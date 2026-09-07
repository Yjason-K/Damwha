# 라이브 녹음(브라우저 캡처) 이월 항목

`feat/live-recording` 브랜치를 머지하기 전후로 남은 일 목록. **닫으면서 갱신하는 체크리스트**다
(`specs/`의 스냅샷 문서와 달리 사후 편집한다).

출처는 셋 — (1) 2026-09-05 최종 브랜치 리뷰(`347b983..2f80836`, 21커밋, 7,316줄 diff),
(2) Task별 리뷰가 minor로 미룬 항목들, (3) 그 뒤 fix wave 여섯 개와 실기기 스모크.

관련 문서:
[설계](../specs/2026-09-05-live-recording-browser-capture-design.md) ·
[구현 플랜](2026-09-05-live-recording-browser-capture.md) ·
현재 동작은 [`be/CLAUDE.md`](../../../be/CLAUDE.md)의 "Live session is a fifth job type"

---

## 0. 지금 상태

**실기기 스모크 통과.** 2026-09-06, 회의 `mtg_15`, 6분 17초.

| 확인한 것 | 결과 |
|---|---|
| 잡 체인 | `live_session`(source=browser) → `process_meeting` → summarize/index/lenses 전부 `done` |
| `meeting.error` / `capture_error` | 둘 다 NULL |
| 바이트 회계 | 파일 = `sealed_bytes + 44`, WAV data 청크 = `sealed_bytes`, 11,802프레임 정수 정렬 |
| 봉인 모양 | 368 풀 청크(32768B) + 26프레임(26,624B) 꼬리 — stop이 꼬리를 싣는 §3.4 그대로 |
| 길이 일치 | `sealed/32000` = `duration_ms` = ffprobe(live.wav) = ffprobe(normalized.flac) = 377.664s |
| 시각 정합 | 오디오 종료 추정 시각과 `stop_requested_at`의 차이 **6ms** — 유실된 청크 없음 |
| 오디오 연속성 | 정확한 0 샘플이 200ms 이상 이어지는 구간 0개 |
| 전사 | 63발화, 화자 5명, 요약·렌즈·인덱스 완료 |

**정상 경로는 검증됐다.** 아래는 전부 *실패 경로*와 위생 항목이었다 — 스모크에서 아무것도
실패하지 않았으므로 하나도 태워지지 않았다.

> **이 `mtg_15` 결과는 2026-09-07 capture-hardening 작업의 근거가 아니다.** 그때 코드에는
> `job.committed_bytes`가 아예 없었다(migration `024`는 그 브랜치에서 추가됐다). 즉 위 "바이트
> 회계" 줄은 *파일 길이*를 기준으로 맞춘 것이고, 확정 경계를 기준으로 맞춘 것이 아니다.
> 이후 변경의 증거는 `be/worker/SMOKE.md`의 2026-09-07 절에 따로 있다.

---

## 1. 닫힌 것

### 스모크 직전 fix wave (6건)

| 커밋 | 내용 |
|---|---|
| `ef8658c` | stop 스플라이스 — 레코더 실패 후 `[오디오][구멍][마지막 1초]`를 이어 붙여 완전한 것처럼 봉인하던 문제 |
| `2a601d3` | `X-Capture-Elapsed`를 POST 시각이 아니라 프레임 도착 시각에 찍는다. `startedAt`도 권한 프롬프트 뒤로 |
| `ac14be8` | `new AudioContext()`를 기존 `try` 안으로 — 생성자가 던지면 마이크가 켜진 채 샜다 |
| `aa29c75` | 라이브 파일이 스펙대로 `live.wav`에 쓰인다 (`meetingKey()`가 basename을 무시하고 있었다) |
| `0adf4d5` | `source` 기본값을 `browser`로 + **빌더 출력을 고정하는 테스트** |
| `cbbdcc3` | SMOKE.md에 `capture_error IS NULL` 확인 추가 |

### 스모크 이후 (이 문서를 쓰고 나서)

| 커밋 | 닫은 항목 |
|---|---|
| `32f72bb` | **P0.1** 레코더 실패 → `capture_error` (§5.3·§7). 같이: 409-without-offset이 offset을 오염시키던 문제(P1 2.2), `upload_failed`가 실제로 발생하게, 배너가 여섯 코드를 전부 그리게 |
| `f396dfa` | **P0.2** `reapStale`이 라이브 회의를 죽이던 문제 (§2.11·§7) — **TypeScript 쪽만**. 정정은 아래 참고. 같이: "누가 finalize하는가"를 `!== 'running'`으로, 봉인-후-미마무리를 스위퍼가 집게, `duration_ms` 부동소수(P1 2.1) |

> **정정 (2026-09-07): 위 reaper 항목은 절반만 닫혀 있었다.** `f396dfa`가 고친 것은
> `JobsRepository.reapStale`(TypeScript)뿐이고, 워커 슈퍼바이저가 실제로 돌리는
> **Python `db.reap_stale`은 그대로였다** — 그쪽 `fail_meetings`는 여전히 라이브 회의를
> `failed`로 만들고 있었다. 두 실행 경로가 다른 계약을 들고 있었으므로, 워커의 reaper가
> 먼저 도는 배포에서는 멀쩡히 업로드 중인 녹음이 죽었을 것이다. 이 문서가 "닫힘"으로
> 분류한 것은 착오다.
>
> 실제로 두 쪽을 일치시킨 것은 capture-hardening 브랜치의 `2a3562f`
> ("fix(live): 워커 종료와 녹음 수명을 분리")다. 지금은 `db.reap_stale`이 `live_session`을
> requeue 집합과 `fail_meetings` 집합 **양쪽에서** 제외하고, 두 집합이 정확히 반대라
> stale live job이 `running`에 영원히 남지도 않는다. 고정하는 테스트도 양쪽에 있다 —
> `be/test/reaper.spec.ts`와
> `worker/tests/test_db_lifecycle.py::test_reap_stale_fails_live_session_but_leaves_the_meeting_recording`
> ·`::test_reap_stale_never_requeues_a_live_session`.
>
> 2026-09-07 실기기로도 확인했다(회의 `mtg_31`): 녹음 중 워커에 SIGTERM → 그 뒤로도
> `POST /live/audio` 15회 전부 200, `committed_bytes`가 정확히 15 × 32,768만큼 증가,
> job은 `failed`/`worker_shutdown`인데 meeting은 `recording` 유지. 종료 뒤 API가 finalize해
> `capture_error=preview_worker_lost`가 붙었고, 워커를 다시 띄우니 정본 처리가 `done`으로
> 끝나면서 그 `capture_error`는 보존됐다.
>
> **교훈:** 이 저장소는 같은 규칙을 TypeScript와 Python 두 곳에 손으로 들고 있다. 한쪽을
> 고치고 "닫힘"으로 적기 전에 반대쪽 파일을 열어 봐야 한다.
| `6a93efb` | **P1 열 건** — tmp 정리, `LIMIT 1`, OSError 분류, hang 대신 실패하는 시계, `pg_locks` 폴링, 409 오프셋 단언, `declare global` 격리, 죽은 코드 셋 |
| *(이 커밋)* | **스펙 괴리** — `mic` 즉시 거절, 봉인 후 크기 단언(§3.3.1), stop의 갭 검사(§3.4), `be/CLAUDE.md` 재작성 |

---

## 2. 남은 것

### P2 — 방어적이거나 오늘은 도달 불가

- **`markUploaded`가 `rowCount`를 안 본다** (`meetings.repository.ts`). 워커의 대응 코드
  (`db.py`)는 0이면 `"discarded"`로 중단한다. 두 API 호출자 모두 양쪽 행 락 아래에서
  `current_job_id`를 먼저 검증하므로 방어용이지만, 이 비대칭 때문에 가드가 조용히 빗나가도 API
  경로는 `process_meeting`을 큐잉하고 `current_job_id`를 옮긴다. `if (rowCount === 0) throw`
  한 줄이면 이 규약이 자기강제된다.
- **`stop()`의 멱등 분기가 항상 `outcome: 'stopping'`을 보고한다**, 원 호출이 finalize까지
  했더라도. ACK 유실 후 재시도한 stop이 클라이언트에게 "영영 움직이지 않을 워커를 기다리라"고
  말한다. 오늘은 무해(FE는 `discarded`만 구별).
- **두 번째 레코더 경합에 대한 클라이언트 가드 부재.** `getUserMedia` 도중의 stop은 no-op이고
  대기 중인 `start()`가 그 뒤에 마이크를 열 수 있다. `createLiveRecorder`가 이전 레코더를 먼저
  멈추고(a1ccda3) `meeting_single_recording_idx`가 한 `getUserMedia` 창 안의 두 번째
  `POST /meetings/live`를 금지하므로 도달 불가. 고치려면 `starting` 플래그나 abort 토큰이 필요.
- **orphan sweep의 `done` 전이가 앰비언트 폴링에만 의존한다.** 60초 `staleTime` 창 안에
  재방문하면 `captureError`가 빠진 낡은 스냅샷을 볼 수 있다. 이 기능이 만든 게 아니라 서버측
  상태 변화 전반의 특성.
- **`CHUNK_MS = 1024`**(`live-recorder.ts`)가 `pcm-convert.ts`에서 유도 가능한 값을 중복.

#### 반복되는 모양 하나

"마이크는 켜졌는데 아무것도 캡처되지 않음"이 이 코드에서 **세 번** 나왔다(생성자 throw,
두 번째 레코더 경합, `getUserMedia` 중 stop). 경로를 하나씩 기우는 대신 불변식 하나를 명시할
값이 있다 — *`start()`는 스트림을 할당 시점부터 첫 프레임까지 소유하고, 모든 종료 경로가 그것을
반납한다.*

### ~~스펙 §9가 요구했으나 없는 동시성 테스트 셋~~ — 닫힘 (2026-09-07)

세 가지 모두 실제 잠금 경합 테스트가 생겼다. 코드 리뷰가 아니라 테스트가 잠금 순서를 고정한다.

| 요구했던 경합 | 지금 고정하는 테스트 |
|---|---|
| cancel ↔ append | `live-audio.e2e-spec.ts` — "an append that waited behind a cancel is refused and never grows the file", "a cancel that waited behind an append closes the session and stops the growth" |
| queued-finalize ↔ worker-claim | `live.e2e-spec.ts` — "a claim skips the session job while stop holds its row lock"; `live-orphan.e2e-spec.ts` — "finalizes a sealed session that no worker ever claimed", "stop finalizes when the reaper already failed the job" |
| running-worker-finalize ↔ orphan-seal | `live-orphan.e2e-spec.ts` — "leaves a sealed session to the worker while the job is still running", "two sweepers on the same candidate produce exactly one process job" |

기존 "two concurrent appends at the same offset"도 그대로 있다.

### 테스트 공백

- ~~orphan 스윕에 §9가 요구한 "`last_input_at`은 낡았는데 파일은 더 긴 경우"가 없다.~~
  **닫힘** — `live-orphan.e2e-spec.ts`의 "an append that commits while the sweeper waits for
  the job lock leaves the session alive"와 "judges freshness by the clock after the lock, not
  by the transaction start"가 그 경합이다. 봉인 길이는 파일 길이가 아니라 확정 경계라는 것도
  "seals at the committed boundary and truncates the uncommitted tail"이 고정한다.
- `pcm-worklet.ts`는 여전히 **jsdom 커버리지 0**(jsdom에 `AudioContext`가 없다). 다만 완전한
  공백은 아니게 됐다 — `pnpm fe verify:worklet`이 **빌드 산출물**을 `node:vm`으로 평가해
  begin/flush 프로토콜을 검사하므로, `?worker&url`이 깨지는 회귀는 자동으로 잡힌다.
  실제 `audioWorklet.addModule()`은 여전히 실기기 스모크에서만 증명된다.
  (`?worker&url` 자체는 원래부터 옳았다 — 2026-09-07 작업은 그걸 고친 게 아니라 회귀 그물을
  씌운 것이다.)

### 2026-09-07 capture-hardening 브랜치가 닫은 것

`fix/live-recording-capture-hardening` (`1116b82..585e358`). 설계는
[capture-hardening spec](../specs/2026-09-07-live-recording-capture-hardening-design.md).

- **확정 바이트 경계** (migration `024`, `job.committed_bytes`). append 오프셋·복구 지점·봉인
  길이의 진실이 파일 길이에서 DB 컬럼으로 옮겨졌다. 부분 write와 sync 전후 크래시가 남기는
  미확정 꼬리를 정본으로 인정하지 않는다. 완전 쓰기 루프 + fdatasync 후 같은 TX에서 경계 전진.
- **워커 장애의 미리보기 격리.** `fail_live_preview`가 생겼고 Python `db.reap_stale`이
  TypeScript와 같은 계약이 됐다(위 정정 참고).
- **orphan 스위퍼의 잠금 후 생존 재검증.** 후보 조회와 봉인 사이에 커밋된 append를 덮지 않는다.
- **캡처 준비 → 회의 생성 순서.** 권한·장치·Worklet 실패가 `POST /meetings/live` 이전에 드러난다.
- **Worklet flush 프로토콜.** `flush`/`flushed` ACK로 마지막 자투리를 건져 stop 본문에 싣는다.
- 실기기 스모크와 배포 형상 실측은 `be/worker/SMOKE.md`의 2026-09-07 절.
  **미검증으로 남은 것: HTTPS origin·다른 기기 브라우저 녹음, 운영 배포.**

---

## 3. 스펙과 코드의 남은 거리

`specs/`는 사후 편집하지 않는 스냅샷이므로(저장소 규약), 아래는 **코드가 정본이고 스펙이 옛
서술**인 지점들이다. 현재 동작의 living doc은 `be/CLAUDE.md`다.

> **먼저 읽을 것:** 2026-09-05 브라우저 캡처 설계의 일부 결정은
> [2026-09-07 capture-hardening 설계](../specs/2026-09-07-live-recording-capture-hardening-design.md)
> §1의 우선순위 표가 **덮어썼다**. 특히 "파일 길이가 append 오프셋의 진실" → **DB의
> `committed_bytes`가 진실**, "워커 오류는 회의 실패" → **미리보기만 종료**, "회의 생성 뒤
> getUserMedia" → **캡처 준비 완료 뒤 회의 생성**, "Worklet 중지 후 메인 버퍼 전송" →
> **flush ACK 뒤 전송 종료**. 두 스냅샷이 부딪히면 나중 문서가 이긴다.

| § | 스펙 | 실제 | 왜 이쪽인가 |
|---|---|---|---|
| 2.1 | `MicSource`는 **동작하는** 참조 구현으로 남는다 | 계약 슬롯은 남되 `_default_live_source`가 즉시 PERMANENT 거절 | 캡처를 브라우저로 옮긴 뒤 mic 세션은 조용히 틀린 결과를 만든다 — 정본과 미리보기가 다른 소리가 되고 stop 뒤 4시간을 돌며 그동안 새 녹음이 전부 막힌다. 시작조차 못 하는 편이 낫다. `MicSource`와 테스트는 시스템 오디오가 들어올 자리의 참조로 남는다 |
| 4.7 | 사용자가 stop을 눌렀는데 0바이트면 회의를 지운다 | 마무리할 워커가 없을 때만(queued·failed) | 워커가 `running`이면 그가 세션을 소유한다. 그 아래에서 회의를 지우는 것이 §2.11이 경계하는 바로 그 파괴적 동작이다 |
| 6.1 | `position_ms`는 `TailSource`에만 | `AudioSource` 프로토콜에 선언 + `FileSource`/`MicSource` 구현 | 의도적 개선. 참고로 이 저장소엔 정적 타입 검사기가 없다(ruff select `[E,F,I,UP,B]`, mypy/pyright 없음) — 프로토콜 선언은 문서일 뿐 강제력이 없다 |
| 8 (5단계) | feature flag를 `POST /meetings/live`에 둔다 | flag 없음 | 배포 순서 사고를 막으려는 장치인데, API·워커·embed가 전부 같은 호스트에서 같이 배포되는 단일 기계 self-hosted 모델이라 그 창이 실질적으로 없다. 게다가 옛 워커가 browser payload를 받으면 `Literal["mic"]` 검증에 걸려 **PERMANENT 잡 실패**가 되지 손상이 되지 않는다 — 시끄럽게 죽는다 |

§3.3.1(봉인 후 크기 단언), §3.4(stop의 `X-Capture-Elapsed`), §4.2(`set_recording_started`),
§5.3·§7(`capture_error`), §2.11·§7(워커 죽음)은 **코드를 스펙에 맞춰 닫았다.**

---

## 4. 이 브랜치 밖의 관찰

- **`transcribe_failed` 비율.** `mtg_15`가 63발화 중 11개(17.5%). 라이브 회귀가 아니다 —
  업로드로 만든 `mtg_10`이 16.6%, `mtg_9`가 24.9%다. 반면 `mtg_4~8`은 0~1.6%. 전부 짧은
  구간(평균 1.7초)에서 난다. 별도로 볼 값이 있다.
- **공유 e2e 하네스의 `socket hang up` flake.** 베이스라인에서도 재현되고, 단언 불일치가 아니라
  소켓 레벨이며, 실패 파일이 실행마다 다르고 라이브와 무관하다. 이 브랜치의 회귀가 아니다.
  (2026-09-06 재확인: 3회 중 1회 재현, 같은 서명.
  2026-09-07 `585e358`에서 be 전체 스위트 2회 — 둘 다 41/41 스위트·454/454 테스트 통과,
  재현 없음. 두 번째 실행은 API·워커가 떠 있는 상태, 즉 자원 경합이 있는 조건이었다.
  **재현되지 않았다는 것이 원인이 밝혀졌다는 뜻은 아니다** — 표본이 늘었을 뿐이다.)
- **`live-crash.e2e-spec.ts`의 `replay()` 헬퍼에 `exit` 리스너가 없다.** 형제인 `crashAt`에는
  있다. 재기동한 자식이 시작하자마자 죽으면 stderr가 삼켜진 채 jest 타임아웃까지 매달린다 —
  위 flake가 이 파일에서 났을 때 읽을 수 없었던 이유로 유력하다. 아직 안 고쳤다.
- **미해명 단일 관측:** Task 11 조사 중 200 대신 403을 한 번 봤다. 명명 가능한 두 기전은
  실험으로 배제됐고, 당시 측정은 서브에이전트와 동시에 전체 스위트를 돌린 자원 경합으로
  오염돼 있었다. 재현되면 그때 판단한다.

---

## 부록 — SDD 원장

실행 중의 판단 40여 건(각각 "틀렸을 때 비용" 포함)과 Task별 브리프·리포트·리뷰 diff는
`.superpowers/sdd/2026-09-05-live-recording-browser-capture/`에 있다(gitignore). 이 문서로
옮겨야 할 내용은 다 옮겼으므로 지워도 된다.
