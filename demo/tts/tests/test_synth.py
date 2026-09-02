import io
import json

import httpx
import numpy as np
import pytest
import soundfile as sf

from damwha_demo_tts.synth import SynthRequest, Synthesizer, cache_key

SR = 24000


def wav_bytes(seconds: float) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, np.zeros(int(seconds * SR), dtype=np.float32), SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def make_synth(tmp_path, handler, key="sk-test"):
    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport, base_url="https://api.openai.com")
    return Synthesizer(api_key=key, cache_dir=tmp_path, client=client)


def test_cache_key_changes_with_any_input():
    a = cache_key(SynthRequest(voice="onyx", instructions="calm", text="안녕"))
    assert a != cache_key(SynthRequest(voice="echo", instructions="calm", text="안녕"))
    assert a != cache_key(SynthRequest(voice="onyx", instructions="fast", text="안녕"))
    assert a != cache_key(SynthRequest(voice="onyx", instructions="calm", text="안녕?"))
    assert a == cache_key(SynthRequest(voice="onyx", instructions="calm", text="안녕"))


def test_synthesize_posts_expected_body_and_returns_audio(tmp_path):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=wav_bytes(0.5))

    synth = make_synth(tmp_path, handler)
    audio, sr = synth.synthesize(SynthRequest(voice="onyx", instructions="calm", text="안녕"))
    assert sr == SR
    assert abs(len(audio) / SR - 0.5) < 1e-3
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"] == {
        "model": "gpt-4o-mini-tts",
        "voice": "onyx",
        "instructions": "calm",
        "input": "안녕",
        "response_format": "wav",
    }


def test_second_call_hits_cache_without_network(tmp_path):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        return httpx.Response(200, content=wav_bytes(0.2))

    synth = make_synth(tmp_path, handler)
    req = SynthRequest(voice="sage", instructions="x", text="같은 말")
    synth.synthesize(req)
    synth.synthesize(req)
    assert calls["n"] == 1
    assert len(list(tmp_path.glob("*.wav"))) == 1


def test_retries_on_429_then_succeeds(tmp_path):
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        if calls["n"] < 3:
            return httpx.Response(429, json={"error": "rate"})
        return httpx.Response(200, content=wav_bytes(0.1))

    synth = make_synth(tmp_path, handler)
    synth.backoff_seconds = 0.0
    synth.synthesize(SynthRequest(voice="nova", instructions="x", text="재시도"))
    assert calls["n"] == 3


def test_4xx_other_than_429_fails_immediately_with_body(tmp_path):
    def handler(request):
        return httpx.Response(401, json={"error": {"message": "invalid key"}})

    synth = make_synth(tmp_path, handler)
    with pytest.raises(RuntimeError, match="401.*invalid key"):
        synth.synthesize(SynthRequest(voice="nova", instructions="x", text="x"))
