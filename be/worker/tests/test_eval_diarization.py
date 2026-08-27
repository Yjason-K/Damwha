import io

from damwha_worker.evaluation.diarization import (
    parse_rttm,
    score,
    segments_to_annotation,
)
from damwha_worker.models.base import DiarSegment


def test_parse_rttm_yields_segments_in_ms():
    rttm = io.StringIO(
        "SPEAKER mtg_1 1 0.50 2.00 <NA> <NA> alice <NA> <NA>\n"
        "SPEAKER mtg_1 1 2.50 1.00 <NA> <NA> bob <NA> <NA>\n"
    )
    segs = parse_rttm(rttm)
    assert segs == [DiarSegment("alice", 500, 2500), DiarSegment("bob", 2500, 3500)]


def test_perfect_hypothesis_scores_zero_der():
    ref = segments_to_annotation([DiarSegment("a", 0, 5000), DiarSegment("b", 5000, 10000)])
    hyp = segments_to_annotation([DiarSegment("S0", 0, 5000), DiarSegment("S1", 5000, 10000)])
    r = score(ref, hyp, collar_ms=0)
    assert r["der"] == 0.0
    assert r["ref_speakers"] == 2 and r["hyp_speakers"] == 2
    assert r["purity"] == 1.0 and r["coverage"] == 1.0


def test_over_segmentation_lowers_coverage_not_purity():
    # one real speaker split into two hypothesis labels
    ref = segments_to_annotation([DiarSegment("a", 0, 10000)])
    hyp = segments_to_annotation([DiarSegment("S0", 0, 5000), DiarSegment("S1", 5000, 10000)])
    r = score(ref, hyp, collar_ms=0)
    assert r["purity"] == 1.0
    assert r["coverage"] == 0.5
    assert r["hyp_speakers"] > r["ref_speakers"]


def test_under_segmentation_lowers_purity_not_coverage():
    # two real speakers collapsed into one hypothesis label
    ref = segments_to_annotation([DiarSegment("a", 0, 5000), DiarSegment("b", 5000, 10000)])
    hyp = segments_to_annotation([DiarSegment("S0", 0, 10000)])
    r = score(ref, hyp, collar_ms=0)
    assert r["coverage"] == 1.0
    assert r["purity"] == 0.5
    assert r["confusion_s"] == 5.0
