"""실 bge-m3 TextEmbedder. models extra에서만 import (테스트는 FakeTextEmbedder 사용)."""


class BgeM3TextEmbedder:
    def __init__(self, model_name: str = "BAAI/bge-m3") -> None:
        import sys

        # sentence-transformers 5.x는 import 시 torchcodec를 당긴다
        # (base/modality_types.py). torchcodec dylib는 FFmpeg 4~8에만 링크돼
        # Homebrew ffmpeg 9에서 RuntimeError로 죽는데, st의 except는
        # (ImportError, OSError)만 잡는다. sys.modules에 None을 심으면
        # ImportError로 바뀌어 st가 정상 흡수한다(AudioDecoder=None).
        # 텍스트 임베딩은 torchcodec 불필요 — audio_io.py 우회와 같은 뿌리.
        sys.modules.setdefault("torchcodec", None)

        from sentence_transformers import SentenceTransformer

        from .downloads import load_cache_first

        # 텍스트 임베더는 MPS를 쓰지 않는다 — 파이프라인 GPU 모델과의 메모리 경쟁
        # 회피(ECAPA가 CPU로 강제되는 것과 동일 근거). 색인은 백그라운드 job이라
        # CPU 지연이 무해하다.
        # 리비전 고정 + safetensors 한정 — 아래 _PINNED_REVISIONS의 주석을 보라 (P4-C10).
        #
        # 캐시 우선 (스펙 §6.6-b). 이 로더가 오프라인에서 **유일하게 죽던** 자리다: hub의
        # `_http_backoff_base`가 `ConnectError`에 공유 클라이언트를 닫고 같은 객체로 재시도해
        # `RuntimeError: client has been closed`를 내는데, 그 타입은 hub·transformers의 캐시 폴백
        # `except`에 걸리지 않는다. 발화 조건이 "캐시에 없는 파일 + ConnectError"이고 transformers가
        # 저장소에 없는 선택 파일(adapter_config.json)을 매번 묻기 때문에 정상 경로에서 터진다.
        # `local_files_only=True`면 그 HTTP 시도 자체가 없다 — 실측 2.1 GB 캐시에서 1.1초.
        self._model = load_cache_first(
            model_name,
            lambda local_files_only: SentenceTransformer(
                model_name,
                device="cpu",
                revision=_PINNED_REVISIONS.get(model_name),
                model_kwargs={"use_safetensors": True},
                local_files_only=local_files_only,
            ),
        )

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        vecs = self._model.encode(
            texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
        )
        return [v.tolist() for v in vecs]


# 리비전 고정 (스펙 §6.6). 위 torchcodec 우회가 14행으로 인용되므로 상수를 파일 끝에 둔다.
# 2026-09-18 확인(HF API, 토큰 없음):
# - `BAAI/bge-m3`의 main(`5617a9f…`)에는 `model.safetensors`가 없고 `pytorch_model.bin`만 있다.
# - `refs/pr/130`(`9a0624b…`, SFconvertbot "Adding `safetensors` variant of this model")은 main의
#   직계 자식이고, main의 모든 파일을 같은 oid로 가진 채 `model.safetensors`(2,271,064,456 B)
#   하나만 더한다 — 토크나이저·설정은 main과 바이트까지 같다.
# 고정하지 않으면 transformers가 main에서 safetensors를 못 찾아 `pytorch_model.bin`(2.1 GB)을
# 받고, 이어서 `Thread-auto_conversion`이 그 변환 PR을 찾아 `model.safetensors`(2.1 GB)를
# **다른 리비전으로 한 벌 더** 받는다(transformers 5.12.1 `modeling_utils.py:720-733`) — 앱
# 캐시에 스냅샷 둘·blob 둘이 생긴 원인이다. 변환 PR 커밋을 고정하면 첫 요청에서 safetensors가
# 잡혀 .bin도, 두 번째 리비전도 없다. `use_safetensors=True`는 safetensors가 없을 때 .bin으로
# 내려가지 않고 실패하게 한다.
# 표에 없는 모델은 main을 쓰되 safetensors 한정은 같다.
from .specs import PINNED_REVISIONS as _PINNED_REVISIONS  # noqa: E402 — 위 주석이 인용 대상이다
