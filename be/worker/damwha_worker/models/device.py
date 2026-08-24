"""payload device('cpu'|'gpu') → 실행 디바이스 번역 (한 곳; spec §6).

gpu인데 MPS 미가용이면 PERMANENT — CPU 폴백은 payload 재현성을 깨므로 금지.
lazy HF 다운로드의 네트워크 실패는 여기 소관이 아니다(미분류 → TRANSIENT 유지).
"""

from ..errors import GPU_UNAVAILABLE, ErrorKind, WorkerError


def torch_device(device: str) -> str:
    if device == "cpu":
        return "cpu"
    import torch

    if not torch.backends.mps.is_available():
        raise WorkerError(
            GPU_UNAVAILABLE,
            "payload requests gpu but MPS is unavailable on this machine",
            ErrorKind.PERMANENT,
        )
    return "mps"
