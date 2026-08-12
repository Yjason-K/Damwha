import json

import httpx
import pytest

from damwha_worker.errors import ErrorKind, WorkerError
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


BODY = {
    "topics": ["파이프라인 실행 순서"],
    "segments": [
        {
            "start_utterance_id": "utt_1",
            "end_utterance_id": "utt_2",
            "title": "티켓 등록 수정",
            "bullets": ["공유를 해드릴 것임"],
        }
    ],
}


def test_summarize_parses_valid_response(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps(BODY, ensure_ascii=False)))
    client = SummaryClient("http://x", None, 5.0)
    result = client.summarize(model="m", utterances=[{"id": "utt_1"}])
    assert result.topics == ["파이프라인 실행 순서"]
    assert result.segments[0].end_utterance_id == "utt_2"


def test_summarize_unwraps_code_fence(monkeypatch):
    fenced = "```json\n" + json.dumps(BODY, ensure_ascii=False) + "\n```"
    _mount(monkeypatch, lambda url, kw: _ok(fenced))
    client = SummaryClient("http://x", None, 5.0)
    assert client.summarize(model="m", utterances=[]).topics == ["파이프라인 실행 순서"]


def test_summarize_sends_transcript_unescaped(monkeypatch):
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0).summarize(
        model="m", utterances=[{"id": "utt_1", "text": "한글"}]
    )
    user_message = captured["json"]["messages"][1]["content"]
    assert "한글" in user_message  # \uXXXX 이스케이프가 아니라 원문 그대로


def test_summarize_defaults_missing_key_to_empty_list(monkeypatch):
    # 로컬 런타임에서는 response_format이 권고사항이라 모델이 topics/segments 중
    # 하나를 통째로 생략하기도 한다 — 그래도 파싱은 되어야 한다.
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps({"segments": BODY["segments"]})))
    result = SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert result.topics == []
    assert result.segments[0].end_utterance_id == "utt_2"


def test_summarize_maps_5xx_to_transient(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok("{}", status=503))
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.TRANSIENT


def test_summarize_maps_invalid_json_to_permanent(monkeypatch):
    _mount(monkeypatch, lambda url, kw: _ok("not json at all"))
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.PERMANENT


def test_summarize_sends_max_tokens(monkeypatch):
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, max_tokens=4096).summarize(model="m", utterances=[])
    assert captured["json"]["max_tokens"] == 4096


def test_summarize_retries_once_with_the_validation_error(monkeypatch):
    # 4B급 로컬 모델은 세그먼트 하나에서 필드를 빠뜨리곤 한다. 같은 프롬프트로
    # 다시 물으면 temperature=0 서버에서는 같은 답이 오므로, 무엇이 틀렸는지
    # 되먹여야 재시도에 의미가 생긴다.
    calls = []
    broken = {"topics": [], "segments": [{"start_utterance_id": "utt_1"}]}

    def handler(url, kw):
        calls.append(kw["json"]["messages"])
        if len(calls) == 1:
            return _ok(json.dumps(broken))
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    result = SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert result.segments[0].title == "티켓 등록 수정"
    assert len(calls) == 2
    retry_messages = calls[1]
    assert retry_messages[2]["role"] == "assistant"  # 거절당한 원문
    assert "end_utterance_id" in retry_messages[3]["content"]  # 무엇이 틀렸는지


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
    # finish_reason=length는 모델이 못 쓴 게 아니라 예산이 모자란 것 — 같은
    # max_tokens로 다시 물어봐야 또 잘린다.
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
