"""Silero VAD adapter — speech-region detection.

Implements the `VAD` protocol. Heavy import (`silero_vad`/torch) is done lazily
in __init__ so the module can be imported without the `models` extra installed.
"""

from .base import SpeechSpan

_SR = 16000  # worker normalizes to 16 kHz mono before any model runs


class SileroVAD:
    def __init__(self) -> None:
        from silero_vad import load_silero_vad

        self._model = load_silero_vad()

    def detect(self, wav_path: str) -> list[SpeechSpan]:
        from silero_vad import get_speech_timestamps, read_audio

        wav = read_audio(wav_path, sampling_rate=_SR)
        stamps = get_speech_timestamps(wav, self._model, sampling_rate=_SR)
        # stamps are sample indices at _SR → convert to ms
        return [
            SpeechSpan(int(s["start"] / _SR * 1000), int(s["end"] / _SR * 1000)) for s in stamps
        ]
