# 라이브 녹음(브라우저 캡처) 이월 항목

`feat/live-recording` 브랜치를 머지하기 전후로 남은 일 목록.

출처는 셋이다 — (1) 2026-09-05 최종 브랜치 리뷰(`347b983..2f80836`, 21커밋, 7,316줄 diff),
(2) Task별 리뷰가 minor로 미룬 항목들, (3) 그 뒤 fix wave 여섯 개와 실기기 스모크.

관련 문서:
[설계](../specs/2026-09-05-live-recording-browser-capture-design.md) ·
[구현 플랜](2026-09-05-live-recording-browser-capture.md)

---

## 0. 지금 상태

**실기기 스모크는 통과했다.** 2026-09-06, 회의 `mtg_15`, 6분 17초.

| 확인한 것 | 결과 |
|---|---|
| 잡 체인 | `live_session`(source=browser) → `process_meeting` → summarize/index/lenses 전부 `done` |
| `meeting.error` / `meeting.capture_error` | 둘 다 NULL |
| 바이트 회계 | 파일 = `sealed_bytes + 44`, WAV data 청크 = `sealed_bytes`, 11,802프레임 정수 정렬 |
| 봉인 모양 | 368 풀 청크(32768B) + 26프레임(26,624B) 꼬리 — stop이 꼬리를 싣는 §3.4 그대로 |
| 길이 일치 | `sealed/32000` = `meeting.duration_ms` = ffprobe(live.wav) = ffprobe(normalized.flac) = 377.664s |
| 시각 정합 | 오디오 종료 추정 시각과 `stop_requested_at`의 차이 **6ms** — 유실된 청크 없음 |
| 오디오 연속성 | 정확한 0 샘플이 200ms 이상 이어지는 구간 0개 — 묵음으로 메워진 구멍 없음 |
| 전사 | 63발화, 화자 5명, 요약·렌즈·인덱스 완료 |

**따라서 정상 경로(happy path)는 검증됐다.** 아래는 전부 *실패 경로*와 위생 항목이다 —
이번 스모크에서 아무것도 실패하지 않았기 때문에 하나도 태워지지 않았다.

### 이미 닫힌 것 (다시 하지 말 것)

| 커밋 | 내용 |
|---|---|
| `ef8658c` | stop 스플라이스 — 레코더 실패 후 큐가 남은 채 stop하면 `[오디오][구멍][마지막 1초]`를 이어 붙여 완전한 것처럼 봉인하던 문제. 이제 마지막 연속 오프셋에서 빈 본문으로 봉인한다. `enqueue()`의 `status.failed` 가드도 같은 커밋 |
| `2a601d3` | `X-Capture-Elapsed`를 POST 시각이 아니라 **프레임 도착 시각**에 찍는다. `startedAt`도 `connect(node)` 이후로 옮겨 권한 프롬프트 대기가 갭으로 오탐되지 않게 했다 |
| `ac14be8` | `new AudioContext()`를 기존 `try` 안으로 — 생성자가 던지면 마이크가 켜진 채 새던 문제 |
| `aa29c75` | 라이브 파일이 `meetings/<id>/original.wav`가 아니라 스펙대로 `live.wav`에 쓰인다 (`meetingKey()`가 basename을 무시하고 있었다) |
| `0adf4d5` | `buildLiveSessionPayload`의 `source` 기본값을 `browser`로. **빌더 출력을 고정하는 테스트를 같이 넣었다** — 아무 테스트도 안 보고 있어서 잘못된 기본값이 402개 백엔드 테스트에 안 걸렸다 |
| `cbbdcc3` | SMOKE.md 6단계에 `capture_error IS NULL` 확인 추가 |

---

## 1. P0 — 머지 전에 판단이 필요한 것

### 1.1 레코더 실패가 `meeting.capture_error`에 절대 도달하지 않는다

`fe/src/features/meeting/lib/live-recorder.ts` `fail()` · `live-session.ts` · `live.service.ts:139`

설계 §5.3과 §7 실패표는 `track.onended`(마이크 뽑힘)와 큐 상한 초과가 `capture_error`에
남아야 한다고 쓴다. 실제로는 `fail()`이 로컬 상태만 바꾸고 토스트를 띄운다. `postStop`은
사유를 싣지 않고, stop 엔드포인트는 사유를 받지 않는다.

**40분 녹음의 3분째에 마이크를 잃은 회의와 깨끗한 회의가 서버에서 구별되지 않는다.**
탭을 닫으면 그 사실의 유일한 기록이 사라진다. `capture_error` 컬럼은 정확히 이걸 막으려고
(§2.10) 만들어졌고, 쓰는 쪽(`live.setCaptureError`)도 있는데, 써야 할 호출자가 안 쓴다.

닫으려면 stop 요청에 실패 사유를 실을 자리가 필요하다 — 헤더 하나 또는 본문 앞의 작은
JSON. 프로토콜 변경이라 스펙 §3.4를 같이 고쳐야 한다.

이번 스모크가 이 항목을 검증하지 못한 이유: 아무것도 실패하지 않았다.

### 1.2 `reapStale`이 멀쩡한 라이브 녹음을 죽인다

`be/src/jobs/jobs.repository.ts:138-142` (이 브랜치가 건드리지 않은 줄)

`fail_meetings` CTE의 조건이 `type IN ('process_meeting','live_session')`이다. 워커가 라이브
잡을 claim한 뒤 죽으면 `REAPER_STALE_MINUTES`(기본 30분) 후 회수되는데,
`attempts=1 >= max_attempts=1`이라 영구 실패로 처리되고 **`meeting.status='failed'`까지 끌고
간다** — 브라우저는 여전히 업로드 중이고 API는 여전히 파일을 쓰고 있는데도.

설계 §2.11("녹음은 워커 생존에 의존하지 않는다")은 이 재설계의 두 기둥 중 하나이고,
§7 표는 워커 죽음을 "녹음은 계속. 미리보기만 없고"라고 쓴다. 이 줄은 **워커가 캡처자였을
때는 옳았고**, 재설계가 그걸 틀리게 만들었는데 아무도 다시 안 봤다.

오디오는 디스크에 살아남지만 회의는 failed가 되고, 그 뒤 브라우저는 `buffer_overflow`가
날 때까지 헛돈다.

닫는 법: `fail_meetings`의 타입 목록에서 `live_session`을 뺀다. 다만 그러면 라이브 잡이
`failed`인데 회의는 `recording`인 상태가 생기므로, orphan 스위퍼가 그걸 집어 봉인·finalize
하는지 확인해야 한다(`live-orphan.service.ts`의 후보 질의는 `last_input_at` 기준이라 아마
집는다 — 확인 필요).

이번 스모크가 검증하지 못한 이유: 워커가 30분간 죽어 있어야 한다.

---

## 2. P1 — 곧 고칠 것

| # | 위치 | 내용 |
|---|---|---|
| 2.1 | `be/src/live/live.service.ts:204` | `markUploaded(c, meeting.id, sealedBytes / 32)` — **부동소수**다. 워커는 `sealed // 32`(정수). `sealed`가 32로 안 나눠지면 node-postgres가 `int4` 파라미터에 `'1.0625'`를 보내 `invalid input syntax for type integer` → stop이 500. 지금 FE에서는 도달 불가(워크릿이 1024바이트 프레임만 낸다)지만 **계약상으로는 도달 가능**하다 — 400 검증이 요구하는 건 "짝수"뿐이다. `Math.floor` 한 글자 |
| 2.2 | `fe/src/features/meeting/api/live.ts:152` | 409에 `expected_offset`이 없으면 클라이언트 오프셋이 오염된다. 서버가 `'meeting is not recording'`이나 `io_error`로 409를 던질 때 오프셋을 안 싣는데(종단 상태라 재동기화 대상이 아니라는 판단은 유효), 클라이언트는 `res.data.expected_offset`을 그대로 읽어 `undefined`를 대입 → `X-Audio-Offset: undefined` → 400 → 무한 재시도 → 60초 뒤 엉뚱한 메시지로 `buffer_overflow`. **숫자가 아닌 409는 하드 실패로 처리**해야 한다 |
| 2.3 | `be/src/storage/live-audio.service.ts` `create()` | write/datasync 실패 시 `<key>.tmp`를 지우지 않는다. 설계 §4.1 실패 매트릭스가 요구하는데 빠졌다(플랜에서 상속된 결함). 회의를 지울 때까지 남는다 |
| 2.4 | `be/worker/tests/test_tail_source.py` `test_ignores_header_size_fields` | 회귀 시 **실패하지 않고 hang한다**. `sealed=FRAME_BYTES`인데 리더가 퇴행하면 `available`이 영영 `sealed`에 못 닿아 무한 루프. `pyproject.toml`에 `pytest-timeout` 설정이 없다. 493개 테스트 스위트에서 hang은 실패보다 나쁘다 |
| 2.5 | `be/worker/damwha_worker/audio/tail_source.py:82` | `_available()`의 `os.path.getsize`가 무방비다. `_open()`은 `FileNotFoundError`를 조심스럽게 다루는데 여기는 안 한다. 세션 도중 회의 삭제로만 도달하고, `io_error`가 아니라 미분류 잡 실패로 표면화된다. `_open()`도 `FileNotFoundError`만 잡아 `PermissionError` 등 다른 `OSError`는 분류 없이 전파 |
| 2.6 | `be/src/live/live.repository.ts` `findLiveJob` | `LIMIT 1`이 없다. 유일한 writer가 `LiveService.start()`이고 재시도 경로가 없어 오늘은 안전하지만, **스키마가 아니라 호출부 규율로만 보장된다**. 한 단어 |
| 2.7 | `be/test/meetings.e2e-spec.ts` (cancel 락 순서 테스트) | 200ms 고정 대기. 다른 두 sleep(`test_live_session.py`의 0.1초 음성 단언 창)과 종류가 다르다 — 이건 "요청이 락에 닿을 시간을 준다"이므로, 느린 머신에서 probe가 요청보다 먼저 돌면 **테스트가 공허하게 통과한다**. 같은 파일에서 이미 한 번 고친 실패 양식이다. `pg_stat_activity`로 대기자를 폴링하거나 비공허성을 단언할 것 |
| 2.8 | `be/worker/tests/test_contracts_live.py:74` | `test_unknown_source_is_rejected`가 같은 파일 57행 `test_rejects_unknown_source_and_future_version`과 중복. 같은 fixture로 같은 `source="system"` 거부를 본다. red였던 적이 없어 TDD 증거도 아니다. 삭제 |
| 2.9 | `fe/src/features/meeting/api/types.ts:161` | `MeetingStatusResponse.capture_error`가 죽은 필드. 실제로 읽히는 건 `WireMeeting.capture_error`(`mappers.ts:271`)뿐이다. 백엔드 `findStatus`의 컬럼은 그대로 둔다(무해하고 상태 엔드포인트가 완전해진다) |
| 2.10 | `fe/src/features/meeting/lib/pcm-worklet.ts:18` | `declare global` 블록이 `tsconfig.app.json` include 대상 안에 있고 이 파일엔 top-level import/export가 없다 — `moduleDetection`으로만 모듈이라 **최소·불완전한 `AudioWorkletProcessor` 선언이 프로그램 전역**이다. 훗날 TS가 진짜 lib 타입을 실으면 중복 식별자로 충돌한다 |
| 2.11 | `be/test/live.e2e-spec.ts` | `'rejects appends after the session is sealed'`가 409만 보고 `expected_offset`을 확인하지 않는다. 그 값이 곧 ACK 프로토콜이다(코드는 옳게 반환하고 있다) |
| 2.12 | `be/worker/damwha_worker/db.py:995` | `set_recording_started`가 죽은 프로덕션 코드. 호출자는 `tests/test_db_live.py:18-26`뿐. 설계 §4.2가 호출을 지우라고 했고 호출은 지워졌는데 함수와 테스트가 남았다 |

---

## 3. P2 — 방어적 · 오늘은 도달 불가

- **`markUploaded`가 `rowCount`를 안 본다** (`meetings.repository.ts:173-177`). 워커의
  대응 코드(`db.py:1078-1099`)는 0이면 `"discarded"`로 중단한다. 두 API 호출자 모두 양쪽
  행 락 아래에서 `current_job_id`를 먼저 검증하므로 방어용일 뿐이지만, 이 비대칭 때문에
  가드가 조용히 빗나가도 API 경로는 `process_meeting`을 큐잉하고 `current_job_id`를 옮긴다.
  `if (rowCount === 0) throw` 한 줄이면 이 규약이 자기강제된다.
- **`stop()`의 멱등 분기가 항상 `outcome: 'stopping'`을 보고한다** (`live.service.ts:160`),
  원래 호출이 finalize까지 했더라도. ACK 유실 후 재시도한 stop이 클라이언트에게 "영영
  움직이지 않을 워커를 기다리라"고 말한다. 오늘은 무해(FE는 `discarded`만 구별).
- **orphan 스위퍼가 `queued`도 `running`도 아닌 잡을 봉인만 하고 finalize 안 한 채 둔다**
  (`live-orphan.service.ts:76-78`). 후보 질의가 `sealed_bytes IS NOT NULL`을 제외하므로 다시
  안 온다. §3.4 재작성으로 `stop()`에서 사라진 세 번째 분기와 같은 모양이다. 그 상태에
  도달하는 경로를 구성하지 못했다 — 라이브 잡을 `failed`/`done`으로 만드는 모든 writer가
  회의도 `recording`에서 옮기기 때문(`reapStale` 포함). **1.2를 고치면 이 전제가 깨진다** —
  같이 봐야 한다.
- **첫 레코더의 `start()`가 resolve하기 전 두 번째를 만드는 것에 대한 클라이언트 가드 부재.**
  `getUserMedia` 도중의 stop은 no-op이고 대기 중인 `start()`가 그 뒤에 마이크를 열 수 있다.
  `createLiveRecorder`가 이전 레코더를 먼저 멈추고(a1ccda3) `meeting_single_recording_idx`가
  한 `getUserMedia` 창 안의 두 번째 `POST /meetings/live`를 금지하므로 도달 불가. 고치려면
  실제 기계(`starting` 플래그나 abort 토큰)가 필요하다.
- **orphan sweep이 `done`으로 만든 전이가 앰비언트 폴링에만 의존한다.** 사용자 stop은 명시적
  `invalidateQueries`를 받지만 스위퍼 전이는 페이지가 마침 마운트돼 있을 때의 2.5초 폴링에만
  의존한다. 60초 `staleTime` 창 안에 재방문하면 `captureError`가 빠진 낡은 스냅샷을 볼 수
  있다. 이 기능이 만든 게 아니라 서버측 상태 변화 전반의 특성.
- **`CHUNK_MS = 1024`**(`live-recorder.ts:14`)가 `pcm-convert.ts`에서 유도 가능한 값을 중복.
  그쪽이 바뀌면 조용히 어긋난다.

### 반복되는 모양 하나

"마이크는 켜졌는데 아무것도 캡처되지 않음"이 이 코드에서 **세 번** 나왔다(생성자 throw,
두 번째 레코더 경합, `getUserMedia` 중 stop). 경로를 하나씩 기우는 대신 불변식 하나를
명시할 값이 있다 — *`start()`는 스트림을 할당 시점부터 첫 프레임까지 소유하고, 모든 종료
경로가 그것을 반납한다.*

---

## 4. 스펙과 코드가 어긋난 곳

최종 리뷰의 12행 표에서 이후 fix wave가 닫은 것(§2.2 파일 경로, §3.3.2 갭 시계)을 뺀 나머지.
**여러 행이 코드가 지키지 않는 약속으로 읽힌다** — 머지 전에 스펙을 고치든 코드를 고치든
한쪽으로 정리해야 한다.

| § | 스펙 | 코드 |
|---|---|---|
| 2.1 | `MicSource`는 동작하는 참조 구현으로 남는다 | **`mic` 세션은 오디오 파일을 아무도 쓰지 않는다.** 워커가 호스트 마이크를 전사하는 동안 API는 브라우저 바이트를 저장하고, `MicSource`가 `sealed_bytes`를 보지 않으므로 stop 후 `max_minutes`(4시간)까지 돈다. T15가 더한 `position_ms`는 프레임 회계만 고친다. → **`mic` 경로를 지우거나 스펙에서 내리는 것이 정직하다** |
| 3.3.1 | 봉인 직후 `stat.size - 44 == sealed_bytes`를 assert한다 | 그런 단언이 없다. 가드된 append로 산술상 함의되지만 명시적 그물은 없다 |
| 3.4 | stop이 `X-Capture-Elapsed`를 싣는다 | FE는 보내는데 `LiveService.stop`이 읽지 않는다 — 꼬리 구간의 불연속을 감지할 수 없다 |
| 4.2 | 워커의 `set_recording_started` 호출은 지운다 | 호출은 지웠고 함수·테스트가 죽은 코드로 남았다 (2.12) |
| 4.7 | 사용자가 직접 stop을 눌렀는데 0바이트면 회의를 지운다 | 잡이 아직 `queued`일 때만. 워커가 돌고 있으면 0바이트 stop이 0에서 봉인 → 워커가 `audio_device_failed` → 회의 `failed`, 삭제 아님 |
| 5.3, 7 | `track.onended` / 큐 상한 초과 → `capture_error` | 브라우저 로컬 토스트·배너뿐 (1.1) |
| 2.11, 7 | 워커 죽음 → 녹음은 계속 | `reapStale`이 회의를 failed로 (1.2) |
| 6.1 | `AudioSource` 프로토콜은 건드리지 않는다. `position_ms`는 `TailSource`에만 | T15가 프로토콜에 선언하고 `FileSource`/`MicSource`에도 구현했다. **의도적 개선이므로 스펙 쪽을 고치면 된다.** (참고: 이 저장소엔 정적 타입 검사기가 없다 — ruff select가 `[E,F,I,UP,B]`이고 mypy/pyright 설정이 없다. 프로토콜 선언은 문서일 뿐 강제력이 없다) |
| 8 (5단계) | flag를 `POST /meetings/live` 지점에 둔다 — 마이그레이션만 적용된 환경에서 browser payload가 enqueue되지 않게 | flag가 없다(`env.demoMode`가 유일한 게이트). 기본값이 이미 browser로 뒤집혔으므로 **§3.2의 배포 순서 보장이 지금 비어 있다** |
| 9 | 동시성 테스트 셋: cancel↔append, queued-finalize↔worker-claim, running-worker-finalize↔orphan-seal | 셋 다 없다 |

---

## 5. 테스트가 못 잡는 곳

세 메커니즘(오프셋/ACK, 봉인 핸드셰이크, orphan 스윕)은 전부 서버측이고 서버측은 잘 덮여
있다. **실제 공백은 클라이언트다.**

- `live-recorder.test.ts`에 업로드 루프 테스트 5개, 게이트 테스트 7개, **stop 테스트 0개.**
  유일한 stop 커버리지가 `meeting-live.test.tsx:212`의 정상 경로다. "레코더를 실패시키고
  큐가 남은 채 stop해서 `X-Final-Offset`을 단언"하는 테스트 하나면 stop 스플라이스(ef8658c
  가 고친 것)를 즉시 잡았을 것이다. **회귀 그물로 지금이라도 넣을 값이 있다.**
- `pcm-worklet.ts`는 여전히 **자동 커버리지 0**이다(jsdom에 `AudioContext`가 없다). 실기기
  스모크 체크리스트 2단계가 유일한 그물.
- orphan 스윕에 §9가 요구한 "`last_input_at`은 낡았는데 파일은 더 긴 경우"가 없다.
- 409에 `expected_offset`이 **없는** 경우를 덮는 테스트가 없다 (2.2와 한 벌).

---

## 6. 이 브랜치 밖의 관찰

- **`transcribe_failed` 비율.** `mtg_15`가 63발화 중 11개(17.5%). 라이브 회귀가 아니다 —
  업로드로 만든 `mtg_10`이 16.6%, `mtg_9`가 24.9%다. 반면 `mtg_4~8`은 0~1.6%. 전부 짧은
  구간(평균 1.7초)에서 난다. 별도로 볼 값이 있다.
- **공유 e2e 하네스의 `socket hang up` flake.** 베이스라인에서도 재현되고(n=10 중 2회),
  실패 파일이 실행마다 다르며 라이브와 무관하다. 이 브랜치의 회귀가 아니다.
- **미해명 단일 관측:** Task 11 조사 중 200 대신 403을 한 번 봤다. 명명 가능한 두 기전은
  실험으로 배제됐고, 당시 측정은 서브에이전트와 동시에 전체 스위트를 돌린 자원 경합으로
  오염돼 있었다. 재현되면 그때 판단한다.

---

## 부록 — SDD 원장

실행 중의 판단 40여 건(각각 "틀렸을 때 비용" 포함)과 Task별 브리프·리포트·리뷰 diff는
`.superpowers/sdd/2026-09-05-live-recording-browser-capture/`에 있다(gitignore). 이 문서로
옮겨야 할 내용은 다 옮겼으므로 지워도 된다.
