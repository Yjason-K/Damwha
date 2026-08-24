"""어댑터 계약 테스트 — 실모델 없이 sys.modules stub으로 kwargs를 검증한다."""

import sys
import types

from damwha_worker.models.base import SpeechSpan

SPANS = [SpeechSpan(500, 3_200), SpeechSpan(4_000, 9_900)]
FLAT_S = [0.5, 3.2, 4.0, 9.9]


def _install_fake_mlx(monkeypatch, calls, loads=None):
    fake_core = types.ModuleType("mlx.core")
    fake_core.set_memory_limit = lambda n: None
    fake_core.array = lambda a: ("mx", a)
    fake_mlx = types.ModuleType("mlx")
    fake_mlx.core = fake_core

    fake_audio = types.ModuleType("mlx_whisper.audio")

    def load_audio(file, sr=16000):
        if loads is not None:
            loads.append((file, sr))
        return ["pcm", file]

    fake_audio.load_audio = load_audio

    fake_whisper = types.ModuleType("mlx_whisper")

    def transcribe(audio, **kwargs):
        calls.append({"audio": audio, **kwargs})
        return {
            "segments": [
                {"words": [{"word": " 안녕", "start": 0.5, "end": 0.9, "probability": 0.9}]}
            ]
        }

    fake_whisper.transcribe = transcribe
    fake_whisper.audio = fake_audio
    monkeypatch.setitem(sys.modules, "mlx", fake_mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", fake_core)
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_whisper)
    monkeypatch.setitem(sys.modules, "mlx_whisper.audio", fake_audio)


def _install_fake_faster(monkeypatch, calls, segment_ends=(0.9,)):
    fake_fw = types.ModuleType("faster_whisper")

    class WhisperModel:
        def __init__(self, size, device=None, compute_type=None):
            pass

        def transcribe(self, wav_path, **kwargs):
            calls.append(kwargs)
            segments = [
                types.SimpleNamespace(
                    start=end - 0.4,
                    end=end,
                    words=[
                        types.SimpleNamespace(
                            word=" 안녕", start=end - 0.4, end=end, probability=0.9
                        )
                    ],
                )
                for end in segment_ends
            ]
            return iter(segments), None

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


# --- 진행 보고: clip/segment 하나가 끝날 때마다 (처리된 오디오 ms, 총 오디오 ms) ---
# SPANS 길이: 2700ms + 5900ms = 8600ms


def test_mlx_reports_progress_after_each_clip(monkeypatch):
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    seen = []
    MlxWhisper("large-v3-turbo").transcribe(
        "a.wav", "ko", SPANS, on_progress=lambda done, total: seen.append((done, total))
    )
    assert seen == [(2_700, 8_600), (8_600, 8_600)]


def test_mlx_whole_file_reports_no_progress(monkeypatch):
    # spans=None(전체 파일)은 진행 단위를 모른다 — 지어내지 않는다
    calls = []
    _install_fake_mlx(monkeypatch, calls)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    seen = []
    MlxWhisper("large-v3-turbo").transcribe(
        "a.wav", "ko", on_progress=lambda done, total: seen.append((done, total))
    )
    assert seen == []


def test_faster_reports_progress_as_segments_stream(monkeypatch):
    # faster-whisper는 clip을 한 번에 받고 segment 제너레이터를 흘린다 —
    # segment 끝 위치(절대 오디오 시각)를 clip 누적 ms로 환산해 보고한다.
    calls = []
    _install_fake_faster(monkeypatch, calls, segment_ends=(3.2, 9.9))
    from damwha_worker.models.whisper_faster import FasterWhisper

    seen = []
    FasterWhisper("large-v3-turbo", device="cpu").transcribe(
        "a.wav", "ko", SPANS, on_progress=lambda done, total: seen.append((done, total))
    )
    assert seen == [(2_700, 8_600), (8_600, 8_600)]


def test_faster_progress_inside_a_clip_counts_partial(monkeypatch):
    # 첫 clip(500~3200) 중간 1500ms 지점 → 1000ms 처리
    calls = []
    _install_fake_faster(monkeypatch, calls, segment_ends=(1.5,))
    from damwha_worker.models.whisper_faster import FasterWhisper

    seen = []
    FasterWhisper("large-v3-turbo", device="cpu").transcribe(
        "a.wav", "ko", SPANS, on_progress=lambda done, total: seen.append((done, total))
    )
    assert seen == [(1_000, 8_600)]


def test_faster_whole_file_reports_no_progress(monkeypatch):
    calls = []
    _install_fake_faster(monkeypatch, calls)
    from damwha_worker.models.whisper_faster import FasterWhisper

    seen = []
    FasterWhisper("large-v3-turbo", device="cpu").transcribe(
        "a.wav", "ko", on_progress=lambda done, total: seen.append((done, total))
    )
    assert seen == []


def test_mlx_loads_audio_once_regardless_of_clip_count(monkeypatch):
    # clip마다 경로를 넘기면 mlx_whisper가 호출마다 파일 전체를 ffmpeg로 재디코드한다.
    # 디코드는 1회여야 하고, 이후 호출은 그 배열을 재사용해야 한다.
    calls, loads = [], []
    _install_fake_mlx(monkeypatch, calls, loads)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    MlxWhisper("large-v3-turbo").transcribe("a.flac", "ko", SPANS)
    assert loads == [("a.flac", 16000)]
    assert len(calls) == 2


def test_mlx_passes_decoded_array_not_path(monkeypatch):
    # 경로 문자열을 그대로 넘기면 라이브러리가 다시 디코드한다 — mx.array를 넘겨
    # 라이브러리 내부의 str 분기와 numpy→mx 변환을 둘 다 건너뛴다.
    calls, loads = [], []
    _install_fake_mlx(monkeypatch, calls, loads)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    MlxWhisper("large-v3-turbo").transcribe("a.flac", "ko", SPANS)
    for kwargs in calls:
        assert kwargs["audio"] == ("mx", ["pcm", "a.flac"])
