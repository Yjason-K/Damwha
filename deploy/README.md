# Damwha 팀 체험 설치 (Apple Silicon)

회의 녹음을 올리면 화자별 발화 타임라인·검색·액션아이템·요약이 나온다. 전부 로컬에서 돈다 — 클라우드 ML 없음, 데이터는 이 폴더 밖으로 안 나간다.

구성: **Docker 2개**(Postgres, API+UI) + **호스트 프로세스 2개**(ML 워커, 임베딩 서비스). ML 워커는 Apple GPU(MLX)를 써야 해서 Docker에 못 들어간다.

## 0. 준비물

| 도구 | 설치 |
|---|---|
| Docker Desktop | https://docker.com |
| [uv](https://docs.astral.sh/uv/) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| ffmpeg | `brew install ffmpeg` |
| gh CLI (릴리스 다운로드용) | `brew install gh` → `gh auth login` |
| Hugging Face 계정 + read 토큰 | 화자 분리 모델(pyannote)이 gated → **[HUGGINGFACE.md](HUGGINGFACE.md)** 대로 5분. 라이선스 3개 수락 + 토큰 발급 |

라이선스(전부 수락해야 한다): [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) · [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) · [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)

메모리: 기본 설정(Qwen3.5 4B + whisper large-v3-turbo) 기준 16GB면 된다. 설정에서 `quality` 프리셋을 고르면 27B(≈28GB)를 받는다.

## 1. 받기

```bash
VER=0.1.2    # 릴리스 태그
gh release download "v$VER" -R Yjason-K/Damwha -p '*.tar.gz' -p '*.whl'
tar -xzf damwha-deploy-$VER.tar.gz && cd damwha
cp .env.example .env     # HF_TOKEN 채우기, DAMWHA_VERSION이 $VER과 같은지 확인

# 워커가 뜨기 전까지 쓸 이 Mac의 스펙 — api는 컨테이너 안이라 직접 못 본다.
# 워커가 한 번 뜨면 자기가 잰 값으로 덮으므로, 건너뛰어도 결국 맞춰진다.
printf 'CAPABILITIES_MEMORY_GB=%d\nCAPABILITIES_CHIP=%s\n' \
  "$(( $(sysctl -n hw.memsize) / 1073741824 ))" \
  "$(sysctl -n machdep.cpu.brand_string)" >> .env
```

이미지는 GHCR에 공개돼 있어 `docker login` 없이 받아진다.

## 2. 띄우기

```bash
# Docker: Postgres + API/UI. 시작 시 마이그레이션 자동 적용.
docker compose up -d

# 호스트: LLM 런타임 + 워커 (워커 venv 밖 — 워커가 mlx_lm.server 바이너리를 실행한다)
uv tool install mlx-lm
uv tool install "damwha-worker[models] @ ../damwha_worker-$VER-py3-none-any.whl"
```

터미널 두 개, **둘 다 이 폴더(`.env` 있는 곳)에서**:

```bash
damwha-worker    # 터미널 1 — 첫 실행에 모델 다운로드 (수 GB, 수 분)
damwha-embed     # 터미널 2 — 검색용 임베딩. 첫 실행 30–90초 워밍업
```

브라우저: **http://localhost:3000** (API 문서 `/docs`)

## 3. 써보기

녹음 파일 업로드 → 잠시 뒤 `done` → 화자별 타임라인. 10분 회의가 M-series에서 1–2분쯤.

- 렌즈(액션/결정/약속)·요약은 업로드 직후 자동으로 큐에 들어가고, 워커가 그 job 직전에 `mlx_lm.server`를 띄웠다가 끝나면 내린다. 첫 요약은 모델 다운로드 시간이 더 붙는다.
- 검색은 `damwha-embed`가 죽어 있어도 동작한다 — 키워드 검색으로 조용히 떨어질 뿐. 의미 검색이 안 되는 것 같으면 `curl localhost:8100/health`.
- 화자 등록: 한 사람 목소리만 10–30초 클립으로. 여러 명 섞인 걸 넣으면 식별이 흐려진다.
- **실시간 녹음**: 좌측 "녹음 시작"으로 이 Mac의 마이크를 바로 녹음한다. 첫 실행에 macOS가
  `damwha-worker`를 띄운 터미널 앱에 마이크 권한을 묻는다. 녹음하는 동안은 다른 처리(요약·색인 등)가
  대기하고, 종료하면 정식 처리가 이어진다. 데모 사이트에서는 꺼져 있다.

## 문제 생기면

| 증상 | 원인 |
|---|---|
| 업로드가 `queued`에서 안 움직임 | `damwha-worker` 안 떠 있음 |
| 업로드가 `gpu is not available on this machine` 400 | compose 파일의 `CAPABILITIES_PLATFORM/ARCH`가 지워짐 — 원본 그대로 써야 한다 |
| 처리 설정의 "내 머신"이 실제 Mac보다 메모리가 작고 칩이 안 뜸 | 워커가 아직 안 떴고 `.env`의 `CAPABILITIES_MEMORY_GB/CHIP`도 빔 — 워커를 띄우거나(30초 안에 반영) 1번의 `printf` 줄 후 `docker compose up -d` 다시. 컨테이너가 보는 건 Docker VM 할당량이다 |
| GPU 프리셋이 전부 잠김 | 워커가 MPS를 못 찾았다고 보고했다. 이유는 `docker compose exec postgres psql -U postgres damwha -c "select value from app_setting where key='worker_capabilities'"` 의 `gpu_probe`. `mps_unavailable`이면 Rosetta python이 유력 → `uv python list`로 arm64 확인 |
| job이 `gpu_unavailable`로 실패 | Apple Silicon이 아니거나 Rosetta python. `uv python list`로 arm64인지 확인 |
| 화자 분리 실패 / 401 | `HF_TOKEN` 비었거나 라이선스 3개 중 하나 미수락 → [HUGGINGFACE.md](HUGGINGFACE.md) |
| 렌즈/요약이 `llm_server_start_failed` | `mlx_lm.server`가 PATH에 없음 → `uv tool install mlx-lm` |
| 워커가 `DATABASE_URL` / `LENS_LLM_BASE_URL` 없다고 죽음 | `.env` 없는 폴더에서 실행함 |
| 녹음이 `audio_device_failed`로 실패 | 마이크 권한 거부 또는 입력 장치 없음 — 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 터미널 앱 허용 |

로그: `docker compose logs -f api`, 워커는 stderr. 워커는 기동 직후 자기 머신 스펙을 재서
`host capabilities reported: {...}` 한 줄을 남기고 DB에 올린다 — 처리 설정 화면의 "내 머신"과
GPU 프리셋 개폐가 그 값을 따른다.

## 정리

```bash
docker compose down -v     # DB 볼륨까지 삭제
rm -rf storage             # 업로드한 오디오
uv tool uninstall damwha-worker mlx-lm
```
