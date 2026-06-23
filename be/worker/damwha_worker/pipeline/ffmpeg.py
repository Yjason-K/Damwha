import json
import subprocess
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
        raise WorkerError(UNSUPPORTED_FORMAT, f"no duration in probe output: {e}", ErrorKind.PERMANENT) from e
    if duration is None:
        raise WorkerError(UNSUPPORTED_FORMAT, "duration is null", ErrorKind.PERMANENT)
    return ProbeResult(duration_ms=int(float(duration) * 1000))


def normalize(src_path: str, dst_path: str, runner: Runner = _run) -> None:
    cmd = ["ffmpeg", "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-f", "wav", dst_path]
    proc = runner(cmd)
    if proc.returncode != 0:
        raise WorkerError(CORRUPT_AUDIO, f"ffmpeg normalize failed: {proc.stderr!r}", ErrorKind.PERMANENT)
