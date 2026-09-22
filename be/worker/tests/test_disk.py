import pytest

from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.disk import check_free_space, format_bytes, free_bytes


def test_free_bytes_is_positive(tmp_path):
    assert free_bytes(str(tmp_path)) > 0


def test_format_bytes_reads_like_a_person_wrote_it():
    assert format_bytes(0) == "0 B"
    assert format_bytes(1_500) == "1.5 KB"
    assert format_bytes(12_300_000_000) == "12.3 GB"


def test_check_passes_when_there_is_room(tmp_path):
    check_free_space(str(tmp_path), needed=1)  # 던지지 않는다


def test_check_raises_permanent_when_short(tmp_path):
    with pytest.raises(WorkerError) as e:
        check_free_space(str(tmp_path), needed=free_bytes(str(tmp_path)) + 10**12)
    assert e.value.kind is ErrorKind.PERMANENT
    assert e.value.code == "DISK_FULL"
    # 화면 문구가 남은 용량과 필요한 용량 둘을 말해야 한다 (causes.ts의 diskFull이 정한 모양)
    assert "남은 용량" in str(e.value)
    assert "필요한 용량" in str(e.value)


def test_check_skips_when_needed_is_unknown(tmp_path):
    # 필요한 용량을 모르면 막지 않는다 — 추정으로 막으면 받을 수 있는 것을 못 받는다
    check_free_space(str(tmp_path), needed=None)


def test_check_skips_when_path_is_missing(tmp_path):
    # 경로가 아직 없으면(첫 다운로드) 가장 가까운 상위로 올라가 잰다
    check_free_space(str(tmp_path / "not" / "yet"), needed=1)
