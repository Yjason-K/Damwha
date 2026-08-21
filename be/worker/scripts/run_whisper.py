"""whisper large-v3-turbo 전사 출력 확인용 단독 스크립트.

파일 하나를 넣고 전사 결과를 눈으로 보는 것이 목적이다. 프로덕션 어댑터
(`models/whisper_mlx.py`)를 그대로 쓰므로 여기서 보이는 텍스트는 파이프라인이
STT 단계에서 만들어내는 텍스트와 같다 — 화자 분리/문장 병합은 하지 않는다.

입력이 16 kHz mono FLAC이 아니면 `pipeline.ffmpeg.normalize()`로 임시 파일을
만들어 쓴다(워커와 동일한 전처리). `--keep-normalized`로 남길 수 있다.

기본은 전체 파일 디코딩. `--vad`를 주면 프로덕션 경로와 같이 Silero VAD →
prepare_stt_spans로 발화 구간만 디코딩한다.

Usage:
    uv run python scripts/run_whisper.py <audio> [--language ko] [--vad]
        [--model large-v3-turbo] [--json out.json]

models extra 필요(`uv sync --extra models`). CI 테스트 아님 — 손으로 돌린다.
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from damwha_worker.models.base import Word  # noqa: E402
from damwha_worker.models.whisper_mlx import _REPO, MlxWhisper  # noqa: E402
from damwha_worker.pipeline.ffmpeg import normalize, probe  # noqa: E402

# 단어 사이가 이 간격 이상 벌어지면 새 줄로 끊는다 — 출력 가독성 목적일 뿐,
# 파이프라인의 발화 분할(build_utterances)과는 무관하다.
_LINE_GAP_MS = 700


def _stream_info(path: str) -> tuple[int, int]:
    """(sample_rate, channels) — ProbeResult는 duration만 들고 있어서 여기서 따로 본다."""
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "json",
            path,
        ],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {proc.stderr!r}")
    stream = json.loads(proc.stdout or b"{}").get("streams", [{}])[0]
    return int(stream.get("sample_rate", 0)), int(stream.get("channels", 0))


def _fmt_ts(ms: int) -> str:
    s, ms = divmod(int(ms), 1000)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def to_lines(words: list[Word], gap_ms: int = _LINE_GAP_MS) -> list[dict]:
    lines: list[dict] = []
    for w in words:
        if lines and w.start_ms - lines[-1]["end_ms"] < gap_ms:
            # align.build_utterances와 같은 공백 조인 — 어댑터가 단어 앞뒤 공백을
            # 이미 떼어내므로 그냥 이으면 붙어버린다.
            lines[-1]["text"] += " " + w.text
            lines[-1]["end_ms"] = w.end_ms
        else:
            lines.append({"start_ms": w.start_ms, "end_ms": w.end_ms, "text": w.text})
    for line in lines:
        line["text"] = line["text"].strip()
    return [line for line in lines if line["text"]]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("audio", help="입력 오디오(어떤 포맷이든 — 필요하면 자동 정규화)")
    ap.add_argument("--language", default="ko")
    ap.add_argument("--model", default="large-v3-turbo", choices=sorted(_REPO))
    ap.add_argument("--vad", action="store_true", help="Silero VAD 발화 구간만 디코딩")
    ap.add_argument("--json", dest="json_out", help="단어/줄 결과를 JSON으로 저장")
    ap.add_argument("--keep-normalized", help="정규화된 FLAC을 이 경로에 남긴다")
    args = ap.parse_args()

    src = Path(args.audio).expanduser().resolve()
    if not src.is_file():
        print(f"no such file: {src}", file=sys.stderr)
        return 2

    sample_rate, channels = _stream_info(str(src))
    if src.suffix.lower() == ".flac" and sample_rate == 16000 and channels == 1:
        wav = src
    else:
        tmp = Path(args.keep_normalized or f"/tmp/{src.stem}.16k.flac").expanduser()
        print(f"normalizing → {tmp} ({sample_rate} Hz / {channels}ch)", file=sys.stderr)
        normalize(str(src), str(tmp))
        wav = tmp
    info = probe(str(wav))

    spans = None
    if args.vad:
        from damwha_worker.models.silero_vad import SileroVAD
        from damwha_worker.pipeline.stt_spans import prepare_stt_spans

        t0 = time.perf_counter()
        spans = prepare_stt_spans(SileroVAD().detect(str(wav)), info.duration_ms)
        speech_s = sum(s.end_ms - s.start_ms for s in spans) / 1000
        print(
            f"vad: {len(spans)} spans / {speech_s:.1f}s speech ({time.perf_counter() - t0:.1f}s)",
            file=sys.stderr,
        )

    print(
        f"transcribing {wav.name} with {_REPO[args.model]} (lang={args.language})", file=sys.stderr
    )
    t0 = time.perf_counter()
    words = MlxWhisper(args.model).transcribe(str(wav), args.language, spans)
    elapsed = time.perf_counter() - t0

    lines = to_lines(words)
    for line in lines:
        print(f"[{_fmt_ts(line['start_ms'])} → {_fmt_ts(line['end_ms'])}] {line['text']}")

    audio_s = info.duration_ms / 1000
    print(
        f"\n{len(words)} words / {len(lines)} lines · {elapsed:.1f}s "
        f"for {audio_s:.1f}s audio (RTF {elapsed / audio_s:.2f}x)",
        file=sys.stderr,
    )

    if args.json_out:
        out = Path(args.json_out).expanduser()
        out.write_text(
            json.dumps(
                {
                    "audio": str(src),
                    "model": _REPO[args.model],
                    "language": args.language,
                    "vad": args.vad,
                    "elapsed_s": round(elapsed, 2),
                    "lines": lines,
                    "words": [
                        {
                            "text": w.text,
                            "start_ms": w.start_ms,
                            "end_ms": w.end_ms,
                            "confidence": w.confidence,
                        }
                        for w in words
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(f"wrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
