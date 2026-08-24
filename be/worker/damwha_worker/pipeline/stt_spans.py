"""VAD span → STT 입력 구간 전처리 (pure).

Silero VAD가 낸 발화 구간을 STT clip 입력으로 다듬는다: 경계 절단 완화를 위한
pad, 파일 범위 clamp, pad로 겹치거나 맞닿게 된 span 병합. 실패 분류(align의
failed_spans)에는 전처리 전 원본 span을 써야 한다 — pad는 STT 입력 확장일 뿐.
"""

from ..models.base import SpeechSpan

PAD_MS = 200


def prepare_stt_spans(
    spans: list[SpeechSpan], duration_ms: int, pad_ms: int = PAD_MS
) -> list[SpeechSpan]:
    valid = [
        s for s in spans if s.end_ms > s.start_ms and s.start_ms < duration_ms and s.end_ms > 0
    ]
    padded = sorted(
        (max(0, s.start_ms - pad_ms), min(duration_ms, s.end_ms + pad_ms)) for s in valid
    )
    merged: list[SpeechSpan] = []
    for start, end in padded:
        if merged and start <= merged[-1].end_ms:
            merged[-1] = SpeechSpan(merged[-1].start_ms, max(merged[-1].end_ms, end))
        else:
            merged.append(SpeechSpan(start, end))
    return merged
