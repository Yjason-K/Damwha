# Electron Phase 4 — 번들 런타임 구현 계획 (Part 1 / 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Python·ML 라이브러리·ffmpeg를 재현 가능하게 빌드해 `.app`에 싣고, 그 번들이 어느 자리에 놓여도 도는 것을 빌드 시점에 증명한다.

**Architecture:** Phase 3의 `build-postgres.sh` → `desktop/build/` → `extraResources` → `Resources/` 경로를 Python·ffmpeg에 복제한다. 재배치는 **절대 경로를 하나도 굽지 않는** 규칙 하나로 통일한다 (스펙 §6.1-b) — 한 산출물이 dev·packaged 두 자리에 놓이기 때문이다.

**Tech Stack:** bash, python-build-standalone 3.12.11, uv (빌드 전용), ffmpeg LGPL 정적 빌드, `codesign`/`install_name_tool`, electron-builder, Node (check-bundle).

**Spec:** [2026-09-16-electron-phase-4-embedded-python-runtime-design.md](../specs/2026-09-16-electron-phase-4-embedded-python-runtime-design.md)

**Part 2:** [2026-09-16-electron-phase-4-runtime-integration.md](2026-09-16-electron-phase-4-runtime-integration.md) — 실행 계약·앱·검증. **이 계획이 끝나야 의미가 있다.**

---

## 이 계획이 지키는 두 규칙

**규칙 1 — 계획에 박는 코드는 확정 전에 최소 한 번 실행한 것만이다.**

4회차까지의 blocking 11건 중 8건이 "계획에 문자 그대로 적었지만 한 번도 실행하지 않은 코드"에서
나왔다. `BUILD_PREFIX` 필터가 0건을 처리하는 것, `getattr` 훑기가 92개 모듈에서 던지는 것,
`config.log`에 없는 줄을 grep하는 것 — 전부 한 번 돌려 봤으면 그 자리에서 드러났다.

그래서 이 계획은:

- **셸 스크립트는 전문을 싣는다.** 실행이 곧 검증이고 Step이 그것을 시킨다.
- **TypeScript·Python은 시그니처와 테스트만 싣는다.** 구현 본문은 "구현 시 작성"이다 —
  계획이 컴파일러를 대신할 수 없다.
- 예외로 본문을 싣는 코드에는 **`[실행됨: <명령>]`** 표시를 붙인다. 없으면 싣지 않는다.
- **검증 명령은 `/usr/bin/grep`·`/usr/bin/find`·`/usr/bin/diff`로 실행한다.** 이 세션의 셸에서
  셋 다 함수로 바꿔치기돼 있고(`grep`은 ugrep `-I` — 바이너리를 건너뛴다), 5회차 blocking
  5건 중 **2건이 그 오염의 산물**이었다. `[실행됨]`은 "돌렸다"만 증명하지 **무엇으로** 돌았는지는
  증명하지 않는다 (스펙 §17.8·§17.9).

**규칙 2 — 한 계약의 사본을 여럿 두지 않는다.**

시그니처는 **Interfaces 절에만** 적는다. Step 안에서 다시 적지 않는다. 4회차의
`parseDamwhaProcesses`가 인터페이스·테스트·구현·호출부 네 곳에서 갈린 것이 그 규칙이 없어서다.

## Global Constraints

스펙에서 **문자 그대로** 옮긴 값이다. 모든 Task에 암묵적으로 포함된다.

- **Python 3.12.11** (python-build-standalone `20250818`). venv를 만들지 않고 배포본
  `site-packages`에 직접 설치.
- **ffmpeg LGPL 2.1 정적 빌드.** 버전과 configure 플래그는 Phase 0 원본
  (`docs/superpowers/reference/electron-phase-0/ffmpeg-fetch.sh`)을 따른다 — **다르면 원본이 맞다.**
- **`mlx-lm` 기준값 0.31.3.** `uv.lock`이 단일 진실 원천이다.
- **entitlement plist는 둘이다** (스펙 §6.1). `entitlements.python.plist` = 최소 집합 둘
  (`allow-unsigned-executable-memory`, `disable-library-validation`) → `Resources/python`·
  `Resources/ffmpeg`. `entitlements.mac.plist` = 위 둘 + **`allow-jit`** → `Damwha.app`.
  **`.app`에 `allow-jit`이 없으면 V8이 rc=133으로 죽는다** (2026-09-16 실측). Task 2의 numba
  측정은 Python 트리에만 적용된다. 트리 쪽은 최소 집합으로 numba가 산다 — 둘 다 각각
  필요하다: 없으면 dyld가 SIGABRT, `disable-library-validation`만 있으면 `import numba`가 SIGKILL.
- **entitlements plist의 XML 주석에 하이픈 두 개를 연달아 쓰지 않는다.** AMFI 파서가 거부해
  `codesign`이 rc=1로 실패하고, `plutil -lint`는 그것을 통과시킨다. **서명에 실패한 `.app`도
  실행되므로** 실행 성공을 서명 성공으로 읽지 않는다.
- **서명 판정은 `codesign --verify --arch arm64`.** `--arch` 없이 부르지 않는다.
- **번들에 절대 경로를 굽지 않는다** (스펙 §6.1-b).
- **`npm install` 금지.** 패키지를 루트에서 실행하지 않는다.
- **절대 불변** (스펙 §5와 글자 그대로 같다) — `be/worker/.env`, `be/.env`, `fe/.env`,
  `~/.cache/huggingface`, Docker 볼륨 `damwha_pgdata`, `be/storage`, `<userData>/storage/`.
  **`~/.cache/uv`는 여기 없다** — Task 3의 `uv sync`가 그 캐시에 정당하게 쓰므로 넣으면
  규칙과 사실이 어긋난다. `~/.local/share/uv/tools`는 §5 허용 변경 표의 "건드리지 않는다"이고
  Task 1이 그것을 `abs-` 쪽에서 감시한다.
- **허용 변경** — `be/worker/.venv`(Task 3), `~/.local/bin/mlx_lm.server`(Part 2의 검증).
  **Task 1이 기준선을 뜬 뒤에만** 손댄다.
- 커밋 메시지는 한국어 본문. 제목은 `type(scope): 한 줄`.

## 검증 명령

| 무엇 | 명령 |
| --- | --- |
| worker 테스트 | `pnpm worker:test` |
| worker lint | `uv run --directory be/worker ruff check .` |
| 앱 패키징 | `pnpm --filter damwha-desktop run package:desktop` |
| 번들 위생 | `node desktop/scripts/check-bundle.mjs` |

---

## 파일 구조

| 경로 | 책임 |
| --- | --- |
| `desktop/scripts/phase4-baseline.sh` | 데이터 안전 기준선 — 찍기·대조 |
| `desktop/scripts/probe-numba.sh` + `numba-probe/*.py` | numba JIT 사망 지점 측정 |
| `desktop/build-resources/entitlements.mac.plist` | `.app`(Electron)용 entitlement — `allow-jit` 포함 |
| `desktop/build-resources/entitlements.python.plist` | 번들 Python 트리용 entitlement — 최소 집합 둘 |
| `desktop/scripts/build-ffmpeg.sh` + `ffmpeg-checksums.txt` | ffmpeg LGPL 정적 빌드 |
| `desktop/scripts/build-python.sh` + `python-checksums.txt` | Python 트리 (캐시 2층) |
| `desktop/scripts/package.mjs` | 빌드 호출·서명 (수정) |
| `desktop/scripts/check-bundle.mjs` | 번들 위생 (수정) |
| `be/worker/pyproject.toml`·`uv.lock` | `mlx-lm`·`mlx` 고정 (수정) |

**참조:** `docs/superpowers/reference/electron-phase-0/` — Phase 0 원본 사본. `README.md`가
읽어야 할 다섯 곳을 짚는다. **옮긴 것이 원본과 다르면 원본이 맞다.**

---

## Task 1: 기준선 — 무엇이든 건드리기 전에

스펙 §5가 **절대 불변**과 **허용 변경**을 나눴다. 기준선을 나중에 뜨면 Task 3이 이미 `.venv`를
바꾼 뒤다.

**Files:** Create `desktop/scripts/phase4-baseline.sh`

**Interfaces:**
- Consumes: 없음
- Produces: `/tmp/p4-baseline/{now,later}/` + `baseline`·`verify` 두 모드. Part 2의 검증이 대조한다.

- [x] **Step 1: 스크립트를 쓴다**

`desktop/scripts/phase4-baseline.sh` — 전문은 아래. **셸이라 전문을 싣고 Step 2·3이 실행으로
검증한다** (규칙 1).

**[실행됨: `bash desktop/scripts/phase4-baseline.sh baseline` → rc=0, 7.9초, 산출 13개]**

```bash
#!/bin/bash
# desktop/scripts/phase4-baseline.sh
#
# Electron Phase 4의 데이터 안전 기준선 (스펙 §5). 두 부류를 **따로** 찍는다 —
# 절대 불변은 바이트 단위로, 허용 변경은 복구에 필요한 것만.
#
#   bash desktop/scripts/phase4-baseline.sh baseline   기준선 (첫 Task보다 먼저)
#   bash desktop/scripts/phase4-baseline.sh verify     지금 상태와 대조

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OUT="${P4_BASELINE_DIR:-/tmp/p4-baseline}"
MODE="${1:?usage: phase4-baseline.sh baseline|verify}"
case "$MODE" in baseline) DEST="$OUT/now" ;; verify) DEST="$OUT/later" ;; *) echo "모드: baseline|verify" >&2; exit 2 ;; esac

mkdir -p "$DEST"
cd "$REPO"

sums() {   # 경로 하나 → 해시 목록. 없으면 빈 파일 ("없음"도 상태다).
  if [ -e "$1" ]; then
    find "$1" -type f -exec shasum -a 256 {} + 2>/dev/null | sort > "$DEST/$2"
  else
    : > "$DEST/$2"
  fi
}

# ── 절대 불변 ────────────────────────────────────────────────────────────────
sums be/worker/.env  abs-worker-env.txt
sums be/.env         abs-be-env.txt
sums fe/.env         abs-fe-env.txt
sums be/storage      abs-be-storage.txt
sums "$HOME/Library/Application Support/Damwha/storage" abs-userdata-legacy-storage.txt
# HF 캐시는 수십 GB다. 우리가 걱정하는 것은 "새 다운로드가 여기 떨어졌나"이지 비트 손상이
# 아니므로 파일 목록과 크기로 충분하다.
find "$HOME/.cache/huggingface" -type f -exec stat -f '%z %N' {} + 2>/dev/null | sort > "$DEST/abs-hf-cache.txt"
ls -la "$HOME/.local/share/uv/tools" > "$DEST/abs-uv-tools.txt" 2>/dev/null || : > "$DEST/abs-uv-tools.txt"
# Docker 볼륨은 메타데이터로 내용 보존을 증명하지 못한다 — 행 수를 직접 센다. host psql이
# 없는 맥이 많아 컨테이너 안의 것을 쓰고, 못 재면 **빈 파일이 아니라 "측정 불가"**를 적는다.
# pg_stat_user_tables.n_live_tup은 **추정치**라 ANALYZE만으로 흔들려 거짓 FAIL을 낸다.
# 정확한 count(*)를 센다 — 이 규모에서 전체가 0.1초다.
if docker exec damwha-postgres psql -U postgres -d damwha -tAc \
     "select string_agg(t||'='||c, E'\n' order by t) from (
        select c.relname as t,
               (xpath('/row/c/text()',
                      query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname),
                                   false, true, '')))[1]::text::bigint as c
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = 'public'
      ) s" \
     > "$DEST/abs-docker-db-rows.txt" 2>/dev/null && [ -s "$DEST/abs-docker-db-rows.txt" ]; then
  :
else
  echo "MEASUREMENT-UNAVAILABLE (docker exec damwha-postgres psql)" > "$DEST/abs-docker-db-rows.txt"
fi

# ── 허용 변경: 복구에 필요한 것 ───────────────────────────────────────────────
cp be/worker/uv.lock "$DEST/mut-uv.lock" 2>/dev/null || :
# --no-sync: 이 조회가 .venv를 바꾸면 기준선이 자기가 재려던 것을 움직인다.
uv run --no-sync --directory be/worker python -c "
import importlib.metadata as m
for p in sorted(('torch','torchaudio','numpy','mlx','mlx-lm','mlx-whisper','faster-whisper',
                 'pyannote.audio','speechbrain','sentence-transformers','numba','llvmlite')):
    try: print(p, m.version(p))
    except Exception: print(p, 'MISSING')
" > "$DEST/mut-venv-versions.txt" 2>/dev/null || : > "$DEST/mut-venv-versions.txt"
ls -la "$HOME/.local/bin" > "$DEST/mut-local-bin.txt" 2>/dev/null || :

# ── 앱 데이터: 기존 레코드 보존으로 판정 ──────────────────────────────────────
APP="$HOME/Library/Application Support/Damwha"
sums "$APP/data/storage" app-storage.txt
"$REPO/desktop/build/postgres/bin/psql" -h "$APP/run" -U damwha damwha -tAc \
  "select 'meeting='||count(*) from meeting" > "$DEST/app-db-rows.txt" 2>/dev/null \
  || echo "MEASUREMENT-UNAVAILABLE (embedded psql)" > "$DEST/app-db-rows.txt"

echo "== $MODE → $DEST"

if [ "$MODE" = verify ]; then
  echo
  # 기준선 없이 부르면 루프가 한 번도 안 돌아 조용히 통과한다. 그것은 대조가 아니다.
  if ! compgen -G "$OUT/now/abs-*.txt" > /dev/null; then
    echo "기준선이 없다: $OUT/now — 먼저 baseline 모드로 찍어라" >&2
    exit 2
  fi
  fail=0
  for f in "$OUT/now"/abs-*.txt; do
    [ -e "$f" ] || continue
    n=$(basename "$f")
    if grep -q '^MEASUREMENT-UNAVAILABLE' "$f" 2>/dev/null; then
      # 양쪽이 "측정 불가"면 같아서 PASS가 되지만 그것은 대조가 아니다.
      echo "SKIP  $n — 기준선이 측정 불가였다. 판정하지 않는다"; fail=1
    elif diff -q "$f" "$OUT/later/$n" >/dev/null 2>&1; then
      echo "PASS  $n"
    else
      echo "FAIL  $n"; diff "$f" "$OUT/later/$n" | head -10; fail=1
    fi
  done
  echo
  echo "허용 변경(mut-*)·앱 데이터(app-*)는 자동 판정하지 않는다 — 사람이 대조한다:"
  ls "$OUT/later" | grep -E '^(mut|app)-' | sed 's/^/  /'
  exit $fail
fi
```

**절대 불변만 `diff`로 자동 판정한다.** 허용 변경과 앱 데이터는 "바뀌었는가"가 아니라
"**어떻게** 바뀌었는가"를 봐야 하고 그것은 사람의 일이다.

```bash
chmod +x desktop/scripts/phase4-baseline.sh
```

- [x] **Step 2: 기준선을 찍는다**

```bash
pnpm db:up          # Docker DB 행 수를 세려면 떠 있어야 한다
bash desktop/scripts/phase4-baseline.sh baseline
ls -la /tmp/p4-baseline/now
```

컨테이너가 이미 healthy면 `pnpm db:up`을 건너뛴다 — 조건은 이미 충족됐고 `compose up`은
compose 파일이 바뀌었을 때 컨테이너를 재생성한다.

`MEASUREMENT-UNAVAILABLE`이 있으면 그 이유를 적어 둔다 — `verify`가 같은 조건이어야 한다.

**[실행됨: 2026-09-16. `app-db-rows.txt`만 `MEASUREMENT-UNAVAILABLE (embedded psql)` — 앱이
안 떠 있어 `<userData>/run`에 소켓이 없다. `app-` 접두사라 자동 판정 대상이 아니지만 `verify`도
앱 미기동 상태여야 한다. 나머지 12개는 측정됐다.]**

이 기준선이 확인한 것 셋 — 스펙 §2.4가 실측으로 재확인됐다.

| 값 | 실측 | 뜻 |
| --- | --- | --- |
| `.venv`의 `mlx-lm` | **MISSING** | 매니페스트 밖. `~/.local/share/uv/tools/mlx-lm` 전역 설치에 기대고 있다 |
| `.venv`의 `mlx` | 0.31.2 | Task 3이 `uv.lock`에 맞춰 옮길 대상 |
| `.venv`의 `numba`·`llvmlite` | 0.65.1 · 0.47.0 | **이미 잠금에 있다** → Task 2를 Task 3보다 먼저 돌려도 된다 |

- [x] **Step 3: 탐지가 되는지 실증한다**

`verify`는 diff 전에 `later/`를 **다시 수집해서 덮어쓴다**(`sums()`의 `> "$DEST/…"`). 그래서
`later/`를 조작하고 `verify`를 부르면 조작이 diff 전에 지워져 `FAIL`이 나오지 않는다
(**[실행됨: 2026-09-16 — probe 줄이 사라지고 grep이 rc=1로 빈손]**). 조작 대상은 `verify`가
건드리지 않는 `now/` 쪽이고, 진짜 기준선을 더럽히지 않도록 **트리째 사본**에 한다.

```bash
bash desktop/scripts/phase4-baseline.sh verify              # 전부 PASS

rm -rf /tmp/p4-baseline-probe
cp -R /tmp/p4-baseline /tmp/p4-baseline-probe               # **사본**을 조작한다
echo "probe-line" >> /tmp/p4-baseline-probe/now/abs-be-env.txt
P4_BASELINE_DIR=/tmp/p4-baseline-probe \
  bash desktop/scripts/phase4-baseline.sh verify 2>&1 | grep 'FAIL.*abs-be-env'
rm -rf /tmp/p4-baseline-probe /tmp/p4-baseline/later
```

**실파일에 쓰지 않는다.** `be/.env`는 절대 불변이고, `be/.gitignore:7`이 무시하므로
`git checkout be/.env`는 `pathspec did not match`로 **실패한다** — probe 줄이 영구히 남는다.

**[실행됨: 2026-09-16. `verify` 8건 전부 PASS → 사본 조작 후 `FAIL abs-be-env.txt` + `< probe-line`.
진짜 기준선 불변. 기준선 없는 `verify`는 가드가 rc=2로 막는다.]**

**Verify:** Step 2·3 통과. `git status`가 깨끗하다.

**Review:**
- 절대 불변 목록이 스펙 §5와 정확히 같은가. **`~/.cache/uv`는 §5에 없고 여기에도 없어야
  한다** — Task 3의 `uv sync`가 그 캐시에 정당하게 쓰므로 절대 불변에 넣으면 모순이다.
- `.venv`·`~/.local/bin`이 `mut-` 쪽인가.
- Docker DB를 메타데이터가 아니라 **행 수**로 재는가.
- `uv run`에 `--no-sync`가 있는가 — 없으면 기준선이 자기 측정 대상을 움직인다.
- Step 3이 **사본의 `now/`**를 조작하는가. `later/`는 `verify`가 덮어쓴다.
- 기준선 없는 `verify`가 조용히 통과하지 않는가.

**[리뷰 결과: 6항 전부 통과 — 2026-09-16 메인 세션]**

- [x] **Step 4: 커밋** — `chore(desktop): Phase 4 데이터 안전 기준선 스크립트를 더한다`

---

## Task 2: numba 사망 지점 측정 — 뒤를 가르는 분기

**이 결과가 Task 5·7의 entitlement 목록과 Phase 진행 여부를 정한다.** Task 5는 빌드 중 Mach-O
전수 서명에 `entitlements.python.plist`를, Task 7은 `.app` 최종 서명에 `entitlements.mac.plist`를
쓴다. Task 6은 쓰지 않는다. **plist가 둘인 이유는 Step 6-c에 있다.**

**Files:** Create `desktop/scripts/probe-numba.sh`, `desktop/scripts/numba-probe/{import_only,define_only,call_it}.py`, `desktop/build-resources/entitlements.python.plist`, `desktop/build-resources/entitlements.mac.plist`

**Interfaces:**
- Consumes: Task 3의 `uv.lock` (numba·llvmlite 고정 버전). **`uv.lock`에 numba가 이미 있으면
  Task 3보다 먼저 해도 된다** — `mlx-whisper`의 전이 의존이라 보통 있다.
- Produces: 판정 하나 — `survives` / `dies_at: import|define|call` / `allow_jit_fixes: bool`.

**[실행됨: 2026-09-16 — 판정 `survives`. 최소 집합으로 산다. `allow-jit` 불필요. Step 6의
첫 줄(plist 그대로, 다음 Task)로 간다. Task 1의 기준선이 잠금에 numba 0.65.1·llvmlite 0.47.0이
이미 있음을 확인해 Task 3보다 먼저 돌렸다.]**

- [x] **Step 1: entitlements를 만든다 — plist 둘**

`desktop/build-resources/entitlements.python.plist` (번들 Python 트리 전용. 이 Task가 재는 것이
이 집합이다):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Phase 0 실측 최소 집합. MLX Metal 셰이더 런타임 컴파일과 torch.jit.script는
       hardened runtime에서 깨지지 않는다 — 깨지는 것은 numba의 LLVM MCJIT이다. -->
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <!-- 제3자 wheel의 .so는 우리 Team ID로 서명되지 않는다. dlv는 서명 주체를 안 따질 뿐
       "서명 없음"은 허용하지 않으므로, 빌드의 전수 서명과 짝이다 (Phase 0 R-5). -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

`desktop/build-resources/entitlements.mac.plist` (`.app` 본체용)는 **같은 둘에 `allow-jit`을
더한다.** 근거는 Step 6-c의 측정이다. `--deep`이 Electron Framework와 헬퍼에도 hardened
runtime을 걸기 때문에 이 셋이 `.app` 전체에 적용된다.

**XML 주석에 하이픈 두 개를 연달아 쓰지 않는다.** `codesign`이
`Failed to parse entitlements: AMFIUnserializeXML: syntax error near line N`으로 rc=1에
실패한다 — `plutil -lint`는 통과시키므로 lint만으로는 못 잡는다.
**[실행됨: 2026-09-16 — 주석에 `codesign --deep`을 적었다가 그대로 당했다. 게다가 서명이
실패한 `.app`도 linker-signed 상태로 **그냥 실행되어**, 실행 성공을 서명 성공으로 읽으면
거짓 통과가 난다.]**

- [x] **Step 2: 세 프로브를 각각 별개 파일로 쓴다**

한 프로세스에서 셋을 다 하면 어디서 죽었는지 구분되지 않는다 — Phase 0의 `probe.sh:391-406`이
정확히 그 실수를 했고 그래서 이 항목이 미해결로 넘어왔다.

| 파일 | 내용 |
| --- | --- |
| `import_only.py` | `import numba` + `print("IMPORT-OK", numba.__version__)` |
| `define_only.py` | 위 + `@numba.jit(nopython=True) def add(a,b): return a+b` + `print("DEFINE-OK")` |
| `call_it.py` | 위 + `print("CALL-RESULT", add(1,2))` + `print("CALL-OK")` |

`call_it.py`가 `mlx_whisper/timing.py:47,72`와 같은 모양이다 — 지연 컴파일이라 호출에서 처음
LLVM MCJIT을 탄다.

- [x] **Step 3: 측정 스크립트를 쓴다**

**[실행됨: `bash desktop/scripts/probe-numba.sh /tmp/numba-probe/python
desktop/build-resources/entitlements.python.plist` → Mach-O 42개 서명, 3/3 통과, rc=0]**

서명 개수 가드를 더했다. 트리 경로가 틀리면 `find`가 0건을 내고 프로브가 **서명 없이** 돌아
거짓 `survives`가 나온다 — Task 4의 `fix_macho` 0건 지적과 같은 부류다.

`${signed}개`의 중괄호가 필수다. `$signed개`로 쓰면 bash가 한글을 변수명에 포함해
`signed개: unbound variable`로 죽는다 (실행에서 드러났다).

```bash
#!/bin/bash
# desktop/scripts/probe-numba.sh
#
# numba의 LLVM MCJIT이 hardened runtime에서 사는지, 죽는다면 import·정의·호출 중 어디서
# 죽는지 가른다 (Electron Phase 4 스펙 §6.8). 쓰기+실행 매핑 거부는 **메시지 없이 SIGKILL**이고
# 크래시 리포트도 안 남는다 (Phase 0 R-4) — 부모가 자식의 종료 신호를 읽는 것이 유일한 관측이다.
#
#   bash desktop/scripts/probe-numba.sh <python트리> <entitlements.plist>

set -uo pipefail   # -e 없음: 자식이 죽는 것이 관측 대상이다

PY_TREE="${1:?usage: probe-numba.sh <python-tree> <entitlements.plist>}"
ENTS="${2:?usage: probe-numba.sh <python-tree> <entitlements.plist>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PY="$PY_TREE/bin/python3.12"
[ -x "$PY" ] || { echo "python이 없다: $PY" >&2; exit 2; }

echo "== hardened runtime + entitlements로 서명한다: $ENTS"
# 하나라도 빠지면 dlv가 그것을 거부해 numba와 무관한 이유로 죽고, 그 죽음이 JIT 판정으로
# 오독된다. **파이프 뒤 while이 아니라 프로세스 치환이다** — `find | while … exit`의 exit는
# 파이프 서브셸만 끝내고 스크립트는 계속 진행한다.
signed=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  codesign --force --sign - --options runtime --entitlements "$ENTS" "$f" 2>/dev/null \
    || { echo "서명 실패: $f" >&2; exit 3; }
  signed=$((signed + 1))
done < <(find "$PY_TREE" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
echo "== Mach-O ${signed}개를 서명했다"
# 0건이면 프로브가 서명 없이 돌아 거짓 survives가 나온다.
[ "$signed" -gt 0 ] || { echo "Mach-O를 하나도 못 찾았다 — 트리가 틀렸다" >&2; exit 3; }

run_probe() {
  local name="$1" out rc
  out=$("$PY" "$HERE/numba-probe/$name.py" 2>&1); rc=$?
  # 128+9 = 137이 SIGKILL이다.
  if [ "$rc" -eq 137 ]; then echo "$name: SIGKILL (rc=137)"; return 9
  elif [ "$rc" -ne 0 ]; then echo "$name: 실패 rc=$rc"; echo "$out" | tail -5; return 1
  fi
  echo "$name: OK — $(echo "$out" | tail -1)"; return 0
}

VERDICT="survives"
for probe in import_only define_only call_it; do
  run_probe "$probe" || { VERDICT="$probe"; break; }
done
echo
echo "== 판정: $VERDICT"
```

- [x] **Step 4: 최소 트리를 만들어 잰다**

```bash
rm -rf /tmp/numba-probe && mkdir -p /tmp/numba-probe && cd /tmp/numba-probe
curl -fsSL -o py.tar.gz \
  "https://github.com/astral-sh/python-build-standalone/releases/download/20250818/cpython-3.12.11+20250818-aarch64-apple-darwin-install_only.tar.gz"
tar xzf py.tar.gz          # → ./python/

# **잠금 버전을 쓴다.** 최신 numba를 깔면 번들에 실릴 것과 다른 LLVM을 재게 된다.
# numpy도 고정한다 — numba는 numpy 없이는 import부터 죽고 그 죽음이 dies_at: import로
# 오독된다. 안 고정하면 uv가 새로 해석해 번들에 실릴 2.4.6과 다른 ABI를 잰다.
# --frozen: 이 조회가 uv.lock을 갱신하지 않게 한다.
uv export --directory /Users/gim-yeongjae/project/daewha/be/worker \
  --extra models --no-dev --frozen --no-hashes --no-emit-project \
  | grep -E '^(numba|llvmlite|numpy)==' > pins.txt
cat pins.txt
[ -s pins.txt ] || { echo "잠금에 numba가 없다 — Task 3을 먼저"; exit 1; }
uv pip install --python ./python/bin/python3.12 -r pins.txt

cd /Users/gim-yeongjae/project/daewha
# 대조군을 먼저 돌린다. 없으면 서명본이 죽었을 때 그것이 hardened runtime 때문인지
# 설치가 깨진 것인지 구분할 근거가 없다.
for p in import_only define_only call_it; do
  /tmp/numba-probe/python/bin/python3.12 desktop/scripts/numba-probe/$p.py; echo "$p rc=$?"
done

bash desktop/scripts/probe-numba.sh /tmp/numba-probe/python desktop/build-resources/entitlements.python.plist
```

`install_only` 아카이브를 쓰는 이유: 재배치 조작 없이 그 자리에서 돌면 되고, 이 측정은
재배치가 아니라 **JIT이 hardened runtime에서 사는지**를 본다.

**[실행됨: 2026-09-16. 잠금 3개(numba 0.65.1·llvmlite 0.47.0·numpy 2.4.6)만 설치. 대조군
3/3 rc=0. 서명 후 3/3 통과, `flags=0x10002(adhoc,runtime)`, `codesign --verify --arch arm64`
통과. Task 1 기준선 `verify` 8건 전부 PASS — 측정이 `/tmp`에 격리됐고 `uv.lock`·`.venv`·
`~/.local/bin` 무변화.]**

- [ ] **Step 5: 죽었으면 `allow-jit`을 더해 다시 잰다** — **돌리지 않았다.** Step 4가
`survives`를 냈으므로 조건이 성립하지 않는다. 절차는 나중에 필요해질 때를 위해 남긴다.

**사본을 먼저 만들고 키를 더한다.** 순서를 뒤집으면 PlistBuddy가 없는 파일에 쓰려다 실패하고
`|| cp`가 **키 없는 원본**을 남겨 거짓 판정이 나온다.

```bash
cp desktop/build-resources/entitlements.python.plist /tmp/ents-with-jit.plist
/usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.allow-jit bool true" /tmp/ents-with-jit.plist
for k in allow-unsigned-executable-memory disable-library-validation allow-jit; do
  /usr/libexec/PlistBuddy -c "Print :com.apple.security.cs.$k" /tmp/ents-with-jit.plist \
    || { echo "키 누락: $k"; exit 1; }
done
bash desktop/scripts/probe-numba.sh /tmp/numba-probe/python /tmp/ents-with-jit.plist
```

- [x] **Step 6: 판정에 따라 갈라진다**

| 결과 | 조치 |
| --- | --- |
| **최소 집합으로 `survives`** ← **이것이다** | plist 그대로. 다음 Task |
| `allow-jit`을 더해야 산다 | plist에 `allow-jit` 추가. 측정 출력을 결과 문서에 |
| `allow-jit`으로도 죽는다 | **여기서 멈춘다.** `whisper_mlx.py:107-123`이 `segment["words"]`만 쓰므로 word-timestamp를 끄면 전사가 빈다 — 대안 정렬 설계는 이 계획 밖이다. **사용자에게 알린다** |

**Step 6-b: entitlement 둘이 각각 필요한지 가른다** (계획에 없던 측정. `survives`만으로는
최소 집합이 실제로 최소인지, 아니면 프로브가 W+X 경로를 아예 안 밟는지 구분되지 않는다.)

| entitlement 집합 | 결과 | 죽는 지점 |
| --- | --- | --- |
| 서명 없음 (대조군) | 3/3 통과 | — |
| hardened runtime, 키 0개 | rc=134 SIGABRT | dyld 라이브러리 로드 — `code signature … not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs` |
| `disable-library-validation`만 | **rc=137 SIGKILL** | **`import numba`** — W+X 매핑 거부 |
| 최소 집합 (둘 다) | 3/3 통과 | — |

**둘 다 load-bearing이고 서로 다른 지점에서 그렇다.** 그리고 `allow-unsigned-executable-memory`가
필요한 곳은 **호출이 아니라 import**다 — LLVM이 모듈 로드 시점에 실행 메모리를 잡는다.
프로브가 실제 경로를 밟는다는 증거이자, 스펙 §6.1의 "Phase 0 실측 최소 집합"의 재확인이다.
Phase 0 R-4가 적은 "메시지 없는 SIGKILL"이 그대로 재현됐다.

**Step 6-c: 같은 entitlement가 `.app`에도 맞는지 잰다** (5회차 blocking B-1. 이것을 안 재면
Task 7이 `.app`을 기동 불능으로 만든다.)

Task 2의 측정 대상은 **Python 프로세스**다. 그 결과를 `.app`에 옮겨 적으면 안 된다 —
`codesign --deep`은 Electron Framework와 헬퍼에도 같은 entitlement를 건다.

```bash
SRC=desktop/node_modules/electron/dist/Electron.app
for v in ctl min jit; do
  rm -rf "/tmp/p4-ent/$v" && mkdir -p "/tmp/p4-ent/$v" && cp -R "$SRC" "/tmp/p4-ent/$v/E.app"
  mkdir -p "/tmp/p4-ent/$v/E.app/Contents/Resources/app"
  printf '{"name":"p4probe","version":"1.0.0","main":"main.js"}\n' \
    > "/tmp/p4-ent/$v/E.app/Contents/Resources/app/package.json"
  cat > "/tmp/p4-ent/$v/E.app/Contents/Resources/app/main.js" <<'JS'
const { app } = require('electron')
app.disableHardwareAcceleration()
app.on('ready', () => { console.log('RESULT JS-OK', new Function('return 1+1')()); app.exit(0) })
JS
done
"/tmp/p4-ent/ctl/E.app/Contents/MacOS/Electron"; echo "ctl rc=$?"      # 대조군

codesign --force --deep --sign - --options runtime \
  --entitlements desktop/build-resources/entitlements.python.plist "/tmp/p4-ent/min/E.app"
echo "codesign rc=$?"          # **0이 아니면 아래 실행 결과는 무의미하다**
"/tmp/p4-ent/min/E.app/Contents/MacOS/Electron"; echo "min rc=$?"

codesign --force --deep --sign - --options runtime \
  --entitlements desktop/build-resources/entitlements.mac.plist "/tmp/p4-ent/jit/E.app"
echo "codesign rc=$?"
"/tmp/p4-ent/jit/E.app/Contents/MacOS/Electron"; echo "jit rc=$?"
rm -rf /tmp/p4-ent
```

**[실행됨: 2026-09-16, Electron 44.3.0]**

| 서명 | 실행 rc | 결과 |
| --- | --- | --- |
| 손 안 댐 (대조군) | 0 | `RESULT JS-OK 2` |
| 최소 집합 (= Python용 plist) | **133** | `Fatal process out of memory: Failed to reserve virtual memory for CodeRange` |
| `.app`용 plist (+`allow-jit`) | 0 | `RESULT JS-OK 2`, `flags=0x10002(adhoc,runtime)`, 키 셋 |

`allow-jit`을 더한 plist로 numba 프로브를 다시 돌려도 `survives`다 — 두 요구는 충돌하지
않는다. 그럼에도 트리에는 최소 집합만 준다 (권한 최소화).

**Verify:** 판정 한 줄이 나온다. 세 프로브가 **각각 별개 프로세스**로 돌았다.
`codesign -d --entitlements - /tmp/numba-probe/python/bin/python3.12`가 키 **둘**을 보인다.
Step 6-c의 `.app`은 키 **셋**을 보이고 실행 rc=0이다.

**[검증됨: 판정 `survives`. 세 프로브가 별개 `$PY` 호출. `codesign -d --entitlements -`가 키
둘을 보이고 `codesign -dvvv`가 `flags=0x10002(adhoc,runtime)`을 보인다 — hardened runtime이
실제로 걸렸으므로 판정이 유효하다.]**

**Review:**
- 한 프로세스에서 셋을 다 하지 않는가 (Phase 0의 실수 재발).
- `rc=137`(SIGKILL)과 평범한 예외 종료를 구분하는가.
- 서명 루프가 **프로세스 치환**인가 (파이프면 `exit`가 스크립트를 안 끝낸다).
- `uv export`에 `--frozen`이 있는가.
- 서명 0건을 `survives`로 읽지 않는가.
- 대조군이 있는가 — 없으면 죽음의 원인을 hardened runtime에 귀속시킬 수 없다.
- **판정의 적용 범위를 Python 트리로 한정하는가.** `.app`은 Step 6-c가 따로 잰다.
- `codesign` 종료 코드를 보는가 — 서명이 실패해도 앱은 실행된다.

**[리뷰 결과: 8항 전부 통과 — 2026-09-16 메인 세션. `rc=134`(SIGABRT, dyld)와
`rc=137`(SIGKILL, W+X)이 실제로 구분되는 것을 측정으로 확인했다. 마지막 두 항은 5회차
blocking B-1을 받아 더한 것이다.]**

- [x] **Step 7: 커밋** — `chore(desktop): numba JIT이 hardened runtime에서 사는지 가르는 프로브를 더한다`

---

## Task 3: `mlx-lm`·`mlx`를 매니페스트에 고정한다

**정리가 아니라 기능 복구다.** 지금 렌즈·요약은 `~/.local/bin`의 uv tool 전역 설치에 기대고
있다 (스펙 §2.4).

**Files:** Modify `be/worker/pyproject.toml`, `be/worker/uv.lock`

**Interfaces:**
- Consumes: Task 1의 기준선
- Produces: `uv.lock`이 `mlx-lm`·`mlx`의 단일 진실 원천. Task 5의 `uv export`가 읽는다.

- [ ] **Step 1: 지금 상태를 확인한다**

```bash
grep -n "mlx" be/worker/pyproject.toml; grep -n '^name = "mlx' be/worker/uv.lock
uv tool list | grep -A1 mlx-lm
```

기대: `pyproject`에 `mlx-whisper`만, `uv.lock`에 `mlx`·`mlx-metal`·`mlx-whisper`만,
uv tool에 `mlx-lm v0.31.3`.

- [ ] **Step 2: `models` extra에 두 줄을 더한다**

`mlx-whisper` 줄 **아래**:

```toml
    # mlx는 mlx-whisper·mlx-lm의 전이 의존이지만 여기서 명시 고정한다. Electron Phase 4가
    # 이 파일을 번들 설치의 단일 진실 원천으로 쓰기 때문이다 — 전이 해석에 맡기면 빌드마다
    # 다른 버전이 들어가고 그것이 STT 출력을 바꿔도 아무 데도 기록이 남지 않는다.
    "mlx==0.31.2 ; sys_platform == 'darwin' and platform_machine == 'arm64'",
    # 렌즈·요약의 LLM 서버. 2026-09-16까지 이 패키지는 pyproject·uv.lock·.venv 어디에도 없었고
    # `uv tool install mlx-lm`으로 깐 ~/.local/bin/mlx_lm.server에 의존했다. 개발 도구가 없는
    # 맥에는 그 경로가 없으므로 번들에 넣지 않으면 두 기능이 통째로 죽는다.
    "mlx-lm==0.31.3 ; sys_platform == 'darwin' and platform_machine == 'arm64'",
```

플랫폼 마커를 다는 이유: `mlx`는 Apple Silicon 전용이라 마커 없이 고정하면 다른 플랫폼에서
해석이 실패한다. 기존 `mlx-whisper` 줄과 같은 마커다.

- [ ] **Step 3: 잠금을 갱신하고 무엇이 바뀌었는지 본다**

```bash
cp be/worker/uv.lock /tmp/p4-uv.lock.before-task3     # 복구용
uv lock --directory be/worker
git diff be/worker/uv.lock | grep -E '^[+-](name|version)' | head -40
```

**`mlx-lm 0.31.3`이 Python 3.12를 지원하는지가 여기서 처음 드러난다** — 이 맥의 uv tool 설치본은
3.14 환경이고, `pyproject`는 `requires-python = ">=3.12,<3.13"`이다. 해석이 실패하면 3.12에서
받는 최신 버전으로 내리고 그 사실을 결과 문서에 적는다.

- [ ] **Step 4: 허용 변경 절차로 venv를 맞춘다**

```bash
[ -f /tmp/p4-baseline/now/mut-uv.lock ] || { echo "Task 1을 먼저 돌려라"; exit 1; }
pnpm worker:sync          # uv sync --extra models
```

**복구:** `cp /tmp/p4-uv.lock.before-task3 be/worker/uv.lock && pnpm worker:sync`.

`.venv`가 허용 변경인 근거는 **재생성 가능한 파생물**이라는 것이다 — `.env`(사람이 적은 값)나
`~/.cache/huggingface`(수십 GB)와 성질이 다르다. `mlx-lm`을 매니페스트에 넣고 `.venv`를 그
잠금에 안 맞추면 **두 스택이 갈린 채로 남는다**(스펙 §6.1).

- [ ] **Step 5: 회귀를 확인한다**

기준선(`mut-venv-versions.txt`)은 **12개 패키지**를 담는다. 같은 목록으로 다시 찍어야 `diff`가
성립한다 — 부분 집합을 찍으면 항상 차이가 난다.

```bash
uv run --no-sync --directory be/worker python -c "
import importlib.metadata as m
for p in sorted(('torch','torchaudio','numpy','mlx','mlx-lm','mlx-whisper','faster-whisper',
                 'pyannote.audio','speechbrain','sentence-transformers','numba','llvmlite')):
    try: print(p, m.version(p))
    except Exception: print(p, 'MISSING')
" > /tmp/p4-venv-after.txt
/usr/bin/diff /tmp/p4-baseline/now/mut-venv-versions.txt /tmp/p4-venv-after.txt || true
pnpm worker:test
uv run --directory be/worker ruff check .
```

기대: `mlx-lm 0.31.3`이 **새로 나타난다.** `mlx`·`torch`·`numpy`는 그대로.

- [ ] **Step 6: 실오디오 1건 + 요약 1건으로 확인한다**

**전사(STT)** — Step 5의 diff에 `mlx`·`torch`·`numpy` 변화가 있을 때만. 없으면 건너뛴다.
기존 회의 하나를 재처리해 전사 텍스트를 이전과 대조하고, 차이가 크면 `mlx` 고정값을 되돌린다.

**요약·렌즈 — diff와 무관하게 항상 한다.** `.venv`의 `mlx` diff가 비어도 이 조합은 검증되지
않은 채로 남는다. 지금 실제로 요약을 돌리는 것은 `.venv`가 아니라 `~/.local/share/uv/tools`의
전역 `mlx-lm`이고, 그 환경은 **Python 3.14.7 + mlx 0.32.2**다(실측). 이 Task가 고정하는
`mlx-lm 0.31.3 + mlx 0.31.2` 조합은 이 맥에서 **한 번도 돈 적이 없다.** 회의 하나에
요약 job을 걸어 출력이 나오는 것까지 본다.

P4-C25의 문구가 "STT·요약"인데 요약 쪽은 이 Task가 보지 않으면 Part 2 P4-C11까지 아무도
보지 않는다 — 그래서 여기서 본다.

**`lens_llm_server_bin`의 기본값은 이 Task에서 바꾸지 않는다.** 그것과 그것을 읽는 코드를
따로 커밋하면 그 사이 커밋에서 관리형 LLM 서버가 뜨지 않는다 — Part 2가 한 번에 바꾼다.

**Verify:** Step 5 통과. Step 6의 요약 1건은 항상, 전사 1건은 diff에 변화가 있었으면.

**Review:**
- 플랫폼 마커가 기존 `mlx-whisper` 줄과 같은가.
- `uv run`에 `--no-sync`가 있는가.
- 복구 사본을 만들었는가.
- `config.py`를 건드리지 않았는가.
- **요약 검증을 diff 조건에 걸지 않았는가** — 걸면 이 조합이 검증 없이 통과한다.

- [ ] **Step 7: 커밋** — `fix(worker): mlx-lm과 mlx를 매니페스트에 고정한다`

---

## Task 4: `build-ffmpeg.sh`

ffmpeg는 완전 정적이라 `LC_RPATH`가 없고 재배치에서 아무것도 깨지지 않는다 — 세 번들 중
유일하다. 빌드 스크립트 관례를 여기서 먼저 세운다.

**Files:** Create `desktop/scripts/build-ffmpeg.sh`, `desktop/scripts/ffmpeg-checksums.txt`

**Interfaces:**
- Consumes: 없음
- Produces: `desktop/build/ffmpeg/bin/{ffmpeg,ffprobe}`. Part 2의 `ffmpegBinaries()`가 이 배치를 가정한다.

- [ ] **Step 1: Phase 0 원본을 읽는다 — 이것이 이 Task의 절반이다**

```bash
sed -n '1,60p'    docs/superpowers/reference/electron-phase-0/ffmpeg-fetch.sh
sed -n '140,180p' docs/superpowers/reference/electron-phase-0/ffmpeg-fetch.sh
cat docs/superpowers/reference/electron-phase-0/ffmpeg-checksums.txt
```

**원본에서 그대로 가져올 것:** `FFMPEG_VERSION`, configure 플래그 전체, 라이선스 검사 방식
(`:151-161` — configure **stdout**을 파일로 받아 `grep -m1 '^License:'`). 체크섬 파일도 원본을 쓴다.

**바꾸지 않는다.** README 규칙: "옮긴 것이 원본과 다르면 원본이 맞다." 바꿔야 할 이유가 생기면
그 근거를 스펙 §2.1에 적고 사용자 확인을 받는다.

- [ ] **Step 2: `build-postgres.sh`의 관례를 읽는다**

```bash
sed -n '1,60p'    desktop/scripts/build-postgres.sh   # 캐시 키·work 디렉터리
sed -n '197,215p' desktop/scripts/build-postgres.sh   # stage() — 스테이징 관례는 여기다
```

베낄 것: 셔뱅과 `set -euo pipefail`, 도구 존재 확인 루프, `KEY=$(… shasum …)` 캐시 키(스크립트
자신 포함), `WORK`/`OUT`/`DONE` 3종, `--fresh`, `fetch()`, `ditto` 스테이징.

- [ ] **Step 3: 스크립트를 쓴다**

원본의 빌드 조작 + `build-postgres.sh`의 캐시·스테이징 골격. 검증 하네스만 걷어낸다.

**라이선스 검사는 configure stdout을 본다.** ffmpeg의 configure는 그 줄을
`echo "License: $license"`로만 내고 `log()`·`echolog()`를 거치지 않아 **`ffbuild/config.log`에는
들어가지 않는다** — config.log를 grep하면 항상 실패한다. 이중 확인으로 `ffbuild/config.mak`에
`CONFIG_GPL=yes`·`CONFIG_NONFREE=yes`가 없는지도 본다(비활성은 `!CONFIG_X=yes` 형식이라
`^CONFIG_(GPL|NONFREE)=yes`가 맞다).

정적 확인: `otool -L`의 외부 의존이 `/usr/lib`·`/System` 밖이면 `die`.

- [ ] **Step 4: 돌린다**

```bash
bash desktop/scripts/build-ffmpeg.sh
time bash desktop/scripts/build-ffmpeg.sh   # 두 번째 — 스테이징만이라 몇 초
```

- [ ] **Step 5: 우리 파이프라인 명령이 실제로 도는지 본다**

```bash
SRC=$(find be/storage -type f \( -name "*.wav" -o -name "*.m4a" \) 2>/dev/null | head -1)
[ -n "$SRC" ] || SRC=/System/Library/Sounds/Glass.aiff
desktop/build/ffmpeg/bin/ffprobe -v error -show_entries format=duration -of json "$SRC"
desktop/build/ffmpeg/bin/ffmpeg -y -i "$SRC" -ac 1 -ar 16000 -sample_fmt s16 -c:a flac \
  -compression_level 5 -f flac /tmp/ff-probe-out.flac
desktop/build/ffmpeg/bin/ffprobe -v error -show_entries stream=sample_rate,channels,sample_fmt \
  -of json /tmp/ff-probe-out.flac
```

기대: 16000 / 1채널 / s16. **`be/storage`는 읽기만 한다** — 출력은 `/tmp`로 간다.

**Verify:** Step 4·5 통과. `git status`에 `desktop/build/`·`.cache/`가 안 뜬다.

**Review:**
- **버전과 configure 플래그가 Phase 0 원본과 같은가.** 다르면 그 근거가 문서에 있는가.
- 라이선스 검사가 **configure stdout**을 보는가 (config.log가 아니라).
- `config.mak` 이중 확인이 있는가.
- 캐시 키에 스크립트 자신의 shasum이 들어갔는가.
- `otool -L` 검사가 `/usr/lib`·`/System` 밖을 전부 잡는가.
- `be/storage`에 쓰지 않는가.

- [ ] **Step 6: 커밋** — `feat(desktop): 내장 ffmpeg 빌드 스크립트를 더한다`

---

## Task 5: `build-python.sh` — 런타임 층

**Files:** Create `desktop/scripts/build-python.sh`, `desktop/scripts/python-checksums.txt`

**Interfaces:**
- Consumes: Task 2의 `entitlements.python.plist`(트리 서명용), Task 3의 `uv.lock`
- Produces: `desktop/.cache/python/rt-<키>/` — 인터프리터 + 의존성 + 재배치 + 서명.
  Task 6이 복사해 worker 패키지를 얹는다.
- 스크립트가 정의하는 함수 **일곱**: `relocate(tree)`, `fix_macho(tree)`, `sign_tree(tree)`,
  `verify_signatures(tree)`, `macho_list(tree)`, `resign(file)`, `purge_pycache(tree)`.
- 스크립트가 받는 플래그: `--print-key` (캐시 키만 찍고 적중 여부를 말한 뒤 종료. Step 7이 쓴다).
- **셔뱅 형태** — `build-python.sh`가 쓰고 `check-bundle.mjs`가 읽는 계약이라 여기 한 곳에만
  적는다 (규칙 2). 스펙 §6.1-b 1번:

```sh
#!/bin/sh
'''exec' "${0%/*}/python3.12" "$0" "$@"
' '''
```

  순진한 `exec "${0%/*}/python3.12" "$0" "$@"`는 **python이 그 줄을 파싱해
  `SyntaxError: Missing parentheses in call to 'exec'`로 죽는다**
  (**[실행됨: 2026-09-16]**). 위 형태는 셸이 2행을 `exec`로 읽고 python은 2·3행을 문자열
  리터럴로 읽어 무시한다. PBS 원본이 같은 폴리글랏에 `dirname`·`realpath`를 쓰는 것을
  `${0%/*}`로 바꾼 것이다.

- [ ] **Step 1: Phase 0 원본을 읽는다 — 이것이 이 Task의 절반이다**

```bash
cat docs/superpowers/reference/electron-phase-0/README.md
sed -n '265,340p' docs/superpowers/reference/electron-phase-0/python-build.sh   # 셔뱅·sysconfigdata
sed -n '342,370p' docs/superpowers/reference/electron-phase-0/python-build.sh   # direct_url·pycache
sed -n '370,437p' docs/superpowers/reference/electron-phase-0/python-build.sh   # LC_RPATH·LC_ID_DYLIB
sed -n '133,205p' docs/superpowers/reference/electron-phase-0/python-build.sh   # prune
```

**원본에서 그대로 가져올 것 여섯:**

| # | 원본 | 핵심 |
| --- | --- | --- |
| 1 | `:370-399` `LC_RPATH` | 필터는 `@*`·번들 안·`/usr/lib`·`/System` **제외 전부**. `BUILD_PREFIX`가 아니다 — Python은 아카이브 전개라 그 문자열이 트리에 없다. 실측 58건은 wheel 배포자 경로(scipy의 `/opt/homebrew` gcc 등) |
| 2 | `:401-435` `LC_ID_DYLIB` | **`libpython3.12.dylib`만 `@executable_path/../lib/…`**, 나머지 `@rpath/<base>`. `bin/python3.12`가 그렇게 참조한다 |
| 3 | `:301-338` `_sysconfigdata` | 파일을 regex로 긁지 말고 **런타임에게 묻는다.** 따옴표 표기가 배포본마다 달라 Phase 0에서 regex가 조용히 빈 값을 냈다. **목표값이 다르다** — 원본은 `$root`(절대 경로)로 재작성하지만 Phase 4는 `/damwha-bundled-python`(자리표시자)이다. 그리고 tarball 전개 경로에서는 uv가 prefix에 손대지 않아 PBS 원본값 `/install`이 남는다(실측) — 스펙 §6.1-b 2번의 근거는 Phase 0의 `uv python install` 경로에서만 성립한다 |
| 4 | `:342-356` `direct_url.json` | 삭제. 텍스트 파일이라 `check-bundle.mjs`의 **기존 4번 검사**가 실제로 잡는 몇 안 되는 경우다 — 같은 검사가 `.pyc`·`.so`는 못 잡는다(`-a` 없음, Task 7이 고친다) |
| 5 | 전체 | `install_name_tool` 뒤 **파일별 즉시 재서명**(`resign`) |
| 6 | `:133-205` prune | `bin/pip*`·`2to3*`·`idle3*`·`pydoc3*`·`python*-config`, `ensurepip`, `tkinter`/`tcl`/`tk` 제거. 없으면 PBS 원본 스크립트가 남아 제한 PATH에서 `realpath: command not found`를 내고 그것이 우리 셔뱅 결함으로 오독된다 |

**의도적으로 다르게 가는 것 하나 — 셔뱅.** 원본은 절대 경로 재작성을 쓰고 `#!/bin/sh` 트릭을
**기각했다**(`:274-277`: "SIP가 `/bin/sh` exec에서 `DYLD_*`를 지워 dyld 실측이 끊긴다").
Phase 4는 dyld 실측을 하지 않고, 반대로 **한 산출물이 두 자리에 놓이는** 제약을 받는다 — 근거는
스펙 §6.1-b·§17.3. 위치 독립 형태(`${0%/*}`, 외부 명령 없음)를 쓴다.

- [ ] **Step 2: 체크섬 파일을 만든다**

**업스트림 `SHA256SUMS`와 대조한다.** pg·ffmpeg와 달리 PBS는 릴리스에 체크섬을 배포하므로
자기 다운로드를 해시해 적는 것보다 강한 근거가 있다.

```bash
BASE=https://github.com/astral-sh/python-build-standalone/releases/download/20250818
ASSET=cpython-3.12.11+20250818-aarch64-apple-darwin-install_only.tar.gz
curl -fsSL -o /tmp/$ASSET "$BASE/$ASSET"
curl -fsSL -o /tmp/SHA256SUMS "$BASE/SHA256SUMS"
MINE=$(shasum -a 256 /tmp/$ASSET | awk '{print $1}')
THEIRS=$(/usr/bin/grep -F " $ASSET" /tmp/SHA256SUMS | awk '{print $1}')
[ -n "$THEIRS" ] && [ "$MINE" = "$THEIRS" ] || { echo "업스트림 체크섬과 다르다"; exit 1; }
printf '%s  %s\n' "$MINE" "$ASSET" > desktop/scripts/python-checksums.txt
```

**[실행됨: 2026-09-16 — `fabb5fd4…e478` 업스트림과 일치]**

- [ ] **Step 3: 스크립트의 뼈대와 런타임 층을 쓴다**

**캐시를 두 층으로 나눈다.** 런타임(인터프리터+의존성+재배치+서명)은 거의 안 변하고 worker
패키지는 매 커밋 변한다. 하나로 묶으면 worker를 고쳐도 캐시가 적중해 **옛 코드가 `.app`에
실린다** — Phase 2가 `24f9080`에서 정확히 그 결함을 겪었다.

| 층 | 캐시 키 | 내용 |
| --- | --- | --- |
| `rt-*` | Python 버전·릴리스 + `checksums.txt` + `pyproject.toml`·`uv.lock` + **`entitlements.python.plist`** + 스크립트 shasum | 인터프리터 + 의존성 + prune + 재배치 + Mach-O + 서명 |
| `wk-*` | 위 키 + `damwha_worker/` **트리 해시(경로 포함, `__pycache__`·`.DS_Store` 제외)** | `damwha_worker` 설치 (Task 6) |

**`BUILD_PREFIX`가 없다.** `build-postgres.sh`·`build-ffmpeg.sh`와 다른 점이다 — 그 둘은
`./configure --prefix`로 소스에서 빌드하지만 Python은 아카이브를 풀 뿐이라 우리가 정한 prefix가
트리 어디에도 없다.

`wk-*` 키의 트리 해시는 **경로를 버리지 않는다**(`awk '{print $1}'` 금지) — 내용이 같은 두
파일의 rename이 같은 키가 되어 모듈을 옮긴 변경이 캐시에 안 잡힌다. `.py`만 보지도 않는다 —
패키지 안의 자원 파일도 동작을 바꾼다.

의존성 설치는 `uv export --extra models --no-dev --locked --no-emit-project`로 뽑은 목록을 쓴다:
- `--no-dev` — 기본은 dev 그룹 포함이라 pytest·ruff·testcontainers가 1.5 GB 번들에 실린다.
- `--locked` — 불일치면 실패한다. 없으면 빌드가 자기 캐시 키 입력(`uv.lock`)을 다시 쓴다.
- `--no-emit-project` — **없으면 목록 3행에 `-e .`가 나온다**
  (**[실행됨: 2026-09-16]**). 그대로 `uv pip install -r`에 넣으면 cwd를 editable로 깔아
  `.pth`에 저장소 절대 경로가 박히거나(§6.7 위반), cwd에 `pyproject.toml`이 없어 실패한다.
- `--link-mode=copy` — Phase 0 원본 `python-build.sh:31-34,127`이 그렇게 한다. 이 맥의 실측으로는
  uv 기본(clone)에서도 공유 inode가 생기지 않고 `codesign`·`install_name_tool`이 새 inode를
  만들어 무해했지만, **원본과 다르게 갈 근거가 없으므로 원본을 따른다.**

- [ ] **Step 4: 돌린다 (수십 분)**

```bash
time bash desktop/scripts/build-python.sh
```

기대 출력 순서: `uv export` → 설치 → prune → 셔뱅 n개 → sysconfig prefix → direct_url →
`LC_RPATH` **>0건** → `LC_ID_DYLIB` → 서명 → `arm64 서명 전수 확인`.

**`LC_RPATH` 0건이면 `die`한다.** Phase 0 실측이 58건이고, 0건은 필터가 틀렸다는 뜻이다.

- [ ] **Step 5: 재배치가 실제로 되는지 확인한다 (R-6 회귀 방지)**

```bash
# 디렉터리만, 그리고 중단된 실행이 남긴 rt-*.hidden·rt-*.tmp를 뺀다.
RT=$(/usr/bin/find desktop/.cache/python -maxdepth 1 -type d -name 'rt-*' \
       ! -name '*.hidden' ! -name '*.tmp' | head -1)
[ -n "$RT" ] || { echo "rt 층이 없다 — Step 4를 먼저"; exit 1; }
cp -R "$RT" /tmp/py-moved
/tmp/py-moved/bin/python3.12 -c "import sys; print(sys.executable, sys.prefix)"
```

기대: **옮긴 경로**를 보고한다.

```bash
mv "$RT" "${RT}.hidden"
/tmp/py-moved/bin/python3.12 -c "import sys, torch; print('OK', sys.prefix)"
mv "${RT}.hidden" "$RT"
```

기대: 원래 경로가 **사라져도** 돈다. **이것이 R-6의 진짜 검사다** — 옛 경로가 남아 있으면 깨진
트리도 조용히 돈다.

- [ ] **Step 5-b: 셔뱅 래퍼를 제한 PATH·공백 경로에서 실행한다**

인터프리터 직접 실행만으로는 셔뱅을 검증하지 못한다. 앱이 자식에게 주는 PATH에는 `/usr/bin`이
없다(스펙 §6.2).

**우리가 재작성한 스크립트만 고른다** — prune 뒤에도 PBS 원본이 남아 있으면 그것이 자기
`realpath` 의존으로 실패하고 우리 결함으로 오독된다.

**`grep -lF`에 홑따옴표다.** 진짜 BSD grep은 겹따옴표 형태도 매치하지만
(**[실행됨: `/usr/bin/grep -l "\${0%/\*}"` → rc=0]**), `-lF`+홑따옴표는 grep 구현과 무관하게
문자열 그대로를 찾으므로 더 견고하다. 5회차가 "겹따옴표는 항상 실패한다"고 본 것은 셸
함수(ugrep)를 잰 결과였다 — 스펙 §17.8.

```bash
BIN=$(grep -lF '${0%/*}' /tmp/py-moved/bin/* 2>/dev/null | head -1)
[ -n "$BIN" ] || { echo "재작성된 스크립트가 없다 — 셔뱅 절을 확인하라"; exit 1; }
env -i PATH="/tmp/py-moved/bin" HOME=/tmp "$BIN" --version 2>&1 | head -3

mkdir -p "/tmp/py spaced" && ditto /tmp/py-moved "/tmp/py spaced/python"
env -i PATH="/tmp/py spaced/python/bin" HOME=/tmp "/tmp/py spaced/python/bin/$(basename "$BIN")" --version 2>&1 | head -3
rm -rf "/tmp/py spaced" /tmp/py-moved
```

`dirname: command not found`나 `/python3.12: not found`가 나오면 셔뱅이 외부 명령에 의존한다.

- [ ] **Step 6: 절대 경로가 안 굽혔는지 확인한다 (B-1 회귀 방지)**

```bash
**캐시 층 안에서 python을 돌리지 않는다.** `$RT`에서 부르면 rt 층에 `.pyc`가 새로 생겨
검증이 검증 대상을 오염시키고, 이 Step을 다시 돌리면 그 `.pyc`를 grep이 잡는다. Step 5가
만든 사본 `/tmp/py-moved`에게 묻는다.

```bash
REPO=$(pwd)
# -a는 출력 형태만 바꾼다 — BSD grep은 없어도 바이너리를 잡는다(실측 456/456). 의도를
# 드러내고 GNU grep에서도 안전하므로 붙인다. 셸 함수가 아닌 진짜 grep을 부른다.
/usr/bin/grep -ralF "$REPO" "$RT" | head -20   # 0건이어야 한다
/tmp/py-moved/bin/python3.12 -c "import sysconfig; print(sysconfig.get_config_var('prefix'))"
```

기대: grep 0건. prefix가 `/damwha-bundled-python`(스펙 §6.1-b의 중립 자리표시자).

- [ ] **Step 7: 캐시 키가 변화를 잡는지 확인한다**

**`| head -3`을 쓰지 않는다.** 미스면 수십 분 빌드가 시작되고 4번째 줄에서 SIGPIPE로 죽어
`work-*`가 반쯤 남는다. 스크립트에 **`--print-key` 모드**(키를 찍고 적중 여부만 말하고 종료)를
두고 그것을 부른다.

```bash
touch be/worker/uv.lock
bash desktop/scripts/build-python.sh --print-key   # 적중 (내용 해시라 mtime 무관)
printf '\n# cache-key probe\n' >> be/worker/pyproject.toml
bash desktop/scripts/build-python.sh --print-key   # 미스
git checkout be/worker/pyproject.toml
```

**Verify:** Step 4~7 전부 통과.

**Review:**
- **원본 여섯이 전부 들어갔는가** (Step 1의 표).
- `LC_RPATH` 필터가 `BUILD_PREFIX`가 아닌가. 0건이면 `die`하는가.
- `libpython`만 `@executable_path`인가.
- `_sysconfigdata`를 **런타임에게 묻는가.**
- prune이 있는가 — 없으면 Step 5-b가 PBS 스크립트에 걸린다.
- `uv export`에 `--no-dev --locked --no-emit-project`가 있는가 — 마지막 것이 없으면 `-e .`가 나온다.
- `--link-mode=copy`인가 (Phase 0 원본과 같게).
- Step 5-b의 grep이 **`-lF` + 홑따옴표**인가.
- Step 6의 grep에 **`-a`**가 있는가.
- Step 7이 `| head -3` 대신 `--print-key`를 쓰는가.
- 캐시 키에 경로가 남는가.
- Step 6의 grep이 0건인가.

- [ ] **Step 8: 커밋** — `feat(desktop): 내장 Python 런타임 빌드 스크립트를 더한다 (런타임 층)`

---

## Task 6: `build-python.sh` — worker 층 + 스테이징

**Files:** Modify `desktop/scripts/build-python.sh`

**Interfaces:**
- Consumes: Task 5의 `$RT_OUT`·`$WK_KEY`와 **일곱 함수**(Task 5 Interfaces)
- Produces: `desktop/build/python/` — `bin/python3.12` + `lib/python3.12/site-packages/damwha_worker/`

- [ ] **Step 1: worker 층을 이어 쓴다**

런타임 층을 `ditto`로 복사해 `uv pip install --no-deps <repo>/be/worker`만 얹는다.
`--no-deps`인 이유: 런타임 층이 이미 전부 깔았고 여기서 해석이 다시 돌면 고정이 흔들린다.

설치가 만든 것만 다시 손본다 — **`relocate`와 `sign_tree`를 다시 부른다.** `damwha_worker`는
순수 Python이라 새 Mach-O가 없어 `sign_tree` 전수 호출의 결과는 "그 파일만 재서명"(스펙 §6.1)과
같다. 전수를 부르는 편이 단순하고 멱등이다. `damwha_worker`는
순수 Python이지만 콘솔 스크립트 둘(`damwha-worker`·`damwha-embed`)이 `bin/`에 새로 생기고 그
셔뱅에 uv가 본 절대 경로가 박히며, `direct_url.json`도 이때 생긴다(실측:
`{"url":"file:///Users/…/be/worker"}`).

- [ ] **Step 2: 진입점을 확인한다 — `import`하지 않는다**

```bash
"$WK_OUT/bin/python3.12" -c "
import importlib.util as u, sys
missing = [m for m in ('damwha_worker', 'damwha_worker.__main__', 'damwha_worker.embed_service',
                       'mlx_lm.server')
           if u.find_spec(m) is None]
if missing: print('  없는 모듈:', ', '.join(missing)); sys.exit(1)
print('  모듈 확인 OK')
"
```

**`find_spec`은 대상 모듈을 실행하지 않는다.** `import`는 부작용이 있는 모듈에서 위험하다 —
`embed_service`는 Part 2가 고치기 전까지 모듈 수준에서 `load_settings()`와
`build_text_embedder()`를 부르므로(`embed_service.py:10-11`), import하면 빌드 머신이
`DATABASE_URL`을 요구하고 bge-m3 2.2 GB를 받는다.

**단, 점 표기의 `find_spec`은 부모 패키지를 import한다**
(**[실행됨: 2026-09-16 — `pkg/__init__.py`의 print가 찍히고 `pkg in sys.modules: True`]**).
`damwha_worker.*`가 안전한 이유는 `damwha_worker/__init__.py`가 **0바이트**이기 때문이지
`find_spec`이 아무것도 실행하지 않아서가 아니다. `mlx_lm.server`는 `mlx_lm/__init__.py`를
실행하고 그것은 실제 import를 담는다(`from ._version import …`, 환경 변수 설정 등) — 다운로드는
없지만 무부작용은 아니다. 그래서 이 확인은 **`damwha_worker/__init__.py`가 비어 있음을 함께
assert한다.** 새 모듈을 목록에 더할 때 그 패키지의 `__init__.py`를 먼저 본다.

`damwha_worker.llm_entry`는 Part 2가 만든다 — 그때 이 목록에 더한다.

`huggingface_hub`의 `tqdm_class` 시그니처도 여기서 assert한다. 라이브러리가 그 인자를 없애면
**`.app`이 아니라 빌드가 깨져야 한다.**

- [ ] **Step 3: `__pycache__`를 지우고 스테이징한다**

**순서가 계약이다** (스펙 §6.1-b 4번). Step 2의 `find_spec`도 `importlib` 자체의 `.pyc`를 만들
수 있으므로 **모든 python 실행 뒤에** 지운다. 스테이징 뒤로는 python을 실행하지 않는다 —
`"$STAGED/bin/python3.12" --version`도 부르지 않는다.

**빌드 안만 지우면 부족하다 — 산출물이 dev 실행 위치이기도 하다.** `desktop/build/python`은
`pnpm desktop:dev`가 실제로 실행하는 트리다. 한 번 돌면 그 자리에 `co_filename`이
`<저장소>/desktop/build/python/…`인 `.pyc`가 쌓이고, 다음 패키징이 캐시 적중으로 스테이징을
건너뛰면 그 트리가 그대로 `.app`에 실린다
(**[실행됨: 2026-09-16 — 트리의 python을 돌린 것만으로 `.pyc` 448개가 **전부** 트리 절대
경로를 담았다]**). §6.1-b가 "최종 위치가 둘"을 규칙으로 세운 것과 같은 형태의 누락이다.

그래서 둘을 한다:

1. **스테이징은 캐시 적중 여부와 무관하게** `$STAGED`의 `__pycache__`를 지운다
   (`build-postgres.sh`의 `.build-key` 관례는 "적중이면 아무것도 안 한다"인데, 여기서는
   적중일수록 오염된 트리가 남는다).
   **`stage()`의 실행 중 프로세스 가드는 그대로 물려받는다** — `build-postgres.sh:200-202`가
   `pgrep -f "$STAGED/bin/postgres"`로 dev 앱이 쓰는 트리를 갈아엎지 못하게 한다. 여기서는
   `pgrep -f "$STAGED/bin/python3.12"`다. python은 모듈을 지연 로드하므로 실행 중
   `rm -rf`(미스)나 `__pycache__` 삭제(적중)가 살아 있는 프로세스를 깨뜨린다.
2. 앱이 번들 python을 부를 때 **`PYTHONPYCACHEPREFIX=<userData>/pycache`**를 준다 —
   **Part 2 Task 4 Step 5**가 받는다(스펙 §6.3). packaged `.app` 안에 런타임 `.pyc`가 쌓여
   **서명 봉인 밖 파일**이 생기는 것도 함께 막는다. `PYTHONDONTWRITEBYTECODE`가 아닌 이유는
   import가 4.5배 느려지기 때문이다(스펙 §6.1-b 실측).

**`check-bundle.mjs`가 이것을 잡기는 한다** — `spawnSync`가 진짜 BSD grep을 받고 그것은
바이너리를 건너뛰지 않는다(6회차 정정). 그래서 오염된 트리는 조용히 실리지 않고 **빌드를
깨뜨린다.** 그편이 낫지만 여전히 결함이다 — dev를 한 번 돌리면 그 뒤 모든 패키징이 실패하고,
실패 메시지가 원인을 가리키지 않는다.

- [ ] **Step 4: 돌린다**

```bash
bash desktop/scripts/build-python.sh
```

기대: `런타임 층 캐시 적중` → `worker 층 빌드` → `모듈 확인 OK` → `__pycache__ n개 삭제` →
`스테이징`.

- [ ] **Step 5: worker 소스를 고치면 캐시가 미스하는지 본다**

```bash
printf '\n# cache-key probe\n' >> be/worker/damwha_worker/__main__.py
bash desktop/scripts/build-python.sh 2>&1 | grep -E '층|모듈 확인'
git checkout be/worker/damwha_worker/__main__.py
bash desktop/scripts/build-python.sh 2>&1 | grep -E '층'
```

기대: 첫 실행이 `런타임 층 캐시 적중` + **`worker 층 빌드`**. 되돌린 뒤 둘 다 적중.

- [ ] **Step 6: 설치된 코드가 저장소와 같고, 절대 경로가 없고, `__pycache__`가 0개인지 본다**

**검사를 둘로 가른다.** 한 `diff`에 얹으면 둘 다 못 쓴다 — 개발 머신의 **소스** 트리에는
worker를 한 번이라도 돌린 흔적으로 `__pycache__`와 `.DS_Store`가 있고 wheel에는 없으므로
`diff -r`이 **항상** `Only in be/worker/damwha_worker: …`를 낸다
(**[실행됨: 2026-09-16 — `__pycache__` 6개 + `.DS_Store` 1개]**). 코드 동일성은 그 잡음을 뺀
`diff`가 보고, **빌드 트리의 `__pycache__` 0개는 바로 아래 `find`가 따로 판정한다.**

```bash
# 코드 동일성 — 소스 쪽 잡음만 제외한다. 빌드 트리의 __pycache__는 아래 find가 본다.
diff -r -x __pycache__ -x .DS_Store \
  be/worker/damwha_worker desktop/build/python/lib/python3.12/site-packages/damwha_worker
# 진짜 grep을 부른다 — 이 셸의 grep은 ugrep 함수다. -a는 출력 형태만 바꾼다.
/usr/bin/grep -ralF "$(pwd)" desktop/build/python | head    # 0건
find desktop/build/python -name __pycache__ | head          # 0건 — 이쪽이 진짜 판정이다
du -sh desktop/build/python desktop/build/ffmpeg
```

기대: 차이 없음, grep 0건, `__pycache__` 0건, python 약 1.5 GB / ffmpeg 약 42 MB.

**Verify:** Step 4~6 전부 통과.

**Review:**
- `--no-deps`가 있는가.
- worker 층이 `relocate`를 **다시** 부르는가 (새 콘솔 스크립트·`direct_url.json`).
- 진입점 확인이 `find_spec`인가 (`import`가 아니라).
- `__pycache__` 삭제가 **모든 python 실행 뒤**인가.
- Step 6이 `diff`(코드 동일성)와 `find`(빌드 트리 `__pycache__` 0개)를 **따로** 하는가.
- `grep`에 `-a`가 있는가 — 없으면 `.pyc`·`.so`의 경로를 못 잡는다.
- 스테이징이 **캐시 적중일 때도** `__pycache__`를 지우는가.
- 진입점 확인이 `damwha_worker/__init__.py`가 비어 있음을 assert하는가.
- `ditto`를 쓰는가.

- [ ] **Step 7: 커밋** — `feat(desktop): Python 빌드에 worker 층과 진입점 확인을 더한다`

---

## Task 7: 패키징·서명·번들 위생

**Files:** Modify `desktop/scripts/package.mjs`, `desktop/scripts/check-bundle.mjs`, `desktop/package.json`

**Interfaces:**
- Consumes: Task 4·5·6의 두 빌드 스크립트, Task 2의 plist 둘
- Produces: `Resources/python`·`Resources/ffmpeg`를 가진 서명된 `.app`. Part 2가 그 경로를 읽는다.

- [ ] **Step 1: `package.mjs`가 두 스크립트를 부르게 한다**

`build-postgres.sh` 호출 **바로 아래**에 `build-python.sh`·`build-ffmpeg.sh`. 여기서 멈추는
이유도 같다 — Python이 빠진 `.app`은 첫 실행에서야 드러난다.

- [ ] **Step 2: 서명에 hardened runtime + entitlements를 준다 — plist 둘을 갈라 쓴다**

지금은 `codesign --force --deep --sign -` 뿐이라 **plist를 만들어도 아무 일도 일어나지 않는다.**
`Resources/python`의 제3자 wheel `.so`는 우리 신원으로 서명되지 않으므로
`disable-library-validation`이 있어야 로드되고, numba의 LLVM이 모듈 로드 시점에 실행 메모리를
잡으므로 `allow-unsigned-executable-memory`가 필요하다.

```
codesign --force --sign - --options runtime \
         --entitlements build-resources/entitlements.python.plist \
         <Resources/python 안의 Mach-O들, Resources/ffmpeg/bin/*>
codesign --force --deep --sign - --options runtime \
         --entitlements build-resources/entitlements.mac.plist <Damwha.app>
```

**`.app`에 `entitlements.python.plist`를 주면 앱이 죽는다** — `--deep`이 Electron Framework와
헬퍼에도 hardened runtime을 걸고, V8이 `allow-jit` 없이 CodeRange 예약에 실패해
`Fatal process out of memory`로 rc=133에 끝난다 (Task 2 Step 6-c 실측). 반대로 Python 트리에는
`allow-jit`을 주지 않는다 — 안 쓰는 권한이다.

**`Resources/ffmpeg/bin/*`도 여기서 서명한다.** `build-python.sh`는 Python 트리만 서명하고
`build-ffmpeg.sh`에는 서명 단계가 없어, 이 줄이 없으면 ffmpeg는 linker ad-hoc 서명만 가진 채
hardened runtime `.app` 안에 들어간다. `Resources/python` 아래 Mach-O는 `build-python.sh`가
이미 같은 plist로 개별 서명했으므로 여기서의 재서명은 멱등이다.

**`codesign` 종료 코드를 반드시 본다.** `package.mjs`의 `run()`은 `execFileSync`라 비0에
throw한다(:12-15) — 그 성질에 기댄다. entitlements plist의 XML 주석에 하이픈 두 개가 연달아
있으면 AMFI가 `Failed to parse entitlements`로 rc=1을 내는데, **그래도 `.app`은 linker-signed
상태로 실행된다.** 실행 성공을 서명 성공으로 읽으면 거짓 통과가 난다.

- [ ] **Step 3: `check-bundle.mjs`에 검사를 더한다**

| 검사 | 왜 |
| --- | --- |
| `Resources/{python,ffmpeg}` 존재, `bin/` 실행 파일 | 빌드 누락 |
| `site-packages/damwha_worker/__main__.py`, `mlx_lm/server.py` 존재 | 트리만 있고 패키지가 없으면 첫 실행에서야 드러난다. `mlx_lm`은 §2.4의 회귀 방지 |
| arm64 무서명 Mach-O 0건 | `codesign --verify --arch arm64` 전수. 심볼릭 링크는 건너뛴다 |
| entitlement 실제 적용 | `codesign -d --entitlements -`가 `.app`에 **세 키**(`allow-jit` 포함), **`Resources/python/bin/python3.12`**에 **두 키**를 보인다. **표본은 실행 파일이어야 한다** — `.so`·`.dylib`은 `--entitlements`로 서명해도 키를 **0개** 보인다(실측). `.so`를 뽑으면 이 검사가 통과 불가다 |
| `Resources/python` 아래 `__pycache__` 0개 | 스펙 §6.1-b 4번 |
| `bin/` 셔뱅이 번들 안을 가리킨다 | **2행**의 `${0%/*}/python3.12`를 본다 — 위치 독립 형태에서 1행은 `#!/bin/sh`다. **우리가 만든 것만** 본다 — 제3자 wheel 원본의 문자열은 지울 수 없고 Phase 6이 받는다 (G1 허용 목록 24건) |

**기존 4번 검사(`check-bundle.mjs:92`)는 이미 바이너리를 잡는다.** `spawnSync("grep", …)`는
셸을 거치지 않아 PATH의 진짜 BSD grep을 받고, 그것은 바이너리를 건너뛰지 않는다
(**[실행됨: `/usr/bin/grep -rlF` 456건 / `-ralF` 456건]**). `-a`를 더하되 이유는 "지금 안
잡혀서"가 아니라 **의도를 드러내고 GNU grep에서도 같게 동작하게** 하기 위해서다.

5회차는 여기서 정반대 결론을 냈고 그것은 이 세션 셸의 `grep`이 ugrep `-I` 함수여서 나온
값이었다. 스펙 §17.7 B-5는 철회됐고 §17.4의 원래 서술이 맞다(§17.8).

그러므로 Task 5·6의 `direct_url.json` 삭제·`_sysconfigdata` 중립화·`__pycache__` 삭제가
**전부** 성립해야 이 Task가 초록불이다 — 이 검사는 처음부터 효력이 있었다.

- [ ] **Step 4: dev 스크립트도 두 빌드를 부르게 한다** — `desktop/package.json`의 `start:desktop`

- [ ] **Step 5: 패키징하고 위생 검사를 돌린다**

```bash
pnpm --filter damwha-desktop run package:desktop
node desktop/scripts/check-bundle.mjs
du -sh desktop/out/mac-arm64/Damwha.app
```

기대: 새 줄이 전부 `PASS`, **기존 검사도 전부 `PASS`**, exit 0.

**Verify:** Step 5 통과.

**Review:**
- 서명이 `--options runtime --entitlements`를 실제로 주는가.
- **plist 둘을 갈라 쓰는가** — `.app`은 `entitlements.mac.plist`, 트리·ffmpeg는 `entitlements.python.plist`.
- `Resources/ffmpeg/bin/*`가 서명 대상에 있는가.
- `--arch arm64`가 있는가.
- 금지 문자열 검사에 **`-a`**가 있는가.
- 셔뱅 검사가 **2행**을 보는가 (1행은 `#!/bin/sh`다).
- `machOFiles`가 심볼릭 링크를 건너뛰는가.
- `package.mjs`가 빌드 실패·**서명 실패** 시 멈추는가 — 서명이 실패해도 앱은 실행된다.

- [ ] **Step 6: 커밋** — `feat(desktop): Python·ffmpeg를 번들에 싣고 hardened runtime으로 서명한다`

---

## 이 계획의 완료 조건

Part 2로 넘어가기 전에 셋이 참이어야 한다:

1. `pnpm --filter damwha-desktop run package:desktop`이 끝까지 돌고
   `node desktop/scripts/check-bundle.mjs`가 exit 0이다.
2. `/usr/bin/grep -ralF <저장소> desktop/out/mac-arm64/Damwha.app/Contents` 가 **0건**이다
   (셸의 `grep`은 ugrep 함수라 바이너리를 건너뛴다 — 거짓 0건이 나온다).
3. Task 2의 numba 판정이 나와 있고, entitlements가 그 결과를 반영한다.

**스펙 완료 기준 중 이 계획이 만드는 것:** P4-C15(번들 위생), P4-C25(mlx 정렬 회귀),
P4-C26·C27의 기준선, P4-C28(numba). 나머지는 Part 2가 만들고 Part 2의 마지막 Task가 30건을
전부 판정한다.

## 자체 검토

**1. 스펙 coverage** — §6.1(번들 계약)·§6.1-b(재배치)·§2.4(mlx-lm)·§6.8(numba)·§5(데이터 안전)가
Task 1~7에 대응한다. §6.2 이후는 Part 2다.

**2. 규칙 1 준수** — 전문을 싣고 Step이 실행하는 것은 **`phase4-baseline.sh`와
`probe-numba.sh` 둘뿐이고, 둘 다 실행됐다**(Task 1·2). `build-python.sh`·`build-ffmpeg.sh`는
**전문을 싣지 않는다** — Task 4·5·6의 코드 블록은 2~10줄짜리 검증 명령이고 스크립트 본문은
"구현 시 작성"이다. 규칙 1은 그 검증 명령들에 적용되며, 5회차에서 셋(셔뱅 grep·`diff -r`·
`head -3`)이 실행으로 깨져 고쳤다.

**그 대신 원본 대조가 규칙 1의 자리를 맡는다.** Task 5 Step 1의 표가 Phase 0
`python-build.sh`의 다섯 지점을 줄 번호로 지목하고, README 규칙("옮긴 것이 원본과 다르면
원본이 맞다")이 구현 시 판정 기준이 된다. 리뷰어가 그 줄 번호 다섯을 원본과 대조해 전부
일치함을 확인했다(5회차).

**3. 규칙 2 준수** — 이 계획의 계약은 `build-python.sh`의 셸 함수 **일곱**, 플래그
`--print-key`, 그리고 **셔뱅 폴리글랏 3줄**이고 전부 Task 5 Interfaces 한 곳에만 적혀 있다.
셔뱅은 `build-python.sh`가 쓰고 `check-bundle.mjs`가 읽는 양쪽 계약이라 특히 그렇다.

**4. 순서** — 1(기준선) → 2(numba, `uv.lock`에 numba가 있으면 3보다 먼저 가능) → 3(매니페스트)
→ 4(ffmpeg) → 5(RT) → 6(WK) → 7(패키징). 각 Task가 자기 Verify를 통과한 상태로 끝난다.
