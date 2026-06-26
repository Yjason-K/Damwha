# Damwha FE — 초기 스캐폴드 설계

- **날짜:** 2026-06-26
- **대상 리포:** `daewha/fe` (`damwha-fe`)
- **상태:** 설계 승인됨 → 구현 계획(writing-plans) 전 단계

> 이 문서는 날짜 스냅샷이며 사후 편집하지 않는다(`be` 컨벤션과 동일). 구현 중 발생한 변경은 living docs(`CLAUDE.md`, `docs/README.md`)에 기록한다.

---

## 1. 이게 뭔가 (Context)

Damwha는 개인용·셀프호스팅 회의 녹음/검색 플랫폼이다. 핵심 객체는 **utterance**(화자 귀속·타임스탬프·원본 오디오 추적). 백엔드(`daewha/be` = `damwha-be`, NestJS)는 REST로 meetings/speakers/jobs를 서빙한다. 이 리포(`daewha/fe` = `damwha-fe`)는 그 백엔드를 소비하는 **웹 프런트엔드**이며, `be`와는 **별도 git 리포**(형제 디렉토리)다.

이 문서의 범위는 제품 기능이 아니라 **프런트엔드 프로젝트의 초기 스캐폴드**다.

## 2. 목표 & 비목표 (Scope)

### 목표
`build · dev · lint · test`가 모두 통과하는 **최소 골격 + 샘플 페이지 1개**를 만든다. 향후 백엔드 연동을 위한 토대(라우터·TanStack Query·Axios 인스턴스·env)는 **배선만** 해 둔다(실제 API 호출은 하지 않음).

### 비목표 (이번에 하지 않음)
- 실제 API 연동 수직 슬라이스(회의 목록/상세/업로드 등)
- 인증/세션
- MSW 등 API 목킹
- CI 파이프라인
- 디자인 시스템 확장, 다크모드 토글 로직
- 배포 설정

> 비목표 항목들은 후속 작업에서 각자의 spec → plan 사이클로 진행한다.

## 3. 기술 스택 (메이저 고정)

| 영역 | 선택 | 비고 |
|---|---|---|
| 런타임 | **Node 22** | `.nvmrc=22`, `engines: ">=22 <23"` — `be`와 동일하게 미러 |
| 패키지매니저 | **pnpm** | `package.json#packageManager` 고정, `.npmrc engine-strict=true` |
| 빌드 | **Vite 8** | `@vitejs/plugin-react` |
| 언어 | **TypeScript** (strict) | tsconfig project references |
| UI 런타임 | **React 19** | |
| 라우팅 | **React Router v7** | `createBrowserRouter` |
| 서버 상태 | **TanStack Query v5** | `QueryClientProvider` 배선 |
| HTTP 클라이언트 | **Axios** | 단일 인스턴스, `VITE_API_BASE_URL` 기반 |
| 스타일 | **Tailwind v4** (`@tailwindcss/vite`) + **shadcn** | new-york 스타일 |
| 테스트 | **Vitest 3** + React Testing Library + jsdom + `@testing-library/jest-dom` | |
| 린트/포맷 | **ESLint(flat config) + Prettier** | typescript-eslint, react-hooks, react-refresh, eslint-config-prettier |

> 권장 디폴트로 채운 결정 3가지: **폴더 구조 = feature-based-lite**, **린트 = ESLint+Prettier(Biome 아님)**, **Tailwind v4 채택**.

## 4. 폴더 구조 (feature-based-lite)

변경 단위 응집과 예측 가능성을 우선한다. shadcn 컴포넌트는 `@/shared/ui`로 매핑한다.

```
src/
├── main.tsx                 # 마운트 진입점 (providers 마운트)
├── index.css                # tailwind 지시문 + 테마 토큰
├── app/
│   ├── providers.tsx        # QueryClientProvider + RouterProvider 조립
│   └── router.tsx           # createBrowserRouter (routes 정의)
├── pages/
│   ├── home.tsx             # 샘플 페이지
│   └── not-found.tsx        # catch-all 라우트
└── shared/
    ├── api/
    │   ├── client.ts        # axios 인스턴스 (배선만, 실제 호출 X)
    │   └── query-client.ts  # QueryClient 팩토리
    ├── config/
    │   └── env.ts           # import.meta.env 타입세이프 접근
    ├── lib/
    │   └── utils.ts         # cn() (shadcn)
    └── ui/                  # shadcn 컴포넌트 (초기: button)
```

향후 기능은 `src/features/<feature>/`(각 기능이 자기 api·ui·model을 소유)로 추가하는 컨벤션을 따른다. 이번 스캐폴드에서는 빈 폴더를 만들지 않는다.

## 5. 루트 설정 파일

| 파일 | 역할 |
|---|---|
| `.nvmrc` | `22` |
| `.npmrc` | `engine-strict=true` |
| `.gitignore` | node_modules, dist, .env 등 |
| `.env.example` | `VITE_API_BASE_URL=http://localhost:3000` |
| `.prettierrc` | Prettier 설정 |
| `eslint.config.js` | ESLint flat config |
| `components.json` | shadcn 설정 (alias를 `@/shared/*`로) |
| `index.html` | Vite 엔트리 |
| `package.json` | `name: damwha-fe`, `engines`, `packageManager`, scripts |
| `tsconfig.json` | project references 루트 |
| `tsconfig.app.json` | 앱 컴파일러 옵션 + path alias (`@/* → src/*`) |
| `tsconfig.node.json` | vite/config용 |
| `vite.config.ts` | react + tailwind + path alias + **vitest `test` 블록**(jsdom, setup) |
| `vitest.setup.ts` | `@testing-library/jest-dom` 등록 |

## 6. 스캐폴드 내용물

- **`Home` 페이지** — 앱 타이틀 + shadcn `Button` 1개 렌더. shadcn/Tailwind 동작을 증명.
- **`NotFound` 페이지** — catch-all 라우트.
- **Axios 인스턴스 + QueryClient** — 생성·Provider 배선까지만(실제 fetch 없음).
- **샘플 테스트 2개** — `Home` 렌더 테스트, `cn()` 유틸 테스트. Vitest 동작을 증명.

## 7. package.json 스크립트

| 스크립트 | 명령 |
|---|---|
| `dev` | `vite` |
| `build` | `tsc -b && vite build` |
| `preview` | `vite preview` |
| `lint` | `eslint .` |
| `format` | `prettier --write .` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |

## 8. git 초기화

리포 로컬 범위로 설정한다(전역 config 건드리지 않음). 첫 push는 별도 요청 시에만 수행한다.

```bash
git init
git config user.name "김영재"
git config user.email "kimyoungjae17@gmail.com"
git remote add origin https://github.com/Yjason-K/Damwha_FE.git
# 스캐폴드 + 스펙 문서를 초기 커밋 (push 안 함)
```

## 9. 완료 기준 (Acceptance Criteria)

설치 후 다음이 모두 성공해야 한다:

```bash
pnpm install
pnpm lint        # 0 errors
pnpm test        # 2 passed
pnpm build       # 타입체크 + 프로덕션 빌드 성공
pnpm dev         # 로컬 서버 기동, Home 페이지 렌더
```

그리고 git 리포가 초기화되어 위 §8 config/remote가 설정되고, 스캐폴드 + 이 스펙 문서가 초기 커밋되어 있어야 한다.
