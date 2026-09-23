# Electron Phase 4 — 실행 통합 구현 계획 (Part 2 / 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱이 번들 Python으로 worker·embed·LLM 서버를 띄우고, HF 토큰을 안전하게 받고, 모델 다운로드와 프로세스 소유를 끝까지 책임진다.

**Architecture:** `uv run`을 버리고 **번들 python의 `-m` 모듈 진입 하나**로 통일한다. 소유는 argv의 `--run-id` 표식으로 판정하고, 종료는 서비스별 `stop()`(A층)과 핸들과 무관한 앱 종료 회수(B층) 둘로 나눈다. 모델 진행은 `app_setting.model_readiness` 한 행으로 올린다.

**Tech Stack:** Electron 44 / TypeScript / vitest, Python 3.12 + pydantic-settings + pytest, PostgreSQL 16 (Phase 3), NestJS·React (표시).

**Spec:** [2026-09-16-electron-phase-4-embedded-python-runtime-design.md](../specs/2026-09-16-electron-phase-4-embedded-python-runtime-design.md)

**Part 1:** [2026-09-16-electron-phase-4-bundled-runtime.md](2026-09-16-electron-phase-4-bundled-runtime.md) — **먼저 끝나야 한다.** 그 계획의 "완료 조건" 셋이 참인 상태에서 시작한다.

---

## 이 계획이 지키는 두 규칙

**규칙 1 — 계획에 박는 코드는 확정 전에 최소 한 번 실행한 것만이다.**

4회차까지의 blocking 11건 중 8건이 "계획에 문자 그대로 적었지만 한 번도 실행하지 않은 코드"에서
나왔다. 그래서 이 계획은 **시그니처·계약·테스트만** 싣는다. 구현 본문은 "구현 시 작성"이다.

예외로 본문을 싣는 코드에는 **`[실행됨: <명령>]`** 표시를 붙인다. 없으면 싣지 않는다.

**규칙 2 — 한 계약의 사본을 여럿 두지 않는다.**

시그니처는 **Interfaces 절에만** 적는다. Step 안에서 다시 적지 않는다. 4회차의
`parseDamwhaProcesses`가 인터페이스·테스트·구현·호출부 네 곳에서 갈린 것이 그 규칙이 없어서다.
테스트 예시가 함수를 부를 때는 **Interfaces의 시그니처를 그대로** 쓴다.

## Global Constraints

Part 1과 같고, 실행 쪽 셋을 더한다.

- **모든 Python 진입은 `-m` 모듈이다.** 콘솔 스크립트를 실행하지 않는다 — 셔뱅을 타면 옛 경로가
  남아 있을 때 죽지 않고 조용히 다른 런타임을 실행한다 (Phase 0 R-6).
- **자식 PATH는 `<python>/bin:<ffmpeg>/bin`뿐이다.** 개발 도구 폴백을 주지 않는다.
- **env 위생은 최종 합성 env에 적용한다** — 상속분만 씻으면 `config.json`이 임의 키로
  되돌린다 (스펙 §6.3).
- **절대 불변/허용 변경**은 Part 1 §Global Constraints와 같다. 기준선은 Part 1 Task 1이 떴다.
- 커밋 메시지는 한국어 본문. 제목은 `type(scope): 한 줄`.

## 검증 명령

| 무엇 | 명령 |
| --- | --- |
| desktop 테스트·타입 | `pnpm --filter damwha-desktop run test` / `run lint` |
| worker 테스트·lint | `pnpm worker:test` / `uv run --directory be/worker ruff check .` |
| 전체 | `pnpm build` / `pnpm test` / `pnpm lint` |
| dev 앱 | `pnpm --filter damwha-desktop run start:desktop` |
| 패키징·위생 | `pnpm --filter damwha-desktop run package:desktop` / `node desktop/scripts/check-bundle.mjs` |
| **번들 캐시 키** | `bash desktop/scripts/build-python.sh --print-key` — **읽기 전용, 0.22초** |

**`--print-key`를 먼저 본다.** `desktop/package.json:13`의 `start:desktop`은 세 빌드 스크립트를
무조건 부르고, `build-python.sh`는 `RT_KEY`에 **자기 shasum**을, `WK_KEY`에 `RT_KEY` + `damwha_worker`
트리 해시를 넣는다(`:106`,`:118`). 그래서 **worker 소스를 한 줄 고치면 wk 층이(온난 ~130초),
`build-python.sh`를 한 줄 고치면 rt·wk 두 층이(온난 311초) 다시 돈다.** 이 계획은 Task 1·2·3·9·10에서
`damwha_worker`를 고치고 Task 5·6·12에서 `start:desktop`/`package:desktop`을 돌린다 — 스펙 §6.7의
dev `PYTHONPATH`가 소스를 직접 읽게 만들므로 그 재빌드는 **순수 낭비인데 건너뛸 수 없다.**
`--print-key`는 그 비용이 언제 발생하는지를 빌드 전에 말해 준다.

---

## 파일 구조

**새로 만드는 것**

| 경로 | 책임 |
| --- | --- |
| `desktop/src/process/runtime-paths.ts` | 번들 경로 (순수) |
| `desktop/src/process/python-launcher.ts` | `launchPython` |
| `desktop/src/process/orphans.ts` | 프로세스 판독·분류·회수 |
| `desktop/src/app/reap-on-quit.ts` | B층 |
| `desktop/src/config/token-store.ts` | Keychain 토큰 |
| `desktop/src/windows/token-window.ts` + `desktop/shell/token.html` | 온보딩 |
| `desktop/src/services/model-readiness.ts` | 준비 상태 해석 (순수) |
| `be/worker/damwha_worker/runtime_report.py` | 런타임 자기 보고 |
| `be/worker/damwha_worker/llm_entry.py` | LLM 진입 모듈 |
| `be/worker/damwha_worker/models/downloads.py` | HF 진행 훅 |
| `desktop/src/windows/apply-token-change.ts` | 토큰 교체를 live env에 반영 (Task 11) |
| `desktop/scripts/lib/macho.mjs` | `machOFiles()` 한 벌 — Part 1 이월, Task 3 Step 7 |

**고치는 것** — `desktop/src/{services/{worker,embed,worker-discovery,worker-shutdown,supervisor},config/{config,repo-root},main,windows/{status-view,shell-hints},diagnostics/causes}.ts`, `desktop/src/services/types.ts`, `be/worker/damwha_worker/{config,__main__,llm_server,embed_service,errors,capabilities,db/__init__,models/{pyannote_diar,bge_embed}}.py`, **`desktop/scripts/{build-python.sh,package.mjs,check-bundle.mjs}`** (Task 3 Step 7 — 한 파동),
`be/src/system/*`, `fe/src/**`

`desktop/src/process/executables.ts`는 **이 계획이 고치지 않는다.** 그 파일의 `buildChildPath`
(`executables.ts:56-60`)는 상속 PATH에 `dirs`를 앞세우는 순수 함수인데, Task 5가
`uv-launcher.ts`를 지우면 **유일한 호출자가 사라져 죽은 코드가 된다.** Task 5 Step 6이 그것을
확인만 하고 제거는 별도 정리에 맡긴다 — 이 Phase가 그 파일의 계약을 바꾸지는 않기 때문이다.

**지우는 것** — `desktop/src/process/uv-launcher.ts` + 그 테스트 (Task 5가 지운다)

---

## 계약 — 이 계획 전체가 쓰는 타입

**여기가 유일한 정의처다.** Task 안에서 다시 적지 않는다.

```typescript
// desktop/src/process/runtime-paths.ts
export const PY_MINOR = "3.12";
// python: `<bundleDir>/bin/python3.12` — **심볼릭 링크가 아니라 실체다.**
//   실측: `Resources/python/bin`에 `python ⇒ python3.12`·`python3 ⇒ python3.12` 둘이 있다.
//   그 둘로 띄우면 argv[0]이 링크 이름으로 남아 §6.5 조건 1(basename `python3.12`)에서 빠진다.
// sitePackages: `<bundleDir>/lib/python3.12/site-packages` — P4-C12의 "site-packages가 번들
//   아래" 판정에만 쓴다. 소비자는 Task 12 Step 3의 P4-C12 하나뿐이고 런처는 쓰지 않는다.
export interface PythonBinaries { python: string; sitePackages: string }
export interface FfmpegBinaries { ffmpeg: string; ffprobe: string }
export function pythonBinaries(bundleDir: string): PythonBinaries;
export function ffmpegBinaries(bundleDir: string): FfmpegBinaries;

// desktop/src/services/types.ts — LaunchContext 변경분
//   repoRoot: string | null        dev 전용. packaged는 null (Task 4가 바꾼다)
//   bins: { python: string; ffmpeg: string; ffprobe: string }
//   runId: string                  이 실행의 UUID. 자식 argv에 실린다
//   searchDirs                     **앱 자신의** 도구 탐색용. 자식 env에 안 간다

// desktop/src/process/python-launcher.ts
export interface PythonLaunchOptions {
  ctx: LaunchContext;
  module: string;                       // "damwha_worker" | "damwha_worker.embed_service"
  args?: readonly string[];             // 모듈 뒤. --run-id는 런처가 마지막에 붙인다
  logId: "worker" | "embed";
  extraEnv?: Record<string, string>;
  spawnFn?: SpawnFn;
  onStderr?: (text: string) => void;
}
export function launchPython(o: PythonLaunchOptions): LaunchResult;

// desktop/src/process/orphans.ts
// trees는 **두 벌이다** — ctx.bins는 이번 실행의 한 벌뿐이므로 거기서 둘을 만들 수 없다.
//   Task 4가 `runtime-paths.ts`에 `knownBundleDirs(ctx): string[]`를 함께 두어 packaged·dev
//   두 bundleDir을 모두 돌려주고(하나의 userData를 두 빌드가 공유한다), Task 7이 그 각각에
//   `pythonBinaries()`를 적용해 `KnownTree[]`를 만든다.
export function knownBundleDirs(ctx: LaunchContext): string[];   // [packaged, dev]
export interface KnownTree { root: string; python: string }
export interface DamwhaProcess {
  pid: number; module: string; runId: string | null; once: boolean; argv0: string;
}
export function parseDamwhaProcesses(psText: string, trees: readonly KnownTree[]): DamwhaProcess[];
export function classify(p: DamwhaProcess, myRunId: string): "mine" | "orphan" | "external";
export interface ReapDeps {
  runId: string;
  trees: readonly KnownTree[];
  ps(): Promise<string>;
  descendantsOf(pid: number): Promise<number[]>;
  kill(pid: number): void;
  exists(pid: number): boolean;
  log(line: string): void;
}
export function reapOrphans(d: ReapDeps): Promise<{ reaped: number[] } | { failed: true }>;

// desktop/src/app/reap-on-quit.ts
export function reapOwnedOnQuit(d: ReapDeps): Promise<{ reaped: DamwhaProcess[] }>;

// desktop/src/config/token-store.ts
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}
export interface TokenStore {
  read(): string | null; write(token: string): void; clear(): void; available(): boolean;
}
export function makeTokenStore(userData: string, storage: SafeStorageLike): TokenStore;
export function maskToken(token: string): string;
export type TokenVerdict =
  | { ok: true; name: string }
  | { ok: false; kind: "invalid" | "offline"; detail: string };
export function verifyHfToken(token: string, fetchFn?: FetchLike): Promise<TokenVerdict>;

// desktop/src/config/config.ts — 추가분
export const STRIPPED_CHILD_ENV_KEYS: readonly string[];
export function sanitizeChildEnv(env: Record<string, string | undefined>): Record<string, string>;
export function appOwnedChildEnv(ctx: LaunchContext): Record<string, string>;

// desktop/src/services/model-readiness.ts
export const STALL_MS = 120_000;
export interface ReadinessEntry {
  key: string; state: "downloading" | "ready" | "failed";
  bytesDone: number; bytesTotal: number; startedAt: number; updatedAt: number;
  writer: string; attempt: number;
  error: string | null;
  errorKind: "PERMANENT" | "TRANSIENT" | null;   // 스펙 §6.9의 error_kind
}
export function parseModelReadiness(json: unknown): ReadinessEntry[];
export function downloadInProgress(
  entries: readonly ReadinessEntry[], writer: string, now: number, stallMs: number,
): boolean;

// desktop/src/services/supervisor.ts — **감독자 객체에 메서드를 더한다.**
//   자유 함수가 아니다: 클로저의 `runtimes`·`bring`이 필요하고, 지금 반환 모양은
//   `{ start, retry, stopAll, statuses, runtimeOf }`다(`supervisor.ts:561`).
//   restartService(id): retry()와 별개 경로 — 살아 있는 서비스도 내린다
export interface Supervisor {
  /* 기존 다섯 그대로 */ restartService(id: ServiceId): Promise<void>;
}

// desktop/src/windows/apply-token-change.ts
export interface TokenChangeDeps {
  store: TokenStore;
  liveEnv: Record<string, string>;
  restartService(id: ServiceId): Promise<void>;
  owned(id: ServiceId): boolean;
}
export function applyTokenChange(d: TokenChangeDeps, token: string):
  Promise<{ restarted: ServiceId[]; skipped: ServiceId[] }>;
```

```python
# be/worker/damwha_worker/runtime_report.py
RUN_ID_PREFIX = "--run-id="
def run_id_arg(argv: list[str]) -> str | None: ...
def runtime_facts() -> dict: ...        # {executable, prefix, version, sys_path_head}

# be/worker/damwha_worker/llm_entry.py
def main() -> None: ...                 # -m 진입

# be/worker/damwha_worker/models/downloads.py
def install_hf_progress_hook(writer: str) -> None: ...
def report_download(conn, key: str, writer: str): ...     # 컨텍스트 매니저

# be/worker/damwha_worker/db/core.py — 추가분
MODEL_READINESS_KEY = "model_readiness"
def shared_state_enabled() -> bool: ...
def merge_model_readiness(conn, key: str, entry: dict, writer: str) -> None: ...
def read_model_readiness(conn) -> dict: ...

# be/worker/damwha_worker/errors.py — 추가분
def classify_download(exc: BaseException) -> ErrorKind: ...   # 401·403은 PERMANENT

# be/worker/damwha_worker/llm_server.py — **이 둘은 시그니처가 바뀌지 않는다**
#   managed_llm_server(model, settings, *, popen, probe, monotonic, sleep)   (llm_server.py:68)
#   _wait_ready(proc, model, settings, probe, monotonic, sleep)              (llm_server.py:130)
# Task 3은 두 함수의 **본문만** 고치고, Task 10은 `_wait_ready` 본문에서
# `settings.database_url`로 **자기 연결을 열어** model_readiness를 읽는다 (스펙 §6.9).
# `--once` 자식의 연결을 인자로 넘기지 않는다 — 넘기면 파급이 `dispatch.py`·`jobs.py`·
# `__main__.py`의 호출부까지 번진다. 자기 연결이면 `llm_server.py`·`config.py` 둘에 갇힌다.
```

---

## Task 1: worker — ffmpeg 경로를 호출 시점에 env에서 읽는다

Phase 2가 넘긴 `FFMPEG_BIN`/`FFPROBE_BIN`을 닫는다.

**Files:** Modify `be/worker/damwha_worker/pipeline/ffmpeg.py`, `config.py`; Modify `be/worker/tests/test_ffmpeg.py`

**Interfaces:** 시그니처가 **바뀌지 않는다** — `probe(path, runner)`·`normalize(src, dst, runner)` 그대로. `config.py`에 `ffmpeg_bin`·`ffprobe_bin` 필드(기본 `"ffmpeg"`/`"ffprobe"`)를 더한다.

- [ ] **Step 1: 왜 인자 추가가 아닌지 확인한다**

```bash
sed -n '30,56p' be/worker/damwha_worker/pipeline/process_meeting.py
sed -n '45,52p'   be/worker/tests/test_ffmpeg.py
sed -n '118,126p' be/worker/tests/test_ffmpeg.py
```

두 파이프라인 함수에 `settings`가 없고, 기본값을 **호출 시점에** `ffmpeg.normalize`로 해석해
테스트의 `monkeypatch.setattr(ffmpeg, "probe", lambda path: …)`를 받는다. partial을 def-time에
만들면 monkeypatch가 무력해지고, call-time에 만들면 그 lambda에 없는 키워드를 줘 `TypeError`다.

**호출 시점에 env를 읽는 방식**은 시그니처·호출부·테스트를 하나도 건드리지 않는다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

세 가지를 본다:
1. `FFPROBE_BIN`이 있으면 `probe`의 첫 인자가 그 값이다.
2. `FFMPEG_BIN`이 있으면 `normalize`의 첫 인자가 그 값이다.
   (**재귀 검증 `probe`는 모듈 기본 runner를 탄다** — 기존 동작이다. 스텁해서 실제 ffprobe를
   부르지 않게 한다.)
3. env가 없으면 맨 이름이다 — 웹 흐름(`pnpm worker`)에 회귀가 없다.

- [ ] **Step 3: 구현한다**

`ffmpeg.py`에 `_bin(name)` 헬퍼를 더해 `os.environ.get(f"{name.upper()}_BIN") or name`을 **호출
시점에** 읽고, `probe`·`normalize`의 명령 첫 인자로 쓴다.

**`normalize` 안의 재귀 `probe(temp_path)`(`ffmpeg.py:82`)는 건드리지 않는다.** 바이너리는
그쪽에서도 `_bin`을 다시 읽어 자동으로 따라온다. `runner`를 넘기는 것은 **별개 변경이고 이
Phase의 범위가 아니다** — 넘기면 `test_ffmpeg.py:49`·`:122`의 `lambda path:`가 `TypeError`를 낸다.

**번들 ffmpeg는 `--disable-network`·`--disable-avdevice`로 빌드돼 있다**
(`build-ffmpeg.sh:124`, Part 1 Task 4). 이 Task가 `FFMPEG_BIN`·`FFPROBE_BIN`을 그 빌드로
향하게 하므로, **경로가 아니라 URL을 넘기면 실패한다.** 지금 파이프라인은 로컬 파일만 넘기지만
그 계약이 여기서 좁아지는 것을 기록해 둔다 — 장래에 원격 입력을 받으면 이 자리에서 터진다.

`Settings`에도 두 필드를 둔다(문서화와 `.env` 운용 경로). pydantic이 같은 env를 읽으므로 값이
갈리지 않는다 — **단일 진실 원천은 env이고 `Settings`는 그 사본이다.** `ffmpeg.py`가 `Settings`를
직접 만들 수 없기 때문이다(`database_url`이 필수라 실패한다).

- [ ] **Step 4: 통과를 확인한다** — `pnpm worker:test`, `ruff check .`

**Verify:** 새 테스트 3건 + **기존 테스트 전부** 통과 (monkeypatch 경로가 안 깨졌다는 증거).

**Review:**
- 시그니처가 안 바뀌었는가.
- `_bin`이 **호출 시점에** 읽는가 (모듈 상수가 아니라).
- 재귀 `probe`에 `runner`를 **안** 넘기는가.
- 기본값이 맨 이름이라 웹 흐름에 회귀가 없는가.
- 번들 ffmpeg의 `--disable-network` 제약이 기록됐는가 (로컬 경로만 넘긴다).

- [ ] **Step 5: 커밋** — `feat(worker): ffmpeg·ffprobe 경로를 env에서 호출 시점에 읽는다`

---

## Task 2: worker — `run_id_arg`·`runtime_facts`와 전파

**Files:** Create `be/worker/damwha_worker/runtime_report.py` + `tests/test_runtime_report.py`; Modify `damwha_worker/__main__.py`, `capabilities.py`, `tests/test_worker_loop.py`

**Interfaces:** 위 계약의 `runtime_report` 절. `--once` 자식이 부모의 `--run-id`를 물려받는다.

**P4-C12가 요구하는 다섯 자기 보고 — 누가 만드는가.** 다섯은 전부 **별도 프로세스**라 하나의
보고가 다른 넷을 증명하지 못한다. 어느 하나라도 빠지면 P4-C12를 판정할 수 없다.

| 프로세스 | 보고를 만드는 자리 | 주의 |
| --- | --- | --- |
| worker supervisor | **Task 2 Step 3-b** — 기동 로그 첫 줄 | — |
| `--once` 자식 | **Task 2 Step 3-b** — `run_child()` 첫머리 | 자식이 **자기** 프로세스에서 찍는다 |
| capabilities 프로브 | **Task 2 Step 4** — `_PROBE_CODE` + 부모가 `r.stderr`를 흘린다 | 아래 Step 4 |
| embed | **Task 3 Step 2** — `main()`, **`install_logging()` 뒤** | 스펙 §9 C12 |
| `llm_entry` | **Task 3 Step 3의 3번** — `main()` 호출 전 | 아래 Task 3 |

연결표의 `C12` 행이 `2·3`인 이유다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

| 테스트 | 기대 |
| --- | --- |
| `run_id_arg(["-m","damwha_worker","--run-id=abc"])` | `"abc"` |
| `run_id_arg(["-m","damwha_worker","--once"])` | `None` |
| `run_id_arg(["--run-id","abc"])` | `None` — `=` 없는 형식은 우리 것이 아니다 |
| `runtime_facts()` | `executable`·`prefix`가 `sys`의 것과 같고 `sys_path_head`가 리스트 |
| `--once` 자식 스폰 | argv에 부모의 `--run-id`가 붙는다 |

- [ ] **Step 2: `runtime_report.py`를 쓴다**

`sys_path_head`는 앞 5개만 담는다 — 전체는 길고 판정에 필요한 것은 "무엇이 site-packages보다
먼저 오는가"뿐이다(dev의 `PYTHONPATH`가 거기 보인다).

`sysconfig`는 담지 않는다 — Part 1 스펙 §6.1-b가 그 값을 중립 자리표시자로 고정했다.

- [ ] **Step 3: `__main__.py`를 고친다**

(a) `--once` 자식 스폰을 모듈 수준 함수로 꺼내고 `--run-id`를 이어 붙인다. `sys.executable`은
그대로다 — 번들 python을 자동으로 승계한다.

(b) supervisor 기동 로그와 `run_child()` 첫머리에 `runtime {json}` 한 줄. **자식은 별도
프로세스라 부모의 보고가 그것을 증명하지 못한다.**

(c) `main()`의 `"--once" in sys.argv[1:]`는 **건드리지 않는다** — 모르는 인자가 있어도 안전하다.

- [ ] **Step 4: `capabilities.py`의 프로브에도 넣는다**

`capabilities.py:68`의 `[sys.executable, "-c", _PROBE_CODE]`는 별도 프로세스다. P4-C12가 다섯
프로세스를 요구하므로 `_PROBE_CODE`에 한 줄을 더한다.

**`stdout`을 건드리면 안 된다.** 부모가 `capabilities.py:77`에서
`{"1": True, "0": False}.get(r.stdout.strip())`로 읽으므로 **한 글자만 섞여도 `None`이 되어
GPU 자격 판정이 조용히 "판정 불가"로 떨어진다**(JSON 파싱이 아니다). 보고는 **`stderr`로** 보낸다.

**그리고 부모가 그 `stderr`를 흘려야 한다.** `capabilities.py:67-77`은
`subprocess.run(..., capture_output=True, ...)`으로 받아 `r.stdout`만 읽고 **`r.stderr`는
누구도 로그하지 않는다** — 프로브가 보고해도 아무 데도 남지 않아 P4-C12의 증거가 되지 못한다.
`r.stderr`를 `log.info`로 흘리거나 프로브에 부모의 stderr를 상속시킨다(`stderr=None`).
어느 쪽이든 `r.stdout` 파싱 경로는 건드리지 않는다.

- [ ] **Step 5: 통과를 확인하고 실제 로그를 본다**

```bash
pnpm worker:test && uv run --directory be/worker ruff check .
uv run --no-sync --directory be/worker python -m damwha_worker --run-id=probe-1 2>&1 | head -5
```

기대: `runtime {"executable": …, "prefix": …, "sys_path_head": [...]}` 한 줄. (DB가 없으면 그
뒤에 접속 실패가 나온다 — 무관하다.)

**Verify:** Step 5 통과.

**Review:**
- worker가 `--run-id`를 **읽어 넘기기만** 하고 자기 동작에 안 쓰는가.
- `--once` 자식과 capabilities 프로브가 **각자** 보고하는가.
- 프로브가 `stdout`을 안 건드리는가.
- `main()`의 argv 판정을 안 바꿨는가.

- [ ] **Step 6: 커밋** — `feat(worker): run-id를 자식에게 전파하고 런타임을 스스로 보고한다`

---

## Task 3: worker — `llm_entry`, embed 모듈 진입, import 부작용 제거

**Files:** Create `damwha_worker/llm_entry.py` + `tests/test_llm_entry.py`, `desktop/scripts/lib/macho.mjs`; Modify `embed_service.py`, `llm_server.py`, `config.py`, `tests/test_llm_server.py`, **`desktop/scripts/build-python.sh`**, `desktop/scripts/{package.mjs,check-bundle.mjs}` (Step 7)

**Interfaces:** 위 계약의 `llm_entry`·`llm_server` 절. `lens_llm_server_bin` 기본값이 `""`(=모듈 진입)로 바뀐다.
**두 Python 시그니처는 계약 절에만 있다** — 이 Task는 본문만 고친다 (규칙 2).

- [ ] **Step 1: 지금 코드를 읽는다**

```bash
sed -n '1,15p' be/worker/damwha_worker/embed_service.py
sed -n '60,120p' be/worker/damwha_worker/llm_server.py
```

확인할 것 셋:
- `embed_service.py:10-11`이 **모듈 수준**에서 `load_settings()`·`build_text_embedder()`를 부른다.
- `managed_llm_server`(`llm_server.py:68`)의 인자 순서가 계약 절에 적힌 그대로인지 — 특히
  `(model, settings)` 순서. 테스트 호출부가 그것을 따른다.
- `_wait_ready`(`:130`)가 600초를 센다(`config.py:53`). **Task 10이 이 함수의 본문을 다시
  고친다** — 시그니처는 그때도 그대로다.

- [ ] **Step 2: `embed_service.py`의 import 부작용을 없앤다**

모듈 수준의 두 줄을 **지연 초기화**로 바꾼다. `health()`는 그것을 부르지 않는다 — 모델이 아직
안 올라왔어도 프로세스가 살아 있음을 답해야 한다. `embed()`와 `main()`만 부르고, `main()`이
uvicorn 전에 한 번 불러 **기동 시점에** 모델을 올린다(첫 요청이 31초 걸리지 않게).

`main()`에 `runtime_facts()` 보고와 `if __name__ == "__main__": main()`을 더한다.
**보고는 `console.install_logging()` 뒤다** — 지금 `embed_service.py:39`의 `main()`에는
`install_logging()`이 아예 없고, 없이 찍으면 uvicorn이 로깅을 잡기 전에 나가 `embed.log`에
남지 않는다. 순서는 `install_logging()` → `runtime_facts()` 보고 → 지연 초기화 → `uvicorn.run`
(스펙 §9 P4-C12가 이 순서를 명시한다).
`[project.scripts]`의 `damwha-embed`는 **그대로 둔다** — `deploy/README.md`가 쓴다.

- [ ] **Step 3: `llm_entry.py`를 쓴다**

하는 일이 넷뿐이다:
1. `--run-id`를 **받아서 버린다** (앱이 `ps -axo args`로 읽는 것이 전부다).
2. 나머지 인자로 `sys.argv`를 재구성한다. `argv[0]`은 남긴다 — argparse가 prog 이름으로 쓴다.
3. **`runtime_facts()`를 stderr로 보고한다** — `main()`을 부르기 **전에.** `llm_entry`는 P4-C12의
   다섯 프로세스 중 하나이고, 다른 넷의 보고가 이것을 증명하지 못한다(`--once` 자식이 `popen`한
   **별도 프로세스**다). `mlx_lm.server`가 뜨고 나면 그 안에서는 찍을 자리가 없다.
4. **같은 프로세스에서** `mlx_lm.server.main()`을 부른다.

**[실행됨: `uv tool run --from mlx-lm python -c "..."`]** — `mlx_lm.server.main()`이
`server.py:1751`에 있고 `:1887`에서 `parser.parse_args()`로 `sys.argv`를 읽으며, 모듈 import에
부작용이 없다(`if __name__` 가드가 `:1899`). `sys.argv`를 재구성해 `main()`을 부르면 그 파서가
정상 동작한다. **재현이 필요하면 `uv run --no-sync --directory be/worker`로 한다** — Part 1
Task 3이 `mlx-lm==0.31.3`을 매니페스트·`.venv`·번들에 넣었으므로 그것으로 충분하고,
`uv tool …`은 `~/.local/share/uv/tools`(절대 불변 옆)를 다시 건드린다.

**설계 제약 — `llm_entry`는 번들 단독으로 import되어야 한다 (Part 1 R-10).** Step 7이 이
모듈을 `build-python.sh`의 진입점 목록에 넣는데, `check_entrypoints`는 `-E -s -P`로 돈다 —
cwd도 `PYTHONPATH`도 `.pth`도 없다. 그래서 `llm_entry`는 (a) 그 격리에서 import 가능해야 하고
(b) `find_spec("damwha_worker.llm_entry").origin`이 **번들 트리 아래**여야 한다. namespace
패키지(`origin=None`)는 실패로 센다. 모듈 수준에 `mlx_lm` import를 두지 않는 것이 여기서
두 번째 이유를 얻는다 — `find_spec`이 부모 패키지를 실제로 import하기 때문이다.

**진행 훅은 Task 9가 이 모듈에 꽂는다.** 여기서 부르면 아직 없는 모듈을 import해 Step 6이
`ImportError`로 죽는다 — 각 Task가 초록불로 끝나야 한다(로드맵 §5). 자리만 주석으로 남긴다.

중간 프로세스를 만들지 않는 것이 핵심이다 — exec 래퍼나 부모-자식 구조로 하면 스펙 §6.2가
없앤 uv 구조가 되살아난다.

- [ ] **Step 4: 실패하는 테스트를 쓴다**

`test_llm_entry.py` — `--run-id`만 걸러내고, 없으면 그대로 두고, `--run-id`로 **시작하는**
토큰만 뺀다(`org/run-id-model` 같은 값은 남는다).

`test_llm_server.py` — 호출부는 **계약 절의 `managed_llm_server` 시그니처를 그대로** 쓴다
(규칙 2 — 여기에 다시 적지 않는다):

| 테스트 | 기대 |
| --- | --- |
| 기본값(`lens_llm_server_bin=""`) | `argv[0] == sys.executable`, `argv[1:3] == ["-m","damwha_worker.llm_entry"]`, `--run-id=` 토큰 존재 |
| 탈출구(값을 채움) | `argv[0]`이 그 파일. **`--run-id` 토큰이 없다** — 앱이 소유를 증명할 수 없다 |
| 없는 탈출구 경로 | 오류 문구에 `uv tool install`이 **없고** `LENS_LLM_SERVER_BIN`이 있다 |

- [ ] **Step 5: `config.py`와 `llm_server.py`를 함께 고친다**

`lens_llm_server_bin`의 기본값을 `""`로 내리고, `llm_server.py:92-100`의 `shutil.which` 블록을
두 갈래로 바꾼다 — 빈 값이면 `[sys.executable, "-m", "damwha_worker.llm_entry"]` + 부모의
`run_id_arg(sys.argv)`를 이어 붙이고, 값이 있으면 그것을 실행 파일로 그대로 쓴다.

**둘을 한 커밋에 묶는다.** 기본값만 먼저 내리면 `shutil.which("")`가 `None`을 돌려줘 그 시점에
관리형 LLM 서버가 뜨지 않는 상태가 커밋으로 남는다.

- [ ] **Step 6: 통과를 확인한다**

```bash
pnpm worker:test && uv run --directory be/worker ruff check .

# import가 부작용 없이 되는가 — 설정도 DB도 없이
env -u DATABASE_URL uv run --no-sync --directory be/worker python -c \
  "import importlib.util as u; print(all(u.find_spec(m) for m in ('damwha_worker.embed_service','damwha_worker.llm_entry','mlx_lm.server')))"

# llm_entry가 인자를 그대로 넘기는가
uv run --no-sync --directory be/worker python -m damwha_worker.llm_entry --run-id=probe --help 2>&1 | head -5
```

기대: 첫째 `True`, 둘째가 `mlx_lm.server`의 `--help`(run-id가 그쪽에 안 새고 argparse가 안 죽는다).

- [ ] **Step 7: `build-python.sh`를 한 파동으로 고친다 — 재빌드가 1회만 돌게**

**이 스크립트를 고치면 rt·wk 두 층이 다시 빌드된다.** `RT_KEY`가 **자기 shasum**을 입력으로
갖고(`build-python.sh:106`) `WK_KEY ⊇ RT_KEY`이므로(`:118`), 한 줄만 바꿔도 1.3 GB짜리 층 둘이
다시 만들어진다 — **온난 311초**(`~/.cache/uv` 기준. 차가우면 수십 분), 그 뒤 스테이징까지.
그래서 이 Task에서 그 파일에 필요한 변경을 **전부 모아 한 번에 적용한다.** Part 1이 Part 2로
명시 이월한 둘이 같은 파일에 있어 함께 들어간다 (Part 1 결과 문서 §9·§9.1).

| # | 변경 | 출처 |
| --- | --- | --- |
| 1 | `check_entrypoints`의 `TARGETS`에 `damwha_worker.llm_entry` 한 줄 (`:609-610`) | 이 Task |
| 2 | `install_name_tool … 2>/dev/null \|\| die` 둘(`:321`,`:355`)이 **사유를 버린다** — `codesign` 2곳과 같은 형태로 고쳐 실패 사유를 남긴다 | Part 1 §9 이월 (우선순위 사유: §9.1) |
| 3 | **캐시 GC** — 키가 바뀌면 옛 `rt-*`/`wk-*` 트리가 그대로 남는다. 현재 키가 아닌 층을 지운다 | Part 1 §8.5 이월 |

**Part 1이 Part 2로 이월한 나머지 한 건은 이 파일이 아니다.** `machOFiles()`가 `package.mjs`와
`check-bundle.mjs`에 **본문 완전 동일**로 중복돼 있어 `desktop/scripts/lib/macho.mjs`로 빼는 일이
남았다(Part 1 §9). 그 둘은 `RT_KEY`의 입력이 아니므로 **재빌드와 무관하다** — 같은 커밋에 넣되
위 파동의 비용에 더해지지 않는다. Files에 `desktop/scripts/{lib/macho.mjs,package.mjs,check-bundle.mjs}`를
함께 적는다.

2번이 왜 지금인가: **Part 2가 이 파일을 고치는 순간 재빌드가 돌고, 그때 사유 없는
"서명 실패: `<파일>`"만 남는다.** Part 1 §9.1이 그 이유로 우선순위를 올렸다.
3번이 왜 지금인가: 이 Step이 만드는 새 층 둘(2.6 GB)이 바로 옛 층을 사장시킨다.

**검증 — `--print-key`가 게이트다.**

```bash
# 1) 고치기 전: 두 층이 적중인지 본다 (읽기 전용, 0.22초)
bash desktop/scripts/build-python.sh --print-key
# 2) 세 변경을 적용한 뒤: 두 키가 모두 **바뀌어 미스**여야 한다. 안 바뀌면 파일을 안 고친 것이다
bash desktop/scripts/build-python.sh --print-key
# 3) 디스크 게이트 — 새 rt·wk 층 2.6 GB가 들어갈 자리가 있는가
df -h /
```

`[실행됨: bash desktop/scripts/build-python.sh --print-key]` — 2026-09-17, 0.22초,
`rt f1f9748ded8fe4dc` / `wk 969845ce35fbd8f8` 둘 다 **적중**. `.app`의 `.build-key`와 일치한다.
**`--print-key`는 읽기 전용이다** — 빌드도 스테이징도 하지 않는다.

그다음 실제 빌드를 **1회** 돌리고 `모듈 확인 OK`를 확인한다. `check_entrypoints`가 실패하면
그 실패는 **이 Task에서** 드러나야 한다 — Step 7이 검증 없이 끝나면 이 변경이 처음 도는 자리가
Task 5 Step 7의 `start:desktop`이 되고, 거기서 터지면 "각 Task가 초록불로 끝난다"와 로드맵 §3의
"아직 실행하지 않은 검증을 성공으로 가정하지 않는다"가 함께 깨진다.

**빌드 전에 잔존 프로세스를 확인한다** — 아래 Task 5 Step 7의 `stage()` 가드와 같은 이유다.

**Verify:** Step 6 통과 + Step 7의 `--print-key` 두 번(적중 → 미스)과 빌드 1회의 `모듈 확인 OK`.

**Review:**
- `embed_service` import가 **설정을 안 읽고 모델을 안 받는가** (Step 6 첫 명령이 증거).
- `health()`가 지연 초기화를 안 부르는가.
- `llm_entry`가 **중간 프로세스를 안 만드는가** (exec도 Popen도 없이 `main()` 직접 호출).
- `--run-id`가 `mlx_lm.server`에 안 새는가.
- 탈출구로 띄운 서버에 표식이 **없음을** 테스트가 확인하는가.
- 진행 훅을 여기서 부르지 **않는가.**
- `llm_entry`가 `main()` **전에** `runtime_facts()`를 stderr로 보고하는가 (P4-C12 다섯 중 하나).
- embed의 보고가 `install_logging()` **뒤**인가.
- Step 7의 세 변경이 **한 파동**으로 들어가 재빌드가 1회인가.
- 빌드 뒤 `모듈 확인 OK`를 **실제로 봤는가** (가정하지 않는다).

- [ ] **Step 8: 커밋** — `feat(worker): LLM 서버를 소유 표식이 남는 진입 모듈로 감싼다`

---

## Task 4: desktop — 경로 모듈과 설정·env 위생

**Files:** Create `desktop/src/process/runtime-paths.ts` + 테스트; Modify
`desktop/src/services/types.ts`, `desktop/src/config/{config,repo-root}.ts`, `desktop/src/main.ts`,
`desktop/src/services/api.ts`, `desktop/src/diagnostics/causes.ts`,
**`desktop/src/process/uv-launcher.ts`**, **`desktop/src/services/worker.ts`** (아래 Step 4의
소비자 둘); 테스트 — `tests/config/{config,config-reload}.test.ts`,
`tests/services/{api,worker,embed,supervisor}.test.ts`,
`tests/services/postgres/{service,service.integration}.test.ts`,
`tests/windows/{status-view,recovery-hint}.test.ts`

**Interfaces:** 위 계약의 `runtime-paths`·`config` 절.

**테스트 아홉이 왜 Files에 있는가.** `LaunchContext`에 `runId: string`을 더하고 `bins`를
`{ python, ffmpeg, ffprobe }`로 넓히는 순간, **ctx 픽스처를 객체 리터럴로 짓는 테스트 아홉이
전부 tsc에서 깨진다** — 실측으로 아홉 다 `bins: { uv: "/opt/homebrew/bin/uv" }` 형태다
(`supervisor.test.ts:19`, `worker.test.ts:29`, `embed.test.ts:12`, `config-reload.test.ts:196`,
`status-view.test.ts:349`, `recovery-hint.test.ts:222`, `postgres/service.test.ts:116`,
`postgres/service.integration.test.ts:58`, `api.test.ts:259`). `bins.uv`는 **이 Task에서 남긴다** —
Task 5가 런처와 함께 지운다. 아홉을 여기서 안 고치면 **이 Task의 Verify가 항상 실패한다.**

- [ ] **Step 1: `runtime-paths.ts`를 테스트 먼저 만든다**

electron을 import하지 않는 순수 모듈이다 — `services/postgres/layout.ts`의 `pgBinaries`와 같은
자리, 같은 이유(electron을 값으로 import하는 파일은 vitest가 못 부른다).

`PY_MINOR`가 `build-python.sh`의 버전과 짝이다 — 어긋나면 런타임에 "파일 없음"으로만 드러난다.

- [ ] **Step 2: env 위생 테스트를 쓴다**

| 지울 키 | 이유 |
| --- | --- |
| `PYTHONHOME`·`PYTHONSTARTUP`·`PYTHONUSERBASE` | 번들 인터프리터의 prefix 해석을 흔든다 |
| **`PYTHONDONTWRITEBYTECODE`** | 상속되면 **`PYTHONPYCACHEPREFIX`를 조용히 이긴다**(실측). 트리 오염은 없지만 `import numba`가 4.5배 느려진다 — dev 터미널에 켜져 있다는 이유만으로 앱이 느려진다. 스펙 §6.3이 표의 한 행으로 싣는다 |
| `VIRTUAL_ENV`·`CONDA_PREFIX` | 다른 환경을 가리킨다 |
| `HF_HUB_CACHE`·`TRANSFORMERS_CACHE`·`TORCH_HOME`·`XDG_CACHE_HOME` | `HF_HOME` 하나가 모두를 이긴다는 근거가 없다 |
| packaged의 `PYTHONPATH` | dev 전용이다 |

그리고 **P4-C30** — `config.json`에 `PYTHONHOME`·`HF_HUB_CACHE`를 적으면 버리고 경고한다.

- [ ] **Step 3: `config.ts`를 고친다**

- **`UV_BIN`은 여기서 빼지 않는다 — Task 5 Step 6으로 옮겼다.** 이 Task가 빼고 uv 런처는 Task 5가
  지우면, 그 한 커밋 동안 `searchDirs` 밖에 uv를 둔 개발자가 앱을 못 띄운다. **탈출구는 그것을
  쓰는 코드와 같은 커밋에서 사라져야 한다.**
- `APP_OWNED_KEYS`에 `HF_TOKEN`을 더하되 **값을 경고 문구에 싣지 않는다** — 그 문구는 화면과
  `supervisor.log`에 남는다.
- 금지 키가 파일에 있으면 버리고 경고한다(`EXTRA_PATH`·`HOST`가 이미 그 규칙을 쓴다).

**씻는 자리가 중요하다.** 상속분만 씻고 `ctx.env`를 뒤에 합치면 구멍이 남는다 —
`config.json`이 임의 문자열 키를 통과시키므로(`config.ts:299-300`) 사용자가 `PYTHONHOME`을
**다시 넣을 수 있다.** 순서는 **합친 뒤 씻고, 앱이 주장하는 값을 그 뒤에 얹는다** —
`HF_HOME`·dev `PYTHONPATH`는 씻겨 나가면 안 되기 때문이다.

- [ ] **Step 4: packaged의 저장소 게이트를 지운다 — 소비자 셋을 함께 본다**

`repoRoot`를 nullable로 만들면 소비자 **다섯**이 함께 깨진다. 계획 초안이 셋만 셌다 —
나머지 둘은 Task 5의 Files에만 있어 **이 Task의 tsc가 그 둘에서 깨진다.**

| 자리 | 지금 | 고칠 것 |
| --- | --- | --- |
| `main.ts:986` `resolveRepoRoot` | `async` + 폴더 선택 대화상자 | 동기. **packaged는 null을 돌려준다.** `saveConfigValue(…, "REPO_ROOT", …)`를 지운다 — `config.json`에 앱이 쓰는 유일한 예외가 사라진다 |
| `api.ts:172` | `const root = ctx.packaged ? … : ctx.repoRoot` → `path.join(root, …)` | packaged가 아닌데 null이면 **`path.join`에 닿기 전에** `CAUSES.repoRootMissing`으로 던진다 |
| 마이그레이션 러너 | `resolved` 참조 | 같은 판정. packaged는 번들 러너라 `repoRoot`가 필요 없다 |
| **`uv-launcher.ts:34`** | `path.join(ctx.repoRoot, "be", "worker")` | null이면 원인을 적어 던지는 **한 줄 가드.** Task 5가 이 파일을 통째로 지우므로 그 이상 손보지 않는다 |
| **`worker.ts:122`** | `path.join(ctx.repoRoot, "be","worker",".env")` | 같은 가드. **Task 5 Step 4가 이 `.env` 검사 자체를 지운다** — 여기서는 컴파일만 세운다 |

마지막 둘이 버려질 코드인 것은 맞다. **두 줄의 낭비가 "중간에 컴파일이 깨진 커밋"보다 싸다** —
그 판단이 Task 5의 존재 이유와 같다. (Task 4·5를 한 Task로 묶는 길도 있으나, 묶으면 뒤의 모든
Task 번호가 밀려 연결표·상호 참조·자체 검토를 함께 고쳐야 하고, env 위생과 런처 교체가 한
커밋·한 리뷰 목록으로 합쳐진다. 규칙 2가 지키려는 것이 바로 그 상호 참조 정합이므로 묶지 않는다.)

`CAUSES.repoRootMissing`은 **남긴다** — dev에서 저장소를 못 찾으면 API를 못 띄우는 것이
사실이다. 문구만 dev 전용으로 고친다.

`repo-root.ts`의 주석("Phase 4가 번들할 것이라 그때까지")도 사실에 맞게 고친다.

- [ ] **Step 5: `main.ts`에서 `bins`·`runId`·앱 소유 env를 만든다**

- `bins` — packaged는 `process.resourcesPath/{python,ffmpeg}`, dev는 `app.getAppPath()/build/…`.
- `runId` — `desktop-${randomUUID()}`. 실행마다 새 값.
- 앱 소유 env — `HF_HOME`(=`<userData>/models`), `FFMPEG_BIN`·`FFPROBE_BIN`,
  **`LENS_LLM_BASE_URL`**(기본값 없는 필수 키 둘 중 하나. 빠뜨리면 worker가 `ValidationError`로
  기동 실패한다), **`PYTHONPYCACHEPREFIX`**(=`<userData>/pycache`), dev만 `PYTHONPATH`,
  외부 DB 모드면 `DAMWHA_SHARED_STATE=off`.
- **`PYTHONPYCACHEPREFIX`가 왜 필수인가** (스펙 §6.1-b, Part 1 Task 6 Step 3이 여기로 넘긴다).
  번들 python이 자기 트리에 `.pyc`를 쓰면 packaged에서 `.app` 안에 **서명 봉인 밖 파일**이
  생겨 `codesign --verify --deep --strict`가 `a sealed resource is missing or invalid`로 깨진다.
  dev에서는 `desktop/build/python`(스테이징 산출물이자 dev 실행 트리)이 저장소 절대 경로를 담은
  `.pyc`로 오염된다. **단 그 오염이 `.app`까지 가지는 않는다** — `build-python.sh:734-737`의
  `stage()`가 캐시 적중 여부와 무관하게 `purge_pycache "$STAGED"`를 돌고 `package.mjs:53`이
  패키징 전에 그 스크립트를 부르므로, 오염은 봉인에 닿기 전에 쓸린다. (초안은 "그 뒤 **모든**
  패키징이 실패한다"였고 그것은 과장이다.) 남는 실해는 **패키징 경로 밖에서 생긴 `.pyc`**와
  아래 Task 5 Step 7의 실행 중 프로세스 가드 둘이다.
  `PYTHONDONTWRITEBYTECODE=1`도 같은 일을 하지만 `import numba` 하나가 0.14초 → 0.63초가
  된다(4.5배, 실측). `PYTHONPYCACHEPREFIX`는 캐시를 번들 밖에 두므로 두 목표를 다 달성하면서
  속도를 잃지 않는다.
- **`PYTHONDONTWRITEBYTECODE`는 씻는 목록에 넣는다**(스펙 §6.3). 상속되면 prefix를 조용히
  이겨서, dev 터미널에 그것이 켜져 있다는 이유만으로 앱이 4.5배 느려진다.
- **prefix 디렉터리를 만들지 못하면 로그를 남긴다.** 쓰기 불가한 prefix는 오류 없이 무캐시로
  강등되므로(실측) 조용히 느려진다. `<userData>/pycache` 생성 실패를 한 줄 남긴다.
- 자식 스폰 3곳(`capabilities.py:67`, `__main__.py:285`, `llm_server.py:103`)이 `env=`·`-I`·`-E`
  없이 상속하므로, 감독자가 주는 env에 한 번 넣으면 `--once`·프로브·`llm_entry`까지 덮인다.
- cwd의 `.env` 경고 — pydantic이 cwd의 `.env`를 읽는다(`config.py:9`). 앱 env가 이기므로 실해는
  없지만 있으면 혼란의 원인이다.

- [ ] **Step 6: 통과를 확인한다** — `test`·`lint` **둘 다.** 이 Task도 초록불로 끝난다.

**`lint`(tsc)가 먼저 깨진다.** 위 Files의 테스트 아홉과 소비자 다섯을 전부 손본 뒤에야
`test`가 돌기 시작한다 — 그 둘을 나눠 확인한다.

**Verify:** Step 6 통과 (`test`·`lint` 둘 다 초록불).

**Review:**
- `runtime-paths.ts`가 electron을 import하지 않는가.
- `HF_TOKEN` 경고에 **값이 안 실리는가.**
- `sanitizeChildEnv`가 **최종 합성 env**에 적용되는가.
- 앱이 주장하는 값이 그 **뒤에** 얹히는가.
- packaged에서 폴더 선택창이 **안 뜨는가.**
- `saveConfigValue(… "REPO_ROOT" …)`가 사라졌는가.
- `api.ts`·마이그레이션 러너가 `path.join`에 닿기 전에 원인을 내는가.
- `LENS_LLM_BASE_URL`이 실제로 들어가는가.
- **`PYTHONPYCACHEPREFIX`가 자식 env에 들어가는가** — Step 2의 위생 테스트가 assert한다.
  worker·embed·`llm_entry` **셋 다**여야 한다. 빠지면 Part 1 Task 6이 넘긴 계약이 받는 쪽
  없이 끊긴다 (6회차 blocking BL-1).

- [ ] **Step 7: 커밋** — `feat(desktop): 자식 env를 씻고 packaged의 저장소 게이트를 지운다`

---

## Task 5: desktop — 런처 교체

**Files:** Create `desktop/src/process/python-launcher.ts` + 테스트; Modify
`desktop/src/services/{types,worker,embed,worker-shutdown}.ts` + 테스트, `desktop/src/main.ts`,
`desktop/src/config/config.ts` (Step 6의 `UV_BIN`); Delete `desktop/src/process/uv-launcher.ts` + 테스트

**Interfaces:** 위 계약의 `python-launcher`·`LaunchContext` 절.

**한 Task로 합친 이유:** 런처를 더하고 소비자를 옮기고 옛 것을 지우는 셋을 나누면 중간에
컴파일이 깨진 커밋이 남는다(로드맵 §5). 셋이 한 Task이고 **끝에서 초록불이다.**

- [ ] **Step 1: 지금 런처를 읽는다**

```bash
cat desktop/src/process/uv-launcher.ts desktop/tests/process/uv-launcher.test.ts
```

**보존할 것:** `makeSink`/`sinkTails`, stdout·stderr 분리, `detached: true`, `'error'` 리스너,
`settle()`, 핸들 모양(`pid`·`alive`·`stderrTail`·`exitCode`·`onExit`·`stop`).

**버릴 것:** `ctx.bins.uv` 확인, `uv run --directory` 인자, "uv pid로 SIGTERM" 우회.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

| 테스트 | 기대 |
| --- | --- |
| 모듈 진입 | `spawn(<python>, ["-m", <module>, "--run-id=<runId>"])` |
| 추가 인자 | 모듈 뒤, `--run-id` 앞 |
| PATH | **`<python>/bin:<ffmpeg>/bin`뿐.** `/opt/homebrew`·`/usr/local` 없음 |
| cwd | `userData` |
| 스트림 | `detached: true`, `stdio: ["ignore","pipe","pipe"]`, `onStderr`가 stderr만 받는다 |
| spawn 실패 | `'error'`가 `exitCode() === -1`로 접히고 main이 안 죽는다 |
| python 경로 빔 | 원인을 적어 던진다 |

- [ ] **Step 3: 구현한다**

`uv` 중간 프로세스가 사라져 SIGTERM이 Python에 바로 닿는다. `detached: true`는 유지한다 —
dev 터미널의 그룹 신호가 종료 절차를 건너뛰는 것을 막는 것이 그 이유였고 그 이유는 그대로다.

stdout·stderr를 합치지 않는다 — worker의 ready 줄은 stderr, embed(uvicorn)의 접근 로그는
stdout이다. 합치면 `stderrTail()`이 노이즈로 밀린다 (Phase 2 실측).

env는 Task 4의 `sanitizeChildEnv`·`appOwnedChildEnv`를 쓴다.

- [ ] **Step 4: 어댑터를 옮긴다**

`worker.ts` — **`be/worker/.env` 존재 검사를 지운다.** 번들에는 그 파일이 없고 앱이 필요한 값을
전부 넣는다. 검사를 남기면 packaged에서 항상 실패한다.

`embed.ts` — `damwha-embed` 콘솔 스크립트가 아니라 `-m damwha_worker.embed_service`.
`EmbedDeps`에 `spawnFn?`을 더한다(테스트 주입용, `WorkerDeps`와 같은 이유).

- [ ] **Step 5: `worker-shutdown.ts`의 uv 전제를 사실에 맞춘다**

그 파일의 1·3단계는 **"`pid`는 uv이고 uv가 정확히 한 번 전달한다"**를 근거로 쓴다
(`worker-shutdown.ts:268`, `:321`). 이 Task 뒤에 `pid`는 **Python supervisor 자신**이다.

**동작은 유지된다** — 직접 SIGTERM 2회가 `_on_signal`의 count 1·2가 되어 `os._exit(1)`에
닿고, `detached: true`라 python이 그룹 리더가 되므로 그룹 SIGTERM도 성립한다. 바뀌는 것은
**근거이지 결과가 아니다.** 그러나 주석이 거짓이 되면 다음 사람이 그것을 근거로 고친다.

- 1·3단계 주석을 "supervisor에 직접 보낸다 — 중간 전달자가 없으므로 보낸 수가 곧 받는 수다"로.
- **`cleanUnlessOrphans`의 그룹 SIGTERM 경로를 테스트로 잠근다** (`:108-114`가 "같은 그룹에 남은
  짧은 자식(capabilities 프로브)"을 명시한다). **P4-C17의 프로브 회수가 이 경로에만 달려 있다** —
  프로브는 `[sys.executable, "-c", …]`라 `-m` 토큰도 `--run-id`도 없어 §6.5의 4조건 중 2·4를
  못 만족하고, 따라서 Task 7의 `parseDamwhaProcesses`도 Task 8의 `reapOwnedOnQuit`("내 run-id만")도
  그것을 보지 못한다.

- [ ] **Step 6: 옛 런처와 `UV_BIN` 탈출구를 함께 지운다**

```bash
/usr/bin/grep -rn "uv-launcher\|bins\.uv\|launchWithUv\|uvBin" desktop/src desktop/tests
/usr/bin/grep -rn "buildChildPath" desktop/src desktop/tests
```

**첫 결과가 비어야** 지운다 (**삭제 게이트라 판정용이다 — `/usr/bin/grep` 절대 경로로 부른다.**
이 셸의 `grep`은 `ugrep -I` 함수다). `LaunchContext.bins`에서 `uv`를 빼고 `main.ts`의
`findExecutable("uv", dirs)`도 지운다.

**`UV_BIN`을 `APP_SETTING_KEYS`에서 여기서 뺀다** (Task 4 Step 3에서 옮겨 왔다). 파일에 있으면
`DOCKER_BIN`과 같이 **로그 note**로만 남긴다 — 화면 경고가 아니다, 사람이 고른 적 없는 옛 값이다.
탈출구와 그것을 쓰는 코드가 **같은 커밋에서** 사라진다.

**둘째 grep은 삭제 게이트가 아니라 기록이다.** `buildChildPath`(`executables.ts:56-60`)의 유일한
호출자가 `uv-launcher.ts`라 이 Step 뒤에 죽은 코드가 된다. 첫 grep의 패턴은 그것을 못 잡는다.
제거는 이 Phase 밖이므로 **결과만 Task 12 결과 문서의 "남은 제약"에 적는다.**

- [ ] **Step 7: 통과를 확인하고 dev에서 띄운다**

**빌드 전에 잔존 프로세스를 확인한다.** `start:desktop`(`desktop/package.json:13`)은
`build-python.sh`를 무조건 부르고, 그 `stage()`(`build-python.sh:711-716`)는

```
procs=$(ps -Ao command= 2>/dev/null) || procs=""
if /usr/bin/grep -qF "$STAGED/bin/" <<< "$procs"; then
  die "번들 python이 실행 중이다 — 앱을 끄고 다시 하라: $STAGED"
fi
```

로 **`<repo>/desktop/build/python/bin/`을 argv에 담은 프로세스가 하나라도 있으면 빌드를
세운다.** 이 Task부터 앱이 띄우는 worker·embed·`llm_entry`·`--once`가 정확히 그 경로이므로,
앱을 제대로 안 끄고 다시 빌드하면 **Electron이 뜨기도 전에** 그 `die` 메시지에서 멈춘다.
(이 가드는 Part 1 R-11이 `070ea2b`에 만든 것이라 이 계획이 쓰일 때 없었다.)

```bash
# 0) 잔존 확인 — 있으면 kill 뒤 다시 본다
ps -Ao command= | /usr/bin/grep -F "$PWD/desktop/build/python/bin/"
pnpm --filter damwha-desktop run test && pnpm --filter damwha-desktop run lint
pnpm --filter damwha-desktop run start:desktop
```

**worker를 고친 뒤 첫 `start:desktop`은 wk 층 재빌드 ~130초를 포함한다** — 이 Task는
`worker.ts`만 고치지만 앞의 Task 1·2·3이 `damwha_worker`를 고쳤고 `WK_KEY`가 그 트리 해시를
담는다(`build-python.sh:118`). 멈춘 것처럼 보이면 `--print-key`로 미스인지 먼저 본다.

기대: 넷이 `running/ok`. `<userData>/logs/worker.log` 첫머리의 `runtime {…}`의 `executable`이
`desktop/build/python/bin/python3.12` (**심볼릭 링크 `python`·`python3`가 아니라 실체**).

**Verify:** Step 7 통과.

**Review:**
- `--run-id`가 argv **마지막**인가.
- PATH에 `searchDirs`가 안 들어가는가.
- `'error'` 리스너가 있는가.
- stdout·stderr를 안 합치는가.
- `.env` 검사가 완전히 사라졌는가.
- Step 6의 첫 grep이 0건인가 — **`/usr/bin/grep`으로 확인했는가.**
- `UV_BIN`이 런처와 **같은 커밋에서** 사라졌는가.
- `worker-shutdown.ts`의 uv 전제 주석이 사실에 맞게 고쳐졌고, 그룹 SIGTERM 경로에 테스트가 있는가.
- `runtime` 줄의 `executable`이 `python3.12` **실체 경로**인가.

- [ ] **Step 8: 커밋** — `feat(desktop): worker와 embed를 번들 Python으로 띄우고 uv 런처를 지운다`

---

## Task 6: desktop — 토큰 저장소와 온보딩

**Files:** Create `desktop/src/config/token-store.ts` + 테스트, `desktop/src/windows/token-window.ts`, `desktop/shell/token.html`; Modify `desktop/src/main.ts`, `causes.ts`, **`desktop/tests/windows/shell-html.test.ts`**

**Interfaces:** 위 계약의 `token-store` 절. 창은 `openTokenWindow(deps): Promise<string>`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`token-store` — 쓰고 읽기, **평문이 디스크에 없음**, 0600, 없으면 null, **복호화 실패는 null이고
파일을 안 지움**, `safeStorage` 불가 시 `available()===false`이고 `write`가 던짐, `clear`.

`maskToken` — 앞뒤만 남기고, 짧으면 전부 가린다.

`verifyHfToken` — 200이면 ok, 401은 `invalid`, 네트워크 실패는 `offline`(무효와 구별),
**실패 사유에 토큰 원문이 없다.**

- [ ] **Step 2: `token-store.ts`를 구현한다**

electron을 값으로 import하지 않는다 — main.ts가 진짜 `safeStorage`를 주입한다.

복호화 실패가 **파일을 안 지우는** 이유: 다른 맥에서 옮겨 온 것일 수 있고 우리가 지우면 복구할
길이 없다.

`verifyHfToken`의 실패 문구에 **원본 예외 메시지를 옮기지 않는다** — 네트워크 스택이 요청
헤더를 메시지에 담는 경우가 있고 그러면 토큰이 화면과 로그에 샌다.

- [ ] **Step 3: 온보딩 창을 만든다**

기존 `desktop/shell/`의 스타일에 맞춘다. 화면이 가진 것 셋: 조건 수락 페이지 링크, 토큰 발급
페이지 링크, 입력칸 + 확인.

**건너뛰기 버튼을 두지 않는다.** 창을 닫으면 앱이 종료된다.

외부 링크는 `shell.openExternal`로 연다 — 앱 창 안에서 huggingface.co를 열면 우리 origin 경계
밖의 내용을 렌더한다(Phase 1 `windows/origin.ts`의 규칙).

**`token.html`을 `shell-html.test.ts`의 검사 대상에 넣는다.** 그 테스트의
`for (const file of ["services.html", "status.html"])`(`shell-html.test.ts:303`)가 **하드코딩**이라
새 페이지는 CSP·innerHTML 싱크 불변식을 하나도 안 받는다. **토큰 창은 HF 오류 문구를 렌더한다** —
외부에서 온 문자열을 화면에 올리는 페이지이므로 그 불변식이 가장 필요한 자리다.

- [ ] **Step 4: 기동 흐름에 게이트를 넣는다**

서비스를 띄우기 **전에**. `safeStorage`를 못 쓰면 **기동을 막고** 원인을 띄운다 — 평문 폴백은
두지 않는다. 토큰이 있으면 `ctx.env.HF_TOKEN`에 넣는다.

`CAUSES`에 `safeStorageUnavailable`·`hfTokenInvalid`·`hfGateNotAccepted`(그 모델의 수락 페이지
링크 포함)를 더한다. **`hfGateNotAccepted`의 소유는 이 Task다** — Task 11 Step 4는 그것을 다시
적지 않고 여기 것을 쓴다.

- [ ] **Step 5: 손으로 확인한다**

```bash
# 잔존 프로세스 먼저 — Task 5 Step 7과 같은 이유 (build-python.sh의 stage() 가드)
ps -Ao command= | /usr/bin/grep -F "$PWD/desktop/build/python/bin/"
rm -f ~/Library/Application\ Support/Damwha/hf-token.bin
pnpm --filter damwha-desktop run start:desktop
```

토큰 창이 먼저 뜨고, 아무 문자열이나 넣으면 거절되고, 진짜 토큰을 넣으면 저장되고 서비스가 뜬다.

**토큰 교체 뒤 live env를 갱신하는 경로는 Task 11이 만든다** — 그것이 `restartService`(Task 10)를
쓴다. 이 Task는 **저장·검증·읽기**까지만 한다.

**Verify:** 테스트 전부 + Step 5.

**Review:**
- `token-store.ts`가 electron을 값으로 import하지 않는가.
- 복호화 실패가 파일을 **안 지우는가.**
- 실패 문구에 토큰이나 원본 예외가 안 들어가는가.
- 건너뛰기 버튼이 **없는가.**
- 외부 링크가 `shell.openExternal`인가.
- 평문 폴백이 **없는가.**

- [ ] **Step 6: 커밋** — `feat(desktop): 첫 실행에 허깅페이스 토큰을 받아 키체인에 보관한다`

---

## Task 7: desktop — 프로세스 판독과 고아 정리

**Files:** Create `desktop/src/process/orphans.ts` + 테스트; Modify `desktop/src/services/{worker-discovery,embed}.ts`, `main.ts`, `causes.ts`

**Interfaces:** 위 계약의 `orphans` 절.

- [ ] **Step 1: 기존 판정을 읽는다**

```bash
sed -n '30,60p' desktop/src/services/worker-discovery.ts
sed -n '78,88p' desktop/src/services/worker-discovery.ts
ps -axo pid,args | /usr/bin/grep -i python | head -5
```

**대체하지 않고 확장한다.** 기존 세 조건(argv[0] basename이 python, `-m damwha_worker` 토큰 쌍,
`--once` 유무)이 `uv run …` 런처 줄과 `/bin/zsh -c "… damwha_worker …"` 셸 줄을 거른다. run-id만
보면 `grep --run-id=…` 같은 줄이 걸린다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

**`parseDamwhaProcesses(psText, trees)` — 계약 절의 시그니처를 그대로 쓴다.**

| 테스트 | 기대 |
| --- | --- |
| worker·`--once`·embed·`llm_entry` | 넷 다 잡고 `module`·`once`·`runId`가 맞다 |
| **저장소 `.venv` worker** | **목록에 들어오고 `classify`가 `external`로 판정한다** |
| `uv run …` 런처 줄 | 안 잡는다 |
| `grep --run-id=… damwha_worker` / `zsh -c` | 안 잡는다 |
| **공백 든 설치 경로** (`/Users/me/My Apps/Damwha.app/…`) | **잡는다** |
| dev·packaged 두 트리 | 각 트리의 `root`로 판정해 둘 다 잡는다 |
| 모르는 트리의 python | 안 잡는다 (오탐 아님) |
| 잘린 `ps` 줄 | 안 잡는다 — "고아 없음"과의 구별은 호출부가 한다 |
| `classify` | 내 run-id=`mine`, 다른 값=`orphan`, 없음·트리 밖=`external` |
| `reapOrphans` 실패 | `ps` 비영 종료·빈 출력 둘 다 `{failed:true}` |

**`parseDamwhaProcesses`와 `classify`의 분담이 스펙 §6.5의 네 조건과 이렇게 맞는다** (2026-09-17
정정). 판독기는 **조건 1·2**로 목록에 넣고 — argv[0]이 절대 경로이고 basename이 `python3.12`,
`-m` 다음 토큰이 우리 모듈 셋 중 하나 — `classify`가 **조건 3·4**를 적용해 딱지를 붙인다.
그래서 저장소 `.venv`의 worker는 **목록에 들어온 뒤 조건 3에서 `external`로 갈린다.** 계약의
`runId: string | null`이 이 분담과 같은 모양이다(판독기가 run-id 없는 줄도 담는다).
초안은 이것을 "안 잡는다"로 적어 아래 Review 항목("저장소 `.venv` worker가 `external`인가")과
**Task 안에서 모순이었다.** 리뷰 항목이 옳다 — P4-C21의 판정 근거가 그것이다.

- [ ] **Step 3: 구현한다**

**판독은 아는 접두사로 먼저 자른다.** `ps -axo pid,args`는 argv를 공백으로 이어 붙인 평탄한
문자열이라 다시 토큰으로 쪼갤 수 없다. 공백이 든 설치 경로는 흔하고, 단순 `split(/\s+/)`는
argv[0]을 잘라 **정상 프로세스를 판정에서 누락시킨다** — 고아 정리가 조용히 생략된다. 앱은 자기
인터프리터 경로를 정확히 알고 있으므로 그것으로 자른다.

처분: `mine`(있을 수 없다 — 방금 만든 UUID, 나오면 로그하고 무시) / `orphan`(내린다, 묻지
않는다 — 이미 죽은 앱의 것이고 살려 두면 중복 처리 창이 열린다) / `external`(손대지 않는다).

**신호 직전에 pid를 다시 확인한다**(`exists`) — 스캔과 신호 사이에 pid가 재사용될 수 있다.

**스캔이 실패하면 새 worker를 띄우지 않는다.** `ps`가 실패했는데 진행하면 고아와 새 프로세스가
같은 job을 집는다.

- [ ] **Step 4: 기존 `worker-discovery.ts`의 공백 경로 한계를 함께 고친다**

스펙 §6.5가 이 Phase에 배정한 수정이다 — "(기존 `worker-discovery.ts:78-85`도 같은 [공백 경로]
한계를 갖는다. **이 Phase가 함께 고친다**.)" 그 자리는 지금
`isWorkerSupervisor(row[2].split(/\s+/))`(`worker-discovery.ts:85`)로 **단순 공백 분할**이다.

**Task 5가 이것을 실제 결함으로 바꾼다.** 그 전까지 앱의 worker argv[0]은 `uv`였고 uv는
`searchDirs` 아래(`/opt/homebrew/bin/uv`)라 공백이 없었다. Task 5 뒤에는 argv[0]이 **번들 python의
절대 경로**이므로, 공백이 든 설치 경로(`/Users/me/My Apps/Damwha.app/…`)에서 `split(/\s+/)`가
argv[0]을 잘라 `isWorkerSupervisor`가 **항상 거짓**이 된다 — 외부·고아 worker 탐지가 조용히 빠진다.

Step 3의 접두사 절단을 그 자리에도 쓴다. 기존 세 조건의 의미는 그대로 두고 **토큰화 방법만**
바꾼다 — 이 함수의 소비자는 "앱이 아닌 worker가 도는가"를 묻는 stand-down 판정이라 run-id를
요구하지 않는다.

- [ ] **Step 5: embed 채택 규칙을 좁힌다**

`--run-id`가 있고 내 것이 아닌 embed는 채택 대상이 아니라 **고아**다 — 먼저 내리고 새로 띄운다.
run-id 없는 외부 embed(터미널 `pnpm embed`)만 채택한다. Phase 3 §5.2-2의 "고아 embed가 한 번은
채택되고 그 뒤에는 둘이 모델 메모리를 썼다"가 닫힌다.

- [ ] **Step 6: `main.ts`에서 서비스 기동 **전에** 정리한다**

뒤에 하면 새로 띄운 것과 고아가 잠시 공존한다.

**`trees`는 `bins`에서 만들 수 없다** — `ctx.bins`는 **이번 실행의 한 벌**이고 여기 필요한 것은
packaged·dev **두 벌**이다(하나의 userData를 두 빌드가 공유하므로 dev로 띄운 고아를 packaged가,
또 그 반대도 만난다). 계약 절의 `knownBundleDirs(ctx)`가 두 bundleDir을 돌려주고, 각각에
`pythonBinaries()`를 적용해 `KnownTree[]`를 만든다.

**Verify:** `test`·`lint` 통과.

**Review:**
- 네 조건이 **전부** 적용되는가 — 판독기가 1·2, `classify`가 3·4 (스펙 §6.5).
- 판독이 **접두사 절단**인가 — 새 `orphans.ts`와 **기존 `worker-discovery.ts:85` 둘 다.**
- 저장소 `.venv` worker가 목록에 들어와 `external`로 판정되는가 (P4-C21의 근거).
- 스캔 실패가 기동을 **막는가.**
- 신호 직전 `exists` 확인이 있는가.
- 정리가 기동 **전**인가.
- 테스트가 계약 절의 시그니처를 그대로 쓰는가 (규칙 2).

- [ ] **Step 7: 커밋** — `feat(desktop): 이전 실행이 남긴 고아 프로세스를 기동 전에 정리한다`

---

## Task 8: desktop — 앱 종료 회수 (B층)

**Files:** Create `desktop/src/app/reap-on-quit.ts` + 테스트; Modify `desktop/src/main.ts`, `desktop/tests/services/supervisor.test.ts`

**Interfaces:** 위 계약의 `reapOwnedOnQuit`.

- [ ] **Step 1: 왜 `stop()` 안에 넣으면 안 되는지 확인한다**

```bash
sed -n '262,292p' be/worker/damwha_worker/__main__.py
sed -n '445,455p' desktop/src/services/supervisor.ts
sed -n '533,540p' desktop/src/services/supervisor.ts
sed -n '505,540p' desktop/src/main.ts
sed -n '1220,1236p' desktop/src/main.ts
```

**두 가지가 겹친다.**

1. Python supervisor는 **두 번째 신호에서** `--once` 자식을 `proc.kill()`하고 `os._exit(1)`한다
   (`__main__.py:273-287`). 자식은 `start_new_session=True`라 별도 세션이므로, 부모가 먼저
   사라지면 자손 SIGKILL이 훑을 트리가 없다.
2. **감독자가 죽은 서비스의 `stop()`을 아예 안 부른다.** `watchForDeath`가 `rt.result = null`로
   만들고(`supervisor.ts:451`), `stopAll`이 `if (rt.result === null || !rt.result.owned) continue`로
   건너뛴다(`:537`). **`stop()` 안에 무엇을 넣어도 이 경로에서는 실행되지 않는다.**

둘째가 결정적이다. 그래서 **핸들도 감독자 상태도 보지 않는 층**을 따로 만든다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

| 테스트 | 기대 |
| --- | --- |
| 핸들 없이 내 run-id 전부 회수 | worker·`--once`·`llm_entry`·embed 넷 |
| **부모와 `--once`가 둘 다 없어도** `llm_entry` 회수 | P4-C19-b |
| 다른 run-id | 안 건드린다 (기동 시 정리가 맡는다) |
| run-id 없는 외부 worker | 안 건드린다 |
| 스캔 후 사라진 pid | `kill` 안 한다 (`exists`) |
| 회수한 것이 있으면 로그 | A층이 놓쳤다는 뜻이다 |
| 아무것도 없으면 조용 | — |

**감독자 통합 테스트** — `watchForDeath` → `rt.result=null` → `stopAll` 경로를 실제로 밟는다:
worker를 죽이고 `stopAll`을 부른 뒤 **`workerStopCalls === 0`**(그것이 이 경로의 전제다)을
확인하고, 그다음 `reapOwnedOnQuit`가 그 pid를 회수한다.

- [ ] **Step 3: 구현한다**

자손을 부모보다 **먼저** 죽인다 — 순서가 뒤집히면 부모가 사라지며 트리를 잃는다.
대상은 **내 run-id만**이다. 회수한 것이 있으면 `supervisor.log`에 남긴다 — 조용히 덮으면 A층의
결함이 영영 안 보인다.

- [ ] **Step 4: `main.ts`의 `stopServices()`에 붙인다**

**`quit-flow.ts`가 아니다.** 거기에는 `stopAll`이 없고(`deps.stopServices()`를 부른다,
`quit-flow.ts:233`), `stopAll`은 `main.ts:511`의 `stopServices()` 안에 있다. 그리고
`main.ts:1224`의 `.catch`가 **`stopServices` 자체가 거부한** 경우를 받아 `quitNow()`로 가는데,
`runQuitFlow` 안에 두면 그 경로에서 건너뛰어진다 — B층의 존재 이유가 "A층이 놓친 경로"인데
그중 하나를 놓친다.

`stopAll`이 **던진 경로에서도** 돌아야 한다. A층이 `stopped: true`라고 해도 B층이 무언가
회수했으면 clean이 아니었다 — 종료 화면의 "남은 것" 판정에 합친다.

**Verify:** `reap-on-quit` 7건 + 감독자 통합 1건.

**Review:**
- B층이 **핸들도 감독자 상태도 안 보는가.**
- **`stopAll`이 던진 경로에서도 도는가.**
- `quit-flow.ts`가 아니라 `main.ts`의 `stopServices()`인가.
- 내 run-id만 대상인가.
- 자손을 부모보다 먼저 죽이는가.
- 신호 직전 `exists` 확인이 있는가.
- 회수한 것을 로그에 남기는가.
- 통합 테스트가 `rt.result=null` 상태를 **실제로 지나는가.**

- [ ] **Step 5: 커밋** — `feat(desktop): 앱 종료에 핸들과 무관한 회수 단계를 더한다`

---

## Task 9: worker — `model_readiness`와 HF 진행 훅

**Files:** Modify `damwha_worker/db/core.py`, **`damwha_worker/db/__init__.py`**, `errors.py`, `models/{pyannote_diar,bge_embed}.py`, `llm_entry.py`, `__main__.py`, `embed_service.py`; Create `models/downloads.py`, `tests/test_model_readiness.py`, `tests/test_downloads.py`

**`db/__init__.py`이지 `damwha_worker/__init__.py`가 아니다.** 후자는 **0바이트 계약**이라
한 글자만 넣어도 `check_entrypoints`의 `assert src.strip() == ''`가 빌드를 세운다
(Part 1 결과 문서 §10).

**Interfaces:** 위 계약의 `downloads`·`db/core`·`errors` 절.

- [ ] **Step 1: 기존 공유 행을 읽는다**

```bash
sed -n '1,45p' be/worker/damwha_worker/db/core.py
sed -n '70,90p' be/src/system/capabilities.ts
```

`worker_capabilities`가 선례다 — worker가 쓰고 API는 읽기 전용. 같은 방향, 같은 자리.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

**동시성을 실제로 본다** — 실제 writer는 supervisor·`--once` 자식·embed·`llm_entry`로 **다른
프로세스**다. 한 연결의 순차 쓰기는 그 경합을 증명하지 못한다.

| 테스트 | 기대 |
| --- | --- |
| 한 key 쓰기·읽기 | 그대로 |
| **두 연결**이 다른 key | 서로를 안 지운다 (`conn`·`conn2` fixture) |
| 행이 없을 때 | 생성된다 |
| 늦은 `downloading` | `ready`를 못 덮는다 |
| **동률** | 먼저 쓴 것이 이긴다 (`<` 비교) |
| `writer`·`updated_at` | 항목에 실린다 |
| `DAMWHA_SHARED_STATE=off` | **아무것도 안 쓴다** |
| `classify_download` | 401·403 = PERMANENT, 네트워크 = TRANSIENT |

- [ ] **Step 3: 원자적 merge를 구현한다**

**한 SQL 문이다.** `INSERT … ON CONFLICT DO UPDATE`에서 충돌한 행의 현재 `entries`에
`jsonb_build_object(key, entry)`를 `||`로 merge하고, 역전 방지는 `WHERE`의 시각 비교로 한다.
두 문장으로 나누면 그 사이에 다른 writer가 낀다.

정해야 할 것 넷:
- **`updated_at`은 함수가 한 번 만들어** `entry`와 `WHERE` 양쪽에 같은 값을 넣는다. 호출자가 안
  주면 비교 기준이 빈 문자열이 되어 어떤 옛 값도 덮어쓴다.
- `WHERE`의 `COALESCE(…, '')`가 **없는 key를 통과**시킨다.
- `<` 비교라 **동률은 무시**한다. `<=`면 같은 밀리초의 진행 갱신이 `ready`를 덮는다.
- ISO 문자열은 **고정 정밀도**다 — 같은 초에서 소수부 유무가 섞이면 사전순이 시간순과 다르다
  (`'…20Z' < '…20.5Z'`는 거짓).
- 최상위 `updated_at`은 `GREATEST`로 올린다 — 다른 key의 더 오래된 쓰기에 뒤로 가지 않게.

- [ ] **Step 4: `DAMWHA_SHARED_STATE`로 두 writer를 끈다**

`shared_state_enabled()`를 `merge_model_readiness`와 **`upsert_worker_capabilities` 둘 다** 첫
줄에서 본다. **URL 모양으로 추정하지 않는다** — worker는 자기가 어느 DB에 붙었는지 알 수 없다.
기본은 켬이라 웹 흐름(이 변수 없음)의 기존 동작은 그대로다. Phase 3이 남긴 "외부 DB 모드에서
worker가 capabilities 한 행을 쓴다"는 한계가 닫힌다.

- [ ] **Step 5: 진행 훅을 구현한다**

**[실행됨: `uv run --no-sync --directory be/worker python -c "…"`]** — 실측으로 확정된 사실:

- `huggingface_hub 1.20.1`의 `snapshot_download`·`hf_hub_download`가 둘 다
  `tqdm_class: type[base_tqdm] | None`을 받는다.
- 소비자 넷이 전부 **모듈 수준** `from huggingface_hub import …`이다 —
  `mlx_whisper/load_models.py:8`, `sentence_transformers/util/file_io.py:7`,
  `pyannote/audio/pipelines/speaker_verification.py:32` **와** `pyannote/audio/utils/hf_hub.py:27`,
  `mlx_lm/utils.py:33`.
- **`getattr(mod, name, None)`으로 `sys.modules`를 훑으면 92개 모듈이 `ModuleNotFoundError`를
  던진다** (transformers의 지연 모듈이 `__getattr__`에서 서브모듈을 import한다). `vars(mod).get(name)`은
  던지지 않는다.

그래서 설치가 두 갈래다:
1. `huggingface_hub`의 원본을 바꿔 **아직 import되지 않은** 소비자를 덮는다.
2. **`vars(mod).get(name)`으로** `sys.modules`를 훑어 이미 import된 소비자의 속성도 바꾼다.
   **`getattr`를 쓰지 않는다.**

호출부는 무거운 모듈을 import하기 **전에** 부른다. 2번이 있어 순서가 어긋나도 동작한다.
멱등이어야 한다(세 진입점이 각자 부른다).

**`tqdm_class`는 바이트 바(`unit="B"`)와 파일 수 바 둘 다에 쓰인다** — `update(n)`의 `n`이
단위가 섞이므로 `self.unit == "B"`일 때만 `bytes_done`에 가산한다.

진행 갱신은 **초당 1회 이하**로 누른다.

- [ ] **Step 6: 훅 테스트**

| 테스트 | 기대 |
| --- | --- |
| **설치 전에 바인딩한 가짜 모듈** | 설치 뒤 그 모듈의 속성도 바뀐다 |
| **`__getattr__`가 던지는 가짜 모듈**이 `sys.modules`에 있어도 | 설치가 성공한다 |
| 두 번 설치 | 멱등 |
| 호출자가 `tqdm_class`를 명시하면 | 우리 훅이 무시된다 — 그 사실을 테스트가 못 박는다 |

- [ ] **Step 7: `llm_entry`에 훅을 꽂는다**

Task 3이 주석으로 남긴 자리. `llm_entry`는 그 보고를 위해 **자기 DB 연결을 연다** —
supervisor·`--once` 자식에 이은 세 번째 writer 프로세스다. `DATABASE_URL`은 앱이 주입한 것을
물려받는다.

- [ ] **Step 8: 401·403을 보존하고 bge-m3 리비전을 고정한다**

`pyannote_diar.py:16-22`가 토큰 문제와 조건 미수락을 합쳐 일반 `RuntimeError`로 만들고
`errors.py:62-74`가 그것을 TRANSIENT로 처리한다. 둘 다 재시도해도 안 되는 실패이고 서로 다른
안내가 필요하다 — 401은 토큰 무효, 403은 조건 미수락.

**`classify_download`의 호출부를 여기서 못 박는다.** 계약 절에 선언이 있고 Step 2에 테스트가
있으나 **누가 그것을 부르는지가 어느 Step에도 없었다.** 경로는 하나다 —
`errors.classify`가 다운로드 예외에 대해 `classify_download`를 타고, 그 결과가
`merge_model_readiness`의 항목에 **`error_kind`로 실린다**(스펙 §6.9의 필드, 계약 절
`ReadinessEntry.errorKind`). 이것이 없으면 Task 11 Step 3의 "층별 안내"와 스펙 §8의
"403 → 수락 페이지 링크 / 401 → 재입력" 구분을 **화면이 할 근거가 사라져** 403과 네트워크 실패를
같은 말로 적게 된다.

`bge_embed.py`가 리비전을 고정하고 safetensors만 받게 한다.
**`sys.modules.setdefault("torchcodec", None)`(`bge_embed.py:14`)을 지우지 않는다** — Part 1 §8.1이
기록한 사장 dylib 우회다. `torchcodec`의 dylib 5개가 `@rpath/libavcodec.{58..62}`를 요구하는데
번들에는 그 rpath가 없어(재배치가 지웠다) 진짜로 import하면 죽는다. Step 8이 같은 파일을
건드리므로 여기서 못 박는다. Phase 0 실측: 같은 가중치를
`pytorch_model.bin`(rev `5617a9f…`)과 `model.safetensors`(rev `9a0624b…`)로 두 벌, 리비전까지
갈려 받아 2.1 GB를 낭비했다.

**Verify:** `pnpm worker:test`·`ruff check .` 통과.

**Review:**
- merge가 **한 SQL 문**인가.
- `updated_at`을 **함수가** 만드는가.
- 동률에 `<`인가.
- `sys.modules` 훑기가 **`vars()`**인가 (`getattr`가 아니라).
- 훅이 멱등인가.
- `unit == "B"`일 때만 바이트에 가산하는가.
- `shared_state_enabled()`를 **두 writer 모두** 보는가.
- 401·403이 PERMANENT인가.
- `classify_download`의 **호출부가 실제로 있고** 그 결과가 `error_kind`로 실리는가.
- `bge_embed.py`의 `torchcodec` 우회가 **그대로 남았는가.**

- [ ] **Step 9: 커밋** — `feat(worker): 모델 다운로드 상태를 app_setting에 올린다`

---

## Task 10: desktop — 준비 유예와 서비스 재시작

**Files:** Create `desktop/src/services/model-readiness.ts` + 테스트; Modify `desktop/src/services/supervisor.ts` + 테스트, `be/worker/damwha_worker/llm_server.py`, `be/worker/damwha_worker/config.py`, `be/worker/tests/test_llm_server.py`

**Interfaces:** 위 계약의 `model-readiness`·`Supervisor` 절. **Python 쪽 시그니처는 바뀌지
않는다** — 계약 절의 `llm_server.py` 주석이 그 사실을 적는다 (규칙 2).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`downloadInProgress(entries, writer, now, stallMs)`:

| 테스트 | 기대 |
| --- | --- |
| 진행이 갱신 중 | `true` — 유예를 소모하지 않는다 |
| 120초 멈춤 | `false` |
| `downloading` 없음 | `false` |
| **다른 writer의 다운로드** | `false` — 이 서비스의 시계를 멈추지 않는다 |
| `bytesTotal`을 모르는 다운로드 | `true` — 판정이 `updatedAt` 기준이지 `bytesDone`이 아니다 |

감독자: 다운로드 중 유예 면제, `restartService`가 살아 있는 서비스도 내린다,
**`owned:false`와 stand-down을 거부한다.**

- [ ] **Step 2: 감독자 쪽을 구현한다 — embed에만 적용된다**

embed의 `readyTimeoutMs`는 180초인데(`embed.ts:47`) bge-m3 첫 다운로드는 그보다 오래 걸린다.
제한을 넘는 다운로드는 진행 중이어도 실패·재시작 대상이 되고, 그러면 받다 만 것을 버리고
처음부터 다시 받는 고리가 생긴다.

**고정 deadline이 아니라 다운로드 시간을 뺀 누적으로 센다** — 그러지 않으면 다운로드가 끝난 뒤
남은 유예가 0이라 곧바로 실패한다.

**`writer`로 서비스를 구별한다** — embed가 죽어 가는 동안 worker가 whisper를 받고 있으면 embed의
유예가 영영 안 끝난다.

**LLM은 감독자가 볼 수 없다.** 그 서버는 이미 준비된 worker의 job 자식이 띄우고
`awaitReady()`는 서비스 기동 때만 돈다.

- [ ] **Step 3: LLM 쪽을 Python에 넣는다**

`llm_server.py:_wait_ready`의 600초 deadline(`config.py:53`)에 같은 규칙을 넣는다.

**DB를 읽어야 한다.** `_wait_ready`는 **`--once` 자식**의 코드이고 `llm_entry`는 그것이 `popen`한
**자식**이다 — 둘은 다른 프로세스다. "같은 프로세스"는 `llm_entry`와 `mlx_lm.server.main()`
사이의 관계다.

**`_wait_ready`는 `settings.database_url`로 자기 연결을 연다** (2026-09-17 사용자 결정, 스펙 §6.9).
`--once` 자식이 쥔 연결을 인자로 받지 않는다 — **시그니처를 바꾸지 않는다.**

| | 연결을 넘긴다 | **자기 연결을 연다 (채택)** |
| --- | --- | --- |
| 파급 | `dispatch.py`·`jobs.py`·`__main__.py`의 호출부까지 | `llm_server.py`·`config.py` 둘 |
| 계약 | `_wait_ready` 시그니처 변경 → 계약 절 개정 | **변경 없음** |
| 비용 | 없음 | 폴링 주기마다 한 행을 읽는 연결 하나 |

`settings`는 이미 인자로 들어와 있으므로 새로 만들 것이 없다. 연결은 **`_wait_ready` 안에서
열고 닫는다** — 대기가 끝나면 필요 없고, 남겨 두면 `--once` 자식의 수명 동안 유휴 연결이 하나
더 산다. **DB를 못 열어도 기다림 자체는 진행한다** — 유예 연장을 못 할 뿐이고, 못 여는 것이
600초 실패의 사유가 되면 안 된다.

- [ ] **Step 4: `restartService`를 구현한다**

`retry()`의 `needsRetry`는 `rt.status.process !== "running" || rt.result === null`이라 **살아 있는
서비스를 건너뛴다**(`supervisor.ts:490`). 토큰을 바꾼 뒤 필요한 것은 정확히 그 반대다.

**감독자 객체의 메서드로 더한다.** 자유 함수로는 만들 수 없다 — 클로저의 `runtimes`·`bring`이
필요하고, 지금 반환은 `{ start, retry, stopAll, statuses, runtimeOf }`다(`supervisor.ts:561`).
반환 객체에 여섯 번째를 더하고 계약 절의 `Supervisor`가 그 모양이다.

**앱이 소유하지 않은 것은 못 내린다** — 채택한 외부 embed(`owned:false`)와 stand-down worker에는
이 경로를 열지 않고, 화면이 그 버튼을 비활성으로 보인다.

**Verify:** `test`·`lint`·`pnpm worker:test` 통과.

**Review:**
- `restartService`가 **감독자 객체의 메서드**인가 (자유 함수가 아니라).
- `restartService`가 `owned:false`·stand-down을 거부하는가.
- 무진행 판정이 `updatedAt` 기준인가.
- **`writer`로 서비스를 구별하는가.**
- 감독자가 **누적**으로 세는가.
- LLM 쪽이 **Python에** 들어갔는가.
- `_wait_ready`가 **자기 연결로** DB를 읽고 **시그니처가 그대로인가.**
- `dispatch.py`·`jobs.py`·`__main__.py`가 **안 바뀌었는가.**
- DB를 못 열어도 기다림이 진행되는가.

- [ ] **Step 5: 커밋** — `feat: 다운로드 중에는 준비 유예를 멈추고 서비스 재시작 경로를 연다`

---

## Task 11: 화면 — 모델 준비·토큰·재시도 3층

**Files:** Create `desktop/src/windows/apply-token-change.ts` + 테스트; Modify `be/src/system/*`, `desktop/src/windows/{status-view,shell-hints}.ts`, **`desktop/tests/windows/recovery-hint.test.ts`**, `desktop/shell/*`, `desktop/src/diagnostics/causes.ts`, `fe/src/**`

**Interfaces:** 위 계약의 `apply-token-change` 절.

- [ ] **Step 1: API가 행을 읽어 내보낸다**

`worker_capabilities`를 읽는 자리와 같은 방식으로 `model_readiness`를 읽어 설정 조회 응답에
`modelReadiness`로 얹는다. **읽기 전용이다** — API가 이 행을 쓰지 않는다.

- [ ] **Step 2: 토큰 교체가 live env에 닿는 경로를 만든다 (Task 6에서 옮겨 왔다)**

저장만으로는 안 된다. 감독자가 쥔 `ctx.env`는 기동 시점에 얼어붙고, 기존 설정 재적용
(`config-reload.ts`)은 **`config.json`만** 읽는다 — 토큰은 거기 없다(Keychain에 있다).

**이 Task에 있는 이유:** `restartService`(Task 10)와 "서비스 다시 시작" 버튼이 **둘 다 여기**
있어야 한 커밋이 컴파일된다.

`applyTokenChange`는 저장 → **다시 읽어** 얹기(암호화·복호화 왕복이 되는지를 그 자리에서
확인하는 것이 재시작 뒤 "왜 안 되지"보다 낫다) → 소유한 서비스만 재시작 → **재시작 못 한 것을
결과에 실어** 화면이 말하게 한다.

테스트: live env가 갱신되고 두 서비스가 재시작된다 / 저장은 됐는데 다시 읽히지 않으면 **재시작
전에** 던진다 / **채택한 외부 embed는 `skipped`에 들어가고 예외가 아니다.**

- [ ] **Step 3: 상태 창에 세 가지를 더한다**

1. **모델 준비** — `downloading`이면 진행(`bytesTotal`이 0이면 "받는 중"만), `failed`면 사유와
   층별 안내. **층을 가르는 값은 `ReadinessEntry.errorKind`다**(Task 9 Step 8이 싣는다) —
   `PERMANENT`면 401·403의 안내로 갈라 보내고, `TRANSIENT`면 "네트워크가 돌아오면" 쪽이다.
   `error` 문자열만 보고 문구를 고르지 않는다.
2. **토큰** — `maskToken` 표시, 수정·삭제, "서비스 다시 시작" 버튼.
3. **재시도 3층을 구분해 말한다:**

| 상황 | 화면이 주는 것 |
| --- | --- |
| 다운로드가 끊겼다, 서비스는 살아 있다 | "네트워크가 돌아오면 다음 처리에서 이어받아요" — 버튼 없음 |
| 서비스가 죽었거나 토큰을 바꿨다 | **"서비스 다시 시작"** |
| job이 이미 실패했다 | "이 회의를 다시 처리하기" — 기존 `POST /meetings/:id/reprocess` |

**"다시 시도" 하나로 뭉치지 않는다.** 뭉치면 눌러도 아무 일도 안 일어나는 경우가 생긴다 —
Phase 2가 stand-down worker에서 정확히 그 문제를 겪었다.

- [ ] **Step 4: `causes.ts`에 남은 원인을 더한다**

`modelDownloadFailed`·`modelDownloadStalled`·`diskFull`·`orphanScanFailed` 넷을 더한다.
**`hfGateNotAccepted`는 Task 6 Step 4가 이미 수락 페이지 링크까지 넣었다** — 여기서 다시
적지 않는다(같은 원인을 두 Task가 쓰면 문구가 갈린다).

**삭제되는 원인:** `uvMissing`, `workerEnvMissing`. 참조가 **두 곳**이다 —
`desktop/src/windows/shell-hints.ts:25,29`와 `desktop/tests/windows/recovery-hint.test.ts:186,189,242,247,437`.
후자가 Files에 없으면 이 Task의 `test`가 깨진다.

- [ ] **Step 5: FE에 모델 준비를 보인다**

`fe/DESIGN.md` 관례. 최소 범위 — 검색이 키워드로만 도는 동안 그 이유를 말하고, 처리 중 모델을
받는 중이면 그것을 보인다.

**Verify:** `pnpm build`·`test`·`lint` 통과.

**Review:**
- API가 `model_readiness`를 **쓰지 않는가.**
- 토큰이 마스킹돼 보이는가.
- 세 층이 화면에서 **구분돼** 말해지는가.
- 소유하지 않은 서비스의 버튼이 비활성이고 `applyTokenChange`가 **던지지 않는가.**

- [ ] **Step 6: 커밋** — `feat: 모델 준비 상태와 토큰 설정을 화면에 보인다`

---

## Task 12: 통합 검증과 결과 문서

스펙 §9의 완료 기준 **30건**을 판정한다. **증거 없이 "통과"라고 쓰지 않는다**
(`superpowers:verification-before-completion`).

**Files:** **Modify** `docs/superpowers/reports/2026-09-16-electron-phase-4-embedded-python-runtime-results.md`
(**이미 있다 — 아래 Step 5**), `docs/electron-migration-roadmap.md`, `desktop/CLAUDE.md`,
`be/worker/SMOKE.md`, `be/CLAUDE.md`

**`be/worker/CLAUDE.md`는 없다.** 그 서브트리의 문서는 `be/worker/SMOKE.md`와 상위의
`be/CLAUDE.md` 둘뿐이다 — 아래 Step 6이 어느 쪽에 무엇을 적는지 정한다.

- [ ] **Step 1: 기준선을 대조할 수 있는지 먼저 본다**

```bash
ls /tmp/p4-baseline/now || { echo "Part 1 Task 1의 기준선이 없다 — 이 검증은 성립하지 않는다"; exit 1; }
cat /tmp/p4-baseline/now/app-db-rows.txt
```

없으면 **여기서 멈추고 사용자에게 알린다.**

**`app-db-rows.txt`가 비어 있다 — 축 A 전에 그 한 파일만 다시 뜬다.**
기준선을 뜬 2026-09-16에 앱 내장 클러스터가 꺼져 있어 그 파일에는
`MEASUREMENT-UNAVAILABLE (embedded psql)`만 들어 있다(Part 1 §3.2가 기록). **P4-C27은
"검증 전 회의 ID·행 수 … 증가만 있고 소실·변경 0"이므로 행 수 없이 판정할 수 없고**, 스펙 §9의
그 문구를 좁히지 않는다.

그래서 **축 A를 시작하기 전에, 앱을 한 번 띄워 내장 클러스터가 올라온 상태에서** 앱 데이터
기준선만 다시 뜬다:

```bash
bash desktop/scripts/phase4-baseline.sh retake app
```

- **`phase4-baseline.sh baseline`을 다시 돌리면 안 된다.** 그 모드는 `DEST="$OUT/now"`에
  **전부** 덮어쓰므로 2026-09-16의 `abs-*` 8건과 `mut-*` 3건이 사라진다 — **P4-C26의 근거와
  `mut-uv.lock`(Part 1이 `.venv`를 바꾸기 전 사본이자 유일한 복구 경로)이 함께 날아간다.**
  `retake app`은 `app-*`만 쓴다.
- **`app-db-rows.txt`는 이제 `meeting` 한 줄이 아니라 전체 테이블 행 수이고, 회의 ID는
  `app-meeting-ids.txt`가 따로 담는다**(커밋 `3955790`). 초안이 기대한 `meeting=<수>` 한 줄은
  더 이상 그 파일의 형태가 아니다 — P4-C27의 "회의 **ID**"를 행 수만으로는 판정할 수 없어서
  고쳤다. 대조는 두 파일을 함께 본다.
- **이 시점이 "before"가 되는 한계를 결과 문서에 적는다.** 앱을 한 번 띄운 뒤의 값이므로
  "Part 2 코드가 한 번도 안 돈 상태"의 값이 아니다. 기동만으로 회의 행이 줄지 않는 것은
  이 재촬영과 검증 뒤 값의 대조로 판정되고, **그 이전 구간은 `app-storage.txt`가 덮는다** —
  그쪽은 2026-09-16 값이 유효하다(Part 1이 `.app`을 한 번도 실행하지 않았다).

**나머지 기준선 파일이 아직 유효한지도 여기서 확인한다.** `app-storage.txt`는 2026-09-16 값이고
Part 1이 앱을 띄우지 않았으므로 지금 유효하지만, **그 전제를 확인하는 절차가 초안에 없었다.**
파일 수·`ls -l`의 mtime이 기준선 이후로 움직이지 않았는지 본다.

**`abs-hf-cache.txt` 하나는 mtime이 다르다 — 그것이 정상이다.** Part 1 종료 뒤
`~/.cache/huggingface`가 Phase 4 **밖의** 요인으로 바뀌어(파일 66개·16.7 GiB 삭제, 전부 번역
실험·Qwen3-ASR 도입 검토·옛 3.1 화자분리 스택) 2026-09-17에 `retake hf`로 그 한 파일만 다시
떴다. 경위·삭제 목록·파이프라인 무영향 근거는 Part 1 결과 문서 §3.2-a에 있다. **나머지 `abs-*`
7건과 `mut-*` 3건은 2026-09-16 값 그대로다** — 그것들의 mtime이 움직였으면 그건 진짜 문제다.

**`/tmp/p4-baseline`의 수명을 먼저 정한다.** macOS의 `/private/tmp`는 재부팅에 날아가고
기준선은 2026-09-16에 찍혔는데 Part 2는 12 Task 분량이다. `phase4-baseline.sh:23`의
`P4_BASELINE_DIR`로 영구 위치를 지정하거나, `/tmp/p4-baseline`을 통째로 영구 위치에 복사해 둔다.
**이 판정을 Task 1 착수 전에 하고 결과를 여기 적는다** (아래 "구현 중 판정할 것" 3번).

- [ ] **Step 2: 착수 게이트 넷을 통과한다**

```bash
df -h /                                                   # (1) 디스크
ps -Ao command= | /usr/bin/grep -F "$PWD/desktop/build/python/bin/"   # (2) 잔존 프로세스
bash desktop/scripts/build-python.sh --print-key           # (3) 캐시 상태 (읽기 전용)
```

1. **디스크.** `package:desktop` 한 회차가 새 rt·wk 층 **2.6 GB**를 만들 수 있고, 축 B가
   모델 약 **10 GB**를 내려받는다 — whisper-large-v3-mlx 2.9 G, bge-m3 4.3 G(safetensors 한
   벌이면 ~2.2 G), Qwen3.5-4B-8bit 4.8 G, pyannote 3종 + speechbrain ~146 M.
   **`~/.cache/huggingface`는 §5의 절대 불변이라 공간 확보에 쓸 수 없다.**
   (2026-09-17 실측: 여유 34 GiB, `desktop/.cache/python` 2.7 G. 이번엔 여유가 있었을 뿐이다.)
2. **잔존 프로세스.** `package:desktop`도 `build-python.sh`를 부르므로 Task 5 Step 7과 같은
   `stage()` 가드에 걸린다. **이 Task는 P4-C18에서 `kill -9`로 고아를 일부러 만들므로** 그
   회차 뒤 다음 빌드 전에 반드시 다시 확인한다.
3. **두 토큰을 미리 준비한다.** 스펙 §4.3이 선행 조건으로 "수락한 계정과 수락하지 않은 계정
   **둘**"을 요구한다. P4-C4(교체 반영)와 P4-C8(403 vs 401)이 그것 없이는 판정되지 않는다.
4. **되돌릴 수 없는 삭제의 복구 절차를 먼저 적는다.** 이 Task는 `<userData>/models` 비우기
   (P4-C5)와 `hf-token.bin` 삭제(P4-C1)를 한다. 스펙 §5가 허용하므로 계약 위반은 아니나
   로드맵 §3이 "위험한 변경에는 실패 시 복구 방법을 포함한다"를 요구한다 — 모델은 재다운로드로
   복구되고(시간 비용만), 토큰은 **사용자만 다시 낼 수 있다.** 지우기 전에 사용자가 그 토큰을
   다시 낼 수 있는지 확인한다.

- [ ] **Step 3: packaged 앱으로 축 A~E를 순서대로 판정한다 (30건)**

각 기준마다 **명령과 출력**을 결과 문서에 남긴다. 축 순서를 지킨다 — A(토큰) → B(실사용) →
C(격리) → D(수명주기) → E(회귀·보존). B가 모델을 받아 놓아야 C·D가 실제 프로세스를 본다.

**첫 기동이 이 Phase에서 가장 위험한 한 걸음이다.** Part 1 §11이 미검증으로 남긴 둘이 여기서
동시에 처음 밟힌다 — (1) hardened runtime으로 서명한 `.app`의 첫 실행(Part 1 Task 2 Step 6-c가
잰 것은 `BrowserWindow` 없는 **맨 Electron 셸**이다), (2) **번들 트리 numba의 첫 실행**
(`check_entrypoints`의 대상 넷에 없고, `@numba.jit` 호출부는 `mlx_whisper/timing.py`의
word-timestamp 경로라 축 B의 전사에서 처음 돈다).

**거짓 통과에 특히 주의한다** — Part 1 §3.4의 부수 실측: **서명에 실패한 `.app`도 linker-signed
상태로 그냥 실행된다.** 실행 성공을 서명 성공으로 읽으면 안 된다.

**첫 기동이 실패하면 진단 순서:**

| rc | 뜻 | 다음 |
| --- | --- | --- |
| **137** (SIGKILL, 메시지 없음) | W+X 매핑 거부 — `allow-unsigned-executable-memory` 누락. **import 시점**에 난다 | 그 프로세스의 plist 키 셋을 본다 |
| **134** (SIGABRT) | dyld — `mapping process and mapped file (non-platform) have different Team IDs` | 서명 누락·불일치. 전수 `codesign --verify --arch arm64` |
| **133** | V8 `Failed to reserve virtual memory for CodeRange` | Electron 쪽에 `allow-jit`이 없다 — **`.app`용 plist를 썼는지** 확인 |

```bash
codesign -dvvv --entitlements - <.app 또는 실패한 실행 파일>
```

그리고 **Console.app의 AMFI/dyld 줄**과 **자식 프로세스의 rc**를 함께 읽는다 — 부모가 0으로
끝나도 자식이 137이면 `supervisor.log`에만 남는다.

**P4-C11의 함정:** `~/.local/bin/mlx_lm.server`를 **일시 이동**하고 요약 job이 성공해야 한다.
검증이 끝나면 **즉시 원위치**한다 (스펙 §5의 허용 변경).

**P4-C13의 (b)(c)를 재현 가능하게 적는다.** (a)는 구조적 증명이라 코드로 끝나지만 (b)(c)는
절차다 — (b) **처리 전 구간** `lsof -p <pid>`로 `/opt/homebrew`·`.venv`·`~/.local`·
`/Library/Frameworks/Python.framework` 0건, (c) 처리 중 `ps -axo args` **주기 샘플링**으로 모든
자식 실행 경로가 번들 아래. **샘플링 주기와 구간(몇 초마다, 어느 job 단계부터 어디까지, pid 집합을
어떻게 갱신하는가)을 정해 결과 문서에 적는다** — 적지 않으면 재현도 반증도 불가능하다.

**P4-C20의 fixture:** `signal.signal(SIGTERM, SIG_IGN)` 뒤 대기하는 전용 프로세스를 worker 자손
자리에 띄워 유예를 넘긴다.

**P4-C24(웹 회귀)는 별도 회차다** — 앱을 끄고 Docker DB + `be/storage` + `.venv`로 돈다.

- [ ] **Step 4: 기준선과 대조한다**

```bash
pnpm db:up          # Part 1 Task 1과 **같은 조건**
bash desktop/scripts/phase4-baseline.sh verify
```

`abs-*` 전부 `PASS`여야 P4-C26 충족이다. `mut-*`·`app-*`는 사람이 본다:

| 대조 | 합격 조건 |
| --- | --- |
| `mut-uv.lock` | Part 1 Task 3이 의도한 차이(`mlx-lm`·`mlx`)만 |
| `mut-venv-versions.txt` | 새 `uv.lock`과 일치 |
| `mut-local-bin.txt` | `mlx_lm.server`가 **제자리로 돌아왔는가** |
| `app-storage.txt` | 기준선의 모든 줄이 지금도 있다. **추가만** 있고 삭제·변경 0 |
| `app-db-rows.txt` | 전체 테이블 행 수가 **줄지 않았다**(증가만). **Step 1의 `retake app`이 뜬 값과 대조한다** — 2026-09-16 값은 `MEASUREMENT-UNAVAILABLE`이라 쓸 수 없다 |
| `app-meeting-ids.txt` | 기준선의 **모든 회의 ID가 지금도 있다.** 추가만 있고 소실 0 — 행 수만 보면 "하나 지우고 하나 넣었다"가 통과하므로 이 대조가 P4-C27의 "회의 ID" 절반을 맡는다 |

**P4-C27의 판정 범위를 결과 문서에 그대로 적는다** — 파일은 2026-09-16 기준선부터, DB 행 수는
Step 1의 재촬영 시점부터다. 두 구간이 다른 것이 이 기준의 한계이고, 숨기면 다음 Phase가 그것을
전 구간 판정으로 읽는다.

- [ ] **Step 5: 결과 문서의 §12를 채운다 — 새로 쓰는 것이 아니다**

**그 문서는 이미 있다.** `197ab7d`가 792줄·12절로 만들었고 §12가
`이 절은 Part 2가 끝나면 채운다`로 비어 있다. **덮어쓰면 안 된다** — 컨트롤러 룰링 14건 표(§6),
"계획·스펙과 실제가 갈린 곳"(§7), "Part 2가 알아야 할 계약"(§10), "미검증 표면"(§11)이 전부 그
안에 있고 **SDD 원장은 이미 삭제돼 저장소에 남은 유일한 사본이다.**

할 일은 셋이다:

1. **§12를 채운다** — Part 2의 단계별 실행과 리뷰, 축 A~E 30건의 판정과 증거, 대조 결과.
2. **제목과 §1의 상태 줄을 Phase 4 전체로 승격한다** — 지금 제목은 `… 결과 (Part 1)`이고
   상태 줄이 "Phase 4는 미완료다"로 시작한다.
3. **§5 "남은 제약"에 둘을 더한다** — (a) 스펙 §6.5가 "이 Phase는 **그 경계를 명시만 한다**"고
   못 박은 것: **supervisor가 실행 중 크래시해 재시작되면 이전 `--once` 자식이 같은 run-id를
   갖는다.** 기동 시 정리로는 안 잡히고 B층은 종료 때만 돈다 — 근본 해소는 job lease token
   (Phase 6)이다. (b) Task 5 Step 6이 확인한 `buildChildPath`의 죽은 코드.

**이관 지시 둘은 이미 끝났으므로 하지 않는다** — Part 1 Task 2의 numba 측정은 §3.4에, 외부 리뷰
기록은 §1과 스펙 §17에 있다. 그리고 **스펙 §17은 4회차가 아니라 8회차까지다**(§17.1~§17.11).
5회차 blocking 5건 중 2건이 6회차에 오진으로 철회된 사실(§17.8·§17.9)과, **8회차가 Part 2 계획을
대상으로 blocking 9건을 낸 사실**(§17.11)이 그 기록에 포함된다.

**P4-C25의 조건부 충족을 닫는다.** Part 1 §4.1은 C25를 "충족(조건)"으로 적었고 그 조건이
**실오디오 전사 1건**인데, 그것이 Part 2의 P4-C5로 넘어왔다. 연결표는 C25를 "Part 1 Task 3·12"로만
적고 그 조건을 기록하지 않는다 — **C5의 판정이 C25의 조건까지 닫는다는 것을 여기서 명시한다.**

- [ ] **Step 6: 로드맵과 운영 문서를 갱신한다**

**`desktop/CLAUDE.md`를 먼저 읽는다.** `197ab7d`가 48줄을 고쳐 목차를 바꿨으므로 이 계획이
쓰일 때의 구성이 아니다(루트 `CLAUDE.md`가 "서브트리를 고치기 전에 그 패키지 문서를 읽으라"를
규약으로 세운 자리다). **Part 2가 뒤집는 줄이 넷이다:**

| 자리 | 지금 (`197ab7d`) | Part 2가 하는 일 |
| --- | --- | --- |
| `:3` | worker·embed가 `uv run` + 저장소 체크아웃 | **Task 5가 뒤집는다** — 번들 python `-m` |
| `:12-24` | 명령·31건·캐시 비용 | `--print-key`와 wk 층 ~130초를 더한다 |
| `:28-52` | "## 번들 — `Resources/` 아래 넷" | `models/`·`hf-token.bin`의 자리를 더한다 |
| `:62` | `process/`의 "uv 런처" | **Task 5가 지운다** |
| `:84` | `config.json` … "앱은 다시 쓰지 않는다(`REPO_ROOT` 저장 제외)" | **Task 4 Step 4가 그 예외를 없앤다** |

그 위에 더할 것: 구조 표(`process/orphans.ts`·`config/token-store.ts`·`windows/token-window.ts`·
`app/reap-on-quit.ts`), 데이터 위치(`models/`·`hf-token.bin`), 디버깅(런타임 자기 보고 줄 읽는 법).

- 로드맵 — 상태 줄, Phase 4 절의 판정표, Phase 5·6 인계.
- **`be/CLAUDE.md`** — `FFMPEG_BIN`·`FFPROBE_BIN`·`LENS_LLM_SERVER_BIN`의 새 의미, `mlx-lm` 편입,
  `DAMWHA_SHARED_STATE`. (`be/worker/CLAUDE.md`는 없다.)
- **`be/worker/SMOKE.md`** — 스모크 절차가 위 env의 새 의미에 걸리면 그쪽도.

- [ ] **Step 7: 브랜치를 마무리한다** — `superpowers:finishing-a-development-branch`

**Verify:** 30건 전부 판정되고 각각 증거가 있다. 미충족이 있으면 **Phase를 미완료로 유지한다**
(로드맵 §6).

**Review:**
- 판정하지 않은 기준이 없는가.
- "통과"에 명령과 출력이 붙어 있는가. **실행 성공을 서명 성공으로 읽지 않았는가.**
- 기준선 대조가 §5의 두 부류를 **구분해서** 했는가.
- `~/.local/bin/mlx_lm.server`가 제자리인가.
- **결과 문서의 기존 11절이 그대로 살아 있는가** — §12만 채웠는가.
- P4-C27의 **판정 범위**(파일과 DB 행의 구간이 다르다)를 적었는가.
- "구현 중 판정할 것" 여덟이 전부 결론과 근거를 얻었는가.

---

## 자체 검토

**1. 스펙 coverage**

| 스펙 | Task |
| --- | --- |
| §6.2 실행 계약 | 3, 4, 5 |
| §6.3 env 주입·위생 | 4 |
| §6.4 HF 토큰 | 6, 11 |
| §6.5 소유·종료 | 2, 5 (`worker-shutdown`), 7, 8 |
| §6.6 ffmpeg·모델 경로 | 1, 9 |
| §6.7 dev 루프 | 4 (`PYTHONPATH`) |
| §6.9 model_readiness·유예 | 9, 10 |
| §6.10 재시도 3층 | 10, 11 |
| §9 완료 기준 30건 | 12 |

(§6.1·§6.1-b·§6.8·§2.4는 Part 1.)

**2. 완료 기준 연결표**

| ID | 만드는 Task | 판정 | 실패 재현 | 비고 |
| --- | --- | --- | --- | --- |
| C1~C3 토큰 게이트·평문·오타 | 6 | 12 | 토큰 파일 삭제 / 잘못된 토큰 | — |
| C4 토큰 교체 반영 | **11** (Step 2) | 11·12 | 미수락 계정 → 수락 계정 | — |
| C5 모델 0에서 완주 | 3·9 | 12 | `models/` 비우기 | — |
| C6 진행 표시 | 9·11 | 12 | — | — |
| C7 끊김·이어받기 | 9·11 | 12 | 네트워크 차단 | **무엇이 참으로 만드는지 구현 중 판정** (1번) |
| C8 403 vs 401 | 9 (Step 8) | 12 | 미수락 계정 토큰 | — |
| C9 재다운로드 없음 | 9 | 12 | — | — |
| C10 bge-m3 한 벌 | 9 (Step 8) | 12 | — | — |
| C11 번들 mlx-lm | Part 1 Task 3·6 + 3 | 12 | 전역 설치 일시 이동 | — |
| C12 번들 런타임 | **2·3** | 12 | — | 다섯 자기 보고: supervisor·`--once`는 2, 프로브는 2(+부모의 stderr 흘리기), embed·`llm_entry`는 3 |
| C13 외부 미참조 | 4·5 | 12 | — | — |
| C14 캐시 재사용 | 4 (`HF_HOME`) | 12 | `.app` 교체 | — |
| C15 번들 위생 | **Part 1 Task 5·6·7** | Part 1 Task 7·12 | — | — |
| C16 저장소 없이 기동 | 4 (Step 4) | 12 | 저장소 일시 이동 | — |
| C17 ⌘Q 정리 | 5 (`worker-shutdown` 그룹 SIGTERM)·8 | 12 | — | **capabilities 프로브는 8이 못 거둔다** — `-m` 토큰도 run-id도 없어 §6.5의 조건 2·4를 못 만족한다. 실제로 거두는 것은 `cleanUnlessOrphans`의 그룹 SIGTERM이고 Task 5 Step 5가 그것을 테스트로 잠근다 |
| C18 고아 정리 | 7 | 12 | `kill -9` main | — |
| C19 부모 선종료 (a·b) | 8 | 8 (통합)·12 | supervisor·`--once` `kill -9` | — |
| C20 자손 SIGKILL | 8 | 12 | `SIG_IGN` fixture | — |
| C21 외부 worker 보존 | 7 | 12 | `pnpm worker` 동시 실행 | — |
| C22 스캔 실패 시 중단 | 7 (Step 2) | 7 (단위) | `ps` 비영·빈 출력 주입 | — |
| C23 dev 반영 | 4 (`PYTHONPATH`) | 12 | — | — |
| C24 웹 회귀 | — | 12 (별도 회차) | — | — |
| C25 mlx 정렬 회귀 | **Part 1 Task 3** | Part 1 Task 3·12 | — | Part 1 §4.1이 **"충족(조건)"**으로 남겼다 — 조건은 실오디오 전사 1건이고 그것이 P4-C5다. **C5의 판정이 이 조건을 닫는다** (Task 12 Step 5) |
| C26·C27 데이터 보존 | **Part 1 Task 1** | 12 | Part 1 Task 1 Step 3이 실증 | **C27의 `app-db-rows` 기준선이 비었다** — Task 12 Step 1이 축 A 전에 그 한 파일만 다시 뜬다. 판정 구간이 파일과 DB에서 다르다 |
| C28 numba | **Part 1 Task 2** | Part 1 Task 2·12 | — | — |
| C29 오프라인 처리 | 9 | 12 | 네트워크 차단 | 같은 판정 (1번) |
| C30 env 재주입 차단 | 4 (Step 2) | 4 (단위)·12 | `config.json`에 `PYTHONHOME` | — |

**단위 테스트로만 판정하는 것**(스펙 §9 비고): C22, `safeStorage` 불가, 복호화 실패, 무진행
제한, `model_readiness` 동시 writer 역전, 훅의 지연 모듈 내성.

**3. 규칙 1 준수** — 이 계획에 실행되지 않은 구현 본문이 없다. `[실행됨]` 표시가 붙은 것 셋:
Task 3 Step 3의 `mlx_lm.server.main()` 사실, Task 3 Step 7의 `--print-key`(2026-09-17, 0.22초,
읽기 전용), Task 9 Step 5의 훅 실측. **검증 명령은 `/usr/bin/grep`·`/usr/bin/find`·`/usr/bin/diff`를
절대 경로로 부른다** — 이 개발 머신의 셸에서 셋 다 함수이고 `grep`은 `ugrep -I`라 바이너리를
건너뛴다(스펙 §17.8 BL-2).

**4. 규칙 2 준수** — 모든 시그니처가 §계약 한 곳에만 있다. Task 안의 테스트는 그것을 참조한다.
**2026-09-17 정정:** 초안은 이 줄이 거짓이었다 — `managed_llm_server`가 계약 절 없이 Task 3
Step 1·4 본문에 두 번 적혀 있었고 Task 10 Step 3이 `_wait_ready`의 시그니처를 또 바꿨다.
둘의 최종 모양을 계약 절에 옮기고 Task 3·10이 참조하게 했다. `restartService`도 계약의 모양이
코드(`supervisor.ts:561`)와 안 맞아 `Supervisor` 메서드로 고쳤다.

**5. 순서**

- **Part 1이 끝나야 시작한다.** 그 계획의 완료 조건 셋이 전제다.
- 1(ffmpeg env) → 2(run-id) → 3(llm_entry) — worker 쪽이 먼저다. Task 3이 Task 2의
  `run_id_arg`를 쓴다.
- 4(경로·env) → 5(런처·어댑터) — 5가 4의 `bins`·`runId`를 쓴다.
- 6(토큰) → 7(고아) → 8(B층) — 7이 4의 `trees`를, 8이 7의 판독을 쓴다.
- 9(model_readiness) → 10(유예·재시작) → 11(화면) — 각각 앞의 것을 읽는다.
- **11이 6에서 옮겨 온 토큰 교체를 갖는다** — 10의 `restartService`를 쓰기 때문이다. 번호와
  실행 순서가 일치한다.
- 12(검증)가 마지막.
- **모든 Task가 `test`·`lint` 통과 상태로 끝난다.**

---

## 구현 중 판정할 것 — 여덟

**고치는 것이 아니라 판정할 것이다.** 문서만 읽어서는 참·거짓을 정할 수 없어, 그 자리에 도달한
실행자가 **판정하고 결과를 기록한다.** 판정 결과는 Task 12 Step 5의 결과 문서에 근거와 함께
남긴다. **"아마 될 것이다"로 넘기지 않는다.**

**1~6은 8회차 검증(스펙 §17.11)의 "확인 필요" 여섯 그대로다.** 7·8은 같은 이유로 여기 옮긴
important 1건(I-14)과 minor 1건(M-5)이다.

| # | 판정할 것 | 언제 | 아니었을 때 |
| --- | --- | --- | --- |
| 1 | **P4-C7(이어받기)·P4-C29(오프라인)를 무엇이 참으로 만드는가.** 둘 다 연결표에서 Task 9에 걸려 있으나 Task 9의 Step은 진행 훅·`model_readiness`·리비전 고정뿐이다. 실제 근거는 `huggingface_hub`의 `.incomplete` 재개와 캐시 폴백(라이브러리 기본 동작)으로 **보인다.** 확인할 것 둘 — (a) 훅으로 `tqdm_class`를 갈아 끼우는 것이 hub의 resume 경로에 영향이 없는가, (b) `HF_HUB_OFFLINE` 없이도 네트워크 단절 시 캐시 폴백이 도는가 | **Task 9 Step 6** (훅 테스트와 같은 자리) | 둘 중 하나라도 아니면 **그것을 만드는 Task가 필요하다** — Task 12에서 발견하면 늦다 |
| 2 | **Task 9 Step 5의 "`sys.modules` 92개 모듈이 `ModuleNotFoundError`" 주장.** `[실행됨]`이 붙어 있고 근거(transformers의 지연 모듈 `__getattr__`)도 그럴듯하나 8회차가 **재현하지 않았다.** | **Task 9 Step 5** 착수 시 1분 | 처방(`vars(mod).get(name)`)은 어느 쪽이든 안전한 방향이라 **구현은 안 바뀐다.** 숫자만 정정한다 |
| 3 | **`/tmp/p4-baseline`의 수명.** Task 12 Step 1의 유일한 게이트인데 macOS `/private/tmp`는 재부팅에 날아간다. 기준선은 2026-09-16에 찍혔고 Part 2는 12 Task 분량이다 | **Task 1 착수 전** | `P4_BASELINE_DIR`(`phase4-baseline.sh:23`)로 영구 위치를 쓰거나 지금 통째로 복사한다. **날아가면 P4-C26·C27을 판정할 수 없고 되돌릴 방법이 없다** |
| 4 | **P4-C25의 조건부 충족을 P4-C5가 닫는가.** Part 1 §4.1이 C25를 "충족(조건)"으로 남겼고 그 조건이 실오디오 전사 1건이다. 연결표는 그 조건을 기록하지 않았다 | **Task 12 Step 3** (축 B) | C5가 통과해도 C25의 조건이 안 닫히는 경우가 있으면 별도 회차가 필요하다 |
| 5 | **검증 전 기준선의 유효성.** Step 4가 대조하는 `app-storage.txt`는 2026-09-17 이전 값이다. Part 1이 `.app`을 실행하지 않아 지금은 유효하지만 **그 전제를 확인하는 절차가 없었다** | **Task 12 Step 1** | 움직였으면 어디서 움직였는지를 먼저 밝힌다 — 그것 없이 대조하면 P4-C27이 거짓 통과·거짓 실패 둘 다 낼 수 있다 |
| 6 | **Task 12 Step 2의 되돌릴 수 없는 삭제.** `<userData>/models` 비우기와 `hf-token.bin` 삭제. 스펙 §5가 허용하므로 계약 위반은 아니나 로드맵 §3의 "위험한 변경에는 실패 시 복구 방법을 포함한다"를 만족하지 않는다 | **Task 12 Step 2** (게이트 4번) | 모델은 재다운로드로 복구된다(시간만). **토큰은 사용자만 다시 낼 수 있다** — 지우기 전에 확인한다 |
| 7 | **`desktop/CLAUDE.md`의 갱신 범위** (8회차 I-14). `197ab7d`가 48줄을 고쳐 목차를 바꿨다. Task 12 Step 6의 표가 그 다섯 자리를 짚지만, Part 2가 실제로 만든 것과 대조해야 최종 목록이 나온다 | **Task 12 Step 6** | — |
| 8 | **`PythonBinaries.sitePackages`의 소비자** (8회차 M-5). 계약에 있으나 이 계획에서 그것을 쓰는 자리가 Task 12 Step 3의 P4-C12 판정 하나뿐이다 | **Task 4 Step 1** | 쓰는 데가 정말 없으면 계약에서 뺀다 — 안 쓰는 필드를 남기면 다음 사람이 그것의 의미를 추측한다 |
