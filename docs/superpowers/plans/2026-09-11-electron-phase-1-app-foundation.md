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
    "test": "vitest run --passWithNoTests",
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

Expected: `desktop`의 vitest가 참여하고 exit 0으로 끝난다. 테스트 파일이 아직 없으므로 `--passWithNoTests`가 필요하다 — 없으면 `vitest run`이 exit 1이 되어 루트 `pnpm test`(P1-C13의 관문)를 깬다.

- [ ] **Step 11: P1-C14의 보존 기준선을 뜬다**

**이 Task에서 떠야 한다.** Task 10부터 API 자식이 실제로 돌고 Task 12가 `.app`을 실행하므로, 그 뒤에 뜬 스냅샷은 "앱이 `be/storage`에 쓰지 않았다"를 증명하지 못한다. 이 Task의 빈 창은 API를 띄우지 않아 아무것도 쓰지 않는다 — 기준선을 뜰 수 있는 마지막 시점이다.

`/tmp`는 재부팅에 비워지므로 쓰지 않는다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
mkdir -p "$EV"
date -u +%Y-%m-%dT%H:%M:%SZ > "$EV/baseline-taken-at.txt"
( cd be/storage && find . -type f -exec shasum -a 256 {} \; | sort ) > "$EV/storage-before.txt"
wc -l < "$EV/storage-before.txt"
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -At -F, -c \
  "select 'meeting', count(*) from meeting union all select 'utterance', count(*) from utterance union all select '_migrations', count(*) from _migrations" \
  | sort > "$EV/rows-before.txt"
docker compose -f be/docker-compose.yml config | grep -E "^name:|pgdata" | sort > "$EV/compose-before.txt"
cat "$EV/rows-before.txt" "$EV/compose-before.txt"
```

Expected: `storage-before.txt`가 비어 있지 않다(기존 회의가 있다면). `rows-before.txt`에 세 줄. `compose-before.txt`에 `name: damwha`와 `pgdata`가 있다.

DB가 안 떠 있으면 `pnpm db:up` 후 다시 한다. **`storage-before.txt`가 빈 파일이면 기준선이 무의미하다** — `be/storage`에 파일이 정말 없는지 `ls be/storage/meetings`로 확인하고 결과 문서에 그 사실을 적는다.

- [ ] **Step 12: 커밋**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml desktop/
git commit -m "feat(desktop): damwha-desktop 패키지를 만들고 빈 창을 띄운다"
```

증거 파일은 `~/.cache/damwha-p1-evidence/`에 있고 커밋하지 않는다 — 개인 녹음의 체크섬이다.

**Verify:**
- `pnpm desktop:dev`로 창이 뜬다.
- `pnpm dev`가 Electron 창을 띄우지 않는다.
- `pnpm build`가 `desktop/out`을 만들지 않는다.
- `desktop/package.json`에 `dependencies` 키가 없다.
- `~/.cache/damwha-p1-evidence/`에 `storage-before.txt`·`rows-before.txt`·`compose-before.txt`·`baseline-taken-at.txt` 넷이 있다.

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
  - `const READY_TIMEOUT_MS = 30_000`, `const READY_INTERVAL_MS = 250`, `const PROBE_TIMEOUT_MS = 2_000`

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

  it("times out even when a probe never settles", async () => {
    // 연결은 됐지만 응답이 없는 API가 이 형태다. probe 반환 뒤에만 deadline을 보면
    // 영원히 매달린다.
    const outcome = await waitForReady({
      probe: () => new Promise<never>(() => {}),
      isAlive: () => true,
      timeoutMs: 60,
      intervalMs: 10,
      probeTimeoutMs: 20,
    });
    expect(outcome).toEqual({ kind: "timeout" });
  }, 2_000);

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

  it("gives up on a request that never settles", async () => {
    const r = await probeHealth("http://127.0.0.1:3000", () => new Promise<never>(() => {}), 30);
    expect(r).toBe("no-response");
  }, 2_000);

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
/**
 * 개별 probe의 상한. 소켓은 붙었는데 응답이 없는 API가 실제로 있으며, 그 경우
 * fetch는 스스로 끝나지 않는다. 이 상한이 없으면 READY_TIMEOUT_MS에 도달하지 못한다.
 */
export const PROBE_TIMEOUT_MS = 2_000;

export interface WaitOptions {
  probe: () => Promise<ProbeResult>;
  /** 자식이 아직 살아 있나. 죽었으면 폴링을 계속할 이유가 없다. */
  isAlive: () => boolean;
  timeoutMs: number;
  intervalMs: number;
  /** 개별 probe의 상한. 기본 PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function waitForReady(options: WaitOptions): Promise<ReadyOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const deadline = now() + options.timeoutMs;
  const remaining = () => deadline - now();

  for (;;) {
    if (!options.isAlive()) return { kind: "child-exited" };
    if (remaining() <= 0) return { kind: "timeout" };
    // probe가 스스로 끝나지 않을 수 있으므로 상한과 경주시킨다. probe에 자체 상한이
    // 있어도 이중으로 막는다 — 루프가 멈추는 것이 probe 구현에 의존하면 안 된다.
    // 주입된 sleep을 쓰지 않는 이유: 테스트의 가짜 시계를 밀어 버린다.
    const result = await Promise.race([options.probe(), noResponseAfter(probeTimeoutMs)]);
    if (result === "ready") return { kind: "ready" };
    if (result === "db-unreachable") return { kind: "db-unreachable" };
    if (remaining() <= 0) return { kind: "timeout" };
    await sleep(options.intervalMs);
  }
}

function noResponseAfter(ms: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("no-response"), ms);
    // 매 회차마다 타이머가 쌓이지 않게 한다. probe가 먼저 끝나면 이 promise는 버려진다.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

type FetchLike = (url: string, init?: { signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * 200은 API와 DB 둘 다 살아 있음, 503은 API만 살아 있음(be/src/health/health.controller.ts).
 * 부팅 프로브가 fail-fast라 503은 부팅 뒤 DB가 끊긴 경우에만 나온다 (스펙 §6.5).
 */
export async function probeHealth(
  baseUrl: string,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  // 소켓은 붙었는데 응답이 없으면 fetch는 스스로 끝나지 않는다. abort로 실제 요청을
  // 끊고, race로 호출자에게는 시간 안에 돌려준다 — signal을 무시하는 구현도 막힌다.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const status = await Promise.race([
      fetchImpl(`${baseUrl}/api/health`, { signal: controller.signal }).then((r) => r.status),
      expired,
    ]);
    if (status === 200) return "ready";
    if (status === 503) return "db-unreachable";
    return "no-response";
  } catch {
    return "no-response";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
  - `interface ApiHandle { pid: number | undefined; alive(): boolean; stderrTail(): string; exitCode(): number | null; onExit(listener: (code: number) => void): void; stop(graceMs: number): Promise<void> }`
  - `interface LaunchOptions { entry: string; cwd: string; env: ApiEnv; logFile?: string }`
  - `function launchPackaged(options: LaunchOptions): ApiHandle`
  - `function launchDev(options: LaunchOptions): ApiHandle`

- [ ] **Step 1: api-process.ts를 쓴다**

Task 2가 `utilityProcess`를 통과시켰다고 가정한 코드다. 통과하지 못했다면 `launchPackaged`의 본문을 `launchDev`와 같은 `child_process.spawn` + `ELECTRON_RUN_AS_NODE=1`로 바꾸고, 그 사실을 결과 문서에 적는다.

```ts
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { UtilityProcess } from "electron";
import type { ApiEnv } from "./config";

/**
 * electron을 모듈 최상단에서 값으로 import하지 않는다. 그러면 이 파일을 평범한 Node에서
 * 부를 수 없고, launchDev의 프로세스 그룹 종료를 Electron 밖에서 검증할 수 없다.
 * 타입만 최상단에서 가져오고 값은 쓰는 자리에서 받는다.
 */
function electronUtilityProcess() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require("electron") as typeof import("electron")).utilityProcess;
}

export interface ApiHandle {
  readonly pid: number | undefined;
  alive(): boolean;
  /** 실패 화면에 올릴 stderr 꼬리. 사람이 읽을 마지막 줄이 여기서 나온다. */
  stderrTail(): string;
  exitCode(): number | null;
  /**
   * 종료 알림. ready 뒤에 죽는 경우를 화면에 알리려면 이게 있어야 한다 (스펙 §8).
   * 이미 죽은 뒤에 등록해도 즉시 호출된다 — 등록과 종료의 경쟁을 없앤다.
   */
  onExit(listener: (code: number) => void): void;
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

/** 종료 알림을 모으는 작은 상자. 이미 종료된 뒤 등록해도 즉시 부른다. */
function exitNotifier() {
  const listeners: Array<(code: number) => void> = [];
  let code: number | null = null;
  return {
    settle(exitCode: number) {
      if (code !== null) return;
      code = exitCode;
      for (const l of listeners) l(exitCode);
    },
    add(listener: (code: number) => void) {
      if (code !== null) listener(code);
      else listeners.push(listener);
    },
    code: () => code,
  };
}

/**
 * SIGTERM으로 안 죽으면 SIGKILL. utilityProcess.kill()에는 신호 인자가 없다.
 * SIGKILL 뒤에도 유한 시간만 기다린다 — 무한 대기는 종료를 막는다.
 */
async function escalate(
  kill: (signal: NodeJS.Signals) => void,
  exited: () => boolean,
  graceMs: number,
): Promise<void> {
  const waitUntil = async (ms: number) => {
    const start = Date.now();
    while (!exited() && Date.now() - start < ms) {
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitUntil(graceMs);
  if (exited()) return;
  kill("SIGKILL");
  await waitUntil(2_000);
}

export function launchPackaged(options: LaunchOptions): ApiHandle {
  const sink = makeSink(options.logFile);
  const exit = exitNotifier();
  // utilityProcess는 app.whenReady() 뒤에만 부를 수 있다. main.ts가 그 순서를 지킨다.
  const child: UtilityProcess = electronUtilityProcess().fork(options.entry, [], {
    cwd: options.cwd,
    stdio: "pipe",
    // HOST가 options.env 뒤에 와야 config.json 한 줄로 LAN에 열리지 않는다.
    env: { ...options.env, HOST: "127.0.0.1" },
  });
  const pid = child.pid;
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (exitCode: number) => {
    sink.close();
    exit.settle(exitCode);
  });
  return {
    get pid() {
      return pid;
    },
    alive: () => exit.code() === null,
    stderrTail: sink.tail,
    exitCode: exit.code,
    onExit: exit.add,
    async stop(graceMs) {
      if (exit.code() !== null) return;
      child.kill();
      await escalate(
        (signal) => {
          if (pid === undefined) return;
          try {
            process.kill(pid, signal);
          } catch {
            // 이미 죽었으면 ESRCH — 무시한다.
          }
        },
        () => exit.code() !== null,
        graceMs,
      );
    },
  };
}

/**
 * 개발에서는 nest start --watch를 쓴다 — 모듈이 아니라 CLI라 utilityProcess로 못 띄운다.
 * cwd는 pnpm --filter가 be/로 맞춰 주므로 be/.env가 오늘처럼 읽힌다 (스펙 §6.3).
 */
export function launchDev(options: LaunchOptions): ApiHandle {
  const sink = makeSink(options.logFile);
  const exit = exitNotifier();
  const child: ChildProcess = spawn("pnpm", ["--filter", "damwha-be", "run", "dev"], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // 필수다. detached가 없으면 자식이 부모의 프로세스 그룹에 들어가 process.kill(-pid)가
    // 그룹을 못 찾고, pnpm만 죽어 nest가 만든 손자 API가 남는다.
    detached: true,
    env: { ...process.env, ...options.env, HOST: "127.0.0.1" },
  });
  const pid = child.pid;
  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => sink.write(b, true));
  child.on("exit", (exitCode) => {
    sink.close();
    exit.settle(exitCode ?? 0);
  });
  const killGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      // 음수 pid = 프로세스 그룹 전체. detached로 만들었으므로 pid가 그룹 리더다.
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 죽었다.
      }
    }
  };
  return {
    get pid() {
      return pid;
    },
    alive: () => exit.code() === null,
    stderrTail: sink.tail,
    exitCode: exit.code,
    onExit: exit.add,
    async stop(graceMs) {
      if (exit.code() !== null) return;
      killGroup("SIGTERM");
      await escalate(killGroup, () => exit.code() !== null, graceMs);
    },
  };
}
```

- [ ] **Step 2: dev 종료가 손자 프로세스를 남기지 않는지 확인한다**

`detached: true`는 위 코드에 이미 들어 있다 — 그것이 `process.kill(-pid)`가 동작하는 전제다. 이 단계는 그 전제가 실제로 성립하는지 재는 것이다.

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

Expected: `leftover: ""`. 남으면 `killGroup`이 그룹을 못 찾은 것이다 — `child.pid`가 그룹 리더인지(`ps -o pid,pgid -p <pid>`에서 둘이 같은지) 확인하고, 아니면 `detached` 옵션이 실제로 적용됐는지 본다.

이 확인이 평범한 `node`에서 도는 것은 위 코드가 `electron`을 **값으로 최상단 import하지 않기** 때문이다. 최상단에서 `import { utilityProcess } from "electron"`을 하면 이 파일은 Electron 밖에서 로드되지 않아 이 단계 자체가 불가능해진다.

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
/**
 * start()가 겹치면 한 호출이 다른 호출의 자식을 죽이고도 이전 호출이 계속 전역 상태를
 * 갱신한다. 세대 번호로 최신 호출만 전역 상태와 창을 건드리게 한다.
 */
let generation = 0;
let starting: Promise<void> | null = null;

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

type AttemptOutcome =
  | { kind: "ready"; handle: ApiHandle; origin: string }
  | { kind: "db-unreachable"; handle: ApiHandle }
  | { kind: "addr-in-use" }
  | { kind: "failed"; handle: ApiHandle };

/**
 * 한 포트로 한 번 시도한다. 전역 `api`를 보지 않고 이 호출이 만든 handle만 관찰한다 —
 * 겹친 start()가 서로의 자식을 오관찰하지 않게 하려면 이 격리가 필요하다.
 */
async function attempt(port: number, env: ApiEnv): Promise<AttemptOutcome> {
  const launch = app.isPackaged ? launchPackaged : launchDev;
  const handle = launch({
    entry: path.join(apiRoot(), "dist", "main.js"),
    cwd: apiRoot(),
    env: { ...env, PORT: String(port) },
    logFile: logFile(),
  });
  const origin = `http://127.0.0.1:${port}`;
  const outcome = await waitForReady({
    probe: () => probeHealth(origin),
    isAlive: () => handle.alive(),
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: READY_INTERVAL_MS,
  });
  if (outcome.kind === "ready") return { kind: "ready", handle, origin };
  if (outcome.kind === "db-unreachable") return { kind: "db-unreachable", handle };
  if (outcome.kind === "child-exited" && isAddrInUse(handle.stderrTail())) {
    await handle.stop(STOP_GRACE_MS);
    return { kind: "addr-in-use" };
  }
  return { kind: "failed", handle };
}

/** ready 뒤에 자식이 죽으면 화면에 알린다. 자동 재시작은 Phase 2다 (스펙 §8). */
function watchForDeath(handle: ApiHandle, mine: number): void {
  handle.onExit((code) => {
    if (mine !== generation || quitting || win === null) return;
    api = null;
    apiOrigin = null;
    const seconds = scheduleRetry();
    void showStatus(win, {
      state: "failed",
      detail: `API가 종료됐어요 (코드 ${code}). ${lastMeaningfulLine(handle.stderrTail())}`,
      retryInSeconds: seconds,
      logPath: logFile(),
    });
  });
}

/** 동시 호출을 직렬화한다. 메뉴 재시도와 자동 재시도가 겹칠 수 있다. */
function start(): Promise<void> {
  const run = (starting ?? Promise.resolve()).then(() => startOnce());
  starting = run.catch(() => undefined);
  return run;
}

async function startOnce(): Promise<void> {
  if (win === null) return;
  generation += 1;
  const mine = generation;
  await stopApi();
  if (mine !== generation || win === null) return;
  await showStatus(win, { state: "starting" });

  const { env, warning } = loadConfig(app.getPath("userData"));
  const preferred = Number(env.PORT) || 3000;

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i += 1) {
    const port = await choosePort(preferred, i);
    const outcome = await attempt(port, env);

    // 내가 도는 동안 더 새로운 start()가 시작됐다면 내가 만든 자식을 치우고 물러난다.
    if (mine !== generation) {
      if (outcome.kind !== "addr-in-use") await outcome.handle.stop(STOP_GRACE_MS);
      return;
    }
    if (win === null) {
      if (outcome.kind !== "addr-in-use") await outcome.handle.stop(STOP_GRACE_MS);
      return;
    }

    if (outcome.kind === "addr-in-use") continue;

    if (outcome.kind === "ready") {
      api = outcome.handle;
      apiOrigin = outcome.origin;
      retryCount = 0;
      watchForDeath(outcome.handle, mine);
      await win.loadURL(app.isPackaged ? `${outcome.origin}/` : VITE_ORIGIN);
      return;
    }

    const detail = [warning, outcome.kind === "db-unreachable" ? undefined : lastMeaningfulLine(outcome.handle.stderrTail())]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" / ");
    await outcome.handle.stop(STOP_GRACE_MS);
    const seconds = scheduleRetry();
    await showStatus(win, {
      state: outcome.kind === "db-unreachable" ? "db-unreachable" : "failed",
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

Expected: 창이 "데이터베이스에 연결할 수 없어요"를 보이고, `detail`에 `database unreachable at postgres://postgres:***@localhost:5432/damwha`가 있고, 재시도 안내가 보인다. 로그 경로가 `~/Library/Application Support/Damwha/logs/api.log`다.

- [ ] **Step 4: DB를 올려 준비 상태 전환을 확인한다**

**이 Task는 Vite를 띄우지 않는다** — Vite 기동은 Task 11이 붙인다. 그래서 여기서는 렌더러가 담화 화면까지 가는 것을 보지 않고, **API가 ready가 되어 main이 화면 전환을 시도하는 것까지**만 확인한다. 그 이상을 보려면 Vite를 손으로 띄운다.

앱을 띄운 채 다른 터미널에서:

```bash
pnpm db:up
```

Expected: 다음 자동 재시도에서 준비 화면이 사라지고 창이 `http://localhost:5173`을 로드하려 한다. Vite가 없으므로 연결 실패 화면이 뜨는 것이 **정상**이다. `~/Library/Application Support/Damwha/logs/api.log`의 마지막 줄이 `Damwha API listening on 127.0.0.1:<port>`다.

담화 화면까지 보고 싶으면 또 다른 터미널에서 `pnpm fe:dev`를 띄운 뒤 메뉴의 **서비스 > 다시 시도**를 누른다. 이때 Vite는 `fe/.env`의 `VITE_API_BASE_URL=http://localhost:3000/api`를 쓰므로 API가 3000을 잡은 경우에만 맞는다 — 포트 주입은 Task 11의 일이다.

- [ ] **Step 5: ready 이후 사망이 화면에 뜨는지 확인한다**

담화 화면(또는 Step 4의 로드 시도) 상태에서 API 자식만 죽인다.

```bash
kill $(pgrep -f "dist/main.js" | head -1)   # packaged 아님 → nest 프로세스
pgrep -f "nest start"
```

dev에서는 `nest start`의 손자가 실제 API다. 그 pid를 골라 죽인다.

Expected: 창이 "담화를 시작하지 못했어요"로 바뀌고 `detail`에 `API가 종료됐어요 (코드 …)`가 있다. 자동 재시도 안내가 보인다.

- [ ] **Step 6: 종료 후 잔존 프로세스를 확인한다**

앱을 닫고:

```bash
pgrep -f "nest start" || echo "API 잔존 없음"
pgrep -f "damwha_worker" >/dev/null && echo "worker 살아 있음 (정상)"
```

Expected: API 잔존 없음. worker는 살아 있다.

- [ ] **Step 7: 겹친 재시도가 자식을 둘로 만들지 않는지 확인한다**

DB를 내려 실패 화면을 띄운 상태에서, 자동 재시도가 도는 동안 메뉴의 **서비스 > 다시 시도**를 빠르게 세 번 누른다.

```bash
pgrep -c -f "nest start"
```

Expected: 1 이하. 2 이상이면 `generation` 가드나 `start()` 직렬화가 동작하지 않는 것이다.

- [ ] **Step 8: 커밋**

```bash
git add desktop/src/main.ts
git commit -m "feat(desktop): API 기동·포트 폴백·자동 재시도·종료 정리를 배선한다"
```

**Verify:**
- DB 없이 띄우면 원인이 화면에 나온다.
- DB를 올리면 자동 재시도로 API가 ready가 되고 로그에 `listening on 127.0.0.1:<port>`가 찍힌다. (담화 화면 완주는 Task 11이 검증한다.)
- ready 이후 API 자식을 죽이면 화면이 사망을 알린다.
- 메뉴 재시도를 연달아 눌러도 API 자식이 하나다.
- 앱 종료 후 API 잔존 0, worker 생존.
- 두 번 실행하면 창이 하나다.

**Review:**
- `before-quit`가 두 번 돌지 않는가 (`quitting` 가드).
- `addr-in-use`가 아닌 실패에서 포트 루프를 계속 돌지 않는가.
- `attempt()`가 전역 `api`를 보지 않고 자기 handle만 관찰하는가.
- 뒤처진 세대가 자기 자식을 치우고 물러나는가 — 전역 상태나 창을 건드리면 결함이다.
- `apiOrigin`이 `stopApi()`와 사망 감지에서 비워져 허용 origin이 남지 않는가.
- 자동 재시도 타이머가 종료 시 취소되는가.
- `watchForDeath`가 종료 중(`quitting`)에는 침묵하는가.

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
  const listeners: Array<(code: number) => void> = [];
  let code: number | null = null;
  let tail = "";
  const child = spawn("pnpm", ["--filter", "damwha-fe", "run", "dev"], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // API 자식과 같은 이유다 — 그룹 종료가 동작해야 esbuild 손자가 남지 않는다.
    detached: true,
    env: { ...process.env, VITE_API_BASE_URL: options.apiBaseUrl },
  });
  const pid = child.pid;
  child.stdout?.on("data", (b: Buffer) => process.stdout.write(`[vite] ${b}`));
  child.stderr?.on("data", (b: Buffer) => {
    tail = (tail + b.toString()).slice(-8_000);
    process.stderr.write(`[vite!] ${b}`);
  });
  child.on("exit", (exitCode) => {
    code = exitCode ?? 0;
    for (const l of listeners) l(code);
  });
  const killGroup = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 죽었다.
      }
    }
  };
  return {
    get pid() {
      return pid;
    },
    alive: () => code === null,
    stderrTail: () => tail,
    exitCode: () => code,
    onExit(listener) {
      if (code !== null) listener(code);
      else listeners.push(listener);
    },
    async stop(graceMs) {
      if (code !== null) return;
      killGroup("SIGTERM");
      const waitUntil = async (ms: number) => {
        const start = Date.now();
        while (code === null && Date.now() - start < ms) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await waitUntil(graceMs);
      if (code !== null) return;
      killGroup("SIGKILL");
      await waitUntil(2_000);
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

렌더러가 볼 주소를 만드는 함수를 넣는다. Task 10의 `startOnce()`는 `outcome.kind === "ready"` 분기에서 `win.loadURL(app.isPackaged ? … : VITE_ORIGIN)`을 부르는데, dev에서는 그 전에 Vite가 떠 있어야 한다.

```ts
/**
 * dev에서 렌더러가 볼 주소. Vite를 이 시점에 띄우고 첫 서빙까지 기다린다.
 * Vite는 API 포트가 바뀌어도 살려 둔다 — 재시도마다 재기동하면 HMR이 끊긴다.
 */
async function rendererTarget(apiBase: string): Promise<{ url: string } | { error: string }> {
  if (app.isPackaged) return { url: `${apiBase}/` };
  if (vite === null || !vite.alive()) {
    vite = launchVite({ cwd: apiRoot(), apiBaseUrl: `${apiBase}/api` });
  }
  const up = await waitForReady({
    probe: async () => {
      try {
        const res = await fetch(VITE_ORIGIN, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
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
    return { error: `Vite를 띄우지 못했어요: ${lastMeaningfulLine(vite?.stderrTail() ?? "")}` };
  }
  return { url: VITE_ORIGIN };
}
```

`startOnce()`의 ready 분기를 바꾼다.

```ts
    if (outcome.kind === "ready") {
      api = outcome.handle;
      apiOrigin = outcome.origin;
      retryCount = 0;
      watchForDeath(outcome.handle, mine);
      const target = await rendererTarget(outcome.origin);
      if (mine !== generation || win === null) return;
      if ("error" in target) {
        const seconds = scheduleRetry();
        await showStatus(win, { state: "failed", detail: target.error, retryInSeconds: seconds, logPath: logFile() });
        return;
      }
      await win.loadURL(target.url);
      return;
    }
```

**dev에서 Vite가 API 주소를 한 번만 받는 문제.** `VITE_API_BASE_URL`은 Vite 기동 시점에 고정된다. 첫 기동 뒤 API 포트가 바뀌면(재시도에서 폴백) Vite가 든 주소가 낡는다. 그래서 API origin이 바뀌었을 때만 Vite를 재기동한다.

```ts
let viteApiBase: string | null = null;
```

`rendererTarget`의 기동 조건을 바꾼다.

```ts
  const wanted = `${apiBase}/api`;
  if (vite === null || !vite.alive() || viteApiBase !== wanted) {
    if (vite !== null) await vite.stop(STOP_GRACE_MS);
    vite = launchVite({ cwd: apiRoot(), apiBaseUrl: wanted });
    viteApiBase = wanted;
  }
```

`stopApi()`와 나란히 Vite도 정리한다.

```ts
async function stopAll(): Promise<void> {
  const v = vite;
  vite = null;
  viteApiBase = null;
  await Promise.all([stopApi(), v === null ? Promise.resolve() : v.stop(STOP_GRACE_MS)]);
}
```

`before-quit`의 `stopApi()`를 `stopAll()`로 바꾼다. `startOnce()` 안의 `await stopApi()`는 그대로 둔다 — 재시도할 때 Vite는 살려 둔다.

`PROBE_TIMEOUT_MS`를 `readiness`에서 추가로 import한다.

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
import { execFileSync, spawnSync } from "node:child_process";

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
// 문자열 접두사 비교는 /…/api 와 /…/api-escaped 를 구별하지 못한다. 경로 관계로 판정한다.
const insideApi = (target) => {
  const rel = path.relative(realApi, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
const escaping = links.filter((link) => {
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return true; // 깨진 링크도 위반이다
  }
  return !insideApi(target);
});
check("no symlink escapes the api tree", escaping.length === 0, escaping.slice(0, 5).join(", "));
console.log(`      (${links.length} symlink(s) inside the tree — allowed)`);

// 4. 저장소 경로와 pnpm store 경로 문자열이 없다
// grep의 exit 1만 "매치 없음"이다. 2 이상은 권한·I/O 오류이고, 그것을 통과로 삼으면
// 검사가 조용히 무력해진다.
for (const needle of [repo, path.join(process.env.HOME ?? "", ".pnpm-store"), "/.pnpm/"]) {
  if (needle.length < 4) continue;
  const r = spawnSync("grep", ["-rlF", "--", needle, contents], { encoding: "utf8" });
  if (r.error !== undefined) {
    check(`grep ran for "${needle}"`, false, String(r.error.message));
    continue;
  }
  if (r.status !== 0 && r.status !== 1) {
    check(`grep ran for "${needle}"`, false, `exit ${r.status}: ${(r.stderr ?? "").trim()}`);
    continue;
  }
  const files = (r.stdout ?? "").split("\n").filter((l) => l.length > 0);
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

- [ ] **Step 1: 기준선이 유효한지 먼저 확인한다**

Task 1 Step 11이 뜬 기준선을 쓴다. 여기서 새로 뜨지 않는다 — 그 사이 Task 10과 Task 12가 앱을 실행했으므로 지금 뜬 스냅샷은 아무것도 증명하지 않는다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
cat "$EV/baseline-taken-at.txt"
wc -l < "$EV/storage-before.txt"
```

Expected: 네 파일이 있고 시각이 Task 1 시점이다. 없으면 **P1-C14를 판정할 수 없다** — 결과 문서에 미판정으로 적고, 다음 Phase에서 기준선부터 다시 뜬다. 없는 것을 통과로 적지 않는다.

- [ ] **Step 2: worker의 STORAGE_ROOT를 앱 값에 맞춘다**

원래 값을 되돌릴 수 있게 보관하고, 기존 큐를 먼저 비운다. **`be/worker/.env`는 gitignore 대상이라 커밋되지 않으므로 이 백업이 유일한 복구 수단이다.**

```bash
EV="$HOME/.cache/damwha-p1-evidence"
cp be/worker/.env "$EV/worker.env.backup"
grep STORAGE_ROOT be/worker/.env
```

먼저 **worker를 멈춘다.** 그 뒤 남은 작업이 없는지 본다.

```bash
docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -At -c \
  "select status, count(*) from job where status in ('queued','running') group by status"
```

Expected: 출력 없음. 남아 있으면 그 작업들은 기존 `be/storage`의 파일을 가리키므로, 경로를 바꾼 worker가 파일을 못 찾아 `failed`로 기록한다 — 기존 회의의 상태를 망친다. **비기 전까지 진행하지 않는다.** 원래 경로의 worker로 큐를 비우고 다시 온다.

큐가 비었으면 경로를 바꾼다.

```bash
python3 - <<'PY'
import pathlib, re, os
p = pathlib.Path("be/worker/.env")
target = str(pathlib.Path.home() / "Library/Application Support/Damwha/storage")
s = p.read_text()
s2 = re.sub(r"^STORAGE_ROOT=.*$", f"STORAGE_ROOT={target}", s, count=1, flags=re.M)
assert s2 != s, "STORAGE_ROOT 줄을 찾지 못했다"
p.write_text(s2)
print(f"STORAGE_ROOT -> {target}")
PY
mkdir -p "$HOME/Library/Application Support/Damwha/storage"
```

- [ ] **Step 3: 남은 선행 조건을 갖춘다**

```bash
pnpm db:up
pnpm be:migrate
```

그 뒤 `pnpm worker`, `pnpm embed`를 각 터미널에서 띄운다. worker 로그의 첫 줄에 새 `STORAGE_ROOT`가 반영됐는지 본다.

- [ ] **Step 4: 실사용 기준 4건을 수행한다 (P1-C1 ~ P1-C4)**

```bash
pnpm desktop:build
# .app 내부 쓰기 판정을 위한 실행 전 manifest (P1-C12)
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
find "$APP" -type f -exec shasum -a 256 {} \; | sort > "$EV/app-before.txt"
wc -l < "$EV/app-before.txt"
open "$APP"
```

순서대로 한다. 각 단계에서 화면을 캡처해 `$EV/`에 둔다.

1. **P1-C1** — 터미널 명령 없이 창이 담화 화면까지 간다.
2. **P1-C2** — 오디오 파일로 회의를 만들고 처리가 끝날 때까지 둔다. 전사 결과가 화면에 뜬다.
3. **P1-C3** — 라이브 녹음을 시작한다. macOS 마이크 권한 대화상자가 뜨고 문구가 `NSMicrophoneUsageDescription`의 것이다. 허가 후 녹음·중단하고 결과를 본다.
4. **P1-C4** — 검색어를 넣어 키워드·의미 결과가 섞여 나오는지 본다.

- [ ] **Step 5: 경로·바인드 위생을 앱이 떠 있는 동안 확인한다 (P1-C9, P1-C12 일부)**

Step 4의 앱이 아직 떠 있는 상태에서 한다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
APP_PID=$(pgrep -f "dist/main.js" | head -1)
echo "api pid: $APP_PID"
lsof -nP -iTCP -sTCP:LISTEN -a -p "$APP_PID"
ps eww -o command= -p "$APP_PID" | tr ' ' '\n' | grep -E "^(STORAGE_ROOT|DATABASE_URL|HOST)="
LAN=$(ipconfig getifaddr en0)
APP_PORT=$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$APP_PID" -Fn | sed -n 's/.*:\([0-9]*\)$/\1/p' | head -1)
curl -sS -m 3 "http://$LAN:$APP_PORT/api/health" && echo "실패: LAN에서 응답했다" || echo "LAN 접속 거부 — 정상"
```

Expected: LISTEN 주소가 `127.0.0.1:<port>`다 — `*:<port>`면 P1-C9 실패. 주입된 세 값이 절대 경로·절대 주소이고 `HOST=127.0.0.1`이다. LAN 주소로는 거부된다.

- [ ] **Step 6: 프로세스 소유권 2건을 수행한다 (P1-C5, P1-C6)**

앱이 떠 있는 상태에서 두 번째 인스턴스를 연다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
pgrep -fl "dist/main.js" > "$EV/procs-running.txt"
pgrep -fl "damwha_worker|damwha-embed" >> "$EV/procs-running.txt"
open "$APP"
pgrep -c -f "dist/main.js"
```

Expected: 창 하나, `dist/main.js` 프로세스 1개.

앱을 닫고:

```bash
pgrep -fl "dist/main.js" || echo "API 잔존 없음"
pgrep -fl "damwha_worker|damwha-embed" || echo "경고: worker/embed가 죽었다 — P1-C5 실패"
```

- [ ] **Step 7: 번들 위생을 확인한다 (P1-C11)**

```bash
pnpm --filter damwha-desktop exec node scripts/check-bundle.mjs
```

Expected: 전 항목 PASS, exit 0.

- [ ] **Step 8: DB 미기동 실패 표시를 확인한다 (P1-C7)**

앱이 완전히 닫힌 상태에서 시작한다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
pgrep -f "dist/main.js" && echo "앱이 아직 떠 있다 — 먼저 닫는다"
pnpm db:down
open "$APP"
```

Expected: 화면이 DB 연결 실패를 말하고 `database unreachable at postgres://postgres:***@localhost:5432/damwha` 원문과 로그 경로가 보인다.

DB를 올려 회복까지 확인한다.

```bash
pnpm db:up
```

Expected: 자동 재시도 또는 메뉴 재시도로 담화 화면에 도달한다. 확인 후 **앱을 닫는다.**

- [ ] **Step 9: 다른 기동 실패 표시를 확인한다 (P1-C8)**

**앱이 닫혀 있어야 한다.** 떠 있으면 single-instance lock 때문에 `open`이 기존 창만 앞으로 보내고 새 자식이 뜨지 않아 바꾼 설정을 읽지 않는다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
pgrep -f "dist/main.js" && echo "먼저 앱을 닫는다" || echo "앱 닫힘 확인"
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / "Library/Application Support/Damwha/config.json"
c = json.loads(p.read_text())
c["SUMMARY_LLM_MODEL"] = "not-in-the-catalog"
p.write_text(json.dumps(c, indent=2) + "\n")
PY
open "$APP"
```

Expected: 기동 실패 화면. `detail`이 zod 검증 실패를 말하며 **P1-C7의 DB 문안과 다르다.**

앱을 닫고 키를 지운 뒤 정상 기동까지 확인한다.

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / "Library/Application Support/Damwha/config.json"
c = json.loads(p.read_text())
c.pop("SUMMARY_LLM_MODEL", None)
p.write_text(json.dumps(c, indent=2) + "\n")
PY
open "$APP"
```

Expected: 담화 화면. 확인 후 **앱을 닫는다.**

- [ ] **Step 10: 포트 폴백을 확인한다 (P1-C10)**

순서가 중요하다. **앱을 먼저 완전히 닫고**, 외부 API가 3000을 잡은 것을 확인한 뒤 앱을 연다. 앱이 이미 3000을 쥐고 있으면 외부 API가 실패해 검증 자체가 성립하지 않는다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
pgrep -f "dist/main.js" && echo "먼저 앱을 닫는다" || echo "앱 닫힘 확인"
# 스펙 P1-C10이 말하는 점유 주체는 pnpm dev다
pnpm dev > "$EV/pnpm-dev.log" 2>&1 &
DEV_PGID=$!
sleep 15
curl -s -o /dev/null -w 'external api on 3000: %{http_code}\n' http://127.0.0.1:3000/api/health
EXTERNAL_PID=$(lsof -nP -iTCP:3000 -sTCP:LISTEN -t | head -1)
echo "external pid: $EXTERNAL_PID"
open "$APP"
sleep 20
APP_PID=$(pgrep -f "dist/main.js" | grep -v "^$EXTERNAL_PID$" | head -1)
lsof -nP -iTCP -sTCP:LISTEN -a -p "$APP_PID"
```

Expected: 앱의 API가 3000이 **아닌** 포트에서 LISTEN한다. 화면이 정상 동작한다. 마이크 권한을 **다시 묻지 않는다**.

앱을 닫고 외부 것만 정리한다.

```bash
pgrep -f "dist/main.js" | grep -v "^$EXTERNAL_PID$" || echo "앱 API 잔존 없음"
curl -s -o /dev/null -w 'external api still up: %{http_code}\n' http://127.0.0.1:3000/api/health
kill -- -"$DEV_PGID" 2>/dev/null || kill "$DEV_PGID"
```

Expected: 앱 API 잔존 없음. 외부 API는 앱 종료 후에도 200 — 앱이 남의 프로세스를 죽이지 않았다는 뜻이다.

- [ ] **Step 11: `.app` 내부 쓰기를 확인한다 (P1-C12 나머지)**

Step 4의 `app-before.txt`와 비교한다. mtime 비교는 빌드 시점에 이미 새로운 파일을 오탐하고 오래된 파일의 수정은 놓친다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
APP="desktop/out/mac-arm64/Damwha.app"
find "$APP" -type f -exec shasum -a 256 {} \; | sort > "$EV/app-after.txt"
diff "$EV/app-before.txt" "$EV/app-after.txt" && echo ".app 내부 무변경 — 정상"
```

Expected: diff가 비어 있다.

- [ ] **Step 12: 회귀를 확인한다 (P1-C13)**

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev        # Electron 창이 뜨지 않는지 확인 후 중단
docker build -f deploy/api.Dockerfile -t damwha-api:p1-check .
```

Expected: 넷 다 통과. `pnpm dev`가 Electron 창을 띄우지 않는다. 이미지 빌드 성공.

- [ ] **Step 13: 데이터 보존을 확인한다 (P1-C14)**

세 항목의 판정 규칙이 서로 다르다. `be/storage`와 compose는 **완전 동일**, `_migrations`는 **동일**, `meeting`·`utterance`는 **줄지 않음**이다. 새 업로드와 녹음을 했으니 뒤의 둘은 늘어난다 — 그것을 `diff`로 보면 정상 동작이 실패로 잡힌다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
( cd be/storage && find . -type f -exec shasum -a 256 {} \; | sort ) > "$EV/storage-after.txt"
diff "$EV/storage-before.txt" "$EV/storage-after.txt" && echo "PASS be/storage 무변경" || echo "FAIL be/storage가 바뀌었다"

docker compose -f be/docker-compose.yml config | grep -E "^name:|pgdata" | sort > "$EV/compose-after.txt"
diff "$EV/compose-before.txt" "$EV/compose-after.txt" && echo "PASS compose 무변경" || echo "FAIL compose가 바뀌었다"

docker compose -f be/docker-compose.yml exec -T postgres psql -U postgres -d damwha -At -F, -c \
  "select 'meeting', count(*) from meeting union all select 'utterance', count(*) from utterance union all select '_migrations', count(*) from _migrations" \
  | sort > "$EV/rows-after.txt"
python3 - <<'PY'
import os, pathlib
ev = pathlib.Path(os.environ["HOME"]) / ".cache/damwha-p1-evidence"
def rows(name):
    return dict(
        (line.split(",")[0], int(line.split(",")[1]))
        for line in (ev / name).read_text().split("\n") if line.strip()
    )
before, after = rows("rows-before.txt"), rows("rows-after.txt")
ok = True
if before["_migrations"] != after["_migrations"]:
    print(f"FAIL _migrations {before['_migrations']} -> {after['_migrations']} (앱이 마이그레이션을 돌렸다)"); ok = False
else:
    print(f"PASS _migrations 동일 ({after['_migrations']})")
for key in ("meeting", "utterance"):
    if after[key] < before[key]:
        print(f"FAIL {key} {before[key]} -> {after[key]} (기존 행이 사라졌다)"); ok = False
    else:
        print(f"PASS {key} {before[key]} -> {after[key]} (줄지 않음)")
raise SystemExit(0 if ok else 1)
PY
```

Expected: 네 판정 모두 PASS. `be/storage`와 compose는 완전 동일, `_migrations` 동일, `meeting`·`utterance`는 늘거나 같다.

- [ ] **Step 14: worker의 STORAGE_ROOT를 되돌릴지 결정한다**

Phase 2 이후 앱이 worker를 직접 띄우면 이 값은 앱이 주입한다. 그때까지 웹 흐름(`pnpm dev` + `pnpm worker`)으로 기존 회의를 처리하려면 원래 값이 맞다.

```bash
EV="$HOME/.cache/damwha-p1-evidence"
diff "$EV/worker.env.backup" be/worker/.env
# 되돌리려면
# cp "$EV/worker.env.backup" be/worker/.env
```

되돌렸는지 되돌리지 않았는지를 **결과 문서에 적는다.** 되돌리지 않으면 웹 흐름에서 기존 회의의 재처리가 파일을 못 찾는다. 되돌리면 데스크톱 앱의 새 업로드가 처리되지 않는다. 둘 다 Phase 5까지의 알려진 한계다.

- [ ] **Step 15: 결과 문서를 채운다**

`docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md`에 쓴다.

- "단계별 실행·리뷰" — Task 1~12 각각의 커밋 범위, 검토자, 지적, 조치, 통과 여부.
- "최종 검증" — P1-C1 ~ P1-C14의 판정 표. 각 행에 실행한 명령과 관찰된 값. 통과하지 못한 기준은 **통과로 적지 않는다.**
- 실측으로 확정된 값 — `READY_TIMEOUT_MS`·`READY_INTERVAL_MS`·`PROBE_TIMEOUT_MS`의 실제 콜드 스타트 소요, `RETRY_DELAYS_MS`, `MAX_PORT_ATTEMPTS`, 쓴 `pnpm deploy` 형태, 선택된 자식 기동 수단, `.app` 용량, Gatekeeper 조치 필요 여부.
- "남은 제약·후속 Phase 인계" — 기존 회의 오디오 404(Phase 5), CORS와 API 인증(Phase 6), `be/worker/.env`를 손으로 맞춰야 하는 것과 Step 14의 되돌림 결정(Phase 2·4·5), ready 이후 사망 시 자동 재시작 부재(Phase 2).

- [ ] **Step 16: 로드맵 상태를 갱신한다**

`docs/electron-migration-roadmap.md`의 Phase 1 "상태" 문단을 실제 결과로 바꾼다. 완료 기준 3개에 대한 충족·부분·미충족을 표로 적고, 부분이면 무엇이 남았는지 쓴다.

- [ ] **Step 17: 커밋**

```bash
git add docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md docs/electron-migration-roadmap.md
git commit -m "docs: Electron Phase 1 통합 검증 결과를 기록한다"
```

**Verify:**
- P1-C1 ~ P1-C14 열네 행이 모두 판정과 증거를 갖는다.
- `be/storage` diff가 비어 있다.
- `_migrations` 행 수가 같고 `meeting`·`utterance`가 줄지 않았다.
- `.app` 실행 전후 manifest가 동일하다.
- P1-C10에서 외부 API가 앱 종료 후에도 살아 있었다.
- `pnpm build`·`pnpm test`·`pnpm lint`·Docker 이미지 빌드가 통과한다.

**Review:**
- 실행하지 않은 검증을 통과로 적지 않았는가. 기준선이 없어 판정 불가인 항목을 통과로 적지 않았는가.
- 실측치가 코드의 상수와 일치하는가.
- 로드맵 상태가 실제 판정과 어긋나지 않는가.
- `be/worker/.env`의 최종 상태와 그 선택의 결과가 문서에 적혔는가.

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
| P1-C13 웹 흐름 회귀 없음 | 1, 3 | 1 Step 10, 13 Step 12 |
| P1-C14 기존 데이터 보존 | 4 (STORAGE_ROOT 분리) | **1 Step 11 (기준선)**, 13 Step 1, Step 13 |

### 완료 기준이 아닌 스펙 요구의 대응

스펙 §8의 실패 동작 표는 완료 기준 식별자를 갖지 않지만 구현 대상이다.

| 스펙 §8 항목 | 구현 Task | 검증 |
| --- | --- | --- |
| `config.json`이 깨진 JSON → 기본값으로 진행, 덮어쓰지 않음 | 4 | 4 Step 1 테스트 |
| 고정 포트 점유 → 폴백 | 5, 10 | 13 Step 10 |
| 빈 포트도 못 잡음 → 기동 실패 화면 | 5, 10 | 10 Review (`MAX_PORT_ATTEMPTS` 상한) |
| API 유예 시간 내 미준비 → 실패 화면 + 자식 정리 | 6, 10 | 6 Step 1 테스트, 10 Step 3 |
| `database unreachable`로 exit 1 → 원문 표시 | 9, 10 | 13 Step 8 |
| 그 밖의 exit 1 → 종료 코드와 stderr 표시 | 9, 10 | 13 Step 9 |
| 부팅 뒤 DB 끊김 → 503 원인 화면 | 6, 9 | 6 Step 1 테스트 (`db-unreachable`) |
| **실행 중 API 사망 → 화면에 알림** | 8 (`onExit`), 10 (`watchForDeath`) | 10 Step 5 |
| 마이크 권한 거부 → 녹음만 막힘 | 9 | 13 Step 4 (P1-C3) |

## 스펙 위험과 Task 대응

| 위험 | 닫는 Task |
| --- | --- |
| R1-1 `utilityProcess`로 NestJS가 안 뜬다 | 2 |
| R1-2 `pnpm deploy` 트리가 불완전하다 | 2 |
| R1-3 `nest build`가 `dist/public`을 지운다 | 12 (순서 고정) |
| R1-4 상대 경로가 번들 내부를 가리킨다 | 4, 13 Step 6 |
| R1-5 electron-builder가 pnpm 레이아웃에서 실패한다 | 1 (`dependencies` 비움), 12 |
| R1-6 폴백 후 마이크 권한 재요청 | 9, 13 Step 10 |
| R1-7 `STORAGE_ROOT` 불일치로 조용한 실패 | 13 Step 2 (선행 조건 + 큐 확인 + 백업) |
| R1-8 `sandbox: true`가 `getUserMedia`를 막는다 | 13 Step 4 |
| R1-9 `pnpm deploy`가 Experimental | 2, 12 |
| R1-10 `EADDRINUSE`를 못 가른다 | 5, 10 |
| R1-11 외부 API를 자기 것으로 오인 | 10, 13 Step 10 |

계획 검증에서 추가로 닫은 것 — 스펙의 위험 목록에는 없지만 계획이 만들어 낸 결함이다.

| 결함 | 닫는 Task |
| --- | --- |
| probe가 끝나지 않으면 준비 판정 루프가 타임아웃에 도달하지 못한다 | 6 (`PROBE_TIMEOUT_MS` + race, 전용 테스트) |
| `detached` 없이 `process.kill(-pid)`를 불러 손자 API가 남는다 | 8 (`detached: true` 고정) |
| 겹친 `start()`가 서로의 자식을 오관찰한다 | 10 (`generation` + 호출 직렬화 + local handle) |
| 종료 escalation이 무한 대기할 수 있다 | 8 (`escalate`의 2차 상한) |
| `grep` 오류를 번들 위생 통과로 위장한다 | 12 (`spawnSync` + status 검사) |
| 심볼릭 링크 탈출 판정이 경로 접두사 오판을 한다 | 12 (`path.relative`) |
| P1-C14 기준선이 앱 실행 뒤에 찍힌다 | 1 Step 11 (기준선을 앱 실행 전으로) |
| `.app` 쓰기 판정이 mtime이라 오탐·누락한다 | 13 Step 4·11 (manifest 비교) |
| `be/worker/.env` 변경이 기존 큐를 실패로 만든다 | 13 Step 2 (큐 확인 + 백업 + 되돌림 결정) |
