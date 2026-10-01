# 화자 분리 모델 번들 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pyannote/speaker-diarization-community-1`을 Electron 앱 `Resources/models/`에 싣고 worker가 토큰 없이 그 폴더에서 적재하게 한 뒤, desktop·fe의 HF 토큰 기능을 전부 걷어낸다.

**Architecture:** desktop이 `DIARIZATION_MODEL_DIR`(번들 폴더 절대 경로)·`PYANNOTE_METRICS_ENABLED=false`를 python 자식 env로 싣는다(`FFMPEG_BIN`과 같은 방식). worker는 payload의 모델 id가 `DIARIZATION_MODEL`이고 그 폴더가 완전하면 `Pipeline.from_pretrained(<폴더>)`로 적재하고, inventory·다운로드 job도 같은 판정 함수(`bundle.bundle_complete`)로 번들을 "받음"으로 다룬다. 토큰 UI·게이트·Keychain 저장은 삭제한다.

**Tech Stack:** Python 3.12 + pyannote.audio 4.0.5 + pytest (worker), Electron/TypeScript + vitest (desktop), React 19 + vitest (fe), bash (빌드 스크립트).

**Spec:** `docs/superpowers/specs/2026-09-30-bundle-diarization-model-design.md`

## Global Constraints

- 모델 저장소 `pyannote/speaker-diarization-community-1`, 리비전 `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`, 라이선스 CC-BY-4.0.
- 번들 폴더 이름 `pyannote-speaker-diarization-community-1`, 위치 dev `desktop/build/models/<이름>`, packaged `Contents/Resources/models/<이름>`.
- 필수 파일 다섯: `config.yaml`, `segmentation/pytorch_model.bin`, `embedding/pytorch_model.bin`, `plda/plda.npz`, `plda/xvec_transform.npz` — 원천은 `be/worker/damwha_worker/models/specs.py`의 `_fixed_specs()` diarization `required`.
- env 이름: `DIARIZATION_MODEL_DIR`, `PYANNOTE_METRICS_ENABLED`(값 `"false"`).
- 새 오류 코드 `diarization_bundle_missing`(PERMANENT).
- worker 부모(inventory 스레드)가 import하는 모듈은 표준 라이브러리만 쓴다 — `models/bundle.py`도 그렇다.
- `npm install` 금지, 패키지를 저장소 루트에서 띄우지 않는다. 루트 명령: `pnpm worker:test`, `pnpm --filter damwha-desktop test`, `pnpm fe test`, `pnpm lint`.
- 과거 기록(옛 스펙·`docs/electron-migration-roadmap.md`)은 고치지 않는다.
- worker venv로 모델 라이브러리(`huggingface_hub`·`pyannote.audio`)를 쓰는 명령은 **반드시** `uv run --directory be/worker --extra models …`다 — extra 없이 `uv run`하면 venv가 extra 없는 모양으로 다시 동기화된다(`be/worker/pyproject.toml`의 `models` extra).
- 셸의 `grep`·`find`·`diff`는 ugrep 함수다 — 측정·검증 명령에는 `/usr/bin/grep` 등 절대 경로를 쓴다.
- 커밋 메시지는 저장소 관례(`feat(worker): …`, 한국어 본문)를 따른다.

## Review Focus

1. **업그레이드 전에 대기열에 선 화자 분리 `download_model` job** — 번들이 있으면 네트워크를 부르지 않고 `done`이 돼야 한다. → Task 3 `test_download_diarization_is_noop_when_bundle_complete`.
2. **HF 캐시에 옛 사본이 있고 번들도 있음** — 모델 카드는 번들 기준으로 "받음". 번들이 깨졌으면 캐시 결과로 되돌아간다. → Task 4 두 테스트.
3. **번들 파일 하나가 빠진 앱**(부분 복사·손상) — 재시도 5회를 태우지 않고 즉시 PERMANENT `diarization_bundle_missing`. → Task 2 `test_bundle_missing_file_is_permanent_error`.
4. **개발자 셸에 `HF_TOKEN`이 있는 채 `pnpm desktop:dev`** — 자식 env에 토큰이 없어야 한다(번들이 없을 때 hub 폴백이 조용히 성공하지 않게). → Task 6 `drops an inherited HF_TOKEN from every python child`.
5. **예전 실패 코드(`hf_token_invalid`·`hf_gate_not_accepted`)를 가진 회의** — 토큰 안내 대신 일반 실패 문구, 크래시 없음. → Task 10 meeting 테스트.

---

### Task 1: worker — 번들 판정 모듈과 설정·오류 코드

**Files:**
- Create: `be/worker/damwha_worker/models/bundle.py`
- Modify: `be/worker/damwha_worker/config.py` (Settings에 필드 추가, `hf_token` 아래)
- Modify: `be/worker/damwha_worker/errors.py:62-65` (상수 추가)
- Test: `be/worker/tests/test_bundle.py`

**Interfaces:**
- Produces:
  - `bundle.diarization_required() -> tuple[str, ...]` — specs의 diarization `required`
  - `bundle.bundle_complete(bundle_dir: str | None) -> bool`
  - `bundle.bundle_size(bundle_dir: str) -> int` — 필수 파일 크기 합
  - `errors.DIARIZATION_BUNDLE_MISSING = "diarization_bundle_missing"`
  - `Settings.diarization_model_dir: str | None = None`

- [ ] **Step 1: 실패하는 테스트**

```python
# be/worker/tests/test_bundle.py
"""번들 판정 (스펙 2026-09-30 §3.1). 표준 라이브러리만 쓰는 모듈이라 모델 extra 없이 돈다."""

import os

from damwha_worker.config import Settings
from damwha_worker.models import bundle, specs

FILES = (
    "config.yaml",
    "segmentation/pytorch_model.bin",
    "embedding/pytorch_model.bin",
    "plda/plda.npz",
    "plda/xvec_transform.npz",
)


def make_bundle(root, *, skip=()):
    for rel in FILES:
        if rel in skip:
            continue
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * 3)
    return root


def test_required_matches_spec_table():
    spec = next(s for s in specs.all_specs() if s.repo_id == specs.DIARIZATION_MODEL)
    assert bundle.diarization_required() == spec.required == FILES


def test_complete_bundle(tmp_path):
    assert bundle.bundle_complete(str(make_bundle(tmp_path))) is True
    assert bundle.bundle_size(str(tmp_path)) == 15


def test_none_or_missing_dir_is_incomplete(tmp_path):
    assert bundle.bundle_complete(None) is False
    assert bundle.bundle_complete("") is False
    assert bundle.bundle_complete(str(tmp_path / "nope")) is False


def test_one_missing_file_is_incomplete(tmp_path):
    make_bundle(tmp_path, skip=("plda/plda.npz",))
    assert bundle.bundle_complete(str(tmp_path)) is False


def test_directory_in_place_of_file_is_incomplete(tmp_path):
    make_bundle(tmp_path, skip=("config.yaml",))
    (tmp_path / "config.yaml").mkdir()
    assert bundle.bundle_complete(str(tmp_path)) is False


def test_settings_reads_env(monkeypatch):
    monkeypatch.setenv("DIARIZATION_MODEL_DIR", "/x/models/p")
    monkeypatch.setenv("DATABASE_URL", "postgres://x")
    monkeypatch.setenv("LENS_LLM_BASE_URL", "http://127.0.0.1:1")
    assert Settings(_env_file=None).diarization_model_dir == "/x/models/p"


def test_error_code_value():
    from damwha_worker import errors

    assert errors.DIARIZATION_BUNDLE_MISSING == "diarization_bundle_missing"
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm worker:test -- tests/test_bundle.py -q`
Expected: FAIL — `ImportError: cannot import name 'bundle'`

- [ ] **Step 3: 구현**

```python
# be/worker/damwha_worker/models/bundle.py
"""앱에 실린 화자 분리 모델 폴더 판정 (스펙 2026-09-30 §3.1·§3.2·§3.3).

desktop이 `DIARIZATION_MODEL_DIR`로 `Resources/models/pyannote-speaker-diarization-community-1`을
알려 준다. 적재(`pyannote_diar`)·inventory·다운로드 job이 **이 한 함수**로 "번들이 쓸 만한가"를 가른다 —
셋이 따로 판정하면 카드는 "받음"인데 적재는 실패하는 식으로 갈린다.

worker 부모(inventory 스레드)가 import한다 — 표준 라이브러리만 쓴다(`specs`도 그렇다).
실행 시 해시는 재지 않는다. 무결성은 빌드(`build-models.sh`)·`check-bundle`·`.app` 서명 봉인이 맡는다(§4.5).
"""

from __future__ import annotations

import os

from . import specs


def diarization_required() -> tuple[str, ...]:
    spec = next(s for s in specs.all_specs() if s.repo_id == specs.DIARIZATION_MODEL)
    return spec.required


def bundle_complete(bundle_dir: str | None) -> bool:
    if not bundle_dir:
        return False
    return all(os.path.isfile(os.path.join(bundle_dir, rel)) for rel in diarization_required())


def bundle_size(bundle_dir: str) -> int:
    return sum(os.path.getsize(os.path.join(bundle_dir, rel)) for rel in diarization_required())
```

`config.py` — `hf_token` 줄 바로 아래:

```python
    hf_token: str | None = None
    # 앱에 실린 화자 분리 모델 폴더 (스펙 2026-09-30 §3.1). desktop이 싣는다 — 없으면(터미널
    # `pnpm worker`) 지금처럼 hub에서 HF_TOKEN으로 받는다.
    diarization_model_dir: str | None = None
```

`errors.py` — `MODEL_DOWNLOAD_FAILED` 줄 아래:

```python
# 앱에 실린 화자 분리 모델 폴더가 불완전하다 (스펙 2026-09-30 §3.1). 설치가 깨진 것이라 재시도로 안 풀린다.
DIARIZATION_BUNDLE_MISSING = "diarization_bundle_missing"
```

`specs.all_specs()`가 diarization을 포함하는지 확인: `/usr/bin/grep -n "def all_specs" -A8 be/worker/damwha_worker/models/specs.py`. 포함하지 않으면 `diarization_required()`에서 `specs._fixed_specs()`를 쓴다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm worker:test -- tests/test_bundle.py -q`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add be/worker/damwha_worker/models/bundle.py be/worker/damwha_worker/config.py be/worker/damwha_worker/errors.py be/worker/tests/test_bundle.py
git commit -m "feat(worker): 번들 화자 분리 모델 판정 모듈과 DIARIZATION_MODEL_DIR 설정"
```

---

### Task 2: worker — 번들 폴더에서 토큰 없이 적재

**Files:**
- Modify: `be/worker/damwha_worker/models/pyannote_diar.py` (`__init__` 시그니처·본문, docstring)
- Modify: `be/worker/damwha_worker/models/registry.py:36` (인자 추가), 모듈 docstring의 "Settings provide only infra: the HF token."
- Modify: `be/worker/damwha_worker/models/downloads.py` (`mark_ready` 공개 별칭)
- Modify: `be/worker/.env.example`
- Test: `be/worker/tests/test_pyannote_diar.py`, `be/worker/tests/test_offline_load.py`

**Interfaces:**
- Consumes: `bundle.bundle_complete`, `errors.DIARIZATION_BUNDLE_MISSING`, `Settings.diarization_model_dir` (Task 1)
- Produces: `PyannoteDiarizer(model: str, hf_token: str | None, device: str, *, bundle_dir: str | None = None)`; `downloads.mark_ready(key: str) -> None`

- [ ] **Step 1: 실패하는 테스트** — `tests/test_pyannote_diar.py` 끝에 추가

```python
# ── 번들 경로 (스펙 2026-09-30 §3.1) ─────────────────────────────────


def _fake_pyannote(monkeypatch, calls):
    import sys
    import types

    class Pipeline:
        @staticmethod
        def from_pretrained(checkpoint, token=None):
            from damwha_worker.models import downloads

            calls.append((checkpoint, token, downloads.cache_first_active()))
            return types.SimpleNamespace(to=lambda device: "pipeline")

    audio = types.ModuleType("pyannote.audio")
    audio.Pipeline = Pipeline
    pkg = types.ModuleType("pyannote")
    pkg.__path__ = []
    pkg.audio = audio
    torch = types.ModuleType("torch")
    torch.device = lambda name: name
    monkeypatch.setitem(sys.modules, "pyannote", pkg)
    monkeypatch.setitem(sys.modules, "pyannote.audio", audio)
    monkeypatch.setitem(sys.modules, "torch", torch)


def test_bundle_dir_loads_local_folder_without_token_or_hub(monkeypatch, tmp_path):
    from tests.test_bundle import make_bundle

    calls, marked = [], []
    _fake_pyannote(monkeypatch, calls)
    monkeypatch.setattr("damwha_worker.models.downloads.mark_ready", marked.append)
    make_bundle(tmp_path)

    PyannoteDiarizer(MODEL, "hf_shell_token", "cpu", bundle_dir=str(tmp_path))

    assert calls == [(str(tmp_path), None, False)]  # 폴더 경로, 토큰 없음, 캐시 우선 컨텍스트 밖
    assert marked == [MODEL]


def test_bundle_missing_file_is_permanent_error(monkeypatch, tmp_path):
    from damwha_worker.errors import DIARIZATION_BUNDLE_MISSING, ErrorKind, WorkerError, classify
    from tests.test_bundle import make_bundle

    calls = []
    _fake_pyannote(monkeypatch, calls)
    make_bundle(tmp_path, skip=("embedding/pytorch_model.bin",))

    try:
        PyannoteDiarizer(MODEL, None, "cpu", bundle_dir=str(tmp_path))
    except WorkerError as e:
        assert (e.code, e.kind) == (DIARIZATION_BUNDLE_MISSING, ErrorKind.PERMANENT)
        assert str(tmp_path) in e.message
        assert classify(e) is e
    else:
        raise AssertionError("expected WorkerError")
    assert calls == []  # 적재를 시도하지 않는다


def test_other_model_id_ignores_bundle_dir(monkeypatch, tmp_path):
    from tests.test_bundle import make_bundle

    calls = []
    _fake_pyannote(monkeypatch, calls)
    make_bundle(tmp_path)

    PyannoteDiarizer("someone/other-diarization", "t", "cpu", bundle_dir=str(tmp_path))

    assert calls[0][:2] == ("someone/other-diarization", "t")
    assert calls[0][2] is True  # 기존 캐시 우선 경로


def test_metrics_env_disables_pyannote_telemetry(monkeypatch):
    import pytest

    metrics = pytest.importorskip("pyannote.audio.telemetry.metrics")
    monkeypatch.setenv("PYANNOTE_METRICS_ENABLED", "false")
    assert metrics.is_metrics_enabled() is False
```

`tests/test_offline_load.py`의 기존 두 pyannote 테스트는 `bundle_dir` 없이 부르므로 그대로 통과해야 한다(기존 경로 보존의 회귀 방지).

- [ ] **Step 2: 실패 확인**

Run: `pnpm worker:test -- tests/test_pyannote_diar.py -q`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'bundle_dir'` (텔레메트리 테스트는 모델 extra 없는 venv면 SKIP)

- [ ] **Step 3: 구현**

`downloads.py` — `_mark_ready` 정의 바로 아래:

```python
def mark_ready(key: str) -> None:
    """캐시 밖에서 통째로 적재한 모델(앱 번들)도 `ready`로 적는다 (스펙 2026-09-30 §3.1)."""
    _mark_ready(key)
```

`pyannote_diar.py` — 모듈 docstring 교체:

```python
"""pyannote.audio 4.x diarization adapter.

Implements the `Diarizer` protocol. pyannote/speaker-diarization-community-1 is gated on the hub.
The desktop app ships it in `Resources/models/` and points `DIARIZATION_MODEL_DIR` at it
(스펙 2026-09-30 §3.1) — that path needs no token and makes no hub call. Without it (terminal
`pnpm worker`) the model comes from the hub with `HF_TOKEN`, as before.
"""
```

`__init__` 교체 (import 줄 포함):

```python
from .. import errors
from . import bundle
from .base import DiarSegment
from .specs import DIARIZATION_MODEL
```

```python
class PyannoteDiarizer:
    def __init__(
        self, model: str, hf_token: str | None, device: str, *, bundle_dir: str | None = None
    ) -> None:
        import torch
        from pyannote.audio import Pipeline

        from . import downloads

        if bundle_dir and model == DIARIZATION_MODEL:
            # 앱 번들 (스펙 2026-09-30 §3.1). pyannote 4.x는 폴더 checkpoint면 hub를 부르지 않는다
            # (core/pipeline.py·model.py·plda.py의 isdir 분기) — 토큰도 캐시 우선 컨텍스트도 필요 없다.
            if not bundle.bundle_complete(bundle_dir):
                raise errors.WorkerError(
                    errors.DIARIZATION_BUNDLE_MISSING,
                    f"the bundled diarization model at {bundle_dir!r} is incomplete — reinstall the app",
                    errors.ErrorKind.PERMANENT,
                )
            pipeline = Pipeline.from_pretrained(bundle_dir)
            downloads.mark_ready(model)
        else:
            # pyannote.audio 4.x renamed the auth param: use_auth_token → token
            # 캐시 우선 (스펙 §6.6-b). `from_pretrained`에도 `local_files_only`가 없다 — 훅이 hub
            # 호출에 끼워 넣는다. 게이트 체인의 하위 모델까지 같은 컨텍스트 안에서 적재되므로
            # 한 번의 시도로 3-모델 체인 전체가 오프라인이 된다.
            try:
                pipeline = downloads.load_cache_first(
                    model, lambda **_: Pipeline.from_pretrained(model, token=hf_token)
                )
            except Exception as exc:
                _raise_auth_failure(model, exc)
                raise
        if pipeline is None:
            # from_pretrained returns None when the license isn't accepted / token is bad
            raise RuntimeError(
                f"failed to load gated diarization model {model!r} — "
                "check HF_TOKEN and that the model license is accepted on HuggingFace"
            )
        # device는 registry의 torch_device()가 이미 검증한 'mps'|'cpu' — 폴백 없음 (spec §6)
        self._pipeline = pipeline.to(torch.device(device))
```

(기존의 `from .downloads import load_cache_first`는 `from . import downloads`로 바뀐다. `test_offline_load.py`가 `downloads.load_cache_first`를 monkeypatch하지 않는지 확인: `/usr/bin/grep -n "load_cache_first" be/worker/tests/test_offline_load.py`. 모듈 속성 접근이라 patch해도 동작한다.)

`registry.py:36`:

```python
        diarizer=PyannoteDiarizer(
            m.diarization.model, settings.hf_token, diar_device,
            bundle_dir=settings.diarization_model_dir,
        ),
```

docstring 마지막 문장: `Settings provide only infra: the HF token.` → `Settings provide only infra: the bundled diarization folder and, off-app, the HF token.`

`be/worker/.env.example`의 `HF_TOKEN=` 줄 위아래에:

```
# 앱 밖에서 worker를 돌릴 때만 필요하다 — 화자 분리 모델(게이트)을 hub에서 받는다.
# 앱은 모델을 번들로 싣고 DIARIZATION_MODEL_DIR로 알려 주므로 토큰을 쓰지 않는다.
HF_TOKEN=
# DIARIZATION_MODEL_DIR=/path/to/desktop/build/models/pyannote-speaker-diarization-community-1
# pyannote.audio의 사용 통계 전송(otel.pyannote.ai)을 끈다. 앱은 항상 false로 싣는다.
PYANNOTE_METRICS_ENABLED=false
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm worker:test -- tests/test_pyannote_diar.py tests/test_offline_load.py -q`
Expected: 모두 PASS (텔레메트리 테스트는 extra 없으면 SKIP)

- [ ] **Step 5: Commit**

```bash
git add be/worker/damwha_worker/models/pyannote_diar.py be/worker/damwha_worker/models/registry.py be/worker/damwha_worker/models/downloads.py be/worker/.env.example be/worker/tests/test_pyannote_diar.py
git commit -m "feat(worker): 앱 번들 폴더에서 화자 분리 모델을 토큰 없이 적재"
```

---

### Task 3: worker — 번들이 있으면 화자 분리 다운로드 job은 받지 않고 끝낸다

**Files:**
- Modify: `be/worker/damwha_worker/pipeline/model_jobs.py` (`run_download_model`)
- Modify: `be/worker/damwha_worker/jobs.py:75-76` (ctx 필드), `:370-372` (handler 인자)
- Modify: `be/worker/damwha_worker/dispatch.py:191` (ctx 생성)
- Test: `be/worker/tests/test_model_jobs.py`

**Interfaces:**
- Consumes: `bundle.bundle_complete`, `downloads.mark_ready` (Task 1·2)
- Produces: `run_download_model(conn, job, payload, *, worker_id, hf_token, diarization_model_dir=None, snapshot=None) -> str`; `JobContext.diarization_model_dir: str | None = None`

- [ ] **Step 1: 실패하는 테스트** — `tests/test_model_jobs.py`의 `test_download_without_spec_uses_name_as_repo` 뒤에

```python
_DIAR = {"schema_version": 1, "role": "diarization",
         "name": "pyannote/speaker-diarization-community-1"}


def test_download_diarization_is_noop_when_bundle_complete(conn, tmp_path, monkeypatch):
    from tests.test_bundle import make_bundle

    marked = []
    monkeypatch.setattr(downloads, "mark_ready", marked.append)
    job = _running(conn, "download_model", _DIAR)
    out = model_jobs.run_download_model(
        conn, job, _p(role="diarization", name=_DIAR["name"]), worker_id=W, hf_token=None,
        diarization_model_dir=str(make_bundle(tmp_path)),
        snapshot=lambda **kw: (_ for _ in ()).throw(AssertionError("must not download")),
    )
    assert out == "committed"
    assert _status(conn, job["id"])["status"] == "done"
    assert marked == [_DIAR["name"]]


def test_download_diarization_goes_to_hub_when_bundle_incomplete(conn, tmp_path):
    from tests.test_bundle import make_bundle

    calls = []
    job = _running(conn, "download_model", _DIAR)
    model_jobs.run_download_model(
        conn, job, _p(role="diarization", name=_DIAR["name"]), worker_id=W, hf_token="t",
        diarization_model_dir=str(make_bundle(tmp_path, skip=("config.yaml",))),
        snapshot=lambda **kw: calls.append(kw) or "/tmp/x",
    )
    assert calls[0]["repo_id"] == _DIAR["name"] and calls[0]["token"] == "t"
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm worker:test -- tests/test_model_jobs.py -q -k diarization`
Expected: FAIL — `TypeError: run_download_model() got an unexpected keyword argument 'diarization_model_dir'`

- [ ] **Step 3: 구현**

`model_jobs.py` import에 `bundle` 추가: `from ..models import bundle, cache_scan, downloads, specs`

```python
def run_download_model(conn, job, payload, *, worker_id, hf_token, diarization_model_dir=None,
                       snapshot=None) -> str:
    job_id = job["id"]
    # 재queue된 job에 이미 취소가 찍혀 있을 수 있다 — 받기 전에 본다 (스펙 §7.1).
    if db.stop_requested(conn, job_id):
        raise downloads.DownloadCancelled(payload.name)
    enter_stage(conn, job_id, worker_id, "download_model", 0)
    if payload.name == specs.DIARIZATION_MODEL and bundle.bundle_complete(diarization_model_dir):
        # 앱이 싣고 온 모델이다 (스펙 2026-09-30 §3.3). 업그레이드 전 토큰 시절에 넣은 job이 여기 온다 —
        # 토큰 없이 게이트 저장소를 부르면 401로 실패하므로 받지 않고 끝낸다.
        downloads.mark_ready(payload.name)
        return "committed" if db.complete_job(conn, job_id, worker_id) else "lost"
    kwargs = _download_kwargs(payload, hf_token)
    # … 이하 기존 그대로
```

`jobs.py` ctx:

```python
    #: 모델 받기가 게이트 모델(화자 분리)을 받을 때 쓴다 — 앱 밖(터미널 worker)에서만 값이 있다
    hf_token: str | None = None
    #: 앱에 실린 화자 분리 모델 폴더 (스펙 2026-09-30 §3.3)
    diarization_model_dir: str | None = None
```

`DownloadModelHandler.run`:

```python
        return run_download_model(
            conn, job, payload, worker_id=ctx.worker_id, hf_token=ctx.hf_token,
            diarization_model_dir=ctx.diarization_model_dir,
        )
```

`dispatch.py:191` 아래: `diarization_model_dir=settings.diarization_model_dir,`

- [ ] **Step 4: 통과 확인**

Run: `pnpm worker:test -- tests/test_model_jobs.py tests/test_worker_loop.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add be/worker/damwha_worker/pipeline/model_jobs.py be/worker/damwha_worker/jobs.py be/worker/damwha_worker/dispatch.py be/worker/tests/test_model_jobs.py
git commit -m "feat(worker): 번들이 있으면 화자 분리 다운로드 job을 받지 않고 끝낸다"
```

---

### Task 4: worker — inventory가 번들을 "받음"으로 보고

**Files:**
- Modify: `be/worker/damwha_worker/inventory.py` (`build_inventory`, `run_inventory_loop` 호출)
- Test: `be/worker/tests/test_inventory.py`

**Interfaces:**
- Consumes: `bundle.bundle_complete`, `bundle.bundle_size` (Task 1)
- Produces: `build_inventory(root, *, lens_model, summary_fallback, diarization_model_dir: str | None = None) -> dict`

- [ ] **Step 1: 실패하는 테스트** — `test_build_inventory_shape` 뒤에

```python
_DIAR = "pyannote/speaker-diarization-community-1"


def test_bundle_overrides_cache_entry(tmp_path):
    from tests.test_bundle import make_bundle

    cache = tmp_path / "hub"
    make_repo(cache, _DIAR, {"config.yaml": b"x"})  # 옛 캐시 사본(불완전)
    bundle_dir = make_bundle(tmp_path / "bundle")
    value = inventory.build_inventory(
        str(cache), lens_model=None, summary_fallback=None, diarization_model_dir=str(bundle_dir)
    )
    assert value["repos"][_DIAR] == {"size_bytes": 15, "complete": True}


def test_broken_bundle_keeps_cache_entry(tmp_path):
    from tests.test_bundle import make_bundle

    cache = tmp_path / "hub"
    make_repo(cache, _DIAR, {"config.yaml": b"x"})
    bundle_dir = make_bundle(tmp_path / "bundle", skip=("plda/plda.npz",))
    value = inventory.build_inventory(
        str(cache), lens_model=None, summary_fallback=None, diarization_model_dir=str(bundle_dir)
    )
    assert value["repos"][_DIAR]["complete"] is False


def test_loop_passes_bundle_dir(conn, tmp_path, monkeypatch):
    seen = []
    real = inventory.build_inventory
    monkeypatch.setattr(
        inventory, "build_inventory",
        lambda *a, **kw: seen.append(kw.get("diarization_model_dir")) or real(*a, **kw),
    )
    settings = _Settings()
    settings.diarization_model_dir = "/b/models/p"
    inventory.run_inventory_loop(
        "unused", settings, _StopAfter(1), root=str(tmp_path), interval=0,
        clock=lambda: 0.0, connect=lambda _u: conn,
    )
    assert seen == ["/b/models/p"]
```

`_Settings`·`_StopAfter`는 이 파일의 기존 헬퍼다. `_Settings`에 `diarization_model_dir = None` 클래스 속성을 추가한다(기존 루프 테스트가 `getattr` 없이 읽게). `connect=lambda _u: conn`이 기존 `_run` 헬퍼의 connect 모양과 다르면(예: close를 막는 래퍼) 그 헬퍼의 connect를 그대로 쓴다 — `sed -n 60,100p be/worker/tests/test_inventory.py`로 먼저 확인.

- [ ] **Step 2: 실패 확인**

Run: `pnpm worker:test -- tests/test_inventory.py -q`
Expected: FAIL — `unexpected keyword argument 'diarization_model_dir'`

- [ ] **Step 3: 구현**

```python
def build_inventory(root: str, *, lens_model: str | None, summary_fallback: str | None,
                    diarization_model_dir: str | None = None) -> dict:
    by_repo = specs.specs_by_repo()
    scanned = cache_scan.scan_cache(root, by_repo)
    repos = {
        repo: {"size_bytes": r.size_bytes, "complete": r.complete}
        for repo, r in sorted(scanned.items())
    }
    # 앱 번들이 온전하면 캐시 결과를 덮는다 (스펙 2026-09-30 §3.2). 캐시의 옛 사본은 무시된다.
    if bundle.bundle_complete(diarization_model_dir):
        repos[specs.DIARIZATION_MODEL] = {
            "size_bytes": bundle.bundle_size(diarization_model_dir), "complete": True,
        }
    return {
        "scanned_at": core.readiness_now(),
        "repos": repos,
        # … 나머지 키는 기존 그대로
    }
```

import: `from .models import bundle, cache_scan, specs`

`run_inventory_loop`의 호출:

```python
                    value = build_inventory(
                        root,
                        lens_model=settings.lens_llm_model,
                        summary_fallback=settings.summary_llm_model,
                        diarization_model_dir=settings.diarization_model_dir,
                    )
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm worker:test -q`
Expected: 전체 PASS

- [ ] **Step 5: Commit**

```bash
git add be/worker/damwha_worker/inventory.py be/worker/tests/test_inventory.py
git commit -m "feat(worker): inventory가 앱 번들 화자 분리 모델을 받음으로 보고"
```

---

### Task 5: desktop — 모델 스테이징 스크립트

**Files:**
- Create: `desktop/scripts/build-models.sh`
- Create: `desktop/scripts/models-checksums.txt`
- Modify: `desktop/package.json:13` (`start:desktop`), `desktop/scripts/package.mjs:46` 다음 줄

**Interfaces:**
- Produces: `desktop/build/models/pyannote-speaker-diarization-community-1/{5 files, NOTICE.txt}`; 체크섬 파일 형식 `<sha256>  <relpath>` (shasum 형식, 5줄)

- [ ] **Step 1: 체크섬 파일 만들기** (이 머신의 HF 캐시에 이미 그 리비전이 있다)

```bash
SNAP=~/.cache/huggingface/hub/models--pyannote--speaker-diarization-community-1/snapshots/3533c8cf8e369892e6b79ff1bf80f7b0286a54ee
cd "$SNAP" && shasum -a 256 config.yaml segmentation/pytorch_model.bin embedding/pytorch_model.bin plda/plda.npz plda/xvec_transform.npz
```

출력 다섯 줄을 머리 주석과 함께 `desktop/scripts/models-checksums.txt`에 쓴다:

```
# build-models.sh가 받는 pyannote/speaker-diarization-community-1@3533c8cf8e369892e6b79ff1bf80f7b0286a54ee
# 파일의 sha256. `shasum -a 256 -c`로 대조한다(주석 줄은 스크립트가 걸러 낸다). check-bundle.mjs도 읽는다.
<hash>  config.yaml
<hash>  segmentation/pytorch_model.bin
<hash>  embedding/pytorch_model.bin
<hash>  plda/plda.npz
<hash>  plda/xvec_transform.npz
```

(캐시에 그 리비전이 없으면 Step 2의 스크립트를 체크섬 없이 한 번 돌릴 수 없으므로, 먼저 `uv run --directory be/worker --extra models python -c "from huggingface_hub import snapshot_download as s; print(s('pyannote/speaker-diarization-community-1', revision='3533c8cf8e369892e6b79ff1bf80f7b0286a54ee'))"`로 받는다 — 토큰 필요.)

- [ ] **Step 2: 스크립트 작성**

```bash
#!/bin/bash
# desktop/scripts/build-models.sh
#
# 앱에 싣는 화자 분리 모델을 스테이징한다 (스펙 2026-09-30 §4.1). 결과는
# desktop/build/models/pyannote-speaker-diarization-community-1/. electron-builder의
# extraResources(from: build)가 그대로 Resources/models/로 싣고, dev 앱은 이 자리를 직접 쓴다.
#
# 이 모델은 HF에서 게이트(자동 승인)다 — **빌드하는 머신만** 토큰이 필요하다. 개발자의 HF 캐시·
# `hf auth login`·HF_TOKEN을 그대로 쓴다. 라이선스는 CC-BY-4.0이라 재배포할 수 있고, 출처는
# 같은 폴더의 NOTICE.txt와 README의 License 절이 적는다.
#
# 모델 파일은 pickle을 허용하는 체크포인트다(pyannote가 weights_only=False로 읽는다) — 그래서 커밋된
# sha256과 맞지 않으면 스테이징하지 않는다 (§4.5 신뢰 경계).
#
#   bash desktop/scripts/build-models.sh           캐시가 있으면 스테이징만
#   bash desktop/scripts/build-models.sh --fresh   이 키의 캐시를 버리고 다시 받는다

set -euo pipefail

REPO_ID=pyannote/speaker-diarization-community-1
REVISION=3533c8cf8e369892e6b79ff1bf80f7b0286a54ee
# 폴더 이름의 원천은 여기와 src/process/runtime-paths.ts의 DIARIZATION_BUNDLE_NAME 둘이다 —
# tests/process/runtime-paths.test.ts가 둘을 맞춰 본다.
NAME=pyannote-speaker-diarization-community-1

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$DESKTOP/.." && pwd -P)"
SCRIPT="$DESKTOP/scripts/build-models.sh"
SUMS="$DESKTOP/scripts/models-checksums.txt"
CACHE="$DESKTOP/.cache/models"
STAGED="$DESKTOP/build/models/$NAME"

die() { echo "build-models: $*" >&2; exit 1; }
say() { echo "== $*"; }

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "") ;;
  *) die "usage: build-models.sh [--fresh]" ;;
esac

command -v uv >/dev/null 2>&1 || die "uv가 없다 — worker venv로 모델을 받는다"

KEY=$( { echo "$REPO_ID $REVISION $NAME"; shasum -a 256 "$SUMS" "$SCRIPT" | awk '{print $1}'; } \
       | shasum -a 256 | cut -c1-16)
OUT="$CACHE/$NAME-$KEY"
DONE="$OUT.complete"

verify() { (cd "$1" && /usr/bin/grep -v '^#' "$SUMS" | shasum -a 256 -c - >/dev/null 2>&1); }

if [ "$FRESH" = 1 ]; then rm -rf "$OUT" "$DONE"; fi
# 캐시 적중도 믿지 않는다 — 대조가 깨졌으면 버리고 다시 받는다(§4.5).
if [ -f "$DONE" ] && ! verify "$OUT"; then
  say "캐시의 체크섬이 맞지 않는다 — 버리고 다시 받는다"
  rm -rf "$OUT" "$DONE"
fi

if [ ! -f "$DONE" ]; then
  say "받기 $REPO_ID@$REVISION"
  SNAP=$(uv run --directory "$REPO/be/worker" --extra models python -c "
import sys
from huggingface_hub import snapshot_download
print(snapshot_download('$REPO_ID', revision='$REVISION'))
" 2>/dev/null | tail -1) || true
  [ -n "${SNAP:-}" ] && [ -d "$SNAP" ] || die "받지 못했다. 게이트 모델이라 빌드 머신에 HF 토큰이 필요하다:
  1) https://huggingface.co/$REPO_ID 에서 사용 조건에 동의하고
  2) 'uv run --directory be/worker --extra models hf auth login' 또는 HF_TOKEN을 설정한 뒤 다시 실행한다"
  rm -rf "$OUT"; mkdir -p "$OUT"
  # HF 캐시 snapshot은 blobs로 가는 심링크다 — 역참조해 실제 파일로 옮긴다.
  /usr/bin/grep -v '^#' "$SUMS" | awk '{print $2}' | while read -r rel; do
    mkdir -p "$OUT/$(dirname "$rel")"
    cp -L "$SNAP/$rel" "$OUT/$rel"
  done
  say "체크섬 대조"
  (cd "$OUT" && /usr/bin/grep -v '^#' "$SUMS" | shasum -a 256 -c -) || { rm -rf "$OUT"; die "체크섬이 맞지 않는다 — 스테이징하지 않는다"; }
  touch "$DONE"
fi

say "스테이징 → $STAGED"
rm -rf "$STAGED"; mkdir -p "$(dirname "$STAGED")"
cp -R "$OUT" "$STAGED"
verify "$STAGED" || die "스테이징 사본의 체크섬이 맞지 않는다"
cat > "$STAGED/NOTICE.txt" <<EOF
pyannote/speaker-diarization-community-1
https://huggingface.co/$REPO_ID (revision $REVISION)

Copyright (c) pyannote contributors. Licensed under the Creative Commons Attribution 4.0
International License (CC BY 4.0): https://creativecommons.org/licenses/by/4.0/

Damwha redistributes these files unmodified.
EOF
say "완료"
```

- [ ] **Step 3: 실행해 확인**

Run: `bash desktop/scripts/build-models.sh && ls -la desktop/build/models/pyannote-speaker-diarization-community-1 && du -sh desktop/build/models`
Expected: `== 완료`, 파일 다섯 + `NOTICE.txt`, 약 31M. 두 번째 실행은 "받기" 없이 스테이징만 한다.

- [ ] **Step 4: 연결**

`desktop/package.json`의 `start:desktop`:

```json
"start:desktop": "bash scripts/build-postgres.sh && bash scripts/build-python.sh && bash scripts/build-ffmpeg.sh && bash scripts/build-models.sh && pnpm run compile && electron .",
```

`desktop/scripts/package.mjs:46` 아래:

```js
run("bash", [path.join("scripts", "build-models.sh")], desktop);
```

`desktop/.gitignore`(또는 루트)에 `.cache/`·`build/`가 이미 걸려 있는지 확인: `git check-ignore desktop/build/models desktop/.cache/models`. 둘 다 출력돼야 한다.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/build-models.sh desktop/scripts/models-checksums.txt desktop/package.json desktop/scripts/package.mjs
git commit -m "feat(desktop): 화자 분리 모델을 받아 Resources/models로 스테이징하는 build-models.sh"
```

---

### Task 6: desktop — 번들 경로와 python 자식 env

**Files:**
- Modify: `desktop/src/process/runtime-paths.ts` (상수·함수 추가)
- Modify: `desktop/src/services/types.ts:71` (`LaunchContext`에 필드)
- Modify: `desktop/src/config/config.ts` (`APP_OWNED_KEYS`, `appOwnedChildEnv`)
- Modify: `desktop/src/main.ts:930-936` (`bundleDir`), `:1455-1471` (ctx)
- Test: `desktop/tests/process/runtime-paths.test.ts`, `desktop/tests/config/config.test.ts`, `desktop/tests/process/python-launcher.test.ts`
- 그 밖에 `LaunchContext`를 리터럴로 만드는 곳 전부(최소 `tests/services/api.test.ts:255-271`, `tests/services/embed.test.ts:15-35`, `tests/services/worker.test.ts:23-43`, `tests/windows/status-view.test.ts:445-457`, `tests/config/config-reload.test.ts:200`, `tests/process/runtime-paths.test.ts`, `tests/process/python-launcher.test.ts`, `tests/config/config.test.ts`). `/usr/bin/grep -rn "bins: {" desktop/src desktop/tests`로 전부 찾는다. **`diarizationModelDir: "/b/models/pyannote-speaker-diarization-community-1"`는 `bins`의 형제(최상위 속성)로 더한다 — `bins` 안에 넣지 않는다.** 커밋 전에 `pnpm --filter damwha-desktop run compile`이 오류 없이 끝나야 한다.

**Interfaces:**
- Produces: `DIARIZATION_BUNDLE_NAME = "pyannote-speaker-diarization-community-1"`; `diarizationModelDir(modelsBundleDir: string): string`; `LaunchContext.diarizationModelDir: string`; 자식 env `DIARIZATION_MODEL_DIR`, `PYANNOTE_METRICS_ENABLED="false"`

- [ ] **Step 1: 실패하는 테스트**

`tests/process/runtime-paths.test.ts`:

```ts
import { DIARIZATION_BUNDLE_NAME, diarizationModelDir } from "../../src/process/runtime-paths";

describe("diarizationModelDir", () => {
  it("names the bundled pyannote folder under Resources/models", () => {
    expect(diarizationModelDir("/b/models")).toBe("/b/models/pyannote-speaker-diarization-community-1");
  });

  it("keeps the folder name paired with build-models.sh", () => {
    const script = fs.readFileSync(path.join(__dirname, "../../scripts/build-models.sh"), "utf8");
    expect(script).toMatch(new RegExp(`^NAME=${DIARIZATION_BUNDLE_NAME}$`, "m"));
  });
});
```

`tests/config/config.test.ts` — `appOwnedChildEnv` 블록 근처(기존 ctx 헬퍼 사용):

```ts
it("tells python children where the bundled diarization model is and turns pyannote telemetry off", () => {
  const env = appOwnedChildEnv(ctx());
  expect(env.DIARIZATION_MODEL_DIR).toBe(ctx().diarizationModelDir);
  expect(env.PYANNOTE_METRICS_ENABLED).toBe("false");
});

it("ignores DIARIZATION_MODEL_DIR and PYANNOTE_METRICS_ENABLED from config.json", () => {
  const env = childEnv(ctx({ env: { DIARIZATION_MODEL_DIR: "/evil", PYANNOTE_METRICS_ENABLED: "true" } }), {});
  expect(env.DIARIZATION_MODEL_DIR).toBe(ctx().diarizationModelDir);
  expect(env.PYANNOTE_METRICS_ENABLED).toBe("false");
});

it("drops an inherited HF_TOKEN from every python child", () => {
  expect("HF_TOKEN" in childEnv(ctx(), { HF_TOKEN: "hf_shell" })).toBe(false);
});
```

(`ctx()` 헬퍼의 실제 이름·인자 모양은 `sed -n 1,80p desktop/tests/config/config.test.ts`로 확인하고 맞춘다. `loadConfig`가 APP_OWNED_KEYS를 거르는 테스트가 따로 있으면 두 키를 그 표에도 추가한다.)

`tests/process/python-launcher.test.ts:113` 아래:

```ts
    expect(env.DIARIZATION_MODEL_DIR).toBe(c.diarizationModelDir);
    expect(env.PYANNOTE_METRICS_ENABLED).toBe("false");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop test -- tests/process tests/config/config.test.ts`
Expected: FAIL — `diarizationModelDir is not exported` / 타입 오류

- [ ] **Step 3: 구현**

`runtime-paths.ts` — `ffmpegBinaries` 아래:

```ts
/**
 * 앱에 실린 화자 분리 모델 폴더 (스펙 2026-09-30 §4.3). `build-models.sh`의 `NAME`과 짝이다 —
 * 테스트가 스크립트를 읽어 맞춰 본다. `HF_HOME`(= `<userData>/models`, HF 캐시)과는 다른 자리다.
 */
export const DIARIZATION_BUNDLE_NAME = "pyannote-speaker-diarization-community-1";

export function diarizationModelDir(modelsBundleDir: string): string {
  return path.join(modelsBundleDir, DIARIZATION_BUNDLE_NAME);
}
```

`services/types.ts` — `bins` 아래:

```ts
  /** 앱에 실린 화자 분리 모델 폴더의 절대 경로 (process/runtime-paths.ts의 diarizationModelDir). */
  diarizationModelDir: string;
```

`config.ts` `APP_OWNED_KEYS` — `FFPROBE_BIN` 줄 아래:

```ts
  ["DIARIZATION_MODEL_DIR", { rule: "앱에 실린 화자 분리 모델을 씁니다" }],
  ["PYANNOTE_METRICS_ENABLED", { rule: "앱은 pyannote 사용 통계 전송을 항상 끕니다" }],
```

`appOwnedChildEnv`의 `out`:

```ts
    FFPROBE_BIN: ctx.bins.ffprobe,
    DIARIZATION_MODEL_DIR: ctx.diarizationModelDir,
    PYANNOTE_METRICS_ENABLED: "false",
```

`main.ts`:

```ts
function bundleDir(name: "postgres" | "python" | "ffmpeg" | "models"): string {
```

ctx 리터럴의 `bins:` 아래:

```ts
    diarizationModelDir: diarizationModelDir(bundleDir("models")),
```

import에 `diarizationModelDir` 추가(`./process/runtime-paths`).

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop test && pnpm --filter damwha-desktop run compile`
Expected: 전체 PASS, tsc 오류 없음

- [ ] **Step 5: Commit**

```bash
git add desktop/src desktop/tests
git commit -m "feat(desktop): 번들 화자 분리 모델 경로와 텔레메트리 끄기를 python 자식 env로 싣는다"
```

---

### Task 7: desktop — check-bundle에 모델 검사

**Files:**
- Modify: `desktop/scripts/check-bundle.mjs` (22번 뒤, `failures` 판정 앞)

**Interfaces:**
- Consumes: `desktop/scripts/models-checksums.txt` 형식(Task 5)

- [ ] **Step 1: 검사 추가**

import에 `import { createHash } from "node:crypto";`

```js
// 23. 앱에 실린 화자 분리 모델 (스펙 2026-09-30 §4.4). 파일 다섯이 커밋된 sha256과 같고 출처 표기가 있다.
// 모델 파일은 pickle을 허용하는 체크포인트라 봉인 전 마지막으로 여기서 대조한다(§4.5).
const modelDir = path.join(contents, "Resources", "models", "pyannote-speaker-diarization-community-1");
const MODEL_FILES = [
  "config.yaml",
  "segmentation/pytorch_model.bin",
  "embedding/pytorch_model.bin",
  "plda/plda.npz",
  "plda/xvec_transform.npz",
];
const sumLines = fs.readFileSync(path.join(desktop, "scripts", "models-checksums.txt"), "utf8")
  .split("\n").filter((l) => l.trim() !== "" && !l.startsWith("#"));
const sums = sumLines.map((l) => /^([a-f0-9]{64})\s{2,}(\S+)$/.exec(l.trim())).filter((m) => m !== null)
  .map((m) => ({ hash: m[1], rel: m[2] }));
const listed = sums.map((s) => s.rel).sort();
check(
  "models-checksums.txt lists exactly the five diarization files",
  sums.length === sumLines.length && JSON.stringify(listed) === JSON.stringify([...MODEL_FILES].sort()),
  listed.join(", "),
);
const badModel = [];
for (const { hash, rel } of sums) {
  const f = path.join(modelDir, rel);
  if (!fs.existsSync(f)) { badModel.push(`${rel} (missing)`); continue; }
  const got = createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (got !== hash) badModel.push(`${rel} (sha256 ${got.slice(0, 12)}…)`);
}
check("bundled diarization model matches models-checksums.txt", badModel.length === 0, badModel.join(", "));
check("bundled diarization model carries NOTICE.txt", fs.existsSync(path.join(modelDir, "NOTICE.txt")));
```

- [ ] **Step 2: 확인** — 패키지 빌드는 Task 12에서 돈다. 여기서는 문법만:

Run: `node --check desktop/scripts/check-bundle.mjs`
Expected: 출력 없음(성공)

- [ ] **Step 3: Commit**

```bash
git add desktop/scripts/check-bundle.mjs
git commit -m "feat(desktop): check-bundle이 번들 화자 분리 모델의 체크섬과 출처 표기를 본다"
```

---

### Task 8: desktop — HF 토큰 기능 제거

**Files:**
- Delete: `desktop/src/config/token-store.ts`, `desktop/src/app/token-boot.ts`, `desktop/src/windows/token-bridge.ts`, `desktop/src/windows/apply-token-change.ts`, `desktop/tests/config/token-store.test.ts`, `desktop/tests/app/token-boot.test.ts`, `desktop/tests/windows/token-bridge.test.ts`, `desktop/tests/windows/apply-token-change.test.ts`
- Modify: `desktop/src/main.ts` (import `:1`·`:20-22`·`:33`, 전역 `:227-231`, `tokenBridge.attach` `:334`·`:1099`, `createTokenBridge` `:734-796`, 상태 창 입력 `:1032-1037`, 기동 읽기 `:1404-1416`, `launchEnv` 호출 `:1463`) — 줄 번호는 b5e7d47 기준, 먼저 `/usr/bin/grep -n "hfToken\|tokenBridge\|TokenStore\|readBootToken\|maskToken\|safeStorage\|verifyHfToken\|tokenFilePath" desktop/src/main.ts`로 다시 잡는다
- Modify: `desktop/src/config/config.ts` (`APP_OWNED_KEYS` HF_TOKEN 문구, `childEnv` 주석, `PYTHON_ONLY_ENV_KEYS`·`nodeChildEnv`, `launchEnv`, `appOwnedChildEnv` 주석)
- Modify: `desktop/src/services/api-process.ts`, `desktop/src/services/postgres/migration-runner.ts` (`nodeChildEnv` 사용처)
- Modify: `desktop/src/windows/status-view.ts`, `desktop/shell/services.html`, `desktop/src/diagnostics/causes.ts`, `desktop/src/windows/shell-hints.ts`, `desktop/src/services/model-readiness.ts:146-155`, `desktop/src/services/types.ts:63`, `desktop/src/services/supervisor.ts:676-687`(주석)
- Modify(주석만): `desktop/src/windows/language-bridge.ts:7,14`, `desktop/src/windows/status-window.ts:22,107`, `desktop/src/update/release-check.ts:5,214`, `desktop/src/config/ui-language-store.ts:10`
- Test: `desktop/tests/windows/status-view.test.ts`, `desktop/tests/config/config.test.ts`, `desktop/tests/config/config-reload.test.ts`, `desktop/tests/services/api-process.test.ts`, `desktop/tests/services/postgres/migration-runner.test.ts`, `desktop/tests/windows/shell-html.test.ts`

**Interfaces:**
- Produces: `launchEnv(cfg, llmPort, deviceLanguage)` (토큰 인자 삭제); `nodeChildEnv(env, inherited)` — `HF_TOKEN`을 여전히 뺀다(아래 결정); `ServicesView`에 `token` 없음

**결정 (스펙 §5.1과 같다):** `PYTHON_ONLY_ENV_KEYS`는 없애되 `nodeChildEnv`는 남기고 `HF_TOKEN`을 직접 뺀다. 이유: Node 자식에게 개발자 셸의 토큰을 흘리지 않는 성질은 그대로 가치가 있고, `nodeChildEnv`는 "값이 없는 키를 뺀다"는 다른 일도 한다.

- [ ] **Step 1: 테스트를 새 계약으로 먼저 고친다**

- `status-view.test.ts`: 토큰 줄 관련 테스트(`tokenView`, `TOKEN_*_NOTE`, `maskedToken`/`tokenStatus` 입력, 401·403 modelRows `:683-703`)를 지우고, 다음을 더한다:

`describe("모델 준비 줄 (스펙 §6.9)")` 블록(`:595` 부근) 안 — 그 블록의 `entry()`·`view()` 헬퍼를 쓴다:

```ts
  it("has no token section", () => {
    expect("token" in view([])).toBe(false);
  });

  it("shows a PERMANENT hf_gate_not_accepted readiness failure as a plain download failure", () => {
    const row = view([
      entry({ state: "failed", error: "hf_gate_not_accepted: refused (403)", errorKind: "PERMANENT" }),
    ]).models[0];
    expect(row.cause).toBe(CAUSES.modelDownloadFailed.text("BAAI/bge-m3", "refused (403)"));
    expect(row.tone).toBe("fail");
  });
```

(`view(...).models`가 모델 줄 배열의 실제 속성 이름인지 기존 테스트에서 확인한다 — 다르면 그 이름으로. `readinessErrorMessage`가 코드 머리를 떼고 `refused (403)`을 돌려주는지도 `desktop/src/services/model-readiness.ts`에서 확인한다.)

- `config.test.ts:743-790`("HF_TOKEN goes to the Python children only" 블록): 다음 하나로 교체 —

```ts
describe("HF_TOKEN never reaches a child", () => {
  it("drops an inherited HF_TOKEN from node children", () => {
    expect("HF_TOKEN" in nodeChildEnv({ A: "1" }, { HF_TOKEN: "hf_shell" })).toBe(false);
  });
  it("launchEnv carries no HF_TOKEN", () => {
    const { env } = launchEnv(loadedConfig(), 8123, "ko");
    expect("HF_TOKEN" in env).toBe(false);
  });
});
```

(`loadedConfig()`는 파일에 있는 기존 헬퍼 이름으로 맞춘다.)

- `config-reload.test.ts:374-436`, `api-process.test.ts:11-81`, `migration-runner.test.ts:30-94`: `launchEnv(..., hfToken, ...)` 호출에서 토큰 인자를 빼고, "토큰이 Node 자식에 안 간다" 단언은 `ctx.env`에 토큰을 넣는 대신 `inherited`에 넣는 형태로 바꾼다(의미: 셸 토큰도 안 간다).
- `shell-html.test.ts:9`: `maskToken` import와 그것을 쓰는 단언을 지운다.
- 삭제 대상 테스트 네 파일을 `git rm`.

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop test`
Expected: FAIL — 새 단언(토큰 줄 존재 등)·시그니처 불일치

- [ ] **Step 3: 구현**

1. `git rm desktop/src/config/token-store.ts desktop/src/app/token-boot.ts desktop/src/windows/token-bridge.ts desktop/src/windows/apply-token-change.ts`
2. `main.ts`:
   - `import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from "electron";` → `safeStorage` 제거.
   - 토큰 import 셋(`token-store`, `token-boot`, `token-bridge`/`apply-token-change`) 제거.
   - `let hfToken: string | null = null;` 제거.
   - `const tokenBridge = createTokenBridge({...})` 블록(`:734-796`) 전체 제거, `tokenBridge.attach(...)` 두 곳 제거.
   - 상태 창 입력의 `maskedToken: …`, `tokenStatus: …` 두 줄 제거.
   - `createSupervisorFor`의 토큰 읽기(`:1406-1416` — 주석 두 줄 + `const boot = …` + `hfToken = boot.token;` + `tokenBridge.boot(…)`)를 지우고, 그 자리에 기존 토큰 파일 삭제 호출(Task 9)이 들어간다 — 이 태스크에서는 비워 둔다.
   - `launchEnv(cfg, await freePort(), hfToken, pickUiLanguage(...))` → `launchEnv(cfg, await freePort(), pickUiLanguage(app.getPreferredSystemLanguages()))`. 바로 위 주석 "토큰은 env에만 싣는다 — …" 줄을 지운다.
3. `config.ts`:
   - `["HF_TOKEN", { rule: "토큰은 앱이 따로 관리합니다", secret: true }]` → `["HF_TOKEN", { rule: "앱은 HF 토큰을 쓰지 않습니다 — 화자 분리 모델은 앱에 들어 있어요", secret: true }]`
   - `APP_OWNED_KEYS` 머리 주석의 "HF_TOKEN은 값을 싣지 않는다." → "HF_TOKEN은 싣지 않는다 — 앱은 토큰을 쓰지 않는다(스펙 2026-09-30)."
   - `appOwnedChildEnv` 주석 마지막 단락("HF_TOKEN은 여기 없다 — …") → "HF_TOKEN은 싣지 않는다. 화자 분리 모델은 DIARIZATION_MODEL_DIR의 번들에서 읽는다(스펙 2026-09-30 §3.1). childEnv가 상속분(개발자 셸의 HF_TOKEN)도 버린다."
   - `childEnv` 주석 1번 항목과 함수 안 주석: "토큰의 출처는 앱 하나다 …" → "상속분에서 HF_TOKEN을 제거한다. 앱은 토큰을 쓰지 않는다 — 셸 토큰이 남으면 번들이 없을 때의 hub 폴백이 조용히 성공해 설치가 깨진 것을 가린다(스펙 2026-09-30 §5.1)."
   - `PYTHON_ONLY_ENV_KEYS` 상수와 주석 삭제. `nodeChildEnv`의 `if (PYTHON_ONLY_ENV_KEYS.includes(key)) continue;` → `if (key === "HF_TOKEN") continue;`, 주석의 수식을 `{ ...inherited, ...env } − HF_TOKEN − 값이 없는 키`로, "감독자가 쥔 ctx.env의 토큰은 worker·embed의 몫으로 남는다" 문장 삭제.
   - `launchEnv`: 시그니처에서 `hfToken: string | null,` 제거, `if (hfToken !== null) env.HF_TOKEN = hfToken;` 제거, 주석의 "기동 게이트가 Keychain에서 읽은 HF 토큰," "LLM 주소와 HF 토큰은" → "LLM 주소는", "토큰이 없으면 조건 수락 모델을 받지 못한다" 문장, 마지막 단락("토큰이 null이면 …") 삭제.
4. `status-view.ts`: `TokenView`·`TokenStatus` 타입, `ServicesView.token`, 입력의 `maskedToken`·`tokenStatus`, `NO_TOKEN_NOTE`·`TOKEN_NOTE`·`UNREADABLE_TOKEN_NOTE`·`TOKEN_UNAVAILABLE_NOTE`, `tokenView`·`tokenNoteFor`, `servicesView`의 `token:` 줄, `modelRows`의 `HF_TOKEN_INVALID_CODE`·`HF_GATE_NOT_ACCEPTED_CODE` 두 분기(그 둘은 뒤의 일반 `return`으로 떨어진다), `:384-385` 표의 토큰 행, 관련 import를 지운다.
5. `shell/services.html`: 토큰 절(CSS `:120-122`, 마크업 `:135-140`, 렌더 `:233-234`·`:257-259`, 주석 `:14`)을 지운다. **`<style>`을 고치면 CSP `style-src` 해시가 바뀐다** — `tests/windows/shell-html.test.ts`가 알려 주는 새 해시로 그 파일의 CSP 메타를 갱신한다(desktop/CLAUDE.md "창 배경과 셸 페이지").
6. `causes.ts`: (스펙 §5.1 — `diarization_bundle_missing` 원인은 더하지 않는다) `safeStorageUnavailable`·`hfTokenInvalid`·`hfGateNotAccepted` 항목과 `HF_GATED_MODEL_PAGE_URL` import 삭제. `modelDownloadFailed` 주석의 "**401·403은 이 원인이 아니다.** …" 단락 → "401·403(앱 밖 개발 경로에서만 생긴다)도 여기로 온다."
7. `shell-hints.ts`: `HF_TOKENS_PAGE_URL` import와 `safeStorageUnavailable`·`hfTokenInvalid`·`hfGateNotAccepted` 세 항목 삭제.
8. `model-readiness.ts`: `HF_TOKEN_INVALID_CODE`·`HF_GATE_NOT_ACCEPTED_CODE`와 그 위 주석의 "401과 403을 가르는 유일한 근거다 (판정 R-11a)." 문장 삭제(`readinessErrorCode`는 남긴다 — 다른 호출부가 있으면. `/usr/bin/grep -rn readinessErrorCode desktop/src`로 확인하고, 쓰는 곳이 없어지면 함수와 테스트도 지운다).
9. `types.ts:63` 주석: "앱이 이 실행에 정한 값(main.ts의 launchEnv — LENS_LLM_BASE_URL, 기동 게이트의 HF_TOKEN)" → "(main.ts의 launchEnv — LENS_LLM_BASE_URL, SUMMARY_LANGUAGE)", "**통째로 로그·화면에 싣지 않는다** — 토큰이 들어 있다." → "**통째로 로그·화면에 싣지 않는다** — DB 비밀번호 같은 값이 들어 있을 수 있다."
10. `supervisor.ts:676-687`: `restartService` 주석에서 토큰 교체 언급을 지운다(메서드는 상태 창 재시작 버튼이 쓰므로 남긴다).
11. 주석만 고치는 네 파일: "token-bridge.ts와 같은 …"/"token-store.ts를 본떴다" 문장을 그 규칙을 직접 적는 문장으로 바꾼다(예: `language-bridge.ts:14` "값은 JSON으로만 싣는다(token-bridge.ts의 hfTokenShowCall과 같은 이유)." → "값은 JSON으로만 싣는다 — 문자열을 스크립트에 이어 붙이면 따옴표 하나로 주입이 된다."). 각 파일에서 원래 이유를 읽고 옮겨 적는다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop test && pnpm --filter damwha-desktop run compile && pnpm --filter damwha-desktop lint`
Expected: 전부 PASS. 그리고 `/usr/bin/grep -rn "hfToken\|token-store\|token-bridge\|token-boot\|apply-token-change\|safeStorage\|HF_GATED_MODEL_PAGE_URL" desktop/src desktop/shell desktop/tests` → 출력 없음.

- [ ] **Step 5: Commit**

```bash
git add -A desktop
git commit -m "refactor(desktop): HF 토큰 기능을 걷어낸다 — Keychain 저장·토큰 다리·상태 창 토큰 줄"
```

---

### Task 9: desktop — 기존 토큰 파일 삭제

**Files:**
- Create: `desktop/src/app/legacy-token-cleanup.ts`
- Modify: `desktop/src/main.ts` (`createSupervisorFor`의 Task 8이 비운 자리)
- Test: `desktop/tests/app/legacy-token-cleanup.test.ts`

**Interfaces:**
- Produces: `LEGACY_TOKEN_FILE = "hf-token.bin"`; `removeLegacyToken(userData: string, deps?: { rm?: (p: string) => void; log?: (line: string) => void }): "removed" | "absent" | "failed"`

- [ ] **Step 1: 실패하는 테스트**

```ts
// desktop/tests/app/legacy-token-cleanup.test.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { LEGACY_TOKEN_FILE, removeLegacyToken } from "../../src/app/legacy-token-cleanup";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "damwha-token-"));
}

describe("removeLegacyToken", () => {
  it("removes the encrypted token file an older build left", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, LEGACY_TOKEN_FILE), "x");
    const lines: string[] = [];
    expect(removeLegacyToken(dir, { log: (l) => lines.push(l) })).toBe("removed");
    expect(fs.existsSync(path.join(dir, LEGACY_TOKEN_FILE))).toBe(false);
    expect(lines.join("\n")).toMatch(/hf-token\.bin/);
  });

  it("does nothing when there is no file", () => {
    expect(removeLegacyToken(tmp())).toBe("absent");
  });

  it("logs and carries on when removal fails", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, LEGACY_TOKEN_FILE), "x");
    const lines: string[] = [];
    const out = removeLegacyToken(dir, {
      rm: () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); },
      log: (l) => lines.push(l),
    });
    expect(out).toBe("failed");
    expect(lines.join("\n")).toMatch(/EPERM/);
  });

  it("uses the file name older builds wrote", () => {
    expect(LEGACY_TOKEN_FILE).toBe("hf-token.bin");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop test -- tests/app/legacy-token-cleanup.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// desktop/src/app/legacy-token-cleanup.ts
import * as fs from "fs";
import * as path from "path";

/**
 * 0.4.x까지의 빌드가 safeStorage로 암호화해 둔 HF 토큰 파일 (옛 `config/token-store.ts`의 TOKEN_FILE_NAME).
 * 앱은 더는 토큰을 쓰지 않으므로(스펙 2026-09-30 §5.1) 기동 때 지운다 — 쓰지 않는 비밀을 디스크에 두지 않는다.
 * 실패해도 기동을 막지 않는다. 로그만 남기고 다음 기동이 다시 시도한다.
 */
export const LEGACY_TOKEN_FILE = "hf-token.bin";

export function removeLegacyToken(
  userData: string,
  deps: { rm?: (p: string) => void; log?: (line: string) => void } = {},
): "removed" | "absent" | "failed" {
  const file = path.join(userData, LEGACY_TOKEN_FILE);
  if (!fs.existsSync(file)) return "absent";
  const rm = deps.rm ?? ((p: string) => fs.rmSync(p, { force: true }));
  try {
    rm(file);
    deps.log?.(`예전 HF 토큰 파일을 지웠어요 — ${LEGACY_TOKEN_FILE} (앱은 더는 토큰을 쓰지 않아요)`);
    return "removed";
  } catch (e) {
    deps.log?.(`예전 HF 토큰 파일(${LEGACY_TOKEN_FILE})을 지우지 못했어요: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
```

`main.ts` `createSupervisorFor` 첫머리(`const userData = …` 다음):

```ts
  removeLegacyToken(userData, { log: appendSupervisorLog });
```

import 추가: `import { removeLegacyToken } from "./app/legacy-token-cleanup";`

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop test && pnpm --filter damwha-desktop run compile`
Expected: PASS

- [ ] **Step 5: `desktop/CLAUDE.md` "지키는 것" 삭제 목록 갱신 후 Commit**

"앱이 지우는 것은 데이터 영역(…)에서 여덟 가지뿐 — …" 문장 뒤에 한 문장 추가:

```
데이터 영역 밖에서는 하나 — 0.4.x까지 쓰던 암호화 토큰 파일 `<userData>/hf-token.bin`을 기동 때 지운다(`app/legacy-token-cleanup.ts`, 스펙 2026-09-30 §5.1).
```

```bash
git add desktop/src/app/legacy-token-cleanup.ts desktop/tests/app/legacy-token-cleanup.test.ts desktop/src/main.ts desktop/CLAUDE.md
git commit -m "feat(desktop): 예전 빌드가 남긴 HF 토큰 파일을 기동 때 지운다"
```

---

### Task 10: fe — 토큰 기능·게이트 제거와 실패 문구

**Files:**
- Delete: `fe/src/features/hf-token/` 전체
- Modify: `fe/src/app/app-shell.tsx:19-20,128,163-164`, `fe/src/features/meeting/ui/left-nav.tsx:12,136,143,189-190`, `fe/src/features/meeting/ui/transcript-pane.tsx:26,349,556-557`, `fe/src/pages/settings.tsx:5,46`, `fe/src/pages/meeting.tsx:28-29,98-127`, `fe/src/features/meeting/lib/desktop-bridge.ts:2,9-10,45`, `fe/src/features/models/ui/model-row-actions.tsx`, `fe/src/features/models/lib/actions.ts:31-33`, `fe/eslint.config.js:39-40`
- Test: `fe/src/pages/meeting.test.tsx`, `fe/src/features/models/lib/actions.test.ts`, `fe/src/features/models/ui/models-card.test.tsx`, `fe/src/features/meeting/lib/desktop-bridge.test.ts`, `fe/src/features/meeting/ui/left-nav.test.tsx`, `fe/src/features/meeting/ui/transcript-pane.test.tsx`

**Interfaces:**
- Produces: `jobErrorText(r: ModelRow): { text: string } | null` (`accept` 필드 삭제); `DesktopBridge`에 `hfToken` 없음

- [ ] **Step 1: 테스트를 새 계약으로**

`pages/meeting.test.tsx` — "취소된 회의는 …" 테스트 뒤에:

```tsx
test("앱에 실린 화자 분리 모델이 깨졌으면 다시 설치를 안내한다", async () => {
  fx.setDetailOverride("m3", {
    ...fx.detailOf("m3"),
    status: "failed",
    current_job_id: null,
    error: { code: "diarization_bundle_missing", stage: "diarize", message: "incomplete" },
  });
  renderShell("/meetings/m3");
  expect(await screen.findByText(/앱에 포함된 화자 분리 모델을 찾을 수 없어요/)).toBeInTheDocument();
  expect(screen.getByText(/앱을 다시 설치해 주세요/)).toBeInTheDocument();
});

test("예전 토큰 오류로 실패한 회의는 일반 실패 문구를 보인다", async () => {
  fx.setDetailOverride("m3", {
    ...fx.detailOf("m3"),
    status: "failed",
    current_job_id: null,
    error: { code: "hf_token_invalid", stage: "diarize", message: "401" },
  });
  renderShell("/meetings/m3");
  expect(await screen.findByText(/처리에 실패했어요/)).toBeInTheDocument();
  expect(screen.queryByText(/토큰/)).toBeNull();
});
```

`features/models/lib/actions.test.ts:46-47` → 교체:

```ts
    expect(jobErrorText(failed("hf_token_invalid"))).toEqual({ text: "받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요." });
    expect(jobErrorText(failed("hf_gate_not_accepted"))).toEqual({ text: "받지 못했어요. 인터넷 연결을 확인하고 다시 받아 주세요." });
```

같은 파일의 다른 `accept: false` 기대값에서 `accept` 키를 지운다.

`models-card.test.tsx`: `HfTokenGateProvider`·`HfTokenState` import, `HF_ABSENT`, `renderCardWithGate`, 게이트 테스트 둘(`:295-335`)과 403 수락 버튼 테스트(`:340-360` 부근)를 지운다. **`diarizationRow`는 남긴다.** 그리고 기존 `renderCard`(`:89-97`)로:

```tsx
test("화자 분리 모델 받기는 토큰 없이 바로 요청한다", async () => {
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
  renderCard({
    ...VIEW,
    freeBytes: null,
    models: [...VIEW.models.slice(0, 3), diarizationRow(), ...VIEW.models.slice(4)],
  });
  fireEvent.click(await screen.findByRole("button", { name: "화자 분리 모델 받기" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/models/download", {
      role: "diarization",
      name: "pyannote/speaker-diarization-community-1",
    }),
  );
  expect(post).toHaveBeenCalledTimes(1);
});
```

`desktop-bridge.test.ts`: `hfToken` 관련 단언을 지우고 `expect("hfToken" in window.__damwha_desktop!).toBe(false);`를 더한다.

`left-nav.test.tsx`·`transcript-pane.test.tsx`: `HfTokenGateProvider`로 감싸거나 토큰 상태를 목으로 넣는 부분이 있으면 지운다(`/usr/bin/grep -n "hf\|Hf\|token" <파일>`). 새 회의 버튼·재처리 버튼이 `disabled`가 아닌지 보는 단언 하나씩:

```tsx
expect(screen.getByRole("button", { name: /새 회의/ })).not.toBeDisabled();
```

```tsx
expect(screen.getByRole("button", { name: /재처리/ })).not.toBeDisabled();
```

(버튼 이름은 각 컴포넌트의 실제 라벨로 맞춘다.)

- [ ] **Step 2: 실패 확인**

Run: `pnpm fe test`
Expected: FAIL — 새 문구 없음, `accept` 키 불일치

- [ ] **Step 3: 구현**

1. `git rm -r fe/src/features/hf-token`
2. `app-shell.tsx`: 두 import 삭제, `<HfTokenGateProvider>` 여닫는 태그와 `<HfTokenOnboarding />` 삭제(자식은 그대로 둔다 — 감싸던 Fragment가 필요하면 `<>…</>`).
3. `left-nav.tsx`: import 삭제, `const gate = useDiarizationGate();` 삭제, 단축키 `if (!gate.locked) gate.run(() => setNewMeetingOpen(true));` → `setNewMeetingOpen(true);`, 버튼 `onClick={() => setNewMeetingOpen(true)}`, `disabled={gate.locked}` 삭제.
4. `transcript-pane.tsx`: import·`gate` 삭제, `onClick={() => setReprocessOpen(true)}`, `disabled={gate.locked}` 삭제.
5. `settings.tsx`: import와 `<HfTokenSettingsSection />` 삭제.
6. `desktop-bridge.ts`: `hfTokenStore` import, `hfToken` 필드·주석, `hfToken: hfTokenStore.bridge,` 삭제.
7. `meeting.tsx`: `hfFailureCopy`·`HfFailureAction` import 삭제. 실패 배너:

```tsx
    const cancelled = meeting.error?.code === "cancelled";
    const noMic = meeting.error?.code === "audio_device_failed";
    // 앱에 실린 화자 분리 모델이 불완전하다 (worker errors.DIARIZATION_BUNDLE_MISSING, 스펙 2026-09-30 §5.2)
    const bundleMissing = meeting.error?.code === "diarization_bundle_missing";
```

제목 삼항: `cancelled ? "처리를 취소했어요" : bundleMissing ? "앱에 포함된 화자 분리 모델을 찾을 수 없어요" : noMic ? … : "처리에 실패했어요"`
본문 삼항: `cancelled ? … : bundleMissing ? "앱을 다시 설치해 주세요." : noMic ? … : "다시 업로드하거나 잠시 후 시도해 주세요."`
`{hf !== null ? <HfFailureAction … /> : null}` 줄 삭제.
8. `actions.ts` `jobErrorText`: 반환 타입 `{ text: string } | null`, `hf_token_invalid`·`hf_gate_not_accepted` 두 줄 삭제, 나머지 반환의 `accept: false` 삭제.
9. `model-row-actions.tsx`: 두 import 삭제. `useDownloadStart`:

```tsx
/** 받기 시작 공통 로직 (스펙 §6.4). */
function useDownloadStart(
  row: ModelRow,
  conflict: { report: (e: unknown) => void; clear: () => void },
) {
  const download = useDownloadModel();
  const key = { role: row.role, name: row.name, backend: row.backend };
  const start = () => {
    conflict.clear();
    download.mutate(key, { onSuccess: conflict.clear, onError: conflict.report });
  };
  return { start, isPending: download.isPending };
}
```

`locked` 구조분해·`disabled={isPending || locked}` → `disabled={isPending}` (두 곳), `{err.accept && <HfFailureAction action="accept" />}` 줄 삭제.
10. `fe/eslint.config.js`: `"useDiarizationGate",`, `"useHfTokenDialog",` 두 줄 삭제.

- [ ] **Step 4: 통과 확인**

Run: `pnpm fe test && pnpm fe lint && pnpm fe build`
Expected: 전부 PASS. `/usr/bin/grep -rn "hf-token\|HfToken\|hfToken\|DiarizationGate\|hf_token_invalid\|hf_gate_not_accepted" fe/src` → 출력 없음.

- [ ] **Step 5: Commit**

```bash
git add -A fe
git commit -m "refactor(fe): HF 토큰 온보딩·설정·게이트를 걷어내고 번들 모델 손상 문구를 더한다"
```

---

### Task 11: 문서

**Files:**
- Modify: `README.md`, `README.ko.md`, `docs/MODELS.md:50`, `desktop/CLAUDE.md`, `fe/CLAUDE.md:162`, `be/CLAUDE.md:63,70,379`, `be/docs/worker-architecture.md:111,518,568`, `be/worker/SMOKE.md:9-18`, `be/.env.example:9`, `site/src/i18n/en.ts:77`, `site/src/i18n/ko.ts:79`
- Delete: `docs/HUGGINGFACE.md`

- [ ] **Step 1: 링크 먼저 찾기**

Run: `/usr/bin/grep -rn "HUGGINGFACE.md" --include='*.md' --include='*.ts' --include='*.astro' . | /usr/bin/grep -v node_modules | /usr/bin/grep -v "docs/superpowers\|electron-migration-roadmap"`
각 링크를 README의 새 개발 절 앵커로 바꾸거나 지운다.

- [ ] **Step 2: 고쳐 쓰기**

- `README.md`/`README.ko.md`:
  - 뱃지 앵커 `:15`(ko `:15`)가 "ML models" 절을 가리키면 새 절 제목에 맞춘다.
  - 필수 조건 표 `:171`(ko `:160`)의 Hugging Face 토큰 행 삭제.
  - `.env` 설명 `:187`(ko `:176`), `:217`(ko `:206`)의 `HF_TOKEN` 필수 표기 → "앱 밖에서 worker만 돌릴 때만 필요".
  - "ML models (gated, heavy)" 절 `:247-256`(ko `:237-246`) 전체를 다음 취지로 교체: 화자 분리 모델 `pyannote/speaker-diarization-community-1`(CC-BY-4.0)은 앱에 포함 → 토큰 불필요. whisper·요약 LLM·bge-m3·ECAPA는 처음 쓸 때 받는다. 앱 없이 `pnpm worker`를 돌리는 개발자는 HF에서 조건 동의 + `HF_TOKEN`(또는 `DIARIZATION_MODEL_DIR`을 `desktop/build/models/...`로). 옛 `speaker-diarization-3.1`·`segmentation-3.0` 언급 삭제.
  - `:327-328`(ko `:317-318`) "앱이 토큰을 묻는다" 삭제.
  - License 절 `:366-370`(ko `:355-356`): "neither vendored nor redistributed" → "화자 분리 모델 하나는 앱에 포함해 재배포한다 — pyannote/speaker-diarization-community-1, © pyannote contributors, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), 변경 없음. 나머지 모델은 재배포하지 않고 각 저장소에서 받는다."
- `docs/MODELS.md:50` → "화자 분리 모델은 앱에 들어 있어 따로 받지 않습니다."
- `desktop/CLAUDE.md`:
  - 명령 블록에 `bash desktop/scripts/build-models.sh [--fresh]   # 화자 분리 모델 스테이징 (31 MB, 빌드 머신만 HF 토큰)` 추가, `pnpm desktop:dev`/`build` 설명의 "셋"을 "넷"으로.
  - 캐시 문장 `desktop/.cache/{postgres,python,ffmpeg}` → `{postgres,python,ffmpeg,models}`.
  - "번들 — `Resources/` 아래 넷" → "다섯", 표에 `| models/ | build-models.sh — pyannote community-1 (CC-BY-4.0). 서명 대상 아님, .app 봉인에 들어간다 |`.
  - "지키는 것"의 "**HF 토큰은 기동을 막지 않는다** …" bullet 교체: "**앱은 HF 토큰을 쓰지 않는다** (스펙 2026-09-30). 화자 분리 모델은 `Resources/models/`에 실려 `DIARIZATION_MODEL_DIR`로 worker에 간다. `childEnv`·`nodeChildEnv`는 셸에서 물려받은 `HF_TOKEN`도 버린다. 번들 파일은 pickle 가능한 체크포인트라 `models-checksums.txt`가 빌드·`check-bundle` 양쪽의 기준이다."
  - `:90`의 "토큰 재입력·마이크 권한 재요청은 없다" — 날짜 박힌 실측 기록이므로 그대로 둔다.
- `fe/CLAUDE.md:162`의 `features/hf-token/` 단락 삭제.
- `be/CLAUDE.md`: `:63` "Heavy/gated ML deps" → "Heavy ML deps", `:70` "3-model gated HF chain" → "pyannote community-1 (앱은 번들, 앱 밖은 hub + HF_TOKEN)", `:379` "download_models.py needs HF_TOKEN"은 유지하되 "(앱 밖 개발 스크립트)" 덧붙임.
- `be/docs/worker-architecture.md:111,518,568`: 토큰 필수 서술을 "앱은 `DIARIZATION_MODEL_DIR`의 번들, 앱 밖은 hub + `HF_TOKEN`"으로.
- `be/worker/SMOKE.md:9-18`: 세 라이선스 링크 → community-1 하나, "앱 밖 개발 스크립트라 `HF_TOKEN`이 필요하다" 명시.
- `be/.env.example:9`: API는 토큰을 읽지 않는다 — `HF_TOKEN` 줄이 있으면 삭제(`/usr/bin/grep -rn HF_TOKEN be/src`가 비어 있음을 먼저 확인).
- `site/src/i18n/en.ts:77`·`ko.ts:79`: "Hugging Face token" 항목 삭제. 그 배열이 개수를 전제한 레이아웃이면 `pnpm site:build`로 확인.

- [ ] **Step 3: 확인**

Run: `/usr/bin/grep -rn "HF_TOKEN\|허깅페이스 토큰\|Hugging Face token\|HUGGINGFACE.md" README.md README.ko.md docs/MODELS.md desktop/CLAUDE.md fe/CLAUDE.md site/src`
Expected: 앱 밖 개발 경로 설명만 남는다.
Run: `pnpm --filter damwha-site build` (site를 고쳤을 때)
Expected: 성공

- [ ] **Step 4: Commit**

```bash
git add -A README.md README.ko.md docs desktop/CLAUDE.md fe/CLAUDE.md be/CLAUDE.md be/docs be/worker/SMOKE.md be/.env.example site/src
git commit -m "docs: 화자 분리 모델 번들과 HF 토큰 제거를 반영한다 — CC-BY-4.0 출처 표기"
```

---

### Task 12: 전체 검증과 실측

**Files:** 없음(검증만). 실패하면 해당 태스크로 돌아가 고친다.

- [ ] **Step 1: 전체 테스트·린트**

Run: `pnpm worker:test && pnpm test && pnpm lint && pnpm fe build`
Expected: 전부 PASS. 실패는 출력 그대로 기록한다.

- [ ] **Step 2: 스테이징한 폴더로 실제 적재 (네트워크 없이)**

Run:
```bash
HF_HUB_OFFLINE=1 PYANNOTE_METRICS_ENABLED=false uv run --directory be/worker --extra models python -c "
from pyannote.audio import Pipeline
p = Pipeline.from_pretrained('$(pwd)/desktop/build/models/pyannote-speaker-diarization-community-1')
print(type(p).__name__)"
```
Expected: `SpeakerDiarization` 출력, 예외 없음.

- [ ] **Step 3: dev 앱 실측** (사람과 함께)

```bash
env -u HF_TOKEN bash -c 'printf x > "$HOME/Library/Application Support/Damwha/hf-token.bin"; pnpm desktop:dev'
```
확인:
1. `~/Library/Application Support/Damwha/hf-token.bin`이 사라지고 `logs/supervisor.log`에 "예전 HF 토큰 파일을 지웠어요".
2. 온보딩 카드·설정의 토큰 섹션·상태 창 토큰 줄이 없다.
3. 짧은 회의 파일 업로드 → 화자 분리까지 `done`.
4. 실시간 녹음 → 멈춤 → 마무리 처리의 화자 분리 `done`.
5. 설정 > 모델 카드의 화자 분리가 "받음".
6. `ps eww $(pgrep -f "damwha_worker" | head -1) | tr ' ' '\n' | /usr/bin/grep -E "DIARIZATION_MODEL_DIR|PYANNOTE_METRICS_ENABLED|HF_TOKEN"` → 앞의 둘만 나온다.

- [ ] **Step 4: 패키지 빌드와 번들 검사**

Run: `rm -rf desktop/out/mac-arm64 && pnpm desktop:build`
Expected: `check-bundle`의 23번 세 줄 포함 `Bundle hygiene: all checks passed.`
(Finder가 `out`을 열고 있으면 `rm -rf`가 깨진다 — 닫고 다시.)

- [ ] **Step 5: graphify 갱신과 마무리 커밋**

Run: `graphify update .`
변경이 있으면(graphify-out은 gitignore라 보통 없다) 커밋하지 않는다. 검증 결과를 PR 본문 초안으로 정리한다.
