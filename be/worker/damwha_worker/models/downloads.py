"""HF 다운로드 진행을 `app_setting.model_readiness`에 올린다 (스펙 §6.9).

**훅 지점.** `huggingface_hub` 1.20.1의 `hf_hub_download`·`snapshot_download`는 `tqdm_class`를
받아 인스턴스화하고 `update(n)`을 부른다. 그 클래스를 우리 것으로 바꿔 끼우면 바이트 진행이
보인다.
소비자(mlx_whisper, sentence_transformers/transformers, pyannote, mlx_lm)는 전부 모듈 수준
`from huggingface_hub import …`라 import 시점에 이름을 묶으므로 설치가 두 갈래다.

1. **원본 자리**(`file_download.hf_hub_download`, `_snapshot_download.snapshot_download`, 패키지
   네임스페이스)를 바꾼다 — 아직 import되지 않은 소비자를 덮는다.
2. **`sys.modules`를 `vars(mod)`로 훑어** 원본과 **같은 객체**를 묶어 둔 이름만 바꾼다 — 이미
   import된 소비자를 덮는다. `getattr(mod, name, None)`을 쓰지 않는다: transformers의 지연 모듈은
   `__getattr__`에서 서브모듈을 import하다 `ModuleNotFoundError`를 던지고(2026-09-18 재현: 92개
   모듈), getattr의 기본값은 AttributeError만 삼킨다. 훑는 것만으로 375개 모듈을 새로 import하는
   부작용도 있다. `vars()`는 `__getattr__`를 부르지 않는다.

설치는 멱등이다 — 원본은 처음 한 번만 잡고, 두 번째 설치는 새로 import된 소비자만 더 덮는다.

**호출 규칙** (감싼 함수 안):
- 호출자가 `tqdm_class`를 **명시하면 손대지 않는다.** `snapshot_download`가 안쪽 파일마다 넘기는
  `_AggregatedTqdm`이 그것이고(그 바이트는 바깥 바가 이미 센다), sentence-transformers의
  `load_dir_path`·faster-whisper의 `download_model`이 넘기는 `disabled_tqdm`도 그렇다 — 뒤의 둘은
  진행이 보고되지 않는다(알려진 한계).
- `local_files_only=True`·`dry_run=True`는 받지 않으므로 그대로 통과시킨다.
- 나머지는 `report_download`로 감싸고 그 보고자에 묶인 `tqdm_class`를 넣는다.

**R-9b.** `downloading`은 **바이트가 실제로 오가기 시작할 때만** 쓴다. 캐시 적중은 바를
만들지 않거나(hf_hub_download) 만들어도 갱신이 없으므로(snapshot_download) 행을 남기지 않는다 —
P4-C9의 "두 번째 실행에 새 downloading 0건". 바가 파일 수에도 쓰이므로(`thread_map`, unit `it`)
`unit == "B"`일 때만 바이트로 센다. 진행 쓰기는 초당 1회 이하, 첫 바이트와 끝(ready/failed)은
즉시 쓴다.

**연결.** 훅은 프로세스마다 연결 하나를 **처음 쓸 때** 연다(`_HookConnection`). 캐시가 찬
프로세스는 끝까지 열지 않는다. 주소는 env `DATABASE_URL`(앱이 주입, `llm_entry`는 `--once`
자식에게서 물려받음), 없으면 `Settings`(웹 흐름의 `.env`)다. 여는 데 실패하면 30초 동안 다시
시도하지 않는다. **어떤 DB 오류도 다운로드를 깨지 않는다** — 로그만 남기고 계속한다.
`DAMWHA_SHARED_STATE=off`면 연결 자체를 열지 않는다.

**key와 writer.** key는 호출의 `repo_id`(스펙 §6.9 "실제로 건드린 모델만"). writer는 설치 때 받은
값 — worker 쪽 프로세스는 WORKER_ID, embed는 `"embed"`(R-9a). supervisor는 모델을 받지 않으므로
설치하지 않는다.

──────────────────────────────────────────────────────────────────────

**스펙 §6.6-b — 캐시 우선·유한 상한·무진행 감시.** 위의 진행 보고와 같은 자리에 붙는 세 층이다.
셋 다 "캐시가 차 있으면 네트워크와 무관하게 적재되고, 어떤 HF 호출도 무한히 멈추지 않는다"는
한 요구를 나눠 진다.

1. **캐시 우선 적재** — `load_cache_first(key, load)`. 로더를 `local_files_only=True`로 **먼저**
   부르고, 캐시 미스일 때만 네트워크로 내려간다. 로더가 그 인자를 자기 API로 못 받아도
   (pyannote·speechbrain) 이 컨텍스트 동안 훅이 **모든 hub 호출에** 그 값을 끼워 넣는다. 성공하면
   그 모델을 `ready`로 적는다 (R-9d — 아래 `_mark_ready`).
2. **유한 상한** — `apply_hf_limits()`. 값은 `config.py`가 정한다(단일 진실 원천). 메타데이터·
   다운로드·공유 클라이언트·xet 네 곳에 각각 유한한 값을 준다.
3. **무진행 감시** — 보고되는 다운로드는 별도 스레드에서 돌리고, 훅이 올리는 진행이 제한
   시간(`config.HF_STALL_SECONDS`) 동안 없으면 호출자 스레드에서 TRANSIENT `WorkerError`를
   던진다. 막힌 호출 자체는 파이썬에서 끊을 수 없다(xet은 Rust 안에서 멈춘다) — 그래서 **호출자를
   풀어 주고 스레드는 버린다.** `--once` 자식은 그 예외로 job을 큐에 돌려보내고 끝난다 (R4-15).
"""

from __future__ import annotations

import contextlib
import functools
import logging
import os
import sys
import threading
import time

from .. import errors
from ..db import core

log = logging.getLogger("damwha_worker")

PROGRESS_INTERVAL_SECONDS = 1.0
_RECONNECT_BACKOFF_SECONDS = 30.0
_CONNECT_KWARGS = {"connect_timeout": 5, "options": "-c statement_timeout=5000"}
_NAMES = ("hf_hub_download", "snapshot_download")
_MISSING = object()
_clock = time.monotonic

# 감시가 진행을 들여다보는 주기. 판정 자체는 `report.last_progress` 하나로 한다.
_WATCHDOG_TICK_SECONDS = 1.0

# `apply_hf_limits`가 채우는 env 이름들. hub 둘은 파이썬 쪽 상수로도 반영하고, xet 셋은
# Rust 쪽이 **자기 프로세스의 env만** 읽으므로 env가 유일한 경로다.
HF_LIMIT_ENV_KEYS = (
    "HF_HUB_ETAG_TIMEOUT",
    "HF_HUB_DOWNLOAD_TIMEOUT",
    "HF_XET_CLIENT_CONNECT_TIMEOUT",
    "HF_XET_CLIENT_READ_TIMEOUT",
    "HF_XET_CLIENT_RETRY_MAX_DURATION",
)

# 캐시 미스의 이름들. hub는 `local_files_only=True`에 캐시가 없으면 `LocalEntryNotFoundError`를
# 던지고(`file_download.py:1795-1799`), `HF_HUB_OFFLINE`이 켜져 있으면 `OfflineModeIsEnabled`가
# 사슬에 남는다. **이 둘만** 온라인 폴백의 조건이다 — 다른 실패를 삼켜 네트워크 재시도로 감추면
# 깨진 캐시나 잘못된 설정이 매번 다운로드로 둔갑한다.
_CACHE_MISS_NAMES = ("LocalEntryNotFoundError", "OfflineModeIsEnabled")

# ── 보고자 ────────────────────────────────────────────────────────────


def _is_benign(exc: BaseException) -> bool:
    """허브에 **없는** 파일을 물은 것 — transformers가 선택 파일(adapter_config.json …)마다 그렇게
    묻고 404를 삼킨다. 받을 것이 없었으므로 모델의 실패가 아니다."""
    return any(cls.__name__ == "RemoteEntryNotFoundError" for cls in type(exc).__mro__)


class _Report:
    """한 다운로드 호출의 진행. DB 오류는 여기서 삼킨다."""

    def __init__(self, conn, key: str, writer: str) -> None:
        self._conn = conn
        self.key = key
        self._writer = writer
        self._enabled = core.shared_state_enabled()
        self._lock = threading.Lock()
        self.done = 0
        self.total = 0
        self._started_at: str | None = None
        self._attempt = 1
        self._last_write = 0.0
        self._abandoned = False
        # 무진행 감시의 유일한 판정 근거. 호출이 시작된 순간부터 센다 — 바이트가 **한 번도**
        # 오지 않는 멈춤(메타데이터 단계의 먹통 네트워크)도 같은 규칙으로 잡히게.
        self.last_progress = _clock()
        self.benign_if = None  # 호출별 추가 판정 (감싼 함수가 채운다)

    @property
    def transferred(self) -> bool:
        return self._started_at is not None

    def abandon(self) -> None:
        """감시가 이 다운로드를 끝냈다 — 버려진 스레드의 뒤늦은 진행을 무시한다.

        막힌 호출은 파이썬에서 끊을 수 없어 스레드를 버리는데, 그 스레드가 나중에 깨어나
        `downloading`을 쓰면 방금 적은 `failed`가 되살아난다.
        """
        with self._lock:
            self._abandoned = True

    def touch(self) -> None:
        """바이트는 아니지만 **무언가 움직였다** — 무진행 시계만 민다. DB에는 쓰지 않는다.

        `last_progress`가 바이트 바에서만 움직이면, 바이트가 안 흐르는 정상 구간(파일 수 바가
        도는 메타데이터 훑기 등)이 '무진행'으로 보인다. 진행 **보고**의 계약은 그대로다 —
        `unit == "B"`가 아닌 바는 여전히 바이트로 세지 않고 항목도 쓰지 않는다.
        """
        with self._lock:
            if self._abandoned:
                return
            self.last_progress = _clock()

    def progress(self, n: int, total: int | None = None) -> None:
        """바이트 `n`이 더 왔다(음수면 되감기). 첫 바이트는 즉시, 이후는 초당 1회 이하로 쓴다."""
        with self._lock:
            if self._abandoned:
                return
            self.last_progress = _clock()
            self.done = max(0, self.done + int(n))
            if total:
                self.total = max(self.total, int(total))
            if not self.transferred:
                if n <= 0:
                    return
                self._started_at = core.readiness_now()
                self._attempt = self._next_attempt()
            elif _clock() - self._last_write < PROGRESS_INTERVAL_SECONDS:
                return
            self._last_write = _clock()
            self._write({"state": "downloading"})

    def finish(self) -> None:
        """바이트가 오간 호출만 `ready`를 쓴다 (R-9b, R-9c-e).

        캐시 적중은 아무것도 안 쓴다. 이 프로세스가 앞서 같은 key를 `failed`로 적었더라도
        마찬가지다 — 0바이트 적중은 "그 모델이 이제 멀쩡하다"의 증거가 아니라 "이 파일 하나가
        캐시에 있다"일 뿐이고, 그것으로 `ready`를 쓰면 곧 실패할 job과 화면이 어긋난다.
        남은 `failed`는 그 key를 **실제로 다시 받는** 다음 다운로드가 덮는다.
        """
        with self._lock:
            if not self.transferred:
                return
            self._write({"state": "ready", "bytes_total": max(self.total, self.done)})

    def fail(self, exc: BaseException) -> None:
        with self._lock:
            if not self.transferred:
                self._started_at = core.readiness_now()
                self._attempt = self._next_attempt()
            # 무진행 감시는 이미 판정이 끝난 `WorkerError`를 던진다 — 그것을 다시 분류하면
            # `WorkerError: model_download_failed: …`라는 겹친 문구가 화면에 남는다.
            w = exc if isinstance(exc, errors.WorkerError) else errors.download_error(exc)
            self._write(
                {
                    "state": "failed",
                    "error": f"{w.code}: {w.message}"[:500],
                    "error_kind": w.kind.value,
                }
            )

    def _next_attempt(self) -> int:
        """직전 항목이 ready가 아니면(실패·중단) 이어서 센다.

        정보용이라 읽기와 쓰기가 한 문장이 아니다 — 경합은 횟수만 틀리게 할 뿐 상태는 못 바꾼다.
        """
        if not self._enabled:
            return 1
        try:
            prev = core.read_model_readiness(self._conn)["entries"].get(self.key)
        except Exception:  # noqa: BLE001 — 시도 횟수 때문에 다운로드를 멈추지 않는다
            self._warn()
            return 1
        if isinstance(prev, dict) and prev.get("state") != "ready":
            attempt = prev.get("attempt")
            return (attempt if isinstance(attempt, int) else 0) + 1
        return 1

    def _write(self, entry: dict) -> bool:
        if not self._enabled:
            return False
        full = {
            "bytes_done": self.done,
            "bytes_total": self.total,
            "attempt": self._attempt,
            **entry,
        }
        if self._started_at is not None:  # 없으면 merge가 이번 시각으로 채운다
            full["started_at"] = self._started_at
        try:
            core.merge_model_readiness(self._conn, self.key, full, self._writer)
            return True
        except Exception:  # noqa: BLE001 — DB 오류가 다운로드를 깨지 않는다
            self._warn()
            return False

    def _warn(self) -> None:
        log.warning(
            "model_readiness write failed for %s — the download continues without a report",
            self.key,
            exc_info=True,
        )


@contextlib.contextmanager
def report_download(conn, key: str, writer: str):
    """`key` 다운로드 하나를 `model_readiness`에 싣는다. 보고자를 내준다(`.progress(n, total)`).

    - 정상 종료: 바이트가 오갔으면 `ready`. 캐시 적중이면 아무것도 안 쓴다(R-9b·R-9c-e).
    - 예외: `failed` + `error`(`<code>: <message>`) + `error_kind`(`errors.classify_download`)를
      쓰고 **다시 던진다.** 허브에 없는 파일을 물은 404는 실패로 적지 않는다.
    - `KeyboardInterrupt`·`SystemExit`는 적지 않는다 — 죽는 중인 프로세스이고, 읽는 쪽이
      5분 넘게 멈춘 `downloading`을 "중단됨"으로 본다.
    """
    report = _Report(conn, key, writer)
    try:
        yield report
    except Exception as exc:
        benign = _is_benign(exc) or (report.benign_if is not None and report.benign_if(exc))
        if not benign:
            report.fail(exc)
        raise
    else:
        report.finish()


# ── 훅 연결 ───────────────────────────────────────────────────────────


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    from ..config import load_settings  # 웹 흐름: `.env`에만 있다

    return load_settings().database_url


def _open_connection():
    return core.connect(_database_url(), **_CONNECT_KWARGS)


class _HookConnection:
    """처음 쓸 때 여는 연결. 실패하면 한동안 다시 열지 않는다(다운로드 스레드를 붙잡지 않게)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._conn = None
        self._retry_at = 0.0

    def execute(self, *args, **kwargs):
        with self._lock:
            if self._conn is None:
                if _clock() < self._retry_at:
                    raise ConnectionError("model_readiness connection is backing off")
                try:
                    self._conn = _open_connection()
                except Exception:
                    self._retry_at = _clock() + _RECONNECT_BACKOFF_SECONDS
                    raise
            try:
                return self._conn.execute(*args, **kwargs)
            except Exception:
                conn, self._conn = self._conn, None
                with contextlib.suppress(Exception):
                    conn.close()
                raise


# ── 설치 ──────────────────────────────────────────────────────────────


class _State:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.writer: str | None = None
        self.originals: dict | None = None
        self.wrappers: dict | None = None
        self.base_tqdm = None
        self.patched: list[tuple[dict, str, object]] = []
        self.conn = _HookConnection()
        self.limits = None
        # 상한을 걸기 **전**의 전역 상태. 테스트의 `_uninstall`이 이 셋을 되돌린다 —
        # `apply_hf_limits`는 프로세스 전역(env·hub 상수·hub 팩토리)을 고치므로, 되돌리지 않으면
        # 한 테스트가 고른 값이 스위트 끝까지 남는다.
        self.client_factory = None
        self.env_before: dict[str, str | None] | None = None
        self.hub_timeouts_before: tuple[int, int] | None = None
        # 0이면 감시가 꺼진다 — `apply_hf_limits`가 아직 안 돌았다는 뜻이고, 그때는 상한도
        # 안 섰으므로 감시만 혼자 도는 것이 오히려 이상하다.
        self.stall_seconds = 0.0


_STATE = _State()


# ── 캐시 우선 적재 (스펙 §6.6-b) ──────────────────────────────────────

_CACHE_FIRST = threading.local()


class _Attempt:
    """한 번의 캐시 우선 시도. 훅이 여기에 캐시 미스를 적어 둔다."""

    __slots__ = ("misses",)

    def __init__(self) -> None:
        self.misses = 0


def _current_attempt() -> _Attempt | None:
    return getattr(_CACHE_FIRST, "attempt", None)


def cache_first_active() -> bool:
    """지금 이 스레드가 캐시 우선 시도 안에 있는가. 로더가 자기 인자로 못 넘길 때의 판정용."""
    return _current_attempt() is not None


@contextlib.contextmanager
def _cache_first_attempt():
    previous = _current_attempt()
    attempt = _Attempt()
    _CACHE_FIRST.attempt = attempt
    try:
        yield attempt
    finally:
        _CACHE_FIRST.attempt = previous


def is_cache_miss(exc: BaseException) -> bool:
    """사슬 어딘가가 "캐시에 없다"인가. 호출자가 hub 예외를 감싸 던지므로 원인까지 본다."""
    for e in errors._chain(exc):
        if any(cls.__name__ in _CACHE_MISS_NAMES for cls in type(e).__mro__):
            return True
    return False


def _last_attempt_was_abandoned(key: str) -> bool:
    """이 key의 직전 시도가 **감시에 버려진 다운로드**였나 (P4-C7).

    판정은 `model_readiness` 한 행이다 — 감시가 끊을 때 `state='failed'`와
    `model_download_failed: …`를 그 자리에 적어 두고, 그것이 프로세스를 건너 사는 유일한 기록이다
    (자식은 job마다 새로 뜨므로 메모리에 남길 수 없다). 코드 접두사로 좁히는 이유는 **다른 이유의
    옛 실패까지 건너뛰면** 오프라인에서 1.1초에 끝날 적재가 매번 네트워크로 내려가기 때문이다
    (§6.6-b가 막는 바로 그것).

    못 읽으면 False다 — 못 읽는 것이 캐시 우선을 포기하는 사유가 되면 안 된다. 훅이 없는
    프로세스(테스트·스크립트)와 `DAMWHA_SHARED_STATE=off`도 같은 길로 떨어진다.
    """
    if _STATE.writer is None:
        return False
    try:
        entry = core.read_model_readiness(_STATE.conn)["entries"].get(key)
    except Exception:  # noqa: BLE001 — 읽기 실패가 적재를 바꾸지 않는다
        log.debug(
            "model_readiness read failed for %s — 캐시 우선을 그대로 쓴다", key, exc_info=True
        )
        return False
    if not isinstance(entry, dict) or entry.get("state") != "failed":
        return False
    return str(entry.get("error") or "").startswith(f"{errors.MODEL_DOWNLOAD_FAILED}:")


def load_cache_first(key: str, load):
    """모델 적재를 **캐시 먼저** 시도한다 (스펙 §6.6-b). `load`는 `local_files_only=`로 불린다.

    로더 다섯이 공유하는 하나의 헬퍼다 — 로더마다 복제하지 않는다. 자기 API로 그 인자를 받는
    로더(sentence-transformers·faster-whisper)는 그대로 넘기고, 못 받는 로더(pyannote·speechbrain·
    mlx)는 무시해도 된다: 이 컨텍스트 동안 훅이 **모든 hub 호출에** `local_files_only=True`를 끼워
    넣는다.

    온라인으로 내려가는 조건은 **캐시 미스 하나뿐이다**(`is_cache_miss`). 그 밖의 예외는 그대로
    올려 보낸다 — 삼켜서 네트워크 재시도로 감추면 오프라인에서 1.1초에 끝날 일이 매번 다운로드가
    되고, 진짜 원인(깨진 캐시·잘못된 리비전)이 영영 안 보인다.

    캐시로 적재에 성공하면 그 key를 `ready`로 적는다 (R-9d, `_mark_ready`).

    **예외 하나: 직전 시도가 감시에 버려진 다운로드면 캐시를 아예 안 물어본다.** 무진행으로
    끊긴 다운로드는 hub 캐시에 `refs/main`과 snapshot 디렉터리를 남기고 가중치만
    `.incomplete`로 남기는데, `local_files_only=True`는 파일 목록을 검사하지 않아 **성공한다**.
    그 뒤 로더가 없는 가중치를 읽다 터지고, 그 예외는 캐시 미스가 아니므로 위 규칙대로 그대로
    올라간다 — 재시도가 전부 같은 자리에서 죽고 네트워크로 영영 안 돌아간다 (P4-C7 실측).
    """
    if _last_attempt_was_abandoned(key):
        log.info("%s: 직전 다운로드가 버려졌다 — 캐시 우선을 건너뛰고 다시 받는다", key)
        return load(local_files_only=False)
    with _cache_first_attempt() as attempt:
        try:
            loaded = load(local_files_only=True)
        except Exception as exc:
            if not (attempt.misses or is_cache_miss(exc)):
                raise
            log.info(
                "%s is not fully cached (%s) — falling back to the network",
                key,
                type(exc).__name__,
            )
        else:
            _mark_ready(key)
            return loaded
    return load(local_files_only=False)


def _mark_ready(key: str) -> None:
    """캐시만으로 적재에 성공한 모델을 `ready`로 적는다 (R-9d).

    Task 9의 훅은 **바이트가 실제로 오간** 다운로드에만 `ready`를 쓴다(R-9b) — 파일 하나의 캐시
    적중은 "그 모델이 멀쩡하다"의 증거가 아니기 때문이다. 그 결과 옛 `failed` 항목이 이제는 캐시로
    잘 뜨는 모델에 그대로 붙어 있고, 화면(Task 11)이 거짓 실패를 보인다. **모델 하나가 통째로
    적재된 이 자리**는 그 증거가 되는 유일한 지점이라 여기서만 적는다.

    바이트 수는 0이다 — 이번 적재가 옮긴 바이트가 정말로 없다 (§6.9는 모르는 구간을 0으로 둔다).
    """
    writer = _STATE.writer
    if writer is None:
        return  # 훅이 없는 프로세스(테스트·스크립트)는 보고할 곳도 없다
    try:
        core.merge_model_readiness(_STATE.conn, key, {"state": "ready"}, writer)
    except Exception:  # noqa: BLE001 — 보고 실패가 적재를 깨지 않는다
        log.warning("model_readiness ready-mark failed for %s", key, exc_info=True)


def _progress_class(report: _Report):
    base = _STATE.base_tqdm

    class _DamwhaProgress(base):
        def __init__(self, *args, **kwargs):
            unit = kwargs.get("unit", "it")
            super().__init__(*args, **kwargs)
            # 꺼진 바(disable=True — 앱의 stderr는 TTY가 아니다)는 tqdm이 unit을 안 채운다
            self.unit = unit

        def update(self, n=1):
            if self.unit == "B" and n:
                report.progress(n, self.total)
            elif n:
                report.touch()  # 바이트가 아닌 진행도 '멈춤 아님'의 증거다
            return super().update(n)

    return _DamwhaProgress


def _known_missing(repo_id: str, args: tuple, kwargs: dict, exc: BaseException) -> bool:
    """오프라인 캐시 미스가 `.no_exist`에 기록된 파일이면 무해하다.

    hub는 네트워크가 없을 때 `.no_exist`를 보지 않고 LocalEntryNotFoundError를 던지고, 선택 파일을
    묻는 호출자는 그것을 삼킨다. 이미 받아 둔 모델을 오프라인에서 적재하는 것을 failed로 적지 않게,
    **없다는 사실이 캐시에 기록된** 파일만 무해로 본다.
    """
    if not any(cls.__name__ == "LocalEntryNotFoundError" for cls in type(exc).__mro__):
        return False
    filename = args[1] if len(args) > 1 else kwargs.get("filename")
    if not isinstance(filename, str):
        return False  # snapshot_download — 스냅샷이 통째로 없다
    if kwargs.get("subfolder"):
        filename = f"{kwargs['subfolder']}/{filename}"
    try:
        from huggingface_hub.file_download import _CACHED_NO_EXIST, try_to_load_from_cache

        found = try_to_load_from_cache(
            repo_id,
            filename,
            cache_dir=kwargs.get("cache_dir"),
            revision=kwargs.get("revision"),
            repo_type=kwargs.get("repo_type"),
        )
    except Exception:  # noqa: BLE001
        return False
    return found is _CACHED_NO_EXIST


def _run_watched(original, args, kwargs, report, key: str):
    """다운로드를 별도 스레드에서 돌리고 무진행을 감시한다 (스펙 §6.9 무진행 규칙, R4-15).

    막힌 호출 자체는 끊을 수 없다 — xet은 GIL을 놓은 채 Rust 안에서 멈추므로 파이썬 예외도
    시그널도 닿지 않는다(2026-09-18 실측: 끊긴 xet 전송이 600초를 예외 없이 멈춰 있었다).
    그래서 **호출자를 풀어 주고 스레드는 버린다.** 버려진 스레드는 daemon이라 인터프리터 종료를
    막지 않고, 세 소비자 모두 이 예외 직후에 프로세스가 끝난다(`--once` 자식은 job을 큐로
    돌려보내고, embed·llm_entry는 적재 실패로 죽어 감독자가 다시 띄운다).

    **이미 끝난 다운로드를 죽이지 않는다.** `wait()`가 False를 돌려준 뒤 판정까지의 사이에 스레드가
    끝날 수 있으므로 `done.is_set()`을 함께 본다 — 그것 없이는 성공한 `box["value"]`를 버리고
    TRANSIENT를 던지는 경합이 남는다.
    """
    limit = _STATE.stall_seconds
    if limit <= 0:
        return original(*args, **kwargs)

    box: dict = {}
    done = threading.Event()

    def _run() -> None:
        try:
            box["value"] = original(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001 — 호출자 스레드에서 그대로 다시 던진다
            box["error"] = exc
        finally:
            done.set()

    threading.Thread(target=_run, name=f"damwha-hf-{key}", daemon=True).start()
    while not done.wait(_WATCHDOG_TICK_SECONDS):
        idle = _clock() - report.last_progress
        if idle >= limit and not done.is_set():
            report.abandon()
            raise errors.WorkerError(
                errors.MODEL_DOWNLOAD_FAILED,
                f"download of {key!r} made no progress for {int(idle)}s — ending it so the job "
                "returns to the queue",
                errors.ErrorKind.TRANSIENT,
            )
    if "error" in box:
        raise box["error"]
    return box["value"]


def _needed_bytes(repo_id: str) -> int | None:
    """저장소 전체 크기 × 여유 계수. 못 얻으면 None — 추정으로 막지 않는다."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo_id, files_metadata=True)
        total = sum(s.size for s in (info.siblings or []) if s.size is not None)
    except Exception:  # noqa: BLE001 — 크기를 모르는 것은 실패가 아니다
        return None
    if total <= 0:
        return None
    # 1.2배: 받는 동안 .incomplete 파일과 최종 파일이 잠깐 함께 있는다.
    return int(total * 1.2)


def _wrap(original):
    @functools.wraps(original)
    def hooked(*args, **kwargs):
        # 캐시 우선 시도 안이면 모든 호출을 오프라인으로 돌린다 (스펙 §6.6-b). 폴백은 로더 자리의
        # `load_cache_first`가 한 번만 한다 — 호출마다 따로 내려가면 bge-m3가 오프라인에서
        # 죽는 hub 버그(닫힌 클라이언트 재사용)를 그대로 만난다.
        attempt = _current_attempt()
        if attempt is not None:
            try:
                return original(*args, **{**kwargs, "local_files_only": True})
            except Exception as exc:
                if is_cache_miss(exc):
                    attempt.misses += 1
                raise

        # (attempt 블록 뒤, `writer = _STATE.writer` 앞)
        #
        # **여기가 맞는 자리다**: 아래 우회 분기(tqdm_class·writer None·repo_id 비문자열)가
        # _run_watched를 건너뛰므로 거기 두면 다운로드의 일부만 덮는다. 진행 보고와 달리
        # 디스크는 모든 경로가 똑같이 쓴다.
        #
        # local_files_only·dry_run은 받지 않으므로 건너뛴다.
        _repo = args[0] if args else kwargs.get("repo_id")
        _skip_check = kwargs.get("local_files_only") or kwargs.get("dry_run")
        if isinstance(_repo, str) and not _skip_check:
            from huggingface_hub import constants as hub_constants

            from .disk import check_free_space

            check_free_space(hub_constants.HF_HUB_CACHE, _needed_bytes(_repo))

        writer = _STATE.writer
        repo_id = args[0] if args else kwargs.get("repo_id")
        if (
            writer is None
            or kwargs.get("tqdm_class") is not None
            or kwargs.get("local_files_only")
            or kwargs.get("dry_run")
            or not isinstance(repo_id, str)
        ):
            return original(*args, **kwargs)
        with report_download(_STATE.conn, repo_id, writer) as report:
            report.benign_if = functools.partial(_known_missing, repo_id, args, kwargs)
            # transformers는 tqdm_class=None을 명시해 넘긴다 — 덮어써야 중복 키가 안 된다
            return _run_watched(
                original,
                args,
                {**kwargs, "tqdm_class": _progress_class(report)},
                report,
                repo_id,
            )

    hooked.__damwha_original__ = original
    return hooked


def _namespace(mod) -> dict | None:
    if mod is None:
        return None
    try:
        ns = vars(mod)  # __getattr__를 부르지 않는다 — getattr 금지 (모듈 docstring)
    except Exception:  # noqa: BLE001 — __dict__ 없는 이상한 sys.modules 항목
        return None
    return ns if isinstance(ns, dict) else None


def _bind(ns: dict, name: str, value) -> None:
    if not any(p_ns is ns and p_name == name for p_ns, p_name, _ in _STATE.patched):
        _STATE.patched.append((ns, name, ns.get(name, _MISSING)))
    ns[name] = value


def apply_hf_limits(limits=None) -> None:
    """모든 HF 요청에 유한한 상한을 준다 (스펙 §6.6-b). **던지지 않는다.**

    값의 단일 진실 원천은 `config.py`다 — 앱이 env로 따로 주지 않으므로 웹 흐름(`pnpm worker`)과
    앱이 같은 값으로 돈다. 이미 **명시된 env는 덮지 않는다**: 운영자가 `.env`나 셸에서 정한 값이
    있으면 그쪽이 이긴다.

    네 층에 각각 준다.
    - `HF_HUB_ETAG_TIMEOUT` — 메타데이터 HEAD. 라이브러리 기본값과 다른 값이어야 hub가
      호출자의 `etag_timeout`까지 이 값으로 덮는다 (`file_download.py:959-961`).
    - `HF_HUB_DOWNLOAD_TIMEOUT` — 스트리밍 중 바이트 사이 간격.
    - **공유 httpx 클라이언트** — `timeout=None`이 기본이라 `repo_info`처럼 per-call 방어가 없는
      호출이 영원히 멈춘다. `set_client_factory`는 hub의 공개 API다. 클라이언트 기본값만으로는
      부족하다: `HfApi.model_info`가 `timeout=None`을 **명시해** 넘겨(`hf_api.py:3311`) 그 기본값을
      끈다. 그래서 팩토리가 내주는 클라이언트는 명시된 `None`을 우리 값으로 되돌린다
      (`_BoundedClient`). 2026-09-18 실측: 이것 없이는 먹통 엔드포인트에서 `snapshot_download`가
      300초를 넘겨도 끝나지 않는다.
    - xet 셋 — Rust 쪽은 자기 프로세스의 env만 읽는다. 다만 2026-09-18 실측에서 hf_xet가 끊긴
      전송에 자기 기본값조차 지키지 않았으므로 **이 셋은 보증이 아니다** — 보증은 무진행 감시다.

    호출 시점이 계약이다: `huggingface_hub.constants`는 **import 시점에** env를 읽으므로 무거운
    import 전에 불러야 한다. 이미 import된 뒤라도 상수 둘은 직접 갈아 끼운다(hub가 호출 시점에
    모듈 속성으로 읽는다).
    """
    try:
        from ..config import hf_limits

        limits = limits or hf_limits()
        _STATE.limits = limits
        _STATE.stall_seconds = float(limits.stall_seconds)
        values = (
            limits.etag_timeout,
            limits.download_timeout,
            limits.connect_timeout,
            limits.request_timeout,
            limits.retry_max_duration,
        )
        if _STATE.env_before is None:
            _STATE.env_before = {n: os.environ.get(n) for n in HF_LIMIT_ENV_KEYS}
        for name, value in zip(HF_LIMIT_ENV_KEYS, values, strict=True):
            os.environ.setdefault(name, str(int(value)))
        _apply_hub_limits(limits)
    except Exception:  # noqa: BLE001 — 상한을 못 걸어도 프로세스는 뜬다 (감시가 남는다)
        log.warning("hf limits not applied — requests keep the library defaults", exc_info=True)


def _apply_hub_limits(limits) -> None:
    try:
        import httpx
        from huggingface_hub import constants as hub_constants
        from huggingface_hub.utils import _http as hub_http
        from huggingface_hub.utils import set_client_factory
    except ImportError:
        return  # models extra 없음 — env만으로 충분하다

    if _STATE.hub_timeouts_before is None:
        _STATE.hub_timeouts_before = (
            hub_constants.HF_HUB_ETAG_TIMEOUT,
            hub_constants.HF_HUB_DOWNLOAD_TIMEOUT,
        )
    hub_constants.HF_HUB_ETAG_TIMEOUT = int(os.environ["HF_HUB_ETAG_TIMEOUT"])
    hub_constants.HF_HUB_DOWNLOAD_TIMEOUT = int(os.environ["HF_HUB_DOWNLOAD_TIMEOUT"])

    if _STATE.client_factory is None:
        _STATE.client_factory = hub_http._GLOBAL_CLIENT_FACTORY
    timeout = httpx.Timeout(float(limits.request_timeout), connect=float(limits.connect_timeout))

    class _BoundedClient(httpx.Client):
        """명시된 `timeout=None`을 유한한 값으로 되돌린다.

        httpx에서 `timeout=None`은 "상한 없음"이지 "클라이언트 기본값"이 아니다. hub의
        `model_info`·`dataset_info`·`space_info`가 그 값을 그대로 넘기므로, 클라이언트 기본값만
        고쳐서는 `snapshot_download`의 `repo_info`가 여전히 무한히 기다린다.
        """

        def build_request(self, *args, **kwargs):
            if "timeout" in kwargs and kwargs["timeout"] is None:
                kwargs["timeout"] = timeout
            return super().build_request(*args, **kwargs)

    def _factory():
        # 기본 팩토리에서 훅·리다이렉트 설정을 그대로 가져온다 — 요청 id 이벤트 훅을 여기에
        # 다시 적으면 hub가 그것을 바꿀 때 조용히 갈린다.
        base = hub_http.default_client_factory()
        try:
            return _BoundedClient(
                event_hooks=base.event_hooks,
                follow_redirects=base.follow_redirects,
                timeout=timeout,
            )
        finally:
            base.close()

    set_client_factory(_factory)


def install_hf_progress_hook(writer: str) -> None:
    """이 프로세스의 HF 다운로드를 `writer` 이름으로 보고한다. 무거운 import **전에** 부른다.

    멱등이다(세 진입점이 각자 부른다). **어떤 이유로도 던지지 않는다** (R-9c-b): huggingface_hub가
    없거나(models extra 없음), 그 내부 구조가 바뀌어 붙일 자리가 사라져도 경고만 남기고 **원본을
    되돌린 채** 돌아온다. 진행 보고는 편의 기능이지 기동 조건이 아니다 — 여기서 던지면 job을 집기도
    전의 `--once` 자식과 gate 서비스인 embed가 죽는다. 그래서 호출부에는 try가 없다.
    """
    with _STATE.lock:
        # 상한을 먼저 건다 — 아래 `_install`이 `huggingface_hub`를 import하고, 그 모듈의
        # `constants`는 import 시점에 env를 읽는다.
        apply_hf_limits()
        fresh = _STATE.originals is None
        mark = len(_STATE.patched)
        try:
            _install(writer)
        except Exception:  # noqa: BLE001 — 보고 기능의 실패가 프로세스를 죽이지 않는다
            _restore(mark)
            if fresh:
                _forget()
            log.warning(
                "download progress hook not installed — downloads still work, "
                "but model_readiness will not show their progress",
                exc_info=True,
            )


def _install(writer: str) -> None:
    try:
        import huggingface_hub
        from huggingface_hub import _snapshot_download, file_download
        from huggingface_hub.utils import tqdm as hub_tqdm
    except ImportError:
        log.info("huggingface_hub is not installed — no download progress hook")
        return

    _STATE.writer = writer
    if _STATE.originals is None:
        originals = {
            "hf_hub_download": file_download.hf_hub_download,
            "snapshot_download": _snapshot_download.snapshot_download,
        }
        originals = {n: getattr(f, "__damwha_original__", f) for n, f in originals.items()}
        _STATE.originals = originals
        _STATE.wrappers = {n: _wrap(f) for n, f in originals.items()}
        _STATE.base_tqdm = hub_tqdm
    originals, wrappers = _STATE.originals, _STATE.wrappers

    # 갈래 1 — 원본 자리. 이후에 import되는 소비자는 여기서 묶는다.
    _bind(vars(file_download), "hf_hub_download", wrappers["hf_hub_download"])
    _bind(vars(_snapshot_download), "snapshot_download", wrappers["snapshot_download"])
    for name in _NAMES:
        _bind(vars(huggingface_hub), name, wrappers[name])

    # 갈래 2 — 이미 import된 소비자. 원본과 같은 객체를 묶은 이름만 바꾼다.
    rebound = 0
    for mod in list(sys.modules.values()):
        ns = _namespace(mod)
        if ns is None:
            continue
        for name in _NAMES:
            if ns.get(name) is originals[name]:
                _bind(ns, name, wrappers[name])
                rebound += 1
    log.info("hf download progress hook installed (writer=%s, rebound=%d)", writer, rebound)


def _restore(mark: int = 0) -> None:
    """`_STATE.patched[mark:]`가 바꾼 이름을 역순으로 되돌린다."""
    while len(_STATE.patched) > mark:
        ns, name, previous = _STATE.patched.pop()
        if previous is _MISSING:
            ns.pop(name, None)
        else:
            ns[name] = previous


def _forget() -> None:
    _STATE.writer = None
    _STATE.originals = None
    _STATE.wrappers = None
    _STATE.base_tqdm = None
    _STATE.conn = _HookConnection()


def _restore_limits() -> None:
    """`apply_hf_limits`가 고친 **전역 상태**를 되돌린다 — env 다섯, hub 상수 둘, hub 팩토리."""
    if _STATE.env_before is not None:
        for name, previous in _STATE.env_before.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous
        _STATE.env_before = None
    if _STATE.hub_timeouts_before is not None:
        with contextlib.suppress(Exception):
            from huggingface_hub import constants as hub_constants

            etag, download = _STATE.hub_timeouts_before
            hub_constants.HF_HUB_ETAG_TIMEOUT = etag
            hub_constants.HF_HUB_DOWNLOAD_TIMEOUT = download
        _STATE.hub_timeouts_before = None
    if _STATE.client_factory is not None:
        with contextlib.suppress(Exception):
            from huggingface_hub.utils import set_client_factory

            set_client_factory(_STATE.client_factory)
        _STATE.client_factory = None
    _STATE.limits = None
    _STATE.stall_seconds = 0.0


def _uninstall() -> None:
    """테스트 전용 — 설치가 바꾼 **모든 전역 상태**를 원래 값으로 되돌린다.

    이름 바인딩(`_restore`)만으로는 모자란다. `apply_hf_limits`가 env 다섯 개와 hub의 타임아웃
    상수 둘, hub의 클라이언트 팩토리까지 고치므로 그것도 함께 되돌린다 — 안 그러면 한 테스트가
    고른 값이 스위트의 나머지 전체에 남는다.
    """
    with _STATE.lock:
        _restore()
        _restore_limits()
        _forget()
