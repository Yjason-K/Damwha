# Electron Phase 0 — 검증 실험 (일회성)

**이것은 제품 코드가 아니다.** Phase 0이 만드는 것은 앱이 아니라 **검증
보고서와 기술 결정**이고(스펙 §1), 여기 있는 코드는 그 검증을 실행하기 위한
일회성 하네스다. 통과하더라도 그대로 제품 코드가 되지 않는다.

Phase 0이 끝나면 이 디렉터리는 브랜치에 **보존만** 된다. 후속 Phase는 제품
코드를 새로 쓰며 이 디렉터리를 이식하지 않는다 (스펙 §6).

- 스펙: `docs/superpowers/specs/2026-09-09-electron-phase-0-packaging-validation-design.md`
- 계획: `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md`
- 증거: `docs/superpowers/reports/evidence/phase-0/`

`experiments/`는 pnpm 워크스페이스 멤버가 **아니다**. `pnpm-workspace.yaml`의
`packages`는 `be`, `fe`, `packages/*`뿐이라 파일을 고칠 필요가 없고, 대신
이 디렉터리에 `package.json`을 두지 않는다 (스펙 §6).

## 절대 하지 않는 것 (스펙 §4.4)

- `damwha_pgdata` / `be_pgdata` 볼륨에 쓰기, `docker compose down -v`,
  `docker volume rm`
- `be/storage` 하위 파일의 생성·수정·삭제 — **복사만 한다**
- `~/.cache/huggingface`(개발자 캐시)에 쓰기, `be/worker/.venv` 재생성
- `pkill` / `killall` 같은 **이름 기반** 프로세스 종료. 실험이 띄운 프로세스는
  `$SANDBOX/run/<name>.pid`의 PID로만 다룬다. 이름으로 죽이면 개발용 Docker
  Postgres나 사용자의 다른 작업을 같이 죽인다.
- 루트 `.gitignore` 수정. 이 디렉터리의 `.gitignore`가 국소적으로 담당한다.

## 고정값

| 이름 | 값 |
| --- | --- |
| `EXP` | `experiments/electron-phase-0` (이 디렉터리) |
| `SANDBOX` | `$EXP/sandbox` — 격리 실행의 HOME/TMPDIR/STORAGE_ROOT, PID, 오디오 |
| `EVIDENCE` | `docs/superpowers/reports/evidence/phase-0` |
| 실험 DB 포트 | `55432` (개발 5432와 분리) |
| `mlx_lm.server` 포트 | `58000` (개발 8000과 분리) |
| embed 포트 | `58100` (개발 8100과 분리) |

전부 `lib/config.sh` 한 곳에 있다. 다른 스크립트가 자기 자리에서 다시 적지
않는다 — 한 군데서 어긋나면 어느 인스턴스에 붙었는지가 증거에서 사라진다.

## 디렉터리

```
lib/      하네스. 모든 Task가 공유한다
verify/   계획의 Verify 표가 부르는 스크립트. 조건을 만족하면 exit 0
probe/    조사 결과 (U-1 오디오 출처, U-4/U-5 의존성)
```

`sandbox/ stage/ bundle/ pgdata/ run/ downloads/ signed/`는 커밋하지 않는다
(`.gitignore`). 전부 재생성 가능하고 수 GB다.

## lib/ 사용법

```sh
# 사전 점검 — 디스크 여유가 <GiB>보다 작으면 시작하지 않는다
bash experiments/electron-phase-0/lib/preflight.sh 5

# 샌드박스
bash experiments/electron-phase-0/lib/sandbox.sh init
bash experiments/electron-phase-0/lib/sandbox.sh status
bash experiments/electron-phase-0/lib/sandbox.sh --fresh          # $SANDBOX 하위만
bash experiments/electron-phase-0/lib/sandbox.sh copy-audio mtg_28

# G2 격리 실행 — 모든 실행 검증이 이 통로를 지난다
bash experiments/electron-phase-0/lib/run-isolated.sh --label t2-start -- <command...>

# G1 정적 검사
bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/pg

# 개발 자산 무변화
bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh before
bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after
```

## 정리된 상태에서 되살리기

**2026-09-10에 이 워크트리의 재생성 가능한 자산을 전부 지웠다.** 15 GB → 133 MB.
Phase 0을 중단하고 폴더를 참조용으로만 두기로 한 결정이다. 커밋된 스크립트·문서·증거는
그대로 있고, 아래 것들이 없다.

| 지운 것 | 용량 | 되살리는 명령 |
| --- | --- | --- |
| `sandbox/home/.cache` (HF 모델 5종) | 11 G | 파이프라인·서비스가 자동 다운로드. `services/llm.sh fetch-model`은 LLM만 따로 받는다 |
| `bundle/` | 1.6 G | `pg/build.sh` · `python/build.sh all` · `ffmpeg/fetch.sh` |
| `signed/` | 1.5 G | `signing/probe.sh sign` (`bundle/`이 먼저 있어야 한다) |
| `stage/` | 613 M | 위 build.sh들이 중간물로 다시 만든다 |
| `downloads/` | 36 M | 위 스크립트가 다시 받는다. 원본 해시는 `pg/checksums.txt`·`ffmpeg/checksums.txt`에 있다 |
| `sandbox/{storage,audio,pgdata,run,tmp}` | 442 M | `sandbox.sh init` + `copy-audio` + `pg/run.sh initdb` |
| 워크트리 `node_modules/` | 366 M | `pnpm install` (루트에서) |

남긴 것은 `sandbox/{t8,state,driver}`다. 그중 `sandbox/t8/`은
`docs/superpowers/reports/evidence/phase-0/t8-sandbox-work/`에 **사본을 커밋해 뒀다** —
`RESULTS.md` §6의 출처(`gk-syslog.txt`·`frag-gatekeeper.md`)와 entitlement plist 원본,
그리고 사라진 번들의 Mach-O 전수 목록이 거기 있고 지금은 재생산할 수 없다. 그 디렉터리의
`README.md`가 되돌려 놓는 방법을 적는다.

### 순서

디스크 여유는 **모델까지 포함해 25 GiB 이상** 잡는다 (계획 Task 9의 `preflight.sh 25`).

```sh
# 0) 워크스페이스 (루트에서 — be/ 안에서 npm install 금지)
pnpm install

# 1) 사전 점검과 샌드박스
bash experiments/electron-phase-0/lib/preflight.sh 25
bash experiments/electron-phase-0/lib/sandbox.sh init
bash experiments/electron-phase-0/lib/sandbox.sh copy-audio mtg_28

# 2) 세 번들 — 각각 독립이라 순서는 상관없다
bash experiments/electron-phase-0/pg/build.sh
bash experiments/electron-phase-0/python/build.sh all
bash experiments/electron-phase-0/ffmpeg/fetch.sh

# 3) G1 정적 검사 — 번들별로 부른다 (규칙 6e: bundle/ 전체를 한 번에 넘기면 위반 42건이 되살아난다)
for b in pg python ffmpeg; do
  bash experiments/electron-phase-0/lib/check-macho.sh "experiments/electron-phase-0/bundle/$b"
done

# 4) DB
bash experiments/electron-phase-0/pg/run.sh initdb
bash experiments/electron-phase-0/pg/run.sh start
DATABASE_URL=postgresql://postgres@127.0.0.1:55432/damwha pnpm be:migrate   # §4.0 — 클라이언트는 격리 대상 밖

# 5) 서비스
bash experiments/electron-phase-0/services/embed.sh start
bash experiments/electron-phase-0/services/llm.sh start

# 6) 서명 사본 (Task 8을 다시 볼 때만)
bash experiments/electron-phase-0/signing/probe.sh sign
```

`HF_TOKEN`이 환경에 있어야 게이트 저장소(`pyannote/speaker-diarization-community-1`)를
받는다. `$SANDBOX` 이하 경로에 **공백이 있으면 안 된다** (계획 규칙 6d).

**`probe.sh quarantine`을 돌리기 전에 읽어라.** 정리 트랩의 결함(T8-B1)은 커밋
`a1c0f0d`에서 고쳤지만 **그 경로는 아직 한 번도 실행되지 않았다.** 중단되면 대상에
`com.apple.quarantine`이 남아 사용자 화면에 Gatekeeper 대화상자가 반복해서 뜬다.
2026-09-10에 실제로 그렇게 됐다.

## 뒤 Task가 알아야 하는 설계 판단

**1. `run-isolated.sh`는 명령을 한 번만 실행한다.**
계획 Task 1의 인터페이스 설명은 "`DYLD_PRINT_LIBRARIES=1`로 한 번 더 실행"이라고
적었지만 그렇게 하지 않는다. 이 래퍼는 Task 7의 전체 음성 파이프라인과 Task 9의
모델 다운로드도 통과하는데, 그 둘을 두 번 돌리면 GPU 시간과 다운로드 용량이
그대로 두 배가 되어 스펙 §4.4의 디스크 규칙(R-14)과 부딪친다. 서비스 기동
(Task 2·5)은 두 번째 실행이 PID 가드에 막혀 빈 dyld 증거를 남기게 된다.
스펙 §4.2 본문은 "`DYLD_PRINT_LIBRARIES=1`을 켜고 실행해"라고만 요구하므로,
한 번의 실행에 계측을 켜는 쪽이 스펙에 더 가깝고 부작용이 없다.

**2. 명령의 stderr는 실행이 끝난 뒤에 나온다.** dyld 줄과 프로그램 로그를
갈라 증거로 나누기 때문이다. 실행 중에 보고 싶으면 래퍼가 시작할 때 출력하는
`tail -f <경로>`를 쓴다.

**2a. 런처를 쓰면 dyld 실측이 끊긴다 — Task 2·5·11의 런처 규칙.**
SIP는 플랫폼 바이너리(`/bin/bash`, `/bin/sh`, `/usr/bin/python3` 등)를
**exec할 때마다** 환경에서 `DYLD_*`를 지운다. 환경 격리(`PATH`·`HOME`·
화이트리스트)는 런처를 거쳐도 멀쩡한데 **dyld 실측만** 조용히 사라진다.
직접 재서 확인했다.

| 실행 형태 | dyld 줄 |
| --- | --- |
| `env -i DYLD_PRINT_LIBRARIES=1 <번들 Mach-O>` | 81 |
| `env -i DYLD_PRINT_LIBRARIES=1 <bash 런처>` → 같은 Mach-O | **0** |
| bash 런처가 `exec` 직전 `export DYLD_PRINT_LIBRARIES=1` | 81 |
| 런처가 자식 stderr를 `2>/dev/null` | **0** |
| 비플랫폼 런처(ad-hoc 서명 bash)가 자식 stderr를 리다이렉트 | 82 — **전부 런처 자신의 것**, 자식 것은 0건 |

마지막 줄이 가장 위험하다. 줄 수가 0이 아니라 래퍼도 사람도 통과로 보는데
정작 검증 대상의 라이브러리는 하나도 없다 — **위반 0건짜리 가짜 증거**다.
`pg_ctl start -l <logfile>`이 정확히 이 형태를 만든다: `pg_ctl` 자신(번들
Mach-O)의 로드 목록은 남고 `postgres`의 것은 로그 파일로 샌다.

`exec` 심으로는 못 고친다 — 심이 다시 bash를 exec하는 순간 또 지워진다.
그래서 런처 쪽이 규칙을 지킨다. 아래 "규칙 N"은 계획 "런처 스크립트의 dyld
실측 규칙"의 번호이며, 이 README 자신의 항목 번호(2b·2c)와는 별개다.

- **규칙 1 — exec 직전에 다시 export한다.** 번들 Mach-O를 `exec`하기 직전에
  런처가 `export DYLD_PRINT_LIBRARIES=1`을 다시 설정한다. 대상은 `pg/run.sh`,
  `services/embed.sh`, `services/llm.sh`, `lib/selfreport-all.sh`다.
- **규칙 2 — 그 프로세스의 stderr를 리다이렉트하지 않는다.**
  `pg_ctl start -l <logfile>` 금지.
- **규칙 2b — `pg_ctl start`는 `-l`을 빼도 쓰지 않는다.** `pg_ctl`이 내부에서
  `/bin/sh -c "exec postgres ... 2>&1 &"`로 띄우므로 SIP가 그 `/bin/sh`에서
  `DYLD_*`를 지우고 stderr가 stdout으로 합쳐진다. 규칙 1·2를 지켜도 결과가
  같다. Task 2는 `postgres -D <데이터 디렉터리> -p 55432 &`를 직접 띄운다.
- **규칙 3 — `start`는 백그라운드 기동 후 준비를 기다리고 exit 0 한다.**
  준비 확인은 `pg_isready`·`/health`·`/v1/models`를 런처 안에서 한다. 이 래퍼는
  자식 종료까지 블로킹하고 증거도 그 뒤에 쓰므로(README 2b), 서버를 포그라운드로
  두면 Verify 행이 영영 돌아오지 않는다. 준비가 끝난 시점이면 서버의 초기 로드
  dyld 줄은 이미 전부 캡처에 담겨 있다.
- **규칙 3b — 서버의 이후 로그는 서버 자신이 파일에 쓰게 한다.** 래퍼가 exit하면
  `trap ... EXIT`이 `$RUNTMP`를 지우는데 서버의 stderr는 여전히 그 안을 가리키므로
  이후 로그가 unlink된 파일로 사라진다. 기동 시점의 dyld 줄은 이미 캡처됐으니
  측정에는 지장이 없지만, crash recovery처럼 서버가 죽은 뒤 원인을 봐야 하는
  검증에서 진단이 불가능해진다.
- **규칙 4 — PID 파일에는 서버 자신의 PID를 쓴다.** 런처 bash의 PID가 아니다.
  그래야 `run.sh kill`의 SIGKILL이 실제 서버에 가고, 아래 판독이 성립한다.

**증거를 읽을 때 (계획 규칙 6).** 함정이 둘이다.

- **파일 전체를 `grep`하지 마라.** 증거 헤더에 `# argv: <명령> <인자...>`가
  들어 있어서, 검증 대상 경로로 파일 전체를 grep하면 **dyld 줄에 그 경로가
  0건이어도 헤더에 항상 매치된다.** 3회차 리뷰가 잡은 것이 정확히 이것이다 —
  D2의 단정이 이 함정에 빠져 가짜 증거를 통과시켰다. `^dyld`로 시작하는 줄로
  한정한다.
- **줄 수만 세지 마라.** 가짜 증거도 줄 수는 0이 아니다. `dyld[<pid>]`의 pid가
  `$SANDBOX/run/<name>.pid`의 서버 PID와 같은지, 그리고 **그 pid의 로드 목록에
  검증 대상 번들 바이너리 경로가 실제로 있는지**까지 본다. 어긋나면 그 회차는
  측정에 실패한 것이다.

`verify/t1-detector-negative.sh`의 D절이 이 판독을 코드로 고정하고, 뒤 Task의
`t2-dyld-measured.sh` / `t5-dyld-measured.sh`가 본뜰 함수 셋
(`dyld_lines` / `dyld_pid_for` / `dyld_pids`)을 담고 있다. 세 대조군이다.

| | 런처 | 기대 |
| --- | --- | --- |
| D1 | re-export 없음 | dyld 0건 + `MEASUREMENT_UNAVAILABLE` 표시 |
| D2 | re-export 있음 | dyld 1건 이상 **그리고** 자식 Mach-O를 로드한 pid가 있음 |
| D3 | 비플랫폼 셔뱅 + 자식 stderr 리다이렉트 | dyld 1건 이상이지만 자식 Mach-O를 로드한 pid는 **없음** |

D3이 규칙 6의 회귀 방지다. 판독을 파일 전체 grep으로 되돌리면 D3이 exit 1로
잡는다. 뒤 Task에서 누가 re-export를 빠뜨리거나 자식 stderr를 돌리면 Task 1
검증이 깨져서 바로 드러난다.

**2b. 증거는 자식이 끝난 뒤에만 쓰인다.** 래퍼 bash가 먼저 죽으면 그 회차의
증거는 남지 않고 자식은 고아가 된다. 래퍼의 `trap ... EXIT`이 `$RUNTMP`를
지우므로 원시 stderr까지 함께 사라진다. 긴 작업을 중단할 때는 자식을 먼저
`$SANDBOX/run/`의 PID로 내린다.

**2c. `DYLD_PRINT_LIBRARIES`는 자손에게 그냥 상속되지 않는다.** 위 2a의
이유로 **플랫폼 바이너리를 하나라도 거치면 끊긴다.** 워커가 `/bin/sh`를
거쳐 ffmpeg를 띄우면 그 ffmpeg의 로드 목록은 증거에 없다. 반대로 번들
Python이 ffmpeg를 직접 `exec`하면 나온다 — 어느 쪽인지는 **경로가 실제로
찍혔는지로** 확인하지, 나왔을 것이라고 가정하지 않는다. 그렇게 이어진
경우 한 파일에 여러 프로세스의 목록이 섞이므로 `dyld[<pid>]`로 갈라 본다.

**3. `DYLD_PRINT_LIBRARIES`는 주입 화이트리스트가 아니라 계측 도구다.**
스펙 §4.2 표의 이름 **12개**만 주입 대상이다 — 값을 기록하는 11개 + 비밀값
`HF_TOKEN`. (표의 *행*은 10개지만 `MODEL_CACHE_DIR`·`HF_HOME`이 한 행에,
`EMBED_SERVICE_HOST`·`PORT`가 또 한 행에 묶여 있어 행 수와 이름 수가 다르다.)
증거 파일도 그 둘을 갈라 적는다. SIP는 플랫폼 바이너리에서 `DYLD_*`를
지우므로, 그런 실행은 dyld 줄이 0건이 되고 증거 첫 줄이
`MEASUREMENT_UNAVAILABLE`이 된다. 통과로 기록하지 않는다.

**4. `HF_TOKEN` 값은 어디에도 남지 않는다.** `be/worker/.env`에서 읽어 주입만
하고, 증거에는 `set`/`unset`만 적는다. 증거로 나가는 모든 텍스트는
`exp_scrub`(config.sh)을 지나며 토큰 값이 `<HF_TOKEN>`으로 치환된다 —
번들 프로그램이 실수로 로그에 찍어도 커밋에 남지 않게 하는 안전망이다.
남는 노출면은 `env -i ... HF_TOKEN=...`이 잠깐 갖는 argv 하나이고, 이는 같은
사용자에게만 보이며 증거·stdout·커밋 어디에도 기록되지 않는다.

**5. `check-macho.sh`의 문자열 면제는 검사 대상 자신($ROOT) 하위 하나뿐이다.**
이 저장소가 개발자 홈 아래에 있으므로 번들의 자기 참조 경로는 금지 문자열
`/Users/<개발자>`로 시작한다. 그것만 `INFO`로 뺀다. 같은 실험 디렉터리라도
**검사 대상 밖**을 가리키면 — `stage/`, `downloads/`, `sandbox/` — `STALE-PATH`
**위반**이다. 스테이징 자리나 원본 아카이브 자리가 그대로 박힌 것이고, 번들을
옮기는 순간 깨진다. 스펙 P0-C3이 "이동 전에는 되는데 이동 후에 깨지는 것"을
핵심 관찰 대상으로 두고 R-9가 정확히 이 형태(콘솔 스크립트 shebang의 절대
경로)이므로, 여기를 면제하면 재배치 검증이 통째로 무력화된다.
`verify/t1-detector-negative.sh`가 shebang·`pyvenv.cfg`·`*.pc` 세 형태로 이
회귀를 막는다.

형제 번들(`$EXP/bundle/*`)을 가리키는 절대 경로도 **위반**이다.
**Task 3이 그대로 두기로 정했다** — `bundle/python`은 `bundle/pg`를 참조하지
않는다 (psycopg는 `psycopg_binary`에 자기 libpq를 들고 온다). 번들 간 참조를
만들 이유가 없으므로 검사기를 넓히지 않았다.

**Task 3이 넓힌 것은 문자열 면제 하나뿐이다** — `lib/g1-allowlist.txt`.
(상대 경로, 금지 문자열, 근거) 쌍으로만 걸리고, 적중은 숨기지 않고 `ALLOW`로
근거와 함께 매 회차 출력된다. 왜 필요했는지는 `python/README.md`의
"G1 문자열 검사와 스펙 §4.1의 긴장" 절에 있다. 요약: CPython 표준
라이브러리와 제3자 wheel **원본**에 독스트링·다른 플랫폼 분기·배포자 빌드
경로·ctypes 폴백 목록으로 금지 문자열이 구조적으로 들어 있어 문자 그대로의
0건이 Python 런타임에서는 달성 불가능하다. **재배치를 깨는 것(STALE-PATH·
OTOOL-L·LC_RPATH)은 하나도 목록에 넣지 않았고 전부 고쳤다.**

**5a. Task 11의 증거 집계기(`aggregate-isolation.sh`)에게.**

- `$EVIDENCE/*-env.txt`와 `*-dyld.txt`에는 샌드박스 절대 경로가 **정상적으로**
  들어 있다(격리 실행의 `HOME`·`TMPDIR`이 거기다). 그것을 금지 문자열로 세면
  P0-C7이 항상 실패한다. 다만 면제는 `$SANDBOX` 하위와 실제로 검사한
  `bundle/` 하위로 좁혀라 — `$EXP` 전체를 뭉뚱그려 빼면 위 `STALE-PATH`와 같은
  구멍이 증거 집계 쪽에 그대로 생긴다.
- **금지 문자열도 dyld 경로도 `^dyld`로 시작하는 줄에서만 읽어라(규칙 6).**
  증거 헤더의 `# argv:` 줄에는 실행한 명령의 경로가 그대로 들어 있어, 파일
  전체를 대상으로 하면 dyld 줄에 없는 경로도 매치된다. 3회차 리뷰가 Task 1의
  D2에서 잡은 함정이 이것이다.
- **dyld 0건을 "위반 없음"으로 세지 마라.** 번들 Mach-O를 실행한 항목인데
  dyld 줄이 0건이면 그건 런처가 re-export를 빠뜨린 **미측정**이다(2a).
  `MEASUREMENT_UNAVAILABLE`로 별도 집계하고, P0-C8의 런타임 자기 보고로
  대체 확인하거나 미충족으로 남긴다.
- 반대로 **줄 수가 0이 아니라고 측정됐다고 보지도 마라.** 그 pid의 로드 목록에
  검증 대상 바이너리가 실제로 있는지 본다. 런처 자신의 로드 목록만 남은
  가짜 증거가 그렇지 않다.
- 단 `t1-dyld-launcher-noexport-*`와 `t1-dyld-launcher-fake-*`는 **의도된
  음성 대조군**이다. 규칙을 어긴 런처가 정말로 0건이 되는지, 가짜 증거가
  정말로 걸러지는지 보려고 일부러 만든 것이므로 미측정·미검증 집계에서 빼고
  그 사실을 결과 문서에 적는다.
- `bundle/` 전체를 한 번에 `$ROOT`로 잡으면 형제 번들 참조가 `INFO`로
  흡수된다. 형제 참조를 허용할지는 Task 3이 번들별 검사(`bundle/pg`,
  `bundle/python`)에서 판정한 결과를 기준으로 한다.

**5b. `check-macho.sh`는 `bundle/`(또는 `stage/`)을 가리켜 돌린다.**
`$EXP` 전체를 가리키면 `sandbox/` 안의 부산물까지 훑는다 — 격리 실행이 남긴
OS python 바이트코드 캐시 같은 것들이라 금지 문자열이 당연히 들어 있고,
검사 대상(번들 후보)이 아니다. `$ROOT`를 `$EXP` 자신으로 잡으면 위 면제가
`stage/`·`downloads/`까지 덮어 버리기도 한다.

**6. `check-macho.sh`가 자기 자신을 제외하는 파일은 하나뿐이다** —
`lib/forbidden-strings.txt`. 패턴 원본이라 자기에게 걸린다. 제외는 그 파일의
절대 경로 하나로만 이뤄지므로 `bundle/` 같은 실제 검사 대상에서는 발동하지
않는다. `lib/` 전체가 오탐 없는 양성 대조군이어야 하므로(계획 Task 1 V6),
`lib/`의 다른 파일에는 금지 문자열을 적지 않는다.

**7. `be/storage`는 worktree에 없다.** 루트 `.gitignore`가 `/be/storage/`를
무시해서 `git worktree add`가 만들어 주지 않는다. `exp_source_storage_root`가
`git worktree list`로 주 worktree를 찾아 **읽기만** 한다. 다른 위치를 쓰려면
`DAMWHA_SOURCE_STORAGE`로 지정한다.

**8. Task 2가 실측으로 덧붙이는 것 (서버 런처를 만드는 Task 5에게).**
자세한 내용과 증거 파일 목록은 `pg/README.md`에 있다. 런처를 쓰는 쪽만 요약한다.

- **`pg_ctl start`는 규칙 2b대로 정말 못 쓴다.** 이제 실측이 있다 —
  `t2-pgctl-trial-dyld.txt`의 dyld 줄 162건이 **전부 `pg_ctl` 자신의 것**이고
  시험 postmaster의 pid로는 0건이다. 서버 로그는 pg_ctl의 stdout으로 나왔다.
  규칙 1을 지켜도 결과가 같다.
- **서버를 `&`로 띄울 때 stdout은 파일로 돌린다.** stderr는 절대 돌리면 안
  되지만(규칙 2), stdout을 그대로 두면 서버가 그 fd를 물고 있어서
  `... | tail`이나 `$(...)`로 런처를 부른 호출이 영영 끝나지 않는다. 래퍼
  안에서는 규칙 3이 지켜지는데 파이프를 태우는 순간 깨진다.
- **fork된 자식의 dyld 줄은 부모의 pid로 찍힌다.** dyld가 프로세스 시작
  시점에 만든 `dyld[<pid>]:` 접두사를 그대로 물려받기 때문이다. PostgreSQL
  백엔드가 확장을 dlopen한 줄이 postmaster의 pid로 남는 것이 그 예다.
- **`install_name_tool`로 고친 Mach-O는 `codesign -f -s -`로 다시 서명해야
  실행된다.** arm64에서는 서명 없는 Mach-O가 뜨지 않는다. ad-hoc 서명은
  플랫폼 바이너리로 만들지 않으므로 `DYLD_*` 실측은 그대로 살아 있다.
- **재배치 검증은 옮긴 뒤에 해야 의미가 있다.** 스테이징 경로 안을 가리키는
  문자열은 `check-macho.sh`가 `INFO`로 분류하다가 옮기는 순간 `STALE-PATH`
  위반이 된다. 같은 파일의 같은 문자열이다 (`t2-relocation-attempt1.txt`).

**9. Task 3이 실측으로 덧붙이는 것 (Python 런타임을 쓰는 Task 4·5·7·9에게).**
자세한 내용과 증거 파일 목록은 `python/README.md`에 있다. 쓰는 쪽만 요약한다.

- **`bundle/python`을 옮기면 `python/build.sh relocate`를 다시 돌려야 한다.**
  이 런타임은 "복사만 하면 도는" 형태가 **아니다.** 그냥 `mv` 하면 `bin/`의
  셔뱅 스크립트 65개가 전부 `bad interpreter`로 죽는다 (R-9, 실측:
  `t3-relocation-symptom.txt`). `mlx_lm.server`·`uvicorn`·`damwha-worker`·
  `damwha-embed`가 전부 거기 있다.
- **`bin/mlx_lm.server`의 셔뱅은 번들 python이다 — `/bin/sh` 심이 아니다.**
  일부러 그렇게 뒀다. `/bin/sh` 심으로 만들면 재배치에는 강하지만 SIP가
  `DYLD_*`를 지워 dyld 실측이 끊긴다(규칙 2a). 런처는 이 파일을 **직접
  exec**하면 되고, dyld의 메인 이미지는 `bundle/python/bin/python3.12`가
  된다 — 판정은 규칙 6c대로 `bundle/python/` **접두사**로 한다.
  `verify/t3-lib.sh::t3_assert_dyld_measured`가 본뜰 형태다.
- **`uv pip install`은 반드시 `--link-mode=copy`.** 기본 하드링크면 설치
  파일이 개발자 uv 캐시의 inode를 공유하고, 그 캐시는 **개발
  venv(`be/worker/.venv`)에도 하드링크돼 있다.** `install_name_tool`로 번들
  Mach-O를 고치는 순간 개발 venv의 같은 파일이 함께 바뀐다 (스펙 §4.4 금지).
- **wheel은 배포자의 빌드 머신 `LC_RPATH`를 그대로 들고 온다.** scikit-learn
  51건, scipy 3건(`/opt/homebrew/Cellar/gcc@13/…`), torchaudio 2건, Pillow 1건,
  PyAV 1건. dyld의 실제 검색 경로이므로 `relocate`가 지운다. 새 패키지를
  넣으면 같은 검사를 다시 해야 한다.
- **`otool -L`의 실제 의존 경로는 처음부터 전부 허용 접두사였다.** R-3이
  걱정한 torch·mlx의 dylib 절대 경로는 나타나지 않았다. 위반으로 잡힌 64건은
  전부 **의존이 아니라 `LC_ID_DYLIB`** (delocate의 `/DLC/…` 자리표시자 등)다.
- **G1 전수 검사가 오래 걸린다.** 파일 3만 3천 개·Mach-O 460개라 한 번에
  10분 안팎이다.
- **번들 python을 실행하면 `__pycache__`가 생긴다.** `.pyc`에는 컴파일 시점
  절대 경로가 들어가므로 재배치 후에는 지워야 한다. `relocate`가 한다.
- **모델은 하나도 들어 있지 않다.** 이 번들은 코드뿐이고, HF 캐시는 격리
  실행의 `HF_HOME`(샌드박스)으로 간다.

**10. Task 4가 실측으로 덧붙이는 것 (ffmpeg를 쓰는 Task 5·7에게).**
자세한 내용과 증거 파일 목록은 `ffmpeg/README.md`에 있다. 쓰는 쪽만 요약한다.

- **ffmpeg/ffprobe는 PostgreSQL·Python과 달리 재배치에서 아무것도 깨지지
  않았다.** `--enable-static --disable-shared`로 완전 정적 링크했더니
  `otool -L`의 의존이 `/usr/lib/*`·`/System/Library/Frameworks/*`뿐이고
  `LC_RPATH` 커맨드 자체가 없다. `install_name_tool`·`codesign` 사후 처리가
  필요 없다 — 이동 전/후 `check-macho.sh` 출력이 완전히 같다.
- **셸 런처가 필요 없다.** 완전 정적 Mach-O라 `env -i`가 직접 `exec`한다
  (번들 python과 같은 형태). `verify/t4-lib.sh::t4_run_ffmpeg` /
  `t4_run_ffprobe`가 그 통로이고, 계획 규칙 1(exec 직전 재-export)이 필요
  없다.
- **Homebrew ffmpeg도 우연히 같은 버전(9.0.1)이다.** 버전 문자열로는 번들
  실행과 Homebrew 실행이 구분되지 않는다 — dyld가 연 이미지의 경로만
  신뢰할 수 있다(`t4-no-homebrew.sh`).
- **라이선스는 LGPL v2.1+로 구성했다** (`--disable-gpl --disable-nonfree
  --disable-version3`, R-8). 담화가 쓰는 probe·normalize 둘 다 native
  코덱만으로 되므로 GPL 구성을 켤 이유가 없었다.
- **번들은 `bin/ffmpeg`·`bin/ffprobe` 둘뿐이다.** `include/`·`lib/*.a`·
  `lib/pkgconfig/*.pc`·`share/ffmpeg/`는 빌드 전용 산출물이라 뺐다 (pg의
  `pgxs`·`include` 제외와 같은 이유). 번들 크기는 42 MB.

**11. Task 5가 실측으로 덧붙이는 것 (서비스를 쓰는 Task 6·7·9·11에게).**
`services/embed.sh`·`services/llm.sh`가 두 서비스의 수명을 다룬다.

```sh
bash lib/run-isolated.sh --label t5-embed -- services/embed.sh start   # 58100
bash lib/run-isolated.sh --label t5-llm   -- services/llm.sh   start   # 58000
bash services/embed.sh stop      # PID 파일 대상 SIGTERM. 격리가 필요 없다
bash services/llm.sh   status
```

- **규칙 3b의 `2> >(tee "$LOG" >&2)` 형태가 실제로 동작한다.** embed·
  `mlx_lm.server`에는 로그를 파일에 직접 쓰는 옵션이 없어서 이 형태 말고는
  규칙 2(“서버 stderr를 리다이렉트하지 않는다”)와 규칙 3b(“래퍼가 exit해도
  로그가 남는다”)를 동시에 지킬 방법이 없다. 실측: `t5-embed-dyld.txt` 1619줄,
  `t5-llm-dyld.txt` 1803줄이고 **전부 서버 프로세스의 것**이다. 같은 줄이
  `$SANDBOX/run/{embed,llm}-stderr.txt`에도 그대로 남아 래퍼가 끝난 뒤에도
  읽을 수 있다. `tee`는 `/usr/bin/tee`(플랫폼 바이너리)라 SIP가 `DYLD_*`를
  지워 **자기 dyld 줄을 만들지 않는다** — 증거가 서버 것만으로 유지되는
  이유가 이것이다.
- **dyld 증거의 줄은 두 모양이다. 판정은 이미지 로드 줄로 한정해야 한다.**

  ```
  dyld[<pid>]: <UUID> /절대/경로              ← 실제 로드 (필드 3개)
  dyld[<pid>]: move loaded to delayed: <이름>  ← 지연 초기화 기록 (필드 6개)
  ```

  둘째 모양에는 **경로가 없고 잎 이름만** 있다(`AVFoundation`,
  `libtidy.A.dylib`). `$NF`로 “번들 밖 경로”를 세면 이것이 전부 위반으로
  잡힌다 — 처음 만든 `t5-dyld-measured.sh`가 정확히 그래서 존재하지 않는
  위반 160여 건을 냈다(`t5-dyld-measured.prev-*.txt`에 그 회차가 남아 있다).
  Task 2의 postgres는 이 줄을 하나도 내지 않아(`t2-start-dyld.txt` 0건)
  거기서는 드러나지 않았고, Task 3·4는 “번들 아래에서 연 이미지 수”만 세어
  (접두사가 `/`로 시작해야 매치된다) 영향이 없었다. Python 프로세스에
  `foreign` 검사를 처음 붙인 Task 5에서 드러난 것이다.
  `verify/t5-lib.sh::t5_awk_load_line`이 그 필터다.
- **판정 대상 pid는 PID 파일 → 기동 기록 순으로 찾는다.** 계획 Verify 표의
  순서상 V11(dyld 판정)이 V5·V9(stop) 뒤에 오는데, stop이 PID 파일을 지우면
  판정 자체가 불가능해진다. 그래서 런처가 PID 파일을 쓰는 **같은 순간 같은
  `$!`로** `$SANDBOX/run/{embed,llm}-start.txt`에 pid·실행 파일·cmdline·로그
  위치를 함께 남긴다(규칙 3b의 “로그 위치 기록”도 이 파일이다).
- **`bundle/python/bin/mlx_lm.server`가 실제로 뜬다.** 스펙 §2가 지목한
  “어떤 매니페스트에도 없는 네 번째 런타임”이 번들 안에서 기동하고 완성
  응답을 냈다. 실행 경로는 `t5-llm-binpath.txt`에 있고, `~/.local/bin`의 uv
  tool 설치본이 아니다. 셔뱅이 번들 python이라 dyld의 메인 이미지는
  `bundle/python/bin/python3.12`이고, 판정은 규칙 6c대로 `bundle/python/`
  **접두사**로 한다.
- **`llm.sh start`는 기동 전에 모델을 받는다.** `/v1/models`는 HF 캐시를
  훑어 목록을 만들므로(`scan_cache_dir()`), 캐시가 비면 서버가 멀쩡히 떠도
  그 모델이 목록에 없다. 로드는 첫 `chat/completions`까지 미뤄진다. 그래서
  `services/fetch_model.py`가 `mlx_lm.utils._download`(서버가 쓰는 그 경로)로
  먼저 받는다. 진행 표시줄은 환경 변수가 아니라 in-process API
  (`disable_progress_bars()`)로 끈다 — 스펙 §4.2 주입 화이트리스트를 넓히지
  않으려고.
- **`damwha-embed`·`damwha-worker`는 인자를 무시하고 바로 서비스를 띄운다.**
  `--help`로 시험하지 마라. 포트는 명령줄이 아니라 주입된
  `EMBED_SERVICE_HOST/PORT`로만 정해지고, `embed.sh`가 그 값이 58100인지
  기동 전에 확인한다.
- **두 런처는 서버를 `$SANDBOX`에서 띄운다.** `damwha_worker.config.Settings`가
  `env_file=".env"`라 **현재 작업 디렉터리**의 `.env`를 읽는다. 저장소 어느
  디렉터리에서 부르든 개발용 `.env`가 섞이지 않게 옮겨서 띄운다.
- **stop은 SIGTERM만 쓰고 SIGKILL로 올리지 않는다.** 올리면 스펙 P0-C5b의
  “SIGTERM에 종료된다”가 증거에서 사라진다. 둘 다 1초 안에 내려갔다.
  `kill` 서브커맨드(SIGKILL)는 롤백 전용이며 판정에 쓰지 않는다.
- **모델은 샌드박스 HF 캐시에만 받았다** (`t5-model-cache.txt`). Task 5 시작
  시점에 그 캐시는 0 B였다.

  | 저장소 | 크기 | 비고 |
  | --- | --- | --- |
  | `mlx-community/Qwen3.5-4B-8bit` | 4.8 GB (5163524489 B, 10파일, 57.6초) | `t5-llm-model-fetch.txt` |
  | `BAAI/bge-m3` | 4.3 GB | **같은 가중치를 두 벌 받는다** |

  bge-m3는 sentence-transformers가 `model.safetensors`(2.27 GB)와
  `pytorch_model.bin`(2.27 GB)을 **둘 다** 받는다. 리비전도 둘로 갈린다.
  2.1 GB가 그냥 낭비되는 자리이므로 Task 9(P0-C13)가 확인할 항목이다.
- **디스크가 빡빡해졌다 (R-14).** Task 5 시작 21 GiB → 종료 **11 GiB**.
  Task 7이 pyannote 게이트 3종과 whisper 모델을 더 받아야 하므로, 착수 전에
  `preflight.sh`로 재고 부족하면 시작하지 말아라.
- **기동 시간(참고).** embed는 bge-m3 다운로드·로드를 포함해 52초, llm은
  모델 다운로드 58초 + 서버 기동 11초 = 69초였다. 첫 완성 요청(모델을
  메모리에 올린다)은 4초.

**12. Task 6이 실측으로 덧붙이는 것 (같은 DB를 쓰는 Task 7·11에게).**

- **실험 DB에 Task 6의 회의가 남아 있다.** `$EVIDENCE/t6-meeting-id.txt`에 그
  id가 **한 줄로만** 들어 있다(주석 없음). 지금 값은 `mtg_1`이고 발화 12건 ·
  임베딩 12건이다. **Task 7의 결과 검증은 자기 meeting id로 스코프해야 한다** —
  `SELECT count(*) FROM utterance` 같은 전역 집계는 이 12건을 함께 센다.
- **회의 id는 재실행해도 그대로지만 utterance id는 바뀐다.**
  `drivers/seed_search.py`는 title로 회의를 찾아 재사용하고 발화만 지웠다 다시
  넣는다(임베딩은 `ON DELETE CASCADE`). 그래서 회차마다 `utt_*`가 새로 발급된다.
  발화 id를 다른 파일에 적어 두고 재사용하지 말아라.
- **`speaker` 행은 만들지 않았다.** `utterance.speaker_id`는 NULL이고 화자 정보는
  `diar_label`(`SPEAKER_00`/`SPEAKER_01`)에만 있다. Task 7의 화자 식별이 보는
  테이블을 이 실험이 미리 채우지 않으려는 것이다. 검색 쿼리는 `LEFT JOIN speaker`
  라 없어도 두 경로가 다 돈다.
- **시드 스크립트가 DB·embed 런처를 스스로 부른다.** 계획 Task 6의 Verify 표에는
  Task 2 V2 · Task 5 V2 같은 기동 행이 없어서 V1이 단독으로 돌 수 있어야 했다.
  둘 다 PID 파일로 멱등하므로 이미 떠 있으면 아무것도 하지 않는다. **떠 있지
  않은 상태에서 V1을 돌리면 `t6-seed-dyld.txt`에 서버 pid가 섞인다** — 집계할 때
  pid별로 갈라 보아라 (Task 11이 Task 5에서 같은 처리를 한다).
- **`psql -c`는 psql 변수를 보간하지 않는다** (단일 질의 모드). `:'q'`·`:'qvec'`를
  쓰는 SQL은 전부 `-f -`(stdin)로 넣어야 한다. `-c`로 넣으면 `syntax error at
  or near ":"`로 죽는다.
- **`IFS=$'\t' read`로 TSV를 읽지 말아라.** 탭은 IFS **공백 문자**라 연속된 탭이
  하나로 뭉개져 빈 필드가 있는 줄에서 열이 통째로 밀린다. 실제로 그 때문에
  `t6-hybrid.sh`가 utterance id 자리에서 meeting id를 읽었다. `awk -F'\t'`를 쓴다.
- **`-A`(정렬 없음) 출력에는 패딩이 없으므로 `tr -d ' '`를 붙이지 않는다.**
  `t2_scalar`가 그렇게 하는데, 값 안의 공백까지 지워져
  `likequery('50% 절감')`이 `%50\%절감%`으로 보인다(실제 값은 `%50\% 절감%`).
- **번들 pgvector는 0.8.6이다.** `<=>`의 구현 함수 이름은 `cosine_distance`이지
  `vector_cosine_distance`가 아니다. 동명 오버로드(vector/halfvec/sparsevec)가
  셋이라 `oprcode::text`는 `public.cosine_distance`로 스키마까지 붙어 나온다.
  `search.service.ts:118-122`가 쓰는 `hnsw.iterative_scan`·`hnsw.ef_search` GUC도
  둘 다 있다 — 없으면 `set_config`가 오류를 낸다.
- **bge-m3의 출력 벡터는 L2 정규화돼 있다** (전 행의 노름이 1.000000).
  `<=>`(코사인 거리)와 `<#>`(음의 내적)의 순위가 같아진다는 뜻이므로, 거리
  값으로 무언가를 판정한다면 이 사실을 전제로 깔아도 된다.

**13. Task 7이 실측으로 덧붙이는 것 (Task 9·11에게).**

- **`bash`는 3.2다. 명령 치환 안에서 `case`를 쓸 수 없다.** macOS의 `/bin/bash`
  는 3.2.57이고 그 파서는 `REPORT=$( ... case ... esac ... )` 형태를 통째로
  거부한다 — `syntax error near unexpected token ';;'`. 이 하네스의 verify
  스크립트는 판정 근거를 전부 `$( )` 안에서 만드는 형태라 정면으로 걸린다.
  같은 이유로 **heredoc(`<<EOT`)도 명령 치환 안에서 쓰지 않는다.** 술어가
  필요하면 `t7-lib.sh`의 `t7_is_uint` / `t7_under`처럼 **함수로 빼서** 부른다
  (함수 본문은 치환 밖이라 `case`가 된다). 목록 순회는 `for x in $LIST`로 한다
  — `$EXP` 이하 경로에는 공백이 없다(계획 규칙 6d).
- **파이프라인이 부른 ffmpeg/ffprobe는 dyld 증거에 나오지 않는다.**
  `be/worker/damwha_worker/pipeline/ffmpeg.py::_run`이 `capture_output=True`로
  자식의 stderr를 파이프로 가져가므로 `DYLD_PRINT_LIBRARIES=1`이 찍은 줄이
  래퍼의 fd 2에 도달하지 못한다. SIP 때문이 아니다 — 그 자식들은 `/bin/sh`를
  거치지도 않는다. 번들 ffmpeg의 dyld 실측이 필요하면 **stderr를 물려준 채로
  따로 한 번 더 부른다**(드라이버가 정규화 산출물 재확인으로 그렇게 한다).
  파이프라인이 어느 바이너리를 썼는지는 같은 프로세스·같은 PATH에서 잰
  `shutil.which()` 값이 답한다.
- **제품 코드는 ffmpeg를 이름으로 부른다.** 격리 `PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin`)에는 없으므로, 드라이버가 자기 프로세스의
  `PATH` 앞에 `bundle/ffmpeg/bin`을 붙인다. 붙이는 값은 번들 내부 절대 경로라
  스펙 §4.2의 `LENS_LLM_SERVER_BIN`과 같은 성격이고, Phase 4의 Electron 메인
  프로세스도 같은 일을 해야 한다.
- **`pyannote/speaker-diarization-3.1`을 쓰지 말아라.**
  `be/src/config/env.ts:13-18`이 "설치된 pyannote.audio 4.x 아래에서 3.1은
  클러스터링이 모든 화자를 한 라벨로 뭉갠다(mtg_5 실측)"고 기록했고 제품
  기본값은 `pyannote/speaker-diarization-community-1`이다. community-1은
  **자기 저장소 안에** segmentation·embedding·plda를 다 갖고 있어(config.yaml이
  `$model/...`을 가리킨다) 외부 저장소를 끌어오지 않는다. 즉 이 파이프라인이
  실제로 받는 게이트 저장소는 **1종**이다 — 스펙 P0-C4의 "게이트 모델 3종"은
  3.1 계열(3.1 + segmentation-3.0 + wespeaker) 기준의 표현이고, 그중
  `wespeaker-voxceleb-resnet34-LM`은 HF API 기준 현재 `gated=False`다.
- **모델 실측 용량** (샌드박스 HF 캐시, blobs 실체 기준).
  `pyannote/speaker-diarization-community-1` 32,821,461 B ·
  `speechbrain/spkrec-ecapa-voxceleb` 88,983,513 B ·
  `mlx-community/whisper-large-v3-turbo` 1,613,980,437 B. 합계 **1.62 GiB**.
  silero-vad는 pip 패키지가 가중치를 동봉해 다운로드가 없다
  (`site-packages/silero_vad/data/silero_vad.jit`). 저장소별 상한은
  `probe/hf_size_survey.py`로 다시 잴 수 있다(Task 9의 용량 산정에 그대로 쓴다).
- **31분 오디오 1건의 벽시계 시간은 586초**다(`total_ms=586660`). 단계별로
  normalize 1.7초 · VAD 7.0초 · diarize 169.5초 · ECAPA embed 28.6초 ·
  identify 0.05초 · STT 315.1초 · align 64.6초 · persist 0.09초.
  모델 다운로드(1.62 GiB)는 이 시간 밖이다.
- **DB에 `mtg_2`가 생겼다.** Task 6의 `mtg_1`(발화 12건, `processing_version=1`)
  옆에 발화 458건(`ok` 374 / `transcribe_failed` 84), `diar_label` 5종,
  `meeting_cluster` 5행, `auto_cluster` voiceprint 5건, `speaker` 5행
  (전부 `provisional`)이 있다. **전역 집계는 두 회의를 함께 센다** — Task 11의
  집계는 meeting id로 스코프해야 한다.
- **후속 job은 큐잉하지 않았다.** payload를 wire v5로 만들고
  `followups={lens:false, summary:false}`를 실었다. 켜 두면 persist가
  `extract_lenses`/`summarize_meeting`을 queued로 남기고, 다음 회차의
  `db.claim`이 그것을 먼저 집어 재실행이 멱등하지 않게 된다. `index_meeting`은
  `run_once`가 `search_embedding`을 `(None, None)`으로 두므로 애초에 안 생긴다.
- **"이 회차가 새로 받았는가"로 판정하지 말아라 — 두 번째 실행부터 반드시
  실패한다.** 드라이버는 실행 전후의 HF `hub/` 차집합으로 `NEW`를 찍는데,
  스펙 §4.4는 재실행 시 캐시를 **지우지 않고 이어받으라**고 정한다. 그래서
  두 번째 회차의 `NEW`는 항상 0건이다. 스펙이 요구하는 것은 "빈 캐시에서 한 번만
  재고 **그 회차를 증거에 명시**"이므로, 판정은 (1) 재실행에도 변하지 않는
  파일시스템 사실과 (2) **회전된 `*.prev-*.txt`까지 뒤진 회차 기록**으로 한다.
  V5가 이 함정에 빠져 verifier 재실행에서 FAIL 났다. Task 9도 모델을 받으므로
  같은 형태를 쓰게 된다.
- **"남의 캐시가 아니다"는 개발자 홈을 읽지 않고도 말할 수 있다.** blob의
  **하드링크 수**가 전부 1이면 다른 캐시와 실체를 공유하지 않는다는 뜻이다.
  심볼릭 링크와 달리 경로로는 보이지 않으므로 `stat -f %l`로 따로 센다.
- **`stat -t '%Y-%m-%dT%H:%M:%SZ'`를 쓰지 말아라.** 그 형식은 **현지 시각**을
  찍으면서 리터럴 `Z`를 붙여 UTC인 척하는 값을 만든다(KST면 9시간 어긋난 값에
  `Z`가 붙는다). `stat -f %B`로 epoch를 받아 `date -u -r`로 바꾼다
  (`t7-lib.sh::t7_utc_of_epoch`).
- **`t*_evidence_path`의 회전은 파일명이 1초 단위라 같은 초에 두 번 돌면 앞의
  것이 덮인다.** 검사를 연달아 돌려 멱등을 확인할 때 회차가 조용히 사라진다.
- **V9는 드라이버 파일 전체를 본다 — 주석·docstring도 센다.** 검사(`verify/`의
  V9 스크립트)는 `testcontainers`·`docker` 두 낱말이 몇 줄에 나오는지를 셀 뿐
  코드와 설명문을 구분하지 않고 대소문자도 무시한다. 그래서 드라이버가
  "smoke 스크립트를 왜 안 쓰는가"를 설명하면서 그 이름을 한 번만 적어도 깨진다
  (실제로 두 번 깨졌다 — 처음은 라이브러리 이름, 두 번째는 **V9 스크립트의
  파일 이름 자체**를 docstring에 적어서다). 설명이 필요하면 "컨테이너 런타임"
  같은 표현을 쓰고, 검사 대상을 코드 줄로 좁히고 싶으면 먼저 계획을 고쳐라.
- **`grep -c`의 종료 코드에 기대지 말아라.** 0건이면 `0`을 출력하면서 **exit 1**
  이다. "없어야 정상"인 검사를 종료 코드로 판정하면 정확히 뒤집힌다.
  `t7-lib.sh::t7_count_literal`이 값만 읽고 종료 코드를 흘린다.
- **`utterance` 재삽입은 먼저 지워야 한다.** 013 이후 UNIQUE가
  `(meeting_id, processing_version, order_index)`라 같은 버전으로 다시 넣으면
  충돌한다. 드라이버는 자기 회의의 utterance·meeting_cluster를 지우고,
  `persist_process_meeting`과 **같은 SQL**로 고아가 된 provisional 화자를
  정리한 뒤 다시 돈다.

## verify/ 규약

각 스크립트는 조건을 만족하면 exit 0, 아니면 exit 1이고 판정 근거를 stdout에
출력한다. "exit 1을 기대하는" 검사(음성 대조군)도 스크립트가 뒤집어 exit 0으로
만든다 — verifier가 비정상 종료와 의도된 실패를 구분하지 못하는 상황을 없애기
위해서다 (계획 "Verify 명령 작성 규칙").

`verify/t1-detector-negative.sh`가 특히 중요하다. 이 하네스의 증거는 전부
G1 정적 검사와 G2 dyld 실측에서 나오므로, 둘 중 하나가 눈이 멀면 나머지 열
Task의 "위반 0건"은 아무 의미가 없다. 그 스크립트는 금지 문자열 9종,
`otool -L` 의존 위반, `LC_RPATH` 위반, dyld 실측을 각각 일부러 만들어 놓고
**검출되는지**를 확인한다.
