import math

from damwha_worker.models.base import DiarSegment
from damwha_worker.pipeline.cluster_merge import merge_clusters


def _unit(x, y):
    m = math.sqrt(x * x + y * y)
    return [x / m, y / m]


def test_near_duplicate_clusters_merge_into_larger_label():
    # S0 (10s) and S1 (3s) are the same voice (cos≈0.99); S2 is a different voice.
    segments = [
        DiarSegment("S0", 0, 10000),
        DiarSegment("S1", 10000, 13000),
        DiarSegment("S2", 13000, 20000),
    ]
    embeddings = [_unit(1.0, 0.0), _unit(1.0, 0.1), _unit(0.0, 1.0)]
    merged_segments, merged_centroids = merge_clusters(
        segments, embeddings, cos_threshold=0.85, min_speech_ms=0
    )
    assert [s.diar_label for s in merged_segments] == ["S0", "S0", "S2"]
    assert set(merged_centroids) == {"S0", "S2"}


def test_clusters_below_threshold_stay_separate():
    segments = [DiarSegment("S0", 0, 5000), DiarSegment("S1", 5000, 10000)]
    embeddings = [_unit(1.0, 0.0), _unit(1.0, 1.0)]  # cos≈0.71
    merged_segments, _ = merge_clusters(segments, embeddings, cos_threshold=0.85, min_speech_ms=0)
    assert [s.diar_label for s in merged_segments] == ["S0", "S1"]


def test_tiny_cluster_absorbed_into_nearest_below_main_threshold():
    # S1 spoke 2s total — below min_speech_ms — so it folds into its nearest cluster (S0)
    segments = [
        DiarSegment("S0", 0, 8000),
        DiarSegment("S1", 8000, 10000),
        DiarSegment("S2", 10000, 18000),
    ]
    embeddings = [_unit(1.0, 0.0), _unit(1.0, 1.0), _unit(0.0, 1.0)]
    merged_segments, _ = merge_clusters(
        segments, embeddings, cos_threshold=0.99, min_speech_ms=5000
    )
    assert [s.diar_label for s in merged_segments] == ["S0", "S0", "S2"]


def test_tiny_cluster_with_no_plausible_neighbor_is_kept():
    # 2s cluster but orthogonal to everyone (cos 0) — a brief real participant, not noise
    segments = [DiarSegment("S0", 0, 8000), DiarSegment("S1", 8000, 10000)]
    embeddings = [_unit(1.0, 0.0), _unit(0.0, 1.0)]
    merged_segments, _ = merge_clusters(
        segments, embeddings, cos_threshold=0.85, min_speech_ms=5000, tiny_cos_floor=0.5
    )
    assert [s.diar_label for s in merged_segments] == ["S0", "S1"]


def test_tiny_cluster_without_embedding_is_left_alone():
    segments = [DiarSegment("S0", 0, 8000), DiarSegment("S1", 8000, 8050)]
    embeddings = [_unit(1.0, 0.0), None]
    merged_segments, centroids = merge_clusters(
        segments, embeddings, cos_threshold=0.85, min_speech_ms=5000
    )
    assert [s.diar_label for s in merged_segments] == ["S0", "S1"]
    assert centroids["S1"] is None


def test_merge_is_transitive_and_centroid_recomputed():
    # S1 close to S0, S2 close to S1 but not to S0 — greedy pairwise merge chains them.
    segments = [
        DiarSegment("S0", 0, 5000),
        DiarSegment("S1", 5000, 10000),
        DiarSegment("S2", 10000, 15000),
    ]
    embeddings = [_unit(1.0, 0.0), _unit(1.0, 0.3), _unit(1.0, 0.6)]
    merged_segments, centroids = merge_clusters(
        segments, embeddings, cos_threshold=0.9, min_speech_ms=0
    )
    # S1+S2 (10s) merge first and outlive S0 (5s); the recomputed centroid then pulls S0 in.
    assert {s.diar_label for s in merged_segments} == {"S1"}
    assert set(centroids) == {"S1"}
    assert abs(math.hypot(*centroids["S1"]) - 1.0) < 1e-6


def test_returns_input_unchanged_when_single_cluster():
    segments = [DiarSegment("S0", 0, 1000)]
    merged_segments, centroids = merge_clusters(segments, [_unit(1.0, 0.0)])
    assert merged_segments == segments and set(centroids) == {"S0"}
