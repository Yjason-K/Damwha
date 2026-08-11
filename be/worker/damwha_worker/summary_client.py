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

    def __init__(self, base_url: str, api_key: str | None, timeout_seconds: float) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    def summarize(self, *, model: str, utterances: list[dict[str, Any]]) -> SummaryResponse:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": _SUMMARY_SYSTEM_PROMPT},
                # Escaped non-ASCII (\uXXXX) is unreadable to the model and inflates
                # the prompt several-fold, so the transcript goes over as-is.
                {
                    "role": "user",
                    "content": json.dumps({"utterances": utterances}, ensure_ascii=False),
                },
            ],
            "response_format": {"type": "json_object"},
            "reasoning_effort": "none",
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
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(_strip_code_fence(content))
            return SummaryResponse.model_validate(parsed)
        except (IndexError, KeyError, TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
