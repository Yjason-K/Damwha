import json

import numpy as np
import soundfile as sf

from damwha_demo_tts.cast import CAST, VOICES
from damwha_demo_tts.render import build_plan, dry_run_stats, render_meeting
from damwha_demo_tts.script_parser import Overlap, Pause, Utterance

SR = 24000


class FakeSynth:
    """텍스트 글자 수에 비례한 길이의 톤을 돌려준다. 네트워크 없음."""

    def __init__(self):
        self.calls = []

    def synthesize(self, req):
        self.calls.append(req)
        n = int(0.1 * len(req.text) * SR)
        t = np.arange(n) / SR
        return (0.3 * np.sin(2 * np.pi * 300 * t)).astype(np.float32), SR


def test_cast_has_four_speakers_with_distinct_voices():
    assert CAST == ("박준영", "김서연", "이도현", "최민지")
    assert set(VOICES.values()) == {"onyx", "sage", "echo", "nova"}


def test_build_plan_folds_pauses_into_next_spoken_index():
    events = [
        Utterance("박준영", "a"),
        Pause(2.0),
        Utterance("김서연", "b"),
        Pause(1.0),
        Pause(1.5),
        Overlap("이도현", "c"),
    ]
    spoken, pauses_before = build_plan(events)
    assert [s.speaker for s in spoken] == ["박준영", "김서연", "이도현"]
    assert pauses_before == {1: 2.0, 2: 2.5}


def test_dry_run_stats_counts_characters_and_estimates():
    events = [Utterance("박준영", "안녕하세요"), Overlap("이도현", "네"), Pause(1.0)]
    stats = dry_run_stats(events)
    assert stats["utterances"] == 2
    assert stats["chars"] == 6
    assert stats["est_usd"] > 0


def test_render_meeting_writes_wav_and_timeline(tmp_path):
    events = [
        Utterance("박준영", "자, 시작할까요."),
        Overlap("이도현", "네네."),
        Pause(1.0),
        Utterance("김서연", "그건 되는데 다만."),
    ]
    synth = FakeSynth()
    out_wav = tmp_path / "m.wav"
    timeline = render_meeting(events, synth, out_wav, seed=1)

    audio, sr = sf.read(out_wav)
    assert sr == SR
    assert len(timeline) == 3
    assert [t["speaker"] for t in timeline] == ["박준영", "이도현", "김서연"]
    assert timeline[1]["start"] < timeline[0]["end"]  # 겹침
    assert timeline[2]["start"] >= timeline[0]["end"] + 1.4  # 사이 1초 + 턴 간격
    assert abs(len(audio) / sr - timeline[-1]["end"]) < 0.05
    assert timeline[0]["text"] == "자, 시작할까요."
    # 화자별 목소리·지시문이 요청에 들어간다
    assert synth.calls[0].voice == VOICES["박준영"]
    assert synth.calls[0].instructions
