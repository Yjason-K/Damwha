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
        # FLAC 16 kHz mono: 무손실이라 PCM은 WAV와 동일하고 디스크는 약 45% 줄어든다.
        # libsndfile 네이티브 지원이라 ecapa_embed의 soundfile.read()가 그대로 동작한다.
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
