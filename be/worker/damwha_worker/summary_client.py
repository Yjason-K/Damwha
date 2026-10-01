import json
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from .contracts import NonEmptyText, SummaryLanguage, SummaryResponse, SummarySegmentCandidate
from .errors import (
    LLM_INVALID_RESPONSE,
    LLM_REQUEST_FAILED,
    ErrorKind,
    WorkerError,
)
from .output_language import output_language_instruction

# 모델은 utterance id가 아니라 1-based index로 경계를 지목한다. 4B급 로컬 모델은
# "utt_5626" 같은 id 수백 개를 그대로 복사하다 프롬프트에 없는 id를 지어내곤 한다
# (숫자 보간) — 작은 정수는 그 실패 모드가 없고 프롬프트도 짧아진다. 실제 id로의
# 역매핑은 이 클라이언트가 한다.
_SUMMARY_SYSTEM_PROMPT_BASE = (
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
    "output timestamps. Do not speculate. "
)


# 태그는 새로 짓지 않고 기존 목록에서만 고른다 — 매 회의 "배포"·"배포 일정" 같은 비슷한
# 이름이 늘어나면 태그로 묶어 보는 의미가 사라진다. 모델이 목록 밖 이름을 내면
# _pick_tags가 버린다. 후보가 없으면 이 문단 자체를 싣지 않는다.
_TAGS_INSTRUCTION = (
    "Also add a third key, tags: an array of at most {max_tags} names chosen from the "
    "existing tags listed after the transcript that clearly fit this whole conversation. "
    "Copy each name exactly as listed. Never invent a new tag. Use an empty array "
    "when none clearly fits. "
)
MAX_SUGGESTED_TAGS = 3


def _summary_system_prompt(output_language: SummaryLanguage, with_tags: bool) -> str:
    tags = _TAGS_INSTRUCTION.format(max_tags=MAX_SUGGESTED_TAGS) if with_tags else ""
    return (
        _SUMMARY_SYSTEM_PROMPT_BASE
        + tags
        + output_language_instruction("topics, title, and bullets", output_language)
    )


def _pick_tags(returned: Any, candidates: list[str]) -> list[str]:
    """모델이 고른 이름을 후보 표기로 되돌린다. 후보 밖·중복·비문자열은 버리고 상한에서 자른다."""
    if not isinstance(returned, list):
        return []
    by_key = {c.strip().lower(): c for c in candidates}
    picked: list[str] = []
    for name in returned:
        if not isinstance(name, str):
            continue
        match = by_key.get(name.strip().lstrip("#").strip().lower())
        if match is not None and match not in picked:
            picked.append(match)
    return picked[:MAX_SUGGESTED_TAGS]


class _LlmSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_index: int
    end_index: int
    title: NonEmptyText
    bullets: list[NonEmptyText]


class _LlmSummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # topics/segments 생략 허용 — contracts.SummaryResponse와 같은 이유
    topics: list[NonEmptyText] = []
    segments: list[_LlmSegment] = []
    # 모양을 묻지 않고 받아둔다 — 후보를 주지 않았는데 tags를 내거나, 문자열·객체
    # 배열처럼 엉뚱한 모양으로 내도 그 때문에 요약 전체가 PERMANENT로 죽으면 안 된다.
    # 쓸 값은 _pick_tags가 후보와 맞는 문자열만 골라낸다.
    tags: Any = []


def _map_indexes(
    parsed: _LlmSummaryResponse, ids: list[str], tag_candidates: list[str]
) -> SummaryResponse:
    """모델이 지목한 인덱스를 실제 id로 옮긴다. 범위 밖은 **자른다**.

    한때 여기서 PERMANENT로 거절했는데, mtg_16(발화 4개 · 그중 하나가 녹음의 72%)이
    그 판단을 뒤집었다: 모델은 줄 수가 아니라 내용으로 나누기 때문에 발화가 몇 개
    없고 내용이 길면 "index 10" 같은 없는 경계를 지목한다. 같은 회의를 네 번 돌려
    네 번 다 같은 자리에서 죽었다 — 재시도로 넘어갈 성질이 아니다. 경계 하나 때문에
    제목·불릿까지 통째로 잃는 대신 범위 안으로 접는다. 구간의 실제 시간은 어차피
    _resolve_segments가 DB 행에서 파생시키므로, 접힌 경계도 없는 시간을 만들지 않는다.
    """
    last = len(ids)
    segments: list[SummarySegmentCandidate] = []
    for seg in parsed.segments:
        start = min(max(seg.start_index, 1), last)
        end = min(max(seg.end_index, 1), last)
        segments.append(
            SummarySegmentCandidate(
                start_utterance_id=ids[start - 1],
                end_utterance_id=ids[end - 1],
                title=seg.title,
                bullets=list(seg.bullets),
            )
        )
    return SummaryResponse(
        topics=list(parsed.topics),
        segments=segments,
        suggested_tags=_pick_tags(parsed.tags, tag_candidates),
    )


def _strip_code_fence(content: str) -> str:
    """Unwrap a ```json ... ``` block. Models wrap JSON despite response_format."""
    text = content.strip()
    if not text.startswith("```"):
        return text
    body = text[3:].removesuffix("```")
    head, sep, rest = body.partition("\n")
    return rest if sep and not head.strip().startswith("{") else body


# 프롬프트에 싣는 것은 화자와 발화문뿐이다. mtg_22(624 utterance) 실측: 발화
# 텍스트 자체는 16,485자인데 직렬화된 프롬프트는 87,577자(44,863토큰)였다 — 81%가
# 스캐폴딩이라 4B 모델로도 prefill에만 285초가 걸렸고, 900초 HTTP 타임아웃을 생성
# 도중에 맞았다. 사라진 몫은 전부 모델이 쓸 일 없는 필드였다:
#   * start_ms/end_ms — 시스템 프롬프트가 타임스탬프 출력을 금지하고 있고, 실제
#     시간은 _resolve_segments가 DB 행에서 파생시킨다.
#   * speaker_id — 1-based 인덱스로 대체된 지 오래고 speaker_name과 중복이다.
# 남은 두 필드를 JSON 객체 배열 대신 한 줄 텍스트로 싣는다(45,081자 → 22,617자).
# 회의록은 원래 `화자: 발화` 꼴이라 모델에게도 JSON 배열보다 자연스러운 형태다.
_SPEAKER_KEYS = ("speaker_name", "speaker_id")


def _render_transcript(utterances: list[dict[str, Any]]) -> str:
    """`<index> <speaker>: <text>` 한 줄씩. 인덱스는 1-based."""
    lines: list[str] = []
    for index, utterance in enumerate(utterances, start=1):
        # 발화문 안의 개행은 접는다 — 한 utterance가 여러 줄이 되면 인덱스와 줄이
        # 어긋나 모델이 없는 경계를 지목한다
        text = " ".join(str(utterance.get("text") or "").split())
        speaker = next((utterance[k] for k in _SPEAKER_KEYS if utterance.get(k)), None)
        lines.append(f"{index} {speaker}: {text}" if speaker else f"{index}: {text}")
    # 고를 수 있는 인덱스를 마지막에 못 박는다 — 범위를 말해 주지 않으면 발화가
    # 4개뿐인 회의에서도 10을 지목한다(mtg_16). 발화 줄 **뒤에** 붙여 `<index> ...`
    # 줄 번호와 인덱스가 어긋나지 않게 한다.
    lines.append("")
    lines.append(f"Valid utterance indexes are 1..{len(utterances)}.")
    return "\n".join(lines)


class SummaryClient:
    """Small synchronous adapter for OpenAI-compatible chat-completion APIs."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        timeout_seconds: float,
        max_tokens: int = 8192,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._max_tokens = max_tokens

    def summarize(
        self,
        *,
        model: str,
        utterances: list[dict[str, Any]],
        output_language: SummaryLanguage,
        tag_candidates: list[str] | None = None,
    ) -> SummaryResponse:
        ids = [u["id"] for u in utterances]
        candidates = list(tag_candidates or [])
        user = _render_transcript(utterances)
        if candidates:
            user += "\n\nExisting tags: " + json.dumps(candidates, ensure_ascii=False)
        messages: list[dict[str, str]] = [
            {
                "role": "system",
                "content": _summary_system_prompt(output_language, with_tags=bool(candidates)),
            },
            {"role": "user", "content": user},
        ]
        content, finish_reason = self._request(model=model, messages=messages)
        if finish_reason == "length":
            # 예산 부족은 모델을 다시 불러도 같은 자리에서 잘린다.
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"response hit the {self._max_tokens}-token max_tokens budget "
                f"before the JSON closed",
                ErrorKind.PERMANENT,
            )
        try:
            parsed = _LlmSummaryResponse.model_validate(json.loads(_strip_code_fence(content)))
            return _map_indexes(parsed, ids, candidates)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc

    def _request(self, *, model: str, messages: list[dict[str, str]]) -> tuple[str, str | None]:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        payload = {
            "model": model,
            "messages": messages,
            "response_format": {"type": "json_object"},
            # 런타임마다 읽는 키가 다르다: Ollama는 reasoning_effort를, mlx_lm.server는
            # chat_template_kwargs만 본다(CLI --chat-template-args 위에 덮어쓴다).
            # 안 읽는 키는 조용히 무시되므로 둘 다 보낸다. lens_client.py와 동일.
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
            # The server's own default (512 on mlx_lm.server) truncates the segments
            # array mid-string, which surfaces as an unparseable-JSON PERMANENT
            # failure — so the cap is stated here instead of inherited.
            "max_tokens": self._max_tokens,
        }
        try:
            with httpx.Client(timeout=self._timeout_seconds) as client:
                response = client.post(
                    f"{self._base_url}/chat/completions", headers=headers, json=payload
                )
        except httpx.TimeoutException as exc:
            # 타임아웃은 TRANSIENT가 아니다. 프롬프트도 모델도 temperature=0도 그대로라
            # 다음 시도는 같은 자리에서 같은 시간을 쓰고 죽는다 — 게다가 관리형 서버는
            # job마다 내려가서 prompt cache까지 비어 있으므로 prefill을 통째로 다시
            # 태운다. mtg_22가 15분짜리 실패를 세 번 반복하고 45분 뒤에 실패했다.
            raise WorkerError(LLM_REQUEST_FAILED, str(exc), ErrorKind.PERMANENT) from exc
        except httpx.RequestError as exc:
            # 연결 실패는 다르다 — 서버가 아직 안 떴거나 재기동 중일 수 있다.
            raise WorkerError(LLM_REQUEST_FAILED, str(exc), ErrorKind.TRANSIENT) from exc

        if response.status_code in {408, 429} or response.status_code >= 500:
            raise WorkerError(LLM_REQUEST_FAILED, response.text, ErrorKind.TRANSIENT)
        if response.status_code >= 400:
            raise WorkerError(LLM_REQUEST_FAILED, response.text, ErrorKind.PERMANENT)

        try:
            choice = response.json()["choices"][0]
            return choice["message"]["content"], choice.get("finish_reason")
        except (IndexError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
