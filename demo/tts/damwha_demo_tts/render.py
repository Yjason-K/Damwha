"""대본 한 편 → 회의 오디오(m4a) + 타임라인(json).

    uv run --directory demo/tts render 01          # demo/scripts/01-*.md
    uv run --directory demo/tts render 01 --dry-run

출력은 demo/audio/NN-<slug>.m4a 와 .timeline.json. 발화별 TTS 결과는
demo/audio/.cache/ 에 캐시된다.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import soundfile as sf

from .cast import CAST, GAINS_DB, INSTRUCTIONS, VOICES
from .mixer import Clip, place, render, time_stretch, trim_silence
from .script_parser import Event, Overlap, Pause, Utterance, parse_script
from .synth import Synthesizer, SynthRequest

DEMO_DIR = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = DEMO_DIR / "scripts"
AUDIO_DIR = DEMO_DIR / "audio"

# 샘플 실측: 한국어 68자 ≈ 12.5초. gpt-4o-mini-tts ≈ $0.015/분(출력 오디오 토큰 기준).
SECONDS_PER_CHAR = 0.18
USD_PER_MINUTE = 0.015

# 1회차 실측 중앙값 0.149초/자를 1.1로 압축 → 약 0.135초/자. 지시문으로는 속도가 안 움직여
# (±10% 노이즈) ffmpeg atempo를 클립 단위로 건다. [사이]와 턴 간격은 압축하지 않는다.
TEMPO = 1.1

# TTS가 가끔 문장을 통째로 버린 0.3초짜리 결과를 준다(스파이크에서 실제 발생).
# 압축 전 기준 초/자가 이 아래면 깨진 출력으로 보고 죽인다. 정상 p5는 0.127.
MIN_SECONDS_PER_CHAR = 0.06


class BrokenClipError(RuntimeError):
    pass

Spoken = Utterance | Overlap


def build_plan(events: list[Event]) -> tuple[list[Spoken], dict[int, float]]:
    spoken: list[Spoken] = []
    pauses_before: dict[int, float] = {}
    pending = 0.0
    for ev in events:
        if isinstance(ev, Pause):
            pending += ev.seconds
            continue
        if pending:
            pauses_before[len(spoken)] = pending
            pending = 0.0
        spoken.append(ev)
    return spoken, pauses_before


def dry_run_stats(events: list[Event]) -> dict:
    spoken, _ = build_plan(events)
    chars = sum(len(s.text) for s in spoken)
    minutes = chars * SECONDS_PER_CHAR / 60
    return {
        "utterances": len(spoken),
        "overlaps": sum(isinstance(s, Overlap) for s in spoken),
        "chars": chars,
        "est_minutes": round(minutes, 1),
        "est_usd": round(minutes * USD_PER_MINUTE, 4),
    }


def render_meeting(events: list[Event], synth, out_wav: Path, seed: int, workers: int = 4, tempo: float = TEMPO) -> list[dict]:
    spoken, pauses_before = build_plan(events)
    reqs = [SynthRequest(voice=VOICES[s.speaker], instructions=INSTRUCTIONS[s.speaker], text=s.text) for s in spoken]

    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(synth.synthesize, reqs))
    rates = {sr for _, sr in results}
    if len(rates) != 1:
        raise RuntimeError(f"mixed sample rates from TTS: {rates}")
    sr = rates.pop()

    clips: list[Clip] = []
    for s, (audio, _) in zip(spoken, results):
        audio = trim_silence(audio, sr)
        if len(audio) / sr < MIN_SECONDS_PER_CHAR * len(s.text):
            raise BrokenClipError(
                f"line {s.line}: TTS returned {len(audio)/sr:.2f}s for {len(s.text)} chars — {s.text[:40]!r}"
            )
        clips.append(Clip(speaker=s.speaker, audio=time_stretch(audio, sr, tempo), overlap=isinstance(s, Overlap)))
    placements = place(clips, sr, seed=seed, pauses_before=pauses_before)
    mix = render(clips, placements, sr, GAINS_DB)

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_wav, mix, sr, subtype="PCM_16")
    return [
        {"speaker": s.speaker, "start": p.start, "end": p.end, "overlap": isinstance(s, Overlap), "text": s.text, "line": s.line}
        for s, p in zip(spoken, placements)
    ]


def _find_script(number: str) -> Path:
    matches = sorted(SCRIPTS_DIR.glob(f"{number}-*.md"))
    if len(matches) != 1:
        raise SystemExit(f"expected exactly one demo/scripts/{number}-*.md, found {matches}")
    return matches[0]


def _encode_m4a(wav: Path, m4a: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "aac", "-b:a", "96k", "-ac", "1", str(m4a)],
        check=True,
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("number", help="회차 번호. demo/scripts/NN-*.md 의 NN")
    ap.add_argument("--dry-run", action="store_true", help="API 호출 없이 발화 수·문자 수·예상 비용만 출력")
    ap.add_argument("--keep-wav", action="store_true", help="m4a 인코딩 후 중간 wav를 지우지 않는다")
    args = ap.parse_args(argv)

    script = _find_script(args.number)
    events = parse_script(script.read_text(encoding="utf-8"), CAST)
    stats = dry_run_stats(events)
    print(f"{script.name}: {json.dumps(stats, ensure_ascii=False)}", file=sys.stderr)
    if args.dry_run:
        return 0

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set")

    slug = script.stem
    out_wav = AUDIO_DIR / f"{slug}.wav"
    out_m4a = AUDIO_DIR / f"{slug}.m4a"
    out_json = AUDIO_DIR / f"{slug}.timeline.json"

    synth = Synthesizer(api_key=api_key, cache_dir=AUDIO_DIR / ".cache")
    timeline = render_meeting(events, synth, out_wav, seed=int(args.number))
    _encode_m4a(out_wav, out_m4a)
    if not args.keep_wav:
        out_wav.unlink()
    out_json.write_text(json.dumps(timeline, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    total = timeline[-1]["end"]
    print(f"wrote {out_m4a.relative_to(DEMO_DIR.parent)} ({total/60:.1f} min) + {out_json.name}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
