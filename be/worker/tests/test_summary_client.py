import json

import httpx
import pytest

from damwha_worker.errors import LLM_INVALID_RESPONSE, ErrorKind, WorkerError
from damwha_worker.summary_client import SummaryClient


def _mount(monkeypatch, handler):
    """httpx.Client.post를 handler로 대체한다."""
    monkeypatch.setattr(httpx.Client, "post", lambda self, url, **kw: handler(url, kw))


def _ok(content: str, status: int = 200, finish_reason: str | None = None):
    choice: dict = {"message": {"content": content}}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    return httpx.Response(
        status,
        json={"choices": [choice]},
        request=httpx.Request("POST", "http://x/chat/completions"),
    )


# LLM은 id가 아니라 1-based 인덱스로 경계를 지목한다 — 4B급 모델이 "utt_5626" 같은
# id 수백 개를 그대로 복사하다 지어내는 실패 모드를 없애기 위함.
BODY = {
    "topics": ["파이프라인 실행 순서"],
    "segments": [
        {
            "start_index": 1,
            "end_index": 2,
            "title": "티켓 등록 수정",
            "bullets": ["공유를 해드릴 것임"],
        }
    ],
}

UTTS = [{"id": "utt_1", "text": "가"}, {"id": "utt_2", "text": "나"}]


def test_summarize_parses_valid_response(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps(BODY, ensure_ascii=False)))
    client = SummaryClient("http://x", None, 5.0, 8192)
    result = client.summarize(model="m", utterances=UTTS)
    assert result.topics == ["파이프라인 실행 순서"]
    assert result.segments[0].start_utterance_id == "utt_1"
    assert result.segments[0].end_utterance_id == "utt_2"


def test_summarize_prompts_with_indexes_not_ids(monkeypatch):
    # 프롬프트에는 utterance id 대신 1-based index가 실린다
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=UTTS)
    sent = json.loads(captured["json"]["messages"][1]["content"])
    assert [u["index"] for u in sent["utterances"]] == [1, 2]
    assert all("id" not in u for u in sent["utterances"])
    system = captured["json"]["messages"][0]["content"]
    assert "start_index" in system and "utterance_id" not in system


def test_summarize_unwraps_code_fence(monkeypatch):
    fenced = "```json\n" + json.dumps(BODY, ensure_ascii=False) + "\n```"
    _mount(monkeypatch, lambda url, kw: _ok(fenced))
    client = SummaryClient("http://x", None, 5.0, 8192)
    assert client.summarize(model="m", utterances=UTTS).topics == ["파이프라인 실행 순서"]


def test_summarize_sends_transcript_unescaped(monkeypatch):
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, 8192).summarize(
        model="m", utterances=[{"id": "utt_1", "text": "한글"}, {"id": "utt_2", "text": "둘"}]
    )
    user_message = captured["json"]["messages"][1]["content"]
    assert "한글" in user_message  # \uXXXX 이스케이프가 아니라 원문 그대로


def test_summarize_caps_generation_with_max_tokens(monkeypatch):
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=UTTS)
    assert captured["json"]["max_tokens"] == 8192


def test_summarize_defaults_missing_key_to_empty_list(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps({"segments": BODY["segments"]})))
    result = SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=UTTS)
    assert result.topics == []
    assert result.segments[0].end_utterance_id == "utt_2"


def test_summarize_maps_5xx_to_transient(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok("{}", status=503))
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.TRANSIENT


def test_summarize_maps_invalid_json_to_permanent(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok("not json at all"))
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.PERMANENT


def test_summarize_sends_max_tokens(monkeypatch):
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, max_tokens=4096).summarize(model="m", utterances=UTTS)
    assert captured["json"]["max_tokens"] == 4096


def test_summarize_retries_once_with_the_validation_error(monkeypatch):
    calls = []
    broken = {"topics": [], "segments": [{"start_index": 1}]}

    def handler(url, kw):
        calls.append(kw["json"]["messages"])
        if len(calls) == 1:
            return _ok(json.dumps(broken))
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    result = SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert result.segments[0].title == "티켓 등록 수정"
    assert len(calls) == 2
    retry_messages = calls[1]
    assert retry_messages[2]["role"] == "assistant"  # 거절당한 원문
    assert "end_index" in retry_messages[3]["content"]  # 무엇이 틀렸는지


def test_summarize_feeds_back_out_of_range_index(monkeypatch):
    # 지어낸 인덱스(범위 밖)는 즉사 대신 거절 사유를 되먹여 한 번 고칠 기회를 준다
    calls = []
    invented = {
        "topics": [],
        "segments": [{"start_index": 1, "end_index": 99, "title": "t", "bullets": ["b"]}],
    }

    def handler(url, kw):
        calls.append(kw["json"]["messages"])
        if len(calls) == 1:
            return _ok(json.dumps(invented))
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    result = SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert result.segments[0].end_utterance_id == "utt_2"
    assert len(calls) == 2
    assert "99" in calls[1][3]["content"]


def test_summarize_runs_validator_in_retry_loop(monkeypatch):
    # 스키마는 통과했지만 도메인 검증(_resolve_segments류)이 거부한 응답도
    # 같은 되먹임 재시도를 탄다
    calls = []
    reversed_body = {
        "topics": [],
        "segments": [{"start_index": 2, "end_index": 1, "title": "t", "bullets": ["b"]}],
    }

    def handler(url, kw):
        calls.append(kw["json"]["messages"])
        if len(calls) == 1:
            return _ok(json.dumps(reversed_body))
        return _ok(json.dumps(BODY, ensure_ascii=False))

    def validate(response):
        seg = response.segments[0]
        if seg.start_utterance_id == "utt_2":
            raise WorkerError(
                LLM_INVALID_RESPONSE, "segment boundaries are reversed", ErrorKind.PERMANENT
            )

    _mount(monkeypatch, handler)
    result = SummaryClient("http://x", None, 5.0).summarize(
        model="m", utterances=UTTS, validate=validate
    )
    assert result.segments[0].start_utterance_id == "utt_1"
    assert len(calls) == 2
    assert "reversed" in calls[1][3]["content"]


def test_summarize_validator_failure_is_permanent_after_retries(monkeypatch):
    calls = []

    def handler(url, kw):
        calls.append(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    def validate(response):
        raise WorkerError(LLM_INVALID_RESPONSE, "always bad", ErrorKind.PERMANENT)

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(
            model="m", utterances=UTTS, validate=validate
        )
    assert exc.value.kind is ErrorKind.PERMANENT
    assert "always bad" in exc.value.message
    assert len(calls) == 2


def test_summarize_gives_up_after_two_attempts(monkeypatch):
    calls = []

    def handler(url, kw):
        calls.append(kw)
        return _ok("not json at all")

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.PERMANENT
    assert len(calls) == 2


def test_summarize_does_not_retry_a_truncated_response(monkeypatch):
    calls = []

    def handler(url, kw):
        calls.append(kw)
        return _ok('{"topics": ["a"], "segm', finish_reason="length")

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.PERMANENT
    assert "max_tokens" in exc.value.message
    assert len(calls) == 1
