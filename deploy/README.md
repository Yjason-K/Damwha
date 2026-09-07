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
- **실시간 녹음**: "새 회의 기록하기 → 실시간 녹음"으로 **보고 있는 브라우저의 마이크**를 녹음한다.
  권한을 묻는 것은 워커가 아니라 브라우저다 — 처음 시작할 때 브라우저가 마이크 권한을 묻고,
  macOS가 그 브라우저 앱에 마이크 접근을 허용해야 한다(시스템 설정 › 개인정보 보호 및 보안 › 마이크).
  워커 터미널의 권한과는 **무관**하다. "녹음 시작"은 두 번 누른다: 첫 클릭이 마이크 점검·장치
  선택이고 두 번째가 실제 시작이다.
  오디오는 브라우저 → API로 올라가고 API가 파일에 쓴다. 워커는 그 파일을 따라 읽어 실시간 자막만
  만든다 — **워커가 죽어도 녹음은 계속되고**, 종료하면 자막 없이도 정식 처리가 이어진다(그 회의는
  `capture_error=preview_worker_lost`로 표시된다). 녹음하는 동안은 다른 처리(요약·색인 등)가
  대기한다. 한 번에 한 회의만 녹음할 수 있다. 데모 사이트에서는 꺼져 있다.

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
| "녹음 시작"을 눌러도 아무 일도 안 일어남 | 첫 클릭은 마이크 점검 단계다 — 마이크 선택이 뜨면 한 번 더 누른다. 그래도 안 되면 브라우저가 마이크 권한을 거부한 것이다(주소창의 자물쇠 → 마이크 허용). 이 경우 회의는 **만들어지지 않는 게 정상**이다 |
| 녹음한 회의에 `capture_error=preview_worker_lost` | 녹음 중 워커가 죽었다. 실시간 자막만 잃었고 **녹음과 정식 처리는 온전하다** — 워커를 다시 띄우면 전사가 끝난다 |
| 녹음이 `audio_device_failed`로 실패 | 브라우저가 아니라 워커가 마이크를 열려 한 경우다(`source='mic'` 세션). 지금 UI는 이 경로를 만들지 않으므로, 나왔다면 옛 클라이언트나 손으로 만든 job이다 |
| 녹음 중 회의가 `uploaded` + `capture_error=producer_abandoned` | 브라우저가 90초 넘게 오디오를 안 보냈다(탭을 닫았거나 네트워크가 끊김). 그때까지 확정된 오디오는 보존되고 정식 처리가 이어진다 |

로그: `docker compose logs -f api`, 워커는 stderr. 워커는 기동 직후 자기 머신 스펙을 재서
`host capabilities reported: {...}` 한 줄을 남기고 DB에 올린다 — 처리 설정 화면의 "내 머신"과
GPU 프리셋 개폐가 그 값을 따른다.

## 업그레이드 / 유지보수

이 설치는 **Docker의 API + 호스트의 워커**라는 두 조각이고, 둘은 HTTP가 아니라 **Postgres와
공유 파일** 하나로만 만난다. 공유 파일은 compose의 `./storage:/repo/be/storage` bind mount다 —
컨테이너 안에서 `STORAGE_ROOT=./storage`(= `/repo/be/storage`)이고 호스트 워커는 같은
`storage/`를 자기 `STORAGE_ROOT`로 본다. 그래서 업그레이드는 **둘을 같이** 올려야 한다.

실시간 녹음이 있는 버전(migration `024` 이상)으로 올릴 때는 순서가 중요하다. `024`가 더한
`job.committed_bytes`는 "fdatasync까지 끝나 확정된 오디오 길이"인데, **이미 진행 중인 녹음에는
그 값을 채워 넣을 방법이 없다**(파일 길이로 역산하면 크래시가 남긴 미확정 꼬리를 정본으로
인정하게 되므로 일부러 안 한다). 새 코드는 그런 세션을 이어받지 않고 거절한다. 그래서 **녹음을
먼저 비운다.**

```bash
# 1) 새 녹음 진입을 멈춘다 (사용자에게 알리고 UI를 쓰지 않게 한다)

# 2) 진행 중인 녹음이 정말 없는지 확인한다 — 둘 다 0이어야 한다
docker compose exec postgres psql -U postgres damwha \
  -c "SELECT count(*) FROM meeting WHERE status='recording';" \
  -c "SELECT count(*) FROM job WHERE type='live_session' AND status IN ('queued','running');"

# 3) 0이 아니면: 사용자가 종료를 누르게 하거나, 최대 90초 기다린다 —
#    orphan 스위퍼가 버려진 녹음을 알아서 봉인한다. 값을 손으로 채우지 말 것.

# 4) 둘 다 내린다
docker compose down            # API (+ Postgres)
#    호스트 워커 터미널에서 Ctrl-C

# 5) 새 버전으로 올린다. API 컨테이너가 시작하면서 migration을 스스로 적용한다
#    (이미지 CMD가 `migrate.js && main.js`).
docker compose pull && docker compose up -d
uv tool install "damwha-worker[models] @ ../damwha_worker-$VER-py3-none-any.whl"
damwha-worker                  # 워커 터미널

# 6) 확인
docker compose exec postgres psql -U postgres damwha \
  -c "SELECT name FROM _migrations ORDER BY name DESC LIMIT 3;"
```

되돌릴 때도 **녹음을 먼저 비운다.** `024`는 컬럼을 더하기만 하므로(additive) 옛 API가 그 컬럼을
무시하고 그냥 돈다 — 컬럼이나 종료된 녹음 이력을 지울 이유는 없다.

> **컨테이너가 쓴 파일을 호스트 워커가 제때 보는가.** 2026-09-07 이 형상으로 실측한 결과,
> API 컨테이너가 확정(fdatasync + DB commit)한 prefix가 호스트 `stat`에 보이기까지 0.01–0.02 ms였고,
> 자라는 파일을 호스트가 따라 읽어 봉인 지점에서 정확히 멈췄다(누락 0). 이 수치는 그 머신의
> Docker Desktop 파일 공유 구현에 대한 실측이며 다른 환경에서 같으리라는 보증은 아니다.
> 참고로 `fdatasync`는 OS에 내구성을 **요청**하는 것이지, 하드웨어 전원 장애까지 견딘다는
> 보증이 아니다.

> **다른 기기(노트북·폰)에서 접속해 녹음하려면 HTTPS가 필요하다.** 브라우저는 `localhost`가
> 아닌 출처에서 secure context가 아니면 마이크를 열어 주지 않는다. `http://<LAN IP>:3000`은
> 지원되는 녹음 환경이 아니다 — TLS를 앞에 두거나 같은 기기의 `localhost`로 쓴다.
> (LAN·HTTPS 경유 녹음은 아직 실측되지 않았다.)

## 정리

```bash
docker compose down -v     # DB 볼륨까지 삭제
rm -rf storage             # 업로드한 오디오
uv tool uninstall damwha-worker mlx-lm
```
