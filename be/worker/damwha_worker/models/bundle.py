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
