"""회의 내 클러스터 병합 — diarization 과분할 보정.

pyannote가 같은 사람을 여러 라벨로 쪼개는 일이 흔하다 (실측: 41분 회의에서
12 클러스터, 그중 한 쌍의 centroid cosine이 0.92). identify는 DB voiceprint와만
대조하고 클러스터끼리는 비교하지 않으므로, embed 직후·identify 직전에 여기서
두 가지를 접는다:

1. centroid cosine이 `cos_threshold` 이상인 쌍 — 가장 가까운 쌍부터 greedy 병합.
   병합 후 centroid를 다시 계산하므로 연쇄 병합이 가능하다.
2. 총 발화가 `min_speech_ms` 미만인 클러스터 — 노이즈 세그먼트가 발급한 유령
   화자. 최근접 클러스터와의 cosine이 `tiny_cos_floor` 이상이면 흡수한다. 바닥을
   두는 이유: 한마디만 한 진짜 참석자를 남에게 붙이면 안 된다.

임베딩이 없는(centroid None) 라벨은 손대지 않는다 — persist가 그 라벨을 centroid
없이 보존하는 경로가 따로 있다. 생존 라벨은 발화 시간이 더 긴 쪽.
"""

import math

from ..models.base import DiarSegment
from .identify import centroids_by_label

# 같은 회의 안에서는 채널·환경이 같아 raw cosine이 회의 간보다 높게 나온다.
# IDENTIFY_THRESHOLD(0.7~0.8)보다 보수적으로 잡는다.
DEFAULT_COS_THRESHOLD = 0.85
# 이 미만으로 말한 클러스터는 화자 identity를 실을 수 없다 — 흡수 후보.
DEFAULT_MIN_SPEECH_MS = 5000
# 흡수 후보라도 최근접과 이보다 멀면 남긴다 (짧게 말한 실제 참석자 보호).
DEFAULT_TINY_COS_FLOOR = 0.5


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    mag = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / mag if mag else 0.0


def _speech_ms(segments: list[DiarSegment]) -> dict[str, int]:
    out: dict[str, int] = {}
    for s in segments:
        out[s.diar_label] = out.get(s.diar_label, 0) + (s.end_ms - s.start_ms)
    return out


def _relabel(segments: list[DiarSegment], src: str, dst: str) -> list[DiarSegment]:
    return [DiarSegment(dst, s.start_ms, s.end_ms) if s.diar_label == src else s for s in segments]


def merge_clusters(
    segments: list[DiarSegment],
    embeddings: list[list[float] | None],
    cos_threshold: float = DEFAULT_COS_THRESHOLD,
    min_speech_ms: int = DEFAULT_MIN_SPEECH_MS,
    tiny_cos_floor: float = DEFAULT_TINY_COS_FLOOR,
) -> tuple[list[DiarSegment], dict[str, list[float] | None]]:
    """(재라벨된 segments, 라벨별 centroid). segments와 embeddings는 index로 짝."""
    segments = list(segments)
    centroids = centroids_by_label(segments, embeddings)

    def survivor(a: str, b: str) -> tuple[str, str]:
        ms = _speech_ms(segments)
        return (a, b) if ms.get(a, 0) >= ms.get(b, 0) else (b, a)

    # 1) 유사도 병합 — 매 회 가장 가까운 쌍 하나만 접고 centroid 재계산
    while True:
        labels = [k for k, v in centroids.items() if v is not None]
        best: tuple[float, str, str] | None = None
        for i, a in enumerate(labels):
            for b in labels[i + 1 :]:
                cos = _cosine(centroids[a], centroids[b])
                if cos >= cos_threshold and (best is None or cos > best[0]):
                    best = (cos, a, b)
        if best is None:
            break
        keep, drop = survivor(best[1], best[2])
        segments = _relabel(segments, drop, keep)
        centroids = centroids_by_label(segments, embeddings)

    # 2) 유령 클러스터 흡수 — 발화가 너무 짧은 라벨은 최근접 라벨로
    kept: set[str] = set()  # 바닥 미달로 남기기로 한 라벨 — 재검토 안 함
    while True:
        ms = _speech_ms(segments)
        labels = [k for k, v in centroids.items() if v is not None]
        tiny = [k for k in labels if ms.get(k, 0) < min_speech_ms and k not in kept]
        if not tiny or len(labels) < 2:
            break
        src = min(tiny, key=lambda k: ms.get(k, 0))
        dst = max(
            (k for k in labels if k != src), key=lambda k: _cosine(centroids[src], centroids[k])
        )
        if _cosine(centroids[src], centroids[dst]) < tiny_cos_floor:
            kept.add(src)
            continue
        segments = _relabel(segments, src, dst)
        centroids = centroids_by_label(segments, embeddings)

    return segments, centroids
