import math
from dataclasses import dataclass

from ..models.base import DiarSegment

# A speaker is a candidate for identification once its enrollment has settled:
# 'ready' (a human enrolled or confirmed it) or 'provisional' (the pipeline minted
# it from a previous meeting's cluster). Provisional used to be excluded, which
# made cross-meeting identity impossible on a fresh install — every install starts
# with zero 'ready' speakers, so the candidate set was always empty and the same
# person re-appeared as a new speaker in every meeting. 'pending'/'failed' stay out:
# their voiceprint is mid-flight or abandoned.
MATCHABLE_STATUSES = ("ready", "provisional")


@dataclass(frozen=True)
class ClusterMatch:
    """What identification concluded about one diarization cluster.

    Exactly one of the two ids is set, or neither. `speaker_id` means bound —
    persist attributes the cluster's utterances to it and mints nothing.
    `suggested_speaker_id` means the score landed in the too-close-to-call band:
    a fresh provisional speaker is still minted, but the candidate is recorded so
    the user can confirm the merge. `similarity` is set iff one of them is.
    """

    speaker_id: str | None = None
    suggested_speaker_id: str | None = None
    similarity: float | None = None


def _normalize(v: list[float]) -> list[float]:
    mag = math.sqrt(sum(x * x for x in v))
    if mag == 0:
        return v
    return [x / mag for x in v]


def centroids_by_label(
    segments: list[DiarSegment], embeddings: list[list[float] | None]
) -> dict[str, list[float] | None]:
    """Duration-weighted mean embedding per diarization label.

    Weighting by segment length rather than counting every segment equally: a
    half-second backchannel carries little speaker identity but plenty of the
    model's own bias direction, so a plain mean lets a handful of them pull short
    clusters toward every other cluster. Measured on mtg_1, weighting drops the
    worst different-speaker pair from .674 to .619 and the corpus mean-embedding
    norm from .723 to .691, with no cluster losing its centroid (a minimum-length
    filter reached the same separation but stranded 3 of 7 labels with none).

    None(너무 짧은 클립)은 평균에서 제외한다. 유효 임베딩이 하나도 없는
    라벨도 dict에 남긴다(값 None) — persist의 cluster 보존 경로가 라벨을 쓴다.
    """
    groups: dict[str, list[tuple[float, list[float]]]] = {}
    for seg, emb in zip(segments, embeddings, strict=True):
        groups.setdefault(seg.diar_label, [])
        if emb is not None:
            groups[seg.diar_label].append((float(seg.end_ms - seg.start_ms), emb))
    out: dict[str, list[float] | None] = {}
    for label, items in groups.items():
        if not items:
            out[label] = None
            continue
        total = sum(w for w, _ in items)
        if total <= 0:  # degenerate zero-length segments — fall back to a plain mean
            items = [(1.0, v) for _, v in items]
            total = float(len(items))
        dim = len(items[0][1])
        mean = [sum(w * v[i] for w, v in items) / total for i in range(dim)]
        out[label] = _normalize(mean)
    return out


def _vec(values: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in values) + "]"


def _nearest_voiceprint(conn, vector, model, dimension) -> tuple[str, float] | None:
    """matchable 화자의 성문 중 코사인 최근접 (speaker_id, similarity)."""
    row = conn.execute(
        """
        SELECT v.speaker_id, 1 - (v.embedding <=> %s::vector) AS similarity
        FROM voiceprint v
        JOIN speaker s ON s.id = v.speaker_id
        WHERE v.model = %s AND v.dimension = %s
          AND s.enrollment_status = ANY(%s)
        ORDER BY v.embedding <=> %s::vector ASC
        LIMIT 1
        """,
        (_vec(vector), model, dimension, list(MATCHABLE_STATUSES), _vec(vector)),
    ).fetchone()
    if row is None:
        return None
    return row["speaker_id"], float(row["similarity"])


def identify_embedding(conn, embedding, model, dimension, threshold) -> tuple[str, float] | None:
    """라이브 클립 하나의 임베딩을 결합한다. 최종 패스와 같은 후보 집합·같은 SQL이고,
    기준만 호출자가 정한다(라이브는 suggest_threshold — 설계 §2.8)."""
    hit = _nearest_voiceprint(conn, embedding, model, dimension)
    if hit is None or hit[1] < threshold:
        return None
    return hit


def identify_clusters(
    conn, centroids, model, dimension, threshold, suggest_threshold=None
) -> dict[str, ClusterMatch]:
    """Bind each cluster to a known speaker, suggest one, or leave it unknown.

    `threshold` binds; `suggest_threshold` (when the payload carries one — v1–v3
    do not) only records a candidate. Ordering by distance means the row we score
    is the nearest voiceprint, so a closer speaker always wins over a merely
    above-threshold one.
    """
    out: dict[str, ClusterMatch] = {}
    for label, centroid in centroids.items():
        if centroid is None:
            out[label] = ClusterMatch()  # 임베딩 불가 라벨 — DB 조회 없이 미식별
            continue
        hit = _nearest_voiceprint(conn, centroid, model, dimension)
        if hit is None:
            out[label] = ClusterMatch()
            continue
        speaker_id, sim = hit
        if sim >= threshold:
            out[label] = ClusterMatch(speaker_id=speaker_id, similarity=sim)
        elif suggest_threshold is not None and sim >= suggest_threshold:
            out[label] = ClusterMatch(suggested_speaker_id=speaker_id, similarity=sim)
        else:
            out[label] = ClusterMatch()
    return out
