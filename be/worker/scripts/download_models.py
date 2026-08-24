"""Pre-download / cache the real models (offline + first-run latency).

Run: `uv run python scripts/download_models.py`
pyannote is gated — set HF_TOKEN in worker/.env and accept the model license at
https://huggingface.co/pyannote/speaker-diarization-community-1 first.

Whisper: `WHISPER_MLX_REPOS` is a comma-separated list of MLX repos to cache
(defaults to the standard preset's model only). To pre-cache several presets in
one pass, e.g. light (small) + standard (large-v3-turbo):

    WHISPER_MLX_REPOS=mlx-community/whisper-small-mlx,mlx-community/whisper-large-v3-turbo \\
        uv run python scripts/download_models.py

Repo names mirror `damwha_worker/models/whisper_mlx.py::_REPO`.
"""

import os

from damwha_worker.config import load_settings

DIAR = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
ECAPA = os.environ.get("EMBEDDING_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
WHISPER_REPOS = os.environ.get(
    "WHISPER_MLX_REPOS",
    "mlx-community/whisper-large-v3-turbo",  # 기본은 standard 프리셋 모델만
).split(",")


def main() -> None:
    s = load_settings()

    print("[1/4] silero-vad ...", flush=True)
    from silero_vad import load_silero_vad

    load_silero_vad()

    print(f"[2/4] ECAPA ({ECAPA}) ...", flush=True)
    from speechbrain.inference.speaker import EncoderClassifier

    EncoderClassifier.from_hparams(source=ECAPA)

    print(f"[3/4] whisper mlx ({', '.join(WHISPER_REPOS)}) ...", flush=True)
    from huggingface_hub import snapshot_download

    for repo in WHISPER_REPOS:
        print(f"  - {repo}", flush=True)
        snapshot_download(repo.strip())

    print(f"[4/4] pyannote gated ({DIAR}) ...", flush=True)
    if not s.hf_token:
        print("  ! HF_TOKEN not set — skipping. Set it in worker/.env + accept the license.")
    else:
        from pyannote.audio import Pipeline

        pipe = Pipeline.from_pretrained(DIAR, token=s.hf_token)
        if pipe is None:
            print("  ! pyannote returned None — token invalid or license not accepted.")
        else:
            print("  ok")

    print("done.")


if __name__ == "__main__":
    main()
