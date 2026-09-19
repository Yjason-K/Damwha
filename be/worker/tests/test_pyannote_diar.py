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


# ── 401·403 보존 (스펙 §8, P4-C8) ─────────────────────────────────────


class _Response:
    def __init__(self, status_code):
        self.status_code = status_code


class HfHubHTTPError(Exception):
    """huggingface_hub 없이 판별 경로를 본다 — 판별은 `.response.status_code`로 한다."""

    def __init__(self, status):
        super().__init__(f"{status} Client Error")
        self.response = _Response(status)


class GatedRepoError(HfHubHTTPError):
    pass


def _loading_raises(monkeypatch, exc):
    import sys
    import types

    class Pipeline:
        @staticmethod
        def from_pretrained(model, token=None):
            raise exc

    audio = types.ModuleType("pyannote.audio")
    audio.Pipeline = Pipeline
    pkg = types.ModuleType("pyannote")
    pkg.__path__ = []
    pkg.audio = audio
    monkeypatch.setitem(sys.modules, "pyannote", pkg)
    monkeypatch.setitem(sys.modules, "pyannote.audio", audio)
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))


MODEL = "pyannote/speaker-diarization-community-1"


def test_401_is_a_permanent_token_error(monkeypatch):
    from damwha_worker.errors import HF_TOKEN_INVALID, ErrorKind, WorkerError, classify

    _loading_raises(monkeypatch, HfHubHTTPError(401))

    try:
        PyannoteDiarizer(MODEL, "hf_bad", "cpu")
    except WorkerError as e:
        assert (e.code, e.kind) == (HF_TOKEN_INVALID, ErrorKind.PERMANENT)
        assert "token" in e.message and "401" in e.message
        assert classify(e) is e
    else:
        raise AssertionError("expected WorkerError")


def test_403_is_a_permanent_gate_error_pointing_at_the_model(monkeypatch):
    from damwha_worker.errors import HF_GATE_NOT_ACCEPTED, ErrorKind, WorkerError

    _loading_raises(monkeypatch, GatedRepoError(403))

    try:
        PyannoteDiarizer(MODEL, "hf_ok", "cpu")
    except WorkerError as e:
        assert (e.code, e.kind) == (HF_GATE_NOT_ACCEPTED, ErrorKind.PERMANENT)
        assert f"https://huggingface.co/{MODEL}" in e.message
        assert "403" in e.message
    else:
        raise AssertionError("expected WorkerError")


def test_401_and_403_messages_differ(monkeypatch):
    from damwha_worker.errors import WorkerError

    messages = []
    for exc in (HfHubHTTPError(401), GatedRepoError(403)):
        _loading_raises(monkeypatch, exc)
        try:
            PyannoteDiarizer(MODEL, "hf_x", "cpu")
        except WorkerError as e:
            messages.append((e.code, e.message))
    assert len({code for code, _ in messages}) == 2
    assert messages[0][1] != messages[1][1]


def test_wrapped_403_is_still_recognised(monkeypatch):
    from damwha_worker.errors import HF_GATE_NOT_ACCEPTED, WorkerError

    try:
        raise GatedRepoError(403)
    except GatedRepoError as inner:
        wrapped = OSError("gated")
        wrapped.__cause__ = inner
    _loading_raises(monkeypatch, wrapped)

    try:
        PyannoteDiarizer(MODEL, "hf_ok", "cpu")
    except WorkerError as e:
        assert e.code == HF_GATE_NOT_ACCEPTED
    else:
        raise AssertionError("expected WorkerError")


def test_other_load_failures_propagate_unchanged(monkeypatch):
    boom = ConnectionError("network down")
    _loading_raises(monkeypatch, boom)

    try:
        PyannoteDiarizer(MODEL, "hf_ok", "cpu")
    except ConnectionError as e:
        assert e is boom
    else:
        raise AssertionError("expected ConnectionError")
