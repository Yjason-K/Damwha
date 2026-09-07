"""프레임 스트림 → 발화 세그먼트 (pure).

VAD start에서 pre-roll(직전 200 ms)을 붙여 열고, end에서 닫는다. 끝이 안 와도 상한
(15 s)에서 강제로 자르고 다음 세그먼트를 빈틈 없이 이어 연다. 최종 패스의
prepare_stt_spans와 같은 취지의 앞 패딩·최소 길이 규칙이다. 뒤 패딩은 silero의
min_silence_duration_ms(끝 이벤트가 그만큼 늦게 온다)가 담당한다.
"""

from collections import deque
from dataclasses import dataclass

from ..audio.source import FRAME_MS
from ..models.base import StreamingVAD

MAX_SEGMENT_MS = 15000
MIN_SEGMENT_MS = 300
PRE_ROLL_MS = 200


@dataclass
class Segment:
    start_ms: int
    end_ms: int
    pcm: bytes


class LiveSegmenter:
    def __init__(
        self,
        vad: StreamingVAD,
        *,
        max_segment_ms: int = MAX_SEGMENT_MS,
        min_segment_ms: int = MIN_SEGMENT_MS,
        pre_roll_ms: int = PRE_ROLL_MS,
    ) -> None:
        self._vad = vad
        self._max = max_segment_ms
        self._min = min_segment_ms
        self._pre_roll: deque[bytes] = deque(maxlen=-(-pre_roll_ms // FRAME_MS))  # ceil
        self._pos_ms = 0  # 지금까지 push된 프레임의 끝 시각
        self._cur: list[bytes] | None = None
        self._cur_start_ms = 0

    def push(self, pcm: bytes) -> list[Segment]:
        events = self._vad.process(pcm)
        self._pos_ms += FRAME_MS
        if self._cur is None:
            self._pre_roll.append(pcm)
        else:
            self._cur.append(pcm)
        out: list[Segment] = []
        for kind, _ in events:
            if kind == "start" and self._cur is None:
                # pre-roll에는 방금 append한 현재 프레임이 들어 있다
                self._cur = list(self._pre_roll)
                self._cur_start_ms = self._pos_ms - len(self._cur) * FRAME_MS
                self._pre_roll.clear()
            elif kind == "end" and self._cur is not None:
                seg = self._emit(keep_open=False)
                if seg is not None:
                    out.append(seg)
        if self._cur is not None and self._pos_ms - self._cur_start_ms >= self._max:
            seg = self._emit(keep_open=True)
            if seg is not None:
                out.append(seg)
        return out

    def skip_to(self, pos_ms: int) -> None:
        """미리보기가 뒤처져 TailSource가 건너뛰었다 — 절대 위치를 다시 심는다.

        _pos_ms는 push된 프레임을 세는 상대 카운터라, 건너뛴 만큼 실제 시각보다 밀린다.
        그대로 두면 이후 모든 live_utterance.start_ms/end_ms가 어긋난다. 발화 점프가 이
        제품의 핵심이라 화면에 틀린 시각이 뜨는 것 자체가 결함이다 (설계 §6.1).

        열려 있던 세그먼트는 버린다 — 방금 그 한가운데에 구멍을 냈으므로 이어 붙이면
        없는 오디오를 하나의 발화로 만든다. pre-roll도 같은 이유로 비운다.
        """
        self._pos_ms = pos_ms
        self._cur = None
        self._pre_roll.clear()
        reset = getattr(self._vad, "reset", None)
        if callable(reset):
            reset()

    def flush(self) -> Segment | None:
        """종료 시 진행 중이던 발화를 닫는다."""
        if self._cur is None:
            return None
        return self._emit(keep_open=False)

    def _emit(self, *, keep_open: bool) -> Segment | None:
        assert self._cur is not None
        frames = self._cur
        start = self._cur_start_ms
        end = start + len(frames) * FRAME_MS
        if keep_open:
            self._cur = []
            self._cur_start_ms = end
        else:
            self._cur = None
        if end - start < self._min or not frames:
            return None
        return Segment(start_ms=start, end_ms=end, pcm=b"".join(frames))
