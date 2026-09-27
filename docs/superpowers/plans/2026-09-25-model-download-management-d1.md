# 모델 다운로드 관리 D1 — 설치·사용 상태 보기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 화면에서 지금 설정이 쓰는 모델과 각 모델의 받음 여부·용량을 한눈에 보여 준다(읽기 전용).

**Architecture:** worker 부모의 inventory 스레드가 HF 캐시를 직접 스캔해 `app_setting.model_inventory`에 스냅샷을 쓴다(캐시 지문이 바뀌거나 5분마다). API의 새 `GET /models`가 그 행, 기존 `model_readiness`, 현재 처리 설정, BE env를 합쳐 모델 행 목록을 만든다. fe의 새 `features/models`가 설정 페이지에 "모델" 카드(요약 + 목록)를 그린다.

**Tech Stack:** Python 3.12 (psycopg 3, pytest, testcontainers) · NestJS 10 + zod + raw SQL (jest, supertest) · React 19 + TanStack Query + Tailwind 4 (vitest, testing-library) · `@damwha/contracts` (CJS+ESM).

**Spec:** `docs/superpowers/specs/2026-09-25-model-download-management-design.md` — 계획은 스펙의 논증이다. 어긋나면 **스펙을 따르고** 스펙 §11 ledger에 적는다.

## Global Constraints

- 이 계획은 D1만 구현한다. `download_model`·`delete_model`·`POST /models/*`·버튼은 만들지 않는다(스펙 §2.2 — D2 계획은 D1 실측 뒤에 따로 쓴다).
- `app_setting.model_inventory`의 writer는 **worker 부모 하나**다. API는 읽기만 한다(스펙 §4.2).
- `damwha_worker/models/specs.py`·`cache_scan.py`·`damwha_worker/inventory.py`는 `huggingface_hub`·`faster_whisper`·torch·mlx를 **import하지 않는다**(부모 경량, `worker:sync:test` 가상환경에 hub 없음).
- faster-whisper의 크기→저장소 표를 베끼지 않는다. 라이브러리 소스를 `ast`로 읽는다(스펙 §4.1).
- 크기는 1000 기준(`disk.py` `format_bytes`와 같은 규칙).
- 멈춤 기준 120000 ms — fe `MODEL_STALL_MS`, desktop `STALL_MS`, 새 BE 상수가 같은 값.
- `DAMWHA_SHARED_STATE=off`면 inventory를 쓰지 않는다.
- 사용자 문구: 서비스·라이브러리 이름(worker, embed, pyannote, speechbrain, bge) 금지. 역할 이름은 "전사 모델 / 요약 모델 / 화자 분리 모델 / 화자 식별 모델 / 검색 임베딩 모델", 요약 줄 라벨은 "전사 / 요약 / 렌즈 추출 / 기본". 작업자 명칭은 "작업 처리기".
- fe: `useEffect`+`setState` 금지(lint `react-hooks/set-state-in-effect`). 파생 값은 렌더 중 계산.
- 코드 주석·UI 문구·커밋 메시지는 한국어.
- 테스트 명령: worker `pnpm worker:test` · be `pnpm be test` · fe `pnpm --filter damwha-fe exec vitest run` · fe lint `pnpm fe lint` · fe 타입 `pnpm --filter damwha-fe exec tsc -b`. 루트에서 패키지를 직접 띄우지 않는다(루트 CLAUDE.md).
- **커밋**: 각 태스크 끝의 커밋 단계는 사용자가 실행 시작 때 커밋을 허용한 경우에만 수행한다. 허용하지 않았으면 커밋 단계를 건너뛰고 변경을 작업 트리에 둔다.
- 커밋 메시지 끝에 `Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC`.

## Review Focus

1. **HF 캐시 루트의 낯선 항목** (`datasets--*`, `.locks/`, `CACHEDIR.TAG`, 루트의 일반 파일) — 스캔은 `models--*` 디렉터리만 보고 나머지를 조용히 건너뛴다. → Task 2 테스트 `test_scan_ignores_foreign_entries`.
2. **`refs/main`이 가리키는 snapshot 폴더가 없음** (사용자가 snapshots만 지움) — 던지지 않고 `complete=False`. → Task 2 `test_ref_to_missing_snapshot_is_partial`.
3. **옛/새 worker가 쓴 inventory 행의 필드 누락·추가** (`worker_llm` 없음, 알 수 없는 키) — API가 던지지 않고 없는 값은 null/빈 값으로 본다. → Task 4 `fromInventoryRow` 테스트.
4. **렌즈 모델(BE env 또는 worker 값)이 `SUMMARY_MODELS` 밖** — 목록 밖 요약 행이 하나 더 생기고 `inUseFor: ['lens']`. → Task 4 `buildModelsView` 테스트.
5. **inventory에 카탈로그 밖 저장소, readiness에 카탈로그 밖 key** — 행으로 나오지 않지만 `totalBytes`에는 들어가고, 카탈로그 밖 readiness는 `pending`에 영향이 없다. → Task 4 테스트.

---

## File Structure

| 파일 | 책임 | 태스크 |
|---|---|---|
| `be/worker/damwha_worker/models/specs.py` (신설) | 받기 명세 표, faster 저장소 풀이(ast) | 1 |
| `be/worker/damwha_worker/models/whisper_mlx.py`·`whisper_faster.py`·`bge_embed.py` (수정) | 저장소·리비전을 specs에서 읽음 | 1 |
| `be/worker/tests/test_model_specs.py` (신설) | 표 범위·contracts 대조·ast 풀이·패턴 대조·경량 import | 1 |
| `be/worker/damwha_worker/models/cache_scan.py` (신설) | 캐시 루트 결정, 저장소 스캔(크기·complete), 캐시 지문 | 2 |
| `be/worker/tests/test_cache_scan.py` (신설) | 가짜 캐시로 판정·지문 | 2 |
| `be/worker/damwha_worker/db/core.py` (수정) | `write_model_inventory` | 3 |
| `be/worker/damwha_worker/db/__init__.py` (수정) | 재수출 | 3 |
| `be/worker/damwha_worker/inventory.py` (신설) | 스냅샷 조립·주기 루프 | 3 |
| `be/worker/damwha_worker/__main__.py` (수정) | 부모에서 inventory 스레드 시작 | 3 |
| `be/worker/tests/test_inventory.py` (신설) | 실 DB 쓰기·루프 규칙 | 3 |
| `packages/contracts/src/index.ts` (수정) | `MODEL_ROLES`·`DELETABLE_ROLES`·`STT_BACKENDS` | 4 |
| `be/src/models/model-inventory.ts` (신설) | inventory 행 파서 | 4 |
| `be/src/models/models-view.ts` (신설) | 순수 조립 `buildModelsView`, 멈춤 상수 | 4 |
| `be/src/models/models.service.ts`·`models.controller.ts`·`models.module.ts` (신설) | `GET /models` | 4 |
| `be/src/app.module.ts` (수정) | `ModelsModule` 등록 | 4 |
| `be/test/model-inventory.spec.ts`·`models-view.spec.ts`·`models.e2e-spec.ts` (신설) | | 4 |
| `fe/src/features/models/api/types.ts`·`models.ts` (신설) | 와이어 타입, `useModels` | 5 |
| `fe/src/features/models/lib/format.ts`·`rows.ts` (신설) | 크기 문구, 행 문구·가시성·요약 줄 | 5 |
| `fe/src/features/settings/lib/presets.ts` (수정) | `modelShortLabel` export | 5 |
| `fe/src/features/settings/api/settings.ts` (수정) | 설정 저장 시 `["models"]` 무효화 | 5 |
| `fe/src/features/models/ui/models-card.tsx` (신설) | 카드 UI | 6 |
| `fe/src/pages/settings.tsx`·`settings.test.tsx` (수정) | 카드 배치 | 6 |
| `docs/MODELS.md` (신설), `README.md`·`README.ko.md`·`CLAUDE.md`·`be/CLAUDE.md`·`fe/CLAUDE.md` (수정) | 문서 | 7 |

---

### Task 1: worker 받기 명세 표 (`specs.py`)

**Files:**
- Create: `be/worker/damwha_worker/models/specs.py`
- Modify: `be/worker/damwha_worker/models/whisper_mlx.py:18-35` (`_REPO` → specs)
- Modify: `be/worker/damwha_worker/models/whisper_faster.py:25-38` (`_repo_id` → specs)
- Modify: `be/worker/damwha_worker/models/bge_embed.py:36,62` (`_PINNED_REVISIONS` → specs)
- Test: `be/worker/tests/test_model_specs.py`

**Interfaces:**
- Produces:
  - `ModelSpec` (frozen dataclass: `role: str, name: str, backend: str | None, repo_id: str, revision: str | None, allow_patterns: tuple[str, ...] | None, required: tuple[str, ...], approx_bytes: int | None`)
  - `WHISPER_MODELS: tuple[str, ...]`, `SUMMARY_MODELS: tuple[str, ...]`, `STT_BACKENDS = ("mlx", "faster")`
  - `MLX_WHISPER_REPOS: dict[str, str]`, `PINNED_REVISIONS: dict[str, str]`
  - `FASTER_WHISPER_ALLOW: tuple[str, ...]`, `MLX_LM_ALLOW: tuple[str, ...]`
  - `read_literal(source_path: str, name: str, *, function: str | None = None) -> object | None`
  - `faster_repo_id(size: str) -> str`
  - `all_specs() -> list[ModelSpec]`
  - `specs_by_repo() -> dict[str, ModelSpec]`
  - `spec_for(role: str, name: str, backend: str | None = None) -> ModelSpec | None`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_model_specs.py`:

```python
"""받기 명세 표 (스펙 §4.1). 이 모듈은 부모 프로세스와 모델 extra 없는 가상환경에서 import된다."""

import importlib.util
import re
import subprocess
import sys
import typing
from pathlib import Path

import pytest

from damwha_worker import contracts
from damwha_worker.models import specs

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_TS = REPO_ROOT / "packages" / "contracts" / "src" / "index.ts"


def _ts_list(name: str) -> tuple[str, ...]:
    """contracts의 `export const NAME = [ ... ] as const;`에서 문자열 목록을 읽는다."""
    src = CONTRACTS_TS.read_text()
    m = re.search(rf"export const {name} = \[(.*?)\] as const;", src, re.S)
    assert m, f"{name} not found in {CONTRACTS_TS}"
    return tuple(re.findall(r"'([^']+)'", m.group(1)))


def test_whisper_and_summary_lists_match_contracts():
    # worker가 목록을 따로 갖는 대가 — contracts와 어긋나면 여기서 깨진다.
    assert specs.WHISPER_MODELS == _ts_list("WHISPER_MODELS")
    assert specs.SUMMARY_MODELS == _ts_list("SUMMARY_MODELS")
    assert specs.WHISPER_MODELS == typing.get_args(contracts.WhisperModel)


def test_table_covers_every_catalog_entry():
    keys = {(s.role, s.name, s.backend) for s in specs.all_specs()}
    for size in specs.WHISPER_MODELS:
        for backend in specs.STT_BACKENDS:
            assert ("stt", size, backend) in keys
    for repo in specs.SUMMARY_MODELS:
        assert ("summary", repo, None) in keys
    assert ("diarization", "pyannote/speaker-diarization-community-1", None) in keys
    assert ("speaker_embedding", "speechbrain/spkrec-ecapa-voxceleb", None) in keys
    assert ("search_embedding", "BAAI/bge-m3", None) in keys


def test_every_spec_has_required_files_and_unique_repo():
    repos = [s.repo_id for s in specs.all_specs()]
    assert len(repos) == len(set(repos))
    for s in specs.all_specs():
        assert s.required, s


def test_spec_for_and_by_repo():
    s = specs.spec_for("stt", "large-v3-turbo", "mlx")
    assert s is not None and s.repo_id == "mlx-community/whisper-large-v3-turbo"
    assert specs.spec_for("stt", "large-v3-turbo", "nope") is None
    assert specs.specs_by_repo()["BAAI/bge-m3"].revision == specs.PINNED_REVISIONS["BAAI/bge-m3"]


def test_read_literal_reads_module_and_function_scope(tmp_path):
    src = tmp_path / "utils.py"
    src.write_text(
        "_MODELS = {'small': 'Org/fw-small', 'large-v3-turbo': 'other/turbo'}\n"
        "def download_model(x):\n"
        "    allow_patterns = ['config.json', 'model.bin']\n"
        "    return allow_patterns\n"
    )
    assert specs.read_literal(str(src), "_MODELS") == {
        "small": "Org/fw-small",
        "large-v3-turbo": "other/turbo",
    }
    assert specs.read_literal(str(src), "allow_patterns", function="download_model") == [
        "config.json",
        "model.bin",
    ]
    assert specs.read_literal(str(src), "missing") is None
    assert specs.read_literal(str(tmp_path / "nope.py"), "_MODELS") is None


def test_faster_repo_id_falls_back_to_size(monkeypatch):
    specs._faster_models.cache_clear()
    monkeypatch.setattr(specs, "_faster_utils_path", lambda: None)
    try:
        assert specs.faster_repo_id("small") == "small"
        assert specs.faster_repo_id("Org/custom") == "Org/custom"
    finally:
        specs._faster_models.cache_clear()


def test_importing_specs_stays_light():
    """부모가 import해도 무거운 모듈이 따라오지 않는다 (스펙 §4.1)."""
    code = (
        "import sys\n"
        "from damwha_worker.models import specs\n"
        "specs.all_specs()\n"
        "bad = [m for m in ('faster_whisper', 'huggingface_hub', 'torch', 'mlx', 'ctranslate2')"
        " if m in sys.modules]\n"
        "print(','.join(bad))\n"
    )
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == ""


def _lib_source(module: str, rel: str) -> str | None:
    spec = importlib.util.find_spec(module)
    if spec is None or spec.origin is None:
        return None
    return str(Path(spec.origin).parent / rel)


def test_faster_allow_patterns_match_library_source():
    path = _lib_source("faster_whisper", "utils.py")
    if path is None:
        pytest.skip("faster_whisper 없음 — `pnpm worker:sync` 뒤 다시 돌린다 (D1-C4 전제)")
    lit = specs.read_literal(path, "allow_patterns", function="download_model")
    assert tuple(lit) == specs.FASTER_WHISPER_ALLOW


def test_mlx_lm_allow_patterns_match_library_source():
    path = _lib_source("mlx_lm", "utils.py")
    if path is None:
        pytest.skip("mlx_lm 없음 — `pnpm worker:sync` 뒤 다시 돌린다 (D1-C4 전제)")
    src = Path(path).read_text()
    # `allow_patterns = allow_patterns or [ ... ]` — BoolOp라 literal_eval 대상이 오른쪽 리스트다.
    m = re.search(r"allow_patterns = allow_patterns or (\[.*?\])", src, re.S)
    assert m, "mlx_lm _download의 기본 패턴 모양이 바뀌었다 — 명세를 다시 확인한다"
    import ast

    assert tuple(ast.literal_eval(m.group(1))) == specs.MLX_LM_ALLOW


def test_faster_repo_id_reads_library_table_when_present():
    if _lib_source("faster_whisper", "utils.py") is None:
        pytest.skip("faster_whisper 없음")
    specs._faster_models.cache_clear()
    assert specs.faster_repo_id("large-v3-turbo") == "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
    assert specs.faster_repo_id("small") == "Systran/faster-whisper-small"
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_model_specs.py -q` (루트에서. `worker:test`가 `--directory be/worker`로 cwd를 맞춘다)
Expected: FAIL — `ImportError: cannot import name 'specs'`

- [ ] **Step 3: `specs.py`를 쓴다**

`be/worker/damwha_worker/models/specs.py`:

```python
"""모델 받기 명세 표 (모델 다운로드 관리 스펙 §4.1).

미리 받기와 실제 적재가 **같은 명세**를 쓰게 하는 단일 자리다. 로더(whisper_mlx·whisper_faster·
bge_embed)가 저장소·리비전을 여기서 읽고, inventory 스캔(`cache_scan`)이 `required`로 "받음"을
판정한다.

**가볍게 둔다.** worker 부모(inventory 스레드)와 모델 extra가 없는 테스트 가상환경이 이 모듈을
import한다 — `huggingface_hub`·`faster_whisper`·torch·mlx를 import하지 않는다. faster-whisper의
크기→저장소 표는 베끼지 않고(turbo가 `mobiuslabsgmbh/…`인 예외를 손으로 옮기면 조용히 갈린다)
라이브러리 **소스를 ast로 읽는다.** `faster_whisper`를 import하면 `__init__`이 transcribe를 거쳐
ctranslate2·av·torch를 끌어온다(부모 RSS +248 MB, 2026-09-25 리뷰 실측).

목록(`WHISPER_MODELS`·`SUMMARY_MODELS`)의 원본은 `packages/contracts`다. worker는 TS를 import할 수
없어 사본을 두고, `tests/test_model_specs.py`가 그 파일을 읽어 대조한다.

`approx_bytes`는 2026-09-25 HF API의 파일 크기 합(명세의 `allow_patterns`로 거른 것)이다. "약 X GB"
표시에만 쓰고, 받을 때의 필요량은 `downloads._needed_bytes`가 다시 잰다.
"""

from __future__ import annotations

import ast
import functools
import importlib.util
import os
from dataclasses import dataclass

WHISPER_MODELS: tuple[str, ...] = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")
SUMMARY_MODELS: tuple[str, ...] = (
    "mlx-community/Qwen3.5-4B-8bit",
    "mlx-community/Qwen3.5-9B-8bit",
    "mlx-community/Qwen3.5-27B-8bit",
)
STT_BACKENDS: tuple[str, ...] = ("mlx", "faster")

DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
SPEAKER_EMBEDDING_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
SEARCH_EMBEDDING_MODEL = "BAAI/bge-m3"

# payload whisper_model → MLX로 변환된 HF 저장소 (mlx-community). 옛 `whisper_mlx._REPO`.
MLX_WHISPER_REPOS: dict[str, str] = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}
# turbo만 safetensors다(HF API 2026-09-25).
_MLX_WHISPER_WEIGHTS = {"large-v3-turbo": "weights.safetensors"}
_MLX_WHISPER_APPROX = {
    "tiny": 74_420_189,
    "base": 143_726_326,
    "small": 481_309_720,
    "medium": 1_524_927_044,
    "large-v3-turbo": 1_613_979_758,
    "large-v3": 3_083_522_487,
}

# faster-whisper `download_model`의 지역 리터럴(faster_whisper 1.2.1 utils.py). import할 수 없어
# 베낀다 — `test_faster_allow_patterns_match_library_source`가 소스와 대조한다.
FASTER_WHISPER_ALLOW: tuple[str, ...] = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)
_FASTER_APPROX = {
    "tiny": 78_203_619,
    "base": 147_882_941,
    "small": 486_212_372,
    "medium": 1_530_571_735,
    "large-v3": 3_090_835_702,
    "large-v3-turbo": 1_621_665_983,
}

# mlx_lm 0.31.3 `utils._download`의 기본 패턴. 같은 이유로 베끼고 대조 테스트를 둔다.
MLX_LM_ALLOW: tuple[str, ...] = (
    "*.json",
    "model*.safetensors",
    "*.py",
    "tokenizer.model",
    "*.tiktoken",
    "tiktoken.model",
    "*.txt",
    "*.jsonl",
    "*.jinja",
)
_SUMMARY_APPROX = {
    "mlx-community/Qwen3.5-4B-8bit": 5_163_524_489,
    "mlx-community/Qwen3.5-9B-8bit": 10_453_442_419,
    "mlx-community/Qwen3.5-27B-8bit": 29_528_168_817,
}

# 리비전 고정 (옛 `bge_embed._PINNED_REVISIONS` — 이유는 bge_embed.py 끝 주석).
PINNED_REVISIONS: dict[str, str] = {SEARCH_EMBEDDING_MODEL: "9a0624b896d81da7492a910ffa53731274b6cf3d"}
# 그 리비전에서 sentence-transformers가 실제로 받는 11개(앱 캐시 2026-09-25). 저장소 전체를 받으면
# pytorch_model.bin·onnx/까지 약 6.8 GB다.
_BGE_ALLOW: tuple[str, ...] = (
    "1_Pooling/config.json",
    "README.md",
    "config.json",
    "config_sentence_transformers.json",
    "model.safetensors",
    "modules.json",
    "sentence_bert_config.json",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
)


@dataclass(frozen=True)
class ModelSpec:
    role: str
    name: str
    backend: str | None
    repo_id: str
    revision: str | None
    allow_patterns: tuple[str, ...] | None
    required: tuple[str, ...]
    approx_bytes: int | None


def read_literal(source_path: str, name: str, *, function: str | None = None) -> object | None:
    """파이썬 소스에서 `name = <리터럴>` 대입의 값을 import 없이 읽는다. 못 찾으면 None.

    `function`을 주면 그 함수 본문 안의 대입만 본다(지역 리터럴).
    """
    try:
        with open(source_path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return None
    scope: ast.AST = tree
    if function is not None:
        found = [
            n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == function
        ]
        if not found:
            return None
        scope = found[0]
    for node in ast.walk(scope):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            try:
                return ast.literal_eval(node.value)
            except ValueError:
                return None
    return None


def _faster_utils_path() -> str | None:
    # **최상위만** find_spec한다. `faster_whisper.utils`를 찾으면 부모 패키지가 import된다.
    try:
        spec = importlib.util.find_spec("faster_whisper")
    except (ImportError, ValueError):
        return None
    if spec is None or spec.origin is None:
        return None
    return os.path.join(os.path.dirname(spec.origin), "utils.py")


@functools.lru_cache(maxsize=1)
def _faster_models() -> dict[str, str]:
    path = _faster_utils_path()
    value = read_literal(path, "_MODELS") if path else None
    return dict(value) if isinstance(value, dict) else {}


def faster_repo_id(size: str) -> str:
    """faster-whisper가 그 크기 이름으로 받는 HF 저장소. 표를 못 읽으면 이름 그대로(옛 `_repo_id` 규칙)."""
    if "/" in size:
        return size
    return _faster_models().get(size, size)


def _stt_specs() -> list[ModelSpec]:
    out: list[ModelSpec] = []
    for size in WHISPER_MODELS:
        out.append(
            ModelSpec(
                role="stt",
                name=size,
                backend="mlx",
                repo_id=MLX_WHISPER_REPOS[size],
                revision=None,
                # mlx-whisper 로더는 패턴 없이 저장소 전체를 받는다(whisper_mlx._snapshot).
                allow_patterns=None,
                required=("config.json", _MLX_WHISPER_WEIGHTS.get(size, "weights.npz")),
                approx_bytes=_MLX_WHISPER_APPROX[size],
            )
        )
        out.append(
            ModelSpec(
                role="stt",
                name=size,
                backend="faster",
                repo_id=faster_repo_id(size),
                revision=None,
                allow_patterns=FASTER_WHISPER_ALLOW,
                required=("config.json", "model.bin", "tokenizer.json"),
                approx_bytes=_FASTER_APPROX[size],
            )
        )
    return out


def _summary_specs() -> list[ModelSpec]:
    return [
        ModelSpec(
            role="summary",
            name=repo,
            backend=None,
            repo_id=repo,
            revision=None,
            allow_patterns=MLX_LM_ALLOW,
            # 가중치 shard는 인덱스의 weight_map으로 전부 요구한다(cache_scan).
            required=("config.json", "tokenizer.json", "model.safetensors.index.json"),
            approx_bytes=_SUMMARY_APPROX[repo],
        )
        for repo in SUMMARY_MODELS
    ]


def _fixed_specs() -> list[ModelSpec]:
    return [
        ModelSpec(
            role="diarization",
            name=DIARIZATION_MODEL,
            backend=None,
            repo_id=DIARIZATION_MODEL,
            revision=None,
            allow_patterns=None,
            required=(
                "config.yaml",
                "segmentation/pytorch_model.bin",
                "embedding/pytorch_model.bin",
                "plda/plda.npz",
                "plda/xvec_transform.npz",
            ),
            approx_bytes=32_800_000,
        ),
        ModelSpec(
            role="speaker_embedding",
            name=SPEAKER_EMBEDDING_MODEL,
            backend=None,
            repo_id=SPEAKER_EMBEDDING_MODEL,
            revision=None,
            allow_patterns=None,
            required=(
                "hyperparams.yaml",
                "embedding_model.ckpt",
                "mean_var_norm_emb.ckpt",
                "classifier.ckpt",
                "label_encoder.txt",
            ),
            approx_bytes=88_900_000,
        ),
        ModelSpec(
            role="search_embedding",
            name=SEARCH_EMBEDDING_MODEL,
            backend=None,
            repo_id=SEARCH_EMBEDDING_MODEL,
            revision=PINNED_REVISIONS[SEARCH_EMBEDDING_MODEL],
            allow_patterns=_BGE_ALLOW,
            required=(
                "config.json",
                "model.safetensors",
                "tokenizer.json",
                "sentencepiece.bpe.model",
                "modules.json",
                "1_Pooling/config.json",
            ),
            approx_bytes=2_293_250_249,
        ),
    ]


def all_specs() -> list[ModelSpec]:
    return _stt_specs() + _summary_specs() + _fixed_specs()


def specs_by_repo() -> dict[str, ModelSpec]:
    return {s.repo_id: s for s in all_specs()}


def spec_for(role: str, name: str, backend: str | None = None) -> ModelSpec | None:
    for s in all_specs():
        if s.role == role and s.name == name and s.backend == backend:
            return s
    return None
```

- [ ] **Step 4: 로더가 specs를 읽게 바꾼다**

`whisper_mlx.py` — `_REPO` 딕셔너리(18-26행)를 지우고 import로 바꾼다:

```python
from ..pipeline.stt_repetition import drop_repetition_loops
from .base import ProgressFn, SpeechSpan, Word, whisper_language
from .specs import MLX_WHISPER_REPOS as _REPO
```

(`MlxWhisper.__init__`은 `_REPO`를 그대로 쓴다 — 이름을 유지해 나머지 코드는 손대지 않는다.)

`whisper_faster.py` — `_repo_id` 함수(25-38행)의 본문을 specs로 위임한다(함수 이름은 호출자 때문에 유지):

```python
def _repo_id(size: str) -> str:
    """faster-whisper가 그 크기 이름으로 받는 HF 저장소 — `model_readiness`의 key다.

    풀이는 `specs.faster_repo_id` 하나가 한다(소스에서 표를 읽음, 베끼지 않음).
    """
    from .specs import faster_repo_id

    return faster_repo_id(size)
```

`bge_embed.py` — 파일 끝 `_PINNED_REVISIONS = {...}` 한 줄을 다음으로 바꾼다(위의 긴 주석은 그대로 둔다 — 이유 설명이다):

```python
from .specs import PINNED_REVISIONS as _PINNED_REVISIONS  # noqa: E402 — 위 주석이 인용 대상이다
```

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_model_specs.py tests/test_whisper_adapters.py tests/test_offline_load.py tests/test_downloads.py -q`
Expected: PASS. `mlx_lm` 대조 테스트는 `-ra` 요약에 SKIPPED로 이유와 함께 보일 수 있다(현재 `.venv`에 mlx_lm 없음) — 실패가 아니다.

- [ ] **Step 6: lint**

Run: `uv run --directory be/worker ruff check damwha_worker tests`
Expected: `All checks passed!`

- [ ] **Step 7: 커밋** (Global Constraints의 커밋 규칙)

```bash
git add be/worker/damwha_worker/models/specs.py be/worker/damwha_worker/models/whisper_mlx.py \
  be/worker/damwha_worker/models/whisper_faster.py be/worker/damwha_worker/models/bge_embed.py \
  be/worker/tests/test_model_specs.py
git commit -m "feat(worker): 모델 받기 명세 표를 한 자리에 둔다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 2: worker 캐시 스캔 (`cache_scan.py`)

**Files:**
- Create: `be/worker/damwha_worker/models/cache_scan.py`
- Test: `be/worker/tests/test_cache_scan.py`

**Interfaces:**
- Consumes: `specs.ModelSpec` (Task 1)
- Produces:
  - `hub_cache_dir() -> str` — env `HF_HUB_CACHE` → `HF_HOME/hub` → `~/.cache/huggingface/hub`
  - `repo_folder(repo_id: str) -> str` — `"models--" + repo_id.replace("/", "--")`
  - `RepoScan` (frozen dataclass: `size_bytes: int, complete: bool`)
  - `scan_cache(root: str, specs_by_repo: dict[str, ModelSpec]) -> dict[str, RepoScan]` — 루트가 없으면 `{}`. 루트 목록 자체를 읽다 난 `OSError`(없음 제외)는 던진다.
  - `fingerprint(root: str) -> tuple[tuple[str, int], ...]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_cache_scan.py`:

```python
"""HF 캐시 직접 스캔 (스펙 §4.2). huggingface_hub 없이 캐시 구조만 안다."""

import json
import os
import time

import pytest

from damwha_worker.models import cache_scan
from damwha_worker.models.specs import ModelSpec

COMMIT = "a" * 40


def _spec(repo, required, revision=None):
    return ModelSpec("stt", "x", "mlx", repo, revision, None, tuple(required), None)


def make_repo(root, repo, files, *, commit=COMMIT, ref="main", blobs_extra=()):
    """blobs에 실파일, snapshots/<commit>/에 symlink를 만든다 — hub의 배치와 같다."""
    base = root / cache_scan.repo_folder(repo)
    (base / "blobs").mkdir(parents=True, exist_ok=True)
    snap = base / "snapshots" / commit
    for i, (rel, content) in enumerate(files.items()):
        blob = base / "blobs" / f"blob{i}-{abs(hash(rel))}"
        blob.write_bytes(content)
        link = snap / rel
        link.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(os.path.relpath(blob, link.parent), link)
    for name, content in blobs_extra:
        (base / "blobs" / name).write_bytes(content)
    if ref is not None:
        (base / "refs").mkdir(exist_ok=True)
        (base / "refs" / ref).write_text(commit)
    return base


def test_hub_cache_dir_precedence(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "a"))
    monkeypatch.setenv("HF_HOME", str(tmp_path / "b"))
    assert cache_scan.hub_cache_dir() == str(tmp_path / "a")
    monkeypatch.delenv("HF_HUB_CACHE")
    assert cache_scan.hub_cache_dir() == str(tmp_path / "b" / "hub")
    monkeypatch.delenv("HF_HOME")
    assert cache_scan.hub_cache_dir().endswith(os.path.join(".cache", "huggingface", "hub"))


def test_missing_root_is_empty(tmp_path):
    assert cache_scan.scan_cache(str(tmp_path / "nope"), {}) == {}


def test_complete_when_all_required_resolve(tmp_path):
    make_repo(tmp_path, "org/m", {"config.json": b"{}", "weights.npz": b"12345"})
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": _spec("org/m", ["config.json", "weights.npz"])})
    assert out["org/m"] == cache_scan.RepoScan(size_bytes=2 + 5, complete=True)


def test_missing_required_is_partial(tmp_path):
    make_repo(tmp_path, "org/m", {"config.json": b"{}"})
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": _spec("org/m", ["config.json", "weights.npz"])})
    assert out["org/m"].complete is False


def test_index_requires_every_shard(tmp_path):
    index = json.dumps({"weight_map": {"a": "model-00001-of-00002.safetensors",
                                       "b": "model-00002-of-00002.safetensors"}}).encode()
    spec = _spec("org/q", ["config.json", "model.safetensors.index.json"])
    make_repo(tmp_path, "org/q", {"config.json": b"{}", "model.safetensors.index.json": index,
                                   "model-00001-of-00002.safetensors": b"1"})
    assert cache_scan.scan_cache(str(tmp_path), {"org/q": spec})["org/q"].complete is False
    make_repo(tmp_path, "org/q", {"model-00002-of-00002.safetensors": b"2"})
    assert cache_scan.scan_cache(str(tmp_path), {"org/q": spec})["org/q"].complete is True


def test_leftover_incomplete_does_not_block_complete_but_counts_in_size(tmp_path):
    make_repo(tmp_path, "org/m", {"config.json": b"{}"},
              blobs_extra=[("abc.1a2b3c4d.incomplete", b"xxxx")])
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": _spec("org/m", ["config.json"])})
    assert out["org/m"] == cache_scan.RepoScan(size_bytes=2 + 4, complete=True)


def test_pinned_revision_without_refs(tmp_path):
    rev = "b" * 40
    make_repo(tmp_path, "org/pin", {"config.json": b"{}"}, commit=rev, ref=None)
    spec = _spec("org/pin", ["config.json"], revision=rev)
    assert cache_scan.scan_cache(str(tmp_path), {"org/pin": spec})["org/pin"].complete is True
    other = _spec("org/pin", ["config.json"], revision="c" * 40)
    assert cache_scan.scan_cache(str(tmp_path), {"org/pin": other})["org/pin"].complete is False


def test_ref_to_missing_snapshot_is_partial(tmp_path):
    base = make_repo(tmp_path, "org/m", {"config.json": b"{}"})
    (base / "refs" / "main").write_text("d" * 40)  # 가리키는 snapshot 폴더가 없다
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": _spec("org/m", ["config.json"])})
    assert out["org/m"].complete is False


def test_broken_symlink_is_partial(tmp_path):
    base = make_repo(tmp_path, "org/m", {"config.json": b"{}"})
    for blob in (base / "blobs").iterdir():
        blob.unlink()
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": _spec("org/m", ["config.json"])})
    assert out["org/m"] == cache_scan.RepoScan(size_bytes=0, complete=False)


def test_repo_without_spec_uses_generic_rule(tmp_path):
    make_repo(tmp_path, "other/x", {"a.bin": b"1"})
    assert cache_scan.scan_cache(str(tmp_path), {})["other/x"].complete is True
    base = make_repo(tmp_path, "other/y", {"a.bin": b"1"})
    for blob in (base / "blobs").iterdir():
        blob.unlink()
    assert cache_scan.scan_cache(str(tmp_path), {})["other/y"].complete is False


def test_scan_ignores_foreign_entries(tmp_path):
    (tmp_path / "CACHEDIR.TAG").write_text("x")
    (tmp_path / ".locks").mkdir()
    (tmp_path / "datasets--org--d").mkdir()
    (tmp_path / "models--org--m").write_text("a file, not a dir")
    make_repo(tmp_path, "org/ok", {"config.json": b"{}"})
    assert set(cache_scan.scan_cache(str(tmp_path), {})) == {"org/ok"}


def test_repo_id_with_dashes_round_trips(tmp_path):
    make_repo(tmp_path, "mlx-community/Qwen3.5-4B-8bit", {"config.json": b"{}"})
    assert "mlx-community/Qwen3.5-4B-8bit" in cache_scan.scan_cache(str(tmp_path), {})


def _bump(path):
    """mtime_ns를 확실히 바꾼다 — 같은 틱 안의 두 쓰기가 같은 mtime을 갖는 파일시스템이 있다."""
    t = time.time() + 10
    os.utime(path, (t, t))


def test_fingerprint_sees_nested_snapshot_dirs_and_ref_files(tmp_path):
    base = make_repo(tmp_path, "org/m", {"sub/dir/a.bin": b"1"})
    fp0 = cache_scan.fingerprint(str(tmp_path))
    # 하위 snapshot 디렉터리에 symlink가 생기면 그 디렉터리의 mtime만 바뀐다(APFS).
    _bump(base / "snapshots" / COMMIT / "sub" / "dir")
    fp1 = cache_scan.fingerprint(str(tmp_path))
    assert fp1 != fp0
    # refs/main을 덮어쓰면 refs/ 디렉터리가 아니라 파일의 mtime이 바뀐다.
    _bump(base / "refs" / "main")
    assert cache_scan.fingerprint(str(tmp_path)) != fp1


def test_fingerprint_sees_blob_and_repo_changes(tmp_path):
    base = make_repo(tmp_path, "org/m", {"a.bin": b"1"})
    fp0 = cache_scan.fingerprint(str(tmp_path))
    _bump(base / "blobs")
    fp1 = cache_scan.fingerprint(str(tmp_path))
    assert fp1 != fp0
    make_repo(tmp_path, "org/n", {"a.bin": b"1"})
    assert cache_scan.fingerprint(str(tmp_path)) != fp1


def test_fingerprint_of_missing_root_is_empty(tmp_path):
    assert cache_scan.fingerprint(str(tmp_path / "nope")) == ()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_cache_scan.py -q`
Expected: FAIL — `ImportError: cannot import name 'cache_scan'`

- [ ] **Step 3: `cache_scan.py`를 쓴다**

`be/worker/damwha_worker/models/cache_scan.py`:

```python
"""HF 캐시 직접 스캔 (모델 다운로드 관리 스펙 §4.2).

`huggingface_hub.scan_cache_dir`를 쓰지 않는다. hub는 기본 의존성이 아니고(models extra),
`scan_cache_dir`는 크기에서 `.incomplete`·가리키지 않는 blob을 빼고, 끊긴 symlink가 하나라도 있으면
저장소를 통째로 경고로 보내며(`partial`이 아니라 `no`가 된다), 스캔 도중 폴더가 지워지면 전체가
던진다. 여기서는 캐시 구조만 안다:

    <root>/models--<org>--<name>/{blobs/, snapshots/<commit>/…, refs/<ref>}

- 크기 = `blobs/` 안 모든 파일의 합(`.incomplete` 포함) — 실제 디스크 사용량, `du`와 맞는다.
- complete = 명세 리비전의 snapshot에서 `required`가 전부 풀리고, 인덱스가 있으면 그 shard도 전부.
  `.incomplete`는 판정에 쓰지 않는다 — 임시 파일 이름이 `<etag>.<uuid8>.incomplete`로 매번 달라
  버려진 것이 남으면 "없음" 조건은 그 모델을 영원히 `partial`로 만든다.

이 모듈은 가볍다(표준 라이브러리만) — worker 부모가 import한다.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from .specs import ModelSpec

_PREFIX = "models--"
_INDEX = "model.safetensors.index.json"


@dataclass(frozen=True)
class RepoScan:
    size_bytes: int
    complete: bool


def hub_cache_dir() -> str:
    """hub가 쓰는 것과 같은 순서: `HF_HUB_CACHE` → `HF_HOME/hub` → `~/.cache/huggingface/hub`."""
    explicit = os.environ.get("HF_HUB_CACHE")
    if explicit:
        return explicit
    home = os.environ.get("HF_HOME")
    if home:
        return os.path.join(home, "hub")
    return os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")


def repo_folder(repo_id: str) -> str:
    return _PREFIX + repo_id.replace("/", "--")


def _repo_id(folder: str) -> str:
    return "/".join(folder[len(_PREFIX):].split("--"))


def _blobs_size(repo_dir: str) -> int:
    total = 0
    try:
        with os.scandir(os.path.join(repo_dir, "blobs")) as it:
            for e in it:
                try:
                    if e.is_file(follow_symlinks=False):
                        total += e.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        return 0
    return total


def _snapshot_dir(repo_dir: str, revision: str | None) -> str | None:
    if revision is None:
        try:
            with open(os.path.join(repo_dir, "refs", "main"), encoding="utf-8") as f:
                commit = f.read().strip()
        except OSError:
            return None
    else:
        commit = revision
    path = os.path.join(repo_dir, "snapshots", commit)
    return path if os.path.isdir(path) else None


def _complete_with_spec(repo_dir: str, spec: ModelSpec) -> bool:
    snap = _snapshot_dir(repo_dir, spec.revision)
    if snap is None:
        return False
    # os.path.exists는 symlink를 따라간다 — 끊긴 링크는 False다.
    if not all(os.path.exists(os.path.join(snap, rel)) for rel in spec.required):
        return False
    index = os.path.join(snap, _INDEX)
    if _INDEX in spec.required:
        try:
            with open(index, encoding="utf-8") as f:
                shards = set(json.load(f).get("weight_map", {}).values())
        except (OSError, ValueError, AttributeError):
            return False
        if not shards or not all(os.path.exists(os.path.join(snap, s)) for s in shards):
            return False
    return True


def _complete_generic(repo_dir: str) -> bool:
    snaps = os.path.join(repo_dir, "snapshots")
    try:
        commits = [d for d in os.listdir(snaps) if os.path.isdir(os.path.join(snaps, d))]
    except OSError:
        return False
    if not commits:
        return False
    for dirpath, _dirs, files in os.walk(snaps):
        for name in files:
            if not os.path.exists(os.path.join(dirpath, name)):
                return False
    return True


def scan_cache(root: str, specs_by_repo: dict[str, ModelSpec]) -> dict[str, RepoScan]:
    """캐시의 `models--*` 저장소 전부. 루트가 없으면 빈 맵(첫 실행).

    개별 저장소를 읽다 난 예외는 그 저장소만 `complete=False`로 두고 계속한다. 루트 목록 자체를
    못 읽으면(권한 등) 던진다 — 호출자(inventory 루프)는 그때 쓰지 않고 다음 주기에 다시 본다.
    """
    try:
        names = os.listdir(root)
    except FileNotFoundError:
        return {}
    out: dict[str, RepoScan] = {}
    for folder in names:
        repo_dir = os.path.join(root, folder)
        if not folder.startswith(_PREFIX) or not os.path.isdir(repo_dir):
            continue
        repo = _repo_id(folder)
        size = _blobs_size(repo_dir)
        try:
            spec = specs_by_repo.get(repo)
            complete = (
                _complete_with_spec(repo_dir, spec) if spec else _complete_generic(repo_dir)
            )
        except OSError:
            complete = False
        out[repo] = RepoScan(size_bytes=size, complete=complete)
    return out


def _mtime(path: str) -> int | None:
    try:
        return os.stat(path, follow_symlinks=False).st_mtime_ns
    except OSError:
        return None


def fingerprint(root: str) -> tuple[tuple[str, int], ...]:
    """다시 스캔할 때가 됐는지 판정하는 mtime 목록. 루트가 없으면 빈 튜플.

    본다: 루트, 각 `models--*`, 그 `blobs/`, `snapshots/` **아래 모든 디렉터리**, `refs/` 안의 **파일**.
    APFS에서 `snapshots/<rev>/sub/`에 symlink가 생겨도 `snapshots/`의 mtime은 그대로고, `refs/main`을
    덮어써도 `refs/`의 mtime은 그대로다(2026-09-25 리뷰 실측). 없는 경로는 건너뛴다.
    """
    root_m = _mtime(root)
    if root_m is None:
        return ()
    items: list[tuple[str, int]] = [(".", root_m)]
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return tuple(items)
    for folder in names:
        repo_dir = os.path.join(root, folder)
        if not folder.startswith(_PREFIX) or not os.path.isdir(repo_dir):
            continue
        for rel in (folder, os.path.join(folder, "blobs")):
            m = _mtime(os.path.join(root, rel))
            if m is not None:
                items.append((rel, m))
        for sub, want_files in (("snapshots", False), ("refs", True)):
            top = os.path.join(repo_dir, sub)
            for dirpath, dirs, files in os.walk(top):
                entries = files if want_files else [""]
                if not want_files:
                    dirs.sort()
                for name in entries:
                    path = os.path.join(dirpath, name) if name else dirpath
                    m = _mtime(path)
                    if m is not None:
                        items.append((os.path.relpath(path, root), m))
    return tuple(items)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_cache_scan.py -q`
Expected: PASS (15 passed)

- [ ] **Step 5: 변이 검증** — 아래 셋을 하나씩 일부러 깨고 테스트가 빨개지는지 본 뒤 되돌린다.
  1. `_complete_with_spec`에서 shard 검사(`if _INDEX in spec.required:` 블록)를 지운다 → `test_index_requires_every_shard` FAIL.
  2. `fingerprint`에서 `snapshots` 하위 순회를 `top` 하나의 mtime으로 바꾼다 → `test_fingerprint_sees_nested_snapshot_dirs_and_ref_files` FAIL.
  3. `refs`를 `want_files=False`로 바꾼다 → 같은 테스트 FAIL.

Expected: 셋 다 FAIL, 되돌린 뒤 PASS.

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/models/cache_scan.py be/worker/tests/test_cache_scan.py
git commit -m "feat(worker): HF 캐시를 hub 없이 직접 스캔한다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 3: worker inventory 쓰기 (DB + 부모 스레드)

**Files:**
- Modify: `be/worker/damwha_worker/db/core.py` (model_readiness 절 뒤에 inventory 절 추가, 모듈 docstring의 "공유 행 둘" → "셋")
- Modify: `be/worker/damwha_worker/db/__init__.py` (재수출)
- Create: `be/worker/damwha_worker/inventory.py`
- Modify: `be/worker/damwha_worker/__main__.py:367` (스레드 시작)
- Test: `be/worker/tests/test_inventory.py`

**Interfaces:**
- Consumes: `specs.all_specs`, `specs.specs_by_repo`, `specs.WHISPER_MODELS`, `specs.STT_BACKENDS`, `specs.spec_for` (Task 1); `cache_scan.scan_cache`, `cache_scan.fingerprint`, `cache_scan.hub_cache_dir`, `cache_scan.RepoScan` (Task 2); `core.readiness_now`, `core.shared_state_enabled`
- Produces:
  - `db.MODEL_INVENTORY_KEY = "model_inventory"`
  - `db.write_model_inventory(conn, value: dict) -> None`
  - `inventory.build_inventory(root: str, *, lens_model: str | None, summary_fallback: str | None) -> dict` — 스펙 §4.2 JSON 모양
  - `inventory.run_inventory_loop(database_url: str, settings, shutdown, *, root: str | None = None, interval: float | None = None, full_rescan_seconds: float = 300.0, clock=time.monotonic, connect=None) -> None`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_inventory.py`:

```python
"""`app_setting.model_inventory` — 세 번째 공유 행 (모델 다운로드 관리 스펙 §4.2)."""

import threading

import pytest

from damwha_worker import db, inventory
from tests.test_cache_scan import make_repo

KEY = db.MODEL_INVENTORY_KEY


@pytest.fixture(autouse=True)
def _clean_rows(conn, monkeypatch):
    monkeypatch.delenv("DAMWHA_SHARED_STATE", raising=False)
    conn.execute("DELETE FROM app_setting WHERE key=%s", (KEY,))
    yield
    conn.execute("DELETE FROM app_setting WHERE key=%s", (KEY,))


def _row(conn):
    r = conn.execute("SELECT value FROM app_setting WHERE key=%s", (KEY,)).fetchone()
    return None if r is None else r["value"]


def test_write_overwrites_whole_row(conn):
    db.write_model_inventory(conn, {"scanned_at": "t1", "repos": {"a/b": {"size_bytes": 1, "complete": True}}})
    db.write_model_inventory(conn, {"scanned_at": "t2", "repos": {}})
    assert _row(conn) == {"scanned_at": "t2", "repos": {}}


def test_write_is_skipped_when_shared_state_off(conn, monkeypatch):
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")
    db.write_model_inventory(conn, {"scanned_at": "t", "repos": {}})
    assert _row(conn) is None


def test_build_inventory_shape(tmp_path):
    make_repo(tmp_path, "mlx-community/whisper-large-v3-turbo",
              {"config.json": b"{}", "weights.safetensors": b"123"})
    make_repo(tmp_path, "someone/else", {"a.bin": b"1"})
    value = inventory.build_inventory(
        str(tmp_path), lens_model="L", summary_fallback="S"
    )
    assert value["repos"]["mlx-community/whisper-large-v3-turbo"] == {"size_bytes": 5, "complete": True}
    assert value["repos"]["someone/else"]["complete"] is True
    assert {"role": "stt", "name": "small", "backend": "mlx",
            "repo_id": "mlx-community/whisper-small-mlx"} in value["resolved"]
    assert len(value["resolved"]) == 12  # 6 크기 × 2 백엔드
    assert all(r["role"] == "stt" for r in value["resolved"])
    assert value["approx"]["BAAI/bge-m3"] == 2_293_250_249
    assert value["worker_llm"] == {"lens_model": "L", "summary_fallback": "S"}
    assert isinstance(value["scanned_at"], str) and value["scanned_at"].endswith("Z")


class _Settings:
    database_url = "unused"
    poll_interval_seconds = 0.01
    lens_llm_model = "L"
    summary_llm_model = "S"


class _StopAfter:
    """루프의 `shutdown.wait`를 n번째에 참으로 만든다 — 실제로 기다리지 않는다."""

    def __init__(self, n):
        self.n = n
        self.calls = 0

    def is_set(self):
        return self.calls >= self.n

    def wait(self, _timeout):
        self.calls += 1
        return self.calls >= self.n


def _run(conn, root, *, ticks, clock, writes, fp_seq=None, monkeypatch=None):
    def connect(_url):
        class _C:
            def execute(self, *a, **k):
                writes.append(a[1][1].obj if hasattr(a[1][1], "obj") else a[1][1])
                return conn.execute(*a, **k)

            def close(self):
                pass

        return _C()

    if fp_seq is not None:
        it = iter(fp_seq)
        monkeypatch.setattr(inventory.cache_scan, "fingerprint", lambda _r: next(it))
    inventory.run_inventory_loop(
        "unused", _Settings(), _StopAfter(ticks), root=str(root), interval=0,
        clock=clock, connect=connect,
    )


def test_loop_writes_at_start_then_only_on_change_or_timeout(conn, tmp_path, monkeypatch):
    writes = []
    times = iter([0.0, 10.0, 20.0, 400.0])
    _run(conn, tmp_path, ticks=4, clock=lambda: next(times), writes=writes,
         fp_seq=[("a",), ("a",), ("b",), ("b",)], monkeypatch=monkeypatch)
    # t=0 시작(무조건), t=10 불변(건너뜀), t=20 지문 변화(씀), t=400 5분 경과(씀)
    assert len(writes) == 3


def test_loop_does_not_write_when_scan_raises(conn, tmp_path, monkeypatch):
    writes = []

    def boom(*_a, **_k):
        raise PermissionError("denied")

    monkeypatch.setattr(inventory, "build_inventory", boom)
    _run(conn, tmp_path, ticks=2, clock=lambda: 0.0, writes=writes)
    assert writes == []
    assert _row(conn) is None


def test_loop_writes_real_row(conn, tmp_path):
    make_repo(tmp_path, "BAAI/bge-m3", {"config.json": b"{}"},
              commit="9a0624b896d81da7492a910ffa53731274b6cf3d", ref=None)
    _run(conn, tmp_path, ticks=1, clock=lambda: 0.0, writes=[])
    row = _row(conn)
    assert row["repos"]["BAAI/bge-m3"] == {"size_bytes": 2, "complete": False}
    assert row["worker_llm"]["lens_model"] == "L"


def test_supervisor_main_starts_inventory_thread(monkeypatch):
    """배선 — 부모가 inventory 스레드를 띄운다."""
    from damwha_worker import __main__ as main_mod

    started = []
    real_thread = threading.Thread

    def spy(*args, target=None, **kwargs):
        started.append(target)
        return real_thread(target=lambda *a, **k: None)

    # run_supervisor_main은 SIGINT/SIGTERM 핸들러를 설치한다 — 테스트 프로세스의 핸들러를 바꾸지 않게.
    monkeypatch.setattr(main_mod.signal, "signal", lambda *a, **k: None)
    monkeypatch.setattr(main_mod.threading, "Thread", spy)
    monkeypatch.setattr(main_mod, "run_supervisor", lambda *a, **k: None)
    monkeypatch.setattr(main_mod, "log_lens_llm_health", lambda *a, **k: None)

    class S(_Settings):
        worker_id = "w"
        reaper_stale_minutes = 30
        reaper_interval_seconds = 60
        lens_llm_base_url = "http://127.0.0.1:1/v1"
        lens_llm_managed = False

    main_mod.run_supervisor_main(S(), threading.Event(), run_id=None)
    assert inventory.run_inventory_loop in started
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm worker:test -- tests/test_inventory.py -q`
Expected: FAIL — `AttributeError: module 'damwha_worker.db' has no attribute 'MODEL_INVENTORY_KEY'`

- [ ] **Step 3: DB 쓰기를 추가한다**

`be/worker/damwha_worker/db/core.py` — 모듈 docstring 7-8행을 다음으로 고친다:

```python
job 테이블 계약 밖의 공유 행 셋도 여기 둔다 — 워커 쪽(와 embed·`llm_entry`)이 쓰고 API가 읽기만 한다.
`worker_capabilities`(머신 스펙), `model_readiness`(모델 다운로드 상태, 스펙 §6.9),
`model_inventory`(받아 둔 모델 목록, 모델 다운로드 관리 스펙 §4.2)다.
```

`read_model_readiness` 함수 뒤(`class _Abort` 앞)에 추가:

```python
# ── model_inventory (모델 다운로드 관리 스펙 §4.2) ─────────────────────

MODEL_INVENTORY_KEY = "model_inventory"


def write_model_inventory(conn, value: dict) -> None:
    """캐시 스캔 스냅샷으로 행 전체를 덮어쓴다.

    writer는 worker 부모의 inventory 스레드 **하나**다(embed·`llm_entry`는 쓰지 않는다). 그래서
    merge가 필요 없고 `worker_capabilities`와 같은 덮어쓰기다. 외부 DB 모드
    (`DAMWHA_SHARED_STATE=off`)에서는 쓰지 않는다.
    """
    if not shared_state_enabled():
        return
    conn.execute(
        """
        INSERT INTO app_setting(key, value) VALUES(%s, %s)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """,
        (MODEL_INVENTORY_KEY, Jsonb(value)),
    )
```

`be/worker/damwha_worker/db/__init__.py` — 기존 core 재수출 목록에 `MODEL_INVENTORY_KEY`, `write_model_inventory`를 더한다(`MODEL_READINESS_KEY`가 재수출되는 자리와 같은 방식).

- [ ] **Step 4: `inventory.py`를 쓴다**

`be/worker/damwha_worker/inventory.py`:

```python
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
```

- [ ] **Step 5: 부모에서 스레드를 띄운다**

`be/worker/damwha_worker/__main__.py` — import 줄(16행)에 `inventory`를 더한다:

```python
from . import capabilities, console, db, inventory, runtime_report, wiring
```

367행 `threading.Thread(target=report_host_capabilities, ...)` 다음 줄에:

```python
    # 받아 둔 모델 목록 (모델 다운로드 관리 스펙 §4.2). writer는 부모의 이 스레드 하나다.
    threading.Thread(
        target=inventory.run_inventory_loop,
        args=(settings.database_url, settings, shutdown),
        daemon=True,
    ).start()
```

- [ ] **Step 6: 통과를 확인한다**

Run: `pnpm worker:test -- tests/test_inventory.py tests/test_supervisor.py tests/test_model_readiness.py -q`
Expected: PASS

- [ ] **Step 7: 전체 worker 스위트와 lint**

Run: `pnpm worker:test` → Expected: PASS(skip은 `-ra`에 이유와 함께)
Run: `uv run --directory be/worker ruff check damwha_worker tests` → Expected: `All checks passed!`

- [ ] **Step 8: 커밋**

```bash
git add be/worker/damwha_worker/db/core.py be/worker/damwha_worker/db/__init__.py \
  be/worker/damwha_worker/inventory.py be/worker/damwha_worker/__main__.py be/worker/tests/test_inventory.py
git commit -m "feat(worker): 받아 둔 모델 목록을 model_inventory에 올린다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 4: contracts 역할 목록 + be `GET /models`

**Files:**
- Modify: `packages/contracts/src/index.ts` (파일 끝에 추가)
- Create: `be/src/models/model-inventory.ts`, `be/src/models/models-view.ts`, `be/src/models/models.service.ts`, `be/src/models/models.controller.ts`, `be/src/models/models.module.ts`
- Modify: `be/src/app.module.ts` (`ModelsModule` import)
- Test: `be/test/model-inventory.spec.ts`, `be/test/models-view.spec.ts`, `be/test/models.e2e-spec.ts`

**Interfaces:**
- Consumes: worker가 쓴 `model_inventory` 행(Task 3의 JSON 모양); `ModelReadinessService.get()`·`ModelReadiness`·`ModelReadinessEntry` (`be/src/system/model-readiness.ts`); `SettingsService.getProcessingConfig(): Promise<ProcessingConfig>`; `loadEnv()`의 `DIARIZATION_MODEL`·`EMBEDDING_MODEL`·`SEARCH_EMBEDDING_MODEL`·`LENS_LLM_MODEL`
- Produces:
  - contracts: `MODEL_ROLES`, `ModelRole`, `DELETABLE_ROLES`, `STT_BACKENDS`, `SttBackend`
  - `MODEL_INVENTORY_KEY`, `ModelInventory`, `fromInventoryRow(raw: unknown): ModelInventory | null`
  - `MODEL_STALL_MS = 120_000`, `isDownloadingNow(e: ModelReadinessEntry, now: number): boolean`
  - `ModelRow`, `ModelsView`, `buildModelsView(input: ModelsViewInput): ModelsView`
  - HTTP `GET /models` → `ModelsView` (JSON, 스펙 §5.1)

- [ ] **Step 1: contracts에 역할 목록을 추가한다**

`packages/contracts/src/index.ts` 끝에:

```ts
/**
 * 모델 역할 (모델 다운로드 관리 스펙 §4.3). 모델 목록 자체는 `WHISPER_MODELS`·`SUMMARY_MODELS`이고,
 * 고정 역할(화자 분리·화자 식별·검색 임베딩)의 모델 이름은 BE env가 정한다.
 */
export const MODEL_ROLES = [
  'stt',
  'summary',
  'diarization',
  'speaker_embedding',
  'search_embedding',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** 지울 수 있는 역할. 고정 역할은 미리 받기만 된다 (Notion P2-D). */
export const DELETABLE_ROLES = ['stt', 'summary'] as const;

/** 전사 백엔드 — `devices.stt`가 gpu면 mlx, cpu면 faster (worker `models/registry.py`). */
export const STT_BACKENDS = ['mlx', 'faster'] as const;
export type SttBackend = (typeof STT_BACKENDS)[number];
```

Run: `pnpm --filter @damwha/contracts build`
Expected: 오류 없이 `dist/cjs`·`dist/esm` 갱신.

- [ ] **Step 2: 실패하는 테스트를 쓴다 — 파서**

`be/test/model-inventory.spec.ts`:

```ts
import { fromInventoryRow } from '../src/models/model-inventory';

const ROW = {
  scanned_at: '2026-09-25T10:00:00.000000Z',
  repos: { 'mlx-community/whisper-large-v3-turbo': { size_bytes: 1612345678, complete: true } },
  resolved: [
    { role: 'stt', name: 'small', backend: 'faster', repo_id: 'Systran/faster-whisper-small' },
  ],
  approx: { 'Systran/faster-whisper-small': 486212372 },
  worker_llm: { lens_model: 'mlx-community/Qwen3.5-4B-8bit', summary_fallback: 'mlx-community/Qwen3.5-4B-8bit' },
};

describe('fromInventoryRow', () => {
  it('worker가 쓴 행을 camelCase로 편다', () => {
    expect(fromInventoryRow(ROW)).toEqual({
      scannedAt: '2026-09-25T10:00:00.000000Z',
      repos: { 'mlx-community/whisper-large-v3-turbo': { sizeBytes: 1612345678, complete: true } },
      resolved: [{ role: 'stt', name: 'small', backend: 'faster', repoId: 'Systran/faster-whisper-small' }],
      approx: { 'Systran/faster-whisper-small': 486212372 },
      workerLlm: { lensModel: 'mlx-community/Qwen3.5-4B-8bit', summaryFallback: 'mlx-community/Qwen3.5-4B-8bit' },
    });
  });

  it.each([null, 3, 'x', [], {}, { repos: {} }])('읽을 수 없는 행 %p → null (던지지 않는다)', (raw) => {
    expect(fromInventoryRow(raw)).toBeNull();
  });

  it('옛/새 worker의 필드 누락·추가를 견딘다', () => {
    const v = fromInventoryRow({
      scanned_at: 't',
      repos: { 'a/b': { size_bytes: 'big', complete: true }, 'c/d': 5, 'e/f': { size_bytes: 1, complete: false } },
      resolved: [{ role: 'stt' }, 'junk'],
      extra_future_field: 1,
    });
    expect(v).toEqual({
      scannedAt: 't',
      repos: { 'e/f': { sizeBytes: 1, complete: false } },
      resolved: [],
      approx: {},
      workerLlm: { lensModel: null, summaryFallback: null },
    });
  });
});
```

- [ ] **Step 3: 파서를 쓴다**

`be/src/models/model-inventory.ts`:

```ts
import { z } from 'zod';
import { STT_BACKENDS } from '@damwha/contracts';

/**
 * `app_setting`의 **세 번째** 공유 행 (모델 다운로드 관리 스펙 §4.2). writer는 worker 부모의 inventory
 * 스레드 하나(`be/worker/damwha_worker/inventory.py`)이고 **API는 읽기 전용**이다.
 *
 * `model-readiness.ts`와 같은 규칙으로 **던지지 않는다** — 남이 쓴 jsonb라 옛/새 worker의 모양이 올
 * 수 있고, 그 하나 때문에 `GET /models`가 500이 되면 안 된다. 알아볼 수 없는 항목은 버린다.
 * `scanned_at`이 없으면 행 전체를 "아직 스캔 안 됨"(null)으로 본다.
 */
export const MODEL_INVENTORY_KEY = 'model_inventory';

export interface ModelInventory {
  scannedAt: string;
  repos: Record<string, { sizeBytes: number; complete: boolean }>;
  resolved: Array<{ role: 'stt'; name: string; backend: (typeof STT_BACKENDS)[number]; repoId: string }>;
  approx: Record<string, number>;
  workerLlm: { lensModel: string | null; summaryFallback: string | null };
}

const RepoSchema = z.object({
  size_bytes: z.number().finite().nonnegative(),
  complete: z.boolean(),
});
const ResolvedSchema = z.object({
  role: z.literal('stt'),
  name: z.string(),
  backend: z.enum(STT_BACKENDS),
  repo_id: z.string(),
});
const RowSchema = z.object({
  scanned_at: z.string(),
  repos: z.record(z.string(), z.unknown()).catch({}).default({}),
  resolved: z.array(z.unknown()).catch([]).default([]),
  approx: z.record(z.string(), z.unknown()).catch({}).default({}),
  worker_llm: z
    .object({
      lens_model: z.string().nullable().catch(null).default(null),
      summary_fallback: z.string().nullable().catch(null).default(null),
    })
    .catch({ lens_model: null, summary_fallback: null })
    .default({ lens_model: null, summary_fallback: null }),
});

export function fromInventoryRow(raw: unknown): ModelInventory | null {
  const row = RowSchema.safeParse(raw);
  if (!row.success) return null;
  const repos: ModelInventory['repos'] = {};
  for (const [repo, v] of Object.entries(row.data.repos)) {
    const r = RepoSchema.safeParse(v);
    if (r.success) repos[repo] = { sizeBytes: r.data.size_bytes, complete: r.data.complete };
  }
  const resolved: ModelInventory['resolved'] = [];
  for (const v of row.data.resolved) {
    const r = ResolvedSchema.safeParse(v);
    if (r.success) resolved.push({ role: 'stt', name: r.data.name, backend: r.data.backend, repoId: r.data.repo_id });
  }
  const approx: Record<string, number> = {};
  for (const [repo, v] of Object.entries(row.data.approx)) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) approx[repo] = v;
  }
  return {
    scannedAt: row.data.scanned_at,
    repos,
    resolved,
    approx,
    workerLlm: {
      lensModel: row.data.worker_llm.lens_model,
      summaryFallback: row.data.worker_llm.summary_fallback,
    },
  };
}
```

Run: `pnpm be test -- model-inventory` → Expected: PASS

- [ ] **Step 4: 실패하는 테스트를 쓴다 — 조립**

`be/test/models-view.spec.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildModelsView, MODEL_STALL_MS, ModelsViewInput } from '../src/models/models-view';
import { ModelInventory } from '../src/models/model-inventory';
import { EMPTY_MODEL_READINESS, ModelReadinessEntry } from '../src/system/model-readiness';

const NOW = Date.parse('2026-09-25T10:00:10.000Z');
const FIXED = {
  diarization: 'pyannote/speaker-diarization-community-1',
  speaker_embedding: 'speechbrain/spkrec-ecapa-voxceleb',
  search_embedding: 'BAAI/bge-m3',
};
const RESOLVED: ModelInventory['resolved'] = ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'].flatMap(
  (name) => [
    { role: 'stt' as const, name, backend: 'mlx' as const, repoId: `mlx/${name}` },
    { role: 'stt' as const, name, backend: 'faster' as const, repoId: `fw/${name}` },
  ],
);

function inv(over: Partial<ModelInventory> = {}): ModelInventory {
  return {
    scannedAt: '2026-09-25T10:00:00.000000Z',
    repos: {},
    resolved: RESOLVED,
    approx: { 'mlx/large-v3': 3083522487 },
    workerLlm: { lensModel: 'mlx-community/Qwen3.5-4B-8bit', summaryFallback: 'mlx-community/Qwen3.5-4B-8bit' },
    ...over,
  };
}

function input(over: Partial<ModelsViewInput> = {}): ModelsViewInput {
  return {
    config: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'gpu' }, summary_model: 'mlx-community/Qwen3.5-9B-8bit' },
    fixed: FIXED,
    lensModel: 'mlx-community/Qwen3.5-4B-8bit',
    inventory: inv(),
    readiness: EMPTY_MODEL_READINESS,
    now: NOW,
    ...over,
  };
}

function entry(over: Partial<ModelReadinessEntry>): ModelReadinessEntry {
  return {
    key: 'x', state: 'downloading', bytesDone: 1, bytesTotal: 2, startedAt: null,
    updatedAt: '2026-09-25T10:00:05.000000Z', writer: 'w', attempt: 1, error: null, errorKind: null,
    ...over,
  };
}

const find = (v: ReturnType<typeof buildModelsView>, role: string, name: string, backend: string | null = null) =>
  v.models.find((m) => m.role === role && m.name === name && m.backend === backend);

describe('buildModelsView', () => {
  it('inventory가 없으면 scannedAt null, 모든 행 unknown', () => {
    const v = buildModelsView(input({ inventory: null }));
    expect(v.scannedAt).toBeNull();
    expect(v.totalBytes).toBeNull();
    expect(v.pending).toBe(false);
    expect(v.models.every((m) => m.installed === 'unknown')).toBe(true);
  });

  it('전사: 현재 백엔드 6개 + 다른 백엔드는 받아 둔 것만', () => {
    const v = buildModelsView(input({ inventory: inv({ repos: { 'fw/small': { sizeBytes: 486, complete: true } } }) }));
    const stt = v.models.filter((m) => m.role === 'stt');
    expect(stt.map((m) => `${m.name}:${m.backend}`)).toEqual([
      'tiny:mlx', 'base:mlx', 'small:mlx', 'medium:mlx', 'large-v3:mlx', 'large-v3-turbo:mlx', 'small:faster',
    ]);
    expect(find(v, 'stt', 'small', 'faster')).toMatchObject({ installed: 'yes', sizeBytes: 486, repoId: 'fw/small' });
  });

  it('inUseFor — 전사는 이름과 백엔드가 모두 맞아야 한다', () => {
    const v = buildModelsView(input());
    expect(find(v, 'stt', 'large-v3-turbo', 'mlx')?.inUseFor).toEqual(['stt']);
    const cpu = buildModelsView(input({ config: { whisper_model: 'large-v3-turbo', devices: { diarization: 'gpu', stt: 'cpu' }, summary_model: 'mlx-community/Qwen3.5-9B-8bit' } }));
    expect(find(cpu, 'stt', 'large-v3-turbo', 'faster')?.inUseFor).toEqual(['stt']);
    expect(find(cpu, 'stt', 'large-v3-turbo', 'mlx')).toBeUndefined(); // 다른 백엔드·안 받음 → 행 없음
  });

  it('inUseFor — 요약·렌즈, 둘이 같으면 한 행에 둘 다', () => {
    const v = buildModelsView(input());
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-9B-8bit')?.inUseFor).toEqual(['summary']);
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-4B-8bit')?.inUseFor).toEqual(['lens']);
    const same = buildModelsView(input({ config: { whisper_model: 'small', devices: { diarization: 'gpu', stt: 'gpu' }, summary_model: 'mlx-community/Qwen3.5-4B-8bit' } }));
    expect(find(same, 'summary', 'mlx-community/Qwen3.5-4B-8bit')?.inUseFor).toEqual(['summary', 'lens']);
  });

  it('렌즈 모델이 SUMMARY_MODELS 밖이면 행을 하나 더 만든다 (BE env·worker 값 각각)', () => {
    const v = buildModelsView(input({
      lensModel: 'org/custom-lens',
      inventory: inv({ workerLlm: { lensModel: 'org/worker-lens', summaryFallback: null } }),
    }));
    expect(find(v, 'summary', 'org/custom-lens')).toMatchObject({ inUseFor: ['lens'], repoId: 'org/custom-lens', deletable: false });
    expect(find(v, 'summary', 'org/worker-lens')).toMatchObject({ inUseFor: ['lens'] });
  });

  it('고정 역할: 항상 fixed, 삭제 불가, repoId = 이름', () => {
    const v = buildModelsView(input());
    for (const role of ['diarization', 'speaker_embedding', 'search_embedding'] as const) {
      expect(find(v, role, FIXED[role])).toMatchObject({ inUseFor: ['fixed'], deletable: false, repoId: FIXED[role] });
    }
  });

  it('installed — no / yes / partial, approxBytes', () => {
    const v = buildModelsView(input({ inventory: inv({ repos: {
      'mlx/large-v3-turbo': { sizeBytes: 1600, complete: true },
      'mlx/medium': { sizeBytes: 100, complete: false },
    } }) }));
    expect(find(v, 'stt', 'large-v3-turbo', 'mlx')).toMatchObject({ installed: 'yes', sizeBytes: 1600 });
    expect(find(v, 'stt', 'medium', 'mlx')).toMatchObject({ installed: 'partial', sizeBytes: 100 });
    expect(find(v, 'stt', 'large-v3', 'mlx')).toMatchObject({ installed: 'no', sizeBytes: null, approxBytes: 3083522487 });
  });

  it('deletable — 삭제 가능 역할이고 안 쓸 때만', () => {
    const v = buildModelsView(input());
    expect(find(v, 'stt', 'large-v3-turbo', 'mlx')?.deletable).toBe(false);
    expect(find(v, 'stt', 'small', 'mlx')?.deletable).toBe(true);
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-27B-8bit')?.deletable).toBe(true);
    expect(find(v, 'summary', 'mlx-community/Qwen3.5-4B-8bit')?.deletable).toBe(false); // 렌즈
  });

  it('downloading — 멈춘(120초 넘은) 항목은 받는 중이 아니다', () => {
    const readiness = { updatedAt: null, entries: [
      entry({ key: 'mlx/large-v3', bytesDone: 10, bytesTotal: 30 }),
      entry({ key: 'mlx/medium', updatedAt: new Date(NOW - MODEL_STALL_MS - 1).toISOString() }),
    ] };
    const v = buildModelsView(input({ readiness }));
    expect(find(v, 'stt', 'large-v3', 'mlx')?.downloading).toEqual({ bytesDone: 10, bytesTotal: 30 });
    expect(find(v, 'stt', 'medium', 'mlx')?.downloading).toBeNull();
  });

  it('pending — 받는 중이거나, 카탈로그 repo의 readiness가 scannedAt보다 새로울 때', () => {
    expect(buildModelsView(input()).pending).toBe(false);
    const downloading = { updatedAt: null, entries: [entry({ key: 'mlx/large-v3' })] };
    expect(buildModelsView(input({ readiness: downloading })).pending).toBe(true);
    const readyAfterScan = { updatedAt: null, entries: [entry({ key: 'mlx/large-v3', state: 'ready', updatedAt: '2026-09-25T10:00:03.000000Z' })] };
    expect(buildModelsView(input({ readiness: readyAfterScan })).pending).toBe(true);
    const readyBeforeScan = { updatedAt: null, entries: [entry({ key: 'mlx/large-v3', state: 'ready', updatedAt: '2026-09-25T09:59:00.000000Z' })] };
    expect(buildModelsView(input({ readiness: readyBeforeScan })).pending).toBe(false);
    const foreign = { updatedAt: null, entries: [entry({ key: 'not/in-catalog', state: 'ready', updatedAt: '2026-09-25T10:00:03.000000Z' })] };
    expect(buildModelsView(input({ readiness: foreign })).pending).toBe(false);
  });

  it('totalBytes는 카탈로그 밖 저장소까지 합한다', () => {
    const v = buildModelsView(input({ inventory: inv({ repos: {
      'mlx/large-v3-turbo': { sizeBytes: 1000, complete: true },
      'someone/old-model': { sizeBytes: 500, complete: true },
    } }) }));
    expect(v.totalBytes).toBe(1500);
    expect(v.models.some((m) => m.repoId === 'someone/old-model')).toBe(false);
  });

  it('멈춤 상수는 fe·desktop과 같은 값이다', () => {
    const root = join(__dirname, '..', '..');
    const fe = readFileSync(join(root, 'fe/src/features/settings/lib/model-readiness.ts'), 'utf8');
    const desktop = readFileSync(join(root, 'desktop/src/services/model-readiness.ts'), 'utf8');
    expect(fe).toMatch(/MODEL_STALL_MS = 120_000/);
    expect(desktop).toMatch(/STALL_MS = 120_000/);
    expect(MODEL_STALL_MS).toBe(120_000);
  });
});
```

- [ ] **Step 5: 조립을 쓴다**

`be/src/models/models-view.ts`:

```ts
import {
  DELETABLE_ROLES,
  ModelRole,
  SUMMARY_MODELS,
  SttBackend,
  WHISPER_MODELS,
} from '@damwha/contracts';
import { ProcessingConfig } from '../settings/presets';
import { ModelReadiness, ModelReadinessEntry } from '../system/model-readiness';
import { ModelInventory } from './model-inventory';

/**
 * `GET /models`의 순수 조립 (모델 다운로드 관리 스펙 §5.1). DB·env를 모른다 — 서비스가 읽어 넘긴다.
 *
 * 멈춤 기준은 fe `MODEL_STALL_MS`·desktop `STALL_MS`와 **같은 값**이다. `fromReadinessRow`는 멈춤을
 * 판정하지 않아 여기에 세 번째 사본이 생긴다 — `test/models-view.spec.ts`가 세 파일을 대조한다.
 */
export const MODEL_STALL_MS = 120_000;

export type InUse = 'stt' | 'summary' | 'lens' | 'fixed';
export type Installed = 'yes' | 'no' | 'partial' | 'unknown';

export interface ModelRow {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
  repoId: string | null;
  inUseFor: InUse[];
  installed: Installed;
  sizeBytes: number | null;
  approxBytes: number | null;
  downloading: { bytesDone: number; bytesTotal: number } | null;
  deletable: boolean;
}

export interface ModelsView {
  scannedAt: string | null;
  totalBytes: number | null;
  pending: boolean;
  models: ModelRow[];
}

export interface ModelsViewInput {
  config: Pick<ProcessingConfig, 'whisper_model' | 'devices' | 'summary_model'>;
  fixed: { diarization: string; speaker_embedding: string; search_embedding: string };
  /** BE env `LENS_LLM_MODEL` (수동 재추출). worker 값은 inventory `workerLlm`에서 온다. */
  lensModel: string;
  inventory: ModelInventory | null;
  readiness: ModelReadiness;
  now: number;
}

export function isDownloadingNow(e: ModelReadinessEntry, now: number): boolean {
  if (e.state !== 'downloading' || e.updatedAt === null) return false;
  const t = Date.parse(e.updatedAt);
  // 읽을 수 없는 시각은 "받는 중"이 아니다 — 진행 표시가 영영 남지 않게(fe와 같은 규칙).
  return !Number.isNaN(t) && now - t <= MODEL_STALL_MS;
}

const backendOf = (stt: 'cpu' | 'gpu'): SttBackend => (stt === 'gpu' ? 'mlx' : 'faster');

export function buildModelsView(input: ModelsViewInput): ModelsView {
  const { config, fixed, inventory, readiness, now } = input;
  const current = backendOf(config.devices.stt);
  const lensModels = [...new Set([input.lensModel, inventory?.workerLlm.lensModel].filter((x): x is string => !!x))];
  const readinessByKey = new Map(readiness.entries.map((e) => [e.key, e]));

  const resolve = (name: string, backend: SttBackend): string | null =>
    inventory?.resolved.find((r) => r.name === name && r.backend === backend)?.repoId ?? null;

  const row = (role: ModelRole, name: string, backend: SttBackend | null, repoId: string | null, inUseFor: InUse[]): ModelRow => {
    const repo = repoId && inventory ? inventory.repos[repoId] : undefined;
    const installed: Installed =
      !inventory || !repoId ? 'unknown' : !repo ? 'no' : repo.complete ? 'yes' : 'partial';
    const r = repoId ? readinessByKey.get(repoId) : undefined;
    return {
      role,
      name,
      backend,
      repoId,
      inUseFor,
      installed,
      sizeBytes: repo ? repo.sizeBytes : null,
      approxBytes: repoId ? inventory?.approx[repoId] ?? null : null,
      downloading: r && isDownloadingNow(r, now) ? { bytesDone: r.bytesDone, bytesTotal: r.bytesTotal } : null,
      deletable: (DELETABLE_ROLES as readonly string[]).includes(role) && inUseFor.length === 0,
    };
  };

  const models: ModelRow[] = [];
  const other: SttBackend = current === 'mlx' ? 'faster' : 'mlx';
  for (const name of WHISPER_MODELS) {
    const inUse: InUse[] = name === config.whisper_model ? ['stt'] : [];
    models.push(row('stt', name, current, resolve(name, current), inUse));
  }
  for (const name of WHISPER_MODELS) {
    const repoId = resolve(name, other);
    if (repoId && inventory?.repos[repoId]) models.push(row('stt', name, other, repoId, []));
  }
  const summaryNames = [...SUMMARY_MODELS, ...lensModels.filter((m) => !(SUMMARY_MODELS as readonly string[]).includes(m))];
  for (const name of summaryNames) {
    const inUse: InUse[] = [];
    if (name === config.summary_model) inUse.push('summary');
    if (lensModels.includes(name)) inUse.push('lens');
    models.push(row('summary', name, null, name, inUse));
  }
  models.push(row('diarization', fixed.diarization, null, fixed.diarization, ['fixed']));
  models.push(row('speaker_embedding', fixed.speaker_embedding, null, fixed.speaker_embedding, ['fixed']));
  models.push(row('search_embedding', fixed.search_embedding, null, fixed.search_embedding, ['fixed']));

  const scanned = inventory ? Date.parse(inventory.scannedAt) : NaN;
  const catalogRepos = new Set(models.map((m) => m.repoId).filter((x): x is string => !!x));
  const settling =
    !Number.isNaN(scanned) &&
    readiness.entries.some((e) => {
      if (!catalogRepos.has(e.key) || e.updatedAt === null) return false;
      const t = Date.parse(e.updatedAt);
      return !Number.isNaN(t) && t > scanned;
    });

  return {
    scannedAt: inventory?.scannedAt ?? null,
    totalBytes: inventory ? Object.values(inventory.repos).reduce((s, r) => s + r.sizeBytes, 0) : null,
    pending: models.some((m) => m.downloading !== null) || settling,
    models,
  };
}
```

Run: `pnpm be test -- models-view` → Expected: PASS

- [ ] **Step 6: 서비스·컨트롤러·모듈을 쓴다**

`be/src/models/models.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { SettingsService } from '../settings/settings.service';
import { ModelReadinessService } from '../system/model-readiness.service';
import { MODEL_INVENTORY_KEY, ModelInventory, fromInventoryRow } from './model-inventory';
import { ModelsView, buildModelsView } from './models-view';

/**
 * `GET /models`의 읽기 (모델 다운로드 관리 스펙 §5.1). `app_setting.model_inventory`·
 * `model_readiness`·처리 설정을 **읽기만** 한다 — 이 모듈에 app_setting 쓰기가 생기면 worker
 * 단일 writer 계약이 깨진다.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly settings: SettingsService,
    private readonly readiness: ModelReadinessService,
  ) {}

  async list(): Promise<ModelsView> {
    const env = loadEnv();
    const [config, readiness, inventory] = await Promise.all([
      this.settings.getProcessingConfig(),
      this.readiness.get(),
      this.readInventory(),
    ]);
    return buildModelsView({
      config,
      fixed: {
        diarization: env.DIARIZATION_MODEL,
        speaker_embedding: env.EMBEDDING_MODEL,
        search_embedding: env.SEARCH_EMBEDDING_MODEL,
      },
      lensModel: env.LENS_LLM_MODEL,
      inventory,
      readiness,
      now: Date.now(),
    });
  }

  /** 못 읽으면 null("아직 스캔 안 됨") — `ModelReadinessService`와 같은 조용한 폴백. */
  private async readInventory(): Promise<ModelInventory | null> {
    try {
      const r = await this.db.pool.query('SELECT value FROM app_setting WHERE key=$1', [MODEL_INVENTORY_KEY]);
      return r.rows[0] ? fromInventoryRow(r.rows[0].value) : null;
    } catch (e) {
      this.logger.warn(`could not read model inventory: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}
```

`be/src/models/models.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ModelsService } from './models.service';

@ApiTags('models')
@Controller('models')
export class ModelsController {
  constructor(private readonly service: ModelsService) {}

  @Get()
  @ApiOperation({ summary: '모델별 사용 여부·받음 여부·용량 (읽기 전용)' })
  list() {
    return this.service.list();
  }
}
```

`be/src/models/models.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SettingsModule } from '../settings/settings.module';
import { SystemModule } from '../system/system.module';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

@Module({
  imports: [DatabaseModule, SettingsModule, SystemModule],
  controllers: [ModelsController],
  providers: [ModelsService],
})
export class ModelsModule {}
```

`be/src/app.module.ts` — `SettingsModule` import 옆에 `import { ModelsModule } from './models/models.module';`를 두고 `imports` 배열의 `SystemModule` 다음에 `ModelsModule`을 넣는다.

- [ ] **Step 7: e2e 테스트를 쓰고 돌린다**

`be/test/models.e2e-spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, StartedTestDb } from './db';
import { AppModule } from '../src/app.module';

describe('GET /models', () => {
  let db: StartedTestDb;
  let app: INestApplication;
  const srv = () => app.getHttpServer();

  beforeAll(async () => {
    db = await startTestDb();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await db.reset(); await db.pool.query(`DELETE FROM app_setting WHERE key IN ('model_inventory','model_readiness')`); });
  afterAll(async () => { await app?.close(); await db?.stop(); });

  it('inventory 행이 없으면 scannedAt null, 모든 행 unknown', async () => {
    const res = await request(srv()).get('/models');
    expect(res.status).toBe(200);
    expect(res.body.scannedAt).toBeNull();
    expect(res.body.models.every((m: { installed: string }) => m.installed === 'unknown')).toBe(true);
  });

  it('worker가 쓴 inventory를 읽어 행을 만든다. API는 그 행을 쓰지 않는다', async () => {
    const value = {
      scanned_at: '2026-09-25T10:00:00.000000Z',
      repos: { 'mlx-community/whisper-large-v3-turbo': { size_bytes: 1613979758, complete: true } },
      resolved: [{ role: 'stt', name: 'large-v3-turbo', backend: 'mlx', repo_id: 'mlx-community/whisper-large-v3-turbo' }],
      approx: {},
      worker_llm: { lens_model: null, summary_fallback: null },
    };
    await db.pool.query(`INSERT INTO app_setting(key, value) VALUES('model_inventory', $1)`, [JSON.stringify(value)]);
    const res = await request(srv()).get('/models');
    const turbo = res.body.models.find((m: { name: string; backend: string }) => m.name === 'large-v3-turbo' && m.backend === 'mlx');
    expect(turbo).toMatchObject({ installed: 'yes', sizeBytes: 1613979758 });
    const after = await db.pool.query(`SELECT value FROM app_setting WHERE key='model_inventory'`);
    expect(after.rows[0].value).toEqual(value);
  });

  it('망가진 inventory 행에도 200이다', async () => {
    await db.pool.query(`INSERT INTO app_setting(key, value) VALUES('model_inventory', '"junk"')`);
    const res = await request(srv()).get('/models');
    expect(res.status).toBe(200);
    expect(res.body.scannedAt).toBeNull();
  });
});
```

> `startTestDb`의 기본 처리 설정은 `settings.e2e-spec.ts`처럼 env 폴백(`large-v3-turbo`)이다. 기본 `devices.stt`가 cpu라 turbo 행의 backend가 `faster`로 나오면, 테스트의 inventory `resolved`·`repos`를 faster 쪽(`mobiuslabsgmbh/faster-whisper-large-v3-turbo`)으로 바꿔 같은 것을 검증한다. 먼저 `GET /settings/processing` 응답의 `devices.stt`를 확인한다.

Run: `pnpm be test -- models` → Expected: PASS
Run: `pnpm be test` → Expected: 전체 PASS
Run: `pnpm be lint` → Expected: 오류 없음

- [ ] **Step 8: 변이 검증** — `buildModelsView`에서 (1) 전사 inUse의 백엔드 비교를 지운다(`inUseFor`가 다른 백엔드 행에도 붙게), (2) `settling` 계산을 `false`로 바꾼다. 각각 `models-view.spec.ts`가 FAIL하는지 보고 되돌린다.

- [ ] **Step 9: 커밋**

```bash
git add packages/contracts/src/index.ts be/src/models be/src/app.module.ts \
  be/test/model-inventory.spec.ts be/test/models-view.spec.ts be/test/models.e2e-spec.ts
git commit -m "feat(be): GET /models — 모델별 사용·받음·용량을 읽는다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 5: fe 모델 API·순수 로직

**Files:**
- Create: `fe/src/features/models/api/types.ts`, `fe/src/features/models/api/models.ts`
- Create: `fe/src/features/models/lib/format.ts`, `fe/src/features/models/lib/rows.ts`
- Modify: `fe/src/features/settings/lib/presets.ts` (`modelShortLabel` export)
- Modify: `fe/src/features/settings/api/settings.ts:57-59` (설정 저장 시 `["models"]`도 무효화)
- Test: `fe/src/features/models/api/models.test.tsx`, `fe/src/features/models/lib/format.test.ts`, `fe/src/features/models/lib/rows.test.ts`, `fe/src/features/settings/lib/presets.test.ts`(추가), `fe/src/features/settings/api/settings.test.tsx`(수정)

**Interfaces:**
- Consumes: HTTP `GET /models` → `ModelsView` (Task 4)
- Produces:
  - `ModelRow`, `ModelsView`, `Installed`, `InUse` (types.ts — BE와 같은 모양)
  - `MODELS_QUERY_KEY = ["models"] as const`, `useModels(): UseQueryResult<ModelsView>`
  - `formatBytes(n: number): string`
  - `modelShortLabel(role: string, name: string): string` (presets.ts)
  - `ROLE_TITLES: Record<ModelRole, string>`, `rowLabel(row, currentBackend): string`, `statusText(row): string`, `isVisibleByDefault(row): boolean`, `currentSttBackend(models): SttBackend | null`, `summaryLines(view): SummaryLine[]` where `SummaryLine = { label: string; value: string; status: string }`

- [ ] **Step 1: 실패하는 테스트를 쓴다 — 크기·라벨**

`fe/src/features/models/lib/format.test.ts`:

```ts
import { expect, test } from "vitest";
import { formatBytes } from "./format";

test("1000 기준, 소수 한 자리 — worker disk.py format_bytes와 같은 규칙", () => {
  expect(formatBytes(999)).toBe("999 B");
  expect(formatBytes(1000)).toBe("1.0 KB");
  expect(formatBytes(486_212_372)).toBe("486.2 MB");
  expect(formatBytes(1_613_979_758)).toBe("1.6 GB");
  expect(formatBytes(29_528_168_817)).toBe("29.5 GB");
});
```

`fe/src/features/settings/lib/presets.test.ts` 끝에 추가:

```ts
test("modelShortLabel — 셀렉트 라벨의 ' — ' 앞부분, 목록 밖은 repo 마지막 조각", () => {
  expect(modelShortLabel("stt", "large-v3-turbo")).toBe("large-v3-turbo");
  expect(modelShortLabel("stt", "tiny")).toBe("tiny");
  expect(modelShortLabel("summary", "mlx-community/Qwen3.5-9B-8bit")).toBe("qwen3.5 9B");
  expect(modelShortLabel("summary", "org/custom-lens")).toBe("custom-lens");
  expect(modelShortLabel("diarization", "pyannote/x")).toBe("x");
});
```

(파일 머리 import에 `modelShortLabel`을 더한다.)

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/models src/features/settings/lib/presets.test.ts`
Expected: FAIL — 모듈/이름 없음

- [ ] **Step 3: 크기·라벨을 쓴다**

`fe/src/features/models/lib/format.ts`:

```ts
const UNITS = ["KB", "MB", "GB", "TB"];

/**
 * 사람이 읽는 크기. **1000 기준**이다 — worker `disk.py`의 `format_bytes`와 같은 규칙이고, Finder가
 * 그렇게 보이므로 화면과 어긋나지 않는다.
 */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  let size = n;
  for (const unit of UNITS) {
    size /= 1000;
    if (size < 1000) return `${size.toFixed(1)} ${unit}`;
  }
  return `${size.toFixed(1)} TB`;
}
```

`fe/src/features/settings/lib/presets.ts` — `SUMMARY_MODEL_OPTIONS` 정의 뒤에 추가:

```ts
/**
 * 모델 카드(`features/models`)가 쓰는 짧은 이름 — 셀렉트 라벨의 " — " 앞부분이다. 라벨 Record를
 * 베끼지 않으려고 여기서 파생한다. 카탈로그 밖(렌즈 env 값 등)은 repo id의 마지막 조각이다.
 */
export function modelShortLabel(role: string, name: string): string {
  const label =
    role === "stt"
      ? WHISPER_MODEL_LABELS[name as WhisperModel]
      : role === "summary"
        ? SUMMARY_MODEL_LABELS[name as SummaryModel]
        : undefined;
  if (label) return label.split(" — ")[0];
  return name.split("/").pop() ?? name;
}
```

- [ ] **Step 4: 실패하는 테스트를 쓴다 — 행 로직**

`fe/src/features/models/lib/rows.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { ModelRow, ModelsView } from "../api/types";
import {
  currentSttBackend,
  isVisibleByDefault,
  rowLabel,
  statusText,
  summaryLines,
} from "./rows";

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt", name: "large-v3-turbo", backend: "mlx", repoId: "r", inUseFor: [],
    installed: "yes", sizeBytes: 1_613_979_758, approxBytes: null, downloading: null, deletable: true,
    ...over,
  };
}

const FIXED: ModelRow[] = [
  row({ role: "diarization", name: "pyannote/speaker-diarization-community-1", backend: null, inUseFor: ["fixed"], sizeBytes: 32_838_000, deletable: false }),
  row({ role: "speaker_embedding", name: "speechbrain/spkrec-ecapa-voxceleb", backend: null, inUseFor: ["fixed"], sizeBytes: 88_997_000, deletable: false }),
  row({ role: "search_embedding", name: "BAAI/bge-m3", backend: null, inUseFor: ["fixed"], sizeBytes: 2_293_250_249, deletable: false }),
];

function view(models: ModelRow[]): ModelsView {
  return { scannedAt: "t", totalBytes: 1, pending: false, models };
}

describe("statusText", () => {
  test.each([
    [row({ downloading: { bytesDone: 4_100_000_000, bytesTotal: 9_800_000_000 } }), "받는 중 41% · 4.1 GB / 9.8 GB"], // 41.8% → 내림
    [row({ downloading: { bytesDone: 5, bytesTotal: 0 } }), "받는 중"],
    [row({}), "받음 · 1.6 GB"],
    [row({ installed: "partial", sizeBytes: 1_100_000_000 }), "일부만 받음 · 1.1 GB"],
    [row({ installed: "no", sizeBytes: null, approxBytes: 3_083_522_487 }), "안 받음 · 약 3.1 GB"],
    [row({ installed: "no", sizeBytes: null, approxBytes: null }), "안 받음"],
    [row({ installed: "unknown", sizeBytes: null }), "확인 중"],
  ])("%#", (r, text) => {
    expect(statusText(r)).toBe(text);
  });
});

test("rowLabel — 다른 백엔드 전사 모델에 CPU용/GPU용", () => {
  expect(rowLabel(row({ name: "small", backend: "faster" }), "mlx")).toBe("small · CPU용");
  expect(rowLabel(row({ name: "small", backend: "mlx" }), "faster")).toBe("small · GPU용");
  expect(rowLabel(row({ name: "small", backend: "mlx" }), "mlx")).toBe("small");
  expect(rowLabel(FIXED[1], "mlx")).toBe("화자 식별 모델");
  expect(rowLabel(row({ role: "summary", name: "mlx-community/Qwen3.5-9B-8bit", backend: null }), "mlx")).toBe("qwen3.5 9B");
});

test("isVisibleByDefault — 사용 중·받음·일부·받는 중·고정만", () => {
  expect(isVisibleByDefault(row({ installed: "no" }))).toBe(false);
  expect(isVisibleByDefault(row({ installed: "no", inUseFor: ["stt"] }))).toBe(true);
  expect(isVisibleByDefault(row({ installed: "partial" }))).toBe(true);
  expect(isVisibleByDefault(row({ installed: "no", downloading: { bytesDone: 1, bytesTotal: 2 } }))).toBe(true);
  expect(isVisibleByDefault(row({ installed: "unknown", role: "diarization", backend: null }))).toBe(true);
});

test("currentSttBackend — 사용 중 전사 행의 백엔드", () => {
  expect(currentSttBackend([row({ backend: "faster", inUseFor: ["stt"] })])).toBe("faster");
  expect(currentSttBackend([row({})])).toBeNull();
});

describe("summaryLines", () => {
  const stt = row({ inUseFor: ["stt"] });
  const sum9 = row({ role: "summary", name: "mlx-community/Qwen3.5-9B-8bit", backend: null, inUseFor: ["summary"], installed: "no", sizeBytes: null, approxBytes: 10_453_442_419 });
  const lens4 = row({ role: "summary", name: "mlx-community/Qwen3.5-4B-8bit", backend: null, inUseFor: ["lens"], sizeBytes: 5_163_524_489 });

  test("전사·요약·렌즈 추출·기본 — 안 받은 줄은 처음 처리 때 받는다고 말한다", () => {
    expect(summaryLines(view([stt, sum9, lens4, ...FIXED]))).toEqual([
      { label: "전사", value: "large-v3-turbo · GPU", status: "받음 · 1.6 GB" },
      { label: "요약", value: "qwen3.5 9B", status: "안 받음 · 처음 회의를 처리할 때 받아요 (약 10.5 GB)" },
      { label: "렌즈 추출", value: "qwen3.5 4B", status: "받음 · 5.2 GB" },
      { label: "기본", value: "화자 분리 · 화자 식별 · 검색 임베딩", status: "모두 받음 · 2.4 GB" },
    ]);
  });

  test("요약과 렌즈가 같은 행이면 한 줄", () => {
    const both = row({ ...lens4, inUseFor: ["summary", "lens"] });
    const lines = summaryLines(view([stt, both, ...FIXED]));
    expect(lines.map((l) => l.label)).toEqual(["전사", "요약·렌즈 추출", "기본"]);
  });

  test("기본 모델 중 안 받은 것은 풀어 쓴다", () => {
    const fixed = [FIXED[0], { ...FIXED[1], installed: "no" as const, sizeBytes: null }, FIXED[2]];
    const last = summaryLines(view([stt, ...fixed])).at(-1);
    expect(last).toEqual({ label: "기본", value: "화자 분리 · 화자 식별 · 검색 임베딩", status: "화자 식별 모델 안 받음" });
  });

  test("CPU 전사", () => {
    const cpu = row({ backend: "faster", inUseFor: ["stt"] });
    expect(summaryLines(view([cpu, ...FIXED]))[0].value).toBe("large-v3-turbo · CPU");
  });
});
```

- [ ] **Step 5: 타입과 행 로직을 쓴다**

`fe/src/features/models/api/types.ts`:

```ts
import type { ModelRole, SttBackend } from "@damwha/contracts";

/**
 * `GET /models` 와이어 타입 — be `src/models/models-view.ts`의 `ModelsView`와 같은 모양
 * (모델 다운로드 관리 스펙 §5.1).
 */
export type InUse = "stt" | "summary" | "lens" | "fixed";
export type Installed = "yes" | "no" | "partial" | "unknown";

export interface ModelRow {
  role: ModelRole;
  name: string;
  backend: SttBackend | null;
  repoId: string | null;
  inUseFor: InUse[];
  installed: Installed;
  sizeBytes: number | null;
  approxBytes: number | null;
  downloading: { bytesDone: number; bytesTotal: number } | null;
  deletable: boolean;
}

export interface ModelsView {
  scannedAt: string | null;
  totalBytes: number | null;
  pending: boolean;
  models: ModelRow[];
}
```

`fe/src/features/models/lib/rows.ts`:

```ts
import type { ModelRole, SttBackend } from "@damwha/contracts";
import { modelShortLabel } from "@/features/settings/lib/presets";
import type { ModelRow, ModelsView } from "../api/types";
import { formatBytes } from "./format";

/**
 * 모델 카드가 행을 읽는 규칙 (모델 다운로드 관리 스펙 §6). 순수 함수만 둔다.
 *
 * 사용자에게 보이는 이름은 화면에 이미 나간 말만 쓴다 — "화자 식별"은 처리 단계 이름
 * (`pages/meeting.tsx`), "검색 임베딩 모델"은 검색 안내(`app-shell.tsx`). 서비스·라이브러리 이름은
 * 쓰지 않는다.
 */
export const ROLE_TITLES: Record<ModelRole, string> = {
  stt: "전사 모델",
  summary: "요약 모델",
  diarization: "화자 분리 모델",
  speaker_embedding: "화자 식별 모델",
  search_embedding: "검색 임베딩 모델",
};

const FIXED_SHORT: Record<string, string> = {
  diarization: "화자 분리",
  speaker_embedding: "화자 식별",
  search_embedding: "검색 임베딩",
};

const isFixed = (r: ModelRow) => r.inUseFor.includes("fixed");

export function rowLabel(r: ModelRow, current: SttBackend | null): string {
  if (isFixed(r)) return ROLE_TITLES[r.role];
  const base = modelShortLabel(r.role, r.name);
  if (r.role === "stt" && current !== null && r.backend !== current) {
    return `${base} · ${r.backend === "mlx" ? "GPU용" : "CPU용"}`;
  }
  return base;
}

export function statusText(r: ModelRow): string {
  if (r.downloading) {
    const { bytesDone, bytesTotal } = r.downloading;
    if (bytesTotal <= 0) return "받는 중";
    const pct = Math.floor((bytesDone / bytesTotal) * 100);
    return `받는 중 ${pct}% · ${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`;
  }
  switch (r.installed) {
    case "yes":
      return `받음 · ${formatBytes(r.sizeBytes ?? 0)}`;
    case "partial":
      return `일부만 받음 · ${formatBytes(r.sizeBytes ?? 0)}`;
    case "no":
      return r.approxBytes ? `안 받음 · 약 ${formatBytes(r.approxBytes)}` : "안 받음";
    default:
      return "확인 중";
  }
}

export function isVisibleByDefault(r: ModelRow): boolean {
  return (
    r.inUseFor.length > 0 ||
    r.installed === "yes" ||
    r.installed === "partial" ||
    r.downloading !== null
  );
}

export function currentSttBackend(models: ModelRow[]): SttBackend | null {
  return models.find((m) => m.role === "stt" && m.inUseFor.includes("stt"))?.backend ?? null;
}

export interface SummaryLine {
  label: string;
  value: string;
  status: string;
}

/** 요약 줄의 상태 — 안 받은 사용 중 모델은 "처음 회의를 처리할 때 받아요"를 덧붙인다. */
function inUseStatus(r: ModelRow): string {
  if (r.installed === "no" && !r.downloading) {
    const approx = r.approxBytes ? ` (약 ${formatBytes(r.approxBytes)})` : "";
    return `안 받음 · 처음 회의를 처리할 때 받아요${approx}`;
  }
  return statusText(r);
}

export function summaryLines(view: ModelsView): SummaryLine[] {
  const lines: SummaryLine[] = [];
  const stt = view.models.find((m) => m.role === "stt" && m.inUseFor.includes("stt"));
  if (stt) {
    lines.push({
      label: "전사",
      value: `${modelShortLabel("stt", stt.name)} · ${stt.backend === "mlx" ? "GPU" : "CPU"}`,
      status: inUseStatus(stt),
    });
  }
  for (const r of view.models.filter((m) => m.role === "summary")) {
    const s = r.inUseFor.includes("summary");
    const l = r.inUseFor.includes("lens");
    if (!s && !l) continue;
    lines.push({
      label: s && l ? "요약·렌즈 추출" : s ? "요약" : "렌즈 추출",
      value: modelShortLabel("summary", r.name),
      status: inUseStatus(r),
    });
  }
  // "요약"이 "렌즈 추출"보다 먼저 오게 — 같은 우선순위 안에서는 카탈로그 순서.
  const rank = (label: string) => (label.startsWith("요약") ? 0 : 1);
  const head = lines.slice(0, stt ? 1 : 0);
  const rest = lines.slice(stt ? 1 : 0).sort((a, b) => rank(a.label) - rank(b.label));
  const fixed = view.models.filter(isFixed);
  if (fixed.length > 0) {
    const missing = fixed.filter((r) => r.installed !== "yes");
    rest.push({
      label: "기본",
      value: fixed.map((r) => FIXED_SHORT[r.role] ?? ROLE_TITLES[r.role]).join(" · "),
      status:
        missing.length === 0
          ? `모두 받음 · ${formatBytes(fixed.reduce((s, r) => s + (r.sizeBytes ?? 0), 0))}`
          : missing.map((r) => `${ROLE_TITLES[r.role]} ${statusText(r)}`).join(" · "),
    });
  }
  return [...head, ...rest];
}
```

> 기대값 대조: `summaryLines` 테스트의 "화자 식별 모델 안 받음"은 `statusText`가 `approxBytes` null일 때 "안 받음"을 돌려주는 것에 기댄다. `sort`는 안정 정렬이다(ES2019+).

- [ ] **Step 6: API 훅과 무효화를 쓴다**

`fe/src/features/models/api/models.ts`:

```ts
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type { ModelsView } from "./types";

export const MODELS_QUERY_KEY = ["models"] as const;

/** 받는 중이거나 inventory 갱신을 기다리는 동안(`pending`) 다시 읽는 간격. */
const PENDING_POLL_MS = 3000;

/**
 * 모델별 사용·받음·용량 (모델 다운로드 관리 스펙 §5.1·§6.3).
 *
 * 다시 읽을지는 **서버가** 정한다(`pending`) — 멈춤 판정과 "받기는 끝났는데 inventory가 아직
 * 안 바뀜" 구간을 fe가 다시 갖지 않는다.
 */
export function useModels(): UseQueryResult<ModelsView> {
  return useQuery({
    queryKey: MODELS_QUERY_KEY,
    queryFn: async () => {
      const { data } = await apiClient.get<ModelsView>("/models");
      return data;
    },
    refetchInterval: (query) => (query.state.data?.pending ? PENDING_POLL_MS : false),
  });
}
```

`fe/src/features/models/api/models.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { useModels } from "./models";
import type { ModelsView } from "./types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const VIEW: ModelsView = { scannedAt: "t", totalBytes: 0, pending: false, models: [] };

test("GET /models를 조회한다", async () => {
  const get = vi.spyOn(apiClient, "get").mockResolvedValue({ data: VIEW } as never);
  const { result } = renderHook(() => useModels(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/models");
});

test("pending이면 3초마다 다시 읽고, 아니면 멈춘다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValueOnce({ data: { ...VIEW, pending: true } } as never)
    .mockResolvedValue({ data: VIEW } as never);
  const { result } = renderHook(() => useModels(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  await vi.advanceTimersByTimeAsync(3100);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(get).toHaveBeenCalledTimes(2);
});
```

`fe/src/features/settings/api/settings.ts` — `useUpdateProcessingSettings`의 `onSuccess`:

```ts
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["processing-settings"] });
      // "사용 중"과 요약이 저장 직후 옮겨 가게 (모델 다운로드 관리 스펙 §6.3).
      queryClient.invalidateQueries({ queryKey: ["models"] });
    },
```

`fe/src/features/settings/api/settings.test.tsx` — "useUpdateProcessingSettings가 PUT 후 설정 쿼리를 무효화한다" 테스트 끝에 추가:

```tsx
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["models"] });
```

- [ ] **Step 7: 통과·lint·타입을 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/models src/features/settings`
Expected: PASS
Run: `pnpm fe lint` → Expected: 오류 없음
Run: `pnpm --filter damwha-fe exec tsc -b` → Expected: 오류 없음

- [ ] **Step 8: 변이 검증** — `useModels`의 `refetchInterval`을 항상 `false`로 바꾸면 폴링 테스트가 FAIL하고, `summaryLines`의 "모두 받음" 조건을 `missing.length <= 1`로 바꾸면 "풀어 쓴다" 테스트가 FAIL하는지 확인하고 되돌린다.

- [ ] **Step 9: 커밋**

```bash
git add fe/src/features/models fe/src/features/settings/lib/presets.ts fe/src/features/settings/lib/presets.test.ts \
  fe/src/features/settings/api/settings.ts fe/src/features/settings/api/settings.test.tsx
git commit -m "feat(fe): 모델 상태 조회와 행 문구 규칙

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 6: fe 모델 카드 UI와 설정 페이지 배치

**Files:**
- Create: `fe/src/features/models/ui/models-card.tsx`
- Test: `fe/src/features/models/ui/models-card.test.tsx`
- Modify: `fe/src/pages/settings.tsx` (카드 배치)
- Modify: `fe/src/pages/settings.test.tsx` (`/models` 응답 추가)

**Interfaces:**
- Consumes: `useModels` (Task 5), `summaryLines`·`statusText`·`rowLabel`·`isVisibleByDefault`·`currentSttBackend`·`ROLE_TITLES`·`formatBytes` (Task 5), `Card` (`@/shared/ui/card`), `Badge` (`@/shared/ui/badge`)
- Produces: `ModelsCard` (props 없음)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`fe/src/features/models/ui/models-card.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import type { ModelRow, ModelsView } from "../api/types";
import { ModelsCard } from "./models-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function row(over: Partial<ModelRow>): ModelRow {
  return {
    role: "stt", name: "large-v3-turbo", backend: "mlx", repoId: "r", inUseFor: [],
    installed: "yes", sizeBytes: 1_613_979_758, approxBytes: null, downloading: null, deletable: true,
    ...over,
  };
}

const VIEW: ModelsView = {
  scannedAt: "2026-09-25T10:00:00.000000Z",
  totalBytes: 9_200_000_000,
  pending: false,
  models: [
    row({ inUseFor: ["stt"], deletable: false }),
    row({ name: "large-v3", installed: "no", sizeBytes: null, approxBytes: 3_083_522_487 }),
    row({ role: "summary", name: "mlx-community/Qwen3.5-4B-8bit", backend: null, inUseFor: ["summary", "lens"], sizeBytes: 5_163_524_489, deletable: false }),
    row({ role: "diarization", name: "pyannote/speaker-diarization-community-1", backend: null, inUseFor: ["fixed"], sizeBytes: 32_800_000, deletable: false }),
    row({ role: "speaker_embedding", name: "speechbrain/spkrec-ecapa-voxceleb", backend: null, inUseFor: ["fixed"], sizeBytes: 88_900_000, deletable: false }),
    row({ role: "search_embedding", name: "BAAI/bge-m3", backend: null, inUseFor: ["fixed"], sizeBytes: 2_293_250_249, deletable: false }),
  ],
};

function renderCard(view: ModelsView) {
  vi.spyOn(apiClient, "get").mockResolvedValue({ data: view } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelsCard />
    </QueryClientProvider>,
  );
}

test("요약 영역에 지금 설정에서 쓰는 모델과 합계를 보인다", async () => {
  renderCard(VIEW);
  const summary = await screen.findByRole("region", { name: "지금 설정에서 쓰는 모델" });
  expect(within(summary).getByText("large-v3-turbo · GPU")).toBeTruthy();
  expect(within(summary).getByText("요약·렌즈 추출")).toBeTruthy();
  expect(within(summary).getByText(/모두 받음/)).toBeTruthy();
  expect(screen.getByText("받은 모델 합계 9.2 GB")).toBeTruthy();
});

test("목록은 기본으로 사용 중·받은 것만, 펼치면 나머지", async () => {
  renderCard(VIEW);
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).queryByText("large-v3")).toBeNull();
  expect(within(list).getAllByText("사용 중").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "모든 모델 보기" }));
  expect(within(list).getByText("large-v3")).toBeTruthy();
  expect(within(list).getByText("안 받음 · 약 3.1 GB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "접기" })).toBeTruthy();
});

test("고정 모델은 기본 모델 묶음에 사용자 이름으로 나온다", async () => {
  renderCard(VIEW);
  const list = await screen.findByRole("region", { name: "받아 둔 모델" });
  expect(within(list).getByText("기본 모델 · 항상 사용")).toBeTruthy();
  expect(within(list).getByText("화자 식별 모델")).toBeTruthy();
  expect(within(list).queryByText(/pyannote|speechbrain|bge/i)).toBeNull();
});

test("아직 스캔 전이면 안내 문구만", async () => {
  renderCard({ scannedAt: null, totalBytes: null, pending: false, models: VIEW.models });
  expect(await screen.findByText("모델 상태를 아직 확인하지 못했어요. 작업 처리기가 준비되면 보여요.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "받아 둔 모델" })).toBeNull();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run src/features/models/ui`
Expected: FAIL — `models-card` 없음

- [ ] **Step 3: 카드를 쓴다**

`fe/src/features/models/ui/models-card.tsx`:

```tsx
import { useState } from "react";
import type { ModelRole } from "@damwha/contracts";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { useModels } from "../api/models";
import type { ModelRow } from "../api/types";
import { formatBytes } from "../lib/format";
import {
  ROLE_TITLES,
  currentSttBackend,
  isVisibleByDefault,
  rowLabel,
  statusText,
  summaryLines,
} from "../lib/rows";

const GROUPS: { title: string; roles: ModelRole[] }[] = [
  { title: ROLE_TITLES.stt, roles: ["stt"] },
  { title: ROLE_TITLES.summary, roles: ["summary"] },
  { title: "기본 모델 · 항상 사용", roles: ["diarization", "speaker_embedding", "search_embedding"] },
];

/**
 * 설정 › "모델" 카드 (모델 다운로드 관리 스펙 §6). D1은 읽기 전용이다 — 받기·삭제 버튼은 D2가 행에 붙인다.
 */
export function ModelsCard() {
  const { data } = useModels();
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">모델</h2>
        {data?.totalBytes != null && data.scannedAt !== null && (
          <span className="text-sm text-[color:var(--text-muted)]">
            받은 모델 합계 {formatBytes(data.totalBytes)}
          </span>
        )}
      </header>
      <p className="text-sm text-[color:var(--text-muted)]">
        회의를 처리할 때 쓰는 모델이에요. 처음 쓸 때 받고, 받은 뒤에는 이 Mac에 남아요.
      </p>
      {!data ? (
        <p role="status" className="text-sm text-[color:var(--text-muted)]">
          모델 상태를 불러오는 중…
        </p>
      ) : data.scannedAt === null ? (
        <p role="status" className="text-sm text-[color:var(--text-muted)]">
          모델 상태를 아직 확인하지 못했어요. 작업 처리기가 준비되면 보여요.
        </p>
      ) : (
        <>
          <section
            aria-label="지금 설정에서 쓰는 모델"
            className="flex flex-col gap-2 rounded-md border border-[color:var(--border-subtle)] p-3"
          >
            <span className="text-sm font-medium text-[color:var(--text-secondary)]">
              지금 설정에서 쓰는 모델
            </span>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {summaryLines(data).map((l) => (
                <div key={l.label} className="contents">
                  <dt className="text-[color:var(--text-muted)]">{l.label}</dt>
                  <dd className="flex flex-wrap justify-between gap-x-3 text-foreground">
                    <span>{l.value}</span>
                    <span className="text-[color:var(--text-secondary)]">{l.status}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <ModelList models={data.models} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        </>
      )}
    </Card>
  );
}

function ModelList({
  models,
  expanded,
  onToggle,
}: {
  models: ModelRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const current = currentSttBackend(models);
  const hiddenCount = models.filter((m) => !isVisibleByDefault(m)).length;
  return (
    <section aria-label="받아 둔 모델" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">받아 둔 모델</span>
        {(hiddenCount > 0 || expanded) && (
          <button
            type="button"
            onClick={onToggle}
            className="text-sm font-medium text-[color:var(--accent-text)] outline-none focus-visible:[box-shadow:var(--focus-ring)]"
          >
            {expanded ? "접기" : "모든 모델 보기"}
          </button>
        )}
      </div>
      {GROUPS.map((g) => {
        const rows = models.filter(
          (m) => g.roles.includes(m.role) && (expanded || isVisibleByDefault(m)),
        );
        if (rows.length === 0) return null;
        return (
          <div key={g.title} className="flex flex-col gap-1">
            <span className="text-xs text-[color:var(--text-muted)]">{g.title}</span>
            <ul className="flex flex-col gap-1">
              {rows.map((m) => (
                <li
                  key={`${m.role}:${m.name}:${m.backend ?? ""}`}
                  className="flex flex-wrap items-center justify-between gap-x-3 text-sm"
                >
                  <span className="flex items-center gap-2 text-foreground">
                    {rowLabel(m, current)}
                    {m.inUseFor.length > 0 && !m.inUseFor.includes("fixed") && (
                      <Badge variant="accent">사용 중</Badge>
                    )}
                  </span>
                  <span className="text-[color:var(--text-secondary)]">{statusText(m)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
```

- [ ] **Step 4: 설정 페이지에 놓는다**

`fe/src/pages/settings.tsx` — import에 `import { ModelsCard } from "@/features/models/ui/models-card";`를 더하고, `<ProcessingSettingsForm />`과 `<HfTokenSettingsSection />` 사이에 `<ModelsCard />`를 넣는다.

`fe/src/pages/settings.test.tsx` — `mockImplementation` 안, `throw` 앞에 추가:

```tsx
    if (url === "/models")
      return {
        data: { scannedAt: null, totalBytes: null, pending: false, models: [] },
      } as never;
```

그리고 기존 단언 끝에:

```tsx
  expect(await screen.findByRole("heading", { name: "모델" })).toBeTruthy();
```

- [ ] **Step 5: 통과·lint·타입을 확인한다**

Run: `pnpm --filter damwha-fe exec vitest run` → Expected: 전체 PASS
Run: `pnpm fe lint` → Expected: 오류 없음
Run: `pnpm --filter damwha-fe exec tsc -b` → Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add fe/src/features/models/ui fe/src/pages/settings.tsx fe/src/pages/settings.test.tsx
git commit -m "feat(fe): 설정에 모델 카드 — 지금 쓰는 모델과 받은 모델

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 7: 문서

**Files:**
- Create: `docs/MODELS.md`
- Modify: `README.md`, `README.ko.md` (docs 링크 목록에 한 줄), `CLAUDE.md:14-18`, `be/CLAUDE.md`, `fe/CLAUDE.md:143` 근처

- [ ] **Step 1: `docs/MODELS.md`를 쓴다** (D1 부분만 — D2의 받기·지우기 절은 D2가 채운다)

```markdown
# 모델

담화는 회의를 처리할 때 AI 모델 몇 개를 씁니다. 모델은 **처음 쓸 때** 받고, 받은 뒤에는 이 Mac에 남아
다시 받지 않습니다.

## 어디에 저장되나

- 앱: `~/Library/Application Support/Damwha/models/hub`
- 개발용 웹 실행(`pnpm worker`): 허깅페이스 기본 캐시(`~/.cache/huggingface/hub`, 또는 `HF_HOME`/`HF_HUB_CACHE`가 가리키는 곳)

## 어떤 모델을 쓰나

| 이름 | 하는 일 | 바꿀 수 있나 |
|---|---|---|
| 전사 모델 | 말을 글로 옮긴다 | 처리 설정에서 고른다. 같은 이름이라도 GPU/CPU에 따라 받는 파일이 다르다 |
| 요약 모델 | 회의를 요약한다 | 처리 설정에서 고른다 |
| 렌즈 추출 | 할 일·결정·약속을 뽑는다 | 앱 설정으로는 바꾸지 않는다(기본: 요약 모델 중 가장 작은 것) |
| 화자 분리 모델 | 누가 언제 말했는지 나눈다 | 고정 |
| 화자 식별 모델 | 나뉜 목소리를 등록된 화자와 대조한다 | 고정 |
| 검색 임베딩 모델 | 뜻이 비슷한 발언을 찾는다 | 고정 |

## 대략 용량

| 모델 | 약 |
|---|---|
| 전사 tiny / base / small / medium | 0.1 / 0.1–0.2 / 0.5 / 1.5 GB |
| 전사 large-v3-turbo / large-v3 | 1.6 / 3.1 GB |
| 요약 qwen3.5 4B / 9B / 27B | 5.2 / 10.5 / 29.5 GB |
| 화자 분리 · 화자 식별 · 검색 임베딩 | 합계 약 2.4 GB |

## 설정에서 확인하기

**설정 › 모델**에서 볼 수 있습니다.

- **지금 설정에서 쓰는 모델** — 처리 설정이 실제로 쓰는 전사·요약·렌즈 추출 모델과 기본 모델, 각각 받았는지.
  이미 줄에 선 회의는 넣을 때의 모델로 처리되므로, 설정을 막 바꾼 직후에는 둘이 다를 수 있습니다.
- **받아 둔 모델** — 받은 모델과 용량. "모든 모델 보기"를 누르면 안 받은 모델과 대략 용량도 보입니다.
- 상태: 받음 · 일부만 받음(받다가 끊김) · 안 받음 · 받는 중 · 확인 중(작업 처리기가 아직 확인 전)

Finder에서 모델 폴더를 직접 지우면 몇 분 안에 설정 화면에 반영됩니다.
```

- [ ] **Step 2: README 두 개에 링크** — 기존 docs 링크 목록(`README.md` 328행 근처)의 관례대로 `docs/MODELS.md`를 한 줄 더한다. 영어판은 "Models — where they are stored, sizes, checking status in Settings", 한국어판은 "모델 — 저장 위치, 용량, 설정에서 상태 확인".

- [ ] **Step 3: 루트 `CLAUDE.md`** — 14-18행 문단의 "the one other shared row is `app_setting.worker_capabilities`, written by the worker and read-only for the API, which is how the API reports the host Mac's spec instead of its own container's."를 다음으로 바꾼다:

```markdown
the other shared rows are three `app_setting` keys, all written on the worker
side and read-only for the API: `worker_capabilities` (the worker — how the API
reports the host Mac's spec instead of its own container's), `model_readiness`
(worker, embed and `llm_entry` — per-model download progress) and
`model_inventory` (the worker supervisor's inventory thread — which models are
in the HF cache and how big they are).
```

- [ ] **Step 4: `be/CLAUDE.md`** — 모듈 목록에 `models`(`GET /models`, `model_inventory`·`model_readiness`·처리 설정을 읽기만 한다)를, 공유 행 설명이 있는 자리에 `model_inventory`(writer: worker 부모 inventory 스레드, `be/worker/damwha_worker/inventory.py`)를 더한다. worker 절에 `models/specs.py`(받기 명세 표 — 로더와 스캔이 같은 명세를 쓴다, 부모 경량 규칙)를 한 줄로.

- [ ] **Step 5: `fe/CLAUDE.md`** — 143행 settings 문단 뒤에:

```markdown
`src/features/models/` (모델) owns the Settings › 모델 card: `api` (`useModels` — `GET /models`, polls every 3 s only while the server says `pending`), `lib` (`rows.ts` — row copy, default visibility, the "지금 설정에서 쓰는 모델" summary lines; `format.ts` — 1000-based sizes), `ui` (`ModelsCard`). Short model names come from `modelShortLabel` in `features/settings/lib/presets.ts` — do not copy the label Records. Saving processing settings invalidates `["models"]`.
```

- [ ] **Step 6: 커밋**

```bash
git add docs/MODELS.md README.md README.ko.md CLAUDE.md be/CLAUDE.md fe/CLAUDE.md
git commit -m "docs: 모델 문서와 공유 행 설명을 고친다

Claude-Session: https://claude.ai/code/session_01VzfmA4HyJ71RKYfSZzugNC"
```

---

### Task 8: 전체 검증과 실측 (D1-C1~C5)

컨트롤러(메인 세션)가 수행한다. 앱 조작은 computer-use, 비밀 입력은 사용자.

- [ ] **Step 1: 전체 스위트**

Run: `pnpm worker:test` · `pnpm be test` · `pnpm --filter damwha-fe exec vitest run` · `pnpm fe lint` · `pnpm --filter damwha-fe exec tsc -b` · `pnpm --filter damwha-desktop exec vitest run`
Expected: 모두 PASS (desktop은 코드 변경이 없지만 contracts 빌드가 바뀌었으므로 돌린다)

- [ ] **Step 2: 실제 가상환경에서 패턴 대조** — `pnpm worker:sync` 후 `pnpm worker:test -- tests/test_model_specs.py -q -ra`. Expected: skip 0, 전부 PASS. (끝나면 `pnpm worker:sync:test`로 되돌릴 필요는 없다 — 테스트는 models extra가 있어도 돈다.)

- [ ] **Step 3: graphify 갱신** — `graphify update .` (루트 CLAUDE.md 규칙)

- [ ] **Step 4: 앱 기동** — `desktop/out/`의 앱이 떠 있으면 사용자에게 종료를 요청한 뒤 dev(`pnpm dev` + worker) 또는 packaged로 띄운다.

- [ ] **Step 5: D1-C1** — 설정 › 모델에서 저장소 5개가 "받음 · 크기"로 나오는지. 각 크기를 `du -sk ~/Library/Application\ Support/Damwha/models/hub/models--*`의 KB×1024를 1000 기준으로 바꾼 값과 대조한다. 합계도 대조한다.

- [ ] **Step 6: D1-C2** — 프리셋을 표준↔가볍게로 바꿔 저장하고 요약·"사용 중" 배지가 바로 옮겨 가는지. 고급 설정에서 전사 장치만 CPU로 바꿔 전사 줄의 백엔드("· CPU")와 받음 여부가 바뀌는지. 끝나면 원래 설정으로 되돌린다.

- [ ] **Step 7: D1-C4** — 모델 종류마다(mlx 전사, faster 전사, 요약, 화자 분리, 화자 식별, 검색 임베딩) 명세로 받은 캐시가 로더의 캐시 전용 적재로 네트워크 없이 열리는지 확인한다. 이미 받은 5개는 `HF_HUB_OFFLINE=1`로 각 로더를 한 번씩 적재해 본다. 안 받은 종류(faster 전사)는 작은 크기(tiny)를 `snapshot_download(repo_id, allow_patterns=FASTER_WHISPER_ALLOW)`로 받은 뒤 같은 방식으로 확인하고, 스캔 결과가 `yes`인지 본다. 실패하면 명세를 고치고 스펙 §11 ledger에 적는다 — D2 계획의 전제다.

- [ ] **Step 8: D1-C3** — 안 받은 모델(예: 아직 캐시에 없는 mlx 전사 크기 `small`)을 쓰도록 설정을 바꾸고 짧은 회의를 처리해, 그 줄이 "받는 중 N%"로 움직이고 끝나면 "받음"으로 바뀌는지(폴링이 멈추기 전에). 끝나면 설정을 되돌린다.

- [ ] **Step 9: D1-C5** — 작은 모델 폴더 하나(예: D1-C4에서 받은 faster tiny)를 백업 후 Finder에서 지우고, 설정 화면을 다시 열어 "안 받음"이 되는지(늦어도 5분). 다른 모델을 지울 때는 반드시 백업한다.

- [ ] **Step 10: 결과 기록** — 스펙 §11 ledger와 `docs/electron-migration-roadmap.md`에 D1 실측 결과를 적는다. Notion P2-D에 "D1 완료"를 적는 것은 사용자 확인 뒤.

---

## 판정 기록 (계획 ↔ 스펙)

- **ast 패턴 대조 테스트의 skip**: 스펙 §10.1은 "라이브러리가 없는 환경에서는 skip이 아니라 실 가상환경에서 도는 표시된 테스트"라고 했다. `worker:sync:test` 가상환경에는 mlx_lm이 없어 테스트가 항상 실패하게 둘 수 없으므로, **skip하되 이유를 `-ra`에 남기고, Task 8 Step 2에서 실 가상환경으로 skip 0을 확인**하는 것으로 스펙의 의도(대조가 반드시 한 번은 돈다)를 지킨다. 스펙 §11 ledger에 옮겨 적는다.
