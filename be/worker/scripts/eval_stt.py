"""STT quality eval: compare transcriber backends against a reference transcript.

Runs up to four configurations on one (already 16k-mono-normalized) wav and
reports WER/CER against a YouTube json3 caption reference:

  turbo     mlx-whisper large-v3-turbo   (current `standard` preset)
  large     mlx-whisper large-v3         (current `quality` preset)
  faster    faster-whisper large-v3 int8 (cpu path / backend isolation)
  pipeline  diarize + build_utterances over the `turbo` words
            (measures text loss/reorder introduced by the pipeline, not STT)

By default the transcribe runs mirror the production path in
`pipeline/process_meeting.py`: Silero VAD → `prepare_stt_spans` → decode only
those spans. `--full-file` skips the VAD step and decodes the whole file
instead, which is what isolates the clip_timestamps guard from the decode-param
guards (`condition_on_previous_text` / `hallucination_silence_threshold`, which
are module constants in the adapters and therefore always on).

Usage:
    uv run --with jiwer python scripts/eval_stt.py \
        --wav /path/audio16k.wav --json3 /path/ref.ko.json3 \
        --outdir /path/outdir [--runs turbo,large,faster,pipeline] \
        [--language ko] [--full-file]

Caveat: YouTube auto-captions are themselves ASR output (Google) — treat the
numbers as *relative* signal between runs, not absolute accuracy.
Requires models extra (`uv sync --extra models`); `pipeline` additionally needs
HF_TOKEN in worker/.env (pyannote gated).

NOT a CI test — heavy/gated models, run by hand like smoke_process_meeting.py.
"""

import argparse
import json
import re
import sys
import time
import unicodedata
from pathlib import Path

import jiwer


def load_json3_text(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    parts: list[str] = []
    for ev in data.get("events", []):
        for seg in ev.get("segs") or []:
            t = seg.get("utf8", "")
            if t and t != "\n":
                parts.append(t)
    return " ".join(parts)


def normalize_text(s: str) -> str:
    s = unicodedata.normalize("NFC", s).lower()
    s = re.sub(r"\[.*?\]", " ", s)  # [음악], [박수] 등 캡션 이벤트 태그
    s = re.sub(r"[^0-9a-z가-힣\s]", " ", s)
    return " ".join(s.split())


def metrics(ref: str, hyp: str) -> dict:
    ref_n, hyp_n = normalize_text(ref), normalize_text(hyp)
    return {
        "wer": round(jiwer.wer(ref_n, hyp_n), 4),
        # 한국어: 띄어쓰기 차이 제거한 CER이 주 지표
        "cer": round(jiwer.cer(ref_n.replace(" ", ""), hyp_n.replace(" ", "")), 4),
        "ref_chars": len(ref_n.replace(" ", "")),
        "hyp_chars": len(hyp_n.replace(" ", "")),
    }


def hf_token() -> str | None:
    env = Path(__file__).resolve().parents[1] / ".env"
    if not env.is_file():
        return None
    for line in env.read_text().splitlines():
        if line.strip().startswith("HF_TOKEN="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def words_to_jsonable(words) -> list[dict]:
    return [
        {"text": w.text, "start_ms": w.start_ms, "end_ms": w.end_ms, "confidence": w.confidence}
        for w in words
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--json3", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--runs", default="turbo,large,faster,pipeline")
    ap.add_argument("--language", default="ko")
    ap.add_argument(
        "--full-file",
        action="store_true",
        help="decode the whole file instead of the VAD spans (drops the clip_timestamps guard)",
    )
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    ref_text = load_json3_text(Path(args.json3))
    (outdir / "ref.txt").write_text(ref_text, encoding="utf-8")

    runs = [r.strip() for r in args.runs.split(",") if r.strip()]
    results: dict[str, dict] = {}
    turbo_words = None

    # 프로덕션 경로와 동일하게 VAD 구간만 디코딩한다 (process_meeting.py의 stt 단계).
    # spans=None이면 어댑터가 전체 파일을 전사한다.
    spans = None
    raw_spans: list = []
    if not args.full_file:
        from damwha_worker.models.silero_vad import SileroVAD
        from damwha_worker.pipeline.ffmpeg import probe
        from damwha_worker.pipeline.stt_spans import prepare_stt_spans

        duration_ms = probe(args.wav).duration_ms
        raw_spans = SileroVAD().detect(args.wav)
        spans = prepare_stt_spans(raw_spans, duration_ms)
        clipped = sum(s.end_ms - s.start_ms for s in spans)
        print(
            f"[vad] spans={len(spans)} clipped_ms={clipped} duration_ms={duration_ms}", flush=True
        )

    def report(name: str, hyp: str, elapsed: float, extra: dict | None = None) -> None:
        m = metrics(ref_text, hyp)
        m["elapsed_s"] = round(elapsed, 1)
        if extra:
            m.update(extra)
        results[name] = m
        (outdir / f"hyp_{name}.txt").write_text(hyp, encoding="utf-8")
        print(f"[{name}] {m}", flush=True)

    if "turbo" in runs or "pipeline" in runs:
        from damwha_worker.models.whisper_mlx import MlxWhisper

        t0 = time.perf_counter()
        turbo_words = MlxWhisper("large-v3-turbo").transcribe(args.wav, args.language, spans)
        el = time.perf_counter() - t0
        (outdir / "words_turbo.json").write_text(json.dumps(words_to_jsonable(turbo_words)))
        if "turbo" in runs:
            report("turbo", " ".join(w.text for w in turbo_words), el, {"words": len(turbo_words)})

    if "large" in runs:
        from damwha_worker.models.whisper_mlx import MlxWhisper

        t0 = time.perf_counter()
        words = MlxWhisper("large-v3").transcribe(args.wav, args.language, spans)
        report(
            "large",
            " ".join(w.text for w in words),
            time.perf_counter() - t0,
            {"words": len(words)},
        )

    if "faster" in runs:
        from damwha_worker.models.whisper_faster import FasterWhisper

        t0 = time.perf_counter()
        words = FasterWhisper("large-v3", device="cpu").transcribe(args.wav, args.language, spans)
        report(
            "faster",
            " ".join(w.text for w in words),
            time.perf_counter() - t0,
            {"words": len(words)},
        )

    if "pipeline" in runs:
        token = hf_token()
        if not token:
            print("pipeline run skipped: no HF_TOKEN in worker/.env", file=sys.stderr)
        else:
            from damwha_worker.models.device import torch_device
            from damwha_worker.models.pyannote_diar import PyannoteDiarizer
            from damwha_worker.models.silero_vad import SileroVAD
            from damwha_worker.pipeline.align import build_utterances

            t0 = time.perf_counter()
            # align의 failed_spans는 pad 전 원본 VAD span (stt_spans 모듈 주석 참고)
            failed_spans = raw_spans or SileroVAD().detect(args.wav)
            segments = PyannoteDiarizer(
                "pyannote/speaker-diarization-3.1", token, torch_device("gpu")
            ).diarize(args.wav)
            utts = build_utterances(turbo_words, segments, failed_spans=failed_spans)
            hyp = " ".join(u.text for u in utts if u.text)
            report(
                "pipeline",
                hyp,
                time.perf_counter() - t0,
                {
                    "segments": len(segments),
                    "utterances": len(utts),
                    "non_ok": sum(1 for u in utts if u.status != "ok"),
                },
            )

    (outdir / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print("\n=== summary (CER 기준, 낮을수록 좋음) ===")
    for name, m in sorted(results.items(), key=lambda kv: kv[1]["cer"]):
        print(f"  {name:<9} CER {m['cer']:.4f}  WER {m['wer']:.4f}  {m['elapsed_s']}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
