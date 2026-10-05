# 회의 목록 드롭존과 결정·할 일 요약 결과

**스펙:** `docs/superpowers/specs/2026-10-05-meeting-list-overview-design.md`
**계획:** `docs/superpowers/plans/2026-10-05-meeting-list-overview.md`
**브랜치:** `feat/meeting-list-overview` (`origin/feat/meeting-folders` @ `2daabeb`에서 분기, 미커밋)

## 구현한 것

- **BE:** `GET /lenses`에 `folder_id` 필터(형식 오류 400)와 응답 `total`.
- **FE:**
  - `/meetings`·`/folders/:id` 위에 드롭존을 둔다. 회의가 없으면 크게, 있으면 한 줄로 그린다.
  - 드롭·`파일 선택하기`(`⌥U`)는 파일을 채운 새 회의 모달을, `실시간 녹음 시작`은 실시간 탭 모달을 연다.
    폴더는 보던 폴더로 시작한다.
  - 회의가 있으면 `최근 결정 N건` / `진행 중인 할 일 N건` 카드를 둔다. 폴더 화면은 그 폴더만 센다.
    결정은 근거 시각 링크, 할 일은 담당자 아바타·기한 배지를 단다.
- **living doc:** `fe/CLAUDE.md` 회의 폴더 단락.

## 검증

| 명령 | 결과 |
| --- | --- |
| `pnpm build` (be) | exit 0 |
| `jest --runInBand --config ./jest.config.js test/lenses.e2e-spec.ts` (be) | 42 passed |
| `pnpm build` (fe, `tsc -b` + vite) | exit 0 |
| `pnpm lint` (fe) | exit 0, 기존 경고 1개(`saved-utterance-dashboard.tsx`) |
| `pnpm test` (fe) | 86 files / 822 tests passed |

첫 전체 실행에서 `left-nav.test.tsx`의 "새 폴더: … 그 목록으로 간다"가 한 번 실패했다(`aria-current`를
`findByText` 직후 동기로 읽는다). 단독 실행 15/15, 전체 재실행 822/822 통과 — 이번 변경과 무관한 타이밍
의존 테스트다.

**변이 검증** (줄을 지우고 테스트가 빨개지는지 확인한 뒤 되돌림):

| 지운 것 | 실패한 테스트 |
| --- | --- |
| BE `m.folder_id` 조건 | `filters by folder_id and rejects a malformed one` |
| FE `folder_id` 쿼리 파라미터 | 폴더 목록 요약 테스트 |
| 모달 `initialFile` 적용 | 드롭 → 파일 채운 모달 테스트 |
| 모달 `initialSource` 적용 | 녹음 → 실시간 탭 테스트 |
| 드롭존 오디오 검사 | 드롭 테스트(비오디오에도 모달이 열림) |

**실화면** (로컬 BE + Vite, Playwright 헤드리스, 1440×1000): 전체 목록 라이트/다크, 빈 목록(응답을 `[]`로
가로채 DB는 건드리지 않음) 라이트/다크, 드롭 → `주간회의.m4a`가 채워지고 폴더 `기본 폴더`가 골라진 모달,
녹음 → 실시간 탭 모달. 폴더 화면의 요청은 `/api/lenses?kind=decision&completion_status=open&limit=2&folder_id=fld_1`.
페이지 오류 0, 유휴 4초·모달 열림 4초 동안 추가 API 요청 0.

## 완료 기준

| 기준 | 판정 |
| --- | --- |
| 드롭존이 항상 목록 위, 빈 목록이면 크게 | 충족 |
| 드롭·선택은 파일 채운 모달, 바로 올리지 않음 | 충족 |
| 녹음은 실시간 탭 모달 | 충족 |
| 비오디오 파일은 모달을 열지 않음 | 충족 |
| 결정·할 일 카드, 건수, 근거 링크, 기한 배지 | 충족 |
| 폴더 화면은 그 폴더 항목만 | 충족 |
