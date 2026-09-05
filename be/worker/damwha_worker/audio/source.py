"""오디오 프레임 소스 — 마이크(sounddevice)와 파일(테스트·smoke).

프레임은 16 kHz 모노 int16 LE 512샘플(32 ms) = 1024바이트의 `bytes`다. numpy를 쓰지
않는 이유는 결정적 테스트가 models extra 없이 돌아야 하기 때문이고, 512샘플인 이유는
silero VADIterator가 16 kHz에서 그 크기만 받기 때문이다. `AudioSource`는 시스템 오디오
구현체를 나중에 붙일 자리다 (설계 §2.1).
"""

import logging
import queue
import threading
import time
import wave
from collections.abc import Iterator
from typing import Protocol

from ..errors import AUDIO_DEVICE_FAILED, ErrorKind, WorkerError

log = logging.getLogger("damwha_worker")

SR = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
FRAME_MS = FRAME_SAMPLES * 1000 // SR  # 32


class AudioSource(Protocol):
    def frames(self) -> Iterator[bytes]:
        """프레임을 순서대로 낸다. stop() 뒤(또는 EOF) 반복이 끝난다."""
        ...

    def stop(self) -> None: ...


class FileSource:
    """WAV 파일을 프레임으로 흘린다. realtime=True면 프레임당 32 ms 대기(smoke용)."""

    def __init__(self, path: str, *, realtime: bool = False, sleep=time.sleep) -> None:
        self._path = path
        self._realtime = realtime
        self._sleep = sleep
        self._stopped = threading.Event()

    def frames(self) -> Iterator[bytes]:
        with wave.open(self._path, "rb") as w:
            if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SR, 1, 2):
                raise ValueError(
                    f"FileSource needs {SR} Hz mono int16, got "
                    f"{w.getframerate()} Hz / {w.getnchannels()} ch / {w.getsampwidth() * 8} bit"
                )
            while not self._stopped.is_set():
                pcm = w.readframes(FRAME_SAMPLES)
                if len(pcm) < FRAME_BYTES:
                    return  # 마지막 자투리는 버린다
                if self._realtime:
                    self._sleep(FRAME_MS / 1000)
                yield pcm

    def stop(self) -> None:
        self._stopped.set()


def _import_sounddevice():
    try:
        import sounddevice
    except ImportError as exc:
        raise WorkerError(
            AUDIO_DEVICE_FAILED,
            "sounddevice is not installed — run `uv sync --extra models`",
            ErrorKind.PERMANENT,
            stage="capture",
        ) from exc
    return sounddevice


class MicSource:
    """기본 입력 장치를 연다. 콜백은 큐에 넣기만 하고, frames()가 그 큐를 비운다.

    첫 실행에 macOS 마이크 권한 프롬프트가 터미널 앱 앞으로 뜬다. 거부·장치 없음·미설치는
    전부 PERMANENT audio_device_failed — 재시도로 달라질 게 없다.
    """

    def __init__(self, device: int | str | None = None, *, sounddevice_module=None) -> None:
        self._device = device
        self._sd = sounddevice_module
        self._q: queue.Queue[bytes | None] | None = None

    def frames(self) -> Iterator[bytes]:
        sd = self._sd or _import_sounddevice()
        q: queue.Queue[bytes | None] = queue.Queue()
        self._q = q

        def _callback(indata, frames, time_info, status) -> None:
            if status:
                log.warning("mic stream status: %s", status)
            # indata는 PortAudio가 재사용하는 버퍼다 — bytes()가 복사한다.
            q.put(bytes(indata))

        try:
            stream = sd.InputStream(
                samplerate=SR,
                channels=1,
                dtype="int16",
                blocksize=FRAME_SAMPLES,
                device=self._device,
                callback=_callback,
            )
            stream.start()
        except Exception as exc:  # noqa: BLE001 — PortAudioError 등 장치 계층 예외 전부
            raise WorkerError(
                AUDIO_DEVICE_FAILED,
                f"could not open microphone: {exc}",
                ErrorKind.PERMANENT,
                stage="capture",
            ) from exc
        try:
            while True:
                pcm = q.get()
                if pcm is None:
                    return
                yield pcm
        finally:
            stream.stop()
            stream.close()

    def stop(self) -> None:
        if self._q is not None:
            self._q.put(None)
