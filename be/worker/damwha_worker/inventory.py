"""받아 둔 모델 목록을 `app_setting.model_inventory`에 올린다 (모델 다운로드 관리 스펙 §4.2).

worker **부모**의 daemon 스레드에서 돈다(`report_host_capabilities`와 같은 자리). 부모는 가벼워야
하므로 이 모듈과 그 의존(`specs`·`cache_scan`)은 표준 라이브러리만 쓴다.

**언제 쓰나.** `poll_interval_seconds`마다 캐시 지문을 재고, 지문이 바뀌었거나 마지막 쓰기에서
`full_rescan_seconds`(5분)가 지났으면 다시 스캔해 행 전체를 덮어쓴다. 시작 시 한 번은 무조건 쓴다.
지문은 스캔 **전에** 잰 값을 기억한다 — 스캔 도중 바뀐 것은 다음 주기에 다시 잡힌다. worker job,
embed, `llm_entry`, 사용자의 수동 삭제를 트리거 배선 없이 이 한 규칙이 잡는다. 5분 무조건 스캔은
지문이 놓친 경우의 안전망이다.

또 하나의 트리거: `model_readiness`의 최상위 `updated_at`이 지난 주기와 다르면(캐시 지문·5분과
무관하게) 다시 스캔한다. 캐시 히트로 적재된 모델은 파일이 이미 있어 지문이 안 바뀌므로, 이게
없으면 받기가 끝난 뒤에도 최대 5분간 `pending`이 참으로 남는다(스펙 §5.1의 pending 두 번째
조건). readiness 스탬프도 지문처럼 **스캔 전에** 읽고, 다음 비교 기준으로 남기는 것은 쓰기가
성공했을 때뿐이다.

`DAMWHA_SHARED_STATE=off`(외장 DB 모드)면 이 루프는 아무것도 하지 않고 즉시 돌아온다 — 앱이
소유하지 않은 DB에 쓰지 않는 것과 같은 이유로, 쓰지도 않을 지문 계산·캐시 스캔조차 하지 않는다.

**실패.** 스캔이 던지면(권한 등) 쓰지 않고 다음 주기에 다시 본다 — 한 번의 실패로 모든 모델이
"안 받음"으로 깜빡이지 않게. 캐시 루트가 없는 첫 실행은 실패가 아니라 빈 `repos`다(`scan_cache`).
DB 오류도 로그만 남긴다.
"""

from __future__ import annotations

import logging
import time

from . import db
from .db import core
from .models import bundle, cache_scan, specs

log = logging.getLogger("damwha_worker")


def build_inventory(
    root: str,
    *,
    lens_model: str | None,
    summary_fallback: str | None,
    diarization_model_dir: str | None = None,
) -> dict:
    by_repo = specs.specs_by_repo()
    scanned = cache_scan.scan_cache(root, by_repo)
    repos = {
        repo: {"size_bytes": r.size_bytes, "complete": r.complete}
        for repo, r in sorted(scanned.items())
    }
    # 앱 번들이 온전하면 캐시 결과를 덮는다 (스펙 2026-09-30 §3.2). 캐시의 옛 사본은 무시된다.
    if bundle.bundle_complete(diarization_model_dir):
        repos[specs.DIARIZATION_MODEL] = {
            "size_bytes": bundle.bundle_size(diarization_model_dir),
            "complete": True,
        }
    return {
        "scanned_at": core.readiness_now(),
        "repos": repos,
        "resolved": [
            {"role": s.role, "name": s.name, "backend": s.backend, "repo_id": s.repo_id}
            for s in specs.all_specs()
            if s.role == "stt"
        ],
        "approx": {s.repo_id: s.approx_bytes for s in by_repo.values() if s.approx_bytes},
        # 렌즈 자동 추출·옛 payload의 요약 대체값은 worker env를 쓴다(dispatch.py) — API는 BE env만
        # 알므로 여기서 알려 준다.
        "worker_llm": {"lens_model": lens_model, "summary_fallback": summary_fallback},
        # 남은 디스크 — 받기 전 "여유보다 큰 모델" 경고용(스펙 §6.4). 정확한 판정은
        # 받을 때 훅이 한다.
        "free_bytes": _free_bytes(root),
    }


def _free_bytes(root: str) -> int | None:
    from .models import disk  # 표준 라이브러리만 쓴다(shutil) — 부모 경량 규칙을 지킨다

    try:
        return disk.free_bytes(root)
    except OSError:
        return None


def clear_stale_bundle_failure(conn, bundle_dir: str | None, writer: str) -> None:
    """앱 번들이 온전하면 화자 분리 모델의 옛 readiness 항목을 `ready`로 고친다.

    0.4.x는 이 모델을 hub에서 받았고, 토큰 오류(`hf_token_invalid` 등)로 남은 `failed`가 업그레이드
    뒤에도 그대로 붙어 첫 회의를 돌리기 전까지 상태 창이 "실패"를 보인다. 번들 적재 경로
    (`pyannote_diar`)가 `ready`를 쓰는 것은 적재 성공 뒤라 그 전에는 고쳐지지 않는다.

    **이미 있는 항목만** 고친다 — 새 설치에 없던 항목을 만들지 않는다(스펙 §6.9 "실제로 건드린
    모델만"). 쓰기는 `downloads._mark_ready`와 같은 길(`merge_model_readiness`)이고, writer는 이
    worker의 id다.
    """
    if not bundle.bundle_complete(bundle_dir):
        return
    entry = db.read_model_readiness(conn)["entries"].get(specs.DIARIZATION_MODEL)
    if not isinstance(entry, dict) or entry.get("state") == "ready":
        return
    db.merge_model_readiness(conn, specs.DIARIZATION_MODEL, {"state": "ready"}, writer)
    log.info("bundled diarization model present — cleared stale readiness %r", entry.get("state"))


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
    if not core.shared_state_enabled():
        log.info("DAMWHA_SHARED_STATE=off — inventory 루프를 시작하지 않는다")
        return
    root = root or cache_scan.hub_cache_dir()
    interval = settings.poll_interval_seconds if interval is None else interval
    connect = connect or db.connect
    last_fp = None
    last_write: float | None = None
    last_readiness_at: str | None = None
    bundle_checked = False
    while not shutdown.is_set():
        try:
            fp = cache_scan.fingerprint(root)
            now = clock()
            conn = connect(database_url)
            try:
                if not bundle_checked:
                    # 기동 후 한 번 (`clear_stale_bundle_failure`). 스탬프를 읽기 **전**이라 이
                    # 쓰기로 바뀐 updated_at은 같은 주기의 비교에 이미 들어간다.
                    clear_stale_bundle_failure(
                        conn, settings.diarization_model_dir, settings.worker_id
                    )
                    bundle_checked = True
                # readiness 스탬프도 지문처럼 스캔 **전에** 읽는다 — 스캔 도중 바뀐 것은
                # 다음 주기가 잡는다(모듈 docstring).
                readiness_at = db.read_model_readiness(conn)["updated_at"]
                due = (
                    last_write is None
                    or fp != last_fp
                    or now - last_write >= full_rescan_seconds
                    or readiness_at != last_readiness_at
                )
                if due:
                    value = build_inventory(
                        root,
                        lens_model=settings.lens_llm_model,
                        summary_fallback=settings.summary_llm_model,
                        diarization_model_dir=settings.diarization_model_dir,
                    )
                    db.write_model_inventory(conn, value)
                    last_fp, last_write, last_readiness_at = fp, now, readiness_at
            finally:
                conn.close()
        except Exception:  # noqa: BLE001 — 다음 주기가 다시 본다
            log.warning("model inventory scan/write failed — retrying next cycle", exc_info=True)
        if shutdown.wait(interval):
            break
