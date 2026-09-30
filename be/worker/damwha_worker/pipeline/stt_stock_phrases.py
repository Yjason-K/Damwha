"""Whisper 상투구 환각 제거 (pure).

Whisper는 말이 거의 없는 짧은 clip(기침·웃음·키보드·숨소리)을 받으면 학습 데이터의
**유튜브 자막 맺음말**을 뱉는다 — "감사합니다.", "시청해주셔서 감사합니다.", "다음 영상에서
만나요.", "한글자막". 2026-09-30 실측에서 이 출력은 기존 방어를 모두 통과했다:

  - VAD: 소음도 발화 구간으로 잡혀 clip으로 들어온다.
  - `hallucination_silence_threshold=2.0`: 앞뒤 2초+ 무음이 있어야 작동한다. clip은 VAD
    구간 + 200ms 패드라 1초 안팎이다.
  - 내장 무음 스킵(`no_speech_prob > 0.6` **그리고** `avg_logprob < -1`): large-v3-turbo의
    no_speech_prob는 mtg_17의 VAD clip 207개(세그먼트 707개) 전부에서 0.000이었다. 환각
    세그먼트의 avg_logprob도 -0.31 ~ -0.98로 -1을 넘는다.

그래서 stt_repetition과 같은 자리에서, 같은 이유로 출력에서 걷어낸다.

판정은 **Whisper 세그먼트 하나**를 단위로 한다. 문장 중간에 박힌 "감사합니다"도 전사
단계에서는 독립 세그먼트였다 — align이 옆 발화와 합쳐 문장 안으로 들어간 것이다. 그래서
세그먼트 전체가 상투구로만 이루어졌을 때만 버리고, 문장의 일부인 상투구는 건드리지 않는다.

확률 조건이 진짜 인사를 살린다. mtg_17 재현에서 상투구 단독 세그먼트 9개의 단어 확률은
0.10 ~ 0.72였고, 실제로 말한 "함께해 주셔서 감사합니다"(mtg_6)는 0.98이었다. 세그먼트의
**가장 높은** 단어 확률이 `MAX_CONFIDENCE` 미만일 때만 버린다 — 한 단어라도 확신하면 남긴다.
"""

import re

from ..models.base import Word

# 관측된 환각 0.72 위, 실제 발화 0.98 아래. 경계에 걸린 진짜 "감사합니다"를 잃는 것은 한 마디지만,
# 환각은 회의 하나에 수십 번 끼어든다 (mtg_17: 단독 "감사합니다." 발화 20개+).
MAX_CONFIDENCE = 0.8

# 공백·문장부호를 걷어낸 모양으로 적는다. 세그먼트는 이것들의 반복·연쇄여야 한다
# ("감사합니다. 감사합니다.", "감사합니다. 다음 영상에서 만나요.").
STOCK_PHRASES = (
    "감사합니다",
    "시청해주셔서감사합니다",
    "시청해주셔서고맙습니다",
    "다음영상에서만나요",
    "구독과좋아요부탁드립니다",
    "한글자막",
)

_STOCK_RUN = re.compile("(?:" + "|".join(STOCK_PHRASES) + ")+")
_NOISE = re.compile(r"[\s\W_]+")


def is_stock_hallucination(segment: list[Word]) -> bool:
    if not segment:
        return False
    text = _NOISE.sub("", "".join(w.text for w in segment))
    if not _STOCK_RUN.fullmatch(text):
        return False
    # 확률이 없는 단어(백엔드가 주지 않음)는 판정 근거가 없으니 확신한 것으로 본다 — 남긴다.
    top = max(1.0 if w.confidence is None else w.confidence for w in segment)
    return top < MAX_CONFIDENCE


def drop_stock_hallucination(segment: list[Word]) -> list[Word]:
    """Whisper 세그먼트 하나의 단어들. 상투구 환각이면 빈 리스트, 아니면 그대로."""
    return [] if is_stock_hallucination(segment) else segment
