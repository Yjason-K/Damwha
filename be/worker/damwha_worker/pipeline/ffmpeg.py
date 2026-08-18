import json
import os
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass

from ..errors import CORRUPT_AUDIO, PROBE_FAILED, UNSUPPORTED_FORMAT, ErrorKind, WorkerError

Runner = Callable[[list[str]], subprocess.CompletedProcess]


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True)


@dataclass
class ProbeResult:
    duration_ms: int


def probe(path: str, runner: Runner = _run) -> ProbeResult:
    cmd = ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path]
    proc = runner(cmd)
    if proc.returncode != 0:
        raise WorkerError(PROBE_FAILED, f"ffprobe failed: {proc.stderr!r}", ErrorKind.PERMANENT)
    try:
        data = json.loads(proc.stdout or b"{}")
        duration = data["format"]["duration"]
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        raise WorkerError(
            UNSUPPORTED_FORMAT, f"no duration in probe output: {e}", ErrorKind.PERMANENT
        ) from e
    if duration is None:
        raise WorkerError(UNSUPPORTED_FORMAT, "duration is null", ErrorKind.PERMANENT)
    return ProbeResult(duration_ms=int(float(duration) * 1000))


def normalize(src_path: str, dst_path: str, runner: Runner = _run) -> None:
    fd, temp_path = tempfile.mkstemp(
        prefix=f".{os.path.basename(dst_path)}.",
        suffix=".tmp",
        dir=os.path.dirname(dst_path) or ".",
    )
    os.close(fd)
    try:
        # FLAC 16 kHz mono s16: 무손실이라 PCM은 기존 WAV와 비트 단위로 동일하고
        # 디스크는 약 50% 줄어든다. libsndfile 네이티브 지원이라 ecapa_embed의
        # soundfile.read()가 그대로 동작한다.
        # -sample_fmt s16 필수 — 디코더가 float를 내주면 FLAC 인코더가 24비트를
        # 고르고(측정: 39.3MB vs s16 19.6MB), 그러면 s16 WAV 대비 1%밖에 안 줄어든다.
        # -f 명시 필수 — temp_path가 .tmp 접미사라 확장자 추론이 안 된다.
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            src_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-sample_fmt",
            "s16",
            "-c:a",
            "flac",
            "-compression_level",
            "5",
            "-f",
            "flac",
            temp_path,
        ]
        proc = runner(cmd)
        if proc.returncode != 0:
            raise WorkerError(
                CORRUPT_AUDIO, f"ffmpeg normalize failed: {proc.stderr!r}", ErrorKind.PERMANENT
            )
        probe(temp_path)
        os.replace(temp_path, dst_path)
    except BaseException:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass
        raise
