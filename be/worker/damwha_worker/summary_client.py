import json
from typing import Any

import httpx
from pydantic import ValidationError

from .contracts import SummaryResponse
from .errors import (
    LLM_INVALID_RESPONSE,
    LLM_REQUEST_FAILED,
    ErrorKind,
    WorkerError,
)

_SUMMARY_SYSTEM_PROMPT = (
    "Return a JSON object with exactly two keys: topics and segments. topics is an "
    "array of short phrases naming what was discussed. segments splits the "
    "conversation into consecutive chunks; each segment has exactly these fields: "
    "start_utterance_id, end_utterance_id, title, bullets. start_utterance_id and "
    "end_utterance_id must be IDs from the supplied utterances, in the order given. "
    "bullets are short sentences restating what was said in that segment. Do not "
    "output timestamps. Do not speculate. Write topics, title, and bullets in the "
    "language of the transcript."
)

# 로컬 4B급 모델은 세그먼트 하나에서 필드를 빠뜨리는 식으로 자주 어긋난다.
# 같은 프롬프트를 다시 보내면 temperature=0 서버에서 같은 답이 돌아오므로,
# 거절 사유를 되먹여 한 번만 고쳐 쓸 기회를 준다.
_MAX_ATTEMPTS = 2

_RETRY_INSTRUCTION = (
    "Your previous reply was rejected: {error}\n"
    "Reply again with the corrected JSON object only. Every segment must have all "
    "of start_utterance_id, end_utterance_id, title, and bullets."
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

    def summarize(self, *, model: str, utterances: list[dict[str, Any]]) -> SummaryResponse:
        messages: list[dict[str, str]] = [
            {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
            # Escaped non-ASCII (\uXXXX) is unreadable to the model and inflates
            # the prompt several-fold, so the transcript goes over as-is.
            {
                "role": "user",
                "content": json.dumps({"utterances": utterances}, ensure_ascii=False),
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
                return SummaryResponse.model_validate(json.loads(_strip_code_fence(content)))
            except (json.JSONDecodeError, ValidationError) as exc:
                if attempt == _MAX_ATTEMPTS:
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
            "reasoning_effort": "none",
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
