import logging
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

log = logging.getLogger("damwha_worker")

# job type별 허용 버전 — enroll/index는 v1 불변 (spec §4)
SUPPORTED_SCHEMA_VERSIONS: dict[str, frozenset[int]] = {
    "process_meeting": frozenset({1, 2, 3}),
    "enroll_speaker": frozenset({1}),
    "index_meeting": frozenset({1}),
    "extract_lenses": frozenset({1}),
    "summarize_meeting": frozenset({1}),
}

MeetingId = Annotated[str, StringConstraints(pattern=r"^mtg_[1-9][0-9]*$")]
SpeakerId = Annotated[str, StringConstraints(pattern=r"^spk_[1-9][0-9]*$")]
ExtractionRunId = Annotated[str, StringConstraints(pattern=r"^ler_[1-9][0-9]*$")]
UtteranceId = Annotated[str, StringConstraints(pattern=r"^utt_[1-9][0-9]*$")]
NonEmptyText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
]
NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

WhisperModel = Literal["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]
Device = Literal["cpu", "gpu"]


class UnsupportedPayloadVersion(ValueError):
    pass


class Diarization(BaseModel):
    model: str
    min_speakers: int | None
    max_speakers: int | None


class Embedding(BaseModel):
    model: str
    dimension: int


class Devices(BaseModel):
    diarization: Device
    stt: Device


class ModelsV1(BaseModel):  # 기존 Models 이름 변경
    whisper_model: Literal["large-v3-turbo", "large-v3"]
    device: Literal["mps", "cpu", "cuda"]
    language: str
    diarization: Diarization
    embedding: Embedding


class ModelsV2(BaseModel):
    """wire v2 전용. TS ModelsSchemaV2가 .strict()이므로 여기도 extra를 막는다."""

    model_config = ConfigDict(extra="forbid")

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    diarization: Diarization
    embedding: Embedding


class ModelsWireV3(BaseModel):
    """wire v3. summary_model은 필수 — v3는 완전 해석된 계약이라 워커가 env로
    폴백할 여지를 남기지 않는다 (spec §3)."""

    model_config = ConfigDict(extra="forbid")

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    summary_model: NonEmptyString
    diarization: Diarization
    embedding: Embedding


class ModelsConfig(BaseModel):
    """내부 정규 표현 — 파이프라인/registry는 이 모양만 다룬다.

    이름이 Models가 아닌 이유: pipeline/process_meeting.py의 Models는 로드된 ML
    어댑터(VAD/Diarizer/Embedder/Transcriber) 묶음이고 registry.py가 그걸 import한다.

    summary_model이 nullable인 이유는 preset/preset_revision과 같다: v1/v2에서
    변환된 payload에는 값이 없다. v3 유래는 항상 채워진다. Literal이 아니라 str인
    이유는 워커가 API의 큐레이션 목록을 알 필요가 없기 때문 — 목록 검증은 API 경계
    (그리고 워커 env 폴백 값은 목록 밖일 수 있다)."""

    whisper_model: WhisperModel
    language: str
    devices: Devices
    preset: str | None = None
    preset_revision: str | None = None
    summary_model: str | None = None
    diarization: Diarization
    embedding: Embedding


def _v1_models_to_internal(m: ModelsV1) -> ModelsConfig:
    if m.device == "cuda":
        # cuda→gpu는 Metal 의미와 다른 오변환 — cpu로 내리고 경고 (spec §4)
        log.warning("v1 payload device=cuda — converting to cpu (cuda is a non-goal)")
    dev: Device = "gpu" if m.device == "mps" else "cpu"
    return ModelsConfig(
        whisper_model=m.whisper_model,
        language=m.language,
        devices=Devices(diarization=dev, stt=dev),
        preset=None,
        preset_revision=None,
        summary_model=None,
        diarization=m.diarization,
        embedding=m.embedding,
    )


def _v2_models_to_internal(m: ModelsV2) -> ModelsConfig:
    return ModelsConfig(**m.model_dump(), summary_model=None)


def _v3_models_to_internal(m: ModelsWireV3) -> ModelsConfig:
    return ModelsConfig(**m.model_dump())


class Identify(BaseModel):
    threshold: float


class ProcessMeetingPayloadV1(BaseModel):
    """v1 wire 형태 — schema_version은 정확히 1 (누락 시 1)."""

    schema_version: Literal[1] = 1
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsV1
    identify: Identify


class ProcessMeetingPayloadWireV2(BaseModel):
    schema_version: Literal[2]
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsV2
    identify: Identify


class ProcessMeetingPayloadWireV3(BaseModel):
    schema_version: Literal[3]
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsWireV3
    identify: Identify


class ProcessMeetingPayload(BaseModel):
    """내부 표현 — 항상 정규화된 ModelsConfig. v1/v2/v3는 parse에서 즉시 변환되고
    원본 버전을 보존한다.

    schema_version의 입력 검증 제약은 이 필드가 아니라 parse_payload의
    job type별 dispatch(SUPPORTED_SCHEMA_VERSIONS)가 담당한다.
    """

    schema_version: int = 2
    meeting_id: MeetingId
    audio_key: str
    processing_version: int
    reprocess: bool
    models: ModelsConfig
    identify: Identify


class EnrollSpeakerPayload(BaseModel):
    schema_version: int = 1
    speaker_id: SpeakerId
    audio_key: str
    embedding: Embedding


class SearchEmbedding(BaseModel):
    model: str
    # Mirrors the zod contract (IndexMeetingPayloadSchema) and the 005 DB CHECK:
    # reject a mis-dimensioned index job at the contract boundary (categorized
    # PERMANENT failure) rather than letting it die on the DB constraint.
    dimension: Literal[1024]


class IndexMeetingPayload(BaseModel):
    schema_version: int = 1
    meeting_id: MeetingId
    processing_version: int
    search_embedding: SearchEmbedding


class ExtractLensesPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    meeting_id: MeetingId
    processing_version: int = Field(ge=0)
    extraction_run_id: ExtractionRunId
    model: NonEmptyString


class LensCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["action", "decision", "promise"]
    text: NonEmptyText
    # 프롬프트가 nullable로 명시한 두 필드는 기본값 None — 로컬 런타임에서
    # response_format은 권고사항이라 모델이 null 필드를 통째로 생략한다. 생략은
    # 명시적 null과 의미가 같으므로 추출 run 전체를 실패시키지 않는다.
    # (extra="forbid"는 그대로라 없는 필드를 지어내는 것은 여전히 막힌다.)
    assignee_speaker_id: SpeakerId | None = None
    due_at: date | None = None
    primary_utterance_id: UtteranceId
    supporting_utterance_ids: list[UtteranceId]


class LensExtractionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[LensCandidate]


class SummarizeMeetingPayload(BaseModel):
    """렌즈와 달리 extraction_run_id가 없다 — meeting_summary는 회의당 1행이라
    meeting_id가 곧 키이고 별도 run 엔티티가 필요 없다."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1]
    meeting_id: MeetingId
    processing_version: int = Field(ge=0)
    model: NonEmptyString


class SummarySegmentCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_utterance_id: UtteranceId
    end_utterance_id: UtteranceId
    title: NonEmptyText
    bullets: list[NonEmptyText]


class SummaryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # response_format은 로컬 런타임에서 권고사항이라 모델이 두 키 중 하나를 통째로
    # 생략하기도 한다(LensCandidate와 같은 이유). 생략은 빈 결과와 의미가 같으므로
    # 기본값을 둬 요약 전체를 실패시키지 않는다.
    topics: list[NonEmptyText] = []
    segments: list[SummarySegmentCandidate] = []


def _parse_process_meeting(data: dict) -> ProcessMeetingPayload:
    version = data.get("schema_version", 1)
    if version == 1:
        v1 = ProcessMeetingPayloadV1.model_validate(data)
        return ProcessMeetingPayload(
            schema_version=1,
            meeting_id=v1.meeting_id,
            audio_key=v1.audio_key,
            processing_version=v1.processing_version,
            reprocess=v1.reprocess,
            models=_v1_models_to_internal(v1.models),
            identify=v1.identify,
        )
    if version == 2:
        v2 = ProcessMeetingPayloadWireV2.model_validate(data)
        return ProcessMeetingPayload(
            schema_version=2,
            meeting_id=v2.meeting_id,
            audio_key=v2.audio_key,
            processing_version=v2.processing_version,
            reprocess=v2.reprocess,
            models=_v2_models_to_internal(v2.models),
            identify=v2.identify,
        )
    v3 = ProcessMeetingPayloadWireV3.model_validate(data)
    return ProcessMeetingPayload(
        schema_version=3,
        meeting_id=v3.meeting_id,
        audio_key=v3.audio_key,
        processing_version=v3.processing_version,
        reprocess=v3.reprocess,
        models=_v3_models_to_internal(v3.models),
        identify=v3.identify,
    )


def parse_models(payload: dict) -> ModelsConfig:
    """registry용: process_meeting payload dict → 정규화된 내부 ModelsConfig."""
    return _parse_process_meeting(payload).models


def parse_payload(job_type: str, data: dict):
    allowed = SUPPORTED_SCHEMA_VERSIONS.get(job_type)
    if allowed is None:
        raise ValueError(f"unknown job type {job_type}")
    version = data.get("schema_version", 1)
    if version not in allowed:
        raise UnsupportedPayloadVersion(
            f"{job_type}: schema_version {version} not in {sorted(allowed)}"
        )
    if job_type == "process_meeting":
        return _parse_process_meeting(data)
    if job_type == "enroll_speaker":
        return EnrollSpeakerPayload.model_validate(data)
    if job_type == "index_meeting":
        return IndexMeetingPayload.model_validate(data)
    if job_type == "summarize_meeting":
        return SummarizeMeetingPayload.model_validate(data)
    return ExtractLensesPayload.model_validate(data)
