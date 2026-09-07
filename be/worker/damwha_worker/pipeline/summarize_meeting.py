import threading

from .. import db
from ..contracts import SummarizeMeetingPayload
from ..errors import LLM_INVALID_RESPONSE, ErrorKind, WorkerError
from .stage import enter_stage
from .timing import timed_stage


def _resolve_segments(segments, rows) -> list[dict]:
    """LLM이 지목한 경계 utterance를 DB 행에 맞춰 **바로잡고** 시간을 채운다.

    LLM은 id만 신뢰 대상이다 — start_ms/end_ms는 여기서 DB 값으로 파생시켜
    모델이 타임스탬프를 지어내는 실패 모드를 원천 차단한다.

    경계가 어긋나면 한때 PERMANENT로 거절했다. mtg_16이 그 판단을 뒤집었다:
    발화 4개짜리 회의(그중 하나가 녹음의 72%)에서 모델은 마지막 발화를 앞 구간의
    끝이자 다음 구간의 시작으로 다시 썼고, 네 번 재시도해서 네 번 다 같은 자리에서
    죽었다. 모델은 줄 수가 아니라 내용으로 나누므로 발화가 몇 개 없으면 이 어긋남은
    구조적이다 — 재시도가 넘어갈 성질이 아니다. 경계 정리 하나 때문에 주제·제목·불릿을
    통째로 잃는 대신 여기서 정규화한다: 뒤집힌 경계는 되돌리고, 순서는 정렬하고,
    겹친 구간은 밀거나(부분) 앞 구간에 합친다(포함). 없던 내용을 만들지는 않는다 —
    불릿은 한 줄도 버리지 않고, 시간은 여전히 DB 행에서만 온다.
    """
    order = {row["id"]: index for index, row in enumerate(rows)}
    by_id = {row["id"]: row for row in rows}
    spans: list[tuple[int, int, object]] = []
    for segment in segments:
        start = by_id.get(segment.start_utterance_id)
        end = by_id.get(segment.end_utterance_id)
        if start is None or end is None:
            # 이건 정규화 대상이 아니다 — 이 회의에 없는 발화를 인용했다는 뜻이고,
            # 클라이언트가 인덱스를 id로 옮기는 이상 나올 수 없는 계약 위반이다.
            raise WorkerError(
                LLM_INVALID_RESPONSE,
                f"segment cites an utterance outside the meeting: "
                f"{segment.start_utterance_id}..{segment.end_utterance_id}",
                ErrorKind.PERMANENT,
            )
        first, last = order[start["id"]], order[end["id"]]
        if first > last:  # 시작과 끝을 바꿔 적었다
            first, last = last, first
        spans.append((first, last, segment))
    # 나열 순서가 틀린 것과 구간이 겹치는 것은 다른 문제다. 정렬로 앞의 것을 먼저
    # 걷어내야 남은 겹침만 다루게 된다.
    spans.sort(key=lambda span: (span[0], span[1]))

    resolved: list[dict] = []
    previous_end = -1
    for first, last, segment in spans:
        if last <= previous_end:
            # 앞 구간에 완전히 들어간다. 그 발화 안을 더 쪼갤 방법이 없으므로 새
            # 구간을 만들지 않고, 잃으면 안 되는 불릿만 앞 구간에 합친다.
            if resolved:
                resolved[-1]["bullets"].extend(segment.bullets)
            continue
        if first <= previous_end:
            first = previous_end + 1  # 겹친 만큼 시작을 민다
        previous_end = last
        start, end = rows[first], rows[last]
        resolved.append(
            {
                "start_utterance_id": start["id"],
                "end_utterance_id": end["id"],
                "start_ms": start["start_ms"],
                "end_ms": end["end_ms"],
                "title": segment.title,
                "bullets": list(segment.bullets),
            }
        )
    return resolved


def run_summarize_meeting(
    conn,
    job: dict,
    payload: SummarizeMeetingPayload,
    client,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
) -> str:
    outcome = db.mark_summary_running(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
    )
    if outcome != "running":
        return outcome
    enter_stage(conn, job["id"], worker_id, "summarize_meeting", 30, shutdown_event)
    rows = conn.execute(
        """SELECT u.id, u.speaker_id, s.name AS speaker_name, u.text, u.start_ms, u.end_ms
           FROM utterance u
           LEFT JOIN speaker s ON s.id = u.speaker_id
           WHERE u.meeting_id=%s AND u.processing_version=%s
             AND u.status='ok' AND u.text IS NOT NULL
           ORDER BY u.order_index, u.id""",
        (payload.meeting_id, payload.processing_version),
    ).fetchall()
    # LLM 호출은 긴 회의에서 수 분 — timed_stage가 진행 중 tick과 완료 시간을 남긴다
    with timed_stage("summarize_meeting", f"job={job['id']} meeting={payload.meeting_id}") as t:
        row_dicts = [dict(row) for row in rows]
        response = client.summarize(model=payload.model, utterances=row_dicts)
        segments = _resolve_segments(response.segments, row_dicts)
        t["detail"] = f"utterances={len(rows)} segments={len(segments)}"
    enter_stage(conn, job["id"], worker_id, "persist_summary", 80, shutdown_event)
    return db.persist_summary(
        conn,
        job_id=job["id"],
        worker_id=worker_id,
        meeting_id=payload.meeting_id,
        processing_version=payload.processing_version,
        topics=list(response.topics),
        segments=segments,
    )
