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
  GET /lenses / GET /meetings/:id/lenses  기존 evidence 배열 그대로 사용 (변경 없음)
  GET /lenses/extraction-status           신규 집계
```

### 3.1 배치와 뷰 전환
- `fe/src/pages/meeting.tsx`의 `view: "meeting" | "lens"`는 유지한다. nav "모든
  회의"는 계속 `view="lens"`로 전환하되, 렌더 대상만 `LensView` → 신규
  `LensDashboard`로 교체한다. `/app` 셸·라우팅은 변경하지 않는다.
- 렌즈 kind 상수·메타를 `features/lens/model`에 **새로 정의**한다. 기존
  `features/meeting/model/data.ts`의 `LENS_META`는 `topic`(주제·키워드)을 포함하지만,
  BE `GET /lenses`의 kind enum은 `action|decision|promise`만 허용한다
  (`be/src/lenses/lens.types.ts`). 따라서 작업 3 전용 상수는 **`action|decision|promise`
  3종만** 담아 `topic` 탭이 BE가 거부하는 쿼리를 만들지 않게 한다. `topic` 탭은 저장
  검색을 다루는 **작업 4**에서 별도로 추가한다. 기존 상수를 그대로 이관하지 않는다.

## 4. 백엔드 변경

BE 변경은 신규 집계 엔드포인트 **하나뿐**이다. 목록의 근거는 이미 반환된다.

### 4.1 목록 근거 — projection 확장 불필요 (기존 계약 사용)

`GET /lenses`·`GET /meetings/:id/lenses`는 이미 각 항목에 `evidence` 배열을 반환한다
(`lenses.service.ts`의 `list` → `hydrateMany` → `toItem`). 각 원소는
`{ relation, utterance: { id, start_ms, text, speaker_id } }`이고 primary가 맨 앞에
정렬된다(`findEvidence`의 `ORDER BY (relation <> 'primary'), start_ms`). 따라서 근거 점프와
타임코드 표시에 필요한 데이터가 모두 존재하므로 **새 projection 필드를 추가하지 않는다**.
FE는 `evidence.find(e => e.relation === 'primary')`로 primary 발언을 얻는다.

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
(`DISTINCT ON (meeting_id) ... ORDER BY meeting_id, created_at DESC, id DESC` 또는 lateral).
"최신" 판정 정렬은 반드시 **`created_at DESC, id DESC`**로 tie-breaker를 포함해 같은 시각
run에서도 결과가 안정적이게 한다(회의 상태 조회 `meetings.repository.ts`와 동일 정렬).
읽기 전용, 트랜잭션 불필요.

## 5. 프런트엔드 설계 (`fe/src/features/lens/`)

### 5.1 모듈 구조
```text
features/lens/
  model/
    types.ts        // LensKind, LensItem, Evidence, ExtractionStatus, 필터 타입
    meta.ts         // LENS_KINDS/LENS_META — action|decision|promise 3종만 (topic 제외)
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
- **useLensExtractionStatus**: `useQuery`, 대시보드가 열려 있는 동안 **항상 10초
  `refetchInterval`**. `running>0`일 때만 폴링하면 idle/실패 상태에서 다른 경로(회의 처리
  완료 시 자동 enqueue, 작업 2)로 새 추출이 생겨도 재조회하지 않아 진행 배너가 뜨지 않는다.
  v1은 상시 10초 폴링으로 단순·안전하게 처리한다. 재시도/완료 후 `['lenses']` 무효화로
  목록 갱신.
- **완료 토글**: `LensItem` 체크박스 → complete/reopen mutation. **낙관적 업데이트**로
  즉시 반영, 실패 시 롤백 + 토스트(`use-toast`).

### 5.4 렌즈 항목 → LensItem 매핑
- primary 근거는 응답의 `evidence` 배열에서 `evidence.find(e => e.relation === 'primary')`로
  얻는다(별도 필드 없음, §4.1).
- `source`: `ai|user|edited` 그대로. **primary 근거가 없는 보존 항목**(`evidence`에 primary
  없음, AI 출처)은 `hint`("확인 필요")로 표시(품질조건: 근거 사라진 항목은 삭제 않고 표시).
- `evidence`: primary `utterance.start_ms` → `mm:ss` 타임코드. `onJump` → 점프 콜백.
- `assignee`: `assignee_speaker_id` → 화자 목록(speakers 쿼리)에서 이름·색 인덱스 해석.
- `done`: `completion_status==='done'`. `checkable`: 항상 true.

### 5.5 근거 점프
- LensDashboard가 받은 `onJump(meetingId, utteranceId)`를 meeting.tsx로 전달.
- meeting.tsx: `setView("meeting")` + `setSelectedId(meetingId)` +
  `setActiveId(utteranceId)`. transcript-pane의 기존 `activeId` 효과가 해당 발언으로
  스크롤·하이라이트·포커스한다. **`pendingSeek`는 설정하지 않는다**(오디오 seek 없음).
- 기존 `jumpTo`가 seek를 포함하면, seek 없는 경량 점프 경로를 별도로 쓴다.

**재처리된 근거(historical utterance) 처리:** `GET /meetings/:id`의 transcript는 현재
`processing_version`의 발언만 반환한다(`meetings.repository.ts`의 `findUtterances`가
`u.processing_version = m.processing_version`로 필터). 재처리 전 발언을 primary 근거로 가진
보존 렌즈는 근거가 유지돼도(발언 row는 커밋 `317f6d7`로 보존) 현재 transcript에 없으므로
스크롤 대상이 존재하지 않는다. 현재 transcript-pane은 대상 발언을 못 찾으면 **무성 no-op**이다.
v1은 이를 명시적으로 처리한다:
- 점프 시 대상 회의 transcript 로드 후, `activeId` 발언이 현재 발언 목록에 **없으면**
  스크롤하지 않고 토스트로 알린다: "재처리로 근거 발언을 현재 버전에서 찾을 수 없어요".
- 이 판정은 이미 로드된 transcript로 클라이언트 측에서 하므로 추가 BE·버전 API가 필요 없다.
- 버전별 발언 열람 UI는 이번 범위 밖(비범위). 필요 시 후속에서 버전 인지 조회로 확장한다.

### 5.6 상태(빈·로딩·에러)
- 로딩: 스켈레톤 카드 몇 장.
- 첫 페이지 비었음: kind별 "아직 {label} 항목이 없어요".
- 필터 결과 0: "조건에 맞는 항목이 없어요".
- 목록/배너 에러: 짧은 메시지 + 재시도 버튼.

## 6. 인터페이스 요약

| 유닛 | 하는 일 | 입력 | 의존 |
|---|---|---|---|
| `GET /lenses` (기존) | 필터+커서 목록, evidence 배열 포함 (변경 없음) | 쿼리 필터 | lens_item, lens_evidence, utterance, meeting |
| `GET /lenses/extraction-status` (신규) | 진행중/실패 집계 | 없음 | lens_extraction_run, meeting |
| `useLensList` | 무한 목록 fetch | 필터 | GET /lenses |
| `useLensExtractionStatus` | 상태 폴링 | 없음 | GET /lenses/extraction-status |
| `LensDashboard` | 필터·kind·점프 오케스트레이션 | 없음(셸) | 위 훅들, meeting.tsx 콜백 |
| `LensFilterBar` | 필터 입력 | 현재 필터 | speakers·meetings 쿼리 |
| `LensExtractionBanner` | 진행/실패 표시·재시도 | 없음 | 상태 훅, POST extract |
| `LensList` | 목록 렌더·무한 스크롤 | 페이지들 | LensItem |

## 7. 테스트 전략
- **BE (TDD, e2e 먼저):** 신규 `extraction-status`만 테스트 대상(목록은 기존 계약, 변경 없음).
  - 진행중(`queued`/`running`) 카운트.
  - 실패는 회의별 **최신** run 기준으로만 노출(재추출 성공/진행 시 제외), 회의당 1건,
    `created_at DESC, id DESC` tie-breaker로 동시각 run에서도 안정적.
- **FE (vitest + testing-library, API는 MSW 모킹):**
  - useLensList 무한 스크롤(다음 커서 로드), 낙관적 완료 토글 + 롤백.
  - kind 탭이 `action|decision|promise` 3종만 렌더(topic 없음).
  - 필터 상호작용 → 쿼리 파라미터 반영.
  - 배너 진행/실패 렌더·재시도 호출.
  - 점프 콜백이 올바른 (meetingId, utteranceId)로 호출.
  - primary 근거를 현재 transcript에서 못 찾는 경우(historical) 토스트 + 무 스크롤.

## 8. 품질 조건 정합 (로드맵 §6)
- AI 출력 검증은 서버측(작업 1·2)에서 이미 보장. 대시보드는 조회·표시만.
- 실패·진행 중 추출을 배너로 명시하고 회의별 재시도 경로 제공.
- 근거가 사라진 보존 항목은 삭제하지 않고 "확인 필요"(hint)로 표시.

## 9. 완료 기준
- 액션·결정·약속 항목을 전역에서 조회·필터·완료 처리할 수 있다.
- 각 항목의 근거 발언이 속한 회의로 이동할 수 있다. **현재 처리 버전의 근거**는
  transcript에서 스크롤·하이라이트로 확인하고, **재처리 전(historical) 근거**는 회의로
  이동한 뒤 현재 버전에 없음을 안내(토스트)한다.
- 진행 중·실패 추출이 배너로 보이고, 실패 회의를 재시도할 수 있다.
- BE·FE 필수 검증 스위트가 모두 통과한다.
