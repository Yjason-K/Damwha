"""ensure_sample_rate 순수 헬퍼 테스트.

audio_io는 어댑터가 torchaudio/torchcodec 대신 쓰는 로드 진입점이다. 무거운
import는 함수 안에 있어 models extra 없이 모듈 import가 되고, 정규화 계약
(16 kHz)을 강제하는 분기만 CI에서 직접 검증한다. 실제 디코딩은 SMOKE 소관.
"""

import pytest

from damwha_worker.models.audio_io import SR, UnexpectedSampleRate, ensure_sample_rate


def test_expected_rate_passes_through():
    assert ensure_sample_rate(SR) == SR


def test_mismatched_rate_raises_instead_of_resampling():
    with pytest.raises(UnexpectedSampleRate) as e:
        ensure_sample_rate(44100)
    # 메시지가 복구 방법(정규화 먼저)을 알려줘야 한다
    assert "normalize" in str(e.value)


def test_unexpected_sample_rate_is_a_value_error():
    # classify()가 ValueError 계열로 취급하도록 상속을 고정한다
    assert issubclass(UnexpectedSampleRate, ValueError)
