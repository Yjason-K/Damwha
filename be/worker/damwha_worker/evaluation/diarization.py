"""Diarization scoring helpers — DER plus the two numbers that separate
over- from under-segmentation.

  purity   how single-speaker each hypothesis cluster is. Low purity = two real
           people collapsed into one label (under-segmentation).
  coverage how much of each real speaker lands in one hypothesis cluster. Low
           coverage = one person spread across several labels (over-segmentation).

DER alone cannot tell the two apart; both show up as "confusion".
Everything here is pure (no DB, no audio) so it stays testable without models —
`scripts/eval_diarization.py` is the CLI that feeds it.
"""

from typing import TextIO

from pyannote.core import Annotation, Segment

from ..models.base import DiarSegment


def parse_rttm(fp: TextIO) -> list[DiarSegment]:
    """RTTM (NIST) → DiarSegment list. Only SPEAKER lines; start/dur are seconds."""
    out: list[DiarSegment] = []
    for line in fp:
        parts = line.split()
        if not parts or parts[0] != "SPEAKER":
            continue
        start_s, dur_s, label = float(parts[3]), float(parts[4]), parts[7]
        start_ms = round(start_s * 1000)
        out.append(DiarSegment(label, start_ms, start_ms + round(dur_s * 1000)))
    out.sort(key=lambda s: s.start_ms)
    return out


def segments_to_annotation(segments: list[DiarSegment], uri: str = "eval") -> Annotation:
    ann = Annotation(uri=uri)
    for s in segments:
        ann[Segment(s.start_ms / 1000, s.end_ms / 1000)] = s.diar_label
    return ann


def score(ref: Annotation, hyp: Annotation, collar_ms: int = 250) -> dict[str, float | int]:
    """DER breakdown + purity/coverage + speaker counts. Times in seconds."""
    from pyannote.metrics.diarization import (
        DiarizationCoverage,
        DiarizationErrorRate,
        DiarizationPurity,
    )

    collar = collar_ms / 1000
    der = DiarizationErrorRate(collar=collar)
    detail = der(ref, hyp, detailed=True)
    total = detail["total"] or 1.0
    return {
        "der": round(detail["diarization error rate"], 4),
        "confusion_s": round(detail["confusion"], 2),
        "missed_s": round(detail["missed detection"], 2),
        "false_alarm_s": round(detail["false alarm"], 2),
        "confusion_rate": round(detail["confusion"] / total, 4),
        "purity": round(DiarizationPurity(collar=collar)(ref, hyp), 4),
        "coverage": round(DiarizationCoverage(collar=collar)(ref, hyp), 4),
        "ref_speakers": len(ref.labels()),
        "hyp_speakers": len(hyp.labels()),
        "ref_speech_s": round(total, 2),
    }
