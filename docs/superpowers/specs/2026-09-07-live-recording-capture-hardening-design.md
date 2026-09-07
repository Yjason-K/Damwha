# 라이브 녹음 — 브라우저 캡처 정합성 보완 설계

**작성일:** 2026-09-07

**상태:** 리뷰를 바탕으로 작성한 후속 설계. 이 문서의 목표 동작 전체가 구현됐다는 뜻은 아니다.

**기준 코드:** `e6a410b` (`dev`, 라이브 녹음 머지 후)

**범위:** 브라우저 캡처의 시작·종료, 부분 쓰기 복구, 워커 장애 격리, orphan 경합, 배포 검증.

**구현 계획:** [capture-hardening plan](../plans/2026-09-07-live-recording-capture-hardening.md)

## 1. 문서 관계와 현재 구현

앞선 두 문서는 변경하지 않는 스냅샷이다.

1. [원 설계](2026-09-05-live-recording-design.md): 2-pass, 라이브 미리보기, 정본 처리의 출발점.
2. [브라우저 캡처 설계](2026-09-05-live-recording-browser-capture-design.md): 캡처 주체와 WAV writer 변경.
3. **이 문서:** 두 문서를 합쳐 읽을 때 남는 실패 경로를 확정한다. 아래 표에 해당하는 규칙은 이 문서가 우선한다.

| 기존 결정                                      | 이번 결정                                              | 적용 절                      |
| ---------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| 2-pass, `live_utterance`, suggest 임계값, 폴링 | 유지                                                   | 원 설계 §2.2·2.4·2.7·2.8     |
| 브라우저 캡처, API writer, 워커 tail           | 유지                                                   | 브라우저 설계 §2.1–2.5       |
| 파일 길이가 append 오프셋의 진실               | **DB의 `committed_bytes`가 진실**                      | 브라우저 설계 §3.3·4.3·4.4·6 |
| `sealed_bytes`가 유일한 EOF                    | 유지. 봉인 시 `sealed_bytes = committed_bytes`         | 브라우저 설계 §2.7           |
| 워커 오류는 회의 실패, SIGTERM은 finalize      | **미리보기만 종료. 봉인 전 finalize 금지**             | 원 설계 §2.6·3.4·5.5·5.6·8   |
| API finalize는 queued만 허용                   | **queued 또는 failed**, 이미 봉인된 미완료 세션도 회수 | 브라우저 설계 §4.6·4.7       |
| orphan 후보 조회 후 봉인                       | 잠금 후 생존 조건 재검증                               | 브라우저 설계 §4.7           |
| 회의 생성 뒤 getUserMedia / 시작 전 게이트     | **캡처 준비 완료 뒤 회의 생성**                        | 브라우저 설계 §4·5.2·7       |
| Worklet 중지 후 메인 버퍼 전송                 | **Worklet flush ACK 뒤 전송 종료**                     | 브라우저 설계 §5.4           |
| `.ts`의 `new URL()`                            | 기존 구현의 **`?worker&url` 유지·검증**                | 브라우저 설계 §5.1           |
| API·워커가 모두 호스트 프로세스                | 개발은 호스트, 배포는 API 컨테이너 + 호스트 워커       | 브라우저 설계 §2.1·2.2       |

[2026-09-06 이월 목록](../plans/2026-09-06-live-recording-followups.md)은 구현 이력이다.
그 문서가 완료로 분류한 내용도 아래 실제 파일을 기준으로 확인했다.

| 항목                                  | 기준 코드에서 확인한 상태                              | 이번 작업                             |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------- |
| Worklet TS 변환                       | `live-recorder.ts`는 이미 `?worker&url` 사용           | 재구현 없이 프로덕션 산출물 회귀 검증 |
| API의 워커 부재 finalize·봉인 후 스캔 | 이미 구현                                              | 가드를 명시하고 회귀 검증             |
| reaper의 라이브 회의 실패 제외        | TS에는 반영, Python `db.reap_stale`에는 미반영         | 두 실행 경로 일치                     |
| 워커 예외                             | `handle_job`이 `fail_process_meeting` 호출             | preview 전용 실패 경로                |
| 파일 append                           | `FileHandle.write` 반환 길이 미검사, DB 확정 경계 없음 | 완전 쓰기 + 확정 경계                 |
| orphan 재검증                         | 잠금 후 상태만 확인                                    | 생존 조건도 재검증                    |
| 권한·Worklet 준비                     | 회의 생성 성공 뒤 `recorder.start`                     | 순서 변경                             |
| Worklet 자투리                        | `rest`를 전송하는 종료 프로토콜 없음                   | 명시적 flush                          |

## 2. 목표, 불변식, 비목표

### 2.1 성공 기준

- 권한 거절, 장치 부재, AudioContext·Worklet 준비 실패는 `/meetings/live`를 호출하지 않는다.
- 정상 종료에서는 Worklet이 캡처한 마지막 샘플까지 PCM에 포함된다. 정본에 512샘플 패딩을 넣지 않는다.
- append/stop 쓰기 도중 죽어도 미확정 꼬리를 정본으로 인정하지 않으며, 같은 요청을 재전송해 복구한다.
- 워커 OOM·SIGTERM·클립 연속 실패가 브라우저의 정상 append를 막지 않는다.
- stale 판정 후 봉인된 세션은 API가 다음 스캔에서 최종 job 하나만 만든다.
- orphan 후보 조회 이후 성공한 append를 스캐너가 덮어 봉인하지 않는다.
- 프로덕션 JS Worklet 및 API 컨테이너↔호스트 워커 공유 경로를 검증한다.

### 2.2 전역 제약

- Node 22, pnpm 10.26.0, Python 3.12. 기존 React 19·Vite 8·NestJS 10 구조를 유지한다.
- PCM은 16,000 Hz, mono, signed int16 little-endian. WAV 헤더는 44바이트다.
- 일반 청크는 32,768바이트, 프레임은 512샘플(1,024바이트), PCM 시간 환산은 32 bytes/ms다.
- 모든 상태 변경은 job → meeting 잠금과 `current_job_id` 재검증을 사용한다.
- producer는 회의당 하나, in-flight 요청은 하나, 메모리 전송 버퍼 상한은 60초다.
- API와 워커는 Postgres 및 공유 저장소로 통신한다. 워커 HTTP 엔드포인트를 만들지 않는다.
- `live_session.max_attempts=1`을 유지한다. 미리보기 job을 재queue하지 않는다.
- 활성 녹음을 비운 유지보수 창에서 API·워커를 함께 갱신한다. 구·신 writer 혼용은 지원하지 않는다.

IndexedDB, WebSocket, 시스템 오디오, 다중 producer, 원격 워커, 미리보기 자동 재시작은 범위 밖이다.
탭 종료·시스템 슬립 중의 미전송 오디오 보존을 약속하지 않는다. API의 확정 경계까지만 보존한다.

## 3. 부분 쓰기 복구: 확정 경계를 DB에 둔다

### 3.1 선택과 대안

`stat.size`만 쓰면서 겹친 요청의 바이트를 비교·복원하는 방법은 stop 자투리와 고정 청크 규칙을
복잡하게 만든다. 청크별 파일/receipt 방식은 별도 파일 수명·정리 프로토콜이 필요하다.
**job의 확정 바이트 수 하나를 추가**한다. 이미 매 append마다 job을 갱신하므로 트랜잭션 수는 늘지 않는다.
대신 TailSource도 이 경계를 읽도록 함께 바뀐다.

### 3.2 데이터

새 마이그레이션 `024_live_committed_bytes.sql`:

```sql
ALTER TABLE job ADD COLUMN committed_bytes bigint;
ALTER TABLE job ADD CONSTRAINT job_live_committed_bytes_check CHECK (
  committed_bytes IS NULL OR (
    type = 'live_session' AND committed_bytes >= 0 AND committed_bytes % 2 = 0
    AND (sealed_bytes IS NULL OR sealed_bytes = committed_bytes)
  )
);
```

신규 browser live job은 반드시 `committed_bytes=0`으로 생성한다. 과거 종료 job과 다른 job 타입은
NULL을 허용한다. 완료된 옛 녹음을 파일 크기로 일괄 역산하지 않는다. 신규 활성 세션의 NULL은
호환성 오류이며 파일 길이 fallback을 쓰지 않는다. payload 모양은 변하지 않아 버전도 유지한다.
DB bigint는 API에서 안전한 정수 범위인지 확인한 뒤 변환하고, 헤더 값도 같은 검증을 적용한다.

`committed_bytes`는 **fdatasync 완료 후 DB commit한 연속 prefix**다. `sealed_bytes`는 그 prefix를
최종 길이로 확정했다는 표시다. 실제 파일에는 크래시 때문에 미확정 꼬리가 붙어 있을 수 있다.

### 3.3 append 순서와 재전송

검증 가능한 헤더·body 오류는 파일을 열기 전에 400으로 거절한다. 일반 body는 정확히 32,768바이트다.
이후 job → meeting을 잠그고 recording/current job/미봉인/확정 경계를 확인한다.

1. 파일 길이가 `44 + committed_bytes`보다 길면 그 경계로 truncate하고 sync한다.
2. 파일이 그보다 짧거나 없으면 `io_error`로 job과 meeting을 닫는다. 잃은 확정 바이트를 0으로 채우지 않는다.
3. 요청 offset이 확정 경계와 같으면 positional write를 반복한다. `bytesWritten=0`은 I/O 실패다.
4. 모든 PCM을 쓰고 fdatasync한 뒤 같은 TX에서 `committed_bytes`, `last_input_at`, 첫 `recorded_at`을 갱신한다.
5. DB commit 뒤 200 `{ accepted_offset: end, expected_offset: end }`를 반환한다.

재전송 offset+body.length가 확정 경계와 같으면 ACK 유실로 판단한다. 같은 producer·한 요청 in-flight
전제 아래 중복으로 허용하고, `last_input_at` 갱신을 **commit한 다음** 409 `{expected_offset}`를 보낸다.
그 밖의 앞선/미래 offset도 409지만 생존 시각을 갱신하지 않는다. sealed/종단 오류는 `code`로 구분한다.
FE는 409라는 이유만으로 청크를 버리지 않는다. expected가 현재 청크 끝일 때만 dequeue한다.
expected가 현재 시작이면 같은 청크를 재시도하고, 그 외 경계 또는 `code:'sealed'`는 종료 복구로 간다.

TX callback 안에서 예외를 던져 liveness/실패 마킹을 rollback하지 않는다. 응답 결정을 값으로 반환해
commit 이후 HTTP 상태로 변환한다. 실제 DB 오류로 TX가 실패하면 별도 TX에서 job → meeting을 다시
잠그고 상태와 **실패 전 committed_bytes**를 재검증한 뒤에만 I/O 실패를 마킹한다.
뒤의 성공 요청이 경계를 전진시켰다면 그 세션을 소급 실패시키지 않는다.

### 3.4 stop·orphan·크래시

stop body는 0 이상 32,768 미만의 짝수 바이트, `final = offset + body.length`다.
stop도 §3.3의 복구와 완전 쓰기를 사용한다. 꼬리 sync 후 **하나의 TX에서** committed=final,
sealed=final, stop_requested_at을 함께 commit한다. finalize의 선행 조건은 이 봉인이다.
헤더 확정은 commit 후 best-effort이며 normalize의 header repair는 유지한다.

| 크래시 지점                 | DB 경계 | 다음 요청/스캐너                              |
| --------------------------- | ------- | --------------------------------------------- |
| PCM 일부 쓰기 중            | 이전 값 | 미확정 꼬리 truncate, 요청 전체 재전송        |
| PCM sync 후 commit 전       | 이전 값 | 동일. 디스크에 전부 있어도 미확정             |
| commit 후 응답 전           | 새 값   | append 중복 ACK / 같은 final의 stop 멱등 응답 |
| 봉인 commit 후 헤더 수정 전 | 최종 값 | TailSource는 정상 EOF, 헤더는 repair          |

orphan 봉인은 파일 크기가 아니라 committed_bytes를 사용한다. 미확정 꼬리를 truncate한 뒤 봉인한다.
브라우저까지 사라졌다면 미확정 데이터는 버리고 `producer_abandoned`를 남긴다.
파일이 확정 경계보다 짧으면 봉인·finalize하지 않고 I/O 실패로 끝낸다.
0바이트 사용자 stop은 worker 상태와 무관하게 job을 종료 처리한 뒤 회의를 폐기한다(job → meeting 잠금).
자동 스캐너의 0바이트는 `producer_never_started` 실패로 남기며 삭제하지 않는다.
stop 재시도는 current job이 이미 process job으로 바뀌어도 원 live job을 찾아 처리한다.
0바이트 폐기 후 404는 FE에서 폐기 완료로 수렴시키고 새 회의를 만들지 않는다.

### 3.5 TailSource

워커는 `get_live_input_state` 한 SELECT로 status/locked_by/committed/sealed/stop을 읽는다.
읽기 스레드에는 immutable snapshot을 교체해 전달한다. 갱신 주기는 기존 stop 폴링의 1초다.
열린 파일의 읽기와 drift seek 상한은 `min(physical_pcm, committed_bytes)`다.
이렇게 해야 다음 요청이 미확정 꼬리를 truncate해도 이미 전사한 PCM이 바뀌지 않는다.
확정 경계까지 short read하면 대기한다. 봉인 후 정본의 마지막 512샘플 미만은 파일에 남기되
미리보기에서만 생략한다. sealed 이후 파일이 짧은 상태가 10초 지속되면 preview I/O 실패로 종료한다.
정본 처리 실패 판정은 API 저장소 검사 또는 기존 normalize가 담당한다.

## 4. 워커 생존과 녹음 생존을 분리한다

### 4.1 actor와 상태

| 사건                                 | live job                       | meeting / 캡처         | 종결자            |
| ------------------------------------ | ------------------------------ | ---------------------- | ----------------- |
| 워커가 아직 claim하지 않음           | queued                         | recording, append 계속 | stop 후 API       |
| 워커 정상 + 미봉인                   | running                        | recording, append 계속 | 봉인 전에는 없음  |
| SIGTERM, preview 예외·연속 클립 실패 | 소유권 가드 아래 failed        | recording, append 계속 | 봉인 후 API       |
| OOM/SIGKILL                          | stale까지 running, 이후 failed | recording, append 계속 | stale 판정 후 API |
| 봉인 + 정상 워커                     | running → done                 | uploaded               | worker            |
| 봉인 + queued/failed                 | done                           | uploaded               | API               |
| 사용자 cancel / API 디스크 실패      | failed                         | failed, append 거절    | 기존 cancel / API |

API finalize 허용 상태는 명시적으로 queued/failed다. done live job을 다시 finalize하지 않는다.
worker finalize는 running+locked_by뿐 아니라 sealed=committed를 요구하며 duration은
`floor(sealed_bytes / 32)`다. 두 actor 모두 recording+current_job_id를 확인하고 process job을 한 번만 만든다.
worker_id를 API가 가장하지 않는다. TypeScript와 Python은 각 저장소 함수를 유지하고 같은 계약 테스트로 맞춘다.

### 4.2 실패·시그널·상한

`fail_live_preview`는 job만 failed로 바꾼다. meeting.error/status, committed/sealed를 변경하지 않는다.
SIGTERM이 dispatch 직전에 왔어도 live job은 `requeue_for_shutdown`에 들어가지 않는다.
봉인 전 SIGTERM은 preview를 반납한다. 봉인 후 처리 중 SIGTERM도 API 인계를 위해 반납할 수 있다.
DB 장애 때문에 반납을 기록할 수 없으면 자식은 종료하고 reaper가 소유권을 회수한다.
worker가 이미 lost이면 추가 쓰기 없이 종료한다. source=mic는 기존 거절 정책을 유지한다.

양쪽 reaper는 live job을 failed로 만들되 `fail_meetings`에 live_session을 포함하지 않는다.
stale 판정은 기존 `REAPER_STALE_MINUTES`(기본 30분), 실행 주기는 기존 5분이다. 빠른 복구를 약속하지 않는다.
배너의 heartbeat 30초 경고는 표시용이며 API가 임의로 살아 있는 worker의 잠금을 훔치는 근거가 아니다.

기존 4시간 상한은 미리보기 프로세스의 수명과 분리한다. FE는 캡처 시작부터 4시간에 정상 stop 절차를
시작한다. API는 누적 PCM 최대 `460800000`바이트(16,000×2×4×3600)를 강제한다. 초과 요청은 상한까지의
prefix만 쓰고 같은 TX에서 봉인한 뒤 409 `{code:'duration_limit', expected_offset:460800000}`를 돌려준다.
FE는 이를 일반 ACK로 취급하지 않고 마이크·큐를 정리하고 봉인된 상태를 조회한다.
worker의 기존 max_minutes 도달은 preview 반납일 뿐 임의 봉인이 아니다.

## 5. orphan 스캐너의 재검증

후보 조회는 힌트다. 각 후보에 대해 job → meeting 잠금 후 다음을 다시 검사한다.

1. meeting.status=recording, current_job_id=job.id.
2. 미봉인이면 `COALESCE(last_input_at, created_at)`이 DB 현재 시각보다 90초 이상 오래됐는지.
   잠금 대기 전 TX 시작 시각 대신 잠금 획득 뒤 `clock_timestamp()`로 판정한다.
3. 아직 신선하면 파일을 건드리지 않고 끝낸다. 오래됐으면 §3의 복구 후 봉인한다.
4. 이미 봉인이면 producer 시각은 보지 않고 queued/failed만 API finalize한다. running은 기다린다.

스캔 주기는 기존 30초다. producer abandon 판정은 정상 실행 기준 90–120초 안이며 DB/API 장애 중에는
이 시간을 보장하지 않는다. cancel·다른 스캐너·worker finalize가 먼저 이겼으면 아무것도 변경하지 않는다.

## 6. 브라우저 준비와 소유권

레코더 상태는 `idle → preparing → prepared → recording → stopping → stopped`이며 실패는 리소스를
반납하고 stopped로 수렴한다. 모듈 스코프 세션 소유자를 유지해 라우트 전환이 녹음을 종료하지 않게 한다.

1. 사용자 클릭에서 prepare를 호출한다. secure context를 검사하고 getUserMedia 권한·장치를 얻는다.
2. AudioContext 생성·실제 16kHz 확인·Worklet 모듈 로딩·노드 연결·resume를 수행한다.
3. Worklet은 첫 유효 입력 quantum을 확인해 ready를 보내되 begin 전 PCM은 버린다. 유효 입력에는 무음도 포함된다.
4. resume/ready는 각각 5초 제한이다. 권한 프롬프트 자체에는 제한을 두지 않는다. 취소된 prepare가 늦게
   stream을 얻으면 generation 토큰 확인 후 즉시 track.stop한다. permissions.query 미지원은 시작 차단 사유가 아니다.
5. prepared 이후에만 `/meetings/live`를 보낸다. 응답 후 begin을 전송하고 캡처 시작 시계를 설정한다.
6. begun ACK를 5초 안에 받은 뒤 성공 토스트·상세 이동을 한다. 회의 생성 실패면 dispose한다.

회의 생성 요청이 서버에 도달한 뒤 응답이 유실된 경우의 멱등 생성은 이번 범위 밖이다.
클라이언트는 생성 POST를 자동 재시도하지 않고 dispose한다. 서버의 0바이트 orphan 회수가 남은 회의를 닫는다.
201 뒤 begin 실패는 id를 알고 있으므로 0바이트 stop으로 정리한다. 성공한 준비 이후 취소·연속 클릭도
동일 토큰과 소유권 규칙을 사용한다. 이전 레코더를 fire-and-forget stop하면서 새 녹음을 만들지 않는다.

## 7. Worklet 종료 프로토콜과 전송

메인→Worklet: `{type:'begin'}` / `{type:'flush'}`.
Worklet→메인: `{type:'ready'}` / `{type:'begun'}` / `{type:'pcm', pcm:ArrayBuffer}` /
`{type:'flushed'}`. 모든 PCM 및 ACK는 같은 MessagePort를 사용한다.

flush 처리 시 이후 입력 누적을 중단하고, 내부 rest를 int16 PCM으로 전송한 뒤 flushed를 보낸다.
flushed 이후 process()는 PCM을 생성하지 않는다. 메인 스레드는 flushed까지 전달된 PCM을 모두 누적한 뒤
노드 disconnect, track.stop, AudioContext.close를 수행한다. 그래프는 gain=0을 거쳐 destination에
연결해 처리 수명을 유지하고 마이크 소리를 스피커로 되돌리지 않는다.

`ChunkAccumulator`는 프레임 개수가 아니라 실제 샘플 수로 16,384샘플씩 꺼낸다.
flush는 0–16,383샘플을 패딩 없이 반환한다. 워크릿 자투리는 1–511샘플일 수 있다.
예: 16,384+137샘플 입력은 일반 청크 32,768바이트와 stop body 274바이트다.

정상 stop: flush 요청 → ACK(최대 2초) → 리소스 반납 → 전체 청크 ACK 확인 → stop 자투리 요청.
중복 stop은 같은 Promise를 반환한다. flush ACK 시간 초과는 `capture_flush_failed`를 남기고,
이미 받은 연속 PCM까지만 전송·봉인한다. 장치 ended도 가능한 flush를 시도하고 `device_ended`를 우선 보존한다.
전송 실패/큐 상한 이후에는 기존의 마지막 연속 prefix 정책을 유지하고 구멍 뒤의 꼬리를 이어 붙이지 않는다.
HTTP 한 요청은 10초 timeout, 정상 stop의 drain은 60초 한도다. 한도 초과 시 마이크는 이미 꺼져 있어야 하며
`upload_failed`를 표시하고 마지막 확인 경계에서 stop을 시도한다. 서버까지 닿지 않으면 orphan에 맡긴다.
ACK 유실로 서버 경계가 더 앞서 있으면 그 경계에서 빈 stop을 재시도한다. 로컬 미전송 PCM을 성공으로 표시하지 않는다.

`X-Capture-Error`에 `capture_flush_failed`를 추가하고 API 매핑·FE 문구·wire 타입을 같이 맞춘다.
capture_error는 첫 캡처 원인을 보존하며 preview_worker_lost는 기존 값이 없을 때만 기록한다.
최종 persist가 이 필드를 지우지 않는 기존 동작을 유지한다.

## 8. 빌드와 배포

`pcm-worklet.ts?worker&url`을 유지한다. `.ts`를 URL 에셋으로 복사하는 방식으로 되돌리지 않는다.
[Vite asset 문서](https://vite.dev/guide/assets)는 URL 에셋과 worker 빌드를 구분한다.
검증은 tsc 통과뿐 아니라 실제 프로덕션 Worklet JS 평가·메시지 프로토콜 및 브라우저 addModule까지 포함한다.

개발은 `be/.env`의 `./storage`와 worker의 `../storage`가 같은 디렉터리다.
배포는 `deploy/docker-compose.yml`의 `./storage:/repo/be/storage` bind mount를 통해 같은 파일을 본다.
Docker Desktop VM 경계를 통과하는 파일 가시성·sync 비용은 호스트 경로와 별도로 실측한다.
fdatasync는 OS의 내구성 요청이며 하드웨어 전원 장애까지 실측 없이 보증했다는 표현은 쓰지 않는다.
다른 노트북의 브라우저 접속은 HTTPS origin에서 시험한다. HTTP LAN IP를 권한 지원 환경으로 세지 않는다.

배포 순서: 새 녹음 진입 중지 → recording 및 queued/running live job이 0인지 확인 → API/워커 정지 →
024 migration → 새 API·워커 기동 → 검증 후 진입 재개. 활성 legacy job에 committed 값을 추측해 채우지 않는다.
옛 writer로 롤백할 때도 녹음을 먼저 비운다. 컬럼은 additive이므로 종료 이력을 삭제할 이유가 없다.

## 9. 수용 테스트와 문서 갱신

| ID  | 시나리오 / 합격 기준                                                               | plan     |
| --- | ---------------------------------------------------------------------------------- | -------- |
| R1  | 양쪽 reaper·SIGTERM·5연속 preview 실패 뒤에도 meeting recording, append 성공       | Task 3   |
| R2  | 일반 청크·stop의 일부 쓰기, sync 전후, commit 전후 crash → 정본 바이트 정확히 일치 | Task 1·2 |
| R3  | 프로덕션 Worklet JS 평가 가능, 실제 addModule·ready·begin·flush 성공               | Task 5·7 |
| R4  | 후보 선정 뒤 append commit → sweep 0, 미봉인 유지                                  | Task 4   |
| R5  | 권한/ctx/module/ready 실패에서 생성 POST 0, 열린 track 0                           | Task 6   |
| R6  | 다양한 quantum과 마지막 137샘플 → 정본 33,042바이트 PCM, ACK 뒤 PCM 없음           | Task 5·6 |
| R7  | 배포 API append의 committed prefix를 호스트 tail이 읽음, HTTPS 브라우저 녹음 완료  | Task 7   |
| R8  | queued-finalize↔claim, worker-finalize↔sweep, cancel↔append → process job 최대 1   | Task 3·4 |
| R9  | 4시간 경계 넘는 청크 → 460800000에서 봉인, FE 캡처 중지                            | Task 2·6 |

결정적 DB 테스트는 기존 Testcontainers를 사용한다. 실모델과 실제 마이크는 로컬 smoke이며 CI가 있다고
가정하지 않는다. 이번 문서 작성은 이 테스트들의 실행 완료를 의미하지 않는다.
구현 완료 시 `be/CLAUDE.md`, `fe/CLAUDE.md`, `be/worker/SMOKE.md`, `deploy/README.md`와 이월 목록을
갱신한다. 과거 spec/완료 plan을 다시 쓰지 않는다. 이월 목록은 각 항목을 실제 검증 근거와 함께 닫는다.
