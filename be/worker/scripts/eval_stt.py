"""STT quality eval: compare transcriber backends against a reference transcript.

Runs up to six configurations on one (already 16k-mono-normalized) wav and
reports WER/CER against a YouTube json3 caption reference:

  turbo     mlx-whisper large-v3-turbo   (current `standard` preset)
  large     mlx-whisper large-v3         (current `quality` preset)
  faster    faster-whisper large-v3 int8 (cpu path / backend isolation)
  qwen17    Qwen3-ASR-1.7B-bf16 via mlx-audio  (whole file only — see below)
  qwen06    Qwen3-ASR-0.6B-bf16 via mlx-audio  (whole file only)
  pipeline  diarize + build_utterances over the `turbo` words
            (measures text loss/reorder introduced by the pipeline, not STT)

By default the whisper runs mirror the production path in
`pipeline/process_meeting.py`: Silero VAD → `prepare_stt_spans` → decode only
those spans. `--full-file` skips the VAD step and decodes the whole file
instead, which is what isolates the clip_timestamps guard from the decode-param
guards (`condition_on_previous_text` / `hallucination_silence_threshold`, which
are module constants in the adapters and therefore always on).

The `qwen*` runs ignore both — Qwen3-ASR has no clip_timestamps equivalent, so
they always decode the whole file and report `full_file: true`. Compare them
against a `--full-file` turbo run for a like-for-like read, and against the
default turbo run for "would swapping it in help in production".

Usage:
    uv run --with jiwer python scripts/eval_stt.py \
        --wav /path/audio16k.wav --json3 /path/ref.ko.json3 \
        --outdir /path/outdir [--runs turbo,large,faster,pipeline] \
        [--language ko] [--full-file]

Caveat: YouTube auto-captions are themselves ASR output (Google) — treat the
numbers as *relative* signal between runs, not absolute accuracy.
Requires models extra (`uv sync --extra models`); `pipeline` additionally needs
HF_TOKEN in worker/.env (pyannote gated), and the `qwen*` runs need
`--with mlx-audio` (not a worker dependency — this script only).

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


_QWEN = {
    "qwen17": "mlx-community/Qwen3-ASR-1.7B-bf16",
    "qwen06": "mlx-community/Qwen3-ASR-0.6B-bf16",
}
# mlx-audio takes a language *name*, not an ISO code.
_QWEN_LANG = {"ko": "Korean", "en": "English"}


def qwen_transcribe(repo: str, wav_path: str, language: str) -> tuple[str, float]:
    """Transcribe the whole file with a Qwen3-ASR MLX model; return (text, seconds).

    Deliberately NOT a `Transcriber` implementation. Qwen3-ASR emits no word
    timings — mlx-audio's `STTOutput.segments` are chunk boundaries
    (`chunk_duration` defaults to 1200s), so a 17-minute file yields one
    segment spanning the file. Faking `Word(start_ms=0, ...)` to satisfy the
    protocol would make align/diarization silently wrong, so this eval path
    returns text only. Word timings need `Qwen3-ForcedAligner-0.6B` as a second
    stage; that is the open question this eval is meant to inform, not answer.
    """
    from mlx_audio.stt import load

    model = load(repo)
    t0 = time.perf_counter()
    out = model.generate(wav_path, language=_QWEN_LANG.get(language, language))
    return out.text, time.perf_counter() - t0


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

    for name in ("qwen17", "qwen06"):
        if name in runs:
            # spans는 무시된다 — results.json만 보고 조건을 착각하지 않도록 표시한다.
            text, el = qwen_transcribe(_QWEN[name], args.wav, args.language)
            report(name, text, el, {"full_file": True})

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
