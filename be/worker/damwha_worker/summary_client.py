import json
from collections.abc import Callable
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
    """모델이 공급된 범위 밖 인덱스를 인용했다 — 되먹임 재시도 대상."""


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


# 로컬 4B급 모델은 세그먼트 하나에서 필드를 빠뜨리는 식으로 자주 어긋난다.
# 같은 프롬프트를 다시 보내면 temperature=0 서버에서 같은 답이 돌아오므로,
# 거절 사유를 되먹여 한 번만 고쳐 쓸 기회를 준다.
_MAX_ATTEMPTS = 2

_RETRY_INSTRUCTION = (
    "Your previous reply was rejected: {error}\n"
    "Reply again with the corrected JSON object only. Every segment must have all "
    "of start_index, end_index, title, and bullets."
)


def _strip_code_fence(content: str) -> str:
    """Unwrap a ```json ... ``` block. Models wrap JSON despite response_format."""
    text = content.strip()
    if not text.startswith("```"):
        return text
    body = text[3:].removesuffix("```")
    head, sep, rest = body.partition("\n")
    return rest if sep and not head.strip().startswith("{") else body


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
        validate: Callable[[SummaryResponse], None] | None = None,
    ) -> SummaryResponse:
        ids = [u["id"] for u in utterances]
        prompt_utterances = [
            {"index": i, **{k: v for k, v in u.items() if k != "id"}}
            for i, u in enumerate(utterances, start=1)
        ]
        messages: list[dict[str, str]] = [
            {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
            # Escaped non-ASCII (\uXXXX) is unreadable to the model and inflates
            # the prompt several-fold, so the transcript goes over as-is.
            {
                "role": "user",
                "content": json.dumps({"utterances": prompt_utterances}, ensure_ascii=False),
            },
        ]
        for attempt in range(1, _MAX_ATTEMPTS + 1):
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
                response = _map_indexes(parsed, ids)
                if validate is not None:
                    # 도메인 검증(경계 순서 등)도 스키마 실패와 똑같이 되먹여 재시도한다
                    validate(response)
                return response
            except (json.JSONDecodeError, ValidationError, _InvalidIndex, WorkerError) as exc:
                if attempt == _MAX_ATTEMPTS:
                    if isinstance(exc, WorkerError):
                        raise
                    raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
                messages = [
                    *messages,
                    {"role": "assistant", "content": content},
                    {"role": "user", "content": _RETRY_INSTRUCTION.format(error=exc)},
                ]
        raise AssertionError("unreachable")  # pragma: no cover

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
            raise WorkerError(LLM_REQUEST_FAILED, str(exc), ErrorKind.TRANSIENT) from exc
        except httpx.RequestError as exc:
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
