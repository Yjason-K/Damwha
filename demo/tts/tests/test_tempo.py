import numpy as np
import pytest

from damwha_demo_tts.mixer import time_stretch
from damwha_demo_tts.render import BrokenClipError, render_meeting
from damwha_demo_tts.script_parser import Utterance

SR = 24000


def tone(seconds):
    t = np.arange(int(seconds * SR)) / SR
    return (0.4 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def test_time_stretch_shortens_by_factor_keeping_sample_rate():
    out = time_stretch(tone(2.0), SR, 1.1)
    assert abs(len(out) / SR - 2.0 / 1.1) < 0.03
    assert out.dtype == np.float32


def test_time_stretch_factor_one_is_identity():
    a = tone(1.0)
    assert np.array_equal(time_stretch(a, SR, 1.0), a)


class TinySynth:
    def synthesize(self, req):
        return tone(0.25), SR  # 50자 문장에 0.25초 → 깨진 출력


def test_render_rejects_clip_far_too_short_for_its_text(tmp_path):
    events = [Utterance("박준영", "정리하면, 이번 MVP는 주간 반복만 갑니다. 월간이랑 커스텀 규칙은 다음 분기로 넘기죠.", line=7)]
    with pytest.raises(BrokenClipError, match="line 7"):
        render_meeting(events, TinySynth(), tmp_path / "x.wav", seed=1)
