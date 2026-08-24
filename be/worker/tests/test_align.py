from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
from damwha_worker.pipeline.align import build_utterances


def test_assigns_words_by_midpoint_and_merges_consecutive():
    segments = [DiarSegment("S0", 0, 1000), DiarSegment("S1", 1000, 2000)]
    words = [
        Word("안녕", 0, 400, 0.9),  # mid 200 → S0
        Word("하세요", 400, 900, 0.8),  # mid 650 → S0
        Word("반가워", 1100, 1500, 0.7),  # mid 1300 → S1
    ]
    utts = build_utterances(words, segments)
    assert len(utts) == 2
    assert utts[0].diar_label == "S0" and utts[0].text == "안녕 하세요" and utts[0].status == "ok"
    assert utts[0].order_index == 0
    assert abs(utts[0].confidence - 0.85) < 1e-6
    assert utts[1].diar_label == "S1" and utts[1].text == "반가워"


def test_speaker_change_splits_even_if_adjacent():
    segments = [DiarSegment("S0", 0, 500), DiarSegment("S1", 500, 1000)]
    words = [Word("a", 0, 200, None), Word("b", 600, 800, None)]
    utts = build_utterances(words, segments)
    assert [u.diar_label for u in utts] == ["S0", "S1"]


def test_silence_segment_with_no_words():
    segments = [DiarSegment("S0", 0, 1000)]
    utts = build_utterances([], segments)
    assert len(utts) == 1 and utts[0].status == "silence" and utts[0].text is None


def test_transcribe_failed_span():
    segments = [DiarSegment("S0", 0, 1000)]
    utts = build_utterances([], segments, failed_spans=[SpeechSpan(0, 1000)])
    assert utts[0].status == "transcribe_failed" and utts[0].text is None


def test_order_index_is_time_ordered():
    segments = [DiarSegment("S1", 1000, 2000), DiarSegment("S0", 0, 1000)]
    words = [Word("late", 1100, 1200, None), Word("early", 100, 200, None)]
    utts = build_utterances(words, segments)
    assert [u.order_index for u in utts] == [0, 1]
    assert utts[0].start_ms < utts[1].start_ms


def test_empty_segments_returns_empty():
    assert build_utterances([Word("hi", 0, 500, 0.9)], []) == []


def test_wordless_sliver_segment_dropped():
    # 1초 미만 무단어 diar 세그먼트(화자 겹침 파편)는 row를 만들지 않는다 —
    # 전사 불가능한 파편이 transcribe_failed/silence 노이즈 row로 쌓이는 것 방지
    segments = [DiarSegment("S0", 0, 5000), DiarSegment("S1", 2000, 2400)]
    words = [Word("안녕", 100, 600, 0.9)]
    utts = build_utterances(words, segments, failed_spans=[SpeechSpan(0, 5000)])
    assert [u.diar_label for u in utts] == ["S0"]
    assert utts[0].order_index == 0


def test_wordless_segment_at_1s_threshold_kept():
    segments = [DiarSegment("S0", 0, 1000), DiarSegment("S1", 1000, 2000)]
    words = [Word("안녕", 100, 600, 0.9)]
    utts = build_utterances(words, segments, failed_spans=[])
    assert [u.status for u in utts] == ["ok", "silence"]


def test_short_segment_with_words_is_kept():
    # 짧아도 단어가 있으면 유지 (drop은 무단어에만 적용)
    segments = [DiarSegment("S0", 0, 400)]
    words = [Word("응", 100, 300, 0.9)]
    utts = build_utterances(words, segments, failed_spans=[])
    assert len(utts) == 1 and utts[0].status == "ok"


def test_midpoint_in_overlapping_segments_prefers_longer():
    # 겹침 구간에서 word 중점이 두 세그먼트 모두에 들어가면 지배적(더 긴) 세그먼트 선택.
    # 백채널 B(500-3000)가 본 화자 A(1000-10000)보다 먼저 시작해도 A가 이겨야 한다.
    segments = [DiarSegment("B", 500, 3000), DiarSegment("A", 1000, 10000)]
    words = [Word("본문", 1200, 1800, 0.9)]  # mid 1500 → B와 A 모두 포함
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert len(ok) == 1 and ok[0].diar_label == "A"


def test_short_overlapping_backchannel_run_reabsorbed():
    # A 발화 도중 백채널 B 세그먼트(A1/A2와 시간 겹침)가 word를 탈취한 경우,
    # 짧은 B run은 주변 화자 A로 재귀속되고 빈 B 세그먼트는 row를 만들지 않는다.
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 3900, 5100),
        DiarSegment("A", 5000, 9000),
    ]
    words = [
        Word("나라가", 1000, 1500, 0.9),
        Word("잘", 2000, 2500, 0.9),
        Word("사는", 4300, 4700, 0.9),  # mid 4500 → B에만 포함 (탈취)
        Word("거하고", 5500, 6000, 0.9),
        Word("체감", 6500, 7000, 0.9),
    ]
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "A"]
    assert ok[0].text == "나라가 잘 사는"
    assert ok[1].text == "거하고 체감"
    assert all(u.diar_label != "B" for u in utts)


def test_short_nonoverlapping_turn_is_preserved():
    # 겹침 없는 진짜 짧은 발언("말고")은 스무딩 대상 아님 — 그대로 유지
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 4000, 4800),
        DiarSegment("A", 4800, 9000),
    ]
    words = [
        Word("집에", 1000, 1500, 0.9),
        Word("가지", 2000, 2500, 0.9),
        Word("말고", 4200, 4600, 0.9),
        Word("일하자", 5000, 5500, 0.9),
    ]
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]


def test_long_overlapping_run_not_reabsorbed():
    # 겹쳐도 run이 충분히 길면(>=2초) 진짜 발언일 수 있으므로 재귀속하지 않는다
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 3900, 8100),
        DiarSegment("A", 8000, 12000),
    ]
    words = [
        Word("앞", 1000, 1500, 0.9),
        Word("긴", 4300, 4800, 0.9),
        Word("발언", 5500, 6000, 0.9),
        Word("이다", 7000, 7600, 0.9),  # B run: 4300-7600 = 3300ms
        Word("뒤", 8500, 9000, 0.9),
    ]
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]


def _sandwich_fixture():
    # A(0-4000), B(4000-4800), A(4800-9000): 겹침 없는 0.4초 B run ("말고" 패턴)
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 4000, 4800),
        DiarSegment("A", 4800, 9000),
    ]
    words = [
        Word("집에", 1000, 1500, 0.9),
        Word("가지", 2000, 2500, 0.9),
        Word("말고", 4200, 4600, 0.9),
        Word("일하자", 5000, 5500, 0.9),
    ]
    return segments, words


def test_arbitrate_true_absorbs_nonoverlapping_run():
    # 임베딩 판정자가 True면 겹침 없는 micro-run도 흡수된다
    segments, words = _sandwich_fixture()
    calls = []

    def arbitrate(start_ms, end_ms, own, neighbor):
        calls.append((start_ms, end_ms, own, neighbor))
        return True

    utts = build_utterances(words, segments, arbitrate=arbitrate)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "A"]
    assert ok[0].text == "집에 가지 말고"
    assert calls == [(4200, 4600, "B", "A")]


def test_arbitrate_false_preserves_overlapping_short_run():
    # 판정자가 False면 겹침+짧음이라도 보존 (진짜 끼어든 질문 보호)
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 3900, 5100),
        DiarSegment("A", 5000, 9000),
    ]
    words = [
        Word("나라가", 1000, 1500, 0.9),
        Word("진짜", 4300, 4700, 0.9),
        Word("질문", 4700, 5000, 0.9),
        Word("거하고", 5500, 6000, 0.9),
    ]
    utts = build_utterances(words, segments, arbitrate=lambda *a: False)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]


def test_arbitrate_widens_run_cap_to_5s():
    # 판정자가 있으면 2초 이상~5초 미만 run도 후보가 된다 (09:45 케이스)
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 4000, 8500),
        DiarSegment("A", 8500, 12000),
    ]
    words = [
        Word("앞", 1000, 1500, 0.9),
        Word("잘", 4200, 4700, 0.9),
        Word("사는", 5500, 6000, 0.9),
        Word("거하고", 7500, 8200, 0.9),  # B run 4200-8200 = 4000ms
        Word("뒤", 9000, 9500, 0.9),
    ]
    utts = build_utterances(words, segments, arbitrate=lambda *a: True)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "A"]


def test_arbitrate_run_over_5s_not_candidate():
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 4000, 10500),
        DiarSegment("A", 10500, 14000),
    ]
    words = [
        Word("앞", 1000, 1500, 0.9),
        Word("긴", 4200, 4700, 0.9),
        Word("발언", 9500, 10200, 0.9),  # B run 4200-10200 = 6000ms
        Word("뒤", 11000, 11500, 0.9),
    ]
    calls = []
    utts = build_utterances(words, segments, arbitrate=lambda *a: calls.append(a) or True)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]
    assert calls == []


def test_arbitrate_none_falls_back_to_overlap_heuristic():
    # 판정 불가(None)면 기존 휴리스틱: 겹침+2초 미만만 흡수
    overlap_segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 3900, 5100),
        DiarSegment("A", 5000, 9000),
    ]
    overlap_words = [
        Word("앞", 1000, 1500, 0.9),
        Word("탈취", 4300, 4700, 0.9),
        Word("뒤", 5500, 6000, 0.9),
    ]
    utts = build_utterances(overlap_words, overlap_segments, arbitrate=lambda *a: None)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "A"]

    nonoverlap_segments, nonoverlap_words = _sandwich_fixture()
    utts = build_utterances(nonoverlap_words, nonoverlap_segments, arbitrate=lambda *a: None)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]
