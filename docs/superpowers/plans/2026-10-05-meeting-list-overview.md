# 회의 목록 드롭존과 결정·할 일 요약 계획

**Spec:** `docs/superpowers/specs/2026-10-05-meeting-list-overview-design.md`
**브랜치:** `feat/meeting-list-overview` (`origin/feat/meeting-folders` @ `2daabeb`에서 분기)

## 작업

1. **BE `GET /lenses`** — `lenses.repository.ts`의 필터 조립을 `filterClauses()`로 빼서 `list`와 새 `count`가
   같이 쓴다. `folder_id`(`m.folder_id`) 조건을 더한다. `lenses.service.ts`가 `FOLDER_ID_RE`로 검증하고
   응답에 `total`을 싣는다.
   → 검증: `test/lenses.e2e-spec.ts`에 폴더 필터·잘못된 `folder_id` 400·페이지와 무관한 `total` 테스트.
2. **FE 데이터** — `LensListPage.total?`, `useLensOverview(kind, folderId)`(키 `["lens-overview", …]`),
   완료 토글이 그 키도 무효화.
3. **FE 요약 카드** — `lens-overview.tsx`, `due-day.ts`.
4. **FE 드롭존** — `meeting-dropzone.tsx`(드래그 강조, 오디오 검사, `⌥U`).
5. **모달 연결** — `NewMeetingDialog`의 `initialSource`/`initialFile`, `meeting-list.tsx`에서 드롭존·요약·모달 배치.
   빈 목록이면 드롭존만 크게, 요약은 숨긴다.
   → 검증: `pages/meeting-list.test.tsx`에 요약(폴더 스코프·건수·근거 링크·D-Day), 전체 목록은 폴더로 거르지
   않음, 드롭 → 파일 채운 모달, 비오디오 드롭 무시, 녹음 → 실시간 탭.
6. **전체 검증** — BE build + 렌즈 e2e, FE build·lint·test, 변이 검증, 라이트/다크 실화면.
