"""Whisper 반복 루프 제거 (pure).

Whisper 디코더는 짧은 clip에서 같은 토큰을 상한까지 뱉는 축퇴(degenerate) 상태에
빠질 수 있고, **그 출력이 두 안전망을 모두 통과한다.** `transcribe.py`에서:

  - `compression_ratio_threshold`가 "too repetitive"로 fallback을 걸지만,
    바로 다음 분기가 `no_speech_prob > threshold`면 `needs_fallback = False`로
    되돌린다 — 짧은 clip은 30초로 패딩되어 대부분 무음이므로 항상 여기 걸린다.
  - 그러면 무음으로 스킵될 차례인데, 반복 루프는 avg_logprob이 높아
    `should_skip = False`가 되어 살아남는다.

두 우회가 같은 성질(모델이 쓰레기를 확신함)에서 나오므로 파라미터로 분리할 수
없다. `no_speech_threshold=None`은 반복 판정을 살리지만 무음 스킵도 함께 꺼서
한국어 강연 실측 CER이 5.07% → 8.82%로 악화됐다(SMOKE.md). 그래서 upstream을
설정으로 우회하는 대신 출력에서 걷어낸다. faster-whisper도 같은 로직을 물려받아
동일하게 필요하다.

판정은 두 조건을 모두 요구한다 (회의 녹음 4개 전사, 약 14,000단어 실측 기준):
  - 동일 텍스트 6회 이상 연속 — 정상 발화의 최대는 5회였고 6~10회는 0건이었다.
  - 초당 5단어 초과 — 루프는 55~223단어를 1~3초에 몰아넣는다(실측 65~147단어/초).
    사람이 낼 수 없는 밀도이므로, 진짜로 "네"를 여섯 번 말한 경우는 남는다.
"""

from itertools import groupby

from ..models.base import Word

MIN_RUN = 6
MAX_WORDS_PER_SEC = 5.0


def _is_loop(run: list[Word]) -> bool:
    if len(run) < MIN_RUN:
        return False
    # 루프는 단어 길이가 0으로 뭉개져 구간이 거의 0초가 된다 — 0 나눗셈을 피한다.
    seconds = (run[-1].end_ms - run[0].start_ms) / 1000
    return seconds <= 0 or len(run) / seconds > MAX_WORDS_PER_SEC


def drop_repetition_loops(words: list[Word]) -> list[Word]:
    kept: list[Word] = []
    for _, group in groupby(words, key=lambda w: w.text):
        run = list(group)
        if not _is_loop(run):
            kept.extend(run)
    return kept
