from pathlib import Path

import pytest

from damwha_demo_tts.script_parser import Overlap, Pause, Utterance, parse_script

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
CAST = ("박준영", "김서연", "이도현", "최민지")

# demo/README.md "길이" 표. 대본이 바뀌면 여기와 README를 같이 고친다.
EXPECTED = {
    "01-kickoff.md": (137, 11, 12),
    "02-tech-review.md": (132, 12, 14),
    "03-postmortem.md": (152, 12, 21),
    "04-sprint-check.md": (154, 12, 24),
}


@pytest.mark.parametrize("name,expected", EXPECTED.items())
def test_real_script_counts_match_readme(name, expected):
    events = parse_script((SCRIPTS / name).read_text(encoding="utf-8"), CAST)
    spoken = sum(isinstance(e, (Utterance, Overlap)) for e in events)
    overlaps = sum(isinstance(e, Overlap) for e in events)
    pauses = sum(isinstance(e, Pause) for e in events)
    assert (spoken, overlaps, pauses) == expected
