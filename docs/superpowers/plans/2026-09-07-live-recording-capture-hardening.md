# 라이브 녹음 캡처 정합성 보완 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 실행 시 사용자가 병렬 에이전트를 요청하지 않았다면 순차 실행한다.

**Goal:** 정상 종료의 마지막 샘플을 보존하고, 부분 쓰기·워커 장애·orphan 경합이 녹음의 확정 prefix를 손상시키지 않게 한다.

**Architecture:** API는 job의 `committed_bytes`까지를 확정 PCM으로 관리하며 `sealed_bytes`로 봉인한다. 워커는 확정 prefix만 읽고 미리보기 실패를 회의 실패로 전파하지 않는다. 브라우저는 서버 회의 생성 전 준비를 완료하고 Worklet flush ACK 이후 종료한다.

**Tech Stack:** Node 22, pnpm 10.26.0, NestJS 10, Postgres/raw SQL, Python 3.12/psycopg, React 19, Vite 8, AudioWorklet, Jest/Testcontainers, pytest, Vitest.

**Spec:** [2026-09-07-live-recording-capture-hardening-design.md](../specs/2026-09-07-live-recording-capture-hardening-design.md)

**기준:** `e6a410b`. 문서 작성 브랜치는 `docs/live-recording-capture-hardening`. 아래 체크박스는 모두 미실행이다. 이 plan은 기존 라이브 기능을 처음부터 다시 만드는 계획이 아니다.

## Global Constraints

- Node 22, pnpm 10.26.0, Python 3.12. 기존 React 19·Vite 8·NestJS 10 구조를 유지한다.
- PCM은 16,000 Hz, mono, signed int16 little-endian. WAV 헤더는 44바이트다.
- 일반 청크는 32,768바이트, 프레임은 512샘플(1,024바이트), PCM 시간 환산은 32 bytes/ms다.
- 모든 상태 변경은 job → meeting 잠금과 `current_job_id` 재검증을 사용한다.
- producer는 회의당 하나, in-flight 요청은 하나, 메모리 전송 버퍼 상한은 60초다.
- API와 워커는 Postgres 및 공유 저장소로 통신한다. 워커 HTTP 엔드포인트를 만들지 않는다.
- `live_session.max_attempts=1`을 유지한다. 미리보기 job을 재queue하지 않는다.
- 활성 녹음을 비운 유지보수 창에서 API·워커를 함께 갱신한다. 구·신 writer 혼용은 지원하지 않는다.

명령은 별도 표시가 없으면 **monorepo root**에서 실행한다. `pnpm be/fe`와 `uv --directory`로 cwd를
지정한다. `npm install`, 루트 `.env`, 실행 중인 녹음의 임의 삭제는 사용하지 않는다.
DB 테스트는 Docker가 필요하다. 모델 설치 없이 glue를 검증하고 실제 마이크/실모델은 Task 7에서 분리한다.

---

## 파일 지도와 순서

| Task | 책임                                   | 주요 파일                                                                |
| ---- | -------------------------------------- | ------------------------------------------------------------------------ |
| 1    | 확정 경계 스키마·파일 원시 연산        | migration 024, `live-audio.service.ts`, `live.repository.ts`             |
| 2    | append/stop/ACK·tail의 확정 경계       | `live.service.ts`, `db.py`, `tail_source.py`, FE `api/live.ts`           |
| 3    | preview 실패 격리·finalize·양쪽 reaper | `__main__.py`, `pipeline/live_session.py`, `db.py`, `jobs.repository.ts` |
| 4    | orphan 잠금 후 검증·교차 경합          | `live-orphan.service.ts`, DB e2e                                         |
| 5    | Worklet flush·가변 자투리·빌드 검증    | `pcm-worklet.ts`, `pcm-convert.ts`, 새 검증 스크립트                     |
| 6    | prepare/begin/stop·UI 통합             | `live-recorder.ts`, `live-session.ts`, `new-meeting-dialog.tsx`          |
| 7    | 공유 저장소·프로덕션 smoke·현재 문서   | `SMOKE.md`, `deploy/README.md`, 패키지 CLAUDE                            |

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 순서로 실행한다. 중간 커밋은 검토 단위이며 혼합 버전으로 배포하지 않는다.
각 Task에서 새 테스트의 실패 원인을 먼저 확인한다. 기존 테스트가 이미 목표를 충족하면 그 사실을 기록하고
중복 구현하지 않는다. 성공 기준이 바뀐 기존 테스트는 새 계약에 맞춰 갱신한다.

### Task 1: 확정 경계와 복구 가능한 파일 쓰기

**Files**

- Create: `be/src/database/migrations/024_live_committed_bytes.sql`
- Modify: `be/src/jobs/jobs.types.ts`, `be/src/live/live.repository.ts`, `be/src/live/live.service.ts`
- Modify: `be/src/storage/live-audio.service.ts`
- Test: `be/test/live-audio.service.spec.ts`, `be/test/live.e2e-spec.ts`

**Interfaces**

- `JobRow.committed_bytes: string | null` — pg bigint 수신 타입.
- `LiveRepository.setCommitted(exec: Queryable, jobId: string, bytes: number): Promise<void>` — job 경계와 `last_input_at` 갱신.
- `LiveAudioService.recover(key: string, committedBytes: number): Promise<void>` — 초과 꼬리 truncate+sync, 짧은 파일 오류.
- `LiveAudioService.writeAt(key: string, offset: number, pcm: Buffer): Promise<number>` — 완전 positional write+sync, 반환은 offset+len.
- 기존 `append` 호출자는 Task 2에서 전환한다. 미사용이 된 뒤 제거한다.

- [ ] **Step 1: 파일 복구 회귀 테스트를 추가한다.** 기존 service spec의 `root`, `KEY`, `svc` fixture를 사용한다.

```ts
it("replays a partially written tail from the committed boundary", async () => {
  await svc.create(KEY);
  const first = Buffer.alloc(32768, 1);
  await svc.writeAt(KEY, 0, first);
  fs.appendFileSync(path.join(root, KEY), Buffer.alloc(401, 9));
  await svc.recover(KEY, 32768);
  const tail = Buffer.alloc(1000, 2);
  expect(await svc.writeAt(KEY, 32768, tail)).toBe(33768);
  expect(fs.readFileSync(path.join(root, KEY)).subarray(44)).toEqual(
    Buffer.concat([first, tail]),
  );
});
```

같은 fixture에 짧은 파일(확정=32768, 실제=32766) 오류와 `bytesWritten=0` 오류를 추가한다.
write spy는 실제 파일에 7바이트씩 쓰고 실제 bytesWritten을 반환하도록 감싸서, 한 번의 write 호출에
전체 버퍼가 쓰인다고 가정하는 구현을 실패시킨다. fs 전체를 mock하지 않는다.

- [ ] **Step 2: 실패를 확인한다.**

Run: `pnpm be test --runInBand test/live-audio.service.spec.ts`

Expected: 새 메서드 부재 또는 부분 쓰기 단언 실패. 환경 설정 오류는 회귀 실패로 세지 않는다.

- [ ] **Step 3: spec §3.2의 SQL과 원시 연산을 구현한다.**

```ts
// writeAt 내부. offset은 PCM 기준이며 헤더 44바이트 뒤에 쓴다.
let written = 0;
while (written < pcm.length) {
  const result = await fh.write(
    pcm,
    written,
    pcm.length - written,
    44 + offset + written,
  );
  if (result.bytesWritten === 0) throw new Error("zero-byte live audio write");
  written += result.bytesWritten;
}
await fh.datasync();
return offset + written;
```

recover는 파일 길이가 44+committed보다 크면 truncate, 작으면 오류, 같으면 no-op이다.
신규 live job을 생성하는 repository 경로가 같은 생성 TX에서 committed=0을 설정하게 한다.
024 제약은 spec 그대로 적용하고 기존 migration 023은 수정하지 않는다.

- [ ] **Step 4: 원시 연산과 스키마 테스트를 확인한다.**

Run: `pnpm be test --runInBand test/live-audio.service.spec.ts test/live.e2e-spec.ts`

Expected: 부분 쓰기 완성, 401바이트 미확정 꼬리 제거, 짧은 파일 거절, 신규 job의 committed=0.
SQL로 음수/홀수 committed 및 sealed≠committed를 넣으면 CHECK 위반, 과거 NULL은 허용되는지도 검사한다.

- [ ] **Step 5: 위 파일만 stage하고 커밋한다.** 메시지: `fix(live): 확정 바이트 경계와 완전 쓰기 원시 연산 추가`

### Task 2: append·stop·ACK·TailSource를 같은 경계로 맞춘다

**Files**

- Modify: `be/src/live/live.service.ts`, `be/src/live/live.repository.ts`, `be/src/live/live.controller.ts`
- Modify: `be/worker/damwha_worker/db.py`, `be/worker/damwha_worker/__main__.py`
- Modify: `be/worker/damwha_worker/audio/tail_source.py`, `be/worker/damwha_worker/pipeline/live_session.py`
- Modify: `fe/src/features/meeting/api/live.ts`, `fe/src/features/meeting/lib/live-recorder.ts`
- Create: `be/test/fixtures/live-crash-child.ts`, `be/test/live-crash.e2e-spec.ts`
- Test: `be/test/live-audio.e2e-spec.ts`, `be/worker/tests/test_tail_source.py`, `be/worker/tests/test_db_live.py`
- Test: `fe/src/features/meeting/api/live.test.tsx`, `fe/src/features/meeting/lib/live-recorder.test.ts`

**Interfaces**

- Consumes: Task 1의 `recover`, `writeAt`, `setCommitted`.
- Python `LiveInputState`는 `@dataclass(frozen=True)`로 `signal: str | None`, `committed_bytes: int`, `sealed_bytes: int | None`을 가진다.
- `get_live_input_state(conn, job_id: str, worker_id: str) -> LiveInputState` — 단일 SELECT, lost 상태에서는 committed=0이며 소비자가 즉시 종료한다.
- `TailSource`는 기존 인자를 유지하되 `input_state: Callable[[], LiveInputState]`로 sealed callback을 대체한다.
- FE `PostResult`는 `{status: 200 | 409; expected: number; code?: 'sealed' | 'duration_limit'}`로 통일한다.

- [ ] **Step 1: 실제 파일·DB를 사용하는 crash 회귀를 추가한다.** 기존 audio e2e의 start/send/stop/srv fixture를 사용한다.

```ts
it("does not acknowledge PCM written before a rolled-back commit", async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  const { rows } = await db.pool.query(
    "SELECT audio_key FROM meeting WHERE id=$1",
    [m.id],
  );
  const storage = app.get(StorageService); // ../src/storage/storage.service 에서 import
  fs.appendFileSync(storage.resolve(rows[0].audio_key), Buffer.alloc(401, 9));
  await stop(m.id, CHUNK, CHUNK + 1000, Buffer.alloc(1000, 2)).expect(200);
  expect(
    fs.readFileSync(storage.resolve(rows[0].audio_key)).subarray(44),
  ).toEqual(Buffer.concat([chunk(1), Buffer.alloc(1000, 2)]));
});
```

별도 테스트는 writeAt이 401바이트를 쓰고 throw하게 하고 DB 경계 불변을 단언한다.
DB commit 실패는 파일 sync 뒤 TX를 rollback시키는 seam으로 주입한다. 복구는 예외를 정상 catch하는 경우와
실제 자식 API 프로세스 SIGKILL 후 재기동하는 경우를 구분한다. 새 live-crash e2e는 기존 Testcontainers
DB와 임시 STORAGE_ROOT를 자식에 전달한다. live-crash-child는 테스트 Nest 앱을 띄우고 주입된 storage/DB
래퍼에서 IPC `{type:'barrier', point}`를 부모에게 보낸 뒤 대기한다. 부모는 SIGKILL 후 같은 DB·storage로
자식을 다시 띄워 동일 요청을 보낸다. kill 지점은 첫 부분 write 후, sync 후, commit 후 응답 전 세 지점이다.
자식 fixture는 be cwd에서 `fork(fixturePath, [], {execArgv: ['-r', 'ts-node/register/transpile-only'],
env: {...process.env, DATABASE_URL: db.url, STORAGE_ROOT: db.storageRoot}})`로 띄운다.
기존 ts-node 의존성을 사용하며 운영 HTTP fault endpoint는 만들지 않는다. 모든 자식은 finally에서 종료한다.

- [ ] **Step 2: 해당 테스트의 실패를 확인한다.**

Run: `pnpm be test --runInBand test/live-audio.e2e-spec.ts`

Expected: 이전 구현이 파일 길이를 expected로 삼거나 미확정 꼬리를 포함해 실패한다.

- [ ] **Step 3: API 트랜잭션을 아래 순서로 바꾼다.**

```text
validate safe integer/even offset/body length
lock job -> meeting; recheck current job + recording + unsealed
recover(audio_key, committed)
duplicate? -> markInput; return conflict decision; COMMIT -> HTTP 409
offset != committed? -> return conflict decision; COMMIT -> HTTP 409
end = writeAt(audio_key, committed, body)
setCommitted(end); if stop: seal(end)
COMMIT -> HTTP response
```

`intHeader`와 pg bigint 변환에 Number.isSafeInteger 검사를 넣는다. stop body 상한과
final=offset+len을 검증한다. I/O 오류와 DB TX 오류를 구분하고 spec §3.3의 재잠금 실패 마킹을 적용한다.
파일 길이가 아니라 실패 전 committed 값을 비교해야 후속 성공 요청을 실패시키지 않는다.
4시간 상한 초과는 spec §4.2대로 prefix만 쓰고 봉인하며 `duration_limit` 응답을 commit 뒤 반환한다.
이미 봉인된 stop의 응답은 live job 상태에 따라 finalized/stopping을 구분하고 새 process job을 만들지 않는다.

- [ ] **Step 4: worker의 확정 prefix 소비를 구현한다.**

```python
# tail loop에서 읽기와 drift 계산에 공통 사용
state = self._input_state()
if state.signal == 'lost':
    return
available = min(physical_pcm, state.committed_bytes)
```

db.py의 immutable snapshot 하나를 main loop가 1초마다 교체하고 source 스레드가 읽게 한다.
`get_stop_requested`를 쓰는 기존 테스트/호출자를 전환한다. sealed 이후 short file 10초 timeout은
주입 시계로 검사한다. confirmed 한 프레임 + 미확정 한 프레임 파일에서는 첫 프레임만 나와야 한다.
미확정 prefix를 truncate한 뒤 다른 PCM을 다시 써도 이전 바이트가 전사되지 않는지 검사한다.

- [ ] **Step 5: FE의 ACK 판정을 고친다.**

```ts
const end = this.offset + body.byteLength;
if (res.code === "sealed" || res.code === "duration_limit") {
  // 자동 봉인 상태를 노출하고 캡처/큐를 정리한다. 일반 ACK로 dequeue하지 않는다.
  return;
}
if (res.expected === end) {
  this.offset = end;
  this.queue.shift();
} else if (res.status === 409 && res.expected === this.offset) {
  // 청크는 보존하고 기존 retry delay 후 재전송한다.
} else {
  throw new LiveUploadRejected("invalid audio acknowledgement");
}
```

`LiveUploadRejected`는 기존 Error 하위 클래스로 문자열 메시지를 받는다. 반환 직전 리소스 정리와 terminal 상태 반영을 구현하며
Task 6의 stop 경로에서 자동 봉인을 재사용한다. stop ACK 유실 후 missing_chunk expected가 로컬보다
앞서면 서버의 확정 경계에서 빈 stop을 재시도한다. 그 앞에 최신 자투리를 덧붙이지 않는다.

- [ ] **Step 6: 전체 경계 계약을 검증한다.**

Run: `pnpm be test --runInBand test/live-audio.e2e-spec.ts test/live-crash.e2e-spec.ts`

Run: `uv run --directory be/worker pytest -q tests/test_tail_source.py tests/test_db_live.py`

Run: `pnpm fe test src/features/meeting/api/live.test.tsx src/features/meeting/lib/live-recorder.test.ts`

Expected: 정상·부분 쓰기·ACK 유실에 동일 PCM, 홀수 꼬리 복구, sealed 불변, tail은 committed 초과 읽기 0.
상한 테스트는 `MAX_PCM_BYTES - 1024` 크기의 sparse 파일과 맞는 DB 경계를 준비하고 일반 청크를 보내
최종 길이 460800000, duration_limit, 후속 append 거절을 확인한다. 실제 4시간을 기다리지 않는다.

- [ ] **Step 7: 변경 파일만 커밋한다.** 메시지: `fix(live): append와 tail을 DB 확정 경계로 통일`

### Task 3: 워커 장애를 미리보기에 격리한다

**Files**

- Modify: `be/worker/damwha_worker/db.py`, `be/worker/damwha_worker/__main__.py`
- Modify: `be/worker/damwha_worker/pipeline/live_session.py`
- Modify: `be/src/jobs/jobs.repository.ts`, `be/src/live/live.service.ts`
- Test: `be/worker/tests/test_db_lifecycle.py`, `be/worker/tests/test_dispatch_live.py`, `be/worker/tests/test_live_session.py`, `be/worker/tests/test_db_live.py`
- Test: `be/test/reaper.spec.ts`, `be/test/live-audio.e2e-spec.ts`

**Interfaces**

- `fail_live_preview(conn, job_id: str, worker_id: str, error: dict) -> bool`: running/locked_by 가드, job만 failed, 0행이면 false.
- `finalize_live_session`과 API `finalizeByApi`는 기존 인터페이스 유지, DB에서 sealed=committed를 추가 검증한다.
- `handle_job`은 browser live의 예외·ShutdownRequested를 preview 실패 경로에 라우팅한다. mic 거절은 별도 기존 정책.

- [ ] **Step 1: DB-only preview 실패 회귀를 쓴다.** `test_db_live.py`의 기존 live job 생성 fixture 패턴을 사용한다.

```python
def test_preview_failure_does_not_fail_recording(conn):
    # 이 테스트는 기존 seed_meeting/seed_job helper의 기본 행을 live로 전환한다.
    from conftest import seed_meeting, seed_job
    from damwha_worker import db

    meeting_id = seed_meeting(conn)
    job_id = seed_job(conn, meeting_id=meeting_id)
    conn.execute("UPDATE job SET type='live_session', status='running', locked_by='w1', "
                 "committed_bytes=32768 WHERE id=%s", (job_id,))
    conn.execute("UPDATE meeting SET status='recording', current_job_id=%s WHERE id=%s",
                 (job_id, meeting_id))
    assert db.fail_live_preview(conn, job_id, 'w1', {'code': 'live_stt_failed'})
    assert conn.execute('SELECT status FROM meeting WHERE id=%s', (meeting_id,)).fetchone()['status'] == 'recording'
```

기존 `seed_meeting`/`seed_job`은 id 문자열을 반환하며 payload 생략 시 빈 JSON을 사용한다.
이 DB 상태 테스트는 payload를 dispatch하지 않는다. reaper 경로는 TS/Python에서 동일한 running live + 오래된 locked_at을 만들고
job failed, meeting recording을 각각 단언한다. process_meeting은 여전히 meeting failed여야 한다.

- [ ] **Step 2: 실패를 확인한다.**

Run: `uv run --directory be/worker pytest -q tests/test_db_live.py tests/test_db_lifecycle.py tests/test_dispatch_live.py`

Expected: Python reaper 또는 기존 fail_process_meeting 전파가 recording을 failed로 바꿔 실패한다.

- [ ] **Step 3: 실패/시그널 분기와 finalize 가드를 수정한다.**

```sql
UPDATE job SET status='failed', error=%s, updated_at=now()
WHERE id=%s AND status='running' AND locked_by=%s;
```

preview 실패 경로는 위 소유권 가드만 수행한다. meeting은 변경하지 않는다.
두 reaper의 fail_meetings는 process_meeting만 대상으로 맞춘다. dispatch 전 shutdown, loop shutdown,
max_minutes, 연속 클립 실패를 각각 검사하고 live를 requeue하거나 미봉인 finalize하지 않게 한다.
봉인된 worker finalize는 현재 DB 상태를 잠금 아래 재검증하고 duration을 확정 길이에서 계산한다.
API는 queued/failed만 finalize한다. lost/cancelled meeting은 보존한다.
0바이트 사용자 stop은 running이어도 job 종료+회의 폐기, orphan 0바이트는 failed로 구별한다.

- [ ] **Step 4: 교차 actor를 검증한다.**

Run: `pnpm be test --runInBand test/reaper.spec.ts test/live-audio.e2e-spec.ts`

Run: `uv run --directory be/worker pytest -q tests/test_db_lifecycle.py tests/test_dispatch_live.py tests/test_live_session.py tests/test_db_live.py`

Expected: R1 및 봉인 전후 SIGTERM, sealed finalizer 소유권 상실, capture_error 보존 통과.
실제 reaper 함수를 호출한 뒤 append 200 → stop → process job 1개를 확인한다. SQL로 job failed만
흉내 낸 테스트만으로 두 reaper가 일치했다고 판단하지 않는다.

- [ ] **Step 5: 커밋한다.** 메시지: `fix(live): 워커 종료와 녹음 수명을 분리`

### Task 4: orphan의 잠금 후 생존 검사와 동시성을 검증한다

**Files**

- Modify: `be/src/live/live-orphan.service.ts`, `be/src/live/live.repository.ts`
- Test: `be/test/live-orphan.e2e-spec.ts`, `be/test/live-audio.e2e-spec.ts`
- Test: `be/worker/tests/test_db_live.py`

**Interfaces**

- `LiveRepository.isProducerExpired(exec: Queryable, jobId: string, seconds: number): Promise<boolean>` — 이미 잠근 job을 DB clock으로 검사.
- sweep은 Task 1 recover와 Task 3 API finalize를 사용한다. 새 worker liveness 임계값을 만들지 않는다.

- [ ] **Step 1: 후보 조회 직후 정상 append를 끼우는 테스트를 추가한다.** 기존 orphan e2e의 fixture를 사용한다.

```ts
it("rechecks input freshness after selecting an orphan candidate", async () => {
  const { body: m } = await start().expect(201);
  await send(m.id, 0, chunk(1)).expect(200);
  await age(m.id, 120, true);
  const repo = app.get(LiveRepository); // ../src/live/live.repository 에서 import
  const original = repo.findOrphanCandidates.bind(repo);
  jest
    .spyOn(repo, "findOrphanCandidates")
    .mockImplementationOnce(async (exec, seconds) => {
      const candidates = await original(exec, seconds);
      await send(m.id, CHUNK, chunk(2)).expect(200);
      return candidates;
    });
  expect(await orphans.sweep()).toBe(0);
  const { rows } = await db.pool.query(
    "SELECT status FROM meeting WHERE id=$1",
    [m.id],
  );
  expect(rows[0].status).toBe("recording");
});
```

- [ ] **Step 2: 실패를 확인한다.**

Run: `pnpm be test --runInBand test/live-orphan.e2e-spec.ts`

Expected: 현재 sweep이 1을 반환하거나 meeting을 uploaded로 바꿔 실패한다.

- [ ] **Step 3: 잠금 후 predicate를 추가한다.**

```sql
SELECT COALESCE(last_input_at, created_at)
       < clock_timestamp() - ($2 || ' seconds')::interval AS expired
FROM job WHERE id=$1;
```

미봉인일 때만 검사하고 신선하면 즉시 false를 반환한다. 오래된 세션은 committed 경계로 복구·봉인한다.
이미 sealed면 queued/failed만 회수하고 running은 유지한다. 파일 stat을 확정 길이로 쓰지 않는다.

- [ ] **Step 4: 별도 커넥션으로 경합을 고정한다.**

DB barrier를 사용해 job 잠금 획득 순서를 강제하고 `pg_locks`로 대기를 확인한다. 임의 sleep으로
승자를 가정하지 않는다. 각 테스트는 finally에서 rollback/release하여 실패해도 잠금이 남지 않게 한다.

| 경합                        | 강제 순서                                   | 단언                                             |
| --------------------------- | ------------------------------------------- | ------------------------------------------------ |
| queued API finalize ↔ claim | stop이 job 잠금 / claim이 먼저 commit, 각각 | SKIP LOCKED 또는 worker 인계, process job 최대 1 |
| worker finalize ↔ orphan    | 봉인 후 worker의 job 잠금 / API 회수, 각각  | stale actor 쓰기 0, current job 하나             |
| cancel ↔ append             | 각각 job 잠금을 먼저 잡는 경우              | deadlock/500 없음, cancel 후 파일 증가 없음      |
| append ↔ sweep              | 후보 조회 후 append commit                  | sealed NULL, committed=65536                     |
| API sweep 둘                | 같은 candidate                              | process job 하나                                 |

Python worker finalize의 실제 함수를 호출하는 경합은 `test_db_live.py`에서 두 psycopg 연결로 검증한다.
TS에서 worker SQL을 흉내 낸 테스트만으로 Python 구현 검증을 대체하지 않는다.

- [ ] **Step 5: 테스트 후 커밋한다.**

Run: `pnpm be test --runInBand test/live-orphan.e2e-spec.ts test/live-audio.e2e-spec.ts`

Run: `uv run --directory be/worker pytest -q tests/test_db_live.py`

Expected: 위 표의 정해진 양방향 순서 모두 통과. 메시지: `fix(live): orphan 봉인 전 생존 조건 재검증`

### Task 5: Worklet의 마지막 샘플과 프로덕션 빌드를 검증한다

**Files**

- Modify: `fe/src/features/meeting/lib/pcm-worklet.ts`, `fe/src/features/meeting/lib/pcm-convert.ts`
- Create: `fe/src/features/meeting/lib/pcm-worklet-protocol.ts`
- Create: `fe/src/features/meeting/lib/pcm-worklet-protocol.test.ts`
- Create: `fe/scripts/verify-pcm-worklet.mjs`
- Modify: `fe/package.json`
- Test: 기존 `fe/src/features/meeting/lib/pcm-convert.test.ts`

**Interfaces**

- `WorkletCommand = {type:'begin'} | {type:'flush'}`.
- `WorkletEvent = {type:'ready'} | {type:'begun'} | {type:'pcm'; pcm:ArrayBuffer} | {type:'flushed'}`.
- `ChunkAccumulator.push(samples: Int16Array): Uint8Array[]` — 입력 길이와 무관하게 완전 청크 배열 반환.
- `ChunkAccumulator.flush(): Uint8Array` — 남은 샘플의 정확한 바이트 길이.
- `FrameAccumulator.flush(): Int16Array` — 내부 rest를 반환하고 비운다.

- [ ] **Step 1: 샘플 회계를 고정한다.**

```ts
it("keeps a 137-sample final tail without padding", () => {
  const chunks = new ChunkAccumulator();
  const input = new Int16Array(16384 + 137).fill(123);
  const full = chunks.push(input);
  expect(full.map((x) => x.byteLength)).toEqual([32768]);
  const tail = chunks.flush();
  expect(tail.byteLength).toBe(274);
  expect(new Int16Array(tail.buffer)).toEqual(new Int16Array(137).fill(123));
  expect(chunks.flush().byteLength).toBe(0);
});
```

Run: `pnpm fe test src/features/meeting/lib/pcm-convert.test.ts`

Expected: 기존 고정 FRAME_BYTES 할당/프레임 개수 기반 구현에서 실패한다.

- [ ] **Step 2: 가변 샘플 누적과 Worklet 제어를 구현한다.**

```ts
// Worklet의 같은 port에서 FIFO로 보낸다.
if (message.type === "flush" && !this.finished) {
  this.finished = true;
  const tail = this.frames.flush();
  if (tail.length)
    this.port.postMessage({ type: "pcm", pcm: tail.buffer }, [tail.buffer]);
  this.port.postMessage({ type: "flushed" });
}
```

최초 유효 입력에서 ready 한 번, begin 수신에서 begun 한 번을 보낸다. begin 전/flush 후 process는
PCM을 누적하지 않는다. 타입은 protocol 파일에서 import하고 런타임 누적 함수는 기존 pcm-convert를
재사용한다. worker 빌드가 import를 번들하므로 Worklet 안에서 상수를 수동 복제할 필요가 없다.
복수 채널 downmix와 실제 quantum 길이 처리를 유지한다. caller는 push 결과 배열을 전부 enqueue한다.

- [ ] **Step 3: 실제 Worklet 클래스를 테스트한다.**

protocol test는 mock AudioWorkletProcessor/port와 registerProcessor를 설치한 뒤 실제 모듈을 import한다.
128, 256, 137샘플 quantum 및 2채널을 공급하고 ready/begun/pcm/flushed 순서와 결과 샘플을 단언한다.
registerProcessor로 받은 생성자를 사용한다. 테스트용으로 복제한 processor 로직은 만들지 않는다.
begin 전 샘플 0개, flush 이후 추가 process의 PCM 0개, flush 두 번의 ACK 수명도 검사한다.

- [ ] **Step 4: 프로덕션 Worklet 산출물 검증 명령을 추가한다.**

`package.json`의 `verify:worklet`은 `node scripts/verify-pcm-worklet.mjs`다. 스크립트는
`dist/assets/pcm-worklet-*.js`를 정확히 하나 찾고 Node vm으로 평가한다. `.ts` 산출물은 실패다.

```js
let Processor;
const sandbox = {
  registerProcessor(name, ctor) {
    if (name !== "pcm-processor") throw new Error("unexpected processor");
    Processor = ctor;
  },
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage() {}, onmessage: null };
    }
  },
  Float32Array,
  Int16Array,
  Uint8Array,
  ArrayBuffer,
};
vm.runInNewContext(source, sandbox, { timeout: 1000 });
assert.equal(typeof Processor, "function");
```

스크립트에서 `node:vm`, `node:assert/strict`, `node:fs/promises`를 import한다.
평가 후 Step 3과 같은 begin/flush를 호출해 실제 산출물이 protocol을 지키는지 검사한다.
Node vm 통과는 브라우저 AudioWorklet 지원 증명이 아니며 Task 7 smoke를 별도로 수행한다.

- [ ] **Step 5: 테스트·빌드 후 커밋한다.**

Run: `pnpm fe test src/features/meeting/lib/pcm-convert.test.ts src/features/meeting/lib/pcm-worklet-protocol.test.ts`

Run: `pnpm fe build`

Run: `pnpm fe verify:worklet`

Expected: 샘플 회계 및 실제 산출물 실행 통과. 메시지: `fix(live): Worklet flush로 마지막 샘플 보존`

### Task 6: 회의 생성 전 prepare, flush ACK 뒤 stop을 연결한다

**Files**

- Modify: `fe/src/features/meeting/lib/live-recorder.ts`, `fe/src/features/meeting/lib/live-session.ts`
- Modify: `fe/src/features/meeting/ui/new-meeting-dialog.tsx`, `fe/src/features/meeting/ui/live-banner.tsx`
- Modify: `fe/src/features/meeting/api/live.ts`, `fe/src/features/meeting/api/types.ts`
- Modify: `be/src/live/live.service.ts`
- Test: `fe/src/features/meeting/lib/live-recorder.test.ts`, `fe/src/features/meeting/lib/live-session.test.tsx`
- Test: `fe/src/features/meeting/ui/new-meeting-dialog.live.test.tsx`, `fe/src/features/meeting/ui/live-banner.test.tsx`
- Test: `be/test/live-audio.e2e-spec.ts`

**Interfaces**

- `LiveRecorder.prepare(deviceId?: string): Promise<void>` — 마이크·ctx·Worklet ready 확보, meetingId 불필요.
- `LiveRecorder.begin(meetingId: string): Promise<void>` — prepared 상태에서 begin/begun 후 recording.
- `LiveRecorder.dispose(): Promise<void>` — 생성 전 취소/실패 정리, 서버 POST 없음.
- `LiveRecorder.stop(): Promise<void>` — 중복 호출은 동일 Promise, flush→drain→stop.
- `prepareLiveRecorder(deviceId?: string): Promise<LiveCapture>` — preparing부터 모듈 소유자를 예약한다.
- `beginLiveCapture(capture: LiveCapture, meetingId: string): Promise<void>` — 동일 예약 확인 후 활성 meeting 연결.
- 기존 createLiveRecorder/start API는 호출자가 전환된 뒤 제거하고 get/subscribe/clear의 화면 계약은 유지한다.
- `RecorderFailure`에 `capture_flush_failed` 추가. `RecorderStatus`에 `phase`와 `sealedByServer: boolean` 추가.

- [ ] **Step 1: 생성 전 실패 순서를 UI 테스트로 고정한다.** 기존 dialog test의 start mutation과 마이크 mock을 재사용한다.

```text
권한 Promise reject -> start.mutate 호출 0, 성공 toast 0
getUserMedia 성공 + addModule reject -> track.stop 1, start.mutate 0
ready ACK 없음 + 5초 -> track.stop 1, ctx.close 1, start.mutate 0
ready ACK -> 생성 요청 -> 201 -> begin/begun -> 상세 이동
생성 요청 409 -> dispose, begin 0
201 뒤 begin 실패 -> 0바이트 stop, 성공 toast 0
prepare 중 취소 -> 늦게 resolve한 stream 즉시 stop, 생성 요청 0
```

fake timer로 5초를 진행한다. 실제 권한 프롬프트에는 시간 제한을 걸지 않는 것을 별도 검사한다.

- [ ] **Step 2: stop이 ACK를 기다리는 테스트를 추가한다.**

```text
recording 레코더에 완전 청크 + 137샘플 주입
stop 호출 -> port로 flush 전송, 아직 postStop/ctx.close 호출 0
pcm(137샘플), flushed 순서로 port 이벤트 전달
postChunk 200 후 postStop의 body.length = 274, final = 33042
stop 재호출 -> postStop 총 1회, 동일 Promise
```

Run: `pnpm fe test src/features/meeting/lib/live-recorder.test.ts src/features/meeting/ui/new-meeting-dialog.live.test.tsx`

Expected: 이전 POST-before-prepare/teardown-before-flush 구현에서 실패한다.

- [ ] **Step 3: 명시적 상태 전이를 구현한다.**

```ts
const capture = await prepareLiveRecorder(deviceId);
try {
  const meeting = await start.mutateAsync(request);
  await beginLiveCapture(capture, meeting.id);
  onCreated(meeting.id);
} catch (error) {
  await capture.recorder.dispose();
  throw error;
}
```

이 orchestration에서 생성 id는 catch에서도 보존한다. id를 얻은 뒤 begin 실패면 dispose 외에
0바이트 stop을 보내고, 201 응답 유실이면 생성 재시도를 하지 않는다. UI는 gate 준비와 네트워크 요청
전체 동안 중복 시작을 막는다. generation 토큰을 prepare/dispose의 각 await 뒤에 검사한다.
ctx.resume, ready, begun을 각각 5초로 제한하고 silent gain→destination 연결을 유지한다.

- [ ] **Step 4: 정상 종료·실패 종료를 같은 자원 반납 경로로 연결한다.**

```text
정상: flush(2초) -> flushed -> release resources -> drain(60초) -> postStop(tail)
flush timeout: capture_flush_failed -> release -> 받은 연속 PCM만 drain/stop
upload/buffer failure: release -> 마지막 확인 경계에서 빈 stop, hole 뒤 tail 금지
duration_limit/sealed 응답: release -> pending queue 폐기 -> 서버 상태 재조회
```

요청별 10초 AbortSignal timeout을 추가한다. 중복 stop Promise를 저장하고 finally에서 자원을
정리한다. stop 중에도 flushed 이전 PCM handler는 살아 있어야 한다. 4시간 timer는 begin ACK 기준으로
설정하고 stop/dispose에서 해제한다. 각 timeout은 fake timer 테스트로 확인한다.
`capture_flush_failed` 헤더/API 매핑/배너를 추가하고 기존 device_ended 사유를 덮지 않는다.

- [ ] **Step 5: 통합 테스트 후 커밋한다.**

Run: `pnpm fe test src/features/meeting/lib/live-recorder.test.ts src/features/meeting/lib/live-session.test.tsx src/features/meeting/ui/new-meeting-dialog.live.test.tsx src/features/meeting/ui/live-banner.test.tsx`

Run: `pnpm be test --runInBand test/live-audio.e2e-spec.ts`

Expected: R5·R6·R9, route unmount 중 캡처 유지, generation 취소, flush/drain timeout, 오류 이력 보존 통과.
메시지: `fix(live): 준비 완료 뒤 녹음을 만들고 flush 후 종료`

### Task 7: 배포 경로 검증과 현재 문서를 갱신한다

**Files**

- Modify: `be/CLAUDE.md`, `fe/CLAUDE.md`, `be/worker/SMOKE.md`, `deploy/README.md`
- Modify: `docs/superpowers/plans/2026-09-06-live-recording-followups.md`
- Inspect: `deploy/docker-compose.yml`, `be/docker-compose.yml`

**Interfaces**

- 앞 Task의 migration·API·worker·브라우저 프로토콜을 함께 검증한다.
- smoke 증거는 실행 시각, commit, OS/browser, 개발/배포 구분, meeting id, committed/sealed/파일 크기를 기록한다.

- [ ] **Step 1: 전체 결정적 검증을 실행한다.**

Run: `pnpm be test --runInBand`

Run: `uv run --directory be/worker pytest -q`

Run: `pnpm fe test`

Run: `pnpm build`

Run: `pnpm lint`

Run: `uv run --directory be/worker ruff check .`

Run: `pnpm fe verify:worklet`

Expected: 모두 exit 0. 환경 실패와 assertion 실패를 구별한다. 기존 socket hang up 관측만으로
새 실패를 무조건 flake 처리하지 않는다. 실행하지 못한 검증은 미검증으로 명시한다.

- [ ] **Step 2: 유지보수 배포 절차를 문서화하고 대상 환경에서 확인한다.**

```sql
SELECT count(*) FROM meeting WHERE status='recording';
SELECT count(*) FROM job WHERE type='live_session' AND status IN ('queued','running');
```

두 결과가 0이고 새 녹음 진입이 중지된 상태에서 API/워커를 정지한다. 024를 적용하고 둘을 함께
올린다. 실제 배포 승인 범위가 없으면 문서·검증용 환경까지만 수행하고 운영 배포를 완료로 표시하지 않는다.

- [ ] **Step 3: 개발과 Docker 배포 smoke를 각각 수행한다.**

1. 개발 서버에서 실제 마이크 권한 거절 → 회의가 안 생기는지 확인한다.
2. 프로덕션 빌드에서 실제 마이크 승인 → Worklet ready/begun → 10초 녹음 → flush/stop을 확인한다.
3. 배포의 API 컨테이너가 쓰는 `deploy/storage` 파일을 호스트 worker가 읽는지 확인한다.
4. 별도 녹음 중 worker를 SIGTERM하고 오디오 업로드가 계속되는지 확인한 후 stop한다.
5. 정본 처리 뒤 아래 바이트 회계를 확인한다. ffprobe로 16kHz·mono·duration도 대조한다.

```sql
SELECT m.id, m.status, m.duration_ms, m.capture_error,
       j.committed_bytes, j.sealed_bytes
FROM meeting m JOIN job j ON j.meeting_id=m.id
WHERE j.type='live_session' AND m.id = $1;
```

정상 완료: `physical_size = 44 + committed_bytes = 44 + sealed_bytes`, WAV data 크기=sealed,
`duration_ms=floor(sealed/32)`. preview 실패 회의도 정본 처리는 성공하고 기존 capture_error는 보존되어야 한다.
API 로그로 append latency와 호스트에서 새 committed prefix가 보이는 지연을 기록한다.
LAN 브라우저는 HTTPS origin에서만 시험하고 TLS 구성을 본래 녹음 기능의 구현으로 섞지 않는다.

- [ ] **Step 4: 문서의 현재 동작과 과거 스냅샷을 구분한다.**

현재 문서에 spec의 우선순위 표, committed/sealed 차이, preview-only 실패, prepare/flush, 두 배포
경로를 반영한다. 이월 목록의 reaper 완료 표시는 Python 검증 결과까지 붙여 바로잡는다.
이미 수정된 Worklet 경로는 이번에 새로 고친 것으로 기록하지 않는다. 실제 마이크를 실행하지 못하면
사유와 미검증 항목을 SMOKE에 남기며 과거 mtg_15 결과를 이번 성공 근거로 재사용하지 않는다.

- [ ] **Step 5: 코드 변경에 맞춰 그래프를 갱신하고 마무리한다.**

Run: `graphify update .`

Run: `git diff --check`

전체 diff에서 범위 밖 변경을 제거하고 테스트/빌드/smoke 증거를 기록한다.
문서 커밋 메시지: `docs(live): 확정 경계와 배포 검증 결과 갱신`

## Spec coverage / 실행 완료 기준

| Spec             | 실행 Task | 완료 증거                                     |
| ---------------- | --------- | --------------------------------------------- |
| §1 문서 관계     | 7         | 현재 문서와 이월 목록 링크                    |
| §2·3 확정 prefix | 1·2       | CHECK, 부분 write/kill 복구, ACK, tail 테스트 |
| §4 worker 독립성 | 3         | 실제 양쪽 reaper와 dispatch/signal 테스트     |
| §5 orphan        | 4         | 후보 이후 append 및 양방향 경합               |
| §6 prepare       | 6         | 생성 POST 순서·취소·리소스 정리 테스트        |
| §7 flush         | 5·6       | 137샘플 꼬리, ACK 순서, timeout/오류 표시     |
| §8 빌드·배포     | 5·7       | 산출물 평가, 실제 브라우저·공유 저장소 smoke  |
| §9 R1–R9         | 1–7       | 각 테스트 결과와 미검증 항목 구분             |

정상 경로 smoke만으로 실패 경로 검증을 대신하지 않는다. 구현 결과가 spec과 달라지면
먼저 차이와 근거를 기록하고, 실패한 검증을 통과했다고 체크하지 않는다.
