# Task 2 — PostgreSQL 번들 후보

스펙 P0-C1이 요구하는 것: **Docker·Homebrew 없이** PostgreSQL 16 + pgvector +
pg_bigm이 뜨고, 마이그레이션 24개를 받아내고, 정상 종료·강제 종료 후 재기동에서
살아남는가. 그 후보를 여기서 고르고, 만들고, 옮겨 본다.

실측값은 전부 `docs/superpowers/reports/evidence/phase-0/`에 있다.

| 증거 | 내용 |
| --- | --- |
| `t2-candidates.txt` | 후보 4종 조사에서 **실제로 확인한 값** |
| `t2-relocation-attempt1.txt` | 재배치 1차 시도 — 무엇이 깨졌는지 |
| `t2-build-relocation.txt` | 고친 뒤의 빌드·재배치 전 과정 |
| `t2-pgctl-trial*.txt` | `pg_ctl start`가 dyld 실측을 잃는다는 실측 (계획 규칙 2b) |
| `t2-start-*.txt`, `t2-restart-*`, `t2-crash-restart-*` | 격리 기동의 dyld 실측 |
| `t2-extension-load-dyld.txt` | 확장 `.dylib`의 dlopen 경로 |
| `t2-migrate.txt` | `pnpm be:migrate` 적용 기록 (격리 대상 밖) |
| `t2-crash-recovery.txt` | SIGKILL 후 crash recovery 로그 |
| `t2-dev-baseline.txt` | Task 시작 시점의 개발 DB 상태 (V9의 대조 기준) |

## 고른 것 — 소스 빌드 (스펙 §9 후보 3)

```
PostgreSQL 16.15   ftp.postgresql.org (배포처가 공개한 sha256과 대조)
pgvector   0.8.6
pg_bigm    1.2-20240606   be/docker/postgres-bigm/Dockerfile과 같은 버전
```

16.15는 **개발 이미지와 같은 마이너 버전**이다 —
`damwha/postgres-bigm:pg16`의 이미지 환경변수 `PG_VERSION=16.15-1.pgdg12+2`.
확장 ABI와 카탈로그가 개발 DB와 어긋나면 Task 6(하이브리드 검색)이
"번들이 문제인지 버전이 문제인지" 구분할 수 없게 된다.

결과: **arm64 네이티브, 21 MB, `otool -L bin/postgres`의 외부 의존이
`/usr/lib/libSystem.B.dylib` 하나뿐**이다. ICU·readline·zlib·OpenSSL을 전부 끄고
빌드했기 때문이다. G1(정적 검사) 위반 0건.

## 탈락시킨 것

**후보 1 — EnterpriseDB 바이너리 아카이브.** *배포 자체가 없다.*
EDB의 "Download PostgreSQL Binaries" 페이지에 걸린 `osx-binaries.zip`은
9.2.24와 9.3.25뿐이고, 16.x의 macOS 칸은 아카이브가 아니라 설치 프로그램으로
이어진다. linux-x64/windows-x64는 최신까지 계속 올라오는 것과 대비된다.
받을 것이 없으므로 후보에서 빠진다.

**후보 2 — Postgres.app에서 추출.** 받아서 뜯어보지 않았다. 판단 근거는 둘이다.
- **`pg_bigm` 때문에 어차피 툴체인이 필요하다.** 배포 바이너리가 없어 소스에서
  빌드해야 하고(R-1), 그러려면 그 배포본의 `pg_config`·서버 헤더에 맞춰
  컴파일해야 한다. 즉 "빌드를 피하려고" 배포본을 쓰는 이점이 남지 않는다.
- **필요 없는 것을 통째로 들고 온다.** 16 전용 판이 112.9 MB이고(2.9.6 기준)
  그 안에는 우리가 끄고 빌드한 ICU·OpenSSL·libxml 같은 의존과 여러 확장이
  들어 있다. 그것들은 Task 8(서명 대상)과 Task 9(라이선스 추적 대상)를 그대로
  늘린다. 우리가 만든 트리는 21 MB에 외부 의존이 `libSystem` 하나다.

**후보 4 — embedded-postgres(zonky) 아카이브.** *확장을 붙일 수단이 없다.*
`darwin-arm64v8:16.15.0`을 실제로 받아 풀어 봤다.
- `bin/`에 `initdb`·`pg_ctl`·`postgres` 셋뿐이다. **`pg_config`가 없다.**
- `include/`(서버 헤더)도 `lib/postgresql/pgxs`도 없다.
- 즉 pgvector·pg_bigm을 이 배포본에 맞춰 빌드할 방법이 아카이브 안에 없다.
  (contrib는 미리 들어 있지만 우리가 쓰는 둘은 contrib가 아니다.)
- 게다가 universal 바이너리 + ICU 68 데이터 + krb5/OpenSSL/libxml로 트리가
  **296 MB**다. 소스 빌드본의 14배다.

## 재배치에서 실제로 깨진 것 — R-1 / R-2

이 Task의 핵심은 "빌드한 자리에서 도는가"가 아니라 **"옮긴 자리에서 도는가"** 다.
그래서 `build.sh`는 일부러 세 경로를 서로 다르게 둔다.

```
빌드 시점 prefix : /opt/damwha-phase0/pg16   (이 머신에 존재하지 않는다)
스테이징         : $EXP/stage/pg             (DESTDIR로 여기에 설치)
최종             : $EXP/bundle/pg            (여기로 옮긴 뒤 모든 검증)
```

`--prefix`에 최종 경로를 넣어 버리면 재배치를 한 번도 묻지 않은 채로 통과한다.
중립 prefix로 빌드하면 컴파일 시점 경로가 **어디에도 존재하지 않으므로**,
경로 해석이 실행 파일 위치 기준으로 다시 계산되는지가 그대로 드러난다.

### 깨진 것 1 — 공유 라이브러리 install_name (이동 즉시 실행 불가)

PostgreSQL은 macOS에서 `-install_name $(libdir)/lib…`로 링크한다. 옮기고 나면
클라이언트가 dyld 단계에서 죽는다. 1차 시도의 실측 그대로다.

```
$ bundle/pg/bin/psql --version        # exit 134
dyld[59029]: Library not loaded: /opt/damwha-phase0/pg16/lib/libpq.5.dylib
  Referenced from: …/bundle/pg/bin/psql
  Reason: tried: '/opt/damwha-phase0/pg16/lib/libpq.5.dylib' (no such file) …
```

`otool -L` 기준 위반 **37건** — `bin/` 20개(psql·pg_isready·pg_dump·initdb…)와
`lib/` 17개(`libpq`·`libecpg`·`libpgtypes` 계열의 자기 id와 상호 참조)다.
**서버는 멀쩡했다** — `postgres`는 libpq를 링크하지 않는다. 서버만 보고 "재배치
된다"고 적었으면 psql·pg_isready·pg_dump가 전부 죽은 번들을 통과시킬 뻔했다.

고친 방법(`build.sh`의 8단계, **이동한 뒤에** 돌린다):
- 의존 경로를 `@loader_path/…` 상대로 바꾼다 (`install_name_tool -change`)
- dylib의 `-id`를 `@rpath/…`로 바꾼다
- 번들 밖을 가리키는 `LC_RPATH`가 있으면 지운다
- 고친 Mach-O를 `codesign -f -s -`로 **ad-hoc 재서명**한다.
  `install_name_tool`이 서명을 무효화하는데 arm64에서는 서명 없는 Mach-O가
  실행되지 않는다. ad-hoc 서명은 플랫폼 바이너리로 만들지 않으므로 `DYLD_*`
  실측도 그대로 살아 있다 (Task 8이 다룰 진짜 서명과는 별개다).

새 경로가 옛 경로보다 짧아서 로드 커맨드 공간 문제는 없었다.

### 깨진 것 2 — 확장에 박힌 빌드 시점 include 경로 (이동 후에야 위반이 된다)

PGXS는 `pg_config`가 알려 주는 **절대** include 경로로 컴파일하므로, 서버 헤더의
인라인 함수에 있는 `Assert`의 `__FILE__`이 스테이징 경로 그대로
`vector.dylib`에 박힌다. 이것이 R-1("`pg_config` 기준 절대 경로가 산출물에
박혀 재배치가 깨진다")의 두 번째 얼굴이다.

무서운 점은 **이동 전에는 위반으로 보이지 않는다**는 것이다. 검사 대상
디렉터리 안을 가리키므로 `check-macho.sh`가 `INFO`로 분류한다. 옮기는 순간
같은 문자열이 `STALE-PATH` 위반이 된다. 두 상태가 `t2-relocation-attempt1.txt`의
`## 5`와 `## 9`에 나란히 남아 있다.

고친 방법: 확장 빌드에 `-fmacro-prefix-map=<스테이징>=<중립 prefix>`를 준다.
`__FILE__`이 중립 prefix로 되돌아가 코어 `postgres` 바이너리가 애초에 갖는
형태와 같아진다.

### 깨지지 **않은** 것 — 파일 경로 해석 (R-2)

PostgreSQL은 실행 파일 자신의 위치에서 `share`/`lib` 경로를 다시 계산한다
(`src/port/path.c`의 `make_relative_path`). 컴파일 시점 문자열이 존재하지 않는
`/opt/damwha-phase0/pg16`인데도 이동 후 `pg_config`가 번들 안을 보고했고,
`initdb`가 `share/postgresql`을 찾아 클러스터를 만들었다.

```
$ bundle/pg/bin/pg_config --sharedir
…/experiments/electron-phase-0/bundle/pg/share/postgresql
```

**R-2("initdb 시점의 경로 가정 때문에 옮기면 깨진다")는 이 구성에서는 성립하지
않았다.** 깨지는 것은 경로 해석이 아니라 dylib install_name 쪽이었다.

## 번들에서 뺀 것

`lib/postgresql/pgxs`, `include/`, `lib/pkgconfig`, `lib/*.a` — **확장을 빌드할
때만** 필요하고 앱 실행에는 쓰이지 않는다. 남겨 두면 재배치와 무관한 빌드 기록이
G1 위반으로 잡힌다. `pgxs/src/Makefile.global`에는 빌드 트리 절대 경로와
`configure`가 찾아 둔 `/opt/homebrew/bin/openssl`·`/opt/homebrew/bin/zstd` 같은
**Homebrew 도구 경로**가 들어 있다 (1차 시도에서 실제로 잡혔다).
30832 KiB → 21920 KiB.

**경로 주의:** pgxs는 `lib/pgxs`가 아니라 `pkglibdir/pgxs`에 설치된다. prefix에
`postgres`/`pgsql`이 들어 있지 않으면 `pkglibdir = prefix/lib/postgresql`이다.
1차 시도가 `lib/pgxs`만 지우는 바람에 그대로 남았다.

## 빌드 구성에서 신경 쓴 것

| 선택 | 이유 |
| --- | --- |
| `--without-icu` | ICU는 Homebrew에서 온다. 켜면 번들이 `/opt/homebrew`에 묶인다. libc 제공자 + `--locale=C`로 충분하다. |
| `--without-readline` `--without-zlib` | 각각 psql 줄 편집과 pg_dump 압축만 쓴다. 외부 의존을 하나라도 줄인다. |
| `PG_SYSROOT=<없는 경로>` | 그냥 두면 `src/tools/darwin_sysroot`가 `xcrun --show-sdk-path`를 넣고, `-isysroot /Library/Developer/CommandLineTools/…`가 `pg_config`와 `Makefile.global`에 문자열로 박힌다 — G1 금지 문자열(스펙 §4.1 행 7)이다. 값이 디렉터리가 아니면 그 스크립트가 버리므로 `-isysroot` 자체가 사라진다. clang은 없어도 CLT SDK를 기본으로 찾는다. |
| pgvector `OPTFLAGS=""` | 기본값이 `-march=native`다. 빌드한 머신에서만 도는 바이너리를 배포하지 않으려고 끈다(pgvector README 권장). |

## 실험 인스턴스의 설정

`run.sh initdb`가 `postgresql.conf`에 한 번만 덧붙인다.

| 설정 | 값 | 이유 |
| --- | --- | --- |
| `port` | `55432` | 개발 5432와 분리 (스펙 §7.1 U-6) |
| `listen_addresses` | `127.0.0.1` | 밖에서 붙지 못하게 |
| `unix_socket_directories` | `''` (끔) | `$SANDBOX/run`의 절대 경로가 92자라 소켓 파일명을 붙이면 macOS의 `sun_path` 한계(104바이트)를 넘는다. 클라이언트는 전부 TCP로 붙으므로 필요 없고, `/tmp`에 소켓을 남기지도 않는다. |
| `logging_collector` | `on`, `log_directory='log'` | 계획 규칙 3b. 래퍼가 exit하면 서버 stderr가 unlink된 파일로 사라지므로 서버가 직접 쓰게 한다. |
| `--auth=trust` | | 실험 DB에는 비밀번호가 없다. **Phase 3의 앱은 이 설정을 그대로 쓰면 안 된다** — 여기서 검증하는 것은 인증이 아니라 번들 기동이다. |

## 뒤 Task가 알아야 하는 것

1. **`pg_ctl start`는 쓰지 않는다** (계획 규칙 2b). 이제 실측이 있다:
   `t2-pgctl-trial-dyld.txt`에 dyld 줄이 162건 남았는데 **전부 `pg_ctl` 자신의
   것**이고 시험 postmaster(pid 92536)의 줄은 0건이다. 서버 로그는 pg_ctl의
   **stdout**으로 나왔다. 규칙 1(exec 직전 재 export)을 지켜도 결과가 같다.
   Task 1 D3이 말한 "가짜 증거"의 실물이다.
2. **서버를 백그라운드로 띄울 때 stdout을 파일로 돌려라.** stderr는 절대 돌리면
   안 되지만(규칙 2), stdout을 그대로 두면 서버가 그 fd를 물고 있어서
   `run.sh start | tail` 이나 `$(...)` 같은 호출이 **영영 끝나지 않는다**.
   래퍼 안에서는 규칙 3이 지켜지는데 파이프를 태우는 순간 깨지는 형태다.
   Task 5의 embed·llm 런처도 같은 자리를 밟는다.
3. **fork된 백엔드의 dyld 줄은 postmaster의 pid로 찍힌다.** dyld가 프로세스
   시작 시점에 만든 `dyld[<pid>]:` 접두사를 자식이 그대로 물려받기 때문이다.
   덕분에 확장 dlopen 줄도 `pg.pid`와 대조할 수 있다 (규칙 4·6b).
4. **확장 로드의 dyld 줄은 `t2-start-dyld.txt`에 없다.** `logging_collector`가
   백엔드 stderr를 서버 로그로 보내기 때문이다(규칙 3b). `t2-extensions.sh`가
   그것을 `t2-extension-load-dyld.txt`로 옮긴다 — P0-C7 집계는 그 파일을 본다.
5. **Verify 표는 V2부터 순서대로 돈다.** `run.sh start`는 이미 떠 있으면 새로
   띄우지 않으므로(스펙 §4.4), 서버가 뜬 상태에서 V2를 돌리면 그 회차의 dyld
   증거가 비고 V2b가 실패한다. Task 2를 마칠 때 서버는 **정지 상태**로 둔다.
