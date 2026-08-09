import pytest
from pydantic import ValidationError

from damwha_worker.contracts import ExtractLensesPayload, LensCandidate, parse_payload


def test_extract_payload_requires_run_and_model():
    with pytest.raises(ValidationError):
        parse_payload("extract_lenses", {"schema_version": 1, "meeting_id": "mtg_1"})


def test_extract_payload_validates_db_identifiers_and_version():
    payload = parse_payload(
        "extract_lenses",
        {
            "schema_version": 1,
            "meeting_id": "mtg_1",
            "processing_version": 0,
            "extraction_run_id": "ler_1",
            "model": "qwen",
        },
    )
    assert isinstance(payload, ExtractLensesPayload)

    with pytest.raises(ValidationError):
        parse_payload(
            "extract_lenses",
            {
                "schema_version": 1,
                "meeting_id": "mtg_0",
                "processing_version": 0,
                "extraction_run_id": "ler_1",
                "model": "qwen",
            },
        )


def test_lens_candidate_trims_text_and_validates_dates_and_ids():
    candidate = LensCandidate.model_validate(
        {
            "kind": "action",
            "text": "  Send the notes  ",
            "assignee_speaker_id": "spk_1",
            "due_at": "2026-07-20",
            "primary_utterance_id": "utt_1",
            "supporting_utterance_ids": ["utt_2"],
        }
    )
    assert candidate.text == "Send the notes"
    assert candidate.due_at.isoformat() == "2026-07-20"

    with pytest.raises(ValidationError):
        LensCandidate.model_validate(
            {
                "kind": "topic",
                "text": " ",
                "assignee_speaker_id": "speaker_1",
                "due_at": "not-a-date",
                "primary_utterance_id": "utterance_1",
                "supporting_utterance_ids": [],
            }
        )


def test_lens_candidate_treats_omitted_nullable_fields_as_null():
    """Local runtimes don't enforce the schema — models drop the nullable fields.

    An omitted `assignee_speaker_id`/`due_at` is semantically identical to an
    explicit null, so it must not fail the whole extraction run.
    """
    candidate = LensCandidate.model_validate(
        {
            "kind": "action",
            "text": "Send the notes",
            "primary_utterance_id": "utt_1",
            "supporting_utterance_ids": ["utt_2"],
        }
    )
    assert candidate.assignee_speaker_id is None
    assert candidate.due_at is None
