"""Speaker-attribution eval: who-said-which-words, scored against a Clova Note transcript.

`eval_diarization.py` scores time segments against a hand-labelled RTTM and
`eval_stt.py` scores text only. Neither answers the question users actually see
in the transcript view: *is this sentence shown under the right person?* This
does, using a Clova Note export (speaker-attributed text, `참석자 N mm:ss`
headers) as the reference — no hand labelling needed.

Two steps, because the models are the slow part and align is what we iterate on:

  cache   run VAD → pyannote (regular AND exclusive output) → ECAPA → Whisper once
          per wav, exactly like `process_meeting`, and store everything align needs
          as JSON. ~10–20 min per hour of audio.
  score   rebuild utterances from the cache with each align variant and score them.
          Seconds per variant (plus the embedding arbiter's ECAPA calls).

Scoring: hyp text and ref text are aligned character by character (Hangul split
into jamo so edlib's 256-symbol limit holds; spaces/punctuation dropped). On
characters that match, the hyp speaker is compared with the ref speaker after an
optimal 1:1 label mapping (Hungarian), as DER does.

  match      share of ref chars matched by a hyp char — STT overlap, sanity only
  attr       speaker-attribution accuracy over matched chars (headline)
  head→prev  on each ref speaker change A→B, share of B's first 12 matched chars
             attributed to A — "B's opening line recorded as A"
  tail→next  share of A's last 12 matched chars attributed to B
  turn       share of ref turns whose majority hyp speaker is right
  leaks      turns where half or more of the opening went to the previous speaker
  short      share of our utterances with two words or fewer — how choppy the
             transcript reads (Clova's own turns: 6–10%)

Variants (`--variants`):
  current    the shipped align: latest-start overlap rule + fragment absorption
  latest     latest-start overlap rule only (no fragment absorption) — a7646ea
  longest    the original overlap rule (longer diar segment wins), no fragment
             absorption — align before 2026-09-29
  exclusive  current align over pyannote's exclusive (non-overlapping) output
  no_arb     current align with neither embedding helper (arbiter, fragment resolver)

Caveat: Clova Note is itself ASR + diarization. Read the numbers as a comparison
between variants, not as absolute accuracy.

Usage:
    uv run python scripts/eval_speaker_attribution.py cache \
        --outdir /tmp/attr ~/Desktop/damwha_test/*.wav
    uv run --with edlib python scripts/eval_speaker_attribution.py score \
        --cache /tmp/attr --ref-dir ~/Desktop/damwha_test [--leaks]

The reference for `foo.wav` is `<ref-dir>/foo.txt`. Needs the models extra and
HF_TOKEN in worker/.env (pyannote is gated). NOT a CI test — run by hand.
"""

import argparse
import json
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

from damwha_worker.models.base import DiarSegment, SpeechSpan, Word

HEAD_CHARS = 12
DEFAULT_WHISPER = "large-v3-turbo"

# ---------------------------------------------------------------- cache


def _segments(annotation) -> list[DiarSegment]:
    segs = [
        DiarSegment(str(label), int(t.start * 1000), int(t.end * 1000))
        for t, _, label in annotation.itertracks(yield_label=True)
    ]
    segs.sort(key=lambda s: s.start_ms)
    return segs


def cmd_cache(args) -> int:
    import torch
    from pyannote.audio import Pipeline

    from damwha_worker.config import load_settings
    from damwha_worker.models.audio_io import load_mono_tensor
    from damwha_worker.models.ecapa_embed import EcapaEmbedder
    from damwha_worker.models.silero_vad import SileroVAD
    from damwha_worker.models.specs import DIARIZATION_MODEL, SPEAKER_EMBEDDING_MODEL
    from damwha_worker.models.whisper_mlx import MlxWhisper
    from damwha_worker.pipeline.ffmpeg import probe
    from damwha_worker.pipeline.stt_spans import prepare_stt_spans

    args.outdir.mkdir(parents=True, exist_ok=True)
    # 워커와 같은 입력 조건: 16 kHz mono wav를 기대한다(process_meeting은 normalize 후 처리).
    pipe = Pipeline.from_pretrained(DIARIZATION_MODEL, token=load_settings().hf_token)
    pipe = pipe.to(torch.device(args.device))
    embedder = EcapaEmbedder(SPEAKER_EMBEDDING_MODEL, "cpu")
    vad = SileroVAD()
    stt = MlxWhisper(args.whisper)
    for wav in args.wavs:
        out = args.outdir / f"{wav.stem}.{args.whisper}.json"
        if out.exists():
            print(f"skip {out}", flush=True)
            continue
        t0 = time.time()
        duration_ms = probe(str(wav)).duration_ms
        spans = vad.detect(str(wav))
        waveform, sr = load_mono_tensor(str(wav))
        diar = pipe({"waveform": waveform.unsqueeze(0), "sample_rate": sr})
        reg = _segments(diar.speaker_diarization)
        exc = _segments(diar.exclusive_speaker_diarization)
        words = stt.transcribe(str(wav), args.language, prepare_stt_spans(spans, duration_ms))
        data = {
            "wav": str(wav),
            "duration_ms": duration_ms,
            "vad": [asdict(s) for s in spans],
            "reg": [asdict(s) for s in reg],
            "reg_emb": embedder.embed(str(wav), reg),
            "exc": [asdict(s) for s in exc],
            "exc_emb": embedder.embed(str(wav), exc),
            "words": [asdict(w) for w in words],
        }
        out.write_text(json.dumps(data))
        print(
            f"{wav.stem}: segments={len(reg)}/{len(exc)} words={len(words)} "
            f"{time.time() - t0:.0f}s",
            flush=True,
        )
    return 0


# ---------------------------------------------------------------- reference

_TURN_HEAD = re.compile(r"^(참석자 \d+) (\d{1,2}(?::\d{2}){1,2})$")


def parse_clova(path: Path) -> list[tuple[str, int, str]]:
    """Clova Note txt export → [(speaker, start_ms, text)]. First 3 lines are a header."""
    turns: list[list] = []
    for line in path.read_text(encoding="utf-8-sig").splitlines()[3:]:
        line = line.strip()
        m = _TURN_HEAD.match(line)
        if m:
            sec = 0
            for part in m.group(2).split(":"):
                sec = sec * 60 + int(part)
            turns.append([m.group(1), sec * 1000, ""])
        elif turns and line:
            turns[-1][2] += " " + line
    return [tuple(t) for t in turns]


# ---------------------------------------------------------------- scoring

_KEEP = re.compile(r"[가-힣0-9a-zA-Z]")
_SYMBOLS: dict[str, str] = {}


def _chars(text: str) -> list[str]:
    return [c for c in text.lower() if _KEEP.match(c)]


def _symbol(token: str) -> str:
    if token not in _SYMBOLS:
        _SYMBOLS[token] = chr(0x100 + len(_SYMBOLS))
    return _SYMBOLS[token]


def _encode(chars: list[str]) -> tuple[str, list[int]]:
    """Hangul syllable → jamo symbols; returns the string and each symbol's char index."""
    out, owner = [], []
    for i, c in enumerate(chars):
        o = ord(c) - 0xAC00
        if 0 <= o <= 11171:
            syms = [_symbol(f"L{o // 588}"), _symbol(f"V{(o % 588) // 28}")]
            if o % 28:
                syms.append(_symbol(f"T{o % 28}"))
        else:
            syms = [_symbol(c)]
        out += syms
        owner += [i] * len(syms)
    return "".join(out), owner


def _matched_chars(hyp: list[str], ref: list[str]) -> dict[int, int]:
    """ref char index → hyp char index, for ref chars whose jamo all matched one hyp char."""
    import edlib

    hs, h_owner = _encode(hyp)
    rs, r_owner = _encode(ref)
    cigar = edlib.align(hs, rs, mode="NW", task="path")["cigar"]
    pairs: dict[int, set[int]] = defaultdict(set)
    hi = ri = 0
    for n, op in re.findall(r"(\d+)([=XID])", cigar):
        n = int(n)
        if op == "=":
            for k in range(n):
                pairs[r_owner[ri + k]].add(h_owner[hi + k])
        hi += n if op in "=XI" else 0
        ri += n if op in "=XD" else 0
    return {r: next(iter(h)) for r, h in pairs.items() if len(h) == 1}


def score(utterances: list[tuple[str, str]], ref_turns: list[tuple[str, int, str]]) -> dict:
    from scipy.optimize import linear_sum_assignment

    short = sum(1 for _, text in utterances if len(text.split()) <= 2)
    hyp_chars, hyp_spk = [], []
    for label, text in utterances:
        cs = _chars(text)
        hyp_chars += cs
        hyp_spk += [label] * len(cs)
    ref_chars, ref_spk, ref_turn = [], [], []
    for ti, (spk, _, text) in enumerate(ref_turns):
        cs = _chars(text)
        ref_chars += cs
        ref_spk += [spk] * len(cs)
        ref_turn += [ti] * len(cs)

    matched = _matched_chars(hyp_chars, ref_chars)
    hyp_labels, ref_labels = sorted(set(hyp_spk)), sorted(set(ref_spk))
    counts = [[0] * len(ref_labels) for _ in hyp_labels]
    for r, h in matched.items():
        counts[hyp_labels.index(hyp_spk[h])][ref_labels.index(ref_spk[r])] += 1
    rows, cols = linear_sum_assignment([[-c for c in row] for row in counts])
    mapping = {hyp_labels[r]: ref_labels[c] for r, c in zip(rows, cols, strict=True)}
    got = {r: mapping.get(hyp_spk[h]) for r, h in matched.items()}

    by_turn: dict[int, list[int]] = defaultdict(list)
    for r in sorted(got):
        by_turn[ref_turn[r]].append(r)
    head_n = head_prev = tail_n = tail_next = turn_ok = turn_n = 0
    leaks = []
    for ti, (spk, start_ms, text) in enumerate(ref_turns):
        rs = by_turn.get(ti, [])
        if rs:
            turn_n += 1
            turn_ok += Counter(got[r] for r in rs).most_common(1)[0][0] == spk
        if ti == 0 or ref_turns[ti - 1][0] == spk:
            continue
        prev = ref_turns[ti - 1][0]
        head = rs[:HEAD_CHARS]
        to_prev = sum(1 for r in head if got[r] == prev)
        head_n += len(head)
        head_prev += to_prev
        tail = by_turn.get(ti - 1, [])[-HEAD_CHARS:]
        tail_n += len(tail)
        tail_next += sum(1 for r in tail if got[r] == spk)
        if head and to_prev >= max(3, len(head) // 2):
            leaks.append((start_ms, prev, spk, text.strip()[:40]))
    return {
        "match": len(matched) / max(1, len(ref_chars)),
        "attr": sum(1 for r, s in got.items() if s == ref_spk[r]) / max(1, len(matched)),
        "head_prev": head_prev / max(1, head_n),
        "tail_next": tail_next / max(1, tail_n),
        "turn": turn_ok / max(1, turn_n),
        "hyp_speakers": len(hyp_labels),
        "ref_speakers": len(ref_labels),
        "utterances": len(utterances),
        "short": short / max(1, len(utterances)),
        "leaks": leaks,
    }


# ---------------------------------------------------------------- variants


def _load(path: Path) -> dict:
    d = json.loads(path.read_text())
    for key in ("reg", "exc"):
        d[key] = [DiarSegment(**s) for s in d[key]]
    d["vad"] = [SpeechSpan(**s) for s in d["vad"]]
    d["words"] = [Word(**w) for w in d["words"]]
    return d


def _longest_wins(word: Word, segments: list[DiarSegment]) -> DiarSegment:
    """The overlap rule align used until 2026-09-29, kept here as the comparison baseline."""
    mid = (word.start_ms + word.end_ms) // 2
    containing = [s for s in segments if s.start_ms <= mid < s.end_ms]
    if containing:
        return max(containing, key=lambda s: s.end_ms - s.start_ms)
    return min(segments, key=lambda s: min(abs(mid - s.start_ms), abs(mid - s.end_ms)))


def run_variant(name: str, d: dict, embedder) -> list[tuple[str, str]]:
    from damwha_worker.pipeline import align
    from damwha_worker.pipeline.cluster_merge import merge_clusters
    from damwha_worker.pipeline.speaker_arbiter import (
        make_embedding_arbiter,
        make_fragment_resolver,
    )

    key = "exc" if name == "exclusive" else "reg"
    segments, centroids = merge_clusters(d[key], d[f"{key}_emb"])
    arbiter = resolver = None
    if name != "no_arb":
        arbiter = make_embedding_arbiter(d["wav"], embedder, centroids)
    if name in ("current", "exclusive"):
        resolver = make_fragment_resolver(d["wav"], embedder, centroids)
    original = align._segment_for
    if name == "longest":
        align._segment_for = _longest_wins
    try:
        utts = align.build_utterances(
            d["words"],
            segments,
            failed_spans=d["vad"],
            arbitrate=arbiter,
            resolve_fragment=resolver,
        )
    finally:
        align._segment_for = original
    return [(u.diar_label, u.text) for u in utts if u.text]


VARIANTS = ("longest", "latest", "current", "exclusive", "no_arb")


def cmd_score(args) -> int:
    from damwha_worker.models.ecapa_embed import EcapaEmbedder
    from damwha_worker.models.specs import SPEAKER_EMBEDDING_MODEL

    variants = args.variants.split(",")
    unknown = set(variants) - set(VARIANTS)
    if unknown:
        print(f"unknown variants: {sorted(unknown)}; expected {VARIANTS}", file=sys.stderr)
        return 2
    embedder = EcapaEmbedder(SPEAKER_EMBEDDING_MODEL, "cpu")
    report: dict[str, dict[str, dict]] = defaultdict(dict)
    for path in sorted(args.cache.glob(f"*.{args.whisper}.json")):
        stem = path.name[: -len(f".{args.whisper}.json")]
        ref_path = args.ref_dir / f"{stem}.txt"
        if not ref_path.exists():
            print(f"no reference for {stem}, skipped", file=sys.stderr)
            continue
        ref, d = parse_clova(ref_path), _load(path)
        for v in variants:
            r = score(run_variant(v, d, embedder), ref)
            report[v][stem] = r
            print(
                f"{stem[:16]:<16} {v:<9} match {r['match']:.3f}  attr {r['attr']:.4f}  "
                f"head→prev {r['head_prev']:.4f}  tail→next {r['tail_next']:.4f}  "
                f"turn {r['turn']:.4f}  spk {r['hyp_speakers']}/{r['ref_speakers']}  "
                f"leaks {len(r['leaks'])}  utts {r['utterances']}  short {r['short']:.3f}",
                flush=True,
            )
            if args.leaks:
                for t, a, b, text in r["leaks"]:
                    print(f"    {t // 60000:02d}:{t // 1000 % 60:02d} {a}→{b}  {text}")
    print("\n=== mean over files ===")
    for v, files in report.items():
        rs = list(files.values())

        def mean(k, rs=rs):
            return sum(r[k] for r in rs) / len(rs)

        print(
            f"{v:<9} attr {mean('attr'):.4f}  head→prev {mean('head_prev'):.4f}  "
            f"tail→next {mean('tail_next'):.4f}  turn {mean('turn'):.4f}  "
            f"leaks {sum(len(r['leaks']) for r in rs)}  "
            f"utts {sum(r['utterances'] for r in rs)}  short {mean('short'):.3f}"
        )
    if args.json:
        args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cache", help="run the models once and store their outputs")
    c.add_argument("wavs", nargs="+", type=Path, help="16 kHz mono wav files")
    c.add_argument("--outdir", type=Path, required=True)
    c.add_argument("--whisper", default=DEFAULT_WHISPER)
    c.add_argument("--language", default="ko")
    c.add_argument("--device", default="mps", help="pyannote device (mps|cpu)")
    s = sub.add_parser("score", help="rebuild utterances per variant and score them")
    s.add_argument("--cache", type=Path, required=True)
    s.add_argument("--ref-dir", type=Path, required=True, help="dir with <wav stem>.txt")
    s.add_argument("--whisper", default=DEFAULT_WHISPER)
    s.add_argument("--variants", default="longest,latest,current")
    s.add_argument("--leaks", action="store_true", help="list every leaked turn")
    s.add_argument("--json", type=Path, help="also write the full report here")
    args = ap.parse_args()
    return cmd_cache(args) if args.cmd == "cache" else cmd_score(args)


if __name__ == "__main__":
    sys.exit(main())
