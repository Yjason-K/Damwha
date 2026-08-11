# 대화 요약 (Conversation Summary) 설계

> 작성일: 2026-08-11 · 대상: `damwha-be` (worker 포함) + `damwha-fe`

---

## 1. 배경과 문제

담화는 렌즈(할 일 · 결정 · 약속)를 풀스택으로 완성했다. 워커 추출 잡, 로컬 LLM 클라이언트, 서비스·리포지토리·컨트롤러, evidence 점프, 전역 대시보드, 비파괴 머지까지 스펙 5건이 들어갔다.

그런데 그 위에 있어야 할 **요약이 없다**.

- `fe/src/features/meeting/api/mappers.ts:249` — `summary: []` 하드코딩
- 같은 파일 `:252` — `topics: []` 하드코딩
- `fe/src/features/meeting/ui/insight-pane.tsx:130` — 요약 섹션은 항상 "아직 요약이 없어요." 출력

결과적으로 인사이트 패널은 **요약 빈칸 위, 결정·할 일 아래** 구조다. 업로드 직후 사용자가 처음 보는 자리가 빈칸이다.

두 번째 문제는 프레이밍이다. `docs/product-concept.md`는 제품을 "회의 기록·검색 플랫폼"으로 정의하는데, 서비스명 담화(Damwha)는 대화·이야기를 뜻한다. 파이프라인(VAD → diarization → identification → STT → 인덱싱) 어디에도 회의 전제가 없고, 1급 객체도 `meeting`이 아니라 `utterance`다. 회의 전제가 실제로 박혀 있는 유일한 층은 렌즈다 — 액션아이템·결정사항·약속은 전부 회의 산출물이고, 인터뷰나 잡담에는 대응물이 없다.

즉 **가장 장르 의존적인 층부터 만들었다.**

## 2. 개념 재정의 — 층위

| 층 | 대상 | 적용 범위 | 상태 |
|---|---|---|---|
| 기반 — 기록 | 화자 붙은 발언 (`utterance`) | 모든 녹음 | 완성 |
| 기반 — 요약 | 주요 주제 · 단락별 요약 | 모든 녹음 | **본 스펙** |
| 확장 — 렌즈 | 할 일 · 결정 · 약속 | 회의 성격일 때만 결과 발생 | 완성, 위상만 재정의 |

렌즈는 "필요할 때 켜는 보조 뷰"가 아니라 **대화가 회의 성격일 때만 결과가 나오는 확장층**이다. 이 재정의에 새 코드가 필요하지 않다 — 잡담 녹음이면 추출 결과가 0건이고, `insight-pane.tsx:165`의 기존 `if (items.length === 0) return null`이 섹션을 자동으로 없앤다.

대화 유형(회의/인터뷰/통화/메모) 필드는 **도입하지 않는다.** LLM이 전사를 보고 알아서 적응하며, 유형 필드는 새 UI·새 스키마·오분류 수정 경로를 전부 끌고 온다.

## 3. 범위

### 범위 안

- 워커 `summarize_meeting` 잡 신설 — 주요 주제 + 단락별 요약 추출
- `meeting_summary` 테이블 신설
- 요약 조회·재생성 API
- 인사이트 패널 요약 탭 재구성 (주요 주제 / 다음 할 일 / 핵심 결정 / 단락별 요약)
- UI 카피와 `docs/product-concept.md`를 대화 중심으로 재작성

### 범위 밖 (의도적)

- **개요 요약 블록** — 전체 요지 3-5줄. 주요 주제 목록과 역할이 겹쳐 넣지 않는다
- **대화 유형 필드** — 2장 참조
- **약속/책임(promise)의 요약 화면 노출** — 전역 렌즈 대시보드에만 남긴다. 컨셉상 최하위 우선순위이고 감시성이 가장 짙다
- **코드·DB·API의 `meeting` → `conversation` rename** — 사용자에게 보이지 않는 내부 용어다. 마이그레이션과 전 레이어 터치가 요약 기능 릴리스를 막을 이유가 없다. 필요해지면 별도 스펙
- **요약 항목 편집** — 요약은 전사의 파생 뷰지 사용자 자산이 아니다. 통째 재생성만 제공한다. 항목 편집을 지원하면 소스 컬럼·머지 규칙·충돌 처리가 따라오고, 그게 렌즈에서 스펙 5건을 태운 비용이다
- **단락 점프 시 오디오 seek** — 기존 렌즈 evidence 점프와 동일하게 발언 하이라이트까지만
- **주제의 전역 검색·필터** — 저장 검색(로드맵 별건)과 성격이 다르다

## 4. 데이터 모델

### 4.1 `meeting_summary` — 회의당 1행

```sql
CREATE TABLE meeting_summary (
  meeting_id          text PRIMARY KEY REFERENCES meeting(id) ON DELETE CASCADE,
  processing_version  int  NOT NULL,
  model               text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  topics              jsonb NOT NULL DEFAULT '[]'::jsonb,
  segments            jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

`topics` — 문자열 배열.

```json
["파이프라인 실행 순서와 제약 사항", "예약 관리와 예약 상태 변경"]
```

`segments` — 원소 구조.

```json
{
  "start_utterance_id": "utt_...",
  "end_utterance_id": "utt_...",
  "start_ms": 0,
  "end_ms": 67000,
  "title": "티켓 등록 수정",
  "bullets": ["티켓 등록 수정에 관련해서 공유를 해드릴 것임", "..."]
}
```

### 4.2 정규화하지 않는 이유

요약은 읽기 전용이고 통째로 재생성된다. 항목 단위 UPDATE가 존재하지 않으므로 재생성이 UPSERT 1회로 끝나고 원자적이다. 렌즈처럼 항목별 소스 컬럼·머지 로직·커서 페이징이 필요 없다. 주제의 전역 검색이 나중에 필요해지면 그때 정규화한다.

### 4.3 타임스탬프의 출처

`start_ms` / `end_ms`는 **LLM 응답에서 받지 않는다.** LLM은 단락 경계의 `utterance.id`만 반환하고, 워커가 DB의 해당 utterance 행에서 시간을 읽어 채운다. `extract_lenses.py:29-35`가 이미 `u.id, u.speaker_id, s.name, u.text, u.start_ms, u.end_ms`를 실어 보내므로 LLM이 id를 지목할 근거는 충분하고, 모델이 타임스탬프를 지어내는 실패 모드는 원천 차단된다.

### 4.4 마이그레이션

기존 최신은 `015_job_retry_schedule.sql`.

- `016_summarize_meeting_job.sql` — `job_type_check` 제약에 `summarize_meeting` 추가 (`011_add_extract_lenses_job_type.sql` 형태 그대로), 잡 스테이지 제약에 `summarize_meeting` · `persist_summary` 추가 (`012_add_extract_lenses_job_stages.sql` 형태)
- `017_meeting_summary.sql` — 4.1 테이블

## 5. 워커

### 5.1 잡

새 타입 `summarize_meeting`. `extract_lenses`와 **나란히, 독립적으로** 실행된다 — 각자 재시도·상태·실패를 가지며 한쪽이 죽어도 다른 쪽은 산다.

- 큐잉 지점: `be/worker/damwha_worker/db.py`의 처리 완료 후속 잡 삽입부 (현재 `lens_extraction_run` + `extract_lenses` 잡을 넣는 `:358-372` 구간). 같은 트랜잭션에서 `meeting_summary` 행을 `queued`로 만들고 `summarize_meeting` 잡을 넣는다
- 디스패치: `__main__.py:82` · `:116` 분기에 형제 분기 추가
- 페이로드 버전: `contracts.py:14`에 `"summarize_meeting": frozenset({1})` 추가

### 5.2 파이프라인

`pipeline/summarize_meeting.py` — `extract_lenses.py`의 형제.

1. `enter_stage(..., "summarize_meeting", 30, ...)`
2. `extract_lenses.py:29-35`와 동일한 쿼리로 utterance 로드 (`meeting_id` + `processing_version` 필터, `order_index, id` 정렬)
3. `summary_client.py`로 로컬 LLM 호출
4. `enter_stage(..., "persist_summary", 80, ...)`
5. 검증 통과분을 `meeting_summary`에 UPSERT, `status='done'`

### 5.3 `summary_client.py`

`lens_client.py`의 형제. 전용 시스템 프롬프트, 전용 응답 스키마.

응답 스키마:

```json
{
  "topics": ["..."],
  "segments": [
    { "start_utterance_id": "...", "end_utterance_id": "...",
      "title": "...", "bullets": ["..."] }
  ]
}
```

전사는 `lens_client.py:52-53`의 결정을 따라 이스케이프 없이 그대로 보낸다.

### 5.4 검증

기존 렌즈 추출의 all-or-nothing 관례를 따른다. 별도 잡으로 분리했으므로 요약이 통째로 실패해도 렌즈는 무손상이다.

응답을 받은 뒤 확인한다.

- 스키마 정합 (`LensExtractionResponse`와 같은 방식의 pydantic 검증)
- 모든 `start_utterance_id` / `end_utterance_id`가 2단계에서 로드한 행 집합에 존재
- 각 단락에서 `start`의 `order_index` ≤ `end`의 `order_index`
- 단락 순서가 `start_ms` 오름차순

하나라도 깨지면 `WorkerError`를 던진다. 기존 `errors.py:56` `classify()`가 재시도 여부를 판정하고, 최종 실패 시 `meeting_summary.status='failed'`로 남는다.

### 5.5 모델

렌즈와 동일한 처리 설정의 로컬 LLM 모델을 쓴다. 별도 설정 항목을 만들지 않는다.

## 6. API

| 신규 | 기존 형제 |
|---|---|
| `GET /meetings/:id` 응답에 `summary` 필드 추가 | — |
| `POST /meetings/:id/summary/generate` | `POST /meetings/:id/lenses/extract` (`meetings.controller.ts:56`) |
| `GET /meetings/:id/status` 응답에 요약 상태 추가 | 같은 엔드포인트 (`meetings.controller.ts:52`) |

`summary` 페이로드는 주제 ~5건 + 단락 ~8건으로 작다. 회의 상세에 실어도 부담이 없고 왕복이 하나 줄어든다.

상태는 **기존 `GET /meetings/:id/status`를 확장**한다. FE가 이미 이 엔드포인트를 폴링하므로 새 폴링 루프를 만들지 않는다. `db.py:113`과 `jobs.repository.ts:95`가 `type='extract_lenses'` 후속 잡을 조인해 상태를 만드는데, 같은 방식의 `summarize_meeting` 조인을 나란히 추가한다.

`POST .../summary/generate`는 `lens-extraction.service.ts:45`가 잡을 넣는 방식을 그대로 따른다. 이미 `running`인 요약이 있으면 새로 큐잉하지 않고 진행 중인 것을 반환한다.

모듈은 `be/src/summary/` (service + repository)로 두고, 라우트는 경로가 `/meetings/:id/...`이므로 `meetings.controller.ts`에 붙인다 — 렌즈 재추출이 `lens-extraction.service.ts`를 두고 라우트만 meetings 컨트롤러에 붙인 것과 같은 배치다.

## 7. 프론트엔드

### 7.1 탭 구성

인사이트 패널 탭이 `요약 / 참석자 / 파일 / 메모`에서 **`요약 / 파일 / 메모`** 로 줄어든다. 참석자는 요약 탭 최상단 블록으로 남으므로 별도 탭이 중복이었다. `insight-pane.tsx:382`의 `onMore={() => onTab("people")}` ("모두 보기") 링크는 갈 곳이 없어져 제거한다.

### 7.2 요약 탭 블록 순서

```
참석자          (기존 블록 유지)
주요 주제    5
다음 할 일   4        ← lens_item(action), 기존 그대로 수정·추가·체크 가능
핵심 결정    2        ← lens_item(decision), 결과 없으면 섹션 사라짐
단락별 요약  8        ← 신규, 접힘 기본
```

**회의별 렌즈는 FE 배선이 빠져 있다.** 백엔드 `GET /meetings/:id/lenses` (`lenses.controller.ts:17`)는 이미 있지만 FE가 호출하지 않는다 — `mappers.ts:253`이 `lenses: {}`를 하드코딩한다. 그래서 지금 인사이트 패널의 할 일·결정 블록은 요약과 마찬가지로 **항상 빈 상태**다. 요약만 붙이면 네 블록 중 두 개가 여전히 비므로, 이 배선도 본 스펙 범위에 포함한다. 추출·저장·머지는 이미 동작하므로 FE 쿼리 훅과 매핑만 추가하면 된다.

### 7.3 단락별 요약 — 접힘 기본

우측 레일은 `fe/src/index.css:153` `--rail-insight: 320px`다. 패딩을 빼면 본문 288px, 한글 13px 기준 약 20자/줄이다. 클로바 수준의 불릿 길이면 한 줄이 3-4줄로 접히고, 단락 하나가 200px, 8단락이면 1600px가 된다. 그 위에 참석자·주제·할 일·결정까지 얹히면 뒷 단락 도달이 사실상 불가능하다.

따라서 시간과 제목만 한 줄로 나열하고 펼침은 클릭으로 한다. 단락 8개가 8줄이 된다.

```
단락별 요약   8
▸ 00:00  티켓 등록 수정
▸ 02:10  빌드 자동화 테스트 배포
▾ 05:48  파이프라인 정의
   • 실행 순서를 카드로 매핑하는 방식 검토 필요
   • 제약 사항은 다음에 정리
▸ 09:12  예약 상태 변경
```

히트 영역이 두 개다.

- **행 클릭** — 펼침/접힘
- **시간 클릭** — 해당 발언으로 점프

점프는 기존 렌즈 evidence 점프와 같은 규칙이다: 회의 뷰의 해당 발언을 하이라이트하고, **오디오 seek은 하지 않는다.** 재처리로 utterance가 사라진 경우도 기존과 같이 조용한 무동작 대신 토스트를 띄운다.

### 7.4 재생성

요약 탭 헤더에 재생성 버튼 하나. 서버가 주제와 단락을 한 번의 LLM 호출로 만들기 때문에 블록 단위 재생성은 존재할 수 없다 — 버튼도 하나여야 정직하다.

할 일·결정의 렌즈 재추출 버튼은 별개 잡이므로 지금 그대로 둔다.

### 7.5 타입·매핑 변경

- `mappers.ts:249` `summary: []` · `:252` `topics: []` 하드코딩 제거, 실제 응답 매핑
- `Meeting.summary: string[]` 필드 제거 — 개요 블록을 만들지 않기로 했으므로 죽은 필드다
- `topics`의 타입이 `{ label, spk }`에서 문자열 배열로 바뀐다. 지금 `Topics` 컴포넌트는 `<Tag speaker={t.spk}>`로 화자 색을 칠하는데, 주요 주제는 논의 주제라 화자가 없다. **태그 클라우드에서 불릿 목록으로 바뀐다**
- 신규 `SummarySegments` 컴포넌트

### 7.6 상태·에러

- **생성 중** — 해당 블록에 `role="status"` + `aria-busy`, "요약 만드는 중". 모션이 아니라 텍스트로 전달한다 (`fe/CLAUDE.md` 규칙, `prefers-reduced-motion`)
- **실패** — 재시도 버튼. `LensExtractionBanner` 패턴을 따른다
- **재처리 후** — `meeting_summary.processing_version`이 현재 버전과 다르면 요약 없음으로 취급하고, 재처리 파이프라인이 새 요약 잡을 큐잉한다

## 8. 테스트

**워커** — `be/worker/tests/test_summarize_meeting.py`

- 정상 응답 → `meeting_summary` UPSERT, `status='done'`, `start_ms`/`end_ms`가 DB 값에서 채워짐
- 스키마 깨진 응답 → `WorkerError`, 요약 미저장
- 존재하지 않는 `utterance_id`를 가리키는 단락 → `WorkerError`
- `start`가 `end`보다 뒤인 단락 → `WorkerError`
- 발언이 없는 회의 → 빈 요약으로 `done`
- 요약 잡 실패가 `extract_lenses` 결과에 영향 없음

**백엔드** — `be/test/summary.service.spec.ts` + e2e

- 큐잉 → 조회 → 재생성 → 재처리 시 무효화
- 이미 `running`인 상태에서 재생성 요청 시 중복 큐잉 없음
- `GET /meetings/:id/status`가 렌즈와 요약 상태를 함께 반환

**프론트엔드**

- 요약 탭이 네 블록을 순서대로 렌더
- 참석자 탭 부재, "모두 보기" 링크 부재
- 단락 행 클릭 시 펼침, 시간 클릭 시 점프 핸들러 호출 (두 동작이 서로를 트리거하지 않음)
- 결과 0건인 결정 블록이 렌더되지 않음
- 로딩(`aria-busy`) · 빈 상태 · 실패 상태

## 9. 결정 기록

| 결정 | 선택 | 근거 |
|---|---|---|
| 대화 유형 필드 | 없음 | LLM이 전사로 적응. 필드는 UI·스키마·오분류 수정 경로를 끌고 옴 |
| 요약 화면 블록 | 주제 / 할 일 / 결정 / 단락 | 클로바노트 3블록 + 결정. 결정은 결과 없으면 자동 소멸이라 공짜 |
| 배치 | 기존 우측 레일 요약 탭 | 3패널 구조 변경 없음 |
| 단락 표시 | 접힘 기본 | 320px에 8단락 펼치면 1600px |
| 추출 구조 | 별도 잡 분리 | 로컬 런타임은 `response_format`이 권고사항일 뿐(`lens_client.py:82`)이고 검증이 all-or-nothing이라, 스키마를 키우면 실패 시 요약·할 일이 함께 날아감. 대가는 LLM 2콜 |
| 수정 정책 | 읽기 전용 + 재생성 | 요약은 파생 뷰. 편집 지원은 소스 컬럼·머지·충돌 처리를 부름 |
| 용어 범위 | UI 카피 + 문서만 | 내부 용어 rename이 릴리스를 막을 이유 없음 |
| 참석자 탭 | 삭제 | 요약 탭 블록과 중복 |

## 10. 문서 갱신

- `fe/docs/product-concept.md` — "회의 기록·검색 플랫폼"을 대화 중심으로 재작성. 5.5 렌즈 절을 2장의 층위 정의로 교체. 7장 파이프라인에 요약 단계 추가
- `fe/CLAUDE.md` — 제품 개념 요약과 `features/meeting` 설명 갱신
- `be/docs/worker-architecture.md` — `summarize_meeting` 잡 추가
