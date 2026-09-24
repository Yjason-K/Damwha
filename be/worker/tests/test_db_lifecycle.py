from damwha_worker import db
from tests.conftest import seed_job, seed_meeting, seed_speaker


def test_claim_increments_attempts_and_locks(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert j is not None
    assert j["status"] == "running"
    assert j["attempts"] == 1
    assert j["locked_by"] == "w1"
    assert j["stage"] is None


def test_claim_empty_returns_none(conn):
    assert db.claim(conn, "w1") is None


def test_claim_skips_future_retry_until_eligible(conn):
    delayed = seed_job(conn, type="index_meeting")
    conn.execute("UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=%s", (delayed,))
    ready = seed_job(conn, type="index_meeting")

    assert db.claim(conn, "w1")["id"] == ready


def test_set_stage_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert db.set_stage(conn, j["id"], "w1", "diarize", 40) == 1
    assert db.set_stage(conn, j["id"], "someone-else", "stt", 60) == 0  # lost ownership
    row = conn.execute("SELECT stage, progress FROM job WHERE id=%s", (j["id"],)).fetchone()
    assert row["stage"] == "diarize" and row["progress"] == 40


def test_mark_processing_guarded_by_meeting(conn):
    mid = seed_meeting(conn, processing_version=2)
    seed_job(conn, meeting_id=mid)
    # 실제로 mark_processing은 **claim한 자식**만 부른다. job 가드가 생긴 뒤로는
    # queued인 채로 두면 meeting 가드를 보기도 전에 0이 나와, 이 테스트가 재려던
    # processing_version 불일치를 못 재게 된다.
    jid = db.claim(conn, "w1")["id"]
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    assert db.mark_processing(conn, mid, jid, 2, "w1") == 1
    assert db.mark_processing(conn, mid, jid, 1, "w1") == 0  # version mismatch → stale
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "processing"
    )


def test_requeue_clears_lock(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    j = db.claim(conn, "w1")
    assert db.requeue(conn, j["id"], "w1", {"code": "x", "kind": "TRANSIENT", "stage": None}) == 1
    row = conn.execute(
        "SELECT status, locked_by, locked_at FROM job WHERE id=%s", (j["id"],)
    ).fetchone()
    assert row["status"] == "queued" and row["locked_by"] is None and row["locked_at"] is None


def test_requeue_sets_delay_from_claimed_attempt(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")

    assert db.requeue(conn, jid, "w1", {"code": "x", "kind": "TRANSIENT", "stage": None}) == 1
    row = conn.execute(
        "SELECT next_attempt_at - now() AS delay FROM job WHERE id=%s", (jid,)
    ).fetchone()
    # claim이 attempts를 0→1로 올린 뒤 requeue한다 → 30 * 2^0 = 30초 (025 백오프).
    assert 29 <= row["delay"].total_seconds() <= 31


def test_requeue_stores_the_error_it_retries_for(conn):
    """스펙 §6.3 — 재시도 대기 중 "마지막 오류"의 원천. 지금까지는 쓰지 않았다."""
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    err = {"code": "model_download_failed", "kind": "TRANSIENT", "stage": "stt", "message": "reset"}
    assert db.requeue(conn, jid, "w1", err) == 1
    assert conn.execute("SELECT error FROM job WHERE id=%s", (jid,)).fetchone()["error"] == err


def test_requeue_is_still_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.requeue(conn, jid, "w2", {"code": "x"}) == 0
    row = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "running" and row["error"] is None


def test_requeue_for_shutdown_restores_attempts(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)  # attempts=0
    db.claim(conn, "w1")  # attempts 0→1
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    row = conn.execute(
        "SELECT status, locked_by, locked_at, attempts FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None and row["locked_at"] is None
    assert row["attempts"] == 0  # claim의 +1이 되돌려짐 — 순 소모 0


def test_requeue_for_shutdown_attempts_never_negative(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    conn.execute("UPDATE job SET attempts=0 WHERE id=%s", (jid,))  # 인위적 0
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert conn.execute("SELECT attempts FROM job WHERE id=%s", (jid,)).fetchone()["attempts"] == 0


def test_requeue_for_shutdown_guarded_by_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.requeue_for_shutdown(conn, jid, "w2") == 0  # 소유자 아님 — no-op
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )


def test_reap_stale_fails_exhausted_process_meeting_and_entity(conn):
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="dead-worker",
        attempts=3,
        max_attempts=3,
        interruptions=2,
        locked_minutes_ago=31,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    assert db.reap_stale(conn, 30) == (0, 1)
    job = conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()
    meeting = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert job["status"] == "failed"
    assert meeting["status"] == "failed"


def test_reap_stale_makes_retried_job_immediately_eligible(conn):
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="dead-worker",
        attempts=1,
        max_attempts=3,
        locked_minutes_ago=31,
    )
    conn.execute("UPDATE job SET next_attempt_at=now() + interval '1 hour' WHERE id=%s", (jid,))

    assert db.reap_stale(conn, 30) == (1, 0)
    row = conn.execute("SELECT status, next_attempt_at FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "queued"
    assert row["next_attempt_at"] is None


def test_fail_process_meeting_propagates(conn):
    mid = seed_meeting(conn, processing_version=0)
    jid = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    db.claim(conn, "w1")
    ok = db.fail_process_meeting(conn, jid, "w1", mid, {"code": "corrupt_audio", "message": "x"})
    assert ok is True
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    assert (
        conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"]
        == "failed"
    )


def test_fail_process_meeting_lost_ownership(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid)
    db.claim(conn, "w1")
    assert db.fail_process_meeting(conn, jid, "OTHER", mid, {"code": "x", "message": "y"}) is False
    # job not failed by a non-owner
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )


def test_fail_enroll_propagates(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    assert (
        db.fail_enroll(conn, jid, "w1", sid, {"code": "model_load_failed", "message": "x"}) is True
    )
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "failed"
    )
    row = conn.execute(
        "SELECT enrollment_status, enrollment_error FROM speaker WHERE id=%s", (sid,)
    ).fetchone()
    assert row["enrollment_status"] == "failed"
    assert row["enrollment_error"] is not None


def test_fail_enroll_lost_ownership(conn):
    sid = seed_speaker(conn, enrollment_status="pending")
    jid = seed_job(conn, type="enroll_speaker", meeting_id=None)
    conn.execute("UPDATE speaker SET current_job_id=%s WHERE id=%s", (jid, sid))
    db.claim(conn, "w1")
    assert db.fail_enroll(conn, jid, "OTHER", sid, {"code": "x", "message": "y"}) is False
    assert (
        conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()["status"] == "running"
    )
    assert (
        conn.execute("SELECT enrollment_status FROM speaker WHERE id=%s", (sid,)).fetchone()[
            "enrollment_status"
        ]
        == "pending"
    )


def test_peek_queued_true_when_queued_job_exists(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    assert db.peek_queued(conn) is True


def test_peek_queued_false_when_empty(conn):
    assert db.peek_queued(conn) is False


def test_peek_queued_does_not_claim(conn):
    mid = seed_meeting(conn)
    seed_job(conn, meeting_id=mid)
    db.peek_queued(conn)
    row = conn.execute("SELECT status FROM job WHERE meeting_id=%s", (mid,)).fetchone()
    assert row["status"] == "queued"


def test_claim_prefers_live_session_over_older_jobs(conn):
    mid = seed_meeting(conn)
    seed_job(conn, type="process_meeting", meeting_id=mid)
    seed_job(conn, type="index_meeting", meeting_id=mid)
    live = seed_job(conn, type="live_session", meeting_id=mid, max_attempts=1)

    assert db.claim(conn, "w1")["id"] == live


def _stale_live(conn, *, attempts=1, max_attempts=1):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(
        conn,
        type="live_session",
        meeting_id=mid,
        status="running",
        locked_by="w1",
        attempts=attempts,
        max_attempts=max_attempts,
        locked_minutes_ago=45,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    return mid, jid


def test_reap_stale_fails_live_session_but_leaves_the_meeting_recording(conn):
    """워커를 잃는 것은 미리보기를 잃는 것이다 — 녹음을 잃는 것이 아니다 (설계 §4.1·§4.2).

    오디오는 브라우저가 API로 보내고 API가 파일에 쓰므로 워커가 죽어도 녹음은 계속된다.
    여기서 회의를 failed로 만들면 아직 업로드 중인 멀쩡한 녹음을 죽인다. TypeScript
    reapStale과 같은 계약이며, be/test/reaper.spec.ts가 그쪽을 같은 모양으로 고정한다.
    """
    mid, jid = _stale_live(conn)

    assert db.reap_stale(conn, 30) == (0, 1)
    job = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert job["status"] == "failed" and job["error"]["code"] == "stale_worker"
    meeting = conn.execute("SELECT status, error FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert meeting["status"] == "recording" and meeting["error"] is None


def test_reap_stale_never_requeues_a_live_session(conn):
    """미리보기 job은 재queue하지 않는다 (설계 §2.2·§4.2). max_attempts=1이 보통 그것을
    보장하지만, 남는 attempts를 가진 라이브 행이 어쩌다 생겨도 requeue가 아니라 failed다 —
    재claim된 워커는 이미 지나간 오디오를 앞에서부터 다시 전사하게 된다."""
    mid, jid = _stale_live(conn, attempts=1, max_attempts=3)

    assert db.reap_stale(conn, 30) == (0, 1)
    job = conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()
    assert job["status"] == "failed"
    meeting = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert meeting["status"] == "recording"


def _meeting_with_running_job(conn, *, worker_id):
    """회의는 아직 processing으로 넘어가기 전 — job만 claim되어 실행 중인 상태를 재현한다.

    Task 6의 mark_processing worker_id 가드도 이 헬퍼를 그대로 쓴다.
    """
    mid = seed_meeting(conn, status="uploaded", processing_version=1)
    jid = seed_job(conn, meeting_id=mid, status="running", locked_by=worker_id, attempts=1)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    return mid, jid


def test_requeue_backs_off_thirty_seconds_on_the_first_retry(conn):
    mid, jid = _meeting_with_running_job(conn, worker_id="w")
    assert db.requeue(conn, jid, "w", {"code": "x", "kind": "TRANSIENT", "stage": None}) == 1
    row = conn.execute(
        "SELECT extract(epoch from (next_attempt_at - now())) AS secs FROM job WHERE id=%s",
        (jid,),
    ).fetchone()
    # attempts=1 → 30 * 2^0 = 30초. 앞뒤 1초는 실행 시간이다.
    assert 29 <= row["secs"] <= 31


def test_requeue_backoff_is_capped_at_fifteen_minutes(conn):
    mid, jid = _meeting_with_running_job(conn, worker_id="w")
    conn.execute("UPDATE job SET attempts=20 WHERE id=%s", (jid,))
    assert db.requeue(conn, jid, "w", {"code": "x", "kind": "TRANSIENT", "stage": None}) == 1
    row = conn.execute(
        "SELECT extract(epoch from (next_attempt_at - now())) AS secs FROM job WHERE id=%s",
        (jid,),
    ).fetchone()
    assert 899 <= row["secs"] <= 901


def test_worker_capabilities_upsert_overwrites(conn):
    db.upsert_worker_capabilities(conn, {"worker_id": "w1", "gpu_eligible": True})
    db.upsert_worker_capabilities(conn, {"worker_id": "w2", "gpu_eligible": False})
    row = conn.execute(
        "SELECT value FROM app_setting WHERE key=%s", (db.WORKER_CAPABILITIES_KEY,)
    ).fetchone()
    assert row["value"] == {"worker_id": "w2", "gpu_eligible": False}


def test_mark_processing_refuses_when_the_job_is_no_longer_running(conn, pg_url):
    # P4-C7 회차 실측: 취소가 claim과 mark_processing 사이에 들어오면, 취소는 job과
    # meeting.status만 바꾸고 `current_job_id`·`processing_version`은 그대로 두므로
    # meeting 가드를 그냥 통과한다 → mark_processing이 meeting을 `processing`으로
    # 되돌려 놓는다. 그러면 취소는 409(진행 중인 게 없다), 재처리도 409(done/failed가
    # 아니다)라 **회의가 도달 불가 상태로 굳는다**. 같은 파일의 set_stage·heartbeat는
    # 둘 다 job 가드를 건다 — 이것만 빠져 있었다.
    mid = seed_meeting(conn, status="failed")
    jid = seed_job(conn, meeting_id=mid, status="failed")
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    conn.commit()

    assert db.mark_processing(conn, mid, jid, 0, "w1") == 0
    row = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] == "failed"


def test_mark_processing_still_marks_a_running_job(conn, pg_url):
    # 정상 경로는 그대로다 — 가드를 너무 좁히면 모든 처리가 lost_ownership이 된다.
    mid = seed_meeting(conn, status="uploaded")
    jid = seed_job(conn, meeting_id=mid, status="running", locked_by="w1")
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    conn.commit()

    assert db.mark_processing(conn, mid, jid, 0, "w1") == 1
    row = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] == "processing"


def test_mark_processing_refuses_a_worker_that_no_longer_owns_the_job(conn):
    # 회수(기동 시) → 새 worker의 재claim → **뒤늦게 도착한 이전 worker**의 mark_processing.
    # status='running'만 보면 이 호출이 통과해 자기 것이 아닌 job의 상태를 옮긴다.
    mid, jid = _meeting_with_running_job(conn, worker_id="desktop-old")
    conn.execute("UPDATE job SET locked_by='desktop-new' WHERE id=%s", (jid,))
    assert db.mark_processing(conn, mid, jid, 1, "desktop-old") == 0
    row = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert row["status"] != "processing"


def test_mark_processing_accepts_the_owning_worker(conn):
    mid, jid = _meeting_with_running_job(conn, worker_id="desktop-new")
    assert db.mark_processing(conn, mid, jid, 1, "desktop-new") == 1


def test_reap_own_orphans_requeues_this_workers_running_job_without_waiting(conn):
    """`--once` 자식이 죽으면 그 행은 30분을 기다리지 않고 바로 돌아와야 한다.

    `locked_at`이 방금인데도 회수된다 — 부모가 "내 자식은 없다"를 알고 부르는 자리다.
    """
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="w1",
        attempts=1,
        max_attempts=5,
        locked_minutes_ago=0,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    assert db.reap_own_orphans(conn, "w1") == (1, 0)
    row = conn.execute(
        "SELECT status, locked_by, next_attempt_at FROM job WHERE id=%s", (jid,)
    ).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None
    assert row["next_attempt_at"] is None


def test_reap_own_orphans_leaves_another_workers_job_alone(conn):
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="w2",
        attempts=1,
        max_attempts=5,
        locked_minutes_ago=0,
    )

    assert db.reap_own_orphans(conn, "w1") == (0, 0)
    row = conn.execute("SELECT status, locked_by FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "running"
    assert row["locked_by"] == "w2"


def test_reap_own_orphans_fails_live_session_instead_of_requeueing(conn):
    mid = seed_meeting(conn, status="recording")
    jid = seed_job(
        conn,
        type="live_session",
        meeting_id=mid,
        status="running",
        locked_by="w1",
        attempts=1,
        max_attempts=5,
        locked_minutes_ago=0,
    )

    assert db.reap_own_orphans(conn, "w1") == (0, 1)
    row = conn.execute("SELECT status, error FROM job WHERE id=%s", (jid,)).fetchone()
    assert row["status"] == "failed"
    assert row["error"]["code"] == "stale_worker"


def test_reap_own_orphans_fails_on_the_third_interruption(conn):
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn,
        meeting_id=mid,
        status="running",
        locked_by="w1",
        attempts=5,
        max_attempts=5,
        interruptions=2,
        locked_minutes_ago=0,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    assert db.reap_own_orphans(conn, "w1") == (0, 1)
    job = conn.execute("SELECT status FROM job WHERE id=%s", (jid,)).fetchone()
    assert job["status"] == "failed"
    meeting = conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()
    assert meeting["status"] == "failed"


def test_reap_stale_requeues_a_job_whose_retry_budget_is_spent(conn):
    """재시도 예산(attempts=max_attempts)을 다 써도 중단 예산이 남으면 queued (스펙 §4.2)."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(
        conn, meeting_id=mid, status="running", locked_by="dead", attempts=3, max_attempts=3,
        locked_minutes_ago=31,
    )
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))
    assert db.reap_stale(conn, 30) == (1, 0)
    row = conn.execute("SELECT status, attempts, interruptions FROM job WHERE id=%s", (jid,)).fetchone()
    assert (row["status"], row["attempts"], row["interruptions"]) == ("queued", 3, 1)


def test_reap_stale_leaves_a_meeting_whose_current_job_is_newer(conn):
    """스펙 §6.1 — 밀려난 옛 job의 소진 회수가 새 실행의 회의를 덮지 않는다."""
    mid = seed_meeting(conn, status="processing")
    old = seed_job(
        conn, meeting_id=mid, status="running", locked_by="dead", attempts=3, max_attempts=5,
        interruptions=2, locked_minutes_ago=31,
    )
    newer = seed_job(conn, meeting_id=mid)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (newer, mid))
    assert db.reap_stale(conn, 30) == (0, 1)
    assert conn.execute("SELECT status FROM job WHERE id=%s", (old,)).fetchone()["status"] == "failed"
    assert conn.execute("SELECT status FROM meeting WHERE id=%s", (mid,)).fetchone()["status"] == "processing"


def _counters(conn, jid):
    r = conn.execute(
        "SELECT status, attempts, interruptions FROM job WHERE id=%s", (jid,)
    ).fetchone()
    # 스펙 §4.1의 두 불변식 — 매 전이 뒤에 선다.
    assert 0 <= r["interruptions"] <= r["attempts"]
    if r["status"] == "running":
        assert r["interruptions"] < r["attempts"]
    return r["status"], r["attempts"], r["interruptions"]


def test_transitions_keep_the_counter_invariants(conn):
    """도달 가능한 전이만으로: claim → 회수 → claim → 정상 반납 → claim → 회수 → claim → 회수(소진)."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(conn, meeting_id=mid, max_attempts=5)
    conn.execute("UPDATE meeting SET current_job_id=%s WHERE id=%s", (jid, mid))

    db.claim(conn, "w1")
    assert _counters(conn, jid) == ("running", 1, 0)
    assert db.reap_own_orphans(conn, "w1") == (1, 0)
    assert _counters(conn, jid) == ("queued", 1, 1)
    db.claim(conn, "w1")
    assert _counters(conn, jid) == ("running", 2, 1)
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert _counters(conn, jid) == ("queued", 1, 1)
    db.claim(conn, "w1")
    assert db.reap_own_orphans(conn, "w1") == (1, 0)
    assert _counters(conn, jid) == ("queued", 2, 2)
    db.claim(conn, "w1")
    assert db.reap_own_orphans(conn, "w1") == (0, 1)
    assert _counters(conn, jid) == ("failed", 3, 3)


def test_a_late_shutdown_from_the_old_owner_is_refused_after_reclaim(conn):
    """회수 뒤 옛 소유자의 늦은 반납은 소유권 가드에 막혀 0행 — attempts가 두 번 내려가지 않는다."""
    mid = seed_meeting(conn, status="processing")
    jid = seed_job(conn, meeting_id=mid, max_attempts=5)
    db.claim(conn, "w-old")
    conn.execute("UPDATE job SET locked_at = now() - interval '31 minutes' WHERE id=%s", (jid,))
    assert db.reap_stale(conn, 30) == (1, 0)
    db.claim(conn, "w-new")
    assert db.requeue_for_shutdown(conn, jid, "w-old") == 0
    assert _counters(conn, jid) == ("running", 2, 1)


def test_requeue_for_shutdown_leaves_interruptions_alone(conn):
    mid = seed_meeting(conn)
    jid = seed_job(conn, meeting_id=mid, attempts=1, interruptions=1)
    db.claim(conn, "w1")  # attempts 1→2
    assert db.requeue_for_shutdown(conn, jid, "w1") == 1
    assert _counters(conn, jid) == ("queued", 1, 1)
