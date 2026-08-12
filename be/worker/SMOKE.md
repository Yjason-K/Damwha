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

1. Run Postgres (pgvector) + apply migrations (`npm run migrate`).
2. `npm run start:dev` (NestJS API).
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
# from repo root
docker build -t damwha/postgres-bigm:pg16 docker/postgres-bigm/
```

Or just `docker compose up -d` from the repo root — the `postgres` service
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

1. **Postgres** (`damwha/postgres-bigm:pg16`) + `npm run migrate`
2. **Embed service** — wait for `/health` → `{"status":"ok"}`
3. **Lens LLM 서버** (렌즈 추출 / 요약이 쓴다 — 둘이 같은 서버) — 아래 "렌즈 추출 LLM" 참고.
   워커보다 먼저 띄우면 슈퍼바이저 기동 로그에 서빙 중인 모델이 찍힌다.
4. **NestJS API** — `npm run start:dev`
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
mlx_lm.server --model mlx-community/Qwen3.5-4B-8bit \
  --chat-template-args '{"enable_thinking":false}' \
  --host 127.0.0.1 --port 8000
```

`--chat-template-args`로 서버 기본값도 추론 off로 맞춘다. 클라이언트가 요청마다
같은 값을 보내므로(아래 함정) 이 플래그 없이도 동작하지만, 서버를 직접 찔러 볼 때
기본값이 일치해 있는 편이 헷갈리지 않는다.

```
# worker/.env — LENS_LLM_BASE_URL은 필수다(기본값 없음). 나머지는 config.py 기본값과 같다.
LENS_LLM_BASE_URL=http://127.0.0.1:8000/v1
LENS_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit
SUMMARY_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit

# 루트 .env (API) — 값이 job payload에 각인되므로 워커와 반드시 같아야 한다
LENS_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit
SUMMARY_LLM_MODEL=mlx-community/Qwen3.5-4B-8bit   # 카탈로그 밖 값이면 API가 아예 부팅하지 않는다
```

**`--model`로 띄운 것과 다른 repo를 요청하면** `mlx_lm.server`가 그 자리에서 HF에서
받아 로드하고 기존 모델을 내린다. 동작은 하지만 요청마다 스왑이 일어나므로, 렌즈와
요약(= light 프리셋)은 같은 repo로 맞춰 두는 게 좋다. standard/quality 프리셋으로
요약하면 9B/27B를 그때 받는다.

확인:

```bash
# 1) 워커 기동 로그 — 슈퍼바이저가 GET {LENS_LLM_BASE_URL}/models를 1회 확인한다
#    떠 있으면:  lens/summary LLM at http://127.0.0.1:8000/v1 serving: mlx-community/...
#    안 떠 있으면: WARNING ... is unreachable — extract_lenses/summarize_meeting jobs will retry...
#    경고가 떠도 워커는 정상 기동한다 (process_meeting은 LLM을 쓰지 않는다).
uv run python -m damwha_worker

# 2) 실제 추출
curl -s -X POST http://localhost:3000/meetings/<id>/lenses/extract   # status=done인 회의
# run/job이 done이 되고 lens_item + lens_evidence가 생기는지 확인
```

서버가 없을 때의 실패 경로: `httpx.RequestError` → `llm_request_failed`(TRANSIENT) →
지수 백오프로 requeue → `max_attempts`(기본 3) 소진 후 job `failed`. 회의는 `done`을
유지한다.

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
```

- 기본 동작은 프로덕션 경로와 같다 — Silero VAD → `prepare_stt_spans` → 그 구간만
  디코딩. `--full-file`을 주면 VAD를 건너뛰고 전체 파일을 전사하므로
  **clip_timestamps 가드만 분리**해서 잴 수 있다(디코딩 파라미터 가드는 어댑터
  모듈 상수라 항상 켜져 있다).
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
