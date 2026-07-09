# Damwha 백엔드 — Worker 정확도 수정 2건 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-07-09 · 대상: `worker/` (Python ML 워커)
> 선행: Plan 2 (Python ML 워커, 완료) · 워커 스펙: `2026-06-23-damwha-ml-worker-design.md`
> 배경: 워커 코드 비판적 검토에서 발견된 정확도 결함 2건의 수정 설계.

---

## 0. 이 문서의 범위

워커 내부 정확도 결함 2건을 고친다. **job payload 계약(zod/pydantic), DB 스키마, NestJS `src/` 코드는 변경하지 않는다** — 워커 내부 + 워커 테스트 + 기존 오염 데이터 정리용 마이그레이션 1건(§1.4)만 추가한다.

1. **Zero-vector 임베딩이 centroid를 오염** — 100ms 미만 diar 세그먼트에 대해 ECAPA 어댑터가 `[0.0]*192` sentinel을 반환하고, 이 값이 centroid 평균·voiceprint 저장·enroll 경로에 그대로 흘러든다.
2. **`transcribe_failed` vs `silence` 오분류** — STT가 word를 하나라도 반환하면 word 없는 세그먼트가 전부 `silence`로 기록된다(부분 STT 실패가 침묵으로 위장됨).

**범위 밖:** 모델 캐싱, 폴 루프 재접속, heartbeat 재시도, graceful shutdown, 배치 INSERT, timed backoff (검토에서 함께 발견됐으나 별도 작업).

---

## 1. 결함 1 — zero-vector 임베딩 (선택안: B, 계약을 정직하게)

### 1.1 현재 동작과 문제

- `models/ecapa_embed.py`: 클립이 100ms 미만이면 `[0.0]*192`를 반환한다. "값처럼 보이는 에러"다.
- `pipeline/identify.py` `centroids_by_label`: zero 벡터를 평균에 그대로 포함 → centroid가 0 방향으로 희석되어 식별 정확도가 떨어진다. 어떤 라벨의 세그먼트가 전부 짧으면 centroid 자체가 zero → 미식별 처리 후 persist가 zero centroid로 provisional speaker + `auto_cluster` voiceprint를 만든다(pgvector cosine 연산에 NaN 유입).
- `pipeline/enroll_speaker.py`: 등록 샘플이 100ms 미만이면 zero 벡터가 `'enroll'` source voiceprint로 저장되고 speaker가 `ready`가 된다 — 이후 모든 identify 쿼리에 NaN이 섞인다(잠복 버그).

### 1.2 설계

sentinel을 제거하고 임베딩 부재를 타입으로 표현한다: **너무 짧은 세그먼트의 임베딩은 `None`**.

- **`models/base.py`** — `Embedder` 프로토콜 시그니처 변경:
  `embed(wav_path, segments) -> list[list[float] | None]` (`None` = 세그먼트가 짧아 임베딩 신뢰 불가). 반환 리스트 길이는 여전히 `segments`와 1:1.
- **`models/ecapa_embed.py`** — 100ms 미만 클립에 `None` 반환(zero sentinel 삭제). 100ms 기준값 자체는 유지. "너무 짧음" 판정은 모듈 수준 순수 헬퍼로 분리한다(예: `too_short_for_embedding(n_samples, sr)`) — `ecapa_embed.py`의 top-level import는 `.base`뿐이라 이 헬퍼는 `models` extra 없이 CI에서 직접 테스트 가능하다. 실모델 `embed` 경로는 헬퍼를 호출하고, 어댑터 전체는 기존대로 SMOKE에서 검증한다.
- **`pipeline/identify.py` `centroids_by_label`** — `None`을 제외하고 평균. 유효 임베딩이 0개인 라벨은 **dict에 남기되 값을 `None`으로** 둔다(라벨 → cluster row 보존 경로 유지). 반환 타입: `dict[str, list[float] | None]`.
- **`pipeline/identify.py` `identify_clusters`** — centroid가 `None`인 라벨은 DB 조회 없이 미식별(`None`) 처리.
- **persist (`db.py`) — 변경 없음.** centroid `None`인 cluster는 이미 speaker/voiceprint 생성 없이 cluster row만 보존한다(기존 분기).
- **`pipeline/enroll_speaker.py`** — 전체 파일 임베딩이 `None`이면 `WorkerError("sample_too_short", ..., ErrorKind.PERMANENT)`를 던진다. 기존 실패 경로(`handle_job` → `db.fail_enroll`)가 speaker를 `failed` + 에러 메시지로 전이시킨다. `errors.py`에 `SAMPLE_TOO_SHORT = "sample_too_short"` 코드 상수를 추가한다(error jsonb의 `code`는 자유 문자열 — API 측 변경 불요).
- **`tests/fakes.py`** — fake Embedder가 `None`을 낼 수 있도록 갱신.

### 1.3 결과 의미론

- 짧은 세그먼트가 섞인 라벨: 유효 임베딩만으로 centroid 계산 → 식별 정확도 개선.
- 전부 짧은 라벨: centroid `None` → 미식별 cluster row(voiceprint·provisional speaker 없음)로 보존, utterance는 `diar_label`만 갖고 speaker `NULL`.
- 100ms 미만 enroll 샘플: PERMANENT 실패, speaker `enrollment_status='failed'` + `sample_too_short`.

### 1.4 기존 오염 데이터 정리 (마이그레이션)

이 설계는 미래 쓰기만 차단한다 — 현재 워커를 이미 실행한 DB에는 zero-vector voiceprint(`auto_cluster`/`enroll` source 모두 가능)가 남아 identify 쿼리에 계속 NaN을 유입시킨다. `voiceprint.embedding`은 `vector(192) NOT NULL`일 뿐 non-zero 가드가 없다(`001_init.sql`).

일회성 데이터 정리 마이그레이션을 추가한다(스키마 변경 아님, 리포 관례인 numbered SQL):

```sql
-- 00X_delete_zero_voiceprints.sql
DELETE FROM voiceprint WHERE vector_norm(embedding) = 0;
```

- `auto_cluster` zero voiceprint 삭제 → provisional speaker는 cluster 참조가 남아 유지(persist GC 조건과 정합).
- `enroll` zero voiceprint 삭제 → `ready` speaker는 voiceprint 없이 남음 — identify에 매칭되지 않을 뿐이며, 재등록으로 복구.
- CHECK 제약(`vector_norm > 0`) 추가는 기각: 워커가 이제 zero를 쓰지 않으므로 YAGNI.

---

## 2. 결함 2 — `transcribe_failed` vs `silence` (선택안: A, speech_spans 항상 전달)

### 2.1 현재 동작과 문제

`pipeline/process_meeting.py`:

```python
utts = build_utterances(words, segments, failed_spans=speech_spans if not words else None)
```

`failed_spans`가 **전체 words가 0일 때만** 전달된다. STT가 부분 실패하면(일부 세그먼트만 word 없음, VAD는 speech 감지) 해당 세그먼트가 `silence`로 기록된다 — 실패가 침묵으로 위장된다. `build_utterances`는 이미 세그먼트별 overlap 판정 로직을 갖고 있는데 호출부가 무력화하고 있다.

### 2.2 설계

조건을 제거하고 항상 전달한다:

```python
utts = build_utterances(words, segments, failed_spans=speech_spans)
```

`align.py`는 변경 없음. 의미론: **word 없는 세그먼트가 VAD speech span과 겹치면 `transcribe_failed`, 아니면 `silence`** — 전역이 아닌 세그먼트별 판정.

알려진 트레이드오프: VAD false-positive(노이즈) 세그먼트가 `silence` 대신 `transcribe_failed`로 기록될 수 있다. "VAD가 speech라 했는데 STT 결과가 없다"는 사실 기술로서 그쪽이 더 정직하다고 판단, overlap 비율 임계값(knob 추가)은 기각했다.

---

## 3. 테스트

기존 패턴 유지: fake 모델 + testcontainers Postgres, 실모델 없음.

- **identify** (`tests/test_identify.py`):
  - `None` 섞인 임베딩 → 유효 벡터만으로 centroid 평균.
  - 전부 `None`인 라벨 → centroid `None` 유지(라벨은 dict에 존재).
  - `identify_clusters`: centroid `None` → DB 조회 없이 미식별.
- **process_meeting** (`tests/test_process_meeting.py`):
  - centroid `None` cluster가 provisional speaker/voiceprint 없이 cluster row로 보존되는 end-to-end 경로.
- **enroll** (`tests/test_enroll_speaker.py`):
  - fake embedder가 `None` 반환 → job `failed`(PERMANENT, `sample_too_short`) + speaker `enrollment_status='failed'`.
- **결함 2 회귀 테스트는 호출부 레벨이 필수** (`tests/test_process_meeting.py`):
  - `align.py`는 이미 per-segment 판정을 지원하므로 align 단독 테스트는 수정 전 코드에서도 통과한다 — 버그는 `process_meeting.py`의 호출부 조건이다. 따라서 **`run_process_meeting`을 통과하는 테스트**로 검증한다: fake STT가 word를 일부 반환(비어있지 않음) + word 없는 세그먼트가 VAD speech span과 overlap → 해당 utterance가 `transcribe_failed`로 persist됨(수정 전 코드에서는 `silence`로 기록되어 실패해야 하는 테스트). overlap 없는 빈 세그먼트 → `silence`.
  - `test_align.py`에 세그먼트별 케이스를 보강하는 것은 부차 — 호출부 테스트를 대체할 수 없다.
- **ECAPA "너무 짧음" 헬퍼** (`tests/test_ecapa_helpers.py` 또는 기존 파일):
  - `too_short_for_embedding` 순수 헬퍼를 CI에서 직접 테스트(경계값: 100ms 미만 true / 이상 false). fake 갱신만으로는 실어댑터 분기가 검증되지 않는 갭을 좁힌다. 실어댑터 end-to-end는 SMOKE 소관.
- **마이그레이션** (API 측 기존 패턴, 예: `test/db.ts` 기반 suite):
  - zero-vector voiceprint 삽입 후 마이그레이션 적용 → 삭제 확인, non-zero는 보존.

---

## 4. 파일별 변경 요약

| 파일 | 변경 |
|---|---|
| `worker/damwha_worker/models/base.py` | `Embedder.embed` 반환 타입 `list[list[float] \| None]` |
| `worker/damwha_worker/models/ecapa_embed.py` | zero sentinel → `None`, 순수 헬퍼 `too_short_for_embedding` 분리 |
| `worker/damwha_worker/pipeline/identify.py` | `None` 필터 centroid, `None` centroid 미식별 처리 |
| `worker/damwha_worker/pipeline/enroll_speaker.py` | `None` 임베딩 → PERMANENT `sample_too_short` |
| `worker/damwha_worker/errors.py` | `SAMPLE_TOO_SHORT` 코드 상수 추가 |
| `worker/damwha_worker/pipeline/process_meeting.py` | `failed_spans=speech_spans` 무조건 전달 |
| `worker/tests/fakes.py` + 관련 테스트 | fake/케이스 갱신 (결함 2는 `run_process_meeting` 호출부 테스트 필수) |
| `src/database/migrations/00X_delete_zero_voiceprints.sql` | 기존 zero-vector voiceprint 일회성 삭제 (§1.4) |

계약(`src/contracts/`, `contracts.py`), API 코드 — 변경 없음.
