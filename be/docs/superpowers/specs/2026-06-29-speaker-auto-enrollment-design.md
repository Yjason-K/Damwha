# Damwha 백엔드 — 회의 처리 시 화자 자동 등록 + 화자 이름 변경 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-06-29 · 대상: `src/` (NestJS API) + `worker/` (Python)
> 선행: Plan 1 (인제스션 API, 완료) · Plan 2 (ML 워커, 완료)
> 관련 코드: `src/meetings/meetings.service.ts:135`, `src/meetings/meetings.repository.ts:45,90`,
> `src/speakers/*`, `worker/damwha_worker/db.py`, `worker/damwha_worker/pipeline/process_meeting.py`

---

## 0. 범위

회의 처리(`process_meeting`) 시 **미식별 화자를 기본 이름의 `speaker` row로 자동 생성**하고, **화자 이름 변경(rename)** 기능을 추가한다. 자동 생성된 화자는 단일 회의 centroid로 만든 voiceprint를 갖지만, 사용자가 이름을 **확인(rename)하기 전까지는 매칭 후보에서 제외**한다(provisional). 자동 생성이 기존 수동 해소(`resolve`) 경로의 voiceprint를 오염시키지 않도록 **provenance 추적(`source_cluster_id`) + 재귀속(reattach) 정책**을 도입한다.

**범위에 포함:**
- migration `004` — `provisional` 상태값, 전역 시퀀스, `voiceprint.source_cluster_id` + 부분 유일 인덱스
- Worker persist 단계의 provisional 화자 + voiceprint 자동 생성 (가드 TX 내부)
- `PATCH /speakers/:id` 이름 변경 + provisional→ready 승격
- `resolve` 엔드포인트 재작성(병합·승격·멱등·고아정리·동시성)
- `GET /meetings/:id` utterance 응답에 화자 이름 join

**범위 밖:**
- diarization/STT/임베딩 등 ML 파이프라인 로직 변경 (worker, 현행 유지)
- 비파괴 머지/히스토리(Phase 3), 전용 "화자 병합" UI 엔드포인트
- reprocess 시 provisional 고아 정리(§9.4, 향후 과제)
- 운영 데이터 backfill 구현(§9.6, 필요 시점에 별도 처리)

---

## 1. 현행 동작 (변경 전)

- **매칭 자동 지정 — 이미 동작.** worker `process_meeting`이 diarize→임베딩→라벨별 centroid→`identify_clusters`(voiceprint 코사인 검색, `model`+`dimension` 일치 + `speaker.enrollment_status='ready'` + threshold)로 utterance에 `speaker_id`를 부여한다(`identify.py`).
- **미식별 화자 — `meeting_cluster`로만 보존.** sid=None 라벨은 `meeting_cluster(centroid, resolved_speaker_id=NULL)`로만 남고 **speaker로 생성되지 않는다.** (CLAUDE.md invariant: *"never force-created as speaker"*.)
- **수동 해소 — `POST /meetings/:id/clusters/:clusterId/resolve`.** `{speaker_id}` 또는 `{new_name}`으로 cluster를 기존/신규 speaker(`ready`)에 연결, utterance 일괄 배정, centroid를 voiceprint로 **INSERT**(`source='cluster_resolve'`).
- **이름 변경 — 없음.** utterance/cluster는 `speaker_id`(FK)만 참조하고 이름은 `speaker` row에만 있다.
- **GET 응답 — 이름 미포함.** `findUtterances`는 `speaker_id`만 반환하고 `speaker`를 join하지 않는다.

---

## 2. 의도적 invariant 변경

본 설계는 CLAUDE.md의 다음 invariant를 **의도적으로 변경**한다:

> 변경 전: *"Unidentified speakers are preserved as `meeting_cluster` rows (raw `diar_label`), never force-created as `speaker`."*
>
> 변경 후: *"Unidentified speakers are auto-created as **provisional** `speaker` rows (default name `Speaker_NNN`) with a voiceprint from the meeting centroid. Provisional speakers are excluded from identification (`identify` filters `enrollment_status='ready'`) until confirmed by rename. The `meeting_cluster` row is retained as the per-meeting `diar_label → speaker` resolution record (now with `resolved_speaker_id` set), and remains the unit of the `resolve` endpoint for re-assignment/merge."*

구현 후 CLAUDE.md의 해당 단락을 위 문구로 갱신한다. (specs/plans는 스냅샷이므로 본 문서는 사후 편집하지 않고, 구현 델타는 living doc에 기록한다.)

상태값 의미:

| `enrollment_status` | 의미 | voiceprint | 매칭 후보? |
|---|---|---|---|
| `pending` | enroll job 진행 중, voiceprint 아직 없음 (현행) | 없음 | ✗ |
| `provisional` | **자동 생성, voiceprint 있음, 미확인 (신규)** | 있음 (centroid 없는 라벨은 speaker 자체를 만들지 않음 — §4.1) | **✗** |
| `ready` | 확인됨(수동 enroll 완료 / provisional rename 승격 / resolve로 명명) | 보통 ≥1 (§9.5 예외) | ✓ |
| `failed` | enroll 실패 (현행) | 없음 | ✗ |

---

## 3. 데이터 모델 — migration `004_speaker_auto_enroll.sql`

```sql
-- 1) provisional 상태값 추가 (text + CHECK 진화 원칙)
ALTER TABLE speaker DROP CONSTRAINT speaker_enrollment_status_check;
ALTER TABLE speaker ADD CONSTRAINT speaker_enrollment_status_check
  CHECK (enrollment_status IN ('pending','ready','provisional','failed'));

-- 2) 기본 이름 전역 시퀀스 (중복 없는 Speaker_NNN)
CREATE SEQUENCE speaker_default_seq;

-- 3) voiceprint provenance: 어느 cluster centroid에서 만들어졌는가
ALTER TABLE voiceprint
  ADD COLUMN source_cluster_id uuid REFERENCES meeting_cluster(id) ON DELETE SET NULL;

-- 4) cluster당 voiceprint ≤ 1 (중복 삽입 구조적 차단 + UPSERT 대상)
CREATE UNIQUE INDEX voiceprint_source_cluster_uniq
  ON voiceprint (source_cluster_id) WHERE source_cluster_id IS NOT NULL;
```

설계 근거:
- **`provisional`은 DB 컬럼 값일 뿐 job payload 계약(zod/pydantic)과 무관** → `src/contracts/`, `worker/damwha_worker/contracts.py`, 픽스처 **변경 없음**. (계약 드리프트 위험 없음.)
- **`source_cluster_id` `ON DELETE SET NULL`**: reprocess가 `meeting_cluster`를 DELETE해도 *확인된(ready)* 화자의 voiceprint는 살아남고(링크만 NULL이 됨) `CASCADE`처럼 enrollment를 파괴하지 않는다.
- **부분 유일 인덱스**(`WHERE source_cluster_id IS NOT NULL`): cluster 1개당 voiceprint 1개를 구조적으로 강제 → resolve 반복 호출 시 중복 삽입 불가. NULL(enroll·legacy voiceprint)은 인덱스에서 제외되므로 기존 row와 무관하게 인덱스 생성이 성공한다.

---

## 4. Worker — persist 단계의 자동 생성

`run_process_meeting`의 identify/utterance/cluster 구성 로직은 **변경하지 않는다.** 변경은 `db.persist_process_meeting`의 **가드 트랜잭션 내부(fresh 경로)** 에 한정된다.

### 4.1 persist 흐름 (fresh 경로, 가드 통과 이후)

기존: utterance INSERT → cluster INSERT. 변경 후 **순서를 재구성**한다(cluster id가 voiceprint의 `source_cluster_id`에 필요하므로):

1. `label → speaker_id` 맵을 만든다. 전달받은 `clusters`(=미식별 라벨, centroid 보유) 각각에 대해:
   - **centroid 있음:**
     - `INSERT INTO speaker(name, enrollment_status) VALUES (:prefix || '_' || lpad(nextval('speaker_default_seq')::text, 3, '0'), 'provisional') RETURNING id` → `sid`
     - `INSERT INTO meeting_cluster(meeting_id, diar_label, centroid, resolved_speaker_id, processing_version, job_id) VALUES (..., :sid, ...) RETURNING id` → `cid`
     - `INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source, source_cluster_id) VALUES (:sid, :centroid, :model, :dim, 'auto_cluster', :cid)`
     - 맵에 `label → sid` 기록
   - **centroid 없음 (방어적 엣지):** speaker/voiceprint 생성을 **생략**하고 `meeting_cluster(resolved_speaker_id=NULL)` (레거시형 미해소 cluster)만 INSERT한다. 해당 라벨은 맵에 없으므로 utterance `speaker_id`는 NULL로 남는다.
2. utterance INSERT: `speaker_id = (identify가 준 매칭 sid) OR 맵[diar_label]`.
3. job done + (조건부) `index_meeting` enqueue — 현행 유지.

> 매칭된 라벨은 현행과 동일(cluster 미생성, utterance에 기존 `speaker_id`). centroid는 라벨마다 항상 존재하는 것이 정상이므로 centroid 없음 경로는 방어적 분기다.

### 4.2 가드 의미 (테스트 표현 정정)

- **meeting 가드 0-row (stale/discarded):** persist는 fresh 경로(DELETE/INSERT)에 진입하지 않는다. 따라서 **새 결과를 생성하지 않고 기존 결과를 보존**하며, job만 `done` + `discarded_by_stale_guard` 사유로 마킹한다. *("롤백"이 아님 — 애초에 쓰지 않음.)*
- **job ownership 0-row (lost):** `_Abort` → 트랜잭션 rollback → persist가 `"lost"` 반환. 이번 호출이 만든 speaker/voiceprint/utterance/cluster가 모두 없던 일이 된다. **job lifecycle은 그대로**(lock은 다른 워커 소유).
- **persist 중 일반 예외(예: DB 오류):** `with conn.transaction()`가 예외로 빠져나가 rollback되고, **예외가 `handle_job`까지 전파**된다 → `classify` 후 transient면 requeue(시도 남으면)·아니면 fail. 결과 row가 사라지는 것은 lost와 같지만 **job lifecycle이 다르다**(`_Abort`/`"lost"`가 아니라 requeue/fail).

### 4.3 설정 배선

- `worker/damwha_worker/config.py`: `Settings.default_speaker_prefix: str = "Speaker"` 추가 + **빈 문자열/공백 거부 validator**(strip 후 비면 오류, **strip된 값을 반환**해 양끝 공백이 이름에 새지 않게 한다).
- 전달 경로: `dispatch_claimed_job` → `handle_job`(현재 `search_embedding` 튜플과 동일 방식) → `run_process_meeting` → `persist_process_meeting`. persist는 추가로 `embedding_model`/`embedding_dim`(=`payload.models.embedding.model/dimension`)을 받아 voiceprint에 기록한다.
- `run_process_meeting`/`persist_process_meeting`의 prefix 기본 인자는 테스트 편의를 위해 `"Speaker"`로 둔다.

---

## 5. Worker — identify는 변경 없음

`identify_clusters`는 이미 `s.enrollment_status = 'ready'`만 후보로 사용한다(`identify.py:39`). provisional 화자는 자동으로 제외되어, **확인(rename→ready) 전에는 다음 회의에서 매칭되지 않는다.** "음성 저장 + 확인 후 매칭" 요건이 코드 변경 없이 충족된다.

---

## 6. API — `resolve` 재작성 (오염 방지의 핵심)

`POST /meetings/:id/clusters/:clusterId/resolve`. 자동 생성 도입 후 cluster는 보통 이미 `resolved_speaker_id`(provisional)를 갖는다. resolve는 이제 **명명(확정)·병합·재지정** 도구다. 모든 작업은 단일 `db.withTransaction` 안에서 수행한다.

### 6.1 동시성 — cluster + speaker row 잠금

cluster row만 잠그면 `resolve`끼리만 직렬화될 뿐, **`PATCH /speakers/:id`(cluster를 잠그지 않음)와는 직렬화되지 않는다.** 그러면 resolve의 매트릭스 평가(§6.3)와 PATCH의 상태 변경이 겹쳐 **torn 상태**(반쯤 적용된 재지정 + 동시 승격)가 생길 수 있다. 따라서 cluster에 더해 **관련 speaker row(`S_prev`, `T`)도 잠가** 두 연산을 **하나의 명확한 순서로 직렬화**한다.

> 직렬화는 **순서를 보장할 뿐 결과를 강제하지 않는다.** PATCH가 먼저 커밋되면 A는 ready로 승격된 뒤 resolve가 A→T 재지정을 수행하고, A는 ready로 보존된 채 voiceprint가 0개가 될 수 있다 — 이는 §9.5에서 허용한 정상 결과다(오매칭 위험 없음). 잠금이 막는 것은 *고아*가 아니라 *torn 상태/중복 적용*이다.

1) 대상 cluster를 `FOR UPDATE`로 잠근다:

```sql
SELECT id, meeting_id, diar_label, resolved_speaker_id, (centroid IS NOT NULL) AS has_centroid
FROM meeting_cluster
WHERE id=$1 AND meeting_id=$2
FOR UPDATE;
```

없으면 404. `S_prev := resolved_speaker_id`.

2) 관련 speaker(`S_prev`가 NULL 아니면 포함, `speaker_id`(T)가 주어지면 포함)를 **id 순서로** 잠근다 — PATCH의 `UPDATE speaker`(암묵적 row lock)와 실제로 직렬화하고, 동시 resolve 간 데드락(잠금 순서 역전)을 피한다:

```sql
SELECT id, enrollment_status
FROM speaker
WHERE id = ANY($1)        -- [S_prev, T] 중 non-null
ORDER BY id
FOR UPDATE;
```

T를 지정했는데 row가 없으면 404. **§6.3 매트릭스는 이 잠금 이후 읽은 `enrollment_status`로 평가한다** — speaker 잠금을 획득한 뒤의 PATCH는 우리 TX 커밋까지 차단되므로, 잠금 하의 상태값이 트랜잭션 동안 권위 있는 값이다.

### 6.2 입력 검증

- `speaker_id`와 `new_name`은 **정확히 하나만** 허용. 둘 다/둘 다 없음 → **400**.
- `new_name`은 PATCH와 동일하게 검증: `typeof === 'string'` 아니면 400, `trim()` 후 빈 값 또는 100자 초과면 400.
- `speaker_id`(=T)는 **문자열 UUID 형식**이어야 한다 — 형식 위반이면 **400**(PostgreSQL `uuid` cast 500 방지). 형식은 맞지만 존재하지 않으면 **404**. (path의 `meetingId`/`clusterId`는 컨트롤러 `ParseUUIDPipe`로 검증되지만 **body의 `speaker_id`는 수동 검증**해야 한다.)

### 6.3 입력·상태 매트릭스

병합 대상 `T`(=`speaker_id`)의 허용 상태:

| `T` 상태 | 동작 |
|---|---|
| `ready` | 일반 병합 |
| `provisional` | 병합 허용 (provisional끼리 묶고 이후 rename으로 확인) |
| `pending` / `failed` | **409** (enroll 진행/실패 화자로 병합 불가) |

`new_name`(N) 처리는 `S_prev`(cluster의 현재 화자) 상태로 분기:

| `S_prev` 상태 | `new_name` 동작 |
|---|---|
| `provisional` | 해당 speaker를 **rename + ready 승격** (신규 생성 없음, 고아 없음). voiceprint는 이미 보유 → 즉시 매칭 활성 |
| `NULL` (레거시 미해소) | 새 `ready` speaker 생성 + utterance 배정 + voiceprint UPSERT(§6.5) |
| `ready` | **409** (`PATCH /speakers/:id`로 rename하거나 `speaker_id`로 병합 안내 — 공유 화자의 의도치 않은 전역 rename 방지) |
| `pending` / `failed` | **409** (방어적; 자동 경로에선 발생하지 않음) |

### 6.4 `speaker_id`(T) 병합 처리 순서

1. utterance 재지정: `UPDATE utterance SET speaker_id=T WHERE meeting_id=$meeting AND diar_label=$label`.
2. cluster 재지정: `UPDATE meeting_cluster SET resolved_speaker_id=T WHERE id=$cluster`.
3. **voiceprint 재귀속(§6.5)** — cluster 유래 voiceprint를 T로 *이동*(복사 아님, 멱등).
4. **고아 정리(§6.6)** — `S_prev`가 provisional이고 더 이상 참조되지 않으면 원자적 조건부 DELETE.

(3을 4보다 먼저 — 먼저 voiceprint를 T로 옮긴 뒤 `S_prev`를 지워야 cascade가 옮긴 voiceprint를 건드리지 않는다.)

### 6.5 voiceprint 재귀속 — UPSERT (멱등, 중복 불가)

복사가 아니라 **cluster당 1개 voiceprint를 현재 resolved 화자로 재귀속**한다. 부분 유일 인덱스(`source_cluster_id`)를 대상으로 하므로 **predicate를 포함**해야 인덱스가 추론된다:

```sql
INSERT INTO voiceprint(speaker_id, embedding, model, dimension, source, source_cluster_id)
SELECT $speaker, centroid, $model, $dim, 'cluster_resolve', id
FROM meeting_cluster
WHERE id = $cluster AND centroid IS NOT NULL
ON CONFLICT (source_cluster_id) WHERE source_cluster_id IS NOT NULL
DO UPDATE SET speaker_id = EXCLUDED.speaker_id;
```

- 자동 생성된 cluster(이미 `source_cluster_id` voiceprint 존재) → **CONFLICT → `speaker_id`만 갱신**(=재귀속). 반복 호출/같은 target 재지정 모두 무해.
- 레거시 미해소 cluster(voiceprint 없음, centroid 있음) → **INSERT**(최초 1회).
- centroid 없는 cluster → `SELECT`가 0행 → 아무 일도 없음(voiceprint 미생성).

**`source` 의미:** CONFLICT 시 `DO UPDATE`는 **`speaker_id`만 변경하고 `source`/`embedding`/`model`/`dimension`은 보존**한다. 즉 `source`는 **"최초 생성 출처"** 의미다 — 자동 생성 voiceprint는 재귀속 후에도 `source='auto_cluster'`로 남는다. ("마지막 작업" 의미가 필요해지면 그때 `DO UPDATE`에 `source='cluster_resolve'`를 추가한다 — 현재는 불필요.)

이 한 문장이 §6.4-3(병합 재귀속), §6.3 레거시 INSERT를 모두 멱등하게 처리한다.

### 6.6 고아 정리 — 원자적 조건부 DELETE

최초 조회 상태를 신뢰하지 않고, **조건을 DELETE의 WHERE에 직접** 넣어 동시성 안전을 확보한다(특히 PATCH가 동시에 `provisional→ready`로 승격했다면 ready 화자가 삭제되면 안 됨 — `enrollment_status='provisional'` 가드가 이를 막음):

```sql
DELETE FROM speaker s
WHERE s.id = $s_prev
  AND s.enrollment_status = 'provisional'
  AND NOT EXISTS (SELECT 1 FROM utterance WHERE speaker_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM meeting_cluster WHERE resolved_speaker_id = s.id);
```

voiceprint는 FK cascade로 함께 삭제된다(이미 §6.5에서 T로 옮긴 것은 영향 없음). ready 화자는 어떤 경우에도 자동 삭제되지 않는다.

### 6.7 응답 — `updated_utterances`를 모든 성공 경로에서 통일

`updated_utterances` 값이 경로마다 달라지지 않도록(기존 API 호환), **모든 성공 경로가 최종 화자로의 동일한 bulk assign을 실행**하고 그 `rowCount`를 반환한다:

```sql
UPDATE utterance SET speaker_id = :final
WHERE meeting_id = :meeting AND diar_label = :label;
```

- provisional `new_name` 승격처럼 utterance가 **이미 같은 화자에 배정**돼 값이 안 바뀌어도 실행한다 — PostgreSQL `rowCount`는 **매칭 행 수**를 세므로 값 불변이어도 카운트된다.
- 같은 `speaker_id`로 반복 resolve, centroid 없는 legacy cluster도 동일하게 카운트된다.
- 따라서 `updated_utterances`는 항상 **"해당 `diar_label`의 발화 수"** 를 뜻한다.

응답: `{ speaker_id: <최종 화자>, updated_utterances: <rowCount>, merged_speaker_deleted: <boolean> }`.

---

## 7. API — 이름 변경 `PATCH /speakers/:id`

- 컨트롤러: `@Patch(':id')` body `{ name: string }`.
- **수동 검증**(global `ValidationPipe` 없음 — `main.ts` 확인): `typeof body?.name !== 'string'` → 400; `const name = body.name.trim(); if (!name || name.length > 100)` → 400. 없는 id → 404.
- 리포지토리:

```sql
UPDATE speaker
SET name = $2,
    enrollment_status = CASE WHEN enrollment_status='provisional' THEN 'ready' ELSE enrollment_status END
WHERE id = $1
RETURNING *;
```

- **`provisional`만 `ready`로 승격**(=확인). `pending`/`failed`/`ready`는 상태 불변, 이름만 변경.
- 전파: utterance/cluster는 `speaker_id` FK만 참조 → 이름 변경이 모든 참조에 자동 반영, 추가 쓰기 불필요.
- 추가: `SpeakersRepository.rename`, `SpeakersService.rename`, 컨트롤러 `@Patch`.

---

## 8. API — GET 응답에 화자 이름 join

자동 생성 이름(`Speaker_001`)과 rename 결과가 회의 화면에 보이도록 `MeetingsRepository.findUtterances`에 speaker join을 추가한다:

```sql
SELECT u.*, s.name AS speaker_name, s.enrollment_status AS speaker_status
FROM utterance u
LEFT JOIN speaker s ON s.id = u.speaker_id
WHERE u.meeting_id = $1
ORDER BY u.order_index ASC;
```

`GET /meetings/:id`의 각 utterance에 `speaker_name`(미배정이면 NULL), `speaker_status`가 포함된다. 이로써 rename이 회의 응답에서 E2E로 관측 가능하고, 자동 생성 이름 자체가 비로소 사용자에게 노출된다(기능 가치의 전제).

---

## 9. 정상 동작 / 알려진 한계 (문서화)

1. **시퀀스 간격은 정상 + 이름 유일성 범위.** PostgreSQL 시퀀스는 TX 롤백 시 `nextval`을 복구하지 않는다. lost/예외로 persist가 롤백되면 `Speaker_001, Speaker_003`처럼 번호가 비며, 이는 정상 동작이다. 시퀀스는 **자동 생성 번호만** 유일하게 한다 — `speaker.name`에는 UNIQUE 제약이 없으므로 사용자가 rename/resolve로 수동으로 같은 이름(또는 `Speaker_001` 같은 형식)을 만들 수 있다(의도된 동작; 충돌 방지는 자동 경로에만 보장).
2. **999 초과.** `lpad(...,3,'0')`은 1000부터 `Speaker_1000`이 된다(폭이 늘어날 뿐 유일성 유지). 의도된 동작.
3. **테스트 시퀀스 리셋.** `test/db.ts`의 `TRUNCATE ... RESTART IDENTITY`는 컬럼 소유(serial/identity) 시퀀스만 리셋하므로 독립 시퀀스 `speaker_default_seq`는 리셋되지 않는다. → reset 헬퍼에 `ALTER SEQUENCE speaker_default_seq RESTART;`를 추가한다. 단, 테스트는 절대 시작 번호 대신 **형식(`/^Speaker_\d{3,}$/`)·유일성·단조성**을 단정한다.
4. **reprocess 고아.** reprocess 시 미확인 provisional 화자는 매칭(ready)되지 않으므로 새 provisional이 다시 생성되고, 이전 provisional 화자 row + voiceprint는 고아로 남는다(utterance/cluster는 persist의 DELETE로 정리됨; voiceprint는 `source_cluster_id`가 SET NULL됨). provisional은 매칭에서 제외되므로 **다른 회의를 오염시키지 않는다.** Phase 1(overwrite, no history) 정책과 일관 → **정리는 향후 과제로 문서화만** 한다. (이미 확인된 ready 화자는 voiceprint가 남아 reprocess 시 **일반적으로 재매칭 가능**하다 — 단 코사인 threshold 때문에 매칭이 보장되지는 않는다.)
5. **ready의 voiceprint 0개 가능.** `ready A → ready B` 재지정으로 A의 유일한 cluster 유래 voiceprint가 B로 이동하면 A는 ready지만 voiceprint 0개가 될 수 있다. 오매칭 위험은 없다(후보 행이 없을 뿐). 문구로 명시: *"ready는 확인 상태이며 DB가 voiceprint 존재를 보장하지 않는다. 재지정 결과 voiceprint가 0개가 될 수 있고, 이 경우 매칭 후보 행이 없어 실질적으로 매칭되지 않는다."*
6. **레거시 voiceprint backfill.** 기존 `cluster_resolve` voiceprint는 `source_cluster_id=NULL`이다. 같은 cluster를 다시 resolve하면 NULL은 부분 유일 인덱스에서 제외되어 CONFLICT가 발생하지 않으므로 **새 voiceprint가 추가되어 중복**될 수 있다. **개발 DB를 초기화할 수 있으면 비고만** 남긴다. 운영 데이터를 보존해야 한다면, migration에서 `voiceprint.speaker_id = meeting_cluster.resolved_speaker_id`이고 임베딩이 일치하는 **안전하게 매칭 가능한 행만** `source_cluster_id`를 backfill한다(모호한 행은 건드리지 않음). 본 설계는 **초기화 가능 가정** → backfill 미구현, 필요 시점에 별도 처리.

---

## 10. 테스트

**migration** (`test/migration.spec.ts`)
- `provisional` CHECK 허용·미허용 값 거부; `speaker_default_seq` 존재; `voiceprint.source_cluster_id` 컬럼 존재.
- 부분 유일 인덱스는 **존재만이 아니라 동작 검증**: 동일한 non-null `source_cluster_id`로 2회 INSERT → **unique 위반**; `source_cluster_id=NULL` voiceprint 여러 개 → **허용**.

**worker** (`worker/tests/`)
- `test_db_persist.py`: 미식별 라벨 → provisional 화자 + voiceprint(`source_cluster_id` 채워짐, `source='auto_cluster'`) 생성; `label→speaker` 매핑이 utterance에 반영; **centroid=None → speaker/voiceprint 미생성 + 미해소 cluster 행 유지**; 매칭 라벨은 cluster 미생성·기존 speaker_id 유지; **stale(meeting 가드 0행) → 새 결과 미생성·기존 보존, persist가 `"discarded"` 반환**; **lost(job ownership 0행) → 전부 rollback + persist가 `"lost"` 반환**; **persist 중 일반 예외 → 전부 rollback + 예외가 호출자로 전파**(`"lost"` 아님); 두 회의 처리 시 이름 유일성(형식·단조성).
- `test_identify.py`: provisional 화자는 매칭 후보에서 제외.
- `test_process_meeting.py`: fakes e2e — 미식별 라벨이 provisional 화자로 utterance에 부여됨.
- `test_config.py`: `default_speaker_prefix` 빈/공백 거부; **배선 테스트** — 설정 prefix가 dispatch→run→persist까지 전달되어 이름 prefix로 사용됨.

**API** (`test/`)
- `clusters.e2e-spec.ts`:
  - provisional → 기존 ready 화자 병합 시 **기존 provisional/voiceprint 정리**(고아 DELETE), voiceprint가 target으로 재귀속(중복 0).
  - `new_name`이 **새 speaker 생성 없이 provisional을 rename+ready 승격**.
  - **동일 cluster 반복 resolve 시 voiceprint 중복 없음**(부분 유일 인덱스 + UPSERT).
  - **ready A → ready B 재지정**: voiceprint가 B로 이동, A는 삭제되지 않음(ready), A의 다른 voiceprint 불변.
  - `speaker_id`+`new_name` 동시 → 400; **malformed `speaker_id`(비 UUID) → 400**; 유효 UUID 미존재 → 404; T가 `pending`/`failed` → 409; `S_prev`가 ready + `new_name` → 409.
  - legacy(`resolved_speaker_id=NULL`) cluster에서만 `new_name`이 신규 speaker 생성.
  - 모든 성공 경로에서 `updated_utterances` = 해당 `diar_label` 발화 수(provisional 승격·반복 resolve 포함).
  - **동시성**: 병합 resolve와 `PATCH /speakers/:id`(같은 `S_prev`를 `provisional→ready` 승격)를 동시에 실행 — speaker 잠금으로 직렬화되어 **둘 중 하나의 순서로 일관 종료**(torn 상태·중복 적용 없음). 기대 결과:
    - **resolve 선행**: provisional A가 고아로 삭제되고, 이후 PATCH는 **404**.
    - **PATCH 선행**: A가 **ready로 보존**되고 resolve 완료 후 A의 voiceprint가 0개가 될 수 있음(§9.5 허용, 정상).
    - 어떤 순서든 **중간 혼합 상태나 ready 화자 자동 삭제는 없음**.
- `speakers.e2e-spec.ts`: rename 200 + 상태 전이; provisional→ready 승격; **pending/failed/ready 상태 불변**; 404; **비문자열/빈/100자 초과 name → 400**.
- `meetings.e2e-spec.ts`: utterance 응답에 `speaker_name`/`speaker_status` 포함; rename 후 회의 응답 이름 전파 확인.

---

## 11. 변경 파일 요약

**신규**
- `src/database/migrations/004_speaker_auto_enroll.sql`

**수정 (API)**
- `src/speakers/speakers.repository.ts` — `rename`
- `src/speakers/speakers.service.ts` — `rename`(검증)
- `src/speakers/speakers.controller.ts` — `@Patch(':id')`
- `src/meetings/meetings.service.ts` — `resolveCluster` 재작성(잠금·매트릭스·재귀속·고아정리)
- `src/meetings/meetings.repository.ts` — cluster `FOR UPDATE` 조회, voiceprint UPSERT, 고아 조건부 DELETE, `findUtterances` speaker join
- `src/meetings/clusters.controller.ts` — 입력 검증/응답 보강(필요 시)

**수정 (worker)**
- `worker/damwha_worker/config.py` — `default_speaker_prefix` + validator
- `worker/damwha_worker/db.py` — `persist_process_meeting`에 provisional 생성/voiceprint/배선 인자
- `worker/damwha_worker/pipeline/process_meeting.py` — prefix/embedding 인자 전달
- `worker/damwha_worker/__main__.py` — dispatch 배선

**수정 (테스트)**
- `test/db.ts` — reset에 `ALTER SEQUENCE speaker_default_seq RESTART`
- `test/{migration,clusters,speakers,meetings}.e2e-spec.ts` (또는 해당 spec), `worker/tests/{test_db_persist,test_identify,test_process_meeting,test_config}.py`

**문서**
- `CLAUDE.md` — speaker identification invariant 단락 갱신(§2)
