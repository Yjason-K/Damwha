import logging
import threading

from . import db

log = logging.getLogger("damwha_worker")


class Heartbeat:
    """job 소유권을 주기적으로 갱신한다.

    beat가 0행을 갱신하면 소유권을 잃은 것이다 — 운영자 취소(BE가 job을 failed로)
    또는 reaper의 회수. 그때 `set_on_lost`로 걸어 둔 훅을 정확히 한 번 부르고
    beat를 멈춘다. 워커는 이 훅으로 자신이 띄운 LLM 서버를 내려, 취소 즉시
    메모리를 돌려주고 진행 중 HTTP 요청을 실패시킨다(결과는 소유권 가드에 막혀
    `lost`로 버려진다).
    """

    def __init__(self, url: str, job_id: str, worker_id: str, interval: float) -> None:
        self._url = url
        self._job_id = job_id
        self._worker_id = worker_id
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._on_lost = None
        self._lock = threading.Lock()

    def set_on_lost(self, callback) -> None:
        """소유권 상실 시 부를 훅. None이면 해제 — 정상 완료 직후의 경합을 막는다."""
        with self._lock:
            self._on_lost = callback

    def _fire_lost(self) -> None:
        with self._lock:
            cb = self._on_lost
            self._on_lost = None
        log.warning(
            "job %s ownership lost (cancelled or reaped) — aborting in-flight work",
            self._job_id,
        )
        if cb is None:
            return
        try:
            cb()
        except Exception:  # noqa: BLE001 — 훅 실패가 heartbeat 스레드를 죽이면 안 된다
            log.warning("on_lost hook failed for job %s", self._job_id, exc_info=True)

    def _run(self) -> None:
        conn = None
        try:
            while not self._stop.is_set():
                if conn is None:
                    try:
                        conn = db.connect(self._url)  # 별도 커넥션 (psycopg는 스레드 간 공유 불가)
                    except Exception:  # noqa: BLE001 — connect 실패가 스레드를 죽이면 안 된다
                        log.warning(
                            "heartbeat connect failed for job %s (retry in %ss)",
                            self._job_id,
                            self._interval,
                            exc_info=True,
                        )
                        if self._stop.wait(self._interval):
                            break
                        continue
                if self._stop.wait(self._interval):
                    break
                try:
                    if db.heartbeat(conn, self._job_id, self._worker_id) == 0:
                        self._fire_lost()
                        break  # 더 갱신할 소유권이 없다
                except Exception:  # noqa: BLE001 — a transient beat failure must not kill the heartbeat thread
                    log.warning(
                        "heartbeat failed for job %s (reconnect next interval)",
                        self._job_id,
                        exc_info=True,
                    )
                    try:
                        conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    conn = None
        finally:
            if conn is not None:
                conn.close()

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
