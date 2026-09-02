"""발화 클립을 타임라인에 배치하고 한 트랙으로 합친다.

규칙(demo/README.md, 설계 §6.4):
- 화자가 바뀌는 턴: 0.4~1.0초 간격
- 같은 화자 연속: 0.15~0.4초
- [겹침]: 앞 발화 끝에서 0.3~0.8초 앞에 시작
- [사이 N초]: 위 간격에 N초를 더한다
간격은 seed 고정 RNG로 뽑아 같은 클립이면 같은 배치가 나온다.
"""

from __future__ import annotations

import io
import subprocess
from dataclasses import dataclass

import numpy as np
import soundfile as sf

SPEAKER_CHANGE_GAP = (0.4, 1.0)
SAME_SPEAKER_GAP = (0.15, 0.4)
OVERLAP_LEAD = (0.3, 0.8)


@dataclass
class Clip:
    speaker: str
    audio: np.ndarray  # float32 mono
    overlap: bool


@dataclass(frozen=True)
class Placement:
    speaker: str
    start: float
    end: float


def trim_silence(audio: np.ndarray, sr: int, threshold_db: float = -40.0, pad: float = 0.008) -> np.ndarray:
    thresh = 10 ** (threshold_db / 20)
    loud = np.flatnonzero(np.abs(audio) > thresh)
    if loud.size == 0:
        return audio
    pad_n = int(pad * sr)
    lo = max(0, int(loud[0]) - pad_n)
    hi = min(len(audio), int(loud[-1]) + 1 + pad_n)
    return audio[lo:hi]


def place(
    clips: list[Clip],
    sr: int,
    seed: int,
    pauses_before: dict[int, float] | None = None,
) -> list[Placement]:
    rng = np.random.default_rng(seed)
    pauses_before = pauses_before or {}
    out: list[Placement] = []
    tail = 0.0  # 지금까지 배치된 모든 클립 중 가장 늦은 끝
    prev: Placement | None = None
    for i, clip in enumerate(clips):
        dur = len(clip.audio) / sr
        if prev is None:
            start = 0.0
        elif clip.overlap:
            start = max(0.0, prev.end - rng.uniform(*OVERLAP_LEAD))
        else:
            lo, hi = SAME_SPEAKER_GAP if clip.speaker == prev.speaker else SPEAKER_CHANGE_GAP
            start = tail + rng.uniform(lo, hi) + pauses_before.get(i, 0.0)
        cur = Placement(clip.speaker, round(start, 4), round(start + dur, 4))
        out.append(cur)
        tail = max(tail, cur.end)
        prev = cur
    return out


def render(clips: list[Clip], placements: list[Placement], sr: int, gains_db: dict[str, float]) -> np.ndarray:
    total = int(max(p.end for p in placements) * sr) + 1
    mix = np.zeros(total, dtype=np.float32)
    for clip, p in zip(clips, placements):
        gain = 10 ** (gains_db.get(clip.speaker, 0.0) / 20)
        s = int(p.start * sr)
        seg = clip.audio * gain
        mix[s : s + len(seg)] += seg
    peak = float(np.max(np.abs(mix))) if total else 0.0
    ceiling = 10 ** (-1.0 / 20)
    if peak > ceiling:
        mix *= ceiling / peak
    return mix


def time_stretch(audio: np.ndarray, sr: int, factor: float) -> np.ndarray:
    """ffmpeg atempo로 피치를 유지한 채 길이를 1/factor로 줄인다. factor 1.0은 그대로."""
    if factor == 1.0:
        return audio
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="FLOAT")
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-af", f"atempo={factor}", "-f", "wav", "-c:a", "pcm_f32le", "pipe:1"],
        input=buf.getvalue(), capture_output=True, check=True,
    )
    out, out_sr = sf.read(io.BytesIO(proc.stdout), dtype="float32")
    assert out_sr == sr
    return out
