from damwha_worker.models.base import Word
from damwha_worker.pipeline.stt_repetition import drop_repetition_loops


def w(text: str, start_ms: int, end_ms: int, confidence: float = 0.95) -> Word:
    return Word(text=text, start_ms=start_ms, end_ms=end_ms, confidence=confidence)


def test_normal_speech_is_untouched():
    words = [w("안녕하세요", 0, 500), w("반갑습니다", 500, 1_100)]
    assert drop_repetition_loops(words) == words


def test_drops_a_degenerate_loop():
    # 실측 형태: 동일 토큰이 0.7초에 223회 (전부 길이 0초)
    loop = [w("CON", 4_390, 4_390) for _ in range(223)]
    words = [w("감사합니다", 4_300, 4_390), *loop]
    assert drop_repetition_loops(words) == words[:1]


def test_keeps_a_loop_that_is_slow_enough_to_be_speech():
    # "네"를 3초에 걸쳐 6번 — 사람이 실제로 낼 수 있는 속도라 남긴다
    words = [w("네", i * 500, i * 500 + 400) for i in range(6)]
    assert drop_repetition_loops(words) == words


def test_keeps_short_runs_even_when_dense():
    # 5회는 실측상 정상 범위의 상한 — 밀도가 높아도 남긴다
    words = [w("또", 1_000, 1_000) for _ in range(5)]
    assert drop_repetition_loops(words) == words


def test_drops_only_the_loop_and_keeps_surrounding_speech():
    before = [w("그래서", 0, 400), w("이제", 400, 800)]
    loop = [w("max", 1_000, 1_000) for _ in range(223)]
    after = [w("다시", 3_000, 3_400)]
    assert drop_repetition_loops([*before, *loop, *after]) == [*before, *after]


def test_handles_two_separate_loops():
    loop_a = [w("Q", 1_000, 1_000) for _ in range(111)]
    loop_b = [w("MAY", 9_000, 9_000) for _ in range(55)]
    keep = w("회의", 5_000, 5_400)
    assert drop_repetition_loops([*loop_a, keep, *loop_b]) == [keep]


def test_different_tokens_do_not_form_a_run():
    # 서로 다른 단어가 빠르게 이어지는 것은 루프가 아니다
    words = [w(t, 1_000, 1_000) for t in "가나다라마바사"]
    assert drop_repetition_loops(words) == words


def test_empty_input():
    assert drop_repetition_loops([]) == []
