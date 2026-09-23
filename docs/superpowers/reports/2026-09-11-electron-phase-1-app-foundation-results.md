# Electron Phase 1 — 앱 기반 실행 결과

작성 시작: 2026-09-11
브랜치: `feat/electron-migration-phase-1-app-foundation`
브랜치 분기점: `a4f3a99` (`dev`)
스펙: [2026-09-11-electron-phase-1-app-foundation-design.md](../specs/2026-09-11-electron-phase-1-app-foundation-design.md)
계획: [2026-09-11-electron-phase-1-app-foundation.md](../plans/2026-09-11-electron-phase-1-app-foundation.md)

**상태 (2026-09-11): 구현 12개 Task 완료, 통합 검증 완료, 수정 회차 3번 완료.**
완료 기준 14건 **전부 충족**. 통합 검증 시점(`fc65f11`)에는 2건이 부분 미충족이었고
(P1-C8 실패 원인 문안, P1-C10 포트 폴백의 외부 API 오인) 그때는 Phase 2로 넘길
계획이었으나, 같은 브랜치에서 `d8f2af1`·`8dcd08e`가 **둘 다 닫았다.** 이 문서는 그
뒤의 상태로 다시 썼다 — 아래 "수정 회차"와 "판정 표"의 측정 빌드 표기를 함께 읽어야
어느 판정이 어느 빌드에서 나온 것인지 알 수 있다.

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

계획 실행은 superpowers SDD 원장(`.superpowers/sdd/2026-09-11-electron-phase-1-app-foundation/progress.md`)이
Task마다 구현·리뷰·수정 라운드를 기록했다. 아래는 그 원장을 커밋 범위로 압축한 것이다.
리뷰어는 각 Task의 diff와 스펙·계획만 받았고 구현 대화를 받지 않았다.

| Task | 커밋 범위 | 리뷰 지적 | 조치 | 통과 |
| --- | --- | --- | --- | --- |
| 1 데스크톱 패키지·빈 창 | `2d47232..8a5bfd8` | 1건 — 조건 미충족인데 추가된 루트 `pnpm.onlyBuiltDependencies: ["electron"]` | 되돌림(`8a5bfd8`) | 통과 (minor 2건 보류) |
| 2 API 실행 경로 실측 | `8a5bfd8..2dc4282` | 1건 — 표가 Step 순서가 아니라 주제별 | 보류(외형) | 통과 |
| 3 `be` 바인드 host | `46aed65..d5e5c55` | 1건 — TDD-red가 ts-jest 암묵 타입검사에 의존 | 보류 | 통과 |
| 4~7 config·port·readiness·origin (일괄) | `d5e5c55..9115eaf` | 3건 — `noResponseAfter` 타이머 미해제, 테스트 이름과 단언 불일치, 중복 분기 커버리지 | 전부 보류(무해) | 통과 |
| 8 자식 API 기동·정리 | `9115eaf..f9ea2f2` | 2건 차단 — 두 런처 모두 `child.on("error")` 없음(spawn 실패가 main을 죽인다), 로그 WriteStream `error` 미처리 + `close()` 비멱등 | 같은 라운드에서 수정(`f9ea2f2`) | 통과 (minor 2건 보류) |
| 9 셸 화면·권한·메뉴 | `dc37854..0f18ee8` | 3건 — ANSI escape 잔존, 상태 조회 fallback, 권한 핸들러 주석. 추가로 **"두 권한 핸들러의 origin 도출 경로가 다르다"는 Minor를 보류** | 앞 3건 수정(`0f18ee8`), Minor 보류 | 통과 — **이 보류가 이 Phase의 마지막 차단 요인이 됐다** |
| 10 main 배선 | `0f18ee8..f2266e8` | 3건 — `inFlight` 추적 누락(준비 전 종료 시 자식 유출), `loadURL` 실패 미처리, DB 미기동 화면 도달 실패 | 전부 수정(`f2266e8`) | 통과 (minor 3건 보류) |
| 11 dev Vite 기동·API 주소 주입 | `e9678d2..a9f4f85` | 2건 — dev에서 포트 폴백·DB 화면에 닿지 못함, `vite-process.ts`에도 `child.on("error")` 없음 | 2라운드 수정(`7f6d9ef`, `a9f4f85`) | 통과 (parked 1, minor 1) |
| 12 패키징·번들 위생 | `a9f4f85..165dd75` | 1건 차단 — electron-builder가 `target: dir` + 서명 설정 없음이면 재서명하지 않아 번들이 Electron 프리빌트의 서명을 그대로 갖는다 | ad-hoc 재서명 + 위생 검사 2개 추가(`165dd75`) | 통과 (minor 1건 보류) |
| 9 (2차 수정) 권한 조회 핸들러 | `165dd75..75a19f8` | P1-C3 차단 — `permissions.query`가 항상 `denied` | `requestingOrigin`을 `isAllowedOrigin`으로 정규화(`75a19f8`) | 통과 |

Task 11은 구현자가 두 번 커밋 없이 멈췄다(끝나지 않는 명령을 띄우고 턴을 종료). 세 번째
구현자의 결과를 채택했고, 그 과정에서 컨트롤러가 이전 구현자의 포트 점유 픽스처를
"고아 프로세스"로 오인해 죽였다. 이후 규칙: **다른 에이전트의 프로세스를 알리지 않고 죽이지 않는다.**

### Task 9의 보류가 만든 교훈

Task 9 리뷰어의 Minor — "두 권한 핸들러가 origin을 서로 다른 경로로 도출하며 공통
정규화를 거치지 않는다" — 를 "프레임이 하나뿐이라 저위험"으로 판단해 보류했다. 위험은
프레임 수가 아니라 **문자열 정규화**였다. 실측하니 `requestingOrigin`은
`"http://localhost:5173/"`처럼 끝에 슬래시가 붙어 오는데 `allowedOrigins()`는 슬래시 없는
origin을 담고 있어, 원문 `.includes()` 비교는 영원히 거짓이었다. `getUserMedia`는
`setPermissionRequestHandler`(origin을 `contents.getURL()`에서 뽑는다)를 타서 성공하는데
`permissions.query`만 거부되는 불일치가 여기서 났고, 렌더러는 조회 결과만 보고
"마이크 권한이 거부돼 있어요"를 그려 **macOS에 묻지도 않았다.** P1-C3이 마지막까지 막힌
진짜 원인이 이것이다.

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

수행일 2026-09-11. P1-C1 ~ P1-C4는 GUI·실제 마이크·실제 파일이 필요해 **사용자가 직접**
패키징된 앱에서 수행했고, P1-C5 ~ P1-C14는 에이전트가 같은 `.app`
(`desktop/out/mac-arm64/Damwha.app`, `75a19f8` 이후 빌드)에 대해 수행했다. 에이전트에는
GUI가 없으므로 화면 도달은 두 대체 수단으로 판정했다 — `--remote-debugging-port`로
연 CDP에서 창이 실제로 로드한 URL을 읽는 것(`showStatus`가 셸 상태를 query string에
싣기 때문에 어느 화면인지가 URL로 드러난다), 그리고
`~/Library/Application Support/Damwha/logs/api.log`.

### 어느 판정이 어느 빌드에서 나왔나

판정을 낸 빌드가 셋이다. 이 구분을 지우면 "충족"이 어느 코드에 대한 것인지 알 수 없게
되므로 표의 각 행에 측정 빌드를 밝힌다.

| 빌드 | 커밋 | 그 빌드에서 나온 판정 |
| --- | --- | --- |
| **통합 검증 빌드** | `75a19f8` 이후 | P1-C1 ~ P1-C14 **전부의 최초 측정.** 이 빌드에서 P1-C8·P1-C10이 부분 미충족으로 나왔다 |
| **수정 1·2회차 빌드** | `8dcd08e` 이후 | P1-C8·P1-C10 **재측정** (충족으로 전환). 그 밖의 기준은 재측정하지 않았다 |
| **최종 리뷰 수정 빌드** | `ac6507a` 이후 | P1-C1(정상 기동)·P1-C5(자식 정리)·P1-C7 계열(설정 오류 화면)·P1-C11(번들 위생) **재측정.** 아래 "수정 3회차" 참조 |

**재측정하지 않은 기준은 통합 검증 빌드의 판정을 그대로 쓴다.** P1-C2·C3·C4(사용자 수행),
P1-C12·C13·C14가 여기 해당한다. 이후 수정들이 만진 것은 데스크톱 셸의 기동·종료 경로뿐이고
`be`/`fe`는 한 줄도 건드리지 않았으므로 그 판정은 유효하지만, **같은 빌드에서 다시 잰 것은
아니다.**

### 판정 표

| 기준 | 판정 | 실행한 명령과 관찰된 값 |
| --- | --- | --- |
| **P1-C1** 앱 아이콘 실행 | **충족** | 사용자가 Finder에서 `Damwha.app`을 실행. 터미널 명령 없이 창이 담화 화면에 도달했다 |
| **P1-C2** 업로드와 처리 | **충족** | 사용자가 오디오 파일로 회의를 만들고 전사 결과를 화면에서 확인. 생성된 `mtg_37`은 `meeting.status=done`이고 오디오는 `~/Library/Application Support/Damwha/storage/meetings/mtg_37/{original.m4a,normalized.flac}`에 있다 |
| **P1-C3** 녹음과 마이크 권한 | **충족** | 사용자가 `tccutil reset Microphone kr.damwha.app` 후 Finder에서 실행. macOS 마이크 대화상자가 `NSMicrophoneUsageDescription`의 문구로 떴고 녹음·중단·결과 확인까지 완주했다. 세 차례의 원인 규명 기록은 아래 "마이크 권한" 절에 있다 |
| **P1-C4** 검색 | **충족** | 사용자가 검색어를 넣어 키워드·의미 결과가 섞여 나오는 것을 확인 |
| **P1-C5** 자식 정리·외부 보존 | **충족** | 앱 기동 후 `osascript -e 'tell application id "kr.damwha.app" to quit'`. 2초 안에 Electron main 0개, API 자식 0개, 3000 점유 0. 같은 시점에 외부 `damwha_worker`·`damwha-embed` 4개 프로세스 전부 생존. P1-C10의 세 경우 모두에서 외부 API·점유자가 앱 종료 뒤에도 살아 있었다(200 응답) |
| **P1-C6** 중복 실행 방지 | **충족** | 앱이 떠 있는 상태에서 (a) `open -a Damwha.app` → Electron main 1개, CDP page target 1개 유지. (b) `Contents/MacOS/Damwha`를 직접 실행 → 두 번째 프로세스가 스스로 **exit 0**으로 종료(`requestSingleInstanceLock` 실패 경로), Electron main은 여전히 1개. API 자식도 1개 |
| **P1-C7** DB 미기동 원인 표시 | **충족** | `pnpm db:down` 후 기동. 3초 만에 `status.html?state=db-unreachable&detail=…&retryInSeconds=3&logPath=…`. `detail` 원문: `[Nest] 55229 … ERROR [Bootstrap] startup failed: database unreachable at postgres://postgres:***@localhost:5432/damwha:` — 비밀번호는 `maskUrl`이 가렸고 로그 경로가 화면에 있다. `pnpm db:up` 후 **자동 재시도로 3초 만에** `http://127.0.0.1:3000/`에 도달 |
| **P1-C8** 다른 기동 실패 원인 표시 | **충족** (`ac6507a` 빌드에서 재측정) | `config.json`에 `SUMMARY_LLM_MODEL=not-in-the-catalog`를 넣고 기동. 2초 만에 `state=failed`. `detail` 원문: `[Nest] 88764 - 09/11/2026, 5:07:51 PM   ERROR [Bootstrap] startup failed: [ / (종료 코드 1)`. 통합 검증 때의 `]` 한 글자가 아니라 **`startup failed:` 계약 줄**이고, **종료 코드가 화면에 있다**. P1-C7의 DB 문안(`startup failed: database unreachable at …`)과 다르다. 자식 잔존 0. 키 삭제 후 정상 기동. 남은 한계는 아래 "P1-C8 상세" 참조 |
| **P1-C9** 로컬 바인드 | **충족** | `lsof -nP -iTCP -sTCP:LISTEN -a -p <api pid>` → `TCP 127.0.0.1:3000 (LISTEN)` 한 줄, `*:3000` 아님. 주입된 env는 `HOST=127.0.0.1`, `PORT=3000`, `DATABASE_URL=postgres://…`, `STORAGE_ROOT=/Users/…/Library/Application Support/Damwha/storage` — 셋 다 절대값. LAN 주소 `172.16.1.154:3000`은 `Couldn't connect to server`로 거부 |
| **P1-C10** 포트 폴백 | **충족** (`ac6507a` 빌드에서 재측정) | 통합 검증에서 미충족이던 (b2) — `127.0.0.1:3000`을 외부가 점유하고 `/api/health`에 **200**을 주는 경우 — 를 그대로 다시 만들었다. 앱은 1초 만에 `http://127.0.0.1:63451/`로 떴고, 3000의 리스너는 **점유자 pid 하나뿐**이었으며, 앱 종료 뒤에도 점유자가 살아서 `/api/health`에 200을 줬다. R1-11이 닫혔다. 아래 "P1-C10 상세"의 **재측정** 절과 그 단서 두 개를 함께 읽어야 한다 |
| **P1-C11** 번들 위생 | **충족** | `pnpm --filter damwha-desktop exec node scripts/check-bundle.mjs` → 11개 항목 전부 PASS, exit 0. `dependencies` 없음, `app.asar`에 `node_modules` 0건, 트리 밖 심볼릭 링크 0건(트리 안 379개는 허용), 저장소 경로·pnpm store 경로 문자열 0건, SPA가 `api/dist/public/index.html`에 있음, `NSMicrophoneUsageDescription` 존재, `codesign` Identifier가 `kr.damwha.app`, `codesign --verify --deep --strict` exit 0 |
| **P1-C12** 경로 위생 | **충족** (판정 구간 한정) | 주입 env 3종 전부 절대 경로(P1-C9 행). 자식의 cwd는 `Contents/Resources/api` — 번들 **안**이지만, 실행 전후 체크섬 manifest 7,655개 파일이 **완전 동일**했다(`diff` 무출력). 다만 manifest는 P1-C5~C14 구간(정상 기동 5회, DB 미기동 1회, zod 실패 1회, 포트 점유 3회, 중복 실행 2회) 앞뒤로만 떴다 — 사용자의 P1-C1~C4 구간은 사전 manifest가 없어 **판정 범위 밖**이다 |
| **P1-C13** 웹 흐름 회귀 없음 | **충족** | `pnpm install` exit 0 / `pnpm build` exit 0 / `pnpm lint` exit 0(fe에 기존 경고 1건, 오류 0) / `pnpm test` — 1회차에 `be/test/lenses.e2e-spec.ts`가 `socket hang up`으로 1건 실패했으나 단독 재실행 40/40 통과, 부하를 걷어낸 뒤 전체 재실행 **43 suites / 468 tests 전부 통과**(테스트는 testcontainers의 일회용 Postgres와 임시 `STORAGE_ROOT`를 쓰므로 실 데이터와 무관하다). `pnpm dev`는 API 3000 + Vite 5173만 띄우고 **Electron 프로세스 0개**(`desktop`에 `dev` 스크립트가 없다). `docker build -f deploy/api.Dockerfile -t damwha-api:p1-check .` 성공, 314 MB |
| **P1-C14** 기존 데이터 보존 | **충족** (`.DS_Store` 예외) | 기준선은 Task 1이 2026-09-11T02:23:59Z에 뜬 `~/.cache/damwha-p1-evidence/`다. `be/storage` 32개 항목 중 **29개 데이터 파일 체크섬 완전 동일**, 유일한 차이는 Finder가 갱신한 `./.DS_Store` 1건(파일 수는 32로 동일). compose `config` 비교 완전 동일(`name: damwha`, `damwha_pgdata` 유지, `be_pgdata`는 손대지 않음). `_migrations` 24 → 24 **동일**. `meeting` 11 → 12, `utterance` 4619 → 4620 — 둘 다 **줄지 않음**(사용자의 P1-C2·C3이 더한 분) |

### P1-C8 상세 — 통합 검증에서 왜 부분 미충족이었고, 어떻게 닫혔나

스펙 §9의 성공 판정은 "기동 실패가 화면에 나오고 **stderr 마지막 줄과 종료 코드**를 볼 수
있다"이다. **아래는 통합 검증 빌드(`75a19f8` 이후)의 관찰이다** — 수정 뒤의 값은 판정 표의
P1-C8 행과 이 절 끝의 "수정과 재측정"에 있다. 그때 관찰된 것:

- `state=failed`로 화면은 떴고 P1-C7의 DB 문안과 다르다 → 이 부분은 충족.
- `detail`이 **`]`** 한 글자다. `retryInSeconds=3`, `logPath`는 정상.
- **종료 코드가 화면에 없다.**

원인은 추측이 아니라 실측이다. 같은 기동의 `api.log`에 찍힌 stderr는 zod 오류를
pretty-print한 15줄짜리 JSON 배열이고, 그 **마지막 비어 있지 않은 줄이 정확히 `]`**다.

```
ERROR [Bootstrap] startup failed: [
  {
    "received": "not-in-the-catalog",
    "code": "invalid_enum_value",
    ...
    "message": "Invalid enum value. Expected 'mlx-community/Qwen3.5-4B-8bit' | … , received 'not-in-the-catalog'"
  }
]
```

`desktop/src/shell-window.ts:33`의 `lastMeaningfulLine()`은 "마지막 비어 있지 않은 줄"을
고른다. 이 휴리스틱은 한 줄짜리 실패(P1-C7의 `database unreachable …`)에는 맞고 여러 줄
실패에는 맞지 않는다. Task 9 리뷰어가 "스택 트레이스 프레임이 잡힐 수 있다"는 Important를
냈고, 당시 컨트롤러가 `be/src/main.ts`가 스택 대신 한 줄만 찍는다는 실측으로 기각했다 —
그 실측은 DB 실패 경로에 대해서만 옳았다. zod 실패 경로는 `EnvSchema.parse`가 던지는
`ZodError`의 `message`가 그 자체로 여러 줄이라 같은 `catch`를 타고도 여러 줄이 된다.

종료 코드는 별개 누락이다. `main.ts`의 `watchForDeath()`는 `코드 ${code}`를 문안에 넣지만,
기동 실패 경로인 `startOnce()`의 `showStatus` 호출(`main.ts:299-304`)은 `outcome.handle.exitCode()`를
읽지 않는다.

#### 수정과 재측정 (`d8f2af1`)

위 두 결함은 **같은 브랜치에서 닫혔다.** 통합 검증 Task가 "Phase 2로 넘긴다"고 적었던
것은 그 Task의 역할이 판정과 기록이었기 때문이고, 이어진 수정 회차가 실제로 고쳤다.

- `lastMeaningfulLine()`을 `desktop/src/stderr.ts`로 빼고 규칙을 바꿨다. 1순위는
  `be/src/main.ts`의 계약 줄인 **`startup failed:`를 담은 마지막 줄**, 2순위는 괄호·구두점만
  있는 줄을 건너뛴 마지막 유의미한 줄이다. `]`는 2순위에서도 걸러진다.
  (부수 효과로 `shell-window.ts`가 electron을 값으로 import해 vitest가 못 불러오던 문제도
  풀려, 이 로직에 단위 테스트가 생겼다 — `desktop/tests/stderr.test.ts`.)
- 기동 실패 화면에 **종료 코드**를 넣었다(`(종료 코드 1)`).

`ac6507a` 빌드 재측정 결과는 판정 표의 P1-C8 행에 원문 그대로 있다.

**남은 한계 — 이 기준의 letter는 충족하지만 zod 경로의 원인은 아직 화면에 없다.**
스펙 §9의 판정 항목(실패 화면 도달 / stderr 줄 / 종료 코드 / P1-C7과 다른 문안 / 자식
무잔존)은 전부 관찰됐다. 그러나 zod 실패의 **실제 원인 문장**은
`"message": "Invalid enum value. Expected …, received 'not-in-the-catalog'"`이고, 이것은
`startup failed:` 계약 줄의 **다음** 줄부터 시작하는 pretty-print JSON 안에 있다. 화면이
보여 주는 것은 그 계약 줄 하나이므로 사용자가 읽는 문구는 `startup failed: [`에서 끊긴다.
`]`보다는 낫고(어느 단계에서 죽었는지와 종료 코드를 알 수 있다) 로그 경로가 화면에 있어
원문에 닿을 수는 있지만, **한 줄만 고르는 휴리스틱으로는 여러 줄 원인을 화면에 올릴 수
없다**는 사실 자체는 그대로다. 완료 기준의 미충족이 아니라 품질 한계로 기록하고, 여러 줄
메시지를 다루는 일은 Phase 2의 화면 개선에 남긴다.

### P1-C10 상세 — 세 경우의 실측, 그리고 재측정

스펙이 말하는 점유 주체는 `pnpm dev`다. 그대로 해 보니 **충돌 자체가 일어나지 않았다.**
**아래 표는 통합 검증 빌드(`75a19f8` 이후)의 관찰이고, (a)와 (b2)는 수정 뒤 달라졌다** —
이 절 끝의 "재측정"을 함께 읽어야 한다.

| 점유자 | 점유 주소 | 앱의 API가 잡은 주소 | 화면 | 판정 |
| --- | --- | --- | --- | --- |
| (a) `pnpm dev` (스펙 문언) | `*:3000` (`HOST` 기본값 `0.0.0.0`) | **`127.0.0.1:3000`** — 같은 포트에 함께 bind됨 | `http://127.0.0.1:3000/` 정상 | 폴백 **미발생**. 앱은 정상 동작하고 외부는 앱 종료 후에도 200 |
| (b1) `127.0.0.1:3000` 점유, `/api/health`에 200을 주지 않음 | `127.0.0.1:3000` | **`127.0.0.1:57192`** (탐색 포트) | `http://127.0.0.1:57192/meetings/mtg_37` 정상 | **폴백 성공.** 점유자 생존 |
| (b2) `127.0.0.1:3000` 점유, `/api/health`에 **200**을 줌 | `127.0.0.1:3000` | 없음 — 자식이 `EADDRINUSE`로 죽음 | `state=failed`, `detail=API가 종료됐어요 (코드 1). … listen EADDRINUSE: address already in use 127.0.0.1:3000` | **폴백 실패 (R1-11)** |

(a)는 macOS/BSD의 소켓 의미론 때문이다. `SO_REUSEADDR`가 켜진 상태에서 `0.0.0.0:3000` 위에
`127.0.0.1:3000`을 겹쳐 bind하는 것이 허용되고, loopback 트래픽은 더 구체적인 bind가
가져간다. 그래서 스펙이 지정한 점유 주체로는 `EADDRINUSE`가 발생하지 않고 폴백 경로가
실행되지 않는다. 검증이 성립하지 않는 것이지 앱이 틀린 것은 아니다 — 앱은 자기 자식이
쥔 포트를 보고 있었고, 외부 프로세스를 죽이지도 않았다.

> **(a)는 수정 뒤 더 이상 성립하지 않는다.** 위 표는 `75a19f8` 빌드의 관찰이다. 이제
> 기구 (a)가 `127.0.0.1:3000`에 연결해 보고 `*:3000`의 리스너가 그 연결을 받으므로, 앱은
> `pnpm dev`가 도는 동안 3000을 점유된 것으로 보고 **항상 다른 포트로 옮긴다.** 겹쳐
> bind하던 동작은 사라졌다. 바뀐 쪽이 옳다 — 겹쳐 bind는 "누가 그 포트를 쥐고 있는가"를
> 앱이 모른 채 우연히 성립한 것이고, 외부 리스너가 `127.0.0.1`에 붙어 있기만 하면 곧장
> (b2)의 오인으로 넘어간다. 스펙 §6.4에 같은 내용을 적었다.

(b2)가 실제 결함이다. `main.ts:180-185`의 `attempt()`는 자식을 띄우자마자
`probeHealth(origin)`으로 **그 포트의 응답**을 준비 신호로 쓴다. 자식이 `EADDRINUSE`로
죽기 전에 첫 probe가 나가고, 그 200은 외부 점유자가 준 것이므로 앱은 `ready`로 판정해
`apiOrigin`을 `http://127.0.0.1:3000`으로 잡고 `watchForDeath`를 건다. 곧 자기 자식이
죽으면서 사망 화면이 뜨고, `addr-in-use` 분기에 닿지 못해 **다음 포트로 넘어가지 않는다.**
재시도는 다시 3000부터 시작하므로 같은 자리를 반복한다.

이것은 스펙 §6.4가 F-8을 닫으며 명시한 계약
— *"'그 포트에 응답이 있다'를 준비 신호로 쓰지 않는다 — 응답이 외부 API에서 올 수 있다"* —
을 구현이 지키지 않은 것이다. 소유권은 자식 핸들로만 판정해야 하며, 최소한 자식이
`EADDRINUSE`로 죽었는지를 probe 성공보다 먼저 확인해야 한다.

#### 수정 (`d8f2af1`, `8dcd08e`)

기구를 둘로 나눴다. 스펙 §6.4를 같은 내용으로 개정했다("소유권을 판정하는 두 기구").

- **(a) 스폰 전 사전 점검** `isPortOccupied(port)` — 후보 포트에 TCP로 붙어 보고 누가
  받으면 자식을 띄우지 않고 다음 후보로 간다.
- **(b) 준비 후 소유 증명** `verifyOwnListener(port, childPid)` — health 200을 받아도
  `lsof -sTCP:LISTEN -t`의 리스너 pid가 우리 자식이거나 그 자손일 때만 `ready`로 본다.
  dev는 `pnpm`→`nest`→`node`의 **손자**가, packaged는 `utilityProcess` 헬퍼 **자신**이
  bind하므로 `ps`의 pid/ppid를 BFS로 훑어 양쪽을 한 판정으로 덮는다.

`8dcd08e`는 그 (b)가 packaged에서 통째로 무력했던 회귀를 고쳤다 — `utilityProcess.pid`는
`fork()` 직후 `undefined`이고 `'spawn'` 이벤트에서야 채워지는데 동기로 한 번만 읽고 있었다.
그래서 packaged의 모든 handle이 생애 내내 `pid === undefined`였고, 소유 확인이 **자기
자식조차** 인정하지 못해 건강한 자식이 매번 30초 타임아웃으로 죽었다. 같은 커밋에서
"health 200은 봤지만 소유를 증명 못 한 채 끝난 타임아웃"을 `failed`로 뭉개지 않고
`unverified-owner`라는 별도 outcome으로 갈라, 같은 결함이 다음에 원인 없는 화면으로
숨지 않게 했다.

#### 재측정 (`ac6507a` 빌드, 2026-09-11)

통합 검증에서 미충족이던 **(b2)를 그대로 재현했다** — `127.0.0.1:3000`에 외부 프로세스를
띄우고 모든 GET에 200을 주게 했다(`/api/health` → 200 확인).

| 관찰 항목 | 값 |
| --- | --- |
| 앱이 도달한 URL (CDP) | `http://127.0.0.1:63451/` — 폴백 성공 |
| 도달까지 | 1초 |
| 앱 기동 중 3000의 LISTEN pid | 점유자 pid **하나뿐** (앱은 3000에 붙지 않았다) |
| 앱 종료 후 점유자 | **생존**, `/api/health` → 200 |
| 앱 종료 후 Damwha 프로세스 | 0 |

같은 회차에서 확인된 다른 경로: packaged 정상 기동이 CDP 기준 약 2초 만에
`http://127.0.0.1:3000/meetings/mtg_37`에 도달하고 종료 후 잔존 프로세스 0,
폴백 경우가 `http://127.0.0.1:61434/`에 도달하며 3000의 외부 점유자는 손대지 않은 채
계속 200을 주고, 개발 흐름이 `http://localhost:5173/meetings/mtg_37`에 도달한다.

**이 재측정에 붙는 단서 두 개. 이것을 지우면 기록이 실제보다 강해진다.**

- **P1-C10 재실행이 시험한 것은 사전 점검이지 소유권 확인이 아니다.** 기구 (a)가 자식이
  생기기도 전에 점유자를 잡아내기 때문이다. 즉 이 재측정은 (a)의 동작을 증명하고, 계약을
  실제로 지키는 (b)는 이 경로에서 발화하지 않는다.
- **`unverified-owner` 실패 화면은 종단간으로 한 번도 발화시켜 본 적이 없고, 코드
  검토로만 확인했다.** (a)를 통과한 뒤 (b)만 실패하는 상태 — 점검과 bind 사이에 다른
  프로세스가 그 포트를 가져가는 TOCTOU 창 — 를 인위적으로 만들지 못했다.

마이크 권한 재요청 여부(R1-6)는 **미판정**이다. 폴백이 일어난 (b1)에서 앱은 새 origin
`http://127.0.0.1:57192`를 정상 로드했고, `permissions.ts:8-26`은 허용 origin에 대해
`media`를 자동 부여하므로 Electron 층에서 다시 묻지 않는 것은 코드로 확인된다. 그러나
macOS TCC 대화상자가 다시 뜨는지는 GUI와 Finder 실행이 필요해 이 세션에서 관찰할 수 없었다.

### 수정 회차

통합 검증(`fc65f11`) 뒤에 같은 브랜치에서 세 번의 수정이 있었다. 이 문서는 그 셋을 모두
반영한 상태다.

| 회차 | 커밋 | 고친 것 | 어떻게 드러났나 |
| --- | --- | --- | --- |
| 1 | `d8f2af1` | P1-C10의 외부 API 오인(소유권 두 기구), P1-C8의 실패 원인 문안과 종료 코드 | 통합 검증의 실측 |
| 2 | `8dcd08e` | packaged의 `utilityProcess.pid`가 생애 내내 `undefined`라 1회차의 소유권 확인이 통째로 무력했던 회귀. `unverified-owner` outcome 분리 | 1회차 직후의 재측정에서 건강한 자식이 30초 타임아웃으로 죽는 것으로 드러났다 |
| 3 | `ac6507a` | 기동·종료 경로의 예외 4건 — 아래 | 브랜치 전체 최종 리뷰 |

**3회차가 고친 것.** 전부 라이프사이클의 에러 경로이고, 1·2회차가 이 코드를 두 번
고쳤다는 사실 자체가 여기를 다시 보게 만들었다.

- **`startOnce()`가 스스로 던지는 예외에 실패 경로가 없었다.** `config.json`의
  `{"PORT": 70000}`(또는 `-1`, `1.5`)은 `choosePort`가 던지고, 못 쓰는 userData는
  `loadConfig`의 `writeFileSync`가 던지고, 막힌 포트 탐색은 `freePort`가 던진다. 셋 다
  `showStatus({state:"starting"})` **뒤**라 상태 갱신도 재시도도 로그도 없이 앱이
  "준비 중"에 영원히 머물렀다 — 이 Phase가 이미 두 번 값을 치른 조용한 정지와 같은
  모양이고, 이번 문은 사용자가 직접 고치는 파일에서 열린다. 실측(수정 전 `d8f2af1`
  빌드): 24초 동안 CDP URL이 `status.html?state=starting` 그대로였고 stderr에
  `UnhandledPromiseRejectionWarning: Error: invalid preferred port: 70000`이 찍혔다.
  수정 후 같은 조건에서 3초 만에
  `status.html?state=failed&detail=config.json의 PORT 값 "70000"은(는) 1~65535의 정수가 아니에요. …&retryInSeconds=3`
  에 도달하고, 재시도 간격이 3 → 8 → 20으로 올라가는 것까지 관찰됐다.
- **`launchPackaged`가 자식에게 환경을 통째로 갈아 줬다.** `utilityProcess.fork`의 `env`는
  대체이지 병합이 아닌데 `options.env`만 줘서, packaged API 자식이 `PATH`·`HOME`·`TMPDIR`·
  `LANG` 없이 돌았다. `be/src/system/capabilities.ts:44`가 `execFile('sysctl', …)`를 이름만으로
  부르는데 `PATH`가 없으면 `execvp`가 `/usr/bin:/bin`으로 되돌아가고 `/usr/sbin/sysctl`은
  거기 없어 ENOENT — **packaged 앱만** `chip: null`을 보고했다. `launchDev`와 같은 모양
  (`{ ...process.env, ...options.env, HOST: "127.0.0.1" }`)으로 맞췄다. `options.env`와
  `HOST`가 여전히 마지막이라 §6.6의 LAN 노출 방지 보장은 그대로다. 수정 후 실측:
  `GET /api/system/capabilities` → `{"platform":"darwin","arch":"arm64","chip":"Apple M2","memory_gb":16,"gpu_eligible":true,"recommended_preset":"standard"}`.
  자식 env에 `PATH`·`HOME`·`TMPDIR`·`LANG`이 모두 있고 `HOST=127.0.0.1`이 유지된다.
- **자식의 `exit` 리스너가 던지면 main 프로세스가 죽었다.** `exitNotifier.settle`의
  `for (const l of listeners) l(exitCode)`에 격리가 없었다. 등록된 리스너는 `watchForDeath`의
  것 하나이고 그것이 `BrowserWindow`를 건드리는데, **창을 닫는 행위 자체가 자식을 죽이는
  종료를 부르므로** `win === null` 검사와 `loadFile` 호출 사이에 창이 파괴될 수 있고
  `loadFile`은 그때 `Object has been destroyed`를 **동기로** 던진다. 알림 루프를
  `try/catch`로 감싸고, 창 판정을 `isDestroyed()`까지 보게 하고, `void showStatus(...)`에
  `.catch()`를 붙였다. 같은 계열로 `before-quit`의
  `void stopAll().then(() => app.quit())`도 고쳤다 — `stopAll()`이 거부하면 `app.quit()`이
  아예 불리지 않아, `event.preventDefault()`로 막아 둔 종료가 영영 재개되지 않고 앱이 창
  없이 남는다. `.finally()`로 바꾸고 `launchPackaged.stop`의 맨몸 `child.kill()`도 감쌌다.
- **`quitting`을 네 군데 중 한 군데에서만 봤다.** `before-quit`이 `quitting = true`와
  `cancelRetry()`를 지난 뒤에, `waitForReady`나 Vite 대기에 들어가 있던 `startOnce`가
  죽은 자식을 보고 깨어나 실패 분기로 떨어져 `scheduleRetry()`를 다시 걸고(종료가 방금
  치운 타이머다) 사라졌을 수 있는 창에 `showStatus()`를 불렀다. 세대·종료·창 파괴를 한
  자리에서 보는 `activeWindow(mine)`으로 네 검사를 통일하고, `scheduleRetry()`를 종료 중
  no-op으로 만들고, 승격된 자식을 두고 물러나지 않도록 `abandon(handle)`을 넣었다.

3회차 뒤 재검증: `desktop` lint·compile 통과, `desktop` 테스트 5 파일 46개 통과,
`pnpm desktop:build`의 번들 위생 11항목 전부 PASS, 루트 `pnpm lint` exit 0,
루트 `pnpm test` — be 43 suites / 468 tests, fe 62 파일 / 566 tests,
desktop 5 파일 / 46 tests **전부 통과**.

### 실측으로 확정된 값

| 항목 | 코드의 값 | 실측 |
| --- | --- | --- |
| `READY_TIMEOUT_MS` | `30_000` (`desktop/src/readiness.ts:16`) | packaged 콜드 스타트는 `open`부터 `/api/health` 200까지 **1.7초**. 상한의 6% |
| `READY_INTERVAL_MS` | `250` | 1.7초 안에 판정되므로 폴링 횟수는 한 자릿수 |
| `PROBE_TIMEOUT_MS` | `2_000` | 이번 실행에서 probe가 상한에 걸린 경우는 없었다 |
| `RETRY_DELAYS_MS` | `[3_000, 8_000, 20_000]` (`main.ts:28`) | 실패 화면의 `retryInSeconds=3` — 첫 값이 화면에 그대로 나온다. P1-C7의 DB 복구가 자동 재시도로 3초 만에 성립 |
| `MAX_PORT_ATTEMPTS` | `4` (고정 1 + 탐색 3, `port.ts:7`) | (b1)에서 1회 폴백으로 `57192` 획득 |
| `pnpm deploy` 형태 | — | `pnpm --filter=damwha-be --prod --config.inject-workspace-packages=true deploy desktop/build/api`. 선행 조건으로 `be/package.json`에 `"files": ["dist"]`가 필요하다(`be/.gitignore`의 `dist/` 때문에 빠진다) |
| 자식 기동 수단 | `utilityProcess.fork` | 실측 argv: `Damwha Helper.app/Contents/MacOS/Damwha Helper --type=utility --utility-sub-type=node.mojom.NodeService`, ppid = Electron main. cwd = `Contents/Resources/api` |
| `.app` 용량 | — | **353 MB**, 파일 7,655개. `app.asar` 80 KB(main + 셸만), 나머지는 `Resources/api` 트리와 Electron 프레임워크 |
| Gatekeeper 조치 | — | `spctl -a -vvv` → **rejected**(ad-hoc, 공증 없음). 로컬 빌드에는 `com.apple.quarantine` 속성이 없어 실행에는 조치가 필요 없었다. 배포본은 Phase 6의 Developer ID + 공증이 있어야 한다 |

### 검증 절차 자체에서 드러난 사실

- **packaged 모드에서 `pgrep -f "dist/main"`은 API 자식을 찾지 못한다.** 계획과 Task 13
  브리핑이 쓰던 이 패턴은 `nest`가 `node … be/dist/main`을 띄우는 **dev 전용**이다.
  packaged의 자식은 `utilityProcess.fork`가 만든 Electron 헬퍼라 argv에 `dist/main`이
  없다. 올바른 탐색은 `pgrep -P <Electron main pid>` 후 argv에서
  `--utility-sub-type=node.mojom.NodeService`를 찾는 것, 또는 포트로 `lsof -t`다.
- `pgrep -c`는 macOS에 없다. `pgrep -f X | wc -l`로 센다.
- 두 번째 인스턴스를 `open`으로 여는 것은 single-instance를 **시험하지 않는다** —
  LaunchServices가 기존 앱을 활성화할 뿐 새 프로세스를 만들지 않을 수 있다.
  `Contents/MacOS/Damwha`를 직접 실행해야 진짜 두 번째 프로세스가 생긴다.
- 터미널에서 앱을 실행하면 macOS가 TCC를 앱이 아니라 터미널에 귀속시킨다. 권한 검증은
  반드시 Finder 실행으로 해야 한다.

### 마이크 권한 — 세 차례의 원인 규명

P1-C3은 이 Phase에서 가장 오래 막힌 기준이고, 그 과정이 Phase 6의 입력을 만들었다.

1. **대화상자가 뜨지 않음.** `codesign -dv`가 `Identifier=Electron`,
   `Sealed Resources=none`를 보고했다. electron-builder는 `target: dir`에 서명 설정이
   없으면 번들을 재서명하지 않아, 앱이 Electron 프리빌트의 링커 서명을 그대로 갖는다.
   앱이 **자기 TCC 주체가 아니었다** — 이 맥의 다른 미서명 Electron 앱들과 권한을 공유한다.
   조치: 패키징 파이프라인에 `codesign --force --deep --sign -`를 추가(`165dd75`).
2. **재서명 후에도 거부.** `codesign -d --requirements -`가
   `designated => cdhash H"7e5cefc6…"` — cdhash **하나뿐인** designated requirement를 냈다.
   ad-hoc 서명의 DR은 항상 이 형태로 환원된다. TCC는 DR에 권한을 묶으므로 **재빌드할 때마다
   권한이 무효가 된다.** 시스템 설정에는 예전 빌드의 "Damwha" 항목이 남아 있어 macOS가
   다시 묻지도 않았다. 조치: 사용자가 `tccutil reset Microphone kr.damwha.app` 실행.
3. **리셋 후에도 앱이 스스로 "권한 거부"를 그림.** 렌더러가
   `navigator.permissions.query({name:'microphone'})`로 `denied`를 받고 `getUserMedia`를
   아예 부르지 않아 macOS에 물어볼 기회가 없었다. 원인은 위 "Task 9의 보류가 만든 교훈"에
   적은 origin 정규화 불일치다. 수정(`75a19f8`) 후 CDP 측정: microphone `granted`,
   `getUserMedia`가 실제 트랙 획득. 사용자가 Finder 실행으로 대화상자와 녹음 완주를 확인했다.


## 남은 제약·후속 Phase 인계

### 이 Phase에서 닫지 못한 완료 기준

**완료 기준 14건은 전부 충족했다.** 통합 검증이 남겼던 P1-C8·P1-C10 두 건은 같은
브랜치에서 닫혔으므로 **Phase 2의 백로그로 넘기지 않는다.** 아래는 기준 미충족이 아니라
품질·검증 범위의 한계로 남는 것들이다.

| 항목 | 남은 것 | 인계 |
| --- | --- | --- |
| P1-C8 품질 (기준은 충족) | 한 줄만 고르는 휴리스틱이라 zod 같은 여러 줄 원인은 화면에 `startup failed: [`까지만 나온다. 원인 문장은 로그에만 있다 | Phase 2의 화면 개선. `desktop/src/stderr.ts` |
| P1-C10 검증 범위 (기준은 충족) | 재실행이 시험한 것은 사전 점검(a)이지 소유권 확인(b)이 아니다. `unverified-owner` 화면은 종단간 미발화, 코드 검토로만 확인 | Phase 2 검증에서 TOCTOU 창을 인위적으로 만들 수단이 생기면 1회 확인 |
| R1-6 (P1-C10의 일부) | 포트 폴백 후 macOS TCC 대화상자가 다시 뜨는지 미판정 — GUI와 Finder 실행 필요 | Phase 2 검증 시 사람이 1회 확인 |
| 3000 공존 동작 변경 | `pnpm dev`가 도는 동안 앱이 3000에 겹쳐 bind하던 동작이 사라졌다. 앱은 항상 다른 포트로 옮긴다 | 의도된 변경. 스펙 §6.4에 기록 |

### 서명 — Phase 6의 성격이 바뀐다

**ad-hoc 서명은 TCC 권한을 바이너리의 cdhash에 못 박는다.** `codesign -d --requirements -`가
낸 designated requirement는 `cdhash H"…"` 하나뿐이고, TCC는 DR에 권한을 묶는다. 따라서
**재빌드할 때마다 마이크 권한이 무효가 되고**, 사용자 화면에는 예전 빌드의 항목이 남아
macOS가 다시 묻지도 않는다. Developer ID 서명의 DR은
`identifier "kr.damwha.app" and anchor apple generic and certificate leaf[subject.OU] = "<TEAMID>"`
로 재빌드에 걸쳐 **안정적**이다.

그러므로 Developer ID 서명은 배포 편의가 아니라 **앱의 권한이 업데이트를 넘어 살아남기
위한 선행 조건**이다. ad-hoc으로 업데이트를 내보내면 매 판올림마다 사용자가 마이크 권한을
다시 줘야 하고 이전 항목은 유령으로 남는다. Phase 0은 서명을 Phase 6으로 미뤘지만 이
층까지 닿지 않았다(Phase 0 Task 8은 Gatekeeper에서 멈췄다).

Phase 6 입력으로 확인된 현재 상태: 사용자는 Apple Developer Program에 가입했으나
`security find-identity -v -p codesigning`에는 iOS 인증서
(`iPhone Distribution: Mediology Co., Ltd. (HJJNV9Y5W8)`)만 있고 **Developer ID Application
인증서도 notarytool 프로필도 없다.** 필요한 것: 팀 선택(개인 vs Mediology), Account Holder가
발급하는 Developer ID Application 인증서, 개인 키의 `.p12` 백업(잃으면 같은 identity로
업데이트를 서명할 수 없다), App Store Connect API 키 기반 공증 자격증명.

### 기존 회의 오디오 404 — Phase 5

앱은 `STORAGE_ROOT`를 `~/Library/Application Support/Damwha/storage`로 잡는다. 기존 회의
11건의 파일은 `be/storage`에 있으므로 **앱에서 그 회의의 오디오는 404가 된다.** 의도된
선택이고(스펙 §6.3), 데이터 이전은 **Phase 5**가 진다. P1-C14가 판정하듯 `be/storage`는
이 Phase에서 한 바이트도 바뀌지 않았으므로 이전 대상은 온전하다.

### `be/worker/.env` — 되돌렸다

worker는 API와 같은 `STORAGE_ROOT`를 봐야 한다. 검증을 위해 Task 13 Step 2가 이 값을 앱의
경로로 바꿨고, **검증을 마친 뒤 원래 값 `../storage`로 되돌렸다.**

- 되돌리기 전 `job` 테이블에 `queued`·`running`이 0건임을 확인했다(현재 `done` 69, `failed` 25).
  앱이 만든 `mtg_37`도 이미 `done`이라 미완 작업을 남기지 않는다.
- 백업은 `~/.cache/damwha-p1-evidence/worker.env.backup`에 그대로 있다. 이 파일은
  gitignore 대상이라 **이 백업이 유일한 복구 수단**이다.
- **선택의 대가:** 이제 웹 흐름(`pnpm dev` + `pnpm worker`)은 기존 회의 전부를 정상
  처리하지만, **데스크톱 앱에서 새로 올린 파일은 worker가 찾지 못해 처리되지 않는다.**
  앱으로 처리까지 하려면 `be/worker/.env`의 `STORAGE_ROOT`를
  `/Users/<user>/Library/Application Support/Damwha/storage`로 바꾸고 worker를 재시작해야 한다.
- 되돌린 것은 파일이다. **이미 떠 있는 worker 프로세스는 재시작 전까지 검증용 값을 그대로
  들고 있다.** 다음 재시작부터 `../storage`가 적용된다.
- 이 수동 합의 자체가 제약이다. **Phase 2**가 worker를 앱이 직접 띄우면 앱이 값을 주입하므로
  사라진다.

### dev 모드와 packaged 모드의 프로세스 의미가 다르다 — Phase 2

dev의 API 자식은 `nest start --watch` **래퍼**다. 이 래퍼는 자기 손자(진짜 API)가
fail-fast로 죽어도 살아 있으므로, `waitForReady`의 결과가 `child-exited`가 아니라
`timeout`으로 온다. `attempt()`는 이것을 `timeout`에서도 stderr를 검사하는 방식으로
흡수한다(`main.ts:189-201`) — 그 검사가 없으면 dev에서 포트 폴백이 영원히 일어나지 않고
DB 미기동 화면에도 닿지 못한다. packaged의 자식은 `utilityProcess`라 죽으면 바로
`child-exited`가 온다.

즉 **두 모드의 프로세스 의미가 다르고, 코드가 그 차이를 한쪽으로 보정하고 있다.**
`stderrTail()`은 handle마다 따로이므로 오판정은 아니지만, 두 모드를 같은 의미로 만드는
일은 **Phase 2**의 몫이다.

### ready 이후 자동 재시작 부재 — Phase 2

`watchForDeath()`는 ready 뒤 자식이 죽으면 화면에 알리고 `scheduleRetry()`를 건다. 이것은
전체 `start()`의 재실행이지 프로세스 감독이 아니다. 서비스 수준의 감독·재시작은 Phase 2다.

### CORS와 API 인증 — Phase 6

`HOST=127.0.0.1`은 LAN 노출을 막지만(P1-C9로 실측 확인) API는 여전히 무제한 CORS를 켜고
인증이 없다. 남은 위협은 같은 머신의 다른 프로세스이며 CORS로는 막히지 않는다. 데스크톱이
되면서 새로 생긴 노출이 아니므로 Phase 1에서 고치지 않았다(스펙 F-9). **Phase 6** 배포
보안 검토가 진다.
