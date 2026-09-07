import json
import logging
from datetime import date, datetime
from typing import Annotated, Any, Literal

import httpx
from pydantic import BaseModel, BeforeValidator, ConfigDict, ValidationError

from .contracts import LensCandidate, NonEmptyText, SpeakerId
from .errors import (
    LLM_INVALID_RESPONSE,
    LLM_REQUEST_FAILED,
    ErrorKind,
    WorkerError,
)

log = logging.getLogger("damwha_worker")

_EXTRACTION_SYSTEM_PROMPT = (
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

# 프롬프트에 싣는 것은 인덱스, 화자, 발화문뿐이다. DB 행을 통째로
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
#
# utterance는 id가 아니라 1-based 인덱스로 지목한다 — summary_client와 같은
# 이유, 이번엔 실측으로. 진짜 id를 실은 판에서 모델이 utt_2657/utt_2659 사이를
# 숫자 보간해 프롬프트에 없는 utt_2658(transcribe_failed로 걸러진 행)을
# 지목했고, all-or-nothing 검증이 mtg_1 추출 전체를 invalid_lens_candidate로
# 떨궜다. temperature=0이라 재실행해도 같은 실패다. 연속 정수는 보간해도 항상
# 실존 utterance에 떨어진다. 실제 id로의 역매핑은 이 클라이언트가 한다.
_SPEAKER_KEYS = ("speaker_name", "speaker_id")


def _due_at_or_none(v: Any) -> Any:
    """파싱되지 않는 마감일은 그 항목만 마감일 없음으로 떨군다.

    모델은 "오늘"·"목요일"·"22 일" 같은 상대 표현을 그대로 낸다. 예전에는 이 한
    필드가 _LlmLensResponse 전체 검증을 깨서 추출 run이 통째로
    llm_invalid_response(PERMANENT)로 죽었다.

    관대화는 due_at에만 준다. kind·text·primary_index가 틀린 항목은 애초에 의미가
    없고, 인덱스 조작은 없는 발화를 근거로 지목하는 문제라 조용히 넘기면 안 된다.
    """
    if v is None or isinstance(v, date):
        return v
    if isinstance(v, str):
        s = v.strip()
        try:
            return date.fromisoformat(s)
        except ValueError:
            pass
        try:
            # 모델이 날짜 대신 ISO datetime을 내는 일이 잦다. date.fromisoformat은
            # 그걸 받지 않으므로(3.12에서 ValueError) 여기서 한 번 더 시도한다 —
            # 관대화는 파싱 안 되는 값을 흡수하라는 것이지, 파싱되는 값을 버리라는
            # 것이 아니다.
            return datetime.fromisoformat(s).date()
        except ValueError:
            return None
    return None


class _LlmLensItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["action", "decision", "promise"]
    text: NonEmptyText
    # nullable 두 필드는 기본값 None — response_format이 로컬 런타임에서 권고사항이라
    # 모델이 null 필드를 통째로 생략한다(contracts.LensCandidate와 같은 이유).
    assignee_speaker_id: SpeakerId | None = None
    due_at: Annotated[date | None, BeforeValidator(_due_at_or_none)] = None
    primary_index: int
    supporting_indexes: list[int] = []


class _LlmLensResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[_LlmLensItem] = []


def _map_indexes(parsed: _LlmLensResponse, ids: list[str]) -> list[LensCandidate]:
    """모델이 지목한 인덱스를 실제 id로 옮긴다. 범위 밖은 **그 항목만** 버린다.

    한때 범위 밖 인덱스 하나가 추출 run 전체를 PERMANENT로 죽였다. 두 가지가 그
    판단을 뒤집었다:

    * 요약 쪽에서 같은 실패가 실제로 났다 — mtg_16(발화 4개)에서 모델이 "index 10"을
      지목했고 네 번 재시도해서 네 번 다 같은 자리에서 죽었다. 모델은 줄 수가 아니라
      내용으로 나누므로, 발화가 몇 개 없고 내용이 길면 이 어긋남은 구조적이다.
    * all-or-nothing은 이 파일이 이미 한 번 물린 함정이다 — mtg_1의 job_3에서 파싱
      안 되는 날짜 6개가 멀쩡한 항목 10건을 통째로 날렸고, due_at은 그래서 항목 단위
      관대화로 바뀌었다. 인덱스도 같은 모양의 문제다.

    다만 요약처럼 **범위 안으로 접지는 않는다**. 렌즈의 primary는 "이 발화가 근거다"
    라는 지목이라, 접으면 엉뚱한 발화에 주장을 붙이게 되고 UI의 근거 점프가 관계없는
    곳으로 간다. 근거로 쓸 수 없으면 그 항목을 버리는 게 맞다. supporting은 선택
    항목이라(기본값 []) 범위 밖인 것만 빼고 항목은 살린다.
    """
    candidates: list[LensCandidate] = []
    for item in parsed.items:
        if not 1 <= item.primary_index <= len(ids):
            log.warning(
                "lens item dropped: primary_index %s is outside 1..%s",
                item.primary_index,
                len(ids),
            )
            continue
        supporting = [i for i in item.supporting_indexes if 1 <= i <= len(ids)]
        candidates.append(
            LensCandidate(
                kind=item.kind,
                text=item.text,
                assignee_speaker_id=item.assignee_speaker_id,
                due_at=item.due_at,
                primary_utterance_id=ids[item.primary_index - 1],
                supporting_utterance_ids=[ids[i - 1] for i in supporting],
            )
        )
    return candidates


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
    """`<index> <speaker>: <text>` 한 줄씩. 인덱스는 1-based."""
    lines: list[str] = []
    for index, utterance in enumerate(utterances, start=1):
        # 발화문 안의 개행은 접는다 — 한 utterance가 여러 줄이 되면 인덱스와 줄이
        # 어긋나 모델이 없는 경계를 지목한다
        text = " ".join(str(utterance.get("text") or "").split())
        speaker = next((utterance[k] for k in _SPEAKER_KEYS if utterance.get(k)), None)
        lines.append(f"{index} {speaker}: {text}" if speaker else f"{index}: {text}")
    # 고를 수 있는 인덱스를 마지막에 못 박는다 — 범위를 말해 주지 않으면 모델이 없는
    # 번호를 지목한다(요약 쪽 mtg_16). 발화 줄 **뒤에** 붙여 줄 번호와 어긋나지 않게 한다.
    lines.append("")
    lines.append(f"Valid utterance indexes are 1..{len(utterances)}.")
    return "\n".join(lines)


def _render_prompt(utterances: list[dict[str, Any]], meeting_date: date | None) -> str:
    transcript = _render_transcript(utterances)
    speakers = _render_speakers(utterances)
    body = f"Speakers:\n{speakers}\n\n{transcript}" if speakers else transcript
    if meeting_date is None:
        return body
    # 존 이름은 싣지 않는다 — 날짜는 이미 meeting_timezone으로 환산돼서 온다.
    return f"Meeting date: {meeting_date.isoformat()}\n\n{body}"


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

    def extract(
        self,
        *,
        model: str,
        utterances: list[dict[str, Any]],
        meeting_date: date | None = None,
    ) -> list[LensCandidate]:
        ids = [u["id"] for u in utterances]
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": _EXTRACTION_SYSTEM_PROMPT,
                },
                {"role": "user", "content": _render_prompt(utterances, meeting_date)},
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
            return _map_indexes(_LlmLensResponse.model_validate(parsed), ids)
        except (json.JSONDecodeError, ValidationError) as exc:
            raise WorkerError(LLM_INVALID_RESPONSE, str(exc), ErrorKind.PERMANENT) from exc
