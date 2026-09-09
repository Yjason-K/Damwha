# 검증 증거 — Task 2

- 커밋: `8b8d3556be1509ee481450f587ffdb0a333cf463` (시작 전 `git -C <worktree> rev-parse HEAD`로 확인, COMMIT과 일치)
- 환경:
  - node v22.21.1
  - pnpm 10.26.0
  - python3 (시스템, `/usr/bin/python3` 계열) 3.10.21 — 격리 실행 내부의 python3는 Task 1 검증 대상이며 이 회차에서 재확인하지 않았다
  - docker 29.4.0 (OrbStack), `damwha-postgres` 컨테이너 기동 상태 (포트 5432, healthy), `damwha_pgdata` 볼륨 존재
  - macOS: Darwin 27.0.0 arm64 (OKESJasons-MacBook-Pro)
- 실행 일시 (시작): 2026-09-09 (UTC 08:36경, 아래 각 항목의 개별 타임스탬프 참조)

## 시작 시점 상태 확인

- `git -C <worktree> rev-parse HEAD` → `8b8d3556be1509ee481450f587ffdb0a333cf463` — COMMIT과 일치
- `git status --porcelain` (시작 시점) → 출력 없음 (clean)
- 실험 postgres 프로세스: 없음 (`ps aux | grep -i postgres` 매치 없음, exit 1)
- 포트 55432: `lsof -i :55432` 매치 없음 (free)
- 포트 5432 (개발, 손대지 않음): OrbStack pid 1397 이 LISTEN — 그대로 둠
- `docker ps -a`: `damwha-postgres`(healthy, 5432), `blog-minio`, `blog-postgres` — 3개 컨테이너
- `docker volume ls`: 15개 볼륨, `damwha_pgdata`·`be_pgdata` 포함

이 상태는 계획이 요구하는 "시작 시점에 실험 PostgreSQL 서버는 정지 상태"와 일치한다.

---

## V1. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/pg`
- cwd: `<repo root>`
- 기대: exit 0. 재배치 후 위반 0건
- 실제: `위반 : 0건` (파일 수 767, Mach-O 수 70)
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/pg
  파일 수       : 767
  Mach-O 수     : 70
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 0개 파일
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
```
</details>

---

## V2. `bash experiments/electron-phase-0/lib/run-isolated.sh --label t2-start -- experiments/electron-phase-0/pg/run.sh start`
- cwd: `<repo root>`
- 기대: exit 0. `$SANDBOX/run/pg.pid` 생성. 래퍼가 블로킹하지 않고 돌아온다
- 실제: `postgres 기동: pid 1764 port 55432 data .../sandbox/pgdata`, `준비됨 (pg_isready)`. 명령이 정상 반환됨(블로킹 없음). `pg.pid` 내용: `1764`
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
run-isolated: label=t2-start  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.z5rkIv/stderr.raw)
postgres 기동: pid 1764  port 55432  data /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata
준비됨 (pg_isready)
데이터베이스 damwha 있음
2026-09-09 17:36:48.347 KST [1764] LOG:  redirecting log output to logging collector process
2026-09-09 17:36:48.347 KST [1764] HINT:  Future log output will appear in directory "log".
```
</details>

---

## V2b. `bash experiments/electron-phase-0/verify/t2-dyld-measured.sh`
- cwd: `<repo root>`
- 기대: exit 0. `$EVIDENCE/t2-start-dyld.txt`의 `^dyld` 줄에 한정해, `pg.pid`의 PID를 가진 `dyld[<pid>]` 줄이 존재하고 그 pid의 로드 목록에 `bundle/pg` 하위 바이너리 경로가 실제로 있다. `MEASUREMENT_UNAVAILABLE`이 아니다
- 실제: `MEASUREMENT_UNAVAILABLE` 표시 없음. `^dyld 줄 245건`. pid 1764(pg.pid)의 로드 목록에 번들 postgres 있음. 서버가 로드한 이미지가 전부 번들/usr/lib/System/Library 안
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
== V2b — t2-start dyld 실측 판독 (계획 규칙 6 / 6b)
  증거 파일 : /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t2-start-dyld.txt
  OK   MEASUREMENT_UNAVAILABLE 표시가 없다
  OK   ^dyld 줄 245건 (헤더가 아니라 dyld 줄만 셌다)
  pg.pid    : 1764
  증거의 pid: 1764 1768 1778
  OK   pid 1764 의 로드 목록에 번들 postgres가 있다 (/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/pg/bin/postgres)
  참고 pid 1764 이 번들(/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/pg) 아래에서 로드한 이미지: 1건
  OK   서버가 로드한 이미지가 전부 번들 / usr/lib / System/Library 안이다

판정: t2-start의 dyld 실측이 서버 프로세스의 것이다
```
</details>

### V2b 세부 판독 — `$EVIDENCE/t2-start-dyld.txt`에 대한 직접 계수

지시된 4가지를 스크립트 실행과 별개로 `awk`/`grep -c`로 직접 세었다 (변수 대입, `|| echo 0` 금지 규칙 준수).

| 항목 | 값 |
| --- | --- |
| `^dyld`로 시작하는 줄의 수 | 245 |
| `$SANDBOX/run/pg.pid`의 PID | 1764 |
| 그 PID를 가진 `dyld[<pid>]:` 줄의 수 | 81 |
| 그 PID의 줄 중 마지막 필드가 `bundle/pg/` 하위인 것의 수 | 1 |

증거 파일에 등장하는 다른 pid: `1768`(82줄), `1778`(82줄) — 헤더 주석에는 `# argv: experiments/electron-phase-0/pg/run.sh start`가 있고 이 줄은 `^dyld`로 시작하지 않으므로 위 계수에 포함되지 않는다.

**`verify/t2-dyld-measured.sh`의 실제 판정 순서 (코드 인용, `t2-lib.sh` 포함):**

1. `PIDFILE="$(exp_pid_file pg)"`; `PID=$(cat "$PIDFILE")` — **pid를 먼저 읽어 고정한다.**
2. `t2_dyld_pid_loads_exact "$DY" "$PID" "$PGBIN_POSTGRES"` 호출:
   ```
   awk -v p="dyld[$2]:" -v b="$3" \
     '$1 == p && $NF == b { n++ } END { print n + 0 }' "$1"
   ```
   `$1 == p`(즉 `dyld[<고정된 PID>]:`) 조건이 **먼저** 걸리고, 그 다음 `$NF == b`(번들 postgres 경로 정확 일치)를 본다. 경로로 pid를 찾는 역순이 아니다.
3. `t2_dyld_pid_loads_under`도 같은 순서(`$1 == p` 먼저, 그다음 `index($NF, d) == 1`)로 번들 하위 접두사 일치를 센다.
4. 별도로 `awk`로 "PID가 번들·`/usr/lib/`·`/System/Library/` 밖에서 로드한 이미지"가 있는지도 같은 `$1 == p` 선(先) 고정 방식으로 확인한다.

계획 규칙 6b("pid를 먼저 고정한 뒤 그 pid의 로드 목록을 본다")가 요구하는 순서와 스크립트의 awk 조건 순서(`$1==p` 먼저)가 일치한다.

---

## V2c. `bash experiments/electron-phase-0/verify/t2-no-pgctl-start.sh`
- cwd: `<repo root>`
- 기대: exit 0. `pg/run.sh`의 기동 경로에 `pg_ctl start`가 없고 `postgres`를 직접 띄운다. 번들 `pg_ctl start` 시험 실행 결과(`/bin/sh`를 거쳐 dyld 실측을 잃는지)가 `$EVIDENCE/t2-pgctl-trial-dyld.txt`에 기록됨 (규칙 2b)
- 실제: 정적 검사(A) 4항목 전부 OK. 실측(B) — 시험 postmaster PID 92536, dyld 줄 162건, 그중 pg_ctl 자신은 2건 측정, **시험 postmaster(92536)의 dyld 줄은 0건**, 서버 로그가 pg_ctl의 stdout에 섞여 나옴, 시험 PID가 `pg.pid`에 들어가지 않음
- 일치: 예
- 종료 코드: 0

**참고:** `$EVIDENCE/t2-pgctl-trial*.txt`는 이 회차 이전(2026-09-09T08:17 UTC, 구현 단계)에 이미 만들어져 있던 파일이며, V2 이전(서버가 떠 있지 않은 시점)에 기록된 것이다. 이번 회차의 V2c는 그 기존 증거를 다시 읽어 판정했다 — 스크립트 자체가 새로 시험 실행을 하지 않고 기존 증거 파일의 존재와 내용만 검사하는 구조다(코드 27~64행). 계획의 Verify 표 셀 명령이 정확히 그 스크립트 하나이므로 그대로 실행했다.

<details><summary>전체 출력</summary>

```
== A. 정적 — pg/run.sh의 기동 경로
  OK   본문에 pg_ctl ... start 가 없다
  OK   postgres를 직접 백그라운드로 띄운다
  OK   번들 Mach-O를 부르기 전에 DYLD_PRINT_LIBRARIES를 다시 export한다 (규칙 1)
  OK   postgres의 stderr를 리다이렉트하지 않는다 (규칙 2)

== B. 실측 — 번들 pg_ctl start 시험 실행
  시험 postmaster PID : 92536
  증거의 dyld pid     : 92534 92556
  OK   dyld 줄 162건이 남았다 — 줄 수만 보면 통과처럼 보이는 형태다
  OK   번들 pg_ctl 자신은 2번 측정됐다 (런처는 측정된다)
  OK   시험 postmaster(pid 92536)의 dyld 줄은 **0건**이다 —
       pg_ctl이 /bin/sh -c "exec postgres ... 2>&1 &" 로 띄우는 바람에
       SIP가 그 /bin/sh에서 DYLD_*를 지웠다. 규칙 2b가 실측으로 확인됐다.
  OK   서버 로그가 pg_ctl의 **stdout**에 섞여 나왔다 — stderr가 stdout으로 합쳐진다
  OK   시험 프로세스의 PID가 pg.pid에 들어가지 않았다

판정: 기동 경로에 pg_ctl start가 없고, 그래야 하는 이유가 실측으로 남았다
```
</details>

### V2c 세부 판독 — `$EVIDENCE/t2-pgctl-trial-dyld.txt`

| 항목 | 값 |
| --- | --- |
| `^dyld` 줄 수 | 162 |
| 시험 postmaster PID (`t2-pgctl-trial.txt`에서 읽음) | 92536 |
| 그 PID를 가진 dyld 줄 수 | **0** |
| (참고) 그 외 등장 pid | `92534`(81줄), `92556`(81줄) — pg_ctl 자신과 그 자식으로 추정 |

`t2-pgctl-trial.txt`에서 "PID 파일 소유권" 절: `시험 전 pg.pid : 없음` / `시험 후 pg.pid : 없음` — 시험 프로세스가 `pg.pid`에 기록되지 않았음을 확인.

---

## V3. `bash experiments/electron-phase-0/verify/t2-extensions.sh`
- cwd: `<repo root>`
- 기대: exit 0. `pg_extension`에 `vector`와 `pg_bigm`(버전 `1.2`)이 모두 존재
- 실제: `pg_bigm | 1.2`, `vector | 0.8.6` — 둘 다 존재. 확장 코드 실행(코사인 거리, bigm_similarity, likequery)도 동작 확인. 확장 로드 dyld 증거가 번들 경로에서 나옴
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
== 서버 준비
  서버 상태: 살아 있음 (pid 1764)

== 1. CREATE EXTENSION (멱등)
NOTICE:  extension "vector" already exists, skipping
NOTICE:  extension "pg_bigm" already exists, skipping
   extname | extversion
  ---------+------------
   pg_bigm | 1.2
   plpgsql | 1.0
   vector  | 0.8.6
  (3 rows)

  OK   vector 0.8.6
  OK   pg_bigm 1.2 (be/docker/postgres-bigm/Dockerfile의 1.2-20240606과 같은 계열)

== 2. 확장 코드 실행 (.dylib가 실제로 로드되는 경로)
  OK   pgvector: '[1,0,0]' <=> '[0,1,0]' = 1.000 (코사인 거리 연산자 동작)
  OK   pg_bigm: bigm_similarity=0.714  likequery('회의')=%회의%
  OK   gin_bigm_ops 연산자 클래스가 있다
  OK   hnsw 접근 방법이 있다

== 3. 확장 로드의 dyld 실측 (규칙 3b — 서버 로그에서 꺼낸다)
  증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t2-extension-load-dyld.txt
    dyld[1764]: <1B98DB38-0843-35AF-818B-308EEA882FE1> .../bundle/pg/lib/postgresql/vector.dylib
    dyld[1764]: <B960C51B-4601-39C8-A0CE-29491A9636E9> .../bundle/pg/lib/postgresql/pg_bigm.dylib
    dyld[93429]: <1B98DB38-0843-35AF-818B-308EEA882FE1> .../bundle/pg/lib/postgresql/vector.dylib
    dyld[93429]: <3B2273DB-2895-30E2-9A78-2E51B930755C> .../bundle/pg/lib/postgresql/plpgsql.dylib
    dyld[93429]: <B960C51B-4601-39C8-A0CE-29491A9636E9> .../bundle/pg/lib/postgresql/pg_bigm.dylib
    dyld[97869]: <1B98DB38-0843-35AF-818B-308EEA882FE1> .../bundle/pg/lib/postgresql/vector.dylib
    dyld[97869]: <B960C51B-4601-39C8-A0CE-29491A9636E9> .../bundle/pg/lib/postgresql/pg_bigm.dylib
  OK   vector.dylib 를 번들 경로에서 로드했다
  OK   pg_bigm.dylib 를 번들 경로에서 로드했다
  OK   확장 로드 경로가 전부 번들 안이다

판정: 번들의 pgvector·pg_bigm이 로드되고 동작한다
```
</details>

---

## V4. `DATABASE_URL=postgresql://postgres@127.0.0.1:55432/damwha pnpm be:migrate`
- cwd: `<repo root>`
- 기대: exit 0
- 실제: pnpm/ts-node 실행 로그만 출력, 예외 없이 종료. `be/src/database/migrate.ts`는 성공 시 콘솔 출력이 없는 구조(적용된 마이그레이션이 없을 때도 조용히 exit 0) — 이번 실행 이전에 이미 24개 전부가 적용돼 있어(2026-09-09T08:24 UTC 구현 단계에 적용, `t2-migrate.txt` 참조) 이번 회차는 신규 적용 0건으로 멱등하게 통과했다
- 일치: 예 (exit 0 확인. 이 명령은 계획 §4.0에 따라 **격리 대상 밖**이며 `run-isolated.sh`를 거치지 않고 그대로 실행했다)
- 종료 코드: 0
<details><summary>전체 출력</summary>

```

> damwha@0.2.3 be:migrate /Users/gim-yeongjae/project/daewha-electron-phase-0
> pnpm --filter damwha-be run migrate


> damwha-be@0.2.3 migrate /Users/gim-yeongjae/project/daewha-electron-phase-0/be
> ts-node src/database/migrate.ts

```
</details>

---

## V5. `bash experiments/electron-phase-0/verify/t2-migrations.sh`
- cwd: `<repo root>`
- 기대: exit 0. 55432의 `_migrations` 행 수가 `be/src/database/migrations/*.sql` 파일 수(24)와 같음
- 실제: 마이그레이션 파일 24개, `_migrations` 행 **24개**, 대상이 포트 55432 · 데이터 디렉터리 `sandbox/pgdata` 임을 확인
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
== 서버 준비
  서버 상태: 살아 있음 (pid 1764)

== 파일과 행 수
  마이그레이션 파일 : 24 개 (/Users/gim-yeongjae/project/daewha-electron-phase-0/be/src/database/migrations)
  _migrations 행    : 24 개 (127.0.0.1:55432/damwha)
  OK   파일 수와 행 수가 같다
  OK   계획의 고정값 24와 같다

== 적용 대상이 실험 인스턴스인지
  port           : 55432
  data_directory : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata
  database       : damwha
  OK   실험 포트다 (개발 5432가 아니다)
  OK   데이터 디렉터리가 샌드박스 안이다

== 마이그레이션이 만든 스키마의 표본
             name
  --------------------------
   001_init.sql
   002_search.sql
   003_meeting_favorite.sql
  (3 rows)

   tables
  --------
       17
  (1 row)

판정: 실험 DB에 마이그레이션 전량이 적용돼 있다
```
</details>

---

## V6. `bash experiments/electron-phase-0/verify/t2-restart.sh`
- cwd: `<repo root>`
- 기대: exit 0. `pg_ctl stop -m fast` 후 재기동해도 `_migrations`가 24
- 실제: 정지 전 pid 1764, `_migrations` 24. `pg_ctl stop -m fast`로 정지 확인. 재기동 후 새 pid 2767(다른 프로세스), `_migrations` **24 유지**, system identifier 동일(같은 클러스터), 확장 2종 그대로
- 일치: 예
- 종료 코드: 0
- **서버 상태(이 행 뒤):** 살아 있음, pid 2767
<details><summary>전체 출력</summary>

```
== 사전 상태
  서버 상태: 살아 있음 (pid 1764)
  pid 1764 / _migrations 24 / 파일 24
  system identifier: 7683446811500268117

== 정상 종료 (pg_ctl stop -m fast)
waiting for server to shut down.... done
server stopped
정지 완료 (pid 1764)
  OK   정지됨

== 재기동 (run-isolated.sh --label t2-restart)
run-isolated: label=t2-restart  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.6aX1Ot/stderr.raw)
postgres 기동: pid 2767  port 55432  data /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata
준비됨 (pg_isready)
데이터베이스 damwha 있음
2026-09-09 17:37:57.168 KST [2767] LOG:  redirecting log output to logging collector process
2026-09-09 17:37:57.168 KST [2767] HINT:  Future log output will appear in directory "log".
  OK   재기동됨 (pid 2767)
  OK   새 프로세스다 (이전 pid 1764)

== 재기동 후 상태
  _migrations 24 / system identifier 7683446811500268117
  OK   _migrations가 24 로 유지됐다
  OK   같은 클러스터다 (system identifier 동일)
  OK   확장 2종이 그대로 있다

== 재기동한 서버의 dyld 실측 (규칙 6b)
  OK   pid 2767 이 번들 postgres를 로드한 줄이 있다

판정: 정상 종료 후 재기동해도 스키마가 유지된다
```
</details>

---

## V7. `bash experiments/electron-phase-0/verify/t2-crash-recovery.sh`
- cwd: `<repo root>`
- 기대: exit 0. PID 파일 대상 SIGKILL 후 재기동해도 `_migrations`가 24
- 실제: 사전 pid 2767, `_migrations` 24. postmaster + 자식 6개(2771/2772/2773/2777/2778/2779) SIGKILL. 재기동 pid 3067. 서버 로그에 `automatic recovery in progress` / `redo starts at ...` / `redo done at ...` 기록. 재기동 후 `_migrations` **24 유지**, crash 직전 커밋 행 생존, 확장 2종 유지
- 일치: 예
- 종료 코드: 0
- **서버 상태(이 행 뒤):** 살아 있음, pid 3067
<details><summary>전체 출력</summary>

```
== 사전 상태
  서버 상태: 살아 있음 (pid 2767)
NOTICE:  relation "t2_crash_probe" already exists, skipping
  pid 2767 / _migrations 24 / 표식 t2-crash-20260909T083803Z

== SIGKILL (PID 파일 대상)
SIGKILL: postmaster pid 2767
SIGKILL: 자식 pid 2771 (postmaster의 보조 프로세스)
SIGKILL: 자식 pid 2772 (postmaster의 보조 프로세스)
SIGKILL: 자식 pid 2773 (postmaster의 보조 프로세스)
SIGKILL: 자식 pid 2777 (postmaster의 보조 프로세스)
SIGKILL: 자식 pid 2778 (postmaster의 보조 프로세스)
SIGKILL: 자식 pid 2779 (postmaster의 보조 프로세스)
강제 종료 완료
  OK   강제 종료됨

== 재기동 (run-isolated.sh --label t2-crash-restart)
run-isolated: label=t2-crash-restart  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.jmgDjE/stderr.raw)
postgres 기동: pid 3067  port 55432  data /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata
준비됨 (pg_isready)
데이터베이스 damwha 있음
2026-09-09 17:38:04.344 KST [3067] LOG:  redirecting log output to logging collector process
2026-09-09 17:38:04.344 KST [3067] HINT:  Future log output will appear in directory "log".
  OK   재기동됨 (pid 3067)

== crash recovery 흔적
  증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t2-crash-recovery.txt
    2026-09-09 17:38:04.427 KST [3074] LOG:  database system was not properly shut down; automatic recovery in progress
    2026-09-09 17:38:04.429 KST [3074] LOG:  redo starts at 0/1B26EF8
    2026-09-09 17:38:04.430 KST [3074] LOG:  redo done at 0/1B27100 system usage: CPU: user: 0.00 s, system: 0.00 s, elapsed: 0.00 s
    2026-09-09 17:38:04.432 KST [3072] LOG:  checkpoint complete: wrote 5 buffers (0.0%); 0 WAL file(s) added, 0 removed, 0 recycled; write=0.001 s, sync=0.001 s, total=0.002 s; sync files=4, longest=0.001 s, average=0.001 s; distance=0 kB, estimate=0 kB; lsn=0/1B27128, redo lsn=0/1B27128
    2026-09-09 17:38:04.434 KST [3067] LOG:  database system is ready to accept connections
  OK   서버 로그에 crash recovery 기록이 있다

== 재기동 후 상태
  OK   _migrations가 24 로 유지됐다
  OK   crash 직전에 커밋한 행이 살아남았다 (t2-crash-20260909T083803Z)
  OK   확장 2종이 그대로 있다

판정: SIGKILL 후 재기동에서 crash recovery가 동작하고 데이터가 남는다
```
</details>

---

## V8. `bash experiments/electron-phase-0/verify/t2-idempotent.sh`
- cwd: `<repo root>`
- 기대: exit 0. `run.sh initdb`를 다시 불러도 데이터 디렉터리를 재초기화하지 않고 `_migrations`가 24 유지
- 실제: `initdb` 재호출이 "이미 초기화돼 있다"로 조기 반환. system identifier 동일(재초기화 안 됨), `_migrations` **24 유지**, 서버 프로세스 pid 3067 그대로(재시작 없이 계속 생존)
- 일치: 예
- 종료 코드: 0
- **서버 상태(이 행 뒤):** 살아 있음, pid 3067 (변화 없음)
<details><summary>전체 출력</summary>

```
== 사전 상태
  서버 상태: 살아 있음 (pid 3067)
  _migrations 24 / system identifier 7683446811500268117 / pid 3067

== run.sh initdb 재호출 (run-isolated.sh --label t2-initdb-again)
  이미 초기화돼 있다: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata (다시 initdb 하지 않는다 — 스펙 §4.4 멱등)
    PG_VERSION: 16
  OK   exit 0
  OK   이미 초기화됐다고 판단하고 아무것도 하지 않았다

== 사후 상태
  _migrations 24 / system identifier 7683446811500268117 / pid 3067
  OK   클러스터가 재초기화되지 않았다 (system identifier 동일)
  OK   _migrations가 24 로 유지됐다
  OK   서버 프로세스가 그대로다 (pid 3067)
  OK   서버가 계속 살아 있다

판정: initdb 재호출이 멱등하다
```
</details>

### V5·V6·V7·V8 `_migrations` 행 수 요약 (기대값 24)

| Verify | 상황 | `_migrations` 행 수 | 기대와 일치 |
| --- | --- | --- | --- |
| V5 | 첫 마이그레이션 적용 직후 | 24 | 예 |
| V6 | `pg_ctl stop -m fast` 정상 종료 후 재기동 | 24 | 예 |
| V7 | PID 대상 SIGKILL 후 재기동 (crash recovery) | 24 | 예 |
| V8 | `run.sh initdb` 재호출(멱등) 후 | 24 | 예 |

---

## V9. `bash experiments/electron-phase-0/verify/t2-dev-db-untouched.sh`
- cwd: `<repo root>`
- 기대: exit 0. `damwha_pgdata` 볼륨이 그대로 존재하고, 개발 컨테이너 수가 Task 시작 시점과 같음
- 실제: `damwha_pgdata`·`be_pgdata` 그대로 존재, 시작 시점 볼륨 15개 전부 유지. 컨테이너 수 시작 3 / 지금 3. 실험 서버(pid 3067)는 55432만 LISTEN, 5432는 잡지 않음(5432는 pid 1397/OrbStack이 계속 보유)
- 일치: 예
- 종료 코드: 0
<details><summary>전체 출력</summary>

```
== 기준선
  /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t2-dev-baseline.txt (2026-09-09T08:01:26Z)

== 1. 볼륨
  OK   damwha_pgdata 가 그대로 있다
  OK   be_pgdata 가 그대로 있다
  OK   시작 시점의 볼륨이 하나도 사라지지 않았다 (15개)

== 2. 컨테이너 수
  시작 시점: 3 / 지금: 3
  OK   같다

== 3. 실험 서버의 포트
  실험 서버 pid 3067 가 LISTEN하는 포트: 55432
  OK   실험 포트 55432 에 붙어 있다
  OK   개발 포트 5432를 잡고 있지 않다
  참고: 5432를 물고 있는 프로세스 pid = 1397 (개발 인스턴스. 실험은 여기 붙지 않는다)

== 4. 실험이 쓴 경로
  데이터 디렉터리: /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/sandbox/pgdata
  OK   샌드박스 안이다

판정: 개발 DB의 볼륨·컨테이너가 Task 시작 시점과 같다
```
</details>

**직접 대조 (`docker volume ls` / `docker ps` 재실행 결과 vs `t2-dev-baseline.txt`):** 두 출력이 볼륨 목록·이름·개수, 컨테이너 이름·개수(3), 5432 LISTEN pid(1397) 모두 문자 그대로 일치했다.

---

## V10. `bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after`
- cwd: `<repo root>`
- 기대: exit 0
- 실제: `개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다`. `be/storage`: files=29, bytes=2227477523, newest_mtime=1788857034, `manifest_sha256=a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be`
- 일치: 예
- 종료 코드: 0

**전후 sha256 대조 (`$EVIDENCE/dev-assets-latest.txt`의 `## before` / `## after` 블록):**

| 항목 | before | after |
| --- | --- | --- |
| `be/storage` files | 29 | 29 |
| `be/storage` bytes | 2227477523 | 2227477523 |
| `be/storage` newest_mtime | 1788857034 | 1788857034 |
| `manifest_sha256` | `a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be` | `a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be` |
| `docker volume ls` 목록 | 15개 (동일 목록) | 15개 (동일 목록, 문자 그대로 동일) |

before/after 두 sha256이 동일하다.

<details><summary>전체 출력</summary>

```
개발 자산 무변화 — docker 볼륨과 be/storage 매니페스트가 before와 같다
## docker volumes
2deac09559ef79effc56c7230c228d0109d309fc4f208051ecc08c1c65c9ccc0
3a0f65c5f8709d0b6b08af645aeb746d96a340603e1d37a12d4413556a16f984
3a559c09626e43a1c2538d4173f17ecb0c710a9cabac042b7d0517f6f3a3d95e
564b2a00aa80cb4b3795532907244d41dd6e245eae5d921bdf32a9bc9425830c
7a6f325733f01c9cf627f80691db77ed6a4ebd06325108e804f01e6b140e5f81
be_pgdata
blog-local_minio_data
blog-local_postgres_data
c9975fd05f0848f0fe72889a84bf13ae1eb2b20bfbea00828398f19ab845473e
damwha_pgdata
docker_mariadb-local-data
e33e9714513e13422fdd6cb4081a173df3460999fde456bd8294619ad0facb52
redpanda_redpanda-data
trb_db_db_data
trb_db_db_logs
## be/storage
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
```
</details>

---

## V11. `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts`
- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음 (0줄)
- 일치: 예
- 종료 코드: 0

---

## 재배치 증거 요약 (`t2-relocation-attempt1.txt` vs `t2-build-relocation.txt`)

두 파일은 같은 재배치 절차의 서로 다른 회차를 담고 있다. `t2-relocation-attempt1.txt`는 `pg/build.sh`의 **1차(순진한) 형태**가 남긴 기록의 보존본이고, `t2-build-relocation.txt`는 그 형태를 고친 뒤(현재 `build.sh`)의 기록이다.

| | `t2-relocation-attempt1.txt` (1차 시도) | `t2-build-relocation.txt` (수정 후, 현재 `build.sh`) |
| --- | --- | --- |
| 이동 후 G1(`check-macho.sh bundle/pg`) exit | **1** | **0** |
| 위반 건수 | **8건** | **0건** |
| 위반 형태 | STRING 5건(`/opt/homebrew/...` — `lib/postgresql/pgxs/src/Makefile.global`), STALE-PATH 3건(빌드 트리·스테이징 절대 경로가 `Makefile.global`과 `vector.dylib`에 남음) | 없음 |
| 원인(파일에 적힌 설명) | (1) PGXS 설치 경로 오판 — `lib/pgxs`가 아니라 `lib/postgresql/pgxs`(prefix에 `postgres`/`pgsql`이 없어 `pkglibdir=prefix/lib/postgresql`이 됨)라 빌드 전용 산출물(`Makefile.global`) 제거가 빠짐 → Homebrew 도구 경로·빌드 트리 경로가 그대로 번들에 남음. (2) 확장(`pgvector`) 빌드에 `-fmacro-prefix-map`이 없어 서버 헤더 인라인 함수의 `__FILE__`이 스테이징 절대 경로 그대로 `vector.dylib`에 박힘 — 이동 **전**에는 검사 대상(`stage/pg`) 안이라 INFO였다가 이동 **후** STALE-PATH 위반으로 전환 | 위 두 원인을 `build.sh`에서 수정(PGXS 산출물 제거 경로 수정, `-fmacro-prefix-map` 적용)한 결과로 재배치 후 위반 0건 |
| `bin/psql` 실행 | 기록 없음(파일에는 이 항목이 최종 결과 절에 없음 — attempt1 발췌는 `## 9` 이후만 포함) | exit 0, `psql (PostgreSQL) 16.15` |
| 번들 크기 | 22M | 21M |
| `install_name_tool`/`codesign` 사후 처리 | 있음(rpath를 `@loader_path`/`@rpath`로 변경 후 `codesign -f -s -`) — `build.sh`에 남아 재현 가능 | 동일 처리 |

요컨대 이동 전에는 드러나지 않다가 **이동 후에만** STALE-PATH로 바뀌는 위반(`vector.dylib`의 `__FILE__` 임베드)이 1차 시도에서 실측으로 확인됐고, `build.sh` 수정 후 재배치 결과(오늘 V1이 검증한 `bundle/pg`)는 위반 0건이다.

---

## 프로세스 정리

Verify 표(V1~V11)를 순서대로 실행한 뒤, 이 verifier가 마지막으로 띄운 실험 postgres(V8 시점 pid 3067)를 `experiments/electron-phase-0/pg/run.sh stop`(PID 파일 대상, `pg_ctl stop -m fast`)으로 정리했다. `pkill`/`killall`은 쓰지 않았다.

- 기동 전 (V2 실행 직전): 실험 postgres 프로세스 없음 (`ps aux | grep -i postgres` 매치 0건)
- 정리 직전 (V11 이후): 아래 7개 프로세스 (postmaster + 보조 6개)
  ```
  gim-yeongjae 3079 ... postgres: logical replication launcher
  gim-yeongjae 3078 ... postgres: autovacuum launcher
  gim-yeongjae 3077 ... postgres: walwriter
  gim-yeongjae 3073 ... postgres: background writer
  gim-yeongjae 3072 ... postgres: checkpointer
  gim-yeongjae 3071 ... postgres: logger
  gim-yeongjae 3067 ... .../bundle/pg/bin/postgres -D .../sandbox/pgdata -p 55432
  ```
  `pg.pid` = 3067
- 정리 명령: `bash experiments/electron-phase-0/pg/run.sh stop` → 출력 `waiting for server to shut down.... done` / `server stopped` / `정지 완료 (pid 3067)`, exit 0
- 정리 후: `ps aux | grep -i "bundle/pg/bin/postgres \|postgres: "` 매치 0건. `experiments/electron-phase-0/sandbox/run/pg.pid` 파일 없음(정상 삭제됨)

## 검증 종료 시점 상태

- 실험 PostgreSQL: **떠 있지 않음** (위 정리 절차로 정지, pid 파일 없음)
- 개발 postgres(포트 5432, `damwha-postgres` 컨테이너): 처음부터 끝까지 손대지 않음. 컨테이너 상태·볼륨은 V9·V10이 대조

## `$EVIDENCE`(`docs/superpowers/reports/evidence/phase-0/`) 디렉터리 파일 목록·확장자별 개수

- 총 파일 수: 67
- 확장자별: `.md` 4개, `.txt` 63개 (`.log` 0개)
- 이 회차(Task 2 verify)에서 새로 생긴 `.prev-<timestamp>.txt` 파일들은 `run-isolated.sh`가 같은 라벨을 다시 실행할 때 **이전 회차 증거를 덮어쓰지 않고 자동으로 회전 보존**하는 하네스 자체 동작이다 — verifier가 기존 파일을 지우거나 손으로 옮기지 않았다. 예: `t2-start-dyld.prev-20260909T083648Z.txt`(V6 재기동 시 V2의 이전 `t2-start-dyld.txt`가 회전된 것), `t2-restart-dyld.prev-20260909T083757Z.txt`, `t2-crash-restart-dyld.prev-20260909T083804Z.txt`, `t2-initdb-again-dyld.prev-20260909T083810Z.txt` 등.
- `task-1-r1.md`~`task-1-r4.md`, 기존 `t1-*.txt`는 이 회차에서 건드리지 않았다 (수정 없음).

전체 목록 (알파벳순):

```
dev-assets-latest.txt
t1-dyld-control-dyld.txt
t1-dyld-control-env.txt
t1-dyld-launcher-fake-dyld.txt
t1-dyld-launcher-fake-env.txt
t1-dyld-launcher-noexport-dyld.txt
t1-dyld-launcher-noexport-env.txt
t1-dyld-launcher-reexport-dyld.txt
t1-dyld-launcher-reexport-env.txt
t1-env-dyld.txt
t1-env-env.txt
t1-home-dyld.txt
t1-home-env.txt
t1-nodev-dyld.txt
t1-nodev-env.txt
t2-build-relocation.txt
t2-candidates.txt
t2-crash-recovery.txt
t2-crash-restart-dyld.prev-20260909T083218Z.txt
t2-crash-restart-dyld.prev-20260909T083804Z.txt
t2-crash-restart-dyld.txt
t2-crash-restart-env.prev-20260909T083218Z.txt
t2-crash-restart-env.prev-20260909T083804Z.txt
t2-crash-restart-env.txt
t2-crash-restart-stderr.prev-20260909T083218Z.txt
t2-crash-restart-stderr.prev-20260909T083804Z.txt
t2-crash-restart-stderr.txt
t2-dev-baseline.txt
t2-extension-load-dyld.txt
t2-initdb-again-dyld.prev-20260909T083218Z.txt
t2-initdb-again-dyld.prev-20260909T083810Z.txt
t2-initdb-again-dyld.txt
t2-initdb-again-env.prev-20260909T083218Z.txt
t2-initdb-again-env.prev-20260909T083810Z.txt
t2-initdb-again-env.txt
t2-initdb-dyld.txt
t2-initdb-env.txt
t2-migrate.txt
t2-pgctl-trial-dyld.txt
t2-pgctl-trial-env.txt
t2-pgctl-trial.txt
t2-relocation-attempt1.txt
t2-restart-dyld.prev-20260909T083217Z.txt
t2-restart-dyld.prev-20260909T083757Z.txt
t2-restart-dyld.txt
t2-restart-env.prev-20260909T083217Z.txt
t2-restart-env.prev-20260909T083757Z.txt
t2-restart-env.txt
t2-restart-stderr.prev-20260909T083217Z.txt
t2-restart-stderr.prev-20260909T083757Z.txt
t2-restart-stderr.txt
t2-start-dyld.prev-20260909T082035Z.txt
t2-start-dyld.prev-20260909T083203Z.txt
t2-start-dyld.prev-20260909T083648Z.txt
t2-start-dyld.txt
t2-start-env.prev-20260909T082035Z.txt
t2-start-env.prev-20260909T083203Z.txt
t2-start-env.prev-20260909T083648Z.txt
t2-start-env.txt
t2-start-stderr.prev-20260909T082035Z.txt
t2-start-stderr.prev-20260909T083203Z.txt
t2-start-stderr.prev-20260909T083648Z.txt
t2-start-stderr.txt
task-1-r1.md
task-1-r2.md
task-1-r3.md
task-1-r4.md
```

## `git status --porcelain` 전체 출력 (검증 실행 후, 이 증거 파일 작성 전 시점)

```
 M docs/superpowers/reports/evidence/phase-0/dev-assets-latest.txt
 M docs/superpowers/reports/evidence/phase-0/t2-crash-recovery.txt
 M docs/superpowers/reports/evidence/phase-0/t2-crash-restart-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t2-crash-restart-env.txt
 M docs/superpowers/reports/evidence/phase-0/t2-crash-restart-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t2-extension-load-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t2-initdb-again-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t2-initdb-again-env.txt
 M docs/superpowers/reports/evidence/phase-0/t2-restart-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t2-restart-env.txt
 M docs/superpowers/reports/evidence/phase-0/t2-restart-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t2-start-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t2-start-env.txt
 M docs/superpowers/reports/evidence/phase-0/t2-start-stderr.txt
?? docs/superpowers/reports/evidence/phase-0/t2-crash-restart-dyld.prev-20260909T083804Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-crash-restart-env.prev-20260909T083804Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-crash-restart-stderr.prev-20260909T083804Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-initdb-again-dyld.prev-20260909T083810Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-initdb-again-env.prev-20260909T083810Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-restart-dyld.prev-20260909T083757Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-restart-env.prev-20260909T083757Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-restart-stderr.prev-20260909T083757Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-start-dyld.prev-20260909T083648Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-start-env.prev-20260909T083648Z.txt
?? docs/superpowers/reports/evidence/phase-0/t2-start-stderr.prev-20260909T083648Z.txt
```

(`.prev-*` 파일들과 `M` 표시된 라벨별 최신 파일은 모두 `run-isolated.sh`/`run.sh`/`verify/*.sh`가 Verify 표의 명령을 실행하며 자체적으로 생성·회전한 것이다. 이 목록에 소스·설정·계획 문서는 없다.)

## 부록 — V1~V11 명령·기대·실제·일치 요약표

| # | 명령(요약) | 기대 | 실제(핵심) | 일치 |
| --- | --- | --- | --- | --- |
| V1 | `check-macho.sh bundle/pg` | exit 0, 위반 0건 | exit 0, 위반 0건 | 예 |
| V2 | `run-isolated.sh --label t2-start -- pg/run.sh start` | exit 0, pg.pid 생성, 논블로킹 | exit 0, pid 1764, pg.pid=1764 | 예 |
| V2b | `t2-dyld-measured.sh` | exit 0, pid 고정 후 번들 경로 확인 | exit 0, pid 1764의 로드 목록에 번들 postgres 있음 | 예 |
| V2c | `t2-no-pgctl-start.sh` | exit 0, 정적+실측 | exit 0, pg_ctl start 없음, 시험 postmaster dyld 0건 실측 | 예 |
| V3 | `t2-extensions.sh` | exit 0, vector+pg_bigm 1.2 | exit 0, vector 0.8.6 / pg_bigm 1.2 | 예 |
| V4 | `DATABASE_URL=...55432... pnpm be:migrate` | exit 0 | exit 0 (격리 대상 밖) | 예 |
| V5 | `t2-migrations.sh` | exit 0, `_migrations`=24 | exit 0, 24 | 예 |
| V6 | `t2-restart.sh` | exit 0, 재기동 후 24 | exit 0, 24 (pid 1764→2767) | 예 |
| V7 | `t2-crash-recovery.sh` | exit 0, SIGKILL 후 24 | exit 0, 24 (pid 2767→3067, redo 로그 확인) | 예 |
| V8 | `t2-idempotent.sh` | exit 0, 재초기화 없이 24 | exit 0, 24 (pid 3067 유지) | 예 |
| V9 | `t2-dev-db-untouched.sh` | exit 0, damwha_pgdata·컨테이너 수 동일 | exit 0, 15볼륨/3컨테이너 동일 | 예 |
| V10 | `snapshot-dev-assets.sh after` | exit 0 | exit 0, sha256 before=after | 예 |
| V11 | `git status --porcelain be/src ...` | 출력 없음 | 출력 없음 | 예 |
