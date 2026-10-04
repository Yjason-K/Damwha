# 폴더 회의 목록 화면과 '나' 지정 결과

**스펙:** `docs/superpowers/specs/2026-10-04-folder-meeting-list-design.md`
**계획:** `docs/superpowers/plans/2026-10-04-folder-meeting-list.md`
**브랜치:** `feat/folder-meeting-list` (`feat/meeting-folders` @ `c537905`에서 분기, 미커밋)

## 구현한 것

- **사이드바:** 섹션 제목 `전체 회의`와 `+`(새 폴더), 그 아래 폴더 행으로 바꿨다. 폴더 행을 누르면 좌측 목록이
  그 폴더로 걸러지고, 가운데 칸에 `/folders/:id` 카드 목록이 열린다. 제목 `전체 회의`를 누르면 선택이 풀리고
  `/meetings`로 간다.
- **목록 화면:** `pages/meeting-list.tsx`.
  - 탭: `전체 / 내가 참여한 회의 / 결정 있는 회의 / 즐겨찾기`.
  - 정렬: `최신순 / 오래된순 / 긴 회의순`.
  - 한 페이지 20개. 탭·정렬·페이지는 `?tab=&sort=&page=`로 URL에 싣는다.
  - 빈 상태와 없는 폴더 상태를 따로 그린다.
- **카드:**
  - 메타 줄: 첫 태그 · 날짜 · 길이 · N명.
  - 배지: 결정·할 일·저장한 발언 수. 처리 중인 회의는 상태 배지를 단다.
  - 미리보기: 결정 한 줄, 그리고 할 일 한 줄(할 일이 없으면 요약 한 줄).
  - `회의 열기 →` 버튼.
- **'나' 지정:**
  - 마이그레이션 `031`이 `speaker.is_me`를 추가한다. 최대 한 명이고, 부분 유니크 인덱스가 이를 강제한다.
  - API: `PUT/DELETE /speakers/:id/me`.
  - 화자 관리 행에 `나로 지정`/`나 지정 해제` 버튼과 `나` 배지를 달았다.
- **BE 목록 응답:** `GET /meetings`가 카드용 집계를 함께 내려 준다. `participant_count`, `decision_count`,
  `action_count`, `saved_count`, `has_me`, `preview_decision`, `preview_action`, `preview_summary`이다.
- **living doc:** `be/CLAUDE.md`, `fe/CLAUDE.md`에 반영했다.

## 검증 (리드가 직접 다시 실행한 것)

| 대상 | 명령 | 결과 |
|---|---|---|
| BE 빌드 | `pnpm --filter damwha-be build` | exit 0 |
| BE 관련 테스트 | `jest --runInBand test/speakers-management.e2e-spec.ts test/meetings-management.e2e-spec.ts test/migration.spec.ts` | 3 suites, 64/64 통과 |
| FE 빌드 | `pnpm --filter damwha-fe build` (`tsc -b` 포함) | exit 0 |
| FE 린트 | `pnpm --filter damwha-fe lint` | 오류 0. 경고 1개는 기존 `saved-utterance-dashboard.tsx` |
| FE 테스트 | `pnpm --filter damwha-fe exec vitest run` | 86 files, 817/817 통과 |

BE 전체 스위트(60 suites, 681 tests 통과)는 구현 작업자가 보고한 것이고, 리드는 관련 3개 파일만 다시 돌렸다.

### 변이 증명

| 변이 | 확인한 쪽 | 결과 |
|---|---|---|
| `setMe`에서 기존 '나'를 내리는 UPDATE 제거 | 리드 재현 | `PUT moves me from the previous speaker…`가 500(`speaker_single_me_idx` 위반)으로 실패 |
| `mine` 탭 필터의 `return m.hasMe` → `return true` | 리드 재현 | `각 탭이 맞게 거르고…`가 실패. 기대 `['회의 mine']`, 실제로는 3건 |
| `has_me`의 `processing_version` 조건 제거 | 작업자 보고 | `has_me` 테스트 실패 (`Expected: false, Received: true`) |
| 폴더 행 클릭의 `navigate` 제거 | 작업자 보고 | `left-nav.test.tsx` 2건 실패 |

리드가 재현한 두 변이는 모두 원래 코드로 되돌린 것을 확인했다.

### 실제 화면

사용자의 DB(`damwha`)와 실행 중인 API·Vite는 건드리지 않았다. 대신 같은 Postgres에 임시 DB
`damwha_qa_list`를 만들어 마이그레이션 31개를 적용하고, 다음 데이터를 넣었다.

- 폴더 3개, 화자 4명.
- 회의 26개(처리 중 1개 포함).
- 렌즈: 결정과 할 일. archived 결정 1개 포함.
- 저장한 발언 3개, 요약 1개.

이 DB에 새 빌드의 API(:3100)와 Vite(:5199)를 띄우고 헤드리스 WebView(1440×1000, 다크 테마)로 다음을 확인했다.
확인 뒤 서버를 내리고 임시 DB를 지웠다.

- 회의 화면에서 사이드바 `프로덕트 리뷰`를 누르면 `/folders/fld_3`로 간다. 폴더 행 강조, 회의 수(10),
  카드(결정 2 · 할 일 3, 담당자·기한이 붙은 할 일 줄, 요약 줄)가 맞게 나온다. archived 결정은 세지 않았다(`결정 1`).
- '나'가 없을 때 `내가 참여한 회의` 탭은 안내와 `화자 관리로 가기` 링크를 보여 준다.
  - 링크로 화자 관리에 가서 `김영재`를 `나로 지정`하면 `나` 배지와 `나 지정 해제`가 나온다.
  - 뒤로 가면 탭은 그대로이고, 김영재가 참여한 5개 회의만 남는다.
- 제목 `전체 회의`를 누르면 `/meetings`로 간다.
  - 제목이 강조되고, 1페이지에 처리 중 배지 카드와 저장한 발언 배지(🔖 3)가 보인다.
  - `다음`을 누르면 `?page=2`, `표시 중: 21–26 / 총 26개 회의`가 나온다.

## 남은 것 / 후속 후보

- **미리보기 결정의 순서:** 미리보기 결정은 `created_at, id` 순으로 고른다. AI 추출은 한 트랜잭션에서 여러 항목을
  넣어 `created_at`이 같아지므로, 실제로는 text id의 사전순(`lens_10` < `lens_9`)이 고른다. "회의에서 먼저 나온
  결정"을 보여 주려면 근거 발화의 `start_ms` 순으로 바꾸는 편이 낫다. 이번 범위에서는 스펙대로 두었다.
- **라이트 테마:** 확인하지 않았다. 다크 테마로만 보았다.
- **보던 폴더를 지울 때:** 지금 보고 있는 폴더를 지우면 가운데 칸이 "폴더를 찾을 수 없어요"가 된다(스펙 §2.2).
  `/meetings`로 자동 이동하지는 않는다.
- **커밋:** 아직 하지 않았다.
