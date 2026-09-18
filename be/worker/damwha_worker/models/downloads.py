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
        self.benign_if = None  # 호출별 추가 판정 (감싼 함수가 채운다)

    @property
    def transferred(self) -> bool:
        return self._started_at is not None

    def progress(self, n: int, total: int | None = None) -> None:
        """바이트 `n`이 더 왔다(음수면 되감기). 첫 바이트는 즉시, 이후는 초당 1회 이하로 쓴다."""
        with self._lock:
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
            w = errors.download_error(exc)
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


_STATE = _State()


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


def _wrap(original):
    @functools.wraps(original)
    def hooked(*args, **kwargs):
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
            return original(*args, **{**kwargs, "tqdm_class": _progress_class(report)})

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


def install_hf_progress_hook(writer: str) -> None:
    """이 프로세스의 HF 다운로드를 `writer` 이름으로 보고한다. 무거운 import **전에** 부른다.

    멱등이다(세 진입점이 각자 부른다). **어떤 이유로도 던지지 않는다** (R-9c-b): huggingface_hub가
    없거나(models extra 없음), 그 내부 구조가 바뀌어 붙일 자리가 사라져도 경고만 남기고 **원본을
    되돌린 채** 돌아온다. 진행 보고는 편의 기능이지 기동 조건이 아니다 — 여기서 던지면 job을 집기도
    전의 `--once` 자식과 gate 서비스인 embed가 죽는다. 그래서 호출부에는 try가 없다.
    """
    with _STATE.lock:
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


def _uninstall() -> None:
    """테스트 전용 — 설치가 바꾼 모든 이름을 원래 값으로 되돌린다."""
    with _STATE.lock:
        _restore()
        _forget()
