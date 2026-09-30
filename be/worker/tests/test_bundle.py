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


def test_required_matches_desktop_checksums():
    """desktop이 싣고 대조하는 파일 목록(models-checksums.txt)과 worker가 요구하는 목록이 같다.

    둘이 갈라지면 빌드는 통과하는데 worker는 번들을 "불완전"으로 판정한다(또는 그 반대).
    """
    from pathlib import Path

    sums = Path(__file__).resolve().parents[3] / "desktop" / "scripts" / "models-checksums.txt"
    listed = [
        line.split()[1]
        for line in sums.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert sorted(listed) == sorted(bundle.diarization_required())
    assert len(listed) == len(set(listed))
