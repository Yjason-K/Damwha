"""OpenAI TTS 호출 + 발화 단위 디스크 캐시.

캐시 키는 (model, voice, instructions, text)의 sha256. 대본에서 한 줄만 고쳐도
그 줄만 다시 부른다. 캐시 디렉터리(demo/audio/.cache)는 gitignore다.
"""

from __future__ import annotations

import hashlib
import io
import json
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

MODEL = "gpt-4o-mini-tts"
_RETRYABLE = {429, 500, 502, 503, 504}


@dataclass(frozen=True)
class SynthRequest:
    voice: str
    instructions: str
    text: str


def cache_key(req: SynthRequest) -> str:
    payload = json.dumps(
        {"model": MODEL, "voice": req.voice, "instructions": req.instructions, "text": req.text},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class Synthesizer:
    def __init__(self, api_key: str, cache_dir: Path, client: httpx.Client | None = None, max_attempts: int = 5):
        self.api_key = api_key
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.client = client or httpx.Client(base_url="https://api.openai.com", timeout=120.0)
        self.max_attempts = max_attempts
        self.backoff_seconds = 2.0

    def cache_path(self, req: SynthRequest) -> Path:
        return self.cache_dir / f"{cache_key(req)}.wav"

    def synthesize(self, req: SynthRequest) -> tuple[np.ndarray, int]:
        path = self.cache_path(req)
        if not path.exists():
            data = self._fetch(req)
            tmp = path.with_suffix(".wav.part")
            tmp.write_bytes(data)
            tmp.replace(path)
        audio, sr = sf.read(path, dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        return audio, sr

    def _fetch(self, req: SynthRequest) -> bytes:
        body = {
            "model": MODEL,
            "voice": req.voice,
            "instructions": req.instructions,
            "input": req.text,
            "response_format": "wav",
        }
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        last: httpx.Response | None = None
        for attempt in range(self.max_attempts):
            resp = self.client.post("/v1/audio/speech", json=body, headers=headers)
            if resp.status_code == 200:
                return resp.content
            last = resp
            if resp.status_code not in _RETRYABLE:
                break
            time.sleep(self.backoff_seconds * (2**attempt))
        assert last is not None
        raise RuntimeError(f"TTS failed {last.status_code} for {req.text[:30]!r}: {last.text}")
