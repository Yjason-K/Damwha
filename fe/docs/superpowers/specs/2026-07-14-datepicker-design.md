# DatePicker (Timbre) 설계

_2026-07-14 · 회의 업로드 모달의 녹음 일시 입력을 디자인 시스템 컴포넌트로 교체_

## 배경

회의 업로드 모달(`upload-dialog.tsx`)의 "녹음 일시 (선택)" 필드는 현재
`<Input type="datetime-local">`(브라우저 기본 위젯)을 사용한다. 브라우저마다
모양·동작이 달라 Timbre 디자인 시스템과 어긋난다. 이를 브랜드 토큰에 맞춘
DatePicker 컴포넌트로 교체한다.

**전제 확인:** `radix-ui` 프리미티브에는 Calendar/DatePicker 프리미티브가
**없다**. Popover만 있다. `react-day-picker`·`date-fns`·`dayjs`도 미설치.
따라서 "radix DatePicker" = radix **Popover** + 직접 만든 달력 그리드다.
새 의존성 없이 손수 구현한다(CLAUDE.md의 단순성 원칙).

## 목표 / 비목표

**목표**
- 녹음 일시를 Timbre 토큰에 맞는 날짜 선택기 + 시간 입력으로 교체.
- 새 npm 의존성 0. 재사용 가능한 `shared/ui` 컴포넌트로 제공.
- `useUploadMeeting` 계약(ISO 문자열 `recordedAt`) 변경 없음.

**비목표**
- 날짜 범위 선택, 다중 선택, 연/월 빠른 점프 드롭다운.
- 로케일 전환(한국어 UI 고정).
- 기존 다른 화면의 날짜 입력 교체(이번 범위는 업로드 모달만).

## 결정 사항

| 항목 | 결정 |
|------|------|
| 달력 그리드 출처 | 손수 구현, 의존성 0 (radix Popover 위) |
| 날짜/시간 | 날짜 + 시간 유지(현행 datetime-local 정밀도 보존) |
| 표시 형식 | `YYYY.MM.DD` (예: `2026.07.14`, zero-pad) |
| 컴포넌트 위치 | `src/shared/ui/` (Select/Input과 동일) |

## 컴포넌트 (신규 3개, `src/shared/ui/`)

### 1. `popover.tsx`
`radix-ui` Popover의 얇은 래퍼. export: `Popover`, `PopoverTrigger`,
`PopoverContent`, `PopoverAnchor`.
- `PopoverContent`는 `Select`의 content 표면을 재사용: `bg-popover`,
  `border border-border`, `[box-shadow:var(--shadow-md)]`, 동일한
  open/close zoom+slide 애니메이션, `z-50`, `Portal`.
- CVA export 없음 → eslint `allowExportNames` 등록 불필요.

### 2. `calendar.tsx`
손수 만든 월 그리드. 의존성 0.
- Props: `value: Date | null`, `onChange(d: Date): void`, `disabled?: boolean`.
- 내부 상태 `viewMonth: Date` — 표시 중인 달. 이전/다음 달 버튼(인라인 chevron SVG).
- 헤더: `YYYY년 M월` 라벨 + 이전/다음 nav 버튼.
- 요일 행: 일 월 화 수 목 금 토. 일요일은 `--red-text`, 나머지 muted.
- 6×7 그리드, `role="grid"` / 셀 `role="gridcell"`. 인접 달 날짜는
  `--text-faint`로 흐리게. 오늘은 은은한 ring, 선택일은
  `bg-primary text-primary-foreground rounded-sm`.
- 키보드: 방향키 포커스 이동, Enter/Space 선택, PageUp/PageDown 월 이동.
  Select와 동일한 focus-visible ring.
- `Date`만 사용(연/월/일 산술). "오늘" 판정은 렌더 시점 `new Date()` 기준.

### 3. `date-picker.tsx`
Popover + Calendar 조합.
- Props: `value: Date | null`, `onChange(d: Date | null): void`,
  `label?`, `placeholder?`(기본 "날짜 선택"), `disabled?`, `id?`.
- 트리거 = Input box와 동일 스타일 버튼(`h-8 rounded-sm border`, focus ring
  `accent-2`). 왼쪽 `calendar` 아이콘, 값 있으면 `YYYY.MM.DD` 표시 +
  트레일링 "×"(clear), 없으면 faint placeholder.
- `aria-haspopup="dialog"`, 라벨은 Input처럼 `htmlFor`/`useId` 연결.
- 날짜 선택 시 Popover 자동 닫힘, `onChange(date)`. "×" 클릭 시 `onChange(null)`.

## 업로드 모달 변경 (`upload-dialog.tsx`)

현재 line 152의 단일 `<Input type="datetime-local">`를 라벨 있는 한 행으로 교체:

```
녹음 일시 (선택)
[ 📅 2026.07.14  × ]   [ 14:30 ]
   DatePicker            Input type="time"
```

- 상태: `recordedAt: string` → `recordedDate: Date | null` + `recordedTime: string`.
- 제출 조합:
  - `recordedDate` 있음 → `recordedDate` + (`recordedTime` || "00:00")를
    로컬 시각으로 합쳐 `.toISOString()`.
  - `recordedDate` 없음 → `recordedAt` `undefined`(현행과 동일). 시간만 있으면 무시.
- `resetForm`은 두 상태 모두 초기화.

## 데이터 흐름

DatePicker는 월 뷰 외 날짜 산술을 소유하지 않는다. ISO 조합은 모달이 담당.
`useUploadMeeting`의 요청 계약(ISO 문자열 `recordedAt`)은 변경 없음.

## 엣지 케이스

- 날짜 없음 = `recordedAt` 미전송(시간 입력값 무시).
- 날짜 있고 시간 없음 = `00:00`.
- clear("×") = 날짜 초기화, 시간은 유지되나 제출에는 미반영.
- 선택 필드이므로 검증 에러 없음.

## 테스트

- 신규 `date-picker.test.tsx`: Popover 열기 → 특정 일 클릭 → `onChange` 호출,
  clear 동작. (Radix Popover는 jsdom 클릭으로 열림 — `vitest.setup.ts`의
  Pointer Capture 폴리필이 이미 존재.)
- `upload-dialog.test.tsx`: datetime-local에 의존하는 단언이 있으면
  DatePicker/time 입력 기준으로 갱신.

## 접근성 / 스타일

- 트리거 `aria-haspopup="dialog"` + 라벨 연결. 달력 `role="grid"`/`gridcell`.
- 모션은 전역 `prefers-reduced-motion`으로 이미 처리.
- 모든 색/간격은 Timbre 시맨틱 토큰 참조(원시 스케일 직접 참조 금지).
