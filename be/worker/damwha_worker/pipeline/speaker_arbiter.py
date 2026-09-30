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

# 조각 판정에서 이보다 짧은 스팬은 이 길이까지 늘려 임베딩한다 — ECAPA는 100ms 미만을
# 거부하고, 수백 ms 미만은 화자 정보가 거의 없다.
FRAGMENT_MIN_EMBED_MS = 300

Arbitrate = Callable[[int, int, str, str], bool | None]
ResolveFragment = Callable[[int, int, str, list[str]], str | None]


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
    # 스팬 → 임베딩. align의 스무딩 루프는 변경마다 처음부터 다시 훑어 같은 run을
    # 거듭 묻는다 — 캐시 없이는 1회 처리에서 11,057번 임베딩했고 서로 다른 스팬은
    # 338개였다(43분 녹음, align 단계만 수 분). 판정은 라벨 쌍마다 다르므로 벡터를 캐시한다.
    cache: dict[tuple[int, int], list[float] | None] = {}

    def arbitrate(start_ms: int, end_ms: int, own_label: str, neighbor_label: str) -> bool | None:
        own_c = centroids.get(own_label)
        neighbor_c = centroids.get(neighbor_label)
        if own_c is None or neighbor_c is None:
            return None
        if (start_ms, end_ms) not in cache:
            segment = DiarSegment(own_label, start_ms, end_ms)
            cache[(start_ms, end_ms)] = embedder.embed(wav_path, [segment])[0]
        emb = cache[(start_ms, end_ms)]
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


def make_fragment_resolver(
    wav_path: str,
    embedder: Embedder,
    centroids: dict[str, list[float] | None],
    margin: float = MIN_MARGIN,
) -> ResolveFragment:
    """align의 조각 흡수가 "이 조각은 누구 것인가?"를 물을 때 답한다.

    반환: 자기 라벨(자기 목소리가 이웃 중 최선보다 margin 이상 가까움 — 유지), 이웃 중
    가장 가까운 라벨(흡수), None(임베딩 불가 — align이 시간상 가까운 이웃으로 폴백).
    centroid가 없는 라벨은 유사도 -1로 친다. 같은 스팬은 한 번만 임베딩한다.
    """
    cache: dict[tuple[int, int], dict[str, float] | None] = {}

    def resolve(start_ms: int, end_ms: int, own_label: str, candidates: list[str]) -> str | None:
        end_ms = max(end_ms, start_ms + FRAGMENT_MIN_EMBED_MS)
        if (start_ms, end_ms) not in cache:
            emb = embedder.embed(wav_path, [DiarSegment(own_label, start_ms, end_ms)])[0]
            cache[(start_ms, end_ms)] = (
                None
                if emb is None
                else {label: _cosine(emb, c) for label, c in centroids.items() if c is not None}
            )
        sims = cache[(start_ms, end_ms)]
        if sims is None:
            return None
        best = max(candidates, key=lambda label: sims.get(label, -1.0))
        if sims.get(own_label, -1.0) >= sims.get(best, -1.0) + margin:
            return own_label
        return best

    return resolve
