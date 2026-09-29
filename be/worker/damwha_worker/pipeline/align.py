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

# 임베딩 판정자(arbitrate)가 있으면 후보 폭을 이 길이까지 넓힌다 — 시간 휴리스틱과
# 달리 오디오가 실제 누구 목소리인지 확인하므로, 더 긴 오귀속 run도 안전하게 다룬다.
ARBITRATE_MAX_RUN_MS = 5000

# 같은 화자의 연속 ok 발언 사이 무음이 이 길이 미만이면 하나로 합친다. pyannote는
# 숨 고르는 pause마다 세그먼트를 끊어 한 턴이 utt 십수 개로 쪼개진다(실측: 턴당
# 21개). 사이에 다른 화자 row나 non-ok row가 끼면 합치지 않는다.
MERGE_GAP_MS = 1500

# on_progress 비율 배분: 스무딩(임베딩 판정자가 대부분의 시간)이 앞 80%, 조각 흡수가 뒤 20%.
_SMOOTH_SHARE = 0.8

# 조각 흡수: 스무딩 뒤에도 남은 run 중 단어가 이 수 이하이거나 이 길이 미만인 것은
# 앞·뒤 화자 중 목소리가 더 가까운 쪽으로 붙인다. 겹침 구간에서 화자가 단어 하나씩
# 번갈아 바뀌어 "말씀하시는데"/"경고예요" 같은 한 단어 발언이 쏟아지는 것 방지
# (실측: 두 단어 이하 발언 25% → 13.5%, 화자 귀속 정확도는 +0.5%p).
FRAGMENT_MAX_WORDS = 2
FRAGMENT_MIN_MS = 1000


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
        # 겹침 구간이면 가장 늦게 시작한 세그먼트가 이긴다 — 겹침은 대개 앞 화자
        # 세그먼트의 끝이 다음 화자의 시작을 덮는 모양이라, 새로 말을 시작한 쪽이
        # 그 단어의 주인일 가능성이 높다. 예전 규칙(더 긴 세그먼트)은 길게 말하던
        # 앞 화자에게 뒷사람의 첫마디를 넘겼다(클로바노트 대비 턴 첫 12자의 약 23%).
        # 본 화자 발언 도중 끼어든 백채널이 본문을 가져가는 경우는
        # _smooth_backchannels(임베딩 판정)가 회수한다.
        return max(containing, key=lambda s: s.start_ms)
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
    arbitrate=None,
    on_run=None,
) -> list[tuple[Word, DiarSegment]]:
    """겹침 백채널 세그먼트에 탈취된 짧은 word run을 주변 화자로 재귀속한다.

    arbitrate(start_ms, end_ms, own_label, neighbor_label) -> bool | None이 주어지면
    임베딩 판정이 흡수/보존을 결정하고(후보 폭도 ARBITRATE_MAX_RUN_MS로 확대),
    None(판정 불가)일 때만 기존 겹침 휴리스틱으로 폴백한다.
    """
    max_run_ms = ARBITRATE_MAX_RUN_MS if arbitrate is not None else BACKCHANNEL_MAX_RUN_MS
    changed = True
    while changed:
        changed = False
        runs = _label_runs(assignment)
        for k in range(1, len(runs) - 1):
            label, idxs = runs[k]
            if on_run is not None:
                on_run(assignment[idxs[-1]][0].end_ms)
            prev_label, prev_idxs = runs[k - 1]
            next_label, next_idxs = runs[k + 1]
            if prev_label != next_label or prev_label == label:
                continue
            run_words = [assignment[i][0] for i in idxs]
            run_start = run_words[0].start_ms
            run_end = run_words[-1].end_ms
            if run_end - run_start >= max_run_ms:
                continue
            neighbor_prev = assignment[prev_idxs[-1]][1]
            neighbor_next = assignment[next_idxs[0]][1]

            verdict = None
            if arbitrate is not None:
                verdict = arbitrate(run_start, run_end, label, prev_label)
            if verdict is None:
                # 겹침 휴리스틱: 2초 미만 + 이웃 세그먼트와 시간 겹침일 때만 흡수
                run_segs = {id(assignment[i][1]): assignment[i][1] for i in idxs}
                verdict = run_end - run_start < BACKCHANNEL_MAX_RUN_MS and any(
                    _overlaps(s.start_ms, s.end_ms, n.start_ms, n.end_ms)
                    for s in run_segs.values()
                    for n in (neighbor_prev, neighbor_next)
                )
            if not verdict:
                continue
            for i in idxs:
                assignment[i] = (assignment[i][0], neighbor_prev)
            changed = True
            break  # run 경계가 바뀌었으므로 재계산
    return assignment


def _absorb_fragments(
    assignment: list[tuple[Word, DiarSegment]],
    resolve,
    on_run=None,
) -> list[tuple[Word, DiarSegment]]:
    """짧은 run(조각)을 resolve가 고른 이웃 화자로 옮긴다.

    resolve(start_ms, end_ms, own_label, candidate_labels) -> str | None 은 조각을 가질
    화자 라벨을 돌려준다 — own_label이면 그대로 두고, 후보 중 하나면 그 화자로 옮기며,
    None(판정 불가)이면 시간상 더 가까운 이웃에게 붙인다. 옮기면 run 경계가 바뀌므로
    처음부터 다시 훑는다. 옮길 때마다 run이 하나씩 줄어 반드시 끝난다.
    """
    changed = True
    while changed:
        changed = False
        runs = _label_runs(assignment)
        for k, (label, idxs) in enumerate(runs):
            run_words = [assignment[i][0] for i in idxs]
            start, end = run_words[0].start_ms, run_words[-1].end_ms
            if on_run is not None:
                on_run(end)
            if len(run_words) > FRAGMENT_MAX_WORDS and end - start >= FRAGMENT_MIN_MS:
                continue
            # 이웃 화자 → (조각과 맞닿은 세그먼트, 조각과의 시간 간격). 앞 run은 끝 단어,
            # 뒤 run은 첫 단어 기준. 앞뒤가 같은 화자면 앞을 쓴다(동점도 앞 화자 우선).
            neighbors: dict[str, tuple[DiarSegment, int]] = {}
            if k > 0:
                w, seg = assignment[runs[k - 1][1][-1]]
                neighbors[runs[k - 1][0]] = (seg, start - w.end_ms)
            if k + 1 < len(runs):
                w, seg = assignment[runs[k + 1][1][0]]
                neighbors.setdefault(runs[k + 1][0], (seg, w.start_ms - end))
            if not neighbors:
                continue
            target = resolve(start, end, label, list(neighbors))
            if target == label:
                continue
            if target not in neighbors:
                target = min(neighbors, key=lambda lb: neighbors[lb][1])
            for i in idxs:
                assignment[i] = (assignment[i][0], neighbors[target][0])
            changed = True
            break
    return assignment


def build_utterances(
    words: list[Word],
    segments: list[DiarSegment],
    failed_spans: list[SpeechSpan] | None = None,
    arbitrate=None,
    resolve_fragment=None,
    on_progress=None,
) -> list[Utterance]:
    """on_progress(fraction)은 스무딩·조각 흡수 루프가 훑는 위치를 0~1로 알린다. 루프가
    변경마다 처음부터 다시 훑으므로 값이 뒤로 갈 수 있다 — 받는 쪽이 최대값을 쓴다.
    끝나면 1.0을 한 번 보낸다."""
    failed_spans = failed_spans or []
    if not segments:
        return []
    # 1) word를 세그먼트에 귀속 (시간순), 백채널 run은 주변 화자로 재귀속
    ordered = sorted(words, key=lambda w: w.start_ms)
    assignment = [(w, _segment_for(w, segments)) for w in ordered]
    seg_index = {id(s): i for i, s in enumerate(segments)}
    had_words = {seg_index[id(seg)] for _, seg in assignment}
    total_ms = max((w.end_ms for w in ordered), default=0) or 1
    smooth_share = _SMOOTH_SHARE if resolve_fragment is not None else 1.0

    def phase(offset: float, share: float):
        if on_progress is None:
            return None
        return lambda at_ms: on_progress(offset + share * min(at_ms / total_ms, 1.0))

    assignment = _smooth_backchannels(assignment, arbitrate, phase(0.0, smooth_share))
    if resolve_fragment is not None:
        assignment = _absorb_fragments(
            assignment, resolve_fragment, phase(smooth_share, 1.0 - smooth_share)
        )
    if on_progress is not None:
        on_progress(1.0)

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
    merged = _merge_adjacent_same_speaker(raw)
    for idx, u in enumerate(merged):
        u.order_index = idx
    return merged


def _merge_adjacent_same_speaker(utts: list[Utterance]) -> list[Utterance]:
    """시간순 utts에서 같은 diar_label의 인접 ok 발언을 MERGE_GAP_MS 미만 간격이면 병합."""
    out: list[Utterance] = []
    counts: list[int] = []  # confidence 재평균용: 각 out 항목이 흡수한 conf 보유 utt 수
    for u in utts:
        prev = out[-1] if out else None
        if (
            prev is not None
            and prev.status == "ok"
            and u.status == "ok"
            and prev.diar_label == u.diar_label
            and u.start_ms - prev.end_ms < MERGE_GAP_MS
        ):
            prev.end_ms = max(prev.end_ms, u.end_ms)
            prev.text = f"{prev.text} {u.text}"
            if u.confidence is not None:
                if prev.confidence is None:
                    prev.confidence, counts[-1] = u.confidence, 1
                else:
                    n = counts[-1]
                    prev.confidence = (prev.confidence * n + u.confidence) / (n + 1)
                    counts[-1] = n + 1
            continue
        out.append(u)
        counts.append(1 if u.confidence is not None else 0)
    return out
