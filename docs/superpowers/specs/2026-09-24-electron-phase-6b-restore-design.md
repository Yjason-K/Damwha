# Electron Phase 6b-2 — 업데이트 전 스냅샷·되돌리기·실패 복구 (구현 스펙)

작성일: 2026-09-24
브랜치: `feat/electron-migration-phase-6b-restore`
선행: Phase 6b-3 병합 (PR #31, `dev` = `ad82f2d`). 발행된 최신 릴리스 `desktop-v0.3.1`(마이그레이션 `025`까지).

## 1. 목표

**업데이트가 실패하거나 새 판을 쓸 수 없을 때, 앱 안의 정해진 절차로 업데이트 직전의 데이터와 실행
상태로 돌아갈 수 있게 한다. 이전 판(0.3.1 포함)을 다시 설치해 쓰는 데까지가 한 절차다.**

로드맵 6b 완료 기준의 남은 한 줄 — "업데이트 실패 시 정의된 복구 절차로 데이터와 실행 상태 복구
가능" — 을 채운다. 다른 한 줄("이전 버전에서 업데이트해도 회의 기록과 설정 유지")은 6b-3 C1에서
충족됐다. 이 브랜치가 병합되면 v0.4.0을 낸다(릴리스 자체는 범위 밖).

지금 있는 것은 마이그레이션 직전 `pg_dump -Fc` 하나다(`migration-gate.ts`). 검증은 `pg_restore
--list`까지이고, 복원 절차·UI는 없으며, 복원은 한 번도 해 본 적이 없다. 0.3.1은 새 스키마를
만나면 기동을 거부할 뿐(6b-3 C4) 스스로 되돌릴 수 없고 고칠 수도 없다 — **되돌리는 길은 0.4.0 안에
있거나 수동 절차뿐이다.**

## 2. 범위

### 2.1 포함

- **판올림 스냅샷**: packaged 앱의 빌드 식별자가 `data/`에 적힌 것과 다르면, postmaster를 띄우기
  전에 `data/`(postgres·storage)를 APFS clone으로 통째로 뜬다(§5).
- **되돌리기**: 앱 메뉴 "업데이트 전으로 되돌리기…" → 확인 → 저널 기록 → 재시작 → 기동 초기에 교체
  → 보류 대화상자(§6·§7).
- **중단 복구**: 교체가 어느 단계에서 끊겨도 다음 기동이 저널로 이어서 마친다. `data/`가 없어도
  저널이 있으면 `initdb`하지 않는다(§6.3).
- **업그레이드 시작 덤프의 고정 보존**: 마이그레이션 실패 뒤의 재시도가 업그레이드 전 덤프를 밀어내지
  않게 한다 — 지금 코드에 있는 결함이다(§8).
- **수동 절차 문서** `docs/RESTORE.md`: 앱이 메뉴까지 못 갈 때의 터미널 절차와, 최후 수단으로 덤프
  복원(§3 스파이크 P2d 방식)(§9).
- 삭제 계약의 확장(`desktop/CLAUDE.md` "지키는 것")(§10).

### 2.2 제외 — 그리고 어디로 가나

| 제외 | 이유 |
| --- | --- |
| 다른 맥으로의 데이터 이전 | 로드맵이 "필요해지면"이라 적었고 요청이 없다. 스냅샷 디렉터리가 자기완결적이라(§5.2) 나중의 이전을 막지 않는다 |
| PostgreSQL 메이저 업그레이드(`pg_upgrade`) | 0.4.0은 16 그대로다. 스냅샷은 `PG_VERSION`이 다르면 복원 대상에서 뺀다(§6.1) |
| 토큰·키체인·TCC·모델 되돌리기 | `data/` 밖이고 판과 결합돼 있지 않다. 대화상자가 "그대로 유지"라고 말한다(§7.2) |
| 덤프 복원 UI | DB만 되감으면 시퀀스가 되돌아가 스토리지의 `meetings/mtg_N`과 번호가 충돌한다(§3). 스냅샷이 같은 일을 짝째로 한다. 덤프 복원은 수동 절차에만 둔다 |
| 사전 여유 공간 점검 | clone의 실제 소모가 MB 단위다(§3 P3). 실패는 그대로 표면화한다(§5.4) |
| 외부 DB 모드(`DEBUG_EXTERNAL_DATABASE_URL`)의 스냅샷·되돌리기 | 앱이 그 DB를 소유하지 않는다. 메뉴를 비활성으로 두고 이유를 말한다 |

## 3. 선행 사실 — 스파이크 (2026-09-24, 버린 코드)

번들 PG16 바이너리(`desktop/build/postgres`)로 scratchpad의 사본과 임시 소켓 위에서 쟀다. 실데이터와
6b-3 복구 세트는 건드리지 않았다.

| # | 확인한 것 | 결과 |
| --- | --- | --- |
| P1 | 6b-3 C1이 남긴 실물 `20260924T084933Z-before-026_job_interruptions.sql.dump`를 새 클러스터에 복원 | 1.2초, rc=0. vector 0.8.6·pg_bigm 1.2가 함께 생성되고 `_migrations`는 `025`에서 끝난다 |
| P1' | 알려진 클러스터 → `pg_dump -Fc` → 새 클러스터 복원 | 모든 테이블 내용 해시·시퀀스·확장·인덱스·제약·함수 **완전 일치** |
| P2a | 제자리 `pg_restore --clean --if-exists` | oid 유지, `026` 되감김. **그러나 덤프에 없는 객체(뒤에 만든 테이블)가 남는다** → 재업그레이드가 `already exists`로 깨질 수 있다 |
| P2b | `DROP`/`CREATE DATABASE` 뒤 복원 | 내용 일치, **oid 16384 → 20925** → 판정표 2 `database-recreated` 거부 |
| P2c/d | 같은 DB에서 한 트랜잭션: `drop schema public cascade; create schema public authorization pg_database_owner; grant usage on schema public to public;` + `pg_restore -f - <dump> \| psql -1 -v ON_ERROR_STOP=1` | oid 유지·잔여 없음·완전 일치. 끝에 오류를 주입하면 **전부 롤백되어 원상태**. 다른 세션이 열려 있으면 잠금에 막힌다 |
| — | DB만의 복원은 시퀀스를 되감는다 | `mtg_id_seq` 11 → 9. 백업 뒤 만든 `meetings/mtg_10`·`mtg_11`을 새 회의가 덮는다 |
| P3 | `cp -c -R <userData>/data` (postgres 72 MB + storage) | 0.22초, 실제 소모 ≈ 1.9 MB. 130 MB 실데이터 스토리지는 0.007초·56 KB. 사본의 `pg_controldata` system identifier·마커가 원본과 같고 그대로 기동한다 |

| P4 | clone 도구 (스펙 리뷰 뒤 추가 실측) | **Node 22의 `fs.cp`는 macOS에서 clone하지 않는다** — `COPYFILE_FICLONE`은 조용히 전체 복사(72 MB에 77 MB 소모), `COPYFILE_FICLONE_FORCE`는 첫 파일에서 `ENOSYS`. **`/bin/cp -c -R`만 clone한다.** HFS+ 이미지에서 `cp -c -R`은 **rc=0으로 조용히 일반 복사**로 넘어간다. 대상 디렉터리가 이미 있으면 **그 안에 중첩**한다(`dst/src`). 권한(PGDATA 0700, 파일 0600)은 보존된다 |

결론: **DB와 스토리지를 한 시점으로 묶는 단위는 `data/` 통째 clone이다.** 짝(마커)·oid·시퀀스·파일이
함께 움직이므로 Phase 3 §6.2가 막으려던 번호 충돌이 구조적으로 생기지 않는다. 덤프 복원은 P2d 방식이면
안전하게 되지만 스토리지 격리를 따로 만들어야 해서 수동 절차의 최후 수단으로만 둔다.

### 3.1 코드에서 확인한 제약 (코덱스 탐색 2026-09-24 + 직접 확인)

- **고아 postmaster 종료는 postgres 어댑터 `launch()` 안에 있다** — 판정표 1 뒤의 `handleLock()`
  (`desktop/src/services/postgres/service.ts:144-173`, 호출 `:258-262`). main에 "postgres 기동 전" 훅을
  단순히 두면 앞 실행에서 살아남은 postmaster가 쥔 클러스터를 복사한다.
- **Python 고아 회수는 감독자 생성 전** `reapBeforeStart`에서 돈다(`main.ts` `createSupervisorFor`
  안, 토큰 게이트·config·포트 뒤). 그 스캔은 `DAMWHA_MODULES` 셋만 알아본다(`process/orphans.ts:23`).
- **`stopAll()`은 결과와 무관하게 상태를 `stopped`로 적는다**(`supervisor.ts:865` 부근). 정직한 것은
  반환값 `StopOutcome`(`stopped`·`leaked`)이다. 그리고 `stopping`을 되돌리지 않아 한 번 쓰면 끝이다.
  → 앱이 떠 있는 채로 디렉터리를 바꾸지 않는다. 교체는 재시작 뒤 기동 초기에만 한다.
- **기동 순서는 `postgres → api(gate) → embed → worker`**이고 게이트가 실패하면 `runFrom`이 그 자리에서
  멈춘다(`supervisor.ts:806-818`) → 기동 때 게이트가 실패하면 worker·embed는 뜨지 않는다. 다만 상태 창의 단독 재시작은 그 뒤에도 worker를 띄울 수 있다(`supervisor.ts:785`) — §8이 재사용 대신 고정 보존을 택한 이유다.
- **`decideCluster`는 PGDATA가 없고 스토리지가 비어 있으면 `initdb`다**(`pairing.ts:106-108`). 교체
  도중 `data/`를 옮긴 직후 죽으면 다음 기동이 빈 클러스터를 만든다 — 가장 무거운 위험이다(§6.3).
- **마이그레이션 게이트는 재시도마다 덤프를 새로 뜨고 성공과 무관하게 5개로 정리한다**
  (`migration-gate.ts:124-150`). 뒤쪽 마이그레이션 실패에 "다시 시도"를 다섯 번 누르면 업그레이드 전
  덤프가 사라진다(§8).
- **마지막 실행 판을 기록하는 곳이 없다.** `update-state.json`은 건너뛴 버전만 적는다
  (`update/update-state.ts`). `desktop/package.json` 버전은 릴리스 때 올리므로 개발 빌드는 발행판과
  같은 `0.3.1`을 말한다.
- **창을 여는 게이트는 postgres·api뿐이다**(`services/specs.ts:17-26`). 화면이 붙었다는 것은 업그레이드
  성공의 증거가 아니다 — 스냅샷을 그 조건으로 지우지 않는다(§5.3).

## 4. 용어와 배치

모두 `<userData>` = `~/Library/Application Support/Damwha` 아래, `data/`와 **같은 볼륨의 형제**다.
`data/` 안에 두면 clone과 교체의 경계가 꼬인다.

| 경로 | 무엇 | 만드는 것 | 지우는 것 |
| --- | --- | --- | --- |
| `data/.damwha-generation` | 이 `data/`를 마지막으로 연 packaged 빌드 식별자 (§5.1) | 스냅샷 완료 직후의 데이터 가드 | 없음(덮어씀) |
| `snapshots/<sid>/data/` | `data/`의 clone | 데이터 가드 | 보존 규칙(§5.3) |
| `snapshots/<sid>/manifest.json` | 스냅샷 설명. `complete: true`가 적힌 것만 스냅샷이다 | 데이터 가드 | 스냅샷과 함께 |
| `restore-journal.json` | 되돌리기 진행 상태 (§6.2) | 종료 흐름의 `commit` 단계(§6.2) | 보류 해제·`requested` 실패 |
| `restore-staging/<rid>/` | 교체용 임시 clone | 저널 처리 | 저널 처리 |
| `data.replaced-<rid>/` | 교체 때 옆으로 치운 그때의 `data/` | 저널 처리 | **앱은 지우지 않는다** |

- `<sid>` = `backupStamp` 형식 UTC 스탬프(`20260924T084933Z`), 같은 초 충돌 시 `-2`… 접미사.
  `<rid>` = 되돌리기 요청 시각의 같은 형식 스탬프.
- 빌드 식별자 = `<app.getVersion()>+<git 커밋 12자>`. `desktop/scripts/package.mjs`가 패키징 때
  `Resources/build-info.json`(`{"version","commit"}`)으로 싣고 `check-bundle.mjs`가 존재·형식을
  단언한다. packaged가 읽지 못하면 스냅샷을 뜨지 않고 기동을 거부한다(번들 결함).

## 5. 판올림 스냅샷

### 5.1 언제 뜨나

**packaged에서만**, 아래가 모두 참일 때:

1. 내장 모드다(외부 DB 모드가 아니다).
2. `data/postgres`가 있다(첫 설치에는 지킬 데이터가 없다).
3. 판정표 1(`decideCluster`)이 `start`다 — 거부로 끝날 클러스터에서는 아무것도 만들지 않는다(거부
   경로 규칙). 그 거부는 뒤이어 postgres 어댑터가 평소대로 낸다.
4. `data/.damwha-generation`이 없거나, 읽을 수 없거나, 그 `build`가 지금 빌드 식별자와 다르다.

**dev는 스냅샷을 뜨지 않고 `.damwha-generation`도 쓰지 않는다.** dev와 packaged는 같은 `data/`를
쓴다. dev를 오갈 때마다 스냅샷이 뜨면 보존 상한(2) 때문에 진짜 업데이트 전 스냅샷이 밀려난다. dev의
브랜치 전환은 지금처럼 마이그레이션 전 덤프가 지킨다.

**기록을 `data/` 안에 두는 이유.** 0.3.1은 이 파일을 모른다. 되돌리기로 들여놓은 `data/`는 0.4.0이
스냅샷을 뜨기 전의 clone이라 이 파일이 없거나 옛 값이다. 그러니 되돌린 뒤 0.3.1로 몇 주를 쓰고 다시
0.4.0을 깔아도, 0.4.0은 기록이 자기와 다르다고 보고 새 스냅샷을 뜬다. `userData` 루트에 두면 복원이
기록을 되감지 못해 두 번째 업그레이드가 스냅샷 없이 지나간다(코덱스 지적).

### 5.2 어디서, 무엇을

**데이터 가드**(`app/data-guard.ts`, 신설)는 postgres가 떠 있지 않은 상태에서 감독자가 postgres를
launch하기 **전에** 반드시 한 번 통과해야 하는 단계다. 호출 지점은 둘이다:

- 첫 기동: `createSupervisorFor` 안, `reapBeforeStart` **뒤**, 감독자 생성 **전**.
- "다시 시도": `existing.retry()` **전**, postgres가 `running`이 아닐 때. 첫 가드가 판정표 1 거부로
  스냅샷을 건너뛴 뒤 감독자가 만들어지고, 사람이 마커를 고친 다음 "다시 시도"를 누르면 가드 없이
  마이그레이션까지 가는 경로가 있었다(`main.ts:1012`, 코덱스 스펙 리뷰 [2]). 가드가 통과해야
  postgres launch로 넘어간다.

순서:

1. 외부 DB 모드면 아무것도 하지 않는다.
2. **쓰는 주체 부재 확인**: `reapBeforeStart`가 성공을 돌려도 SIGKILL 뒤 생존자를 로그로만 남긴다
   (`process/orphans.ts:552-556`, `app/reap-on-start.ts:17-21`). 가드는 같은 스캐너로 **다시 스캔해**
   앱 소유 Python 프로세스(이번 실행 run-id가 아닌 것)가 하나라도 남아 있으면 거부한다(`writersAlive`,
   `manual`, pid 목록). 지우거나 죽이지 않는다 — 회수는 이미 한 번 시도됐다.
3. 저널이 있으면 §6.3을 처리한다(그 경로는 락 처리 → 저널 step. 곧 버릴 지금의 `data/`에 판정표 1을
   적용하지 않는다). `hold`면 여기서 보류를 돌려준다.
4. 클러스터 사실을 읽는다 — `PG_VERSION`, `pg_controldata`(system identifier), 스토리지 사실.
   `decideCluster`가 `start`가 아니면 여기서 끝낸다(스냅샷 없이 넘어가고, 거부는 postgres 어댑터가
   낸다). postgres 어댑터의 "판정 → 락" 순서와 같다 — 거부될 클러스터의 락을 건드리지 않는다.
5. **락 처리**: `handleLock()`의 판정·고아 종료를 `services/postgres/lock.ts`로 꺼내 둘이 함께 쓴다.
   살아 있는 앱 소유 postmaster는 fast 종료로 내린다(SIGKILL 금지 유지). 확인할 수 없거나 안 내려가면
   기존 `pgLockUnprovable`·`pgOrphanStuck`로 거부한다. 뒤이은 postgres 어댑터의 `handleLock()`은 이미
   정리된 상태를 보고 그냥 지나간다.
6. §5.1의 조건 4를 보고 스냅샷이 필요 없으면 7~10을 건너뛴다.
7. **미기록 완료 스냅샷 재사용**: `manifest.toBuild`가 지금 빌드이고 **`manifest.fromRecord`가 지금
   `.damwha-generation`의 원문(없으면 null)과 같은** 완료 스냅샷이 있으면(앞 기동이 10의 기록 전에 끊겼다)
   새로 뜨지 않고 그것으로 10으로 간다. `fromRecord` 조건이 없으면, 스냅샷 A로 되돌린 뒤 [이 판으로 계속]을
   고를 때 A(`toBuild`가 같다)가 재사용돼 그 사이 이전 판에서 쓴 데이터가 복원점에서 빠진다 — 교체가
   들여놓은 `data/`의 기록에 `restoredFrom`을 적으므로(§6.3) 기록 원문이 반드시 달라진다. 없으면 8. 재시도마다 같은
   데이터의 완료 스냅샷이 쌓여 보존 상한(2)이 서로 다른 과거 복원점을 밀어내는 것을 막는다(코덱스
   스펙 리뷰 [5]).
8. **clone**: `snapshots/<sid>.partial/`가 **없음을 확인하고**(있으면 지운 뒤) 만든 다음
   `/bin/cp -c -R <userData>/data <sid>.partial/data`. 목적지 `…/data`가 미리 있으면 `cp`가 그 안에
   중첩하므로(§3 P4) 만들지 않는다. 끝나면 `<sid>.partial/data/postgres/PG_VERSION`과
   `<sid>.partial/data/storage`가 **바로 아래에** 있는지 확인한다. 이어 **사본에서**
   `pg_controldata`를 다시 읽어(락 처리 뒤의 실제 상태 — 코덱스 스펙 리뷰 [12]) manifest를 쓴다:
   ```json
   {"id":"20260924T084933Z","createdAt":"…","fromBuild":"0.3.1+…"|null,"toBuild":"0.4.0+…",
    "fromRecord":"<스냅샷 당시 .damwha-generation 원문>"|null,
    "pgVersion":"16","clusterId":"7687238228739395787","databaseOid":16384|null,
    "clusterState":"shut down"|"in production"|…,"complete":true}
   ```
   `databaseOid`는 사본의 마커에서 읽는다 — 마커의 `databaseOid`가 null일 수 있다(`createdb` 전).
   `fromBuild`는 옛 `.damwha-generation`의 `build`(없으면 null).
9. `snapshots/<sid>.partial` → `snapshots/<sid>` rename(7에서 재사용했으면 생략). **여기까지가 완료**다.
10. `data/.damwha-generation`에 `{"build":"<지금 빌드>","snapshot":"<sid>"}`를 원자적으로 쓴다.
11. 보존 정리(§5.3).

`clusterState`가 `shut down`이 아니어도(정전 뒤 등) 뜬다 — postmaster가 없을 때의 사본이라 crash-
consistent 이미지이고 기동 때 postgres가 스스로 복구한다. manifest에 그대로 적고 대화상자가 표시한다.

**종료와의 관계.** clone은 `/bin/cp` 자식 프로세스다(§3 P4 — 프로세스 안 clone 수단이 없다). 감독자가
없으면 종료가 곧바로 "정리 완료"로 간다(`main.ts:578`의 `stopServices`) — 그러면 Electron이 끝난 뒤에도
`cp`가 `.partial`에 계속 쓰고, 다음 기동의 정리와 겹친다(코덱스 스펙 리뷰 [4]). 그래서 가드의 **파일
I/O**(clone·rename·저널 쓰기)는 종료 흐름에 등록해 `stopServices`가 그 완료를 기다린다. 대화상자(보류)는
등록하지 않는다 — 종료가 사람의 선택을 기다리면 순환 대기가 된다. 종료가 오면 진행 중인 `cp`는 끝까지
기다리고(초 단위), 다음 단계로 가지 않는다.

**가드 실패의 상태.** 가드의 `manual` 실패(`writersAlive`·`snapshotFailed`·`restoreIncomplete`·
`restoreJournalUnreadable`·락 거부)는 감독자가 없는 상태의 실패라 `mayAutoRetry(null)`이 참이 되고, Dock
재열기가 `start()`를 다시 부른다(`app/window-flow.ts:81`, 코덱스 스펙 리뷰 [11]). main이 마지막 가드
결과를 보존해 `autoRetryAllowed`가 그것을 보게 한다 — 재열기는 화면만 다시 그리고, 메뉴의 "다시
시도"만 가드를 다시 돌린다.

### 5.3 보존

- 완료된 스냅샷(이름이 `.partial`이 아니고 `manifest.complete === true`)을 **최근 2개** 둔다. 새
  스냅샷이 완료된 **뒤에만** 옛것을 지운다.
- **저널이 가리키는 스냅샷은 지우지 않는다**(되돌리기 진행 중·보류 중).
- `.partial`이거나 manifest가 없거나 `complete`가 아닌 디렉터리는 다음 데이터 가드가 지운다.
- 지우는 것은 `snapshots/` 바로 아래, 앱이 만드는 이름 형식(`^\d{8}T\d{6}Z(-\d+)?(\.partial)?$`),
  `lstat`으로 심볼릭 링크가 아닌 디렉터리만. 지운 경로를 `supervisor.log`에 적는다(§10).
- 화면 부착이나 기동 성공은 보존 판단에 쓰지 않는다(§3.1 마지막 항목).

### 5.4 실패

스냅샷 단계(7~10)가 실패하면(ENOSPC, EPERM 등) **기동하지 않는다.** `.partial`을 지우고 `manual` 실패
`snapshotFailed`로 원인·경로와 "디스크 여유 공간을 확인한 뒤 다시 시도해 주세요"를 보인다. Phase 3의
"검증된 백업 없이는 마이그레이션하지 않는다"(P3-C6)를 판올림 전체로 넓힌 것이다. `.damwha-generation`을
쓰지 않았으므로 다시 시도하면 스냅샷을 다시 시도한다(9까지 끝났다면 7이 재사용한다).

**APFS가 아닌 볼륨**에서는 `cp -c`가 조용히 일반 복사로 넘어간다(§3 P4). 실패가 아니라 느리고 공간을
쓰는 스냅샷이 될 뿐이라 따로 막지 않는다. 시동 볼륨이 APFS가 아닌 경우는 macOS 15에서 사실상 없다.

## 6. 되돌리기 — 저널과 교체

### 6.1 되돌릴 수 있는 스냅샷

완료된 스냅샷 중 `pgVersion`이 번들 메이저(`16`)와 같고, `snapshots/<sid>/data/storage/.damwha-cluster`가
읽히는 것. 최근 것부터 최대 2개.

### 6.2 저널

`<userData>/restore-journal.json`, 원자적 쓰기(임시 파일 → rename):

```json
{"id":"<rid>","snapshot":"<sid>","step":"requested"|"staged"|"moved-aside"|"hold",
 "requestedAt":"…","completedAt":"…"|null}
```

- `<rid>`는 요청 시각 스탬프이되, `data.replaced-<rid>`와 `restore-staging/<rid>`가 **둘 다 없는** 값으로
  고른다(있으면 `-2`… 접미사). 목적지 충돌을 요청 시점에 없앤다(코덱스 스펙 리뷰 [9]).
- **저널은 종료 흐름의 새 커밋 단계에서 쓴다.** `runQuitFlow`에 선택 dep `commit(): Promise<void>`를 더해
  확인(`decision.quit`) 뒤, `beginQuit()` **전**에 await한다. `beginQuit()`은 동기이고 정리용
  `try/finally` 밖에서 불려(`app/quit-flow.ts:75,186`) 거기서 던지면 녹음 마무리·서비스 정지를 건너뛴 채
  강제 종료 경로로 간다(코덱스 스펙 리뷰 [3]). `commit`이 던지면(ENOSPC 등) 종료를 시작하지 않고
  "되돌리기를 예약하지 못했어요"와 원인을 대화상자로 보인 뒤 앱은 그대로 산다. 녹음 중 확인에서
  "취소"를 고르면 `commit`에 닿지 않아 저널이 생기지 않는다.
- 저널이 생긴 뒤 종료 전에 앱이 죽으면 다음 기동이 되돌리기를 수행한다 — 사람이 요청한 일이다.

### 6.3 처리 (데이터 가드 3단계)

저널은 **판정표 1보다 먼저** 본다. 저널이 읽히지 않거나 형식이 틀리면 **거부**한다
(`restoreJournalUnreadable`, 저널·`data/`·`snapshots/` 경로를 보이고 아무것도 옮기거나 지우지 않는다).

락 처리(§5.2-5)를 먼저 한다 — 앞 실행의 postmaster가 없음을 확인한 뒤에만 디렉터리를 만진다.

표기: D = `data/`, R = `data.replaced-<rid>/`, S = `restore-staging/<rid>/`. **신원 확인** = 대상의
`postgres/PG_VERSION`·`storage/`가 바로 아래에 있고, 대상 `pg_controldata`의 system identifier와 대상
마커가 스냅샷 manifest의 `clusterId`·`databaseOid`와 같다.

| step | 경로 상태 | 하는 일 | 다음 step |
| --- | --- | --- | --- |
| `requested` | R 없음 | 스냅샷이 §6.1을 만족하는지 확인. S가 있으면 지운다(이름 형식·`lstat` 확인). `/bin/cp -c -R snapshots/<sid>/data S`(S는 미리 만들지 않는다). S **신원 확인** | `staged` |
| `requested` | R 있음 | 거부(`restoreIncomplete`) — 요청 시 없던 R이 있다 | — |
| `staged` | D 있음·R 없음·S 있음 | `D → R` rename | `moved-aside` |
| `staged` | D 없음·R 있음·S 있음 | (앞 기동이 rename 뒤 step 기록 전에 끊김) 건너뜀 | `moved-aside` |
| `moved-aside` | D 없음·R 있음·S 있음 | `S → D` rename. 신원 확인 뒤 D의 `.damwha-generation`에 `restoredFrom: <rid>`를 더해 쓴다(원래 `build`·`snapshot`은 보존, 파일이 없었으면 둘 다 null) | `hold` |
| `moved-aside` | D 있음·R 있음·S 없음 | (앞 기동이 rename 뒤 끊김) D **신원 확인**이 맞으면 rename은 건너뛰고 `restoredFrom` 기록만 한다(멱등) | `hold` |
| `hold` | — | 아무것도 옮기지 않는다. `completedAt`이 null이면 채운다. §7.3 보류 대화상자 | (사람의 선택) |
| 그 밖의 모든 조합 | — | **거부**(`restoreIncomplete`, 세 경로의 존재 여부를 보인다). 다음 step을 쓰지 않고 아무것도 옮기지 않는다 | — |

- 스냅샷 자체는 **불변**이다 — 교체는 언제나 staging clone을 거친다. 같은 스냅샷으로 몇 번이든 다시
  되돌릴 수 있다.
- **`requested`에서 실패하면**(스냅샷이 사라짐·§6.1 불만족·staging clone 실패·신원 불일치) 현재 `data/`를
  건드리기 전이다. S를 지우고 저널을 지운 뒤 원인을 대화상자로 알리고 **평소대로 기동한다**
  (`restoreAborted`). 저널이 가리키는 스냅샷은 보존 정리가 지우지 않으므로(§5.3) "사라짐"은 사람이 지운
  경우뿐이다.
- **`staged`·`moved-aside`의 rename 실패와 "그 밖의 조합"**은 `manual` 실패 `restoreIncomplete`로 멈춘다 —
  저널은 그대로 두고, 다시 시도하면 같은 표로 잇는다. 이 상태에서 `initdb`로 빠지는 경로는 없다:
  데이터 가드가 저널을 처리하지 못하면 postgres launch로 넘어가지 않는다.
- step은 **일을 마친 뒤에** 다음 값으로 쓴다. rename은 모두 `<userData>` 바로 아래 같은 볼륨 안이고,
  목적지가 없음을 표가 보장한다.

## 7. 사용자 흐름

### 7.1 메뉴

앱 메뉴(`windows/menu-template.ts`)의 "업데이트 확인…" 아래에 **"업데이트 전으로 되돌리기…"**.

- 늘 보인다. 비활성 조건: 외부 DB 모드 / §6.1을 만족하는 스냅샷이 없음 / 저널이 이미 있음. 활성·비활성은
  기동·데이터 가드 뒤에 판정하고 상태가 바뀌면 메뉴를 다시 세운다(Electron 메뉴는 정적이다).
- 서비스 상태와 무관하다 — API·worker가 실패해 있어도, 마이그레이션 실패 화면에서도 쓸 수 있다.
- 실패 화면 안내(`windows/shell-hints.ts`)에 한 줄을 더한다 — 업데이트와 관계된 원인(`migrationFailed`,
  `migrationsStillPending`)이고 **메뉴가 실제로 활성일 때만**: "앱 메뉴 → 업데이트 전으로 되돌리기…로
  업데이트 전 데이터로 돌아갈 수 있어요." 안내 함수에 복원 가능 여부를 인자로 넘긴다(지금은 원인·서비스만
  받는다, `shell-hints.ts:150` — 코덱스 스펙 리뷰 [13]). 첫 설치의 마이그레이션 실패처럼 스냅샷이 없으면
  누를 수 없는 메뉴로 보내지 않는다. 기동 실패 일반에는 넣지 않는다.

### 7.2 확인 대화상자 (네이티브)

- 제목: "업데이트 전으로 되돌릴까요?"
- 본문(스냅샷마다 한 줄): "<fromBuild의 버전 또는 '이전 판'> → <toBuild의 버전> 업데이트 직전 ·
  <현지 시각>"(`clusterState`가 `shut down`이 아니면 "(비정상 종료 뒤의 상태)"를 덧붙인다).
- 설명: "그 뒤에 만든 회의와 바꾼 설정은 지우지 않고 `data.replaced-…` 폴더로 옮겨 둬요. 토큰·마이크
  권한·모델은 그대로예요. 앱이 다시 시작돼요."
- 버튼: 스냅샷마다 "<시각> 상태로 되돌리고 다시 시작"(최대 2개) + "취소". `cancelId`는 "취소"
  (6b-1과 같은 이유 — Escape가 파괴적 선택을 고르지 않게).
- 선택하면 정상 종료 흐름(`runQuitFlow`)을 탄다. §6.2의 `commit`에서 저널 `requested`를 쓰고, `quit`에서
  `app.relaunch()` 뒤 `app.quit()`. 종료가 "남은 것"을 보고하면(`!stopped`) 기존 경고를 그대로 보인다 —
  다음 기동의 쓰는 주체 확인(§5.2-2)과 락 처리가 남은 프로세스를 다시 판정한다.

### 7.3 보류 대화상자 (다음 기동, 서비스 전)

저널이 `hold`이면 데이터 가드가 postgres launch 전에 띄운다. 문구는 처음 보는 경우와 다시 보는 경우를
가르지 않고 **날짜로 말한다** — 되돌린 뒤 이전 판으로 몇 주를 쓰고 신판을 다시 깔면 같은 대화상자가
다시 뜨기 때문이다(코덱스 스펙 리뷰 [10]):

- "<completedAt 날짜·시각>에 업데이트 전 데이터(<스냅샷 시각> 상태)로 되돌렸어요. 그 뒤 이전 판에서 쓴
  내용은 지금 데이터에 그대로 있어요. 되돌리기 전 데이터는 <R 경로>에 있어요."
- **[종료]** — "이전 판(<fromBuild 버전, null이면 '업데이트 전에 쓰던 판'>)을 쓰려면 앱을 종료하고 그 판을
  설치하세요." 저널은 `hold` 그대로 둔다.
- **[다운로드 페이지 열고 종료]** — `https://github.com/Yjason-K/Damwha/releases`를 열고 종료.
- **[이 판으로 계속]** — "이 판으로 계속하면 데이터를 다시 업데이트해요." 저널을 지우고 평소 기동을
  잇는다. 들여놓은 `data/`의 `.damwha-generation`은 옛 값이므로 §5.1에 따라 **새 스냅샷**을 뜨고
  게이트가 마이그레이션한다.
- `cancelId`는 [종료].

보류 중에는 postgres launch로 넘어가지 않는다 — 신판의 게이트가 되돌린 데이터를 다시 마이그레이션하지 않는다.
0.3.1을 설치하면 0.3.1은 저널을 모르고, 들여놓은 `data/`는 0.3.1이 기록한 상태 그대로라 정상 기동한다.

## 8. 마이그레이션 전 덤프 — 업그레이드 시작 덤프의 고정 보존

지금 결함(§3.1): 재시도마다 새 덤프 + 성공과 무관한 5개 정리 → 업그레이드 전 덤프가 밀려난다.

**규칙: 덤프는 지금처럼 매번 뜨되, "이 업그레이드 시도의 첫 덤프"는 5개 정리에서 뺀다.**

- 덤프마다 옆에 sidecar `<dump>.json` = `{"firstPending","applied","generation"}`를 쓴다. `generation`은
  그때 `data/.damwha-generation`의 `snapshot` 값(없으면 null).
- 정리할 때, `generation`이 null이 아닌 덤프들을 `generation`별로 묶어 **각 묶음의 가장 오래된 것**은
  지우지 않는다. 나머지(묶음의 뒤쪽, null 묶음, sidecar 없는 옛 덤프)는 지금의 5개 규칙 그대로다.
- 방금 만든 덤프는 지금처럼 후보에서 뺀다(`migration-gate.ts:143-146`).

처음 설계는 "같은 시도 안에서는 덤프를 다시 뜨지 않고 재사용"이었다. 코덱스 스펙 리뷰가 그 전제
("재시도 사이에 DB가 바뀌지 않는다")가 깨지는 경로 셋을 찾았다 — 부분 성공하는 재시도는 매번
`firstPending`·`applied`가 달라져 결국 새 덤프가 5개를 넘고([6]), 상태 창의 단독 재시작은 API 게이트
실패 중에도 worker를 띄워 DB를 바꾸며(`supervisor.ts:785`, [7]), dev도 packaged가 남긴 `generation`을
읽어 낡은 덤프를 재사용한다([8]). 고정 보존은 재사용하지 않으므로 셋 다 무관하다. 매 재시도 덤프는
그 시점의 정확한 사본이고, 업그레이드 시작 덤프 하나만 끝까지 남는다.

- 되돌리기 뒤의 새 업그레이드는 새 스냅샷 id라 새 묶음이 된다. 옛 묶음의 첫 덤프는 그 묶음에 새 덤프가
  더 생기지 않으므로 5개 규칙에서 빠진 채 남는다 — 묶음마다 하나씩 쌓인다. 스냅샷 보존(2개)에 맞춰
  **스냅샷 디렉터리가 더 없는 `generation`의 묶음은 고정을 풀어** 5개 규칙에 맡긴다.
- dev에서 packaged의 `generation`을 읽어도 고정이 하나 늘 뿐 데이터를 잃지 않는다.
- sidecar는 덤프와 함께 지운다.

## 9. 수동 절차 — `docs/RESTORE.md`

앱이 메뉴까지 못 갈 때(창이 안 뜸, 토큰 게이트가 막음 등). 내용:

1. 쓰는 주체가 모두 꺼졌는지 확인 — `pgrep -fl` 한 줄(Electron·postmaster·worker·mlx_lm). 켜져
   있으면 앱을 종료하고, postmaster가 남으면 `pg_ctl -D … -m fast stop`(SIGKILL 금지).
2. `ls ~/Library/Application\ Support/Damwha/snapshots/*/manifest.json`로 스냅샷과 `fromBuild` 확인.
3. `mv data data.replaced-manual-<날짜>` → `cp -c -R snapshots/<sid>/data data`.
4. 이전 판 설치 → 기동.
5. 최후 수단: 스냅샷이 없고 덤프만 있을 때 — 번들 `postgres`를 띄워 §3 P2d의 한 트랜잭션 복원.
   시퀀스가 되감기므로 백업 뒤 생긴 `data/storage/meetings/mtg_N`을 먼저 다른 곳으로 옮기라는 경고를
   함께 적는다.

C10이 이 문서를 복구 세트 사본 위에서 한 번 실제로 따라 한다.

## 10. 계약 변경 (`desktop/CLAUDE.md`)

- **"앱이 지우는 것"**: 넷(initdb 임시물·증명한 낡은 락·5개 초과 덤프·`.dump.partial`)에 더해
  (5) 보존 상한을 넘은 완료 스냅샷, (6) 미완료 스냅샷(`.partial`·manifest 미완료), (7) 저널 처리의
  `restore-staging/<rid>`, (8) 덤프 sidecar(덤프와 함께). **`data.replaced-*`는 지우지 않는다** —
  사람의 데이터다. (코덱스는 토큰·업데이트 임시 파일도 이미 지운다고 짚었다 — 그것들은 데이터 영역
  밖의 앱 자신의 상태 파일이라 이 목록의 범위를 "데이터 영역(`data/`·`snapshots/`·`backups/`·
  `restore-staging/`)"으로 명시한다.)
- **거부 경로**: 저널을 읽을 수 없음·락 확인 불가·판정표 거부는 여전히 아무것도 만들거나 지우지 않는다.
  스냅샷은 판정표 1이 `start`일 때만 뜬다.
- **`manual` 실패**: `writersAlive`·`snapshotFailed`·`restoreIncomplete`·`restoreJournalUnreadable`은 자동
  재시도하지 않는다(`app/retry-policy.ts`). 감독자가 없는 상태의 실패라 창 재열기 경로도 main이 보존한 가드
  결과로 막는다(§5.2).
- 데이터 위치 표에 `snapshots/`·`restore-journal.json`·`restore-staging/`·`data.replaced-*`·
  `data/.damwha-generation`을 더한다.

## 11. 구성 요소

| 파일 | 맡는 일 | 성질 |
| --- | --- | --- |
| `services/postgres/lock.ts` (신설) | `handleLock()`에서 꺼낸 락 판정·고아 종료. postgres 어댑터와 데이터 가드가 함께 쓴다 | deps 주입, 테스트 가능 |
| `services/postgres/snapshot.ts` (신설) | 스냅샷 만들기·목록·manifest 파싱·보존 정리·되돌릴 수 있는 것 고르기 | fs·clone 도구 주입 |
| `services/postgres/restore-journal.ts` (신설) | 저널 파싱·원자적 쓰기·§6.3 step 기계 | fs 주입, 모든 step·중단 지점 단위 테스트 |
| `services/postgres/generation.ts` (신설) | 빌드 식별자·`.damwha-generation` 읽기·쓰기·판정(§5.1) | 순수 + 얇은 fs |
| `app/data-guard.ts` (신설) | §5.2 순서 조립: 외부 모드 → 저널 → 판정표 1 → 락 → 스냅샷 → 보존. 결과를 `{kind:"proceed"} \| {kind:"hold", …} \| 실패`로 돌려준다 | deps 주입 |
| `app/restore-flow.ts` (신설) | 메뉴 활성 판정, 확인·보류 대화상자 옵션, 선택 → 동작 정책 | electron 값 import 없음 |
| `services/postgres/migration-gate.ts` | §8 sidecar·고정 보존 | 기존 테스트 확장 |
| `services/postgres/service.ts` | `handleLock` → `lock.ts` 사용 | 동작 불변 |
| `diagnostics/causes.ts`, `windows/shell-hints.ts` | `writersAlive`·`snapshotFailed`·`restoreIncomplete`·`restoreJournalUnreadable`·`restoreAborted` 문구와 안내, 업데이트 관련 실패의 메뉴 안내 한 줄(복원 가능 여부 인자) | |
| `app/quit-flow.ts` | 선택 dep `commit()` — 확인 뒤·`beginQuit` 전, 던지면 종료하지 않음(§6.2) | 기존 테스트 확장 |
| `app/window-flow.ts` 배선 | 가드 실패 뒤 재열기가 가드를 다시 돌리지 않게 `autoRetryAllowed`가 보존된 가드 결과를 봄 | |
| `windows/menu-template.ts` | 메뉴 항목과 활성 상태 | |
| `main.ts` | 배선만: 데이터 가드 호출 두 곳(첫 기동의 `reapBeforeStart` 뒤, "다시 시도"의 `existing.retry()` 전), 가드 파일 I/O를 `stopServices`가 기다리게 등록, 보류 대화상자, 메뉴 핸들러, 종료 흐름의 `commit`·`quit`(relaunch) | |
| `scripts/package.mjs`, `scripts/check-bundle.mjs` | `Resources/build-info.json` 생성·단언 | |
| `docs/RESTORE.md` (신설) | §9 | |

`app/`는 `services/postgres/`를 import해도 된다(앱 흐름이 서비스를 조립한다). 서비스끼리는 import하지
않는다는 규칙은 그대로다.

## 12. 테스트·검증

### 12.1 자동 (vitest, `pnpm --filter damwha-desktop exec vitest run <path>`)

- `generation`: 기록 없음·읽을 수 없음·다름·같음·dev → 스냅샷 여부.
- `snapshot`: 완료 판정(`.partial`·manifest 없음·`complete` 거짓), 보존 2개·저널 보호·이름 형식 밖은
  안 지움·심볼릭 링크 안 지움, clone 실패 시 `.partial` 정리와 `.damwha-generation` 미기록, `pgVersion`
  불일치 제외, **9→10 사이 중단을 반복해도 완료 스냅샷이 하나만 생기고 옛 복원점이 밀려나지 않음**(§5.2-7),
  manifest의 `clusterState`·`databaseOid`(null 포함)를 **사본**에서 읽음.
- **실제 임시 디렉터리 테스트**(가짜 fs가 아니라 `/bin/cp -c -R`을 실제로 부름): 목적지 부재에서 clone 뒤
  `postgres/`·`storage/`가 바로 아래에 있음, 목적지가 이미 있으면 거부(중첩 `data/data` 금지), 권한
  0700·0600 보존. `restore-journal`의 교체도 실제 디렉터리에서 한 번 왕복한다(코덱스 스펙 리뷰 [14]).
- `restore-journal`: §6.3 표의 **모든 행**(정의된 조합의 전이, 그 밖의 조합은 무변경 거부), 모든 step 사이
  중단 뒤 재개(rename 직후·step 쓰기 직전), 신원 불일치 거부, `requested` 실패 시 `data/` 불변·저널 삭제,
  손상 저널 거부 시 무변경, `<rid>` 충돌 회피.
- `data-guard`: 외부 모드 무동작, 쓰는 주체 생존 시 거부(`writersAlive`), 판정표 1 거부 시 무생성, 락 거부
  전파, 저널이 `data/` 없는 상태에서 `initdb` 판정보다 먼저 옴, `hold` 반환, **"다시 시도" 경로에서도 가드가
  돎**(첫 가드가 판정표 거부로 건너뛴 뒤 마커를 고친 재시도가 스냅샷을 뜸), 가드 실패 뒤 창 재열기가
  가드를 다시 돌리지 않음, 종료가 진행 중인 clone을 기다림.
- `migration-gate`: 묶음별 첫 덤프 고정, null 묶음·sidecar 없는 옛 덤프는 5개 규칙, 스냅샷이 없어진
  `generation`은 고정 해제, **부분 성공을 거친 6회 이상 재시도**(재시도마다 `firstPending`이 바뀜)와 같은
  파일 5회 실패 둘 다에서 업그레이드 시작 덤프 생존.
- `restore-flow`·`quit-flow`: 메뉴 비활성 세 조건, 확인 대화상자 `cancelId`, 저널이 `commit`에서만 쓰이고
  녹음 확인 "취소"면 안 쓰임, **`commit`이 던지면 종료가 시작되지 않고 서비스도 멈추지 않음**, 실패 화면
  안내 한 줄이 복원 가능할 때만 붙음.
- 번들: `check-bundle`이 `build-info.json`을 단언.
- **변이 검증**(이 저장소 관례): 위 판정마다 한 줄씩 뒤집어 빨간불을 확인하고 결과 문서에 기록.

### 12.2 packaged 실측 (GUI 조작은 사용자)

재료: `~/damwha-builds/Damwha-0.3.1-published.app`(발행판), `~/damwha-6b3-recovery-20260924T173744/`
(`026` 이전 userData, `models/` 제외), 이 브랜치의 새 빌드. **매 단계 전후와 판을 바꿀 때마다** 쓰는 주체
전부가 꺼졌는지 확인한다:
`pgrep -fl "Damwha.app/Contents|Electron.app/Contents/MacOS/Electron|electron/cli.js|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"`.
파괴적 단계 전에는 앱을 끄고 userData를 통째로 복사한다(`models/` 제외, 디스크 여유 확인 — 약 11 GB).

1. **준비**: 앱 종료 확인 → 현재 userData 백업 → 복구 세트를 userData로 들여놓는다(`models/`는 현재 것
   유지). 0.3.1을 `/Applications`에 설치·기동해 정상인지, 기준선(6b-3 §3 C1과 같은 항목: `_migrations`
   마지막, 회의·발화·요약 해시, 화자, `processing_defaults`, job, 스토리지 파일 sha256, 마커)을 뜬다. 종료.
2. **C1 판올림 스냅샷**: 새 빌드 설치·기동. `supervisor.log`에 스냅샷 줄, `snapshots/<sid>/manifest.json`
   (`complete`, `fromBuild` null, `clusterState` `shut down`), 사본의 system identifier·마커 = 원본,
   `data/.damwha-generation`, 이어서 게이트의 덤프(+sidecar)와 `026` 적용.
3. 새 판에서 회의 하나를 업로드해 `done`까지(`mtg_N` 생성).
4. **C2·C4 되돌리기 왕복**: 메뉴 → 확인 → 재시작 → 보류 대화상자 → [종료]. `data.replaced-<rid>`에 3의
   회의 파일이 있고, `data/`의 `_migrations` 마지막이 `025`. **같은 새 판을 한 번 더 열어** 보류가 다시 뜨고
   `supervisor.log`에 마이그레이션·백업 줄이 없음을 확인(C4) → [종료]. 0.3.1 설치·기동 → **정상 기동**,
   1의 기준선과 전부 같음. 0.3.1에서 회의 하나를 더 올린다(되돌린 뒤 이전 판에서 쓴 데이터).
5. **C3·C4 재업그레이드**: 새 빌드 재설치·기동 → 저널이 `hold`로 남아 있으므로 **보류가 다시 뜬다** —
   날짜 문구와 "그 뒤 이전 판에서 쓴 내용은 지금 데이터에 그대로 있어요"를 확인 → [이 판으로 계속] → 새
   스냅샷(`fromBuild` null — 0.3.1은 기록을 쓰지 않는다), 새 덤프(새 `generation` 묶음의 첫 덤프), `026`
   적용. 4에서 0.3.1로 올린 회의가 보이고, 새 회의를 올려 `mtg_N`이 3에서 쓴 번호와 겹쳐도
   `data.replaced-*`의 파일은 그대로이며 `data/storage`에는 새 파일만 생긴다.
6. **C5 교체 중 크래시**: 되돌리기를 요청하고, 실측용 env `DAMWHA_RESTORE_PAUSE_AFTER_STEP=<step>`
   (packaged에서도 읽음, 그 step 기록 뒤 60초 대기)로 `staged`·`moved-aside` 각각에서 멈춘 동안 앱 main을
   SIGKILL(데이터 가드는 감독자 전이라 worker 자식이 없다 — 확인은 `pgrep`). 다음 기동이 이어서 마치고
   `initdb` 줄이 없음. clone **도중**의 중단은 이 방법으로 잡을 수 없다 — 실제 디렉터리 단위 테스트(§12.1)와
   "종료가 clone을 기다린다"는 단위 테스트가 맡는다.
7. (예비) 5에서 만든 상태로 되돌리기를 한 번 더 해 두 번째 스냅샷 버튼이 보이는지(보존 2개) 확인한다.
8. **C6 스냅샷 실패**: 새 빌드 식별자가 필요하다 — 커밋 하나를 더한 빌드로 판을 바꾸되 `snapshots/`를
   `chmod 500`. 기동 거부·`snapshotFailed` 문구·`.partial` 없음·`.damwha-generation` 불변·게이트 미실행.
   권한을 되돌리고 "다시 시도" → 스냅샷·기동.
9. **복구**: 앱 종료 확인 → 1에서 떠 둔 userData 백업을 되돌린다.

C10(수동 절차)은 9의 복구 **전에**, 새 판이 026을 적용한 상태에서 `docs/RESTORE.md`를 글자 그대로
따라 해 0.3.1 기동까지 확인한다. 문서가 실제 userData 경로를 가리키므로 실데이터 위에서 하고, 시작 전에
userData를 한 번 더 복사해 둔다.

## 13. 완료 기준

| # | 기준 | 판정 |
| --- | --- | --- |
| C1 | 판이 바뀌면 postmaster 기동 전에 스냅샷이 완료되고, manifest·system identifier·마커가 원본과 같다 | packaged §12.2-2 |
| C2 | 되돌리기 왕복 뒤 0.3.1이 정상 기동하고 기준선이 업데이트 전과 같다. 새 판에서 만든 데이터는 `data.replaced-*`에 있다 | packaged §12.2-4 |
| C3 | 되돌린 뒤 이전 판을 쓰다가 재업그레이드하면 보류가 날짜 문구로 다시 뜨고, [이 판으로 계속]이 새 스냅샷·새 덤프로 진행되며, 새 회의가 옛 번호의 파일을 덮지 않는다 | packaged §12.2-5 |
| C4 | 보류 중 같은 판을 다시 열어도 마이그레이션하지 않고, [이 판으로 계속]이 다시 업데이트한다 | packaged §12.2-4·5 |
| C5 | 교체의 모든 중단 지점에서 다음 기동이 이어서 마치고 `initdb`하지 않으며, 정의되지 않은 경로 조합에서는 아무것도 옮기지 않고 멈춘다 | 단위(§6.3 표 전 행, 실제 디렉터리 포함) + packaged §12.2-6 |
| C6 | 스냅샷을 못 만들면 기동하지 않고 원인을 보이며 미완료물을 남기지 않는다 | packaged §12.2-8 |
| C7 | 게이트 "다시 시도"를 반복해도(부분 성공 포함) 업그레이드 시작 덤프가 남는다 | 단위 |
| C8 | 보존 2개, 저널이 가리키는 스냅샷과 `data.replaced-*`는 지워지지 않는다 | 단위 |
| C9 | 외부 DB 모드·스냅샷 없음·저널 있음에서 메뉴 비활성, dev는 스냅샷·기록을 만들지 않는다 | 단위 |
| C10 | `docs/RESTORE.md`를 실제로 따라 해 이전 판 기동까지 된다 | 실측 |
| C11 | 전 패키지 초록(`pnpm build/test/lint`, ruff는 worker를 건드렸을 때), 변이 전부 빨간불 | 자동 |

## 14. 알려진 한계

- **데이터 가드는 토큰 게이트·config·포트 판정 뒤에 돈다**(Python 고아 회수가 그 뒤라서). 토큰 게이트가
  막히면(safeStorage 불가) 보류 대화상자도 교체도 기다린다. 그 경우는 수동 절차가 맡는다(§9). 0.3.1도
  같은 게이트에 막히므로 되돌린다고 풀리지 않는다.
- 스냅샷은 삭제된 오디오의 블록을 쥔다. 상한 2개·`data.replaced-*` 수동 삭제로 제한한다.
- `data.replaced-*`는 앱이 지우지 않으므로 되돌리기를 반복하면 쌓인다. 보류 대화상자가 경로를 말한다.
- 스냅샷은 packaged 판올림에만 뜬다 — dev가 데이터를 망가뜨린 경우는 덤프가 지킨다(지금과 같음).
- 앱 밖의 쓰는 주체(터미널 `pnpm worker`·`pnpm dev`의 API)는 데이터 가드가 모른다(`DAMWHA_MODULES`는
  앱 run-id가 붙은 것만 본다). packaged 사용자에게는 없는 경우이고, 개발자는 수동 절차의 `pgrep` 확인을
  따른다.

## 15. 로드맵·문서 변경

- `docs/electron-migration-roadmap.md` Phase 6b: 6b-2 상태 문단(완료 시), 완료 기준 두 번째 줄 충족 근거.
- `desktop/CLAUDE.md`: §10 계약, 데이터 위치 표, "업데이트 전 스냅샷·되돌리기" 절 신설.
- `docs/RESTORE.md` 신설. 릴리스 노트(범위 밖)가 이 문서를 가리키게 한다.

## 16. 리뷰 기록

### 16.1 브레인스토밍 결정 (2026-09-24, 사용자 승인)

- 다루는 실패: 마이그레이션 실패 / 새 판이 떴지만 쓸 수 없음 / 이전 판으로 되돌리기 / 백업 실패·디스크
  부족. 제외는 §2.2.
- 백업 방식: `data/` APFS clone 스냅샷이 주(스파이크 P3), 마이그레이션 전 덤프는 유지. 덤프 복원 UI 없음.
- 복원 주체: 앱 메뉴(주) + `docs/RESTORE.md`(보조). 교체는 재시작 뒤 기동 초기에만.
- 다른 맥 이전: 제외.

### 16.2 코덱스 탐색 (2026-09-24, 스펙 전)

열린 탐색 과제로 넘겼다(판정 요청 아님). 반영한 것: 교체 중 크래시 → `initdb`(§6.3·C5), 스냅샷 시점은
락 처리 뒤(§5.2-4), `stopAll` 상태 불신 → 재시작 뒤 교체(§3.1), 복원 직후 재마이그레이션 → 보류(§7.3),
기록 위치(§5.1), 스냅샷 불변 + staging(§6.3), 덤프 밀려남(§8), 외부 DB 모드(§2.2), clean shutdown
표시(§5.2), 화면 부착 ≠ 성공(§5.3), 삭제 계약(§10). 반영하지 않은 것: 모델 revision 고정(범위 밖 —
재현성 문제이지 복구 문제가 아니다), 관측값 재보고(`app_setting.worker_capabilities`는 worker가 기동마다
다시 쓴다).

### 16.3 코덱스 스펙 리뷰 (2026-09-24, `cc74e24` 대상)

14건. 데이터 유실급 주장은 코드로 직접 확인했다([1] `orphans.ts:552-556`·`reap-on-start.ts:17-21`,
[2] `main.ts:1012`, [3] `quit-flow.ts:75,186`, [7] `supervisor.ts:90,785`, [11] `window-flow.ts:81`).
[4]를 고치려던 "프로세스 안 clone"은 추가 실측(§3 P4)으로 불가능함이 드러났고, 같은 실측이 §5.4의
"APFS가 아니면 clone 실패" 가정도 틀렸음을 보였다(`cp -c`는 조용히 일반 복사로 넘어간다).

| # | 지적 | 반영 |
| --- | --- | --- |
| 1 | 고아 회수 성공 ≠ 쓰는 주체 없음 | §5.2-2 재스캔·`writersAlive` 거부 |
| 2 | 판정표 거부 뒤 고친 재시도가 가드를 우회 | §5.2 호출 지점 둘(재시도 경로 포함) |
| 3 | `beginQuit`에서 저널 쓰기가 던지면 정상 종료를 건너뜀 | §6.2 `commit` 단계, 실패 시 종료하지 않음 |
| 4 | 가드를 await해도 종료가 기다리지 않음 | §5.2 가드 파일 I/O를 종료 흐름에 등록(대화상자는 제외) |
| 5 | 세대 기록 전 중단이 복원점을 밀어냄 | §5.2-7 미기록 완료 스냅샷 재사용 |
| 6 | 부분 성공 재시도가 최초 덤프를 지움 | §8을 재사용에서 고정 보존으로 교체 |
| 7 | 단독 재시작이 재시도 사이 DB를 바꿈 | §8 고정 보존(재사용 전제 제거) |
| 8 | dev가 packaged의 generation을 읽음 | §8 고정 보존(재사용 없음 — 고정이 하나 늘 뿐) |
| 9 | `staged` 충돌 상태 미정의 | §6.2 `<rid>` 충돌 회피, §6.3 경로 조합 표·신원 확인·그 밖은 무변경 거부 |
| 10 | 재업그레이드에서 옛 복원을 현재처럼 안내 | §7.3 날짜 문구, §12.2-5가 보류 재등장을 거침 |
| 11 | 감독자 전 manual 실패가 창 재열기로 재시도됨 | §5.2 가드 결과 보존 |
| 12 | 정상 종료한 스냅샷에 "비정상 종료"가 붙음 | §5.2-8 사본에서 `pg_controldata` 재조회 |
| 13 | 누를 수 없는 메뉴로 안내 | §7.1 복원 가능할 때만 안내, `fromBuild` null 문구 |
| 14 | 가짜 fs 테스트가 잘못된 복사 배치를 통과시킴 | §12.1 실제 디렉터리 테스트, 충돌 무변경 거부 |
