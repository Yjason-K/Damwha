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
import time
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
        except Exception:  # noqa: BLE001
            # 저장소 하나를 읽다 난 예외(깨진 UTF-8 refs, weight_map 값이 문자열이 아닌 경우 등)는
            # 그 저장소만 partial로 두고 나머지는 계속 스캔한다(스펙 §4.2).
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

    본다: 루트, 각 `models--*`, 그 `blobs/`, `snapshots/` **아래 모든 디렉터리**,
    `refs/` 안의 **파일**. APFS에서 `snapshots/<rev>/sub/`에 symlink가 생겨도
    `snapshots/`의 mtime은 그대로고, `refs/main`을 덮어써도 `refs/`의 mtime은
    그대로다(2026-09-25 리뷰 실측). 없는 경로는 건너뛴다.
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


def clean_stale_incomplete(
    root: str, older_than_seconds: float, *, now: float | None = None
) -> int:
    """`blobs/*.incomplete` 중 mtime이 `older_than_seconds`보다 오래된 것을 지운다 (스펙 §7.5).

    받는 중인 임시 파일은 계속 쓰여 mtime이 새롭다. 오래된 것은 무진행 감시·취소·강제 종료가 버린
    스레드의 잔해다 — hub 1.20.1은 이어 받지 않으므로 남겨도 쓸모가 없고 디스크만 먹는다.
    complete 판정은 `.incomplete`를 보지 않으므로 inventory와 무관한 디스크 정리다.
    """
    now = time.time() if now is None else now
    removed = 0
    try:
        folders = os.listdir(root)
    except OSError:
        return 0
    for folder in folders:
        blobs = os.path.join(root, folder, "blobs")
        if not folder.startswith(_PREFIX) or not os.path.isdir(blobs):
            continue
        try:
            names = os.listdir(blobs)
        except OSError:
            continue
        for name in names:
            if not name.endswith(".incomplete"):
                continue
            path = os.path.join(blobs, name)
            try:
                if now - os.stat(path).st_mtime >= older_than_seconds:
                    os.remove(path)
                    removed += 1
            except OSError:
                continue
    return removed
