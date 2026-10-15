# 로컬 API 접근 제어 구현 계획

**Spec:** [`docs/superpowers/specs/2026-10-08-local-api-access-control-design.md`](../specs/2026-10-08-local-api-access-control-design.md)
**브랜치:** `feat/local-api-access-control` (`dev` @ `a0f2f23`에서 분기)

**Goal:** 브라우저로 연 아무 웹페이지가 로컬 be API·embed·LLM 서버로 회의를 읽거나 바꾸지 못하게 한다. 패키징
desktop·`pnpm dev`·desktop dev·데모는 그대로 동작한다.

**Architecture:**
- be: 순수 판정 함수 `evaluateAccess`(Host → 브라우저 출처) + express 미들웨어 `accessControl`(프레임 헤더·403·CORS·
  preflight). `main.ts`의 HTTP 구성을 `configureHttp`로 옮겨 접근 제어를 **모든 본문 파서보다 앞**에 건다. 접근 제어
  e2e는 같은 함수로 앱을 만든다. `enableCors()`는 사라진다. env `ALLOWED_ORIGINS`·`ALLOWED_HOSTS`, `HOST` 기본값
  `127.0.0.1`.
- desktop: `apiChildEnv`가 두 키의 최종값을 정한다(dev는 Vite origin, packaged는 제거). `config.json`은 두 키를 못 덮는다.
- fe: 두 `<audio>`에 `crossOrigin="anonymous"`, Vite 5173 고정.
- worker: 순수 판정 `browser_guard.rejection` 하나를 embed(FastAPI 미들웨어)와 LLM(`APIHandler` 메서드 제자리 교체)이 쓴다.

**Tech Stack:** NestJS 10 / express 4.22 / zod 3.25 / jest + supertest + testcontainers, Electron + vitest, React 19 +
Vite 8 + vitest(jsdom), Python 3.12 + FastAPI 0.138 + `http.server` + pytest.

## Global Constraints

- 403 본문: `{ statusCode: 403, code: "HOST_NOT_ALLOWED" | "ORIGIN_NOT_ALLOWED", message }` (be).
- loopback Host 셋: `localhost`, `127.0.0.1`, `[::1]` — 포트는 보지 않는다(be·worker 공통).
- `Access-Control-Allow-Origin: *`는 어떤 응답에도 없다. `Access-Control-Allow-Credentials`는 보내지 않는다.
- 모든 be 응답(403 포함)에 `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`.
- `/api` 판정은 대소문자 무시. 미들웨어 순서: 접근 제어 → `useBodyParser('json', 1mb)` → `setGlobalPrefix('api')` →
  SPA 정적 → Swagger.
- `ALLOWED_ORIGINS` 항목은 `new URL(x).origin === x`, `ALLOWED_HOSTS` 항목은 포트·scheme 없는 이름. 어기면 기동 실패.
- Vite 개발 origin은 `http://localhost:5173` 하나(`strictPort: true`).
- worker 가드: `Origin` 또는 `Sec-Fetch-Site`가 있으면 403(항상). Host는 loopback 셋 + 설정된 bind 호스트(`0.0.0.0`·`::`
  제외). `Sec-Fetch-Mode`는 보지 않는다(Node `fetch`가 `sec-fetch-mode: cors`를 붙인다 — 실측).
- 레포 명령은 루트에서: `pnpm be …`, `pnpm fe …`, `pnpm --filter damwha-desktop exec …`/`pnpm --filter damwha-desktop test`
  (`pnpm desktop exec`는 테스트 0개 거짓 초록불). worker 테스트는 `uv run --directory be/worker pytest <경로>`
  (`pnpm worker:test -- <경로>`는 인자를 넘기지 않는다).

**spec과 다르게 하는 것 하나:** spec §3.8은 `llm_server.py`가 `--allowed-origins`를 넘기는 이중 장치를 적었다. 설치된
mlx_lm 0.31.3에서 `cli_args.allowed_origins`를 읽는 곳은 `_set_cors_headers` 하나뿐이고(`server.py:1076`), 이 계획은
그 메서드를 아무 헤더도 쓰지 않게 덮는다(Task 9). 인자는 효과가 없어지고, `LENS_LLM_SERVER_BIN` 탈출구의 임의 백엔드는
모르는 인자로 죽을 수 있다. 그래서 넣지 않고 `test_llm_server.py`의 기동 인자 고정도 바꾸지 않는다. result에 적는다.

## Review Focus

1. **Electron 패키징 렌더러가 보내는 실제 헤더** — 같은 origin이면 GET에 `Origin`이 없고 `Sec-Fetch-Site: same-origin`,
   POST에는 `Origin: http://127.0.0.1:<port>`. 테스트는 이 모양을 흉내 낼 뿐이라 Task 11의 패키징 앱 수동 확인이 본체다.
2. **desktop 포트 폴백** — 3000이 막혀 무작위 포트로 뜨면 Host·Origin이 그 포트를 담는다. 포트를 보지 않는 Host 판정과
   `URL.host` 비교가 이를 통과시켜야 한다 → Task 2 단위 표에 비표준 포트 행.
3. **IPv6 loopback** — `Host: [::1]:3000`, `Origin: http://[::1]:3000` → Task 2 표에 행.
4. **cross-site 내비게이션으로 데모 `/` 열기**(제품 사이트 링크) — 403이면 데모가 죽는다 → Task 3 e2e 정상 경로에 행.
5. **오디오 Range 요청이 dev cross-origin에서 206 + ACAO** — `<audio crossOrigin>`이 CORS 모드라 ACAO가 없으면 재생이
   안 된다 → Task 3 e2e 정상 경로에 행.

---

### Task 1: be env — `ALLOWED_ORIGINS`·`ALLOWED_HOSTS` 파싱, `HOST` 기본값

**Files:**
- Create: `be/src/access/access-policy.ts`
- Modify: `be/src/config/env.ts:6-9` (HOST), 스키마 끝(두 키)
- Modify: `deploy/api.Dockerfile` (런타임 단계 `ENV NODE_ENV=production` 옆에 `ENV HOST=0.0.0.0`)
- Modify: `be/.env.example` (맨 위 `PORT=3000` 다음)
- Test: `be/test/env.spec.ts`, Create `be/test/access-policy.spec.ts`

**Interfaces:**
- Produces:
  - `interface AccessPolicy { readonly allowedOrigins: ReadonlySet<string>; readonly allowedHosts: ReadonlySet<string> }`
  - `const LOOPBACK_HOSTS: ReadonlySet<string>` = `localhost`, `127.0.0.1`, `[::1]`
  - `parseAllowedOrigins(raw: string): string[]` — 형식이 틀리면 throw
  - `parseAllowedHosts(raw: string): string[]` — 소문자로 돌려준다, 틀리면 throw
  - `buildAccessPolicy(origins: string, hosts: string): AccessPolicy`
  - `Env.ALLOWED_ORIGINS: string`, `Env.ALLOWED_HOSTS: string` (검증된 원문), `Env.HOST` 기본 `'127.0.0.1'`

- [ ] **Step 1: 실패하는 테스트 — env.spec.ts**

`be/test/env.spec.ts`의 첫 테스트를 바꾸고 아래를 더한다:

```ts
  it('defaults to 127.0.0.1 — the Docker image sets HOST=0.0.0.0 itself', () => {
    delete process.env.HOST;
    expect(loadEnv().HOST).toBe('127.0.0.1');
  });
```

```ts
describe('loadEnv access lists', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved, DATABASE_URL: 'postgres://u:p@localhost:5432/d' };
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.ALLOWED_HOSTS;
  });
  afterAll(() => { process.env = saved; });

  it('defaults both lists to empty', () => {
    const env = loadEnv();
    expect(env.ALLOWED_ORIGINS).toBe('');
    expect(env.ALLOWED_HOSTS).toBe('');
  });

  it('accepts bare origins and host names', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173, http://127.0.0.1:5173';
    process.env.ALLOWED_HOSTS = 'damwha-demo.0kimjae.dev';
    expect(() => loadEnv()).not.toThrow();
  });

  it.each([
    'http://localhost:5173/',      // 끝 슬래시
    'http://localhost:5173/app',   // 경로
    'localhost:5173',              // scheme 없음
    '*',
    'null',
    'HTTP://LOCALHOST:5173',       // 정규형이 아님
  ])('rejects ALLOWED_ORIGINS=%s at startup', (bad) => {
    process.env.ALLOWED_ORIGINS = bad;
    expect(() => loadEnv()).toThrow(/ALLOWED_ORIGINS/);
  });

  it.each(['demo.example:443', 'https://demo.example', '*.example', '*', 'a b'])(
    'rejects ALLOWED_HOSTS=%s at startup', (bad) => {
      process.env.ALLOWED_HOSTS = bad;
      expect(() => loadEnv()).toThrow(/ALLOWED_HOSTS/);
    },
  );
});
```

`be/test/access-policy.spec.ts`:

```ts
import { buildAccessPolicy, LOOPBACK_HOSTS, parseAllowedHosts, parseAllowedOrigins } from '../src/access/access-policy';

describe('access policy lists', () => {
  it('splits on commas, trims, drops empties', () => {
    expect(parseAllowedOrigins(' http://localhost:5173 ,, ')).toEqual(['http://localhost:5173']);
    expect(parseAllowedHosts('Demo.Example, b.example')).toEqual(['demo.example', 'b.example']);
  });

  it('builds sets', () => {
    const p = buildAccessPolicy('http://localhost:5173', 'demo.example');
    expect([...p.allowedOrigins]).toEqual(['http://localhost:5173']);
    expect([...p.allowedHosts]).toEqual(['demo.example']);
  });

  it('loopback set is exactly the three names', () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm be exec jest test/env.spec.ts test/access-policy.spec.ts`
Expected: FAIL — `Cannot find module '../src/access/access-policy'`, HOST가 `0.0.0.0`.

- [ ] **Step 3: 구현**

`be/src/access/access-policy.ts`:

```ts
/**
 * 로컬 API 접근 제어의 허용 목록 (spec 2026-10-08-local-api-access-control §3.4).
 * env 원문은 loadEnv()가 이 파서로 검증하고, main.ts가 buildAccessPolicy로 집합을 만든다.
 * 형식이 틀린 항목을 조용히 버리면 "설정했는데 403"이 되므로 throw한다 — 기동 실패가 낫다.
 */
export interface AccessPolicy {
  /** 같은 origin 말고 /api를 부를 수 있는 Origin. 정확히 일치. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** loopback 셋 말고 허용할 Host 이름(소문자, 포트 없음). */
  readonly allowedHosts: ReadonlySet<string>;
}

/** 항상 허용하는 Host 이름. 포트는 보지 않는다 — desktop은 3000이 막히면 무작위 포트로 물러난다. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

export function parseAllowedOrigins(raw: string): string[] {
  return splitList(raw).map((item) => {
    let origin: string;
    try {
      origin = new URL(item).origin;
    } catch {
      throw new Error(`ALLOWED_ORIGINS: ${JSON.stringify(item)} is not a URL (expected e.g. http://localhost:5173)`);
    }
    if (origin === 'null' || origin !== item) {
      throw new Error(`ALLOWED_ORIGINS: ${JSON.stringify(item)} must be a bare origin like ${JSON.stringify(origin)}`);
    }
    return item;
  });
}

export function parseAllowedHosts(raw: string): string[] {
  return splitList(raw).map((item) => {
    const host = item.toLowerCase();
    if (!HOSTNAME.test(host)) {
      throw new Error(`ALLOWED_HOSTS: ${JSON.stringify(item)} must be a host name without scheme or port`);
    }
    return host;
  });
}

export function buildAccessPolicy(origins: string, hosts: string): AccessPolicy {
  return {
    allowedOrigins: new Set(parseAllowedOrigins(origins)),
    allowedHosts: new Set(parseAllowedHosts(hosts)),
  };
}
```

`be/src/config/env.ts` — import 추가, `HOST` 교체, 스키마 끝에 두 키:

```ts
import { parseAllowedHosts, parseAllowedOrigins } from '../access/access-policy';

/** 파서가 throw하면 그 메시지로 zod 이슈를 만든다 — 기동 실패 메시지에 env 이름이 남는다. */
const validatedBy = (parse: (raw: string) => unknown) => (raw: string, ctx: z.RefinementCtx) => {
  try {
    parse(raw);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
  }
};
```

```ts
  // 기본은 loopback이다(spec 2026-10-08 §3.5) — pnpm dev가 API를 LAN에 열던 0.0.0.0을 버린다.
  // 바깥에서 닿아야 하는 컨테이너는 deploy/api.Dockerfile이 ENV HOST=0.0.0.0을 준다.
  // desktop은 그와 무관하게 127.0.0.1을 마지막에 덮어쓴다(desktop/src/services/api-process.ts).
  HOST: z.string().default('127.0.0.1'),
```

```ts
  // 로컬 API 접근 제어(spec 2026-10-08 §3.4). 같은 origin 말고 /api를 부를 수 있는 Origin(쉼표 구분,
  // 정확히 일치)과, loopback 말고 허용할 Host 이름. 비우면 같은 origin·loopback만.
  ALLOWED_ORIGINS: z.string().default('').superRefine(validatedBy(parseAllowedOrigins)),
  ALLOWED_HOSTS: z.string().default('').superRefine(validatedBy(parseAllowedHosts)),
```

`deploy/api.Dockerfile` 런타임 단계:

```dockerfile
ENV NODE_ENV=production
# API 기본 HOST는 127.0.0.1이다(loopback). 컨테이너는 포트 매핑·터널로 바깥에서 닿아야 한다.
ENV HOST=0.0.0.0
```

`be/.env.example` (`PORT=3000` 바로 아래):

```bash
# 로컬 API 접근 제어(spec 2026-10-08). pnpm dev의 Vite(:5173)는 API와 다른 origin이라 여기 있어야 한다.
# 비우면 같은 origin만. 데모처럼 loopback 밖 이름으로 접속하면 ALLOWED_HOSTS에 그 이름을.
ALLOWED_ORIGINS=http://localhost:5173
# ALLOWED_HOSTS=
# HOST=127.0.0.1   # 기본값. LAN에 열려면 0.0.0.0
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm be exec jest test/env.spec.ts test/access-policy.spec.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add be/src/access/access-policy.ts be/src/config/env.ts be/test/env.spec.ts be/test/access-policy.spec.ts deploy/api.Dockerfile be/.env.example
git commit -m "feat(be): 접근 제어 허용 목록 env와 HOST 기본값 127.0.0.1"
```

---

### Task 2: be 판정 함수 `evaluateAccess`

**Files:**
- Create: `be/src/access/evaluate-access.ts`
- Test: Create `be/test/evaluate-access.spec.ts`

**Interfaces:**
- Consumes: `AccessPolicy`, `LOOPBACK_HOSTS`, `buildAccessPolicy` (Task 1)
- Produces:
  - `interface AccessRequest { method: string; path: string; headers: IncomingHttpHeaders }` (`node:http`)
  - `type AccessDenyCode = 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED'`
  - `type AccessDecision = { allow: true; corsOrigin: string | null } | { allow: false; code: AccessDenyCode; message: string }`
  - `hostnameOf(hostHeader: string | undefined): string | null`
  - `isGatedPath(method: string, path: string): boolean`
  - `evaluateAccess(req: AccessRequest, policy: AccessPolicy): AccessDecision`

- [ ] **Step 1: 실패하는 테스트**

`be/test/evaluate-access.spec.ts`:

```ts
import type { IncomingHttpHeaders } from 'node:http';
import { buildAccessPolicy } from '../src/access/access-policy';
import { evaluateAccess, hostnameOf, isGatedPath } from '../src/access/evaluate-access';

const POLICY = buildAccessPolicy('http://localhost:5173', 'damwha-demo.example');
const decide = (method: string, path: string, headers: IncomingHttpHeaders) =>
  evaluateAccess({ method, path, headers }, POLICY);
const allowed = (d: ReturnType<typeof decide>) => d.allow;
const code = (d: ReturnType<typeof decide>) => (d.allow ? null : d.code);

describe('hostnameOf', () => {
  it.each([
    ['127.0.0.1:3000', '127.0.0.1'],
    ['LOCALHOST:41234', 'localhost'],
    ['[::1]:3000', '[::1]'],
    ['damwha-demo.example', 'damwha-demo.example'],
    ['attacker@127.0.0.1', null],   // userinfo — URL 파서처럼 127.0.0.1로 읽으면 안 된다
    ['127.0.0.1:3000:1', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (h, want) => {
    expect(hostnameOf(h as string | undefined)).toBe(want);
  });
});

describe('isGatedPath', () => {
  it.each([
    ['GET', '/api/meetings', true],
    ['GET', '/API/meetings', true],
    ['GET', '/Api', true],
    ['GET', '/%61pi/meetings', true],   // 디코드해서 본다
    ['GET', '/apix', false],
    ['GET', '/', false],
    ['GET', '/docs', false],
    ['HEAD', '/meetings/m1', false],
    ['POST', '/anything', true],          // /api 밖이라도 GET·HEAD가 아니면 검사한다
    ['OPTIONS', '/', true],
    ['GET', '/%E0%A4%A', true],           // 디코드 실패 → 검사 쪽으로
  ])('%s %s → %s', (m, p, want) => {
    expect(isGatedPath(m, p)).toBe(want);
  });
});

describe('evaluateAccess — Host', () => {
  it.each([
    ['127.0.0.1:3000'], ['127.0.0.1:51234'], ['localhost:3000'], ['[::1]:3000'], ['localhost'],
    ['damwha-demo.example'], ['DAMWHA-DEMO.EXAMPLE'],
  ])('allows %s', (host) => {
    expect(allowed(decide('GET', '/api/health', { host }))).toBe(true);
  });

  it.each([['attacker.example:3000'], ['127.0.0.2:3000'], ['evil.localhost:3000'], ['']])('denies %s', (host) => {
    expect(code(decide('GET', '/api/health', { host }))).toBe('HOST_NOT_ALLOWED');
  });

  it('denies a request with no Host', () => {
    expect(code(decide('GET', '/api/health', {}))).toBe('HOST_NOT_ALLOWED');
  });

  it('checks Host outside /api too', () => {
    expect(code(decide('GET', '/', { host: 'attacker.example' }))).toBe('HOST_NOT_ALLOWED');
  });
});

describe('evaluateAccess — Origin', () => {
  const H = { host: '127.0.0.1:3000' };

  it('same origin passes without CORS', () => {
    expect(decide('POST', '/api/folders', { ...H, origin: 'http://127.0.0.1:3000' })).toEqual({ allow: true, corsOrigin: null });
  });

  it('same origin on a fallback port passes', () => {
    expect(allowed(decide('POST', '/api/folders', { host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234' }))).toBe(true);
  });

  it('IPv6 loopback same origin passes', () => {
    expect(allowed(decide('POST', '/api/folders', { host: '[::1]:3000', origin: 'http://[::1]:3000' }))).toBe(true);
  });

  it('allow-listed origin passes and gets CORS', () => {
    expect(decide('GET', '/api/meetings', { ...H, origin: 'http://localhost:5173' }))
      .toEqual({ allow: true, corsOrigin: 'http://localhost:5173' });
  });

  it('demo: https origin behind a tunnel that speaks http to us', () => {
    expect(allowed(decide('POST', '/api/search', {
      host: 'damwha-demo.example', origin: 'https://damwha-demo.example',
    }))).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://127.0.0.1:4000',          // 다른 포트
    'http://localhost:3000',          // 이름만 다른 같은 서버 — Host와 다르다
    'http://localhost:5173/',         // 끝 슬래시 — 목록과 정확히 같지 않다
    'null',
    'not a url',
  ])('denies Origin %s', (origin) => {
    expect(code(decide('POST', '/api/folders', { ...H, origin }))).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('message names the env to fix', () => {
    const d = decide('GET', '/api/meetings', { ...H, origin: 'http://localhost:5174' });
    expect(d.allow ? '' : d.message).toMatch(/ALLOWED_ORIGINS/);
  });
});

describe('evaluateAccess — no Origin', () => {
  const H = { host: '127.0.0.1:3000' };
  it.each(['cross-site', 'same-site'])('denies Sec-Fetch-Site: %s', (site) => {
    expect(code(decide('GET', '/api/meetings/m1/audio', { ...H, 'sec-fetch-site': site }))).toBe('ORIGIN_NOT_ALLOWED');
  });
  it.each(['same-origin', 'none'])('allows Sec-Fetch-Site: %s', (site) => {
    expect(allowed(decide('GET', '/api/meetings', { ...H, 'sec-fetch-site': site }))).toBe(true);
  });
  it('allows a header-less client (curl, desktop health probe, Node fetch)', () => {
    expect(decide('GET', '/api/health', { ...H, 'sec-fetch-mode': 'cors' })).toEqual({ allow: true, corsOrigin: null });
  });
  it('cross-site navigation outside /api passes (product site → demo /)', () => {
    expect(allowed(decide('GET', '/', { host: 'damwha-demo.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' }))).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm be exec jest test/evaluate-access.spec.ts`
Expected: FAIL — `Cannot find module '../src/access/evaluate-access'`.

- [ ] **Step 3: 구현**

`be/src/access/evaluate-access.ts`:

```ts
import type { IncomingHttpHeaders } from 'node:http';
import { LOOPBACK_HOSTS, type AccessPolicy } from './access-policy';

/**
 * 요청 하나를 허용할지 정하는 순수 함수 (spec 2026-10-08-local-api-access-control §3.1).
 *
 * ① Host(모든 경로) — DNS rebinding. ② 브라우저 출처(/api 아래와 GET·HEAD가 아닌 요청) — 읽기·CSRF.
 * 판정 근거는 브라우저가 강제하는 헤더뿐이다. Origin·Sec-Fetch-Site가 없는 요청(curl, desktop 헬스 프로브,
 * Node fetch)은 브라우저가 아니므로 통과한다 — 같은 Mac의 로컬 프로세스는 위협 모델 밖이다(spec §2 5번).
 * Sec-Fetch-Mode는 보지 않는다: Node fetch(undici)가 `sec-fetch-mode: cors`를 붙인다(실측).
 */
export interface AccessRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export type AccessDenyCode = 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED';

export type AccessDecision =
  | { allow: true; corsOrigin: string | null }
  | { allow: false; code: AccessDenyCode; message: string };

// URL 파서를 쓰지 않는다 — `attacker@127.0.0.1`을 127.0.0.1로 읽는다.
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i;

export function hostnameOf(hostHeader: string | undefined): string | null {
  if (hostHeader === undefined) return null;
  const m = HOST_HEADER.exec(hostHeader.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * express 라우터는 대소문자를 구분하지 않는다 — `/API/health`도 같은 핸들러로 간다(실측 200).
 * 그래서 소문자·디코드 기준으로 본다. 디코드에 실패하면 검사 쪽으로 기운다.
 * /api 밖의 GET·HEAD(SPA, 정적 파일, /docs)는 공개 코드라 검사하지 않는다 — 제품 사이트가 데모 `/`로
 * cross-site 링크를 건다. /api 밖이라도 GET·HEAD가 아니면 검사한다(처리할 라우트가 없으니 잃을 것이 없다).
 */
export function isGatedPath(method: string, path: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  if (/^\/api(\/|$)/i.test(decoded)) return true;
  return method !== 'GET' && method !== 'HEAD';
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** scheme은 비교하지 않는다 — 데모는 터널 바깥이 https, 우리에게 닿는 요청은 http다. Host는 ①을 통과한 값이다. */
function isSameOrigin(origin: string, host: string): boolean {
  if (origin === 'null') return false;
  try {
    return new URL(origin).host === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

const deny = (code: AccessDenyCode, message: string): AccessDecision => ({ allow: false, code, message });

export function evaluateAccess(req: AccessRequest, policy: AccessPolicy): AccessDecision {
  const host = single(req.headers.host);
  const hostname = hostnameOf(host);
  if (hostname === null || !(LOOPBACK_HOSTS.has(hostname) || policy.allowedHosts.has(hostname))) {
    return deny('HOST_NOT_ALLOWED', `Host ${JSON.stringify(host ?? null)} is not allowed. Add its name to ALLOWED_HOSTS.`);
  }
  if (!isGatedPath(req.method, req.path)) return { allow: true, corsOrigin: null };

  const origin = single(req.headers.origin);
  if (origin !== undefined) {
    if (policy.allowedOrigins.has(origin)) return { allow: true, corsOrigin: origin };
    if (isSameOrigin(origin, host as string)) return { allow: true, corsOrigin: null };
    return deny(
      'ORIGIN_NOT_ALLOWED',
      `Origin ${JSON.stringify(origin)} may not call this API. If it is your own dev server, add it to ALLOWED_ORIGINS.`,
    );
  }
  const site = single(req.headers['sec-fetch-site']);
  if (site === 'cross-site' || site === 'same-site') {
    return deny('ORIGIN_NOT_ALLOWED', `Sec-Fetch-Site: ${site} request without an allowed Origin.`);
  }
  return { allow: true, corsOrigin: null };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm be exec jest test/evaluate-access.spec.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add be/src/access/evaluate-access.ts be/test/evaluate-access.spec.ts
git commit -m "feat(be): Host·Origin 접근 판정 함수"
```

---

### Task 3: be 미들웨어·`configureHttp`·공격 시나리오 e2e

**Files:**
- Create: `be/src/access/access-control.middleware.ts`
- Create: `be/src/http/configure-http.ts`
- Modify: `be/src/main.ts` (전체 — 아래)
- Test: Create `be/test/access-control.e2e-spec.ts`

**Interfaces:**
- Consumes: `evaluateAccess` (Task 2), `buildAccessPolicy`, `AccessPolicy` (Task 1)
- Produces:
  - `accessControl(policy: AccessPolicy): RequestHandler` (express)
  - `interface HttpOptions { policy: AccessPolicy; publicDir: string | null }`
  - `configureHttp(app: NestExpressApplication, options: HttpOptions): void`

- [ ] **Step 1: 실패하는 e2e**

`be/test/access-control.e2e-spec.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { buildAccessPolicy } from '../src/access/access-policy';
import { configureHttp } from '../src/http/configure-http';
import { startTestDb, StartedTestDb } from './db';

/**
 * spec 2026-10-08-local-api-access-control §6 — 공격 시나리오별 e2e. 앱은 main.ts와 같은 configureHttp로 만든다.
 * "거부됐다"는 403만으로 보지 않는다: 쓰기 시나리오는 DB에 행이 생기지 않았는지까지 본다.
 */
const DEV = 'http://localhost:5173';
const EVIL = 'https://evil.example';
const DEMO_HOST = 'damwha-demo.example';
const SELF_HOST = '127.0.0.1:3000';
const SELF = `http://${SELF_HOST}`;

describe('local API access control', () => {
  let db: StartedTestDb;
  let app: NestExpressApplication;
  let publicDir: string;

  beforeAll(async () => {
    db = await startTestDb();
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damwha-spa-'));
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>spa</title>');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureHttp(app, { policy: buildAccessPolicy(DEV, DEMO_HOST), publicDir });
    await app.init();
  });
  afterEach(async () => { await db.reset(); });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const count = async (sql: string, args: unknown[] = []) => Number((await db.pool.query(sql, args)).rows[0].n);
  const meetingCount = () => count('SELECT count(*) AS n FROM meeting');
  const folderNamed = (name: string) => count('SELECT count(*) AS n FROM folder WHERE name = $1', [name]);
  /** 헤더 없는 요청(접근 제어를 통과하는 모양)으로 오디오가 있는 회의를 만든다. */
  const seedMeeting = async () =>
    (await http().post('/api/meetings').set('Host', SELF_HOST)
      .attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' })
      .expect(201)).body.id as string;

  describe('1·읽기', () => {
    it('다른 Origin의 GET은 403이고 ACAO가 없다', async () => {
      const res = await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL).expect(403);
      expect(res.body).toMatchObject({ statusCode: 403, code: 'ORIGIN_NOT_ALLOWED' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('2~4·CSRF simple request', () => {
    it('urlencoded form POST는 403이고 폴더가 생기지 않는다', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST).set('Origin', EVIL)
        .type('form').send('name=csrf-probe').expect(403);
      expect(await folderNamed('csrf-probe')).toBe(0);
    });

    it('multipart 업로드는 403이고 회의도 파일도 생기지 않는다', async () => {
      await http().post('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL)
        .attach('audio', Buffer.from('0123456789'), { filename: 'a.wav', contentType: 'audio/wav' })
        .expect(403);
      expect(await meetingCount()).toBe(0);
      expect(fs.existsSync(path.join(db.storageRoot, 'meetings'))
        ? fs.readdirSync(path.join(db.storageRoot, 'meetings')) : []).toEqual([]);
    });

    it('text/plain으로 실시간 녹음 시작은 403이고 회의가 생기지 않는다', async () => {
      await http().post('/api/meetings/live').set('Host', SELF_HOST).set('Origin', EVIL)
        .set('Content-Type', 'text/plain').send('{}').expect(403);
      expect(await meetingCount()).toBe(0);
    });
  });

  describe('5·Origin 없는 cross-site no-cors GET', () => {
    it.each(['cross-site', 'same-site'])('Sec-Fetch-Site: %s 오디오 요청은 403', async (site) => {
      const id = await seedMeeting();
      await http().get(`/api/meetings/${id}/audio`).set('Host', SELF_HOST).set('Sec-Fetch-Site', site).expect(403);
    });
  });

  describe('6·preflight', () => {
    it('다른 Origin의 preflight는 403이고 ACAO가 없다', async () => {
      const res = await http().options('/api/meetings/mtg_1').set('Host', SELF_HOST).set('Origin', EVIL)
        .set('Access-Control-Request-Method', 'DELETE').expect(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('허용 Origin의 preflight는 204와 그 Origin을 담은 CORS 헤더', async () => {
      const res = await http().options('/api/meetings/mtg_1/live/audio').set('Host', SELF_HOST).set('Origin', DEV)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-audio-offset').expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(DEV);
      expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
      expect(res.headers['access-control-allow-headers']).toBe('content-type,x-audio-offset');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('7·DNS rebinding', () => {
    it.each(['/api/health', '/docs', '/'])('Host가 공격자 이름이면 %s도 403', async (p) => {
      const res = await http().get(p).set('Host', 'attacker.example:3000').expect(403);
      expect(res.body.code).toBe('HOST_NOT_ALLOWED');
    });
  });

  describe('8·정상 경로', () => {
    it('packaged 모양: 같은 origin의 POST·GET·DELETE', async () => {
      const created = await http().post('/api/folders').set('Host', SELF_HOST).set('Origin', SELF)
        .send({ name: '같은 origin' }).expect(201);
      expect(created.headers['access-control-allow-origin']).toBeUndefined();
      await http().get('/api/folders').set('Host', SELF_HOST).set('Sec-Fetch-Site', 'same-origin').expect(200);
      await http().delete(`/api/folders/${created.body.id}`).set('Host', SELF_HOST).set('Origin', SELF).expect(204);
    });

    it('dev 모양: 허용 Origin의 GET에 그 Origin의 ACAO', async () => {
      const res = await http().get('/api/meetings').set('Host', 'localhost:3000').set('Origin', DEV).expect(200);
      expect(res.headers['access-control-allow-origin']).toBe(DEV);
      expect(res.headers.vary).toMatch(/Origin/);
    });

    it('헬스 프로브 모양: 헤더 없는 요청은 통과하고 ACAO가 없다', async () => {
      const res = await http().get('/api/health').set('Host', SELF_HOST).set('Sec-Fetch-Mode', 'cors').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('dev 오디오: 허용 Origin의 Range 요청은 206과 ACAO', async () => {
      const id = await seedMeeting();
      const res = await http().get(`/api/meetings/${id}/audio`).set('Host', SELF_HOST).set('Origin', DEV)
        .set('Range', 'bytes=2-5').expect(206);
      expect(res.headers['access-control-allow-origin']).toBe(DEV);
    });

    it('데모 모양: https Origin + 데모 Host', async () => {
      await http().post('/api/folders').set('Host', DEMO_HOST).set('Origin', `https://${DEMO_HOST}`)
        .send({ name: '데모' }).expect(201);
    });

    it('제품 사이트에서 데모 / 로의 cross-site 내비게이션은 SPA를 준다', async () => {
      const res = await http().get('/').set('Host', DEMO_HOST)
        .set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Mode', 'navigate').expect(200);
      expect(res.text).toContain('<title>spa</title>');
    });
  });

  describe('9·클릭재킹 헤더', () => {
    const framed = (res: request.Response) => {
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
    };
    it('200에도', async () => framed(await http().get('/api/health').set('Host', SELF_HOST).expect(200)));
    it('HOST_NOT_ALLOWED 403에도', async () => framed(await http().get('/api/health').set('Host', 'attacker.example').expect(403)));
    it('ORIGIN_NOT_ALLOWED 403에도', async () =>
      framed(await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL).expect(403)));
  });

  describe('10·접근 제어가 본문 파서보다 먼저', () => {
    const bigJson = JSON.stringify({ name: 'x'.repeat(1_500_000) });   // json 파서 상한 1mb 초과
    const bigForm = `name=${'x'.repeat(200_000)}`;                     // Nest urlencoded 기본 상한 100kb 초과

    it('대조군: 허용된 요청이면 큰 JSON은 413 — 이 크기가 파서에 걸린다는 증거', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST)
        .set('Content-Type', 'application/json').send(bigJson).expect(413);
    });
    it('대조군: 허용된 요청이면 큰 urlencoded도 413', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST).type('form').send(bigForm).expect(413);
    });
    it('다른 Origin의 큰 JSON은 413이 아니라 403', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST).set('Origin', EVIL)
        .set('Content-Type', 'application/json').send(bigJson).expect(403);
    });
    it('다른 Origin의 큰 urlencoded는 413이 아니라 403', async () => {
      await http().post('/api/folders').set('Host', SELF_HOST).set('Origin', EVIL).type('form').send(bigForm).expect(403);
    });
  });

  describe('11·경로 대소문자', () => {
    it('대조군: /API/meetings도 라우터가 처리한다', async () => {
      await http().get('/API/meetings').set('Host', SELF_HOST).expect(200);
    });
    it('다른 Origin의 GET /API/meetings는 403', async () => {
      await http().get('/API/meetings').set('Host', SELF_HOST).set('Origin', EVIL).expect(403);
    });
    it('다른 Origin의 urlencoded POST /Api/folders는 403이고 폴더가 없다', async () => {
      await http().post('/Api/folders').set('Host', SELF_HOST).set('Origin', EVIL).type('form').send('name=case-probe').expect(403);
      expect(await folderNamed('case-probe')).toBe(0);
    });
  });

  it('어떤 응답에도 ACAO: *가 없다', async () => {
    for (const r of [
      await http().get('/api/health').set('Host', SELF_HOST),
      await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', DEV),
      await http().get('/api/meetings').set('Host', SELF_HOST).set('Origin', EVIL),
    ]) {
      expect(r.headers['access-control-allow-origin']).not.toBe('*');
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm be exec jest test/access-control.e2e-spec.ts`
Expected: FAIL — `Cannot find module '../src/http/configure-http'`.

- [ ] **Step 3: 미들웨어 구현**

`be/src/access/access-control.middleware.ts`:

```ts
import type { RequestHandler } from 'express';
import type { AccessPolicy } from './access-policy';
import { evaluateAccess } from './evaluate-access';

const ALLOW_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

/**
 * 로컬 API 접근 제어 + CORS (spec 2026-10-08 §3.1~§3.2). `app.enableCors()`를 대신한다 — CORS 판정과 접근 판정이
 * 따로 놀면 어긋나므로 evaluateAccess 하나로 둘 다 정한다. configureHttp의 첫 미들웨어여야 한다.
 *
 * 프레임 헤더를 판정보다 먼저 건다: 같은 origin 요청은 ②를 통과하므로, 악성 페이지가 앱을 iframe에 넣고
 * 사용자를 속여 버튼을 누르게 하는 경로는 이 헤더만 막는다. 403에도 실린다.
 */
export function accessControl(policy: AccessPolicy): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');

    const decision = evaluateAccess({ method: req.method, path: req.path, headers: req.headers }, policy);
    if (!decision.allow) {
      res.status(403).json({ statusCode: 403, code: decision.code, message: decision.message });
      return;
    }
    if (decision.corsOrigin !== null) {
      res.setHeader('Access-Control-Allow-Origin', decision.corsOrigin);
      res.append('Vary', 'Origin');
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
        res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
        const requested = req.headers['access-control-request-headers'];
        if (requested !== undefined) res.setHeader('Access-Control-Allow-Headers', requested);
        res.setHeader('Access-Control-Max-Age', '600');
        res.append('Vary', 'Access-Control-Request-Headers');
        res.status(204).end();
        return;
      }
    }
    next();
  };
}
```

- [ ] **Step 4: `configureHttp`와 `main.ts`**

`be/src/http/configure-http.ts`:

```ts
import * as path from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { accessControl } from '../access/access-control.middleware';
import type { AccessPolicy } from '../access/access-policy';

export interface HttpOptions {
  policy: AccessPolicy;
  /** 배포 이미지의 SPA 산출물(dist/public). 없으면 null — dev와 테스트. */
  publicDir: string | null;
}

/**
 * main.ts의 HTTP 구성 전부. 접근 제어 e2e가 같은 함수로 앱을 만든다 — 테스트하는 구성이 곧 운영 구성이다.
 *
 * **순서가 계약이다** (spec 2026-10-08 §3.3): 접근 제어 → JSON 파서 → prefix → SPA → Swagger. useBodyParser도
 * 내부에서 app.use를 부르고 Nest 기본 파서(urlencoded 포함)는 init()에서 붙으므로, 접근 제어가 먼저여야
 * 거부된 요청의 본문을 읽지 않는다. SPA·Swagger도 그 뒤라 DNS rebinding의 Host 검사를 받는다.
 */
export function configureHttp(app: NestExpressApplication, { policy, publicDir }: HttpOptions): void {
  app.use(accessControl(policy));
  // 회의 메모(meeting_note) 상한이 100,000자 — UTF-8로 한글은 글자당 3바이트라
  // 약 300KB. Express 기본 100kb 제한으로는 스펙의 상한 자체에 도달할 수 없다.
  app.useBodyParser('json', { limit: '1mb' });
  // 모든 API는 /api 아래. SPA 라우트(/meetings/:id)와 API(GET /meetings/:id)가 같은
  // 경로라 한 origin에서 같이 서빙하려면 한쪽에 prefix가 있어야 한다. Swagger는 /docs 그대로.
  app.setGlobalPrefix('api');

  // publicDir이 있으면(배포 이미지 — deploy/api.Dockerfile이 Vite 산출물을 넣는다) SPA도 같이 서빙한다.
  // init 전에 미들웨어로 거는 이유: init이 붙이는 Nest 404 핸들러 뒤에 오면 절대 실행되지 않는다.
  if (publicDir !== null) {
    app.useStaticAssets(publicDir);
    // /api·/docs 밖의 GET은 전부 index.html — 클라이언트 라우터가 받는다.
    const spa = /^\/(?!api(\/|$)|docs(\/|$)|docs-json$).*/;
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && spa.test(req.path)) res.sendFile(path.join(publicDir, 'index.html'));
      else next();
    });
  }

  const config = new DocumentBuilder()
    .setTitle('Damwha API')
    .setDescription('회의 녹음 인제스트/검색 백엔드 (NestJS). 발화(utterance)가 1급 객체.')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
```

`be/src/main.ts` 전체:

```ts
import 'dotenv/config';
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { buildAccessPolicy } from './access/access-policy';
import { loadEnv } from './config/env';
import { configureHttp } from './http/configure-http';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const publicDir = path.join(__dirname, 'public');
  configureHttp(app, {
    policy: buildAccessPolicy(env.ALLOWED_ORIGINS, env.ALLOWED_HOSTS),
    publicDir: fs.existsSync(publicDir) ? publicDir : null,
  });
  await app.listen(env.PORT, env.HOST);
  Logger.log(`Damwha API listening on ${env.HOST}:${env.PORT} (docs at /docs)`, 'Bootstrap');
}
bootstrap().catch((e: unknown) => {
  // DatabaseService.onModuleInit의 DB 프로브 실패 등 — 스택 대신 원인 한 줄로 끝낸다
  Logger.error(`startup failed: ${e instanceof Error ? e.message : String(e)}`, 'Bootstrap');
  process.exit(1);
});
```

- [ ] **Step 5: 통과 확인**

Run: `pnpm be exec jest test/access-control.e2e-spec.ts`
Expected: PASS. 413 대조군이 403이면 접근 제어가 허용 요청까지 막는 것이고, 대조군이 통과하는데 공격 행이 413이면 순서가
틀린 것이다. multipart·대형 본문 행이 `ECONNRESET`/`EPIPE`로 깨지면(서버가 본문을 다 읽기 전에 응답한다) 그 원인을
확인하고, 상태 코드 단언은 빼지 않는다 — 클라이언트 오류로 끝난 행은 통과로 치지 않는다.

- [ ] **Step 6: 기존 be 전체 회귀**

Run: `pnpm be test`
Expected: PASS (기존 e2e는 configureHttp를 거치지 않으므로 변화 없음). `pnpm be exec tsc --noEmit -p tsconfig.build.json` PASS.

- [ ] **Step 7: 커밋**

```bash
git add be/src/access/access-control.middleware.ts be/src/http/configure-http.ts be/src/main.ts be/test/access-control.e2e-spec.ts
git commit -m "feat(be): 로컬 API 접근 제어 미들웨어 — enableCors를 Host·Origin 검사로 대체"
```

---

### Task 4: be 보안 테스트 변이 확인

**Files:** 코드 변경 없음(변이는 확인 후 되돌린다). 결과를 `docs/superpowers/reports/` 작성 때 쓸 수 있게
`.omo/notes/2026-10-08-mutations.md`(커밋하지 않는 로컬 메모)에 적는다.

각 변이는 한 번에 하나만 넣고, 지정한 테스트를 돌려 **실패하는지** 본 뒤 `git checkout -- <파일>`로 되돌린다. 실패하지
않으면 테스트를 고치고 Task 3에 이어 커밋한다.

- [ ] **M1 Host 검사 제거** — `evaluate-access.ts`의 Host `if` 블록을 지운다.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "DNS rebinding"` → Expected: FAIL 3건.
- [ ] **M2 Origin 거부 제거** — `origin !== undefined` 블록의 마지막 `return deny(...)`를 `return { allow: true, corsOrigin: null };`로.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "읽기|CSRF|preflight|대소문자"` → Expected: 각 describe에서 FAIL.
- [ ] **M3 Sec-Fetch-Site 분기 제거** — `site === 'cross-site' ...` `if`를 지운다.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "no-cors"` → Expected: FAIL 2건.
- [ ] **M4 `enableCors()` 되살리기** — `configureHttp`의 `app.use(accessControl(policy));` 다음 줄에 `app.enableCors();`.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "정상 경로|ACAO"` → Expected: FAIL (헤더 없는 요청에 `*`, DEV가 `*`로 덮임).
- [ ] **M5 순서 뒤집기** — `app.use(accessControl(policy));`를 `useBodyParser` 다음 줄로 옮긴다.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "본문 파서"` → Expected: "큰 JSON은 413이 아니라 403" FAIL.
  (urlencoded 파서는 init()에서 붙으므로 이 변이로는 그대로 403이다 — 결과에 그렇게 적는다.)
- [ ] **M6 경로 대소문자 구분** — `isGatedPath` 정규식의 `/i`를 지운다.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "대소문자"` → Expected: "GET /API/meetings는 403" FAIL.
- [ ] **M7 프레임 헤더를 판정 뒤로** — `accessControl`에서 두 `setHeader`를 `next();` 바로 앞으로 옮긴다.
  Run: `pnpm be exec jest test/access-control.e2e-spec.ts -t "클릭재킹"` → Expected: 403 두 건 FAIL.
- [ ] **되돌림 확인** — `git status --short be/` 가 비어 있고 `pnpm be exec jest test/access-control.e2e-spec.ts` PASS.

---

### Task 5: fe — `<audio crossOrigin>`과 Vite 포트 고정

**Files:**
- Modify: `fe/src/pages/meeting.tsx:796` (`<audio>` props)
- Modify: `fe/src/shared/lib/use-sample-player.tsx:52` (`<audio>` props)
- Modify: `fe/vite.config.ts` (`server` 블록)
- Test: `fe/src/pages/meeting.test.tsx`, Create `fe/src/shared/lib/use-sample-player.test.tsx`, Create `fe/src/vite-config.test.ts`

- [ ] **Step 1: 실패하는 테스트**

`fe/src/pages/meeting.test.tsx` 끝에:

```tsx
test("오디오는 CORS 모드로 요청한다 — dev cross-origin에서 Origin이 실려야 API가 통과시킨다", async () => {
  const { container } = renderShell();
  await screen.findByRole("heading", { level: 1, name: "기획회의 — UI 개선안" });
  expect(container.querySelector("audio")!.getAttribute("crossorigin")).toBe("anonymous");
});
```

`fe/src/shared/lib/use-sample-player.test.tsx`:

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { useSamplePlayer } from "./use-sample-player";

afterEach(cleanup);

function Host() {
  return useSamplePlayer().element;
}

test("미리듣기 <audio>도 CORS 모드다 (spec 2026-10-08 §3.7)", () => {
  const { container } = render(<Host />);
  expect(container.querySelector("audio")!.getAttribute("crossorigin")).toBe("anonymous");
});
```

`fe/src/vite-config.test.ts`:

```ts
// @vitest-environment node
import { expect, test } from "vitest";

import config from "../vite.config";

test("Vite는 5173에 고정된다 — 허용 Origin(ALLOWED_ORIGINS)과 desktop dev가 이 포트를 전제한다", () => {
  expect(config.server).toMatchObject({ port: 5173, strictPort: true });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm fe exec vitest run src/pages/meeting.test.tsx src/shared/lib/use-sample-player.test.tsx src/vite-config.test.ts`
Expected: FAIL 3건 (`crossorigin`이 null, `config.server` undefined).

- [ ] **Step 3: 구현**

`fe/src/pages/meeting.tsx` `<audio>`에 `src` 다음 줄:

```tsx
          // dev는 API가 다른 origin이다(:5173 → :3000). CORS 모드여야 브라우저가 Origin을 싣고, API의 접근 제어가
          // 허용 Origin으로 통과시킨다 — no-cors면 Sec-Fetch-Site만 보고 403이다(spec 2026-10-08 §3.7).
          crossOrigin="anonymous"
```

`fe/src/shared/lib/use-sample-player.tsx` `<audio>`에 `ref` 다음 줄:

```tsx
      // 메인 플레이어와 같은 이유로 CORS 모드다(pages/meeting.tsx).
      crossOrigin="anonymous"
```

`fe/vite.config.ts`의 `plugins` 다음:

```ts
  // 5173 고정. be의 ALLOWED_ORIGINS와 desktop dev(VITE_ORIGIN)가 이 origin을 전제한다 — 포트가 차 있을 때
  // 다음 포트로 옮겨 가면 조용히 403이 나므로, 옮기지 말고 실패한다(spec 2026-10-08 §3.4).
  server: { port: 5173, strictPort: true },
```

- [ ] **Step 4: 통과 확인**

Run: 같은 명령 → PASS. 이어서 `pnpm fe test` 전체와 `pnpm fe lint` PASS.

- [ ] **Step 5: 커밋**

```bash
git add fe/src/pages/meeting.tsx fe/src/shared/lib/use-sample-player.tsx fe/vite.config.ts fe/src/pages/meeting.test.tsx fe/src/shared/lib/use-sample-player.test.tsx fe/src/vite-config.test.ts
git commit -m "feat(fe): 오디오를 CORS 모드로 요청하고 Vite를 5173에 고정"
```

---

### Task 6: desktop — API 자식 env의 최종값과 config.json 거부

**Files:**
- Create: `desktop/src/dev/vite-origin.ts`
- Modify: `desktop/src/main.ts:144` (지역 상수 → import)
- Modify: `desktop/src/services/api-process.ts:42-47` (`apiChildEnv`), `:112`, `:189` (호출)
- Modify: `desktop/src/config/config.ts:106-124` (`APP_OWNED_KEYS`)
- Test: `desktop/tests/services/api-process.test.ts`, `desktop/tests/config/config.test.ts`, `desktop/tests/process/readiness.test.ts`

**Interfaces:**
- Produces: `export const VITE_ORIGIN = "http://localhost:5173"` (`src/dev/vite-origin.ts`);
  `export type ApiLaunchMode = "dev" | "packaged"`;
  `apiChildEnv(env: ApiEnv, mode: ApiLaunchMode, inherited?: Record<string, string | undefined>): Record<string, string>`

- [ ] **Step 1: 실패하는 테스트**

`desktop/tests/services/api-process.test.ts` — 기존 `apiChildEnv` 호출에 `"dev"`를 넣고(`apiChildEnv(LIVE, "dev", {...})`), describe에 추가:

```ts
  it("dev: ALLOWED_ORIGINS is the Vite origin whatever the shell or config says, ALLOWED_HOSTS is gone", () => {
    const env = apiChildEnv(
      { ...LIVE, ALLOWED_ORIGINS: "https://evil.example", ALLOWED_HOSTS: "evil.example" },
      "dev",
      { ALLOWED_ORIGINS: "https://shell.example", ALLOWED_HOSTS: "shell.example" },
    );
    expect(env.ALLOWED_ORIGINS).toBe("http://localhost:5173");
    expect("ALLOWED_HOSTS" in env).toBe(false);
  });

  it("packaged: neither key survives — the renderer is same-origin with the API", () => {
    const env = apiChildEnv(
      { ...LIVE, ALLOWED_ORIGINS: "https://evil.example" },
      "packaged",
      { ALLOWED_ORIGINS: "https://shell.example", ALLOWED_HOSTS: "shell.example" },
    );
    expect("ALLOWED_ORIGINS" in env).toBe(false);
    expect("ALLOWED_HOSTS" in env).toBe(false);
    expect(env.HOST).toBe("127.0.0.1");
  });
```

`launchDev` 테스트에 `vi.stubEnv("ALLOWED_ORIGINS", "https://shell.example");`와
`expect(env.ALLOWED_ORIGINS).toBe("http://localhost:5173");`, `launchPackaged` 테스트에 같은 stub과
`expect("ALLOWED_ORIGINS" in env).toBe(false);`를 더한다 — 런처가 모드를 맞게 넘기는지 본다.

`desktop/tests/config/config.test.ts`의 `describe("loadConfig — app-owned keys")`에:

```ts
  it("never lets config.json loosen the API's access lists", () => {
    // 설정 파일 한 줄로 아무 웹페이지가 로컬 API를 읽게 되면 안 된다(spec 2026-10-08 §3.6). HOST와 같은 규칙이다.
    const dir = mkdtempSync(join(tmpdir(), "damwha-cfg-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ ALLOWED_ORIGINS: "https://evil.example", ALLOWED_HOSTS: "evil.example" }),
    );
    const c = loadConfig(dir);
    expect(c.env.ALLOWED_ORIGINS).toBeUndefined();
    expect(c.env.ALLOWED_HOSTS).toBeUndefined();
    expect(c.warning).toMatch(/ALLOWED_ORIGINS/);
    expect(c.warning).toMatch(/ALLOWED_HOSTS/);
  });
```

`desktop/tests/process/readiness.test.ts`의 `describe("probeHealth")`에:

```ts
  it("sends no headers — the API lets a header-less client through (spec 2026-10-08 §3.6)", async () => {
    // Origin·Sec-Fetch-Site를 실으면 be의 접근 제어가 브라우저로 보고 판정한다. init에는 signal만 있어야 한다.
    let seen: Record<string, unknown> | undefined;
    await probeHealth("http://127.0.0.1:3000", async (_url, init) => {
      seen = init as Record<string, unknown>;
      return { status: 200 } as Response;
    });
    expect(Object.keys(seen ?? {})).toEqual(["signal"]);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter damwha-desktop exec vitest run tests/services/api-process.test.ts tests/config/config.test.ts tests/process/readiness.test.ts`
Expected: FAIL (api-process 새 행들, config 새 행). readiness 행은 이미 통과할 수 있다 — 현재 동작을 고정하는 계약 테스트다.

- [ ] **Step 3: 구현**

`desktop/src/dev/vite-origin.ts`:

```ts
/**
 * dev 렌더러의 origin. 세 곳이 같은 값을 써야 한다: 창이 여는 URL(main.ts), 권한·내비게이션 허용 목록(main.ts),
 * 그리고 API 자식의 ALLOWED_ORIGINS(services/api-process.ts — spec 2026-10-08 §3.6). fe/vite.config.ts가
 * strictPort로 이 포트에 고정한다.
 */
export const VITE_ORIGIN = "http://localhost:5173";
```

`desktop/src/main.ts:144`: `const VITE_ORIGIN = "http://localhost:5173";`를 지우고 import 블록에
`import { VITE_ORIGIN } from "./dev/vite-origin";`.

`desktop/src/services/api-process.ts` — import에 `import { VITE_ORIGIN } from "../dev/vite-origin";`, 함수 교체:

```ts
export type ApiLaunchMode = "dev" | "packaged";

/**
 * (기존 주석 유지) …
 * - HOST가 **마지막**이다. config.json 한 줄로 LAN에 열리지 않는다.
 * - ALLOWED_ORIGINS·ALLOWED_HOSTS도 여기서 **최종값**을 정한다(spec 2026-10-08 §3.6). 상속 env나 config.json에서 온
 *   값은 남기지 않는다: packaged는 렌더러가 API와 같은 origin이라 둘 다 없고, dev는 Vite origin 하나다.
 *   (dev의 be는 be/.env를 dotenv로 읽지만 dotenv는 이미 있는 env를 덮지 않으므로 ALLOWED_ORIGINS는 이 값이 이긴다.)
 */
export function apiChildEnv(
  env: ApiEnv,
  mode: ApiLaunchMode,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...nodeChildEnv(env, inherited), HOST: "127.0.0.1" };
  delete out.ALLOWED_ORIGINS;
  delete out.ALLOWED_HOSTS;
  if (mode === "dev") out.ALLOWED_ORIGINS = VITE_ORIGIN;
  return out;
}
```

`launchPackaged`의 `env: apiChildEnv(options.env),` → `env: apiChildEnv(options.env, "packaged"),`
`launchDev`의 `env: apiChildEnv(options.env),` → `env: apiChildEnv(options.env, "dev"),`

`desktop/src/config/config.ts` `APP_OWNED_KEYS`에 `EMBED_SERVICE_HOST` 다음 두 줄:

```ts
  ["ALLOWED_ORIGINS", { rule: "앱이 정합니다 — packaged는 같은 origin만, dev는 Vite origin만 API를 부를 수 있어요" }],
  ["ALLOWED_HOSTS", { rule: "앱이 정합니다 — API는 loopback 이름으로만 받아요" }],
```

(같은 파일의 `APP_OWNED_KEYS` 머리 주석 목록에도 한 줄: `ALLOWED_ORIGINS·ALLOWED_HOSTS: 로컬 API 접근 제어(spec 2026-10-08 §3.6). 파일 한 줄로 아무 웹페이지가 API를 읽게 되면 안 된다.`)

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter damwha-desktop test` (전체 — 테스트 수가 0이 아닌지 출력에서 확인) → PASS.
`pnpm --filter damwha-desktop run lint` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/dev/vite-origin.ts desktop/src/main.ts desktop/src/services/api-process.ts desktop/src/config/config.ts desktop/tests/services/api-process.test.ts desktop/tests/config/config.test.ts desktop/tests/process/readiness.test.ts
git commit -m "feat(desktop): API 자식의 허용 Origin을 앱이 정한다 — dev는 Vite origin, packaged는 없음"
```

---

### Task 7: worker — 브라우저 금지 판정 `browser_guard`

**Files:**
- Create: `be/worker/damwha_worker/browser_guard.py`
- Test: Create `be/worker/tests/test_browser_guard.py`

**Interfaces:**
- Produces:
  - `LOOPBACK_HOSTS: frozenset[str]` = `{"localhost", "127.0.0.1", "[::1]"}`
  - `hostname_of(host_header: str | None) -> str | None`
  - `allowed_hostnames(bind_host: str | None) -> frozenset[str]`
  - `rejection(get_header: Callable[[str], str | None], bind_host: str | None) -> str | None` — 거부 사유 또는 None.
    `get_header`는 대소문자 무시 조회(starlette `Headers.get`, `http.client.HTTPMessage.get` 둘 다 그렇다).

- [ ] **Step 1: 실패하는 테스트**

`be/worker/tests/test_browser_guard.py`:

```python
"""embed·LLM 서버의 '브라우저 금지' 판정 (spec 2026-10-08-local-api-access-control §3.8).

두 서버의 클라이언트는 be(Node fetch)·desktop 프로브(Node fetch)·worker(httpx)뿐이라 Origin·Sec-Fetch-Site를
싣지 않는다. 실린 요청은 브라우저다. Host는 rebinding을 막는다.
"""

import pytest

from damwha_worker import browser_guard as bg


def _get(headers):
    lowered = {k.lower(): v for k, v in headers.items()}
    return lambda name: lowered.get(name.lower())


@pytest.mark.parametrize(
    ("header", "want"),
    [
        ("127.0.0.1:8100", "127.0.0.1"),
        ("LOCALHOST:8100", "localhost"),
        ("[::1]:8100", "[::1]"),
        ("attacker@127.0.0.1", None),
        ("", None),
        (None, None),
    ],
)
def test_hostname_of(header, want):
    assert bg.hostname_of(header) == want


@pytest.mark.parametrize("bind", [None, "127.0.0.1", "0.0.0.0", "::", ""])
def test_wildcard_or_loopback_bind_allows_only_loopback(bind):
    assert bg.allowed_hostnames(bind) == bg.LOOPBACK_HOSTS


def test_named_bind_host_is_also_allowed():
    assert bg.allowed_hostnames("Mac-Studio.local") == bg.LOOPBACK_HOSTS | {"mac-studio.local"}


def test_bare_ipv6_bind_is_bracketed():
    assert "[fd00::1]" in bg.allowed_hostnames("fd00::1")


def test_server_client_passes():
    # Node fetch는 sec-fetch-mode를 붙인다(실측) — 그건 브라우저 신호가 아니다.
    assert bg.rejection(_get({"Host": "127.0.0.1:8100", "Sec-Fetch-Mode": "cors"}), None) is None


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "127.0.0.1:8100", "Origin": "https://evil.example"},
        {"Host": "127.0.0.1:8100", "Origin": "null"},
        {"Host": "127.0.0.1:8100", "Sec-Fetch-Site": "cross-site"},
        {"Host": "127.0.0.1:8100", "Sec-Fetch-Site": "same-origin"},  # rebinding 뒤엔 같은 origin이다
        {"Host": "attacker.example:8100"},
        {},
    ],
)
def test_browser_or_foreign_host_is_rejected(headers):
    assert bg.rejection(_get(headers), None) is not None


def test_origin_is_rejected_even_with_a_named_bind_host():
    assert bg.rejection(_get({"Host": "mac-studio.local:8100", "Origin": "http://mac-studio.local:8100"}), "mac-studio.local")


def test_named_bind_host_passes_for_server_clients():
    assert bg.rejection(_get({"Host": "mac-studio.local:8100"}), "mac-studio.local") is None
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --directory be/worker pytest tests/test_browser_guard.py -q`
Expected: FAIL — `ImportError: cannot import name 'browser_guard'`.

- [ ] **Step 3: 구현**

`be/worker/damwha_worker/browser_guard.py`:

```python
"""embed·LLM 서버의 '브라우저 금지' 판정 (spec 2026-10-08-local-api-access-control §3.8).

두 서버는 브라우저 클라이언트가 없다 — be·desktop 프로브는 Node fetch, worker는 httpx로 부르고 어느 쪽도
Origin·Sec-Fetch-Site를 싣지 않는다. 그래서 그 둘 중 하나라도 있으면 브라우저로 보고 거부한다(설정과 관계없이).
Sec-Fetch-Mode는 보지 않는다: Node fetch(undici)가 `sec-fetch-mode: cors`를 붙인다(실측).

Host는 DNS rebinding을 막는다. loopback 셋에 더해 **설정된 bind 호스트 이름**도 받는다 —
EMBED_SERVICE_ALLOW_NON_LOOPBACK·embed_service_host·LENS_LLM_BASE_URL로 loopback 밖에 띄우는 구성이 아직 있고,
그 클라이언트는 그 이름을 Host로 보낸다. 와일드카드 bind(0.0.0.0, ::)는 이름이 아니므로 더하지 않는다.

이 모듈은 아무것도 import하지 않는다 — llm_entry가 mlx를 올리기 전에, embed_service가 모델을 올리기 전에 쓴다.
"""

from __future__ import annotations

import re
from collections.abc import Callable

LOOPBACK_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "[::1]"})
_WILDCARD_BINDS = frozenset({"", "0.0.0.0", "::", "[::]"})
# URL 파서를 쓰지 않는다 — `attacker@127.0.0.1`을 127.0.0.1로 읽는다.
_HOST_HEADER = re.compile(r"^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$", re.IGNORECASE)


def hostname_of(host_header: str | None) -> str | None:
    if host_header is None:
        return None
    m = _HOST_HEADER.match(host_header.strip())
    return m.group(1).lower() if m else None


def allowed_hostnames(bind_host: str | None) -> frozenset[str]:
    if bind_host is None:
        return LOOPBACK_HOSTS
    name = bind_host.strip().lower()
    if name in _WILDCARD_BINDS:
        return LOOPBACK_HOSTS
    if ":" in name and not name.startswith("["):
        name = f"[{name}]"  # Host 헤더의 IPv6는 대괄호 안에 온다
    return LOOPBACK_HOSTS | {name}


def rejection(get_header: Callable[[str], str | None], bind_host: str | None) -> str | None:
    """거부 사유, 또는 통과면 None. `get_header`는 대소문자를 무시하는 헤더 조회다."""
    if get_header("origin") is not None:
        return "browser requests are not accepted (Origin)"
    if get_header("sec-fetch-site") is not None:
        return "browser requests are not accepted (Sec-Fetch-Site)"
    name = hostname_of(get_header("host"))
    if name is None or name not in allowed_hostnames(bind_host):
        return "Host is not allowed"
    return None
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --directory be/worker pytest tests/test_browser_guard.py -q` → PASS.
`uv run --directory be/worker ruff check damwha_worker/browser_guard.py tests/test_browser_guard.py` → 깨끗.

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/browser_guard.py be/worker/tests/test_browser_guard.py
git commit -m "feat(worker): embed·LLM 서버용 브라우저 금지 판정"
```

---

### Task 8: worker — embed 서비스 미들웨어

**Files:**
- Modify: `be/worker/damwha_worker/embed_service.py` (`app = FastAPI()` 아래, `main()`)
- Test: Create `be/worker/tests/test_embed_guard.py`

**Interfaces:**
- Consumes: `browser_guard.rejection` (Task 7)
- Produces: 모듈 전역 `_bind_host: str | None` — `main()`이 `settings.embed_service_host`로 채운다.

- [ ] **Step 1: 실패하는 테스트**

`be/worker/tests/test_embed_guard.py`:

```python
"""embed 서비스의 브라우저 금지 미들웨어 (spec 2026-10-08 §3.8). /health로 본다 — 모델을 올리지 않는다.

fastapi는 models extra라 테스트 전용 venv(worker:sync:test)에는 없다 — 그때는 건너뛴다.
"""

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from damwha_worker import embed_service  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(embed_service, "_bind_host", "127.0.0.1")
    return TestClient(embed_service.app)


def test_server_client_reaches_health(client):
    r = client.get("/health", headers={"host": "127.0.0.1:8100", "sec-fetch-mode": "cors"})
    assert r.status_code == 200
    assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize(
    "headers",
    [
        {"host": "127.0.0.1:8100", "origin": "https://evil.example"},
        {"host": "127.0.0.1:8100", "sec-fetch-site": "cross-site"},
        {"host": "attacker.example:8100"},
    ],
)
def test_browser_or_rebound_request_is_refused(client, headers):
    r = client.get("/health", headers=headers)
    assert r.status_code == 403
    assert "access-control-allow-origin" not in r.headers


def test_embed_route_is_guarded_before_the_model_loads(client, monkeypatch):
    def boom():
        raise AssertionError("_service() must not run for a refused request")

    monkeypatch.setattr(embed_service, "_service", boom)
    r = client.post("/embed", json={"texts": ["x"]}, headers={"host": "attacker.example:8100"})
    assert r.status_code == 403


def test_named_bind_host_is_accepted(monkeypatch):
    monkeypatch.setattr(embed_service, "_bind_host", "mac-studio.local")
    r = TestClient(embed_service.app).get("/health", headers={"host": "mac-studio.local:8100"})
    assert r.status_code == 200
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --directory be/worker pytest tests/test_embed_guard.py -q`
Expected: FAIL — `_bind_host` 속성 없음(monkeypatch `raising=True`), 거부 행 200.

- [ ] **Step 3: 구현**

`be/worker/damwha_worker/embed_service.py` — import에 `from fastapi.responses import JSONResponse`와
`from . import browser_guard, console`(기존 `from . import console` 교체). `app = FastAPI()` 아래:

```python
# main()이 settings.embed_service_host로 채운다. 미들웨어가 설정 전체(DATABASE_URL 필수)를 읽지 않게 값만 둔다.
# None이면 loopback만 받는다.
_bind_host: str | None = None


@app.middleware("http")
async def _refuse_browsers(request, call_next):
    """브라우저 금지 (spec 2026-10-08 §3.8). 엔드포인트보다 먼저 돈다 — 거부된 요청은 모델을 깨우지 않는다."""
    reason = browser_guard.rejection(request.headers.get, _bind_host)
    if reason is not None:
        return JSONResponse({"detail": reason}, status_code=403)
    return await call_next(request)
```

`main()`의 `settings, _ = _service()` 다음:

```python
    global _bind_host
    _bind_host = settings.embed_service_host
```

- [ ] **Step 4: 통과 확인**

Run: `uv run --directory be/worker pytest tests/test_embed_guard.py tests/test_downloads.py -q` → PASS.
`uv run --directory be/worker ruff check damwha_worker/embed_service.py tests/test_embed_guard.py` → 깨끗.

- [ ] **Step 5: 커밋**

```bash
git add be/worker/damwha_worker/embed_service.py be/worker/tests/test_embed_guard.py
git commit -m "feat(worker): embed 서비스가 브라우저·rebinding 요청을 거부한다"
```

---

### Task 9: worker — LLM 서버 가드 (`APIHandler` 메서드 제자리 교체)

**Files:**
- Create: `be/worker/damwha_worker/llm_guard.py`
- Modify: `be/worker/damwha_worker/llm_entry.py` (`main()`)
- Test: Create `be/worker/tests/test_llm_guard.py`, Modify `be/worker/tests/test_llm_entry.py` (`fake_server` 픽스처와 새 테스트)

**Interfaces:**
- Consumes: `browser_guard.rejection` (Task 7)
- Produces:
  - `llm_guard.install(handler_cls: type | None, bind_host: str | None) -> None` — 없거나 모양이 다르면 `RuntimeError`.
  - `llm_guard.host_arg(argv: list[str]) -> str | None` — `--host X`/`--host=X`, 없으면 None.

- [ ] **Step 1: 실패하는 테스트 — 순수 핸들러 + 실제 mlx 서버**

`be/worker/tests/test_llm_guard.py`:

```python
"""LLM 서버 가드 (spec 2026-10-08 §3.8).

핵심 함정: mlx_lm 0.31.3의 `_run_http_server(..., handler_class=APIHandler)`는 **정의 시점에** 원래 클래스를
기본 인자로 잡았고 `run()`은 그 인자를 넘기지 않는다. 그래서 하위 클래스로 모듈 속성을 바꾸면 실제 서버는 가드 없이
뜬다. 메서드만 부르는 테스트는 그 실수를 못 잡으므로, 여기서는 **실제 HTTP 서버**에 요청을 보낸다.
"""

import http.client
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from damwha_worker import llm_guard


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _request(port, method, path, headers):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path, body=b"{}" if method == "POST" else None, headers=headers)
    res = conn.getresponse()
    res.read()
    conn.close()
    return res.status, {k.lower(): v for k, v in res.getheaders()}


def _make_handler():
    """APIHandler와 같은 모양의 대역 — do_GET/do_POST/do_OPTIONS와 CORS를 마구 쓰는 _set_cors_headers."""

    class Handler(BaseHTTPRequestHandler):
        def _set_cors_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "*")

        def _ok(self):
            self.send_response(200)
            self._set_cors_headers()
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")

        def do_GET(self):
            self._ok()

        def do_POST(self):
            self._ok()

        def do_OPTIONS(self):
            self._ok()

        def log_message(self, *args):
            pass

    return Handler


def _serve(handler_cls):
    port = _free_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


@pytest.fixture
def guarded():
    handler = _make_handler()
    llm_guard.install(handler, bind_host="127.0.0.1")
    httpd, port = _serve(handler)
    yield port
    httpd.shutdown()


GOOD = {"Host": "127.0.0.1:8000"}


@pytest.mark.parametrize("method", ["GET", "POST", "OPTIONS"])
def test_server_client_passes_and_gets_no_cors_headers(guarded, method):
    status, headers = _request(guarded, method, "/v1/models", GOOD)
    assert status == 200
    assert not [k for k in headers if k.startswith("access-control-")]


@pytest.mark.parametrize("method", ["GET", "POST", "OPTIONS"])
@pytest.mark.parametrize(
    "extra",
    [{"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Host": "attacker.example:8000"}],
)
def test_browser_or_rebound_request_is_refused(guarded, method, extra):
    status, headers = _request(guarded, method, "/v1/chat/completions", {**GOOD, **extra})
    assert status == 403
    assert not [k for k in headers if k.startswith("access-control-")]


def test_install_is_idempotent():
    handler = _make_handler()
    llm_guard.install(handler, None)
    llm_guard.install(handler, None)  # 두 번 감싸지 않는다
    httpd, port = _serve(handler)
    try:
        assert _request(port, "GET", "/", GOOD)[0] == 200
    finally:
        httpd.shutdown()


@pytest.mark.parametrize(
    "bad",
    [None, type("NoMethods", (BaseHTTPRequestHandler,), {"_set_cors_headers": lambda self: None}),
     type("NoCors", (BaseHTTPRequestHandler,), {"do_GET": lambda self: None})],
)
def test_unexpected_handler_shape_fails_closed(bad):
    with pytest.raises(RuntimeError):
        llm_guard.install(bad, None)


@pytest.mark.parametrize(
    ("argv", "want"),
    [
        (["x", "--model", "m", "--host", "10.0.0.5", "--port", "8000"], "10.0.0.5"),
        (["x", "--host=127.0.0.1"], "127.0.0.1"),
        (["x", "--model", "m"], None),
        (["x", "--host"], None),
    ],
)
def test_host_arg(argv, want):
    assert llm_guard.host_arg(argv) == want


def test_real_mlx_server_path_is_guarded():
    """설치된 mlx_lm의 **실제** `_run_http_server` 경로. 하위 클래스 교체였다면 여기서 200이 나온다."""
    server = pytest.importorskip("mlx_lm.server")

    class FakeGenerator:
        """/health는 응답 생성기를 쓰지 않는다 — 모델 없이 서버를 띄운다."""

    llm_guard.install(server.APIHandler, bind_host="127.0.0.1")
    port = _free_port()
    threading.Thread(
        target=server._run_http_server, args=("127.0.0.1", port, FakeGenerator()), daemon=True
    ).start()
    # 서버가 붙을 때까지 기다린다
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.1).close()
            break
        except OSError:
            threading.Event().wait(0.05)

    ok_status, ok_headers = _request(port, "GET", "/health", {"Host": f"127.0.0.1:{port}"})
    assert ok_status == 200
    assert not [k for k in ok_headers if k.startswith("access-control-")]

    for extra in ({"Origin": "https://evil.example"}, {"Host": "attacker.example"}):
        status, headers = _request(port, "GET", "/health", {"Host": f"127.0.0.1:{port}", **extra})
        assert status == 403
        assert not [k for k in headers if k.startswith("access-control-")]
```

`be/worker/tests/test_llm_entry.py` — `fake_server` 픽스처 안, `pkg = types.ModuleType("mlx_lm")` 앞에:

```python
    class FakeHandler(BaseHTTPRequestHandler):
        def _set_cors_headers(self):
            pass

        def do_GET(self):
            pass

        def do_POST(self):
            pass

    seen["handler"] = FakeHandler
```

`server_main` 안에 `seen["guarded_at_main"] = getattr(FakeHandler, "_damwha_guarded", False)`, `_module_getattr`를

```python
    def _module_getattr(name):
        if name == "APIHandler":
            return FakeHandler
        if name != "main":
            raise AttributeError(name)
        seen["hook_calls_at_import"] = list(hook_calls)
        return server_main
```

로 바꾸고 파일 맨 위 import에 `from http.server import BaseHTTPRequestHandler`. 새 테스트:

```python
def test_guards_the_handler_before_server_main(monkeypatch, fake_server):
    """spec 2026-10-08 §3.8 — 서버가 뜨기 전에 APIHandler가 감싸져 있어야 한다."""
    _run(monkeypatch, ["/b/llm_entry.py", "--run-id=r", "--host", "127.0.0.1", "--port", "8000"])

    assert fake_server["guarded_at_main"] is True


def test_refuses_to_start_without_an_apihandler(monkeypatch, fake_server):
    """mlx_lm이 바뀌어 APIHandler가 사라지면 가드 없이 뜨지 않고 기동이 실패한다."""
    server = sys.modules["mlx_lm.server"]
    original = server.__getattr__

    def no_handler(name):
        if name == "APIHandler":
            raise AttributeError(name)
        return original(name)

    monkeypatch.setattr(server, "__getattr__", no_handler)
    with pytest.raises(RuntimeError):
        _run(monkeypatch, ["/b/llm_entry.py", "--run-id=r"])
    assert "argv" not in fake_server
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --directory be/worker pytest tests/test_llm_guard.py tests/test_llm_entry.py -q`
Expected: FAIL — `cannot import name 'llm_guard'`; `guarded_at_main` KeyError.

- [ ] **Step 3: 구현**

`be/worker/damwha_worker/llm_guard.py`:

```python
"""LLM 서버(mlx_lm.server)에 브라우저 금지 가드를 건다 (spec 2026-10-08 §3.8).

mlx_lm.server는 `--allowed-origins` 기본값 `*`로 모든 응답에 `Access-Control-Allow-Origin: *`를 붙이고, 본문을
Content-Type과 관계없이 json.loads한다 — 아무 웹페이지가 `text/plain` simple request로 부르고 답을 읽을 수 있었다.

**클래스를 바꾸지 않고 원래 클래스 객체의 메서드를 제자리에서 바꾼다.** `_run_http_server(..., handler_class=APIHandler)`가
정의 시점에 원래 클래스를 기본 인자로 잡았고 `run()`은 그 인자를 넘기지 않는다(mlx_lm 0.31.3 server.py:1702,1735).
모듈 속성을 하위 클래스로 바꾸면 실제 서버는 가드 없이 뜬다. 같은 객체의 메서드를 바꾸면 기본 인자도 같은 객체다.

`_set_cors_headers`는 아무 헤더도 쓰지 않게 덮는다 — Origin이 맞지 않아도 `Allow-Methods: *`·`Allow-Headers: *`를
쓴다(server.py:1075-1084). 이 메서드가 `cli_args.allowed_origins`의 유일한 소비자라, 이걸 덮으면 그 인자는 효과가 없다.

모양이 기대와 다르면(mlx_lm이 바뀌어 APIHandler·_set_cors_headers·do_*가 없음) RuntimeError — 조용히 가드 없이 뜨지 않는다.
"""

from __future__ import annotations

import json

from . import browser_guard

_MARK = "_damwha_guarded"


def host_arg(argv: list[str]) -> str | None:
    for i, token in enumerate(argv):
        if token == "--host":
            return argv[i + 1] if i + 1 < len(argv) else None
        if token.startswith("--host="):
            return token[len("--host=") :]
    return None


def _refuse(handler, reason: str) -> None:
    body = json.dumps({"error": reason}).encode()
    handler.send_response(403)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _guard(method, bind_host):
    def guarded(self):
        reason = browser_guard.rejection(self.headers.get, bind_host)
        if reason is not None:
            _refuse(self, reason)
            return
        method(self)

    guarded.__name__ = method.__name__
    return guarded


def install(handler_cls: type | None, bind_host: str | None) -> None:
    if handler_cls is None:
        raise RuntimeError("mlx_lm.server.APIHandler not found — refusing to start an unguarded LLM server")
    if getattr(handler_cls, _MARK, False):
        return
    do_methods = [name for name in vars(handler_cls) if name.startswith("do_")]
    if not do_methods or not callable(getattr(handler_cls, "_set_cors_headers", None)):
        raise RuntimeError(
            f"mlx_lm.server.APIHandler has an unexpected shape (do_*={do_methods}) — refusing to start unguarded"
        )
    for name in do_methods:
        setattr(handler_cls, name, _guard(getattr(handler_cls, name), bind_host))
    handler_cls._set_cors_headers = lambda self: None
    setattr(handler_cls, _MARK, True)
```

`be/worker/damwha_worker/llm_entry.py` `main()`의 마지막 두 줄을 교체:

```python
    # 스펙 2026-10-08 §3.8 — 서버가 뜨기 전에 원래 APIHandler의 메서드를 감싼다(llm_guard 머리 주석).
    import mlx_lm.server as mlx_server

    from . import llm_guard

    llm_guard.install(getattr(mlx_server, "APIHandler", None), bind_host=llm_guard.host_arg(sys.argv))
    mlx_server.main()
```

모듈 머리 docstring의 이유 목록 끝에 한 줄: `- 브라우저 금지 가드를 서버가 뜨기 전에 건다(spec 2026-10-08 §3.8, llm_guard).`

- [ ] **Step 4: 통과 확인**

Run: `uv run --directory be/worker pytest tests/test_llm_guard.py tests/test_llm_entry.py tests/test_llm_server.py -q` → PASS
(`test_real_mlx_server_path_is_guarded`는 models venv에서만 돈다 — 출력에서 SKIPPED가 아니라 PASSED인지 확인한다).
`uv run --directory be/worker ruff check damwha_worker tests` → 깨끗.

- [ ] **Step 5: 변이 확인 (M8)**

`test_real_mlx_server_path_is_guarded`의 `llm_guard.install(server.APIHandler, bind_host="127.0.0.1")` 한 줄을
"하위 클래스를 만들어 가드를 걸고 모듈 속성에 대입"하는 실수로 바꾼다(하위 클래스에 `do_*`를 직접 두어야 `install`이
모양 검사를 통과한다):

```python
    sub = type("Sub", (server.APIHandler,), {
        n: getattr(server.APIHandler, n) for n in vars(server.APIHandler) if n.startswith("do_")
    })
    llm_guard.install(sub, bind_host="127.0.0.1")
    server.APIHandler = sub
```

Run: `uv run --directory be/worker pytest tests/test_llm_guard.py::test_real_mlx_server_path_is_guarded -q`
Expected: FAIL — `_run_http_server`의 기본 인자가 원래 클래스라 거부 행이 403 대신 200. 결과를
`.omo/notes/2026-10-08-mutations.md`에 적고 되돌린다(`git checkout -- be/worker/tests/test_llm_guard.py`는 커밋 전이라
쓰지 말고 편집으로 되돌린 뒤 다시 PASS 확인).

- [ ] **Step 6: 커밋**

```bash
git add be/worker/damwha_worker/llm_guard.py be/worker/damwha_worker/llm_entry.py be/worker/tests/test_llm_guard.py be/worker/tests/test_llm_entry.py
git commit -m "feat(worker): LLM 서버의 APIHandler에 브라우저 금지 가드를 건다"
```

---

### Task 10: 데모 compose·문서

**Files:**
- Modify: `deploy/demo/docker-compose.yml` (api `environment`)
- Modify: `deploy/demo/README.md` ("시드 갱신" 절)
- Modify: `be/CLAUDE.md` ("Non-obvious invariants"에 항목 하나, Demo read-only 항목 바로 앞)
- Modify: `desktop/CLAUDE.md` (API 자식 env를 설명하는 곳 — `apiChildEnv`/HOST 고정 설명 근처)
- Modify: `be/worker/SMOKE.md`의 LLM 서버 절(없으면 `be/docs/worker-architecture.md`의 embed·LLM 설명)에 한 단락

- [ ] **Step 1: compose**

```yaml
      DEMO_READ_ONLY: "true"            # every non-GET (except POST /search) → 403
      # 로컬 API 접근 제어(spec 2026-10-08): loopback 밖 Host는 이 목록에 있어야 한다. 터널이 원래 Host를 넘긴다.
      ALLOWED_HOSTS: damwha-demo.0kimjae.dev
```

- [ ] **Step 2: README** — "시드 갱신" 코드 블록 아래에:

```markdown
**2026-10-08 이후 이미지는 compose 파일도 새로 받아야 한다.** API가 loopback 밖 `Host`를 `ALLOWED_HOSTS`로만
받는다(로컬 API 접근 제어, `docs/superpowers/specs/2026-10-08-local-api-access-control-design.md`). 옛 compose로
새 이미지를 띄우면 터널로 들어온 모든 요청이 `403 HOST_NOT_ALLOWED`다. `curl -O …/docker-compose.yml`부터 다시 한다.
공개 주소를 바꾸면 compose의 `ALLOWED_HOSTS`도 바꾼다.
```

- [ ] **Step 3: be/CLAUDE.md** — 불변식 항목:

```markdown
- **Local API access control (`src/access/`, `src/http/configure-http.ts`)**: `app.enableCors()` is gone. One express middleware, registered by `configureHttp` **before every body parser, the SPA and Swagger**, decides every request with `evaluateAccess`: (1) `Host` must be `localhost`/`127.0.0.1`/`[::1]` (any port) or in `ALLOWED_HOSTS` — DNS rebinding; (2) under `/api` (matched case-insensitively — express routes are case-insensitive, `/API/health` is a 200) and for any non-GET/HEAD, an `Origin` must be same-origin (`URL.host === Host`, scheme ignored for the tunnelled demo) or in `ALLOWED_ORIGINS`; with no `Origin`, `Sec-Fetch-Site: cross-site|same-site` is refused. Requests with neither header (curl, the desktop health probe, Node fetch) pass — same-Mac processes are out of the threat model. CORS headers go only to `ALLOWED_ORIGINS`, never `*`; every response carries `frame-ancestors 'none'`/`X-Frame-Options: DENY`. **New routes are covered without declaring anything** — but never make a GET change state: no-cors GETs carry no `Origin`, so write protection rests on the `Origin` check of POST/PUT/PATCH/DELETE. `HOST` defaults to `127.0.0.1` (the Docker image sets `0.0.0.0`). `test/access-control.e2e-spec.ts` builds its app through `configureHttp`; other e2e suites don't and are unaffected. Spec: `docs/superpowers/specs/2026-10-08-local-api-access-control-design.md`.
```

- [ ] **Step 4: desktop/CLAUDE.md** — API 자식 env 설명 옆에:

```markdown
- **API의 허용 Origin은 앱이 정한다** (spec 2026-10-08 §3.6). `apiChildEnv`가 HOST처럼 마지막에 덮는다: dev는
  `ALLOWED_ORIGINS=http://localhost:5173`(`src/dev/vite-origin.ts`의 `VITE_ORIGIN`), packaged는 둘 다 지운다(렌더러가 API와
  같은 origin). `config.json`의 `ALLOWED_ORIGINS`·`ALLOWED_HOSTS`는 경고하고 버린다. 헬스 프로브는 헤더를 싣지 않는다
  — be가 헤더 없는 요청을 통과시키는 것이 그 계약이다(`tests/process/readiness.test.ts`).
```

- [ ] **Step 5: worker 문서** — embed·LLM 설명이 있는 곳(우선 `be/worker/SMOKE.md`의 LLM 서버 절, 없으면 `be/docs/worker-architecture.md`)에:

```markdown
**브라우저 금지 가드** (spec 2026-10-08 §3.8). embed(FastAPI 미들웨어)와 LLM(`llm_entry`가 `mlx_lm.server.APIHandler`의
메서드를 제자리에서 감싼다, `llm_guard.py`)은 `Origin`·`Sec-Fetch-Site`가 실린 요청과 loopback·설정된 bind 이름이 아닌
`Host`를 403으로 거부하고 CORS 헤더를 내지 않는다. 덮지 않는 것: `LENS_LLM_SERVER_BIN` 탈출구와 이미 떠 있던 서버의 재사용.
mlx_lm을 올릴 때 `tests/test_llm_guard.py::test_real_mlx_server_path_is_guarded`를 models venv에서 돌린다 —
`APIHandler`가 바뀌면 llm_entry는 기동을 거부한다.
```

- [ ] **Step 6: 커밋**

```bash
git add deploy/demo/docker-compose.yml deploy/demo/README.md be/CLAUDE.md desktop/CLAUDE.md be/worker/SMOKE.md be/docs/worker-architecture.md
git commit -m "docs: 로컬 API 접근 제어 — 데모 ALLOWED_HOSTS, 불변식, desktop·worker 문서"
```

(실제로 고친 파일만 add 한다.)

---

### Task 11: 전체 회귀와 실제 확인

**Files:** 코드 변경 없음. 결과를 `.omo/notes/2026-10-08-manual.md`(로컬)에 적는다.

- [ ] **Step 1: 전체 테스트**

```bash
pnpm be test
pnpm fe test && pnpm fe lint
pnpm --filter damwha-desktop test && pnpm --filter damwha-desktop run lint
uv run --directory be/worker pytest -q
uv run --directory be/worker ruff check .
```

각각 통과 수·실패 수를 기록한다. desktop은 테스트 수가 0이 아닌지 본다.

- [ ] **Step 2: `pnpm dev` 수동** — 로컬 `be/.env`(커밋하지 않는다)에 `ALLOWED_ORIGINS=http://localhost:5173`을 넣고
`pnpm dev`. Chrome(Claude in Chrome, 새 탭 — 숨은 탭은 TanStack 폴링이 멈추므로 확인 중엔 탭을 앞에 둔다)으로 `http://localhost:5173`:
회의 목록·상세, 오디오 재생, 화자 미리듣기, 업로드, 삭제, 설정 저장, 실시간 녹음 시작/정지(마이크 권한 필요 — 안 되면
그 사실을 적는다). 개발자 도구 네트워크에서 `/api` 응답 403이 없는지.

- [ ] **Step 3: 다른 origin 페이지** — 스크래치 디렉터리에 `evil.html`을 두고 `python3 -m http.server 8765`로 서빙
(`http://127.0.0.1:8765/evil.html`):

```html
<!doctype html><meta charset="utf-8"><title>evil</title>
<pre id="out"></pre>
<form id="f" method="POST" action="http://localhost:3000/api/folders" target="sink">
  <input name="name" value="evil-form-probe"></form>
<iframe name="sink" hidden></iframe>
<audio id="a" src="http://localhost:3000/api/meetings/MEETING_ID/audio" preload="auto"></audio>
<script>
const log = (s) => (document.getElementById('out').textContent += s + '\n');
fetch('http://localhost:3000/api/meetings').then(r => r.text()).then(t => log('read: ' + t.slice(0, 80)), e => log('read blocked: ' + e));
fetch('http://localhost:3000/api/meetings/live', { method: 'POST', mode: 'no-cors', body: '{}' }).then(() => log('live sent'));
const fd = new FormData(); fd.append('audio', new Blob(['0123456789'], { type: 'audio/wav' }), 'a.wav');
fetch('http://localhost:3000/api/meetings', { method: 'POST', mode: 'no-cors', body: fd }).then(() => log('upload sent'));
document.getElementById('f').submit();
document.getElementById('a').onerror = () => log('audio blocked'); document.getElementById('a').oncanplay = () => log('audio PLAYED');
</script>
```

(`MEETING_ID`는 실제 회의 id로 바꾼다.) 확인: `read blocked`, `audio blocked`, 네트워크 탭에서 네 요청 모두 403,
그리고 DB에 `evil-form-probe` 폴더·새 회의·녹음 중 회의가 **없음**(`psql`로 확인). 같은 페이지에서
`http://127.0.0.1:3000/...`로 바꿔 한 번 더.

- [ ] **Step 4: rebinding 흉내**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/meetings -H 'Host: attacker.example:3000'   # 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8100/health -H 'Host: attacker.example:8100'          # 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8100/health -H 'Origin: https://evil.example'          # 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8100/health                                            # 200
```

(embed는 `pnpm embed`로 새 코드를 띄운 뒤.)

- [ ] **Step 5: 패키징 desktop** — 메모리 규칙: Claude 세션에서는 `FORCE_COLOR`를 빼고 패키징하고, 그 전에 `desktop/out/`에
옛 DMG가 없고 `out/mac-arm64`의 앱이 떠 있지 않은지 본다. `env -u FORCE_COLOR pnpm package:desktop` → 산출 앱을 연다(Computer use):
회의 열람·오디오 재생·업로드·삭제·설정 저장. 앱이 떠 있는 동안 Step 3의 evil 페이지에서 앱의 포트(`lsof -iTCP -sTCP:LISTEN -P | grep node`)로
같은 요청 → 막힘 확인. LLM 가드는 렌즈 추출·요약을 한 번 돌려(작은 회의) 정상 완료를 본다 — worker가 `Host`를 bind와 같은
`127.0.0.1:<port>`로 보내므로 통과해야 한다.

- [ ] **Step 6: 정리** — evil 서버 종료, 탐침으로 생긴 행이 있으면 지운다(없어야 정상), 로컬 `be/.env` 변경은 유지(개발용).

---

### Task 12: result

**Files:**
- Create: `docs/superpowers/reports/2026-10-08-local-api-access-control-results.md`

- [ ] **Step 1: 작성** — 기존 reports와 같은 모양: spec·plan 링크, 브랜치, 커밋 목록(`git log --oneline dev..`), Task 11
Step 1의 명령과 결과(통과 수), Task 4·9 변이 표(변이 → 실패한 테스트), Task 11 수동 확인 결과, spec §7 완료 기준 1~8 각각의
판정(충족/미충족/부분 + 근거), spec과 다르게 한 것(`--allowed-origins` 미적용과 그 이유), 남은 것(예: 실시간 녹음 수동
확인 여부). 끝 단락 "공유 기능에 넘기는 규칙"(spec §8을 확정):

```markdown
## 공유 기능이 따를 규칙

선행 조건은 `be/src/access/`의 접근 제어로 충족됐다. 공유 API(`POST /meetings/:id/share`, `…/share/preview`,
`GET`·`DELETE /meetings/:id/share`, `GET /shares`)는 `/api` 아래에 두기만 하면 별도 선언 없이 Host·Origin 검사를 받는다 —
미들웨어가 라우터보다 앞에서 모든 요청을 판정하기 때문이다(`test/access-control.e2e-spec.ts`). 지킬 것: (1) 상태를 바꾸는
공유 동작을 GET으로 만들지 않는다 — no-cors GET은 Origin 없이 오고 쓰기 보호는 POST·PUT·PATCH·DELETE의 Origin 검사에 기대므로;
(2) 공유 서비스 도메인을 `ALLOWED_ORIGINS`에 넣지 않는다 — 공유 응답(링크·키)은 같은 origin(앱)과 dev Vite에서만 읽혀야
한다; (3) 공유 라우트의 e2e 하나는 `configureHttp`로 앱을 만들어 다른 Origin의 `POST …/share`가 403이고 `meeting_share` 행이
생기지 않는지 확인한다; (4) be가 외부로 보내는 요청(공유 업로드)은 이 미들웨어와 무관하다 — 들어오는 요청만 다룬다.
```

- [ ] **Step 2: 커밋**

```bash
git add docs/superpowers/reports/2026-10-08-local-api-access-control-results.md
git commit -m "docs(report): 로컬 API 접근 제어 결과"
```

- [ ] **Step 3: `graphify update .`** (루트 CLAUDE.md 규칙, graphify-out은 gitignore) — 그리고 push·PR은 사용자에게 묻는다.
