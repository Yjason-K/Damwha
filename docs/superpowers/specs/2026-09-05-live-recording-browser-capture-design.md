# 라이브 녹음 — 브라우저 캡처 설계

**작성일:** 2026-09-05
**범위:** 실시간 녹음의 오디오 획득을 워커 Mac의 마이크에서 브라우저로 옮긴다. `fe/`, `be/`,
`be/worker/` 셋을 건드린다.
**관계:** [2026-09-05-live-recording-design.md](./2026-09-05-live-recording-design.md)의 §2.1을
뒤집는다. 그 문서는 스냅샷이라 고치지 않는다 — 뒤집힌 결정과 그 근거는 여기 §2.1에 있다.
나머지 결정(2-pass, 별도 `live_utterance` 테이블, 재시도 없음, 폴링, suggest 임계값)은 전부
그대로 유효하다.

## 1. 왜 바꾸는가

원 설계는 워커가 도는 Mac의 마이크를 `sounddevice`로 직접 열었다. 그 결정의 대가가 구현 후에
드러났다.

- **권한이 터미널 앱에 붙는다.** macOS TCC는 권한을 프로세스가 아니라 책임 앱에 귀속시킨다.
  워커를 띄운 터미널이 권한 주체가 되고, 사용자 안내가 "시스템 설정 › 개인정보 보호 및 보안 ›
  마이크에서 터미널 앱을 허용"이 된다. supervisor가 자식을 `start_new_session=True`로 spawn하는
  구조에서는 귀속이 더 불투명하다.
- **그래서 한 번도 끝까지 돌려본 적이 없다.** `be/worker/SMOKE.md`의 실측 표에 그대로 적혀
  있다: "`--mic`는 이 환경에 마이크 권한을 부여할 수 없어 실행하지 못했다." 검증된 것은
  `--file` 경로뿐이다.
- **워커를 headless로 못 돌린다.** launchd로 상주시키면 권한 프롬프트를 띄울 UI가 없다.
- **기기를 분리할 수 없다.** 노트북에서 회의에 들어가고 워커 Mac은 책상에 두는 구성이 로드맵에
  있는데, 워커 마이크로는 원리적으로 도달할 수 없다.

브라우저 캡처는 넷을 한꺼번에 없앤다. 권한은 표준 오리진 프롬프트이고, 장치 선택·권한 상태
조회·장치 분리 감지가 전부 플랫폼 API로 딸려 온다.

## 2. 결정

### 2.1 오디오는 브라우저가 잡는다 (원 설계 §2.1을 뒤집는다)

원 설계가 워커를 고른 이유는 둘이었다. 하나는 사실관계가 틀렸고, 하나는 유효하지만 지금
결정에 걸리지 않는다.

**"브라우저→API→워커로 오디오를 흘릴 길을 새로 파야 한다"는 절반만 맞다.** API는 컨테이너가
아니다. `be/docker-compose.yml`은 Postgres만 띄우고 API·워커·embed service는 전부 같은 호스트
프로세스다. `be/.env`의 `STORAGE_ROOT=./storage`와 `be/worker/.env`의 `../storage`가 같은
디렉터리를 가리키고, `StorageService`가 업로드에서 이미 그 길로 파일을 쓴다. 길은 있다.
없는 것은 append이지 경로가 아니다.

**"온라인 회의 상대방 소리는 호스트 시스템 오디오여야 한다"는 여전히 맞다.** 브라우저는 macOS
시스템 오디오도 네이티브 Zoom 소리도 못 잡는다. 다만 그 기능은 급하지 않고, `AudioSource`
프로토콜과 payload의 `source` 필드가 그 자리로 남는다. 마이크 경로를 브라우저로 옮기는 것과
나중에 시스템 오디오 구현체를 워커에 더하는 것은 충돌하지 않는다 — 단 §9.3의 제약이 붙는다.

`MicSource`는 지우지 않는다. 시스템 오디오 구현체가 들어올 자리의 참조 구현이자, `AudioSource`
프로토콜이 실제로 두 구현을 견디는지 보여주는 테스트 대상으로 남는다. 다만 기본 경로가 아니고
FE·문서·스모크에서 노출되지 않는다.

### 2.2 API가 WAV의 writer가 되고, 워커는 자라는 파일을 따라 읽는다

브라우저가 PCM 청크를 API에 올리면 API가 `meetings/<id>/live.wav`에 이어 붙이고, 워커는 그
파일을 tail한다. 대안은 청크를 seq별 임시 파일로 받아 워커가 소비해 WAV를 쓰는 것이었는데,
그러면 "워커가 유일한 writer"라는 형식만 지켜진다. 그 불변식이 원래 보호하던 것 — 추론이
느려져도 파일 쓰기가 막히지 않는다 — 은 캡처가 브라우저로 간 순간 이미 달성된다. API의 append는
whisper와 아예 다른 프로세스다. 중간 파일 한 겹은 순수 비용이다.

이 결정의 전제: **API와 워커는 같은 Mac에 있고 같은 파일시스템을 공유한다.** 분리 대상은
브라우저지 워커가 아니다. 워커를 다른 기기로 옮기는 것은 이 설계의 범위 밖이고, 그때는 tail이
성립하지 않아 streaming read API나 object storage가 필요하다(§9.4).

결과적으로 워커에서 `WavWriter`·`WriterThread`·`Capture`의 이중 큐·조인 순서 로직이 전부
사라진다. 미리보기 파이프라인(`LiveSegmenter` → whisper → ECAPA → `insert_live_utterance`)은
한 줄도 바뀌지 않는다. `AudioSource` 프로토콜이 정확히 그 경계였다.

### 2.3 획득은 getUserMedia + AudioWorklet. MediaRecorder는 기각

`MediaRecorder`(MediaStream Recording API)는 webm/opus를 낸다. 이 파일은 미리보기용이 아니라
**그대로 정본이 되므로**, 손실 압축을 거치면 STT와 화자 임베딩 품질을 되돌릴 수 없게 깎고
워커가 청크마다 ffmpeg 디코드를 해야 한다.

Web Audio + `AudioWorklet`은 raw PCM을 준다. `new AudioContext({ sampleRate: 16000 })`으로
컨텍스트 전체를 16 kHz에 고정하면 `createMediaStreamSource`가 마이크 입력을 리샘플해 주므로
리샘플러를 직접 쓸 일이 없다. `AudioWorkletProcessor.process()`의 렌더 퀀텀이 128샘플이라
**4개를 모으면 정확히 512샘플** — `be/worker/damwha_worker/audio/source.py`의 `FRAME_SAMPLES`와
그대로 맞는다. int16 변환만 얹으면 `MicSource`가 내던 것과 바이트 단위로 동일한 프레임이 된다.

다만 `sampleRate` 요청은 user agent가 만족하지 않을 수 있다. 생성 직후 실제
`audioContext.sampleRate`를 검증하고 16000이 아니면 녹음을 시작하지 않는다 — 48 kHz PCM에
16 kHz 헤더를 씌우면 느리고 낮아진 정본이 조용히 만들어진다(§5.2).

### 2.4 오디오 처리를 전부 끈다

```js
{ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false,
           channelCount: 1, deviceId } }
```

Chrome은 셋을 기본으로 켠다. AGC와 노이즈 억제는 신호를 변형해 ECAPA 임베딩과 정본 STT를
동시에 나쁘게 만든다. `MicSource`가 PortAudio로 받던 raw와 같은 지점을 맞추는 일이기도 하다.
되돌릴 수 있는 결정이다(§10).

### 2.5 전송은 초당 POST 하나. WebSocket은 넣지 않는다

원 설계 §2.7이 SSE를 뺀 논리가 대칭으로 적용된다. 이 저장소에 지속 연결 패턴이 하나도 없고,
WebSocket을 넣으면 연결 수명·재연결·백프레셔·프록시 설정이 전부 새로 생긴다. 초당 1회 POST는
재시도와 멱등성이 그냥 되고, 32 KB/s(시간당 115 MB)는 같은 Mac에서는 물론 LAN에서도 부담이
아니다. 압축은 필요해지면 그때 붙인다.

### 2.6 봉인의 권위는 파일이 아니라 `job.sealed_bytes`다

파일 append·WAV 헤더 재작성·DB commit 셋은 하나의 트랜잭션이 될 수 없다. SQL row lock은 DB
안에서만 유효하고 파일 연산을 rollback하지 못한다. 그래서 셋 중 무엇이 진실인지 정한다:
**DB가 이긴다.** 순서와 크래시 의미는 §4.3.

따라서 `TailSource`는 열린 세션 동안 WAV 헤더의 크기 필드를 읽지 않는다. 오프셋으로만
전진하고, short read는 EOF가 아니라 재시도이며, 진짜 EOF는 `sealed_bytes`가 채워졌고 거기
도달했을 때만 성립한다.

### 2.7 fsync를 켠다

원 설계 §5.2가 fsync를 뺀 근거는 "프로세스 crash에서는 page cache가 살아남는다"였다. 그건
지금도 맞지만, API가 writer가 되면서 **"200을 돌려줬다"는 사용자 약속**이 새로 생겼다. 전원
장애·kernel panic은 page cache를 지킨다는 가정 밖이다. 32 KB/s에 매 청크 `fdatasync`는 이
머신에서 측정 가능한 비용이 아니다. 봉인 시에는 데이터·헤더·부모 디렉터리까지 sync한다.

### 2.8 클라이언트 버퍼는 메모리만. 단 상한이 있다

미전송 청크를 IndexedDB에 영속화하지 않는다. 쿼터·정리·재개 UX가 v1 범위를 눈에 띄게 키우는데,
지금은 브라우저와 API가 같은 Mac이라 실질 손실 창이 1~2초다.

**대신 상한을 둔다.** 무한 재시도 큐는 Wi-Fi 단절이나 API hang에서 무한히 자라 탭 OOM으로
끝나고, OOM은 조용한 손실이다. 60초분(약 2 MB)을 넘으면 캡처를 중단하고 서버에 보이게
실패시킨다.

§2.9의 불변식은 이 설계에서 **"마지막으로 성공한 청크까지"**로 약해진다. 이것은 브라우저
캡처의 필연적 대가이며, 위 상한과 §5.3의 실패 표기가 그 약화를 조용하지 않게 만드는 장치다.

### 2.9 녹음은 워커 생존에 의존하지 않는다

브라우저가 캡처하고 API가 쓰므로, 워커가 죽어 있어도 녹음은 온전히 남는다. 미리보기만 없다.
원 설계에서는 워커가 없으면 job이 `queued`에 머물며 아무것도 녹음되지 않았다.

이 때문에 지금 `LiveService.stop`의 `queued` 분기 — "워커가 아직 마이크를 열지 않았다, 녹음된
게 없으니 회의째 지운다" — 는 **파괴적으로 틀린다.** §4.5에서 뒤집는다.

## 3. 데이터와 계약

### 3.1 마이그레이션 `023_live_browser_capture.sql`

```sql
-- 봉인된 최종 PCM 바이트 수(헤더 제외). 워커가 tail을 끝낼 유일한 근거 (§2.6).
ALTER TABLE job ADD COLUMN sealed_bytes bigint;
-- producer(브라우저) 생존 신호. append마다 갱신, 버려진 세션 판정에 쓴다 (§4.6).
ALTER TABLE job ADD COLUMN last_input_at timestamptz;
```

`meeting_single_recording_idx`, `live_utterance`, `job.stop_requested_at`은 그대로다.

두 컬럼 모두 `job`에 두는 이유: API→워커 방향 신호가 job 행에 실린다는 원칙이 `stop_requested_at`
에서 이미 성립했고, `sealed_bytes`는 실제로 워커가 읽는다. `last_input_at`은 API 내부용이지만
같은 세션의 같은 수명이라 같은 행에 둔다.

### 3.2 payload

`LiveSessionPayloadSchema`의 `source`에 `'browser'`를 더하고 기본값으로 삼는다.
**스키마 버전은 올리지 않는다** — 이 기능이 아직 머지 전이라 `live_session` payload가 실제로
존재한 적이 없다. v1을 넓히는 것이 정직하다.

세 곳을 같이 바꾼다(저장소 관례):
- `be/src/contracts/job-payload.schema.ts`
- `be/worker/damwha_worker/contracts.py`
- `be/test/fixtures/job-payloads/live_session.valid.json`

### 3.3 청크 전송 계약

```
POST /meetings/:id/live/audio
  Content-Type: application/octet-stream
  X-Audio-Offset: <이 청크가 시작하는 PCM 바이트 오프셋>
  body: 32768 바이트 (512샘플 프레임 32개 = 1.024초)

200 { accepted_offset, expected_offset }
409 { expected_offset }   -- 불일치. 클라이언트는 이 값으로 재동기화한다
507 { code: 'io_error' }  -- 디스크 참. job 행에도 기록된다
```

**오프셋은 언제나 PCM 바이트다** — 44바이트 WAV 헤더를 뺀 값이고, 파일 위치는 `44 + offset`이다.
`X-Audio-Offset`, `X-Final-Offset`, `expected_offset`, `job.sealed_bytes`가 전부 이 기준을 쓴다.
문서 안에서 이 기준을 벗어나는 곳은 없다.

**seq 카운터를 저장하지 않는다.** 청크가 고정 크기라 `expected_offset = filesize - 44`로
파일에서 복원된다. API가 재시작해도 정확하고, 디스크에 실제로 있는 것과 어긋날 수 없다.

**409가 `expected_offset`을 싣는 것이 이 계약의 핵심이다.** append가 성공했는데 응답이 유실되면
클라이언트는 재전송할지 다음을 보낼지 알 수 없다. 그때 다음 요청의 409가 진실을 알려주므로
중복 전송도 결번도 조용히 지나갈 수 없다.

**in-flight append는 항상 하나.** HTTP 완료 순서는 전송 시작 순서를 보장하지 않는다.
클라이언트는 앞 청크의 200을 받은 뒤에만 다음을 보낸다. 링 버퍼가 그동안 채워지고, 초당 1회
왕복은 무시할 만하다.

**시간 갭 검출에는 헤더가 필요 없다.** 맥이 슬립했다 깨면 오디오는 연속이지만 벽시계와
어긋난다. 그 판정은 API가 자기가 가진 것만으로 한다 — 캡처된 샘플 수는 `offset / 2`이고 경과
시간은 `now() - recorded_at`이므로, 후자가 `offset / 2 / 16000`초보다 크게 앞서면 그만큼 시간이
사라진 것이다. 클라이언트 시계를 믿을 필요도, 헤더를 하나 더 둘 필요도 없다.

### 3.4 종료

```
POST /meetings/:id/live/stop
  X-Audio-Offset:  <자투리가 시작하는 오프셋>
  X-Final-Offset: <최종 PCM 바이트 수>
  body: 마지막 자투리 PCM (0바이트 가능, 512샘플 배수가 아닐 수 있음)

200 { meeting_id, job_id, outcome: 'stopping' | 'finalized' }
409 { code: 'missing_chunk', expected_offset }
```

봉인과 마지막 청크 사이의 창을 없애기 위해 stop이 꼬리를 싣고 온다. `X-Final-Offset`까지 연속
수신되지 않았으면 409이지 조용한 성공이 아니다.

## 4. 세션 생명주기

```
POST /meetings/live ─→ meeting(recording) + live_session(queued) + 헤더만 있는 44바이트 WAV
   ─→ 브라우저 getUserMedia ─→ POST .../live/audio × N ─→ API append
   ─→ (워커가 살아 있으면) claim ─→ stage capture ─→ TailSource 미리보기
   ─→ POST .../live/stop ─→ 봉인(sealed_bytes) ─→ 워커 finalize (또는 API 자체 finalize)
   ─→ meeting(uploaded) + process_meeting(queued) ─→ (기존 흐름)
```

### 4.1 시작

원 설계 §4와 같다. `recording` 회의가 있으면 409, 보장은 `meeting_single_recording_idx`.
**추가:** 201을 돌려주기 전에 API가 `meetings/<id>/live.wav`에 44바이트 스트리밍 헤더를
원자적으로 만든다. 워커가 브라우저의 첫 POST보다 먼저 job을 claim할 수 있어서, 그때 tail 대상이
존재해야 한다. `TailSource`도 `ENOENT`를 영구 오류가 아니라 정상 대기로 취급한다 — 안전벨트 둘.

### 4.2 첫 청크 — `recorded_at`이 여기서 찍힌다

원 설계에서는 워커가 마이크를 연 시각을 `db.set_recording_started`로 찍었다. 이제 그 시각은
API가 첫 청크를 받은 때다(첫 샘플에 가장 가까운 값). 회의 가드
(`current_job_id = job.id AND status = 'recording'`)는 그대로 건다. 워커의
`set_recording_started` 호출은 지운다 — 소유권 확인은 `get_stop_requested`가 이미 한다.

### 4.3 봉인 — 순서가 곧 의미다

`stop`(또는 §4.6의 자동 봉인) 처리는 한 잠금 안에서 다음 순서를 지킨다.

```
① 꼬리 PCM append          파일이 길어진다
② fdatasync                200을 돌려주기 전에 디스크에 닿는다
③ DB commit                ← 봉인은 여기서 성립한다. sealed_bytes = 최종 PCM 바이트 수
④ WAV 헤더 재작성           best-effort
```

- **③ 전에 죽으면** 세션은 안 끝난 것이고 재시도가 안전하다. 파일이 조금 길어져 있어도 ①은
  오프셋으로 멱등하게 판정된다(409 + `expected_offset`).
- **③ 후 ④ 전에 죽으면** DB가 봉인을 말하고 헤더만 스트리밍 값(`0xFFFFFFFF`)으로 남는다.
  기존 `repair_streaming_header`가 정확히 그 상태를 위해 있다. 워커는 `sealed_bytes`를 보므로
  영향이 없고, `GET /meetings/:id/audio` 재생만 최종 패스의 normalize 전까지 헤더가 미정이다.

### 4.4 워커의 종료 — `sealed_bytes`까지 읽고 finalize

`get_stop_requested`가 `"stop"`을 돌려주면 같은 행에서 `sealed_bytes`를 읽고, 읽기 오프셋이
거기 닿을 때까지 계속 tail한다(타임아웃 있음). 그 길이는 불변이므로 안전하게
`duration_ms = sealed_bytes / 2 / 16`을 계산하고, `segmenter.flush()`로 마지막 발화를 닫고,
기존 `finalize_live_session`을 그대로 부른다. 잠금 순서와 DB 함수는 무변경이다.

**마지막 자투리 프레임:** 정본 WAV는 한 바이트도 자르지 않는다. 512샘플이 안 되는 꼬리는
미리보기에만 안 보이고(최대 32 ms), 패딩도 하지 않는다.

### 4.5 워커가 없을 때 — API가 직접 finalize (원 설계의 `queued` 분기를 뒤집는다)

지금 `LiveService.stop`은 job이 `queued`면 회의를 삭제한다. 새 구조에서 그것은 온전한 녹음을
지우는 일이다. 바뀐 동작: API가 회의를 `uploaded`로, `duration_ms`를 `sealed_bytes`에서,
`live_session` job을 닫고, payload의 v5 `process` 블록으로 `process_meeting`을 큐잉한다.
API에 이미 `buildProcessMeetingPayload` 기계가 있다.

### 4.6 버려진 producer

브라우저가 stop을 못 부르고 죽으면(탭 닫힘·크래시·슬립) 아무도 봉인하지 않아 회의가
`recording`에 갇히고 `meeting_single_recording_idx`가 다음 녹음을 막는다.

**기존 reaper로는 이것을 볼 수 없다.** `JobsRepository.reapStale`의 CTE는 `job.locked_at`
staleness만 보는데, tail 대기 중인 워커는 건강하게 heartbeat를 계속 뛴다. 워커 생존은 브라우저
생존의 증거가 아니다.

그래서 `job.last_input_at`을 append마다 갱신하고, **API 서비스 코드가** 후보를 뽑는다. reaper의
CTE에 넣을 수 없는 이유는 봉인이 `duration_ms`를 알아야 하고 그건 파일을 stat해야 나오기
때문이다 — SQL이 못 한다. API는 후보마다 파일을 stat하고 `stop`이 쓰는 것과 **똑같은 봉인·
finalize 경로**를 대신 호출한다. 코드 경로 하나에 트리거 셋이다: 사용자 종료 / 버려진 producer /
워커 부재 회수.

**결과를 정상 종료로 위장하지 않는다.** `meeting.error`에 `producer_abandoned`를 남긴 채
`uploaded`로 보낸다 — "불완전하지만 재처리 가능한 봉인된 녹음". 화면은 "브라우저 연결이 끊겨
여기까지 녹음됐어요"를 보여주고 정본 처리는 정상으로 돈다.

기본 임계값은 **90초**다. 청크 주기가 1초이므로 90번 연속 실패는 재시도로 회복될 상황이 아니고,
실수로 탭을 닫았다 되돌아오기엔 짧다. 되돌릴 수 있는 값이다(§10).

## 5. 브라우저 캡처

### 5.1 파이프라인

```
getUserMedia(§2.4 제약) ─▶ AudioContext({sampleRate:16000})
   ─▶ createMediaStreamSource ─▶ AudioWorkletNode
         process(): 128샘플 × 4 = 512샘플, Float32 → int16
   ─▶ port.postMessage ─▶ 메인 스레드 링 버퍼
   ─▶ 32프레임 모이면 청크 ─▶ POST (in-flight 하나)
```

워크릿 모듈은 `addModule()`로 별도 파일이라 Vite에서 `new URL('./pcm-worklet.ts', import.meta.url)`
패턴으로 넣는다.

### 5.2 시작 전 게이트

- `navigator.mediaDevices`가 `undefined`(insecure context)이면 "HTTPS에서만 녹음할 수 있어요".
  지금 `localhost:5173`은 secure context라 안 뜨지만, 기기를 분리하면 `http://192.168.x.x`는
  secure context가 아니라 이 경로가 확정적으로 걸린다(§9.1).
- `navigator.permissions.query({ name: 'microphone' })`가 `denied`면 다이얼로그에서 막는다.
- `enumerateDevices()`로 입력 장치를 고르게 한다. 라벨은 권한 승인 후에만 나온다.
- `AudioContext` 생성 직후 `audioContext.sampleRate === 16000`을 검증한다. 아니면 시작하지
  않는다(§2.3).

원 설계에서 회의 중간에 `audio_device_failed`로 터지던 실패가 전부 시작 전으로 옮겨간다.

### 5.3 녹음 중 실패를 조용히 두지 않는다

- **`track.onended`** (장치 제거·권한 회수): 캡처를 멈추고 §3.4의 종료 절차를 사유와 함께
  탄다. **바이트가 하나라도 있으면 정상 finalize** — 40분 중 30분이 살아 있으면 그 30분을
  정본으로 넘긴다. 0바이트일 때만 `audio_device_failed`로 실패하고 회의를 지운다.
- **`track.onmute` / `onunmute`**: 무음 구간을 기록만 하고 계속 간다. `ended`와 달리 회복
  가능하다. `ended` 후에도 워크릿은 무음을 계속 낼 수 있으므로, 이 둘을 구분하지 않으면 실제
  대화가 무음으로 기록된 채 회의가 정상 완료로 표시된다.
- **전송 큐 상한 초과**(§2.8): 캡처 중단 + 보이게 실패.
- **배너**: 미전송 버퍼가 30초를 넘으면 "업로드가 밀리고 있어요".

### 5.4 종료 절차

1. 워크릿 정지 — 새 프레임 없음
2. 버퍼의 완전 청크를 순서대로 전부 전송하고 **각각 200을 확인**
3. `POST .../live/stop`에 자투리 + `X-Final-Offset`

2단계가 있어야 "이미 날아가고 있던 청크"의 창이 닫힌다. §3.3의 "in-flight 하나" 규칙이 이를
자동으로 만족시킨다.

## 6. 워커 — `TailSource`

`MicSource` 자리에 자라는 WAV를 따라 읽는 구현체가 들어간다. `FileSource`와 결정적으로 다른
점은 **EOF가 "끝"이 아니라 "따라잡음"**이라는 것이다.

- 44바이트 헤더를 건너뛰고 오프셋으로만 전진한다. 헤더의 크기 필드는 읽지 않는다(§2.6).
- 부분 읽기를 대비해 나머지 버퍼를 들고 완성된 1024바이트 프레임만 낸다. short read는 EOF가
  아니라 재시도다.
- `ENOENT`는 정상 대기다(§4.1).
- 진짜 EOF는 `sealed_bytes`가 채워졌고 읽기 오프셋이 거기 닿았을 때만이다.

### 6.1 드리프트 정책 — 그리고 지금 있는 타임스탬프 결함

원 구현은 preview 큐가 5분을 넘으면 가장 오래된 프레임을 버린다. 그런데 `LiveSegmenter.push()`는
프레임 하나당 `self._pos_ms += FRAME_MS`로 시간을 센다. **프레임을 버리는 순간 `_pos_ms`가
실제 시각보다 `dropped × 32ms`만큼 밀리고, 그 이후 모든 `live_utterance.start_ms/end_ms`가
어긋난다.** 미리보기 행은 persist에서 지워지니 정본에는 남지 않지만, 발화 점프가 이 제품의 핵심
capability인 만큼 화면에 틀린 시각이 뜨는 것 자체가 결함이다.

`TailSource`에서는 구조적으로 일어나지 않는다. 시간의 근거가 프레임 카운터가 아니라 파일
오프셋이기 때문이다.

```
position_ms = offset / 2 / 16        -- offset은 PCM 바이트, 파일 위치는 44 + offset
```

정책:
- 매 읽기 전에 읽기 오프셋과 파일 크기를 비교한다.
- 30초 이상 뒤처졌으면 `size - 30초`로 **프레임 경계에 맞춰 seek**하고
  `segmenter.skip_to(position_ms)`를 부른다. 이 메서드는 `_pos_ms`를 절대값으로 다시 놓고,
  pre-roll을 비우고, 열려 있던 세그먼트를 버리고(방금 구멍을 냈으므로), VAD 상태를 리셋한다.
- 건너뛴 구간은 로그에 남긴다. "미리보기는 늦어질 뿐 파일은 온전하다"는 원 설계의 문장이 그대로
  산다.

`AudioSource` 프로토콜은 건드리지 않는다. `position_ms`는 `TailSource`에만 있고 라이브 루프에서만
읽는다.

> `be/worker/SMOKE.md`의 "세션 안에서 지연이 단조 증가(4219 → 4360 → 5934 → 7356ms)"가 이
> 드리프트일 가능성이 있으나, 표본 4개짜리 `--file` 측정이고 preview 큐 5분 상한에 닿을 길이가
> 아니라 근거로 삼기에 약하다. 재측정 항목으로만 남긴다.

### 6.2 사라지는 것

`WavWriter`, `WriterThread`, `run_writer_thread`, `writer_q`, `Capture`의 이중 큐 분기,
`writer_thread.error` 판정, `frames_written == 0` 정리, `finally`의 조인 순서 로직.
`repair_streaming_header`는 §4.3의 그물로 남는다.

## 7. 실패 모드

| 실패 | 원 설계 | 이 설계 |
|---|---|---|
| 마이크 못 열음 | 워커 `MicSource` → `audio_device_failed` | 브라우저가 시작 전에 차단. job도 안 만들어진다 (§5.2) |
| 녹음 중 장치 끊김 | 워커 `capture.error` → 회의 `failed` | `track.onended` → 봉인 + 정상 finalize. 0바이트면 `audio_device_failed` (§5.3) |
| 디스크 참 | 워커 `WriterThread.error` → `io_error` | API append가 507 + job 행에 `io_error` → 워커 폴링이 보고 세션 실패 |
| 브라우저 사라짐 | 해당 없음 | `last_input_at` 초과 → 봉인 + `producer_abandoned` (§4.6) |
| 워커 죽음 | job `queued`, 아무것도 녹음 안 됨 | 녹음은 계속. 미리보기만 없고 stop 시 API가 finalize (§4.5) |
| 클립 연속 실패 | `live_stt_failed` | 무변경 |
| 전송 큐 폭주 | 해당 없음 | 상한 초과 → 캡처 중단 + 보이게 실패 (§2.8) |

새 에러 코드는 `producer_abandoned` 하나이고, job 실패가 아니라 `meeting.error`에 붙는 주석이다.

## 8. 테스트

**워커** — `TailSource`가 새 표면의 전부다.
- 부분 읽기가 EOF로 오인되지 않는다 / `ENOENT`에서 대기한다 / `sealed_bytes`에 닿아야만
  끝난다 / 헤더의 크기 필드를 읽지 않는다 / 30초 드리프트에서 프레임 경계로 seek한다
- `LiveSegmenter.skip_to()`가 `_pos_ms`를 절대값으로 놓고 열린 세그먼트·pre-roll·VAD를 리셋한다
- `run_live_session`을 fake tail source로 (기존 fake 모델 패턴 그대로)
- 삭제: `WavWriter`/`WriterThread`/`Capture` 이중 큐 테스트

**API**
- append: 오프셋 일치/불일치, 409가 `expected_offset`을 싣는다, ACK 유실 후 재동기화,
  봉인 후 409
- 봉인 순서: ③ 전 크래시는 재시도 안전, ③ 후 ④ 전 크래시는 DB가 이긴다
- stop: `final_offset` 결손이 409, 꼬리 자투리 append
- `queued` finalize, `producer_abandoned` finalize
- **회귀: `StorageService.save()`를 append 경로에 쓰지 않는다.** `fs.promises.writeFile`은
  truncate라 매 청크가 앞 청크를 덮어써 정본이 마지막 1초만 남는다

**FE**
- Float32 → int16 변환과 512샘플 배칭 (순수 함수)
- `sampleRate !== 16000`이면 시작 거부
- 전송 큐 상한 초과 시 캡처 중단
- stop이 큐를 비운 뒤에만 발사된다
- `track.onended` 처리
- 데모 빌드에서 숨는지 (기존 테스트 갱신)

## 9. 알려진 제약

### 9.1 secure context — 기기를 분리하는 날 확정적으로 걸린다
insecure context에서는 `navigator.mediaDevices` 자체가 `undefined`다. `localhost`는 secure
context로 취급되므로 지금은 문제가 없지만, 노트북에서 `http://192.168.x.x:5173`으로 붙는 순간
getUserMedia가 존재하지 않는다. mkcert/Caddy로 TLS를 세우거나 Tailscale(`.ts.net` + 자동
인증서)로 푼다. 이 설계를 바꾸지는 않는다.

### 9.2 시스템 슬립
AudioWorklet은 오디오 스레드에서 돌아 탭 백그라운드에는 강하지만 시스템 슬립은 못 버틴다.
Screen Wake Lock API가 검토 대상이나 v1 필수는 아니다. 사후 갭 검출은 §3.3의 방식으로 한다.

### 9.3 나중의 시스템 오디오는 한 WAV에 그냥 append할 수 없다
브라우저 마이크와 워커의 시스템 오디오는 서로 다른 hardware clock·시작 시각·장치 지연을 가진다.
도착 순서대로 하나의 mono WAV에 이어 붙이면 시간축이 뒤섞이고 drift가 누적된다. 그때는 source별
트랙과 sample-clock 메타데이터를 두고 finalize에서 정렬·믹스해야 한다. `AudioSource` 계약이
지금은 단일 16 kHz mono 프레임만 표현한다.

### 9.4 워커를 다른 기기로 옮기면 tail이 성립하지 않는다
§2.2의 전제가 깨진다. 그때는 streaming read API나 object storage가 필요하다. 현재 로드맵에
없다.

## 10. 되돌릴 수 있는 결정

- **오디오 제약 셋(§2.4)** — 실측으로 되돌릴 수 있다. 특히 `echoCancellation`은 스피커로 회의
  소리를 내보내는 구성에서 의미가 달라진다.
- **버려진 producer 임계값 90초(§4.6)**
- **드리프트 seek 임계값 30초(§6.1)**
- **청크 크기 32768바이트(§3.3)** — 지연과 요청 수의 교환이다.

## 11. 하지 않는 것

IndexedDB 영속 버퍼, WebSocket/SSE, 오디오 압축, 시스템 오디오 캡처, Screen Wake Lock,
워커 원격 배치. 전부 `be/docs/backlog.md`로 보낸다.
