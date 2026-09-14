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

- postmaster에는 SIGINT(fast)·SIGQUIT(immediate)만. `pg-handle.ts`의 신호 타입이 SIGKILL을 막는다.
- 앱이 지우는 것은 넷뿐 — `data/postgres.initdb-*`, 증명한 낡은 락, 5개 초과 백업, `*.dump.partial`. 거부 경로는 아무것도 만들거나 지우지 않는다.
- 마이그레이션 실패·페어링 거부 같은 `manual` 실패는 자동 재시도하지 않는다(`retry-policy.ts`, 창 재열기도 재시도하지 않는다 — `window-flow.ts`). 메뉴의 "다시 시도"만 다시 돈다.
- `desktop/package.json`의 `dependencies`는 비어 있다(번들 위생). DB에는 번들 `psql`·`pg_controldata`와 `migrate.js`로만 묻는다.
- `main.ts`는 electron을 값으로 import해 vitest가 부를 수 없다. 판단은 테스트 가능한 모듈로 빼고 `main.ts`에는 배선만 남긴다.
