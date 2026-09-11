# Electron Phase 1 — 앱 기반 설계

작성일: 2026-09-11
브랜치: `feat/electron-migration-phase-1-app-foundation`
분기점: `dev`
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 1. Electron 앱 기반"
선행 Phase 결과: [Phase 0 검증 결과](../reports/2026-09-09-electron-phase-0-packaging-validation-results.md)

**상태: 스펙 작성 중. 구현 미착수.** 완료 기준의 판정 값은 계획 실행 단계에서 증거와 함께 채운다.

## 1. 이 Phase가 만드는 것

기존 담화를 `Damwha.app` 창에서 쓴다. Electron이 NestJS API를 자식 프로세스로 띄우고, 준비되면 화면을 붙인다.

DB·worker·embed는 **이 Phase가 관리하지 않는다.** 개발자가 오늘처럼 손으로 띄운 것을 그대로 쓴다. 그 세 서비스의 기동 통합은 Phase 2다.

이 Phase가 만드는 것은 후속 Phase 전체가 올라탈 네 계약이다.

1. **프로세스 소유권 계약** — 앱이 만든 프로세스와 외부 프로세스를 구분하고, 앱이 만든 것은 앱이 정리한다.
2. **경로 계약** — 실행 파일은 앱 번들 안, 변경되는 데이터는 앱 번들 밖. 값을 누가 정하고 어떻게 주입하는가.
3. **준비 상태 계약** — "서비스가 쓸 수 있다"를 무엇으로 판정하고, 아닐 때 사용자에게 무엇을 보여주는가.
4. **번들 위생 계약** — 무엇이 `.app` 안에 들어가고, 그 안에 개발 환경 흔적이 남지 않았음을 어떻게 확인하는가.

## 2. Phase 0에서 인계받는 것

**없다.** Phase 0 결과 문서의 "Phase 1 (Electron 앱 기반)" 항목이 명시한다 — Phase 1은 기존 개발 환경의 DB·worker·embed를 그대로 쓰므로 번들이 필요하지 않고, 검증 하네스도 이식하지 않는다. Node 런타임은 Electron이 제공하므로 Phase 0의 격리 경계(§4.0) 밖이었다.

Phase 0이 확정한 PostgreSQL·Python·ffmpeg 제공 방식은 Phase 3·4가 쓴다. 이 Phase는 그 산출물을 참조하지 않는다.

## 3. 현재 시스템에서 이 Phase가 건드리는 지점

| 지점 | 현재 상태 | Phase 1에서 |
| --- | --- | --- |
| `be/src/main.ts` | `dist/public`이 있으면 SPA + 폴백 서빙. `app.listen(env.PORT)`로 0.0.0.0 바인드 | 서빙 경로를 **그대로 재사용**한다. 바인드 host만 주입 가능하게 고친다 |
| `be/src/config/env.ts` | `PORT`, `DATABASE_URL`, `STORAGE_ROOT` 등을 zod로 검증 | `HOST` 추가 (기본 `0.0.0.0` — Docker 배포 동작 유지) |
| `be/src/health/health.controller.ts` | DB에 `SELECT 1`을 던져 200 / 503 | **그대로 쓴다.** 준비 판정의 신호 |
| `be/src/database/database.service.ts:34` | fail-fast — DB에 못 닿으면 `onModuleInit`이 던지고 `main.ts`가 `startup failed: database unreachable at <가려진 URL>`을 찍고 exit 1 | **그대로 쓴다.** 실패 원인을 이미 한 줄로 주므로 main은 그 줄을 화면에 올리기만 한다 |
| `fe/src/shared/config/env.ts` | `VITE_API_BASE_URL`, 없으면 `http://localhost:3000/api` | 변경 없음. 값만 빌드·기동 시점에 주입 |
| `deploy/api.Dockerfile` | `VITE_API_BASE_URL=/api`로 단일 origin 빌드 | 변경 없음. 데스크톱 빌드가 같은 조합을 쓴다 |
| `be/worker/`, `packages/contracts/` | — | 변경 없음 |

제품 코드 변경은 `be/src/main.ts`, `be/src/config/env.ts`, `be/package.json` **세 파일뿐**이다. §10에 전량을 적는다.

## 4. 범위

### 4.1 포함

- 모노레포에 `desktop/` 패키지 추가 (`damwha-desktop`, pnpm workspace member).
- Electron main 프로세스 — 수명주기, 창, 단일 인스턴스 잠금.
- API 자식 프로세스 관리 — 기동, 준비 판정, 종료 정리.
- 준비·오류 셸 화면 (앱 번들 내 정적 HTML).
- `config.json` 읽기와 기본값 생성, 절대 경로 주입.
- 포트 결정 — 고정 우선, 점유 시 빈 포트.
- 마이크 권한 — `Info.plist` 항목과 Chromium 권한 핸들러.
- 네비게이션 경계 — 자기 origin 밖 이동 차단, 외부 링크는 기본 브라우저.
- `electron-builder --dir`로 서명 없는 `Damwha.app` 생성.
- 개발 실행 스크립트 — 기존 `pnpm dev` 웹 흐름과 공존.

### 4.2 제외

| 제외 | 이유 |
| --- | --- |
| DB·worker·embed 자동 실행 | Phase 2 |
| 창 닫기와 앱 종료 구분, 녹음·분석 중 종료 정책 | Phase 2. 이 Phase는 `window-all-closed` → `app.quit()`로 단순하게 둔다 |
| 시작 순서 오케스트레이션, 재시작, 로그 회전 | Phase 2 |
| PostgreSQL 내장 | Phase 3 |
| Python·ML·ffmpeg 내장, 모델 다운로드 | Phase 4 |
| 기존 DB·녹음·모델 이전, 백업·복원 | Phase 5 |
| 서명, 공증, DMG, 자동 업데이트, 다른 맥에서의 설치 검증 | Phase 6 |
| 렌더러에 Electron 전용 API 노출 | §7.4. `fe/`는 웹·Docker 배포와 공유된다 |
| Intel 맥, Mac App Store | 로드맵 전체 범위 밖 |

### 4.3 선행 조건

구현 전에 갖춰져 있어야 하고, 검증할 때도 같은 상태를 요구한다.

1. **Postgres가 떠 있다** — `pnpm db:up`.
2. **worker와 embed가 떠 있다** — `pnpm worker`, `pnpm embed`.
3. **`be/worker/.env`의 `STORAGE_ROOT`가 앱의 `STORAGE_ROOT`와 같은 절대 경로다** — 기본값이면 `~/Library/Application Support/Damwha/storage`. 이유와 방향의 근거는 §6.3.
4. **`pnpm be:migrate`가 적용된 DB다.** 이 Phase는 마이그레이션을 실행하지 않는다.

## 5. 데이터 안전 규칙

Phase 0 스펙 §4.4와 같은 취지다. 이 Phase에서 위험한 것은 **기존 `be/storage`**와 **`damwha_pgdata` 볼륨**이다. 각 규칙은 P1-C14가 실측으로 판정한다 — 규칙만 적고 검증하지 않으면 규칙이 아니다.

- 앱은 기존 `be/storage`에 **쓰지 않는다.** §6.3의 방향 결정으로 앱의 `STORAGE_ROOT`가 그 트리와 겹치지 않는다.
- 앱은 **새 meeting id로만** 파일을 쓴다. 기존 `meetings/<기존 id>/` 아래 파일을 덮어쓰거나 지우지 않는다.
- 앱은 마이그레이션을 실행하지 않고 스키마를 바꾸지 않는다. 기존 행을 지우지 않는다.

**`<userData>` 밖으로 쓰는 유일한 길은 사람이 여는 것이다.** 아래 "`.app` 번들 안에는 쓰지 않는다"는 절대 규칙이지만, "쓰기는 `<userData>` 아래"는 **기본 설정의 성질**이다 — `config.json`의 `STORAGE_ROOT`에 다른 절대 경로를 적으면 앱은 그곳에 쓴다(§6.3). 그것이 기존 `be/storage`를 보려는 사람의 탈출구이므로 막지 않는다. P1-C14는 **기본 설정 상태**를 판정한다.
- `docker-compose.yml`의 `name: damwha`와 `damwha_pgdata` 볼륨을 건드리지 않는다.
- `.app` 번들 **안에는 쓰지 않는다.** 쓰기가 필요한 모든 경로는 `<userData>` 아래다.
- 기존 `be/.env`, `be/worker/.env`, `fe/.env`를 구현이 자동으로 고치지 않는다. 선행 조건 3번은 사람이 맞춘다.

## 6. 구성요소와 계약

### 6.1 패키지 구조

```
desktop/
  package.json            damwha-desktop. dependencies는 비운다 (§9의 P1-C11)
  electron-builder.yml
  tsconfig.json
  src/
    main.ts               수명주기, 창, 단일 인스턴스
    config.ts             userData 보장, config.json 읽기·기본값 생성
    api-process.ts        기동 / 준비 판정 / 종료
    port.ts               고정 우선, 점유 시 빈 포트
    permissions.ts        마이크 권한, 네비게이션 경계
    shell/                준비·오류 정적 화면
  build/                  빌드 산출물 (gitignore)
```

`pnpm-workspace.yaml`의 `packages`에 `desktop`을 추가한다.

**`desktop`에 `dev`와 `build` 스크립트를 두지 않는다.** 루트 `package.json`의 `dev`는 `pnpm --parallel --recursive run dev`이고 `build`는 `pnpm --recursive run build`라, 그 이름을 쓰면 `pnpm dev`가 Electron 창을 띄우고 `pnpm build`가 매번 `.app`을 만든다. 스펙이 지켜야 하는 "기존 웹 흐름과 공존"이 그 자리에서 깨진다.

| desktop의 스크립트 | 루트 recursive 참여 | 부르는 방법 |
| --- | --- | --- |
| `start:desktop` | 안 함 | `pnpm desktop:dev`가 `--filter`로 부른다 |
| `package:desktop` | 안 함 | `pnpm desktop:build`가 `--filter`로 부른다 |
| `lint`, `test` | **함** | 루트 `pnpm lint`·`pnpm test`에 들어간다. 데스크톱 코드도 같은 관문을 지나야 한다 |

`electron`·`electron-builder`·`typescript`는 **devDependencies**에 둔다. electron-builder가 그 배치를 요구하고, `dependencies`를 비워 두는 것이 §9의 번들 위생 기준을 성립시킨다.

### 6.2 프로세스 소유권 계약

앱이 소유하는 프로세스는 **API 하나**다. DB·worker·embed는 외부 소유이며 앱이 죽이지 않는다.

기동은 `utilityProcess.fork()`로 한다 — Electron이 제공하는 Node 자식 프로세스 API이며, 별도 `node` 바이너리를 번들에 넣지 않아도 된다. `stdio: 'pipe'`로 stdout·stderr를 받아 로그로 남긴다.

`utilityProcess`가 NestJS를 못 띄우는 경우의 대체안은 `child_process.spawn(process.execPath, [script], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })`이다. 어느 쪽을 쓰든 이 계약의 나머지는 같다. 계획의 첫 단계가 이것을 먼저 확인한다.

종료 계약:

- `before-quit`에서 API에 종료를 요청하고, 유예 시간 안에 안 죽으면 강제 종료한다.
- 앱이 죽은 뒤 앱이 만든 프로세스가 남지 않는다 (§9의 P1-C5).
- 외부 소유 프로세스(DB·worker·embed)는 앱 종료 후에도 살아 있어야 한다. 이것도 P1-C5가 함께 판정한다.

**Phase 2와의 경계.** 로드맵은 "정상 종료와 자식 프로세스 정리"를 Phase 2 범위에, "앱이 생성한 자식 프로세스가 종료 후 남지 않음"을 Phase 2 완료 기준에 둔다. 그것과 이 절은 범위가 다르다.

| | Phase 1 (이 스펙) | Phase 2 |
| --- | --- | --- |
| 대상 | 앱이 만든 **자식 하나**(API) | DB·worker·embed까지 포함한 전체 |
| 다루는 것 | 요청 → 유예 → 강제의 단일 절차, 무잔존 | 의존 역순 종료, 시작 순서, 재시작, 로그 관리 |
| 다루지 않는 것 | 창 닫기와 앱 종료 구분, 녹음·분석 중 종료 정책 | — |

Phase 1이 자식을 만들면서 그 정리를 Phase 2로 미루면 Phase 1 산출물이 프로세스를 흘린다. 그래서 **자기가 만든 것의 정리는 Phase 1이 지고**, 그것을 여러 서비스로 확장하는 일이 Phase 2다. 로드맵에 이 문장을 넣어 이중 정의를 없앤다 — §16의 산출물에 포함한다.

### 6.3 경로 계약

`<userData>`는 `app.getPath('userData')`이고 `~/Library/Application Support/Damwha`다. 로드맵이 후보로 둔 경로와 같다.

**그 경로가 되게 하려면 `app.setName("Damwha")`를 명시해야 한다.** 2026-09-11 실측: `app.getPath('userData')`는 `productName`이 아니라 `app.getName()`에서 나오고, 그것은 `desktop/package.json`의 `name` 필드(`damwha-desktop`)를 읽는다. 이름을 고정하지 않으면 개발 모드는 `~/Library/Application Support/damwha-desktop/`를, packaged 모드는 electron-builder가 `productName`으로 정한 `Damwha`를 써서 **두 모드가 서로 다른 `config.json`·`storage/`·`logs/`를 갖는다.** P1-C12·P1-C14와 worker의 `STORAGE_ROOT` 합의가 모두 경로가 하나라는 전제에 서 있으므로, `main.ts`가 userData를 처음 읽기 전에 이름을 고정한다.

```
~/Library/Application Support/Damwha/
  config.json      앱이 첫 실행에 기본값으로 만든다
  storage/         config.json의 기본 STORAGE_ROOT
  logs/            API stdout·stderr
```

`config.json`은 **자식 API의 환경변수 오버레이**다. 파일에 있는 키는 그대로 자식 env로 주입되고, 앱이 기본값을 갖는 키는 셋이다.

| 키 | 기본값 | 후속 Phase |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/damwha` | Phase 3이 내장 인스턴스 주소로 바꾼다 |
| `STORAGE_ROOT` | `<userData>/storage` | Phase 5가 이전 결과를 반영한다 |
| `PORT` | `3000` | — |

기본값이 없는 키도 파일에 적으면 주입된다 — `be/src/config/env.ts`가 검증하는 모든 키가 대상이다. 값 자체의 유효성은 API의 zod가 판정하며, 잘못된 값은 기동 실패로 드러난다(P1-C8이 그 경로를 확인한다). 앱은 키 목록을 따로 검증하지 않는다 — 그러면 `env.ts`와 이중 관리가 된다.

`HOST`는 예외로 **파일이 아니라 앱이 고정 주입**한다. 항상 `127.0.0.1`이며 설정으로 열 수 없다(§6.6).

main은 경로 성격의 값을 **절대 경로로** 만들어 자식 API의 env에 넣는다. `be/src/main.ts`의 `import 'dotenv/config'`는 `loadEnv()`보다 먼저 실행되고 이미 설정된 `process.env`를 덮지 않으므로(dotenv 기본 `override: false`), 주입한 값이 `.env`를 이긴다.

어느 `.env`가 읽히는지는 자식의 `cwd`가 결정하므로, 두 모드의 실행 환경을 여기서 고정한다.

| | 개발 (`pnpm desktop:dev`) | packaged |
| --- | --- | --- |
| entrypoint | `nest start --watch` (be 패키지의 `dev` 스크립트) | `Contents/Resources/api/dist/main.js` |
| cwd | `be/` | `Contents/Resources/api/` |
| dotenv가 읽는 파일 | `be/.env` (오늘과 같다) | **없다** — `.env`가 번들에 실리지 않는다 |
| 값의 출처 | `be/.env` + main이 덮어쓰는 `PORT`·`HOST` | 전부 main의 주입 (`config.json` + `PORT`·`HOST`) |
| API 로그 | 터미널 | `<userData>/logs/` |

개발에서 `be/.env`를 살려 두는 이유는 오늘의 값(모델 선택, 임계값, `HF_TOKEN` 등)을 그대로 쓰기 위해서다. 그 파일이 주는 값 중 main이 덮는 것은 `PORT`와 `HOST`뿐이다. packaged에서는 `config.json`에 없는 키는 `be/src/config/env.ts`의 zod 기본값으로 떨어진다.

`STORAGE_ROOT`에 상대 경로가 남으면 `be/src/storage/storage.service.ts:12`의 `path.resolve`가 **`.app` 번들 내부**를 가리킨다. 그래서 주입 값은 절대 경로여야 하고, P1-C12가 그것을 판정한다.

**선행 조건 3번의 이유.** worker는 `be/worker/.env`의 `STORAGE_ROOT=../storage`(= `be/storage`)를 보고, `be/worker/damwha_worker/storage.py`가 API와 같은 규칙으로 키를 해석한다.

DB가 저장하는 것은 **상대 storage key**다 — `meeting.audio_key`(`NOT NULL`)와 `meeting.normalized_key`(`001_init.sql:39-40`). 값은 `be/src/storage/storage.service.ts:22`의 `meetings/<meeting id>/original<ext>` 형태이고 절대 경로가 아니다. 스키마가 그것을 `CHECK`로 강제하지는 않으므로, **상대 키만 저장한다는 것은 서비스 계약**이다. 그래서 API와 worker가 각자의 root에서 같은 키를 해석하며, 두 root가 갈리면 **앱이 올린 파일을 worker가 못 찾아 처리가 조용히 실패한다.**

**맞추는 방향은 worker 쪽이다.** `config.json`의 기본값 `<userData>/storage`를 그대로 두고, 선행 조건으로 `be/worker/.env`의 `STORAGE_ROOT`를 그 절대 경로로 바꾼다. 이 방향을 고른 이유:

- 기본 `config.json`과 검증 경로가 일치한다. 반대 방향은 "기본값으로 실행하면 조용히 실패하는 설정"을 남긴다.
- 앱이 기존 `be/storage`에 **쓰지 않는다.** 데이터 안전 위험(§5)이 구조적으로 사라지고, P1-C14가 그것을 판정한다.
- Phase 3~6이 전제하는 "앱 번들 밖 전용 데이터 폴더"와 같은 모양이다.

대가는 **기존 회의의 오디오가 404**라는 것이다. DB를 공유하므로 회의 목록·전사·요약·검색은 그대로 보이고 재생만 안 된다. 해소는 Phase 5의 이전 절차이며, 그때까지의 알려진 한계로 남긴다. 사용자가 기존 데이터를 보려면 `config.json`의 `STORAGE_ROOT`를 `be/storage` 절대 경로로 바꾸는 길도 열려 있지만, **Phase 1의 검증은 기본값으로 수행한다.**

### 6.4 origin·포트 계약

렌더러는 **API가 서빙하는 origin**을 로드한다. `be/src/main.ts`의 `dist/public` 서빙과 SPA 폴백을 그대로 쓰므로 API base는 `/api`이고 CORS가 관여하지 않는다. `deploy/api.Dockerfile`이 이미 쓰는 조합이다.

포트는 **고정 우선, 점유 시 폴백**이다. 판정은 **자식의 bind 결과**로 한다 — 미리 빈 포트를 찾아 두는 방식은 탐색과 자식의 bind 사이에 다른 프로세스가 그 포트를 가져갈 수 있다.

```
1. config.PORT(기본 3000)로 API를 기동한다
2. 자식이 EADDRINUSE로 죽으면 다음 후보 포트로 재기동한다
3. 최대 N회까지. 넘으면 기동 실패 화면
```

후보 포트를 고르는 방법과 N의 값은 구현 계획이 정한다. `EADDRINUSE`와 다른 기동 실패를 구분해야 하며, 구분하지 못하면 §6.5의 실패 화면이 잘못된 원인을 말한다.

**소유권 판정은 포트가 아니라 자식 프로세스 핸들이다.** 같은 포트에 이미 떠 있는 API는 외부 소유이며 앱이 그것을 자기 것으로 오인하거나 죽이지 않는다. 앱은 자기가 만든 자식의 핸들과 pid만 관리하며, "그 포트에 응답이 있다"를 준비 신호로 쓰지 않는다 — 응답이 외부 API에서 올 수 있다. P1-C10이 이것을 판정한다.

`pnpm dev`가 3000을 쓰고 있어도 앱이 뜬다 — 로드맵의 "기존 웹 개발·실행 흐름과 충돌하지 않음"을 포트 충돌 없이 지난다.

API 포트를 쓰는 것은 렌더러뿐이다. worker는 DB로만 붙고(`be/CLAUDE.md`의 job 테이블 계약), embed는 API가 호출하는 쪽이라 API 포트를 모른다. 그래서 포트가 바뀌어도 다른 서비스에 영향이 없다.

**폴백이 만드는 부작용과 그 처리.** origin이 바뀌면 Chromium의 origin별 상태가 리셋된다.

- **마이크 권한** — macOS TCC 권한은 `.app` 번들 단위라 포트와 무관하게 유지된다. 리셋되는 것은 Chromium의 origin별 허가뿐이고, §6.6의 권한 핸들러가 자기 origin에 자동으로 부여하므로 사용자는 재요청을 보지 않는다.
- **`localStorage`** — 실제 영향은 `fe/src/features/meeting/ui/new-meeting-dialog.tsx:64`의 "마지막에 고른 입력 소스(file/live)" 하나다. 기본값으로 돌아간다. 알려진 한계로 남기고 고치지 않는다.

### 6.5 준비 상태 계약

준비 판정은 `GET /api/health`와 **자식 프로세스의 종료·stderr** 두 신호로 한다. 새 엔드포인트를 만들지 않는다.

**API는 DB에 대해 fail-fast다.** `be/src/database/database.service.ts:34`의 부팅 프로브가 실패하면 `onModuleInit`이 던지고 `be/src/main.ts`의 catch가 `startup failed: database unreachable at <가려진 URL>`을 stderr에 찍고 exit 1한다. 그러므로 **DB가 안 떠 있으면 API는 listen하지 않고, 503은 기동 시점에 관찰되지 않는다.** 503은 부팅 뒤에 DB가 끊긴 경우에만 나온다.

`maskUrl`이 비밀번호를 `***`로 가리므로 그 메시지를 화면에 그대로 올려도 된다.

**이 표는 packaged 모드에서 정확하고, 개발 모드에서는 한 줄이 어긋난다.** 2026-09-11 실측: 개발 모드의 자식은 `nest start --watch`이고, 그 래퍼는 **자기 자식(진짜 API)이 죽어도 살아 있다** — watch 모드의 본래 동작이다. 그래서 개발 모드에서는 `alive()`가 계속 참이라 "자식이 exit 1" 행이 관찰되지 않고, DB 미기동은 `database unreachable` 화면 대신 유예 시간이 다 지난 뒤의 일반 기동 실패 화면으로 나타난다.

packaged 모드에는 이 문제가 없다. `launchPackaged`가 `utilityProcess.fork`로 `dist/main.js`를 **직접** 띄우므로 handle의 수명이 곧 API의 수명이다. 완료 기준 P1-C1~C14는 전부 packaged에서 판정하므로 이 표대로 성립한다.

개발 모드를 맞추려면 `--watch`를 빼야 하는데, 그러면 백엔드 핫 리로드가 사라진다. 개발자 편의 경로를 위해 그 값을 치르지 않는다 — 백엔드를 고치며 일할 때는 기존 `pnpm dev` 웹 흐름이 그대로 있다. 프로세스 오케스트레이션은 Phase 2의 범위이므로, 개발 모드와 packaged 모드의 프로세스 의미를 일치시키는 일은 그쪽에서 다룬다.

| 관찰 | 뜻 | 화면 |
| --- | --- | --- |
| `/api/health` 200 | API 살아 있음, DB 연결됨 | API origin을 로드한다 |
| 자식이 exit 1 + stderr에 `startup failed: database unreachable at …` | **DB 미기동** | 그 원문을 원인으로 보여주고 재시도를 제공한다 |
| 자식이 exit 1 + 그 밖의 stderr | 설정 검증 실패 등 다른 기동 실패 | stderr 마지막 줄과 종료 코드, 로그 경로를 보여준다 |
| 연결 거부 / 무응답, 자식은 살아 있음 | 아직 기동 중 | 유예 시간까지 대기, 넘으면 기동 실패 화면 |
| `/api/health` 503 | 부팅 뒤 DB가 끊김 | "데이터베이스에 연결할 수 없어요" + 재시도 |

기동 순서:

```
1. requestSingleInstanceLock()   실패 → 기존 창 포커스 후 종료
2. <userData> 보장, config.json 읽기 (없으면 기본값으로 생성)
3. 포트 결정
4. BrowserWindow 생성 → 준비 화면 로드
5. API 기동 (절대 경로 env 주입, HOST=127.0.0.1)
6. /api/health 폴링
7. 200 → API origin 로드
   그 밖 → 위 표대로 화면 갱신
```

폴링 간격과 유예 시간의 구체 값은 구현 계획이 정하고, 값과 근거를 결과 문서에 남긴다.

**재시도는 main이 소유한다.** 셸 화면은 `file://`로 뜨는 정적 HTML이고 preload가 없어(§6.6) 렌더러에서 main을 부를 IPC 경로가 없다. 그래서 재시도를 렌더러 버튼으로 만들지 않는다.

| 재시도 경로 | 주체 | 왜 IPC가 필요 없나 |
| --- | --- | --- |
| 자동 재시도 — 실패 후 백오프를 두고 API 기동을 다시 시도 | main | main이 스스로 타이머를 돌린다 |
| 애플리케이션 메뉴의 "다시 시도" 항목 | main | 메뉴는 main 프로세스 소유다 |
| 셸 화면 | 표시만 — 현재 상태, 원인 문장, 다음 자동 재시도까지 남은 시간, 로그 경로 | 상태 변화는 main이 셸을 다시 `loadFile`하거나 쿼리 문자열로 전달한다 |

자동 재시도 횟수·간격과 셸에 상태를 전달하는 방식(재로드 대 쿼리 문자열)은 구현 계획이 정한다. **렌더러에서 main으로 가는 경로를 새로 만들지 않는다**는 것이 계약이다.

### 6.6 보안 경계

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **preload 스크립트를 두지 않는다.** 노출할 것이 없다. `fe/`는 웹·Docker 배포와 공유되므로 Electron 전용 API에 의존하면 그 배포가 깨진다. 렌더러는 순수 웹 코드로 남는다. Phase 2 이후 앱 상태를 화면에 알릴 필요가 생기면 그때 preload를 도입하고, 그 시점에도 `fe/`가 그 API 없이 동작하는 성질은 유지한다.
- API는 `127.0.0.1`에만 바인드한다. main이 `HOST=127.0.0.1`을 주입한다.
- `session.setPermissionRequestHandler`와 `setPermissionCheckHandler` — 자기 origin(packaged의 loopback, 개발의 `localhost:5173`)에만 `media`를 허용하고 그 밖은 전부 거부한다.
- `setWindowOpenHandler` — 새 창을 열지 않고 외부 링크는 기본 브라우저로 넘긴다.
- `will-navigate` — 자기 origin 밖으로 이동하지 않는다.
- `mac.extendInfo`에 `NSMicrophoneUsageDescription`을 넣는다. 없으면 macOS가 마이크 요청 시 앱을 죽인다.

**이 Phase가 닫지 않는 것 — CORS.** `be/src/main.ts:19`의 `app.enableCors()`는 제한이 없고(주석이 "개인용 셀프호스팅 전제"라고 적고 있다) 이 Phase는 그것을 바꾸지 않는다. 근거는 위협 모델이다 — 남은 위협은 **같은 머신의 다른 프로세스**가 loopback API를 부르는 것이고, 그것은 `HOST=127.0.0.1`로도 CORS 정책으로도 막히지 않는다(CORS는 브라우저의 규칙이고 API에는 인증이 없다). 즉 데스크톱 앱이 되면서 새로 생기는 노출이 아니라 기존 웹 실행과 같은 수준이다. 인증·origin 제한은 Phase 6의 배포 보안 검토로 인계한다(§15).

## 7. 사용자 동작

| 동작 | 기대 |
| --- | --- |
| Finder에서 `Damwha.app` 더블클릭 | 창이 뜨고 준비 화면을 지나 담화 화면이 붙는다 |
| 이미 실행 중인데 다시 실행 | 새 창이 아니라 기존 창이 앞으로 온다 |
| 오디오 파일 업로드 | 오늘의 웹과 같다. worker가 처리하고 결과가 화면에 뜬다 |
| 녹음 시작 | 첫 실행에 macOS 마이크 권한을 한 번 묻고, 허가 후 녹음된다 |
| 검색 | 오늘의 웹과 같다 |
| Postgres가 안 떠 있는 상태로 실행 | 원인을 말하는 화면과 재시도 |
| 창 닫기 | 앱이 종료된다. API도 함께 정리된다. Phase 2가 이 동작을 재정의한다 |
| 외부 링크 클릭 | 기본 브라우저가 연다 |

## 8. 실패·복구 동작

| 실패 | 앱의 처리 |
| --- | --- |
| `config.json`이 깨진 JSON | 기본값으로 진행하고 그 사실을 화면과 로그에 남긴다. 파일을 덮어쓰지 않는다 |
| 고정 포트 점유 | 빈 포트로 폴백한다. 사용자에게 알리지 않는다 |
| 빈 포트도 못 잡음 | 기동 실패 화면 |
| API가 유예 시간 안에 준비 안 됨 | 기동 실패 화면 + 로그 경로. 자식 프로세스를 정리한다 |
| API가 `database unreachable`로 exit 1 | 그 원문을 원인으로 보여주고 재시도를 제공한다. 앱을 죽이지 않는다 |
| API가 그 밖의 이유로 exit 1 | 종료 코드와 stderr 마지막 줄을 화면에 보여준다 |
| 부팅 뒤 DB가 끊겨 `/api/health`가 503 | 원인 화면 + 재시도. 앱을 죽이지 않는다 |
| 실행 중 API 프로세스 사망 | 사망을 화면에 알린다. 자동 재시작은 Phase 2 |
| 마이크 권한 거부 | 녹음 기능만 막히고 앱은 계속 쓸 수 있다 |

## 9. 완료 기준

각 기준은 식별자 · 확인 환경 · 확인 방법 · 성공 판정으로 구성한다. **아직 실행되지 않았다.**

"packaged 환경"은 `pnpm desktop:build`로 만든 `Damwha.app`을 Finder에서 실행한 상태를 말한다. `pnpm desktop:dev`가 아니다.

### 축 A — 실사용 동작

**P1-C1. 앱 아이콘 실행과 화면 준비**

- 확인 환경: packaged. 선행 조건 4개 충족.
- 확인 방법: Finder에서 `Damwha.app`을 더블클릭한다. 준비 화면에서 담화 화면으로 넘어가는지 본다.
- 성공 판정: 창이 뜨고, 준비 화면을 지나 회의 목록이 있는 담화 화면이 렌더된다. 터미널에서 아무 명령도 실행하지 않았다.

**P1-C2. 업로드와 처리**

- 확인 환경: packaged. worker·embed 실행 중.
- 확인 방법: 앱에서 오디오 파일로 회의를 만들고 처리가 끝날 때까지 둔다.
- 성공 판정: `job` 행이 생기고 worker가 집어 처리하며, 전사 결과가 앱 화면에 뜬다. 앱이 쓴 파일을 worker가 찾는다 — §6.3의 경로 합의가 실제로 성립했다는 뜻이다.

**P1-C3. 녹음**

- 확인 환경: packaged. 마이크 권한 미허가 상태에서 시작한다.
- 확인 방법: 라이브 녹음을 시작한다. macOS 권한 대화상자에 허가한다. 녹음하고 중단한다.
- 성공 판정: 권한 대화상자가 `NSMicrophoneUsageDescription` 문구와 함께 뜨고, 허가 후 `fe/src/features/meeting/lib/live-recorder.ts` 경로가 동작해 라이브 회의가 만들어지며 결과가 나온다. 앱이 죽지 않는다.

**P1-C4. 검색**

- 확인 환경: packaged.
- 확인 방법: 결과가 있는 회의를 대상으로 검색어를 넣는다.
- 성공 판정: 키워드·의미 양쪽이 섞인 결과가 반환된다. API가 embed 서비스에 붙었다는 뜻이다.

### 축 B — 프로세스 소유권

**P1-C5. 자식 프로세스 정리와 외부 프로세스 보존**

- 확인 환경: packaged.
- 확인 방법: 앱 실행 전 프로세스 목록을 기록한다. 앱을 실행하고 API가 뜬 것을 확인한 뒤 종료한다. 종료 후 목록을 다시 기록한다.
- 성공 판정: 앱이 만든 프로세스가 종료 후 **0개** 남는다. DB·worker·embed는 종료 전과 같이 살아 있다. 앱이 만든 것과 외부 것을 구분해 판정한 근거를 증거에 적는다.

**P1-C6. 중복 실행 방지**

- 확인 환경: packaged.
- 확인 방법: 실행 중인 상태에서 다시 실행한다.
- 성공 판정: 두 번째 인스턴스가 창을 만들지 않고 종료하며, 기존 창이 포커스를 받는다. API 프로세스가 둘로 늘지 않는다.

### 축 C — 실패 표시

**P1-C7. DB 미기동 시 원인 표시**

- 확인 환경: packaged. `pnpm db:down` 상태.
- 확인 방법: 앱을 실행한다. 그 뒤 `pnpm db:up`으로 DB를 띄우고 재시도한다.
- 성공 판정: DB에 연결할 수 없다는 뜻이 화면에 나오고(빈 화면·무한 로딩·JS 오류가 아니다), API가 찍은 `database unreachable at …` 원문을 확인할 수 있으며, 로그 위치를 알 수 있고, DB가 뜬 뒤 재시도로 정상 화면에 도달한다.
- 비고: API가 fail-fast라 이 경우 자식은 exit 1로 죽는다(§6.5). 503이 아니라 **종료 코드와 stderr**로 판정되는 것이 정상이다.

**P1-C8. 다른 기동 실패 시 원인 표시**

- 확인 환경: packaged. `config.json`의 `SUMMARY_LLM_MODEL`을 카탈로그(`be/src/contracts/model-catalog.ts`) 밖 값으로 바꾼다 — `be/src/config/env.ts`가 의도적으로 기동을 실패시키는 값이다.
- 확인 방법: 앱을 실행한다.
- 성공 판정: 기동 실패가 화면에 나오고 stderr 마지막 줄과 종료 코드를 볼 수 있다. 그 문안이 P1-C7의 DB 문안과 **다르다** — main이 고정 문구를 쓰지 않고 실제 stderr를 올린다는 뜻이다. 자식 프로세스가 남지 않는다. 확인 후 `config.json`을 원복한다.

### 축 D — 경계

**P1-C9. 로컬 바인드**

- 확인 환경: packaged. API 실행 중.
- 확인 방법: API가 어느 주소에 바인드했는지 확인한다. 같은 머신의 비-loopback 주소로 접속을 시도한다.
- 성공 판정: 바인드 주소가 `127.0.0.1`이고 비-loopback 접속이 실패한다.

**P1-C10. 포트 폴백**

- 확인 환경: packaged. `pnpm dev`로 3000을 점유한 상태.
- 확인 방법: 앱을 실행한다. 앱이 어느 포트를 쓰는지, 그 포트를 누가 bind했는지 확인한다. 앱을 종료한다.
- 성공 판정: 앱이 3000이 아닌 포트로 뜨고 정상 동작한다. 마이크 권한을 **다시 묻지 않는다**(§6.4). 점유하던 `pnpm dev`의 API가 앱 종료 후에도 살아 있다 — 앱이 3000의 외부 API를 자기 것으로 오인하지 않았다는 뜻이다.

**P1-C11. 번들 위생**

- 확인 환경: `pnpm desktop:build` 산출물.
- 확인 방법: `desktop/package.json`의 `dependencies`를 확인한다. `app.asar` 목록에서 `node_modules`를 찾는다. `Contents/Resources/api/` 아래 심볼릭 링크를 전수 나열하고 각 링크의 최종 대상이 `api/` 트리 안인지 본다. `Contents/` 전체에서 저장소 절대 경로와 pnpm store 경로 문자열을 찾는다.
- 성공 판정: `dependencies`가 비어 있고, `app.asar` 안에 `node_modules`가 없고, **`api/` 트리 밖을 가리키는 심볼릭 링크가 0건**이며, 저장소 경로·pnpm store 경로 문자열이 0건이다.
- 비고: 트리 **안**을 가리키는 상대 심볼릭 링크(예: `node_modules/.bin`)는 위반이 아니다. 재배치를 깨는 것은 트리를 벗어나는 링크다. `--config.node-linker=hoisted`로 링크 자체를 없애도 되고, 어느 쪽을 썼는지 증거에 적는다.
- 근거: electron-builder의 pnpm 관련 알려진 실패는 앱 패키지의 prod 의존성을 훑을 때 나온다. 훑을 것이 없으면 걸리지 않는다. API 트리는 `pnpm deploy` 산출물을 `extraResources`로 통째 복사하므로 electron-builder가 의존성을 해석하지 않는다.

**P1-C12. 경로 위생**

- 확인 환경: packaged. 실행 중.
- 확인 방법: 자식 API에 주입된 `STORAGE_ROOT`·`DATABASE_URL`이 절대값인지 확인한다. 업로드를 한 번 하고 `.app` 번들 안에 새 파일이 생겼는지 확인한다.
- 성공 판정: 주입값이 모두 절대 경로·절대 주소다. `.app` 번들 내부에 쓰기가 0건이다. 새 파일은 `STORAGE_ROOT` 아래에만 생긴다.

### 축 E — 회귀와 데이터 보존

**P1-C13. 기존 웹 흐름 회귀 없음**

- 확인 환경: 앱을 실행하지 않은 상태.
- 확인 방법: `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`를 루트에서 돌린다. `pnpm dev`로 API와 Vite를 띄우고 브라우저에서 업로드·검색을 해 본다. `docker build -f deploy/api.Dockerfile .`이 성공하는지 본다.
- 성공 판정: 네 스크립트가 데스크톱 패키지 추가 전과 같이 통과하고, 브라우저 흐름이 동작하며, 이미지 빌드가 성공한다. `pnpm dev`가 Electron 창을 띄우지 않고 `pnpm build`가 `.app`을 만들지 않는다(§6.1). `.npmrc`는 변경되지 않았다.

**P1-C14. 기존 데이터 보존**

- 확인 환경: packaged. §5의 규칙 전체를 대상으로 한다.
- 확인 방법: 앱을 처음 실행하기 **전에** `be/storage` 전체의 파일 목록과 체크섬을 떠 둔다. `meeting` 행 수와 `utterance` 행 수도 기록한다. 그 뒤 P1-C1~C4를 수행한다(새 회의 업로드·처리·검색, 녹음 1건 포함). 끝난 뒤 같은 목록·체크섬·행 수를 다시 뜬다. `docker compose -f be/docker-compose.yml config`의 `name`과 볼륨 이름도 전후로 비교한다.
- 성공 판정: `be/storage`의 파일 목록과 체크섬이 **한 건도 다르지 않다** — 앱이 그 트리에 쓰지 않았다는 뜻이다. 기존 `meeting`·`utterance` 행이 하나도 줄지 않았다(새 행은 늘어난다). compose `name`이 `damwha`이고 볼륨이 `damwha_pgdata`로 그대로다. `_migrations` 행 수가 변하지 않았다 — 앱이 마이그레이션을 실행하지 않았다.
- 근거: §5의 규칙은 검증되지 않으면 규칙이 아니다. 이 저장소에서 실제로 발생한 사고가 데모 시드가 `be/storage`의 원본 오디오를 덮어쓴 건이라, 그 트리에 대한 무변경 판정을 명시적으로 둔다.

## 10. 제품 코드 변경 목록

`desktop/` 신설과 `pnpm-workspace.yaml`·루트 `package.json` 스크립트 추가 외에, 기존 코드 변경은 이 셋뿐이다.

**`be/src/config/env.ts`** — `HOST` 추가.

```ts
HOST: z.string().default('0.0.0.0'),
```

기본값이 `0.0.0.0`이라 `deploy/api.Dockerfile`로 만든 이미지와 `pnpm be:dev`의 동작이 바뀌지 않는다.

**`be/src/main.ts`** — 바인드 host 전달.

```ts
await app.listen(env.PORT, env.HOST);
```

로그 줄도 host를 포함하게 고친다.

**`be/package.json`** — `files` 허용 목록 추가.

```json
"files": ["dist"],
```

2026-09-11 실측으로 추가된 항목이다(§11). `pnpm deploy`가 `pnpm pack`의 파일 선택 규칙을 따르므로, 허용 목록이 없으면 산출 트리가 `be/.gitignore`가 무시하는 `dist/`를 빠뜨리고 `src`·`test`·`docs`·`docker`와 Python `worker/` 트리를 대신 앱 번들에 넣는다. `be`는 `private: true`라 발행되지 않고 `files`는 pack·publish·deploy에만 작용한다 — `deploy/api.Dockerfile`은 `COPY be ./be`로 디렉터리를 그대로 복사하므로 영향이 없고, 워크스페이스 링크도 영향이 없다.

`fe/` 소스는 변경하지 않는다. 값 주입만 한다 — packaged 빌드는 `VITE_API_BASE_URL=/api`, 개발 실행은 결정된 포트를 담은 절대 URL.

## 11. 빌드와 실행 흐름

루트에 `desktop:dev`와 `desktop:build`를 추가한다. 둘 다 `--filter`로 `damwha-desktop`의 `start:desktop`·`package:desktop`을 부른다 — `dev`·`build` 이름을 쓰지 않는 이유는 §6.1에 있다.

```
pnpm desktop:dev
  main이 포트를 결정
  → API 기동        (nest start --watch, PORT·HOST·절대 경로 주입)
  → Vite 기동       (VITE_API_BASE_URL=http://127.0.0.1:<port>/api 주입)
  → http://localhost:5173 로드

pnpm desktop:build
  1. pnpm be build
  2. pnpm fe build                     VITE_API_BASE_URL=/api
  3. pnpm --filter=damwha-be --prod \
       --config.inject-workspace-packages=true deploy desktop/build/api
  4. fe/dist → desktop/build/api/dist/public 복사
  5. electron-builder --dir            desktop/build/api → Resources/api
```

`pnpm deploy`는 pnpm 10.26.0에서 **Experimental**이다. 2026-09-11 실측(결과 문서의 Task 2)으로 두 가지가 확정됐다.

- 맨 `--prod deploy`는 `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`로 **거절당한다.** `--config.inject-workspace-packages=true`가 필요하다. 플래그는 이 명령에만 붙으므로 **루트 `.npmrc`는 고치지 않는다** — 그 파일의 주석이 hoisting 금지를 명시하고 있고, 여기서 필요한 것은 저장소 전체가 아니라 이 한 산출물이다.
- `pnpm deploy`는 `pnpm pack`의 파일 선택 규칙을 따른다. 그래서 허용 목록이 없으면 `be/.gitignore`가 무시하는 `dist/`가 **트리에서 빠지고** `src`·`test`·`docs`·`docker`와 Python `worker/` 트리가 대신 들어온다. `be/package.json`에 `"files": ["dist"]`를 넣어 고친다 — 이것이 §10의 세 번째 변경이다.

산출 트리의 심볼릭 링크는 379개이고 트리 밖을 가리키는 것은 0건이다. 단, 그 판정은 기준 경로를 **realpath한 뒤에만** 옳다 — macOS의 `/tmp`가 `/private/tmp` 심볼릭이라 문자열 접두사로 비교하면 트리 안의 링크가 거짓 위반으로 잡힌다. P1-C11의 검사가 `fs.realpathSync`와 `path.relative`를 쓰는 이유가 이것이다.

Vite는 셸 환경변수가 `.env` 파일을 이기므로, 개발에서 포트가 폴백돼도 렌더러가 옳은 주소를 본다.

3번 뒤에 4번을 두는 이유는 `be build`(`nest build`)가 `dist`를 비울 수 있어서다. `pnpm deploy` 산출 트리에 SPA를 넣으면 순서 의존이 사라진다.

`pnpm dev`, `pnpm be:*`, `pnpm fe:*`는 손대지 않는다.

## 12. 미확정 사항

구현에 영향을 주는 것은 계획 작성 전에 닫는다.

| 항목 | 성격 | 언제 닫히나 |
| --- | --- | --- |
| `utilityProcess.fork`로 NestJS가 뜨는가 | 기술 위험 | 계획 1단계에서 실측. 실패 시 `ELECTRON_RUN_AS_NODE` 대체안 |
| `pnpm deploy`가 `@damwha/contracts` workspace 의존을 실제 파일로 푸는가 | 기술 위험 | 계획 1단계에서 산출 트리 실행 검증 |
| `pnpm deploy`를 기본 구현·`--legacy`·`--config.node-linker=hoisted` 중 무엇으로 부르는가 | 구현 값 | 계획 1단계에서 산출 트리를 비교해 정하고 결과 문서에 고정 기록 |
| pnpm 10이 `electron` 설치 스크립트를 차단하는가 | 설정 | `pnpm install` 첫 실행에서 확인. 차단되면 루트 `package.json`에 `pnpm.onlyBuiltDependencies`를 추가한다 (현재는 `ignoredBuiltDependencies`만 있다) |
| health 폴링 간격·유예 시간 | 구현 값 | 계획에서 정하고 근거를 결과 문서에 남긴다 |
| 자동 재시도 횟수·간격, 셸에 상태를 전달하는 방식(재로드 대 쿼리 문자열) | 구현 값 | 계획에서 정한다. 렌더러→main 경로를 만들지 않는다는 계약은 §6.5에서 이미 닫혔다 |
| 폴백 후보 포트를 고르는 방법과 재시도 횟수 N | 구현 값 | 계획에서 정한다. `EADDRINUSE`를 다른 기동 실패와 구분하는 방법을 함께 정한다 |
| 준비·오류 화면의 구체 문안과 시각 언어 | 구현 세부 | 구현 단계. `fe/DESIGN.md`의 톤을 따른다 |
| 앱 아이콘 | 구현 세부 | Phase 1은 자리를 만들고 임시 아이콘을 둔다. 최종 아이콘은 Phase 6 |
| 지원 최소 macOS 버전 | Phase 0 미결 | Phase 6. 이 Phase는 개발 머신에서만 검증한다 |

## 13. 기술 위험

| 식별자 | 위험 | 관찰 방법 | 대응 |
| --- | --- | --- | --- |
| R1-1 | `utilityProcess`가 NestJS의 데코레이터·`reflect-metadata` 초기화에서 깨진다 | 1단계 실측 | `ELECTRON_RUN_AS_NODE` + `child_process.spawn` |
| R1-2 | `pnpm deploy` 트리에서 `@damwha/contracts`가 심볼릭으로 남거나 `dist`가 빠진다 | P1-C11, 1단계 실행 검증 | 빌드 순서 조정. 필요하면 `prepare` 산출물을 명시 복사 |
| R1-9 | `pnpm deploy`가 Experimental이라 pnpm 판올림에서 동작이 바뀐다 | **2026-09-11 실측으로 해소** — 필요한 조합은 `--config.inject-workspace-packages=true` + `be/package.json`의 `files` 허용 목록이다(§11). 루트 `.npmrc`는 손대지 않았다. 판올림 시 이 조합을 다시 재야 한다 | 결과 문서 Task 2에 명령과 출력을 고정 기록 |
| R1-3 | `nest build`가 `dist`를 비워 `dist/public`이 사라진다 | 빌드 후 파일 확인 | §11의 순서 고정 |
| R1-4 | packaged cwd가 `.app` 안이라 상대 경로가 번들 내부를 가리킨다 | P1-C12 | 모든 경로를 절대값으로 주입 |
| R1-5 | electron-builder가 pnpm isolated 레이아웃에서 의존성을 못 찾는다 | P1-C11 | `dependencies`를 비운 상태 유지. `.npmrc`는 고치지 않는다 |
| R1-6 | 포트 폴백 후 마이크 권한이 다시 요청된다 | P1-C10 | §6.6의 권한 핸들러가 자기 origin에 자동 부여 |
| R1-7 | 앱과 worker의 `STORAGE_ROOT`가 갈려 처리가 조용히 실패한다 | P1-C2 | 선행 조건 3번 — worker를 앱 값에 맞춘다. §6.3에 방향의 근거 |
| R1-10 | `EADDRINUSE`를 다른 기동 실패와 구분하지 못해 실패 화면이 잘못된 원인을 말하거나, 포트 폴백이 무한 반복된다 | P1-C8, P1-C10 | 재시도 상한 N. 구분 방법을 계획에서 확정 |
| R1-11 | 앱이 같은 포트의 외부 API를 자기 자식으로 오인해 그것을 죽이거나 준비 완료로 오판한다 | P1-C5, P1-C10 | 소유권을 자식 프로세스 핸들로만 판정한다(§6.4) |
| R1-8 | `sandbox: true`가 렌더러의 `getUserMedia`나 파일 선택을 막는다 | P1-C3, P1-C2 | 막히면 어느 옵션이 원인인지 좁혀 기록하고, 경계를 최소로만 완화한다 |

## 14. 로드맵 완료 기준과의 대응

| 로드맵 Phase 1 완료 기준 | 이 스펙의 기준 |
| --- | --- |
| 앱 아이콘으로 실행하여 업로드·녹음·검색 가능 | P1-C1, P1-C2, P1-C3, P1-C4 |
| DB와 worker·embed는 기존 환경에서 실행해 사용 | §4.3 선행 조건, P1-C5의 외부 프로세스 보존 |
| 기존 웹 개발·실행 흐름과 충돌하지 않음 | P1-C10, P1-C13, P1-C14 |

로드맵 Phase 1 범위 중 "앱 중복 실행 방지, 로컬 통신 경계, 마이크 권한 처리"는 P1-C6·P1-C9·P1-C3이, "실행 파일·사용자 데이터 경로와 서비스 실행 계약의 기반 정의"는 §6.2·§6.3과 P1-C11·P1-C12가 받는다.

## 15. 후속 Phase에 넘기는 것

- **Phase 2** — §6.2의 프로세스 소유권 계약 위에 DB·worker·embed를 얹는다. 창 닫기와 앱 종료 구분, 녹음·분석 중 종료 정책, 자동 재시작, 로그 관리를 정의한다. 이 Phase가 단순하게 둔 `window-all-closed` → `app.quit()`을 재정의한다.
- **Phase 3** — `config.json`의 `DATABASE_URL`을 내장 인스턴스 주소로 바꾼다. `extraResources`에 PostgreSQL 번들을 추가한다.
- **Phase 4** — `extraResources`에 Python·ML·ffmpeg 번들을 추가하고 worker·embed의 실행 경로를 그쪽으로 돌린다.
- **Phase 5** — 기존 `be/storage`의 녹음을 `<userData>/storage`로 옮기는 이전 절차. §6.3이 남긴 "기존 회의의 오디오가 404"가 여기서 풀린다.
- **Phase 6** — `electron-builder.yml`의 `mac.target`을 `dmg`로 올리고 서명·공증·자동 업데이트를 붙인다. 최종 아이콘과 지원 최소 macOS 버전을 확정한다. **`app.enableCors()`의 무제한 정책과 API 인증 부재**를 배포 보안 검토에서 다룬다(§6.6) — 다른 사람의 맥에 설치되는 시점에 위협 모델이 달라진다.

## 16. 산출물

- `desktop/` 패키지와 그 안의 main 프로세스 모듈, 셸 화면. preload는 없다(§6.6).
- `pnpm-workspace.yaml`, 루트 `package.json`에 `desktop:dev`·`desktop:build` 추가.
- **로드맵 갱신** — Phase 1과 Phase 2의 프로세스 정리 경계를 한 문장으로 명시해 §6.2의 표가 가리키는 이중 정의를 없앤다.
- `be/src/config/env.ts`, `be/src/main.ts` 변경 2건.
- `desktop/electron-builder.yml`.
- 결과 문서 `docs/superpowers/reports/2026-09-11-electron-phase-1-app-foundation-results.md` — 스펙 리뷰, 계획 검증, 단계별 실행·리뷰, 최종 검증을 구분해 기록한다.
- 로드맵의 Phase 1 상태 갱신.
