# Damwha 설치 (Apple Silicon)

회의 녹음을 올리면 화자별 발화 타임라인·검색·액션아이템·요약이 나온다. 전부 로컬에서 돈다 —
클라우드 ML 없음, 데이터는 이 폴더 밖으로 안 나간다.

구성은 **Docker 2개**(Postgres, API+UI) + **호스트 프로세스 2개**(ML 워커, 임베딩 서비스).
ML 워커는 Apple GPU(MLX)를 써야 해서 Docker에 못 들어간다.

## 준비물

| 도구 | 설치 |
|---|---|
| Docker Desktop | https://docker.com |
| [uv](https://docs.astral.sh/uv/) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| ffmpeg | `brew install ffmpeg` |
| Hugging Face 계정 + read 토큰 | 화자 분리 모델(pyannote)이 gated → **[HUGGINGFACE.md](HUGGINGFACE.md)** 대로 5분 |
| gh CLI | 릴리스로 설치할 때만. `brew install gh` → `gh auth login` |

라이선스 3개를 전부 수락해야 한다: [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) ·
[segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) ·
[speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1)

메모리는 기본 설정(Qwen3.5 4B + whisper large-v3-turbo) 기준 16GB면 된다. 설정에서 `quality`
프리셋을 고르면 27B(≈28GB)를 받는다.

## 설치

**레포를 클론했다면** — 워커를 `be/worker` 소스에서 바로 깐다:

```bash
cd deploy
make setup     # .env 생성 + 이 Mac의 메모리·칩 기록
make tools     # mlx-lm + 워커 설치
make up        # Postgres + API/UI 컨테이너
```

`make setup`이 만든 `.env`에서 **`HF_TOKEN` 한 줄만 손으로 채우면 된다**
([HUGGINGFACE.md](HUGGINGFACE.md), 5분). 제대로 됐는지는 `make check`가 확인해 준다.

**릴리스로 설치한다면** — 받아서 푼 폴더에서 위와 똑같이 하면 된다:

```bash
VER=0.2.0
gh release download "v$VER" -R Yjason-K/Damwha -p '*.tar.gz' -p '*.whl'
tar -xzf damwha-deploy-$VER.tar.gz && cd damwha
```

`make tools`가 옆에 있는 wheel을 쓰고, 없으면 `make fetch`가 릴리스에서 받아 온다.
이미지는 GHCR에 공개돼 있어 `docker login` 없이 받아진다.

마지막으로 터미널 두 개, **둘 다 `.env`가 있는 이 폴더에서**:

```bash
make worker    # 터미널 1 — 첫 실행에 모델 다운로드 (수 GB, 수 분)
make embed     # 터미널 2 — 검색용 임베딩. 첫 실행 30–90초 워밍업
```

첫 회의를 올릴 때 기다리기 싫으면 그 전에 `make models`로 미리 받아 둔다.

브라우저: **http://localhost:13000** (API 문서 `/docs`)

## 명령

| | |
|---|---|
| `make` | 타깃 목록 + 지금 상태 |
| `make check` | 준비물·`.env`·포트·HF 토큰 점검. `up`도 포트 검사를 먼저 돌린다 |
| `make models` | ML 모델 미리받기. 안 해도 첫 처리 때 자동으로 받는다 |
| `make health` | api·embed·워커 상태를 한 번에. 아래 문제 해결의 절반이 이걸로 갈린다 |
| `make ps` / `make logs` | 컨테이너 상태 / API 로그 |
| `make up` / `make down` | 기동 / 정지 (볼륨은 남는다) |
| `make upgrade` | 새 버전으로 — 진행 중인 녹음이 있으면 **아무것도 하지 않는다** |
| `make clean` | DB·오디오까지 전부 삭제 (확인을 묻는다) |

`make`는 `.env`가 있는 폴더에서만 돈다 — 다른 곳에서 부르면 거부한다. compose의 `./storage`
마운트와 워커의 `STORAGE_ROOT`가 둘 다 cwd 기준이라, 폴더가 틀리면 조용히 빈 디렉터리를 본다.

## 포트

**13000**(브라우저·API)과 **15432**(Postgres). 서비스 기본 포트 앞에 `1`을 붙인 번호이고, 이
레포의 개발용 스택(`pnpm dev`는 3000, `pnpm db:up`은 5432)과 겹치지 않아 둘을 동시에 띄울 수 있다.

그 번호마저 쓰이고 있으면 `.env`에서 바꾼다:

```bash
DAMWHA_API_PORT=13001
DAMWHA_DB_PORT=15433
DATABASE_URL=postgres://postgres:postgres@localhost:15433/damwha   # DB 포트와 같이 바꾼다
```

적지 않으면 기본값을 쓴다. `make up`은 시작하기 전에 두 포트를 확인하고, 이미 쓰이고 있으면
무엇이 물고 있는지 알려 주며 멈춘다 — 반쯤 뜬 스택을 남기지 않는다. `DATABASE_URL`의 포트가
`DAMWHA_DB_PORT`와 어긋나도 멈춘다(워커가 엉뚱한 Postgres에 붙는 사고를 막는다).

## 써보기

녹음 파일 업로드 → 잠시 뒤 `done` → 화자별 타임라인. 10분 회의가 M-series에서 1–2분쯤.

- 렌즈(액션/결정/약속)·요약은 업로드 직후 자동으로 큐에 들어가고, 워커가 그 job 직전에
  `mlx_lm.server`를 띄웠다가 끝나면 내린다. 첫 요약은 모델 다운로드 시간이 더 붙는다.
- 검색은 `damwha-embed`가 죽어 있어도 동작한다 — 키워드 검색으로 조용히 떨어질 뿐.
- 화자 등록은 한 사람 목소리만 10–30초 클립으로. 여러 명 섞인 걸 넣으면 식별이 흐려진다.

**실시간 녹음** — "새 회의 기록하기 → 실시간 녹음"으로 **보고 있는 브라우저의 마이크**를 녹음한다.

- 권한을 묻는 것은 워커가 아니라 브라우저다. macOS가 그 브라우저 앱에 마이크 접근을 허용해야
  한다(시스템 설정 › 개인정보 보호 및 보안 › 마이크). 워커 터미널의 권한과는 **무관**하다.
- "녹음 시작"은 두 번 누른다. 첫 클릭이 마이크 점검·장치 선택, 두 번째가 실제 시작이다.
- 오디오는 브라우저 → API로 올라가고 API가 파일에 쓴다. 워커는 그 파일을 따라 읽어 실시간 자막만
  만든다 — **워커가 죽어도 녹음은 계속되고**, 종료하면 자막 없이 정식 처리가 이어진다.
- 녹음하는 동안은 다른 처리(요약·색인 등)가 대기한다. 한 번에 한 회의만 녹음할 수 있다.

> 다른 기기(노트북·폰)에서 접속해 녹음하려면 HTTPS가 필요하다. 브라우저는 `localhost`가 아닌
> 출처에서 secure context가 아니면 마이크를 열어 주지 않는다 — `http://<LAN IP>:13000`은 지원되는
> 녹음 환경이 아니다. TLS를 앞에 두거나 같은 기기의 `localhost`로 쓴다.
> (LAN·HTTPS 경유 녹음은 아직 실측되지 않았다.)

## 문제 생기면

먼저 `make health`. 그다음:

| 증상 | 원인 |
|---|---|
| 업로드가 `queued`에서 안 움직임 | `damwha-worker` 안 떠 있음 |
| 워커가 job을 하나도 안 집는데 로그는 조용함 | `.env`의 `DATABASE_URL` 포트가 이 스택의 것이 아니다. `make check`가 잡아 준다 |
| 워커가 `DATABASE_URL` / `LENS_LLM_BASE_URL` 없다고 죽음 | `.env` 없는 폴더에서 실행함 |
| `make up`이 `<포트>가 이미 쓰이고 있다`로 멈춤 | 메시지가 어느 컨테이너/프로세스인지 알려 준다 — `.env`에서 그 포트를 빈 번호로 바꾼다(DB 쪽은 `DATABASE_URL`도 같이) |
| `container name ... is already in use` | 같은 스택이 다른 폴더에 이미 있다. `docker rm -f damwha-deploy-postgres damwha-deploy-api` — 볼륨 `damwha-deploy_pgdata`는 남는다 |
| 처리 설정의 "내 머신"이 실제 Mac보다 작게 나옴 | 워커가 아직 안 떴다. 띄우면 30초 안에 실측값으로 덮인다. 컨테이너가 보는 건 Docker VM 할당량이다 |
| GPU 프리셋이 전부 잠김 / job이 `gpu_unavailable` | 워커가 MPS를 못 찾았다. `make health`의 `gpu_probe`를 본다 — `mps_unavailable`이면 Rosetta python이 유력하다(`uv python list`로 arm64 확인) |
| 업로드가 `gpu is not available on this machine` 400 | compose의 `CAPABILITIES_PLATFORM/ARCH`가 지워졌다 — 원본 그대로 써야 한다 |
| 화자 분리 실패 / 401 | `HF_TOKEN` 비었거나 라이선스 3개 중 하나 미수락. `make check`가 어느 쪽인지 알려 준다 → [HUGGINGFACE.md](HUGGINGFACE.md) |
| 렌즈/요약이 `llm_server_start_failed` | `mlx_lm.server`가 PATH에 없음 → `make tools` |
| "녹음 시작"을 눌러도 아무 일도 안 일어남 | 첫 클릭은 마이크 점검 단계다 — 한 번 더 누른다. 그래도 안 되면 브라우저가 마이크 권한을 거부한 것이다(주소창의 자물쇠 → 마이크 허용). 이 경우 회의가 **안 만들어지는 게 정상**이다 |
| 녹음한 회의에 `capture_error=preview_worker_lost` | 녹음 중 워커가 죽었다. 실시간 자막만 잃었고 **녹음과 정식 처리는 온전하다** — 워커를 다시 띄우면 전사가 끝난다 |
| 녹음이 `capture_error=producer_abandoned` | 브라우저가 90초 넘게 오디오를 안 보냈다(탭을 닫았거나 네트워크 끊김). 그때까지 확정된 오디오는 보존되고 정식 처리가 이어진다 |
| 녹음이 `audio_device_failed`로 실패 | 브라우저가 아니라 워커가 마이크를 열려 한 경우다(`source='mic'`). 지금 UI는 이 경로를 만들지 않으므로, 나왔다면 옛 클라이언트나 손으로 만든 job이다 |

로그는 `make logs`(API)와 워커 터미널의 stderr. 워커는 기동 직후 자기 머신 스펙을 재서
`host capabilities reported: {...}` 한 줄을 남기고 DB에 올린다 — 처리 설정 화면의 "내 머신"과
GPU 프리셋 개폐가 그 값을 따른다.

## 업그레이드

```bash
make upgrade
```

이 설치는 **Docker의 API + 호스트의 워커**라는 두 조각이고, 둘은 HTTP가 아니라 Postgres와 공유
파일(`./storage` bind mount) 하나로만 만난다. 그래서 업그레이드는 둘을 같이 올려야 하고,
`make upgrade`가 그 순서를 지킨다 — 내리고, 이미지를 받고, 올리고(API가 시작하며 migration을
스스로 적용한다), 워커를 다시 깐다.

**진행 중인 녹음이 있으면 아무것도 하지 않고 멈춘다.** migration `024`가 더한
`job.committed_bytes`는 "fdatasync까지 끝나 확정된 오디오 길이"인데, 이미 진행 중인 녹음에는 그
값을 채워 넣을 방법이 없다(파일 길이로 역산하면 크래시가 남긴 미확정 꼬리를 정본으로 인정하게
되므로 일부러 안 한다). 새 코드는 그런 세션을 이어받지 않고 거절한다.

걸렸다면 사용자가 "종료"를 누르게 하거나 최대 90초 기다린다 — orphan 스위퍼가 버려진 녹음을
알아서 봉인한다. **DB 값을 손으로 채우지 말 것.**

되돌릴 때도 녹음을 먼저 비운다. `024`는 컬럼을 더하기만 하므로(additive) 옛 API가 그 컬럼을
무시하고 그냥 돈다 — 컬럼이나 종료된 녹음 이력을 지울 이유는 없다.

> **0.2.0 이전에서 올라오는 경우 — 한 번만 하는 이사.** 이 릴리스부터 compose 프로젝트 이름을
> `damwha-deploy`로 고정하고 포트를 13000·15432로 옮겼다. 예전에는 프로젝트 이름이 폴더에서
> 유도돼(`damwha` 또는 `deploy`) 개발용 스택과 이름·포트가 겹쳤다. 이름이 바뀌면 **옛 볼륨은 새
> 프로젝트에 따라오지 않는다.** 옛 데이터를 쓰려면 올리기 전에 옮긴다(옛 이름은
> `docker volume ls | grep pgdata`로 확인):
>
> ```bash
> docker volume create damwha-deploy_pgdata
> docker run --rm -v <옛이름>_pgdata:/from -v damwha-deploy_pgdata:/to alpine \
>   sh -c 'cd /from && cp -a . /to'
> ```
>
> 옛 볼륨은 되돌릴 자리로 남겨 둔다. 옛 컨테이너(`damwha-postgres`, `damwha-api`)는
> `docker rm -f`로 치운다.

> 컨테이너가 확정(fdatasync + DB commit)한 오디오를 호스트 워커가 보기까지 2026-09-07 이 형상에서
> 0.01–0.02 ms였고 누락은 0이었다. 그 머신의 Docker Desktop 파일 공유에 대한 실측이며 다른 환경에
> 대한 보증은 아니다. `fdatasync`도 OS에 내구성을 요청하는 것이지 하드웨어 전원 장애까지 견딘다는
> 뜻은 아니다.

## 정리

```bash
make clean     # DB 볼륨 + 업로드한 오디오 + 설치한 uv 도구. 되돌릴 수 없어 확인을 묻는다
```
