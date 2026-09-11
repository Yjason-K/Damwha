# Electron Phase 1 앱 기반 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Damwha.app` 아이콘으로 실행해 업로드·녹음·검색을 할 수 있게 한다. Electron이 NestJS API를 자식 프로세스로 띄우고 준비되면 화면을 붙인다.

**Architecture:** 새 워크스페이스 패키지 `desktop`의 main 프로세스가 `config.json`을 읽어 절대 경로 env를 만들고, API를 자식으로 띄운 뒤 `GET /api/health`와 자식의 종료·stderr로 준비 상태를 판정한다. 준비되면 렌더러가 **API가 서빙하는 loopback origin**을 로드하므로 CORS가 관여하지 않고 `be/src/main.ts`의 기존 `dist/public` 서빙을 그대로 쓴다. preload는 두지 않고, 재시도는 main이 자동 재시도와 애플리케이션 메뉴로 소유한다.

**Tech Stack:** Electron 44.3.0, electron-builder 26.15.3, TypeScript 5.9, vitest 4, pnpm 10.26.0 workspace, NestJS 10 (기존 `be`), React 19 + Vite 8 (기존 `fe`)

**Spec:** [docs/superpowers/specs/2026-09-11-electron-phase-1-app-foundation-design.md](../specs/2026-09-11-electron-phase-1-app-foundation-design.md)

## Global Constraints

모든 Task의 요구사항에 암묵적으로 포함된다. 값은 스펙에서 그대로 옮겼다.

- **`desktop/package.json`의 `dependencies`는 빈 상태를 유지한다.** `electron`·`electron-builder`·`typescript`·`vitest`·`@electron/asar`는 전부 `devDependencies`. (스펙 §6.1, P1-C11)
- **preload 스크립트를 만들지 않는다.** 렌더러에서 main으로 가는 경로를 새로 만들지 않는다. (스펙 §6.6, §6.5)
- **`desktop`에 `dev`·`build` 스크립트를 두지 않는다.** 루트 `dev`가 `pnpm --parallel --recursive run dev`, `build`가 `pnpm --recursive run build`이기 때문이다. `start:desktop`·`package:desktop`을 쓰고 루트가 `--filter`로 부른다. `lint`·`test`는 recursive에 참여한다. (스펙 §6.1, P1-C13)
- **루트 `.npmrc`를 고치지 않는다.** `node-linker=hoisted`를 추가하지 않는다. (스펙 §11, P1-C13)
- **`fe/` 소스를 고치지 않는다.** 값 주입만 한다. (스펙 §10)
- **`be/` 변경은 `src/config/env.ts`와 `src/main.ts` 두 파일뿐이다.** `HOST` 기본값은 `0.0.0.0`이어야 한다 — Docker 배포와 `pnpm be:dev` 동작을 보존한다. (스펙 §10)
- **앱은 `.app` 번들 안에 쓰지 않는다.** 쓰기가 필요한 모든 경로는 `<userData>` 아래다. (스펙 §5, P1-C12)
- **앱은 기존 `be/storage`에 쓰지 않는다.** 기존 `meeting`·`utterance` 행을 지우지 않고 마이그레이션을 실행하지 않는다. (스펙 §5, P1-C14)
- `appId: kr.damwha.app`, `productName: Damwha`, `mac.target: dir`. (스펙 §6.1, §4.2)
- Node `>=22 <23`, pnpm `10.26.0`. 기존 `engines`·`packageManager`와 같다.
- API는 `127.0.0.1`에만 바인드한다. `HOST`는 `config.json`이 아니라 앱이 고정 주입한다. (스펙 §6.6)
- 렌더러 창은 `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. (스펙 §6.6)

## 선행 조건 — 구현과 검증 모두

스펙 §4.3. Task 11의 통합 검증 전에 반드시 갖춰져 있어야 한다.

1. `pnpm db:up`으로 Postgres가 떠 있다.
2. `pnpm worker`, `pnpm embed`가 떠 있다.
3. `be/worker/.env`의 `STORAGE_ROOT`가 앱의 `STORAGE_ROOT`와 같은 절대 경로다 — 기본값이면 `~/Library/Application Support/Damwha/storage`. **worker를 앱 값에 맞춘다.** 반대 방향으로 하지 않는다.
4. `pnpm be:migrate`가 적용된 DB다.

## File Structure

```
desktop/
  package.json                  damwha-desktop. dependencies 없음
  tsconfig.json                 module commonjs, outDir dist
  vitest.config.ts
  electron-builder.yml
  .gitignore                    build/ out/
  shell/
    status.html                 준비·오류 화면. 상태는 쿼리 문자열로 받는다
  scripts/
    package.mjs                 be build → fe build → pnpm deploy → public 복사 → electron-builder
    check-bundle.mjs            P1-C11·P1-C12의 번들 위생 검사
  src/
    config.ts                   userData의 config.json 읽기·기본값 생성. electron을 import하지 않는다
    port.ts                     후보 포트 결정, EADDRINUSE 판별. electron을 import하지 않는다
    readiness.ts                준비 판정 폴링 루프. electron을 import하지 않는다
    origin.ts                   origin 추출과 허용 판정. electron을 import하지 않는다
    api-process.ts              자식 API 기동·종료. dev와 packaged 두 launcher
    permissions.ts              마이크 권한, 네비게이션 경계
    menu.ts                     애플리케이션 메뉴와 "다시 시도"
    shell-window.ts             셸 화면 로드와 상태 전달
    main.ts                     수명주기 배선
  tests/
    config.test.ts
    port.test.ts
    readiness.test.ts
    origin.test.ts
```

`electron`을 import하지 않는 네 모듈(`config`·`port`·`readiness`·`origin`)이 단위 테스트 대상이다. vitest는 Electron 런타임 밖에서 도니 `electron`을 import하는 모듈은 테스트에서 불러올 수 없다 — 그래서 순수 로직을 그 네 파일로 분리한다.

`build/`는 `pnpm deploy` 산출물, `out/`은 electron-builder 산출물이다. 루트 `.gitignore`가 `dist/`를 이미 덮으므로 `desktop/.gitignore`는 둘만 추가한다.

---

### Task 1: desktop 패키지 스캐폴드와 빈 창

패키지를 만들고 빈 창을 띄운다. 루트 recursive 명령이 desktop을 끌어가지 않는 것을 이 Task에서 확정한다.

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/vitest.config.ts`
- Create: `desktop/.gitignore`
- Create: `desktop/src/main.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (루트 스크립트 2개 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `desktop` 워크스페이스 패키지. 루트 명령 `pnpm desktop:dev`, `pnpm desktop:build`. `desktop`의 스크립트 이름 `start:desktop`, `package:desktop`, `lint`, `test`, `compile`.

- [ ] **Step 1: 워크스페이스에 desktop을 추가한다**

`pnpm-workspace.yaml`의 `packages` 목록에 `desktop`을 넣는다. 기존 주석은 그대로 둔다.

```yaml
packages:
  - be
  - fe
  - desktop
  - packages/*
  - "!be/worker/**"
```

- [ ] **Step 2: desktop/package.json을 만든다**

`dependencies` 키를 아예 두지 않는다. `dev`·`build` 이름을 쓰지 않는다.

```json
{
  "name": "damwha-desktop",
  "private": true,
  "version": "0.2.3",
  "license": "MIT",
  "description": "Damwha macOS desktop shell. Runs the NestJS API as a child process and loads the SPA it serves.",
  "main": "dist/main.js",
  "engines": {
    "node": ">=22 <23"
  },
  "scripts": {
    "compile": "tsc -p tsconfig.json",
    "start:desktop": "pnpm run compile && electron .",
    "package:desktop": "node scripts/package.mjs",
    "test": "vitest run",
    "lint": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "@electron/asar": "^4.0.1",
    "@types/node": "^22.20.0",
    "electron": "44.3.0",
    "electron-builder": "26.15.3",
    "typescript": "^5.9.3",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 3: tsconfig.json을 만든다**

`be/tsconfig.json`과 같은 CJS 설정을 쓴다. Electron main은 CJS가 기본이다.

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2023"],
    "moduleResolution": "node",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: vitest.config.ts를 만든다**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: .gitignore를 만든다**

```
# pnpm deploy 산출물과 electron-builder 산출물. dist/는 루트 .gitignore가 덮는다.
build/
out/
```

- [ ] **Step 6: 빈 창을 띄우는 main.ts를 쓴다**

이 Task의 main.ts는 창만 띄운다. API 기동은 Task 6 이후에 붙인다.

```ts
import { app, BrowserWindow } from "electron";

function createWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 860,
    title: "담화",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

app.whenReady().then(() => {
  createWindow();
});

// Phase 1은 창을 닫으면 앱이 끝난다. macOS 관례와 다르며 Phase 2가 재정의한다 (스펙 §4.2).
app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 7: 루트 스크립트를 추가한다**

`package.json`의 `scripts`에 두 줄을 넣는다. `fe` 관련 스크립트 뒤에 둔다.

```json
    "desktop": "pnpm --filter damwha-desktop run",
    "desktop:dev": "pnpm --filter damwha-desktop run start:desktop",
    "desktop:build": "pnpm --filter damwha-desktop run package:desktop",
```

- [ ] **Step 8: 설치하고 electron 설치 스크립트 차단 여부를 확인한다**

Run: `pnpm install`

`electron`은 바이너리를 내려받는 설치 스크립트를 갖는다. pnpm 10은 승인되지 않은 빌드 스크립트를 차단하고 경고를 낸다. 출력에 `Ignored build scripts: electron` 류의 줄이 있으면 루트 `package.json`의 `pnpm` 블록에 `onlyBuiltDependencies`를 추가한다. 기존 `ignoredBuiltDependencies`는 그대로 둔다.

```json
  "pnpm": {
    "onlyBuiltDependencies": ["electron"],
    "ignoredBuiltDependencies": [
      "@nestjs/core",
      "cpu-features",
      "protobufjs",
      "ssh2"
    ]
  }
```

추가했으면 `pnpm install`을 다시 돌린다.

Expected: `desktop/node_modules/electron/dist/Electron.app`이 존재한다. 없으면 설치 스크립트가 아직 막힌 것이다.

- [ ] **Step 9: 창이 뜨는지 확인한다**

Run: `pnpm desktop:dev`

Expected: 빈 흰 창이 뜬다. 제목이 "담화". 창을 닫으면 프로세스가 끝난다.

- [ ] **Step 10: 루트 recursive 명령이 desktop을 끌어가지 않는지 확인한다**

Run: `pnpm dev`

Expected: API(:3000)와 Vite(:5173)만 뜬다. **Electron 창이 뜨지 않는다.** 확인 후 중단한다.

Run: `pnpm build`

Expected: `be`·`fe`·`contracts`만 빌드된다. `desktop/out`이 생기지 않는다.

Run: `pnpm test`

Expected: `desktop`의 vitest가 참여한다. 테스트 파일이 아직 없으므로 "No test files found"로 끝나며, 그 자체는 실패가 아니어야 한다. 실패로 끝나면 `vitest run --passWithNoTests`로 바꾼다.

- [ ] **Step 11: 커밋**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml desktop/
git commit -m "feat(desktop): damwha-desktop 패키지를 만들고 빈 창을 띄운다"
```

**Verify:**
- `pnpm desktop:dev`로 창이 뜬다.
- `pnpm dev`가 Electron 창을 띄우지 않는다.
- `pnpm build`가 `desktop/out`을 만들지 않는다.
- `desktop/package.json`에 `dependencies` 키가 없다.

**Review:**
- 루트 스크립트가 `--filter`로만 desktop을 부르는가.
- `.npmrc`가 변경되지 않았는가.
- `desktop/package.json`에 `dev`·`build` 키가 없는가.
- 창 옵션에 `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`가 모두 있는가.

---

### Task 2: API 실행 경로 실측

스펙 §12가 계획 1단계에서 닫으라고 한 두 위험(R1-1 `utilityProcess`로 NestJS가 뜨는가, R1-2·R1-9 `pnpm deploy` 트리가 실행 가능한가)을 여기서 실측한다. 이 Task의 산출물은 **결정과 증거**이고, 실험 코드는 남기지 않는다.

**Files:**
- Create: `desktop/build/api/` (`pnpm deploy` 산출물, gitignore 대상)
- Create: 임시 실측 스크립트 — 이 Task 끝에 지운다
- Modify: `docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md` ("단계별 실행·리뷰"에 Task 2 결과)

**Interfaces:**
- Consumes: Task 1의 `desktop` 패키지
- Produces: 두 결정 — (1) 자식 API 기동 수단이 `utilityProcess.fork`인지 `ELECTRON_RUN_AS_NODE`인지, (2) `pnpm deploy` 호출 형태. Task 6과 Task 10이 이 결정을 쓴다.

- [ ] **Step 1: be를 빌드하고 deploy 트리를 만든다**

```bash
pnpm be build
pnpm --filter=damwha-be --prod deploy desktop/build/api
```

Expected: `desktop/build/api/dist/main.js`, `desktop/build/api/node_modules/`, `desktop/build/api/package.json`이 있다.

- [ ] **Step 2: 트리가 자기 안에서 완결되는지 본다**

```bash
find desktop/build/api -type l | head -50
find desktop/build/api -type l -exec sh -c 'printf "%s -> %s\n" "$1" "$(cd "$(dirname "$1")" && readlink -f "$(basename "$1")")"' _ {} \; \
  | grep -v "$(cd desktop/build/api && pwd)" || echo "트리 밖을 가리키는 링크 없음"
ls desktop/build/api/node_modules/@damwha/contracts/dist
```

Expected: 트리 밖을 가리키는 링크가 없다. `@damwha/contracts`의 `dist/cjs`와 `dist/esm`이 실재한다.

트리 밖을 가리키는 링크가 있으면 두 대안을 차례로 시험하고 결과를 기록한다.

```bash
rm -rf desktop/build/api
pnpm --filter=damwha-be --prod --config.node-linker=hoisted deploy desktop/build/api
# 그래도 안 되면
rm -rf desktop/build/api
pnpm --filter=damwha-be --prod --legacy deploy desktop/build/api
```

- [ ] **Step 3: 트리의 API를 Node로 직접 띄워 본다**

DB가 떠 있어야 한다(`pnpm db:up`).

```bash
cd desktop/build/api
PORT=53001 HOST=127.0.0.1 \
DATABASE_URL=postgres://postgres:postgres@localhost:5432/damwha \
STORAGE_ROOT="$HOME/Library/Application Support/Damwha/storage" \
node dist/main.js
```

별 터미널에서:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:53001/api/health
```

Expected: `200`. `Ctrl+C`로 멈춘다.

`Cannot find module` 류로 실패하면 Step 2의 대안 중 아직 안 쓴 것으로 다시 만들어 반복한다.

- [ ] **Step 4: utilityProcess로 같은 것을 띄워 본다**

`desktop/src/probe-main.ts`를 임시로 만든다.

```ts
import { app, utilityProcess } from "electron";
import * as path from "path";

const api = path.join(__dirname, "..", "build", "api", "dist", "main.js");

app.whenReady().then(() => {
  const child = utilityProcess.fork(api, [], {
    cwd: path.dirname(path.dirname(api)),
    stdio: "pipe",
    env: {
      ...process.env,
      PORT: "53002",
      HOST: "127.0.0.1",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha",
      STORAGE_ROOT: path.join(app.getPath("userData"), "storage"),
    },
  });
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[api] ${b}`));
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[api!] ${b}`));
  child.on("exit", (code) => {
    console.log(`[probe] api exited: ${code}`);
    app.quit();
  });
  setTimeout(async () => {
    const res = await fetch("http://127.0.0.1:53002/api/health").catch((e) => e as Error);
    console.log(`[probe] health: ${res instanceof Error ? res.message : res.status}`);
    console.log(`[probe] child pid: ${child.pid}`);
    child.kill();
  }, 15000);
});
```

Run:

```bash
pnpm --filter damwha-desktop run compile
cd desktop && npx electron dist/probe-main.js
```

Expected: `[probe] health: 200`과 `[probe] child pid: <숫자>`가 찍힌다.

- [ ] **Step 5: utilityProcess가 실패하면 대체안을 실측한다**

Step 4가 실패했을 때만 한다. `probe-main.ts`의 `utilityProcess.fork` 블록을 아래로 바꿔 같은 판정을 반복한다.

```ts
import { spawn } from "child_process";

const child = spawn(process.execPath, [api], {
  cwd: path.dirname(path.dirname(api)),
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: "53002",
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha",
    STORAGE_ROOT: path.join(app.getPath("userData"), "storage"),
  },
});
```

- [ ] **Step 6: 실측 결과를 결과 문서에 적는다**

`docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md`의 "단계별 실행·리뷰"에 표를 넣는다. 적을 것: 쓴 `pnpm deploy` 형태, 트리 밖 링크 건수, `node dist/main.js`의 health 응답, `utilityProcess` health 응답과 pid, 실패했으면 오류 원문과 대체안 결과.

- [ ] **Step 7: 임시 파일을 지운다**

```bash
rm desktop/src/probe-main.ts desktop/dist/probe-main.js desktop/dist/probe-main.js.map
```

- [ ] **Step 8: 커밋**

```bash
git add docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md
git commit -m "docs(desktop): API 기동 경로와 pnpm deploy 조합을 실측해 기록한다"
```

**Verify:**
- `desktop/build/api`에 트리 밖을 가리키는 심볼릭 링크가 0건이다.
- `node dist/main.js`와 선택된 Electron 기동 수단 양쪽에서 `/api/health`가 200이다.
- 결과 문서에 쓴 명령과 응답이 적혀 있다.

**Review:**
- 두 결정(기동 수단, deploy 형태)이 문서에 명시됐는가.
- 실험 코드가 저장소에 남지 않았는가.
- 실패한 대안도 이유와 함께 기록됐는가.

---

### Task 3: be에 HOST를 추가한다

**Files:**
- Modify: `be/src/config/env.ts`
- Modify: `be/src/main.ts`
- Test: `be/test/env.spec.ts` (없으면 만든다)

**Interfaces:**
- Consumes: 없음
- Produces: env 키 `HOST` (기본 `0.0.0.0`). Task 6이 `127.0.0.1`을 주입한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be`는 jest를 쓴다. 스펙 파일은 `be/jest.config.js`의 `roots` 때문에 **`be/test/` 바로 아래 평평하게** 둔다 — 기존 파일들이 전부 그 모양이다. `be/test/env.spec.ts`를 만든다.

`pnpm be test`는 `*.e2e-spec.ts`도 돌리며 그쪽은 testcontainers가 Docker를 쓴다. 파일 하나만 돌릴 때는 경로를 붙인다.

```ts
import { loadEnv } from '../src/config/env';

describe('loadEnv HOST', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved, DATABASE_URL: 'postgres://u:p@localhost:5432/d' };
  });
  afterAll(() => {
    process.env = saved;
  });

  it('defaults to 0.0.0.0 so the Docker image keeps working', () => {
    delete process.env.HOST;
    expect(loadEnv().HOST).toBe('0.0.0.0');
  });

  it('takes the injected value', () => {
    process.env.HOST = '127.0.0.1';
    expect(loadEnv().HOST).toBe('127.0.0.1');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm be test test/env.spec.ts`
Expected: FAIL — `HOST` 속성이 없다는 타입 오류 또는 `undefined` 반환.

- [ ] **Step 3: env.ts에 HOST를 넣는다**

`be/src/config/env.ts`의 `EnvSchema`에서 `PORT` 바로 아래에 넣는다.

```ts
  PORT: z.coerce.number().default(3000),
  // 기본값이 0.0.0.0인 것은 의도다 — deploy/api.Dockerfile의 컨테이너는 외부에서
  // 접근해야 한다. 데스크톱 앱만 127.0.0.1을 주입해 loopback으로 좁힌다.
  HOST: z.string().default('0.0.0.0'),
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `pnpm be test test/env.spec.ts`
Expected: PASS

- [ ] **Step 5: main.ts가 host를 전달하게 한다**

`be/src/main.ts` 끝부분의 두 줄을 바꾼다.

```ts
  await app.listen(env.PORT, env.HOST);
  Logger.log(`Damwha API listening on ${env.HOST}:${env.PORT} (docs at /docs)`, 'Bootstrap');
```

- [ ] **Step 6: 기존 테스트 전량을 돌린다**

Run: `pnpm be test`
Expected: 추가 전과 같이 통과.

- [ ] **Step 7: 기본 동작이 안 바뀌었는지 확인한다**

Run: `pnpm be:dev` (DB가 떠 있어야 한다)
Expected: 로그가 `Damwha API listening on 0.0.0.0:3000`. 확인 후 중단한다.

- [ ] **Step 8: 커밋**

```bash
git add be/src/config/env.ts be/src/main.ts be/test/env.spec.ts
git commit -m "feat(be): 바인드 host를 env로 받는다"
```

**Verify:**
- `pnpm be test` 전량 통과.
- `HOST` 미설정 시 `0.0.0.0`.
- `pnpm be:dev`의 로그가 `0.0.0.0:3000`.

**Review:**
- `HOST` 기본값이 `0.0.0.0`인가 — `127.0.0.1`이면 Docker 배포가 깨진다.
- `be` 변경이 이 두 파일과 테스트에 한정됐는가.

---

### Task 4: config.ts — config.json 읽기와 기본값 생성

**Files:**
- Create: `desktop/src/config.ts`
- Test: `desktop/tests/config.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ApiEnv = Record<string, string>`
  - `function defaultConfig(userDataDir: string): ApiEnv`
  - `interface LoadedConfig { env: ApiEnv; created: boolean; warning?: string }`
  - `function loadConfig(userDataDir: string): LoadedConfig`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultConfig, loadConfig } from "../src/config";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "damwha-config-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  it("puts storage under the user data directory as an absolute path", () => {
    const env = defaultConfig("/tmp/ud");
    expect(env.STORAGE_ROOT).toBe(path.join("/tmp/ud", "storage"));
    expect(path.isAbsolute(env.STORAGE_ROOT)).toBe(true);
  });

  it("carries the three keys the app owns defaults for", () => {
    expect(Object.keys(defaultConfig("/tmp/ud")).sort()).toEqual([
      "DATABASE_URL",
      "PORT",
      "STORAGE_ROOT",
    ]);
  });
});

describe("loadConfig", () => {
  it("creates config.json with the defaults on first run", () => {
    const r = loadConfig(dir);
    expect(r.created).toBe(true);
    expect(r.warning).toBeUndefined();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(onDisk.DATABASE_URL).toBe("postgres://postgres:postgres@localhost:5432/damwha");
    expect(onDisk.PORT).toBe("3000");
  });

  it("passes through keys that have no app default", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ SUMMARY_LLM_MODEL: "mlx-community/Qwen3.5-4B-8bit" }),
    );
    expect(loadConfig(dir).env.SUMMARY_LLM_MODEL).toBe("mlx-community/Qwen3.5-4B-8bit");
  });

  it("stringifies numbers and booleans because env values are strings", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ PORT: 4100, DEMO_READ_ONLY: false }));
    const env = loadConfig(dir).env;
    expect(env.PORT).toBe("4100");
    expect(env.DEMO_READ_ONLY).toBe("false");
  });

  it("resolves a relative STORAGE_ROOT against the user data directory", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ STORAGE_ROOT: "./audio" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe(path.join(dir, "audio"));
  });

  it("keeps an absolute STORAGE_ROOT as given", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ STORAGE_ROOT: "/srv/damwha" }));
    expect(loadConfig(dir).env.STORAGE_ROOT).toBe("/srv/damwha");
  });

  it("falls back to defaults on broken JSON without overwriting the file", () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{ not json");
    const r = loadConfig(dir);
    expect(r.created).toBe(false);
    expect(r.warning).toBeDefined();
    expect(r.env.PORT).toBe("3000");
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("warns when the file is valid JSON but not an object", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify([1, 2]));
    const r = loadConfig(dir);
    expect(r.warning).toBeDefined();
    expect(r.env.PORT).toBe("3000");
  });

  it("never returns a HOST key — the app injects that itself", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ HOST: "0.0.0.0" }));
    expect(loadConfig(dir).env.HOST).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm desktop test`
Expected: FAIL — `../src/config`를 찾을 수 없다.

- [ ] **Step 3: config.ts를 구현한다**

```ts
import * as fs from "fs";
import * as path from "path";

/** 자식 API에 넣을 환경변수. 값은 항상 문자열이다. */
export type ApiEnv = Record<string, string>;

export interface LoadedConfig {
  env: ApiEnv;
  /** config.json을 이번 실행에서 만들었으면 true */
  created: boolean;
  /** 파일이 있었지만 쓸 수 없어 기본값으로 진행한 이유 */
  warning?: string;
}

/** 앱이 기본값을 갖는 세 키. 그 밖의 키는 be/src/config/env.ts의 zod 기본값으로 떨어진다. */
export function defaultConfig(userDataDir: string): ApiEnv {
  return {
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/damwha",
    STORAGE_ROOT: path.join(userDataDir, "storage"),
    PORT: "3000",
  };
}

/**
 * HOST는 설정으로 열 수 없다 — 앱이 127.0.0.1을 고정 주입한다 (스펙 §6.6).
 * 여기서 걸러 내지 않으면 config.json 한 줄로 API가 LAN에 열린다.
 */
const APP_OWNED_KEYS = ["HOST"];

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function loadConfig(userDataDir: string): LoadedConfig {
  const file = path.join(userDataDir, "config.json");
  const defaults = defaultConfig(userDataDir);

  if (!fs.existsSync(file)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(defaults, null, 2)}\n`);
    return { env: defaults, created: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // 덮어쓰지 않는다 — 사용자가 직접 고칠 수 있어야 한다 (스펙 §8).
    return {
      env: defaults,
      created: false,
      warning: `config.json을 읽을 수 없어 기본값으로 실행합니다: ${reason(e)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      env: defaults,
      created: false,
      warning: "config.json이 객체가 아니라 기본값으로 실행합니다.",
    };
  }

  const env: ApiEnv = { ...defaults };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (APP_OWNED_KEYS.includes(key)) continue;
    if (typeof value === "string") env[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    // 그 밖의 타입은 무시한다. 값의 유효성은 API의 zod가 판정한다.
  }

  // 상대 경로가 남으면 packaged 앱의 cwd가 .app 안이라 번들 내부를 가리킨다 (스펙 §6.3).
  env.STORAGE_ROOT = path.resolve(userDataDir, env.STORAGE_ROOT);
  return { env, created: false };
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `pnpm desktop test`
Expected: PASS — 10건 전부.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/config.ts desktop/tests/config.test.ts
git commit -m "feat(desktop): userData의 config.json을 읽고 없으면 기본값으로 만든다"
```

**Verify:** `pnpm desktop test`가 config 테스트 10건을 통과한다.

**Review:**
- 깨진 `config.json`을 덮어쓰지 않는가.
- `STORAGE_ROOT`가 언제나 절대 경로로 나오는가.
- `HOST`가 파일로 주입되지 않는가.

---

### Task 5: port.ts — 후보 포트와 EADDRINUSE 판별

**Files:**
- Create: `desktop/src/port.ts`
- Test: `desktop/tests/port.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `function freePort(): Promise<number>`
  - `function choosePort(preferred: number, attempt: number, probe?: () => Promise<number>): Promise<number>`
  - `function isAddrInUse(text: string): boolean`
  - `const MAX_PORT_ATTEMPTS = 4`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, expect, it } from "vitest";
import * as net from "net";
import { MAX_PORT_ATTEMPTS, choosePort, freePort, isAddrInUse } from "../src/port";

describe("choosePort", () => {
  it("uses the preferred port on the first attempt", async () => {
    let probed = false;
    const port = await choosePort(3000, 0, async () => {
      probed = true;
      return 51000;
    });
    expect(port).toBe(3000);
    expect(probed).toBe(false);
  });

  it("probes for a port on later attempts", async () => {
    expect(await choosePort(3000, 1, async () => 51000)).toBe(51000);
    expect(await choosePort(3000, 2, async () => 51001)).toBe(51001);
  });

  it("rejects a port outside 1-65535", async () => {
    await expect(choosePort(0, 0)).rejects.toThrow(/preferred port/);
    await expect(choosePort(70000, 0)).rejects.toThrow(/preferred port/);
    await expect(choosePort(3.5, 0)).rejects.toThrow(/preferred port/);
  });

  it("rejects a negative attempt index", async () => {
    await expect(choosePort(3000, -1)).rejects.toThrow(/attempt/);
  });
});

describe("freePort", () => {
  it("returns a port nothing is listening on", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });
});

describe("isAddrInUse", () => {
  it("recognises the node bind error", () => {
    expect(isAddrInUse("Error: listen EADDRINUSE: address already in use 127.0.0.1:3000")).toBe(true);
  });

  it("does not match an unrelated startup failure", () => {
    expect(isAddrInUse("startup failed: database unreachable at postgres://...")).toBe(false);
    expect(isAddrInUse("")).toBe(false);
  });
});

describe("MAX_PORT_ATTEMPTS", () => {
  it("is a small finite number so the retry loop terminates", () => {
    expect(MAX_PORT_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_PORT_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm desktop test`
Expected: FAIL — `../src/port`를 찾을 수 없다.

- [ ] **Step 3: port.ts를 구현한다**

```ts
import * as net from "net";

/**
 * 고정 포트 1회 + 탐색 포트 3회. 상한이 없으면 EADDRINUSE가 반복될 때 무한 재기동이 된다
 * (스펙 R1-10).
 */
export const MAX_PORT_ATTEMPTS = 4;

/** OS에게 빈 포트를 물어본다. 닫은 직후 다른 프로세스가 가져갈 수 있으므로 판정은 자식의 bind가 한다. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("could not read the probe port")));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

export async function choosePort(
  preferred: number,
  attempt: number,
  probe: () => Promise<number> = freePort,
): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
    throw new Error(`invalid preferred port: ${preferred}`);
  }
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`invalid attempt index: ${attempt}`);
  }
  return attempt === 0 ? preferred : probe();
}

/** 포트 충돌과 다른 기동 실패를 갈라야 실패 화면이 옳은 원인을 말한다 (스펙 §6.4). */
export function isAddrInUse(text: string): boolean {
  return /EADDRINUSE/.test(text);
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `pnpm desktop test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/port.ts desktop/tests/port.test.ts
git commit -m "feat(desktop): 고정 포트 우선에 탐색 포트 폴백을 더한다"
```

**Verify:** `pnpm desktop test` 통과. `MAX_PORT_ATTEMPTS`가 유한하다.

**Review:**
- 판정을 미리 하지 않고 자식의 bind에 맡기는 구조인가.
- `isAddrInUse`가 `database unreachable`을 포트 충돌로 오인하지 않는가.

---

### Task 6: readiness.ts — 준비 판정 폴링

**Files:**
- Create: `desktop/src/readiness.ts`
- Test: `desktop/tests/readiness.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `type ProbeResult = "ready" | "db-unreachable" | "no-response"`
  - `type ReadyOutcome = { kind: "ready" } | { kind: "db-unreachable" } | { kind: "child-exited" } | { kind: "timeout" }`
  - `interface WaitOptions { probe; isAlive; timeoutMs; intervalMs; sleep?; now? }`
  - `function waitForReady(options: WaitOptions): Promise<ReadyOutcome>`
  - `function probeHealth(baseUrl: string, fetchImpl?): Promise<ProbeResult>`
  - `const READY_TIMEOUT_MS = 30_000`, `const READY_INTERVAL_MS = 250`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, expect, it, vi } from "vitest";
import { probeHealth, waitForReady } from "../src/readiness";

const never = () => Promise.resolve<never>(undefined as never);

function harness(results: Array<"ready" | "db-unreachable" | "no-response">, alive = true) {
  const calls: number[] = [];
  let clock = 0;
  return {
    calls,
    options: {
      probe: async () => results.shift() ?? "no-response",
      isAlive: () => alive,
      timeoutMs: 1000,
      intervalMs: 100,
      sleep: async (ms: number) => {
        calls.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

describe("waitForReady", () => {
  it("returns ready on the first successful probe", async () => {
    const h = harness(["ready"]);
    expect(await waitForReady(h.options)).toEqual({ kind: "ready" });
    expect(h.calls).toEqual([]);
  });

  it("keeps polling while there is no response", async () => {
    const h = harness(["no-response", "no-response", "ready"]);
    expect(await waitForReady(h.options)).toEqual({ kind: "ready" });
    expect(h.calls).toEqual([100, 100]);
  });

  it("reports db-unreachable without waiting further", async () => {
    const h = harness(["db-unreachable"]);
    expect(await waitForReady(h.options)).toEqual({ kind: "db-unreachable" });
  });

  it("gives up when the deadline passes", async () => {
    const h = harness([]);
    expect(await waitForReady(h.options)).toEqual({ kind: "timeout" });
  });

  it("stops immediately when the child is gone and never probes", async () => {
    const probe = vi.fn(never);
    const outcome = await waitForReady({
      probe,
      isAlive: () => false,
      timeoutMs: 1000,
      intervalMs: 100,
      sleep: async () => {},
      now: () => 0,
    });
    expect(outcome).toEqual({ kind: "child-exited" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("notices the child dying between probes", async () => {
    let alive = true;
    const outcome = await waitForReady({
      probe: async () => "no-response",
      isAlive: () => alive,
      timeoutMs: 1000,
      intervalMs: 100,
      sleep: async () => {
        alive = false;
      },
      now: () => 0,
    });
    expect(outcome).toEqual({ kind: "child-exited" });
  });
});

describe("probeHealth", () => {
  it("maps 200 to ready", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => ({ status: 200 }) as Response);
    expect(r).toBe("ready");
  });

  it("maps 503 to db-unreachable — the API is up but the DB is not", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => ({ status: 503 }) as Response);
    expect(r).toBe("db-unreachable");
  });

  it("maps a refused connection to no-response", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => {
      throw new Error("fetch failed");
    });
    expect(r).toBe("no-response");
  });

  it("maps any other status to no-response", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", async () => ({ status: 404 }) as Response);
    expect(r).toBe("no-response");
  });

  it("asks for /api/health under the given base", async () => {
    let asked = "";
    await probeHealth("http://127.0.0.1:4100", async (url) => {
      asked = String(url);
      return { status: 200 } as Response;
    });
    expect(asked).toBe("http://127.0.0.1:4100/api/health");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm desktop test`
Expected: FAIL — `../src/readiness`를 찾을 수 없다.

- [ ] **Step 3: readiness.ts를 구현한다**

```ts
export type ProbeResult = "ready" | "db-unreachable" | "no-response";

export type ReadyOutcome =
  | { kind: "ready" }
  | { kind: "db-unreachable" }
  | { kind: "child-exited" }
  | { kind: "timeout" };

/**
 * NestJS의 콜드 스타트는 이 기계에서 수 초다. 30초는 느린 첫 실행까지 덮는 값이고,
 * 250ms는 사람이 "멈췄다"고 느끼기 전에 상태가 바뀌게 하는 값이다. 실측치는 결과
 * 문서에 기록한다 (스펙 §12).
 */
export const READY_TIMEOUT_MS = 30_000;
export const READY_INTERVAL_MS = 250;

export interface WaitOptions {
  probe: () => Promise<ProbeResult>;
  /** 자식이 아직 살아 있나. 죽었으면 폴링을 계속할 이유가 없다. */
  isAlive: () => boolean;
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForReady(options: WaitOptions): Promise<ReadyOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;

  for (;;) {
    if (!options.isAlive()) return { kind: "child-exited" };
    const result = await options.probe();
    if (result === "ready") return { kind: "ready" };
    if (result === "db-unreachable") return { kind: "db-unreachable" };
    if (now() >= deadline) return { kind: "timeout" };
    await sleep(options.intervalMs);
  }
}

type FetchLike = (url: string) => Promise<{ status: number }>;

/**
 * 200은 API와 DB 둘 다 살아 있음, 503은 API만 살아 있음(be/src/health/health.controller.ts).
 * 부팅 프로브가 fail-fast라 503은 부팅 뒤 DB가 끊긴 경우에만 나온다 (스펙 §6.5).
 */
export async function probeHealth(
  baseUrl: string,
  fetchImpl: FetchLike = (url) => fetch(url),
): Promise<ProbeResult> {
  try {
    const { status } = await fetchImpl(`${baseUrl}/api/health`);
    if (status === 200) return "ready";
    if (status === 503) return "db-unreachable";
    return "no-response";
  } catch {
    return "no-response";
  }
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `pnpm desktop test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/readiness.ts desktop/tests/readiness.test.ts
git commit -m "feat(desktop): health와 자식 생존으로 준비 상태를 판정한다"
```

**Verify:** `pnpm desktop test` 통과. 자식 사망을 probe 없이 잡는다.

**Review:**
- 503을 `ready`로 취급하지 않는가.
- 자식 사망 검사가 probe보다 먼저인가.
- 타임아웃 루프가 유한한가.

---

### Task 7: origin.ts — origin 추출과 허용 판정

**Files:**
- Create: `desktop/src/origin.ts`
- Test: `desktop/tests/origin.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `function originOf(url: string): string | null`
  - `function isAllowedOrigin(url: string, allowed: readonly string[]): boolean`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
import { describe, expect, it } from "vitest";
import { isAllowedOrigin, originOf } from "../src/origin";

describe("originOf", () => {
  it("keeps the port because the app's port can change between runs", () => {
    expect(originOf("http://127.0.0.1:51734/meetings/mtg_5?u=utt_9")).toBe("http://127.0.0.1:51734");
  });

  it("returns null for a file URL — file has no usable origin", () => {
    expect(originOf("file:///Applications/Damwha.app/shell/status.html")).toBe(null);
  });

  it("returns null for garbage", () => {
    expect(originOf("not a url")).toBe(null);
    expect(originOf("")).toBe(null);
  });
});

describe("isAllowedOrigin", () => {
  const allowed = ["http://127.0.0.1:51734", "http://localhost:5173"];

  it("allows the API origin the window was loaded from", () => {
    expect(isAllowedOrigin("http://127.0.0.1:51734/meetings/mtg_5", allowed)).toBe(true);
  });

  it("allows the Vite dev server origin", () => {
    expect(isAllowedOrigin("http://localhost:5173/", allowed)).toBe(true);
  });

  it("rejects the same host on a different port", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000/", allowed)).toBe(false);
  });

  it("rejects a remote origin", () => {
    expect(isAllowedOrigin("https://example.com/", allowed)).toBe(false);
  });

  it("rejects a file URL", () => {
    expect(isAllowedOrigin("file:///etc/passwd", allowed)).toBe(false);
  });

  it("rejects everything when the allow list is empty", () => {
    expect(isAllowedOrigin("http://127.0.0.1:51734/", [])).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm desktop test`
Expected: FAIL — `../src/origin`을 찾을 수 없다.

- [ ] **Step 3: origin.ts를 구현한다**

```ts
/**
 * URL의 origin. file:은 origin이 "null"이라 쓸 수 없으므로 null을 돌려준다 —
 * 셸 화면은 file:로 뜨지만 권한이 필요 없다 (스펙 §6.6).
 */
export function originOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.origin;
}

export function isAllowedOrigin(url: string, allowed: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && allowed.includes(origin);
}
```

- [ ] **Step 4: 테스트 통과를 확인한다**

Run: `pnpm desktop test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/origin.ts desktop/tests/origin.test.ts
git commit -m "feat(desktop): 자기 origin 판정을 분리한다"
```

**Verify:** `pnpm desktop test` 통과.

**Review:** 포트가 다르면 거부하는가 — 폴백 포트를 쓰므로 origin은 실행마다 달라진다.

---

### Task 8: api-process.ts — 자식 API 기동과 종료

**Files:**
- Create: `desktop/src/api-process.ts`

**Interfaces:**
- Consumes: `ApiEnv` (Task 4)
- Produces:
  - `interface ApiHandle { pid: number | undefined; alive(): boolean; stderrTail(): string; exitCode(): number | null; stop(graceMs: number): Promise<void> }`
  - `interface LaunchOptions { entry: string; cwd: string; env: ApiEnv; logFile?: string }`
  - `function launchPackaged(options: LaunchOptions): ApiHandle`
  - `function launchDev(options: LaunchOptions): ApiHandle`

- [ ] **Step 1: api-process.ts를 쓴다**

Task 2가 `utilityProcess`를 통과시켰다고 가정한 코드다. 통과하지 못했다면 `launchPackaged`의 본문을 `launchDev`와 같은 `child_process.spawn` + `ELECTRON_RUN_AS_NODE=1`로 바꾸고, 그 사실을 결과 문서에 적는다.

```ts
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { utilityProcess, type UtilityProcess } from "electron";
import type { ApiEnv } from "./config";

export interface ApiHandle {
  readonly pid: number | undefined;
  alive(): boolean;
  /** 실패 화면에 올릴 stderr 꼬리. 사람이 읽을 마지막 줄이 여기서 나온다. */
  stderrTail(): string;
  exitCode(): number | null;
  stop(graceMs: number): Promise<void>;
}

export interface LaunchOptions {
  /** packaged면 Resources/api/dist/main.js. dev에서는 쓰이지 않는다. */
  entry: string;
  cwd: string;
  env: ApiEnv;
  /** 있으면 stdout·stderr를 여기에도 쓴다. */
  logFile?: string;
}

const TAIL_LIMIT = 8_000;

function makeSink(logFile?: string) {
  let tail = "";
  let out: fs.WriteStream | undefined;
  if (logFile !== undefined) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.createWriteStream(logFile, { flags: "a" });
  }
  return {
    write(chunk: Buffer | string, isError: boolean) {
      const text = chunk.toString();
      out?.write(text);
      if (isError) tail = (tail + text).slice(-TAIL_LIMIT);
    },
    tail: () => tail,
    close: () => out?.end(),
  };
}

/** SIGTERM으로 안 죽으면 SIGKILL. utilityProcess.kill()에는 신호 인자가 없다. */
async function escalate(pid: number | undefined, exited: () => boolean, graceMs: number): Promise<void> {
  const start = Date.now();
  while (!exited() && Date.now() - start < graceMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!exited() && pid !== undefined) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 이미 죽었으면 ESRCH — 무시한다.
    }
  }
}

export function launchPackaged(options: LaunchOptions): ApiHandle {
  const sink = makeSink(options.logFile);
  let code: number | null = null;
  const child: UtilityProcess = utilityProcess.fork(options.entry, [], {
    cwd: options.cwd,
    stdio: "pipe",
    env: { ...options.env, HOST: "127.0.0.1" },
  });
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (exitCode: number) => {
    code = exitCode;
    sink.close();
  });
  return {
    get pid() {
      return child.pid;
    },
    alive: () => code === null,
    stderrTail: sink.tail,
    exitCode: () => code,
    async stop(graceMs) {
      if (code !== null) return;
      child.kill();
      await escalate(child.pid, () => code !== null, graceMs);
    },
  };
}

/**
 * 개발에서는 nest start --watch를 쓴다 — 모듈이 아니라 CLI라 utilityProcess로 못 띄운다.
 * cwd는 pnpm --filter가 be/로 맞춰 주므로 be/.env가 오늘처럼 읽힌다 (스펙 §6.3).
 */
export function launchDev(options: LaunchOptions): ApiHandle {
  const sink = makeSink(options.logFile);
  let code: number | null = null;
  const child: ChildProcess = spawn("pnpm", ["--filter", "damwha-be", "run", "dev"], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env, HOST: "127.0.0.1" },
  });
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (exitCode) => {
    code = exitCode ?? 0;
    sink.close();
  });
  return {
    get pid() {
      return child.pid;
    },
    alive: () => code === null,
    stderrTail: sink.tail,
    exitCode: () => code,
    async stop(graceMs) {
      if (code !== null) return;
      // nest start --watch는 자식을 또 만든다. 프로세스 그룹째 보낸다.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      await escalate(child.pid, () => code !== null, graceMs);
    },
  };
}
```

- [ ] **Step 2: dev 종료가 손자 프로세스를 남기지 않는지 확인한다**

`launchDev`의 `process.kill(-pid)`는 자식이 프로세스 그룹 리더여야 동작한다. `spawn`에 `detached: true`를 주면 그룹이 생긴다. 확인하고 필요하면 추가한다.

Run:

```bash
pnpm --filter damwha-desktop run compile
node -e "
const { launchDev } = require('./desktop/dist/api-process.js');
const h = launchDev({ entry: '', cwd: process.cwd(), env: { PORT: '53010' } });
setTimeout(async () => {
  console.log('pid', h.pid);
  await h.stop(5000);
  console.log('exit', h.exitCode());
  setTimeout(() => {
    require('child_process').exec('pgrep -f \"nest start\"', (e, out) => console.log('leftover:', JSON.stringify(out.trim())));
  }, 1000);
}, 12000);
"
```

Expected: `leftover: ""`. 남으면 `spawn` 옵션에 `detached: true`를 넣고 다시 확인한다.

`require('electron')`이 Node에서 실패하므로 이 확인은 `api-process.js`의 `launchDev`만 부르는데도 모듈 최상단 import 때문에 막힐 수 있다. 막히면 `utilityProcess` import를 함수 안의 지연 `require`로 옮긴다.

```ts
function forkUtility(options: LaunchOptions) {
  // 모듈 최상단에서 electron을 import하면 Node에서 이 파일을 부를 수 없다.
  const { utilityProcess } = require("electron") as typeof import("electron");
  return utilityProcess.fork(/* ... */);
}
```

- [ ] **Step 3: 커밋**

```bash
git add desktop/src/api-process.ts
git commit -m "feat(desktop): 자식 API를 띄우고 정리한다"
```

**Verify:**
- `pnpm desktop lint`(= `tsc --noEmit`) 통과.
- `launchDev`로 띄운 API를 `stop()`한 뒤 `pgrep -f "nest start"`가 비어 있다.

**Review:**
- `HOST: "127.0.0.1"`이 `options.env` **뒤에** 있어 덮이지 않는가.
- SIGTERM 후 SIGKILL 에스컬레이션이 있는가.
- `stderrTail`이 무한히 자라지 않는가.
- dev 종료가 손자 프로세스를 남기지 않는가.

---

### Task 9: 셸 화면, 권한 경계, 메뉴

**Files:**
- Create: `desktop/shell/status.html`
- Create: `desktop/src/shell-window.ts`
- Create: `desktop/src/permissions.ts`
- Create: `desktop/src/menu.ts`

**Interfaces:**
- Consumes: `isAllowedOrigin` (Task 7)
- Produces:
  - `type ShellState = "starting" | "db-unreachable" | "failed"`
  - `interface ShellStatus { state: ShellState; detail?: string; retryInSeconds?: number; logPath?: string }`
  - `function showStatus(win: BrowserWindow, status: ShellStatus): Promise<void>`
  - `function lastMeaningfulLine(stderr: string): string`
  - `function applyPermissionBoundary(allowedOrigins: () => string[]): void`
  - `function applyNavigationBoundary(win: BrowserWindow, allowedOrigins: () => string[]): void`
  - `function installMenu(onRetry: () => void): void`

- [ ] **Step 1: 셸 화면을 만든다**

상태는 쿼리 문자열로 받는다. 본문 삽입은 전부 `textContent`다 — `detail`에 API의 stderr가 들어오므로 `innerHTML`을 쓰면 그 문자열이 마크업으로 해석된다.

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>담화</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; height: 100vh;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center; gap: 12px;
        font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif;
        background: #fbfbfa; color: #1c1b1a;
      }
      @media (prefers-color-scheme: dark) { body { background: #191817; color: #e8e6e3; } }
      h1 { font-size: 15px; font-weight: 600; margin: 0; }
      p { margin: 0; opacity: 0.72; max-width: 46ch; text-align: center; }
      pre {
        margin: 0; padding: 10px 12px; max-width: 70ch; overflow-x: auto;
        font-size: 12px; border-radius: 6px;
        background: rgba(127, 127, 127, 0.12);
      }
      .hint { font-size: 12px; opacity: 0.56; }
    </style>
  </head>
  <body>
    <h1 id="headline">담화를 준비하고 있어요</h1>
    <p id="body"></p>
    <pre id="detail" hidden></pre>
    <p class="hint" id="hint" hidden></p>
    <script>
      const q = new URLSearchParams(location.search);
      const state = q.get("state") ?? "starting";
      const copy = {
        starting: ["담화를 준비하고 있어요", "서비스가 뜨기를 기다리고 있어요."],
        "db-unreachable": [
          "데이터베이스에 연결할 수 없어요",
          "Postgres가 떠 있는지 확인해 주세요. 터미널에서 `pnpm db:up`으로 띄울 수 있어요.",
        ],
        failed: ["담화를 시작하지 못했어요", "아래 내용이 원인이에요."],
      };
      const [headline, body] = copy[state] ?? copy.failed;
      document.getElementById("headline").textContent = headline;
      document.getElementById("body").textContent = body;

      const detail = q.get("detail");
      if (detail) {
        const el = document.getElementById("detail");
        el.textContent = detail;
        el.hidden = false;
      }

      const parts = [];
      const retry = q.get("retryInSeconds");
      if (retry) parts.push(`${retry}초 뒤에 다시 시도해요.`);
      const log = q.get("logPath");
      if (log) parts.push(`로그: ${log}`);
      parts.push("메뉴의 서비스 > 다시 시도로 지금 재시도할 수 있어요.");
      const hint = document.getElementById("hint");
      hint.textContent = parts.join(" ");
      hint.hidden = false;
    </script>
  </body>
</html>
```

- [ ] **Step 2: shell-window.ts를 쓴다**

```ts
import { app, type BrowserWindow } from "electron";
import * as path from "path";

export type ShellState = "starting" | "db-unreachable" | "failed";

export interface ShellStatus {
  state: ShellState;
  /** API stderr의 마지막 줄 같은 원인 원문 */
  detail?: string;
  retryInSeconds?: number;
  logPath?: string;
}

function shellFile(): string {
  // app.getAppPath()는 dev에서 desktop/, packaged에서 app.asar을 가리킨다.
  return path.join(app.getAppPath(), "shell", "status.html");
}

export function showStatus(win: BrowserWindow, status: ShellStatus): Promise<void> {
  const query: Record<string, string> = { state: status.state };
  if (status.detail !== undefined) query.detail = status.detail;
  if (status.retryInSeconds !== undefined) query.retryInSeconds = String(status.retryInSeconds);
  if (status.logPath !== undefined) query.logPath = status.logPath;
  return win.loadFile(shellFile(), { query });
}

/** API stderr에서 사람에게 보여줄 마지막 의미 있는 줄. */
export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}
```

- [ ] **Step 3: permissions.ts를 쓴다**

```ts
import { session, shell, type BrowserWindow } from "electron";
import { isAllowedOrigin } from "./origin";

/**
 * 마이크만 허용하고 자기 origin에만 허용한다. 자동 부여라 포트가 바뀌어도 사용자가
 * 권한을 다시 묻지 않는다 — macOS TCC 권한은 .app 단위라 그대로 유지된다 (스펙 §6.4).
 */
export function applyPermissionBoundary(allowedOrigins: () => string[]): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === "media" && isAllowedOrigin(contents.getURL(), allowedOrigins()));
  });
  s.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return permission === "media" && allowedOrigins().includes(requestingOrigin);
  });
}

export function applyNavigationBoundary(win: BrowserWindow, allowedOrigins: () => string[]): void {
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedOrigin(url, allowedOrigins())) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 새 창을 만들지 않는다. 외부 링크는 기본 브라우저가 연다.
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}
```

`will-navigate`는 셸 화면(`file:`)에서 API origin으로 넘어가는 `loadFile`/`loadURL`에는 걸리지 않는다 — 그 둘은 프로그램이 호출하는 로드이고 `will-navigate`는 렌더러가 시작한 이동만 받는다.

- [ ] **Step 4: menu.ts를 쓴다**

```ts
import { Menu, type MenuItemConstructorOptions } from "electron";

/**
 * 재시도를 메뉴에 두는 이유: preload가 없어 렌더러에서 main을 부를 경로가 없다 (스펙 §6.5).
 * 메뉴는 main 프로세스 소유라 IPC가 필요 없다.
 */
export function installMenu(onRetry: () => void): void {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "서비스",
      submenu: [
        {
          label: "다시 시도",
          accelerator: "CmdOrCtrl+Alt+R",
          click: () => onRetry(),
        },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
```

- [ ] **Step 5: 타입 검사를 돌린다**

Run: `pnpm desktop lint`
Expected: 오류 없음.

- [ ] **Step 6: 셸 화면이 세 상태를 그리는지 눈으로 확인한다**

임시로 `main.ts`의 `createWindow` 뒤에 `showStatus(win, { state: "failed", detail: "startup failed: database unreachable at postgres://postgres:***@localhost:5432/damwha", logPath: "/tmp/api.log" })`를 넣고 `pnpm desktop:dev`로 띄운다. 세 `state` 값을 차례로 넣어 본다. 확인 후 임시 코드를 지운다.

Expected: 문안이 상태별로 바뀌고, `detail`이 코드 블록으로 보이며, 마크업으로 해석되지 않는다. `detail`에 `<b>x</b>`를 넣어 그대로 글자로 나오는지 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add desktop/shell desktop/src/shell-window.ts desktop/src/permissions.ts desktop/src/menu.ts
git commit -m "feat(desktop): 준비·오류 화면과 권한·네비게이션 경계를 넣는다"
```

**Verify:**
- `pnpm desktop lint` 통과.
- 셸 화면이 `starting`·`db-unreachable`·`failed` 세 상태를 각각 다르게 그린다.
- `detail`의 `<b>x</b>`가 글자로 보인다.

**Review:**
- 셸 화면이 `innerHTML`을 쓰지 않는가.
- 권한 핸들러가 `media` 외 권한을 전부 거부하는가.
- `setWindowOpenHandler`가 항상 `deny`를 돌려주는가.
- preload가 만들어지지 않았는가.

---

### Task 10: main.ts 배선 — 기동, 폴백, 자동 재시도, 종료

**Files:**
- Modify: `desktop/src/main.ts`

**Interfaces:**
- Consumes: Task 4~9의 전부
- Produces: 완성된 main 프로세스. dev와 packaged 양쪽에서 동작한다.

- [ ] **Step 1: main.ts를 다시 쓴다**

```ts
import { app, BrowserWindow } from "electron";
import * as path from "path";
import { loadConfig, type ApiEnv } from "./config";
import { MAX_PORT_ATTEMPTS, choosePort, isAddrInUse } from "./port";
import { READY_INTERVAL_MS, READY_TIMEOUT_MS, probeHealth, waitForReady } from "./readiness";
import { launchDev, launchPackaged, type ApiHandle } from "./api-process";
import { lastMeaningfulLine, showStatus } from "./shell-window";
import { applyNavigationBoundary, applyPermissionBoundary } from "./permissions";
import { installMenu } from "./menu";

/** 실패 후 자동 재시도 간격. 세 번째부터는 사람이 손 쓸 문제라 늘리지 않는다. */
const RETRY_DELAYS_MS = [3_000, 8_000, 20_000];
const STOP_GRACE_MS = 5_000;
/** 개발에서 렌더러는 Vite가 서빙한다. 그 포트는 Vite 기본값이다. */
const VITE_ORIGIN = "http://localhost:5173";

let win: BrowserWindow | null = null;
let api: ApiHandle | null = null;
let apiOrigin: string | null = null;
let retryCount = 0;
let retryTimer: NodeJS.Timeout | null = null;
let quitting = false;

function allowedOrigins(): string[] {
  const list: string[] = [];
  if (apiOrigin !== null) list.push(apiOrigin);
  if (!app.isPackaged) list.push(VITE_ORIGIN);
  return list;
}

function logFile(): string {
  return path.join(app.getPath("userData"), "logs", "api.log");
}

function apiRoot(): string {
  // packaged: Contents/Resources/api. dev: 저장소 루트 (pnpm --filter가 be/로 내려간다).
  return app.isPackaged
    ? path.join(process.resourcesPath, "api")
    : path.resolve(app.getAppPath(), "..");
}

function createWindow(): BrowserWindow {
  const created = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "담화",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyNavigationBoundary(created, allowedOrigins);
  return created;
}

function cancelRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

async function stopApi(): Promise<void> {
  const handle = api;
  api = null;
  apiOrigin = null;
  if (handle !== null) await handle.stop(STOP_GRACE_MS);
}

function scheduleRetry(): number | undefined {
  const delay = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
  retryCount += 1;
  cancelRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void start();
  }, delay);
  return Math.round(delay / 1000);
}

/** 한 포트로 한 번 시도한다. EADDRINUSE면 null을 돌려 호출자가 다음 포트로 넘어가게 한다. */
async function attempt(port: number, env: ApiEnv): Promise<"ready" | "db-unreachable" | "addr-in-use" | "failed"> {
  const launch = app.isPackaged ? launchPackaged : launchDev;
  api = launch({
    entry: path.join(apiRoot(), "dist", "main.js"),
    cwd: apiRoot(),
    env: { ...env, PORT: String(port) },
    logFile: logFile(),
  });
  const base = `http://127.0.0.1:${port}`;
  const outcome = await waitForReady({
    probe: () => probeHealth(base),
    isAlive: () => api?.alive() ?? false,
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: READY_INTERVAL_MS,
  });
  if (outcome.kind === "ready") {
    apiOrigin = base;
    return "ready";
  }
  if (outcome.kind === "db-unreachable") return "db-unreachable";
  if (outcome.kind === "child-exited" && isAddrInUse(api?.stderrTail() ?? "")) {
    await stopApi();
    return "addr-in-use";
  }
  return "failed";
}

async function start(): Promise<void> {
  if (win === null) return;
  const tail = () => lastMeaningfulLine(api?.stderrTail() ?? "");
  await stopApi();
  await showStatus(win, { state: "starting" });

  const { env, warning } = loadConfig(app.getPath("userData"));
  const preferred = Number(env.PORT) || 3000;

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i += 1) {
    const port = await choosePort(preferred, i);
    const result = await attempt(port, env);
    if (result === "ready") {
      retryCount = 0;
      const target = app.isPackaged ? `${apiOrigin}/` : VITE_ORIGIN;
      await win.loadURL(target);
      return;
    }
    if (result === "addr-in-use") continue;

    const detail = [warning, result === "db-unreachable" ? undefined : tail()]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" / ");
    const seconds = scheduleRetry();
    await stopApi();
    await showStatus(win, {
      state: result === "db-unreachable" ? "db-unreachable" : "failed",
      detail: detail.length > 0 ? detail : undefined,
      retryInSeconds: seconds,
      logPath: logFile(),
    });
    return;
  }

  const seconds = scheduleRetry();
  await showStatus(win, {
    state: "failed",
    detail: `${MAX_PORT_ATTEMPTS}번 시도했지만 쓸 수 있는 포트를 찾지 못했어요.`,
    retryInSeconds: seconds,
    logPath: logFile(),
  });
}

// 중복 실행 방지 — 두 번째 인스턴스는 창을 만들지 않고 기존 창을 앞으로 보낸다 (스펙 P1-C6).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    applyPermissionBoundary(allowedOrigins);
    installMenu(() => {
      retryCount = 0;
      cancelRetry();
      void start();
    });
    win = createWindow();
    win.on("closed", () => {
      win = null;
    });
    await start();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  // 앱이 만든 자식은 앱이 정리한다 (스펙 §6.2, P1-C5).
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    cancelRetry();
    event.preventDefault();
    void stopApi().then(() => app.quit());
  });
}
```

- [ ] **Step 2: 타입 검사를 돌린다**

Run: `pnpm desktop lint`
Expected: 오류 없음.

- [ ] **Step 3: DB를 내린 상태로 실패 화면을 확인한다**

```bash
pnpm db:down
pnpm desktop:dev
```

Expected: 창이 "담화를 시작하지 못했어요" 또는 "데이터베이스에 연결할 수 없어요"를 보이고, `detail`에 `database unreachable at postgres://postgres:***@localhost:5432/damwha`가 있고, 재시도 안내가 보인다. 로그 경로가 `~/Library/Application Support/Damwha/logs/api.log`다.

- [ ] **Step 4: DB를 올려 자동 재시도가 붙는지 확인한다**

앱을 띄운 채 다른 터미널에서:

```bash
pnpm db:up
```

Expected: 다음 자동 재시도에서 화면이 담화로 바뀐다. 기다리기 싫으면 메뉴의 **서비스 > 다시 시도**를 누른다.

- [ ] **Step 5: 종료 후 잔존 프로세스를 확인한다**

앱을 닫고:

```bash
pgrep -f "nest start" || echo "API 잔존 없음"
pgrep -f "damwha_worker" >/dev/null && echo "worker 살아 있음 (정상)"
```

Expected: API 잔존 없음. worker는 살아 있다.

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/main.ts
git commit -m "feat(desktop): API 기동·포트 폴백·자동 재시도·종료 정리를 배선한다"
```

**Verify:**
- DB 없이 띄우면 원인이 화면에 나온다.
- DB를 올리면 자동 재시도 또는 메뉴 재시도로 담화 화면에 도달한다.
- 앱 종료 후 API 잔존 0, worker 생존.
- 두 번 실행하면 창이 하나다.

**Review:**
- `before-quit`가 두 번 돌지 않는가 (`quitting` 가드).
- `addr-in-use`가 아닌 실패에서 포트 루프를 계속 돌지 않는가.
- `apiOrigin`이 `stopApi()`에서 비워져 허용 origin이 남지 않는가.
- 자동 재시도 타이머가 종료 시 취소되는가.

---

### Task 11: 개발 흐름 — Vite 기동과 API base URL 주입

**Files:**
- Modify: `desktop/src/main.ts`
- Create: `desktop/src/vite-process.ts`

**Interfaces:**
- Consumes: Task 10의 `main.ts`
- Produces:
  - `interface ViteOptions { cwd: string; apiBaseUrl: string }`
  - `function launchVite(options: ViteOptions): ApiHandle` — `ApiHandle`은 Task 8의 타입을 그대로 쓴다
  - `async function stopAll(): Promise<void>` (main.ts 안)

Task 10의 dev 경로는 Vite가 따로 떠 있다고 가정한다. 이 Task가 Vite도 앱이 띄우게 만들어 `pnpm desktop:dev` 한 줄로 끝나게 한다.

- [ ] **Step 1: vite-process.ts를 쓴다**

```ts
import { spawn } from "child_process";
import type { ApiHandle } from "./api-process";

export interface ViteOptions {
  /** 저장소 루트 */
  cwd: string;
  /** 예: http://127.0.0.1:51734/api */
  apiBaseUrl: string;
}

/**
 * Vite는 셸 환경변수가 .env 파일을 이긴다. 그래서 API 포트가 폴백돼도 렌더러가
 * 옳은 주소를 본다 (스펙 §11).
 */
export function launchVite(options: ViteOptions): ApiHandle {
  let code: number | null = null;
  let tail = "";
  const child = spawn("pnpm", ["--filter", "damwha-fe", "run", "dev"], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, VITE_API_BASE_URL: options.apiBaseUrl },
  });
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[vite] ${b}`));
  child.stderr?.on("data", (b: Buffer) => {
    tail = (tail + b.toString()).slice(-8_000);
    process.stderr.write(`[vite!] ${b}`);
  });
  child.on("exit", (exitCode) => {
    code = exitCode ?? 0;
  });
  return {
    get pid() {
      return child.pid;
    },
    alive: () => code === null,
    stderrTail: () => tail,
    exitCode: () => code,
    async stop(graceMs) {
      if (code !== null) return;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const start = Date.now();
      while (code === null && Date.now() - start < graceMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (code === null && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // 이미 죽었다.
        }
      }
    },
  };
}
```

- [ ] **Step 2: main.ts가 dev에서 Vite를 띄우게 한다**

`main.ts`에 상태와 배선을 추가한다.

```ts
import { launchVite } from "./vite-process";

let vite: ApiHandle | null = null;
```

`start()`의 `result === "ready"` 분기를 바꾼다.

```ts
    if (result === "ready") {
      retryCount = 0;
      if (app.isPackaged) {
        await win.loadURL(`${apiOrigin}/`);
      } else {
        if (vite === null) {
          vite = launchVite({ cwd: apiRoot(), apiBaseUrl: `${apiOrigin}/api` });
        }
        // Vite의 첫 서빙까지 기다린다 — 준비 판정과 같은 루프를 재사용한다.
        const up = await waitForReady({
          probe: async () => {
            try {
              const res = await fetch(VITE_ORIGIN);
              return res.status < 500 ? "ready" : "no-response";
            } catch {
              return "no-response";
            }
          },
          isAlive: () => vite?.alive() ?? false,
          timeoutMs: READY_TIMEOUT_MS,
          intervalMs: READY_INTERVAL_MS,
        });
        if (up.kind !== "ready") {
          await showStatus(win, {
            state: "failed",
            detail: `Vite를 띄우지 못했어요: ${lastMeaningfulLine(vite?.stderrTail() ?? "")}`,
            logPath: logFile(),
          });
          return;
        }
        await win.loadURL(VITE_ORIGIN);
      }
      return;
    }
```

`stopApi()`와 나란히 Vite도 정리한다.

```ts
async function stopAll(): Promise<void> {
  const v = vite;
  vite = null;
  await Promise.all([stopApi(), v === null ? Promise.resolve() : v.stop(STOP_GRACE_MS)]);
}
```

`before-quit`의 `stopApi()`를 `stopAll()`로 바꾼다. `start()` 안의 `await stopApi()`는 그대로 둔다 — 재시도할 때 Vite는 살려 둔다.

- [ ] **Step 3: 타입 검사와 실행을 확인한다**

Run: `pnpm desktop lint`
Expected: 오류 없음.

`pnpm db:up`이 떠 있는 상태에서:

Run: `pnpm desktop:dev`
Expected: 창이 준비 화면을 지나 담화 화면을 보인다. 터미널에 `[vite]` 로그가 있다. 브라우저를 따로 열지 않았다.

- [ ] **Step 4: 포트 폴백에서도 렌더러가 옳은 API를 부르는지 확인한다**

다른 터미널에서 3000을 점유한다.

```bash
pnpm be:dev
```

그 상태로 `pnpm desktop:dev`를 띄운다.

Expected: 앱이 3000이 아닌 포트로 API를 띄우고, 화면이 정상 동작한다. Electron 개발자 도구의 Network에서 요청 주소가 그 포트다.

- [ ] **Step 5: 종료 정리를 확인한다**

앱을 닫고:

```bash
pgrep -f "nest start" || echo "API 잔존 없음"
pgrep -f "vite" || echo "Vite 잔존 없음"
```

Expected: 둘 다 잔존 없음. 단, Step 4에서 손으로 띄운 `pnpm be:dev`는 살아 있어야 한다 — 그건 외부 소유다.

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/vite-process.ts desktop/src/main.ts
git commit -m "feat(desktop): 개발 실행이 Vite까지 띄우고 API 주소를 주입한다"
```

**Verify:**
- `pnpm desktop:dev` 한 줄로 창이 담화 화면까지 간다.
- 3000이 점유된 상태에서도 동작하고, 렌더러가 실제 포트를 부른다.
- 종료 후 API·Vite 잔존 0, 외부 API는 생존.

**Review:**
- `VITE_API_BASE_URL`이 실제 포트를 담는가.
- 재시도 때 Vite를 불필요하게 죽이지 않는가.
- 외부에서 띄운 API를 앱이 죽이지 않는가.

---

### Task 12: 패키징 파이프라인과 번들 위생 검사

**Files:**
- Create: `desktop/electron-builder.yml`
- Create: `desktop/scripts/package.mjs`
- Create: `desktop/scripts/check-bundle.mjs`

**Interfaces:**
- Consumes: Task 2의 `pnpm deploy` 결정, Task 10~11의 main
- Produces: `desktop/out/mac-arm64/Damwha.app`. `node scripts/check-bundle.mjs`가 P1-C11·P1-C12의 정적 항목을 판정한다.

- [ ] **Step 1: electron-builder.yml을 쓴다**

```yaml
# Phase 1은 서명 없는 .app까지만 만든다. dmg·서명·공증은 Phase 6 (스펙 §4.2).
appId: kr.damwha.app
productName: Damwha
directories:
  output: out
  buildResources: build-resources
# asar 안에는 컴파일된 main과 셸 화면만 들어간다. desktop에는 dependencies가 없으므로
# electron-builder가 훑을 prod 의존성이 없다 (스펙 P1-C11).
files:
  - dist/**/*
  - shell/**/*
  - package.json
# API 트리는 pnpm deploy 산출물을 통째로 복사한다. electron-builder는 내용을 해석하지 않는다.
extraResources:
  - from: build/api
    to: api
mac:
  target: dir
  category: public.app-category.productivity
  extendInfo:
    # 없으면 macOS가 마이크 요청 시 앱을 죽인다 (스펙 §6.6).
    NSMicrophoneUsageDescription: 담화가 회의를 녹음하려면 마이크를 사용해요. 녹음과 처리는 이 맥 안에서만 일어나요.
```

- [ ] **Step 2: package.mjs를 쓴다**

빌드 순서가 중요하다 — `nest build`가 `dist`를 비울 수 있으므로 SPA는 `pnpm deploy` **뒤에** 넣는다 (스펙 §11, R1-3).

```js
// desktop/scripts/package.mjs
// 순서: be build → fe build → pnpm deploy → SPA 복사 → electron-builder.
// pnpm deploy 뒤에 SPA를 넣는 이유: nest build가 dist를 비울 수 있다 (스펙 R1-3).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const apiTree = path.join(desktop, "build", "api");

function run(cmd, args, cwd = repo, extraEnv = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...extraEnv } });
}

run("pnpm", ["--filter", "damwha-be", "run", "build"]);
// fe/.env 의 VITE_API_BASE_URL 은 절대 URL이다. 셸 환경변수가 .env 파일을 이기므로
// 여기서 덮어 단일 origin 빌드를 만든다 (스펙 §11).
run("pnpm", ["--filter", "damwha-fe", "run", "build"], repo, { VITE_API_BASE_URL: "/api" });

fs.rmSync(apiTree, { recursive: true, force: true });
// Task 2가 확정한 형태를 쓴다. --config.node-linker=hoisted나 --legacy가 필요했다면
// 결과 문서의 Task 2 표에 적힌 대로 여기 인자를 맞춘다.
run("pnpm", ["--filter=damwha-be", "--prod", "deploy", path.relative(repo, apiTree)]);

const publicDir = path.join(apiTree, "dist", "public");
fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(path.join(repo, "fe", "dist"), publicDir, { recursive: true });
console.log(`SPA copied into ${path.relative(repo, publicDir)}`);

run("pnpm", ["exec", "electron-builder", "--dir"], desktop);
run("node", [path.join("scripts", "check-bundle.mjs")], desktop);
```

- [ ] **Step 3: check-bundle.mjs를 쓴다**

```js
// desktop/scripts/check-bundle.mjs
// P1-C11(번들 위생)과 P1-C12의 정적 항목을 판정한다. 실패하면 exit 1.
import * as asar from "@electron/asar";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
const appDir = path.join(desktop, "out", "mac-arm64", "Damwha.app");
const contents = path.join(appDir, "Contents");
const apiDir = path.join(contents, "Resources", "api");

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// 1. desktop 패키지에 runtime 의존성이 없다
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
check("desktop has no runtime dependencies", deps.length === 0, deps.join(", "));

// 2. app.asar 안에 node_modules가 없다
const asarPath = path.join(contents, "Resources", "app.asar");
check("app.asar exists", fs.existsSync(asarPath));
if (fs.existsSync(asarPath)) {
  const entries = asar.listPackage(asarPath, { isPack: false });
  const bundled = entries.filter((e) => e.split("/").includes("node_modules"));
  check("app.asar has no node_modules", bundled.length === 0, `${bundled.length} entries`);
}

// 3. API 트리 밖을 가리키는 심볼릭 링크가 없다
const realApi = fs.realpathSync(apiDir);
const links = execFileSync("find", [apiDir, "-type", "l"], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.length > 0);
const escaping = links.filter((link) => {
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return true; // 깨진 링크도 위반이다
  }
  return !target.startsWith(realApi);
});
check("no symlink escapes the api tree", escaping.length === 0, escaping.slice(0, 5).join(", "));
console.log(`      (${links.length} symlink(s) inside the tree — allowed)`);

// 4. 저장소 경로와 pnpm store 경로 문자열이 없다
for (const needle of [repo, path.join(process.env.HOME ?? "", ".pnpm-store"), "/.pnpm/"]) {
  if (needle.length < 4) continue;
  let hits = "";
  try {
    hits = execFileSync("grep", ["-rlF", needle, contents], { encoding: "utf8" });
  } catch {
    hits = ""; // grep은 결과가 없으면 exit 1
  }
  const files = hits.split("\n").filter((l) => l.length > 0);
  check(`no "${needle}" in the bundle`, files.length === 0, files.slice(0, 5).join(", "));
}

// 5. SPA가 API 트리에 들어갔다
check("SPA is inside the api tree", fs.existsSync(path.join(apiDir, "dist", "public", "index.html")));

// 6. 마이크 사용 설명이 Info.plist에 있다
let usage = "";
try {
  usage = execFileSync(
    "plutil",
    ["-extract", "NSMicrophoneUsageDescription", "raw", "-o", "-", path.join(contents, "Info.plist")],
    { encoding: "utf8" },
  ).trim();
} catch {
  usage = "";
}
check("Info.plist carries NSMicrophoneUsageDescription", usage.length > 0, usage);

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle hygiene check(s) failed.`);
  process.exit(1);
}
console.log("\nBundle hygiene: all checks passed.");
```

- [ ] **Step 4: 빌드를 돌린다**

Run: `pnpm desktop:build`
Expected: `desktop/out/mac-arm64/Damwha.app`이 생기고 `check-bundle.mjs`가 전부 PASS로 끝난다.

`app.asar has no node_modules`가 실패하면 `electron-builder.yml`의 `files` 목록을 확인한다. `no symlink escapes the api tree`가 실패하면 Task 2의 대안 인자를 `package.mjs`에 반영한다.

- [ ] **Step 5: .app을 실행한다**

```bash
open desktop/out/mac-arm64/Damwha.app
```

Expected: 창이 뜨고 담화 화면까지 간다. `~/Library/Application Support/Damwha/config.json`이 만들어졌고 `storage/`가 생겼다.

서명이 없어 macOS가 막으면 Gatekeeper 경고가 나올 수 있다. 로컬 빌드라 `xattr -dr com.apple.quarantine desktop/out/mac-arm64/Damwha.app` 후 다시 연다. 이 조치가 필요했는지 결과 문서에 적는다.

- [ ] **Step 6: 커밋**

```bash
git add desktop/electron-builder.yml desktop/scripts/
git commit -m "feat(desktop): .app 빌드 파이프라인과 번들 위생 검사를 넣는다"
```

**Verify:**
- `pnpm desktop:build`가 `.app`을 만들고 위생 검사 전부 PASS.
- `open`으로 `.app`이 담화 화면까지 간다.
- `<userData>/config.json`이 기본값으로 생성됐다.

**Review:**
- SPA 복사가 `pnpm deploy` 뒤인가.
- `fe` 빌드가 `VITE_API_BASE_URL=/api`로 돌았는가 — `.app`의 `index.html`이 참조하는 JS에서 절대 URL이 없어야 한다.
- `extraResources`가 API 트리를 `Resources/api`로 넣는가.
- 위생 검사가 실패 시 exit 1인가.

---

### Task 13: 통합 검증과 결과 기록

스펙 §9의 완료 기준 P1-C1 ~ P1-C14 전량을 수행하고 증거를 남긴다.

**Files:**
- Modify: `docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md`
- Modify: `docs/electron-migration-roadmap.md` (Phase 1 상태)

**Interfaces:**
- Consumes: Task 1~12 전부
- Produces: 판정이 채워진 결과 문서.

- [ ] **Step 1: 선행 조건을 갖춘다**

```bash
pnpm db:up
# be/worker/.env 의 STORAGE_ROOT 를 앱과 같은 절대 경로로 맞춘다
grep STORAGE_ROOT be/worker/.env
pnpm be:migrate
```

`be/worker/.env`가 아직 `../storage`면 아래로 바꾼다. **이 파일은 gitignore 대상이라 커밋되지 않는다.**

```
STORAGE_ROOT=/Users/<사용자>/Library/Application Support/Damwha/storage
```

그 뒤 `pnpm worker`, `pnpm embed`를 각 터미널에서 띄운다.

- [ ] **Step 2: P1-C14의 사전 스냅샷을 뜬다**

앱을 아직 실행하지 않은 상태에서 한다. **이 단계를 건너뛰면 P1-C14를 판정할 수 없다.**

```bash
mkdir -p /tmp/p1-evidence
cd be/storage && find . -type f -exec shasum -a 256 {} \; | sort > /tmp/p1-evidence/storage-before.txt; cd -
wc -l /tmp/p1-evidence/storage-before.txt
psql postgres://postgres:postgres@localhost:5432/damwha -At -c \
  "select 'meeting', count(*) from meeting union all select 'utterance', count(*) from utterance union all select '_migrations', count(*) from _migrations" \
  > /tmp/p1-evidence/rows-before.txt
docker compose -f be/docker-compose.yml config | grep -E "^name:|pgdata" > /tmp/p1-evidence/compose-before.txt
cat /tmp/p1-evidence/rows-before.txt /tmp/p1-evidence/compose-before.txt
```

- [ ] **Step 3: 실사용 기준 4건을 수행한다 (P1-C1 ~ P1-C4)**

```bash
pnpm desktop:build
open desktop/out/mac-arm64/Damwha.app
```

순서대로 한다. 각 단계에서 화면을 캡처해 `/tmp/p1-evidence/`에 둔다.

1. **P1-C1** — 터미널 명령 없이 창이 담화 화면까지 간다.
2. **P1-C2** — 오디오 파일로 회의를 만들고 처리가 끝날 때까지 둔다. 전사 결과가 화면에 뜬다.
3. **P1-C3** — 라이브 녹음을 시작한다. macOS 마이크 권한 대화상자가 뜨고 문구가 `NSMicrophoneUsageDescription`의 것이다. 허가 후 녹음·중단하고 결과를 본다.
4. **P1-C4** — 검색어를 넣어 키워드·의미 결과가 섞여 나오는지 본다.

- [ ] **Step 4: 프로세스 소유권 2건을 수행한다 (P1-C5, P1-C6)**

```bash
# 앱이 떠 있는 상태에서
pgrep -fl "dist/main.js" > /tmp/p1-evidence/procs-running.txt
pgrep -fl "damwha_worker\|damwha-embed" >> /tmp/p1-evidence/procs-running.txt
# 두 번째 인스턴스
open desktop/out/mac-arm64/Damwha.app
# 창이 하나인지, API 프로세스가 하나인지 확인
pgrep -c -f "dist/main.js"
```

Expected: 창 하나, `dist/main.js` 프로세스 1개.

앱을 닫고:

```bash
pgrep -fl "dist/main.js" || echo "API 잔존 없음"
pgrep -fl "damwha_worker\|damwha-embed" || echo "경고: worker/embed가 죽었다 — P1-C5 실패"
```

- [ ] **Step 5: 실패 표시 2건을 수행한다 (P1-C7, P1-C8)**

```bash
pnpm db:down
open desktop/out/mac-arm64/Damwha.app
```

Expected: 화면이 DB 연결 실패를 말하고 `database unreachable at …` 원문이 보인다. 로그 경로가 보인다. 앱을 닫고 `pnpm db:up` 후 다시 열면 정상 화면.

```bash
# P1-C8 — 다른 기동 실패
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / "Library/Application Support/Damwha/config.json"
c = json.loads(p.read_text())
c["SUMMARY_LLM_MODEL"] = "not-in-the-catalog"
p.write_text(json.dumps(c, indent=2) + "\n")
PY
open desktop/out/mac-arm64/Damwha.app
```

Expected: 기동 실패 화면. `detail`이 zod 검증 실패를 말하며 **P1-C7의 DB 문안과 다르다.** 확인 후 그 키를 지운다.

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / "Library/Application Support/Damwha/config.json"
c = json.loads(p.read_text())
c.pop("SUMMARY_LLM_MODEL", None)
p.write_text(json.dumps(c, indent=2) + "\n")
PY
```

- [ ] **Step 6: 경계 4건을 수행한다 (P1-C9 ~ P1-C12)**

```bash
# P1-C9 — 로컬 바인드
open desktop/out/mac-arm64/Damwha.app
PORT=$(lsof -nP -iTCP -sTCP:LISTEN | grep -E "Damwha|dist/main" | head -1)
echo "$PORT"   # 127.0.0.1:<port> 여야 한다. *:<port>면 실패
LAN=$(ipconfig getifaddr en0)
curl -sS -m 3 "http://$LAN:3000/api/health" && echo "실패: LAN에서 응답했다" || echo "LAN 접속 거부 — 정상"
```

```bash
# P1-C10 — 포트 폴백
pnpm be:dev &     # 3000 점유
open desktop/out/mac-arm64/Damwha.app
lsof -nP -iTCP -sTCP:LISTEN | grep -E "Damwha|dist/main"
```

Expected: 앱이 3000이 아닌 포트다. 마이크 권한을 다시 묻지 않는다. 앱을 닫은 뒤 손으로 띄운 `pnpm be:dev`가 살아 있다.

```bash
# P1-C11 — 번들 위생
pnpm --filter damwha-desktop exec node scripts/check-bundle.mjs
```

```bash
# P1-C12 — 경로 위생
find desktop/out/mac-arm64/Damwha.app -newer desktop/out/mac-arm64/Damwha.app/Contents/Info.plist -type f | head
ps eww -o command $(pgrep -f "dist/main.js" | head -1) | tr ' ' '\n' | grep -E "STORAGE_ROOT|DATABASE_URL|HOST"
```

Expected: `.app` 안에 새 파일이 없다. 주입값이 절대 경로·절대 주소이고 `HOST=127.0.0.1`이다.

- [ ] **Step 7: 회귀와 데이터 보존 2건을 수행한다 (P1-C13, P1-C14)**

```bash
# P1-C13
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev        # Electron 창이 뜨지 않는지 확인 후 중단
docker build -f deploy/api.Dockerfile -t damwha-api:p1-check .
```

```bash
# P1-C14 — 사후 스냅샷
cd be/storage && find . -type f -exec shasum -a 256 {} \; | sort > /tmp/p1-evidence/storage-after.txt; cd -
diff /tmp/p1-evidence/storage-before.txt /tmp/p1-evidence/storage-after.txt && echo "be/storage 무변경 — 정상"
psql postgres://postgres:postgres@localhost:5432/damwha -At -c \
  "select 'meeting', count(*) from meeting union all select 'utterance', count(*) from utterance union all select '_migrations', count(*) from _migrations" \
  > /tmp/p1-evidence/rows-after.txt
diff /tmp/p1-evidence/rows-before.txt /tmp/p1-evidence/rows-after.txt
docker compose -f be/docker-compose.yml config | grep -E "^name:|pgdata" > /tmp/p1-evidence/compose-after.txt
diff /tmp/p1-evidence/compose-before.txt /tmp/p1-evidence/compose-after.txt && echo "compose 무변경 — 정상"
```

Expected: `be/storage`가 한 건도 다르지 않다. `_migrations` 행 수가 같다. `meeting`·`utterance`는 늘기만 했다(줄면 실패). compose `name`과 볼륨이 같다.

- [ ] **Step 8: 결과 문서를 채운다**

`docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md`에 쓴다.

- "단계별 실행·리뷰" — Task 1~12 각각의 커밋 범위, 검토자, 지적, 조치, 통과 여부.
- "최종 검증" — P1-C1 ~ P1-C14의 판정 표. 각 행에 실행한 명령과 관찰된 값. 통과하지 못한 기준은 **통과로 적지 않는다.**
- 실측으로 확정된 값 — `READY_TIMEOUT_MS`·`READY_INTERVAL_MS`의 실제 콜드 스타트 소요, `RETRY_DELAYS_MS`, `MAX_PORT_ATTEMPTS`, 쓴 `pnpm deploy` 형태, 선택된 자식 기동 수단, `.app` 용량, Gatekeeper 조치 필요 여부.
- "남은 제약·후속 Phase 인계" — 기존 회의 오디오 404(Phase 5), CORS와 API 인증(Phase 6), `be/worker/.env`를 손으로 맞춰야 하는 것(Phase 2·4).

- [ ] **Step 9: 로드맵 상태를 갱신한다**

`docs/electron-migration-roadmap.md`의 Phase 1 "상태" 문단을 실제 결과로 바꾼다. 완료 기준 3개에 대한 충족·부분·미충족을 표로 적고, 부분이면 무엇이 남았는지 쓴다.

- [ ] **Step 10: 커밋**

```bash
git add docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md docs/electron-migration-roadmap.md
git commit -m "docs: Electron Phase 1 통합 검증 결과를 기록한다"
```

**Verify:**
- P1-C1 ~ P1-C14 열네 행이 모두 판정과 증거를 갖는다.
- `be/storage` diff가 비어 있다.
- `pnpm build`·`pnpm test`·`pnpm lint`·Docker 이미지 빌드가 통과한다.

**Review:**
- 실행하지 않은 검증을 통과로 적지 않았는가.
- 실측치가 코드의 상수와 일치하는가.
- 로드맵 상태가 실제 판정과 어긋나지 않는가.

---

## 스펙 완료 기준과 Task 대응

| 기준 | 구현 Task | 검증 Task |
| --- | --- | --- |
| P1-C1 앱 아이콘 실행 | 1, 10, 12 | 13 Step 3 |
| P1-C2 업로드와 처리 | 10, 12 | 13 Step 3 |
| P1-C3 녹음 | 9, 12 | 13 Step 3 |
| P1-C4 검색 | 10, 12 | 13 Step 3 |
| P1-C5 자식 정리·외부 보존 | 8, 10, 11 | 13 Step 4 |
| P1-C6 중복 실행 방지 | 10 | 13 Step 4 |
| P1-C7 DB 미기동 원인 표시 | 6, 9, 10 | 13 Step 5 |
| P1-C8 다른 기동 실패 표시 | 8, 9, 10 | 13 Step 5 |
| P1-C9 로컬 바인드 | 3, 8 | 13 Step 6 |
| P1-C10 포트 폴백 | 5, 10, 11 | 13 Step 6 |
| P1-C11 번들 위생 | 1, 12 | 12 Step 4, 13 Step 6 |
| P1-C12 경로 위생 | 4, 10, 12 | 13 Step 6 |
| P1-C13 웹 흐름 회귀 없음 | 1, 3 | 1 Step 10, 13 Step 7 |
| P1-C14 기존 데이터 보존 | 4 (STORAGE_ROOT 분리) | 13 Step 2, Step 7 |

## 스펙 위험과 Task 대응

| 위험 | 닫는 Task |
| --- | --- |
| R1-1 `utilityProcess`로 NestJS가 안 뜬다 | 2 |
| R1-2 `pnpm deploy` 트리가 불완전하다 | 2 |
| R1-3 `nest build`가 `dist/public`을 지운다 | 12 (순서 고정) |
| R1-4 상대 경로가 번들 내부를 가리킨다 | 4, 13 Step 6 |
| R1-5 electron-builder가 pnpm 레이아웃에서 실패한다 | 1 (`dependencies` 비움), 12 |
| R1-6 폴백 후 마이크 권한 재요청 | 9, 13 Step 6 |
| R1-7 `STORAGE_ROOT` 불일치로 조용한 실패 | 13 Step 1 (선행 조건) |
| R1-8 `sandbox: true`가 `getUserMedia`를 막는다 | 13 Step 3 |
| R1-9 `pnpm deploy`가 Experimental | 2, 12 |
| R1-10 `EADDRINUSE`를 못 가른다 | 5, 10 |
| R1-11 외부 API를 자기 것으로 오인 | 10, 13 Step 6 |
