"""어댑터 계약 테스트 — 실모델 없이 sys.modules stub으로 kwargs를 검증한다."""

import sys
import types

from damwha_worker.models.base import SpeechSpan

SPANS = [SpeechSpan(500, 3_200), SpeechSpan(4_000, 9_900)]
FLAT_S = [0.5, 3.2, 4.0, 9.9]


def _install_fake_mlx(monkeypatch, calls):
    fake_core = types.ModuleType("mlx.core")
    fake_core.set_memory_limit = lambda n: None
    fake_mlx = types.ModuleType("mlx")
    fake_mlx.core = fake_core

    fake_whisper = types.ModuleType("mlx_whisper")

    def transcribe(wav_path, **kwargs):
        calls.append(kwargs)
        return {
            "segments": [
                {"words": [{"word": " 안녕", "start": 0.5, "end": 0.9, "probability": 0.9}]}
            ]
        }

    fake_whisper.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx", fake_mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", fake_core)
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_whisper)


def _install_fake_faster(monkeypatch, calls):
    fake_fw = types.ModuleType("faster_whisper")

    class WhisperModel:
        def __init__(self, size, device=None, compute_type=None):
            pass

        def transcribe(self, wav_path, **kwargs):
            calls.append(kwargs)
            word = types.SimpleNamespace(word=" 안녕", start=0.5, end=0.9, probability=0.9)
            return iter([types.SimpleNamespace(words=[word])]), None

    fake_fw.WhisperModel = WhisperModel
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_fw)


def test_mlx_calls_once_per_clip_with_guards(monkeypatch):
    # mlx-whisper의 다중 clip seek 루프는 일부 clip 출력을 드랍한다(로컬 재현).
    # clip마다 개별 호출해야 하며, 매 호출에 가드 kwargs가 포함되어야 한다.
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    words = MlxWhisper("large-v3-turbo").transcribe("a.wav", "ko", SPANS)
    assert [c["clip_timestamps"] for c in calls] == [[0.5, 3.2], [4.0, 9.9]]
    for kwargs in calls:
        assert kwargs["condition_on_previous_text"] is False
        assert kwargs["hallucination_silence_threshold"] == 2.0
        assert kwargs["word_timestamps"] is True
    # 호출 결과는 clip 순서대로 이어붙인다 (fake는 호출당 단어 1개 반환)
    assert [w.text for w in words] == ["안녕", "안녕"]


def test_mlx_none_spans_omits_clip(monkeypatch):
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    MlxWhisper("large-v3-turbo").transcribe("a.wav", "ko")
    (kwargs,) = calls
    assert "clip_timestamps" not in kwargs


def test_faster_passes_guards_and_clip(monkeypatch):
    calls = []
    _install_fake_faster(monkeypatch, calls)
    from damwha_worker.models.whisper_faster import FasterWhisper

    words = FasterWhisper("large-v3-turbo", device="cpu").transcribe("a.wav", "ko", SPANS)
    (kwargs,) = calls
    assert kwargs["clip_timestamps"] == FLAT_S
    assert kwargs["condition_on_previous_text"] is False
    assert kwargs["hallucination_silence_threshold"] == 2.0
    assert kwargs["word_timestamps"] is True
    assert [w.text for w in words] == ["안녕"]


def test_faster_none_spans_omits_clip(monkeypatch):
    calls = []
    _install_fake_faster(monkeypatch, calls)
    from damwha_worker.models.whisper_faster import FasterWhisper

    FasterWhisper("large-v3-turbo", device="cpu").transcribe("a.wav", "ko")
    (kwargs,) = calls
    assert "clip_timestamps" not in kwargs


def test_mlx_empty_spans_skips_library_and_returns_empty(monkeypatch):
    # 빈 리스트 = '발화 없음' — clip_timestamps=[]가 전체 오디오로 해석되는 것을 방어
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    assert MlxWhisper("large-v3-turbo").transcribe("a.wav", "ko", []) == []
    assert calls == []


def test_faster_empty_spans_skips_library_and_returns_empty(monkeypatch):
    calls = []
    _install_fake_faster(monkeypatch, calls)
    from damwha_worker.models.whisper_faster import FasterWhisper

    assert FasterWhisper("large-v3-turbo", device="cpu").transcribe("a.wav", "ko", []) == []
    assert calls == []
