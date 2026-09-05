import pytest

from damwha_worker.models.base import DiarSegment
from damwha_worker.pipeline.identify import centroids_by_label, identify_clusters
from tests.conftest import seed_speaker, seed_voiceprint


def test_centroids_l2_normalized_mean():
    segs = [DiarSegment("S0", 0, 1), DiarSegment("S0", 1, 2), DiarSegment("S1", 2, 3)]
    embs = [[3.0, 0.0] + [0.0] * 190, [0.0, 4.0] + [0.0] * 190, [1.0, 0.0] + [0.0] * 190]
    c = centroids_by_label(segs, embs)
    assert set(c) == {"S0", "S1"}
    # S0 mean = (1.5, 2.0,...) → normalized magnitude 1
    import math

    assert abs(math.sqrt(sum(x * x for x in c["S0"])) - 1.0) < 1e-6


def test_centroids_weight_segments_by_duration():
    # A 9s segment and a 1s segment are not equal evidence. Weighting by duration
    # keeps sub-second crosstalk from dragging a centroid toward the corpus mean —
    # measured to drop the worst different-speaker pair in mtg_1 from .674 to .619.
    segs = [DiarSegment("S0", 0, 9000), DiarSegment("S0", 9000, 10000)]
    embs = [[1.0, 0.0] + [0.0] * 190, [0.0, 1.0] + [0.0] * 190]
    c = centroids_by_label(segs, embs)
    assert c["S0"][0] == pytest.approx(0.9939, abs=1e-3)  # 9:1, then normalized
    assert c["S0"][1] == pytest.approx(0.1104, abs=1e-3)


def test_centroids_equal_durations_match_plain_mean():
    segs = [DiarSegment("S0", 0, 1000), DiarSegment("S0", 1000, 2000)]
    embs = [[1.0, 0.0] + [0.0] * 190, [0.0, 1.0] + [0.0] * 190]
    c = centroids_by_label(segs, embs)
    assert c["S0"][0] == pytest.approx(0.7071, abs=1e-3)
    assert c["S0"][1] == pytest.approx(0.7071, abs=1e-3)


def test_centroids_zero_length_segment_does_not_divide_by_zero():
    segs = [DiarSegment("S0", 500, 500)]
    embs = [[1.0, 0.0] + [0.0] * 190]
    c = centroids_by_label(segs, embs)
    assert c["S0"] == [1.0, 0.0] + [0.0] * 190


def test_centroids_skip_none_embeddings():
    # None(너무 짧은 클립)은 평균을 희석하지 않는다
    segs = [DiarSegment("S0", 0, 1), DiarSegment("S0", 1, 2)]
    embs = [[1.0, 0.0] + [0.0] * 190, None]
    c = centroids_by_label(segs, embs)
    assert c["S0"] == [1.0, 0.0] + [0.0] * 190


def test_centroids_all_none_label_kept_with_none_centroid():
    # 전부 짧은 라벨도 dict에 남는다 (cluster row 보존 경로) — 값만 None
    segs = [DiarSegment("S0", 0, 1), DiarSegment("S1", 1, 2)]
    embs = [None, [1.0] + [0.0] * 191]
    c = centroids_by_label(segs, embs)
    assert set(c) == {"S0", "S1"}
    assert c["S0"] is None
    assert c["S1"] is not None


def test_identify_none_centroid_is_unidentified_without_db_query(conn):
    # threshold=0.0이면 어떤 voiceprint든 매칭되므로, None이 나오는 것 자체가
    # DB 조회를 타지 않았다는 증거다
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    out = identify_clusters(
        conn,
        {"S0": None},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.0,
    )
    assert out["S0"].speaker_id is None


def test_identify_matches_ready_speaker_above_threshold(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    centroids = {"S0": [1.0] + [0.0] * 191}  # identical direction → similarity 1.0
    out = identify_clusters(
        conn, centroids, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.7
    )
    assert out["S0"].speaker_id == sid


def test_identify_below_threshold_is_none(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    centroids = {"S0": [0.0, 1.0] + [0.0] * 190}  # orthogonal → similarity 0
    out = identify_clusters(
        conn, centroids, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.7
    )
    assert out["S0"].speaker_id is None


def test_identify_ignores_wrong_model(conn):
    pending = seed_speaker(conn, enrollment_status="pending")
    seed_voiceprint(conn, speaker_id=pending, embedding=[1.0] + [0.0] * 191)
    ready_other_model = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(
        conn, speaker_id=ready_other_model, embedding=[1.0] + [0.0] * 191, model="other-model"
    )
    out = identify_clusters(
        conn,
        {"S0": [1.0] + [0.0] * 191},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.5,
    )
    assert out["S0"].speaker_id is None


def test_identify_matches_provisional_speaker(conn):
    # Auto-created speakers are the ONLY speakers a fresh install has, so excluding
    # them made cross-meeting identification structurally impossible — the same
    # audio uploaded twice produced two disjoint speaker sets.
    prov = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=prov, embedding=[1.0] + [0.0] * 191)
    out = identify_clusters(
        conn,
        {"S0": [1.0] + [0.0] * 191},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.5,
    )
    assert out["S0"].speaker_id == prov


def test_identify_ignores_pending_and_failed_speakers(conn):
    # 'pending'/'failed' are enrollment jobs mid-flight or dead — their voiceprint
    # row may be absent or half-written. Only settled speakers are candidates.
    for status in ("pending", "failed"):
        sid = seed_speaker(conn, enrollment_status=status)
        seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    out = identify_clusters(
        conn,
        {"S0": [1.0] + [0.0] * 191},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.5,
    )
    assert out["S0"].speaker_id is None
    assert out["S0"].suggested_speaker_id is None


def test_identify_suggests_within_band_without_linking(conn):
    # The band between suggest_threshold and threshold is where the score is too
    # close to call: record the candidate for the user, but do not bind it.
    sid = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0, 0.0] + [0.0] * 190)
    # cos(45°) ≈ 0.707 — inside [0.60, 0.80)
    centroid = [1.0, 1.0] + [0.0] * 190
    out = identify_clusters(
        conn,
        {"S0": centroid},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.8,
        suggest_threshold=0.6,
    )
    assert out["S0"].speaker_id is None
    assert out["S0"].suggested_speaker_id == sid
    assert out["S0"].similarity == pytest.approx(0.7071, abs=1e-3)


def test_identify_below_suggest_band_reports_nothing(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0, 0.0] + [0.0] * 190)
    out = identify_clusters(
        conn,
        {"S0": [0.0, 1.0] + [0.0] * 190},  # orthogonal → 0.0
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.8,
        suggest_threshold=0.6,
    )
    assert out["S0"].speaker_id is None
    assert out["S0"].suggested_speaker_id is None
    assert out["S0"].similarity is None


def test_identify_without_suggest_threshold_never_suggests(conn):
    # v1–v3 payloads carry no suggest_threshold; they must behave exactly as before.
    sid = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0, 0.0] + [0.0] * 190)
    out = identify_clusters(
        conn,
        {"S0": [1.0, 1.0] + [0.0] * 190},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.8,
    )
    assert out["S0"].speaker_id is None
    assert out["S0"].suggested_speaker_id is None


def test_identify_picks_best_candidate_not_merely_one_above_threshold(conn):
    near = seed_speaker(conn, enrollment_status="ready", name="near")
    seed_voiceprint(conn, speaker_id=near, embedding=[1.0, 0.05] + [0.0] * 190)
    far = seed_speaker(conn, enrollment_status="provisional", name="far")
    seed_voiceprint(conn, speaker_id=far, embedding=[1.0, 0.6] + [0.0] * 190)
    out = identify_clusters(
        conn,
        {"S0": [1.0, 0.0] + [0.0] * 190},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.7,
    )
    assert out["S0"].speaker_id == near


def test_identify_embedding_binds_at_threshold_and_returns_similarity(conn):
    from damwha_worker.pipeline.identify import identify_embedding

    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    hit = identify_embedding(
        conn, [1.0] + [0.0] * 191, "speechbrain/spkrec-ecapa-voxceleb", 192, 0.6
    )
    assert hit is not None
    assert hit[0] == sid and hit[1] == pytest.approx(1.0, abs=1e-6)


def test_identify_embedding_returns_none_below_threshold_or_without_candidates(conn):
    from damwha_worker.pipeline.identify import identify_embedding

    assert identify_embedding(conn, [1.0] + [0.0] * 191, "m", 192, 0.6) is None
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    far = [0.0, 1.0] + [0.0] * 190  # cosine 0
    assert identify_embedding(conn, far, "speechbrain/spkrec-ecapa-voxceleb", 192, 0.6) is None
    # 모델이 다르면 후보가 아니다
    assert identify_embedding(conn, [1.0] + [0.0] * 191, "other-model", 192, 0.6) is None
