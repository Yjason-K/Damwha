# 검증 증거 — Task 5 (임베딩 서비스와 `mlx_lm.server`)

- 커밋: `f840679f1465cf03124002335a7528ef62cae3b6` (요청된 COMMIT `f840679`와 일치, 시작 전 `git -C <worktree> rev-parse HEAD`로 확인, 실행 종료 시점도 재확인해 동일함을 확인)
- 환경:
  - macOS: `ProductVersion 27.0` / `BuildVersion 26A5425a` / `Darwin 27.0.0 arm64`
  - node: `v22.21.1`
  - pnpm: `10.26.0`
  - `python3`(쉘 PATH, 검증 도구로만 쓰임 — 피검사 대상 아님): `Python 3.10.21` (`python3 -> python3.10` alias). verify 스크립트가 실제로 부르는 것은 `SYSPY=/usr/bin/python3`(t5-lib.sh)와 번들 `bundle/python/bin/python3.12`이며, 이 쉘 `python3`는 어느 verify 판정에도 쓰이지 않는다.
  - Docker: `docker ps`가 5초 타임아웃에도 무응답 (지시문에 적힌 "Task 3·4·5 연속 무응답"과 일치). Task 5 Verify 어디에도 docker 호출이 없어 영향 없음.
  - Postgres(55432): 시작 시점 정지 상태(`lsof` 무응답 → free). Task 5는 DB를 쓰지 않는다.
- 실행 일시(UTC): 2026-09-09T14:23:58Z(시작 확인) ~ 2026-09-09T14:26:46Z(종료 확인). 로컬(KST) 23:23:58 ~ 23:26:46.

## 시작 전 상태 확인

- `git -C /Users/gim-yeongjae/project/daewha-electron-phase-0 rev-parse HEAD` → `f840679f1465cf03124002335a7528ef62cae3b6` — COMMIT과 일치.
- 시작 시점 포트: `lsof -i :58000 -i :58100 -i :55432` → 무응답(exit 1, 즉 free). `ps aux | grep -E "mlx_lm|embed_service|uvicorn"` → 출력 없음.
- `$SANDBOX/run/`에 `embed.pid`·`llm.pid`·`pg.pid` 파일 없음 — embed·llm 모두 정지 상태로 시작(지시문과 일치).
- `$SANDBOX/run/embed-start.txt`·`llm-start.txt`는 이미 존재(구현자의 자체 실행 잔재, timestamp 23:14~23:16, 내 실행 이전). `$EVIDENCE`에도 구현자가 남긴 `t5-*.txt`가 이미 존재했다 — 아래 각 verify 스크립트는 `t5_evidence_path()`/`rotate()`로 기존 파일을 `*.prev-<UTC>.txt`로 옮기고 새로 쓰므로, 내가 실행한 결과는 새 파일에, 구현자의 이전 실행 결과는 `*.prev-20260909T1425xxZ.txt`로 보존됐다.
- `df -g /System/Volumes/Data` (V1 preflight 실행 시점, 시작): `Available 11` (1G-blocks, GiB) — 구현자가 보고한 종료 상태(21→11 GiB)와 이미 같은 11 GiB에서 시작한다. 즉 내 실행 시작 시점 자체가 이미 구현자의 이전 다운로드가 반영된 뒤였다(모델이 샌드박스 캐시에 이미 있었음, 지시문과 일치).

## Verify 실행 (계획 표 순서, cwd 전부 `<repo root>` = 이 worktree)

### V1. `bash experiments/electron-phase-0/lib/preflight.sh 10`
- cwd: worktree 루트
- 기대: exit 0
- 실제: `여유 : 11 GiB` / `필요 : 10 GiB` / `판정 : 충분`, 포트 55432·58000·58100 전부 `free`
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
preflight.sh — 사전 점검

디스크
  대상 경로 : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0
  마운트    : /System/Volumes/Data
  여유      : 11 GiB
  필요      : 10 GiB
  판정      : 충분

포트 (개발 기본값 5432 / 8000 / 8100과 분리된 실험 포트, 스펙 §7.1 U-6)
  55432 (실험 DB): free
  58000 (mlx_lm.server): free
  58100 (embed): free

검사 도구 (스펙 §4.0 — 피검사 대상이 아니라 측정 수단이다)
  otool: /usr/bin/otool
  file: /usr/bin/file
  lsof: /usr/sbin/lsof
  shasum: /usr/bin/shasum
  df: /bin/df

be/storage(읽기 전용 원본): /Users/gim-yeongjae/project/daewha/be/storage
```
</details>

### V2. `bash experiments/electron-phase-0/lib/run-isolated.sh --label t5-embed -- experiments/electron-phase-0/services/embed.sh start`
- cwd: worktree 루트
- 기대: exit 0, 래퍼가 블로킹하지 않고 돌아온다
- 실제: exit 0, wall time 12.588s(구현자 보고 52초보다 짧음 — 모델이 이미 샌드박스 캐시에 있었기 때문으로 보인다, 로그의 `Loading weights: 100%|...` 표시가 즉시 완료됨). pid 78210. `$SANDBOX/run/embed.pid`=78210 생성 확인.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
run-isolated: label=t5-embed  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.V4wgXu/stderr.raw)
기동: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/damwha-embed
  포트     : 127.0.0.1:58100
  HF_HOME  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
  stderr   : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/embed-stderr.txt (규칙 3b의 tee 사본)
  stdout   : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/embed-stdout.txt
  pid      : 78210
  cmdline  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/damwha-embed
준비됨: GET /health -> {"status":"ok"}
Loading weights:   0%|          | 0/391 [00:00<?, ?it/s]dyld[78261]: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
Loading weights: 100%|██████████| 391/391 [00:00<00:00, 58595.57it/s]
INFO:     Started server process [78210]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:58100 (Press CTRL+C to quit)
bash experiments/electron-phase-0/lib/run-isolated.sh --label t5-embed --    0.15s user 0.22s system 2% cpu 12.588 total
```
</details>

### V3. `bash experiments/electron-phase-0/verify/t5-embed-health.sh`
- cwd: worktree 루트
- 기대: exit 0, `GET /health`가 `{"status":"ok"}`
- 실제: `응답: {"status":"ok"}`, 포트 58100을 pid 78210(embed.pid와 동일)이 잡고 있음 확인
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)
  embed: 살아 있음 (pid 78210)

== GET http://127.0.0.1:58100/health
  응답: {"status":"ok"}
  OK   {"status":"ok"} 형태다

== 포트 소유 확인 (개발 기본값 8100이 아니라 실험 포트 58100 인가)
  OK   58100 를 우리 PID 파일의 서버(pid 78210)가 잡고 있다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-embed-health.txt
판정: 번들 embed 서비스가 58100 에서 /health에 응답한다
```
</details>

### V4. `bash experiments/electron-phase-0/verify/t5-embed-vector.sh`
- cwd: worktree 루트
- 기대: exit 0. `POST /embed`가 `model=BAAI/bge-m3`, `dimension=1024`, 벡터 1개, 길이 1024
- 실제: `model: BAAI/bge-m3`, `dimension: 1024`, `vector_count: 2`(요청 문자열 2개를 보냈으므로 벡터 2개, 각각 길이 1024), `be/worker/.env`의 `SEARCH_EMBEDDING_DIM(1024)`과 일치, 두 벡터가 서로 다름(`two_vectors_identical: False`)
- 일치: 예 (표의 "벡터 1개"는 계획의 요약 표현이고, 스크립트 자체는 P0-C5의 "요청 문자열 수만큼의 벡터"를 근거로 2개를 보내 개수/길이/비상수성을 확인함 — 스크립트 주석에 그 판단 근거가 명시돼 있음)
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)
  embed: 살아 있음 (pid 78210)

== POST http://127.0.0.1:58100/embed
  요청: {"texts":["담화는 회의 녹음을 요약한다","두 번째 문장은 벡터 개수를 확인하려고 넣는다"]}

  model: BAAI/bge-m3
  dimension: 1024
  vector_count: 2
  vector[0] len: 1024  head: [0.034910, 0.010353, -0.070133, 0.005738, ...]
  vector[1] len: 1024  head: [-0.051210, -0.028172, -0.027173, 0.012027, ...]
  two_vectors_identical: False

  OK   model = BAAI/bge-m3
  OK   dimension = 1024
  OK   be/worker/.env의 SEARCH_EMBEDDING_DIM(1024)과 같다
  OK   요청 2개에 벡터 2개, 각각 길이 1024
  OK   두 벡터가 서로 다르다 — 상수 벡터를 돌려주는 것이 아니다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-embed-vector.txt
판정: 번들 bge-m3가 1024차원 벡터를 요청 수만큼 돌려준다
```
</details>

### V5. `bash experiments/electron-phase-0/verify/t5-embed-stop.sh`
- cwd: worktree 루트
- 기대: exit 0. `embed.sh stop` 후 58100이 응답하지 않음
- 실제: SIGTERM 전송(pid 78210) → 1초 안에 종료 확인. `/health` curl exit 7(연결 거부). 58100 LISTEN pid 없음. PID 파일 정리됨
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 종료 전 상태
  pid 78210, 58100 LISTEN: 78210

== embed.sh stop (PID 파일 대상 SIGTERM)
  SIGTERM: pid 78210
  종료 확인 (SIGTERM 1s 안에 내려갔다)

== 종료 후 확인
  OK   stop이 exit 0
  OK   pid 78210 가 SIGTERM에 내려갔다
  OK   58100/health 가 더는 응답하지 않는다 (curl exit 7)
  OK   58100 를 LISTEN 하는 프로세스가 없다
  OK   PID 파일이 정리됐다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-embed-stop.txt
판정: embed 서비스가 SIGTERM에 내려가고 58100 가 비었다
```
</details>

### V6. `bash experiments/electron-phase-0/lib/run-isolated.sh --label t5-llm -- experiments/electron-phase-0/services/llm.sh start`
- cwd: worktree 루트
- 기대: exit 0, 래퍼가 블로킹하지 않고 돌아온다
- 실제: exit 0, wall time 7.713s(구현자 보고 69초보다 짧음 — 모델이 이미 샌드박스 HF 캐시에 있어 `fetch-model` 단계가 0.3초 만에 끝남: `elapsed_seconds: 0.3`, `bytes: 5163524489`). pid 78727. `$SANDBOX/run/llm.pid`=78727 생성 확인. 기동 도중 `GET https://huggingface.co/api/models/mlx-community/Qwen3.5-4B-8bit/revision/main "HTTP/1.1 200 OK"` 네트워크 호출이 관측됨(캐시 존재 여부와 무관하게 revision 조회를 하는 것으로 보인다) — 모델 파일 자체의 재다운로드는 없었다(`elapsed_seconds: 0.3`).
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
run-isolated: label=t5-llm  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.jyDJTp/stderr.raw)
모델 준비: mlx-community/Qwen3.5-4B-8bit
  HF_HOME: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
  repo           : mlx-community/Qwen3.5-4B-8bit
  hf_home        : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
  snapshot_path  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface/hub/models--mlx-community--Qwen3.5-4B-8bit/snapshots/1704583a86670ba531b7f2c92530a2f725cfd45b
  files          : 10
  bytes          : 5163524489
  mib            : 4924.3
  elapsed_seconds: 0.3
  downloader     : mlx_lm.utils._download (mlx-lm이 서버에서 쓰는 경로)
기록: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-llm-model-fetch.txt
기동: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/mlx_lm.server
  모델   : mlx-community/Qwen3.5-4B-8bit
  포트   : 127.0.0.1:58000
  stderr : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/llm-stderr.txt (규칙 3b의 tee 사본)
  stdout : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/llm-stdout.txt
기록: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-llm-binpath.txt
  pid    : 78727
  cmdline: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/mlx_lm.server --model mlx-community/Qwen3.5-4B-8bit --chat-template-args {"enable_thinking": false} --host 127.0.0.1 --port 58000
준비됨: GET /v1/models 가 mlx-community/Qwen3.5-4B-8bit 을 낸다
/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/lib/python3.12/site-packages/mlx_lm/server.py:1723: UserWarning: mlx_lm.server is not recommended for production as it only implements basic security checks.
  warnings.warn(
2026-09-09 23:25:30,584 - INFO - Starting httpd at 127.0.0.1 on port 58000...
2026-09-09 23:25:30,805 - INFO - HTTP Request: GET https://huggingface.co/api/models/mlx-community/Qwen3.5-4B-8bit/revision/main "HTTP/1.1 200 OK"
Fetching 10 files:   0%|          | 0/10 [00:00<?, ?it/s]Fetching 10 files: 100%|██████████| 10/10 [00:00<00:00, 1146.92it/s]
127.0.0.1 - - [09/Sep/2026 23:25:31] "GET /v1/models HTTP/1.1" 200 -
bash experiments/electron-phase-0/lib/run-isolated.sh --label t5-llm --  star  2.59s user 0.75s system 43% cpu 7.713 total
```
</details>

### V7. `bash experiments/electron-phase-0/verify/t5-llm-models.sh`
- cwd: worktree 루트
- 기대: exit 0. `GET /v1/models` 응답에 `Qwen3.5-4B-8bit` 포함
- 실제: 모델 id 목록에 `mlx-community/Qwen3.5-4B-8bit` 포함, 포트 58000을 pid 78727(llm.pid)이 잡고 있음, 샌드박스 HF 캐시 디렉터리 존재 확인
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)
  llm: 살아 있음 (pid 78727)

== GET http://127.0.0.1:58000/v1/models
  모델 id:
    mlx-community/Qwen3.5-4B-8bit

  OK   mlx-community/Qwen3.5-4B-8bit 이 목록에 있다

== 포트 소유 확인 (개발 기본값 8000이 아니라 실험 포트 58000 인가)
  OK   58000 를 우리 PID 파일의 서버(pid 78727)가 잡고 있다

== 모델이 샌드박스 HF 캐시에 있는가 (개발자 홈이 아니다, 스펙 §4.4)
  OK   /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface/hub/models--mlx-community--Qwen3.5-4B-8bit

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-llm-models.txt
판정: 번들 mlx_lm.server가 58000 에서 mlx-community/Qwen3.5-4B-8bit 을 서빙 목록에 낸다
```
</details>

### V8. `bash experiments/electron-phase-0/verify/t5-llm-completion.sh`
- cwd: worktree 루트
- 기대: exit 0. `POST /v1/chat/completions`가 `choices` 1건을 반환
- 실제: `choices_count: 1`, `choices[0].content: 'ok'`, `finish_reason: stop`, 완료까지 2초(모델이 이미 메모리에 로드돼 있었을 가능성 — V6 기동 로그에는 로드 완료 표시가 없었고 이 요청에서 처음 로드된 것으로 스크립트 주석은 설명하나, 실측 경과 시간은 2초로 구현자가 보고한 것과 다른 상황(캐시 히트로 전체가 빠름)과 일관됨)
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 서비스 준비 (격리 래퍼를 통해서만 띄운다, 스펙 §4.2)
  llm: 살아 있음 (pid 78727)

== POST http://127.0.0.1:58000/v1/chat/completions
  요청: {"model":"mlx-community/Qwen3.5-4B-8bit","messages":[{"role":"user","content":"Reply with exactly one word: ok"}],"max_tokens":16,"temperature":0.0}
  (첫 요청이 모델 로드를 포함한다 — 수십 초 걸릴 수 있다)

  id: chatcmpl-c080e036-e383-4e5c-b08e-65e457864cae
  model: mlx-community/Qwen3.5-4B-8bit
  choices_count: 1
  choices[0].role: assistant
  choices[0].finish_reason: stop
  choices[0].content: 'ok'
  usage: {"completion_tokens": 2, "prompt_tokens": 19, "prompt_tokens_details": {"cached_tokens": 0}, "total_tokens": 21}

  OK   choices 1건
  OK   생성된 내용이 있다: 'ok'

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-llm-completion.txt
판정: 번들 mlx_lm.server가 mlx-community/Qwen3.5-4B-8bit 로 완성 응답 1건을 만들었다 (2s)
```
</details>

### V9. `bash experiments/electron-phase-0/verify/t5-llm-stop.sh`
- cwd: worktree 루트
- 기대: exit 0. SIGTERM 후 58000이 응답하지 않음
- 실제: SIGTERM 전송(pid 78727) → 1초 안에 종료 확인. `/v1/models` curl exit 7. 58000 LISTEN pid 없음. PID 파일 정리됨
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 종료 전 상태
  pid 78727, 58000 LISTEN: 78727

== llm.sh stop (PID 파일 대상 SIGTERM)
  SIGTERM: pid 78727
  종료 확인 (SIGTERM 1s 안에 내려갔다)

== 종료 후 확인
  OK   stop이 exit 0
  OK   pid 78727 가 SIGTERM에 내려갔다 (SIGKILL을 쓰지 않았다)
  OK   58000 가 더는 응답하지 않는다 (curl exit 7)
  OK   58000 를 LISTEN 하는 프로세스가 없다
  OK   PID 파일이 정리됐다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-llm-stop.txt
판정: mlx_lm.server가 SIGTERM에 내려가고 58000 가 비었다
```
</details>

### V10. `bash experiments/electron-phase-0/verify/t5-bundle-paths.sh`
- cwd: worktree 루트
- 기대: exit 0. `t5-llm-binpath.txt`가 `bundle/python` 하위 경로이고 `/Users/gim-yeongjae/.local`이 아니며, dyld 증거에 개발자 HF 캐시가 0건
- 실제: binpath가 `bundle/python/bin/mlx_lm.server`, 셔뱅이 `bundle/python/bin/python3.12`, argv 일치 확인. dyld 증거(embed 1617줄, llm 1802줄) 전부에서 개발자 HF 캐시·`~/.local`·`/opt/homebrew`·`Python.framework`·`/usr/local/lib`·`/usr/local/bin` 각 0건. 모델 2종 모두 샌드박스 HF 캐시 존재(bge-m3 4.3G, Qwen3.5-4B-8bit 4.8G)
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 1. llm.sh start가 실행한 바이너리 (스펙 P0-C5b)
  기록된 binary : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/mlx_lm.server
  셔뱅          : #!/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
  실제 cmdline  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/mlx_lm.server --model mlx-community/Qwen3.5-4B-8bit --chat-template-args {"enable_thinking": false} --host 127.0.0.1 --port 58000
  OK   bundle/python 하위다
  OK   개발자 홈의 ~/.local 설치본이 아니다
  OK   셔뱅이 번들 python이다 — /bin/sh 심이 아니라 dyld 실측이 산다
  OK   기동한 프로세스의 argv에 그 경로가 있다

== 2. dyld 증거의 ^dyld 줄에 개발 환경 경로가 있는가 (계획 규칙 6)
  t5-embed: ^dyld 줄 1617건
    OK   /Users/gim-yeongjae/.cache/huggingface: 0건
    OK   /Users/gim-yeongjae/.local/: 0건
    OK   /opt/homebrew: 0건
    OK   /Library/Frameworks/Python.framework: 0건
    OK   /usr/local/lib: 0건
    OK   /usr/local/bin: 0건
  t5-llm: ^dyld 줄 1802건
    OK   /Users/gim-yeongjae/.cache/huggingface: 0건
    OK   /Users/gim-yeongjae/.local/: 0건
    OK   /opt/homebrew: 0건
    OK   /Library/Frameworks/Python.framework: 0건
    OK   /usr/local/lib: 0건
    OK   /usr/local/bin: 0건

== 3. 모델이 샌드박스 HF 캐시에 있는가 (스펙 §4.4 — 개발자 캐시에 쓰지 않는다)
  샌드박스 HF_HOME : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
  OK   models--mlx-community--Qwen3.5-4B-8bit — 4.8G
  OK   models--BAAI--bge-m3 — 4.3G
  참고: 격리 래퍼가 주입한 HF_HOME은 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface 이다 (스펙 §4.2 표)

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-bundle-paths.txt
판정: 번들 안의 mlx_lm.server가 떴고, dyld 실측에 개발 환경 경로가 0건이다
```
</details>

### V11. `bash experiments/electron-phase-0/verify/t5-dyld-measured.sh`
- cwd: worktree 루트
- 기대: exit 0. `t5-embed-dyld.txt`·`t5-llm-dyld.txt` 각각 `^dyld` 줄에 한정해, 해당 PID 파일의 PID를 가진 `dyld[<pid>]` 줄이 존재하고 그 pid의 로드 목록에 `bundle/python` 하위 바이너리 경로가 실제로 있다. `MEASUREMENT_UNAVAILABLE`이 아니다
- 실제: embed pid 78210 — bundle/python/ 아래 202건 로드. llm pid 78727 — bundle/python/ 아래 187건 로드. 둘 다 연 이미지 전체가 번들/usr/lib/System/Library 안(FAIL 없음)
- 일치: 예
- 종료 코드: 0

**측정 대상 pid를 무엇으로 고정했는가 (코드 확인, 지시문 요구사항):** V5·V9가 stop을 실행해 PID 파일(`$SANDBOX/run/{embed,llm}.pid`)을 이미 지운 뒤에 V11이 실행되므로, `verify/t5-lib.sh::t5_measured_pid()`는 다음 순서로 pid를 찾는다.
1. `$SANDBOX/run/{embed,llm}.pid` 파일이 존재하면 그 안의 숫자를 쓴다.
2. 없으면(내 실행에서는 이 경로) `$SANDBOX/run/{embed,llm}-start.txt`의 `pid  : <N>` 줄에서 읽는다. 이 파일은 `services/{embed,llm}.sh`의 `cmd_start()`가 서버 프로세스를 `exec`한 직후 **같은 셸 변수(`srv_pid=$!`)로 PID 파일과 동시에** 써 두는 기동 기록이다(`exp_pid_write "$PIDNAME" "$srv_pid"` 직후 `$STARTREC`에 `pid : $srv_pid`를 기록). 즉 PID 파일이 사라져도 그 순간 함께 남긴 기록에서 같은 값을 복구한다.

내 실행에서 실제로 이 경로를 탔음을 V11 stdout이 명시한다 — `대상 pid : 78210 (출처: .../embed-start.txt (stop 뒤 — 런처가 PID 파일과 같이 남긴 기동 기록))`, `대상 pid : 78727 (출처: .../llm-start.txt (stop 뒤 — ...))`. `t5_measured_pid_source()`가 이 출처 문자열을 그대로 만든다.

- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== t5-embed — dyld 실측 판독 (계획 규칙 6 / 6b / 6c)
  증거 파일 : /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-embed-dyld.txt
  OK   MEASUREMENT_UNAVAILABLE 표시가 없다
  OK   ^dyld 줄 1617건 (헤더가 아니라 dyld 줄만 셌다)
  대상 pid  : 78210  (출처: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/embed-start.txt (stop 뒤 — 런처가 PID 파일과 같이 남긴 기동 기록))
  증거의 pid: 78210 78261 
  OK   pid 78210 이 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/ 아래 이미지를 202건 로드했다
       /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
       /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/lib/libpython3.12.dylib
       /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/lib/python3.12/site-packages/pydantic_core/_pydantic_core.cpython-312-darwin.so
  OK   pid 78210 이 연 이미지가 전부 번들 / usr/lib / System/Library 안이다

== t5-llm — dyld 실측 판독 (계획 규칙 6 / 6b / 6c)
  증거 파일 : /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-llm-dyld.txt
  OK   MEASUREMENT_UNAVAILABLE 표시가 없다
  OK   ^dyld 줄 1802건 (헤더가 아니라 dyld 줄만 셌다)
  대상 pid  : 78727  (출처: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/run/llm-start.txt (stop 뒤 — 런처가 PID 파일과 같이 남긴 기동 기록))
  증거의 pid: 78695 78727 
  OK   pid 78727 이 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/ 아래 이미지를 187건 로드했다
       /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
       /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/lib/libpython3.12.dylib
       /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/lib/python3.12/site-packages/mlx/core.cpython-312-darwin.so
  OK   pid 78727 이 연 이미지가 전부 번들 / usr/lib / System/Library 안이다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t5-dyld-measured.txt
판정: 두 서비스의 dyld 실측이 각자의 서버 프로세스 것이고, 번들 이미지를 로드했다
```
</details>

---

## 특별 확인 사항 (지시문 1~8)

### 1. 규칙 3b `tee` 형태가 실제로 동작하는가

| 항목 | `t5-embed-dyld.txt` | `t5-llm-dyld.txt` |
| --- | --- | --- |
| `^dyld` 줄 총수 | 1617 | 1802 |
| `MEASUREMENT_UNAVAILABLE` 여부 | 첫 줄은 `# run-isolated.sh dyld 실측` — `MEASUREMENT_UNAVAILABLE` 아님 | 동일, 아님 |
| `$SANDBOX/run/{embed,llm}-start.txt`의 pid | 78210 | 78727 |
| 그 pid의 `dyld[<pid>]:` 줄 수 | 915 (`grep -c '^dyld\[78210\]:'`) | 901 (`grep -c '^dyld\[78727\]:'`) |
| 그 pid의 줄 중 경로가 `bundle/python/` 하위인 것의 수 | 202 (V11 판정에 쓴 `t5_dyld_pid_loads_under` 결과와 동일) | 187 (동일) |
| `/usr/bin/tee`의 pid를 가진 dyld 줄이 있는가 | `grep -c '/usr/bin/tee' t5-embed-dyld.txt` → 0 | `grep -c '/usr/bin/tee' t5-llm-dyld.txt` → 0 |

두 파일의 고유 pid 집합은 각각 `{78210, 78261}`(embed), `{78695, 78727}`(llm)뿐이다 — `tee`에 해당하는 별도 pid 항목 자체가 나타나지 않는다(플랫폼 바이너리라 SIP가 `DYLD_*`를 지워 자기 dyld 줄을 만들지 않는다는 구현자 보고와 일치). 두 번째 pid(embed의 78261, llm의 78695)는 각각 `bundle/python/lib/libpython3.12.dylib`, `bundle/python/bin/python3.12`를 메인 이미지로 로드한 것으로 나타나며(아래 항목 2), tee가 아니라 번들 python이 만든 자식/포크 프로세스로 보인다 — 이 판단은 dyld 줄 내용을 근거로 한 추정이며 별도의 프로세스 트리 증거(`ps --ppid` 스냅샷 등)로 직접 확인하지는 못했다(서버가 이미 종료돼 재확인 불가).

### 2. 메인 이미지

`dyld[<pid>]:` 줄 중 필드가 3개(`NF==3`, 즉 `dyld[pid]: <UUID> <경로>` 형태)인 첫 줄을 그 pid의 메인 이미지로 보면:

- embed 서버 pid 78210의 첫 로드 줄: `dyld[78210]: <4C4C44A6-...> /Users/.../bundle/python/bin/python3.12`
- llm 서버 pid 78727의 첫 로드 줄: `dyld[78727]: <4C4C44A6-...> /Users/.../bundle/python/bin/python3.12` (같은 UUID — 같은 python3.12 바이너리)

둘 다 `bundle/python/bin/python3.12`다 — 구현자 보고와 일치.

### 3. `t5-llm-binpath.txt` 원문 전체

```
# Task 5 — llm.sh start 가 실제로 실행한 바이너리 (스펙 P0-C5b)
# utc: 2026-09-09T14:25:27Z
#
# 스펙 §2가 지목한 대로 mlx_lm.server 는 어떤 매니페스트에도 없고, 개발
# 절차는 uv tool 로 개발자 홈에 까는 것이다. 그래서 '번들 안의 실행
# 파일이 떴는가'가 이 기준의 본론이고 아래 경로가 그 답이다.

binary   : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/mlx_lm.server
shebang  : #!/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
pid      : 78727
cmdline  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/mlx_lm.server --model mlx-community/Qwen3.5-4B-8bit --chat-template-args {"enable_thinking": false} --host 127.0.0.1 --port 58000
bundle   : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python
model    : mlx-community/Qwen3.5-4B-8bit
hf_home  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/home/.cache/huggingface
endpoint : http://127.0.0.1:58000/v1
```

(이 파일은 내 실행의 V6가 새로 쓴 것이다. 구현자의 이전 실행 원문은 `t5-llm-binpath.prev-20260909T142527Z.txt`로 보존됐다.)

### 4. 개발자 자산 참조 0건 확인

`t5-embed-dyld.txt`·`t5-llm-dyld.txt`의 `^dyld` 줄에서 각 토큰의 건수 (V10 스크립트가 이미 이 판정을 수행했고, 아래는 그 결과를 재기재한 것):

| 토큰 | t5-embed | t5-llm |
| --- | --- | --- |
| `/Users/gim-yeongjae/.cache/huggingface` | 0 | 0 |
| `/Users/gim-yeongjae/.local` | 0 | 0 |
| `/opt/homebrew` | 0 | 0 |
| `/Library/Frameworks/Python.framework` | 0 | 0 |
| `/usr/local/lib` | 0 | 0 |
| `/usr/local/bin` | 0 | 0 |

### 5. 샌드박스 모델 캐시

`du -sh experiments/electron-phase-0/sandbox/home/.cache/huggingface` → **9.1G**

`hub/` 하위 저장소 목록(`ls`):
```
.locks
CACHEDIR.TAG
models--BAAI--bge-m3          (4.3G, du -sh)
models--mlx-community--Qwen3.5-4B-8bit   (4.8G, du -sh)
```

개발자 `~/.cache/huggingface`의 mtime: 디렉터리 자체 `Mon Jun 29 16:12:31 2026`, 하위 `hub/` 디렉터리 `Tue Aug 18 16:28:04 2026` — 둘 다 Task 5 실행 창(2026-09-09 23:23~23:26 KST / 14:23~14:26 UTC)보다 훨씬 이전이다. `find ~/.cache/huggingface -newermt "2026-09-09 23:20:00" -maxdepth 5`는 아무 결과도 내지 않았다 — 실행 창 안에서 개발자 HF 캐시에 어떤 파일도 새로 쓰이거나 갱신되지 않았다. (참고: `~/.cache/huggingface` 최상위에 `.agent_harnesses.json`이라는, huggingface와 무관해 보이는 파일이 있고 mtime이 `Wed Sep 9 22:14:14 2026`(로컬)로 내 실행 창보다 앞선다 — 이 파일의 존재나 갱신은 이 검증 실행이 만든 것이 아니다.)

### 6. 디스크

- V1(시작, `preflight.sh 10` 실행 시점) `df -g /System/Volumes/Data`: `Available 11` (GiB)
- 종료 시점(V11 이후) `df -g /System/Volumes/Data`:

```
Filesystem   1G-blocks Used Available Capacity iused     ifree %iused  Mounted on
/dev/disk3s5       460  414        13    97% 4463039 136350080    3%   /System/Volumes/Data
```

즉 시작 11 GiB → 종료 13 GiB (증가). 구현자 보고(21→11 GiB, 그 실행 안에서 모델을 새로 받으며 감소)와는 다른 수치다 — 내 실행 시작 시점이 이미 구현자 실행 종료 이후(모델이 이미 캐시에 있는 상태)였고, 내 실행에서는 모델을 새로 받지 않았으므로(V6 fetch-model `elapsed_seconds: 0.3`) 디스크가 줄지 않고 오히려 소폭 늘었다(다른 프로세스의 배경 작업 또는 측정 시점 차이로 보이며, 이 검증 실행이 원인이라고 판단할 근거는 없다).

### 7. V11의 1회차 실패 기록

`t5-dyld-measured.prev-20260909T141803Z.txt` (파일명의 타임스탬프 `20260909T141803Z`는 이 prev 파일이 회전되기 **직전**에 있던 구버전 판정의 UTC 시각으로 보이며, 파일 내부 헤더의 `utc:` 값은 `2026-09-09T14:17:11Z`다) 원문 요약:

- embed: 대상 pid 74049, `^dyld` 줄 1619건, 번들 아래 로드 203건(OK) — 그러나 **"서버가 번들·/usr/lib·/System/Library 밖에서 라이브러리를 로드했다"는 FAIL이 155건** 나열됨. 나열된 항목은 전부 경로가 없는 잎 이름(`AVFoundation`, `libtidy.A.dylib`, `CoreML`, `AppleNeuralEngine` 등)이다.
- llm: 대상 pid 75447, `^dyld` 줄 1803건, 번들 아래 로드 187건(OK) — 같은 형태로 **FAIL 155건**.
- 종합 `embed_rc=1`, `llm_rc=1`.

지시문이 설명한 대로, 이 잎 이름들은 `dyld[pid]: move loaded to delayed: <이름>` 형태의 줄에서 나온 것으로 판단된다 — `t5-lib.sh`의 주석이 정확히 이 두 가지 dyld 줄 모양(이미지 로드 줄 vs. `move loaded to delayed` 줄)을 설명하며, 예전 버전의 foreign-라이브러리 판정이 필드 수 제약 없이 `$NF`만 보고 두 형태를 구분하지 않아 "존재하지 않는 위반"을 만들어냈다고 적어 두었다. 현재의 `t5-lib.sh::t5_awk_load_line`(`NF==3 && $2 ~ /^</ && $3`가 `/`로 시작)은 이 두 번째 형태를 걸러내며, 내가 실행한 V11(위 본문)에서는 이 FAIL 목록이 나타나지 않았다(embed·llm 둘 다 "연 이미지가 전부 번들/usr/lib/System/Library 안" OK).

### 8. `t2-dyld-measured.sh`의 같은 결함 여부

- `t2-dyld-measured.sh` 자체의 "번들 밖 라이브러리" 판정부는 다음 형태다(코드 확인):
  ```awk
  awk -v p="dyld[$PID]:" -v d="$BUNDLE_PG/" '
    $1 == p {
      img = $NF
      if (index(img, d) == 1) next
      if (index(img, "/usr/lib/") == 1) next
      if (index(img, "/System/Library/") == 1) next
      print img
    }' "$DY" | sort -u
  ```
  필드 수 제약 없이 `$NF`(마지막 필드)만 보고 판정한다 — t5-lib.sh가 고친 `NF==3 && $2 ~ /^</`류의 형태 구분이 없다. `t2_dyld_pid_loads_under`/`t2_dyld_pid_loads_exact`(t2-lib.sh)도 동일하게 `$NF` 기반이다.
- `t2-start-dyld.txt`에서 `move loaded to delayed`를 포함하는 줄의 수: `grep -c "move loaded to delayed" t2-start-dyld.txt` → **0**.

즉 코드 구조상 t5의 예전 버전과 같은 잠재 결함이 t2-dyld-measured.sh에도 있으나(`$NF` 전용, 두 dyld 줄 모양 미구분), t2-start-dyld.txt(postgres의 dyld 로그)에는 `move loaded to delayed` 형태의 줄이 0건이라 이 결함이 현재는 드러나지 않는다는 구현자 보고와 실측이 일치한다.

---

## 종료 시점 상태

- 포트 58000·58100·55432: `lsof -i :58000 -i :58100 -i :55432` → 무응답(exit 1, 즉 free 3개 전부)
- `ps aux | grep -E "mlx_lm|embed_service|damwha-embed|python3.12.*bundle"` → 출력 없음
- `$SANDBOX/run/*.pid` → 파일 없음 (`no matches found`)
- `git status --porcelain` (저장소 전체, 워크트리 루트):

```
 M docs/superpowers/reports/evidence/phase-0/t5-bundle-paths.txt
 M docs/superpowers/reports/evidence/phase-0/t5-dyld-measured.txt
 M docs/superpowers/reports/evidence/phase-0/t5-embed-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t5-embed-env.txt
 M docs/superpowers/reports/evidence/phase-0/t5-embed-health.txt
 M docs/superpowers/reports/evidence/phase-0/t5-embed-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t5-embed-stop.txt
 M docs/superpowers/reports/evidence/phase-0/t5-embed-vector.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-binpath.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-completion.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-env.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-model-fetch.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-models.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t5-llm-stop.txt
?? docs/superpowers/reports/evidence/phase-0/t5-bundle-paths.prev-20260909T142546Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-dyld-measured.prev-20260909T142549Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-embed-dyld.prev-20260909T142501Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-embed-env.prev-20260909T142501Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-embed-health.prev-20260909T142511Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-embed-stderr.prev-20260909T142501Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-embed-stop.prev-20260909T142518Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-embed-vector.prev-20260909T142513Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-binpath.prev-20260909T142527Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-completion.prev-20260909T142538Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-dyld.prev-20260909T142531Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-env.prev-20260909T142531Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-model-fetch.prev-20260909T142527Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-models.prev-20260909T142535Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-stderr.prev-20260909T142531Z.txt
?? docs/superpowers/reports/evidence/phase-0/t5-llm-stop.prev-20260909T142542Z.txt
```

(이 diff는 전부 `$EVIDENCE` 아래 `.txt`/`.prev-*.txt` 파일이다 — 이 Task의 verify 스크립트들이 생성/회전한 증거 자체이며, 소스·설정·계획 문서는 건드리지 않았다. 이 파일이 `git status`에 나타나는 것은 이 저장소가 증거 파일을 커밋 대상으로 추적하기 때문이다 — 계획 §"증거 파일명" 규칙대로 회전됐고 `> "$OUT"`로 덮어쓴 파일은 없다.)
- `git rev-parse HEAD` (종료 시점 재확인): `f840679f1465cf03124002335a7528ef62cae3b6` — 시작 시점과 동일, 변경 없음.

## 프로세스 정리

- 기동 전 (V2 실행 직전): `ps aux | grep -E "mlx_lm|embed_service|uvicorn"` → 출력 없음. 포트 55432·58000·58100 전부 free.
- V2가 embed(pid 78210)를 띄우고, V5(`t5-embed-stop.sh`)가 SIGTERM으로 내렸다 — 내가 직접 `kill`을 호출하지 않았고, `embed.sh stop`이 PID 파일 대상으로만 신호를 보냈다.
- V6가 llm(pid 78727)을 띄우고, V9(`t5-llm-stop.sh`)가 SIGTERM으로 내렸다 — 마찬가지로 `llm.sh stop`이 PID 파일 대상으로만 신호를 보냈다.
- 종료 후: `ps aux | grep -E "mlx_lm|embed_service|damwha-embed|python3.12.*bundle"` → 출력 없음. `lsof -i :58000 -i :58100 -i :55432` → 무응답(전부 free). `$SANDBOX/run/*.pid` 없음.
- `pkill`·`killall`은 이 실행 전체에서 한 번도 쓰지 않았다.
