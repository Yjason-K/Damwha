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
    assert out["S0"] is None


def test_identify_matches_ready_speaker_above_threshold(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    centroids = {"S0": [1.0] + [0.0] * 191}  # identical direction → similarity 1.0
    out = identify_clusters(
        conn, centroids, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.7
    )
    assert out["S0"] == sid


def test_identify_below_threshold_is_none(conn):
    sid = seed_speaker(conn, enrollment_status="ready")
    seed_voiceprint(conn, speaker_id=sid, embedding=[1.0] + [0.0] * 191)
    centroids = {"S0": [0.0, 1.0] + [0.0] * 190}  # orthogonal → similarity 0
    out = identify_clusters(
        conn, centroids, model="speechbrain/spkrec-ecapa-voxceleb", dimension=192, threshold=0.7
    )
    assert out["S0"] is None


def test_identify_ignores_non_ready_and_wrong_model(conn):
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
    assert out["S0"] is None


def test_identify_ignores_provisional_speaker(conn):
    prov = seed_speaker(conn, enrollment_status="provisional")
    seed_voiceprint(conn, speaker_id=prov, embedding=[1.0] + [0.0] * 191)
    out = identify_clusters(
        conn,
        {"S0": [1.0] + [0.0] * 191},
        model="speechbrain/spkrec-ecapa-voxceleb",
        dimension=192,
        threshold=0.5,
    )
    assert out["S0"] is None
