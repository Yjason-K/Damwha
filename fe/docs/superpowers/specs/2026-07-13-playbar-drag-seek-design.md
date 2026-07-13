# 플레이바 드래그 seek 설계

날짜: 2026-07-13
범위: FE 전용 — `speaker-timeline.tsx`, `player-bar.tsx` + 컴포넌트 테스트.

## 문제

하단 플레이바의 화자 타임라인은 클릭 seek만 지원한다. 누른 채 끌어도 아무 일이
없고, 플레이헤드 핀은 `pointer-events-none`이라 잡을 수도 없다. 원하는 지점을
탐색하려면 클릭을 반복해야 한다.

## 결정 사항 (브레인스토밍 확정)

- **놓을 때 seek**: 드래그 중에는 플레이헤드 핀과 시간 라벨만 포인터를 따라가는
  미리보기, 실제 `currentTime` 변경은 `pointerup`에 1회. 스트리밍 오디오에서
  seek 폭주와 버퍼링 튐을 피한다. (실시간 스크러빙은 검토 후 배제.)
- **레인 아무 곳이나 드래그 시작**: 레인 컬럼 위 아무 데나 누르면 그 지점부터
  드래그. 클릭은 "이동 없는 드래그"로 자연 통합된다 (누른 지점 == 놓은 지점 →
  기존 클릭 seek과 동일한 결과). 핀 전용 핸들 방식은 배제.
- **드래그 중 시간 라벨 연동**: 왼쪽 `00:39 / 1:02:00` 라벨이 미리보기 시각을
  따라가야 몇 분 지점인지 알 수 있다. `SpeakerTimeline`에 선택적
  `onScrub(fraction | null)` 콜백을 추가해 `PlayerBar`가 라벨에 반영한다.

## 구현 설계

### `src/shared/ui/speaker-timeline.tsx`

- **Props 추가**: `onScrub?: (fraction: number | null) => void` — 드래그 중
  미리보기 fraction, 드래그 종료/취소 시 `null`.
- **내부 state**: `drag: number | null` (React.useState).
- **드래그 오버레이**: 기존 핀 오버레이와 같은 grid 컬럼 구조(`label | lane |
  duration?`)의 absolute 오버레이를 하나 더 렌더하고, 레인 컬럼 셀에만 pointer
  핸들러를 단다. `onSeek`이 있을 때만 렌더. 스타일: 투명, `cursor-pointer`,
  `touch-action: none`(터치 드래그가 스크롤로 새지 않게), 레인들 위·핀(z-[3])
  아래 z-index. 레인 셀에 `data-slot="timeline-scrub"`(리포의 data-slot 관행,
  테스트 셀렉터 겸용).
- **오버레이 접근성 정책**: `aria-hidden="true"`, role 없음, div 기본값 그대로
  포커스 불가 — 스크린리더와 탭 순서에 노출되지 않는다. `onClick`을 붙이지
  않는다(포인터 이벤트만) — pointerup 뒤 브라우저가 만드는 호환 click이 seek을
  중복 발생시키지 않아야 한다.
- **포인터 핸들링** (Pointer Events — 마우스·터치 공통):
  - `pointerdown`: `e.currentTarget.setPointerCapture?.(e.pointerId)`(jsdom에
    없으므로 옵셔널 호출) 후 fraction 계산 → `setDrag(f)`, `onScrub?.(f)`.
  - `pointermove`: 드래그 중일 때만 fraction 갱신 → `setDrag(f)`, `onScrub?.(f)`.
  - `pointerup`: `onSeek(f)` 1회 → `setDrag(null)`, `onScrub?.(null)`.
  - `pointercancel`: seek 없이 `setDrag(null)`, `onScrub?.(null)`.
  - fraction은 오버레이 레인 셀의 `getBoundingClientRect()` 기준
    `(clientX - left) / width`를 0..1로 클램프.
  - `releasePointerCapture`는 호출하지 않는다 — Pointer Events 스펙상
    `pointerup`/`pointercancel` 후 암묵 해제가 표준이고 요소 제거 시에도
    해제되므로, 명시 해제는 불필요한 방어 코드다 (리뷰 검토 후 의도적 배제).
- **핀 위치**: `drag ?? playhead` — 드래그 중에는 미리보기, 아니면 재생 위치.
- **SpeakerTrack으로의 `onSeek` 전달 제거**: 오버레이가 레인 클릭을 모두
  받으므로 이 컴포넌트 안에서는 트랙에 `onSeek`을 내려보내지 않는다.
  `SpeakerTrack` 자체의 클릭 seek API는 다른 사용처를 위해 그대로 둔다.
- 레인 왼쪽 라벨 컬럼(화자별 재생 버튼)은 오버레이 밖이라 영향 없음.

### `src/features/meeting/ui/player-bar.tsx`

- `const [scrub, setScrub] = React.useState<number | null>(null)`.
- 시간 라벨: `fmt(scrub ?? pos, totalSeconds)`.
- `<SpeakerTimeline onScrub={setScrub} ...>` 연결.

### `src/pages/meeting.tsx`

- `<PlayerBar key={meeting.id} ...>` 키잉 추가 — 드래그 중 ⌘K 등으로 회의가
  전환되면(포인터는 캡처돼도 키보드는 자유) 리마운트로 `scrub`·`drag` state가
  함께 초기화되어 stale 미리보기가 남지 않는다. `<audio key={meeting.id}>`와
  같은 기존 패턴. `onSeek={seek}` 배선은 그대로.

### 변경하지 않는 것

- `SpeakerTrack`: API·클릭 seek 유지 (showcase 등 다른 사용처).
- 키보드 접근성: 기존과 동일하게 10초 이동 버튼이 키보드 경로. 드래그는
  기존 클릭 seek과 같은 포인터 전용 상호작용이다 (slider role 도입은 비범위).

## 엣지 케이스

- `drag`/`scrub`이 `0`(맨 앞)일 때도 미리보기여야 하므로 판별은 `??`(null
  병합)로만 한다 — falsy 검사 금지.
- 레인 밖으로 끌어도 pointer capture로 계속 추적되고 fraction은 0..1 클램프.
- 드래그 중 `onTimeUpdate`로 `pos`가 계속 갱신돼도(재생 중 드래그) 핀·라벨은
  `drag`/`scrub`이 우선이라 튀지 않는다. 놓는 순간 seek되므로 이후 `pos`가
  그 지점부터 이어진다.

## 테스트

새 컴포넌트 테스트 `src/shared/ui/speaker-timeline.test.tsx` — 오버레이 레인
셀은 `data-slot="timeline-scrub"`으로 선택하고, 해당 요소의
`getBoundingClientRect`를 목킹해 fraction 계산을 고정한다:

- pointerdown(25% 지점) → `onScrub(0.25)` 호출, `onSeek`은 아직 호출 안 됨,
  핀이 25% 위치로 이동.
- pointermove(50%) → `onScrub(0.5)`, 핀 50%.
- pointerup(50%) → `onSeek(0.5)` 정확히 1회, `onScrub(null)`, 핀이 `playhead`로
  복귀.
- pointerdown 후 pointercancel → `onSeek` 호출 없음, `onScrub(null)`.
- 이동 없는 down+up(클릭) → 그 지점으로 `onSeek` 1회 (기존 클릭 seek 동등성).
- down+up 뒤 브라우저 호환 `click` 이벤트가 이어져도 `onSeek`은 여전히 1회다.
- `onSeek` 미전달 시 오버레이가 렌더되지 않는다.

기존 테스트(`meeting.test.tsx` 등)는 그대로 통과해야 한다.
