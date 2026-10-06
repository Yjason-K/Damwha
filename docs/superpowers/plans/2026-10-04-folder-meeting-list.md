# 폴더 회의 목록 화면과 '나' 지정 구현 계획

**스펙:** `docs/superpowers/specs/2026-10-04-folder-meeting-list-design.md`
**브랜치:** `feat/folder-meeting-list` (`feat/meeting-folders` @ `c537905`에서 분기)

BE와 FE는 와이어 계약(스펙 §2.4, §2.5)만 공유하므로 두 트랙을 나란히 진행한다. 두 트랙이 손대는 파일은 겹치지 않는다.

## 트랙 A — BE (`be/`만)

1. 마이그레이션 `031_speaker_is_me.sql` (스펙 §2.5).
   - 기존 `migration.spec.ts`의 방식으로 다음을 확인한다.
     - 컬럼 기본값이 false다.
     - 두 번째 `is_me=true`는 유니크 위반이다.
2. `SpeakersRepository`에 `setMe(exec, id)`(기존 나를 내리고 이 화자를 올린다)와 `clearMe(exec, id)`를 추가한다.
   서비스는 한 트랜잭션으로 처리하고, 없는 화자면 404를 낸다. 컨트롤러에 `PUT /speakers/:id/me`와
   `DELETE /speakers/:id/me`(204)를 Swagger 설명과 함께 추가한다.
3. `MeetingsRepository.list`에 스펙 §2.4의 8개 필드를 상관 서브쿼리로 추가한다. 다른 응답(PATCH,
   즐겨찾기 등)은 바꾸지 않는다.
4. e2e 테스트를 추가한다.
   - 화자:
     - 지정하면 이전 나가 풀린다.
     - 해제는 멱등이다.
     - 없는 화자는 404다.
     - 나로 지정된 화자를 지우면 나도 사라진다.
   - 회의 목록:
     - 각 집계가 맞는다(활성만 세고 archived는 뺀다, 현재 `processing_version`의 클러스터만 센다).
     - `has_me`가 맞는다.
     - 미리보기 선택 규칙(open 할 일 우선, 요약은 done일 때만)이 맞는다.
5. 검증: `pnpm --filter damwha-be build`, 관련 e2e, 전체 BE 테스트.
   변이 증명 2개는 결과 보고에 남긴다.
   - `has_me`의 processing_version 조건을 지우면 테스트가 실패한다.
   - `setMe`의 기존 나 해제를 지우면 테스트가 실패한다.

## 트랙 B — FE (`fe/`만)

1. `api/types.ts`: `WireMeeting`에 §2.4 필드를 optional로 추가한다(기존 픽스처 보호). `WireSpeaker.is_me?`도 추가한다.
2. `api/mappers.ts`의 `toMeetingSummary`에서 `MeetingSummary`에 다음을 추가한다.
   - `startIso`, `durationMs`
   - `participantCount`, `decisionCount`, `actionCount`, `savedCount`
   - `hasMe`
   - `preview: { decision, action, summary }`
3. `features/speaker/api/speakers.ts`: `SpeakerItem.isMe`, `useSetMe`/`useClearMe`를 추가한다. 둘 다
   `["speakers"]`와 `["meetings"]`를 무효화한다. `speaker-row.tsx`에 버튼과 `나` 배지를 단다(스펙 §2.6).
4. `features/meeting/ui/meeting-card.tsx`: 카드(스펙 §2.7). 날짜 라벨 함수는 순수 함수로 만들고 테스트한다.
5. `pages/meeting-list.tsx`: 다음을 담는다.
   - 제목과 회의 수.
   - `SegmentedControl` 탭과 `Select` 정렬.
   - 검색 파라미터(스펙 §2.3).
   - 20개 페이지네이션.
   - 빈 상태(스펙 §2.8).
   - 없는 폴더 처리.

   `router.tsx`에 `/meetings`와 `/folders/:folderId`를 `lazyRoute`로 추가한다.
6. `folder-section.tsx`와 `left-nav.tsx`:
   - 섹션 제목 `전체 회의`를 버튼으로 바꾼다. 누르면 선택을 풀고 `/meetings`로 간다. `/meetings`에서는 강조한다.
   - `전체 회의` 행을 없앤다.
   - 폴더 행을 누르면 선택을 바꾸고 `/folders/:id`로 간다.
   - `/folders/:folderId` 경로를 사이드바 선택이 따라간다.

   새 폴더를 만들면 그 폴더 목록으로 이동한다. 기존 `left-nav.test.tsx`의 `전체 회의` 행 단언을 새 동작에 맞게 고친다.
7. 테스트를 추가한다.
   - 목록 화면:
     - 폴더로 거른다.
     - 각 탭이 맞게 거른다.
     - 정렬이 맞다.
     - 21번째 회의는 2페이지에 있다.
     - 나 미지정 안내가 뜬다.
     - 없는 폴더 상태가 뜬다.
   - 폴더 섹션: 이동과 강조.
   - 화자 행: 지정·해제 요청과 배지.
8. 검증: `pnpm --filter damwha-fe build`(tsc -b 포함), `lint`, 전체 vitest.
   변이 증명 2개를 남긴다.
   - 탭 필터의 `hasMe` 조건을 지우면 테스트가 실패한다.
   - 폴더 행 클릭의 navigate를 지우면 테스트가 실패한다.

## 통합 (리드)

- BE와 FE의 결과를 직접 재실행하고, 변이 증명 가운데 최소 2개를 직접 재현한다.
- 로컬 dev 서버에서 실제 화면을 확인한다: 폴더 클릭, 목록, 탭, 정렬, 페이지, 화자 관리의 나 지정과 내가 참여한 탭.
- `docs/superpowers/reports/2026-10-04-folder-meeting-list-results.md`를 작성한다.
- 커밋은 사용자가 요청할 때 관심사별로 나눠서 한다.
