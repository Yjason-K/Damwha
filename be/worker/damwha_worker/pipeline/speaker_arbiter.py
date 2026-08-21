"""임베딩 기반 화자 재귀속 판정자.

align의 백채널 스무딩이 "이 word run을 주변 화자에게 흡수할까?"를 물을 때,
run 구간의 오디오를 ECAPA로 임베딩해 자기 화자/이웃 화자 centroid와의
cosine 유사도로 답한다. 시간 휴리스틱(겹침+길이)만으로는 "탈취된 본문"과
"진짜 끼어든 짧은 발언"을 구분할 수 없어서 도입됐다.

반환 계약: True = 흡수, False = 보존, None = 판정 불가(임베딩 불가·centroid
없음·유사도 차이가 margin 미만) — None이면 align이 기존 휴리스틱으로 폴백한다.
"""

import math
from collections.abc import Callable

from ..models.base import DiarSegment, Embedder

# 이웃/자기 유사도 차이가 이보다 작으면 판정 유보. 겹침 구간은 두 목소리가
# 섞여 차이가 작게 나오므로, 애매하면 보수적 휴리스틱에 맡긴다.
MIN_MARGIN = 0.05

Arbitrate = Callable[[int, int, str, str], bool | None]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    mag = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    if mag == 0:
        return 0.0
    return dot / mag


def make_embedding_arbiter(
    wav_path: str,
    embedder: Embedder,
    centroids: dict[str, list[float] | None],
    margin: float = MIN_MARGIN,
) -> Arbitrate:
    def arbitrate(start_ms: int, end_ms: int, own_label: str, neighbor_label: str) -> bool | None:
        own_c = centroids.get(own_label)
        neighbor_c = centroids.get(neighbor_label)
        if own_c is None or neighbor_c is None:
            return None
        emb = embedder.embed(wav_path, [DiarSegment(own_label, start_ms, end_ms)])[0]
        if emb is None:
            return None
        own_sim = _cosine(emb, own_c)
        neighbor_sim = _cosine(emb, neighbor_c)
        if neighbor_sim >= own_sim + margin:
            return True
        if own_sim >= neighbor_sim + margin:
            return False
        return None

    return arbitrate
