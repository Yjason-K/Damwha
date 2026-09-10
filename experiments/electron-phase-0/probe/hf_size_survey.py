#!/usr/bin/env python3
"""Task 7 착수 전 디스크 산정 — HF 저장소의 파일 크기를 API 로 조회한다 (R-14).

계획 Task 7 의 V1 은 `preflight.sh 40` 이다. 기준 호스트의 데이터 볼륨 여유가
**12 GiB(98% 사용)** 뿐이라 그 값이면 시작조차 못 한다. 스펙 §4.4 는 "각 실험
Task 는 시작 전에 필요한 여유를 확인하고 부족하면 시작하지 않고 실패로
보고한다"고만 정할 뿐 40 이라는 숫자의 근거를 두지 않았으므로, 실제 필요량을
재서 판단한다. 이 스크립트가 그 측정이다.

    /usr/bin/python3 experiments/electron-phase-0/probe/hf_size_survey.py

## 격리에서의 위치

**격리 대상이 아니다** (스펙 §4.0). 번들에 들어갈 산출물이 아니라 **측정
수단**이며, 시스템 python3 와 시스템 curl 로 돈다. 실행에 필요한 것은
`be/worker/.env` 의 `HF_TOKEN` 뿐이고, 그 값은 출력 어디에도 나가지 않는다
(스펙 §4.2).

## 재는 값의 뜻

HF API 의 `siblings[].lfs.size` / `size` 합계, 즉 **저장소 전체**다. 실제
다운로드는 이보다 작다 — pyannote 나 speechbrain 은 필요한 파일만
`hf_hub_download` 하므로 README·예제 오디오·벤치마크 rttm 은 받지 않는다.
따라서 이 합계는 **상한**이고, 산정을 보수적으로 만든다.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_ENV = REPO_ROOT / "be/worker/.env"

# 조사 대상. 무엇이 왜 목록에 있는지는 be/worker/damwha_worker/models/ 가 출처다.
TARGETS = [
    ("pyannote/speaker-diarization-community-1",
     "제품 기본 diarization 파이프라인 (be/src/config/env.ts:18, be/.env:9). 게이트."),
    ("pyannote/speaker-diarization-3.1",
     "smoke 스크립트 payload 의 옛 값. 게이트. 설치된 pyannote.audio 4.x 에서 "
     "클러스터링이 깨진다고 env.ts:13-17 이 기록."),
    ("pyannote/segmentation-3.0",
     "3.1 파이프라인이 참조하는 게이트 서브모델."),
    ("pyannote/wespeaker-voxceleb-resnet34-LM",
     "3.1 파이프라인이 참조하는 임베딩 서브모델."),
    ("speechbrain/spkrec-ecapa-voxceleb",
     "화자 임베딩 (models/ecapa_embed.py). 제품 기본값."),
    ("mlx-community/whisper-large-v3-turbo",
     "devices.stt=gpu 의 STT (models/whisper_mlx.py). be/.env:6 의 기본값."),
    ("mlx-community/whisper-small-mlx",
     "같은 경로의 더 작은 후보."),
    ("mlx-community/whisper-tiny",
     "같은 경로의 가장 작은 후보."),
    ("Systran/faster-whisper-large-v3",
     "devices.stt=cpu 의 STT (models/whisper_faster.py)."),
    ("Systran/faster-whisper-tiny",
     "같은 경로의 가장 작은 후보."),
]


def read_token() -> str:
    if not WORKER_ENV.is_file():
        sys.exit(f"no such file: {WORKER_ENV}")
    for line in WORKER_ENV.read_text(encoding="utf-8").splitlines():
        if line.startswith("HF_TOKEN="):
            return line[len("HF_TOKEN="):].strip().strip("'\"")
    sys.exit("HF_TOKEN not found in be/worker/.env")


def fetch(repo: str, token: str) -> dict:
    req = urllib.request.Request(
        f"https://huggingface.co/api/models/{repo}?blobs=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        return {"_error": f"HTTP {exc.code}"}


def main() -> int:
    token = read_token()
    print("# Task 7 디스크 산정 — HF 저장소 크기 실측 (스펙 §4.4, R-14)")
    print("# 도구: probe/hf_size_survey.py  (격리 대상 아님 — 측정 수단, 스펙 §4.0)")
    print("# HF_TOKEN: set   # 값은 기록하지 않는다 (스펙 §4.2)")
    print("#")
    print("# 합계는 저장소 **전체**다. 실제 다운로드는 필요한 파일만이라 이보다 작다.")
    print("#")
    print("repo\tgated\ttotal_bytes\ttotal_MB\tfiles")
    for repo, why in TARGETS:
        d = fetch(repo, token)
        if "siblings" not in d:
            print(f"{repo}\tERROR\t-\t-\t-\t{d.get('_error', d)}")
            continue
        total = 0
        for s in d["siblings"]:
            total += s.get("size") or (s.get("lfs") or {}).get("size") or 0
        print(f"{repo}\t{d.get('gated')}\t{total}\t{total / 1e6:.1f}\t{len(d['siblings'])}")
        print(f"#   {why}")
        biggest = sorted(
            ((s.get("size") or (s.get("lfs") or {}).get("size") or 0, s["rfilename"])
             for s in d["siblings"]),
            reverse=True,
        )[:3]
        for sz, name in biggest:
            print(f"#     {sz / 1e6:9.2f} MB  {name}")
    print("#")
    print("# 데이터 볼륨 여유 (df -g, 이 조사 시점)")
    df = subprocess.run(["/bin/df", "-g", str(REPO_ROOT)], capture_output=True, text=True)
    for line in df.stdout.strip().splitlines():
        print(f"# {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
