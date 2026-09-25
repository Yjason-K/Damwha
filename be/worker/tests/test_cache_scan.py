"""HF 캐시 직접 스캔 (스펙 §4.2). huggingface_hub 없이 캐시 구조만 안다."""

import json
import os
import time

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
    spec = _spec("org/m", ["config.json", "weights.npz"])
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": spec})
    assert out["org/m"] == cache_scan.RepoScan(size_bytes=2 + 5, complete=True)


def test_missing_required_is_partial(tmp_path):
    make_repo(tmp_path, "org/m", {"config.json": b"{}"})
    spec = _spec("org/m", ["config.json", "weights.npz"])
    out = cache_scan.scan_cache(str(tmp_path), {"org/m": spec})
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


def test_refs_with_invalid_utf8_is_partial_other_repos_still_scanned(tmp_path):
    """스펙 §4.2 리뷰 반영 — 저장소 하나를 읽다 난 예외(OSError가 아니어도)는 그 저장소만
    partial로 두고 나머지는 계속 스캔한다."""
    base = make_repo(tmp_path, "org/bad", {"config.json": b"{}"})
    (base / "refs" / "main").write_bytes(b"\xff\xfe\x00garbage")  # 깨진 UTF-8 — read()가 던진다
    make_repo(tmp_path, "org/ok", {"config.json": b"{}"})
    out = cache_scan.scan_cache(
        str(tmp_path),
        {"org/bad": _spec("org/bad", ["config.json"]), "org/ok": _spec("org/ok", ["config.json"])},
    )
    assert out["org/bad"].complete is False
    assert out["org/ok"].complete is True


def test_index_with_non_string_shard_values_is_partial_other_repos_still_scanned(tmp_path):
    """weight_map 값이 문자열이 아니면(TypeError) 그 저장소만 partial."""
    index = json.dumps({"weight_map": {"a": 1, "b": 2}}).encode()
    spec = _spec("org/badshard", ["config.json", "model.safetensors.index.json"])
    make_repo(
        tmp_path, "org/badshard",
        {"config.json": b"{}", "model.safetensors.index.json": index},
    )
    make_repo(tmp_path, "org/ok2", {"config.json": b"{}"})
    out = cache_scan.scan_cache(
        str(tmp_path), {"org/badshard": spec, "org/ok2": _spec("org/ok2", ["config.json"])}
    )
    assert out["org/badshard"].complete is False
    assert out["org/ok2"].complete is True


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


def test_clean_stale_incomplete_removes_only_old_ones(tmp_path):
    base = make_repo(tmp_path, "org/m", {"config.json": b"{}"},
                     blobs_extra=[("a.11111111.incomplete", b"x"), ("b.22222222.incomplete", b"y")])
    old = base / "blobs" / "a.11111111.incomplete"
    os.utime(old, (1000, 1000))
    fresh = base / "blobs" / "b.22222222.incomplete"
    os.utime(fresh, (1_000_000, 1_000_000))
    n = cache_scan.clean_stale_incomplete(str(tmp_path), 180, now=1_000_100)
    assert n == 1
    assert not old.exists() and fresh.exists()
    assert (base / "snapshots").exists()  # 임시 파일 말고는 건드리지 않는다


def test_clean_stale_incomplete_missing_root(tmp_path):
    assert cache_scan.clean_stale_incomplete(str(tmp_path / "nope"), 180) == 0
