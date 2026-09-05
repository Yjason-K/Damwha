"""스트리밍 헤더 WAV writer — 녹음 중에는 길이 미정, 닫을 때만 실제 크기.

표준 wave 모듈은 close()에서만 헤더를 쓴다. 자식이 죽으면 길이 0짜리 헤더가 남고,
ffmpeg는 data 크기가 실제보다 작은 헤더를 만나면 그 길이로 잘라 읽는다(실측: PCM 7초·
헤더 5초 → 5초). 반대로 0xFFFFFFFF(ffmpeg가 seek 불가 출력에 쓰는 관례)면 EOF까지
읽는다. 그래서 열 때 두 크기 필드를 0xFFFFFFFF로 두고 close()에서만 고친다 — 어느
순간 죽어도 디스크에 닿은 프레임까지 살아 있다. 주기 갱신은 마지막 갱신 이후를 잃으므로
하지 않는다. 설계: docs/superpowers/specs/2026-09-05-live-recording-design.md §2.9.

numpy/soundfile을 쓰지 않는다 — 결정적 테스트는 models extra 없이 돈다.
"""

import os
import queue
import struct
import threading

SR = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16
HEADER_LEN = 44
STREAMING_SIZE = 0xFFFFFFFF


def _header(data_size: int, riff_size: int, sample_rate: int = SR) -> bytes:
    byte_rate = sample_rate * CHANNELS * SAMPLE_WIDTH
    block_align = CHANNELS * SAMPLE_WIDTH
    return (
        b"RIFF"
        + struct.pack("<I", riff_size)
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, CHANNELS, sample_rate, byte_rate, block_align, 16)
        + b"data"
        + struct.pack("<I", data_size)
    )


class WavWriter:
    def __init__(self, path: str, sample_rate: int = SR) -> None:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self._sample_rate = sample_rate
        self._f = open(path, "wb")  # noqa: SIM115 — 수명이 close()까지다
        self._f.write(_header(STREAMING_SIZE, STREAMING_SIZE, sample_rate))
        self._bytes = 0
        self._closed = False

    @property
    def frames_written(self) -> int:
        return self._bytes // (CHANNELS * SAMPLE_WIDTH)

    @property
    def duration_ms(self) -> int:
        return int(self.frames_written * 1000 / self._sample_rate)

    def append(self, pcm: bytes) -> None:
        if self._closed:
            raise ValueError("WavWriter is closed")
        self._f.write(pcm)
        self._bytes += len(pcm)

    def flush(self) -> None:
        self._f.flush()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._f.flush()
        self._f.seek(0)
        self._f.write(_header(self._bytes, 36 + self._bytes, self._sample_rate))
        self._f.close()


def repair_streaming_header(path: str) -> bool:
    """스트리밍 헤더(또는 파일보다 큰 data 크기)를 실제 파일 크기로 고친다.

    우리 writer가 만든 44바이트 헤더(fmt가 12, data가 36 오프셋)만 다룬다. 다른 배치의
    WAV나 WAV가 아닌 파일, 없는 파일은 건드리지 않고 False. 반쪽 샘플로 끝나면 샘플 경계로
    내림해 잘라낸다. 크래시 후 재처리가 부르는 곳: pipeline.ffmpeg.normalize.
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    if size < HEADER_LEN:
        return False
    with open(path, "r+b") as f:
        head = f.read(HEADER_LEN)
        if head[:4] != b"RIFF" or head[8:12] != b"WAVE" or head[36:40] != b"data":
            return False
        declared = struct.unpack("<I", head[40:44])[0]
        actual = size - HEADER_LEN
        if declared != STREAMING_SIZE and declared <= actual:
            return False
        block = CHANNELS * SAMPLE_WIDTH
        aligned = actual - (actual % block)
        f.seek(4)
        f.write(struct.pack("<I", 36 + aligned))
        f.seek(40)
        f.write(struct.pack("<I", aligned))
        if aligned != actual:
            f.truncate(HEADER_LEN + aligned)
    return True


class WriterThread(threading.Thread):
    """큐의 프레임을 디스크로 옮기는 전용 스레드. None을 받으면 끝난다(파일은 안 닫는다).

    미리보기 파이프라인(whisper·DB)과 다른 스레드에 두는 이유: 추론이 멈춰도 파일 쓰기는
    디스크 속도로만 진행돼야 "녹음은 잃지 않는다"가 성립한다 (설계 §2.9).

    죽은 이유는 error에 남긴다 — live_session의 Capture.error와 짝이다. 예외를 삼키면
    디스크가 찬 순간(ENOSPC) 이 스레드만 조용히 죽고, 남은 프레임은 아무도 읽지 않는 큐에
    쌓인다. 세션은 그대로 finalize돼 "완료된 회의"가 잘린 파일과 틀린 duration_ms를 갖는다.
    녹음은 조용히 잃지 않는다 — 보이게 실패해야 한다.
    """

    def __init__(self, writer: WavWriter, frames: "queue.Queue[bytes | None]") -> None:
        super().__init__(name="wav-writer", daemon=True)
        self._writer = writer
        self._frames = frames
        self.error: BaseException | None = None

    def run(self) -> None:
        try:
            while True:
                pcm = self._frames.get()
                if pcm is None:
                    return
                self._writer.append(pcm)
        except BaseException as exc:  # noqa: BLE001 — 세션 루프가 error를 보고 실패시킨다
            self.error = exc


def run_writer_thread(writer: WavWriter, frames: "queue.Queue[bytes | None]") -> WriterThread:
    t = WriterThread(writer, frames)
    t.start()
    return t
