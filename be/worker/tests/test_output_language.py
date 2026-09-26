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

# 이 설정이 생기기 전(커밋 600de2e)의 시스템 프롬프트 전체 — 그대로 옮겨 왔다:
#   git show 600de2e:be/worker/damwha_worker/summary_client.py  (_SUMMARY_SYSTEM_PROMPT)
#   git show 600de2e:be/worker/damwha_worker/lens_client.py     (_EXTRACTION_SYSTEM_PROMPT)
# transcript일 때 지금 프롬프트가 이것과 바이트 단위로 같아야 한다
# (다국어 스펙 §5.3, global-constraints).
OLD_SUMMARY_SYSTEM_PROMPT = (
    "You are given a meeting transcript. Each line is one utterance, formatted as "
    "`<index> <speaker>: <text>`, in chronological order. "
    "Return a JSON object with exactly two keys: topics and segments. topics is an "
    "array of short phrases naming what was discussed. segments splits the "
    "conversation into consecutive chunks; each segment has exactly these fields: "
    "start_index, end_index, title, bullets. start_index and end_index must be "
    "index values from the supplied utterances, in the order given. Segments must "
    "not overlap: each segment starts after the previous one ends, and no index "
    "appears in two segments. "
    "bullets are short sentences restating what was said in that segment. Do not "
    "output timestamps. Do not speculate. Write topics, title, and bullets in the "
    "language of the transcript."
)

OLD_EXTRACTION_SYSTEM_PROMPT = (
    "You are given a meeting transcript. The Speakers section lists one speaker per "
    "line as `<speaker_id> <name>`. After it, each transcript line is one utterance, "
    "formatted as `<index> <speaker name>: <text>`, in chronological order. "
    "Return a JSON object with only an items array. Each item must be an action, "
    "decision, or promise and have exactly these fields: kind, text, "
    "assignee_speaker_id (nullable), due_at (nullable), primary_index, "
    "supporting_indexes. Choose the exact primary utterance. primary_index and "
    "every supporting index must be index values from the transcript, and "
    "assignee_speaker_id must be a speaker_id from the Speakers section (not a "
    "name) or null. Write due_at as a YYYY-MM-DD calendar date. When an utterance "
    'states a relative deadline ("today", "next Thursday"), resolve it against '
    "the Meeting date line at the top of the transcript; if it cannot be resolved, "
    "use null. Do not "
    "speculate or return duplicates. Write text in the language of the transcript."
)


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


def test_summary_prompt_is_byte_identical_to_the_pre_change_prompt_for_transcript(monkeypatch):
    captured = _capture(monkeypatch, {"topics": [], "segments": []})
    SummaryClient("http://x", None, 5.0, 8192).summarize(
        model="m", utterances=UTTS, output_language="transcript"
    )
    system = captured["json"]["messages"][0]["content"]
    assert system == OLD_SUMMARY_SYSTEM_PROMPT


def test_lens_prompt_is_byte_identical_to_the_pre_change_prompt_for_transcript(monkeypatch):
    captured = _capture(monkeypatch, {"items": []})
    LensClient("http://x", None, 5.0, 8192).extract(
        model="m", utterances=UTTS, output_language="transcript"
    )
    system = captured["json"]["messages"][0]["content"]
    assert system == OLD_EXTRACTION_SYSTEM_PROMPT


def test_output_language_is_required(monkeypatch):
    _capture(monkeypatch, {"items": []})
    with pytest.raises(TypeError):
        SummaryClient("http://x", None, 5.0, 8192).summarize(  # type: ignore[call-arg]
            model="m", utterances=UTTS
        )
