"""라이브 세션 — 마이크 프레임을 파일과 미리보기 파이프라인으로 나눠 흘린다.

[capture thread]  source.frames() ──▶ writer 큐 ──▶ [writer thread] WavWriter.append
                                  └─▶ preview 큐 (상한 5분, 넘치면 오래된 것부터 버림)
[main loop]       preview 큐 ──▶ LiveSegmenter ──segment──▶ temp wav
                              ──▶ transcribe ──▶ text (비면 건너뜀)
                              ──▶ embed ──▶ identify_embedding(suggest_threshold)
                              ──▶ insert_live_utterance(seq++)
                  매 1초: get_stop_requested, shutdown_event, 상한 시간

파일 쓰기와 미리보기는 서로 다른 큐·스레드다. 추론이 멈춰도 파일은 디스크 속도로 쓰인다
(설계 §2.9). 오류는 전부 PERMANENT — 끊긴 녹음은 이어 붙일 수 없다 (§2.6). DB 오류는
클립 실패로 세고 stop 폴링에서는 건너뛴다. 자식은 재접속하지 않는다는 워커 원칙 그대로다.
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
from ..audio.source import FRAME_MS, SR, AudioSource
from ..audio.wav_writer import WavWriter, run_writer_thread
from ..contracts import LiveSessionPayload
from ..errors import AUDIO_DEVICE_FAILED, IO_ERROR, LIVE_STT_FAILED, ErrorKind, WorkerError
from ..models.base import DiarSegment, Embedder, StreamingVAD, Transcriber
from ..storage import Storage
from .identify import identify_embedding
from .live_segmenter import LiveSegmenter, Segment
from .stage import enter_stage

log = logging.getLogger("damwha_worker")

PREVIEW_QUEUE_MAX_FRAMES = 5 * 60 * 1000 // FRAME_MS  # 5분
CLIP_FAILURE_LIMIT = 5
STOP_POLL_SECONDS = 1.0


@dataclass
class LiveModels:
    transcriber: Transcriber
    embedder: Embedder
    vad: StreamingVAD


class Capture:
    """capture thread: 소스의 프레임을 writer 큐와 preview 큐에 나눠 넣는다.

    writer 큐는 무제한이다 — 녹음은 한 프레임도 버리지 않는다. preview 큐만 상한을 두고
    넘치면 오래된 프레임부터 버린다(미리보기가 늦어질 뿐 파일은 온전하다). 소스가 끝나거나
    죽으면 두 큐에 None을 넣어 소비자를 깨운다.
    """

    def __init__(
        self,
        source: AudioSource,
        writer_q: "queue.Queue[bytes | None]",
        preview_q: "queue.Queue[bytes | None]",
        *,
        preview_max_frames: int,
    ) -> None:
        self._source = source
        self._writer_q = writer_q
        self._preview_q = preview_q
        self._max = preview_max_frames
        self.dropped = 0
        self.error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="live-capture", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: float | None = None) -> None:
        self._thread.join(timeout)

    def _run(self) -> None:
        try:
            for pcm in self._source.frames():
                self._writer_q.put(pcm)
                if self._preview_q.qsize() >= self._max:
                    try:
                        self._preview_q.get_nowait()
                        self.dropped += 1
                        if self.dropped in (1, 100, 1000) or self.dropped % 10000 == 0:
                            log.warning("live preview queue full — dropped %d frames", self.dropped)
                    except queue.Empty:
                        pass
                self._preview_q.put(pcm)
        except BaseException as exc:  # noqa: BLE001 — 메인 루프가 다시 던진다
            self.error = exc
        finally:
            self._writer_q.put(None)
            self._preview_q.put(None)


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
    source: AudioSource,
    *,
    worker_id: str,
    shutdown_event: threading.Event | None = None,
    max_minutes: float = 240.0,
    clip_failure_limit: int = CLIP_FAILURE_LIMIT,
    preview_max_frames: int = PREVIEW_QUEUE_MAX_FRAMES,
    stop_poll_seconds: float = STOP_POLL_SECONDS,
    clock=time.monotonic,
) -> str:
    job_id = job["id"]
    meeting_id = payload.meeting_id
    ctx = f"job={job_id} meeting={meeting_id}"
    enter_stage(conn, job_id, worker_id, "capture", 0, shutdown_event)
    if db.set_recording_started(conn, meeting_id, job_id) == 0:
        log.info("%s live_session lost ownership before capture", ctx)
        return "lost"

    writer = WavWriter(storage.resolve(payload.audio_key))
    writer_q: queue.Queue[bytes | None] = queue.Queue()
    preview_q: queue.Queue[bytes | None] = queue.Queue()
    writer_thread = run_writer_thread(writer, writer_q)
    capture = Capture(source, writer_q, preview_q, preview_max_frames=preview_max_frames)
    segmenter = LiveSegmenter(models.vad)
    tmpdir = tempfile.TemporaryDirectory(prefix="damwha-live-")
    state = {"seq": 0, "failures": 0}
    started = clock()
    last_poll = started
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
                pcm = preview_q.get(timeout=stop_poll_seconds)
            except queue.Empty:
                pcm = _NO_FRAME
            if pcm is None:
                stop_reason = "source_ended"
                break
            if pcm is not _NO_FRAME:
                for seg in segmenter.push(pcm):
                    handle(seg)
            now = clock()
            if now - last_poll >= stop_poll_seconds:
                last_poll = now
                if writer_thread.error is not None or capture.error is not None:
                    # 쓰기 경로가 죽어도 미리보기는 멀쩡히 돈다 — 프레임은 아무도 읽지
                    # 않는 writer 큐에 쌓이고, 줄은 계속 뜨고, heartbeat도 계속 뛴다.
                    # 여기서 보지 않으면 디스크가 5분에 차도 사용자는 60분 뒤 종료를
                    # 누를 때에야 안다. stop·소유권 상실과 같은 주기에서 같이 본다.
                    stop_reason = "io_error"
                    break
                try:
                    signal = db.get_stop_requested(conn, job_id, worker_id)
                except Exception:  # noqa: BLE001 — DB가 잠깐 죽어도 녹음은 계속
                    log.warning("%s stop poll failed — continuing", ctx, exc_info=True)
                    signal = None
                if signal == "lost":
                    stop_reason = "lost"
                    break
                if signal == "stop":
                    stop_reason = "stop"
                    break
                if shutdown_event is not None and shutdown_event.is_set():
                    stop_reason = "shutdown"
                    break
                if now - started >= max_minutes * 60:
                    stop_reason = "max_duration"
                    break
        # 정상 종료 순서 (설계 §4): 캡처 닫기 → writer 비우고 파일 닫기 → 마지막 발화 → finalize
        # capture.join()이 writer 종료보다 먼저다 — 캡처가 살아 있는 동안 writer가 끝나면
        # 그 뒤 넣는 프레임이 조용히 사라진다. 캡처의 finally가 이미 sentinel을 넣으므로
        # 조인만 하면 writer는 남은 프레임을 전부 비우고 스스로 끝난다.
        source.stop()
        capture.join(timeout=10)
        writer_thread.join(timeout=60)
        # 오류 판정이 close()보다 먼저다. 디스크가 찬 상태의 close()는 남은 버퍼를
        # flush하다 같은 ENOSPC를 다시 던지고, 그러면 진짜 원인(writer의 OSError)이
        # 가려져 회의가 IO_ERROR가 아니라 uncategorized로 닫힌다. 실패 경로의 파일
        # 닫기는 아래 finally가 조용히 맡는다(헤더가 스트리밍 값으로 남아도 재처리의
        # repair_streaming_header가 고친다).
        if capture.error is not None:
            raise capture.error
        if writer_thread.error is not None:
            # writer가 죽었으면 디스크에 닿은 프레임이 큐에 넣은 프레임보다 적다. finalize하면
            # 잘린 파일과 틀린 duration_ms를 "완료된 회의"로 넘긴다 — 조용한 손실이야말로
            # 이 기능이 막으려는 것이다. 보이게 실패한다(PERMANENT: 끊긴 녹음은 못 잇는다).
            raise WorkerError(
                IO_ERROR,
                f"wav writer died mid-recording: {writer_thread.error!r}",
                ErrorKind.PERMANENT,
                stage="capture",
            ) from writer_thread.error
        # 파일이 닫힌(=헤더가 확정된) 뒤에야 최종 job이 큐에 들어간다 (설계 §4).
        writer.close()
        log.info(
            "%s live_session capture end reason=%s duration_ms=%d rows=%d dropped=%d",
            ctx,
            stop_reason,
            writer.duration_ms,
            state["seq"],
            capture.dropped,
        )
        if stop_reason == "lost":
            return "lost"
        if writer.frames_written == 0:
            # 넘길 녹음이 없다. finalize하면 회의가 uploaded가 되고 배치 job이 큐에 들어가는데,
            # 아래 finally가 바로 그 job이 읽을 파일을 지운다(헤더만 남은 파일은 "파일 없음"
            # — §8). 그래서 커밋과 삭제가 어긋나지 않도록 아예 넘기지 않는다.
            raise WorkerError(
                AUDIO_DEVICE_FAILED,
                f"captured no audio (reason={stop_reason}) — nothing to hand off",
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
            duration_ms=writer.duration_ms,
            process_payload=payload.process_wire,
        )
    finally:
        # 예외 경로에서도 파일은 닫는다(헤더 확정). 소스는 두 번 stop해도 안전하다.
        # 순서가 곧 "녹음은 잃지 않는다"이다: sentinel을 캡처보다 먼저 보내면 writer가
        # 일찍 끝나고, 그 뒤 캡처가 넣는 프레임은 아무도 읽지 않는다 — 모든 예외 경로에서
        # 녹음 꼬리가 잘린다. 소스를 멈추고 캡처를 조인한 뒤에야 보낸다(캡처가 이미 넣은
        # sentinel이 있으므로 이건 여분이고, 여분이어도 해가 없다).
        source.stop()
        capture.join(timeout=10)
        writer_q.put(None)
        writer_thread.join(timeout=60)
        # finally의 close()는 삼킨다. 여기서 던지면 지금 올라가던 예외를 대체해
        # 디스크 풀이 IO_ERROR가 아니라 close의 OSError로 보고된다. 정상 경로에서는
        # 위에서 이미 닫혔으므로 이 호출은 여분이다.
        try:
            writer.close()
        except Exception:  # noqa: BLE001 — 원인 오류를 가리지 않는다
            log.warning("%s wav writer close failed", ctx, exc_info=True)
        if writer.frames_written == 0:
            # 마이크를 못 열었거나 프레임이 하나도 없었다 — 헤더만 남은 파일은
            # "파일 없음"이 맞다 (§8).
            try:
                os.unlink(storage.resolve(payload.audio_key))
            except FileNotFoundError:
                pass
        tmpdir.cleanup()
