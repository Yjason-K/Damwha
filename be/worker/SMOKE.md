# Local smoke (real ML models) — Task 14

Not a CI test. Loads gated/heavy models; run by hand on a machine with the
`models` extra installed, ffmpeg, and Docker.

## One-time setup

1. **Accept the pyannote licenses** (logged into HF). The diarization pipeline
   (pyannote.audio 4.x) pulls a gated chain — accept **all three**:
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0
   - https://huggingface.co/pyannote/speaker-diarization-community-1
   (download_models.py / the first run will name any further gated repo to accept.)
2. **Set your HF token** in `worker/.env`:
   ```
   HF_TOKEN=hf_xxx...
   ```
3. **Install the model deps** (already done if `uv sync --extra models` ran):
   ```
   cd worker && uv sync --extra models
   ```
4. **Pre-cache models** (optional; first real run downloads them anyway):
   ```
   uv run python scripts/download_models.py
   ```

The STT backend follows the job payload's `devices.stt`: `gpu` runs `mlx-whisper`
(Apple Silicon), `cpu` runs `faster-whisper`.

## Option A — scripted end-to-end (recommended)

Spins a throwaway pgvector Postgres, seeds a meeting + job, runs the real
pipeline on your audio, prints the speaker-attributed timeline:

```
uv run python scripts/smoke_process_meeting.py /path/to/2speaker.wav
# CPU-only embedder/diarizer: add --device cpu
```

Expect: `outcome: committed`, `meeting: status=done`, one utterance per
diarized turn with text, and the diarized speakers listed as unidentified
clusters (no speakers enrolled in a throwaway DB).

### Enroll + identify smoke

Verifies the enrollment and auto-identification paths with real models:

```
uv run python scripts/smoke_enroll_identify.py <enroll_audio> <meeting_audio>
```

It (1) enrolls a speaker from `enroll_audio` (real ECAPA → voiceprint, speaker
`ready`), (2) processes `meeting_audio` and reports whether the enrolled speaker
matched any diarized cluster (cross-recording — informational), and (3) does a
deterministic check: registers a real diarized cluster centroid as a voiceprint
and confirms `identify` matches it. Expect `[1] ENROLL: PASS` and
`[3] DETERMINISTIC IDENTIFY: PASS`.

> **Enrollment quality:** `enroll_speaker` embeds the *whole* sample as one
> voiceprint. Enroll from a **clean single-speaker clip** (~10–30 s of one
> person), not a full multi-speaker meeting — a multi-speaker clip yields a
> muddy averaged embedding that won't identify reliably. (That's why the
> cross-recording step can report "did not match" when enrolling from a meeting.)

## Option B — full stack via the Plan 1 API

1. Run Postgres (pgvector) + apply migrations (`pnpm be:migrate`).
2. `pnpm be:dev` (NestJS API).
3. `POST /meetings` with a 2-speaker audio file → creates a queued job.
4. `uv run python -m damwha_worker` (the real worker) → claims + processes.
5. `GET /meetings/:id` → speaker-attributed utterance timeline; `status=done`.
6. Enrollment: `POST /speakers` with a sample → `uv run python -m damwha_worker`
   → `GET /speakers/:id` shows `enrollment_status=ready`. Re-process a meeting
   with that speaker present to see auto-identification.

## Search indexing + embed service (Phase 2 addition)

### One-time: build the custom Postgres image

The search feature requires `pg_bigm` (Korean trigram FTS) alongside `pgvector`.
Build the combined image once before running any integration tests or the full stack:

```bash
# from be/ (the damwha-be package root)
docker build -t damwha/postgres-bigm:pg16 docker/postgres-bigm/
```

Or just `pnpm db:up` from the monorepo root (or `docker compose up -d` from `be/`) — the `postgres` service
builds and tags the same `damwha/postgres-bigm:pg16` image and runs it.

### Install search model deps

bge-m3 is included in the `models` extra:

```bash
cd worker && uv sync --extra models
```

### Start the embed service

The embed service exposes bge-m3 over HTTP (localhost RPC only):

```bash
cd worker
uv run uvicorn damwha_worker.embed_service:app --host 127.0.0.1 --port 8100
```

First load downloads / warms the bge-m3 model — expect **30–90 s** on first
start (subsequent starts use the local cache). Confirm it's ready:

```bash
curl -s http://127.0.0.1:8100/health | python3 -m json.tool
```

### Startup order (full stack)

Start services in this order; each step must be healthy before the next:

1. **Postgres** (`damwha/postgres-bigm:pg16`) + `pnpm be:migrate`
2. **Embed service** — wait for `/health` → `{"status":"ok"}`
3. **Lens LLM 서버** (렌즈 추출 / 요약이 쓴다 — 둘이 같은 서버) — 아래 "렌즈 추출 LLM" 참고.
   워커보다 먼저 띄우면 슈퍼바이저 기동 로그에 서빙 중인 모델이 찍힌다.
4. **NestJS API** — `pnpm be:dev`
5. **Python worker** — `uv run python -m damwha_worker`

The `uv run python -m damwha_worker` command launches a **supervisor parent process** that does not import heavy ML libraries. When a job is available, the parent spawns a child subprocess (`python -m damwha_worker --once`) to process a single job, waits for it to complete, and reclaims the next job. The child exits after processing, allowing the OS to fully reclaim its GPU memory (MLX, torch). This is the core mechanism to prevent OOM from GPU memory accumulation across jobs. When confirming smoke with BGE-M3 CPU embedder or MLX memory caps, verify that both the `index_meeting` (embedding) and `process_meeting` (speech models) paths complete OOM-free.

### Search smoke (Option B extended)

After a meeting is processed (`status=done`), trigger search indexing:

```bash
# reindex all un-indexed meetings
curl -s -X POST http://localhost:3000/meetings/reindex-missing | python3 -m json.tool

# hybrid search (BM25 + dense RRF)
curl -s 'http://localhost:3000/search' \
  -H 'Content-Type: application/json' \
  -d '{"q":"검색어","limit":10}' | python3 -m json.tool
```

`index_meeting` jobs are processed by the same worker poll loop. A failed index
job marks only the job (not the meeting) as failed — the meeting remains `done`
and searchable via BM25 alone until the dense index is rebuilt.

## 프리셋별 스모크 (spec 2026-07-13 processing-settings)

Payload v3가 단계별 디바이스(`devices.{diarization,stt}`), whisper 모델, 요약
LLM(`summary_model`)을 실어 나른다. STT 백엔드는 payload에서 파생된다:
`devices.stt: gpu` → `mlx-whisper`, `cpu` → `faster-whisper` (int8). 프리셋
정의는 `src/settings/presets.ts` (`PRESET_REVISION='2026-08-12.3'`).

각 프리셋에 대해: `PUT /settings/processing`으로 프리셋 설정 → 짧은 오디오 업로드
→ job 완료(`status=done`) 확인. (또는 업로드 시 multipart `processing`
JSON-string 필드 / reprocess JSON body로 job별 오버라이드.)

- **light**: whisper `small` + STT `cpu`(faster-whisper) — **ARM Mac에서
  faster-whisper CPU 경로가 실제로 도는지 확인** (이전엔 플랫폼 마커로 설치 자체가
  안 됐음; 지금은 전 플랫폼 설치).
- **standard**: `large-v3-turbo` + STT `gpu`(mlx).
- **quality**: `large-v3` + STT `gpu`(mlx).
- v3 payload의 `models.devices`/`preset`이 job 행에 그대로 박혔는지 psql로 확인:
  ```sql
  SELECT payload->'models'->'devices', payload->'models'->>'preset'
    FROM job WHERE type='process_meeting' ORDER BY created_at DESC LIMIT 1;
  ```
- 프리셋별 요약 모델 — light → `mlx-community/Qwen3.5-4B-8bit` /
  standard → `-9B-8bit` / quality → `-27B-8bit`. `mlx_lm.server`는 `--model`로
  띄운 것 외의 repo도 요청 시 HF에서 받아 로드하므로 미리 받아둘 필요는 없지만,
  **첫 요약 job이 다운로드 시간만큼 길어지고 모델 스왑이 일어난다.** repo명이
  틀리면 그 프리셋의 요약 job은 PERMANENT로 실패한다.
- 요약 완료 후 기록된 모델을 확인한다:
  `psql "$DATABASE_URL" -c "SELECT model, status FROM meeting_summary ORDER BY updated_at DESC LIMIT 1"`
- (선택) `devices.diarization: cpu` custom으로 pyannote CPU 경로 1회. 어떤 개별
  필드든(language만 바꿔도) preset은 `custom`으로 전환된다.
- tiny/base/small/medium 신규 모델은 여기서 처음 다운로드·추론된다 — repo 이름은
  `whisper_mlx.py::_REPO`에 실재 확인됨(HF 200); 여기서는 다운로드/추론 자체를 검증.
  미리 캐시하려면 `WHISPER_MLX_REPOS=...` 로 `download_models.py` 실행.

> **GPU 미가용 시**: payload가 `gpu`를 요청했는데 MPS가 없으면 job은
> `gpu_unavailable`로 **PERMANENT 실패**한다 — CPU 폴백 없음(재현성 보존).

## 렌즈 추출 LLM (`extract_lenses`)

`lens_client.py`와 `summary_client.py`는 **OpenAI 호환 chat-completions 서버**면
무엇이든 붙는 범용 어댑터이고, 둘은 `LENS_LLM_BASE_URL` **하나를 공유**한다
(모델명만 각자 갖는다). Ollama 의존성은 없다 — 서버는 `mlx_lm.server` 하나만 띄운다.
요약 모델명은 카탈로그(`src/contracts/model-catalog.ts`)로 고정돼 있고, 그 값이
`mlx_lm.server`가 그대로 받는 **HF repo id**다.

```bash
uv tool install mlx-lm      # 워커 venv 밖에 설치 — 워커는 mlx_lm을 import하지 않는다
```

**기본값(`LENS_LLM_MANAGED=true`)에서는 서버를 직접 띄울 필요가 없다.** 렌즈/요약
자식이 job 직전에 payload의 모델로 아래 명령과 같은 프로세스를 띄우고, job이 끝나면
SIGTERM으로 내린다(`llm_server.py`). 큐가 빈 동안 모델이 메모리를 쥐고 있지 않게 하는
것이 목적이다 — 8bit 27B는 ~28GB고, 상시 띄워두면 무관한 `process_meeting`이 도는
동안에도 whisper와 나란히 그 메모리를 잡고 있다. 대가는 job당 모델 로드 1회다(렌즈와
요약은 `persist`가 같이 큐잉하므로 한 쌍이면 2회).

서버를 직접 띄워 찔러 보고 싶으면 그렇게 해도 된다 — **이미 떠 있는 서버를 발견하면
워커는 그걸 남의 것으로 보고 재사용만 하고 죽이지 않는다.**

```bash
mlx_lm.server --model mlx-community/Qwen3.5-4B-8bit \
  --chat-template-args '{"enable_thinking":false}' \
  --host 127.0.0.1 --port 8000
```

`--chat-template-args`로 서버 기본값도 추론 off로 맞춘다. 클라이언트가 요청마다
같은 값을 보내므로(아래 함정) 이 플래그 없이도 동작하지만, 서버를 직접 찔러 볼 때
기본값이 일치해 있는 편이 헷갈리지 않는다. 워커가 띄울 때도 같은 플래그를 붙인다.

```
# worker/.env — LENS_LLM_BASE_URL은 필수다(기본값 없음). 나머지는 config.py 기본값과 같다.
# 워커가 이 URL의 host:port로 서버를 띄우므로 포트가 명시돼 있어야 한다.
LENS_LLM_BASE_URL=http://127.0.0.1:8000/v1
LENS_LLM_MANAGED=true      # false면 예전처럼 사람이 띄운 서버를 그대로 쓴다
LENS_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit
SUMMARY_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit

# be/.env (API) — 값이 job payload에 각인되므로 워커와 반드시 같아야 한다
LENS_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit
SUMMARY_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit   # 카탈로그 밖 값이면 API가 아예 부팅하지 않는다
```

**`--model`로 띄운 것과 다른 repo를 요청하면** `mlx_lm.server`가 그 자리에서 HF에서
받아 로드하고 기존 모델을 내린다. 워커가 띄울 때는 payload의 모델을 그대로 `--model`로
주므로 스왑이 나지 않는다. **수동으로 띄운 서버를 재사용하는 경우엔** 렌즈와
요약(= light 프리셋)을 같은 repo로 맞춰 두는 게 좋다. standard/quality 프리셋으로
요약하면 9B/27B를 그때 받는다.

확인:

```bash
# 1) 워커 기동 로그 — 슈퍼바이저가 GET {LENS_LLM_BASE_URL}/models를 1회 확인한다
#    managed(기본): INFO ... is worker-managed — started per lens/summary job
#    managed=false + 떠 있음:  lens/summary LLM at ... serving: mlx-community/...
#    managed=false + 안 떠 있음: WARNING ... is unreachable — ... jobs will retry...
#    어느 쪽이든 워커는 정상 기동한다 (process_meeting은 LLM을 쓰지 않는다).
uv run python -m damwha_worker

# 2) 실제 추출
curl -s -X POST http://localhost:3000/meetings/<id>/lenses/extract   # status=done인 회의
# run/job이 done이 되고 lens_item + lens_evidence가 생기는지 확인

# 3) managed 경로 확인 — job 도는 동안에만 프로세스가 보이고, 끝나면 사라진다
watch -n1 'pgrep -fl mlx_lm.server'
```

managed=false에서 서버가 없을 때의 실패 경로: `httpx.RequestError` →
`llm_request_failed`(TRANSIENT) → 지수 백오프로 requeue → `max_attempts`(기본 3)
소진 후 job `failed`. 회의는 `done`을 유지한다. managed=true에서 서버를 못 띄우면
`llm_server_start_failed` — 바이너리가 PATH에 없거나 base URL에 포트가 없으면
PERMANENT(즉시 실패), 기동 타임아웃·조기 종료면 TRANSIENT(재시도)다.

함정 다섯:

- **추론(thinking)을 끄는 키는 런타임마다 다르다 — 그래서 둘 다 보낸다.** Ollama는
  `reasoning_effort`를 읽지만 `mlx_lm.server`는 그 키를 **조용히 무시**하고
  `chat_template_kwargs`만 본다(`server.py`가 CLI `--chat-template-args` 위에
  `.update`로 덮는다). Qwen3.5의 chat template은 `enable_thinking`이 정의되지 않으면
  `<think>`를 열어 사고를 시작하므로, 두 클라이언트 모두
  `chat_template_kwargs={"enable_thinking": false}`를 함께 보낸다 — 안 읽는 키는
  무시되니 어느 런타임에 붙어도 안전하다. 이게 빠지면 커밋 `13dd6ae`가 Ollama에서
  겪은 증상 — 사고에만 수 분(398초), 사고 토큰이 `max_tokens` 예산을 잠식해 JSON이
  잘림 — 이 그대로 재현된다.
- **생성 길이 상한은 클라이언트가 바디로 보낸다**(`LENS_LLM_MAX_TOKENS`, 기본 8192).
  `mlx_lm.server`의 `--max-tokens` 기본값은 **512**라 서버 기본값에 맡기면 회의 하나
  분량의 JSON도 못 담고 배열 중간에서 잘린다 — `finish_reason=length`로 끝나고
  `llm_invalid_response`(`Unterminated string…`) PERMANENT 실패가 된다. 바디 값이
  서버 CLI 기본값을 덮으므로 서버를 어떻게 띄웠는지와 무관하게 동작한다.
- **`mlx_lm.server`는 요청의 `model` 필드를 무시하지 않으며, 별칭을 걸 방법이 없다.**
  받은 이름을 그대로 repo id/로컬 경로로 해석하므로 Ollama 태그 표기(`qwen3.5:4b-mlx`)를
  보내면 `Repo id must use alphanumeric chars…`로 거부당한다. 유효한 repo명이거나
  `default_model`(요청에서 `model`을 아예 생략했을 때의 기본값 — `--model`로 띄운
  모델에 매핑된다)이어야 한다. `server.py`의 `_model_map`에는 그 한 항목뿐이라 CLI로
  별칭을 추가할 수 없다 — **요약 모델 카탈로그를 HF repo id로 적는 이유가 이것이다.**
- **API는 `.env`를 부팅 시 1회만 읽는다**(`src/main.ts`의 `import 'dotenv/config'`).
  `nest start --watch`는 소스 변경에만 반응하므로 `.env`를 고쳤으면 **실제로 재시작**해야
  한다(`touch`는 tsc incremental이 건너뛴다). 안 하면 API가 옛 `LENS_LLM_MODEL`을
  payload에 계속 각인한다.
- **`response_format`은 로컬 런타임에서 권고사항이다.** 모델이 nullable 필드를 통째로
  생략하므로 `LensCandidate`의 `assignee_speaker_id`/`due_at`은 기본값 `None`을 갖는다
  (생략 = 명시적 null). `extra="forbid"`는 유지되므로 없는 필드를 지어내는 것은 여전히
  거부된다. `reasoning_effort` 같은 미지원 키는 서버가 조용히 무시한다.

## 화자 식별 품질 측정 (`scripts/eval_speaker_id.py`)

**`IDENTIFY_THRESHOLD`/`IDENTIFY_SUGGEST_THRESHOLD`는 이 도구로 정한다 — 감으로 바꾸지 말 것.**
DB만 읽는 읽기 전용 도구다(SELECT만 발행). `meeting_cluster.centroid`가 이미 저장돼 있으므로
모델도 오디오도 없이 식별 정책 전체를 오프라인 리플레이할 수 있다.

```bash
cd worker
# 기본: health(위생) + scoring(EER) + policy(F1 리플레이)
uv run python scripts/eval_speaker_id.py --labels scripts/eval_speaker_labels.json

# 임계값 실측: 각 클러스터 발화를 교대로 반씩 갈라 재임베딩 → 라벨 없이
# 동일화자/다른화자 분포를 얻는다. 모델 extra + 회의 normalized.wav 필요.
uv sync --extra models
uv run python scripts/eval_speaker_id.py --halves --thresholds 0.5,0.6,0.7,0.8
```

- **정답 라벨**은 `scripts/eval_speaker_labels.json` — `"<meeting_id>/<diar_label>": "<사람>"`.
  일부만 채워도 되고, 없는 클러스터는 scoring/policy에서 빠진다(health에는 남는다).
  `_`로 시작하는 키는 파일 자체 메모로 취급돼 무시된다.
- **`--halves`의 동일화자 점수는 낙관적이다.** 두 반쪽이 같은 녹음을 공유하므로 실제
  회의 간 매칭보다 높게 나온다. **다른화자 최댓값을 자동 연결의 하한**으로 읽고,
  동일화자 최솟값은 상한으로만 쓴다.
- **policy 표의 F1은 `threshold`만 움직인다.** 제안 밴드에 든 클러스터도 자기 화자를
  새로 만들기 때문에 파티션이 바뀌지 않는다. 밴드는 사용자에게 무엇을 보여줄지만 정한다.
- 미해결 이슈(구버전 잔존 화자·회의 내 병합·발화 0건 클러스터)와 centering을 기각한
  근거는 `docs/backlog.md`의 "화자 식별 — RC3/RC4/RC5 후속" 항목에 있다.

## STT 품질 측정 (`scripts/eval_stt.py`)

전사 백엔드/모델/가드 조합을 하나의 wav에 대해 돌리고 참조 스크립트와 CER/WER을
비교한다. 파이프라인 밖에서 STT만 격리해 재는 용도 — 프로덕션 수치는 항상 DB의
`utterance`로 확인한다(아래 "실측" 참고).

```bash
# 오디오 + 참조 자막 준비 (수동 자막이 있는 영상이면 --write-subs 사용)
yt-dlp -x --audio-format wav -o "audio.%(ext)s" --write-auto-subs \
  --sub-langs ko --sub-format json3 <URL>
ffmpeg -y -i audio.wav -ac 1 -ar 16000 -f wav audio16k.wav

cd worker
uv run --with jiwer python scripts/eval_stt.py \
  --wav /path/audio16k.wav --json3 /path/ref.ko.json3 --outdir /path/out \
  --runs turbo,large,faster,pipeline        # 기본값: 넷 다

# Qwen3-ASR(mlx-audio)까지 재려면 --with를 하나 더 준다
uv run --with jiwer --with mlx-audio python scripts/eval_stt.py \
  --wav ... --json3 ... --outdir ... --runs turbo,qwen17,qwen06
```

- 기본 동작은 프로덕션 경로와 같다 — Silero VAD → `prepare_stt_spans` → 그 구간만
  디코딩. `--full-file`을 주면 VAD를 건너뛰고 전체 파일을 전사하므로
  **clip_timestamps 가드만 분리**해서 잴 수 있다(디코딩 파라미터 가드는 어댑터
  모듈 상수라 항상 켜져 있다). 그래서 `--full-file`은 아래 표의 "가드 없음" 행이
  **아니라** "가드, 전체 파일" 행이다 — 무가드 수치는 어댑터 상수를 손으로 고쳐야
  나온다.
- `qwen17`/`qwen06` 런은 두 플래그와 무관하게 **항상 전체 파일**을 전사하고
  `full_file: true`를 결과에 남긴다. Qwen3-ASR엔 `clip_timestamps` 대응물이 없다.
- 한국어는 띄어쓰기 차이가 WER을 지배한다 — **CER을 주 지표로** 본다.
- **유튜브 자동 자막은 ground truth가 아니다**(구글 ASR 출력). 절대 정확도가 아니라
  런 사이 *상대* 비교로만 쓴다. 실제로 아래 실측에서 참조 쪽이 "크리스토퍼 놀란"을
  "논란"으로 적었다.
- `jiwer`는 dev 의존성이 아니라 `--with jiwer`로 넘긴다(이 스크립트 전용).

### 실측 (2026-08-09, 한국어 강연 17분, 단일 화자)

| 조건 | 모델 | CER | 비고 |
|---|---|---|---|
| 가드 없음, 전체 파일 | turbo | 3.98% | 깨끗한 오디오 최저 |
| 가드 없음, 전체 파일 | large-v3 | 8.18% | |
| 가드 없음, 파이프라인 | large-v3 | **21.27%** | `ithmion` 반복 루프 발생 |
| 가드, VAD clip | turbo | 5.07% | |
| 가드, VAD clip | large-v3 | 8.21% | |
| 가드, 전체 파일 | turbo | 7.68% | decode 파라미터만 |
| 가드, 파이프라인(DB) | turbo | 5.22% | |
| 가드, 파이프라인(DB) | large-v3 | 5.53% | |

세 가지가 확인됐다:

1. **한국어에서 `large-v3`가 `large-v3-turbo`보다 낫지 않다.** 평균이 비슷할 뿐
   아니라 런 간 분산이 크다(large-v3 5.53↔8.21 vs turbo 5.07↔5.22). 무가드
   large-v3가 같은 오디오에서 8.18%↔21.27%로 널뛴 것은 temperature fallback의
   비결정성 때문이다. 전역 기본 프리셋을 `standard`(turbo)로 둔 근거.
2. **환각 가드는 세트로만 의미가 있다.** turbo에 decode 파라미터만 걸면 3.98% →
   7.68%로 오히려 나빠진다(`condition_on_previous_text=False`의 문맥 손실).
   VAD clip이 이를 되돌려 5.07%가 된다. 하나만 떼지 말 것.
3. **가드는 공짜가 아니다.** 깨끗한 오디오에서는 무가드가 여전히 1.2%p 낮다.
   회의 녹음(BGM·잡음·다화자)의 참사 리스크와 맞바꾼 값이다.

남은 알려진 한계: 발화 없는 BGM 구간(예: 아웃트로)에서 유령 발화가 붙을 수 있다.
`hallucination_silence_threshold`는 무음 기준이라 음악에는 걸리지 않는다. 실측에서
해당 utterance의 confidence는 0.18–0.46으로 본편(0.92–0.98)과 뚜렷이 갈렸다 —
다만 conf가 만능은 아니다. 위 21.27% 케이스의 반복 루프는 conf 0.95였다.

### 실측 (2026-08-13, Qwen3-ASR 도입 검토, 같은 오디오/참조)

`mlx-community/Qwen3-ASR-{1.7B,0.6B}-bf16`을 mlx-audio로 돌려 turbo와 비교했다.
2026-08-09와 **같은 wav·같은 영상의 자막**을 썼다(참조는 그날 것이 남아있지 않아
`yt-dlp`로 재수집).

| 조건 | 모델 | CER | WER | 시간 |
|---|---|---|---|---|
| 전체 파일 | qwen17 | **4.59%** | 18.71% | 148.1s |
| 가드, VAD clip | turbo | 5.22% | 21.26% | 70.1s |
| 전체 파일 | qwen06 | 5.72% | 19.96% | 86.9s |
| 가드, 전체 파일 | turbo | 7.68% | 23.71% | 49.0s |

turbo 두 줄은 2026-08-09의 5.07%/7.68%를 재측정한 것이다 — 전체 파일은 소수점까지
일치했고, VAD clip은 5.07%→5.22%로 재현 오차가 있다.

1. **Qwen3-ASR 1.7B가 프로덕션 turbo보다 낫다.** 5.22% → 4.59% (상대 12% 감소).
   같은 전체 파일 조건끼리면 7.68% → 4.59%지만, 그쪽 turbo 수치는
   `condition_on_previous_text=False`의 문맥 손실이 섞인 값이라 과대평가다.
2. **0.6B는 turbo와 동급이다.** 표기 규약 차이가 CER을 0.5%p씩 흔든다 — 0.6B만
   숫자를 한글로 풀어쓴다("1177년"→"천백칠십칠 년"). 참조의 숫자를 한글로 바꿔
   다시 재면 순위가 뒤집힌다(turbo 5.74% / qwen17 5.09% / qwen06 5.17%).
   **qwen17만 두 표기 조건 모두에서 1등**이다. 0.6B를 쓸 이유는 없다.
3. **시간 비교엔 편향이 있다.** turbo의 `elapsed_s`는 모델 생성을 포함하고 qwen은
   `generate()`만 잰다. 그걸 감안해도 qwen17은 turbo의 2배가량 느리다.

### 실측 (2026-08-13, 실제 회의 녹음 29분, 다화자)

위 강연은 단일 화자·깨끗한 오디오라 실사용처와 성격이 다르다. 실제 회의 녹음
(참조 전사 없음, 로컬 파일)으로 turbo(프로덕션 경로)와 qwen17을 다시 비교했다.
참조가 없으므로 CER은 못 낸다 — 대신 **텍스트만으로 판정 가능한 파국적 실패**를
셌다. VAD 207 span, 발화비율 91.9%.

| | turbo | qwen17 |
|---|---|---|
| 전체 문자 | 11,919 | 8,325 |
| 반복 루프 문자 | 3,783 (**31.7%**) | 8 (0.1%) |
| 루프 제거 후 | 8,136 | 8,317 |
| 전사 시간 | 287.3s | 218.7s |

**turbo가 이 오디오에서 반복 루프로 무너진다.** 5개 구간에서 각각 약 223단어의
리터럴 `CON`이 쏟아졌고(전체 4,429단어 중 1,109개 = 25%), 각 구간의 실제 오디오는
0.3–2.3초에 불과하다. 1,109개 중 **1,045개가 길이 0초** — 오디오 시간을 안 쓰고
디코더가 토큰 상한까지 루프를 돈 것이다. 207 clip 중 5개가 그렇게 됐다.

1. **confidence로 못 거른다.** 루프 단어의 max confidence가 0.97–0.98이다.
   2026-08-09의 "반복 루프는 conf 0.95였다"와 같은 양상이며, 이번엔 더 높다.
   `hallucination_silence_threshold`도 무음 기준이라 걸리지 않는다.
2. **루프를 걷어내면 두 모델의 실질 분량이 같다**(8,136 vs 8,317자). 같은 회의를
   비슷한 밀도로 받아썼고 turbo만 쓰레기를 덧붙였다는 뜻이다.
3. **속도도 여기선 qwen17이 빠르다**(218.7s vs 287.3s). 강연과 반대인데, turbo는
   clip마다 개별 호출하므로(207회) span이 많아질수록 오버헤드가 커진다.
4. 루프 외 불일치 블록 194개(4자 이상)는 이 시점엔 참조가 없어 판정하지 못했다 —
   아래 "참조 확보 후 재측정"에서 뒤집힌다.

**이건 Qwen 도입과 무관하게 현재 프로덕션의 결함이었다.** `CON` 단어들은 정상
타임스탬프를 달고 나오므로 `build_utterances`가 화자에 배정한다. 원인 규명과 수정은
아래 참고.

### 반복 루프의 근본 원인과 수정 (2026-08-13)

**원인 — upstream Whisper의 안전망 두 개가 같은 성질 하나에 함께 무력화된다.**
짧은 VAD span은 30초 창으로 패딩되어 대부분 무음이 되므로 `no_speech_prob`가 높다.
`mlx_whisper/transcribe.py`에서:

- `237-241`: `compression_ratio > 2.4`가 "too repetitive"로 `needs_fallback=True`를
  걸지만, 바로 다음 분기가 `no_speech_prob > 0.6`이면 `needs_fallback=False`로
  되돌린다. **temperature fallback이 아예 돌지 않는다.**
- `301-309`: 그러면 무음으로 스킵될 차례인데, 반복 루프는 `avg_logprob`이 높아
  `should_skip=False`가 되어 살아남는다.

즉 "모델이 쓰레기를 확신한다"는 성질 하나가 두 방어를 동시에 뚫는다. 관측된 단어당
confidence 0.96–0.98이 그 값이다. 반복 횟수 223/111/55는 전부
`sample_len = n_text_ctx // 2 = 224`(`decoding.py:419`) 토큰 상한에 도달한 결과이며,
토큰 수가 다른 단어일수록 횟수가 줄 뿐이다(`max`=1토큰→223, `넣은`=2→111,
`반죽을`=4→55). **`faster_whisper/transcribe.py:1513,1223`에 같은 로직이 있으므로
`devices.stt=cpu`는 회피로가 아니다.**

**기각한 수정: `no_speech_threshold=None`.** 반복 판정은 살아나지만 무음 스킵도 함께
꺼진다. 회의 루프는 run당 2.2건→0.33건으로 줄었으나 강연 CER이 5.07% → 8.82%로
악화됐다(단어 1994→2220, 무음 구간 환각). 두 효과가 한 파라미터에 묶여 있어 분리할
수 없다 — 값을 1.1로 올려도 None과 같고, 낮추면 fallback이 아예 죽는다.

**채택한 수정: `pipeline/stt_repetition.py::drop_repetition_loops`.** 어댑터 출력에서
축퇴 구간만 제거한다. 판정은 두 조건을 모두 요구한다.

- 동일 텍스트 **6회 이상 연속**. 회의 전사 4개(약 14,000단어) 실측에서 정상 반복의
  최대는 5회였고 **6–10회는 0건**, 그 위는 11/55/111/218/222/223으로 전부 루프였다.
- **초당 5단어 초과**. 루프는 55–223단어를 1–3초에 몰아넣는다(65–147단어/초). 이
  조건 덕분에 "네"를 3초에 걸쳐 여섯 번 말한 경우는 남는다.

교차 검증: 루프 안 단어의 93.8%가 길이 0초인 반면 루프 밖은 0.7%였다.

**검증 결과**

| | 수정 전 | 수정 후 |
|---|---|---|
| 회의 루프 span (run당) | 2, 2, 1, 4, 2 | **0, 0, 0** |
| 회의 단어 수 | 3351, 3405, 3213 | 3124, 3099, 3099 |
| 강연 CER | 5.07% / 5.22% | 5.27% |
| 강연 단어 수 | 1997 | 1998 |

강연에서 단어 수가 그대로인 것은 **깨끗한 오디오에서 필터가 발동하지 않는다**는
뜻이다(오탐 없음). 회의에서 줄어든 단어 수는 제거된 루프 크기와 일치한다.

남은 한계: 루프는 **비결정적**이라 같은 파일·같은 파라미터로도 매 run 다른 span에서
터진다(격리 호출 72회에서는 0건, 207-clip 배치에서는 run당 1–5건). 필터는 결과를
걷어낼 뿐 발생 자체를 막지 못하므로, 발생률이 오르면 다시 볼 것.

### 회의 오디오 재측정 — 참조 확보 후 (2026-08-13)

같은 회의 녹음의 Clova Note 전사를 확보해 CER을 냈다. **참조 자체가 ASR 출력이라**
유튜브 자동 자막과 같은 한계다 — 절대 정확도가 아니라 상대 비교로만 읽는다. 다만
turbo/qwen과 독립된 제3의 엔진이므로 한쪽에 편향될 이유는 없다. 참조 8,583자
(화자·시각 줄과 `clovanote.naver.com` 푸터 제거 후).

| 전사 | run별 CER | 평균 |
|---|---|---|
| turbo 수정 전 | 30.65 / 45.78 / 27.33 / 68.08% | **42.96%** |
| turbo 수정 후 | 25.20 / 27.80 / 24.93% | **25.98%** |
| qwen17 | 26.19 / 26.19 / 26.19% | **26.19%** |

1. **반복 루프 수정이 회의 CER을 42.96% → 25.98%로 낮춘다**(상대 40% 감소). 루프
   개수뿐 아니라 전사 품질로도 수정 효과가 확인됐다.
2. **qwen17의 회의 우위는 turbo의 결함이 만든 착시였다.** 26.19%는 수정 후 turbo의
   범위(24.93–27.80%) 안이고 평균으로는 0.21%p 뒤진다. 루프를 고치자 격차가 사라진다.

| 오디오 | turbo (수정 후) | qwen17 |
|---|---|---|
| 강연 17분 · 단일 화자 | 5.22% | **4.59%** |
| 회의 29분 · 다화자 | **25.98%** | 26.19% |

**실사용처에서는 동률이다.** Qwen이 이기는 것은 깨끗한 단일 화자 오디오뿐이고, 그
대가로 2배 느린 디코딩과 ForcedAligner 2단 체인이 붙는다 — 도입 근거가 약해졌다.

Qwen에 유리한 관측 하나: **qwen17은 3회 모두 12,293자·CER 26.19%로 동일**했다.
turbo는 같은 조건에서 2.9%p 퍼진다. payload 재현성을 설계 가치로 두는 이 저장소에서
무의미한 차이는 아니지만, 3회로 결정성을 단정할 수는 없다.

### Qwen3-ASR 도입의 남은 관문

**word timestamp가 없다.** mlx-audio의 `STTOutput.segments`는
발화 구간이 아니라 청크 경계다(`chunk_duration` 기본 1200s). 30초 슬라이스가
세그먼트 1개(`start=0.0, end=30.0`)로 나오는 것으로 확인했다. `align.build_utterances`가
단어 중점으로 화자를 배정하므로(`_segment_for`), 이대로는 `Transcriber` 프로토콜을
만족시킬 수 없다. 채우려면 `Qwen3-ForcedAligner-0.6B`를 2단으로 얹어야 하고, 그쪽은
5분 제한이 있어 VAD span 단위 정렬이 강제된다. 그래서 `eval_stt.py`의 qwen 경로는
`Transcriber`가 아니라 텍스트만 돌려주는 `qwen_transcribe()`로 두었다.
