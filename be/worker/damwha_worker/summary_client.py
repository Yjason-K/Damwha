import json
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from .contracts import NonEmptyText, SummaryResponse, SummarySegmentCandidate
from .errors import (
    LLM_INVALID_RESPONSE,
    LLM_REQUEST_FAILED,
    ErrorKind,
    WorkerError,
)

# 모델은 utterance id가 아니라 1-based index로 경계를 지목한다. 4B급 로컬 모델은
# "utt_5626" 같은 id 수백 개를 그대로 복사하다 프롬프트에 없는 id를 지어내곤 한다
# (숫자 보간) — 작은 정수는 그 실패 모드가 없고 프롬프트도 짧아진다. 실제 id로의
# 역매핑은 이 클라이언트가 한다.
_SUMMARY_SYSTEM_PROMPT = (
    "You are given a meeting transcript. Each line is one utterance, formatted as "
    "`<index> <speaker>: <text>`, in chronological order. "
    "Return a JSON object with exactly two keys: topics and segments. topics is an "
    "array of short phrases naming what was discussed. segments splits the "
    "conversation into consecutive chunks; each segment has exactly these fields: "
    "start_index, end_index, title, bullets. start_index and end_index must be "
    "index values from the supplied utterances, in the order given. "
    "bullets are short sentences restating what was said in that segment. Do not "
    "output timestamps. Do not speculate. Write topics, title, and bullets in the "
    "language of the transcript."
)


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


class _InvalidIndex(ValueError):
    """모델이 공급된 범위 밖 인덱스를 인용했다."""


def _map_indexes(parsed: _LlmSummaryResponse, ids: list[str]) -> SummaryResponse:
    segments: list[SummarySegmentCandidate] = []
    for seg in parsed.segments:
        for index in (seg.start_index, seg.end_index):
            if not 1 <= index <= len(ids):
                raise _InvalidIndex(
                    f"segment cites index {index}, but valid indexes are 1..{len(ids)}"
                )
        segments.append(
            SummarySegmentCandidate(
                start_utterance_id=ids[seg.start_index - 1],
                end_utterance_id=ids[seg.end_index - 1],
                title=seg.title,
                bullets=list(seg.bullets),
            )
        )
    return SummaryResponse(topics=list(parsed.topics), segments=segments)


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

    def summarize(self, *, model: str, utterances: list[dict[str, Any]]) -> SummaryResponse:
        ids = [u["id"] for u in utterances]
        messages: list[dict[str, str]] = [
            {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
            {"role": "user", "content": _render_transcript(utterances)},
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
            return _map_indexes(parsed, ids)
        except (json.JSONDecodeError, ValidationError, _InvalidIndex) as exc:
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
