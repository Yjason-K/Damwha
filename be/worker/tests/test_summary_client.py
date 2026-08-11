import json

import httpx
import pytest

from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.summary_client import SummaryClient


def _mount(monkeypatch, handler):
    """httpx.Client.post를 handler로 대체한다."""
    monkeypatch.setattr(httpx.Client, "post", lambda self, url, **kw: handler(url, kw))


def _ok(content: str, status: int = 200):
    return httpx.Response(
        status,
        json={"choices": [{"message": {"content": content}}]},
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
