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
