import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from damwha_worker.contracts import IndexMeetingPayload, parse_payload

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "job-payloads"


def _read(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_index_meeting_fixture_validates():
    p = parse_payload("index_meeting", _read("index_meeting.valid.json"))
    assert isinstance(p, IndexMeetingPayload)
    assert p.processing_version == 0
    assert p.search_embedding.model == "BAAI/bge-m3"
    assert p.search_embedding.dimension == 1024


def test_index_meeting_rejects_non_1024_dimension():
    # Mirrors the zod z.literal(1024) + 005 DB CHECK: a mis-dimensioned job must
    # be rejected at the contract boundary, not sail through to the DB.
    data = _read("index_meeting.valid.json")
    data["search_embedding"]["dimension"] = 999
    with pytest.raises(ValidationError):
        parse_payload("index_meeting", data)
