"""실모델·실클라이언트 조립. 워커 자식 프로세스가 쓰는 유일한 구현이다.

모든 import를 함수 본문에 둔다. torch/pyannote/mlx는 import만으로 수 초에서 수십 초가
걸리는데, dispatch가 이 함수들을 job type에 따라 하나만 부르므로 index_meeting job은
STT 스택을 아예 건드리지 않는다. 모듈 최상단으로 올리면 그 절약이 사라진다.

테스트는 이 모듈을 쓰지 않는다 — `JobContext`에 가짜 빌더를 직접 넣는다.
"""


def build_models(payload, settings):
    from .models.registry import build_models as _build_models

    return _build_models(payload, settings)


def build_embedder(payload, settings):
    from .models.registry import build_embedder as _build_embedder

    return _build_embedder(payload, settings)


def build_live_models(payload, settings):
    from .models.registry import build_live_models as _build_live_models

    return _build_live_models(payload, settings)


def build_text_embedder(settings):
    from .models.registry import build_text_embedder as _build_text_embedder

    return _build_text_embedder(settings)


def build_lens_client(settings):
    from .lens_client import LensClient

    return LensClient(
        settings.lens_llm_base_url,
        settings.lens_llm_api_key,
        settings.lens_llm_timeout_seconds,
        settings.lens_llm_max_tokens,
    )


def build_summary_client(settings):
    from .summary_client import SummaryClient

    return SummaryClient(
        settings.lens_llm_base_url,
        settings.lens_llm_api_key,
        settings.lens_llm_timeout_seconds,
        settings.lens_llm_max_tokens,
    )
