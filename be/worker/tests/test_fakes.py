from damwha_worker.models.base import DiarSegment, SpeechSpan, Word
from tests.fakes import FakeDiarizer, FakeEmbedder, FakeTranscriber, FakeVAD


def test_fakes_return_canned_output():
    vad = FakeVAD([SpeechSpan(0, 1000)])
    diar = FakeDiarizer([DiarSegment("SPEAKER_00", 0, 1000)])
    emb = FakeEmbedder([[0.1] * 192])
    stt = FakeTranscriber([Word("안녕", 0, 500, 0.9)])
    assert vad.detect("x")[0].end_ms == 1000
    assert diar.diarize("x")[0].diar_label == "SPEAKER_00"
    assert len(emb.embed("x", diar.diarize("x"))[0]) == 192
    assert stt.transcribe("x", "ko")[0].text == "안녕"
