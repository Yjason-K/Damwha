# Damwha 백엔드 — Worker subprocess-per-job 메모리 격리 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-07-09 · 대상: `worker/` (Python ML 워커)
> 선행: Plan 2 (Python ML 워커, 완료), Worker 운영 안정성 3건(`2026-07-09-worker-ops-resilience-design.md`)
> 배경: 16GB Apple Silicon Mac에서 장수 워커 프로세스가 job 간 MPS(GPU) 메모리를 누적해 OOM으로 실패. 선택안: B(subprocess-per-job 격리).

---

## 0. 이 문서의 범위

워커의 **프로세스 모델**을 "장수 폴 루프 1개"에서 "supervisor 부모 + job당 자식 프로세스 1개"로 바꾼다. **job payload 계약(zod/pydantic), DB 스키마, NestJS `src/`는 변경하지 않는다** — 워커 내부 + 워커 테스트만.

**운영 형태 전제:** 단일 Mac, job **직렬** 처리(동시성 없음). 목표는 처리량이 아니라 **메모리 누적 없이 절대 OOM 안 나기**(안정성 우선).

**범위 밖:** 병렬 job 실행, 처리량 최적화, timed backoff(`next_attempt_at`), 외부 supervisor(launchd/systemd) 연동.

---

## 1. 근본 원인

관측된 실패 로그(요약):

```
job=job_6 meeting=mtg_3 index_meeting start
stage=embed done elapsed_ms=1105          # timed_stage는 finally로 무조건 "done" 기록 → 성공 아님
RuntimeError('MPS backend out of memory (MPS allocated: 4.01 GiB,
             other allocations: 15.31 GiB, max allowed: 20.13 GiB).
             Tried to allocate 1001.28 MiB on shared pool.')
job job_6 type=index_meeting failed: code=uncategorized kind=TRANSIENT attempt=3/3 → failed
```

로그 해석:

- `timed_stage`(`pipeline/timing.py`)는 `finally`에서 "stage done"을 무조건 남긴다 → "embed done"은 성공을 의미하지 않는다. `detail`이 비어 있으므로(`index_meeting.py`가 `embed_texts` **후**에 detail 설정) 예외는 `text_embedder.embed_texts` **도중** 발생.
- torch OOM 메시지의 두 항목은 주체가 다르다: `MPS allocated: 4.01 GiB` = **torch 자기 얼로케이터**(여기선 BGE-M3 본체), `other allocations: 15.31 GiB` = **프로세스 내 torch 바깥 GPU 메모리**. index_meeting은 이만한 GPU 메모리를 만들 수 없다 → **직전 `process_meeting` job의 mlx-whisper 잔재**. `mlx_whisper.transcribe()`는 모듈 전역 `ModelHolder`에 모델을 캐시하고 MLX 버퍼 캐시는 기본 무제한이다.

**근본 원인(2겹):**

1. **주범 — job 간 GPU 메모리 누적, 대부분 MLX.** 모델은 job마다 빌드(`handle_job`의 `build_models()`/`build_text_embedder()`)되지만, 정리 코드가 전무하다: `del`/`gc.collect()`/`torch.mps.empty_cache()` 없음. 장수 프로세스라 직전 job의 GPU 메모리가 다음 job까지 상주한다. 잔재의 주체는 **MLX(mlx-whisper의 전역 `ModelHolder` + 무제한 버퍼 캐시)이고 torch는 일부**다 — `torch.mps.empty_cache()`를 넣었어도 torch 몫(~4GB)만 회수되고 MLX 15GB는 그대로 남는다.
2. **부차 — BGE-M3가 MPS에서 실행.** `bge_embed.py`가 `SentenceTransformer(model_name)`에 device 미지정 → Apple Silicon에서 MPS 자동 선택. weights ~4GB + 활성화가 잔재 위에 얹혀 한계 초과.

**별건(선택) — OOM 오분류.** MPS OOM은 `RuntimeError`라 `errors.classify`의 `isinstance(exc, MemoryError)`에 안 걸려 `uncategorized` TRANSIENT로 분류. 아래 §7 참조. 이 설계로 OOM 자체가 사라지므로 필수는 아니다.

---

## 2. 선택안과 근거

| 안 | 요지 | 판정 |
|---|---|---|
| A. in-process 정리 | job 경계에서 `del`+`gc.collect()`+`torch.mps.empty_cache()` | 잔재 주범이 **MLX 전역 캐시**라 `torch.mps.empty_cache()`로는 대부분 안 풀림. MLX 전역 캐시 해제는 **공개 API가 없어** private 내부(`ModelHolder`) 찌르기가 필요 → 취약·비권장 |
| **B. subprocess-per-job 격리** | 각 job을 자식 프로세스에서 실행, job 끝나면 프로세스 종료 → OS가 메모리 100% 회수 | **채택.** MLX/torch 누수 원인·API 몰라도 무관, 완벽 격리 |
| C. 모델 종류별 전용 워커 | process_meeting/index_meeting 워커 분리 | 주범(process_meeting 잔재)은 그 워커에서 여전히 누적 → 부분해결. 비채택 |

A는 잔재가 torch 몫이면 경량으로 통했겠지만, 실제 주범은 MLX 전역 캐시(공개 해제 API 없음)라 in-process 정리로는 확실히 못 지운다. B는 OS 프로세스 종료로 MLX·torch 무관하게 확실히 회수한다.

---

## 3. 구조

```
부모 (supervisor) — 가벼움, torch/pyannote import 안 함
  conn = peek 전용 커넥션 (기존 _reconnect 재사용)
  while not shutdown:
    peek: SELECT 1 FROM job WHERE status='queued' LIMIT 1
      없으면 → shutdown.wait(poll_interval)
      있으면 → child = spawn: [sys.executable, "-m", "damwha_worker", "--once"]
               (start_new_session=True)
               부모는 child 종료까지 대기
               exit code로 분기 (§5)

자식 (--once) — job 정확히 1건
  자체 시그널 핸들러 설치 → 자체 DB 커넥션 → claim → heartbeat → dispatch → exit
  handle_job / run_once / Heartbeat 경로 그대로 재사용 (무변경)
```

**직렬 1개 보장:** 부모가 자식 하나를 띄우고 종료를 기다린 뒤에야 다음 peek → 동시 실행 0.

**메모리:** 자식 exit = OS가 MPS 포함 전 메모리 100% 회수.

---

## 4. 기동 방식 결정

- **`subprocess.Popen([sys.executable, "-m", "damwha_worker", "--once"], start_new_session=True)`**, `multiprocessing` 아님.
  - 완전 새 인터프리터 = import 격리 확실.
  - job 데이터 pickle 전달 불필요(자식이 스스로 claim).
  - `sys.executable`로 uv venv 인터프리터 보장 — 리터럴 `"python"` 금지.
  - `start_new_session=True`로 자식을 새 세션 리더로 → 터미널 시그널이 자식에 직접 가지 않음(§6).
  - **stdout/stderr는 Popen 기본(부모 상속)을 의도적으로 쓴다** — 로그 스트림이 부모와 단일화된다. `capture_output` 등으로 감싸면 자식 로그가 유실되므로 금지.
- **`--once` 파싱은 argparse가 아니라 `sys.argv` 직접 검사.** argparse는 사용법 오류 시 `sys.exit(2)`를 내는데, 이는 §5의 no-job(3)과 겹치지 않도록 argparse의 exit 2 자체를 피하려는 것 — 잘못된 인자가 "정상 no-job"으로 오인되면 안 된다.
- **`--once` 서브커맨드 신설.** 현 `main()`을 둘로 분리:
  - `main()` = 부모 supervisor 루프.
  - `run_single_job()` = 자식 진입점. 현 `main()`의 conn 열기 + `_dispatch`(heartbeat 주입)를 `run_loop` 대신 **1회 claim+dispatch**로 실행 후 반환.
  - `handle_job` / `run_once` / `Heartbeat` / `dispatch_claimed_job`는 **변경하지 않는다** → 기존 job-처리 테스트 스위트 그대로 유효.

---

## 5. exit code 계약 + hot-loop 보호 (필수)

**문제:** 자식이 **claim 전에** 결정적 오류로 죽으면(import 실패, 모델 로드 실패, 설정 오류) — `attempts`는 claim 시점에만 증가하므로 job은 `queued` 그대로, `attempts` 불변. reaper는 `running`만 회수하므로 못 잡는다. 부모 peek는 계속 같은 queued job을 봐서 **무한 spawn**한다. import 5–10초가 자연 스로틀이지만 영원히 돈다.

**해법 — 자식 exit code 계약:**

| exit code | 의미 | 부모 동작 |
|---|---|---|
| `0` | 처리 완료 (성공 / 정상 fail / requeue / shutdown requeue) | 즉시 다음 peek |
| `3` | no job (peek→claim 사이 TOCTOU, 자식 claim이 None) | `poll_interval` sleep |
| 그 외 (`2` 포함) | 크래시 | `poll_interval` sleep **+ 연속 실패 카운터로 capped backoff + WARNING** |

no-job을 **3**으로 둔 이유: argparse·인터프리터 사용법 오류의 관례적 코드가 `2`라, no-job을 2로 두면 결정적 기동 오류가 "정상 no-job"으로 오인돼 §5의 hot-loop 보호를 우회한다. 2는 크래시 분기로 흡수한다.

- claim **후** 크래시: `attempts`가 올라가 있어 reaper가 소진 시 job을 fail 처리 → peek가 queued를 못 봄 → 자연 종료.
- claim **전** 크래시: job이 계속 queued → backoff가 spawn을 스로틀(운영자는 WARNING 로그로 인지). 결정적 오류를 조용히 무한 반복하지 않는다.

`run_single_job()`은 이 계약에 맞춰 exit code를 반환한다(claim None → 3, 정상 처리 → 0, 미포착 예외는 자연 전파 → nonzero).

---

## 6. Shutdown (필수)

- **`start_new_session=True`(그룹 분리) + 부모의 명시적 전달**을 채택.
  - 자식이 새 세션 리더이므로 터미널 Ctrl+C(SIGINT 프로세스 그룹 전파)가 자식에 직접 가지 않는다 → 부모만 수신.
  - 부모 1차 SIGINT/SIGTERM → 자식에 `SIGTERM` 전달 → 자식의 **기존 stage-boundary graceful shutdown**(`ShutdownRequested` → `requeue_for_shutdown`)이 그대로 동작 → 부모는 자식 종료 후 반환.
  - 부모 2차 시그널 → 자식 `SIGKILL` + 부모 즉시 종료.
- 자식(`run_single_job`)은 진입 시 **기존 `_on_signal` 핸들러를 자체 설치**한다(현 `main()`이 하던 것을 자식으로 이동).
- 대안(그룹 분리 없이 SIGINT 그룹 전파에 의존)은 자식이 1차에 시그널 2개를 받아 시맨틱이 우연에 기댄다 → 비채택.
- **shutdown 중 returncode 오분류 방지:** 부모가 SIGTERM을 보낸 뒤 자식이 핸들러 설치 전(torch import 중)이면 자식은 `-SIGTERM`으로 즉사해 nonzero를 반환한다. 부모는 **shutdown flag가 set이면 자식 nonzero를 §5 크래시 분기로 태우지 않는다**(정상 종료 중 WARNING+backoff 로깅 방지). 이 창구간은 claim 전이라 job은 queued 그대로 — 데이터는 무해, 로깅만 문제.
- **부모 SIGKILL 시 고아 자식:** `start_new_session=True`라 부모가 `-9`로 죽으면 자식은 살아서 job을 마저 처리한다(무해). 운영자가 워커가 죽은 줄 알고 새 supervisor를 띄우면 일시적으로 2개가 동시 실행될 수 있으나, 정합성은 ownership guard(job 소유권 + meeting pv 가드)가 이미 보장하므로 수용한다.

---

## 7. 크래시 복구

자식 비정상 exit → job `running` 잔류(claim 후) 또는 `queued` 잔류(claim 전). 이는 **현재 프로세스 급사와 동일 경로**다:

- claim 후: reaper가 stale `running`을 감지해 requeue(attempts 남음) / fail(소진).
- claim 전: §5 backoff가 스로틀.

자식 내부의 정상 예외는 이미 `handle_job`이 requeue/fail로 처리한다. 추가 배선 없음.

---

## 8. `run_loop` 제거 (필수)

`main()`이 supervisor가 되면 `run_loop`(재접속 + in-flight requeue, 본 브랜치 `2026-07-09-worker-ops-resilience`에서 추가)는 프로덕션 미사용 dead code가 된다. 자식은 1회 실행이라 `run_loop`를 쓰지 않는다.

- `run_loop`와 in-flight requeue 로직을 **제거**한다.
- DB 재접속 책임은 **부모 peek 루프**로 이식한다(`_reconnect` 재사용): peek가 raise하면 커넥션 close → `_reconnect` → 계속.
- 자식 내 DB 끊김은 별도 재접속이 불필요하다 — `handle_job`의 requeue/fail이 실패하면 자식이 크래시(nonzero)하고 reaper가 복구한다.

**ops-resilience 설계와의 관계:** 그 문서의 항목 1(메인 루프 DB 재접속)·항목 3(graceful shutdown)은 본 설계가 supervisor 구조로 재편해 흡수한다. 항목 2(heartbeat 재접속)는 자식 안에서 그대로 유효하므로 변경하지 않는다.

---

## 9. 보조 수정 (B와 독립)

- **BGE-M3 CPU 강제** — `bge_embed.py`: `SentenceTransformer(model_name, device="cpu")`. 색인은 백그라운드 job이라 CPU 지연이 무해하고, MPS 경쟁을 원천 회피(ECAPA가 `ecapa_embed.py`에서 CPU 강제하는 것과 동일한 근거).
- **mlx active 메모리 상한** — job **내부** 피크(mlx-whisper 캐시의 무한 성장)를 억제하는 보험. subprocess 격리는 job **간** 누적만 막고, 단독 `process_meeting`이 16GB에서 아슬한 경우는 못 막는다.
  - 목적이 active 피크 억제이면 `mx.set_memory_limit`이 직접적이다(`mx.set_cache_limit`은 idle 캐시 상한). 역할 구분을 인지하고 선택한다.
  - mlx 0.31.2(락파일 기준) top-level API(`mx.set_cache_limit`/`mx.set_memory_limit`; 구 `mx.metal.*`는 deprecated)를 **구현 시 설치본에서 정확한 시그니처 확인**. `whisper_mlx.py`의 `transcribe` 진입 또는 자식 기동 시 설정(프로세스 전역).

---

## 10. 테스트 전략

- **supervisor 결정적 테스트:** 자식 spawn 커맨드를 **주입 가능**하게 설계한다. 실제 ML 자식 대신 stub 스크립트(즉시 `exit 0` / `exit 3` / `exit 2` / `exit 1` / 시그널 대기)를 spawn해 다음을 검증:
  - exit code별 부모 분기(§5): 0→즉시 재peek, 3→sleep, 그 외(2 포함)→backoff.
  - 연속 크래시 시 capped backoff.
  - shutdown 전달: 부모 시그널 → 자식 SIGTERM → 종료; 2차 → SIGKILL. shutdown flag set 중 자식 nonzero는 크래시 취급 안 함(§6).
  - peek raise 시 `_reconnect`로 생존.
- **자식 경로 테스트:** 기존 job-처리 스위트(`handle_job`/`run_once`/persist 가드/heartbeat, testcontainers Postgres + fake 모델)는 그대로 유효 — `run_single_job`이 동일 경로를 재사용하므로.
- **제거되는 테스트:** `test_worker_loop.py`의 `run_loop`(재접속·in-flight requeue) 검증은 dead code 테스트가 되므로 supervisor 테스트로 **재작성**한다.

---

## 11. 문서 갱신

- `docs/worker-architecture.md`: "resilient poll loop" 서술을 "supervisor 부모 + job당 자식" 프로세스 모델로 갱신.
- `worker/SMOKE.md`: 실행 커맨드(`python -m damwha_worker`)가 supervisor를 띄우고 job당 자식을 spawn한다는 점 반영.

---

## 12. 선택 항목 — OOM 분류 정정

이 설계로 OOM은 사라지지만, 방어적으로 `errors.classify`가 MPS/CUDA OOM `RuntimeError`(메시지 `"out of memory"`)를 `oom` 코드로 인식하도록 추가할 수 있다. 미래의 GPU OOM이 `uncategorized`가 아니라 `oom`으로 기록된다. 필수 아님.
