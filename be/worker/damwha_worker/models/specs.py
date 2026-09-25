"""모델 받기 명세 표 (모델 다운로드 관리 스펙 §4.1).

미리 받기와 실제 적재가 **같은 명세**를 쓰게 하는 단일 자리다. 로더(whisper_mlx·whisper_faster·
bge_embed)가 저장소·리비전을 여기서 읽고, inventory 스캔(`cache_scan`)이 `required`로 "받음"을
판정한다.

**가볍게 둔다.** worker 부모(inventory 스레드)와 모델 extra가 없는 테스트 가상환경이 이 모듈을
import한다 — `huggingface_hub`·`faster_whisper`·torch·mlx를 import하지 않는다. faster-whisper의
크기→저장소 표는 베끼지 않고(turbo가 `mobiuslabsgmbh/…`인 예외를 손으로 옮기면 조용히 갈린다)
라이브러리 **소스를 ast로 읽는다.** `faster_whisper`를 import하면 `__init__`이 transcribe를 거쳐
ctranslate2·av·torch를 끌어온다(부모 RSS +248 MB, 2026-09-25 리뷰 실측).

목록(`WHISPER_MODELS`·`SUMMARY_MODELS`)의 원본은 `packages/contracts`다. worker는 TS를 import할 수
없어 사본을 두고, `tests/test_model_specs.py`가 그 파일을 읽어 대조한다.

`approx_bytes`는 2026-09-25 HF API의 파일 크기 합(명세의 `allow_patterns`로 거른 것)이다. "약 X GB"
표시에만 쓰고, 받을 때의 필요량은 `downloads._needed_bytes`가 다시 잰다.
"""

from __future__ import annotations

import ast
import functools
import importlib.util
import os
from dataclasses import dataclass

WHISPER_MODELS: tuple[str, ...] = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")
SUMMARY_MODELS: tuple[str, ...] = (
    "mlx-community/Qwen3.5-4B-8bit",
    "mlx-community/Qwen3.5-9B-8bit",
    "mlx-community/Qwen3.5-27B-8bit",
)
STT_BACKENDS: tuple[str, ...] = ("mlx", "faster")

DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"
SPEAKER_EMBEDDING_MODEL = "speechbrain/spkrec-ecapa-voxceleb"
SEARCH_EMBEDDING_MODEL = "BAAI/bge-m3"

# payload whisper_model → MLX로 변환된 HF 저장소 (mlx-community). 옛 `whisper_mlx._REPO`.
MLX_WHISPER_REPOS: dict[str, str] = {
    "tiny": "mlx-community/whisper-tiny",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}
# turbo만 safetensors다(HF API 2026-09-25).
_MLX_WHISPER_WEIGHTS = {"large-v3-turbo": "weights.safetensors"}
_MLX_WHISPER_APPROX = {
    "tiny": 74_420_189,
    "base": 143_726_326,
    "small": 481_309_720,
    "medium": 1_524_927_044,
    "large-v3-turbo": 1_613_979_758,
    "large-v3": 3_083_522_487,
}

# faster-whisper `download_model`의 지역 리터럴(faster_whisper 1.2.1 utils.py). import할 수 없어
# 베낀다 — `test_faster_allow_patterns_match_library_source`가 소스와 대조한다.
FASTER_WHISPER_ALLOW: tuple[str, ...] = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)
_FASTER_APPROX = {
    "tiny": 78_203_619,
    "base": 147_882_941,
    "small": 486_212_372,
    "medium": 1_530_571_735,
    "large-v3": 3_090_835_702,
    "large-v3-turbo": 1_621_665_983,
}

# mlx_lm 0.31.3 `utils._download`의 기본 패턴. 같은 이유로 베끼고 대조 테스트를 둔다.
MLX_LM_ALLOW: tuple[str, ...] = (
    "*.json",
    "model*.safetensors",
    "*.py",
    "tokenizer.model",
    "*.tiktoken",
    "tiktoken.model",
    "*.txt",
    "*.jsonl",
    "*.jinja",
)
_SUMMARY_APPROX = {
    "mlx-community/Qwen3.5-4B-8bit": 5_163_524_489,
    "mlx-community/Qwen3.5-9B-8bit": 10_453_442_419,
    "mlx-community/Qwen3.5-27B-8bit": 29_528_168_817,
}

# 리비전 고정 (옛 `bge_embed._PINNED_REVISIONS` — 이유는 bge_embed.py 끝 주석).
PINNED_REVISIONS: dict[str, str] = {
    SEARCH_EMBEDDING_MODEL: "9a0624b896d81da7492a910ffa53731274b6cf3d"
}
# 그 리비전에서 sentence-transformers가 실제로 받는 11개(앱 캐시 2026-09-25). 저장소 전체를 받으면
# pytorch_model.bin·onnx/까지 약 6.8 GB다.
_BGE_ALLOW: tuple[str, ...] = (
    "1_Pooling/config.json",
    "README.md",
    "config.json",
    "config_sentence_transformers.json",
    "model.safetensors",
    "modules.json",
    "sentence_bert_config.json",
    "sentencepiece.bpe.model",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
)


@dataclass(frozen=True)
class ModelSpec:
    role: str
    name: str
    backend: str | None
    repo_id: str
    revision: str | None
    allow_patterns: tuple[str, ...] | None
    required: tuple[str, ...]
    approx_bytes: int | None


def read_literal(source_path: str, name: str, *, function: str | None = None) -> object | None:
    """파이썬 소스에서 `name = <리터럴>` 대입의 값을 import 없이 읽는다. 못 찾으면 None.

    `function`을 주면 그 함수 본문 안의 대입만 본다(지역 리터럴).
    """
    try:
        with open(source_path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return None
    scope: ast.AST = tree
    if function is not None:
        found = [
            n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == function
        ]
        if not found:
            return None
        scope = found[0]
    for node in ast.walk(scope):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == name for t in node.targets
        ):
            try:
                return ast.literal_eval(node.value)
            except ValueError:
                return None
    return None


def _faster_utils_path() -> str | None:
    # **최상위만** find_spec한다. `faster_whisper.utils`를 찾으면 부모 패키지가 import된다.
    try:
        spec = importlib.util.find_spec("faster_whisper")
    except (ImportError, ValueError):
        return None
    if spec is None or spec.origin is None:
        return None
    return os.path.join(os.path.dirname(spec.origin), "utils.py")


@functools.lru_cache(maxsize=1)
def _faster_models() -> dict[str, str]:
    path = _faster_utils_path()
    value = read_literal(path, "_MODELS") if path else None
    return dict(value) if isinstance(value, dict) else {}


def faster_repo_id(size: str) -> str:
    """faster-whisper가 그 크기 이름으로 받는 HF 저장소.

    표를 못 읽으면 이름 그대로(옛 `_repo_id` 규칙).
    """
    if "/" in size:
        return size
    return _faster_models().get(size, size)


def _stt_specs() -> list[ModelSpec]:
    out: list[ModelSpec] = []
    for size in WHISPER_MODELS:
        out.append(
            ModelSpec(
                role="stt",
                name=size,
                backend="mlx",
                repo_id=MLX_WHISPER_REPOS[size],
                revision=None,
                # mlx-whisper 로더는 패턴 없이 저장소 전체를 받는다(whisper_mlx._snapshot).
                allow_patterns=None,
                required=("config.json", _MLX_WHISPER_WEIGHTS.get(size, "weights.npz")),
                approx_bytes=_MLX_WHISPER_APPROX[size],
            )
        )
        out.append(
            ModelSpec(
                role="stt",
                name=size,
                backend="faster",
                repo_id=faster_repo_id(size),
                revision=None,
                allow_patterns=FASTER_WHISPER_ALLOW,
                required=("config.json", "model.bin", "tokenizer.json"),
                approx_bytes=_FASTER_APPROX[size],
            )
        )
    return out


def _summary_specs() -> list[ModelSpec]:
    return [
        ModelSpec(
            role="summary",
            name=repo,
            backend=None,
            repo_id=repo,
            revision=None,
            allow_patterns=MLX_LM_ALLOW,
            # 가중치 shard는 인덱스의 weight_map으로 전부 요구한다(cache_scan).
            required=("config.json", "tokenizer.json", "model.safetensors.index.json"),
            approx_bytes=_SUMMARY_APPROX[repo],
        )
        for repo in SUMMARY_MODELS
    ]


def _fixed_specs() -> list[ModelSpec]:
    return [
        ModelSpec(
            role="diarization",
            name=DIARIZATION_MODEL,
            backend=None,
            repo_id=DIARIZATION_MODEL,
            revision=None,
            allow_patterns=None,
            required=(
                "config.yaml",
                "segmentation/pytorch_model.bin",
                "embedding/pytorch_model.bin",
                "plda/plda.npz",
                "plda/xvec_transform.npz",
            ),
            approx_bytes=32_800_000,
        ),
        ModelSpec(
            role="speaker_embedding",
            name=SPEAKER_EMBEDDING_MODEL,
            backend=None,
            repo_id=SPEAKER_EMBEDDING_MODEL,
            revision=None,
            allow_patterns=None,
            required=(
                "hyperparams.yaml",
                "embedding_model.ckpt",
                "mean_var_norm_emb.ckpt",
                "classifier.ckpt",
                "label_encoder.txt",
            ),
            approx_bytes=88_900_000,
        ),
        ModelSpec(
            role="search_embedding",
            name=SEARCH_EMBEDDING_MODEL,
            backend=None,
            repo_id=SEARCH_EMBEDDING_MODEL,
            revision=PINNED_REVISIONS[SEARCH_EMBEDDING_MODEL],
            allow_patterns=_BGE_ALLOW,
            required=(
                "config.json",
                "model.safetensors",
                "tokenizer.json",
                "sentencepiece.bpe.model",
                "modules.json",
                "1_Pooling/config.json",
            ),
            approx_bytes=2_293_250_249,
        ),
    ]


def all_specs() -> list[ModelSpec]:
    return _stt_specs() + _summary_specs() + _fixed_specs()


def specs_by_repo() -> dict[str, ModelSpec]:
    return {s.repo_id: s for s in all_specs()}


def spec_for(role: str, name: str, backend: str | None = None) -> ModelSpec | None:
    for s in all_specs():
        if s.role == role and s.name == name and s.backend == backend:
            return s
    return None
