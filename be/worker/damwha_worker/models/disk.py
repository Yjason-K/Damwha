"""모델 다운로드 전 디스크 여유 판정 (Electron Phase 6a 스펙 §8.1).

**세 주체가 공유한다** — worker job, embed 서비스, LLM 서버. 셋 다
`models/downloads.py`의 훅을 거치므로 판정을 여기 한 곳에 둔다. 다른 것은
실패가 도달하는 곳뿐이다: job은 `job.status='failed'`, 나머지 둘은 서비스 기동 실패.

문구는 데스크톱의 `causes.ts`가 정한 모양(`남은 용량 X, 필요한 용량 Y`)에 맞춘다.
**사본을 만들지 않는다** — 그 파일의 머리 주석이 금하는 것이다.
"""

from __future__ import annotations

import os
import shutil

from ..errors import DISK_FULL, ErrorKind, WorkerError

_UNITS = ("B", "KB", "MB", "GB", "TB")


def free_bytes(path: str) -> int:
    """`path`가 앉은 볼륨의 남은 바이트. 경로가 아직 없으면 있는 상위로 올라간다."""
    probe = path
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    return shutil.disk_usage(probe).free


def format_bytes(n: int) -> str:
    """사람이 읽는 크기. 1000 기준이다 — Finder가 그렇게 보이므로 화면과 어긋나지 않게."""
    if n < 1000:
        return f"{n} B"
    size = float(n)
    for unit in _UNITS[1:]:
        size /= 1000
        if size < 1000:
            return f"{size:.1f} {unit}"
    return f"{size:.1f} {_UNITS[-1]}"


def check_free_space(dest: str, needed: int | None) -> None:
    """여유가 `needed`보다 적으면 PERMANENT로 던진다.

    `needed`가 None이면 **점검하지 않는다.** 저장소 크기를 못 얻었다는 뜻이고,
    추정으로 막으면 받을 수 있는 것을 못 받는다.
    """
    if needed is None:
        return
    free = free_bytes(dest)
    if free >= needed:
        return
    raise WorkerError(
        DISK_FULL,
        f"디스크 공간이 부족해요 — 남은 용량 {format_bytes(free)}, "
        f"필요한 용량 {format_bytes(needed)}.",
        ErrorKind.PERMANENT,
    )
