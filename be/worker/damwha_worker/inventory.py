"""받아 둔 모델 목록을 `app_setting.model_inventory`에 올린다 (모델 다운로드 관리 스펙 §4.2).

worker **부모**의 daemon 스레드에서 돈다(`report_host_capabilities`와 같은 자리). 부모는 가벼워야
하므로 이 모듈과 그 의존(`specs`·`cache_scan`)은 표준 라이브러리만 쓴다.

**언제 쓰나.** `poll_interval_seconds`마다 캐시 지문을 재고, 지문이 바뀌었거나 마지막 쓰기에서
`full_rescan_seconds`(5분)가 지났으면 다시 스캔해 행 전체를 덮어쓴다. 시작 시 한 번은 무조건 쓴다.
지문은 스캔 **전에** 잰 값을 기억한다 — 스캔 도중 바뀐 것은 다음 주기에 다시 잡힌다. worker job,
embed, `llm_entry`, 사용자의 수동 삭제를 트리거 배선 없이 이 한 규칙이 잡는다. 5분 무조건 스캔은
지문이 놓친 경우의 안전망이다.

**실패.** 스캔이 던지면(권한 등) 쓰지 않고 다음 주기에 다시 본다 — 한 번의 실패로 모든 모델이
"안 받음"으로 깜빡이지 않게. 캐시 루트가 없는 첫 실행은 실패가 아니라 빈 `repos`다(`scan_cache`).
DB 오류도 로그만 남긴다.
"""

from __future__ import annotations

import logging
import time

from . import db
from .db import core
from .models import cache_scan, specs

log = logging.getLogger("damwha_worker")


def build_inventory(root: str, *, lens_model: str | None, summary_fallback: str | None) -> dict:
    by_repo = specs.specs_by_repo()
    scanned = cache_scan.scan_cache(root, by_repo)
    return {
        "scanned_at": core.readiness_now(),
        "repos": {
            repo: {"size_bytes": r.size_bytes, "complete": r.complete}
            for repo, r in sorted(scanned.items())
        },
        "resolved": [
            {"role": s.role, "name": s.name, "backend": s.backend, "repo_id": s.repo_id}
            for s in specs.all_specs()
            if s.role == "stt"
        ],
        "approx": {s.repo_id: s.approx_bytes for s in by_repo.values() if s.approx_bytes},
        # 렌즈 자동 추출·옛 payload의 요약 대체값은 worker env를 쓴다(dispatch.py) — API는 BE env만
        # 알므로 여기서 알려 준다.
        "worker_llm": {"lens_model": lens_model, "summary_fallback": summary_fallback},
    }


def run_inventory_loop(
    database_url: str,
    settings,
    shutdown,
    *,
    root: str | None = None,
    interval: float | None = None,
    full_rescan_seconds: float = 300.0,
    clock=time.monotonic,
    connect=None,
) -> None:
    root = root or cache_scan.hub_cache_dir()
    interval = settings.poll_interval_seconds if interval is None else interval
    connect = connect or db.connect
    last_fp = None
    last_write: float | None = None
    while not shutdown.is_set():
        try:
            fp = cache_scan.fingerprint(root)
            now = clock()
            due = last_write is None or fp != last_fp or now - last_write >= full_rescan_seconds
            if due:
                value = build_inventory(
                    root,
                    lens_model=settings.lens_llm_model,
                    summary_fallback=settings.summary_llm_model,
                )
                conn = connect(database_url)
                try:
                    db.write_model_inventory(conn, value)
                finally:
                    conn.close()
                last_fp, last_write = fp, now
        except Exception:  # noqa: BLE001 — 다음 주기가 다시 본다
            log.warning("model inventory scan/write failed — retrying next cycle", exc_info=True)
        if shutdown.wait(interval):
            break
