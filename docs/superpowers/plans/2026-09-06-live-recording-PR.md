# feat(live): 실시간 녹음 — 브라우저 캡처

`feat/live-recording` → `main`

브라우저가 마이크를 잡아 API로 흘리고, API가 WAV의 유일한 writer가 되며, 워커는 자라는 파일을
따라 읽는다. 회의가 `recording`인 동안 실시간 자막이 흐르고, 종료하면 그 파일이 그대로 기존
`process_meeting` 파이프라인으로 넘어간다.

---

## 왜

기존 업로드 경로는 "이미 있는 파일"만 다뤘다. 실시간 녹음을 처음 붙일 때는 워커 Mac의 마이크를
열었는데(원 설계 §2.1), 그러면 **녹음하는 사람과 서버가 같은 기계에 있어야 한다.** 브라우저는
이미 사용자 앞에 있고 `getUserMedia`도 거기 있다. 캡처를 브라우저로 옮기면 그 결합이 사라지고,
덤으로 "워커가 죽어도 녹음은 계속된다"가 성립한다.

설계 문서 둘을 **순서대로** 읽어야 한다. 두 번째가 첫 번째의 §2.1을 뒤집는다.

1. [`2026-09-05-live-recording-design.md`](../specs/2026-09-05-live-recording-design.md) — 원 설계
2. [`2026-09-05-live-recording-browser-capture-design.md`](../specs/2026-09-05-live-recording-browser-capture-design.md) — **캡처 주체를 뒤집는다**

현재 동작의 living doc은 [`be/CLAUDE.md`](../../../be/CLAUDE.md)의 "Live session is a fifth job
type"이다. 스펙은 사후 편집하지 않는 스냅샷이므로, 스펙과 코드가 갈린 네 지점은
[이월 문서](2026-09-06-live-recording-followups.md) §3에 이유와 함께 적었다.

---

## 무엇이 도는가

```
브라우저                          API                        워커
────────                          ───                        ────
getUserMedia
  → AudioWorklet (512샘플 프레임)
  → 32,768B 청크(1.024초)
       ──POST /live/audio────▶  live.wav에 append
          X-Audio-Offset          + fdatasync
                                  expected = size - 44
       ◀──200 expected_offset──   409면 그 값으로 재동기화
                                                        ◀── tail (EOF = "따라잡음")
                                                            live_utterance 미리보기
  종료
       ──POST /live/stop─────▶  마지막 꼬리 append
          + 꼬리 body            + job.sealed_bytes 봉인
                                                        ◀── sealed까지 읽고 finalize
                                  meeting → uploaded
                                  process_meeting 큐잉 ──▶ 정본 전사
```

**시각 자료:** [`docs/diagrams/live-recording.sequence.html`](../../diagrams/live-recording.sequence.html)
— 브라우저를 열면 검색·경로 추적이 되는 단일 파일.

### 왜 이 모양인가 — 세 가지 결정

**오프셋/ACK.** 청크마다 `X-Audio-Offset`(PCM 바이트, 헤더 제외)을 명시하고, 서버는 파일 크기에서
`expected`를 유도한다. 불일치는 **409에 `expected_offset`을 실어** 돌려주므로 ACK가 유실돼도
구멍 없이 재동기화된다. 동시 요청은 하나. 재동기화할 오프셋이 없는 409는 종단이라 하드 실패로
끊는다 — 그러지 않으면 클라이언트 오프셋이 `undefined`가 돼 이후 모든 요청이 400을 받고 **봉인
자체가 불가능해진다.**

**`job.sealed_bytes`가 유일한 EOF 권위.** 파일 append·WAV 헤더 재작성·DB commit 셋은 한
트랜잭션이 될 수 없으니 셋 중 무엇이 진실인지 정해야 한다. 그래서 `TailSource`는 **EOF를 "끝"이
아니라 "따라잡음"으로** 다루고, 헤더의 크기 필드는 절대 읽지 않는다(봉인 순간 API가 그 두 필드를
고치는데, 전환 중의 값을 믿으면 전사가 조기 종료된다). stop이 마지막 꼬리를 **본문에 싣고 와서**
마지막 청크와 봉인 사이의 창을 없앤다.

**녹음은 워커 생존에 의존하지 않는다.** 오디오를 브라우저가 보내고 API가 쓰므로 워커가 죽어도
녹음은 계속된다 — 잃는 것은 실시간 자막뿐이다. 그래서 "누가 finalize하는가"가 이 기능의
하중을 받는 술어가 되고, 그 값은 `job.status !== 'running'`이다(queued = 아직 claim 안 됨,
failed = reaper가 워커를 잃었다고 판정). 워커 생존 판정은 **reaper 하나만** 한다 — 두 번째
임계값을 만들면 둘이 어긋난다.

---

## 변경 범위

| | |
|---|---|
| 커밋 | 123 (`bee5c92` 이후) |
| 전체 | 212 파일, +57,453 / −637 |
| **코드만** | **118 파일, +9,238 / −610** |
| 마이그레이션 | `021` `022` `023` (전부 additive) |
| 테스트 | BE 412 · worker 492 · FE 477 — 전부 통과, 빌드·린트 클린 |

### 마이그레이션

전부 additive라 롤백해도 옛 코드가 돈다.

- `021_meeting_recorded_at_not_null.sql`
- `022_live_session.sql` — `live_utterance` 테이블, `job.stop_requested_at`
- `023_live_browser_capture.sql` — `job.sealed_bytes`, `job.last_input_at`, `meeting.capture_error`

`meeting.capture_error`가 `meeting.error`와 **별개**인 이유: finalize와 persist가 둘 다
`error=NULL`을 쓰므로, "이 녹음을 어떻게 얻었는가"는 최종 패스가 성공해도 살아남는 필드가
따로 있어야 한다. "40분 중 30분만 녹음됐다"는 회의가 `done`이 된 뒤에도 보여야 한다.

### 새 엔드포인트

| | |
|---|---|
| `POST /meetings/live` | 녹음 시작 — `recording` 회의 + `live_session` job |
| `POST /meetings/:id/live/audio` | PCM 청크 append (`X-Audio-Offset`, `X-Capture-Elapsed`) |
| `POST /meetings/:id/live/stop` | 꼬리 + 봉인 (`X-Audio-Offset`, `X-Final-Offset`, `X-Capture-Error?`) |
| `GET /meetings/:id/live?after=` | 실시간 자막 커서 조회 |

### 세 언어가 합의해야 하는 상수

`SR=16000` · `FRAME_BYTES=1024` · `CHUNK_BYTES=32768` · `HEADER_LEN=44` · **32 bytes/ms**
— `live.service.ts`, `tail_source.py`, `pcm-convert.ts`. 하나를 바꾸면 셋을 같이 바꾼다.

---

## 검증

### 실기기 스모크 (mtg_15, 6분 17초)

합성 테스트가 못 덮는 구간(`getUserMedia`, 워크릿 로딩, 업로드 루프)의 유일한 그물.

| 확인 | 결과 |
|---|---|
| 잡 체인 | `live_session`(browser) → `process_meeting` → summarize/index/lenses 전부 `done` |
| `error` / `capture_error` | 둘 다 NULL |
| 바이트 회계 | 파일 = `sealed_bytes + 44`, WAV data 청크 = `sealed_bytes`, 11,802프레임 정수 정렬 |
| 봉인 모양 | 368 풀 청크 + 26프레임 꼬리 — stop이 꼬리를 싣는 §3.4 그대로 |
| 길이 | `sealed/32000` = `duration_ms` = ffprobe(wav) = ffprobe(flac) = 377.664s |
| **시각 정합** | 오디오 종료 추정과 `stop_requested_at`의 차이 **6ms** — 유실 청크 없음 |
| 연속성 | 정확한 0 샘플이 200ms 이상 이어지는 구간 **0개** |
| 전사 | 63발화, 화자 5명 |

### 조용한 손실을 잡는 테스트

이 기능의 실패 양식은 "터지는 것"이 아니라 **"짧아진 채 정상으로 보이는 것"**이라, 그쪽에 테스트를
몰았다.

- 같은 오프셋 동시 append 둘 → **파일 크기**를 단언(상태 코드가 아니라)
- 꼬리가 이미 디스크에 있을 때의 stop 재개 → `44 + CHUNK + 1024` 단언(이중 append를 잡는다)
- 봉인 후 append 409 → `expected_offset`까지 단언
- 레코더 실패 후 stop → 큐에 남은 구멍 위에 꼬리를 잇지 않고 마지막 연속 오프셋에서 봉인
- 워커가 `sealed_bytes`에서 정확히 끝나는지 / 짧은 read를 EOF로 오인하지 않는지
- `TailSource` 테스트의 가짜 시계에 sleep 상한 — 종료 조건 회귀가 hang이 아니라 **실패**가 된다

### 알려진 flake

공유 e2e 하네스의 `socket hang up`이 3회 중 1회 재현된다. **이 브랜치의 회귀가 아니다** —
베이스라인에서도 재현되고, 단언 불일치가 아니라 소켓 레벨이며, 실패 파일이 실행마다 다르고
라이브와 무관하다.

---

## 리뷰어가 볼 곳

우선순위 순. 나머지는 이 넷의 따름이다.

1. **`be/src/live/live.service.ts`의 `stop()`** — 세 갈래(정상·재개·409)가 §3.4 전부다.
   ③ 직전 크래시를 복구 가능하게 만드는 규칙이 여기 다 있다.
2. **`be/src/live/live-orphan.service.ts`** — 두 일을 한다. 버려진 producer 봉인(90초)과,
   **마무리할 워커가 없는 이미 봉인된 세션의 finalize**. 후자가 없으면 브라우저+워커 동시
   사망이 회의를 `recording`에 영원히 가두고 부분 유일 인덱스가 다음 녹음을 전부 막는다.
3. **`be/worker/damwha_worker/audio/tail_source.py`** — EOF 의미론과 드리프트 건너뛰기.
   종료 조건이 `available >= sealed`인 것이 요점이다(`yielded`가 아니다 — 부분 프레임에서
   영원히 안 끝난다).
4. **`fe/src/features/meeting/lib/live-recorder.ts`의 `stop()`** — 실패 후 종료 절차.

**잠금 순서는 job → meeting**이고 다섯 writer 전부(`appendAudio`·`stop`·`sweep`·
`MeetingsService.cancel`·워커의 `finalize_live_session`)가 지킨다. 회의 id에서 출발하는
경로는 양쪽 락을 잡은 뒤 `current_job_id`를 다시 확인한다. `be/src` 전체의 다른 `FOR UPDATE`를
훑어 역방향 간선이 없음을 확인했다.

---

## 다이어그램

[`docs/diagrams/`](../../diagrams/)에 archify 산출물 둘이 함께 들어간다. `.json`이 정본이고
`.html`은 거기서 결정적으로 컴파일된 의존성 없는 단일 파일이다(브라우저로 열면 검색·경로
추적·PNG/SVG 내보내기가 된다). 재생성 절차는 [README](../../diagrams/README.md)에 있다.

- `live-recording.sequence.html` — 이 PR의 한 세션 시간 순서
- `damwha-runtime.architecture.html` — 런타임 전체와 `job` 테이블 계약

머지 전에 아키텍처 다이어그램에서 **사실 오류 하나를 고쳤다**: `워커 child → 스토리지`가
"live.wav 기록"이라고 말하고 있었는데, 워커는 라이브 오디오를 쓰지 않는다. 이 PR이 뒤집은
바로 그 지점이라("API가 유일한 writer, 워커는 tail") 다이어그램이 옛 아키텍처를 주장하고
있었다. `live.wav tail`로 고치고 계약 카드에 그 방향을 한 줄 박았다.

---

## 남은 것

머지를 막지 않는 것들. 전부 [이월 문서](2026-09-06-live-recording-followups.md)에 있다.

- **P2 다섯 건** — 방어적이거나 오늘 도달 불가(`markUploaded`의 `rowCount` 미확인,
  멱등 stop의 `outcome` 부정확, 두 번째 레코더 경합 등)
- **스펙 §9의 동시성 테스트 셋** — 잠금 순서는 다섯 writer 전부에서 확인했지만 그걸
  *고정하는* 테스트는 append 경합 하나뿐이다. 나머지는 코드 리뷰로만 보장된다.
- **`pcm-worklet.ts`는 자동 커버리지 0** — jsdom에 `AudioContext`가 없다.
  `be/worker/SMOKE.md`의 실기기 절차가 유일한 그물이고, 그 2단계가 워크릿 로딩을 본다.

### 이 브랜치 밖

`transcribe_failed` 비율이 mtg_15에서 17.5%인데, 업로드로 만든 mtg_10(16.6%)·mtg_9(24.9%)와
같은 수준이다 — **라이브 회귀가 아니다.** 다만 mtg_4~8이 0~1.6%인 것과 대비되고 전부 짧은
구간(평균 1.7초)에서 나므로 별도로 볼 값이 있다.

---

## 되돌리기

`source` 기본값 한 줄(`0adf4d5`)을 되돌리면 브라우저 캡처가 꺼진다. 마이그레이션은 전부
additive라 스키마를 되돌릴 필요가 없다.
