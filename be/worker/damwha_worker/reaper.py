import logging

from . import db

log = logging.getLogger("damwha_worker")


def run_reaper_loop(database_url, stale_minutes, interval_seconds, shutdown_event) -> None:
    while not shutdown_event.is_set():
        conn = None
        try:
            conn = db.connect(database_url)
            requeued, failed = db.reap_stale(conn, stale_minutes)
            if requeued or failed:
                log.warning("worker reaper: requeued=%s failed=%s", requeued, failed)
        except Exception:  # noqa: BLE001 — next interval retries DB recovery
            log.exception("worker reaper failed")
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001 — close failure must not stop polling
                    pass
        shutdown_event.wait(interval_seconds)
