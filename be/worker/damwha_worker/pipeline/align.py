from dataclasses import dataclass

from ..models.base import DiarSegment, SpeechSpan, Word

# 무단어 diar 세그먼트가 이 길이 미만이면 row를 만들지 않는다. 화자 겹침에서 나오는
# sub-second 파편은 전사 불가능한 diarization 아티팩트라 transcribe_failed/silence
# 노이즈 row만 쌓는다. 단어가 붙은 세그먼트는 길이와 무관하게 항상 유지된다.
MIN_WORDLESS_SEGMENT_MS = 1000

# 백채널 스무딩: 같은 화자 run 사이에 낀 다른 화자의 word run이 이 길이 미만이고,
# 그 run의 세그먼트가 주변 화자 세그먼트와 시간 겹침이 있으면 주변 화자로 재귀속한다.
# "맞지"/웃음 같은 호응이 겹침 구간에서 본 화자의 단어를 탈취해 발언을 쪼개는 것 방지.
# 겹침 없는 짧은 발언(진짜 턴 교대)은 대상이 아니다.
BACKCHANNEL_MAX_RUN_MS = 2000


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
    containing = [s for s in segments if s.start_ms <= mid < s.end_ms]
    if containing:
        # 겹침 구간이면 지배적(더 긴) 세그먼트가 이긴다 — 짧은 백채널 세그먼트가
        # 본 화자의 word를 탈취하는 것 방지
        return max(containing, key=lambda s: s.end_ms - s.start_ms)
    # 어느 세그먼트에도 안 들면 중점에 가장 가까운 세그먼트
    return min(segments, key=lambda s: min(abs(mid - s.start_ms), abs(mid - s.end_ms)))


def _overlaps(a_start, a_end, b_start, b_end) -> bool:
    return a_start < b_end and b_start < a_end


def _label_runs(assignment: list[tuple[Word, DiarSegment]]) -> list[tuple[str, list[int]]]:
    """시간순 assignment를 diar_label이 같은 연속 구간(run)으로 묶는다."""
    runs: list[tuple[str, list[int]]] = []
    for i, (_, seg) in enumerate(assignment):
        if runs and runs[-1][0] == seg.diar_label:
            runs[-1][1].append(i)
        else:
            runs.append((seg.diar_label, [i]))
    return runs


def _smooth_backchannels(
    assignment: list[tuple[Word, DiarSegment]],
) -> list[tuple[Word, DiarSegment]]:
    """겹침 백채널 세그먼트에 탈취된 짧은 word run을 주변 화자로 재귀속한다."""
    changed = True
    while changed:
        changed = False
        runs = _label_runs(assignment)
        for k in range(1, len(runs) - 1):
            label, idxs = runs[k]
            prev_label, prev_idxs = runs[k - 1]
            next_label, next_idxs = runs[k + 1]
            if prev_label != next_label or prev_label == label:
                continue
            run_words = [assignment[i][0] for i in idxs]
            if run_words[-1].end_ms - run_words[0].start_ms >= BACKCHANNEL_MAX_RUN_MS:
                continue
            neighbor_prev = assignment[prev_idxs[-1]][1]
            neighbor_next = assignment[next_idxs[0]][1]
            run_segs = {id(assignment[i][1]): assignment[i][1] for i in idxs}
            if not any(
                _overlaps(s.start_ms, s.end_ms, n.start_ms, n.end_ms)
                for s in run_segs.values()
                for n in (neighbor_prev, neighbor_next)
            ):
                continue
            for i in idxs:
                assignment[i] = (assignment[i][0], neighbor_prev)
            changed = True
            break  # run 경계가 바뀌었으므로 재계산
    return assignment


def build_utterances(
    words: list[Word],
    segments: list[DiarSegment],
    failed_spans: list[SpeechSpan] | None = None,
) -> list[Utterance]:
    failed_spans = failed_spans or []
    if not segments:
        return []
    # 1) word를 세그먼트에 귀속 (시간순), 백채널 run은 주변 화자로 재귀속
    ordered = sorted(words, key=lambda w: w.start_ms)
    assignment = [(w, _segment_for(w, segments)) for w in ordered]
    seg_index = {id(s): i for i, s in enumerate(segments)}
    had_words = {seg_index[id(seg)] for _, seg in assignment}
    assignment = _smooth_backchannels(assignment)

    by_seg: dict[int, list[Word]] = {i: [] for i in range(len(segments))}
    for w, seg in assignment:
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
            if i in had_words:
                # 스무딩이 word를 전부 회수한 백채널 세그먼트 — 침묵이 아니므로 row 없음
                continue
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
