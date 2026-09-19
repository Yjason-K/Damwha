"""캐시 우선 적재 — 로더 다섯이 네트워크보다 캐시를 먼저 본다 (스펙 §6.6-b).

Task 9의 실측이 전제를 반증했다: `SentenceTransformer`(bge-m3)는 네트워크가 끊기면 캐시가 차
있어도 hub의 닫힌 클라이언트 재사용 버그로 죽고, 먹통 네트워크에서는 `snapshot_download` 계열이
캐시가 차 있어도 무한 대기한다. 처방은 **로더마다 `local_files_only`를 먼저 주는 것**이고,
그 인자를 자기 API로 못 받는 로더(pyannote·speechbrain)는 훅이 hub 호출에 끼워 넣는다.

여기서는 네트워크도 실모델도 쓰지 않는다 — 각 로더가 부르는 라이브러리를 `sys.modules` 가짜로
바꿔 **무엇을 어떤 순서로 부르는지**만 본다. 실제 오프라인 거동은 Task 9 결과 문서 §2.4의 실측이
근거다.
"""

import sys
import types

import pytest

from damwha_worker import errors
from damwha_worker.models import downloads

hub = pytest.importorskip("huggingface_hub")
from huggingface_hub import errors as hub_errors  # noqa: E402


@pytest.fixture
def uninstall():
    yield
    downloads._uninstall()


@pytest.fixture
def hook_writes(monkeypatch):
    """훅의 지연 연결을 가짜로 바꾼다 — **이 파일은 DB를 쓰지 않는다.**

    훅을 설치하면 `_STATE.writer`가 서고, 캐시 적재 성공이 `_mark_ready`로 이어져 훅이 자기
    연결을 연다. 그 연결을 주입하지 않으면 주소가 `be/worker/.env`의 개발 DB가 된다 —
    실제로 그렇게 새 행 하나가 개발 DB에 들어갔다(`conftest.no_ambient_database` 참고).
    """
    writes = []

    class _Recorder:
        def execute(self, *args, **kwargs):
            writes.append(args)
            return None

    monkeypatch.setattr(downloads, "_open_connection", lambda: _Recorder())
    return writes


def _miss() -> Exception:
    return hub_errors.LocalEntryNotFoundError("nothing cached")


# ── 공통 헬퍼 ─────────────────────────────────────────────────────────


def test_cache_first_tries_local_then_online():
    seen = []

    def load(*, local_files_only):
        seen.append(local_files_only)
        if local_files_only:
            raise _miss()
        return "online"

    assert downloads.load_cache_first("org/m", load) == "online"
    assert seen == [True, False]


def test_cache_first_stops_at_the_cache_when_it_hits():
    seen = []

    def load(*, local_files_only):
        seen.append(local_files_only)
        return "cached"

    assert downloads.load_cache_first("org/m", load) == "cached"
    assert seen == [True]


def test_cache_first_does_not_swallow_other_failures():
    seen = []

    def load(*, local_files_only):
        seen.append(local_files_only)
        raise RuntimeError("the config on disk is broken")

    with pytest.raises(RuntimeError):
        downloads.load_cache_first("org/m", load)
    assert seen == [True]  # 온라인 재시도로 감추지 않는다


def test_cache_first_falls_back_on_a_wrapped_cache_miss():
    """transformers·speechbrain은 hub의 예외를 자기 것으로 감싸 던진다 — 사슬을 본다."""
    seen = []

    def load(*, local_files_only):
        seen.append(local_files_only)
        if local_files_only:
            raise OSError("we couldn't connect to huggingface.co") from _miss()
        return "online"

    assert downloads.load_cache_first("org/m", load) == "online"
    assert seen == [True, False]


def test_cache_first_injects_local_files_only_into_hub_calls(uninstall, hook_writes, monkeypatch):
    """로더가 `local_files_only`를 자기 인자로 못 받아도 오프라인이 된다 (pyannote·speechbrain)."""
    from huggingface_hub import file_download

    calls = []

    def fake(repo_id, filename, **kw):
        calls.append(kw)
        return "/cache/f"

    monkeypatch.setattr(file_download, "hf_hub_download", fake)
    downloads.install_hf_progress_hook("w1")

    def load(**_):  # 로더가 인자를 무시해도 hub 호출은 오프라인이다
        return hub.hf_hub_download("org/m", "f.bin")

    assert downloads.load_cache_first("org/m", load) == "/cache/f"
    assert calls[-1]["local_files_only"] is True
    # R-9d의 `ready` 쓰기는 **주입된** 연결로만 간다. 연산 수가 아니라 쓰기 수를 센다 —
    # P4-C7 수정이 같은 연결로 `model_readiness`를 한 번 **읽어** 직전 다운로드가 버려졌는지
    # 보므로, 전체 연산을 세면 그 읽기가 쓰기로 오인된다.
    writes = [sql for sql, _ in hook_writes if "INSERT" in sql or "UPDATE" in sql]
    assert len(writes) == 1


# ── 로더 다섯 ─────────────────────────────────────────────────────────


def _fake_module(monkeypatch, name: str, **attrs):
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    monkeypatch.setitem(sys.modules, name, mod)
    return mod


def test_bge_embedder_asks_sentence_transformers_for_local_files_first(monkeypatch):
    seen = []

    class SentenceTransformer:
        def __init__(self, name, **kw):
            seen.append(kw)
            if kw.get("local_files_only"):
                raise _miss()

    _fake_module(monkeypatch, "sentence_transformers", SentenceTransformer=SentenceTransformer)
    from damwha_worker.models.bge_embed import BgeM3TextEmbedder

    BgeM3TextEmbedder("BAAI/bge-m3")

    assert [kw["local_files_only"] for kw in seen] == [True, False]
    # 리비전 고정·safetensors 한정은 두 시도 모두에 그대로 남는다 (Task 9 계약)
    for kw in seen:
        assert kw["revision"] == "9a0624b896d81da7492a910ffa53731274b6cf3d"
        assert kw["model_kwargs"] == {"use_safetensors": True}


def test_ecapa_embedder_loads_inside_a_cache_first_attempt(monkeypatch):
    seen = []

    class EncoderClassifier:
        @classmethod
        def from_hparams(cls, source, run_opts=None):
            seen.append(downloads.cache_first_active())
            return object()

    speaker = _fake_module(
        monkeypatch, "speechbrain.inference.speaker", EncoderClassifier=EncoderClassifier
    )
    inference = _fake_module(monkeypatch, "speechbrain.inference", speaker=speaker)
    _fake_module(monkeypatch, "speechbrain", inference=inference)
    from damwha_worker.models.ecapa_embed import EcapaEmbedder

    EcapaEmbedder("speechbrain/spkrec-ecapa-voxceleb", "cpu")

    assert seen == [True]


def test_pyannote_diarizer_loads_inside_a_cache_first_attempt(monkeypatch):
    seen = []

    class Pipeline:
        @classmethod
        def from_pretrained(cls, model, token=None):
            seen.append(downloads.cache_first_active())
            return types.SimpleNamespace(to=lambda device: "pipeline")

    class _Torch(types.ModuleType):
        @staticmethod
        def device(name):
            return name

    _fake_module(monkeypatch, "torch", device=lambda name: name)
    audio = _fake_module(monkeypatch, "pyannote.audio", Pipeline=Pipeline)
    _fake_module(monkeypatch, "pyannote", audio=audio)
    from damwha_worker.models.pyannote_diar import PyannoteDiarizer

    PyannoteDiarizer("pyannote/speaker-diarization-community-1", None, "cpu")

    assert seen == [True]


def test_pyannote_cache_miss_retries_online(monkeypatch):
    seen = []

    class Pipeline:
        @classmethod
        def from_pretrained(cls, model, token=None):
            offline = downloads.cache_first_active()
            seen.append(offline)
            if offline:
                raise _miss()
            return types.SimpleNamespace(to=lambda device: "pipeline")

    _fake_module(monkeypatch, "torch", device=lambda name: name)
    audio = _fake_module(monkeypatch, "pyannote.audio", Pipeline=Pipeline)
    _fake_module(monkeypatch, "pyannote", audio=audio)
    from damwha_worker.models.pyannote_diar import PyannoteDiarizer

    PyannoteDiarizer("pyannote/speaker-diarization-community-1", None, "cpu")

    assert seen == [True, False]


def test_faster_whisper_asks_for_local_files_first(monkeypatch):
    seen = []

    class WhisperModel:
        def __init__(self, size, device=None, compute_type=None, local_files_only=False):
            seen.append(local_files_only)

    _fake_module(monkeypatch, "faster_whisper", WhisperModel=WhisperModel)
    from damwha_worker.models.whisper_faster import FasterWhisper

    FasterWhisper("large-v3-turbo", device="cpu")

    assert seen == [True]


def test_mlx_whisper_resolves_the_snapshot_cache_first(monkeypatch):
    seen = []
    calls = []

    def transcribe(audio, **kwargs):
        calls.append(kwargs)
        return {"language": "ko", "segments": []}

    mx = _fake_module(monkeypatch, "mlx.core", set_memory_limit=lambda n: None, array=lambda a: a)
    _fake_module(monkeypatch, "mlx", core=mx)
    audio_mod = _fake_module(monkeypatch, "mlx_whisper.audio", load_audio=lambda f: [f])
    _fake_module(monkeypatch, "mlx_whisper", transcribe=transcribe, audio=audio_mod)
    from damwha_worker.models import whisper_mlx

    def fake_snapshot(self, local_files_only):
        seen.append(local_files_only)
        return "/cache/snapshots/whisper"

    monkeypatch.setattr(whisper_mlx.MlxWhisper, "_snapshot", fake_snapshot)

    whisper_mlx.MlxWhisper("large-v3-turbo").transcribe("a.wav", "ko")

    assert seen == [True]
    assert calls[0]["path_or_hf_repo"] == "/cache/snapshots/whisper"


# ── 빈 캐시 + 거부된 네트워크 ─────────────────────────────────────────


def test_an_empty_cache_offline_is_transient_not_permanent():
    """캐시 미스는 다음 시도에서 달라질 수 있다 — 1층 재시도가 살아 있어야 한다 (§6.10)."""
    wrapped = errors.classify(OSError("cannot reach the hub"))
    assert wrapped.kind is errors.ErrorKind.TRANSIENT

    miss = errors.classify(_miss())
    assert miss.kind is errors.ErrorKind.TRANSIENT
    assert miss.code == errors.MODEL_DOWNLOAD_FAILED
