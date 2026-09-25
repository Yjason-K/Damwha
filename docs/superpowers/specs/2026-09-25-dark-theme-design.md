# 다크 테마 — 시스템 따르기 + 사이드바에서 직접 고르기 (구현 스펙)

작성일: 2026-09-25
선행: `dev` = `7536228` (#34 HF 토큰 앱 내 입력 머지 뒤).
대체: `fe/DESIGN.md` §Don't의 "다크 모드 대응을 추가하지 말 것". 그 금지는 "`.dark` 토큰 세트가 없는데
`dark:`만 붙이면 대응한 척이 된다"는 이유였고, 이 스펙이 그 토큰 세트를 통째로 정의한다.

## 1. 목표

**담화 화면 전체가 다크 테마로 온전히 읽힌다. 기본은 macOS(브라우저) 설정을 따르고, 사용자는 사이드바에서
시스템 / 라이트 / 다크를 직접 고를 수 있다.**

지금은 라이트 전용이다. `fe/src/index.css`에 `@custom-variant dark (&:is(.dark *))` 한 줄만 선언돼 있고
`.dark` 토큰 블록도 `prefers-color-scheme` 처리도 없어서, macOS를 다크로 둬도 웹·데스크톱 모두 밝게 뜬다.

## 2. 범위

### 2.1 포함

- `index.css`의 `.dark` 토큰 블록 — 원시 스케일·시맨틱 별칭·그림자 재정의(§3).
- 새 토큰 — 떠 있는 면, 액센트 위 글자, 지금 hex·rgba로 박힌 값들의 토큰화(§3.4).
- 첫 페인트 전에 테마를 정하는 `index.html` 인라인 스크립트(§4.2).
- 테마 저장소 + `useTheme()` 훅(§4.3).
- 좌측 사이드바 하단의 테마 버튼 + 팝오버(§5).
- 하드코딩 색 정리(§6).
- 데스크톱: 창 `backgroundColor`를 macOS 설정에 맞추고, 셸 창(`desktop/shell/*.html`)이 macOS 다크를
  따르게 한다(§7).
- 문서 갱신(§8), 테스트(§9).

### 2.2 제외

- **창 제목 표시줄을 앱 안 선택에 맞추기** — `nativeTheme.themeSource` 동기화. 렌더러 → main 채널이
  필요한데, desktop-bridge의 "main → 렌더러 한 방향" 계약(Phase 1 스펙 §6.11)을 깨거나 폴링을 들여야 한다.
  앱 안 선택과 macOS 설정이 다를 때 제목 표시줄만 macOS 쪽을 따르는 것은 알려진 한계로 받아들인다.
- **브랜드 마크 재채색** — `brand-mark.tsx`·favicon·앱 아이콘은 테마 대상이 아니다(DESIGN.md §1).
  어두운 패널에서 잉크 사각형 윤곽은 거의 묻히지만 흰 말풍선·민트가 형태를 들고 간다.
- `index.html`의 `theme-color` — 브랜드 바탕 색조(`#0F161E`)라 그대로 둔다.
- 서버 저장 — 테마는 기기별 UI 취향이라 `app_setting`에 올리지 않는다.

## 3. 팔레트

### 3.1 원칙

- **원시 스케일의 이름과 역할을 유지하고 값만 바꾼다.** 라이트에서 `--gray-0`은 "카드 면", `--gray-12`는
  "본문 글자"다. 다크에서도 같은 뜻이 되도록 램프를 다시 쓴다. 컴포넌트가 원시 스케일을 직접 쓰는 곳
  (`var(--gray-2)` 21회 등)이 대부분 손대지 않고 맞는 이유다.
- 바탕은 **무채색 검정**. 라이트의 Mintlify 무채색 스케일을 뒤집은 것으로, 화자 색·민트가 물들지 않는다.
- 주 버튼은 **잉크 반전** — 라이트의 "가장 진한 색 = 주 버튼"이 다크에서 "가장 밝은 색 = 주 버튼"이 된다.
  민트는 선택·링크·포커스 전용으로 남는다(강조는 화면당 하나).
- 떠 있는 층(툴팁·토스트)은 **한 단계 밝은 회색 면 + 테두리 + 짙은 그림자**. 반전(밝은 면)은 어두운
  화면에서 번쩍여서 고르지 않았다.

### 3.2 값 (`.dark` 블록)

대비는 카드(`#18181a`) 바탕 기준.

| 토큰 | 라이트 | 다크 | 역할 · 대비 |
| --- | --- | --- | --- |
| `--gray-0` | `#ffffff` | `#18181a` | card |
| `--gray-1` | `#fafafa` | `#111113` | panel |
| `--gray-2` | `#f7f7f7` | `#0c0c0d` | app · sunken |
| `--gray-3` | `#ededed` | `#232326` | hover |
| `--gray-4` | `#e5e5e5` | `#2a2a2e` | border |
| `--gray-5` | `#d4d4d4` | `#37373c` | border-strong · switch 트랙 |
| `--gray-6` | `#c2c2c2` | `#4a4a50` | |
| `--gray-7` | `#a8a8aa` | `#6e6e75` | text-faint · 3.5 |
| `--gray-8` | `#888888` | `#8b8b92` | text-muted · 5.2 |
| `--gray-9` | `#5a5a5c` | `#a8a8ae` | text-secondary · 7.5 |
| `--gray-10` | `#3a3a3c` | `#c8c8cc` | |
| `--gray-11` | `#1c1c1e` | `#e2e2e4` | |
| `--gray-12` | `#0a0a0a` | `#ededed` | text-primary · 15.1 |
| `--accent-1` | `#f2fcf8` | `#0d1f1a` | 민트 최약 |
| `--accent-2` | `#dcf7ee` | `#0f2a23` | 선택 행 (accent-11 글자 9.2) |
| `--accent-3` | `#cbf3e5` | `#133a30` | 선택 hover |
| `--accent-6` | `#00d4a4` | `#2fdcae` | 포커스 링 |
| `--accent-9` | `#0a0a0a` | `#ededed` | 주 버튼 |
| `--accent-10` | `#1c1c1e` | `#d4d4d8` | 주 버튼 hover |
| `--accent-11` | `#0a6e56` | `#4fe0b9` | 링크 · accent-text · 10.7 |
| `--accent-12` | `#063a2e` | `#a6f2dd` | |
| `--green-bg` / `-9` / `-text` | | `#0f2417` / `#3fae66` / `#6fd394` | 8.9 |
| `--amber-bg` / `-9` / `-text` | | `#2a1f0a` / `#d99a2b` / `#f0bd5e` | 9.4 |
| `--red-bg` / `-text` | | `#2c1414` / `#f28b8b` | 7.3 |
| `--red-9` | `#c94a4a` | `#c94a4a` (동일) | 흰 글자 4.6 — danger 버튼이 두 테마 공통 |

화자 8색은 **`-solid`를 라이트와 똑같이 둔다** — 흰 이니셜 대비(3.7~5.5)를 지켜야 하고, 카드 대비 3.2~4.8로
비텍스트 UI 기준(3:1)을 넘는다. `-bg`·`-text`만 다크용으로 바꾼다(모두 7.3 이상).

| 화자 | `-bg` | `-text` | 대비 |
| --- | --- | --- | --- |
| 1 | `#1c2340` | `#9fb1f5` | 7.39 |
| 2 | `#13291a` | `#7fd497` | 8.65 |
| 3 | `#2b2210` | `#e7b95e` | 8.59 |
| 4 | `#321a24` | `#f09bbb` | 7.73 |
| 5 | `#251d3d` | `#bea5f3` | 7.46 |
| 6 | `#1f2714` | `#aed17c` | 8.99 |
| 7 | `#10262e` | `#7cc9e2` | 8.45 |
| 8 | `#2f1c16` | `#f2a38b` | 8.00 |

### 3.3 시맨틱 별칭 · 그림자

대부분의 별칭은 원시 스케일을 참조하므로 자동으로 따라온다. 다크에서 따로 덮어쓰는 것:

- `--text-on-accent: #0a0a0a` (라이트 `#ffffff`)
- `--surface-overlay: rgba(0, 0, 0, 0.6)` (라이트 `rgba(10,10,10,.45)`)
- `--shadow-*` — 같은 모양, 검정 알파를 올린다(`xs` .3, `sm` .35/.25, `md` .5/.3 + 링 `rgba(255,255,255,.04)`,
  `lg` .6/.35 + 같은 링, `inset` .3). 어두운 면 위에서 옅은 그림자는 보이지 않는다.
- `--focus-ring`은 안쪽 링이 `--gray-0`(카드 면)을 참조하므로 그대로 맞는다.

### 3.4 새 토큰 (`:root`와 `.dark` 모두 정의)

| 토큰 | 라이트 | 다크 | 대체하는 것 |
| --- | --- | --- | --- |
| `--surface-floating` | `var(--gray-12)` | `#26262a` | tooltip·toast의 `var(--gray-12)` |
| `--border-floating` | `transparent` | `#34343a` | (신규) 다크 떠 있는 층 윤곽 |
| `--text-on-floating` | `var(--gray-1)` | `#ededed` (12.9) | tooltip·toast의 `var(--gray-1)`, toast의 `hover:text-white` |
| `--text-on-floating-muted` | `var(--gray-7)` | `#a8a8ae` (6.4) | toast 닫기 버튼의 `var(--gray-7)` |
| `--toast-success` | `#5fe3ad` | `#5fe3ad` | `toaster.tsx`의 hex |
| `--toast-danger` | `#f58c8c` | `#f58c8c` | `toaster.tsx`의 hex |
| `--red-9-hover` | `#b03d3d` | `#b03d3d` | `button.tsx` danger hover hex |
| `--overlay-hover` | `rgba(10,10,10,.06)` | `rgba(255,255,255,.08)` | `tag.tsx`의 `hover:bg-black/[0.06]` |
| `--surface-scrim-soft` | `rgba(20,23,28,.28)` | `rgba(0,0,0,.5)` | `command-bar.tsx`의 rgba 오버레이 |

토스트 아이콘 두 색은 토스트가 **두 테마 모두 어두운 면**이라 값이 같다 — 토큰으로 옮겨 "어두운 면용
시맨틱 토큰이 없어서 생긴 구멍"(DESIGN.md)을 막는 것이 목적이다.

## 4. 테마 결정과 저장

### 4.1 모델

- 선택(preference): `"system" | "light" | "dark"`. 기본 `"system"`.
- 해석(resolved): `"light" | "dark"` = `resolveTheme(pref, systemDark)` —
  `pref === "system" ? (systemDark ? "dark" : "light") : pref`.
- 저장: `localStorage["damwha:theme"]`. 없거나 셋 중 하나가 아니면 `"system"`. `getItem`/`setItem`이
  던지는 환경(차단된 브라우저 저장소)은 try/catch로 `"system"`에 떨어지고, 쓰기 실패는 이번 세션 메모리에만
  남긴다.
- 적용: `<html>`에 해석이 `dark`면 `class="dark"`, 그리고 `style.colorScheme = resolved` — 스크롤바·폼
  기본 컨트롤·`<select>` 팝업이 따라온다.

### 4.2 첫 페인트 (`index.html` 인라인 스크립트)

`<head>`에 `<script>`를 CSS보다 먼저 둔다. 모듈 로드를 기다리면 다크 사용자가 흰 화면을 한 번 본다.
10줄 안팎: 저장값 읽기(try/catch) → `matchMedia("(prefers-color-scheme: dark)").matches` →
`resolveTheme`과 같은 규칙 → `.dark`·`color-scheme` 적용.

인라인 스크립트는 모듈을 import할 수 없어서 판정 규칙이 두 벌이 된다. 어긋남은 테스트가 막는다(§9) —
`index.html`에서 스크립트 본문을 읽어 가짜 `localStorage`·`matchMedia`로 6가지 조합을 돌리고,
`resolveTheme`과 결과가 같은지 본다.

### 4.3 저장소와 훅 (`fe/src/shared/lib/theme.ts`)

- 모듈 수준 저장소: `getPreference()`, `setPreference(p)`, `subscribe(fn)`. `setPreference`는 저장 →
  `<html>` 적용 → 구독자 알림.
- `useTheme()` = `useSyncExternalStore` 위에서 `{ preference, resolved, setPreference }`.
- `"system"`일 때 `matchMedia`의 `change`를 구독해 macOS 전환을 실시간으로 따른다.
- `window`의 `storage` 이벤트(`key === "damwha:theme"`)로 다른 탭의 변경을 따른다.
- 초기화는 `main.tsx`에서 한 번 — 인라인 스크립트가 이미 붙인 클래스를 저장소 상태와 맞추고 리스너를 건다.

## 5. 사이드바 테마 버튼

- 위치: `left-nav.tsx` 맨 아래, 회의 목록(`flex-1`) 뒤에 고정되는 하단 줄. 기존 `icon-button`·`popover`를
  쓴다.
- 아이콘: 선택에 따라 시스템 ◐ / 라이트 ☀ / 다크 ☾(`Icon` 세트에 없으면 인라인 SVG를 `icon.tsx` 관례대로
  추가).
- 팝오버: 세 항목, 현재 선택에 체크. `role="menu"` 안의 `role="menuitemradio"` + `aria-checked`. 고르면
  `setPreference` 후 닫힌다.
- 버튼 `aria-label`: `화면 테마: 시스템`처럼 현재 선택을 담는다. 툴팁도 같은 문구.
- 데모 투어의 `data-tour` 대상은 건드리지 않는다.

## 6. 하드코딩 색 정리

| 위치 | 지금 | 바꾼 뒤 |
| --- | --- | --- |
| `left-nav.tsx:109`, `transcript-pane.tsx:103`, `player-bar.tsx:159`, `utterance.tsx:250`, `checkbox.tsx:75` | `--accent-solid` 위 `text-white` | `text-[color:var(--text-on-accent)]` |
| `switch.tsx` | 켜짐 상태에도 흰 손잡이, rgba 그림자 | 트랙에 `peer-checked:[&>span]:bg-[var(--text-on-accent)]`, 그림자는 `--shadow-xs` |
| `tooltip.tsx` | `bg-[var(--gray-12)]` / `text-[color:var(--gray-1)]` | `--surface-floating` / `--text-on-floating` + `border-[color:var(--border-floating)]` |
| `toast.tsx` | 같은 쌍 + `hover:text-white`, 닫기 `--gray-7` | 같은 교체 + `--text-on-floating` / `--text-on-floating-muted` |
| `toaster.tsx` | `text-[#5fe3ad]`, `text-[#f58c8c]` | `--toast-success`, `--toast-danger` |
| `button.tsx` danger | `hover:bg-[#b03d3d]` | `hover:bg-[var(--red-9-hover)]` |
| `tag.tsx` | `hover:bg-black/[0.06]` | `hover:bg-[var(--overlay-hover)]` |
| `command-bar.tsx` | `bg-[rgba(20,23,28,0.28)]` | `bg-[var(--surface-scrim-soft)]` |

그대로 두는 것: 화자 원색 위 `text-white`(`avatar`, `speaker-track`, `utterance.tsx:97`, `insight-pane`·
`transcript-pane`의 화자 칩) — 원색이 두 테마 공통이다. danger 버튼의 `text-white` — `--red-9`가 공통이다.
`brand-mark.tsx`의 고정 색.

## 7. 데스크톱

- `desktop/src/windows/window-background.ts`(신규): `windowBackground(dark: boolean)` →
  `dark ? "#0c0c0d" : "#f7f7f7"`. 메인 창(`main.ts`의 `new BrowserWindow`)과 셸 창(`shell-window.ts`)이
  `backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors)`로 연다. 값은 `--surface-app`과
  같아야 한다 — 로딩 중 창 바탕과 첫 페인트가 이어지게.
- `desktop/shell/*.html`: 각 파일이 들고 있는 토큰 사본에 `@media (prefers-color-scheme: dark)` 블록을
  더해 §3.2와 같은 값으로 덮는다. 셸 창은 `file://`이라 앱의 localStorage를 못 읽으므로 macOS 설정만 따른다.
- 렌더러 → main 채널은 만들지 않는다(§2.2).
- 알려진 한계: API가 선호 포트 충돌로 다른 포트에 뜨면 origin이 달라져 저장된 선택이 안 보이고 `"system"`으로
  돌아간다. 데모 투어 상태(`tour-state.ts`)가 이미 같은 제약 아래 있다.

## 8. 문서

- `fe/DESIGN.md`: §Don't의 다크 금지 항목을 "색은 토큰으로만 고르고 두 테마에서 확인한다. `dark:`는 토큰으로
  표현할 수 없을 때만 쓴다"로 교체. raw hex 예외 3곳 서술을 새 토큰으로 갱신. 다크 팔레트·새 토큰·떠 있는
  층 규칙을 해당 절에 반영.
- `fe/CLAUDE.md`: 토큰 절에 `.dark` 블록, `shared/lib/theme.ts`, `index.html` 인라인 스크립트의 존재와
  "판정 규칙이 두 벌, 테스트가 묶는다"를 한 단락.
- `desktop/CLAUDE.md`: 창 `backgroundColor`와 셸 HTML의 다크 블록 — `--surface-app`과 값이 같아야 한다.

## 9. 테스트

- `theme.test.ts`: `resolveTheme` 3×2 전 조합. 저장소 — 잘못된 저장값·`localStorage` 예외·`setPreference`가
  `<html>` 클래스와 `color-scheme`을 바꾸는지·`storage` 이벤트·`"system"`에서 `matchMedia` 변경 추종.
- `theme-inline-script.test.ts`: `index.html`의 인라인 스크립트를 실행해 6조합이 `resolveTheme`과 같은지.
- 사이드바 테마 버튼 테스트: 팝오버 열림, 항목 선택 → `<html>`의 `.dark`, `aria-label`·`aria-checked`.
- `design-tokens.test.ts` 확장:
  - `.dark` 블록이 정의하는 변수는 모두 `:root`에도 있다(오타 방지 — 없는 이름을 덮으면 조용히 무시된다).
  - 컴포넌트 소스(`.tsx`)에 raw hex·`rgba(` 색이 허용 목록(`brand-mark.tsx`) 밖에서 나오지 않는다.
  - `--accent-solid` 바탕과 `text-white`가 같은 className 문자열에 함께 나오지 않는다.
- 데스크톱: `window-background.test.ts` — 두 값, 그리고 `index.css`의 라이트·다크 `--gray-2`와 같은지.
- 수동 확인: 브라우저에서 라이트·다크 각각 회의 화면(전사·인사이트·플레이어), 설정, 화자 관리, 저장한 발언,
  명령 팔레트, 다이얼로그, 토스트, 툴팁, 체크박스·스위치 켜짐 상태를 본다.
