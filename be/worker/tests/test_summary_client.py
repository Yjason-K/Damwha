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
    sent = captured["json"]["messages"][1]["content"]
    assert sent.splitlines()[:2] == ["1: 가", "2: 나"]
    assert "utt_1" not in sent
    system = captured["json"]["messages"][0]["content"]
    assert "start_index" in system and "utterance_id" not in system


def test_summarize_prompt_carries_speaker_but_not_ids_or_timestamps(monkeypatch):
    # 화자 이름은 싣고, 모델이 쓸 일 없는 speaker_id/start_ms/end_ms는 뺀다 —
    # 타임스탬프는 시스템 프롬프트가 금지하고 실제 값은 DB 행에서 파생된다
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    rows = [
        {
            "id": "utt_1",
            "speaker_id": "spk_19",
            "speaker_name": "강형욱",
            "text": "안녕하세요",
            "start_ms": 1234567,
            "end_ms": 1234890,
        },
        {
            "id": "utt_2",
            "speaker_id": "spk_20",
            "speaker_name": None,
            "text": "네",
            "start_ms": 1234900,
            "end_ms": 1235000,
        },
    ]
    SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=rows)
    sent = captured["json"]["messages"][1]["content"]
    # speaker_name이 없으면 speaker_id가 화자 자리를 대신한다 — 화자 구분은 남긴다
    assert sent.splitlines()[:2] == ["1 강형욱: 안녕하세요", "2 spk_20: 네"]
    assert "1234567" not in sent and "start_ms" not in sent
    assert "spk_19" not in sent


def test_summarize_prompt_folds_newlines_inside_an_utterance(monkeypatch):
    # 한 utterance가 여러 줄이 되면 인덱스와 줄이 어긋난다
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, 8192).summarize(
        model="m",
        utterances=[{"id": "utt_1", "text": "가\n나"}, {"id": "utt_2", "text": "다"}],
    )
    sent = captured["json"]["messages"][1]["content"]
    assert sent.splitlines()[:2] == ["1: 가 나", "2: 다"]


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


def test_summarize_does_not_retry_a_rejected_response(monkeypatch):
    # 되먹임 재시도는 없다. 같은 프롬프트를 temperature=0 서버에 다시 던지면 같은
    # 바이트가 돌아오고, 관리형 서버는 prompt cache까지 비어 있어 prefill을 통째로
    # 다시 태운다 — 실패를 늦출 뿐 결과는 같다.
    calls = []
    broken = {"topics": [], "segments": [{"start_index": 1}]}

    def handler(url, kw):
        calls.append(kw)
        return _ok(json.dumps(broken))

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert exc.value.kind is ErrorKind.PERMANENT
    assert len(calls) == 1


def test_summarize_clamps_an_out_of_range_index(monkeypatch):
    """범위 밖 인덱스는 요약을 버리지 않고 마지막 발화로 자른다.

    mtg_16(발화 4개, 그중 하나가 녹음의 72%)에서 27B 모델이 "index 10"을 지목해
    요약이 통째로 실패했다. 모델은 줄 수가 아니라 내용으로 나누기 때문에, 발화가
    몇 개 없고 내용이 길면 없는 인덱스를 지어낸다. 경계 하나 때문에 제목·불릿까지
    잃는 것보다 경계를 범위 안으로 접는 편이 낫다 — 시간은 어차피 DB에서 파생된다.
    """
    invented = {
        "topics": [],
        "segments": [{"start_index": 1, "end_index": 99, "title": "t", "bullets": ["b"]}],
    }
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps(invented)))
    result = SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert result.segments[0].start_utterance_id == "utt_1"
    assert result.segments[0].end_utterance_id == "utt_2"
    assert result.segments[0].bullets == ["b"]


def test_summarize_clamps_a_zero_or_negative_index(monkeypatch):
    invented = {
        "topics": [],
        "segments": [{"start_index": 0, "end_index": 1, "title": "t", "bullets": ["b"]}],
    }
    _mount(monkeypatch, lambda url, kw: _ok(json.dumps(invented)))
    result = SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert result.segments[0].start_utterance_id == "utt_1"


def test_summarize_prompt_states_the_index_range(monkeypatch):
    """모델에게 고를 수 있는 인덱스가 몇까지인지 알려 준다.

    범위를 말해 주지 않으면 발화가 4개뿐인 회의에서도 10을 지목한다(mtg_16).
    자르기(clamp)가 안전망이라면 이쪽은 애초에 어긋나지 않게 하는 쪽이다.
    """
    captured = {}

    def handler(url, kw):
        captured.update(kw)
        return _ok(json.dumps(BODY, ensure_ascii=False))

    _mount(monkeypatch, handler)
    SummaryClient("http://x", None, 5.0, 8192).summarize(model="m", utterances=UTTS)
    sent = captured["json"]["messages"][1]["content"]
    # 발화 줄은 그대로 1번부터 시작한다 — 범위 안내는 전사 뒤에 붙는다.
    assert sent.startswith("1: 가\n2: 나")
    assert "1..2" in sent


def test_summarize_calls_the_server_once(monkeypatch):
    calls = []

    def handler(url, kw):
        calls.append(kw)
        return _ok("not json at all")

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=[])
    assert exc.value.kind is ErrorKind.PERMANENT
    assert len(calls) == 1


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


def test_summarize_treats_a_timeout_as_permanent(monkeypatch):
    # 관리형 서버는 job마다 내려가 prompt cache가 비어 있다 — 재시도는 prefill을
    # 통째로 다시 태우고 같은 자리에서 죽는다
    def handler(url, kw):
        raise httpx.TimeoutException("timed out")

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert exc.value.kind is ErrorKind.PERMANENT


def test_summarize_treats_a_connection_error_as_transient(monkeypatch):
    def handler(url, kw):
        raise httpx.ConnectError("connection refused")

    _mount(monkeypatch, handler)
    with pytest.raises(WorkerError) as exc:
        SummaryClient("http://x", None, 5.0).summarize(model="m", utterances=UTTS)
    assert exc.value.kind is ErrorKind.TRANSIENT
