"""라이브 세션 — API가 쓰는 WAV를 따라 읽어 미리보기를 만든다.

[capture thread]  source.frames() ──▶ 유계 큐 (pos_ms, pcm)
[main loop]       큐 ──▶ (위치 불연속이면 segmenter.skip_to)
                      ──▶ LiveSegmenter ──segment──▶ temp wav
                      ──▶ transcribe ──▶ text (비면 건너뜀)
                      ──▶ embed ──▶ identify_embedding(suggest_threshold)
                      ──▶ insert_live_utterance(seq++)
                  매 1초: get_stop_requested, shutdown_event, 상한 시간

워커는 이제 **reader**다. 파일은 API가 쓴다 (설계 §2.2). 그래서 원 설계 §2.9의 이중 큐와
writer 스레드가 통째로 없다 — "추론이 멈춰도 파일 쓰기는 디스크 속도로"는 캡처가 브라우저로
간 순간 이미 성립한다. API의 append는 whisper와 아예 다른 프로세스다.

큐가 유계인 이유는 backpressure다. 미리보기가 느리면 큐가 차고 → capture 스레드가 put에서
막히고 → TailSource가 전진을 멈추고 → 파일은 계속 자라고 → 다음 읽기에서 드리프트를 보고
건너뛴다. 무계 큐면 드리프트가 큐 안에 쌓여 seek이 영영 안 일어난다.

stop_requested_at과 sealed_bytes는 같은 트랜잭션에서 쓰이는 게 정상이지만(설계 §4.4 ③),
API가 stop 플래그만 먼저 찍고 봉인을 나중에 쓰는 창(마이그레이션·API 버그)에 대비해, stop을
본 뒤 STOP_WITHOUT_SEAL_SECONDS 안에 sealed_bytes가 안 오면 max_minutes(4시간)까지 기다리지
않고 IO_ERROR로 끝낸다 — 봉인 없이는 TailSource가 절대 EOF를 내지 않는다.

오류는 전부 PERMANENT — 끊긴 녹음은 이어 붙일 수 없다 (§2.6).
"""

import logging
import os
import queue
import tempfile
import threading
import time
import wave
from dataclasses import dataclass

from .. import db
from ..audio.source import FRAME_MS, SR
from ..contracts import LiveSessionPayload
from ..errors import AUDIO_DEVICE_FAILED, IO_ERROR, LIVE_STT_FAILED, ErrorKind, WorkerError
from ..models.base import DiarSegment, Embedder, StreamingVAD, Transcriber
from ..storage import Storage
from .identify import identify_embedding
from .live_segmenter import LiveSegmenter, Segment
from .stage import enter_stage

log = logging.getLogger("damwha_worker")

#: 2초. backpressure를 만들 만큼 작고, 전사 한 번의 지터를 흡수할 만큼은 크다.
PREVIEW_QUEUE_MAX_FRAMES = 2000 // FRAME_MS
BYTES_PER_MS = 32
CLIP_FAILURE_LIMIT = 5
STOP_POLL_SECONDS = 1.0
#: API가 stop_requested_at만 찍고 sealed_bytes를 아직 안 쓴 창의 상한.
STOP_WITHOUT_SEAL_SECONDS = 60.0


@dataclass
class LiveModels:
    transcriber: Transcriber
    embedder: Embedder
    vad: StreamingVAD


class Capture:
    """capture thread: 소스의 프레임을 (위치, pcm)으로 유계 큐에 넣는다.

    큐가 차면 put에서 막힌다. 그것이 TailSource에 backpressure를 주는 유일한 장치다.
    소스가 끝나거나 죽으면 None을 넣어 소비자를 깨운다.
    """

    def __init__(self, source, q: "queue.Queue", *, stop_poll_seconds: float) -> None:
        self._source = source
        self._q = q
        self._poll = stop_poll_seconds
        self._stopped = threading.Event()
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="live-capture", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: float | None = None) -> None:
        self._thread.join(timeout)

    def _put(self, item) -> bool:
        """stop을 인지하는 blocking put. 소비자가 영영 안 먹어도 종료할 수 있어야 한다."""
        while not self._stopped.is_set():
            try:
                self._q.put(item, timeout=self._poll)
                return True
            except queue.Full:
                continue
        return False

    def stop(self) -> None:
        self._stopped.set()

    def _run(self) -> None:
        try:
            for pcm in self._source.frames():
                if not self._put((self._source.position_ms, pcm)):
                    return
        except BaseException as exc:  # noqa: BLE001 — 메인 루프가 다시 던진다
            self.error = exc
        finally:
            try:
                self._q.put_nowait(None)
            except queue.Full:
                pass


def _write_clip(path: str, pcm: bytes) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


_NO_FRAME = object()


def run_live_session(
    conn,
    job: dict,
    payload: LiveSessionPayload,
    models: LiveModels,
    storage: Storage,
    source,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
    max_minutes: float = 240.0,
    clip_failure_limit: int = CLIP_FAILURE_LIMIT,
    preview_max_frames: int = PREVIEW_QUEUE_MAX_FRAMES,
    stop_poll_seconds: float = STOP_POLL_SECONDS,
    stop_without_seal_seconds: float = STOP_WITHOUT_SEAL_SECONDS,
    sealed_box: dict | None = None,
    clock=time.monotonic,
) -> str:
    job_id = job["id"]
    meeting_id = payload.meeting_id
    ctx = f"job={job_id} meeting={meeting_id}"
    enter_stage(conn, job_id, worker_id, "capture", 0, shutdown_event)
    signal, sealed = db.get_stop_requested(conn, job_id, worker_id)
    if signal == "lost":
        log.info("%s live_session lost ownership before capture", ctx)
        return "lost"
    # 호출자가 TailSource를 만들 때 이미 이 dict를 클로저로 쥐고 있을 수 있다 — 새로 만들지
    # 않고 그 자리에서 갱신해야 소스와 루프가 같은 값을 본다.
    if sealed_box is None:
        sealed_box = {"bytes": sealed}
    else:
        sealed_box["bytes"] = sealed

    q: queue.Queue = queue.Queue(maxsize=preview_max_frames)
    capture = Capture(source, q, stop_poll_seconds=stop_poll_seconds)
    segmenter = LiveSegmenter(models.vad)
    tmpdir = tempfile.TemporaryDirectory(prefix="damwha-live-")
    state = {"seq": 0, "failures": 0}
    started = clock()
    last_poll = started
    next_pos_ms: int | None = None
    stop_seen_at: float | None = None
    stop_reason: str | None = None
    log.info("%s live_session capture start", ctx)

    def handle(seg: Segment) -> None:
        clip = os.path.join(tmpdir.name, f"seg_{state['seq']}.wav")
        try:
            _write_clip(clip, seg.pcm)
            words = models.transcriber.transcribe(clip, payload.process.models.language)
            text = " ".join(w.text for w in words).strip()
            if not text:
                state["failures"] = 0
                return
            speaker_id = None
            similarity = None
            emb = models.embedder.embed(clip, [DiarSegment("LIVE", 0, seg.end_ms - seg.start_ms)])[
                0
            ]
            if emb is not None:
                identify = payload.process.identify
                # 라이브는 suggest 기준 (설계 §2.8). v5는 항상 값이 있지만 타입상 None을 막는다.
                threshold = (
                    identify.suggest_threshold
                    if identify.suggest_threshold is not None
                    else identify.threshold
                )
                hit = identify_embedding(
                    conn,
                    emb,
                    payload.process.models.embedding.model,
                    payload.process.models.embedding.dimension,
                    threshold,
                )
                if hit is not None:
                    speaker_id, similarity = hit
            db.insert_live_utterance(
                conn,
                meeting_id=meeting_id,
                job_id=job_id,
                seq=state["seq"],
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                text=text,
                speaker_id=speaker_id,
                similarity=similarity,
            )
            state["seq"] += 1
            state["failures"] = 0
        except Exception as exc:  # noqa: BLE001 — 클립 하나는 세션을 죽이지 않는다
            state["failures"] += 1
            log.warning(
                "%s live clip failed (%d/%d): %r", ctx, state["failures"], clip_failure_limit, exc
            )
            if state["failures"] >= clip_failure_limit:
                raise WorkerError(
                    LIVE_STT_FAILED,
                    f"{state['failures']} consecutive clip failures: {exc}",
                    ErrorKind.PERMANENT,
                    stage="capture",
                ) from exc
        finally:
            try:
                os.unlink(clip)
            except FileNotFoundError:
                pass

    try:
        capture.start()
        while True:
            try:
                item = q.get(timeout=stop_poll_seconds)
            except queue.Empty:
                item = _NO_FRAME
            if item is None:
                stop_reason = "source_ended"
                break
            if item is not _NO_FRAME:
                pos_ms, pcm = item
                # 소스가 건너뛰었으면 세그먼터의 절대 위치를 다시 심는다. 이 프레임의 끝이
                # pos_ms이므로 시작은 pos_ms - FRAME_MS다 (설계 §6.1). 첫 프레임은 next_pos_ms가
                # 아직 없으므로(None) 건너뛰기로 취급하지 않는다 — 그렇지 않으면 세션마다 첫
                # 프레임에서 스퓨리어스 skip_to(0)이 걸린다.
                if next_pos_ms is not None and pos_ms != next_pos_ms:
                    segmenter.skip_to(pos_ms - FRAME_MS)
                next_pos_ms = pos_ms + FRAME_MS
                for seg in segmenter.push(pcm):
                    handle(seg)
            now = clock()
            if now - last_poll >= stop_poll_seconds:
                last_poll = now
                if capture.error is not None:
                    stop_reason = "capture_error"
                    break
                try:
                    signal, sealed = db.get_stop_requested(conn, job_id, worker_id)
                    sealed_box["bytes"] = sealed
                except Exception:  # noqa: BLE001 — DB가 잠깐 죽어도 미리보기는 계속
                    log.warning("%s stop poll failed — continuing", ctx, exc_info=True)
                    signal = None
                if signal == "lost":
                    stop_reason = "lost"
                    break
                if signal == "stop":
                    # 즉시 끝내지 않는다. 소스가 sealed_bytes에 닿으면 스스로 끝난다
                    # (TailSource가 sealed를 보고 EOF를 낸다) — 그때 None이 큐에 온다.
                    # 다만 sealed_bytes가 계속 안 오면(마이그레이션 창·API 버그) max_minutes
                    # (4시간)까지 기다리지 않고 STOP_WITHOUT_SEAL_SECONDS 만에 끝낸다.
                    if stop_seen_at is None:
                        stop_seen_at = now
                    elif (
                        sealed_box["bytes"] is None
                        and now - stop_seen_at >= stop_without_seal_seconds
                    ):
                        raise WorkerError(
                            IO_ERROR,
                            "stop requested but sealed_bytes still unset after "
                            f"{stop_without_seal_seconds:.0f}s",
                            ErrorKind.PERMANENT,
                            stage="capture",
                        )
                if shutdown_event is not None and shutdown_event.is_set():
                    stop_reason = "shutdown"
                    break
                if now - started >= max_minutes * 60:
                    stop_reason = "max_duration"
                    break
        source.stop()
        capture.stop()
        capture.join(timeout=10)
        if capture.error is not None:
            raise capture.error
        sealed = sealed_box["bytes"]
        log.info(
            "%s live_session capture end reason=%s sealed_bytes=%s rows=%d skips=%d",
            ctx,
            stop_reason,
            sealed,
            state["seq"],
            getattr(source, "skips", 0),
        )
        if stop_reason == "lost":
            return "lost"
        if sealed is None:
            # 봉인 없이 소스가 끝났다 — API가 아직 stop을 처리하지 않았다. 여기서
            # finalize하면 자라는 중인 파일로 duration을 정하고 배치 패스를 큐에 넣는다.
            raise WorkerError(
                IO_ERROR,
                f"live source ended before seal (reason={stop_reason})",
                ErrorKind.PERMANENT,
                stage="capture",
            )
        if sealed == 0:
            # 한 바이트도 안 왔다. 넘길 녹음이 없다.
            raise WorkerError(
                AUDIO_DEVICE_FAILED,
                "captured no audio — nothing to hand off",
                ErrorKind.PERMANENT,
                stage="capture",
            )
        last = segmenter.flush()
        if last is not None:
            handle(last)
        if db.set_stage(conn, job_id, worker_id, "finalize", 100) == 0:
            return "lost"
        return db.finalize_live_session(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            meeting_id=meeting_id,
            duration_ms=sealed // BYTES_PER_MS,
            process_payload=payload.process_wire,
        )
    finally:
        source.stop()
        capture.stop()
        capture.join(timeout=10)
        tmpdir.cleanup()
