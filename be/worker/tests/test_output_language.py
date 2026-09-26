import json

import httpx
import pytest

from damwha_worker.lens_client import LensClient
from damwha_worker.output_language import output_language_instruction
from damwha_worker.summary_client import SummaryClient

# 이 설정이 생기기 전의 프롬프트 끝 문장. transcript일 때 한 글자도 달라지면 안 된다
# (다국어 스펙 §5.3).
OLD_SUMMARY_TAIL = "Write topics, title, and bullets in the language of the transcript."
OLD_LENS_TAIL = "Write text in the language of the transcript."


def test_instruction_per_language():
    assert output_language_instruction("text", "transcript") == OLD_LENS_TAIL
    assert output_language_instruction("text", "ko") == (
        "Write text in Korean, even if the transcript is in another language."
    )
    assert output_language_instruction("text", "en") == (
        "Write text in English, even if the transcript is in another language."
    )


def _capture(monkeypatch, body):
    captured = {}

    def post(self, url, **kw):
        captured.update(kw)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(body)}}]},
            request=httpx.Request("POST", url),
        )

    monkeypatch.setattr(httpx.Client, "post", post)
    return captured


UTTS = [{"id": "utt_1", "text": "가"}]


@pytest.mark.parametrize(
    ("lang", "tail"),
    [
        ("transcript", OLD_SUMMARY_TAIL),
        (
            "en",
            "Write topics, title, and bullets in English, "
            "even if the transcript is in another language.",
        ),
    ],
)
def test_summary_prompt_ends_with_the_instruction(monkeypatch, lang, tail):
    captured = _capture(monkeypatch, {"topics": [], "segments": []})
    SummaryClient("http://x", None, 5.0, 8192).summarize(
        model="m", utterances=UTTS, output_language=lang
    )
    system = captured["json"]["messages"][0]["content"]
    assert system.endswith(tail)
    assert system.count("Write ") == 1  # 언어 지시가 두 번 들어가지 않는다


@pytest.mark.parametrize(
    ("lang", "tail"),
    [
        ("transcript", OLD_LENS_TAIL),
        ("ko", "Write text in Korean, even if the transcript is in another language."),
    ],
)
def test_lens_prompt_ends_with_the_instruction(monkeypatch, lang, tail):
    captured = _capture(monkeypatch, {"items": []})
    LensClient("http://x", None, 5.0, 8192).extract(
        model="m", utterances=UTTS, output_language=lang
    )
    system = captured["json"]["messages"][0]["content"]
    assert system.endswith(tail)


def test_output_language_is_required(monkeypatch):
    _capture(monkeypatch, {"items": []})
    with pytest.raises(TypeError):
        SummaryClient("http://x", None, 5.0, 8192).summarize(  # type: ignore[call-arg]
            model="m", utterances=UTTS
        )
