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

**2a. 래퍼가 받는 것은 자식의 fd 2 하나뿐이다 — Task 2·5가 알아야 한다.**
`pg_ctl start -l <파일>`처럼 **데몬화하면서 stderr를 딴 데로 돌리는** 명령을
래퍼에 통과시키면 dyld 줄이 0건이 되고, 래퍼는 그것을 SIP 탓
(`MEASUREMENT_UNAVAILABLE`)으로 적는다 — 원인을 잘못 귀속한다. 서버는 래퍼
아래 **포그라운드로** 띄우고, PID 파일에는 **서버 자신의 PID**를 쓴다(래퍼
bash의 PID가 아니라). 그래야 dyld 실측이 서고 `run.sh kill`의 SIGKILL이
실제 서버에 간다.

**2b. 증거는 자식이 끝난 뒤에만 쓰인다.** 래퍼 bash가 먼저 죽으면 그 회차의
증거는 남지 않고 자식은 고아가 된다. 긴 작업을 중단할 때는 자식을 먼저
`$SANDBOX/run/`의 PID로 내린다.

**2c. 자손 전부가 `DYLD_PRINT_LIBRARIES`를 물려받는다.** 워커가 띄우는
ffmpeg나 `mlx_lm.server`의 stderr에도 dyld 줄이 섞여 같은 파일에 들어온다.
증거를 읽을 때 한 프로세스의 로드 목록이 아니라 **프로세스 트리 전체의**
로드 목록임을 감안한다. `dyld[<pid>]` 접두사로 갈라 볼 수 있다.

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

형제 번들(`$EXP/bundle/*`)을 가리키는 절대 경로도 **지금은 위반**이다.
번들 간 참조를 허용할지는 Task 3이 Python 런타임 구성 방식을 정하면서
결정할 문제이지, 검사기가 미리 봐 줄 일이 아니다. 허용하기로 정하면 그때
`allowed_dep`/문자열 면제와 같은 자리에 근거를 적고 넓힌다.

**5a. Task 11의 증거 집계기(`aggregate-isolation.sh`)에게.**
`$EVIDENCE/*-env.txt`와 `*-dyld.txt`에는 샌드박스 절대 경로가 **정상적으로**
들어 있다(격리 실행의 `HOME`·`TMPDIR`이 거기다). 그것을 금지 문자열로 세면
P0-C7이 항상 실패한다. 다만 면제는 `$SANDBOX` 하위와 실제로 검사한
`bundle/` 하위로 좁혀라 — `$EXP` 전체를 뭉뚱그려 빼면 위 `STALE-PATH`와 같은
구멍이 증거 집계 쪽에 그대로 생긴다.

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
