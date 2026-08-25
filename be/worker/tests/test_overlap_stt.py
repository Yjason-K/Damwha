from damwha_worker.models.base import Word
from damwha_worker.pipeline.align import Utterance
from damwha_worker.pipeline.overlap_stt import (
    apply_overlap_words,
    is_duplicate,
    select_overlap_targets,
)


def _u(label, start, end, status, text=None, idx=0):
    return Utterance(label, label, start, end, text, None, status, idx)


def test_select_targets_takes_failed_rows_at_least_1s():
    utts = [
        _u("A", 0, 5000, "ok", "본문"),
        _u("B", 1000, 2500, "transcribe_failed"),
        _u("C", 3000, 3800, "transcribe_failed"),  # < 1s
        _u("D", 6000, 8000, "silence"),
    ]
    assert [t.diar_label for t in select_overlap_targets(utts)] == ["B"]


def test_is_duplicate_by_longest_common_substring_ratio():
    assert is_duplicate("약간 늘어진다", ["그건 없어요 약간 늘어진다 싶으면"]) is True
    assert is_duplicate("그건 아닌 거 같고요", ["그건 아닌 것 같고요 보통"]) is True  # 0.5 경계
    assert is_duplicate("저도 재밌게 봤어요", ["색깔도 다양해요 제가 존경하는"]) is False
    assert is_duplicate("", ["뭐든"]) is True  # 빈 결과는 살릴 게 없다


def test_apply_promotes_new_text_and_keeps_duplicates_failed():
    ok = _u("A", 0, 6000, "ok", "지금 보니까 턱을 괴고 계시고", idx=0)
    fresh = _u("B", 1000, 3000, "transcribe_failed", idx=1)
    dup = _u("C", 4000, 5500, "transcribe_failed", idx=2)
    utts = [ok, fresh, dup]
    words = [
        Word("시간만", 1200, 1800, 0.8),
        Word("재고", 1900, 2400, 0.6),
        Word("턱을", 4200, 4600, 0.9),
        Word("괴고", 4700, 5200, 0.9),
    ]
    out = apply_overlap_words(utts, [fresh, dup], words)
    assert out is utts
    assert (fresh.status, fresh.text) == ("ok", "시간만 재고")
    assert abs(fresh.confidence - 0.7) < 1e-6
    assert (dup.status, dup.text) == ("transcribe_failed", None)
    assert ok.text == "지금 보니까 턱을 괴고 계시고"  # 이웃은 손대지 않는다


def test_apply_with_no_words_for_a_target_leaves_it_failed():
    t = _u("B", 1000, 3000, "transcribe_failed")
    apply_overlap_words([t], [t], [])
    assert t.status == "transcribe_failed"
