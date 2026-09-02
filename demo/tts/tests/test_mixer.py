import numpy as np
import pytest

from damwha_demo_tts.mixer import Clip, Placement, place, trim_silence

SR = 24000


def tone(seconds: float, amp: float = 0.5) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.float32)


def test_trim_silence_strips_leading_and_trailing_quiet():
    audio = np.concatenate([silence(0.5), tone(1.0), silence(0.3)])
    trimmed = trim_silence(audio, SR, threshold_db=-40)
    assert abs(len(trimmed) / SR - 1.0) < 0.02


def test_speaker_change_gap_is_within_range():
    clips = [Clip("박준영", tone(1.0), overlap=False), Clip("김서연", tone(1.0), overlap=False)]
    pl = place(clips, SR, seed=1)
    gap = pl[1].start - pl[0].end
    assert 0.4 <= gap <= 1.0


def test_same_speaker_gap_is_shorter():
    clips = [Clip("박준영", tone(1.0), overlap=False), Clip("박준영", tone(1.0), overlap=False)]
    pl = place(clips, SR, seed=1)
    gap = pl[1].start - pl[0].end
    assert 0.15 <= gap <= 0.4


def test_overlap_starts_before_previous_ends():
    clips = [Clip("박준영", tone(2.0), overlap=False), Clip("이도현", tone(0.5), overlap=True)]
    pl = place(clips, SR, seed=1)
    lead = pl[0].end - pl[1].start
    assert 0.3 <= lead <= 0.8


def test_utterance_after_overlap_follows_the_longer_tail():
    # 겹침 발화가 앞 발화보다 먼저 끝나면 다음 턴은 앞 발화(더 긴 쪽) 끝을 기준으로 잡는다
    clips = [
        Clip("박준영", tone(3.0), overlap=False),
        Clip("이도현", tone(0.3), overlap=True),
        Clip("김서연", tone(1.0), overlap=False),
    ]
    pl = place(clips, SR, seed=1)
    assert pl[2].start >= pl[0].end + 0.4


def test_pause_adds_exact_silence():
    clips = [Clip("박준영", tone(1.0), overlap=False), Clip("김서연", tone(1.0), overlap=False)]
    pl = place(clips, SR, seed=1, pauses_before={1: 2.0})
    gap = pl[1].start - pl[0].end
    assert 2.4 <= gap <= 3.0


def test_placement_is_deterministic_for_seed():
    clips = [Clip("박준영", tone(1.0), overlap=False), Clip("김서연", tone(1.0), overlap=False)]
    assert place(clips, SR, seed=7) == place(clips, SR, seed=7)
    assert place(clips, SR, seed=7) != place(clips, SR, seed=8)
