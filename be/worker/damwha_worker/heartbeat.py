import logging
import threading

from . import db

log = logging.getLogger("damwha_worker")


class Heartbeat:
    def __init__(self, url: str, job_id: str, worker_id: str, interval: float) -> None:
        self._url = url
        self._job_id = job_id
        self._worker_id = worker_id
        self._interval = interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        conn = db.connect(self._url)  # 별도 커넥션 (psycopg는 스레드 간 공유 불가)
        try:
            while not self._stop.wait(self._interval):
                try:
                    db.heartbeat(conn, self._job_id, self._worker_id)
                except Exception:  # noqa: BLE001 — a transient beat failure must not kill the heartbeat thread
                    log.warning(
                        "heartbeat failed for job %s (will retry next interval)",
                        self._job_id,
                        exc_info=True,
                    )
        finally:
            conn.close()

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)
