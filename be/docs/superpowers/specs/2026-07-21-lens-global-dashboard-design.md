# 전역 회의 렌즈 대시보드 설계 (작업 3)

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-07-21 · 상위 로드맵: `2026-07-14-lens-platform-roadmap-design.md` 작업 3

## 1. 목적과 범위

모든 회의의 렌즈 항목(액션·결정·약속)을 한 화면에서 조회·필터·완료 처리하고,
각 항목의 근거 발언이 속한 회의로 이동해 해당 발언을 확인할 수 있게 한다.
현재 `/app` 셸의 "모든 회의" 뷰에 있는 "준비 중" placeholder `LensView`를 실제
대시보드로 교체한다.

**범위:**
- 렌즈 kind 탭(액션/결정/약속), 완료·기간·화자·회의 필터.
- 완료 표시·토글, 출처(source) 뱃지, 근거 발언 점프.
- 진행 중·실패 추출을 알리는 상단 배너와 회의별 재시도.

**비범위:**
- 저장 검색(주제 렌즈) 정의·편집 UI (작업 4).
- 근거 발언 클릭 시 오디오 자동 재생/seek — 이번 이터레이션은 트랜스크립트
  스크롤·하이라이트까지만.
- 회의별 인라인 추출 상태 표기(상단 집계 배너로 대체).

## 2. 제품 결정 (브레인스토밍 확정)

- **v1 범위:** 핵심(조회·필터·완료·근거점프) + 추출 상태 집계 배너.
- **근거 점프:** 회의뷰로 전환 + 트랜스크립트 해당 발언 스크롤·하이라이트.
  오디오 자동 seek 없음.
- **필터:** 완료상태·기간·화자·회의 전부.
- **페이지네이션:** 무한 스크롤(keyset 커서 + IntersectionObserver).
- **코드 구조:** 신규 `features/lens/` 모듈로 분리. 렌즈는 독립 도메인.

## 3. 아키텍처

두 런타임에 걸친 변경이며, 기존 렌즈 저장 계약(작업 1) 위에 얹는다.

```text
FE (fe/): features/lens 모듈
  LensDashboard ──> useLensList (GET /lenses, infinite)
                ──> useLensExtractionStatus (GET /lenses/extraction-status, poll)
                ──> complete/reopen mutation (POST /lenses/:id/complete|reopen)
                ──> 근거 점프: view=meeting + selectedId + activeId
BE (be/): 기존 lenses 도메인 확장
  GET /lenses               projection 확장 (primary 근거 포함)
  GET /meetings/:id/lenses  projection 확장 (동일)
  GET /lenses/extraction-status  신규 집계
```

### 3.1 배치와 뷰 전환
- `fe/src/pages/meeting.tsx`의 `view: "meeting" | "lens"`는 유지한다. nav "모든
  회의"는 계속 `view="lens"`로 전환하되, 렌더 대상만 `LensView` → 신규
  `LensDashboard`로 교체한다. `/app` 셸·라우팅은 변경하지 않는다.
- 렌즈 kind 상수·메타(`LENS_KINDS`, `LENS_META`)를 `features/meeting/model`에서
  `features/lens/model`로 이관한다. 잔여 참조는 재-export 없이 직접 import로 정리한다.

## 4. 백엔드 변경

### 4.1 `GET /lenses` · `GET /meetings/:id/lenses` projection 확장

현재 목록 projection(`ITEM_COLUMNS`)은 `lens_item` 컬럼 + `meeting.title`만 반환하고
근거를 포함하지 않는다. 근거 점프와 타임코드 표시를 위해 각 항목에 primary 근거를 추가한다.

**추가 필드:**
```jsonc
"evidence_primary": { "utterance_id": "utt_12", "start_ms": 252000 } // 없으면 null
```

**구현:** repo 목록 쿼리에 primary 근거를 상관 서브쿼리로 join한다.

```sql
(SELECT jsonb_build_object('utterance_id', u.id, 'start_ms', u.start_ms)
   FROM lens_evidence le JOIN utterance u ON u.id = le.utterance_id
  WHERE le.lens_item_id = li.id AND le.relation = 'primary'
  LIMIT 1) AS evidence_primary
```

- keyset 커서(`updated_at, id` 기준)·정렬·기존 필터는 불변.
- 기존 필드명은 하나도 바꾸지 않는다(FE 회귀 방지, 작업 1 계약 유지).
- primary가 여러 개일 수 없음은 작업 1의 불변식·부분 unique 인덱스가 보장하므로
  `LIMIT 1`은 방어적 표현이다.

### 4.2 `GET /lenses/extraction-status` (신규)

전역 배너용 집계. 진행 중 추출 수와 실패 회의 목록을 반환한다.

**응답:**
```jsonc
{
  "running": 2,
  "failed": [
    { "meeting_id": "mtg_7", "title": "주간 스크럼" }
  ]
}
```

**의미:**
- `running` = 상태가 `queued` 또는 `running`인 `lens_extraction_run` 수.
- `failed` = 각 회의의 **최신** run 상태가 `failed`인 회의(회의당 1건). 최신 run이
  성공/진행 중이면 제외한다(재추출로 해소된 실패를 다시 보여주지 않는다).
- 재시도는 별도 API를 만들지 않고 기존 `POST /meetings/:id/lenses/extract`를 재사용한다.

**구현:** `lens_extraction_run`을 회의별 최신 run으로 집계하는 단일 쿼리
(`DISTINCT ON (meeting_id) ... ORDER BY meeting_id, created_at DESC` 또는 lateral).
읽기 전용, 트랜잭션 불필요.

## 5. 프런트엔드 설계 (`fe/src/features/lens/`)

### 5.1 모듈 구조
```text
features/lens/
  model/
    types.ts        // LensKind, LensItem, EvidencePrimary, ExtractionStatus, 필터 타입
    meta.ts         // LENS_KINDS, LENS_META (meeting/model에서 이관)
  api/
    lenses.ts       // react-query 훅
  ui/
    lens-dashboard.tsx        // 셸: 헤더 + kind 탭 + 배너 + 필터바 + 목록
    lens-filter-bar.tsx       // 완료·기간·화자·회의 필터
    lens-extraction-banner.tsx// 진행중/실패 + 재시도
    lens-list.tsx             // 무한 스크롤 목록 (LensItem 재사용)
```
`shared/ui/lens-item.tsx`는 그대로 재사용한다(변경 없음).

### 5.2 컴포넌트 책임
- **LensDashboard** — 필터·kind·뷰 상태를 소유하고 하위에 내린다. 점프 콜백을
  meeting.tsx로 올린다(뷰 전환·발언 선택은 상위 셸 권한).
- **LensFilterBar** — 완료(토글), 기간(DatePicker from~to), 화자(Select), 회의(Select).
  값 변경 → LensDashboard 필터 상태 갱신.
- **LensExtractionBanner** — `useLensExtractionStatus` 구독. `running>0` 진행 배너,
  `failed` 실패 목록 + 회의별 "재시도" 버튼.
- **LensList** — `useLensList` 무한 스크롤. `LensItem` 카드 매핑, 하단 센티넬로
  자동 다음 페이지 로드.

### 5.3 데이터 흐름 (react-query)
- **useLensList**: `useInfiniteQuery`, `queryKey=['lenses', filters]`(kind 포함).
  `getNextPageParam` = 응답 `next_cursor`. `IntersectionObserver` 센티넬이 뷰포트
  진입 시 `fetchNextPage`.
- **useLensExtractionStatus**: `useQuery`, `refetchInterval` = 진행 중일 때만 10초,
  아니면 비활성. 재시도/완료 후 `['lenses']` 무효화로 목록 갱신.
- **완료 토글**: `LensItem` 체크박스 → complete/reopen mutation. **낙관적 업데이트**로
  즉시 반영, 실패 시 롤백 + 토스트(`use-toast`).

### 5.4 렌즈 항목 → LensItem 매핑
- `source`: `ai|user|edited` 그대로. **근거 없는 보존 항목**(`evidence_primary=null`이며
  AI 출처)은 `hint`("확인 필요")로 표시(품질조건: 근거 사라진 항목은 삭제 않고 표시).
- `evidence`: `evidence_primary.start_ms` → `mm:ss` 타임코드. `onJump` → 점프 콜백.
- `assignee`: `assignee_speaker_id` → 화자 목록(speakers 쿼리)에서 이름·색 인덱스 해석.
- `done`: `completion_status==='done'`. `checkable`: 항상 true.

### 5.5 근거 점프
- LensDashboard가 받은 `onJump(meetingId, utteranceId)`를 meeting.tsx로 전달.
- meeting.tsx: `setView("meeting")` + `setSelectedId(meetingId)` +
  `setActiveId(utteranceId)`. transcript-pane의 기존 `activeId` 효과가 해당 발언으로
  스크롤·하이라이트·포커스한다. **`pendingSeek`는 설정하지 않는다**(오디오 seek 없음).
- 기존 `jumpTo`가 seek를 포함하면, seek 없는 경량 점프 경로를 별도로 쓴다.

### 5.6 상태(빈·로딩·에러)
- 로딩: 스켈레톤 카드 몇 장.
- 첫 페이지 비었음: kind별 "아직 {label} 항목이 없어요".
- 필터 결과 0: "조건에 맞는 항목이 없어요".
- 목록/배너 에러: 짧은 메시지 + 재시도 버튼.

## 6. 인터페이스 요약

| 유닛 | 하는 일 | 입력 | 의존 |
|---|---|---|---|
| `GET /lenses` (확장) | 필터+커서 목록, primary 근거 포함 | 쿼리 필터 | lens_item, lens_evidence, utterance, meeting |
| `GET /lenses/extraction-status` | 진행중/실패 집계 | 없음 | lens_extraction_run, meeting |
| `useLensList` | 무한 목록 fetch | 필터 | GET /lenses |
| `useLensExtractionStatus` | 상태 폴링 | 없음 | GET /lenses/extraction-status |
| `LensDashboard` | 필터·kind·점프 오케스트레이션 | 없음(셸) | 위 훅들, meeting.tsx 콜백 |
| `LensFilterBar` | 필터 입력 | 현재 필터 | speakers·meetings 쿼리 |
| `LensExtractionBanner` | 진행/실패 표시·재시도 | 없음 | 상태 훅, POST extract |
| `LensList` | 목록 렌더·무한 스크롤 | 페이지들 | LensItem |

## 7. 테스트 전략
- **BE (TDD, e2e 먼저):**
  - projection 확장: primary 근거가 있는 항목/없는 항목의 `evidence_primary`가
    각각 객체/null인지, 기존 필드·커서 회귀.
  - extraction-status: 진행중 카운트, 실패는 최신 run 기준으로만 노출(재추출 성공 시
    제외), 회의당 1건.
- **FE (vitest + testing-library, API는 MSW 모킹):**
  - useLensList 무한 스크롤(다음 커서 로드), 낙관적 완료 토글 + 롤백.
  - 필터 상호작용 → 쿼리 파라미터 반영.
  - 배너 진행/실패 렌더·재시도 호출.
  - 점프 콜백이 올바른 (meetingId, utteranceId)로 호출.

## 8. 품질 조건 정합 (로드맵 §6)
- AI 출력 검증은 서버측(작업 1·2)에서 이미 보장. 대시보드는 조회·표시만.
- 실패·진행 중 추출을 배너로 명시하고 회의별 재시도 경로 제공.
- 근거가 사라진 보존 항목은 삭제하지 않고 "확인 필요"(hint)로 표시.

## 9. 완료 기준
- 액션·결정·약속 항목을 전역에서 조회·필터·완료 처리할 수 있다.
- 각 항목의 근거 발언이 속한 회의로 이동해 해당 발언을 확인할 수 있다.
- 진행 중·실패 추출이 배너로 보이고, 실패 회의를 재시도할 수 있다.
- BE·FE 필수 검증 스위트가 모두 통과한다.
