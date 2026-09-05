"""자라는 WAV를 따라 읽는 AudioSource — 브라우저가 올리고 API가 쓰는 파일의 소비자.

FileSource와 결정적으로 다른 점은 **EOF가 "끝"이 아니라 "따라잡음"**이라는 것이다.
진짜 EOF는 sealed_bytes()가 값을 주고 읽기 오프셋이 거기 닿았을 때만 성립한다.
파일 크기가 아니라 DB의 sealed_bytes가 권위인 이유: 파일 append·헤더 재작성·DB commit이
한 트랜잭션이 될 수 없어서 셋 중 무엇이 진실인지 정해야 하기 때문이다 (설계 §2.7).

WAV 헤더의 크기 필드는 읽지 않는다. 봉인 순간 API가 그 두 필드를 seek/write로 고치는데,
전환 중의 값을 믿으면 파일을 조기 종료한다 (설계 §6).
"""

import logging
import os
import time
from collections.abc import Callable, Iterator

from ..errors import IO_ERROR, ErrorKind, WorkerError
from .source import FRAME_BYTES

log = logging.getLogger("damwha_worker")

HEADER_LEN = 44
BYTES_PER_MS = 32  # 16000 samples/s * 2 bytes = 32000 bytes/s
#: 미리보기가 이만큼 뒤처지면 따라잡는다. 30초 = 30 * 32000.
DRIFT_BYTES = 960_000
#: 파일이 아직 없어도 되는 기간. 워커가 브라우저의 첫 POST보다 먼저 claim할 수 있다.
#: 무한 대기는 hang이므로 상한을 둔다 (설계 §4.1).
ENOENT_GRACE_SECONDS = 60.0
POLL_SECONDS = 0.05


class TailSource:
    def __init__(
        self,
        path: str,
        *,
        sealed_bytes: Callable[[], int | None],
        grace_seconds: float = ENOENT_GRACE_SECONDS,
        drift_bytes: int = DRIFT_BYTES,
        poll_seconds: float = POLL_SECONDS,
        sleep=time.sleep,
        clock=time.monotonic,
    ) -> None:
        self._path = path
        self._sealed = sealed_bytes
        self._grace = grace_seconds
        self._drift = drift_bytes
        self._poll = poll_seconds
        self._sleep = sleep
        self._clock = clock
        self._stopped = False
        self._yielded = 0  # yield한 PCM 바이트 (position의 근거)
        self._rest = b""  # 아직 프레임을 못 채운 나머지
        self.skips = 0

    @property
    def position_ms(self) -> int:
        """yield한 바이트 기준의 절대 위치. 시간의 근거가 프레임 카운터가 아니라
        파일 오프셋이므로, 건너뛰어도 이 값은 진실을 말한다 (설계 §6.1)."""
        return self._yielded // BYTES_PER_MS

    def stop(self) -> None:
        self._stopped = True

    def _open(self):
        deadline = self._clock() + self._grace
        while not self._stopped:
            try:
                return open(self._path, "rb")  # noqa: SIM115 — 수명이 frames()까지다
            except FileNotFoundError:
                if self._clock() >= deadline:
                    raise WorkerError(
                        IO_ERROR,
                        f"live audio file never appeared within {self._grace}s: {self._path}",
                        ErrorKind.PERMANENT,
                        stage="capture",
                    ) from None
                self._sleep(self._poll)
        return None

    def _available(self, sealed: int | None) -> int:
        pcm = os.path.getsize(self._path) - HEADER_LEN
        return pcm if sealed is None else min(pcm, sealed)

    def frames(self) -> Iterator[bytes]:
        f = self._open()
        if f is None:
            return
        f.seek(HEADER_LEN)  # PCM은 헤더 44바이트 다음부터 — 크기 필드는 절대 읽지 않는다
        try:
            while not self._stopped:
                sealed = self._sealed()
                available = self._available(sealed)
                if self._yielded + len(self._rest) >= available:
                    # 따라잡았다. 봉인됐고 거기 도달했으면 진짜 끝이다 — yielded가 아니라
                    # available로 판단한다. 봉인 시점에 프레임 경계 중간에서 잘리면 남는
                    # 반쪽은 영원히 완성되지 않으므로, yielded == sealed를 기다리면 끝나지
                    # 않는 무한 루프가 된다. available(= min(파일 크기, sealed))이 sealed에
                    # 닿았다는 것은 "더 올 바이트가 없다"는 뜻이고, 그 시점에 못 채운 반쪽은
                    # 버린다 (핵심 성질 3, 브리프의 test_yields_only_complete_frames).
                    if sealed is not None and available >= sealed:
                        return
                    self._sleep(self._poll)
                    continue
                behind = available - self._yielded
                if behind > self._drift:
                    # 미리보기가 너무 뒤처졌다 — 뒤쪽으로 건너뛴다. 파일은 온전하고
                    # 미리보기만 구간을 못 본다. 나머지 버퍼를 버려야 프레임 경계가 맞는다.
                    target = ((available - self._drift) // FRAME_BYTES) * FRAME_BYTES
                    self._rest = b""
                    self._yielded = target
                    f.seek(HEADER_LEN + target)
                    self.skips += 1
                    log.warning(
                        "live preview %d ms behind — skipped to %d ms",
                        behind // BYTES_PER_MS,
                        self.position_ms,
                    )
                    continue
                want = available - self._yielded - len(self._rest)
                chunk = f.read(want)
                if not chunk:
                    # short read. EOF가 아니라 아직 안 쓰인 것이다.
                    self._sleep(self._poll)
                    continue
                self._rest += chunk
                while len(self._rest) >= FRAME_BYTES and not self._stopped:
                    frame, self._rest = self._rest[:FRAME_BYTES], self._rest[FRAME_BYTES:]
                    self._yielded += FRAME_BYTES
                    yield frame
        finally:
            f.close()
