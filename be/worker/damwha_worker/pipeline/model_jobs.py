"""모델 받기·삭제 job 본체 (모델 다운로드 관리 스펙 §7).

받기는 D1의 받기 명세(`models/specs.py`)로 `snapshot_download`를 부르기만 한다. 디스크 사전 점검,
진행 보고(`model_readiness`), 무진행 감시는 `models/downloads.py`의 훅이 맡는다 — 이 파일은 그 위에
취소와 job 마무리만 얹는다.
"""

from __future__ import annotations

import errno
import logging
import os
import shutil

from .. import db, errors
from ..models import cache_scan, downloads, specs
from .stage import enter_stage

log = logging.getLogger("damwha_worker")

#: 삭제 가능한 역할 (스펙 §7.3) — 고정 역할(diarization·speaker_embedding·search_embedding)은
#: 받기만 된다.
_DELETABLE = ("stt", "summary")


def _snapshot(**kwargs):
    from huggingface_hub import snapshot_download  # models extra — 부모에서는 import하지 않는다

    return snapshot_download(**kwargs)


def _download_kwargs(payload, hf_token):
    spec = specs.spec_for(payload.role, payload.name, payload.backend)
    if spec is None:
        # 명세 없는 모델(env가 고정·렌즈 모델을 표 밖 저장소로 바꾼 경우): 이름이 곧 저장소다.
        return {"repo_id": payload.name, "token": hf_token}
    kw = {"repo_id": spec.repo_id, "revision": spec.revision, "token": hf_token}
    if spec.allow_patterns is not None:
        kw["allow_patterns"] = list(spec.allow_patterns)
    return kw


def run_download_model(conn, job, payload, *, worker_id, hf_token, snapshot=None) -> str:
    job_id = job["id"]
    # 재queue된 job에 이미 취소가 찍혀 있을 수 있다 — 받기 전에 본다 (스펙 §7.1).
    if db.stop_requested(conn, job_id):
        raise downloads.DownloadCancelled(payload.name)
    enter_stage(conn, job_id, worker_id, "download_model", 0)
    kwargs = _download_kwargs(payload, hf_token)
    try:
        with downloads.cancel_when(lambda: db.stop_requested(conn, job_id)):
            (snapshot or _snapshot)(**kwargs)
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise errors.WorkerError(
                errors.DISK_FULL, "디스크 공간이 부족해요 — 받는 도중 디스크가 찼어요.",
                errors.ErrorKind.PERMANENT,
            ) from exc
        raise
    return "committed" if db.complete_job(conn, job_id, worker_id) else "lost"


def run_delete_model(conn, job, payload, *, worker_id, lens_models, summary_fallback,
                     cache_root=None) -> str:
    """전사·요약 모델 하나를 캐시에서 지운다 (스펙 §7.3). 재시도 없음 — 실패는 PERMANENT."""
    job_id = job["id"]
    if payload.role not in _DELETABLE:
        raise errors.WorkerError(
            errors.MODEL_NOT_DELETABLE, f"role {payload.role!r} cannot be deleted",
            errors.ErrorKind.PERMANENT,
        )
    enter_stage(conn, job_id, worker_id, "delete_model", 0)
    # API가 넣을 때 검사했어도 그 사이 새 job이 들어올 수 있다 — 지우기 직전에 같은
    # 함수로 다시 본다.
    users = db.model_job_refs(conn, payload.role, payload.name, payload.backend,
                              lens_models, summary_fallback, job_id)
    if users:
        raise errors.WorkerError(
            errors.MODEL_IN_USE, f"in use by {', '.join(users)}", errors.ErrorKind.PERMANENT,
        )
    spec = specs.spec_for(payload.role, payload.name, payload.backend)
    repo = spec.repo_id if spec is not None else payload.name
    root = cache_root or cache_scan.hub_cache_dir()
    path = os.path.join(root, cache_scan.repo_folder(repo))
    if os.path.isdir(path):  # 없으면 성공이다 — 결과(없음)가 같다
        shutil.rmtree(path)
    db.remove_model_readiness_key(conn, repo)
    return "committed" if db.complete_job(conn, job_id, worker_id) else "lost"
