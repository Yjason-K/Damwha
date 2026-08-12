# 프리셋별 요약 모델 선택 — 프론트엔드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 처리 설정 화면에서 프리셋별 요약 모델을 보고 고급 설정으로 바꿀 수 있게 하고, 업로드/재처리 오버라이드와 요약 재생성 시점에도 모델을 고를 수 있게 한다.

**Architecture:** BE 계약(`GET/PUT /settings/processing`의 `summary_model`, job 오버라이드의 `summary_model`, `POST /meetings/:id/summary/generate`의 body)에 맞춰 와이어 타입을 넓히고, 기존 프리셋 카드/고급 폼/오버라이드 섹션에 select를 하나씩 더한다. 요약 재생성 모델 선택 상태는 페이지(`meeting.tsx`)가 들고 `InsightPane`에 prop으로 내린다 — 기존 프리젠테이셔널 패턴 유지.

**Tech Stack:** React + TanStack Query + vitest + Testing Library. `@/shared/ui/select`의 `Select` 컴포넌트 재사용.

## Global Constraints

- 설계 문서: `../be/docs/superpowers/specs/2026-08-12-summary-model-per-preset-design.md`.
- **BE가 먼저 머지되어야 한다.** 이 계획은 BE 계획(`../be/docs/superpowers/plans/2026-08-12-summary-model-per-preset.md`) 완료를 전제한다.
- 모델 목록은 정확히 `["qwen3.5:4b-mlx", "qwen3.5:8b-mlx", "qwen3.5:14b-mlx"]` — BE `src/contracts/model-catalog.ts`의 미러다. 값이 다르면 PUT이 400을 낸다.
- 프리셋 매핑: `light` → `qwen3.5:4b-mlx`, `standard` → `qwen3.5:8b-mlx`, `quality` → `qwen3.5:14b-mlx`.
- `PRESET_META_REVISION`은 `"2026-08-12.1"`로 갱신 (BE `PRESET_REVISION`과 일치해야 드리프트 배너가 오작동하지 않는다).
- 테스트: `npm test` (vitest run). 단건은 `npx vitest run <path>`.
- 기존 파일의 스타일/클래스 관례를 그대로 따른다. 인접 코드를 개선하지 않는다.

---

### Task 1: 와이어 타입 + 프리셋 표시 상수

**Files:**
- Modify: `src/features/settings/api/types.ts`
- Modify: `src/features/settings/lib/presets.ts`
- Modify: `src/features/settings/ui/override-section.test.tsx:21`
- Modify: `src/features/settings/ui/processing-settings-form.test.tsx:22`
- Modify: `src/features/settings/api/settings.test.tsx:18`
- Modify: `src/pages/settings.test.tsx:31`
- Modify: `src/pages/meeting.test.tsx:517`
- Test: `src/features/settings/lib/presets.test.ts` (신규)

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `type SummaryModel = "qwen3.5:4b-mlx" | "qwen3.5:8b-mlx" | "qwen3.5:14b-mlx"`
  - `ProcessingConfig.summary_model: SummaryModel`
  - `ProcessingOverride.summary_model?: SummaryModel`
  - **`ProcessingSettingsUpdate`는 이 태스크에서 건드리지 않는다** — custom 분기에 필수 필드를 넣으면 `processing-settings-form.tsx`의 저장 body가 즉시 타입 에러가 난다. 그 변경은 폼을 함께 고치는 Task 2가 한다.
  - `PRESET_META[name].summary_model: SummaryModel`
  - `SUMMARY_MODEL_OPTIONS: { value: SummaryModel; label: string }[]`
  - `PRESET_META_REVISION = "2026-08-12.1"`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/settings/lib/presets.test.ts` 신규:

```ts
import { describe, expect, it } from "vitest";

import {
  PRESET_META,
  PRESET_META_REVISION,
  PRESET_ORDER,
  SUMMARY_MODEL_OPTIONS,
} from "./presets";

describe("PRESET_META — 요약 모델", () => {
  it("프리셋별 요약 모델 매핑이 BE와 일치한다", () => {
    expect(PRESET_META.light.summary_model).toBe("qwen3.5:4b-mlx");
    expect(PRESET_META.standard.summary_model).toBe("qwen3.5:8b-mlx");
    expect(PRESET_META.quality.summary_model).toBe("qwen3.5:14b-mlx");
  });

  it("모든 프리셋의 요약 모델이 선택지 목록 안에 있다", () => {
    const values = SUMMARY_MODEL_OPTIONS.map((o) => o.value);
    for (const name of PRESET_ORDER) {
      expect(values).toContain(PRESET_META[name].summary_model);
    }
  });

  it("BE 프리셋 revision과 맞춘다", () => {
    expect(PRESET_META_REVISION).toBe("2026-08-12.1");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx vitest run src/features/settings/lib/presets.test.ts`
기대: FAIL — `SUMMARY_MODEL_OPTIONS` export 없음

- [ ] **Step 3: 와이어 타입 확장**

`src/features/settings/api/types.ts`에서 `WhisperModel` 선언 아래에 추가하고 세 타입을 수정:

```ts
/** BE `src/contracts/model-catalog.ts`의 SUMMARY_MODELS 미러 — 함께 갱신할 것. */
export type SummaryModel =
  | "qwen3.5:4b-mlx"
  | "qwen3.5:8b-mlx"
  | "qwen3.5:14b-mlx";
```

`ProcessingConfig`에 필드 추가:

```ts
export type ProcessingConfig = {
  preset: PresetName | "custom";
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
};
```

`ProcessingSettingsUpdate`는 그대로 둔다 (Task 2에서 함께 바꾼다).

`ProcessingOverride`에 optional 필드 추가:

```ts
export type ProcessingOverride = {
  preset?: PresetName;
  whisper_model?: WhisperModel;
  devices?: { diarization?: Device; stt?: Device };
  language?: string;
  summary_model?: SummaryModel;
};
```

- [ ] **Step 4: 표시 상수 확장**

`src/features/settings/lib/presets.ts`에서 import에 `SummaryModel`을 추가하고, `PRESET_META`의 타입과 세 항목에 `summary_model`을 넣는다:

```ts
import type {
  Device,
  PresetName,
  SummaryModel,
  WhisperModel,
} from "../api/types";
```

```ts
export const PRESET_META: Record<
  PresetName,
  {
    label: string;
    desc: string;
    whisper_model: WhisperModel;
    devices: { diarization: Device; stt: Device };
    summary_model: SummaryModel;
  }
> = {
  light: {
    label: "가볍게",
    desc: "8GB 램에 알맞아요",
    whisper_model: "small",
    devices: { diarization: "gpu", stt: "cpu" },
    summary_model: "qwen3.5:4b-mlx",
  },
  standard: {
    label: "표준",
    desc: "16–32GB 램에 알맞아요",
    whisper_model: "large-v3-turbo",
    devices: { diarization: "gpu", stt: "gpu" },
    summary_model: "qwen3.5:8b-mlx",
  },
  quality: {
    label: "고품질",
    desc: "64GB+ 램에 알맞아요",
    whisper_model: "large-v3",
    devices: { diarization: "gpu", stt: "gpu" },
    summary_model: "qwen3.5:14b-mlx",
  },
};
```

`PRESET_META_REVISION`을 갱신하고 파일 상단 주석의 revision 표기도 함께 고친다:

```ts
export const PRESET_META_REVISION = "2026-08-12.1";
```

`WHISPER_MODEL_OPTIONS` 아래에 추가:

```ts
export const SUMMARY_MODEL_OPTIONS: { value: SummaryModel; label: string }[] = [
  { value: "qwen3.5:4b-mlx", label: "qwen3.5 4B — 가장 빠름, 8GB 램" },
  { value: "qwen3.5:8b-mlx", label: "qwen3.5 8B — 균형, 16–32GB 램" },
  { value: "qwen3.5:14b-mlx", label: "qwen3.5 14B — 가장 정확, 64GB+ 램" },
];
```

- [ ] **Step 5: 테스트 통과 확인**

실행: `npx vitest run src/features/settings/lib/presets.test.ts`
기대: PASS (3건)

- [ ] **Step 6: 기존 테스트의 목 데이터 갱신**

`ProcessingConfig` 목을 만드는 다섯 곳에 `summary_model`을 넣고 `preset_revision`을 새 값으로 바꾼다:

실행: `grep -rn "preset_revision" src --include="*.tsx" --include="*.ts"`

각 목 객체에서:
- `preset_revision: "2026-07-13.1"` → `preset_revision: "2026-08-12.1"`
- 같은 객체에 `summary_model: "qwen3.5:8b-mlx"` 추가 (목의 preset이 `standard`가 아니면 그 프리셋에 맞는 값으로)

대상: `src/features/settings/ui/override-section.test.tsx:21`, `src/features/settings/ui/processing-settings-form.test.tsx:22`, `src/features/settings/api/settings.test.tsx:18`, `src/pages/settings.test.tsx:31`, `src/pages/meeting.test.tsx:517`.

- [ ] **Step 7: 전체 테스트 확인**

실행: `npm test`
기대: PASS. 타입 에러가 남으면 `ProcessingConfig`/`ProcessingSettingsUpdate` 리터럴을 만드는 다른 곳이 있는지 확인 —
`npx tsc --noEmit`

- [ ] **Step 8: 커밋**

```bash
git add src/features/settings/api/types.ts src/features/settings/lib/presets.ts src/features/settings/lib/presets.test.ts src/features/settings/ui/override-section.test.tsx src/features/settings/ui/processing-settings-form.test.tsx src/features/settings/api/settings.test.tsx src/pages/settings.test.tsx src/pages/meeting.test.tsx
git commit -m "feat: 요약 모델 와이어 타입 + 프리셋 표시 상수"
```

---

### Task 2: 설정 화면 — 카드 표시 + 고급 select

**Files:**
- Modify: `src/features/settings/ui/processing-settings-form.tsx`
- Test: `src/features/settings/ui/processing-settings-form.test.tsx`

**Interfaces:**
- Consumes: `SUMMARY_MODEL_OPTIONS`, `PRESET_META[name].summary_model`, `ProcessingConfig.summary_model` (Task 1)
- Produces:
  - `ProcessingSettingsUpdate`의 custom 분기에 `summary_model: SummaryModel` (필수) — Task 1이 미뤄둔 변경
  - `FormState`에 `summary_model: SummaryModel` 필드. 저장 body의 custom 분기에 `summary_model` 포함.

**추가 파일:** `src/features/settings/api/types.ts` (`ProcessingSettingsUpdate` custom 분기)

`ProcessingSettingsUpdate`를 먼저 고친다 — 이 변경과 아래 `handleSave` 수정은 한 쌍이다:

```ts
export type ProcessingSettingsUpdate =
  | { preset: PresetName; language: string }
  | {
      preset: "custom";
      language: string;
      whisper_model: WhisperModel;
      devices: { diarization: Device; stt: Device };
      summary_model: SummaryModel;
    };
```

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/settings/ui/processing-settings-form.test.tsx`에 추가. 이 파일의 기존 렌더 헬퍼와 쿼리 목 설정을 그대로 재사용한다(파일 상단의 기존 패턴 확인: `grep -n "const renderForm\|function render\|beforeEach" src/features/settings/ui/processing-settings-form.test.tsx`):

```tsx
  it("프리셋 카드에 요약 모델을 보여준다", async () => {
    // 기존 테스트와 동일한 렌더 헬퍼 사용
    renderForm();
    expect(await screen.findByText(/qwen3.5:8b-mlx/)).toBeInTheDocument();
  });

  it("고급에서 요약 모델을 바꾸면 custom으로 전환된다", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(await screen.findByRole("button", { name: /고급 설정/ }));
    await user.click(screen.getByLabelText("요약 모델"));
    await user.click(screen.getByRole("option", { name: /14B/ }));
    expect(screen.getByText(/사용자 지정 설정을 쓰고 있어요/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx vitest run src/features/settings/ui/processing-settings-form.test.tsx`
기대: FAIL — `요약 모델` 라벨을 찾지 못함

- [ ] **Step 3: FormState와 초기화 확장**

`src/features/settings/ui/processing-settings-form.tsx`에서 import에 `SummaryModel`, `SUMMARY_MODEL_OPTIONS`를 추가:

```tsx
import type {
  Device,
  PresetName,
  ProcessingConfig,
  SummaryModel,
  WhisperModel,
} from "../api/types";
import {
  deviceSummary,
  PRESET_META,
  PRESET_META_REVISION,
  PRESET_ORDER,
  SUMMARY_MODEL_OPTIONS,
  WHISPER_MODEL_OPTIONS,
} from "../lib/presets";
```

`FormState`와 `fromConfig`를 교체:

```tsx
type FormState = {
  preset: PresetName | "custom";
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
  summary_model: SummaryModel;
};

function fromConfig(c: ProcessingConfig): FormState {
  return {
    preset: c.preset,
    language: c.language,
    whisper_model: c.whisper_model,
    devices: { ...c.devices },
    summary_model: c.summary_model,
  };
}
```

- [ ] **Step 4: 카드에 요약 모델 표시**

`PresetRadio`의 마지막 `<span>`을 교체:

```tsx
      <span className="text-xs text-[color:var(--text-secondary)]">
        {meta.whisper_model} · {deviceSummary(meta.devices)}
      </span>
      <span className="text-xs text-[color:var(--text-muted)]">
        요약 {meta.summary_model}
      </span>
```

- [ ] **Step 5: selectPreset이 요약 모델도 따라가게 수정**

`selectPreset`을 교체:

```tsx
  const selectPreset = (name: PresetName) => {
    // 현재 서버 preset과 같은 카드를 고르면 서버 resolved 값을 시작값으로
    // 사용(진실원 우선), 다른 카드는 FE 표시 상수 사용 (리뷰 #6 최소 대응).
    const server = settings.data;
    const source =
      server && server.preset === name
        ? {
            whisper_model: server.whisper_model,
            devices: server.devices,
            summary_model: server.summary_model,
          }
        : PRESET_META[name];
    setForm({
      preset: name,
      language: form.language,
      whisper_model: source.whisper_model,
      devices: { ...source.devices },
      summary_model: source.summary_model,
    });
  };
```

- [ ] **Step 6: 고급 섹션에 select 추가**

전사(Whisper) 모델 select 블록 바로 아래에 같은 구조로 추가:

```tsx
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-[color:var(--text-secondary)]">
                요약(LLM) 모델
              </span>
              <Select
                value={form.summary_model}
                onValueChange={(v) =>
                  setKnob({ summary_model: v as SummaryModel })
                }
              >
                <SelectTrigger aria-label="요약 모델">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUMMARY_MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
```

- [ ] **Step 7: 저장 body에 포함**

`handleSave`의 custom 분기를 교체:

```tsx
    const body =
      form.preset === "custom"
        ? {
            preset: "custom" as const,
            language: form.language.trim(),
            whisper_model: form.whisper_model,
            devices: form.devices,
            summary_model: form.summary_model,
          }
        : { preset: form.preset, language: form.language.trim() };
```

- [ ] **Step 8: 테스트 통과 확인**

실행: `npx vitest run src/features/settings/ui/processing-settings-form.test.tsx`
기대: PASS

- [ ] **Step 9: 커밋**

```bash
git add src/features/settings/ui/processing-settings-form.tsx src/features/settings/ui/processing-settings-form.test.tsx
git commit -m "feat: 설정 화면에 요약 모델 표시 + 고급 선택"
```

---

### Task 3: 오버라이드 섹션 — 요약 모델 select

**Files:**
- Modify: `src/features/settings/ui/override-section.tsx`
- Test: `src/features/settings/ui/override-section.test.tsx`

**Interfaces:**
- Consumes: `ProcessingOverride.summary_model` (Task 1), `SUMMARY_MODEL_OPTIONS` (Task 1)
- Produces: `OverrideSection`이 `onChange({ preset?, summary_model? })`로 두 필드를 함께 실어 보낸다. 컴포넌트 props 시그니처는 불변.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/settings/ui/override-section.test.tsx`에 추가 (기존 렌더 헬퍼 재사용):

```tsx
  it("요약 모델만 고르면 그 값만 담긴 override를 올려보낸다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSection({ value: undefined, onChange });
    await user.click(screen.getByRole("button", { name: /이번 작업만 다른 설정/ }));
    await user.click(screen.getByLabelText("이번 작업 요약 모델"));
    await user.click(screen.getByRole("option", { name: /14B/ }));
    expect(onChange).toHaveBeenCalledWith({ summary_model: "qwen3.5:14b-mlx" });
  });

  it("프리셋 선택 뒤 요약 모델을 바꾸면 두 값이 함께 유지된다", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSection({ value: { preset: "light" }, onChange });
    await user.click(screen.getByLabelText("이번 작업 요약 모델"));
    await user.click(screen.getByRole("option", { name: /14B/ }));
    expect(onChange).toHaveBeenCalledWith({
      preset: "light",
      summary_model: "qwen3.5:14b-mlx",
    });
  });
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx vitest run src/features/settings/ui/override-section.test.tsx`
기대: FAIL — `이번 작업 요약 모델` 라벨 없음

- [ ] **Step 3: select 추가**

`src/features/settings/ui/override-section.tsx`의 import에 상수를 추가:

```tsx
import type { PresetName, ProcessingOverride, SummaryModel } from "../api/types";
import {
  deviceSummary,
  PRESET_META,
  PRESET_ORDER,
  SUMMARY_MODEL_OPTIONS,
} from "../lib/presets";
```

전역 표시 문구에 요약 모델을 덧붙이고:

```tsx
          <span className="text-xs text-[color:var(--text-muted)]">
            현재 전역:{" "}
            {global
              ? `${global.whisper_model} · ${deviceSummary(global.devices)} · 요약 ${global.summary_model}`
              : "불러오는 중…"}
          </span>
```

프리셋 Select의 `onValueChange`를 기존 값 보존형으로 바꾸고, 그 아래에 요약 모델 Select를 추가:

```tsx
          <Select
            value={value?.preset}
            onValueChange={(v) =>
              onChange({ ...value, preset: v as PresetName })
            }
          >
            <SelectTrigger aria-label="이번 작업 프리셋">
              <SelectValue placeholder="프리셋 선택" />
            </SelectTrigger>
            <SelectContent>
              {PRESET_ORDER.map((name) => (
                <SelectItem key={name} value={name}>
                  {PRESET_META[name].label} — {PRESET_META[name].whisper_model}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={value?.summary_model}
            onValueChange={(v) =>
              onChange({ ...value, summary_model: v as SummaryModel })
            }
          >
            <SelectTrigger aria-label="이번 작업 요약 모델">
              <SelectValue placeholder="요약 모델 (기본: 전역 설정)" />
            </SelectTrigger>
            <SelectContent>
              {SUMMARY_MODEL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
```

주석 블록의 "Phase 1은 프리셋 단위 오버라이드만 노출한다" 문장을 실제와 맞게 고친다:

```tsx
 * 노출 범위는 프리셋 + 요약 모델 두 노브다. 나머지 개별 노브(whisper/devices/
 * language)는 서버 계약상 가능하지만 UI에 두지 않는다 — 결과를 custom으로
 * 만들어 혼동 여지가 크다. 요약 모델은 예외로, "이번만 큰 모델로" 요구가
 * 명확해 노출한다(서버는 이 경우에도 결과를 custom으로 기록한다).
```

- [ ] **Step 4: 테스트 통과 확인**

실행: `npx vitest run src/features/settings/ui/override-section.test.tsx`
기대: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/features/settings/ui/override-section.tsx src/features/settings/ui/override-section.test.tsx
git commit -m "feat: job 오버라이드 섹션에 요약 모델 선택"
```

---

### Task 4: 요약 재생성 — 모델 선택 + 409 안내

**Files:**
- Modify: `src/features/meeting/api/meetings.ts:219-243`
- Modify: `src/features/meeting/ui/insight-pane.tsx:445-500`
- Modify: `src/pages/meeting.tsx:161,338`
- Test: `src/features/meeting/ui/insight-pane.test.tsx`

**Interfaces:**
- Consumes: `SummaryModel`, `SUMMARY_MODEL_OPTIONS` (Task 1), `ProcessingConfig.summary_model` (Task 1)
- Produces:
  - `useGenerateSummary()`의 `mutate` 인자 타입: `{ id: string; summary_model?: SummaryModel }`
  - `InsightPaneProps`에 `summaryModel: SummaryModel | undefined`, `onSummaryModelChange: (m: SummaryModel) => void` 추가. `onRegenerateSummary: () => void`는 그대로.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/features/meeting/ui/insight-pane.test.tsx`에 추가 (기존 렌더 헬퍼/목 회의 객체 재사용):

```tsx
  it("요약 탭에서 모델을 고르면 콜백이 불린다", async () => {
    const user = userEvent.setup();
    const onSummaryModelChange = vi.fn();
    renderPane({
      tab: "summary",
      summaryModel: "qwen3.5:8b-mlx",
      onSummaryModelChange,
    });
    await user.click(screen.getByLabelText("요약 모델"));
    await user.click(screen.getByRole("option", { name: /14B/ }));
    expect(onSummaryModelChange).toHaveBeenCalledWith("qwen3.5:14b-mlx");
  });
```

- [ ] **Step 2: 테스트 실패 확인**

실행: `npx vitest run src/features/meeting/ui/insight-pane.test.tsx`
기대: FAIL — `요약 모델` 라벨 없음

- [ ] **Step 3: mutation이 모델을 싣도록 수정**

`src/features/meeting/api/meetings.ts`의 `useGenerateSummary`를 교체:

```ts
/** 대화 요약 생성/재생성 (POST /meetings/:id/summary/generate). done에서만 허용(그 외 409). */
export function useGenerateSummary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; summary_model?: SummaryModel }) => {
      const { data } = await apiClient.post<{
        status: string;
        job_id: string | null;
        processing_version: number;
      }>(
        `/meetings/${vars.id}/summary/generate`,
        vars.summary_model ? { summary_model: vars.summary_model } : {},
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["meeting-status", vars.id] });
    },
    onError: (error) => {
      // 409 = 다른 모델로 이미 진행 중. 서버 문구가 진행 중 모델명을 담는다.
      toast({
        variant: "error",
        title:
          isApiError(error) && error.statusCode === 409
            ? "다른 모델로 요약이 진행 중이에요."
            : "요약을 만들지 못했어요.",
        description: isApiError(error) ? error.message : undefined,
      });
    },
  });
}
```

같은 파일 상단 import를 두 줄 고친다. 8행 `import { apiClient } from "@/shared/api/client";`에 `isApiError`를 더하고, 10행의 타입 import에 `SummaryModel`을 더한다:

```ts
import { apiClient, isApiError } from "@/shared/api/client";
```

```ts
import type {
  ProcessingOverride,
  SummaryModel,
} from "@/features/settings/api/types";
```

(`toast`는 9행에 이미 import되어 있다.)

- [ ] **Step 4: InsightPane에 select 추가**

`src/features/meeting/ui/insight-pane.tsx`의 `InsightPaneProps`에 두 필드를 추가하고 구조분해에도 넣는다:

```tsx
  onRegenerateSummary: () => void;
  summaryModel: SummaryModel | undefined;
  onSummaryModelChange: (model: SummaryModel) => void;
  regenerating: boolean;
```

파일 상단 import에 추가:

```tsx
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import type { SummaryModel } from "@/features/settings/api/types";
import { SUMMARY_MODEL_OPTIONS } from "@/features/settings/lib/presets";
```

요약 `TabsContent` 안에서 `<Attendees ... />` 바로 위에 모델 선택 줄을 넣는다:

```tsx
            <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
              <span className="text-xs text-[color:var(--text-muted)]">
                요약 모델
              </span>
              <Select
                value={summaryModel}
                onValueChange={(v) => onSummaryModelChange(v as SummaryModel)}
              >
                <SelectTrigger aria-label="요약 모델" className="h-7 text-xs">
                  <SelectValue placeholder="전역 설정" />
                </SelectTrigger>
                <SelectContent>
                  {SUMMARY_MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
```

- [ ] **Step 5: 페이지에 상태 연결**

`src/pages/meeting.tsx`에서 설정 훅과 로컬 상태를 추가한다. 161행 부근(`const generateSummary = useGenerateSummary();`) 아래:

```tsx
  const processingSettings = useProcessingSettings();
  const [summaryModel, setSummaryModel] = React.useState<SummaryModel | undefined>(undefined);
  // 선택 전 기본값은 전역 설정값 — 서버도 body가 없으면 같은 값을 쓴다.
  const effectiveSummaryModel =
    summaryModel ?? processingSettings.data?.summary_model;
```

338행의 prop 전달을 교체:

```tsx
          onRegenerateSummary={() =>
            generateSummary.mutate({
              id: meeting.id,
              summary_model: effectiveSummaryModel,
            })
          }
          summaryModel={effectiveSummaryModel}
          onSummaryModelChange={setSummaryModel}
```

import 추가:

```tsx
import { useProcessingSettings } from "@/features/settings/api/settings";
import type { SummaryModel } from "@/features/settings/api/types";
```

- [ ] **Step 6: 테스트 통과 확인**

실행: `npx vitest run src/features/meeting/ui/insight-pane.test.tsx src/pages/meeting.test.tsx`
기대: PASS. `meeting.test.tsx`에서 `/settings/processing` 요청 목이 없어 실패하면, 같은 파일의 기존 MSW 핸들러 목록에 `summary_model`을 포함한 `ProcessingConfig` 응답을 추가한다(517행 부근의 기존 목 객체 재사용).

- [ ] **Step 7: 전체 테스트 확인**

실행: `npm test && npx tsc --noEmit`
기대: PASS

- [ ] **Step 8: 커밋**

```bash
git add src/features/meeting/api/meetings.ts src/features/meeting/ui/insight-pane.tsx src/features/meeting/ui/insight-pane.test.tsx src/pages/meeting.tsx src/pages/meeting.test.tsx
git commit -m "feat: 요약 재생성에 모델 선택 + 409 안내"
```

---

## 최종 검증

- [ ] **전체 테스트**: `npm test` → PASS
- [ ] **타입 체크**: `npx tsc --noEmit` → 에러 없음
- [ ] **린트**: `npm run lint` → PASS
- [ ] **수동 확인 (BE 실행 필요)**:
  - 설정 화면에서 프리셋 카드에 요약 모델이 보인다
  - 고급에서 요약 모델만 바꾸면 "사용자 지정 설정" 문구가 뜨고 저장이 성공한다
  - 업로드 dialog의 "이번 작업만 다른 설정"에서 요약 모델을 고르면 서버가 `custom`으로 기록한다
  - 요약 진행 중에 다른 모델로 재생성을 누르면 409 토스트에 진행 중인 모델명이 보인다
- [ ] **드리프트 확인**: BE `src/contracts/model-catalog.ts`의 `SUMMARY_MODELS`와 `src/features/settings/api/types.ts`의 `SummaryModel`이 같은 값인지 대조한다. BE `PRESET_REVISION`과 `PRESET_META_REVISION`도 대조한다 — 다르면 설정 화면에 드리프트 배너가 뜬다.
