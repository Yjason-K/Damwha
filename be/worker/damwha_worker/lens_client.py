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


class LensClient:
    """Small synchronous adapter for OpenAI-compatible chat-completion APIs."""

    def __init__(
        self, base_url: str, model: str, api_key: str | None, timeout_seconds: float
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._timeout_seconds = timeout_seconds

    def extract(self, *, utterances: list[dict[str, Any]]) -> list[LensCandidate]:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        payload = {
            "model": self._model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Extract action items, decisions, and promises from the supplied "
                        "utterances. Return a JSON object with an items array only."
                    ),
                },
                {"role": "user", "content": json.dumps({"utterances": utterances})},
            ],
            "response_format": {"type": "json_object"},
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
            return LensExtractionResponse.model_validate_json(content).items
        except (IndexError, KeyError, TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
