from damwha_worker.models.base import DiarSegment
from damwha_worker.models.pyannote_diar import PyannoteDiarizer


class _Turn:
    def __init__(self, start, end):
        self.start, self.end = start, end


class _Annotation:
    def __init__(self, tracks):
        self._tracks = tracks

    def itertracks(self, yield_label=False):
        for start, end, label in self._tracks:
            yield _Turn(start, end), None, label


class _Pipeline:
    def __init__(self):
        self.calls = []

    def __call__(self, file, **kwargs):
        self.calls.append(kwargs)
        return _Annotation([(0.0, 1.0, "SPEAKER_00")])


def _diarizer(monkeypatch, pipeline):
    monkeypatch.setattr(
        "damwha_worker.models.audio_io.load_mono_tensor", lambda p: (_FakeTensor(), 16000)
    )
    return PyannoteDiarizer.from_pipeline(pipeline)


class _FakeTensor:
    def unsqueeze(self, _):
        return self


def test_speaker_bounds_forwarded_to_pipeline(monkeypatch):
    pipeline = _Pipeline()
    diar = _diarizer(monkeypatch, pipeline)
    diar.diarize("x.wav", min_speakers=2, max_speakers=4)
    assert pipeline.calls == [{"min_speakers": 2, "max_speakers": 4}]


def test_unbounded_call_passes_no_speaker_kwargs(monkeypatch):
    pipeline = _Pipeline()
    diar = _diarizer(monkeypatch, pipeline)
    segs = diar.diarize("x.wav")
    assert pipeline.calls == [{}]
    assert segs == [DiarSegment("SPEAKER_00", 0, 1000)]
