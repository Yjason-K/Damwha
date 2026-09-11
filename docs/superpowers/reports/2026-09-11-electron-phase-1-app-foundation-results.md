# Electron Phase 1 — 앱 기반 실행 결과

작성 시작: 2026-09-11
브랜치: `feat/electron-migration-phase-1-app-foundation`
브랜치 분기점: `a4f3a99` (`dev`)
스펙: [2026-09-11-electron-phase-1-app-foundation-design.md](../specs/2026-09-11-electron-phase-1-app-foundation-design.md)
계획: [2026-09-11-electron-phase-1-app-foundation.md](../plans/2026-09-11-electron-phase-1-app-foundation.md)

**상태 (2026-09-11): 스펙 리뷰·계획 검증 통과. 구현 착수 전.**

## 스펙 리뷰

| 회차 | 대상 버전 | 검토자 | 지적 | 조치 | 통과 |
| --- | --- | --- | --- | --- | --- |
| 1 | 초안 (미커밋) | 메인 세션 (자체 검토) | 4건 — 준비 판정을 `/api/health` 하나로 둔 오류, P1-C8의 실패 유발 경로가 P1-C7과 동일, `pnpm deploy` 호출 형식과 Experimental 상태 누락, P1-C11의 "심볼릭 링크 0개"가 과한 기준 | 전건 반영 후 `bc33b7f`로 커밋 | 통과 |
| 2 | `bc33b7f` | Codex (`codex:rescue`) | F-1 ~ F-10 (차단 5, 비차단 5). 판정 NEEDS CHANGES | F-1·F-2·F-3·F-4·F-5·F-6·F-7·F-8 반영, F-9 부분 반영, F-10 확인만 | 통과 |

리뷰어에게는 스펙·로드맵·Phase 0 결과 문서와 코드만 주었고 설계 대화를 주지 않았다 (로드맵 "리뷰어는 구현 대화를 받지 않고 diff·스펙·계획·검증 증거만으로 판단한다").

### 1회차 지적 상세 — 메인 세션 자체 검토

| ID | 지적 | 조치 |
| --- | --- | --- |
| S-1 | 준비 판정을 `GET /api/health` 하나로 뒀으나, `be/src/database/database.service.ts:34`가 fail-fast라 DB 미기동 시 API가 listen하지 않는다. 503은 기동 시점에 관찰되지 않는다 | 판정 신호를 health + 자식의 종료 코드·stderr 둘로 고쳤다. `maskUrl`이 비밀번호를 가리므로 `database unreachable at …` 원문을 화면에 올려도 된다는 근거를 함께 적었다 |
| S-2 | P1-C8이 잘못된 `DATABASE_URL`로 기동 실패를 유발해 P1-C7과 같은 경로를 밟는다 | 카탈로그 밖 `SUMMARY_LLM_MODEL`로 바꿨다. zod 단계에서 죽어 문안이 달라지므로 main이 고정 문구가 아니라 실제 stderr를 올린다는 것을 판정한다 |
| S-3 | `pnpm deploy` 호출 형식이 문서와 다르고(`pnpm --filter=<pkg> deploy <dir>`), pnpm 10.26.0에서 Experimental이라는 사실이 빠졌다 | 형식을 바로잡고 `--legacy`·`--config.node-linker=hoisted` 대안을 적었다. R1-9로 등재 |
| S-4 | P1-C11의 "심볼릭 링크 0개"가 과하다. `node_modules/.bin`처럼 트리 안을 가리키는 링크는 재배치를 깨지 않는다 | 기준을 "트리 밖을 가리키는 링크 0건"으로 바꿨다 |

### 2회차 지적 상세 — Codex

| ID | 차단 | 지적 | 조치 |
| --- | --- | --- | --- |
| F-1 | 차단 | 기본 `config.json`은 API의 `STORAGE_ROOT`를 `<userData>/storage`로 두는데 worker의 기본값은 `be/storage`다. 기본 설정으로 실행하면 worker가 파일을 못 찾아 처리가 실패한다. 스펙은 검증 때만 수동으로 맞추라고 적었다 | **사용자에게 방향을 확인해 worker를 앱 값에 맞추기로 결정.** 기본값 `<userData>/storage`를 유지하고 선행 조건 3번을 "`be/worker/.env`의 `STORAGE_ROOT`를 앱 값과 같은 절대 경로로" 로 고쳤다. §6.3에 방향 선택의 근거 3개와 대가(기존 회의 오디오 404, Phase 5에서 해소)를 적었다. 검증은 기본값으로 수행한다 |
| F-2 | 차단 | 오류 셸이 "재시도"를 제공해야 하는데 preload가 없어 렌더러에서 main을 부를 IPC 경로가 없다. 구현자가 임의로 해석하게 된다 | §6.5에 재시도 소유자를 main으로 고정했다. 자동 재시도(백오프) + 애플리케이션 메뉴 항목 — 메뉴는 main 소유라 IPC가 필요 없다. 셸은 표시만 한다. "렌더러→main 경로를 새로 만들지 않는다"를 계약으로 명시 |
| F-3 | 차단 | 루트 `dev`가 `pnpm --parallel --recursive run dev`라 `desktop`에 `dev` 스크립트를 두면 `pnpm dev`가 Electron을 띄운다. "기존 웹 흐름과 공존"이 그 자리에서 깨진다 | §6.1에 스크립트 이름 표를 넣었다. `start:desktop`·`package:desktop`은 recursive에 참여하지 않고 루트가 `--filter`로만 부른다. `lint`·`test`는 참여한다. `build`도 같은 문제라는 것을 함께 적었다. P1-C13의 판정에 추가 |
| F-4 | 차단 | 로드맵이 "정상 종료와 자식 프로세스 정리"와 "자식 프로세스가 종료 후 남지 않음"을 Phase 2 범위·완료 기준에 두는데 스펙이 Phase 1에서 구현·판정한다. Phase 경계가 이중 정의다 | §6.2에 경계 표를 넣고, **로드맵을 갱신했다** — Phase 1 범위에 "앱이 만든 자식(API 하나)의 종료 정리"를 명시하고, Phase 2의 해당 항목을 "Phase 1이 세운 절차를 전체 서비스로 확장"으로 다시 썼다. 근거: 자식을 만들면서 정리를 미루면 Phase 1 산출물이 프로세스를 흘린다 |
| F-5 | 차단 | 기존 `be/storage`를 덮어쓰지 않는다는 데이터 안전 규칙에 검증 기준이 없다. P1-C2는 새 업로드 성공만, P1-C12는 `.app` 내부 쓰기만 본다 | **P1-C14 신설.** 앱 실행 전후 `be/storage` 파일 목록·체크섬 전량 비교, 기존 `meeting`·`utterance` 행 수 비교, compose `name`·`damwha_pgdata` 볼륨 비교, `_migrations` 행 수 비교. §5에 "각 규칙은 P1-C14가 실측으로 판정한다"를 명시 |
| F-6 | 비차단 | dotenv 서술은 정확하나 자식의 `cwd`와 entrypoint가 확정되지 않아 어느 `.env`가 읽히는지가 구현자 판단에 남는다 | §6.3에 dev·packaged 각각의 entrypoint·cwd·읽히는 `.env`·값의 출처·로그 위치를 표로 고정했다 |
| F-7 | 비차단 | "`001_init.sql`은 `original_filename`만 저장한다"가 사실과 다르다. `meeting`은 `audio_key`(`NOT NULL`)와 `normalized_key`도 저장한다 | 확인 결과 지적이 맞다(`001_init.sql:39-40`). 서술을 "DB는 상대 storage key를 저장하고 API·worker가 각자 root에서 해석한다"로 바로잡고, 스키마가 `CHECK`로 강제하지 않으므로 **상대 키만 저장한다는 것은 서비스 계약**임을 명시했다 |
| F-8 | 비차단 | 포트 탐색과 자식 bind 사이 경쟁 조건이 있고, 같은 포트의 외부 API를 자기 것과 구별하는 규칙이 없다 | §6.4를 다시 썼다. 판정을 자식의 bind 결과로 바꿨다 — 고정 포트로 기동 → `EADDRINUSE`면 다음 후보로 재기동 → 상한 N. 소유권은 자식 프로세스 핸들과 pid로만 판정하고 "그 포트에 응답이 있다"를 준비 신호로 쓰지 않는다. R1-10·R1-11 등재, P1-C10 판정 강화 |
| F-9 | 비차단 (부분 수용) | `HOST=127.0.0.1`은 LAN 노출을 막지만 API가 무제한 CORS를 켠다. 위협 모델이 정의되지 않았다 | **Phase 1에서 고치지 않는다.** 남은 위협은 같은 머신의 다른 프로세스이고 그것은 CORS 정책으로 막히지 않는다(CORS는 브라우저의 규칙이고 API에 인증이 없다). 데스크톱이 되면서 새로 생기는 노출이 아니다. §6.6에 알려진 제약으로 적고 §15에서 Phase 6 배포 보안 검토로 인계했다 |
| F-10 | 비차단 | 코드 주장 6건(dotenv import 순서, fail-fast, 상대 key, `HOST` 기본값, SPA 폴백, 브라우저 `getUserMedia`)은 확인 결과 정확 | 변경 없음. 계획에서 각 주장을 검증 항목으로 연결한다 |

### 2회차 이후 스펙 상태

- 신설 완료 기준: P1-C14 (기존 데이터 보존).
- 신설 위험: R1-9 (`pnpm deploy` Experimental), R1-10 (`EADDRINUSE` 구분 실패), R1-11 (외부 API 오인).
- 로드맵 변경 3곳: Phase 1 범위에 자식 정리 추가, Phase 2 범위·완료 기준의 해당 항목을 확장으로 재서술, Phase 1 상태 기록.

### 3회차 — 계획 검증 중 드러난 스펙 수정

| ID | 지적 | 조치 |
| --- | --- | --- |
| F-11 | §5의 "쓰기가 필요한 모든 경로는 `<userData>` 아래"가 §6.3이 허용하는 `config.json` 오버라이드와 모순된다. Task 4의 테스트는 절대 `STORAGE_ROOT`를 그대로 수용하도록 의도적으로 쓰여 있다 | §5에 문단을 추가해 구분했다 — `.app` 번들 내부 무쓰기는 절대 규칙, "`<userData>` 아래"는 **기본 설정의 성질**이며 사람이 `config.json`으로 열 수 있다. P1-C14는 기본 설정 상태를 판정한다 |

## 계획 검증

| 회차 | 대상 버전 | 검토자 | 지적 | 조치 | 통과 |
| --- | --- | --- | --- | --- | --- |
| 1 | 초안 (미커밋) | 메인 세션 (자체 검토) | 4건 — `be` 스펙 파일 위치가 `be/jest.config.js`의 관례와 다름, pnpm isolated linker에서 `electron` 경로, `defaults read`가 `.app` plist에서 불안정, `pnpm desktop exec`가 `run exec`로 풀림 | 전건 반영 후 `27fa1cb`로 커밋 | 통과 |
| 2 | `27fa1cb` | Codex (`codex:rescue`) | V-1 ~ V-14 (차단 12, 비차단 2). 판정 NEEDS CHANGES | V-1~V-12 반영, V-13은 스펙 수정으로 처리(F-11), V-14는 확인만 | 통과 |

### 1회차 지적 상세 — 메인 세션 자체 검토

| ID | 지적 | 조치 |
| --- | --- | --- |
| P-1 | 계획이 `be/test/config/env.spec.ts`를 만들라고 하지만 기존 스펙은 전부 `be/test/` 바로 아래 평평하게 있고 `jest.config.js`의 `roots`가 그 구조를 전제한다 | `be/test/env.spec.ts`로 고치고 관례를 계획에 명시 |
| P-2 | `node_modules/electron/dist/Electron.app` 확인 경로가 pnpm isolated linker와 맞지 않는다 | `desktop/node_modules/electron/...`으로 고침 |
| P-3 | `defaults read <경로>/Info.plist <키>`는 `.app` 안의 plist에서 신뢰할 수 없다 | `plutil -extract ... raw -o -`로 교체 |
| P-4 | `pnpm desktop exec node …`는 `pnpm --filter … run exec`로 풀려 실패한다 | `pnpm --filter damwha-desktop exec`로 고침 |

### 2회차 지적 상세 — Codex

| ID | 차단 | 지적 | 조치 |
| --- | --- | --- | --- |
| V-1 | 차단 | `waitForReady()`가 deadline을 `probe()` 반환 뒤에만 검사한다. 소켓은 붙었는데 응답이 없어 `fetch`가 영원히 매달리면 30초 타임아웃에 **도달하지 못한다.** 테스트도 그 경로를 시험하지 않는다 | `PROBE_TIMEOUT_MS`(2초)를 도입해 `probeHealth`에 `AbortController` + race를 넣고, `waitForReady`도 probe를 상한과 경주시켰다. 경주에 주입된 `sleep`을 쓰면 테스트의 가짜 시계를 밀어 버리므로 실제 타이머(`noResponseAfter`)를 따로 뒀다. "probe가 끝나지 않아도 타임아웃" 테스트 2건 추가 |
| V-2 | 차단 | `launchDev`가 `process.kill(-pid)`를 쓰지만 `spawn`에 `detached: true`가 없어 음수 pid가 프로세스 그룹을 가리키지 못한다. catch로 떨어져 pnpm만 죽고 `nest`가 만든 손자 API가 남는다. 계획도 "남으면 추가한다"고만 적어 붙여 쓸 코드가 틀렸다 | `detached: true`를 필수 옵션으로 코드에 넣고, 검증 단계를 "이미 들어 있는 전제가 성립하는지 잰다"로 바꿨다. `launchVite`도 같이 고쳤다 |
| V-3 | 차단 | `start()` 호출이 직렬화·무효화되지 않는다. 메뉴 재시도와 자동 재시도가 겹치면 한 호출이 다른 호출의 전역 `api`를 죽이고도 이전 호출이 계속 그것을 관찰해 잘못된 `apiOrigin`, 중복 자식, 잘못된 실패 화면이 가능하다 | `generation` 세대 번호와 `start()` 직렬화를 넣었다. `attempt()`가 전역 `api`가 아니라 자기 호출의 local handle만 관찰하도록 반환 타입을 `AttemptOutcome`으로 바꿨다. 뒤처진 세대는 자기 자식을 치우고 물러난다. 겹친 재시도에서 자식이 하나인지 재는 검증 단계 추가 |
| V-4 | 차단 | Task 10의 dev 경로가 `http://localhost:5173`을 로드하지만 Vite 기동은 Task 11에서 붙는다. Task 10의 "담화 화면까지" Verify는 독립 실행으로 통과할 수 없어 개별 리뷰가 불가능하다 | Task 10의 검증 범위를 "API가 ready가 되고 로그에 listening이 찍히는 것"까지로 좁히고, Vite가 없어 연결 실패 화면이 뜨는 것이 정상임을 명시했다. 담화 화면 완주는 Task 11이 검증한다 |
| V-5 | 차단 | ready 뒤 API가 죽는 경우를 관찰하는 코드가 없다. `ApiHandle`이 exit 구독을 제공하지 않고 main도 구독하지 않는다. 스펙 §8이 사망 알림을 요구하는데 매핑표에도 빠졌다 | `ApiHandle.onExit`를 추가했다(이미 죽은 뒤 등록해도 즉시 호출 — 등록과 종료의 경쟁 제거). main에 `watchForDeath`를 넣어 자기 세대의 자식이 죽으면 화면에 알리고 재시도를 건다. ready 이후 자식을 죽여 보는 검증 단계와, 스펙 §8 전체를 Task에 매핑한 표를 추가했다 |
| V-6 | 차단 | `check-bundle.mjs`가 `grep` 실패를 이유와 무관하게 "매치 없음"으로 처리한다. 권한·I/O 오류도 번들 위생 통과로 위장된다 | `spawnSync`로 바꿔 status 1만 "매치 없음"으로 허용하고, 그 밖의 status와 `error`는 검사 실패로 기록한다 |
| V-7 | 차단 | 심볼릭 링크 탈출 판정이 `target.startsWith(realApi)`라 `/…/api`와 `/…/api-escaped`를 구별하지 못한다 | `path.relative`로 경로 관계를 판정한다 |
| V-8 | 차단 | P1-C10 검증 순서가 성립하지 않는다. 앱이 이미 3000을 쥔 상태에서 외부 API를 띄우려 하고, 이어지는 `open`은 single-instance 처리로 기존 창만 포커스한다. 스펙은 `pnpm dev` 점유를 말하는데 계획은 `pnpm be:dev`로 바꿨다 | 순서를 다시 썼다 — 앱 완전 종료 → `pnpm dev` 기동 및 health 확인 → 외부 pid 기록 → `.app` 실행 → 앱 pid·포트 기록 → 앱 종료 → 외부 API 생존 확인 → 외부만 정리. 점유 주체를 스펙대로 `pnpm dev`로 되돌렸다 |
| V-9 | 차단 | P1-C8이 앱이 떠 있는 상태에서 `config.json`을 고치고 `open`한다. single-instance lock 때문에 새 자식이 뜨지 않아 바꾼 값을 읽지 않으며 zod 기동 실패가 검증되지 않는다 | 설정 변경 전 앱 종료와 자식 무잔존 확인을 선행 조건으로 넣고, 검증 뒤 키 삭제와 정상 재기동까지 포함했다 |
| V-10 | 차단 | (a) `.app` 쓰기 검증이 `-newer Info.plist`라 빌드 시점에 이미 새로운 파일을 오탐하고 오래된 파일의 수정을 놓친다. (b) P1-C14의 DB 비교가 `diff`인데 기대값은 `meeting`·`utterance` 증가를 허용한다고 적어, 정상 동작에서 반드시 실패한다 | (a) 실행 전후 체크섬 manifest 비교로 바꿨다. (b) 세 항목의 판정 규칙을 분리했다 — `be/storage`·compose는 완전 동일, `_migrations`는 동일, `meeting`·`utterance`는 `after >= before`. 판정 스크립트를 계획에 넣었다 |
| V-11 | 차단 | P1-C14가 "앱을 처음 실행하기 전" 스냅샷을 요구하지만 Task 12 Step 5가 이미 `.app`을 실행한 뒤 Task 13이 스냅샷을 뜬다. 기준선이 아무것도 증명하지 못한다 | 기준선을 **Task 1 Step 11**로 옮겼다 — 그 Task의 빈 창은 API를 띄우지 않아 쓰기가 없는 마지막 시점이다. `/tmp`가 아니라 `~/.cache/damwha-p1-evidence/`에 두고 채취 시각을 함께 기록한다. Task 13 Step 1은 기준선의 유효성만 확인하고, 없으면 P1-C14를 **미판정**으로 적는다 |
| V-12 | 차단 | `be/worker/.env`의 `STORAGE_ROOT`를 바꾼 뒤 worker를 띄우면 기존 `be/storage`를 가리키는 queued/running job이 파일을 못 찾아 `failed`로 기록된다. 계획에 큐 확인도 백업·복구 절차도 없다 | Task 13 Step 2를 신설했다 — 원본을 `worker.env.backup`으로 보관, worker 정지, `job`의 queued/running이 0인지 확인(있으면 진행 금지), 그 뒤 경로 변경. Step 14에 되돌림 결정과 양쪽 한계를 기록하는 절차를 넣었다 |
| V-13 | 비차단 | `config.json`의 절대 `STORAGE_ROOT`를 무조건 수용하므로 `<userData>` 밖으로도 쓴다. 스펙 §5의 문장과 충돌하지만 §6.3은 그 오버라이드를 명시적으로 허용한다 | **스펙 수정으로 처리**(위 F-11). 계획의 코드와 테스트는 그대로 두었다 — 의도된 동작이다 |
| V-14 | 비차단 | `utilityProcess.fork`의 `cwd`·`env`·`stdio`, `loadFile`의 `query`, permission-check handler의 세 번째 인자, menu roles, `@electron/asar.listPackage`, `mac.extendInfo`·`extraResources`·`mac.target: dir`, `pnpm --filter=… --prod deploy <dir>` 인자 순서가 모두 실제와 일치 | 변경 없음. `utilityProcess`가 `app.whenReady()` 뒤에만 호출 가능하다는 점을 `launchPackaged`의 주석으로 남겼다 |

## 단계별 실행·리뷰

### Task 2 — API 실행 경로 실측

R1-1(`utilityProcess`로 NestJS가 뜨는가)과 R1-2·R1-9(`pnpm deploy` 트리가 실행 가능한가)를 실측했다. Postgres는 OrbStack의 `damwha-postgres` 컨테이너로 이미 떠 있었다(`pnpm db:up` 불필요).

| 항목 | 실측 결과 |
| --- | --- |
| `pnpm deploy` 형태 (옵션 없음) | `pnpm --filter=damwha-be --prod deploy desktop/build/api` → `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`. pnpm 10.26.0은 `inject-workspace-packages=true`가 없는 워크스페이스의 배포를 기본 거부한다 |
| `pnpm deploy` 형태 (`--legacy`) | 트리 생성에는 성공하지만 `dist/` 디렉터리가 통째로 빠진다 |
| `pnpm deploy` 형태 (`--config.inject-workspace-packages=true`, non-legacy) | 워크스페이스 주입 오류는 사라지지만 같은 이유로 `dist/`가 여전히 빠진다 |
| 원인 확인 | `be/.gitignore`에 `dist/`가 있고 `be/package.json`에 `"files"` 허용 목록이 없다. pnpm deploy는 legacy·non-legacy 관계없이 `pnpm pack`과 같은 파일 선택 규칙(`.gitignore` 기반)을 쓰므로 gitignore된 `dist/`를 배포 트리에서 제외한다. `pnpm pack --pack-destination /tmp` 후 tarball 안 `package/dist/` 항목 수를 세어(`grep -c`) 0건임을 직접 확인해 검증했다 |
| 측정을 위해 취한 조치 | `be/.gitignore`의 `dist/` 줄을 측정 동안만 주석 처리하고 `pnpm --filter=damwha-be --prod --config.inject-workspace-packages=true deploy desktop/build/api`를 재실행해 `dist/main.js`가 포함된 완전한 트리를 얻었다. 측정 직후 `git checkout -- be/.gitignore`로 원복했고 `git status`로 무변경을 확인했다 — 이 파일은 커밋에 포함되지 않는다 |
| 심볼릭 링크 탈출 건수 | 트리 내 심볼릭 링크 379개 중 트리 밖을 가리키는 것 **0건** (`find desktop/build/api -type l -exec … readlink -f …` 후 트리 절대경로로 grep → "트리 밖을 가리키는 링크 없음"). `node-linker=hoisted`·`--legacy` 대안은 이 목적으로는 불필요했다 |
| `@damwha/contracts` 빌드 산출물 | `node_modules/@damwha/contracts/dist/{cjs,esm}` 둘 다 실재 |
| `node dist/main.js` 헬스체크 | `PORT=53001 HOST=127.0.0.1 DATABASE_URL=… STORAGE_ROOT="$HOME/Library/Application Support/Damwha/storage" node dist/main.js` 기동 후 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:53001/api/health` → **200**, 응답 본문 `{"status":"ok","db":"ok"}`. `SIGTERM`으로 정상 종료 확인 |
| `utilityProcess.fork` 헬스체크 | 브리핑 원문 그대로 `desktop/src/probe-main.ts`를 만들어 `pnpm --filter damwha-desktop run compile` 후 `npx electron dist/probe-main.js` 실행 → `[probe] health: 200`, `[probe] child pid: 52119`, `[probe] api exited: 0`. Step 5의 `ELECTRON_RUN_AS_NODE` + `spawn` 대체안은 필요 없었다 |

**결정 1 — 자식 API 기동 수단**: `utilityProcess.fork`. 15초 타임아웃 안에 헬스체크 200과 자식 pid(52119)를 받았고 대체안이 필요 없었다.

**결정 2 — `pnpm deploy` 호출 형태**: `pnpm --filter=damwha-be --prod --config.inject-workspace-packages=true deploy desktop/build/api` (legacy 아님, node-linker는 기본값 유지 — 심볼릭 링크가 이미 트리 안에서 완결되므로 hoisted로 바꿀 필요가 없다). 다만 이 호출이 그대로 동작하려면 선행 조건이 하나 더 있다: **`be/package.json`에 `dist`를 포함하는 `"files"` 허용 목록을 추가해야 한다.** 그렇지 않으면 `be/.gitignore`의 `dist/` 때문에 pnpm이 빌드 산출물 자체를 배포 트리에서 제외한다 — 이는 브리핑이 예상한 "트리 밖 심볼릭 링크" 문제와는 별개로 이번 실측에서 새로 드러난 차단 요인이다. 이 Task는 측정 스파이크이므로 `be/package.json`을 영구 수정하지 않았다(측정 동안 `be/.gitignore`만 일시 수정했다가 되돌렸다) — Task 6·Task 10 중 실제 배포 절차를 배선하는 쪽이 `be/package.json`에 `"files": ["dist", …]` (또는 동등한 수단)을 추가해야 이 호출이 그대로 성립한다.

## 최종 검증

미실시.

## 남은 제약·후속 Phase 인계

스펙 §15가 현재 상태를 담는다. 구현이 끝나면 실제 결과로 갱신한다.
