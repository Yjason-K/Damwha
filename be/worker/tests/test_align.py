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


def test_midpoint_in_overlapping_segments_prefers_later_start():
    # 겹침 구간에서 word 중점이 두 세그먼트 모두에 들어가면 늦게 시작한 세그먼트 선택.
    # B(500-3000)가 A(1000-10000)보다 먼저 시작했으므로 겹침 구간의 단어는 A다.
    segments = [DiarSegment("B", 500, 3000), DiarSegment("A", 1000, 10000)]
    words = [Word("본문", 1200, 1800, 0.9)]  # mid 1500 → B와 A 모두 포함
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert len(ok) == 1 and ok[0].diar_label == "A"


def test_next_speaker_opening_inside_previous_segment_goes_to_next():
    # 앞 화자 A의 세그먼트 끝(0-6000)이 이어 말하는 B(5000-9000)의 시작을 덮는 경우.
    # 예전 규칙(더 긴 세그먼트)은 B의 첫마디를 A에게 넘겼다 — 클로바노트 대비 실측 증상.
    segments = [DiarSegment("A", 0, 6000), DiarSegment("B", 5000, 9000)]
    words = [
        Word("그렇죠", 1000, 1600, 0.9),
        Word("그러니까", 5100, 5700, 0.9),  # mid 5400 → A·B 모두 포함
        Word("제", 6200, 6400, 0.9),
        Word("말은", 6400, 6900, 0.9),
    ]
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert [(u.diar_label, u.text) for u in ok] == [("A", "그렇죠"), ("B", "그러니까 제 말은")]


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
    # 회수 후 A의 두 세그먼트는 같은 화자·짧은 간격이라 한 발언으로 합쳐진다
    assert [u.diar_label for u in ok] == ["A"]
    assert ok[0].text == "나라가 잘 사는 거하고 체감"
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
    assert [u.diar_label for u in ok] == ["A"]
    assert ok[0].text.startswith("집에 가지 말고")
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
    assert {u.diar_label for u in ok} == {"A"}


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
    assert {u.diar_label for u in ok} == {"A"}

    nonoverlap_segments, nonoverlap_words = _sandwich_fixture()
    utts = build_utterances(nonoverlap_words, nonoverlap_segments, arbitrate=lambda *a: None)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]


def test_consecutive_same_speaker_segments_with_short_gap_merge():
    # pyannote splits one speaker's turn at every pause; a 600ms gap is the same utterance
    segments = [DiarSegment("S0", 0, 1000), DiarSegment("S0", 1600, 3000)]
    words = [Word("하나", 100, 900, 0.8), Word("둘", 1700, 2900, 0.6)]
    utts = build_utterances(words, segments)
    assert len(utts) == 1
    assert utts[0].text == "하나 둘"
    assert (utts[0].start_ms, utts[0].end_ms) == (100, 2900)
    assert abs(utts[0].confidence - 0.7) < 1e-6
    assert utts[0].order_index == 0


def test_consecutive_same_speaker_segments_with_long_gap_stay_split():
    segments = [DiarSegment("S0", 0, 1000), DiarSegment("S0", 3000, 4000)]
    words = [Word("하나", 100, 900, None), Word("둘", 3100, 3900, None)]
    utts = build_utterances(words, segments)
    assert [u.text for u in utts] == ["하나", "둘"]


def test_other_speaker_between_prevents_merge():
    segments = [
        DiarSegment("S0", 0, 1000),
        DiarSegment("S1", 1000, 2000),
        DiarSegment("S0", 2000, 3000),
    ]
    words = [Word("a", 100, 900, None), Word("b", 1100, 1900, None), Word("c", 2100, 2900, None)]
    utts = build_utterances(words, segments)
    assert [u.diar_label for u in utts] == ["S0", "S1", "S0"]


def test_non_ok_rows_are_not_merged():
    # silence row + ok row of the same speaker stay separate — merging would fabricate text span
    segments = [DiarSegment("S0", 0, 1500), DiarSegment("S0", 1600, 3000)]
    words = [Word("둘", 1700, 2900, None)]
    utts = build_utterances(words, segments)
    assert [u.status for u in utts] == ["silence", "ok"]


def _alternating_fragments():
    # A 발언 사이에 B로 한 단어만 튄 모양 (실측 02:13 구간의 형태). 세그먼트가 겹치지
    # 않아 백채널 스무딩의 겹침 휴리스틱은 손대지 않는다 — 조각 흡수만 시험한다.
    segments = [
        DiarSegment("A", 0, 2000),
        DiarSegment("B", 2000, 2600),
        DiarSegment("A", 2600, 6000),
    ]
    words = [
        Word("경고", 300, 700, 0.9),
        Word("드리겠습니다", 700, 1500, 0.9),
        Word("자꾸", 1500, 1900, 0.9),
        Word("말씀하시는데", 2100, 2500, 0.9),  # mid 2300 → B
        Word("경고예요", 3000, 3600, 0.9),
        Word("단호하게", 3600, 4200, 0.9),
        Word("가겠습니다", 4200, 5000, 0.9),
    ]
    return segments, words


def test_fragment_without_resolver_is_left_alone():
    segments, words = _alternating_fragments()
    utts = build_utterances(words, segments)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]


def test_fragment_absorbed_into_neighbor_the_resolver_picks():
    segments, words = _alternating_fragments()
    calls = []

    def resolve(start_ms, end_ms, own, candidates):
        calls.append((start_ms, end_ms, own, sorted(candidates)))
        return "A"

    utts = build_utterances(words, segments, resolve_fragment=resolve)
    ok = [u for u in utts if u.status == "ok"]
    assert [(u.diar_label, u.text) for u in ok] == [
        ("A", "경고 드리겠습니다 자꾸 말씀하시는데 경고예요 단호하게 가겠습니다")
    ]
    assert calls == [(2100, 2500, "B", ["A"])]


def test_fragment_kept_when_resolver_says_own_voice():
    segments, words = _alternating_fragments()
    utts = build_utterances(words, segments, resolve_fragment=lambda s, e, own, c: own)
    ok = [u for u in utts if u.status == "ok"]
    assert [u.diar_label for u in ok] == ["A", "B", "A"]


def test_undecidable_fragment_goes_to_nearer_neighbor_in_time():
    # 판정 불가(None)면 시간상 더 가까운 이웃 화자에게 붙인다
    segments = [
        DiarSegment("A", 0, 2000),
        DiarSegment("B", 2000, 2400),
        DiarSegment("C", 2400, 8000),
    ]
    words = [
        Word("앞에", 0, 400, 0.9),
        Word("하던", 400, 700, 0.9),
        Word("말", 700, 1000, 0.9),
        Word("음", 2100, 2300, 0.9),  # A 끝(1000)과 1100ms, C 시작(2400)과 100ms
        Word("뒷말은", 2400, 3500, 0.9),
        Word("길게", 3500, 4500, 0.9),
        Word("이어진다", 4500, 5500, 0.9),
    ]
    utts = build_utterances(words, segments, resolve_fragment=lambda *a: None)
    ok = [u for u in utts if u.status == "ok"]
    assert [(u.diar_label, u.text) for u in ok] == [
        ("A", "앞에 하던 말"),
        ("C", "음 뒷말은 길게 이어진다"),
    ]


def test_three_word_run_over_one_second_is_not_a_fragment():
    segments = [DiarSegment("A", 0, 3000), DiarSegment("B", 3000, 6000)]
    words = [
        Word("하나", 0, 1000, 0.9),
        Word("둘", 3000, 3500, 0.9),
        Word("셋", 3500, 4000, 0.9),
        Word("넷", 4000, 4500, 0.9),
    ]
    calls = []
    build_utterances(words, segments, resolve_fragment=lambda *a: calls.append(a) or "A")
    # A의 '하나'는 1단어라 조각이지만, B run은 3단어·1.5초라 조각이 아니다
    assert [c[2] for c in calls] == ["A"]


def test_on_progress_reports_fractions_through_both_passes():
    segments = [
        DiarSegment("A", 0, 4000),
        DiarSegment("B", 3900, 5100),
        DiarSegment("A", 5000, 9000),
    ]
    words = [
        Word("나라가", 1000, 1500, 0.9),
        Word("잘", 2000, 2500, 0.9),
        Word("사는", 4300, 4700, 0.9),
        Word("거하고", 5500, 6000, 0.9),
        Word("체감", 6500, 7000, 0.9),
    ]
    seen: list[float] = []
    build_utterances(
        words, segments, resolve_fragment=lambda s, e, own, c: own, on_progress=seen.append
    )
    assert seen and all(0.0 <= f <= 1.0 for f in seen)
    assert seen[-1] == 1.0
