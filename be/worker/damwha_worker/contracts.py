from typing import Literal

from pydantic import BaseModel

SUPPORTED_SCHEMA_VERSIONS = frozenset({1})


class UnsupportedPayloadVersion(ValueError):
    pass


class Diarization(BaseModel):
    model: str
    min_speakers: int | None
    max_speakers: int | None


class Embedding(BaseModel):
    model: str
    dimension: int


class Models(BaseModel):
    whisper_model: Literal["large-v3-turbo", "large-v3"]
    device: Literal["mps", "cpu", "cuda"]
    language: str
    diarization: Diarization
    embedding: Embedding


class Identify(BaseModel):
    threshold: float


class ProcessMeetingPayload(BaseModel):
    schema_version: int = 1
    meeting_id: str
    audio_key: str
    processing_version: int
    reprocess: bool
    models: Models
    identify: Identify


class EnrollSpeakerPayload(BaseModel):
    schema_version: int = 1
    speaker_id: str
    audio_key: str
    embedding: Embedding


def parse_payload(job_type: str, data: dict):
    version = data.get("schema_version", 1)
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise UnsupportedPayloadVersion(
            f"schema_version {version} not in {sorted(SUPPORTED_SCHEMA_VERSIONS)}"
        )
    if job_type == "process_meeting":
        return ProcessMeetingPayload.model_validate(data)
    if job_type == "enroll_speaker":
        return EnrollSpeakerPayload.model_validate(data)
    raise ValueError(f"unknown job type {job_type}")
