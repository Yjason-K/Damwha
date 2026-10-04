# 회의 폴더 결과

**작성일:** 2026-10-04
**Spec:** [`specs/2026-10-04-meeting-folders-design.md`](../specs/2026-10-04-meeting-folders-design.md)
**Plan:** [`plans/2026-10-04-meeting-folders.md`](../plans/2026-10-04-meeting-folders.md)
**브랜치:** `feat/meeting-folders` (`dev` @ `8a5edb2`에서 분기)

## 요약

회의를 폴더 하나에 넣는 기능을 BE·FE에 넣었다.
- 기존 회의는 마이그레이션 030으로 모두 `기본 폴더`에 들어간다.
- 등록 모달(파일·실시간 녹음)과 회의 헤더에서 폴더를 고른다.
- 좌측 `폴더` 섹션에서 회의 목록을 거른다.

## 계획과 달라진 점

- **기본 폴더 채움 규칙을 SQL 함수로 옮겼다.**
  - 계획은 INSERT마다 `COALESCE($n, (SELECT id FROM folder WHERE is_default))`를 쓰는 것이었다.
  - 실제로는 030이 `default_folder_id()`(STABLE SQL 함수)를 만들고, 이를 `meeting.folder_id`의 컬럼 DEFAULT로 둔다.
  - 이유: 원안대로면 `folder_id`를 적지 않는 raw INSERT가 모두 NOT NULL에 걸린다. 테스트, worker 픽스처, 스모크 스크립트에 이런 INSERT가 약 70곳 있고, 이걸 전부 고쳐야 했다(첫 구현이 실제로 그렇게 됐다).
  - 함수 DEFAULT로 바꾸자 그 수정이 모두 필요 없어졌고, 규칙도 한 곳에만 남았다.
  - 앱의 INSERT 세 곳은 `COALESCE($n, default_folder_id())`를 쓴다. 명시적으로 바인딩된 NULL은 컬럼 DEFAULT를 타지 않기 때문이다.
  - 스펙 §2.3·§3과 계획 사본은 커밋 전에 이 설계로 맞춰 고쳤다.
- **`SectionLabel`을 `ui/section-label.tsx`로 뺐다.** `LeftNav`와 `FolderSection`이 같이 쓰고, 폴더 섹션 제목에 `+` 버튼(`action`)을 붙여야 했다.
- **`WireMeeting.folder_id`는 optional, `folderId`는 `string | null`로 뒀다.** `tags`·`capture_error`와 같은 이유로, 필드가 생기기 전 테스트 픽스처를 깨지 않기 위해서다.

## 변경 파일

- **BE**
  - 새 파일: `src/database/migrations/030_meeting_folder.sql`, `src/folders/`(controller·service·repository·module·`folder-id.ts`), `test/folders.e2e-spec.ts`
  - 수정: `app.module.ts`, `meetings/{controller,service,repository,module}`, `live/{controller,service,repository,module}`
  - 테스트 수정: `test/db.ts`(reset이 기본 폴더 외 폴더를 지움), `test/meetings-management.e2e-spec.ts`, `test/live.e2e-spec.ts`
- **FE**
  - 새 파일: `api/folders.ts`, `ui/folder-section.tsx`, `ui/folder-dialogs.tsx`, `ui/meeting-folder.tsx`(+test), `ui/section-label.tsx`
  - 수정: `api/{types,mappers,meetings}.ts`, `model/types.ts`, `ui/{left-nav,new-meeting-dialog,transcript-pane}.tsx`와 관련 테스트
- **문서:** `be/CLAUDE.md`(Meeting folders 항목), `fe/CLAUDE.md`(태그 문단의 "폴더 대신 태그"를 고치고 회의 폴더 문단 추가)

## 검증

| 명령 | 결과 |
| --- | --- |
| `pnpm --filter damwha-be exec jest --runInBand --config ./jest.config.js test/folders.e2e-spec.ts test/meetings-management.e2e-spec.ts test/live.e2e-spec.ts` | 3 suites, 52 passed (직접 재현) |
| `pnpm be test` | 60 suites, 667 passed (하위 에이전트 실행) |
| `pnpm be build` | exit 0 (직접 재현) |
| `uv run --directory be/worker pytest -q` | 922 passed, `be/worker` 변경 없음 (하위 에이전트 실행) |
| `fe`: `npx tsc -b` | exit 0 |
| `fe`: `vitest run` | 84 files, 800 passed |
| `fe`: `pnpm lint` | 0 errors, 경고 1건(`saved-utterance-dashboard.tsx`, 기존) |

**변이 검증** (수정을 되돌려 테스트가 빨개지는지 확인하고, 원복 뒤 바이트 비교):

- BE, 직접 재현
  - 폴더 삭제에서 `moveMeetingsToDefault` 호출을 빼면 → "DELETE /folders/:id는 그 폴더의 회의를 기본 폴더로 옮기고 회의는 남긴다"가 실패(14개 중 1개).
  - 업로드 INSERT의 `COALESCE($6, default_folder_id())`를 `$6`으로 바꾸면 → meetings-management 12개 중 8개 실패. 실패한 것 중에 "upload without folder_id (or empty) lands in the default folder"가 있다.
- FE
  - 좌측 폴더 필터 조건을 빼면 → left-nav 폴더 테스트 2개 실패.
  - 업로드 FormData의 `folder_id`를 빼면 → 모달 폴더 테스트 2개 실패.
  - 라이브 body의 `folder_id`를 빼면 → live 테스트 1개 실패.
  - 헤더에서 같은 폴더를 골랐을 때 요청을 건너뛰는 조건을 빼면 → 1개 실패.

**마이그레이션 백필:**
- 임시 Postgres에서 029까지 적용하고 회의 2개를 넣은 뒤 030을 적용했다.
- 두 회의 모두 `기본 폴더`에 들어갔고, `folder_id IS NULL`은 0건, 컬럼은 `NOT NULL`이다.

**실제 앱** (개발 DB, 사용자 승인):
- 준비
  - 적용 전에 `~/damwha-backups/dev-before-030-20261004-173145.dump`로 백업했다.
  - `pnpm be:migrate` 뒤 회의 13개가 모두 `기본 폴더`에 들어갔다.
- 실행 방식
  - API는 3300 포트, Vite는 5199 포트로 띄웠다. 3000 포트는 실행 중인 데스크톱 앱이 쓰고 있었다.
  - 헤드리스 Chrome(playwright)으로 라이트·다크 두 테마를 돌렸다.
- 확인한 흐름

| 단계 | 결과 |
| --- | --- |
| 폴더 만들기 | 바로 선택되고, 목록에 "이 폴더에 회의가 없어요."가 뜬다 |
| 대소문자만 다른 이름 | "같은 이름의 폴더가 있어요."(409) |
| 회의 헤더에서 폴더 이동 | 숫자가 기본 12 / 프로젝트A 1로 바뀌고, 헤더 표시도 바뀐다 |
| 폴더 선택 | 목록에 그 회의만 남고, 새 회의 모달의 폴더 초기값이 `프로젝트A`다 |
| 이름 바꾸기 | 적용된다 |
| 삭제 확인 문구 | "안에 있던 회의 1개는 기본 폴더로 옮겨져요." |
| 삭제 후 | 선택이 `전체 회의`로 돌아가고, 기본 폴더가 13이 되고, 헤더도 `기본 폴더`가 된다 |

- 콘솔 오류는 중복 이름 단계에서 의도한 409 하나뿐이다.
- 끝난 뒤 개발 DB는 `기본 폴더` 하나에 회의 13개다.

## 완료 기준 (스펙 §8)

| # | 기준 | 판정 | 근거 |
| --- | --- | --- | --- |
| 1 | 030 뒤 `folder_id IS NULL` 0, 기존 회의 모두 기본 폴더 | 충족 | 임시 DB 백필, 개발 DB 13개 |
| 2 | 업로드·실시간 녹음이 고른 폴더(미선택 시 기본 폴더)에 들어감 | 충족 (조건) | e2e(업로드·라이브 생략·지정·없는 폴더 400), FE 테스트. 실제 앱에서는 모달 초기값까지만 확인했고, 실제 업로드·녹음은 하지 않았다 |
| 3 | 헤더에서 폴더를 바꾸면 숫자와 목록이 바로 따라옴 | 충족 | 실제 앱 |
| 4 | 폴더를 지우면 회의가 기본 폴더로 옮겨지고 수는 그대로 | 충족 | e2e + 변이, 실제 앱 |
| 5 | 기본 폴더 이름 바꾸기·삭제 거부, UI에 메뉴 없음 | 충족 | e2e 400, FE 테스트(기본 폴더에 메뉴 없음) |
| 6 | 폴더·즐겨찾기·태그가 함께 걸림 | 충족 | left-nav 테스트(폴더 ∧ 태그, 겹친 조건 문구) |
| 7 | BE·FE 테스트·typecheck 통과, 실제 앱 확인 | 충족 | 위 표 |

## 알아 둘 것

- **개발 DB는 이제 030까지 올라가 있다.** 030이 없는 브랜치(`dev`)로 돌아가 `pnpm be:migrate --status`를 보면 030이 `unknown`으로 나온다.
  - 같은 출력에 이미 `020_job_stage_stt_overlap.sql`도 `unknown`으로 있었다. 이번 작업 전부터 있던 상태다.
  - 되돌리려면 위 백업을 `pg_restore`한다.
- **데모 덤프(`demo/seed/damwha-demo.dump`)는 다시 만들지 않았다.** 복원 뒤 마이그레이션이 돌면 기본 폴더로 들어간다.
