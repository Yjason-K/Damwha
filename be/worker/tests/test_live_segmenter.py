from damwha_worker.pipeline.live_segmenter import LiveSegmenter, Segment
from tests.audio_fixtures import frame_bytes
from tests.fakes import FakeStreamingVAD

FRAME_MS = 32


def _run(seg: LiveSegmenter, n: int) -> list[Segment]:
    out = []
    for i in range(n):
        out.extend(seg.push(frame_bytes(i)))
    return out


def test_emits_segment_from_pre_roll_to_end_event():
    seg = LiveSegmenter(FakeStreamingVAD({10: [("start", 0)], 40: [("end", 0)]}))
    out = _run(seg, 50)
    assert len(out) == 1
    s = out[0]
    # pre-roll 200ms = 7프레임(현재 프레임 포함): 4..10 → 시작 4*32
    assert s.start_ms == 4 * FRAME_MS
    assert s.end_ms == 41 * FRAME_MS
    assert len(s.pcm) == 37 * 1024
    assert s.pcm[:1024] == frame_bytes(4) and s.pcm[-1024:] == frame_bytes(40)


def test_drops_segments_shorter_than_min():
    seg = LiveSegmenter(FakeStreamingVAD({10: [("start", 0)], 11: [("end", 0)]}))
    assert _run(seg, 20) == []  # 8프레임 = 256ms < 300ms


def test_force_cuts_at_max_and_continues_without_gap():
    seg = LiveSegmenter(FakeStreamingVAD({0: [("start", 0)]}), max_segment_ms=15000)
    out = _run(seg, 1000)
    assert len(out) == 2
    first, second = out
    assert first.start_ms == 0
    assert first.end_ms - first.start_ms >= 15000
    assert second.start_ms == first.end_ms
    assert second.end_ms - second.start_ms >= 15000


def test_flush_closes_the_open_segment_once():
    seg = LiveSegmenter(FakeStreamingVAD({10: [("start", 0)]}))
    assert _run(seg, 30) == []
    s = seg.flush()
    assert s is not None and s.start_ms == 4 * FRAME_MS and s.end_ms == 30 * FRAME_MS
    assert seg.flush() is None


def test_ignores_end_without_start_and_start_while_open():
    vad = FakeStreamingVAD(
        {
            3: [("end", 0)],
            10: [("start", 0)],
            12: [("start", 0)],
            20: [("end", 0)],
        }
    )
    seg = LiveSegmenter(vad)
    out = _run(seg, 25)
    assert len(out) == 1 and out[0].start_ms == 4 * FRAME_MS


def test_skip_to_repositions_absolute_time():
    # start가 건너뛴 직후 첫 프레임(vad 인덱스 0)에서 열리고, 충분한 길이 뒤 end로 닫힌다.
    vad = FakeStreamingVAD({0: [("start", 0)], 14: [("end", 0)]})
    seg = LiveSegmenter(vad)
    seg.skip_to(600_000)  # 10분 지점으로 건너뛴다
    out: list[Segment] = []
    for i in range(15):
        out.extend(seg.push(frame_bytes(i)))
    assert len(out) == 1
    assert out[0].start_ms >= 600_000


def test_skip_to_drops_open_segment():
    vad = FakeStreamingVAD({0: [("start", 0)]})
    seg = LiveSegmenter(vad)
    for i in range(12):  # end 없이 세그먼트를 열어 둔 채 최소 길이(300ms)를 넘긴다
        seg.push(frame_bytes(i))
    seg.skip_to(600_000)
    assert seg.flush() is None  # 구멍을 냈으므로 열려 있던 세그먼트는 버려진다


def test_skip_to_clears_pre_roll():
    # skip_to 이전의 5프레임은 pre-roll만 채우고 세그먼트를 열지 않는다(start는 인덱스 5).
    vad = FakeStreamingVAD({5: [("start", 0)], 20: [("end", 0)]})
    seg = LiveSegmenter(vad)
    for i in range(5):
        seg.push(frame_bytes(i))
    seg.skip_to(600_000)
    out: list[Segment] = []
    for i in range(5, 5 + 21):  # 건너뛴 뒤 vad 인덱스는 0부터 다시 세므로 start는 여섯 번째다
        out.extend(seg.push(frame_bytes(i)))
    assert len(out) == 1
    # pre-roll이 비워지지 않았다면 건너뛰기 전 프레임이 섞여 600_000보다 앞선 시각이 된다
    assert out[0].start_ms == 600_000


def test_skip_to_resets_vad():
    vad = FakeStreamingVAD({})
    seg = LiveSegmenter(vad)
    seg.push(frame_bytes(0))
    seg.push(frame_bytes(1))
    assert vad.frames_seen == 2
    seg.skip_to(1000)
    assert vad.frames_seen == 0
