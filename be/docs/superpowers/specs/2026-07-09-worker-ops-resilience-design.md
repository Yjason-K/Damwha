# Damwha 백엔드 — Worker 운영 안정성 3건 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-07-09 · 대상: `worker/` (Python ML 워커)
> 선행: Plan 2 (Python ML 워커, 완료), 정확도 수정 2건(`2026-07-09-worker-accuracy-fixes-design.md`, 완료)
> 배경: 워커 비판적 검토에서 발견된 운영 결함 3건(검토 항목 2·3·6)의 수정 설계. 선택안: A(국소 수정).

---

## 0. 이 문서의 범위

워커 프로세스의 생존성·종료 품질을 고친다. **job payload 계약(zod/pydantic), DB 스키마, NestJS `src/`는 변경하지 않는다** — 워커 내부 + 워커 테스트만.

1. **메인 루프가 DB 장애 한 번에 죽음** — `__main__.py` `while True`에 예외 처리 없음. DB 재시작/커넥션 drop 시 `db.claim`이 raise → 프로세스 종료. job 실패 후 `db.requeue`/`fail_*` 호출이 죽은 커넥션에서 raise해도 동일. 커넥션은 시작 시 1회 생성, 재접속 없음.
2. **heartbeat 스레드: connect 실패 시 조용히 사망** — `heartbeat.py` `_run`의 `db.connect`가 try 밖. 연결 실패 → 데몬 스레드 즉사 → beat 0회 → 살아있는 job이 reaper에 회수됨(정합성은 소유권 가드가 지키지만 ML 연산 통째로 낭비).
3. **graceful shutdown 없음** — SIGTERM/Ctrl-C 시 job이 `running` 방치 → reaper 회수까지 대기(stale window 기본 30분 `REAPER_STALE_MINUTES` + 최대 5분 cron tick).

**범위 밖:** 모델 캐싱, 배치 INSERT, timed backoff(`next_attempt_at`), 프로세스 supervisor(launchd/systemd) 연동.

**부수 효과(의도됨):** 루프 재구조화로 "job 완료 후에도 poll_interval sleep" 문제가 자연 해소된다 — 큐가 빌 때만 대기한다.

---

## 1. Heartbeat 재시도 (`heartbeat.py`)

`_run`을 재접속 루프로 바꾼다. 스레드는 `stop` 전까지 절대 종료하지 않는다.

```python
def _run(self) -> None:
    conn = None
    try:
        while not self._stop.is_set():
            if conn is None:
                try:
                    conn = db.connect(self._url)
                except Exception:
                    log.warning("heartbeat connect failed for job %s (retry in %ss)",
                                self._job_id, self._interval, exc_info=True)
                    if self._stop.wait(self._interval):
                        break
                    continue
            if self._stop.wait(self._interval):
                break
            try:
                db.heartbeat(conn, self._job_id, self._worker_id)
            except Exception:
                log.warning("heartbeat failed for job %s (reconnect next interval)",
                            self._job_id, exc_info=True)
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None
    finally:
        if conn is not None:
            conn.close()
```

- 최초 connect 실패 → interval 후 재시도(기존: 스레드 사망).
- beat 실패 → 커넥션 폐기 후 다음 interval에 재접속(기존: 같은 커넥션으로 재시도 — 죽은 커넥션이면 영원히 실패).
- 첫 beat가 interval 하나 뒤인 것은 기존과 동일. `__enter__`/`__exit__`/daemon 인터페이스 불변.

---

## 2. 메인 루프 복원력 + graceful shutdown (`__main__.py`)

### 2.1 시그널 → shutdown 이벤트

`main()`에서:

```python
shutdown = threading.Event()

def _on_signal(signum, frame):
    log.info("signal %s received — will stop at next stage boundary (send again to force)", signum)
    shutdown.set()
    signal.signal(signum, signal.SIG_DFL)  # 2차 시그널 = 기본 동작(즉시 종료)

for sig in (signal.SIGINT, signal.SIGTERM):
    signal.signal(sig, _on_signal)
```

**초기 연결도 `_reconnect` 경유** — 워커 시작 시점에 Postgres가 잠깐 내려가 있어도 죽지 않는다. `main()` 배선 순서: 시그널 핸들러 설치 → `conn = _reconnect(lambda: db.connect(settings.database_url), shutdown)` → `conn is None`(연결 전 shutdown)이면 즉시 종료 → `run_loop(...)`. `main()`에서 `db.connect`를 직접 호출하는 코드는 남기지 않는다.

### 2.2 루프 추출 — `run_loop`

`main()`의 `while True`를 테스트 가능한 함수로 추출한다. `main()`은 실제 의존성만 배선한다.

```python
def run_loop(conn, settings, storage, shutdown, *, connect_fn, dispatch_fn) -> None:
    """폴 루프: claim → dispatch. 어떤 예외에도 죽지 않는다 — 재접속 후 계속.

    connect_fn: () -> Connection (재접속용)
    dispatch_fn: (conn, job) -> str (실서비스: dispatch_claimed_job 래퍼)
    """
    job = None  # 현재 in-flight job (예외 시 requeue 대상)
    while not shutdown.is_set():
        try:
            job = db.claim(conn, settings.worker_id)
            if job is None:
                shutdown.wait(settings.poll_interval_seconds)
                continue
            outcome = dispatch_fn(conn, job)
            log.info("job %s type=%s → %s", job["id"], job["type"], outcome)
            job = None  # 정상 처리 완료 — 큐에 남은 job 즉시 재claim (sleep 없음)
        except Exception:
            log.exception("worker loop error — reconnecting")
            try:
                conn.close()
            except Exception:
                pass
            conn = _reconnect(connect_fn, shutdown)
            if conn is None:
                break  # 재접속 중 shutdown
            if job is not None:
                # in-flight job을 reaper 대기 없이 즉시 반환 시도 — 단, attempts가
                # 남아 있을 때만. 소진된 job을 requeue하면 claim이 attempts를 필터하지
                # 않으므로 결정적 오류를 무한 재claim하게 된다. 소진 시 running으로
                # 남겨 reaper가 fail + meeting/speaker 전파를 수행하게 한다(기존 로직 재사용).
                if job["attempts"] < job["max_attempts"]:
                    try:
                        db.requeue(conn, job["id"], settings.worker_id)
                    except Exception:
                        log.warning("in-flight requeue failed — reaper will recover job %s", job["id"])
                else:
                    log.warning("job %s attempts exhausted — leaving for reaper", job["id"])
                job = None
            # 반복 오류 hot-loop 방지: 어떤 outer 예외든 다음 시도 전 poll 간격만큼 쉰다
            if shutdown.wait(settings.poll_interval_seconds):
                break


def _reconnect(connect_fn, shutdown) -> "Connection | None":
    """capped 지수 backoff(1→2→4→8→16→30초)로 재접속. shutdown 시 None."""
    delay = 1.0
    while not shutdown.is_set():
        try:
            return connect_fn()
        except Exception:
            log.warning("reconnect failed — retry in %.0fs", delay, exc_info=True)
            if shutdown.wait(delay):
                break
            delay = min(delay * 2, 30.0)
    return None
```

- `handle_job` 내부는 불변 — 거기서 새어 나온 DB 예외(예: 실패 처리 중 커넥션 사망)도 이 외곽 except가 잡는다.
- **커넥션 소유권**: `run_loop`가 자기 커넥션의 수명을 책임진다 — 정상 종료(shutdown) 시에도 마지막 커넥션을 close하고 반환한다.
- backoff는 `_reconnect` 호출마다 1초부터 다시 시작(재접속 성공 = 리셋).
- 유휴 대기·backoff 대기 모두 `shutdown.wait(...)` — 시그널에 즉시 반응.

### 2.3 stage 경계 shutdown 개입

- **신규 예외** `errors.ShutdownRequested(Exception)` — `WorkerError`와 무관한 제어 흐름 예외(분류 대상 아님).
- **공용 stage 헬퍼** `pipeline/stage.py` 신설:

```python
def enter_stage(conn, job_id, worker_id, stage, progress, shutdown_event=None) -> None:
    """shutdown 확인 + guarded set_stage. 세 파이프라인 공통 진입점.

    - shutdown_event가 set이면 ShutdownRequested.
    - set_stage 0-row(소유권 상실)면 WorkerError('lost_ownership', ..., TRANSIENT).
    """
    if shutdown_event is not None and shutdown_event.is_set():
        raise ShutdownRequested(f"shutdown requested before stage {stage}")
    if db.set_stage(conn, job_id, worker_id, stage, progress) == 0:
        raise WorkerError("lost_ownership", f"lock lost at {stage}", ErrorKind.TRANSIENT, stage=stage)
```

  기존 `process_meeting._stage`는 이 헬퍼로 대체한다. **enroll/index도 동일 헬퍼 사용** — 현재 둘은 `db.set_stage` 반환값을 무시해 소유권을 잃어도 persist까지 헛연산하는 비일관이 있었는데(검토 항목 7), 이 기회에 세 파이프라인 모두 "shutdown 확인 + 소유권 가드"로 통일한다(정합성은 여전히 persist 가드가 최종 방어).
- `run_process_meeting`/`run_enroll_speaker`/`run_index_meeting`에 `shutdown_event: threading.Event | None = None` 키워드 파라미터 추가. 확인 지점:
  - process_meeting: **normalize 진입 전 1곳**(stage enum에 normalize가 없어 `enter_stage` 대신 shutdown 확인만 — ffmpeg가 긴 파일에서 수 분 걸릴 수 있으므로 제외 불가) + vad/diarize/identify/stt/align/persist 진입 6곳(`enter_stage`). normalize 직후는 vad 진입 확인이 커버.
  - enroll: extract_embedding/enroll_persist 진입 2곳.
  - index: embed 진입 1곳(이후는 짧은 persist뿐).
  - persist 트랜잭션 자체에는 개입하지 않는다(짧은 TX).
- `handle_job`: 일반 분류보다 **먼저** catch:

```python
except ShutdownRequested:
    ok = db.requeue_for_shutdown(conn, job["id"], worker_id)
    return "requeued_shutdown" if ok else "lost"
```

- meeting/speaker 상태는 건드리지 않는다 — `processing` 유지, 재claim한 워커가 이어서 처리(mark_processing은 멱등 가드).
- `dispatch_claimed_job`이 `shutdown_event`를 `handle_job`으로, `handle_job`이 각 `run_*`으로 전달.

### 2.4 attempts 미소모 requeue (`db.py` 신규)

shutdown은 job의 잘못이 아니다 — claim이 올린 attempts를 되돌린다:

```python
def requeue_for_shutdown(conn, job_id: str, worker_id: str) -> int:
    cur = conn.execute(
        """
        UPDATE job SET status='queued', locked_by=NULL, locked_at=NULL,
               attempts = greatest(attempts - 1, 0), updated_at=now()
        WHERE id=%s AND locked_by=%s AND status='running'
        """,
        (job_id, worker_id),
    )
    return cur.rowcount
```

claim(+1) → shutdown requeue(−1) → 재claim(+1): 순 소모 0. 소유권 가드는 기존 `requeue`와 동일. 스키마 변경 없음(UPDATE뿐).

---

## 3. 의미론 요약

| 상황 | 동작 |
|---|---|
| DB 장애(유휴 중) | 루프가 backoff 재접속 후 계속. 프로세스 생존. |
| DB 장애(job 처리 중) | 예외 → 재접속 → attempts 남았으면 in-flight job requeue 1회 시도(실패해도 reaper가 회수), 소진이면 running으로 남겨 reaper가 fail+전파 → poll 간격 대기 → 계속(반복 오류도 rate-bound). |
| heartbeat connect/beat 실패 | 스레드 생존, interval마다 재접속·재시도. |
| SIGINT/SIGTERM(유휴) | `shutdown.wait` 즉시 탈출 → 루프 종료. |
| SIGINT/SIGTERM(job 처리 중) | 다음 stage 진입 시 `ShutdownRequested` → `requeue_for_shutdown`(attempts 미소모) → 루프 종료. 최대 대기 = 현재 stage 길이. |
| 2차 시그널 | 기본 동작 — 즉시 강제 종료(job은 reaper가 회수). |

---

## 4. 테스트

기존 패턴: fake + testcontainers Postgres, 실모델 없음. `main()`/시그널 배선은 `# pragma: no cover` 유지 — 추출된 `run_loop`/`_reconnect`와 파이프라인/handle_job 경로를 테스트한다.

- **heartbeat** (`tests/test_heartbeat.py`):
  - `db.connect`가 처음 N회 실패 후 성공(monkeypatch) → 스레드 생존, 이후 beat가 실제 기록됨(`locked_at` 갱신 확인).
  - beat 실패(커넥션 강제 close 등) 후 다음 interval에 재접속해 beat 재개.
  - 고정 sleep 대신 deadline까지 조건을 poll(CI flake 방지).
- **run_loop** (`tests/test_worker_loop.py`):
  - dispatch 중 예외 → `connect_fn` 호출됨 + in-flight job이 `queued`로 복귀 + 루프 계속(다음 iteration에서 정상 처리).
  - **attempts 소진된 job은 requeue하지 않음** — dispatch 예외 시 job이 `running`으로 남고 재claim되지 않음(reaper 몫).
  - claim 자체가 예외 → 재접속 후 계속.
  - shutdown set → 유휴 상태에서 즉시 반환.
  - `_reconnect`: 실패 반복 시 backoff 증가(1→2→4), shutdown set 시 None.
  - **초기 연결 배선 정적 체크**: `main()`은 `# pragma: no cover`라 배선 회귀를 런타임 테스트로 못 잡는다 — `inspect.getsource(main)`에 초기 연결이 `_reconnect(lambda: db.connect...)` 경유로만 존재함을 단언하는 정적 테스트로 고정한다.
- **shutdown 경로**:
  - `run_process_meeting(shutdown_event=set된 Event)` → 첫 stage 진입에서 `ShutdownRequested`.
  - `handle_job` 경유: outcome `"requeued_shutdown"`, job `status='queued'`, `attempts`가 claim 이전 값으로 복귀(미소모), meeting `processing` 유지.
  - `requeue_for_shutdown` 소유권 상실 시 0-row → `"lost"`.
  - attempts=1에서 shutdown requeue → `greatest(0,...)`로 0 (음수 방지).
- **enter_stage 소유권 가드** (enroll/index 신규 의미):
  - enroll/index 실행 중 소유권 상실(reaper 회수 등) → `enter_stage`가 `lost_ownership` TRANSIENT raise → handle_job 경로에서 `"lost"` (기존: persist까지 헛연산).
- **초기 연결**: `_reconnect`가 최초 연결에도 쓰임 — connect_fn 처음 N회 실패 후 성공 → 정상 기동.
- **회귀**: 기존 전체 스위트 통과(파이프라인 `shutdown_event` 기본값 `None` — 기존 호출부 무변경 동작. 단 enroll/index의 lost-ownership 의미 변화는 신규 테스트로 고정).

---

## 5. 파일별 변경 요약

| 파일 | 변경 |
|---|---|
| `worker/damwha_worker/heartbeat.py` | `_run` 재접속 루프 |
| `worker/damwha_worker/__main__.py` | `run_loop`/`_reconnect` 추출, 시그널 핸들러, `ShutdownRequested` 처리, shutdown_event 배선 |
| `worker/damwha_worker/errors.py` | `ShutdownRequested` 예외 추가 |
| `worker/damwha_worker/db.py` | `requeue_for_shutdown` 추가 |
| `worker/damwha_worker/pipeline/stage.py` (신규) | `enter_stage` 공용 헬퍼 (shutdown 확인 + 소유권 가드) |
| `worker/damwha_worker/pipeline/process_meeting.py` | `_stage` → `enter_stage`, normalize 전 shutdown 확인, `shutdown_event` 파라미터 |
| `worker/damwha_worker/pipeline/enroll_speaker.py` | `enter_stage` 사용(소유권 가드 신규), `shutdown_event` 파라미터 |
| `worker/damwha_worker/pipeline/index_meeting.py` | 〃 |
| `worker/tests/test_heartbeat.py`, `test_worker_loop.py`, `test_process_meeting.py` 등 | 테스트 추가 |

계약(`src/contracts/`, `contracts.py`), 마이그레이션, API — 변경 없음.
