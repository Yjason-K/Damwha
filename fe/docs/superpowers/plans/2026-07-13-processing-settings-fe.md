# 처리 설정 FE (설정 화면 + job 오버라이드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자가 머신 스펙 기반 추천과 함께 전역 처리 설정(프리셋/whisper 모델/단계별 GPU)을 관리하고, 업로드·재처리 시 job 한정 오버라이드를 지정할 수 있는 UI.

**Architecture:** 새 `src/features/settings/` feature(api/lib/ui) + `/settings` 라우트. 서버가 진실원 — GET은 resolved 뷰, FE 프리셋 상수는 카드 요약 표시 전용. 오버라이드는 공용 `OverrideSection` 컴포넌트로 업로드 dialog와 신규 재처리 dialog가 공유. 재처리 UI(버튼+확인 dialog+mutation)는 이번에 신설.

**Tech Stack:** Vite 8 + React 19, TanStack Query + Axios(`apiClient`), Tailwind v4 + Timbre 토큰, vitest(jsdom) + testing-library.

**BE 계약 (구현 완료 — `../be` main `470ad76..871f45f`에 머지·push됨: settings/system 도메인, payload v2, 오버라이드 수용 전부 포함. FE 통합 시 be main 기준으로 서버 기동):**
- `GET /settings/processing` → `{ preset, preset_revision, language, whisper_model, devices: {diarization, stt} }` (resolved 뷰)
- `PUT /settings/processing` — named `{preset, language}` 또는 custom `{preset:'custom', language, whisper_model, devices}` (혼합 400, gpu 비적격 400)
- `GET /system/capabilities` → `{ platform, arch, chip, memory_gb, gpu_eligible, recommended_preset }`
- 업로드 multipart에 optional `processing` 필드(JSON **문자열**); 재처리 `POST /meetings/:id/reprocess` JSON body `{processing?}` → 202 `{meeting_id, processing_version, job_id}` (done/failed 아니면 409)
- 오버라이드: preset+개별 필드 혼합 허용, 개별 필드(language 포함) 하나라도 있으면 결과 preset은 custom

**FE 스펙 (be 레포 `docs/superpowers/specs/2026-07-13-processing-settings-design.md` §7):** 감지 스펙 카드 + 추천 배지, 프리셋 라디오 3개(권장 표시, 모델·디바이스 요약), 고급 펼침(수정 시 custom 전환), `gpu_eligible:false`면 gpu 토글 비활성 + 사유 툴팁 + 미지원 경고 배너, 저장 mutation+invalidate, 모델 다운로드 안내 문구, 업로드/재처리 dialog에 기본 접힌 오버라이드 섹션.

## Global Constraints

- Node 22 + **pnpm** (engine-strict). `nvm use 22 && pnpm ...`.
- TypeScript strict + `verbatimModuleSyntax` — 타입 import는 `import type`. Prettier(더블쿼트/세미콜론/trailing comma all) — 마무리 전 `pnpm format`.
- UI 카피·커밋 메시지 한국어. 서비스명 "Damwha", "Timbre"는 사용자 노출 금지.
- env 접근은 `@/shared/config/env`로만. API 호출은 `@/shared/api/client`의 `apiClient`로만.
- 시맨틱 토큰(`--surface-*`, `--text-*`)만 참조, raw 스케일 금지. 로딩은 `aria-busy`/`role="status"`.
- 테스트: vitest globals 없음(`test/expect/vi` 명시 import) + 수동 `afterEach(cleanup)`. HTTP는 `apiClient` 목킹(기존 `src/pages/meeting.test.tsx` 패턴).
- 새 heavy 라우트는 `router.tsx`의 `lazyRoute()` 경유.
- whisper enum: `tiny|base|small|medium|large-v3|large-v3-turbo`. 디바이스: `cpu|gpu`.
- 프리셋 정의(BE `src/settings/presets.ts`와 동기): light=small/diar gpu/stt cpu, standard=large-v3-turbo/gpu/gpu, quality=large-v3/gpu/gpu.
- 검증 명령: `pnpm test`, `pnpm build`(tsc -b가 타입 진실원), `pnpm lint`.

---

### Task 1: settings feature API 레이어

**Files:**
- Create: `src/features/settings/api/types.ts`
- Create: `src/features/settings/api/settings.ts`
- Test: `src/features/settings/api/settings.test.tsx`

**Interfaces:**
- Consumes: `apiClient` (`@/shared/api/client`).
- Produces (후속 태스크가 사용):
  - 타입: `PresetName`, `Device`, `WhisperModel`, `ProcessingConfig`, `ProcessingSettingsUpdate`, `ProcessingOverride`, `Capabilities`
  - 훅: `useProcessingSettings(): UseQueryResult<ProcessingConfig>` (queryKey `["processing-settings"]`)
  - `useUpdateProcessingSettings()` — PUT mutation, 성공 시 `["processing-settings"]` invalidate, resolved `ProcessingConfig` 반환
  - `useCapabilities(): UseQueryResult<Capabilities>` (queryKey `["capabilities"]`, `staleTime: Infinity` — 머신 스펙은 세션 중 불변)

- [ ] **Step 1: 타입 작성** — `src/features/settings/api/types.ts`:

```ts
/**
 * 처리 설정 와이어 타입 — be `GET/PUT /settings/processing`,
 * `GET /system/capabilities` 계약 (2026-07-13 processing-settings spec).
 */

export type PresetName = "light" | "standard" | "quality";
export type Device = "cpu" | "gpu";
export type WhisperModel =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large-v3"
  | "large-v3-turbo";

/** GET /settings/processing — 항상 resolved 뷰. */
export type ProcessingConfig = {
  preset: PresetName | "custom";
  preset_revision: string | null;
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
};

/** PUT /settings/processing — 이름 프리셋은 이름+언어만, custom은 전 필드. */
export type ProcessingSettingsUpdate =
  | { preset: PresetName; language: string }
  | {
      preset: "custom";
      language: string;
      whisper_model: WhisperModel;
      devices: { diarization: Device; stt: Device };
    };

/**
 * job 한정 오버라이드 — 업로드 multipart `processing` 필드(JSON 문자열) /
 * 재처리 body. 개별 필드(language 포함)가 하나라도 있으면 서버가 preset을
 * custom으로 기록한다.
 */
export type ProcessingOverride = {
  preset?: PresetName;
  whisper_model?: WhisperModel;
  devices?: { diarization?: Device; stt?: Device };
  language?: string;
};

/** GET /system/capabilities — gpu_eligible은 하드웨어 적합성만 의미. */
export type Capabilities = {
  platform: string;
  arch: string;
  chip: string | null;
  memory_gb: number;
  gpu_eligible: boolean;
  recommended_preset: PresetName | null;
};
```

- [ ] **Step 2: 실패 테스트** — `src/features/settings/api/settings.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import {
  useCapabilities,
  useProcessingSettings,
  useUpdateProcessingSettings,
} from "./settings";
import type { ProcessingConfig } from "./types";

afterEach(() => vi.restoreAllMocks());

const CONFIG: ProcessingConfig = {
  preset: "standard",
  preset_revision: "2026-07-13.1",
  language: "ko",
  whisper_model: "large-v3-turbo",
  devices: { diarization: "gpu", stt: "gpu" },
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

test("useProcessingSettings가 GET /settings/processing을 조회한다", async () => {
  const get = vi
    .spyOn(apiClient, "get")
    .mockResolvedValue({ data: CONFIG } as never);
  const { result } = renderHook(() => useProcessingSettings(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(get).toHaveBeenCalledWith("/settings/processing");
  expect(result.current.data?.whisper_model).toBe("large-v3-turbo");
});

test("useUpdateProcessingSettings가 PUT 후 설정 쿼리를 무효화한다", async () => {
  vi.spyOn(apiClient, "put").mockResolvedValue({ data: CONFIG } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const { result } = renderHook(() => useUpdateProcessingSettings(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  await result.current.mutateAsync({ preset: "light", language: "ko" });
  expect(apiClient.put).toHaveBeenCalledWith("/settings/processing", {
    preset: "light",
    language: "ko",
  });
  expect(invalidate).toHaveBeenCalledWith({
    queryKey: ["processing-settings"],
  });
});

test("useCapabilities가 GET /system/capabilities를 조회한다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      platform: "darwin",
      arch: "arm64",
      chip: "Apple M2 Pro",
      memory_gb: 32,
      gpu_eligible: true,
      recommended_preset: "standard",
    },
  } as never);
  const { result } = renderHook(() => useCapabilities(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.gpu_eligible).toBe(true);
});
```

- [ ] **Step 3: 실패 확인**

Run: `nvm use 22 && pnpm vitest run src/features/settings/api/settings.test.tsx`
Expected: FAIL (`./settings` 모듈 없음)

- [ ] **Step 4: 훅 구현** — `src/features/settings/api/settings.ts`:

```ts
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import type {
  Capabilities,
  ProcessingConfig,
  ProcessingSettingsUpdate,
} from "./types";

/** 전역 처리 설정 (서버 resolved 뷰). */
export function useProcessingSettings(): UseQueryResult<ProcessingConfig> {
  return useQuery({
    queryKey: ["processing-settings"],
    queryFn: async () => {
      const { data } = await apiClient.get<ProcessingConfig>(
        "/settings/processing",
      );
      return data;
    },
  });
}

/** 전역 처리 설정 변경 — 성공 시 설정 쿼리 무효화. */
export function useUpdateProcessingSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProcessingSettingsUpdate) => {
      const { data } = await apiClient.put<ProcessingConfig>(
        "/settings/processing",
        body,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["processing-settings"] });
    },
  });
}

/** 머신 스펙 감지 결과 — 세션 중 불변이라 staleTime Infinity. */
export function useCapabilities(): UseQueryResult<Capabilities> {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: async () => {
      const { data } = await apiClient.get<Capabilities>(
        "/system/capabilities",
      );
      return data;
    },
    staleTime: Infinity,
  });
}
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm vitest run src/features/settings/api/settings.test.tsx && pnpm build`
Expected: 3/3 PASS, tsc clean

```bash
git add src/features/settings/api/
git commit -m "feat: 처리 설정/스펙 감지 API 훅 (settings feature)"
```

---

### Task 2: 프리셋 표시 상수 + ProcessingSettingsForm

**Files:**
- Create: `src/features/settings/lib/presets.ts`
- Create: `src/features/settings/ui/processing-settings-form.tsx`
- Test: `src/features/settings/ui/processing-settings-form.test.tsx`

**Interfaces:**
- Consumes: Task 1의 훅/타입, `@/shared/ui/{button,input,select,switch,badge,tooltip}`, `toast`.
- Produces:
  - `PRESET_META: Record<PresetName, { label: string; desc: string; whisper_model: WhisperModel; devices: { diarization: Device; stt: Device } }>`
  - `WHISPER_MODEL_OPTIONS: { value: WhisperModel; label: string }[]`
  - `<ProcessingSettingsForm />` — props 없음(내부에서 훅 사용). Task 3 페이지가 렌더.

- [ ] **Step 1: 표시 상수** — `src/features/settings/lib/presets.ts`:

```ts
import type { Device, PresetName, WhisperModel } from "../api/types";

/**
 * 프리셋 카드 표시용 메타 — 값의 진실원은 BE(`be/src/settings/presets.ts`,
 * PRESET_REVISION 2026-07-13.1). 여기 값은 카드 요약 표시 전용이며, 저장 시엔
 * 프리셋 이름만 보내고 서버가 resolve한다. BE 프리셋 변경 시 함께 갱신할 것.
 */
export const PRESET_META: Record<
  PresetName,
  {
    label: string;
    desc: string;
    whisper_model: WhisperModel;
    devices: { diarization: Device; stt: Device };
  }
> = {
  light: {
    label: "가볍게",
    desc: "8GB 램에 알맞아요",
    whisper_model: "small",
    devices: { diarization: "gpu", stt: "cpu" },
  },
  standard: {
    label: "표준",
    desc: "16–32GB 램에 알맞아요",
    whisper_model: "large-v3-turbo",
    devices: { diarization: "gpu", stt: "gpu" },
  },
  quality: {
    label: "고품질",
    desc: "64GB+ 램에 알맞아요",
    whisper_model: "large-v3",
    devices: { diarization: "gpu", stt: "gpu" },
  },
};

export const PRESET_ORDER: PresetName[] = ["light", "standard", "quality"];

/**
 * PRESET_META가 반영한 BE 프리셋 정의 revision. GET 응답의 preset_revision과
 * 다르면 서버 프리셋이 갱신된 것 — 카드 요약이 실제와 다를 수 있음을 UI에
 * 알린다 (드리프트 감지; 리뷰 #6).
 */
export const PRESET_META_REVISION = "2026-07-13.1";

export const WHISPER_MODEL_OPTIONS: { value: WhisperModel; label: string }[] = [
  { value: "tiny", label: "tiny — 가장 빠름, 낮은 정확도" },
  { value: "base", label: "base" },
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
  { value: "large-v3-turbo", label: "large-v3-turbo — 권장 균형" },
  { value: "large-v3", label: "large-v3 — 가장 정확, 느림" },
];

/** 디바이스 요약 문자열 — 카드/고급 요약에 사용. */
export function deviceSummary(devices: {
  diarization: Device;
  stt: Device;
}): string {
  return `화자 분리 ${devices.diarization.toUpperCase()} · 전사 ${devices.stt.toUpperCase()}`;
}
```

- [ ] **Step 2: 실패 테스트** — `src/features/settings/ui/processing-settings-form.test.tsx`:

```tsx
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { Capabilities, ProcessingConfig } from "../api/types";
import { ProcessingSettingsForm } from "./processing-settings-form";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CONFIG: ProcessingConfig = {
  preset: "standard",
  preset_revision: "2026-07-13.1",
  language: "ko",
  whisper_model: "large-v3-turbo",
  devices: { diarization: "gpu", stt: "gpu" },
};

const CAPS: Capabilities = {
  platform: "darwin",
  arch: "arm64",
  chip: "Apple M2 Pro",
  memory_gb: 32,
  gpu_eligible: true,
  recommended_preset: "standard",
};

function mockApi(config = CONFIG, caps = CAPS) {
  vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
    if (url === "/settings/processing") return { data: config } as never;
    if (url === "/system/capabilities") return { data: caps } as never;
    throw new Error(`unexpected GET ${url}`);
  });
}

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProcessingSettingsForm />
    </QueryClientProvider>,
  );
}

test("현재 프리셋이 선택되고 추천 프리셋에 권장 배지가 붙는다", async () => {
  mockApi();
  renderForm();
  const standard = await screen.findByRole("radio", { name: /표준/ });
  expect(standard.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("권장")).toBeTruthy();
});

test("고급에서 모델을 바꾸면 custom으로 전환되고 저장 시 전 필드를 보낸다", async () => {
  mockApi();
  const put = vi
    .spyOn(apiClient, "put")
    .mockResolvedValue({ data: { ...CONFIG, preset: "custom" } } as never);
  renderForm();
  await screen.findByRole("radio", { name: /표준/ });

  fireEvent.click(screen.getByRole("button", { name: /고급 설정/ }));
  // 전사(STT) GPU 스위치를 끈다 → custom 전환
  fireEvent.click(screen.getByRole("switch", { name: /전사.*GPU/ }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));

  await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  expect(put).toHaveBeenCalledWith("/settings/processing", {
    preset: "custom",
    language: "ko",
    whisper_model: "large-v3-turbo",
    devices: { diarization: "gpu", stt: "cpu" },
  });
});

test("이름 프리셋 저장은 이름+언어만 보낸다", async () => {
  mockApi();
  const put = vi
    .spyOn(apiClient, "put")
    .mockResolvedValue({ data: CONFIG } as never);
  renderForm();
  fireEvent.click(await screen.findByRole("radio", { name: /가볍게/ }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/settings/processing", {
      preset: "light",
      language: "ko",
    }),
  );
});

test("gpu_eligible=false: 프리셋 카드 비활성 + 경고, gpu→cpu 끄기는 허용", async () => {
  // 현재 값이 gpu/gpu인 custom 설정 — 비지원 환경에서도 CPU로 끌 수 있어야 함
  mockApi(
    { ...CONFIG, preset: "custom", preset_revision: null },
    {
      ...CAPS,
      platform: "linux",
      arch: "x64",
      gpu_eligible: false,
      recommended_preset: null,
    },
  );
  renderForm();
  const standard = await screen.findByRole("radio", { name: /표준/ });
  // 모든 프리셋 카드 비활성 (전 프리셋이 diar gpu 포함 → 저장 시 400 예방)
  expect((standard as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/지원하지 않는 환경/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /고급 설정/ }));
  const sttSwitch = screen.getByRole("switch", {
    name: /전사.*GPU/,
  }) as HTMLInputElement;
  // 현재 gpu → 끄기 허용 (비대칭 규칙)
  expect(sttSwitch.disabled).toBe(false);
  fireEvent.click(sttSwitch);
  // cpu가 된 뒤에는 다시 켜기 차단
  expect(
    (screen.getByRole("switch", { name: /전사.*GPU/ }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
});

test("capabilities 로딩 전에는 프리셋 카드가 비활성이다 (보수적 기본값)", async () => {
  // capabilities만 pending으로 유지
  vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
    if (url === "/settings/processing") return { data: CONFIG } as never;
    return new Promise(() => {}) as never; // capabilities 영구 pending
  });
  renderForm();
  const standard = await screen.findByRole("radio", { name: /표준/ });
  expect((standard as HTMLButtonElement).disabled).toBe(true);
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm vitest run src/features/settings/ui/processing-settings-form.test.tsx`
Expected: FAIL (컴포넌트 없음)

- [ ] **Step 4: 폼 구현** — `src/features/settings/ui/processing-settings-form.tsx`:

```tsx
import * as React from "react";

import { isApiError } from "@/shared/api/client";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Switch } from "@/shared/ui/switch";
import { toast } from "@/shared/ui/use-toast";
import { cn } from "@/shared/lib/utils";

import {
  useCapabilities,
  useProcessingSettings,
  useUpdateProcessingSettings,
} from "../api/settings";
import type {
  Device,
  PresetName,
  ProcessingConfig,
  WhisperModel,
} from "../api/types";
import {
  deviceSummary,
  PRESET_META,
  PRESET_ORDER,
  WHISPER_MODEL_OPTIONS,
} from "../lib/presets";

/**
 * ProcessingSettingsForm — 전역 처리 설정 편집. 프리셋 라디오(권장 배지) +
 * 고급 펼침(whisper 모델/단계별 GPU). 고급 값 수정 시 custom 전환, 이름
 * 프리셋 저장은 이름+언어만 전송(서버가 resolve).
 */

type FormState = {
  preset: PresetName | "custom";
  language: string;
  whisper_model: WhisperModel;
  devices: { diarization: Device; stt: Device };
};

function fromConfig(c: ProcessingConfig): FormState {
  return {
    preset: c.preset,
    language: c.language,
    whisper_model: c.whisper_model,
    devices: { ...c.devices },
  };
}

function PresetRadio({
  name,
  checked,
  recommended,
  disabled,
  onSelect,
}: {
  name: PresetName;
  checked: boolean;
  recommended: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const meta = PRESET_META[name];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      title={
        disabled
          ? "모든 프리셋은 GPU를 사용해요 — 이 머신에서는 선택할 수 없어요"
          : undefined
      }
      onClick={onSelect}
      className={cn(
        "flex flex-1 flex-col gap-1 rounded-md border p-3 text-left outline-none transition-colors duration-[80ms] focus-visible:[box-shadow:var(--focus-ring)]",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer",
        checked
          ? "border-[color:var(--accent-6)] bg-[var(--accent-1)]"
          : "border-border hover:bg-[var(--surface-hover)]",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {meta.label}
        {recommended && <Badge variant="info">권장</Badge>}
      </span>
      <span className="text-xs text-[color:var(--text-muted)]">
        {meta.desc}
      </span>
      <span className="text-xs text-[color:var(--text-secondary)]">
        {meta.whisper_model} · {deviceSummary(meta.devices)}
      </span>
    </button>
  );
}

export function ProcessingSettingsForm() {
  const settings = useProcessingSettings();
  const capabilities = useCapabilities();
  const update = useUpdateProcessingSettings();

  const [form, setForm] = React.useState<FormState | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  // 서버 값 도착/갱신 시 폼 초기화 (편집 중이 아닐 때만 덮지 않도록
  // 최초 1회만 세팅; 저장 성공 시 mutation 응답으로 다시 동기화).
  React.useEffect(() => {
    if (settings.data && form === null) setForm(fromConfig(settings.data));
  }, [settings.data, form]);

  if (settings.isLoading || form === null) {
    return (
      <p role="status" className="text-sm text-[color:var(--text-muted)]">
        설정을 불러오는 중…
      </p>
    );
  }
  if (settings.isError) {
    return (
      <p className="text-sm text-[color:var(--red-text)]">
        설정을 불러오지 못했어요.
      </p>
    );
  }

  const caps = capabilities.data;
  // 보수적 기본값(리뷰 #3): 조회 전/실패 시 GPU 불허 — 로딩 중엔 GPU 관련
  // 컨트롤(프리셋 카드 + GPU 스위치)을 잠시 비활성화한다.
  const capsReady = capabilities.isSuccess;
  const gpuEligible = caps?.gpu_eligible === true;
  const presetsDisabled = !capsReady || !gpuEligible; // 모든 프리셋이 diar gpu 포함
  // GPU 스위치 비대칭 규칙(리뷰 #4): 켜기(cpu→gpu)는 비적격 시 차단하되,
  // 이미 gpu인 기존 값을 cpu로 끄는 것은 항상 허용 (옮겨온 DB 등 복구 경로).
  const gpuSwitchDisabled = (current: Device) =>
    !capsReady || (!gpuEligible && current === "cpu");

  const selectPreset = (name: PresetName) => {
    // 현재 서버 preset과 같은 카드를 고르면 서버 resolved 값을 시작값으로
    // 사용(진실원 우선), 다른 카드는 FE 표시 상수 사용 (리뷰 #6 최소 대응).
    const server = settings.data;
    const source =
      server && server.preset === name
        ? { whisper_model: server.whisper_model, devices: server.devices }
        : PRESET_META[name];
    setForm({
      preset: name,
      language: form.language,
      whisper_model: source.whisper_model,
      devices: { ...source.devices },
    });
  };

  const setKnob = (patch: Partial<Omit<FormState, "preset">>) => {
    setForm({ ...form, ...patch, preset: "custom" });
  };

  const handleSave = () => {
    const body =
      form.preset === "custom"
        ? {
            preset: "custom" as const,
            language: form.language.trim(),
            whisper_model: form.whisper_model,
            devices: form.devices,
          }
        : { preset: form.preset, language: form.language.trim() };
    update.mutate(body, {
      onSuccess: (resolved) => {
        setForm(fromConfig(resolved));
        toast({ variant: "success", title: "처리 설정을 저장했어요." });
      },
      onError: (error) => {
        toast({
          variant: "error",
          title: "저장에 실패했어요.",
          description: isApiError(error) ? error.message : undefined,
        });
      },
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {capsReady && !gpuEligible && (
        <p className="rounded-md border border-[color:var(--border-subtle)] bg-[var(--surface-hover)] px-3 py-2 text-sm text-[color:var(--text-secondary)]">
          Damwha가 지원하지 않는 환경이에요 (Apple Silicon Mac 전용). 모든
          프리셋은 GPU를 사용하므로 선택할 수 없고, custom CPU 설정만 편집할
          수 있어요.
        </p>
      )}
      {settings.data &&
        settings.data.preset !== "custom" &&
        settings.data.preset_revision !== null &&
        settings.data.preset_revision !== PRESET_META_REVISION && (
          <p className="text-xs text-[color:var(--text-muted)]">
            서버 프리셋 정의가 업데이트됐어요 — 카드 요약이 실제 값과 다를 수
            있어요. 저장은 항상 서버 기준으로 적용돼요.
          </p>
        )}

      <div role="radiogroup" aria-label="처리 프리셋" className="flex gap-2.5">
        {PRESET_ORDER.map((name) => (
          <PresetRadio
            key={name}
            name={name}
            checked={form.preset === name}
            recommended={caps?.recommended_preset === name}
            disabled={presetsDisabled}
            onSelect={() => selectPreset(name)}
          />
        ))}
      </div>
      {form.preset === "custom" && (
        <p className="text-xs text-[color:var(--text-muted)]">
          사용자 지정 설정을 쓰고 있어요. 프리셋을 누르면 해당 값으로
          되돌아가요.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
          className="self-start text-sm font-medium text-[color:var(--accent-text)] outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        >
          고급 설정 {advancedOpen ? "접기" : "펼치기"}
        </button>

        {advancedOpen && (
          <div className="flex flex-col gap-4 rounded-md border border-[color:var(--border-subtle)] p-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-[color:var(--text-secondary)]">
                전사(Whisper) 모델
              </span>
              <Select
                value={form.whisper_model}
                onValueChange={(v) =>
                  setKnob({ whisper_model: v as WhisperModel })
                }
              >
                <SelectTrigger aria-label="전사 모델">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHISPER_MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Switch
              label="화자 분리 GPU 사용"
              checked={form.devices.diarization === "gpu"}
              disabled={gpuSwitchDisabled(form.devices.diarization)}
              title={
                gpuEligible ? undefined : "이 머신에서는 GPU를 켤 수 없어요"
              }
              onChange={(e) =>
                setKnob({
                  devices: {
                    ...form.devices,
                    diarization: e.target.checked ? "gpu" : "cpu",
                  },
                })
              }
            />
            <Switch
              label="전사 GPU 사용"
              checked={form.devices.stt === "gpu"}
              disabled={gpuSwitchDisabled(form.devices.stt)}
              title={
                gpuEligible ? undefined : "이 머신에서는 GPU를 켤 수 없어요"
              }
              onChange={(e) =>
                setKnob({
                  devices: {
                    ...form.devices,
                    stt: e.target.checked ? "gpu" : "cpu",
                  },
                })
              }
            />

            <Input
              label="전사 언어"
              value={form.language}
              onChange={(e) => setKnob({ language: e.target.value })}
            />
          </div>
        )}
      </div>

      <p className="text-xs text-[color:var(--text-faint)]">
        새 모델을 처음 선택하면 첫 처리에서 모델 다운로드로 시간이 오래 걸릴
        수 있어요.
      </p>

      <div>
        <Button
          onClick={handleSave}
          loading={update.isPending}
          disabled={update.isPending || !form.language.trim()}
        >
          저장
        </Button>
      </div>
    </div>
  );
}
```

구현 노트: `Switch`는 네이티브 checkbox 기반(`role="switch"`) — `checked`/`onChange`/`disabled` 그대로. `Badge` variant 이름은 `badge.tsx`에서 확인해 존재하는 것(`info` 없으면 `default`/`accent` 등)으로 조정. `Button` `loading` prop은 `button.tsx`에서 확인(기존 upload-dialog가 사용 중이므로 존재).

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm vitest run src/features/settings/ui/processing-settings-form.test.tsx && pnpm build && pnpm lint`
Expected: 4/4 PASS, tsc/lint clean

```bash
git add src/features/settings/
git commit -m "feat: 처리 설정 폼 — 프리셋 라디오 + 고급(custom 전환) + gpu 비적격 처리"
```

---

### Task 3: 설정 페이지 + 라우트 + LeftNav 진입점

**Files:**
- Create: `src/pages/settings.tsx`
- Modify: `src/app/router.tsx` (lazyRoute `/settings`)
- Modify: `src/features/meeting/ui/left-nav.tsx` (설정 SidebarItem)
- Test: `src/pages/settings.test.tsx`

**Interfaces:**
- Consumes: Task 1 `useCapabilities`, Task 2 `<ProcessingSettingsForm/>`, `Icon`(`settings` 아이콘 기존 존재), `SidebarItem asChild + <Link/>` 패턴(화자 관리 항목과 동일).
- Produces: `SettingsPage` (named export — 기존 페이지들과 동일 컨벤션), 라우트 `/settings`.

- [ ] **Step 1: 실패 테스트** — `src/pages/settings.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { SettingsPage } from "./settings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("설정 페이지가 감지 스펙 카드와 처리 설정 폼을 렌더한다", async () => {
  vi.spyOn(apiClient, "get").mockImplementation(async (url) => {
    if (url === "/system/capabilities")
      return {
        data: {
          platform: "darwin",
          arch: "arm64",
          chip: "Apple M2 Pro",
          memory_gb: 32,
          gpu_eligible: true,
          recommended_preset: "standard",
        },
      } as never;
    if (url === "/settings/processing")
      return {
        data: {
          preset: "standard",
          preset_revision: "2026-07-13.1",
          language: "ko",
          whisper_model: "large-v3-turbo",
          devices: { diarization: "gpu", stt: "gpu" },
        },
      } as never;
    throw new Error(`unexpected GET ${url}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Apple M2 Pro")).toBeTruthy();
  expect(screen.getByText(/32\s*GB/)).toBeTruthy();
  expect(await screen.findByRole("radio", { name: /표준/ })).toBeTruthy();
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/pages/settings.test.tsx`
Expected: FAIL (페이지 없음)

- [ ] **Step 3: 페이지 구현** — `src/pages/settings.tsx`:

페이지 셸(상단바/뒤로 가기 링크 구조)은 `src/pages/speakers.tsx`를 열어 동일 패턴을 따른다 — 아래는 콘텐츠 골격:

```tsx
import { Link } from "react-router";

import { Card } from "@/shared/ui/card";
import { useCapabilities } from "@/features/settings/api/settings";
import { ProcessingSettingsForm } from "@/features/settings/ui/processing-settings-form";

/** /settings — 처리 설정. 감지 스펙 카드 + 전역 처리 설정 폼. */
export function SettingsPage() {
  const { data: caps } = useCapabilities();
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-col gap-1">
        <Link
          to="/app"
          className="self-start text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
        >
          ← 회의로 돌아가기
        </Link>
        <h1 className="text-h1 font-semibold text-foreground">처리 설정</h1>
        <p className="text-sm text-[color:var(--text-muted)]">
          이 머신 성능에 맞춰 회의 처리 방식(모델·GPU)을 고를 수 있어요.
        </p>
      </header>

      <Card className="flex flex-col gap-1 p-4">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">
          내 머신
        </span>
        {caps ? (
          <>
            <span className="text-base text-foreground">
              {caps.chip ?? `${caps.platform} / ${caps.arch}`}
            </span>
            <span className="text-sm text-[color:var(--text-muted)]">
              메모리 {caps.memory_gb} GB
              {caps.recommended_preset
                ? ` · 추천 프리셋: ${caps.recommended_preset}`
                : ""}
            </span>
          </>
        ) : (
          <span role="status" className="text-sm text-[color:var(--text-muted)]">
            스펙을 확인하는 중…
          </span>
        )}
      </Card>

      <ProcessingSettingsForm />
    </div>
  );
}
```

(`Card` API는 `src/shared/ui/card.tsx` 확인 — 서브컴포넌트 구조면 그에 맞게 조정. speakers 페이지가 쓰는 페이지 골격이 다르면 그쪽 우선.)

- [ ] **Step 4: 라우트 + 진입점**

`src/app/router.tsx` — `/speakers` 라우트 아래에:

```tsx
  {
    path: "/settings",
    element: lazyRoute(() =>
      import("@/pages/settings").then((m) => ({ default: m.SettingsPage })),
    ),
  },
```

`lazyRoute`는 default export 컴포넌트를 기대하므로 위처럼 named→default 매핑 (기존 `/app`, `/speakers` 라우트와 동일 패턴).

`src/features/meeting/ui/left-nav.tsx` — "화자 관리" SidebarItem 바로 아래에:

```tsx
          <SidebarItem
            icon={<Icon name="settings" size={16} />}
            label="처리 설정"
            asChild
          >
            <Link to="/settings" />
          </SidebarItem>
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm vitest run src/pages/settings.test.tsx && pnpm test && pnpm build && pnpm lint`
Expected: 전체 PASS

```bash
git add src/pages/settings.tsx src/pages/settings.test.tsx src/app/router.tsx src/features/meeting/ui/left-nav.tsx
git commit -m "feat: /settings 라우트 — 감지 스펙 카드 + 처리 설정, LeftNav 진입점"
```

---

### Task 4: OverrideSection + 업로드 오버라이드

**Files:**
- Create: `src/features/settings/ui/override-section.tsx`
- Modify: `src/features/meeting/api/meetings.ts` (`useUploadMeeting`에 `processing` 추가)
- Modify: `src/features/meeting/ui/upload-dialog.tsx`
- Test: `src/features/settings/ui/override-section.test.tsx`, `src/features/meeting/ui/upload-dialog.test.tsx` (신규)

**Interfaces:**
- Consumes: Task 1 타입/`useProcessingSettings`, Task 2 `PRESET_META`/`WHISPER_MODEL_OPTIONS`.
- Produces:
  - `<OverrideSection value={ProcessingOverride | undefined} onChange={(v: ProcessingOverride | undefined) => void} />` — 기본 접힘 disclosure. Task 5 재처리 dialog도 재사용.
  - `useUploadMeeting` vars에 `processing?: ProcessingOverride` — 있으면 `form.append("processing", JSON.stringify(vars.processing))`.

- [ ] **Step 1: 실패 테스트** — `src/features/settings/ui/override-section.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import type { ProcessingOverride } from "../api/types";
import { OverrideSection } from "./override-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSection(
  value: ProcessingOverride | undefined,
  onChange: (v: ProcessingOverride | undefined) => void,
) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: "2026-07-13.1",
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OverrideSection value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
}

test("기본 접힘 — 토글하면 프리셋 선택이 보인다", () => {
  renderSection(undefined, () => {});
  expect(screen.queryByLabelText("이번 작업 프리셋")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  expect(screen.getByLabelText("이번 작업 프리셋")).toBeTruthy();
});

test("프리셋을 고르면 onChange에 override가 전달된다", async () => {
  const onChange = vi.fn();
  renderSection(undefined, onChange);
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  // Radix Select는 jsdom에서 mousedown으로 연다 (fe-arch §6 규약)
  fireEvent.mouseDown(screen.getByLabelText("이번 작업 프리셋"));
  fireEvent.click(await screen.findByRole("option", { name: /고품질/ }));
  expect(onChange).toHaveBeenCalledWith({ preset: "quality" });
});

test("섹션을 닫으면 override가 해제된다", () => {
  const onChange = vi.fn();
  renderSection({ preset: "quality" }, onChange);
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  expect(onChange).toHaveBeenCalledWith(undefined);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/settings/ui/override-section.test.tsx`
Expected: FAIL

- [ ] **Step 3: OverrideSection 구현** — `src/features/settings/ui/override-section.tsx`:

```tsx
import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

import { useProcessingSettings } from "../api/settings";
import type { PresetName, ProcessingOverride } from "../api/types";
import { deviceSummary, PRESET_META, PRESET_ORDER } from "../lib/presets";

/**
 * OverrideSection — "이번 작업만 다른 설정" 접힌 섹션. 업로드/재처리
 * dialog 공용. 열림 + 프리셋 선택 → onChange(override); 닫으면
 * onChange(undefined) (전역 설정 사용). Phase 1은 프리셋 단위 오버라이드만
 * 노출한다 — 개별 노브 오버라이드는 서버 계약상 가능하지만 UI는 프리셋
 * 선택으로 단순화(개별 필드는 결과를 custom으로 만들어 혼동 여지가 큼).
 */

type OverrideSectionProps = {
  value: ProcessingOverride | undefined;
  onChange: (value: ProcessingOverride | undefined) => void;
};

export function OverrideSection({ value, onChange }: OverrideSectionProps) {
  const [open, setOpen] = React.useState(value !== undefined);
  const { data: global } = useProcessingSettings();

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next) onChange(undefined);
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="self-start text-sm font-medium text-[color:var(--accent-text)] outline-none focus-visible:[box-shadow:var(--focus-ring)]"
      >
        이번 작업만 다른 설정 {open ? "사용 안 함" : "사용"}
      </button>

      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-[color:var(--border-subtle)] p-3">
          <span className="text-xs text-[color:var(--text-muted)]">
            현재 전역:{" "}
            {global
              ? `${global.whisper_model} · ${deviceSummary(global.devices)}`
              : "불러오는 중…"}
          </span>
          <Select
            value={value?.preset ?? ""}
            onValueChange={(v) => onChange({ preset: v as PresetName })}
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
          <span className="text-2xs text-[color:var(--text-faint)]">
            이 설정은 저장되지 않고 이번 작업에만 적용돼요.
          </span>
        </div>
      )}
    </div>
  );
}
```

설계 결정 — **사용자가 승인한 제품 범위 변경 (2026-07-13)**: 오버라이드 UI는 **프리셋 선택만** 노출한다 (스펙 §7 원문 "프리셋 + 고급"의 의도적 축소). 서버 계약은 개별 필드 혼합을 그대로 지원하지만(고급 사용자는 API 직접 호출 가능), 개별 필드는 결과를 custom으로 바꿔 "light에 언어만" 류 혼동(스펙 §5 경고)이 생김. FE CLAUDE.md 델타(Task 6)에 이 결정을 기록한다. (리뷰어: 이 축소는 사용자가 명시 승인한 결정이다 — 스펙 §7 대비 축소를 결함으로 보고하지 말 것.)

**OverrideSection open 상태 동기화(리뷰 #5):** 부모가 `value`를 `undefined`로 리셋하면 섹션도 닫혀야 한다. 구현에 아래 effect 포함 (Radix DialogContent가 close 시 unmount되는 것과 무관하게 안전):

```tsx
  // 부모 reset(value → undefined) 시 섹션 닫힘 동기화. 사용자가 섹션만 열고
  // 아직 선택 전인 상태(open && value undefined)는 value 변화가 없어 영향 없음.
  React.useEffect(() => {
    if (value === undefined) setOpen(false);
  }, [value]);
```

`override-section.test.tsx`에 케이스 추가:

```tsx
test("부모가 value를 리셋하면 섹션이 닫힌다", () => {
  const { rerender } = renderSection({ preset: "quality" }, () => {});
  expect(screen.getByLabelText("이번 작업 프리셋")).toBeTruthy();
  rerender(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <OverrideSection value={undefined} onChange={() => {}} />
    </QueryClientProvider>,
  );
  expect(screen.queryByLabelText("이번 작업 프리셋")).toBeNull();
});
```

(renderSection이 rerender를 지원하도록 helper 반환값 활용 — wrapper 구조는 구현 시 맞춤.)

- [ ] **Step 4: 업로드 연결**

`src/features/meeting/api/meetings.ts` — `useUploadMeeting` vars에 `processing`:

```ts
import type { ProcessingOverride } from "@/features/settings/api/types";
// ...
    mutationFn: async (vars: {
      file: File;
      title?: string;
      recordedAt?: string;
      processing?: ProcessingOverride;
    }) => {
      const form = new FormData();
      form.append("audio", vars.file);
      if (vars.title) form.append("title", vars.title);
      if (vars.recordedAt) form.append("recorded_at", vars.recordedAt);
      if (vars.processing)
        form.append("processing", JSON.stringify(vars.processing));
      // (이하 동일)
```

`src/features/meeting/ui/upload-dialog.tsx`:
- state 추가: `const [processing, setProcessing] = React.useState<ProcessingOverride | undefined>(undefined);` (`import type { ProcessingOverride } from "@/features/settings/api/types";`, `import { OverrideSection } from "@/features/settings/ui/override-section";`)
- `resetForm()`에 `setProcessing(undefined);` 추가
- `upload.mutate({...})`에 `processing,` 추가
- 폼에서 녹음 일시 `<Input/>` 아래, `<DialogFooter>` 위에 `<OverrideSection value={processing} onChange={setProcessing} />`

**신규 테스트** `src/features/meeting/ui/upload-dialog.test.tsx`:

```tsx
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { UploadDialog } from "./upload-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WIRE_MEETING = {
  id: "m1",
  title: null,
  original_filename: "a.m4a",
  audio_key: "meetings/m1/original.m4a",
  normalized_key: null,
  recorded_at: null,
  duration_ms: null,
  status: "uploaded",
  is_favorite: false,
  current_job_id: "job_1",
  processing_version: 0,
  error: null,
  created_at: new Date().toISOString(),
};

test("오버라이드 프리셋 선택 시 multipart에 processing JSON이 실린다", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: null,
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  const post = vi
    .spyOn(apiClient, "post")
    .mockResolvedValue({ data: WIRE_MEETING } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UploadDialog open onOpenChange={() => {}} onUploaded={() => {}} />
    </QueryClientProvider>,
  );

  const fileInput = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(fileInput, {
    target: { files: [new File(["a"], "a.m4a", { type: "audio/mp4" })] },
  });

  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  fireEvent.mouseDown(screen.getByLabelText("이번 작업 프리셋"));
  fireEvent.click(await screen.findByRole("option", { name: /가볍게/ }));

  fireEvent.click(screen.getByRole("button", { name: "업로드" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const form = post.mock.calls[0][1] as FormData;
  expect(form.get("processing")).toBe(JSON.stringify({ preset: "light" }));
});
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `pnpm vitest run src/features/settings/ui/override-section.test.tsx src/features/meeting/ui/upload-dialog.test.tsx && pnpm test && pnpm build && pnpm lint`
Expected: 전체 PASS (기존 meeting.test.tsx 업로드 흐름 회귀 없음 확인)

```bash
git add src/features/settings/ui/override-section.tsx src/features/settings/ui/override-section.test.tsx src/features/meeting/
git commit -m "feat: 업로드 dialog에 job 한정 처리 오버라이드 섹션"
```

---

### Task 5: 재처리 — mutation + 확인 dialog + 진입점

**Files:**
- Modify: `src/features/meeting/api/meetings.ts` (`useReprocessMeeting` 추가)
- Create: `src/features/meeting/ui/reprocess-dialog.tsx`
- Modify: `src/features/meeting/ui/transcript-pane.tsx` (헤더 액션에 재처리 IconButton)
- Test: `src/features/meeting/ui/reprocess-dialog.test.tsx`

**Interfaces:**
- Consumes: Task 4 `OverrideSection`, `ProcessingOverride`; 기존 `Dialog`/`Button`/`IconButton`/`toast`/`Icon`(`rotateCcw` 기존 존재).
- Produces: `useReprocessMeeting()` — `mutate({ id, processing? })`, 성공 시 `["meeting", id]`/`["meetings"]`/`["meeting-status", id]` invalidate. `<ReprocessDialog open onOpenChange meeting={{id, title, status}} />`.

- [ ] **Step 1: mutation** — `src/features/meeting/api/meetings.ts`에 추가:

```ts
/** 재처리 (POST /meetings/:id/reprocess). done/failed에서만 허용(그 외 409). */
export function useReprocessMeeting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      processing?: ProcessingOverride;
    }) => {
      const { data } = await apiClient.post<{
        meeting_id: string;
        processing_version: number;
        job_id: string;
      }>(
        `/meetings/${vars.id}/reprocess`,
        vars.processing ? { processing: vars.processing } : {},
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["meeting", vars.id] });
      queryClient.invalidateQueries({ queryKey: ["meetings"] });
      queryClient.invalidateQueries({ queryKey: ["meeting-status", vars.id] });
    },
  });
}
```

- [ ] **Step 2: 실패 테스트** — `src/features/meeting/ui/reprocess-dialog.test.tsx`:

```tsx
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { ReprocessDialog } from "./reprocess-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(post = vi.fn()) {
  vi.spyOn(apiClient, "get").mockResolvedValue({
    data: {
      preset: "standard",
      preset_revision: null,
      language: "ko",
      whisper_model: "large-v3-turbo",
      devices: { diarization: "gpu", stt: "gpu" },
    },
  } as never);
  vi.spyOn(apiClient, "post").mockImplementation(post as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ReprocessDialog
        open
        onOpenChange={() => {}}
        meeting={{ id: "m1", title: "주간 회의" }}
      />
    </QueryClientProvider>,
  );
  return post;
}

test("확인 시 POST /meetings/:id/reprocess 호출 (오버라이드 없으면 빈 body)", async () => {
  const post = setup(
    vi.fn().mockResolvedValue({
      data: { meeting_id: "m1", processing_version: 1, job_id: "job_2" },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "재처리 시작" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post).toHaveBeenCalledWith("/meetings/m1/reprocess", {});
});

test("오버라이드 선택 시 body에 processing이 실린다", async () => {
  const post = setup(
    vi.fn().mockResolvedValue({
      data: { meeting_id: "m1", processing_version: 1, job_id: "job_2" },
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /이번 작업만 다른 설정/ }),
  );
  fireEvent.mouseDown(screen.getByLabelText("이번 작업 프리셋"));
  fireEvent.click(await screen.findByRole("option", { name: /고품질/ }));
  fireEvent.click(screen.getByRole("button", { name: "재처리 시작" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/meetings/m1/reprocess", {
      processing: { preset: "quality" },
    }),
  );
});
```

- [ ] **Step 3: 실패 확인**

Run: `pnpm vitest run src/features/meeting/ui/reprocess-dialog.test.tsx`
Expected: FAIL

- [ ] **Step 4: dialog 구현** — `src/features/meeting/ui/reprocess-dialog.tsx`:

```tsx
import * as React from "react";

import { isApiError } from "@/shared/api/client";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { toast } from "@/shared/ui/use-toast";
import { OverrideSection } from "@/features/settings/ui/override-section";
import type { ProcessingOverride } from "@/features/settings/api/types";

import { useReprocessMeeting } from "../api/meetings";

/**
 * ReprocessDialog — 회의 재처리 확인. 기존 전사/화자 결과를 새 결과로
 * 덮어쓴다는 점을 고지하고, job 한정 오버라이드 섹션(기본 접힘)을 제공한다.
 */

type ReprocessDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting: { id: string; title: string | null };
};

export function ReprocessDialog({
  open,
  onOpenChange,
  meeting,
}: ReprocessDialogProps) {
  const [processing, setProcessing] = React.useState<
    ProcessingOverride | undefined
  >(undefined);
  const reprocess = useReprocessMeeting();

  const handleOpenChange = (next: boolean) => {
    if (!next && reprocess.isPending) return;
    if (!next) setProcessing(undefined);
    onOpenChange(next);
  };

  const handleConfirm = () => {
    if (reprocess.isPending) return;
    reprocess.mutate(
      { id: meeting.id, processing },
      {
        onSuccess: () => {
          toast({
            variant: "success",
            title: "재처리를 시작했어요.",
            description: "완료되면 새 결과로 바뀌어요.",
          });
          setProcessing(undefined);
          onOpenChange(false);
        },
        onError: (error) => {
          toast({
            variant: "error",
            title: "재처리에 실패했어요.",
            description: isApiError(error) ? error.message : undefined,
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>회의 재처리</DialogTitle>
          <DialogDescription>
            “{meeting.title ?? "제목 없음"}” 회의를 처음부터 다시 처리해요.
            기존 전사·화자 분리 결과는 새 결과로 덮어써요.
          </DialogDescription>
        </DialogHeader>

        <OverrideSection value={processing} onChange={setProcessing} />

        <DialogFooter>
          <DialogClose asChild>
            <Button
              type="button"
              variant="secondary"
              disabled={reprocess.isPending}
            >
              취소
            </Button>
          </DialogClose>
          <Button
            type="button"
            loading={reprocess.isPending}
            disabled={reprocess.isPending}
            onClick={handleConfirm}
          >
            재처리 시작
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: 진입점** — `src/features/meeting/ui/transcript-pane.tsx`:

헤더 액션 영역(제목 옆 `IconButton`들 — 이름 변경/삭제/즐겨찾기가 있는 곳, 385행 근방 "header: title + actions")에 재처리 버튼 추가. 기존 rename/delete dialog가 이 파일 안에서 어떻게 state로 열리는지(예: `const [renameOpen, setRenameOpen] = ...`) 동일 패턴을 따른다:

```tsx
{(meeting.status === "done" || meeting.status === "failed") && (
  <IconButton
    aria-label="회의 재처리"
    onClick={() => setReprocessOpen(true)}
  >
    <Icon name="rotateCcw" size={16} />
  </IconButton>
)}
// ... 파일 하단 dialog 렌더 영역에:
<ReprocessDialog
  open={reprocessOpen}
  onOpenChange={setReprocessOpen}
  meeting={{ id: meeting.id, title: meeting.title }}
/>
```

`IconButton` 실제 props(variant/size)는 인접 버튼과 동일하게 맞춘다. done/failed가 아닐 땐 버튼 자체를 렌더하지 않는다(BE가 409를 주지만 UI에서 선차단).

- [ ] **Step 6: 통과 확인 + 커밋**

Run: `pnpm vitest run src/features/meeting/ui/reprocess-dialog.test.tsx && pnpm test && pnpm build && pnpm lint`
Expected: 전체 PASS

```bash
git add src/features/meeting/
git commit -m "feat: 회의 재처리 — 확인 dialog + 오버라이드 + 헤더 진입점"
```

---

### Task 6: 문서 델타 + 최종 검증

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1–5 결과.
- Produces: living doc 갱신.

- [ ] **Step 1: CLAUDE.md 갱신** (surgical — 관련 문장만):

- "API layer wired but not called" 문구는 이미 사실과 다름 — 현행화: meetings/speakers/search에 이어 `settings` feature가 실 API 사용.
- Architecture 섹션 features 목록에 `src/features/settings/`(처리 설정: API 훅 + 폼 + 오버라이드 섹션) 한 줄.
- 라우트 목록에 `/settings` 추가 (lazyRoute).
- 재처리 UI 존재(TranscriptPane 헤더, done/failed 한정) 한 줄.
- 오버라이드 UI는 프리셋 단위만 노출(서버 계약은 개별 필드 허용 — 의도된 UI 축소) 한 줄.

- [ ] **Step 2: 최종 전체 검증**

Run: `nvm use 22 && pnpm test && pnpm build && pnpm lint && pnpm format`
Expected: 전체 PASS, format 후 diff 없거나 format 커밋에 포함

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: 처리 설정 FE 델타 — settings feature, /settings 라우트, 재처리 UI"
```

---

## Self-Review 체크 결과 (계획 작성 시 수행 + 리뷰 반영)

- **Spec §7 coverage:** 감지 카드+추천 배지→Task 3, 프리셋 라디오+요약+권장→Task 2, 고급 펼침+custom 전환→Task 2, gpu 비적격(비활성+툴팁+경고 배너)→Task 2, 저장 mutation+invalidate→Task 1·2, 다운로드 안내→Task 2, 업로드 오버라이드(접힘, multipart JSON 문자열)→Task 4, 재처리 dialog 오버라이드→Task 5(사용자 승인으로 재처리 UI 신설 포함).
- **의도된 축소 1건 (사용자 승인, 리뷰 #1):** 오버라이드 섹션은 프리셋 선택만 노출(개별 노브 미노출) — 서버 계약은 그대로, UI 혼동 방지 목적. Task 4에 근거 명시, Task 6에서 CLAUDE.md 기록.
- **gpu 비적격 정합 (리뷰 #2·#4):** 프리셋 카드 자체를 disabled (모든 프리셋이 diar gpu → 저장 400 예방). GPU 스위치는 비대칭 — 켜기(cpu→gpu) 차단, 끄기(gpu→cpu) 허용 (옮겨온 DB 복구 경로). 테스트 포함.
- **보수적 기본값 (리뷰 #3):** `gpu_eligible`는 `caps?.gpu_eligible === true`만 참 — 조회 전/실패 시 GPU 불허, 로딩 중 프리셋/스위치 비활성. 테스트 포함.
- **OverrideSection reset 동기화 (리뷰 #5):** `value → undefined` 전환 시 섹션 닫힘 effect + rerender 테스트.
- **프리셋 메타 드리프트 (리뷰 #6, 최소 대응):** `PRESET_META_REVISION` vs GET `preset_revision` 불일치 시 안내 문구; 현재 서버 preset과 같은 카드 선택 시 서버 resolved 값을 시작값으로 사용. 별도 definitions endpoint는 non-goal(BE 변경 불요).
- **BE 전제 (리뷰 #7 정정):** BE는 구현 완료 — `be` main `470ad76..871f45f` 머지·push됨. 계획 서두에 커밋 범위 명시.
- **타입 일관성:** `ProcessingOverride`/`ProcessingConfig`/`PRESET_META`/`OverrideSection(value, onChange)`/`useReprocessMeeting({id, processing?})` — 태스크 간 시그니처 일치 확인함.
- **컴포넌트 API 확인 필요 지점 명시:** `Badge` variant, `Card` 구조, `IconButton` props, speakers 페이지 셸 — 각 태스크에 "인접 코드 확인 후 맞춤" 지시 포함 (실 코드 없이 추정 커밋 금지).
- **Radix Select jsdom 규약(mousedown)** 테스트에 반영.
