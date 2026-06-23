"""Pre-download / cache the real models (offline + first-run latency).

Run: `uv run python scripts/download_models.py`
pyannote is gated — set HF_TOKEN in worker/.env and accept the model license at
https://huggingface.co/pyannote/speaker-diarization-3.1 first.
"""

import os

from damwha_worker.config import load_settings

DIAR = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1")
ECAPA = os.environ.get("EMBEDDING_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
WHISPER_REPO = os.environ.get("WHISPER_MLX_REPO", "mlx-community/whisper-large-v3-turbo")


def main() -> None:
    s = load_settings()

    print("[1/4] silero-vad ...", flush=True)
    from silero_vad import load_silero_vad

    load_silero_vad()

    print(f"[2/4] ECAPA ({ECAPA}) ...", flush=True)
    from speechbrain.inference.speaker import EncoderClassifier

    EncoderClassifier.from_hparams(source=ECAPA)

    print(f"[3/4] whisper mlx ({WHISPER_REPO}) ...", flush=True)
    from huggingface_hub import snapshot_download

    snapshot_download(WHISPER_REPO)

    print(f"[4/4] pyannote gated ({DIAR}) ...", flush=True)
    if not s.hf_token:
        print("  ! HF_TOKEN not set — skipping. Set it in worker/.env + accept the license.")
    else:
        from pyannote.audio import Pipeline

        pipe = Pipeline.from_pretrained(DIAR, use_auth_token=s.hf_token)
        if pipe is None:
            print("  ! pyannote returned None — token invalid or license not accepted.")
        else:
            print("  ok")

    print("done.")


if __name__ == "__main__":
    main()
