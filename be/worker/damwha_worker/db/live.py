"""라이브 세션 — 입력 경계 조회, 미리보기 utterance, 봉인 후 마무리.

`committed_bytes`/`sealed_bytes`를 읽고 쓰는 유일한 파이썬 쪽 자리다. 파일 길이는
어떤 경로에서도 권위가 아니다.
"""

from dataclasses import dataclass

from psycopg.types.json import Jsonb

from .core import _Abort


def fail_live_preview(conn, job_id: str, worker_id: str, error: dict) -> bool:
    """미리보기 job만 닫는다. 회의도, 확정·봉인 경계도 건드리지 않는다 (설계 §4.1·§4.2).

    fail_process_meeting과 나란히 두었지만 하는 일이 정반대다. 저쪽은 "이 회의의 처리가
    실패했다"를 회의에 전파하고, 이쪽은 전파하지 **않는다** — 브라우저 캡처로 옮긴 뒤로
    오디오는 API가 쓰고 워커는 그 파일을 따라 읽을 뿐이라, 워커의 OOM·SIGTERM·클립 연속
    실패가 진행 중인 녹음을 끝낼 권한이 없다. 회의는 recording에 남아 append를 계속 받고,
    마무리는 봉인 뒤 API(stop 또는 orphan 스위퍼)가 한다.

    소유권 가드가 0행을 내는 경우는 둘이다: 다른 워커가 이미 재claim했거나(reaper), 0바이트
    사용자 stop이 회의를 지우면서 job이 FK CASCADE로 함께 사라졌거나. 어느 쪽이든 이 워커는
    더 쓸 것이 없다는 뜻이라 false로 보고한다 — 호출자는 'lost'로 끝낸다.
    """
    cur = conn.execute(
        "UPDATE job SET status='failed', error=%s, updated_at=now() "
        "WHERE id=%s AND status='running' AND locked_by=%s",
        (Jsonb(error), job_id, worker_id),
    )
    return cur.rowcount > 0


# ── 라이브 세션 (설계 §4·§5) ─────────────────────────────────────────────


@dataclass(frozen=True)
class LiveInputState:
    """이 세션의 입력 경계 스냅샷. 읽기 스레드에 통째로 교체해 건네므로 불변이다.

    signal: 'stop' = API가 봉인을 끝냈다. 'lost' = 소유권 상실(cancel·reaper). None = 계속.
    committed_bytes: fdatasync 뒤 DB에 커밋된 연속 prefix. 읽기 상한이다 (설계 §3.5).
    sealed_bytes: 그 prefix가 최종 길이로 확정됐다는 표시. EOF의 유일한 근거다.
    """

    signal: str | None
    committed_bytes: int
    sealed_bytes: int | None


def get_live_input_state(conn, job_id: str, worker_id: str) -> LiveInputState:
    """루프가 1초마다 읽는 종료 신호와 입력 경계 (설계 §3.5).

    셋을 한 SELECT로 읽는 이유는 원자성이 아니다 — 이 커넥션은 autocommit이라
    READ COMMITTED에서 두 SELECT가 찢어진 상태를 볼 수 없다. 이유는 (a) 왕복 1회이고
    (b) 경계 읽기가 stop 검사와 같은 소유권 술어 안에 묶여, 그 사이 job이 재claim되면
    낡은 값을 받는 TOCTOU가 닫히기 때문이다.

    lost일 때 committed=0을 내는 것은 의도적이다. 소유권을 잃은 워커가 마지막으로 본
    경계를 계속 소비하면 이미 남이 쓰고 있는 파일을 전사하게 된다 — 소비자는 이 신호를
    보면 더 읽지 않고 즉시 끝낸다 (설계 §4.2).

    committed_bytes가 NULL인 활성 세션은 024 이전에 만들어진 것뿐이다. 파일 길이로
    역산하지 않고 0으로 본다 — 그러면 미리보기가 아무것도 못 읽고 sealed에서 끝난다.
    """
    row = conn.execute(
        "SELECT status, locked_by, stop_requested_at, committed_bytes, sealed_bytes "
        "FROM job WHERE id=%s",
        (job_id,),
    ).fetchone()
    if row is None or row["locked_by"] != worker_id or row["status"] != "running":
        return LiveInputState("lost", 0, None)
    committed = row["committed_bytes"]
    return LiveInputState(
        "stop" if row["stop_requested_at"] is not None else None,
        0 if committed is None else int(committed),
        row["sealed_bytes"],
    )


def insert_live_utterance(
    conn,
    *,
    meeting_id: str,
    job_id: str,
    seq: int,
    start_ms: int,
    end_ms: int,
    text: str,
    speaker_id: str | None,
    similarity: float | None,
) -> str:
    return conn.execute(
        """
        INSERT INTO live_utterance(meeting_id, job_id, seq, start_ms, end_ms, text,
                                   speaker_id, similarity)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id
        """,
        (meeting_id, job_id, seq, start_ms, end_ms, text, speaker_id, similarity),
    ).fetchone()["id"]


def delete_live_utterances(conn, meeting_id: str) -> int:
    return conn.execute("DELETE FROM live_utterance WHERE meeting_id=%s", (meeting_id,)).rowcount


def finalize_live_session(
    conn,
    *,
    job_id: str,
    worker_id: str,
    meeting_id: str,
    duration_ms: int,
    process_payload: dict,
) -> str:
    """녹음 종료: 회의를 uploaded로 바꾸고 payload의 v5 process_meeting을 그대로 큐잉한다.

    잠금 순서는 persist와 같은 job → meeting. API의 stop도 같은 순서라 교차하지 않는다.
    라이브 발화는 여기서 지우지 않는다 — 최종 패스가 도는 1~2분 동안 미리보기로 남아야 한다.

    워커가 마무리할 자격은 소유권(running + locked_by)만으로는 부족하다. **봉인된 세션**,
    즉 sealed_bytes가 확정 경계와 같을 때만이다 (설계 §4.1). 그래야 duration_ms가 자라는
    중인 파일의 길이가 아니라 API가 정한 최종 길이에서 나온다. 봉인 전이면 마무리할 사람은
    아직 아무도 없고, 그 판단은 잠금 아래 DB 행으로 다시 확인한다 — 루프의 스냅샷은 최대
    1초 낡았다.
    """
    try:
        with conn.transaction():
            owned = conn.execute(
                "SELECT committed_bytes, sealed_bytes FROM job "
                "WHERE id=%s AND locked_by=%s AND status='running' FOR UPDATE",
                (job_id, worker_id),
            ).fetchone()
            if owned is None:
                raise _Abort
            if owned["sealed_bytes"] is None or owned["sealed_bytes"] != owned["committed_bytes"]:
                raise _Abort
            cur = conn.execute(
                """
                UPDATE meeting SET status='uploaded', duration_ms=%s, error=NULL
                WHERE id=%s AND status='recording' AND current_job_id=%s
                """,
                (duration_ms, meeting_id, job_id),
            )
            # capture_error는 일부러 SET 목록에 없다. error는 "이 회의의 처리가 실패했는가"이고
            # capture_error는 "이 녹음이 어떻게 얻어졌는가"다. 최종 패스가 성공해도 "40분 중
            # 30분만 녹음됐다"는 계속 보여야 한다 (설계 §2.10).
            if cur.rowcount == 0:
                conn.execute(
                    "UPDATE job SET status='done', error=%s, updated_at=now() WHERE id=%s",
                    (
                        Jsonb(
                            {
                                "code": "discarded_by_stale_guard",
                                "message": "meeting is no longer recording under this job",
                                "stage": "finalize",
                            }
                        ),
                        job_id,
                    ),
                )
                return "discarded"
            new_job_id = conn.execute(
                "INSERT INTO job(type, meeting_id, payload) VALUES('process_meeting', %s, %s) "
                "RETURNING id",
                (meeting_id, Jsonb(process_payload)),
            ).fetchone()["id"]
            conn.execute(
                "UPDATE meeting SET current_job_id=%s WHERE id=%s", (new_job_id, meeting_id)
            )
            conn.execute(
                "UPDATE job SET status='done', progress=100, updated_at=now() WHERE id=%s",
                (job_id,),
            )
            return "committed"
    except _Abort:
        return "lost"
