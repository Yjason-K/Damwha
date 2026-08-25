"""Diarization quality eval: DER plus purity/coverage against a hand-labelled RTTM.

`eval_speaker_id.py` scores *cross-meeting* identity and `eval_stt.py` scores
text; neither says whether pyannote split one person into several labels
(over-segmentation) or folded two people into one (under-segmentation). This
does, per meeting, against a reference you label by listening:

  der            standard NIST DER with a 250 ms collar (missed + false alarm
                 + confusion, over reference speech)
  purity         1.0 = every hypothesis cluster is one real person. Drops when
                 people are MERGED (under-segmentation).
  coverage       1.0 = every real person sits in one hypothesis cluster. Drops
                 when a person is SPLIT (over-segmentation).
  ref/hyp spk    speaker counts on each side — the quickest sanity check.

Hypothesis source (pick one):

  --meeting <id>     the meeting's current utterance rows from the live DB
                     (what the user actually sees — diarization + cluster merge
                     + align, end to end). Read-only.
  --hyp <file.rttm>  any RTTM, e.g. dumped from a raw pyannote run, to score the
                     model alone without the pipeline's post-processing.

Reference: `--ref <file.rttm>` — one SPEAKER line per turn, times in seconds:

  SPEAKER mtg_10 1 12.40 3.15 <NA> <NA> minsu <NA> <NA>

Label a 20–30 min window rather than a whole meeting and pass `--from/--to`
(seconds) so only that window is scored; anything outside is ignored on both
sides. Audacity label tracks export to a two-column TSV that converts to RTTM
in a few lines — see SMOKE.md.

Usage:
    uv run python scripts/eval_diarization.py --ref refs/mtg_10.rttm --meeting mtg_10
    uv run python scripts/eval_diarization.py --ref refs/mtg_10.rttm --hyp raw.rttm \
        --from 600 --to 2400
"""

import argparse
import json
import os
import sys
from pathlib import Path

from pyannote.core import Segment, Timeline

from damwha_worker.evaluation.diarization import parse_rttm, score, segments_to_annotation
from damwha_worker.models.base import DiarSegment


def load_meeting_segments(database_url: str, meeting_id: str) -> list[DiarSegment]:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        rows = conn.execute(
            """
            SELECT u.diar_label, u.start_ms, u.end_ms
            FROM utterance u JOIN meeting m ON m.id = u.meeting_id
            WHERE u.meeting_id = %s AND u.processing_version = m.processing_version
              AND u.status = 'ok'
            ORDER BY u.start_ms
            """,
            (meeting_id,),
        ).fetchall()
    return [DiarSegment(r["diar_label"], r["start_ms"], r["end_ms"]) for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--ref", type=Path, required=True, help="reference RTTM")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--meeting", help="score this meeting's live utterance rows")
    src.add_argument("--hyp", type=Path, help="score this hypothesis RTTM")
    ap.add_argument(
        "--database-url", default=os.environ.get("DATABASE_URL"), help="defaults to $DATABASE_URL"
    )
    ap.add_argument("--from", dest="from_s", type=float, help="score window start (s)")
    ap.add_argument("--to", dest="to_s", type=float, help="score window end (s)")
    ap.add_argument("--collar-ms", type=int, default=250)
    ap.add_argument("--json", type=Path, help="also write the report here")
    args = ap.parse_args()

    with args.ref.open() as fp:
        ref_segments = parse_rttm(fp)
    if args.hyp:
        with args.hyp.open() as fp:
            hyp_segments = parse_rttm(fp)
        hyp_name = str(args.hyp)
    else:
        if not args.database_url:
            print("DATABASE_URL not set (env or --database-url)", file=sys.stderr)
            return 2
        hyp_segments = load_meeting_segments(args.database_url, args.meeting)
        hyp_name = f"db:{args.meeting}"

    ref = segments_to_annotation(ref_segments)
    hyp = segments_to_annotation(hyp_segments)
    if args.from_s is not None or args.to_s is not None:
        end = args.to_s if args.to_s is not None else max(ref.get_timeline().extent().end, 0)
        window = Timeline([Segment(args.from_s or 0.0, end)])
        ref, hyp = ref.crop(window), hyp.crop(window)

    r = score(ref, hyp, collar_ms=args.collar_ms)
    r["ref"], r["hyp"] = str(args.ref), hyp_name
    print(f"ref={r['ref']}  hyp={r['hyp']}  speech={r['ref_speech_s']}s")
    print(
        f"  DER {r['der']:.3f}   confusion {r['confusion_rate']:.3f}"
        f"   missed {r['missed_s']}s   false-alarm {r['false_alarm_s']}s"
    )
    print(
        f"  purity {r['purity']:.3f} (↓ = merged people)   "
        f"coverage {r['coverage']:.3f} (↓ = split people)"
    )
    print(f"  speakers ref={r['ref_speakers']} hyp={r['hyp_speakers']}")
    if args.json:
        args.json.write_text(json.dumps(r, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
