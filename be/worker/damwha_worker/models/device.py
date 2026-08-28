"""payload device('cpu'|'gpu') → 실행 디바이스 번역 (한 곳; spec §6).

gpu인데 MPS 미가용이면 PERMANENT — CPU 폴백은 payload 재현성을 깨므로 금지.
lazy HF 다운로드의 네트워크 실패는 여기 소관이 아니다(미분류 → TRANSIENT 유지).
"""

from ..errors import GPU_UNAVAILABLE, ErrorKind, WorkerError


def mps_available() -> bool:
    """MPS 실가용성. capabilities 보고와 torch_device가 같은 판정을 쓰게 하는 술어다 —
    UI가 GPU 프리셋을 열어주는 근거와 잡이 실제로 성공하는 조건이 갈리면 안 된다.

    torch import 실패는 여기서 삼키지 않는다(미분류 → TRANSIENT). 모델 extra가 없는
    워커는 GPU만이 아니라 아무 잡도 못 돌기 때문에, 그건 다른 고장이다.
    """
    import torch

    return bool(torch.backends.mps.is_available())


def torch_device(device: str) -> str:
    if device == "cpu":
        return "cpu"
    if not mps_available():
        raise WorkerError(
            GPU_UNAVAILABLE,
            "payload requests gpu but MPS is unavailable on this machine",
            ErrorKind.PERMANENT,
        )
    return "mps"
