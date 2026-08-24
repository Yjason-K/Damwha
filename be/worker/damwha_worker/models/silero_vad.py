"""Silero VAD adapter — speech-region detection.

Implements the `VAD` protocol. Heavy import (`silero_vad`/torch) is done lazily
in __init__ so the module can be imported without the `models` extra installed.
"""

from .audio_io import SR as _SR
from .base import SpeechSpan


class SileroVAD:
    def __init__(self) -> None:
        from silero_vad import load_silero_vad

        self._model = load_silero_vad()

    def detect(self, wav_path: str) -> list[SpeechSpan]:
        from silero_vad import get_speech_timestamps

        from .audio_io import load_mono_tensor

        # silero의 read_audio()는 torchaudio.load() → torchcodec를 탄다(ffmpeg 9에서
        # dlopen 실패). 이미 16 kHz mono로 정규화된 파일이므로 soundfile로 직접 읽어
        # 파형을 넘긴다 — read_audio가 하던 mono 접기/리샘플은 불필요.
        wav, _ = load_mono_tensor(wav_path)
        stamps = get_speech_timestamps(wav, self._model, sampling_rate=_SR)
        # stamps are sample indices at _SR → convert to ms
        return [
            SpeechSpan(int(s["start"] / _SR * 1000), int(s["end"] / _SR * 1000)) for s in stamps
        ]
