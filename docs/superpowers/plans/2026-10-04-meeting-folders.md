# 회의 폴더 구현 계획

**Spec:** [`docs/superpowers/specs/2026-10-04-meeting-folders-design.md`](../specs/2026-10-04-meeting-folders-design.md)
**브랜치:** `feat/meeting-folders` (`dev` @ `8a5edb2`에서 분기)

**Goal:** 회의를 폴더 하나에 넣는다. 폴더를 등록 모달과 회의 화면에서 고르고, 좌측 `폴더` 섹션에서 회의 목록을 거른다.

**Architecture:**
- BE: 새 `folders` 모듈(`tags/`와 같은 구조)과 마이그레이션 `030`.
  - `meeting.folder_id`의 DEFAULT는 `default_folder_id()` 함수다. 값을 바인딩하는 회의 INSERT 세 곳은 `COALESCE($n, default_folder_id())`로 기본 폴더를 채운다.
  - `PATCH /meetings/:id`가 `folder_id`를 받는다.
- FE: `api/folders.ts` 훅을 둔다.
  - `LeftNav`에 `FolderSection`을 넣고 폴더 선택을 로컬 상태로 둔다.
  - `NewMeetingDialog`에 폴더 Select를, `TranscriptPane` 헤더 메타에 폴더 이동 Popover를 넣는다.

BE와 FE는 스펙 §4의 API 계약만 공유하므로 병렬로 진행한다.

---

## Task 1 — BE: 마이그레이션 030

- `be/src/database/migrations/030_meeting_folder.sql`: 스펙 §3의 SQL 그대로(시퀀스 `fld_id_seq`, `default_folder_id()` 함수를 `meeting.folder_id` DEFAULT로). DEFAULT 덕분에 `folder_id` 없이 INSERT하는 기존 테스트·worker 픽스처는 고치지 않는다.
- 검증: `test/migrate-status.spec.ts` 등 마이그레이션 수를 고정한 테스트가 있으면 함께 맞춘다.
  - 030 적용 뒤 기존 회의가 기본 폴더로 들어가는지 확인하는 테스트를 `folders.e2e-spec.ts`에 둔다.
  - 방법: 030 이전 상태를 재현할 수 없으면 `UPDATE meeting SET folder_id=…`를 직접 확인하지 않는다.
    대신 "업로드한 회의의 folder_id = 기본 폴더 id"와 NOT NULL 제약을 확인한다.

## Task 2 — BE: folders 모듈

`be/src/folders/folders.{repository,service,controller,module}.ts`. `AppModule.imports`에 `FoldersModule`을 등록한다.

- repository:
  - `list`: 기본 폴더 먼저, 나머지는 `lower(name)`, 그다음 id 순
  - `create`, `rename`, `findById`, `findDefault`
  - `moveMeetingsToDefault(c, id)`, `delete(c, id)`
  - `exists(exec, id)`: 회의 쪽 검증용으로 export
- service:
  - 이름 파싱: 문자열, `trim`, 1–30자, 아니면 400
  - 이름 중복(`23505`, `folder_name_lower_idx`) → 409
  - id 형식(`^fld_[1-9][0-9]*$`)이 아니거나 행이 없으면 404
  - 기본 폴더 이름 바꾸기·삭제 → 400 `default folder cannot be renamed|deleted`
  - 삭제: 트랜잭션 안에서 `SELECT … FOR UPDATE` → `moveMeetingsToDefault` → `DELETE`
- controller: `GET /folders`, `POST /folders`(201), `PATCH /folders/:id`, `DELETE /folders/:id`(204). Swagger 주석은 `tags.controller.ts`처럼 단다.

## Task 3 — BE: 회의 쪽 folder_id

- 공용 파서: `parseFolderId(v: unknown): string | undefined`.
  - `undefined`·`''`는 미지정
  - 문자열이 아니거나 형식이 틀리면 400 `folder_id must be a folder id`
  - 존재 확인은 DB 조회 후 없으면 400 `folder not found`
  - 위치: `be/src/folders/folder-id.ts`. 존재 확인은 `FoldersRepository.exists`
- 업로드(`meetings.service.ts upload`):
  - `body.folder_id`를 받는다.
  - 형식 검증과 존재 확인을 기존 try 블록(`saveFromTemp` 전, 실패 시 `unlinkQuietly`) 안에서 한다.
  - INSERT에 `folder_id` 컬럼과 `COALESCE($6, default_folder_id())`를 넣는다.
  - controller의 `@ApiBody`와 body 타입에 `folder_id`를 추가한다.
- 라이브(`live.service.ts start`, `live.repository.ts createRecording`, `live.controller.ts`):
  - 같은 파싱을 한다. `prepare` 전 검증 위치는 `parseTitle` 옆이다.
  - 존재 확인은 회의 생성 트랜잭션 전에 한다.
  - INSERT에 같은 COALESCE를 넣는다.
- `MeetingsRepository.create`: 같은 COALESCE(인자 `folderId?: string | null`).
- `PATCH /meetings/:id` (`meetings.service.ts update`, `meetings.repository.ts update`, controller ApiBody):
  - `'folder_id' in body`이면 문자열 형식 검증, `null`은 400, 존재 확인 후 없으면 400.
  - `sets`에 `folder_id=$n`을 추가한다.
- `MeetingsModule`과 `LiveModule`이 `FoldersRepository`를 쓸 수 있게 한다. `FoldersModule`이 export하고 두 모듈이 import한다.

## Task 4 — BE 테스트

- `be/test/folders.e2e-spec.ts` (스펙 §7 BE 목록):
  - GET이 기본 폴더 하나로 시작한다.
  - 만들기 201, 대소문자만 다른 이름 409, 빈 이름·31자 400
  - 정렬(기본 먼저, 이름순)
  - 이름 바꾸기 200, 중복 409, 기본 폴더 이름 바꾸기 400, 없는 id 404
  - 삭제 204 → 그 폴더의 회의가 기본 폴더로 가고 회의 수가 그대로, 기본 폴더 삭제 400, 없는 id 404
- `meetings-management.e2e-spec.ts` 확장:
  - 업로드 시 `folder_id` 생략 → 기본 폴더, 지정 → 그 폴더
  - 없는 폴더 → 400이고 `storage/meetings/` 아래 새 디렉터리가 없다
  - `PATCH { folder_id }` 200, `null` 400, 없는 폴더 400
- `live.e2e-spec.ts` 확장: 시작 시 `folder_id` 생략·지정·없는 폴더 400(회의 행 0)
- 실행: `pnpm --filter damwha-be exec jest --runInBand --config ./jest.config.js test/folders.e2e-spec.ts test/meetings-management.e2e-spec.ts test/live.e2e-spec.ts`. 그다음 `pnpm be test`, `pnpm be build`, `pnpm be lint`(있으면).

## Task 5 — FE 데이터 계층

- `api/types.ts`:
  - `WireMeeting.folder_id: string`. 기존 픽스처가 깨지면 optional로 두고 주석을 단다. `capture_error`와 같은 이유다.
  - `WireFolder = { id; name; is_default; created_at }`
- `model/types.ts`: `MeetingSummary`와 `Meeting`에 `folderId: string`. `Folder = { id; name; isDefault }`
- `api/mappers.ts`: 두 매퍼에 `folderId: wire.folder_id`
- `api/folders.ts`: `useFolders()`(키 `["folders"]`), `useCreateFolder`, `useRenameFolder`, `useDeleteFolder`
  - 삭제 성공 시 `["folders"]`와 `["meetings"]`를 무효화하고, `["meeting"]` prefix도 무효화한다. 열린 회의의 폴더가 바뀌기 때문이다.
- `api/meetings.ts`: `useMoveMeetingToFolder()` → `PATCH /meetings/:id { folder_id }`. `["meetings"]`와 `["meeting", id]`를 무효화한다.
  - 기존 `useRenameMeeting`은 건드리지 않는다.
- 테스트: `api/folders.test.tsx`(요청 모양과 무효화), `mappers.test.ts`에 `folderId`

## Task 6 — FE 좌측 내비게이션

- `ui/folder-section.tsx` `FolderSection({ meetings, folders, value, onChange })`:
  - 머리: SectionLabel 모양으로 `폴더` 제목, `+` IconButton(label "새 폴더")
  - 항목:
    - `전체 회의`(`value === null`)를 맨 앞에 두고, 이어서 `folders` 순서대로 그린다.
    - `SidebarItem`의 meta에 회의 수(FE 계산), active 표시
    - `icon`은 `folder`(전체 회의는 `inbox`)
  - 기본 폴더가 아닌 항목: hover·focus-within에서 보이는 `more` IconButton → Popover 메뉴(`이름 바꾸기`, `삭제`)
  - 목록은 `max-h-[168px] overflow-y-auto`
- `ui/folder-dialogs.tsx`:
  - `FolderNameDialog({ open, mode: "create"|"rename", folder?, onOpenChange, onSaved })`
    - 409 → 입력란 오류 "같은 이름의 폴더가 있어요."
    - 그 밖의 오류 → 토스트(`isDemoBlocked` 가드)
  - `DeleteFolderDialog({ folder, count, ... })`: 문구는 스펙 §5.2
- `left-nav.tsx`:
  - `useFolders()`를 쓰고 `folderFilter` 상태를 둔다. `activeFolder`는 목록에 있을 때만 유효하다(태그와 같다).
  - 배치: 메뉴 항목 → `FolderSection` → 필터 → 태그 → 회의 목록
  - `filtered`에 `(activeFolder ? m.folderId === activeFolder : true)` 조건을 더한다.
  - 빈 목록 문구는 스펙 §5.1의 규칙을 따른다. 걸린 조건 수가 2 이상이면 "조건에 맞는 회의가 없어요."
  - 새로 만든 폴더는 선택한다.
  - `NewMeetingDialog`에 `defaultFolderId={activeFolder ?? undefined}`를 넘긴다.
- 폴더 조회가 실패하거나 로딩 중이면 `FolderSection`은 `전체 회의`만 그린다.
- 테스트(`left-nav.test.tsx` 확장):
  - 폴더 클릭 → 목록 필터
  - 태그와 AND
  - 삭제돼 사라진 폴더 선택 해제
  - 빈 목록 문구
  - 기본 폴더에는 `…` 메뉴 없음
  - 만들기 다이얼로그 POST와 409 문구

## Task 7 — FE 새 회의 모달

- `NewMeetingDialog` props에 `defaultFolderId?: string`
  - 상태 `folderId`, 다이얼로그가 열릴 때 `defaultFolderId ?? 기본 폴더 id`로 초기화한다.
  - `resetForm`이 지우고 다음 열림에서 다시 초기화한다.
- 제목 Input 바로 다음에 `폴더` Select를 둔다. `useFolders`가 성공했을 때만 보이고, 실패하거나 로딩 중이면 숨기며 값도 보내지 않는다.
- 업로드: `useUploadMeeting`의 FormData에 `folder_id`
- 라이브: `useStartLive` body에 `folder_id`
- 데모 업로드 시뮬레이션 경로는 건드리지 않는다.
- 테스트(`new-meeting-dialog.test.tsx`, `.live.test.tsx`):
  - 초기값이 `defaultFolderId`
  - 업로드 FormData와 라이브 body에 `folder_id`
  - 폴더 조회 실패 시 Select 없음, `folder_id` 없음
  - Radix Select는 ArrowDown으로 연다.

## Task 8 — FE 회의 헤더 폴더 이동

- `ui/meeting-folder.tsx` `MeetingFolder({ meetingId, folderId })`:
  - 메타 줄 첫 항목. 버튼에 `folder` 아이콘과 폴더 이름을 둔다. 폴더 목록을 아직 못 받았으면 버튼을 그리지 않는다.
  - 누르면 Popover 안에 폴더 목록이 뜨고, 현재 폴더에 `check` 표시를 한다.
  - 고르면 `useMoveMeetingToFolder`를 부른다. 실패하면 토스트(`isDemoBlocked` 가드)
- `transcript-pane.tsx` 메타 줄 맨 앞에 넣는다.
- 테스트: `meeting-folder.test.tsx`(목록·현재 표시·PATCH 요청). `transcript-pane.test.tsx`의 픽스처에 `folderId`를 추가한다.

## Task 9 — living doc

- `be/CLAUDE.md`: Meeting tags 항목 옆에 `Meeting folders (src/folders/, migration 030)` 항목을 둔다. 기본 폴더 행, NO ACTION FK와 삭제 시 이동, INSERT COALESCE 규칙을 적는다.
- `fe/CLAUDE.md`:
  - "회의 태그" 문단의 "폴더 대신 태그다"를 "폴더는 위치(하나), 태그는 분류(여럿)"로 고친다.
  - 회의 폴더 문단을 추가한다(좌측 필터 AND, 모달 초기값, 헤더 이동, 카운트 FE 계산).

## Task 10 — 검증

1. BE: Task 4 명령, `pnpm be test`, `pnpm be build`
2. FE: `pnpm fe test`, `pnpm fe build`(tsc -b 포함), `pnpm fe lint`, `pnpm fe format` 뒤 diff 확인
3. 실제 앱(`pnpm db:up`, `pnpm be:migrate`, `pnpm dev`)에서 브라우저로 확인한다:
   - 마이그레이션 뒤 기존 회의가 모두 기본 폴더에 있다.
   - 폴더 만들기 → 선택 → 새 회의 모달 초기값 확인
   - 회의 헤더에서 폴더 이동 → 숫자와 목록 갱신
   - 폴더 이름 바꾸기·삭제 → 회의가 기본 폴더로 옮겨진다.
   - 라이트·다크 테마 스크린샷
   - 실제 오디오 처리까지는 하지 않는다. 업로드 행 생성만 확인한다.
   - 주의: 개발 DB에 030이 적용된다. 되돌리는 마이그레이션은 없다. 개발 DB(`damwha_pgdata`)는 사용자 데이터이므로 적용 전에 사용자에게 확인한다.
4. 변이 검증: 핵심 테스트 두 개에서 수정을 되돌려 테스트가 빨개지는지 확인한다.
   - 삭제 시 회의 이동
   - 업로드 COALESCE
5. `docs/superpowers/reports/2026-10-04-meeting-folders-results.md` 작성

## 완료 기준

스펙 §8의 1–7.
