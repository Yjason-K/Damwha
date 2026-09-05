# 실시간 녹음(라이브 세션) 설계

**작성일:** 2026-09-05
**범위:** 워커 Mac의 마이크로 회의를 녹음하면서 전사·등록 화자 식별을 실시간으로 보여주고,
종료 시 기존 배치 파이프라인으로 정본을 만드는 기능. `be/`, `be/worker/`, `fe/` 셋을 건드린다.

## 1. 목적과 성공 기준

지금 Damwha는 밖에서 녹음한 파일을 올려야만 처리가 시작된다. 이 설계는 앱 안에서 녹음을
시작하고, 회의가 진행되는 동안 화면에 발화가 흘러가게 하며, 종료하면 그 녹음이 곧바로 기존
`process_meeting` 흐름으로 들어가게 한다.

핵심 결정은 **2-pass**다. 실시간 패스는 미리보기이고, 종료 뒤 도는 배치 패스가 정본이다. 지금
STT 품질을 만든 장치(전체 VAD로 발화 구간만 디코딩, 지속시간 가중 화자 군집, 이전 텍스트
조건화 끄기)가 전부 파일 전체를 전제하므로, 청크 단위 실시간 결과는 어떤 튜닝으로도 배치를
넘지 못한다. 실시간 결과를 정본으로 승격하려 하지 않고, 배치가 끝나면 통째로 교체한다.

성공 기준은 다음과 같다.

- 좌측 목록의 "녹음" 버튼으로 세션을 시작하면 회의 상세로 이동하고, 발화가 끝난 뒤 수 초 안에
  그 발화가 화면에 나타난다.
- 등록된 화자의 발화에는 이름이 "추정"으로 붙고, 미등록은 "화자 ?"로 보인다.
- "종료"를 누르면 회의가 기존 `uploaded → processing → done` 흐름을 타고, 완료되면 화면이
  실제 전사로 교체된다. 최종 패스는 세션을 시작할 때 고른 처리 설정과 같은 모델로 돈다.
- 워커나 DB가 어떤 식으로 죽어도 그때까지의 녹음 파일은 유효하게 남고, 기존 재처리 버튼으로
  그 파일을 처리할 수 있다.
- 데모 읽기 전용 배포에서는 기능이 노출되지 않는다.

## 2. 결정

### 2.1 오디오는 워커 Mac에서 잡는다. v1은 마이크만

브라우저 마이크가 아니라 워커가 도는 Mac의 입력 장치를 쓴다. 이유는 둘이다. API와 워커는
Postgres로만 통신한다는 불변식을 지키려면 브라우저→API(컨테이너)→워커(호스트)로 오디오를 흘릴
길을 새로 파야 하는데, 워커가 직접 잡으면 그 길이 필요 없다. 그리고 온라인 회의의 상대방
소리를 잡으려면 어차피 호스트 쪽 시스템 오디오여야 한다.

v1은 마이크만 구현한다. 시스템 오디오는 macOS가 앱에 그냥 열어주지 않아 ScreenCaptureKit이나
Core Audio process tap을 써야 하고, 안정성을 먼저 스파이크로 확인해야 한다. 캡처는
`AudioSource` 프로토콜 뒤에 두어 나중에 구현체 하나를 더하는 일로 만든다. payload의 `source`
필드가 그 자리다.

### 2.2 실시간 표시는 전사 + 등록 화자 식별까지

- **전사**: 실시간의 5~10배 속도로 도는 파이프라인(deploy README 실측: 10분 회의가 M-series에서
  1~2분)이라 청크 STT는 여유가 있다.
- **화자 식별**: pyannote 분리는 파일 전체를 군집화하는 오프라인 알고리즘이라 스트리밍이
  불가능하다. 실시간에서 가능한 것은 청크마다 ECAPA 임베딩을 뽑아 등록 성문과 비교하는
  식별뿐이다. 이 제품의 핵심이 화자 귀속 발화이므로 이것까지는 넣는다. 결과는 전부 "추정"이다.
- **중간 요약은 뺀다**: LLM 서버를 세션 내내 띄우면 whisper와 함께 메모리를 점유해 16GB
  머신이 빠듯해지고, 회의 종료 몇 분 뒤면 정식 요약이 나온다. 그 몇 분을 위한 대가가 크다.
- **렌즈·검색 색인은 최종 패스에서만**: 렌즈 머지는 `(kind, primary utterance)`로 매칭하는데
  라이브 발화 id는 임시라 의미가 없다.

### 2.3 세션은 supervisor 자식이 세션 동안 사는 job이다

`live_session` job 타입을 두고, 기존 supervisor가 자식을 spawn해 그 자식이 종료 신호까지
캡처·전사를 돌린다. claim, heartbeat, reaper, 소유권 가드, "자식 하나 = GPU 메모리 회수
단위"라는 모델을 전부 그대로 쓴다. 새 프로세스도 새 계약도 없다.

대가는 녹음하는 동안 다른 job이 기다린다는 것이다. 개인용 도구에서 세션은 한 번에 하나이고,
UI가 "녹음 중이라 대기"를 보여주면 되는 수준이라 감수한다. 별도 상주 프로세스나 supervisor
슬롯 추가는 기각했다. 둘 다 녹음 중에 `process_meeting`이 같이 돌아 whisper 둘과 pyannote가
동시에 뜨는 OOM 위험을 만들고, 그걸 막으려면 결국 큐를 서로 보게 해야 해서 이 결정으로
수렴한다.

### 2.4 라이브 발화는 `utterance`가 아니라 별도 테이블에

`utterance`에 버전 0으로 섞지 않는다. 모든 리더가 `u.processing_version = m.processing_version`
으로 거르고, 렌즈 근거와 저장 발화가 그 테이블을 FK로 물고, `diar_label`이 NOT NULL이다. 임시
행이 검색·렌즈·저장 경로로 새어 나갈 길을 처음부터 막기 위해 `live_utterance`를 따로 둔다.

행은 최종 패스의 persist가 커밋될 때 같은 트랜잭션에서 지운다. 처리 대기 1~2분 동안은
미리보기로 남고, 그 뒤엔 쌓이지 않는다. 최종 패스가 실패하면 행이 남는데, 이건 의도다. 실패한
회의에서도 뭐가 녹음됐는지는 보여야 한다.

### 2.5 종료 신호는 job 행의 컬럼이다

기존 `POST /meetings/:id/cancel`은 job을 failed로 닫고 워커가 소유권 상실로 멈추는
"버리기"다. 녹음 종료는 파일을 살려 최종 패스로 넘겨야 하니 다른 신호가 필요하다.
`job.stop_requested_at`을 두고 API가 찍으면 워커 루프가 읽는다. API→워커 방향 신호가 job
행에 실리는 것이라 "계약은 job 테이블"이라는 원칙 안이다. cancel은 중단 경로로 그대로 산다.

### 2.6 재시도는 없다

끊긴 녹음을 이어 붙일 방법이 없다. `live_session`은 `max_attempts=1`로 넣고 워커는 세션
오류를 전부 PERMANENT로 분류한다. `requeue_for_shutdown`도 세션에는 적용하지 않는다. 1차
SIGTERM은 requeue가 아니라 정상 종료(finalize)로 간다.

### 2.7 폴링. SSE는 넣지 않는다

지연의 큰 덩어리는 전사 자체(발화 끝 → whisper 0.5~1.5초)라 SSE로 줄지 않는다. 폴링이 얹는
지연은 간격의 절반이고, 1초 폴링이면 평균 0.5초다. 쿼리는 `(meeting_id, seq)` 인덱스에서
0~2행을 집는 것이라 부담이 없다. SSE를 넣으면 워커 `NOTIFY`, API의 `LISTEN` 전용 커넥션,
keepalive, `Last-Event-ID` 되감기, 프록시 버퍼링 설정이 전부 새로 생기고 이 저장소에 push
패턴은 하나도 없다. 엔드포인트가 `after` 커서 keyset이라 나중에 SSE를 붙여도 같은 항목을
스트림으로 흘리고 커서를 `Last-Event-ID`로 쓰면 된다. 데이터 모델과 API 형태는 안 바뀐다.

### 2.8 라이브 식별의 결합 기준은 suggest 임계값이다

최종 패스는 지속시간 가중 centroid를 bind 임계값(`IDENTIFY_THRESHOLD`)과 비교하고, 그 아래
suggest 구간은 제안으로만 남긴다. 청크 하나의 임베딩은 centroid보다 잡음이 커서 bind 기준으로는
이름이 잘 안 붙는다. 라이브 표시는 어차피 전부 "추정"이므로 `identify.suggest_threshold`를
결합 기준으로 쓰고 `similarity`를 같이 저장해 UI가 흐림 정도를 정한다. `process` 블록은 API가
늘 v5로 만들므로 이 값은 항상 있다. 이 결정은 §9의 측정으로 되돌릴 수 있다.

### 2.9 녹음 파일은 무엇이 죽어도 잃지 않는다

이 불변식은 두 장치로 성립한다.

- **쓰기 경로의 분리.** 마이크 콜백은 프레임을 두 큐에 나눠 넣고, 전용 writer 스레드가 그중
  하나를 디스크로 옮긴다. 전사·식별·DB 조회는 다른 큐를 먹는 미리보기 파이프라인에만 있다.
  추론이 느려지거나 DB가 멈춰도 파일 쓰기는 영향받지 않는다. 같은 루프에 두면 whisper가 도는
  동안 프레임이 메모리에만 쌓이고, 그 순간 죽으면 그 구간을 잃는다.
- **스트리밍 헤더.** 녹음 중에는 WAV 헤더의 RIFF 크기와 data 크기를 `0xFFFFFFFF`(길이 미정,
  ffmpeg가 seek 불가 출력에 쓰는 관례)로 두고, 정상 종료 때만 실제 값을 쓴다. 이 머신의
  ffmpeg로 확인한 결과, data 크기가 실제보다 작은 헤더(PCM 7초, 헤더 5초)는 probe와
  normalize 모두 **5초로 잘리고**, `0` 또는 `0xFFFFFFFF`면 EOF까지 7초를 읽는다. 따라서
  "주기적으로 헤더를 갱신한다"는 방식은 마지막 갱신 이후 구간을 잃으므로 쓰지 않는다. 어느
  순간 죽어도 마지막 프레임까지 읽힌다.

나머지 실패는 전부 "회의를 `failed`로 닫고 기존 재처리로 그 파일을 최종 패스에 넘긴다"로
수렴한다(§8). 최종 패스의 normalize 단계는 스트리밍 헤더가 남은 파일을 만나면 파일 크기로
헤더를 고쳐 쓴 뒤 진행한다(§5.2). 원본을 그대로 재생하는 `GET /meetings/:id/audio`까지
정확한 헤더를 보게 하기 위해서다.

## 3. 데이터와 계약

### 3.1 마이그레이션 `022_live_session.sql`

```sql
ALTER TABLE meeting DROP CONSTRAINT meeting_status_check;
ALTER TABLE meeting ADD CONSTRAINT meeting_status_check
  CHECK (status IN ('recording','uploaded','processing','done','failed'));

ALTER TABLE job DROP CONSTRAINT job_type_check;
ALTER TABLE job ADD CONSTRAINT job_type_check
  CHECK (type IN ('process_meeting','enroll_speaker','index_meeting',
                  'extract_lenses','summarize_meeting','live_session'));

ALTER TABLE job DROP CONSTRAINT job_stage_check;
ALTER TABLE job ADD CONSTRAINT job_stage_check
  CHECK (stage IN ('vad','diarize','identify','stt','align','persist',
                   'extract_embedding','enroll_persist','embed',
                   'extract_lenses','persist_lenses',
                   'summarize_meeting','persist_summary',
                   'capture','finalize'));

-- 동시에 recording인 회의는 하나뿐이다. status 컬럼의 부분 유일 인덱스라 그 값의 행이
-- 둘이 될 수 없다. 동시 시작 요청은 둘 다 "recording 없음"을 읽어도 INSERT에서 하나만 산다.
CREATE UNIQUE INDEX meeting_single_recording_idx ON meeting (status) WHERE status = 'recording';

ALTER TABLE job ADD COLUMN stop_requested_at timestamptz;

CREATE SEQUENCE lut_id_seq;
CREATE TABLE live_utterance (
  id          text PRIMARY KEY DEFAULT 'lut_' || nextval('lut_id_seq')
                CHECK (id ~ '^lut_[1-9][0-9]*$'),
  meeting_id  text NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
  job_id      text NOT NULL,
  seq         int  NOT NULL,
  start_ms    int  NOT NULL,
  end_ms      int  NOT NULL CHECK (end_ms > start_ms),
  text        text NOT NULL CHECK (char_length(text) > 0),
  speaker_id  text REFERENCES speaker(id) ON DELETE SET NULL,
  similarity  real,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (meeting_id, seq)
);
ALTER SEQUENCE lut_id_seq OWNED BY live_utterance.id;
```

- `status` 컬럼은 없다. 텍스트가 빈 클립은 행을 쓰지 않고, 예외가 난 클립은 로그만 남긴다.
  저장할 실패가 없다.
- `speaker_id`가 `ON DELETE SET NULL`인 이유: 최종 패스의 persist가 임시 화자를 GC하는데,
  라이브 행 삭제와 같은 트랜잭션이라 실제로 부딪히지는 않지만 순서에 기대지 않는다.
- `start_ms`/`end_ms`는 녹음 시작 기준 오프셋이다. 최종 패스의 `utterance`와 같은 기준.

### 3.2 `live_session` payload v1

```json
{
  "schema_version": 1,
  "meeting_id": "mtg_12",
  "audio_key": "meetings/mtg_12/original.wav",
  "source": "mic",
  "process": { "...": "ProcessMeetingPayloadV5 그대로" }
}
```

API가 시작 시점에 처리 설정을 풀어 `buildProcessMeetingPayload({ processingVersion: 0,
reprocess: false, ... })`로 만든 `process_meeting` payload를 통째로 품는다. 워커는 여기서
`models.whisper_model`, `models.devices.stt`, `models.embedding`, `identify.*`를 읽고, 종료
시 이 블록을 그대로 최종 job의 payload로 넣는다. 설정을 두 번 푸는 일이 없고, 라이브 패스와
최종 패스가 같은 모델로 도는 것이 구조적으로 보장된다. `process.audio_key`와 바깥 `audio_key`는
같은 값이다.

계약은 늘 하던 대로 셋을 같이 바꾼다.

- `be/src/contracts/job-payload.schema.ts`: `LiveSessionPayloadSchema`, `JobType`에 `live_session`,
  `buildLiveSessionPayload`.
- `be/worker/damwha_worker/contracts.py`: `LiveSessionPayload`, `SUPPORTED_SCHEMA_VERSIONS["live_session"] = {1}`.
- `be/test/fixtures/job-payloads/live_session.valid.json`: 양쪽이 같은 파일을 검증한다.

### 3.3 claim 우선순위

지금 claim은 `ORDER BY next_attempt_at NULLS FIRST, created_at`이다. 그대로면 회의가
시작됐는데 앞에 밀린 색인 job을 먼저 처리한다. 두 구현(`be/src/jobs/jobs.repository.ts`,
`be/worker/damwha_worker/db.py`) 모두 정렬 키를 앞에 하나 붙인다.

```sql
ORDER BY (type = 'live_session') DESC, next_attempt_at NULLS FIRST, created_at
```

이미 **돌고 있는** 자식은 끝날 때까지 기다린다. supervisor가 그 자식을 stage 경계에서
내려보내는 선점은 후속이다(§10).

### 3.4 reaper

두 reaper 복사본(`be/src/jobs/reaper.service.ts`의 CTE, `db.reap_stale`)의 `fail_meetings`
분기가 지금 `type='process_meeting'`만 본다. `type IN ('process_meeting','live_session')`으로
넓혀 stale 세션이 회의를 `failed`로 닫게 한다. `max_attempts=1`이라 requeue 분기에는 절대
걸리지 않는다.

`JobsRepository.enqueue`에 선택 인자 `maxAttempts`를 추가한다(기본은 컬럼 DEFAULT 3).

## 4. 세션 생명주기

```
POST /meetings/live ─→ meeting(recording) + live_session(queued)
   ─→ 워커 claim ─→ stage capture ─→ stop_requested_at ─→ stage finalize
   ─→ meeting(uploaded) + process_meeting(queued) + live_session(done)
   ─→ (기존 흐름) processing ─→ done, persist가 live_utterance 삭제
```

**시작.** 이미 `recording`인 회의가 있으면 409. 마이크도 하나, supervisor 자식도 하나라
세션은 한 번에 하나다. 사전 조회는 친절한 메시지를 위한 것이고, 보장은
`meeting_single_recording_idx`가 한다. 동시 요청 둘이 모두 "없음"을 읽어도 INSERT에서 하나만
살고, 나머지는 유일 위반(`23505`, 그 인덱스 이름)을 409로 바꿔 돌려준다. 회의를 `recording`으로
넣되 `audio_key`는
`meetings/<id>/original.wav`로 미리 배정하고, `original_filename`은 null이다. `title`은
업로드와 같이 선택이고 서버는 기본값을 만들지 않는다. 기본 제목 `녹음 YYYY-MM-DD HH:mm`은
시작 다이얼로그가 브라우저 시각으로 미리 채운다(§7.2). 컨테이너 API는 회의 시간대를 모른다.
`live_session` job을 `max_attempts=1`로 넣고 `current_job_id`를 잇는다. 워커가 안 떠 있으면
job이 `queued`에 머문다.

**capture.** 자식이 stage `capture`(progress 0)로 들어가며 `recorded_at = now()`를 회의
가드(`current_job_id = job.id`) 아래 다시 찍는다. 실제 녹음 시작 시각이 API 호출 시각이
아니라 첫 샘플 시각이어야 경과 시간이 맞는다. 루프는 §5.

**종료.** `POST /meetings/:id/live/stop`. 트랜잭션 안에서 **job 행을 먼저** 잠근다.

```sql
SELECT j.* FROM job j JOIN meeting m ON m.current_job_id = j.id
WHERE m.id = $1 AND j.type = 'live_session' FOR UPDATE OF j;
SELECT * FROM meeting WHERE id = $1 FOR UPDATE;
```

회의가 `recording`이 아니거나 세션 job이 없으면 409. 그다음 잠근 job의 상태로 가른다.
- `running`: `stop_requested_at = now()`(이미 있으면 그대로), `{ outcome: 'stopping' }`.
- `queued`: 녹음된 게 없다. job과 회의를 지우고 `{ outcome: 'discarded' }`.

claim은 job 행만 `FOR UPDATE SKIP LOCKED`로 잠근다. 회의 행을 잠그는 것만으로는 그 사이
claim이 끼어들어 이미 마이크를 연 세션을 API가 지울 수 있다. job 행을 잠근 채 판정해야 claim이
그 행을 건너뛰고, claim이 먼저였다면 API는 `running`을 본다. 잠금 순서는 **job → meeting**으로,
워커의 persist와 `fail_process_meeting`이 이미 쓰는 순서와 같다. (기존 `cancel`은 반대로
meeting → job이라 워커 persist와 교차할 수 있는데, 이는 이 설계 이전부터 있던 것이고 Postgres가
감지해 한쪽을 되돌린다. 여기서 넓히지 않는다.)

**정상 종료의 순서.** 워커 루프가 stop을 읽으면:

1. 캡처 스트림을 닫는다. 새 프레임이 더 오지 않는다.
2. writer 스레드가 큐를 비우고 파일을 닫으며 헤더에 실제 크기를 쓴다.
3. 미리보기 파이프라인이 진행 중이던 발화를 마지막 세그먼트로 강제 절단해 처리하고, 남은
   프레임은 버린다. 최종 패스가 어차피 전부 다시 본다.
4. finalize.

파일이 닫힌 뒤에 최종 job이 큐에 들어가야 한다. 순서가 바뀌면 최종 패스가 열린 파일을 볼 수
있다.

**finalize.** stage `finalize`(progress 100). 샘플 수로 길이를 잰다. 트랜잭션 하나에서
persist와 같은 순서로 job 가드(`SELECT ... FROM job WHERE id=$job AND locked_by=$worker AND
status='running' FOR UPDATE`)를 먼저, 회의 가드(`status='recording' AND current_job_id = job.id`)를
그다음에 통과하면:

1. `meeting SET status='uploaded', duration_ms=$n`
2. `INSERT job(type='process_meeting', meeting_id, payload=$process)`
3. `meeting SET current_job_id = <새 job>`
4. `job(live) SET status='done'`

가드에 걸리면(그 사이 cancel) 아무것도 쓰지 않고 `discarded`로 끝낸다. WAV는 디스크에 남는다.
자식이 exit 0 하면 부모가 peek에서 새 job을 보고 바로 다음 자식을 띄운다. 그 뒤는 기존 코드다.

**상한.** `LIVE_MAX_MINUTES`(기본 240)를 넘으면 stop이 온 것과 동일하게 finalize한다.

## 5. 워커

### 5.1 파일 배치

| 파일 | 책임 |
|---|---|
| `damwha_worker/audio/source.py` | `AudioSource` 프로토콜, `MicSource`(sounddevice), `FileSource`(WAV를 실시간 또는 즉시 흘림, 테스트·smoke용) |
| `damwha_worker/audio/wav_writer.py` | 스트리밍 헤더 WAV writer(전용 스레드), `repair_streaming_header(path)` |
| `damwha_worker/pipeline/ffmpeg.py` | normalize 앞에서 `repair_streaming_header` 호출 |
| `damwha_worker/models/silero_vad.py` | 기존 `SileroVAD`에 `StreamingSileroVAD` 추가(`VADIterator` 래핑) |
| `damwha_worker/pipeline/live_segmenter.py` | VAD 이벤트 → 세그먼트. 패딩·최소 길이·강제 절단 순수 함수 |
| `damwha_worker/pipeline/live_session.py` | 루프, 식별, finalize |
| `damwha_worker/models/registry.py` | `build_live_models(payload)` = transcriber + embedder + streaming VAD |
| `damwha_worker/db.py` | `set_recording_started`, `get_stop_requested`, `insert_live_utterance`, `finalize_live_session`, `delete_live_utterances`(persist 안). 즉시 실패는 job과 회의를 함께 닫는 기존 `fail_process_meeting`을 그대로 쓴다 |
| `damwha_worker/__main__.py` | `handle_job`에 `live_session` 분기, 1차 시그널을 stop으로 변환 |

의존성: `sounddevice`를 `[project.optional-dependencies] models`에 추가한다(PortAudio 바인딩,
macOS wheel에 라이브러리 동봉). 결정적 테스트 스위트는 이걸 import하지 않는다.

### 5.2 캡처와 WAV

`AudioSource.open()`은 16kHz 모노 int16, 512샘플(32ms) 프레임의 반복자를 내는 컨텍스트
매니저다. `MicSource`의 콜백은 프레임을 두 큐(writer, preview)에 넣기만 한다. 첫 실행에 macOS
마이크 권한 프롬프트가 터미널 앱 앞으로 뜬다(deploy README에 한 줄).

`WavWriter`는 전용 스레드에서 writer 큐를 비워 파일에 이어 쓴다. 헤더는 열 때 RIFF 크기와 data
크기를 `0xFFFFFFFF`로 쓰고, `close()`에서만 실제 값으로 고친다. 중간 갱신은 없다. §2.9의 실측대로
ffmpeg는 이 값을 "길이 미정"으로 읽어 EOF까지 디코딩하므로, 어느 순간 죽어도 마지막으로 디스크에
닿은 프레임까지 살아 있다. writer 스레드는 디스크 외에 아무것도 기다리지 않고, 프로세스 크래시는
커널 페이지 캐시가 살아남으므로 `fsync`는 하지 않는다. 디스크는 시간당 약 115MB.

`repair_streaming_header(path)`는 WAV 헤더의 data 크기가 `0xFFFFFFFF`이거나 파일 크기를 넘으면
실제 파일 크기에서 헤더를 뺀 값을 2바이트(int16 모노 샘플) 경계로 내림해 두 필드를 고쳐 쓴다.
정상 파일은 건드리지 않는다. `process_meeting`의 normalize 단계가 원본을 열기 전에 부른다. 크래시
후 재처리한 녹음이 그 시점부터 정확한 헤더를 갖게 되어, 원본을 그대로 내보내는 오디오 재생과
어떤 다른 리더도 스트리밍 헤더를 볼 일이 없다.

### 5.3 분절

`StreamingSileroVAD`가 프레임마다 시작/끝 이벤트를 낸다. 끝이 오면 세그먼트 하나. 끝이 안 와도
`LIVE_SEGMENT_MAX_SECONDS`(상수 15)가 차면 강제로 자른다. 최종 패스의 `prepare_stt_spans`와
같은 규칙으로 앞뒤 200ms 패딩, 300ms 미만 버림. 지연은 발화 끝에서 STT 시간만큼이라 보통
1~2초이고, 긴 독백은 최대 15초 뒤에 첫 줄이 뜬다.

### 5.4 전사와 식별

세그먼트를 세션 임시 디렉터리에 WAV로 떨구고 기존 `Transcriber.transcribe(wav_path, language)`를
그대로 부른다. 환각 가드, 반복 루프 필터, MLX 클립별 호출이 전부 그대로 적용된다. 배열 입력용
새 경로를 파지 않는 이유다. 결과 단어의 시각에 세그먼트 `start_ms`를 더해 녹음 기준으로 옮긴다.

ECAPA는 같은 임시 파일에 세그먼트 하나로 `Embedder.embed()`를 부른다. `too_short_for_embedding`
가드가 짧은 클립을 거른다(그 경우 `speaker_id`/`similarity` null). 임베딩은
`identify.identify_clusters`와 같은 SQL(model·dimension 일치, `MATCHABLE_STATUSES`)로 최근접
성문을 찾고 §2.8의 기준으로 결합한다. 이 조회는 `identify.py`에 `identify_embedding(conn,
embedding, model, dimension, threshold) -> (speaker_id, similarity) | None`으로 뽑아 두 경로가
같은 SQL을 쓰게 한다.

### 5.5 루프

```
[capture thread]  mic ──512샘플 프레임──▶ writer queue ──▶ [writer thread] WavWriter.append
                                      └─▶ preview queue (상한 5분, 넘치면 오래된 것부터 버림)
[main loop]       preview queue ──▶ StreamingSileroVAD ──segment──▶ temp wav
                                 ──▶ transcribe ──▶ text (비면 건너뜀)
                                 ──▶ embed ──▶ identify_embedding
                                 ──▶ insert_live_utterance(seq++)
                  매 1초: get_stop_requested, 상한 시간, shutdown_event
```

- 파일 쓰기와 미리보기는 서로 다른 큐와 스레드다. whisper가 도는 1~2초 동안 preview 큐에는
  프레임이 쌓였다가 따라잡지만, writer 큐는 디스크 속도로만 비워지므로 파일은 추론과 무관하게
  완전하다. preview 큐는 5분치를 상한으로 두고 넘치면 오래된 프레임부터 버리며 경고를
  남긴다. 이 드롭은 미리보기에만 생기고 녹음에는 영향이 없다. 큐 깊이를 stage 로그에 남겨 CPU
  프리셋처럼 실시간에 못 미치는 머신에서 밀리는 걸 볼 수 있게 한다.
- 클립 하나의 예외는 로그만 남기고 계속 간다. `LIVE_CLIP_FAILURE_LIMIT`(상수 5)회 연속 실패면
  PERMANENT `live_stt_failed`로 세션을 끝낸다. finalize 없이 exit하므로 reaper 경로가 아니라
  `fail_process_meeting`과 같은 즉시 실패 경로로 회의를 `failed`로 닫는다. WAV는 남는다.
- 루프 안 DB 오류는 다음 클립에서 재접속을 한 번 시도한다. WAV 쓰기는 영향받지 않는다. 오래
  끊기면 finalize가 실패하고 §8의 크래시 경로로 간다.
- heartbeat는 기존 daemon thread 그대로.

### 5.6 시그널

1차 SIGINT/SIGTERM은 `shutdown_event`를 세우고, 세션 루프는 그것을 stop과 동일하게 다뤄
finalize로 간다. `Ctrl+C`가 녹음을 깔끔하게 끝내고 최종 패스를 큐잉한다.
`requeue_for_shutdown`은 세션에 호출하지 않는다. 2차 시그널은 기존대로 SIGKILL.

## 6. API

새 도메인 `be/src/live/`(repository / service / controller). 컨트롤러 prefix는 `meetings`.

| 메서드 | 경로 | 응답 |
|---|---|---|
| `POST` | `/meetings/live` | 201, 회의 행. body `{ title?, processing?, speakers?, defer_lens?, defer_summary? }` (JSON). `recording` 회의가 있으면 409 |
| `POST` | `/meetings/:id/live/stop` | 200 `{ meeting_id, job_id, outcome: 'stopping' \| 'discarded' }`. `recording` 아니면 409 |
| `GET` | `/meetings/:id/live?after=<seq>` | 200 `{ stage, heartbeat_at, items: LiveUtterance[] }` |

- `processing`/`speakers`/`defer_*`의 파싱과 resolve는 업로드와 같은 코드를 쓴다. 다만 JSON
  body라 multipart 문자열 파싱은 거치지 않는다(reprocess가 하는 방식).
- `GET .../live`의 `items`는 `seq > after`인 행을 `seq` 오름차순으로 준다. `after` 생략은 전부.
  각 항목은 `{ id, seq, start_ms, end_ms, text, speaker_id, speaker_name, similarity }`.
  `speaker_name`은 조인으로 붙인다. `stage`는 `current_job_id`의 stage, `heartbeat_at`은 그
  job의 `locked_at`(heartbeat가 갱신하는 컬럼). 회의가 `recording`이 아니어도 200이다.
  `uploaded`/`processing` 동안 미리보기를 유지해야 하기 때문.
- 상세 조회 `GET /meetings/:id`는 `status: 'recording'`, `utterances: []`로 그대로 동작한다.
  라이브 행을 상세에 임베드하지 않는 이유는 메모와 같다. 1초마다 상세 캐시를 갈아 끼우면 그
  캐시를 구독하는 화면 전체가 리렌더된다.
- `DemoReadOnlyGuard`가 POST 둘을 자동으로 막는다.

## 7. 프론트엔드

### 7.1 데이터 레이어 — `fe/src/features/meeting/api/live.ts`

- `useStartLive()`: `POST /meetings/live` → 성공 시 `["meetings"]` 무효화, 상세로 이동.
- `useStopLive(id)`: `POST .../live/stop` → `["meeting", id]`, `["meetings"]` 무효화.
  `discarded`면 `/`로 이동.
- `useLiveUtterances(id, status)`: `["live-utterances", id]` 키. 마지막 `seq`를 `after`로 넘겨
  append만 한다. `enabled`는 `recording`/`uploaded`/`processing`/`failed`. `refetchInterval`은
  `recording`이면 1000, `uploaded`/`processing`이면 3000, `failed`는 한 번만 조회하고 폴링하지
  않는다(`done`은 조회 자체를 안 한다. persist가 행을 지웠다). 실패한 회의에 새로 진입해도 같은
  훅이 같은 조건으로 조회하므로 §2.4가 남겨 둔 행이 보인다. 탭이 뒤로 가면 TanStack Query
  기본대로 멈췄다가 복귀 시 커서로 따라잡는다.
- `model/types.ts`의 `MeetingStatus`에 `"recording"`, 새 `LiveUtterance` 타입. `api/types.ts`에
  wire 타입.

### 7.2 UI

- **진입**: `left-nav.tsx` 헤더의 "업로드" 옆에 "녹음" 버튼 → `ui/live-start-dialog.tsx`.
  업로드 모달에서 파일 필드만 뺀 것으로, 제목, `SpeakerCountField`, `OverrideSection`, 렌즈·요약
  자동 실행 세그먼트를 재사용한다. 제목 입력은 `녹음 YYYY-MM-DD HH:mm`(브라우저 시각)으로 미리
  채워 두고 사용자가 고칠 수 있다. 데모 빌드(`VITE_DEMO_MODE`)에서는 버튼을 숨긴다.
- **목록 뱃지**: `statusBadge`에 `recording` → "녹음 중".
- **회의 상세(`pages/meeting.tsx`)**: `status === "recording"`이면 `ProcessingBanner` 자리에
  `ui/live-banner.tsx`, 중앙에 `ui/live-transcript.tsx`. `tracks`가 비므로 플레이바는 기존
  조건으로 자연히 숨는다. 우측 인사이트 패널은 `done`이 아니면 이미 버튼이 잠기므로 안내
  문구 한 줄만 더한다.
- **`LiveBanner`**: 빨간 점, `recorded_at` 기준 경과 시간, "종료" 버튼. job이 `queued`면
  "워커를 기다리는 중"이고 종료는 폐기가 된다. `heartbeat_at`이 30초 넘게 멈추면 "워커 신호
  끊김"으로 바뀐다. 종료는 확인 없이 한 번에 누르고 "종료 중…"으로 잠긴다. 상태가 `uploaded`로
  바뀌면 기존 `ProcessingBanner`가 이어받는다.
- **`LiveTranscript`**: 발화를 시각·화자·텍스트로 나열. 새 행이 오면 바닥으로 따라가되
  사용자가 위로 스크롤하면 멈추고 "▼ 자동 따라가기" 버튼으로 복귀. 화자는 전부 "추정"이라
  흐린 톤(`--text-muted` 계열)으로, `similarity`를 "82%"처럼 옆에 붙인다. 미식별은 "화자 ?".
  `uploaded`/`processing` 동안에도 같은 컴포넌트가 미리보기로 남고, `done`이 되면 기존
  `TranscriptPane`으로 교체된다.
- **실패한 회의의 미리보기**: `status === "failed"`이고 라이브 행이 있으면 기존 실패 배너
  아래 중앙에 같은 `LiveTranscript`를 읽기 전용으로 그린다. 단 `meeting.tracks`가 비어 있을
  때만이다. 이전 처리 버전의 전사가 남아 있는 회의(재처리 실패)는 그 전사가 우선이고, 그런
  회의에는 라이브 행이 없다. 페이지가 `status !== "done"`이면 항상 `useLiveUtterances`를 켜므로
  새로 진입한 경우도 같은 경로다.
- **실패 배너**: `meeting.error.code === "audio_device_failed"`면 macOS 마이크 권한 안내를
  보여주고 재처리 버튼을 숨긴다(파일이 없다). 다른 실패는 기존 재처리 경로 그대로.
- 색·간격·상태 표현은 `fe/DESIGN.md`를 따른다. 새 토큰을 만들지 않는다.

## 8. 실패 처리

| 상황 | 워커 | 결과 | 사용자 경로 |
|---|---|---|---|
| 마이크를 못 염(권한 거부, 장치 없음) | PERMANENT `audio_device_failed`, 즉시 | 회의 `failed`, 파일 없음 | 권한 안내. 재처리 숨김. 삭제 |
| 클립 하나의 전사·임베딩 예외 | 로그, 건너뜀 | 세션 계속 | 없음 |
| 클립 5개 연속 실패 | PERMANENT `live_stt_failed`, finalize 없이 종료 | 회의 `failed`, 파일 있음 | 재처리 |
| 세션 중 자식 크래시(OOM, 디스크 풀) | 죽음. writer 스레드가 디스크에 닿은 프레임까지 파일에 있고 헤더는 스트리밍 값 | reaper가 stale 창(`REAPER_STALE_MINUTES`, 기본 30분) 뒤 job과 회의를 `failed`로 | 재처리. normalize가 헤더를 고치고 EOF까지 읽는다 |
| 루프 안 DB 오류 | 다음 클립에서 재접속 1회, WAV는 계속 | 오래 끊기면 finalize 실패 → 크래시 경로 | 재처리 |
| 워커 SIGTERM 1차 | stop과 동일하게 finalize | 정상 종료, 최종 패스 큐잉 | 없음 |
| 워커 SIGTERM 2차 | SIGKILL | 크래시 경로 | 재처리 |
| API `cancel`(기존 버리기) | heartbeat가 소유권 상실 감지 → 캡처 중단, 헤더 닫고 exit | 회의 `failed(cancelled)`, 파일 있음 | 재처리 또는 삭제 |
| stop 두 번 | 플래그 이미 있음 | 200 `stopping` 그대로 | 없음 |
| 상한 시간 도달 | stop과 동일 | 정상 종료 | 없음 |
| 최종 패스 실패 | 기존 동작 | 회의 `failed`, 라이브 행 남음 | 재처리. 미리보기로 뭐가 녹음됐는지는 보인다 |
| 옛 워커가 `live_session`을 claim | pydantic이 타입을 거부 → PERMANENT | 회의 `failed` | 워커 갱신 |

크래시 경로가 reaper의 stale 창에 기대므로 그동안 배너가 "녹음 중"을 보여줄 수 있다. §6의
`heartbeat_at`이 그 거짓 상태를 30초 안에 "워커 신호 끊김"으로 바꾸는 최소 장치다. 크래시를
즉시 감지해 supervisor가 job을 닫는 경로는 만들지 않는다. 부모가 자식의 job id를 모르고, 그
배관이 reaper 지연을 줄이는 값보다 크다.

## 9. 테스트

이 저장소의 원칙 그대로다. 결정적 glue는 fake 모델과 실제 Postgres(testcontainers)로 CI에서,
실모델은 로컬 smoke에서만.

**워커(pytest)**
- `test_wav_writer.py`: 열자마자 헤더 두 필드가 `0xFFFFFFFF`인지, `close()` 뒤 실제 값인지.
  close 없이 끊긴 파일(프레임을 쓰다 중간에 멈춘 것)을 `repair_streaming_header`로 고쳐 `soundfile`로
  열면 디스크에 닿은 프레임 수와 정확히 같은지. 홀수 바이트로 끊긴 파일이 샘플 경계로 내림되는지.
  정상 헤더 파일은 repair가 건드리지 않는지. `test_ffmpeg.py`에 normalize가 repair를 먼저 부르는지.
- `test_live_segmenter.py`: fake VAD 이벤트 시퀀스로 패딩·300ms 미만 버림·15초 강제 절단.
- `test_live_session.py`: 루프 전체. `FileSource`(즉시 모드)로 WAV를 흘리고 `FakeTranscriber`,
  `FakeEmbedder`, fake 스트리밍 VAD를 꽂는다. `live_utterance`의 seq 순서와 ms 오프셋, 미리
  심은 성문에 suggest 임계값으로 이름이 붙는지, `recorded_at` 갱신, stop 플래그를 읽고 멈추는지,
  finalize 트랜잭션의 네 단계(§4), finalize 전 cancel이면 discarded이고 WAV는 남는지.
  **쓰기 경로 분리**: transcriber가 오래 블록되는 fake를 꽂아도 파일의 프레임 수가 소스가 낸
  프레임 수와 같은지. preview 큐 상한을 작게 두고 넘치면 드롭 경고가 나되 파일은 온전한지.
  **종료 순서**: finalize의 INSERT 시점에 파일이 이미 닫혀 정확한 헤더를 갖는지.
- 실패 분류: 소스가 열리다 죽으면 `audio_device_failed`, 클립 5연속 예외면 `live_stt_failed`,
  둘 다 PERMANENT이고 회의가 `failed`.
- `test_db_lifecycle.py`: claim 우선순위. 더 늦게 들어온 `live_session`이 먼저 잡힌다.
- `test_reaper.py`: stale `live_session`이 회의를 `failed`로 닫는다.
- `test_db_persist.py`: persist가 그 회의의 라이브 행을 지운다.
- 시그널: `shutdown_event`가 서면 requeue가 아니라 finalize로 간다.
- `test_contracts_live.py` + 공용 fixture `live_session.valid.json`.

**API(jest)**
- 새 `test/live.e2e-spec.ts`: 시작이 201에 `recording` 회의, `max_attempts=1`인 `live_session`
  job, `process` 블록이 `buildProcessMeetingPayload` 결과와 같은지. 두 번째 시작 409.
  **동시 시작**: `Promise.all`로 시작 요청 둘을 같이 보내 정확히 하나가 201, 하나가 409이고 DB에
  `recording` 회의가 하나뿐인지(유일 인덱스 경로). `queued`에서 stop은 회의가 사라지고 `discarded`.
  SQL로 claim을 흉내 낸 `running`에서 stop은 `stop_requested_at`이 찍히고 두 번 눌러도 200.
  **stop과 claim의 경합**: 별도 커넥션의 트랜잭션이 job 행을 `FOR UPDATE`로 잡고 있는 동안
  claim SQL을 돌리면 그 job을 건너뛰는지(`SKIP LOCKED`), 그리고 반대로 claim이 먼저 커밋된 뒤
  stop이 `stopping`으로 가는지. `done` 회의에 stop은 409. `GET .../live?after=`가 커서 이후
  행만 주고 `stage`, `heartbeat_at`, `speaker_name`을 싣는지. `failed` 회의에서도 행을 주는지.
- `demo-read-only.e2e-spec.ts`: POST 둘이 403. `jobs.repository.spec.ts`: claim 우선순위.
  `reaper.spec.ts`: `live_session` 전파. `job-payload.spec.ts`: zod 스키마.
  `contract-fixtures.spec.ts`: 새 fixture.

**FE(vitest)**
- `live-start-dialog.test.tsx`: JSON body에 오버라이드와 미루기 플래그가 실리는지, 성공 시
  이동, 데모 빌드에서 버튼이 없는지.
- `live-transcript.test.tsx`: 커서로 append만 하는지, 위로 스크롤하면 따라가기가 꺼지고
  버튼으로 복귀하는지, "추정 82%"와 "화자 ?" 렌더링.
- `live-banner.test.tsx`: 경과 시간, `queued` 문구, 종료 클릭 뒤 "종료 중…", heartbeat 30초
  초과 시 "신호 끊김", `audio_device_failed`에서 재처리 버튼이 숨는지.
- `meeting.test.tsx`: `recording`이면 `LiveBanner`와 `LiveTranscript`가 뜨고 플레이바는 없다.
  `failed`이고 `tracks`가 비었고 라이브 행이 있으면 실패 배너 아래 읽기 전용 미리보기가 뜨고,
  `tracks`가 있으면 뜨지 않는다. `left-nav.test.tsx`: "녹음 중" 뱃지. `meetings.test.tsx`:
  폴링 간격 1초/3초, `failed`는 한 번만, `done`은 조회 안 함.

**Smoke(로컬, 실모델, CI 밖)**
- `worker/scripts/smoke_live_session.py`: `MicSource`로 60초, `FileSource`(실시간 모드)로
  알려진 녹음 하나. 세그먼트 끝에서 행 INSERT까지의 지연을 로그로 남겨 "1~2초"가 실측인지
  확인한다. `SMOKE.md`에 macOS 마이크 권한 절차와 함께 기록.
- 식별 적중률: 기존 `eval_speaker_id.py` 방식대로 같은 클립에 suggest 임계값과 bind 임계값을
  비교해 숫자를 남긴다. §2.8은 이 측정으로 되돌릴 수 있게.

## 10. 비목표와 후속

- **시스템 오디오**(Zoom·Meet 상대방 소리): `AudioSource` 구현체 추가와 payload `source`
  값 하나. ScreenCaptureKit / Core Audio process tap 스파이크 뒤에.
- **중간 요약**: 세션 중 1회 호출 버튼 형태로 검토. §2.2.
- **SSE**: §2.7. 커서 구조 덕에 추가만으로 된다.
- **돌고 있는 자식 선점**: supervisor가 queued `live_session`을 보면 현재 자식에 1차 SIGTERM을
  보내 stage 경계에서 `requeue_for_shutdown`으로 내려보내는 것. 실제로 불편하면.
- **라이브 화자 확정을 최종 패스 시드로**: 회의 중 사용자가 이름을 확정하면 최종 식별에
  "사람이 확인함" 등급을 더하는 것. 데이터가 쌓인 뒤.
- **브라우저 마이크**, **동시 세션 둘 이상**, **일시정지/재개**, **라이브 발화 편집**은 하지 않는다.

## 11. 살아있는 문서 갱신

구현과 함께 다음을 갱신한다. 이 스펙은 스냅샷이라 사후 편집하지 않는다.

- `be/CLAUDE.md`: 워커 섹션에 `live_session` 항목(2-pass, 파일 불변식, 재시도 없음, claim 우선순위).
- `be/docs/worker-architecture.md`: 제공 기능 표에 행 추가, §4에 세션 자식의 흐름.
- `be/worker/SMOKE.md`: 마이크 권한, smoke 스크립트, 지연·식별 실측.
- `deploy/README.md`: 마이크 권한 한 줄, "녹음 중에는 다른 처리가 대기한다".
- `fe/CLAUDE.md`: `recording` 상태와 `features/meeting`의 라이브 데이터 레이어.
- `fe/docs/product-concept.md`: 7장 파이프라인에 "앱 안 녹음 → 실시간 미리보기 → 배치 정본" 한 줄.
