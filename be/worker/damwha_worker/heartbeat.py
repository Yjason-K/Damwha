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
                    db.heartbeat(conn, self._job_id, self._worker_id)
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
