from dataclasses import dataclass

from ..models.base import DiarSegment, SpeechSpan, Word

# 무단어 diar 세그먼트가 이 길이 미만이면 row를 만들지 않는다. 화자 겹침에서 나오는
# sub-second 파편은 전사 불가능한 diarization 아티팩트라 transcribe_failed/silence
# 노이즈 row만 쌓는다. 단어가 붙은 세그먼트는 길이와 무관하게 항상 유지된다.
MIN_WORDLESS_SEGMENT_MS = 1000


@dataclass
class Utterance:
    speaker_label: str | None
    diar_label: str
    start_ms: int
    end_ms: int
    text: str | None
    confidence: float | None
    status: str
    order_index: int


def _segment_for(word: Word, segments: list[DiarSegment]) -> DiarSegment:
    mid = (word.start_ms + word.end_ms) // 2
    for s in segments:
        if s.start_ms <= mid < s.end_ms:
            return s
    # 어느 세그먼트에도 안 들면 중점에 가장 가까운 세그먼트
    return min(segments, key=lambda s: min(abs(mid - s.start_ms), abs(mid - s.end_ms)))


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return a_start < b_end and b_start < a_end


def build_utterances(
    words: list[Word],
    segments: list[DiarSegment],
    failed_spans: list[SpeechSpan] | None = None,
) -> list[Utterance]:
    failed_spans = failed_spans or []
    if not segments:
        return []
    # 1) word를 세그먼트에 귀속
    by_seg: dict[int, list[Word]] = {i: [] for i in range(len(segments))}
    seg_index = {id(s): i for i, s in enumerate(segments)}
    for w in words:
        seg = _segment_for(w, segments)
        by_seg[seg_index[id(seg)]].append(w)

    raw: list[Utterance] = []
    for i, seg in enumerate(segments):
        ws = sorted(by_seg[i], key=lambda w: w.start_ms)
        if ws:
            # 같은 세그먼트(=같은 화자) word들을 하나의 발언으로 병합
            confs = [w.confidence for w in ws if w.confidence is not None]
            raw.append(
                Utterance(
                    speaker_label=seg.diar_label,
                    diar_label=seg.diar_label,
                    start_ms=ws[0].start_ms,
                    end_ms=ws[-1].end_ms,
                    text=" ".join(w.text for w in ws),
                    confidence=(sum(confs) / len(confs)) if confs else None,
                    status="ok",
                    order_index=-1,
                )
            )
        else:
            if seg.end_ms - seg.start_ms < MIN_WORDLESS_SEGMENT_MS:
                continue
            failed = any(
                _overlaps(seg.start_ms, seg.end_ms, f.start_ms, f.end_ms) for f in failed_spans
            )
            raw.append(
                Utterance(
                    speaker_label=seg.diar_label,
                    diar_label=seg.diar_label,
                    start_ms=seg.start_ms,
                    end_ms=seg.end_ms,
                    text=None,
                    confidence=None,
                    status="transcribe_failed" if failed else "silence",
                    order_index=-1,
                )
            )

    raw.sort(key=lambda u: u.start_ms)
    for idx, u in enumerate(raw):
        u.order_index = idx
    return raw
