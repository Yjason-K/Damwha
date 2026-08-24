import json
from typing import Any

import httpx
from pydantic import ValidationError

from .contracts import LensCandidate, LensExtractionResponse
from .errors import (
    LLM_INVALID_RESPONSE,
    LLM_REQUEST_FAILED,
    ErrorKind,
    WorkerError,
)

_EXTRACTION_SYSTEM_PROMPT = (
    "Return a JSON object with only an items array. Each item must be an action, "
    "decision, or promise and have exactly these fields: kind, text, "
    "assignee_speaker_id (nullable), due_at (nullable), primary_utterance_id, "
    "supporting_utterance_ids. Choose the exact primary utterance. Every utterance "
    "ID and assignee_speaker_id must originate in the supplied utterances. Do not "
    "speculate or return duplicates. Write text in the language of the transcript."
)


def _strip_code_fence(content: str) -> str:
    """Unwrap a ```json ... ``` block. Models wrap JSON despite response_format."""
    text = content.strip()
    if not text.startswith("```"):
        return text
    body = text[3:].removesuffix("```")
    head, sep, rest = body.partition("\n")
    return rest if sep and not head.strip().startswith("{") else body


class LensClient:
    """Small synchronous adapter for OpenAI-compatible chat-completion APIs."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        timeout_seconds: float,
        max_tokens: int,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds
        self._max_tokens = max_tokens

    def extract(self, *, model: str, utterances: list[dict[str, Any]]) -> list[LensCandidate]:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": _EXTRACTION_SYSTEM_PROMPT,
                },
                # Escaped non-ASCII (\uXXXX) is unreadable to the model and inflates
                # the prompt several-fold, so the transcript goes over as-is.
                {
                    "role": "user",
                    "content": json.dumps({"utterances": utterances}, ensure_ascii=False),
                },
            ],
            "response_format": {"type": "json_object"},
            # Reasoning models spend minutes thinking before emitting the items
            # array. Extraction needs the answer, not the deliberation. Two keys
            # because runtimes disagree on which one they read: Ollama honors
            # reasoning_effort, mlx_lm.server ignores it and only merges
            # chat_template_kwargs over its --chat-template-args default.
            # An unread key is silently dropped, so sending both is safe.
            "reasoning_effort": "none",
            "chat_template_kwargs": {"enable_thinking": False},
            # The server's own default (512 on mlx_lm.server) truncates the items
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
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(_strip_code_fence(content))
            # response_format is advisory for local runtimes, so a model may emit the
            # items array on its own instead of the wrapper object.
            if isinstance(parsed, list):
                parsed = {"items": parsed}
            return LensExtractionResponse.model_validate(parsed).items
        except (IndexError, KeyError, TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
