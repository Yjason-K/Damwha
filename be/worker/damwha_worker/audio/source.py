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
    #: yield한 마지막 프레임의 끝 시각(ms). 아직 하나도 안 냈으면 0. Capture._run이 매
    #: 프레임마다 읽으므로(pipeline/live_session.py), 구현이 이를 빠뜨리면 런타임에서만
    #: 터진다 — TailSource·GrowingFileSource(테스트 fake)와 계약이 같아야 한다.
    position_ms: int

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
        self.position_ms = 0

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
                self.position_ms += FRAME_MS
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

    `payload.source`가 "browser"면 워커는 이걸 쓰지 않는다 — __main__.py의
    `_default_live_source`가 그 경우 TailSource를 고른다. MicSource는 시스템 오디오
    구현체가 들어올 자리의 참조 구현으로 남아 있다: AudioSource 프로토콜이 TailSource
    말고 다른 구현도 지탱한다는 증거이자, 그 구현이 실제로 존재하는 유일한 자리다. 지우지
    않는다 (설계 §2.1).

    첫 실행에 macOS 마이크 권한 프롬프트가 터미널 앱 앞으로 뜬다. 거부·장치 없음·미설치는
    전부 PERMANENT audio_device_failed — 재시도로 달라질 게 없다.
    """

    def __init__(self, device: int | str | None = None, *, sounddevice_module=None) -> None:
        self._device = device
        self._sd = sounddevice_module
        # 생성 시점에 큐를 만든다 — frames()가 아직 한 번도 next()되지 않은 채 stop()이
        # 먼저 오는 경우(취소 직후) 신호가 버려지면 안 된다. FileSource의 threading.Event와
        # 같은 이유로 stop 신호통은 생성자에서부터 살아 있어야 한다.
        self._q: queue.Queue[bytes | None] = queue.Queue()
        self.position_ms = 0

    def frames(self) -> Iterator[bytes]:
        sd = self._sd or _import_sounddevice()
        q = self._q

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
                self.position_ms += FRAME_MS
                yield pcm
        finally:
            stream.stop()
            stream.close()

    def stop(self) -> None:
        self._q.put(None)
