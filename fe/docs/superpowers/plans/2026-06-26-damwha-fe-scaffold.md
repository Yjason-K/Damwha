# Damwha FE 초기 스캐폴드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `build · dev · lint · test`가 모두 통과하는 React+Vite8+TS 프런트엔드 스캐폴드를 만들고, 향후 백엔드 연동의 토대(라우터·TanStack Query·Axios·env)를 배선한다(실제 API 호출은 안 함).

**Architecture:** Vite 8 + React 19 SPA. feature-based-lite 구조(`app`/`pages`/`shared`). 라우팅은 React Router v7, 서버 상태는 TanStack Query v5, HTTP는 Axios 단일 인스턴스. 스타일은 Tailwind v4 + shadcn(new-york). 테스트는 Vitest 3 + React Testing Library. 린트/포맷은 ESLint flat config + Prettier.

**Tech Stack:** Node 22, pnpm, TypeScript(strict), Vite 8, React 19, React Router 7, TanStack Query 5, Axios, Tailwind 4, shadcn, Vitest 3.

## Global Constraints

- **Node 22 필수.** 각 작업 시작 전 셸에서 `nvm install 22 && nvm use` (현재 셸 기본 node는 v20).
- **패키지매니저는 pnpm** (`packageManager: "pnpm@10.26.0"`). npm/yarn 사용 금지.
- **패키지명은 정확히 `damwha-fe`** (디렉토리는 `daewha/fe`지만 `be`의 `damwha-be`와 네이밍 미러).
- **git identity는 이미 설정됨** (로컬 config: `김영재` / `kimyoungjae17@gmail.com`, remote `origin`). 새로 init/config 하지 말 것. **push 금지** — 커밋만.
- **TypeScript strict + `verbatimModuleSyntax`** → 타입 전용 import는 반드시 `import type { ... }` 사용.
- **Prettier 스타일:** 큰따옴표, 세미콜론, 후행 쉼표(`all`), printWidth 80.
- **실제 백엔드 호출 금지.** axios/query는 생성·배선만 하고 어떤 엔드포인트도 호출하지 않는다.
- 작업 디렉토리는 `daewha/fe` 루트. 모든 경로는 그 기준.

---

### Task 1: 프로젝트 매니페스트 + Vite/React/TS 베이스라인

빈 React 앱이 dev/build 되는 최소 골격.

**Files:**
- Create: `package.json`, `.nvmrc`, `.npmrc`, `.gitignore`, `index.html`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `src/main.tsx`, `src/vite-env.d.ts`

**Interfaces:**
- Consumes: (없음)
- Produces: Vite 프로젝트 루트, `@/*` → `src/*` alias, `pnpm dev/build/preview` 스크립트.

- [ ] **Step 1: `package.json` 작성**

```json
{
  "name": "damwha-fe",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "packageManager": "pnpm@10.26.0",
  "engines": { "node": ">=22 <23" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  }
}
```

- [ ] **Step 2: 설정 파일들 작성**

`.nvmrc`:
```
22
```

`.npmrc`:
```
engine-strict=true
```

`.gitignore`:
```
node_modules
dist
dist-ssr
*.local

# env
.env
.env.*
!.env.example

# editor / os
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store

# logs
*.log
npm-debug.log*
pnpm-debug.log*

# typescript
*.tsbuildinfo
```

`index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Damwha</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`tsconfig.json`:
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```

`tsconfig.app.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",

    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,

    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vitest.setup.ts"]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts"]
}
```

> 참고: `tsconfig.app.json`이 아직 존재하지 않는 `vitest.setup.ts`를 include하지만 Task 5에서 생성된다. `tsc -b`는 include 글롭에 매칭되는 파일이 없어도 에러를 내지 않으므로 Task 1~4 빌드에 영향 없다.

`vite.config.ts`:
```ts
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: 소스 엔트리 작성**

`src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <h1>Damwha FE</h1>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: 의존성 설치**

Run:
```bash
nvm use
pnpm add react@^19 react-dom@^19
pnpm add -D vite@^8 @vitejs/plugin-react@latest typescript@^5 @types/react@^19 @types/react-dom@^19 @types/node@^22
```
Expected: `node_modules/`, `pnpm-lock.yaml` 생성. 에러 없음.

- [ ] **Step 5: 빌드 검증**

Run: `pnpm build`
Expected: `tsc -b` 통과 후 `vite build` 성공, `dist/` 생성. 에러 0.

- [ ] **Step 6: dev 서버 스모크 (수동)**

Run: `pnpm dev` → 브라우저에서 `http://localhost:5173` 접속해 "Damwha FE" 보이면 Ctrl+C로 종료.

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "chore: vite8 + react19 + ts 베이스라인 스캐폴드"
```

---

### Task 2: 폴더 구조 + React Router v7 라우팅

`app`/`pages`/`shared` 구조와 Home/NotFound 라우트.

**Files:**
- Create: `src/app/router.tsx`, `src/app/providers.tsx`, `src/pages/home.tsx`, `src/pages/not-found.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `@/*` alias (Task 1).
- Produces: `router` (`createBrowserRouter` 인스턴스), `AppProviders` 컴포넌트, `HomePage`/`NotFoundPage` 컴포넌트.

- [ ] **Step 1: 의존성 설치**

Run: `pnpm add react-router`
Expected: 에러 없음. (React Router v7는 `react-router` 단일 패키지)

- [ ] **Step 2: 페이지 컴포넌트 작성**

`src/pages/home.tsx`:
```tsx
export function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">Damwha</h1>
    </main>
  );
}
```

`src/pages/not-found.tsx`:
```tsx
import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">404</h1>
      <Link to="/" className="underline">
        홈으로
      </Link>
    </main>
  );
}
```

- [ ] **Step 3: 라우터 + 프로바이더 작성**

`src/app/router.tsx`:
```tsx
import { createBrowserRouter } from "react-router";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";

export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "*", element: <NotFoundPage /> },
]);
```

`src/app/providers.tsx`:
```tsx
import { RouterProvider } from "react-router";
import { router } from "@/app/router";

export function AppProviders() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 4: 엔트리에서 프로바이더 마운트**

`src/main.tsx` (전체 교체):
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
```

- [ ] **Step 5: 빌드 검증**

Run: `pnpm build`
Expected: 성공, 에러 0. (Tailwind 클래스는 아직 스타일 미적용이지만 빌드는 통과)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat: app/pages/shared 구조 + react-router v7 라우팅"
```

---

### Task 3: Tailwind v4 + shadcn(Button)

스타일 파이프라인과 첫 shadcn 컴포넌트.

**Files:**
- Create: `src/index.css`, `components.json`, `src/shared/lib/utils.ts`, `src/shared/ui/button.tsx`
- Modify: `vite.config.ts`, `src/main.tsx`, `src/pages/home.tsx`

**Interfaces:**
- Consumes: `@/*` alias.
- Produces: `cn(...inputs: ClassValue[]): string`, `Button` 컴포넌트(+`buttonVariants`).

- [ ] **Step 1: 의존성 설치**

Run:
```bash
pnpm add -D tailwindcss @tailwindcss/vite tw-animate-css
pnpm add class-variance-authority clsx tailwind-merge @radix-ui/react-slot
```
Expected: 에러 없음.

- [ ] **Step 2: Vite에 Tailwind 플러그인 추가**

`vite.config.ts` (전체 교체):
```ts
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: 글로벌 CSS(테마 토큰) 작성**

`src/index.css`:
```css
@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.145 0 0);
  --sidebar-primary: oklch(0.205 0 0);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.97 0 0);
  --sidebar-accent-foreground: oklch(0.205 0 0);
  --sidebar-border: oklch(0.922 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --sidebar: oklch(0.205 0 0);
  --sidebar-foreground: oklch(0.985 0 0);
  --sidebar-primary: oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent: oklch(0.269 0 0);
  --sidebar-accent-foreground: oklch(0.985 0 0);
  --sidebar-border: oklch(1 0 0 / 10%);
  --sidebar-ring: oklch(0.556 0 0);
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

- [ ] **Step 4: 엔트리에서 CSS import**

`src/main.tsx` — 첫 줄에 추가:
```tsx
import "@/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppProviders } from "@/app/providers";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
```

- [ ] **Step 5: shadcn 설정 + 유틸 + Button 작성**

`components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/shared",
    "utils": "@/shared/lib/utils",
    "ui": "@/shared/ui",
    "lib": "@/shared/lib",
    "hooks": "@/shared/hooks"
  },
  "iconLibrary": "lucide"
}
```

`src/shared/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

`src/shared/ui/button.tsx`:
```tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive:
          "bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
```

- [ ] **Step 6: Home에서 Button 사용**

`src/pages/home.tsx` (전체 교체):
```tsx
import { Button } from "@/shared/ui/button";

export function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-3xl font-bold">Damwha</h1>
      <Button>시작하기</Button>
    </main>
  );
}
```

- [ ] **Step 7: 빌드 + dev 스모크**

Run: `pnpm build`
Expected: 성공, 에러 0.

Run: `pnpm dev` → `http://localhost:5173`에서 가운데 정렬된 "Damwha" 제목과 스타일 입혀진 "시작하기" 버튼 확인 후 Ctrl+C.

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "feat: tailwind v4 + shadcn(button) 스타일 파이프라인"
```

---

### Task 4: TanStack Query + Axios + env 배선

서버 상태/HTTP 토대. 생성·배선만, 실제 호출 없음.

**Files:**
- Create: `src/shared/config/env.ts`, `src/shared/api/query-client.ts`, `src/shared/api/client.ts`, `.env.example`
- Modify: `src/vite-env.d.ts`, `src/app/providers.tsx`

**Interfaces:**
- Consumes: `@/*` alias.
- Produces: `env: { apiBaseUrl: string }`, `createQueryClient(): QueryClient`, `apiClient: AxiosInstance`. `AppProviders`가 `QueryClientProvider`로 래핑됨.

- [ ] **Step 1: 의존성 설치**

Run: `pnpm add @tanstack/react-query axios`
Expected: 에러 없음.

- [ ] **Step 2: env 타입 + 접근 모듈**

`src/vite-env.d.ts` (전체 교체):
```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

`src/shared/config/env.ts`:
```ts
export const env = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000",
} as const;
```

`.env.example`:
```
VITE_API_BASE_URL=http://localhost:3000
```

- [ ] **Step 3: QueryClient 팩토리 + Axios 인스턴스**

`src/shared/api/query-client.ts`:
```ts
import { QueryClient } from "@tanstack/react-query";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        retry: 1,
      },
    },
  });
}
```

`src/shared/api/client.ts`:
```ts
import axios from "axios";
import { env } from "@/shared/config/env";

export const apiClient = axios.create({
  baseURL: env.apiBaseUrl,
  headers: { "Content-Type": "application/json" },
});
```

- [ ] **Step 4: 프로바이더에 QueryClientProvider 추가**

`src/app/providers.tsx` (전체 교체):
```tsx
import { useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router";
import { router } from "@/app/router";
import { createQueryClient } from "@/shared/api/query-client";

export function AppProviders() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

- [ ] **Step 5: 빌드 검증**

Run: `pnpm build`
Expected: 성공, 에러 0. (`apiClient`는 어디서도 호출되지 않지만 export 멤버이므로 미사용 에러 아님)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat: tanstack query + axios + env 배선(호출 없음)"
```

---

### Task 5: Vitest + React Testing Library + 샘플 테스트

테스트 러너 구성과 동작 증명 테스트 2개.

**Files:**
- Create: `vitest.setup.ts`, `src/pages/home.test.tsx`, `src/shared/lib/utils.test.ts`
- Modify: `vite.config.ts`, `package.json`

**Interfaces:**
- Consumes: `HomePage` (Task 2/3), `cn` (Task 3).
- Produces: `pnpm test` / `pnpm test:watch` 스크립트, jsdom 테스트 환경.

- [ ] **Step 1: 첫 테스트 작성 (실패 예정)**

`src/shared/lib/utils.test.ts`:
```ts
import { expect, test } from "vitest";
import { cn } from "@/shared/lib/utils";

test("cn은 클래스를 병합하고 tailwind 충돌을 해결한다", () => {
  expect(cn("px-2", "px-4")).toBe("px-4");
  expect(cn("text-sm", undefined, null, "font-bold")).toBe("text-sm font-bold");
});
```

`src/pages/home.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { HomePage } from "@/pages/home";

test("홈 페이지는 앱 타이틀과 버튼을 렌더한다", () => {
  render(<HomePage />);
  expect(screen.getByRole("heading", { name: "Damwha" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "시작하기" }),
  ).toBeInTheDocument();
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `pnpm test`
Expected: FAIL — `"test"` 스크립트가 아직 없어 실패(또는 vitest 미설치). 이것이 red 상태.

- [ ] **Step 3: 의존성 설치**

Run:
```bash
pnpm add -D vitest @testing-library/react @testing-library/dom @testing-library/jest-dom jsdom
```
Expected: 에러 없음.

- [ ] **Step 4: Vitest 설정 + 셋업 파일**

`vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`vite.config.ts` (전체 교체 — 최상단 vitest 타입 참조 + `test` 블록 추가):
```ts
/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: true,
  },
});
```

- [ ] **Step 5: 테스트 스크립트 추가**

`package.json`의 `scripts`에 추가:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: 테스트 실행 → 통과 확인**

Run: `pnpm test`
Expected: PASS — `2 passed` (2 test files / 2 tests).

- [ ] **Step 7: 타입체크 회귀 확인**

Run: `pnpm build`
Expected: 성공. (`vitest.setup.ts`가 `tsconfig.app` include에 포함되어 jest-dom matcher 타입이 프로그램에 로드됨 → `.toBeInTheDocument()` 타입 통과)

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "test: vitest + RTL 구성 + 샘플 테스트 2개"
```

---

### Task 6: ESLint(flat) + Prettier

린트/포맷 도구와 스크립트.

**Files:**
- Create: `eslint.config.js`, `.prettierrc`, `.prettierignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: (전체 소스)
- Produces: `pnpm lint` / `pnpm format` 스크립트.

- [ ] **Step 1: 의존성 설치**

Run:
```bash
pnpm add -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks eslint-plugin-react-refresh globals prettier eslint-config-prettier
```
Expected: 에러 없음.

- [ ] **Step 2: ESLint flat config 작성**

`eslint.config.js`:
```js
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs["recommended-latest"],
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
]);
```

- [ ] **Step 3: Prettier 설정 작성**

`.prettierrc`:
```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 80
}
```

`.prettierignore`:
```
dist
node_modules
pnpm-lock.yaml
```

- [ ] **Step 4: lint/format 스크립트 추가**

`package.json`의 `scripts`에 `lint`, `format` 추가 (최종 형태):
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 5: 포맷 적용**

Run: `pnpm format`
Expected: 소스 파일들이 Prettier 규칙으로 정렬됨(일부 파일 변경될 수 있음).

- [ ] **Step 6: 린트 실행 → 통과 확인**

Run: `pnpm lint`
Expected: 에러 0. (경고가 있으면 내용 확인 후 제거; `react-refresh/only-export-components`는 페이지/컴포넌트 파일 구조상 발생하지 않아야 함)

- [ ] **Step 7: 회귀 확인**

Run: `pnpm test && pnpm build`
Expected: 둘 다 성공.

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "chore: eslint(flat) + prettier 구성"
```

---

### Task 7: 최종 인수 검증

스펙 §9 완료 기준 전체 확인.

**Files:** (없음 — 검증 전용)

**Interfaces:**
- Consumes: Task 1~6 산출물 전체.
- Produces: 모든 인수 기준 통과 확인.

- [ ] **Step 1: 클린 설치 검증**

Run: `pnpm install`
Expected: 락파일 기준 설치, 에러 0.

- [ ] **Step 2: 린트**

Run: `pnpm lint`
Expected: 에러 0.

- [ ] **Step 3: 테스트**

Run: `pnpm test`
Expected: `2 passed`.

- [ ] **Step 4: 빌드**

Run: `pnpm build`
Expected: 성공, `dist/` 생성.

- [ ] **Step 5: dev 스모크 (수동)**

Run: `pnpm dev` → Home에서 타이틀+버튼 렌더, 존재하지 않는 경로(`/zzz`)에서 404 페이지 확인 후 Ctrl+C.

- [ ] **Step 6: git 상태 확인**

Run: `git status` / `git log --oneline`
Expected: 워킹트리 clean, Task 1~6 커밋 존재, remote `origin` 설정됨. **push는 하지 않음.**

- [ ] **Step 7: (선택) living docs 작성**

스펙 §비목표가 아닌 범위 내에서, 후속 작업자를 위해 `CLAUDE.md`(FE 컨벤션 요약)와 `docs/README.md`를 작성할지는 사용자 확인 후 진행. 기본은 생략.
