"""이 워커가 도는 머신의 실제 스펙 — API는 이걸 직접 볼 수 없다.

API의 `detectCapabilities()`는 platform/arch를 env(`CAPABILITIES_*`)로 받아 거기서
`gpu_eligible`을 **추측**한다. 배포 이미지에서 API는 Linux 컨테이너 안이고 워커는
호스트 Mac이라 그 방법 말고는 없지만, 추측은 Rosetta python으로 깔린 워커를 걸러내지
못한다 — `CAPABILITIES_ARCH=arm64`를 그대로 통과해 UI가 GPU 프리셋을 열어주고,
업로드가 처리 도중 `gpu_unavailable`(PERMANENT)로 죽는다.

여기서 보고하는 값은 추측이 아니다. `platform.machine()`은 Rosetta 아래에서 x86_64를
돌려주고, MPS 가용성은 `torch_device`가 쓰는 바로 그 술어(`models.device.mps_available`)를
**자식 프로세스에서 실제로 호출해** 확인한다. 자식으로 미루는 이유는 부모 supervisor가
가벼워야 하기 때문이다 — torch를 부모가 import하면 프로세스 수명 내내 수백 MB를 쥔다.

보고는 `app_setting`의 `worker_capabilities` 키에 들어간다. job 테이블 계약과 달리
**단방향**(워커 write / API read)이라 TypeScript 짝은 zod 스키마 하나뿐이다.
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys

# Node의 process.arch 어휘로 맞춘다 — 같은 필드를 API가 자기 추정으로도 채우므로
# 두 출처가 다른 문자열을 쓰면 화면에 뜨는 값이 출처마다 달라진다.
_ARCH_ALIASES = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64"}

_SYSCTL_TIMEOUT_SECONDS = 5.0
# 대부분 torch import 시간이다. 콜드 캐시에서도 넉넉하게.
_PROBE_TIMEOUT_SECONDS = 120.0

_PROBE_CODE = "from damwha_worker.models.device import mps_available; print(int(mps_available()))"


def _sysctl(name: str) -> str | None:
    try:
        r = subprocess.run(
            ["sysctl", "-n", name],
            capture_output=True,
            text=True,
            timeout=_SYSCTL_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.strip() or None if r.returncode == 0 else None


def _memory_bytes() -> int | None:
    if sys.platform == "darwin":
        raw = _sysctl("hw.memsize")
        return int(raw) if raw and raw.isdigit() else None
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (OSError, ValueError):
        return None


def probe_mps() -> bool | None:
    """`torch_device`와 같은 술어를 자식 프로세스에서 호출한다. 판정 불가면 None.

    None은 torch 미설치(모델 extra 없음)나 프로브 자체 실패를 뜻한다. 그 경우 GPU
    자격을 뺏지 않고 아키텍처 판단으로 돌아간다 — 잡을 아예 못 도는 워커가 GPU
    프리셋까지 잠글 이유는 없고, 그 고장은 다른 곳에서 드러난다.
    """
    try:
        r = subprocess.run(
            [sys.executable, "-c", _PROBE_CODE],
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return {"1": True, "0": False}.get(r.stdout.strip())


def detect(worker_id: str) -> dict:
    """app_setting에 그대로 실릴 dict. 물리 메모리를 못 읽으면 보고를 포기한다.

    부분 보고(메모리 0)를 올리면 API가 그걸 진실로 받아 추천 프리셋을 엉뚱하게 잡는다 —
    아무것도 안 올려서 API가 자기 추정으로 폴백하는 편이 낫다.
    """
    memory_bytes = _memory_bytes()
    if not memory_bytes:
        raise RuntimeError("could not read physical memory size on this machine")
    machine = _ARCH_ALIASES.get(platform.machine(), platform.machine())
    # Rosetta 아래에서는 machine()이 x86_64다 — env 추측과 갈리는 지점이 이 한 줄이다.
    apple_silicon = sys.platform == "darwin" and machine == "arm64"
    mps = probe_mps()
    return {
        "worker_id": worker_id,
        "platform": sys.platform,
        "arch": machine,
        "chip": _sysctl("machdep.cpu.brand_string") if sys.platform == "darwin" else None,
        "memory_gb": round(memory_bytes / 1024**3),
        "gpu_eligible": apple_silicon if mps is None else (apple_silicon and mps),
        # 잠긴 GPU 프리셋을 psql 한 줄로 설명하기 위한 진단 흔적. API 응답엔 안 나간다.
        "gpu_probe": {True: "mps_available", False: "mps_unavailable", None: "unknown"}[mps],
    }
