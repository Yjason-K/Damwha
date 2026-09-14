# desktop/ — Damwha macOS 앱 (Electron)

Electron main이 네 서비스를 감독한다 — 번들 PostgreSQL, NestJS API(자식), worker·embed(`uv run`, Phase 4 전까지 저장소 체크아웃). 설계는 Phase별 스펙에 있다:
[Phase 1](../docs/superpowers/specs/2026-09-11-electron-phase-1-app-foundation-design.md) ·
[Phase 2](../docs/superpowers/specs/2026-09-12-electron-phase-2-service-orchestration-design.md) ·
[Phase 3](../docs/superpowers/specs/2026-09-14-electron-phase-3-embedded-postgres-design.md).

## 명령

```bash
pnpm desktop:dev     # build-postgres.sh(캐시) → tsc → electron .
pnpm desktop:build   # build-postgres.sh → be·fe build → pnpm deploy → electron-builder → ad-hoc 서명 → check-bundle
bash desktop/scripts/build-postgres.sh [--fresh]   # 내장 PG만. 캐시는 desktop/.cache/postgres (gitignore)
```

루트 `pnpm build`·`pnpm dev`는 PG를 빌드하지 않고 Electron을 띄우지 않는다.

## 구조 — `src/`는 "무슨 일을 맡는가"로 나눈다

| 경로 | 맡는 일 |
| --- | --- |
| `main.ts` | Electron 초기화와 이벤트 배선. 앱 상태도 아직 여기 있다 |
| `app/` | 앱 전체의 시작·복구·종료 흐름 — 종료·창 닫기 흐름(`quit-flow`), 창 재열기(`window-flow`), 재시도 정책, 스폰 가드 |
| `windows/` | 창과 화면 — 셸·상태 창, 화면 판정(`shell-url`·`status-view`), 메뉴, 권한·출처 경계, 렌더러 왕복(`recording-bridge`) |
| `services/` | 서비스별 정책과 감독 — `supervisor`, api·worker·embed 스펙, `postgres/`(레이아웃·핸들·페어링·마이그레이션) |
| `process/` | 서비스들이 함께 쓰는 실행·조회 도구 — 핸들 타입, 출력 싱크, uv 런처, 도구 러너, 프로세스 트리·포트·실행 파일 탐색, 준비 프로브 |
| `config/` | `config.json` 읽기·재로딩, DB URL 마스킹, 저장소 루트 판정 |
| `diagnostics/` | 로그 회전, stderr 요약, 원인 목록(`causes`) |
| `dev/` | dev 전용 — Vite 자식 |

- 순수한가가 아니라 책임으로 나눈다. electron을 쓰는 `windows/shell-window.ts`와 순수 판단인 `windows/shell-url.ts`가 같은 폴더다. 테스트 가능성은 **파일** 단위 분리로 지킨다(아래 "지키는 것"의 마지막 줄).
- 한 서비스가 다른 서비스의 파일을 import하지 않는다(공통인 `types`·`failure`와 스펙을 조립하는 `specs`는 예외). 둘 이상이 쓰게 되면 `process/`로 꺼낸다 — `launchWithUv`·`makeSink`가 그렇게 worker·api에서 나왔다. `process/`는 `services/types`의 타입 말고는 서비스를 모른다.
- `tests/`는 `src/`와 같은 트리다(`tests/services/postgres/handle.test.ts` ↔ `src/services/postgres/handle.ts`). 테스트가 `__dirname`으로 `shell/`·`build/`·`../fe`를 읽으므로 옮기면 그 깊이도 고친다.

## 데이터 위치 — dev와 packaged가 **같은** 곳을 쓴다

`~/Library/Application Support/Damwha` (`main.ts`의 `app.setName("Damwha")`). 클러스터도 하나다 — dev는
`desktop/build/postgres`, packaged는 `Resources/postgres`의 바이너리로 같은 PGDATA를 연다.

| 경로 | 무엇 |
| --- | --- |
| `data/postgres/` | 내장 클러스터 (PGDATA) |
| `data/storage/` | 그 클러스터와 짝인 파일 저장소. `.damwha-cluster` 마커가 짝을 증명한다 — 지우거나 옮기면 앱이 기동을 거부한다 |
| `run/` | 소켓 디렉터리(0700). TCP는 열지 않는다 |
| `backups/` | 데이터가 있는 DB에 마이그레이션을 적용하기 전의 `pg_dump -Fc`, 최근 5개 |
| `logs/` | `supervisor.log`·`api.log`·`worker.log`·`embed.log`·`postgres.log`(초기 stderr), `postgres/`(서버 로그) |
| `storage/` | Phase 1·2가 Docker DB와 쓴 파일. 앱은 읽지도 쓰지도 않는다 (Phase 5가 옮긴다) |
| `config.json` | 사람이 고치는 설정. 앱은 다시 쓰지 않는다(`REPO_ROOT` 저장 제외). 손으로 고친 뒤 JSON이 유효한지 확인한다 |

파괴적인 실험(DB 삭제·`PG_VERSION` 변경 등)은 앱을 끄고 `ditto data data.<이름>-backup`으로 통째로 복사한 뒤에만 한다 —
dev와 packaged가 같은 클러스터라 버려도 되는 "dev 클러스터"가 따로 없다.

## 디버깅

- 내장 DB 접속: 상태 창(메뉴 → 서비스 → 서비스 상태)의 데이터베이스 줄에 명령이 있다 — `"<번들>/bin/psql" -h "<userData>/run" -U damwha damwha`.
- 거부·실패 사유: 기동(`launch`) 실패는 `supervisor.log`에 `기동 실패 — …`로 남는다. 준비 판정(판정표 2) 거부는 화면에만 뜨고 로그에는 상태 줄만 남는다. 마이그레이션 러너의 출력 전체는 `supervisor.log`에 있다.
- Docker 개발 DB에 붙여 재현: `config.json`에 `"DEBUG_EXTERNAL_DATABASE_URL": "postgres://postgres:postgres@localhost:5432/damwha"`. 내장 PG를 띄우지 않고, 마이그레이션은 **감지만** 하며, 상태 창에 `외부 DB(디버깅)`이 상시 뜬다. 모드 변경은 앱을 다시 켜야 반영된다. 이 모드에서도 worker는 기동하며 `app_setting.worker_capabilities`를 그 DB에 쓴다.

## 지키는 것

- postmaster에는 SIGINT(fast)·SIGQUIT(immediate)만. `services/postgres/handle.ts`의 신호 타입이 SIGKILL을 막는다.
- 앱이 지우는 것은 넷뿐 — `data/postgres.initdb-*`, 증명한 낡은 락, 5개 초과 백업, `*.dump.partial`. 거부 경로는 아무것도 만들거나 지우지 않는다.
- 마이그레이션 실패·페어링 거부 같은 `manual` 실패는 자동 재시도하지 않는다(`app/retry-policy.ts`, 창 재열기도 재시도하지 않는다 — `app/window-flow.ts`). 메뉴의 "다시 시도"만 다시 돈다.
- `desktop/package.json`의 `dependencies`는 비어 있다(번들 위생). DB에는 번들 `psql`·`pg_controldata`와 `migrate.js`로만 묻는다.
- `main.ts`는 electron을 값으로 import해 vitest가 부를 수 없다. 판단은 테스트 가능한 모듈로 빼고 `main.ts`에는 배선만 남긴다.
