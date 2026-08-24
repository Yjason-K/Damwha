"""too_short_for_embedding 순수 헬퍼 테스트.

실 ECAPA 어댑터의 "너무 짧음" 분기 기준을 CI에서 직접 검증한다
(ecapa_embed.py의 top-level import는 .base뿐이라 models extra 없이 import 가능).
어댑터 end-to-end는 SMOKE 소관.
"""

from damwha_worker.models.ecapa_embed import too_short_for_embedding

_SR = 16000


def test_below_100ms_is_too_short():
    assert too_short_for_embedding(int(0.099 * _SR), _SR) is True


def test_100ms_and_above_is_ok():
    # 경계: 정확히 100ms(1600 samples @16k)는 임베딩 가능 (기존 < 비교와 동치)
    assert too_short_for_embedding(int(0.1 * _SR), _SR) is False
    assert too_short_for_embedding(_SR, _SR) is False


def test_zero_samples_is_too_short():
    assert too_short_for_embedding(0, _SR) is True
