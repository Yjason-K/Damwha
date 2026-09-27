"""모델 받기·삭제 job의 DB 원시 요소 (모델 다운로드 관리 스펙 §7)."""

from .core import MODEL_READINESS_KEY, shared_state_enabled


def complete_job(conn, job_id: str, worker_id: str) -> bool:
    """내가 쥔 running job을 done으로 닫는다. 소유권을 잃었으면 False."""
    cur = conn.execute(
        "UPDATE job SET status='done', progress=100, updated_at=now() "
        "WHERE id=%s AND locked_by=%s AND status='running'",
        (job_id, worker_id),
    )
    return cur.rowcount > 0


def stop_requested(conn, job_id: str) -> bool:
    row = conn.execute("SELECT stop_requested_at FROM job WHERE id=%s", (job_id,)).fetchone()
    return row is not None and row["stop_requested_at"] is not None


# merge_model_readiness와 같은 한 문장의 원자적 갱신 — 읽고 고쳐 쓰면 다른 writer의 key를 지운다.
_REMOVE_READINESS_KEY_SQL = """
UPDATE app_setting
   SET value = jsonb_set(value, '{entries}', COALESCE(value->'entries', '{}'::jsonb) - %(k)s::text),
       updated_at = now()
 WHERE key = %(row_key)s AND jsonb_typeof(value->'entries') = 'object'
"""


def remove_model_readiness_key(conn, key: str) -> None:
    """`model_readiness.entries[key]`를 지운다. 미리 받기의 최종 실패·취소·삭제 뒤에 부른다
    (스펙 §7.3·§7.4).

    남겨 두면 desktop 상태 창이 선택 기능의 실패에 "다시 시작"을 권하거나, 지운 모델이 처리
    배너에 옛 상태로 남는다.
    """
    if not shared_state_enabled():
        return
    conn.execute(_REMOVE_READINESS_KEY_SQL, {"k": key, "row_key": MODEL_READINESS_KEY})


def model_job_refs(
    conn, role, name, backend, lens_models, summary_fallback, exclude_job
) -> list[str]:
    """마이그레이션 027의 `model_job_refs` — API와 같은 판정을 부른다(사본을 두지 않는다)."""
    rows = conn.execute(
        "SELECT id FROM model_job_refs(%s, %s, %s, %s::text[], %s, %s) AS id",
        (role, name, backend, list(lens_models), summary_fallback, exclude_job),
    ).fetchall()
    return [r["id"] for r in rows]
