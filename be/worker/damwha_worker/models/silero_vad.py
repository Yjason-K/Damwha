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


class StreamingSileroVAD:
    """silero VADIterator 래핑 — 512샘플 int16 프레임을 받아 start/end 이벤트를 낸다.

    speech_pad_ms=0: 앞 패딩은 세그먼터의 pre-roll이, 뒤 패딩은 min_silence_duration_ms가
    담당한다(끝 이벤트가 그만큼 뒤에 온다). 무거운 import는 __init__ 안.
    """

    def __init__(self, *, threshold: float = 0.5, min_silence_duration_ms: int = 200) -> None:
        from silero_vad import VADIterator, load_silero_vad

        self._it = VADIterator(
            load_silero_vad(),
            threshold=threshold,
            sampling_rate=_SR,
            min_silence_duration_ms=min_silence_duration_ms,
            speech_pad_ms=0,
        )

    def process(self, pcm: bytes) -> list[tuple[str, int]]:
        import torch

        x = torch.frombuffer(bytearray(pcm), dtype=torch.int16).float() / 32768.0
        event = self._it(x, return_seconds=False)
        if not event:
            return []
        if "start" in event:
            return [("start", int(event["start"] * 1000 / _SR))]
        return [("end", int(event["end"] * 1000 / _SR))]

    def reset(self) -> None:
        self._it.reset_states()
