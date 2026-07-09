import math

from ..models.base import DiarSegment


def _normalize(v: list[float]) -> list[float]:
    mag = math.sqrt(sum(x * x for x in v))
    if mag == 0:
        return v
    return [x / mag for x in v]


def centroids_by_label(
    segments: list[DiarSegment], embeddings: list[list[float] | None]
) -> dict[str, list[float] | None]:
    # None(너무 짧은 클립)은 평균에서 제외한다. 유효 임베딩이 하나도 없는
    # 라벨도 dict에 남긴다(값 None) — persist의 cluster 보존 경로가 라벨을 쓴다.
    groups: dict[str, list[list[float]]] = {}
    for seg, emb in zip(segments, embeddings, strict=True):
        groups.setdefault(seg.diar_label, [])
        if emb is not None:
            groups[seg.diar_label].append(emb)
    out: dict[str, list[float] | None] = {}
    for label, vecs in groups.items():
        if not vecs:
            out[label] = None
            continue
        dim = len(vecs[0])
        mean = [sum(v[i] for v in vecs) / len(vecs) for i in range(dim)]
        out[label] = _normalize(mean)
    return out


def _vec(values: list[float]) -> str:
    return "[" + ",".join(repr(float(x)) for x in values) + "]"


def identify_clusters(conn, centroids, model, dimension, threshold) -> dict[str, str | None]:
    out: dict[str, str | None] = {}
    for label, centroid in centroids.items():
        if centroid is None:
            out[label] = None  # 임베딩 불가 라벨 — DB 조회 없이 미식별
            continue
        row = conn.execute(
            """
            SELECT v.speaker_id, 1 - (v.embedding <=> %s::vector) AS similarity
            FROM voiceprint v
            JOIN speaker s ON s.id = v.speaker_id
            WHERE v.model = %s AND v.dimension = %s AND s.enrollment_status = 'ready'
            ORDER BY v.embedding <=> %s::vector ASC
            LIMIT 1
            """,
            (_vec(centroid), model, dimension, _vec(centroid)),
        ).fetchone()
        out[label] = row["speaker_id"] if row and row["similarity"] >= threshold else None
    return out
