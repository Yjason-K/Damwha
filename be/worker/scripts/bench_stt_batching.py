"""STT clip 호출 전략 벤치마크 — 파이프라인 코드를 고치기 전에 가설을 재는 하네스.

`whisper_mlx.transcribe()`는 VAD span 하나마다 `mlx_whisper.transcribe()`를 부른다.
mlx_whisper는 호출마다 (1) 전체 오디오 log-mel을 다시 만들고(transcribe.py:150)
(2) clip이 2초든 20초든 30초 창 단위로 디코딩한다. 이 스크립트는 그 두 낭비의
크기를 실제 파일·실제 VAD span으로 측정하고, 대안 전략의 속도와 텍스트 변화를
같이 뽑는다. 파이프라인은 건드리지 않는다 — 순수 계측.

변형(--variants):
  baseline  현재 프로덕션 경로. 전체 오디오 mx.array + clip_timestamps=[s,e], span당 1회
  slice     audio[start:end]만 잘라 전달, clip_timestamps 없음. (B안) 텍스트는 baseline과
            같아야 정상 — 디코더가 보는 오디오가 같기 때문
  packed    gap이 --max-gap-ms 이하인 인접 span을 --max-chunk-ms까지 묶어 한 번에 전달.
            (A안) 무음을 일부 다시 넣으므로 환각 위험이 있다 — 그래서 텍스트 비교가 핵심

정적 통계(디코딩 없이도 나온다):
  span 수, 발화 총길이, 30초 창으로 올림한 디코딩 길이 → 패딩 낭비 배수

측정 결과는 --outdir에 JSON + 변형별 텍스트로 남긴다.

Usage:
    uv run python scripts/bench_stt_batching.py \
        --wav ../storage/meetings/mtg_17/normalized.flac \
        --outdir /tmp/bench --limit-speech-s 120

NOT a CI test — 무거운 모델을 쓴다. eval_stt.py처럼 손으로 돌린다.
"""

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from damwha_worker.models.base import SpeechSpan, Word  # noqa: E402
from damwha_worker.pipeline.ffmpeg import probe  # noqa: E402
from damwha_worker.pipeline.stt_repetition import drop_repetition_loops  # noqa: E402
from damwha_worker.pipeline.stt_spans import prepare_stt_spans  # noqa: E402

_SR = 16000
_WINDOW_S = 30.0  # whisper 디코딩 창 — clip이 이보다 짧아도 창 하나를 통째로 쓴다
_REPO = "mlx-community/whisper-large-v3-turbo"
_CONDITION_ON_PREVIOUS_TEXT = False
_HALLUCINATION_SILENCE_S = 2.0


@dataclass
class SpanStats:
    n_spans: int
    speech_s: float
    decoded_s: float  # 30초 창으로 올림한 실제 디코딩 길이
    waste_ratio: float


def span_stats(spans: list[SpeechSpan]) -> SpanStats:
    import math

    speech_s = sum(s.end_ms - s.start_ms for s in spans) / 1000
    decoded_s = sum(
        max(1, math.ceil((s.end_ms - s.start_ms) / 1000 / _WINDOW_S)) * _WINDOW_S for s in spans
    )
    return SpanStats(
        n_spans=len(spans),
        speech_s=round(speech_s, 1),
        decoded_s=round(decoded_s, 1),
        waste_ratio=round(decoded_s / speech_s, 2) if speech_s else 0.0,
    )


def pack_spans(
    spans: list[SpeechSpan], *, max_gap_ms: int, max_chunk_ms: int
) -> list[list[SpeechSpan]]:
    """인접 span을 청크로 묶는다. 청크 하나가 transcribe() 한 번이 된다.

    묶으면 사이의 무음도 디코더에 들어간다 — max_gap_ms가 그 노출량의 상한이다.
    """
    chunks: list[list[SpeechSpan]] = []
    for s in spans:
        if chunks:
            cur = chunks[-1]
            gap = s.start_ms - cur[-1].end_ms
            span_len = s.end_ms - cur[0].start_ms
            if gap <= max_gap_ms and span_len <= max_chunk_ms:
                cur.append(s)
                continue
        chunks.append([s])
    return chunks


def chunk_spans(chunks: list[list[SpeechSpan]]) -> list[SpeechSpan]:
    """청크를 '시작~끝' 하나의 span으로 접는다 — 디코더가 실제로 보는 구간."""
    return [SpeechSpan(c[0].start_ms, c[-1].end_ms) for c in chunks]


def windows(spans: list[SpeechSpan]) -> int:
    """인코더가 도는 30초 창의 총 개수 — turbo의 지배적 비용."""
    import math

    return sum(max(1, math.ceil((s.end_ms - s.start_ms) / 1000 / _WINDOW_S)) for s in spans)


def _words_from(result: dict, offset_ms: int = 0) -> list[Word]:
    out: list[Word] = []
    for segment in result.get("segments", []):
        for w in segment.get("words", []):
            text = w["word"].strip()
            if not text:
                continue
            out.append(
                Word(
                    text=text,
                    start_ms=int(w["start"] * 1000) + offset_ms,
                    end_ms=int(w["end"] * 1000) + offset_ms,
                    confidence=w.get("probability"),
                )
            )
    return out


def _mem_mb() -> float:
    import mlx.core as mx

    return round(mx.get_active_memory() / 1024 / 1024, 1)


def run_variant(
    variant: str,
    audio,
    spans: list[SpeechSpan],
    *,
    language: str,
    max_gap_ms: int,
    max_chunk_ms: int,
    temperature: tuple[float, ...] | None = None,
) -> dict:
    import mlx.core as mx
    import mlx_whisper

    def _call(arr, **extra) -> dict:
        # temperature 사다리는 whisper 기본이 (0, .2, .4, .6, .8, 1.0)이다.
        # 축퇴한 창은 사다리를 끝까지 올라가도 결국 실패하고, 그 출력은
        # drop_repetition_loops가 버린다 — 사다리 길이가 곧 낭비의 크기다.
        if temperature is not None:
            extra["temperature"] = temperature
        return mlx_whisper.transcribe(
            arr,
            path_or_hf_repo=_REPO,
            language=language,
            word_timestamps=True,
            condition_on_previous_text=_CONDITION_ON_PREVIOUS_TEXT,
            hallucination_silence_threshold=_HALLUCINATION_SILENCE_S,
            **extra,
        )

    mx.clear_cache()
    words: list[Word] = []
    t0 = time.perf_counter()

    if variant == "baseline":
        full = mx.array(audio)
        calls = len(spans)
        for s in spans:
            words += _words_from(_call(full, clip_timestamps=[s.start_ms / 1000, s.end_ms / 1000]))
    elif variant == "slice":
        calls = len(spans)
        for s in spans:
            clip = audio[int(s.start_ms / 1000 * _SR) : int(s.end_ms / 1000 * _SR)]
            words += _words_from(_call(mx.array(clip)), offset_ms=s.start_ms)
    elif variant == "packed":
        chunks = pack_spans(spans, max_gap_ms=max_gap_ms, max_chunk_ms=max_chunk_ms)
        calls = len(chunks)
        for chunk in chunks:
            start_ms, end_ms = chunk[0].start_ms, chunk[-1].end_ms
            clip = audio[int(start_ms / 1000 * _SR) : int(end_ms / 1000 * _SR)]
            words += _words_from(_call(mx.array(clip)), offset_ms=start_ms)
    else:
        raise ValueError(f"unknown variant {variant!r}")

    elapsed = time.perf_counter() - t0
    speech_s = sum(s.end_ms - s.start_ms for s in spans) / 1000
    # 프로덕션은 마지막에 디코더 축퇴 반복을 걷어낸다 — 텍스트 비교를 같은 지점에서
    # 하려면 여기서도 걸어야 한다. raw도 같이 보고해 축퇴량 자체를 드러낸다.
    cleaned = drop_repetition_loops(words)
    return {
        "variant": variant,
        "calls": calls,
        "elapsed_s": round(elapsed, 1),
        "realtime_factor": round(speech_s / elapsed, 2) if elapsed else 0.0,
        "raw_words": len(words),
        "words": len(cleaned),
        "dropped_by_repetition_filter": len(words) - len(cleaned),
        "active_memory_mb": _mem_mb(),
        "text": " ".join(w.text for w in cleaned),
    }


def measure_mel(audio, language: str) -> dict:
    """호출당 전체 mel 재계산 비용 — B안이 없앨 수 있는 고정비의 크기."""
    import mlx.core as mx
    from mlx_whisper.audio import N_SAMPLES, log_mel_spectrogram

    full = mx.array(audio)
    log_mel_spectrogram(full, n_mels=128, padding=N_SAMPLES)  # warmup
    mx.eval(full)
    t0 = time.perf_counter()
    for _ in range(3):
        mel = log_mel_spectrogram(full, n_mels=128, padding=N_SAMPLES)
        mx.eval(mel)
    per_call = (time.perf_counter() - t0) / 3
    return {"full_mel_s_per_call": round(per_call, 3), "mel_frames": int(mel.shape[-2])}


def cer(ref: str, hyp: str) -> float:
    """문자 오류율 — 변형이 텍스트를 얼마나 바꿨는지. baseline이 ref."""
    import jiwer

    return round(jiwer.cer(ref, hyp), 4)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--wav", required=True, help="16k mono로 정규화된 파일")
    p.add_argument("--outdir", required=True)
    p.add_argument("--language", default="ko")
    p.add_argument("--variants", default="baseline,slice,packed")
    p.add_argument(
        "--limit-speech-s",
        type=float,
        default=120.0,
        help="앞에서부터 이만큼의 발화만 사용 (0=전체). 변형 간 동일 span 집합을 쓴다",
    )
    p.add_argument("--max-gap-ms", type=int, default=1500, help="packed: 묶어줄 무음 상한")
    p.add_argument("--max-chunk-ms", type=int, default=28000, help="packed: 청크 길이 상한")
    p.add_argument("--stats-only", action="store_true", help="디코딩 없이 span 통계만")
    p.add_argument(
        "--temperatures",
        default="",
        help="변형별 temperature 사다리를 ';'로 구분해 지정 (예: '0,0.2,0.4,0.6,0.8,1.0;0,0.2')."
        " 비우면 whisper 기본값을 쓴다. --variants와 개수가 같아야 한다",
    )
    args = p.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    duration_ms = probe(args.wav).duration_ms
    print(f"audio: {args.wav}  duration={duration_ms / 1000:.1f}s", flush=True)

    from damwha_worker.models.silero_vad import SileroVAD

    t0 = time.perf_counter()
    raw_spans = SileroVAD().detect(args.wav)
    spans_all = prepare_stt_spans(raw_spans, duration_ms)
    vad_s = time.perf_counter() - t0
    print(f"VAD: {len(raw_spans)} raw → {len(spans_all)} prepared  ({vad_s:.1f}s)")

    full_stats = span_stats(spans_all)
    print(f"전체 span 통계: {asdict(full_stats)}", flush=True)

    spans = spans_all
    if args.limit_speech_s:
        acc, spans = 0.0, []
        for s in spans_all:
            if acc >= args.limit_speech_s * 1000:
                break
            spans.append(s)
            acc += s.end_ms - s.start_ms
    bench_stats = span_stats(spans)
    print(f"벤치 대상: {asdict(bench_stats)}", flush=True)

    # A안 이득의 상한은 "30초 창을 몇 개나 줄이느냐"다. turbo는 디코더만 잘라낸
    # 모델이라 인코더가 지배적이고, 인코더는 clip 길이와 무관하게 창당 30초를 통째로
    # 돈다 — 그래서 창 개수가 곧 비용이다.
    full_packed = chunk_spans(
        pack_spans(spans_all, max_gap_ms=args.max_gap_ms, max_chunk_ms=args.max_chunk_ms)
    )
    full_packed_stats = span_stats(full_packed)
    print(
        f"전체 packed: {len(spans_all)} spans → {len(full_packed)} chunks  "
        f"{asdict(full_packed_stats)}",
        flush=True,
    )
    print(
        f"창 개수: {windows(spans_all)} → {windows(full_packed)} "
        f"(상한 이득 {windows(spans_all) / max(1, windows(full_packed)):.2f}x)",
        flush=True,
    )

    packed_preview = pack_spans(spans, max_gap_ms=args.max_gap_ms, max_chunk_ms=args.max_chunk_ms)
    print(
        f"벤치 packed 미리보기: {len(spans)} spans → {len(packed_preview)} chunks "
        f"(gap<={args.max_gap_ms}ms, chunk<={args.max_chunk_ms}ms)",
        flush=True,
    )

    report: dict = {
        "wav": args.wav,
        "duration_s": round(duration_ms / 1000, 1),
        "full_span_stats": asdict(full_stats),
        "full_packed_stats": asdict(full_packed_stats),
        "full_windows": windows(spans_all),
        "full_packed_windows": windows(full_packed),
        "bench_span_stats": asdict(bench_stats),
        "packed_chunks": len(packed_preview),
        "max_gap_ms": args.max_gap_ms,
        "max_chunk_ms": args.max_chunk_ms,
        "runs": [],
    }

    if args.stats_only:
        (outdir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    from mlx_whisper.audio import load_audio

    audio = load_audio(args.wav)
    report["mel"] = measure_mel(audio, args.language)
    print(f"mel: {report['mel']}", flush=True)

    # 같은 변형을 두 번 적으면 실행 편차(노이즈 바닥)를 잰다 — decode_with_fallback이
    # temperature>0으로 넘어가면 샘플링이 확률적이라 같은 입력도 매번 다른 텍스트를
    # 낸다. 변형 간 차이를 이 바닥과 비교해야 의미가 있다.
    ladders: list[tuple[float, ...]] = []
    if args.temperatures:
        ladders = [
            tuple(float(x) for x in group.split(",")) for group in args.temperatures.split(";")
        ]
        n_variants = len([v for v in args.variants.split(",") if v.strip()])
        if len(ladders) != n_variants:
            raise SystemExit(f"--temperatures {len(ladders)}개 != --variants {n_variants}개")

    baseline_text = None
    seen: dict[str, int] = {}
    for idx, variant in enumerate(args.variants.split(",")):
        variant = variant.strip()
        if not variant:
            continue
        seen[variant] = seen.get(variant, 0) + 1
        label = variant if seen[variant] == 1 else f"{variant}#{seen[variant]}"
        print(f"--- {label} 실행 중 ---", flush=True)
        r = run_variant(
            variant,
            audio,
            spans,
            language=args.language,
            max_gap_ms=args.max_gap_ms,
            max_chunk_ms=args.max_chunk_ms,
            temperature=ladders[idx] if ladders else None,
        )
        r["temperature"] = ladders[idx] if ladders else "whisper default"
        text = r.pop("text")
        r["variant"] = label
        (outdir / f"{label.replace('#', '_')}.txt").write_text(text, encoding="utf-8")
        if baseline_text is None:
            baseline_text = text
        else:
            try:
                r["cer_vs_baseline"] = cer(baseline_text, text)
            except ImportError:
                r["cer_vs_baseline"] = None  # jiwer 없음 — 텍스트 파일로 직접 비교
        r["chars"] = len(text)
        report["runs"].append(r)
        print(json.dumps(r, ensure_ascii=False), flush=True)

    (outdir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("\n=== 요약 ===")
    print(json.dumps(report["runs"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
