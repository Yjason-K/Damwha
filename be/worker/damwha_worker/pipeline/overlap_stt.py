"""겹침 구간 2차 전사 — transcribe_failed 행의 텍스트 회수.

1차 STT는 VAD span 단위로 한 번 돌고, 단어는 중점 기준으로 더 긴 diar 세그먼트에
붙는다(align._segment_for). 두 사람이 겹치면 짧은 쪽 세그먼트는 단어를 하나도
못 받고 transcribe_failed가 된다 — 그 사람의 말은 애초에 생성된 적이 없다.
실측(mtg_26, 43분 5인 토크): failed 105행 195초, 그중 96행이 다른 화자 ok 발언과
겹침. 전체 텍스트의 12%가 이렇게 빠졌다.

여기서는 그 세그먼트만 clip으로 잘라 Whisper를 다시 돌린다. Whisper는 목소리를
분리하지 못하므로 결과는 둘 중 하나다:
  - 겹친 화자 본인의 말 (스파이크: 105개 중 59개) → ok로 승격
  - 지배 화자의 말을 다시 받아쓴 중복 (46개) → 이웃 ok 텍스트와 최장 공통 부분
    문자열 비율로 걸러 failed 유지
빈 결과는 없었다. 회수량은 빠진 텍스트의 약 25% — Whisper 한계 안에서의 상한.
"""

from difflib import SequenceMatcher

from ..models.base import SpeechSpan, Word
from .align import Utterance

# 이보다 짧은 failed 행은 재전사하지 않는다 — 1초 미만 겹침 파편은 단어가 못 나온다.
MIN_TARGET_MS = 1000
# 2차 결과와 이웃 ok 텍스트의 최장 공통 부분 문자열 비율이 이 이상이면 중복.
# 스파이크에서 진짜 중복은 대부분 1.0, 새 텍스트는 ≤0.46, 0.5 근처는 조사만 다른
# 사실상 중복("그건 아닌 거/것 같고요")이라 0.5를 경계로 잡는다.
DUP_THRESHOLD = 0.5
# 이웃 판정 범위: 대상 구간 앞뒤 이만큼 안에 걸친 ok 발언을 비교 대상으로 삼는다.
NEIGHBOR_PAD_MS = 2000


def select_overlap_targets(utts: list[Utterance], min_ms: int = MIN_TARGET_MS) -> list[Utterance]:
    return [u for u in utts if u.status == "transcribe_failed" and u.end_ms - u.start_ms >= min_ms]


def _squash(s: str) -> str:
    return "".join(s.split())


def is_duplicate(text: str, neighbor_texts: list[str], threshold: float = DUP_THRESHOLD) -> bool:
    t = _squash(text)
    if not t:
        return True
    n = _squash(" ".join(neighbor_texts))
    if not n:
        return False
    m = SequenceMatcher(None, t, n, autojunk=False).find_longest_match(0, len(t), 0, len(n))
    return m.size / len(t) >= threshold


def apply_overlap_words(
    utts: list[Utterance],
    targets: list[Utterance],
    words: list[Word],
    dedupe_threshold: float = DUP_THRESHOLD,
) -> list[Utterance]:
    """2차 STT 단어를 대상 행에 붙인다. 새 텍스트면 ok로 승격, 중복/무단어면 그대로.

    utts를 제자리에서 수정해 돌려준다 — order_index와 이웃 행은 건드리지 않는다.
    """
    ok_rows = [u for u in utts if u.status == "ok" and u.text]
    for target in targets:
        mine = sorted(
            (w for w in words if target.start_ms <= (w.start_ms + w.end_ms) // 2 < target.end_ms),
            key=lambda w: w.start_ms,
        )
        if not mine:
            continue
        text = " ".join(w.text for w in mine)
        neighbors = [
            o.text
            for o in ok_rows
            if o.start_ms < target.end_ms + NEIGHBOR_PAD_MS
            and o.end_ms > target.start_ms - NEIGHBOR_PAD_MS
        ]
        if is_duplicate(text, neighbors, dedupe_threshold):
            continue
        confs = [w.confidence for w in mine if w.confidence is not None]
        target.text = text
        target.confidence = (sum(confs) / len(confs)) if confs else None
        target.status = "ok"
    return utts


def spans_for(targets: list[Utterance]) -> list[SpeechSpan]:
    return [SpeechSpan(t.start_ms, t.end_ms) for t in targets]
