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
    "You are given a meeting transcript. The Speakers section lists one speaker per "
    "line as `<speaker_id> <name>`. After it, each transcript line is one utterance, "
    "formatted as `<utterance_id> <speaker name>: <text>`, in chronological order. "
    "Return a JSON object with only an items array. Each item must be an action, "
    "decision, or promise and have exactly these fields: kind, text, "
    "assignee_speaker_id (nullable), due_at (nullable), primary_utterance_id, "
    "supporting_utterance_ids. Choose the exact primary utterance. Every utterance "
    "ID must originate in the transcript, and assignee_speaker_id must be a "
    "speaker_id from the Speakers section (not a name) or null. Do not "
    "speculate or return duplicates. Write text in the language of the transcript."
)

# 프롬프트에 싣는 것은 utterance id, 화자, 발화문뿐이다. DB 행을 통째로
# json.dumps 하던 예전 형식은 회의록 자체보다 스캐폴딩이 훨씬 컸다 — mtg_10(778
# utterance)이 119,563자, mtg_3(997)이 236,484자였고 둘 다 LLM 타임아웃으로 죽었다.
# 빠진 필드는 모델이 쓸 일이 없는 것들이다:
#   * start_ms/end_ms — 렌즈 항목에 시간 필드가 없다. due_at은 발화 내용에서 오는
#     달력 날짜지 녹음 내 오프셋이 아니다.
#   * 발화별 speaker_id — 화자 이름과 중복이다. 이름이 없을 때만 화자 자리를
#     대신한다. 단, 진짜 spk id는 머리의 Speakers 명단에만 한 번씩 싣는다 —
#     assignee_speaker_id가 SpeakerId 패턴(`spk_...`)을 요구해서, 이름만 보낸
#     첫 판(job_131, named 화자 2명인 mtg_21)에서는 assignee가 구조적으로 전부
#     NULL이 됐다. 명단은 화자 수(2~12행)만큼이라 크기 문제가 없고, 모델이 수백
#     개 id를 베끼는 게 아니라 짧은 목록에서 고르므로 id 조작 위험도 낮다.
# 같은 형식으로 mtg_10은 39,238자, mtg_22는 25,845자가 된다.
# (summary_client와 달리 utterance id는 남긴다 — 렌즈 응답 계약이 진짜 id를
# 지목하도록 돼 있어서 인덱스로 대체하려면 응답 스키마까지 바꿔야 한다.)
_SPEAKER_KEYS = ("speaker_name", "speaker_id")


def _render_speakers(utterances: list[dict[str, Any]]) -> str:
    """`<speaker_id> <name>` 한 줄씩, 등장 순서대로 한 번씩."""
    seen: dict[str, str] = {}
    for utterance in utterances:
        speaker_id = utterance.get("speaker_id")
        if not speaker_id or speaker_id in seen:
            continue
        name = " ".join(str(utterance.get("speaker_name") or "").split())
        seen[speaker_id] = f"{speaker_id} {name}" if name else str(speaker_id)
    return "\n".join(seen.values())


def _render_transcript(utterances: list[dict[str, Any]]) -> str:
    """`<utterance_id> <speaker>: <text>` 한 줄씩."""
    lines: list[str] = []
    for utterance in utterances:
        # 발화문 안의 개행은 접는다 — 한 utterance가 여러 줄이 되면 어느 줄이 어느
        # id인지 흐려지고, 모델이 없는 id를 지어내는 쪽으로 샌다
        text = " ".join(str(utterance.get("text") or "").split())
        speaker = next((utterance[k] for k in _SPEAKER_KEYS if utterance.get(k)), None)
        head = f"{utterance['id']} {speaker}" if speaker else str(utterance["id"])
        lines.append(f"{head}: {text}")
    return "\n".join(lines)


def _render_prompt(utterances: list[dict[str, Any]]) -> str:
    transcript = _render_transcript(utterances)
    speakers = _render_speakers(utterances)
    if not speakers:
        return transcript
    return f"Speakers:\n{speakers}\n\n{transcript}"


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
                {"role": "user", "content": _render_prompt(utterances)},
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
            # 타임아웃은 TRANSIENT가 아니다 — summary_client와 같은 이유로, 같은
            # 프롬프트를 다시 던지면 같은 자리에서 같은 시간을 쓰고 죽는다.
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
            content = choice["message"]["content"]
            finish_reason = choice.get("finish_reason")
        except (IndexError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc

        if finish_reason == "length":
            # 잘린 items 배열은 "Invalid JSON: expected `,` or `}`"로 나타나서 모델의
            # 포맷 버그처럼 보인다. 실제 원인인 예산 소진을 이름으로 밝힌다.
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"response hit the {self._max_tokens}-token max_tokens budget "
                f"before the JSON closed",
                ErrorKind.PERMANENT,
            )

        try:
            parsed = json.loads(_strip_code_fence(content))
            # response_format is advisory for local runtimes, so a model may emit the
            # items array on its own instead of the wrapper object.
            if isinstance(parsed, list):
                parsed = {"items": parsed}
            return LensExtractionResponse.model_validate(parsed).items
        except (IndexError, KeyError, TypeError, json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
