# Electron Phase 4 — Python·ML 실행 환경 내장 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱이 Python·ML 라이브러리·ffmpeg를 번들로 싣고 worker·embed·LLM 서버를 그것으로 띄워, 개발 도구가 없는 맥에서 전사·화자 분리·요약·검색이 돌게 한다.

**Architecture:** Phase 3의 `build-postgres.sh` → `desktop/build/` → `extraResources` → `Resources/` 경로를 Python·ffmpeg에 그대로 복제한다. 실행 계약은 `uv run`을 버리고 번들 python의 `-m` 모듈 진입 하나로 통일한다. 모델 가중치는 번들에 넣지 않고 `<userData>/models`에 게으르게 받으며, 그 진행·실패를 worker가 `app_setting.model_readiness`에 써서 앱과 FE가 읽는다.

**Tech Stack:** Electron 44 / TypeScript / vitest (desktop), Python 3.12 + pydantic-settings + pytest (worker), python-build-standalone, uv (빌드 전용), ffmpeg LGPL 정적 빌드, PostgreSQL 16 (Phase 3).

**Spec:** [docs/superpowers/specs/2026-09-16-electron-phase-4-embedded-python-runtime-design.md](../specs/2026-09-16-electron-phase-4-embedded-python-runtime-design.md) (개정본 `4180768` 기준 — 스펙 §17.2)

**개정 (2026-09-16):** Codex 계획 검증 1회차의 blocking 10건·important 7건을 반영했다.
스펙을 고쳐야 했던 여섯은 스펙 개정이 받았고(§17.2), 이 계획은 나머지를 받는다.
가장 큰 구조 변화 셋 — **Task 0(기준선)이 신설되어 맨 앞에 온다**, **LLM은 `llm_entry`
진입 모듈로 감싼다(Task 8)**, **Task 11이 옛 런처를 지우지 않고 공존시킨다**(중간 컴파일
실패 제거).

## Global Constraints

이 절의 값은 스펙에서 **문자 그대로** 옮긴 것이다. 모든 Task의 요구사항에 암묵적으로 포함된다.

- **Python 3.12.11** (python-build-standalone). venv를 만들지 않고 배포본 `site-packages`에 직접 설치.
- **ffmpeg LGPL 2.1 정적 빌드** — `--disable-gpl --disable-nonfree --disable-version3`. 공개 정적 빌드(libx264·libx265·libfdk-aac 포함)는 쓰지 않는다.
- **`mlx-lm` 기준값 0.31.3** (2026-09-16 이 맥의 uv tool 실측). `uv.lock`이 단일 진실 원천이다.
- **entitlement 최소 집합** — `com.apple.security.cs.allow-unsigned-executable-memory`, `com.apple.security.cs.disable-library-validation`. `allow-jit`은 Task 1의 측정이 요구할 때만 더한다.
- **서명은 `codesign --verify --arch arm64`로 판정한다.** `--arch` 없이 부르지 않는다 — universal 파일의 x86_64 슬라이스 하나 때문에 파일 전체가 `not signed at all`로 보고된다.
- **모든 Python 진입은 `-m` 모듈이다.** 콘솔 스크립트(`bin/damwha-worker`·`bin/damwha-embed`·`bin/mlx_lm.server`)를 실행하지 않는다 — 셔뱅을 타면 옛 경로가 남아 있을 때 죽지 않고 조용히 다른 런타임을 실행한다.
- **자식 PATH는 `<python>/bin:<ffmpeg>/bin`뿐이다.** 개발 도구 폴백을 주지 않는다.
- **`npm install` 금지** (repo CLAUDE.md). `pnpm`만 쓴다.
- **패키지를 루트에서 실행하지 않는다.** 루트 스크립트가 `--filter`/`--directory`로 cwd를 잡는다.
- **절대 불변** — `be/worker/.env`, `be/.env`, `fe/.env`, `~/.cache/huggingface`, `~/.local/share/uv`, Docker 볼륨 `damwha_pgdata`, `be/storage`, `<userData>/storage/`. 어떤 Task도 이것을 쓰지 않는다.
- **허용 변경** (스펙 §5의 표) — `be/worker/.venv`는 Task 2가 `uv sync`로 새 잠금에 맞추고,
  `~/.local/bin/mlx_lm.server`는 Task 20이 검증 중 일시 이동한다. **둘 다 Task 0이 기준선을
  뜬 뒤에만** 손댄다. 복구 절차는 각 Task에 있다.
- **커밋 메시지는 한국어 본문**으로 쓴다 (저장소 관례). 제목은 `type(scope): 한 줄`.

## 검증 명령 모음

| 무엇 | 명령 |
| --- | --- |
| desktop 단위 테스트 | `pnpm --filter damwha-desktop run test` |
| desktop 타입 검사 | `pnpm --filter damwha-desktop run lint` |
| worker 테스트 | `pnpm worker:test` (= `uv run --directory be/worker pytest`) |
| worker lint | `uv run --directory be/worker ruff check .` |
| 전체 빌드 | `pnpm build` |
| 앱 패키징 | `pnpm --filter damwha-desktop run package:desktop` |
| 번들 위생 | `node desktop/scripts/check-bundle.mjs` |

---

## 파일 구조

### 새로 만드는 파일

| 경로 | 책임 |
| --- | --- |
| `desktop/scripts/build-ffmpeg.sh` | ffmpeg LGPL 정적 빌드 → `desktop/build/ffmpeg/` |
| `desktop/scripts/ffmpeg-checksums.txt` | ffmpeg 소스 아카이브 체크섬 |
| `desktop/scripts/build-python.sh` | Python 트리 빌드(2층 캐시) → `desktop/build/python/` |
| `desktop/scripts/python-checksums.txt` | python-build-standalone 아카이브 체크섬 |
| `desktop/build-resources/entitlements.mac.plist` | hardened runtime entitlement |
| `desktop/src/process/runtime-paths.ts` | `pythonBinaries()`·`ffmpegBinaries()` — `pgBinaries` 모양 |
| `desktop/src/process/python-launcher.ts` | `launchPython()` — `uv-launcher.ts` 대체 |
| `desktop/src/process/orphans.ts` | 4조건 고아 스캔·회수 |
| `desktop/src/config/token-store.ts` | `safeStorage` 기반 HF 토큰 읽기·쓰기 |
| `desktop/src/windows/token-window.ts` | 토큰 온보딩 창 |
| `desktop/shell/token.html` | 그 창의 화면 |
| `desktop/src/services/model-readiness.ts` | `model_readiness` 행 읽기·해석 (순수) |
| `be/worker/damwha_worker/runtime_report.py` | 런타임 자기 보고 (`sys.executable`·`sys.prefix`·`sys.path`) |
| `be/worker/damwha_worker/models/downloads.py` | HF 진행 훅 → `model_readiness` |

### 고치는 파일

| 경로 | 무엇 |
| --- | --- |
| `desktop/scripts/package.mjs` | 두 빌드 스크립트 호출, 서명에 `--options runtime --entitlements` |
| `desktop/scripts/check-bundle.mjs` | Python·ffmpeg 트리·서명·entitlement·문자열 검사 |
| `desktop/src/process/executables.ts` | 자식 PATH에서 개발 도구 폴백 제거 |
| `desktop/src/services/worker-discovery.ts` | `--run-id` 판독, 소유/외부/고아 셋 |
| `desktop/src/services/worker.ts`·`embed.ts` | `.env`·uv 검사 제거, `-m` 진입, 채택 규칙 |
| `desktop/src/services/worker-shutdown.ts` | 부모 선종료 자손 회수 |
| `desktop/src/services/supervisor.ts` | 다운로드 중 유예, 서비스 재시작 경로 |
| `desktop/src/config/config.ts` | `UV_BIN` 제거, `HF_TOKEN` 앱 소유 키, env 위생 |
| `desktop/src/config/repo-root.ts`·`desktop/src/main.ts` | packaged 저장소 게이트 제거 |
| `desktop/src/windows/status-view.ts`·`shell-hints.ts` | 모델 준비·토큰·재시작 |
| `desktop/src/diagnostics/causes.ts` | 새 원인 |
| `be/worker/pyproject.toml`·`uv.lock` | `mlx-lm`·`mlx` 고정 |
| `be/worker/damwha_worker/config.py` | `ffmpeg_bin`·`ffprobe_bin`, `lens_llm_server_bin` 기본값 |
| `be/worker/damwha_worker/pipeline/ffmpeg.py` | 호출 시점 env 읽기 |
| `be/worker/damwha_worker/embed_service.py` | `if __name__ == "__main__"` |
| `be/worker/damwha_worker/__main__.py` | `--run-id` 수용·전파, 자기 보고 |
| `be/worker/damwha_worker/llm_server.py` | `-m mlx_lm.server` 진입 |
| `be/worker/damwha_worker/models/pyannote_diar.py`·`bge_embed.py` | 401/403 보존, 리비전 고정 |
| `be/worker/damwha_worker/errors.py` | 다운로드 실패 분류 |
| `be/worker/damwha_worker/db/core.py` | `model_readiness` 원자적 merge |
| `be/src/system/*` | `model_readiness` 읽기 |
| `fe/src/**` | 모델 준비 표시 |

### 지우는 파일

| 경로 | 왜 |
| --- | --- |
| `desktop/src/process/uv-launcher.ts` | `python-launcher.ts`가 대체 |
| `desktop/tests/process/uv-launcher.test.ts` | 위와 같이 |

---

## Task 0: 기준선 — 무엇이든 건드리기 전에

스펙 §5가 **절대 불변**과 **허용 변경** 두 부류를 나눴다. 기준선을 검증 단계(Task 20)에서
뜨면 그 앞의 변경을 못 잡는다 — Task 2가 이미 `.venv`를 바꾼 뒤다.

**Files:**
- Create: `desktop/scripts/phase4-baseline.sh`

**Interfaces:**
- Consumes: 없음
- Produces: `/tmp/p4-baseline/` — Task 20이 대조하는 기준선. 스크립트는 **찍기와 대조 둘 다**
  한다(`baseline` / `verify` 인자).

- [ ] **Step 1: 스크립트를 쓴다**

`desktop/scripts/phase4-baseline.sh`:

```bash
#!/bin/bash
# desktop/scripts/phase4-baseline.sh
#
# Electron Phase 4의 데이터 안전 기준선 (스펙 §5). 두 부류를 **따로** 찍는다 —
# 절대 불변은 바이트 단위로, 허용 변경은 복구에 필요한 것만.
#
#   bash desktop/scripts/phase4-baseline.sh baseline   기준선을 찍는다 (첫 Task보다 먼저)
#   bash desktop/scripts/phase4-baseline.sh verify     지금 상태와 대조한다

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OUT="${P4_BASELINE_DIR:-/tmp/p4-baseline}"
MODE="${1:?usage: phase4-baseline.sh baseline|verify}"
DEST="$OUT/$([ "$MODE" = baseline ] && echo now || echo later)"

mkdir -p "$DEST"
cd "$REPO"

sums() {  # 경로 하나를 해시 목록으로. 없으면 빈 파일 — "없음"도 상태다.
  local target="$1" out="$2"
  if [ -e "$target" ]; then
    find "$target" -type f -exec shasum -a 256 {} + 2>/dev/null | sort > "$DEST/$out"
  else
    : > "$DEST/$out"
  fi
}

# ── 절대 불변: 바이트 단위 ────────────────────────────────────────────────────
sums be/worker/.env            abs-worker-env.txt
sums be/.env                   abs-be-env.txt
sums fe/.env                   abs-fe-env.txt
sums be/storage                abs-be-storage.txt
# HF 캐시는 수십 GB다. blob 내용까지 해시하면 몇 분 걸린다 — 파일 목록과 크기로 충분하다.
# (우리가 걱정하는 변화는 "새 다운로드가 여기 떨어졌나"이지 비트 손상이 아니다.)
find "$HOME/.cache/huggingface" -type f -exec stat -f '%z %N' {} + 2>/dev/null | sort > "$DEST/abs-hf-cache.txt"
ls -la "$HOME/.local/share/uv/tools" > "$DEST/abs-uv-tools.txt" 2>/dev/null || : > "$DEST/abs-uv-tools.txt"
sums "$HOME/Library/Application Support/Damwha/storage" abs-userdata-legacy-storage.txt
# Docker 볼륨은 메타데이터만으로는 내용 보존을 증명하지 못한다 — 행 수를 직접 센다.
# DB가 꺼져 있으면 빈 파일이고, verify도 같은 조건이면 대조는 성립한다.
docker volume inspect damwha_pgdata > "$DEST/abs-pgdata-meta.json" 2>/dev/null || : > "$DEST/abs-pgdata-meta.json"
psql "postgres://postgres:postgres@localhost:5432/damwha" -tAc \
  "select relname||'='||n_live_tup from pg_stat_user_tables order by relname" \
  > "$DEST/abs-docker-db-rows.txt" 2>/dev/null || : > "$DEST/abs-docker-db-rows.txt"

# ── 허용 변경: 복구에 필요한 것 ───────────────────────────────────────────────
cp be/worker/uv.lock "$DEST/mut-uv.lock" 2>/dev/null || :
uv run --directory be/worker python -c "
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
  "select 'meeting='||count(*) from meeting" > "$DEST/app-db-rows.txt" 2>/dev/null || : > "$DEST/app-db-rows.txt"

echo "== $MODE → $DEST"

if [ "$MODE" = verify ]; then
  echo
  fail=0
  for f in "$OUT/now"/abs-*.txt "$OUT/now"/abs-*.json; do
    [ -e "$f" ] || continue
    n=$(basename "$f")
    if diff -q "$f" "$OUT/later/$n" >/dev/null 2>&1; then
      echo "PASS  $n"
    else
      echo "FAIL  $n"
      diff "$f" "$OUT/later/$n" | head -10
      fail=1
    fi
  done
  echo
  echo "허용 변경(mut-*)과 앱 데이터(app-*)는 자동 판정하지 않는다 — 사람이 대조한다:"
  ls "$OUT/later" | grep -E '^(mut|app)-' | sed 's/^/  /'
  exit $fail
fi
```

```bash
chmod +x desktop/scripts/phase4-baseline.sh
```

**절대 불변은 `diff`로 자동 판정하고 허용 변경·앱 데이터는 하지 않는다.** 뒤 둘은
"바뀌었는가"가 아니라 "**어떻게** 바뀌었는가"를 봐야 하고 그것은 사람의 일이다 — 앱 데이터는
증가만 있어야 하고(P4-C27), `.venv`는 새 잠금과 일치해야 한다(P4-C25).

- [ ] **Step 2: 기준선을 찍는다**

```bash
pnpm db:up          # Docker DB 행 수를 세려면 떠 있어야 한다
bash desktop/scripts/phase4-baseline.sh baseline
ls -la /tmp/p4-baseline/now
```

**출력이 비어 있는 파일이 있으면 그 이유를 적어 둔다** — `verify`가 같은 조건에서 돌아야
대조가 성립한다(DB가 꺼져 있었으면 나중에도 꺼 두거나, 켜고 다시 기준선을 찍는다).

- [ ] **Step 3: 대조가 실제로 도는지 확인한다**

```bash
bash desktop/scripts/phase4-baseline.sh verify    # 아무것도 안 바꿨으니 전부 PASS
echo "probe" >> be/.env && bash desktop/scripts/phase4-baseline.sh verify | grep 'FAIL.*be-env'
git checkout be/.env
```

기대: 첫 실행이 전부 `PASS`, 둘째가 `FAIL  abs-be-env.txt`. **탐지가 되는 것을 확인하지 않은
기준선은 기준선이 아니다.**

**Verify:** Step 2·3 통과. `/tmp/p4-baseline/now`에 파일이 있다.

**Review:**
- 절대 불변 목록이 스펙 §5와 **정확히** 같은가.
- `.venv`·`~/.local/bin`이 절대 불변이 **아닌** 자리(`mut-`)에 있는가.
- Docker DB를 메타데이터가 아니라 **행 수**로 재는가.
- Step 3이 탐지를 실증하는가.

- [ ] **Step 4: 커밋**

```bash
git add desktop/scripts/phase4-baseline.sh
git commit -m "chore(desktop): Phase 4 데이터 안전 기준선 스크립트를 더한다"
```

커밋 본문:

```
스펙 §5가 절대 불변과 허용 변경을 나눴다. 기준선을 검증 단계에서 뜨면
그 앞의 변경을 못 잡는다 — 의존성 정렬이 이미 .venv를 바꾼 뒤다.

절대 불변만 diff로 자동 판정한다. 허용 변경과 앱 데이터는 '바뀌었는가'가
아니라 '어떻게 바뀌었는가'를 봐야 하고 그것은 사람의 일이다.

Docker 볼륨은 메타데이터가 아니라 행 수로 잰다. 볼륨 생성 시각이 같아도
내용은 바뀔 수 있다.
```

---

## Task 1: numba 사망 지점 측정 — 뒤 Task를 가르는 분기

**이 Task의 결과가 계획을 갱신한다.** 측정 전에 Task 6의 entitlement 목록을 확정하지 않는다.

**Files:**
- Create: `desktop/scripts/probe-numba.sh`
- Create: `desktop/scripts/numba-probe/{import_only,define_only,call_it}.py`

**Interfaces:**
- Consumes: 없음 (첫 Task)
- Produces: 결과 문서에 적을 판정 하나 — `{ survives: true } | { dies_at: "import" | "define" | "call", allow_jit_fixes: boolean }`. Task 6이 entitlement 목록을 여기서 받는다.

**선행 조건:** 이 맥에 `uv`와 Xcode CLT. Phase 0 하네스는 필요 없다 — 최소 Python 트리를 새로 만든다.

- [ ] **Step 1: 측정용 최소 Python 트리를 만든다**

`numba`와 `llvmlite`만 있으면 된다. 1.5 GB 전체 트리는 Task 4가 만들고, 이 Task는 그것을 기다리지 않는다.

```bash
mkdir -p /tmp/numba-probe && cd /tmp/numba-probe
curl -fsSL -o py.tar.gz \
  "https://github.com/astral-sh/python-build-standalone/releases/download/20250818/cpython-3.12.11+20250818-aarch64-apple-darwin-install_only.tar.gz"
tar xzf py.tar.gz          # → ./python/
uv pip install --python ./python/bin/python3.12 numba
```

`install_only` 아카이브를 쓰는 이유: 재배치 조작 없이 그 자리에서 돌면 되고, 이 측정은 재배치를 보는 것이 아니라 **JIT이 hardened runtime에서 사는지**를 본다.

- [ ] **Step 2: 세 프로브를 각각 별개 파일로 쓴다**

한 프로세스에서 셋을 다 하면 어디서 죽었는지 구분되지 않는다 — Phase 0의 `probe.sh:391-406`이 정확히 그 실수를 했고, 그래서 이 항목이 미해결로 넘어왔다.

`desktop/scripts/numba-probe/import_only.py`:

```python
import numba
print("IMPORT-OK", numba.__version__)
```

`desktop/scripts/numba-probe/define_only.py`:

```python
import numba

@numba.jit(nopython=True)
def add(a, b):
    return a + b

print("DEFINE-OK")
```

`desktop/scripts/numba-probe/call_it.py`:

```python
import numba

@numba.jit(nopython=True)
def add(a, b):
    return a + b

print("CALL-RESULT", add(1, 2))
print("CALL-OK")
```

`call_it.py`가 `mlx_whisper/timing.py:47,72`의 `@numba.jit(nopython=True)`와 같은 모양이다 — 지연 컴파일이므로 호출에서 처음 LLVM MCJIT을 탄다.

- [ ] **Step 3: 측정 스크립트를 쓴다**

`desktop/scripts/probe-numba.sh`:

```bash
#!/bin/bash
# desktop/scripts/probe-numba.sh
#
# numba의 LLVM MCJIT이 hardened runtime에서 사는지, 죽는다면 import·정의·호출 중
# 어디서 죽는지 가른다 (Electron Phase 4 스펙 §6.8).
#
# 쓰기+실행 매핑 거부는 **메시지 없이 SIGKILL**이고 크래시 리포트도 남지 않는다
# (Phase 0 R-4). 그래서 자식의 종료 신호를 부모가 읽어 판정한다.
#
#   bash desktop/scripts/probe-numba.sh <python트리> <entitlements.plist>

set -uo pipefail   # -e 없음: 자식이 죽는 것이 이 스크립트의 관측 대상이다

PY_TREE="${1:?usage: probe-numba.sh <python-tree> <entitlements.plist>}"
ENTS="${2:?usage: probe-numba.sh <python-tree> <entitlements.plist>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PY="$PY_TREE/bin/python3.12"

[ -x "$PY" ] || { echo "python이 없다: $PY" >&2; exit 2; }

echo "== hardened runtime + entitlements로 서명한다: $ENTS"
# 인터프리터와 모든 .so를 서명한다. 하나라도 빠지면 dlv가 그것을 거부해
# numba와 무관한 이유로 죽고, 그 죽음이 JIT 판정으로 오독된다.
find "$PY_TREE" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 |
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    # 서명 실패를 삼키지 않는다. 서명 안 된 .so는 dlv가 거부해 numba와 무관한 이유로
    # 죽고, 그 죽음이 JIT 판정으로 오독된다 (Phase 0 R-5).
    codesign --force --sign - --options runtime --entitlements "$ENTS" "$f" \
      || { echo "서명 실패: $f" >&2; exit 3; }
  done

run_probe() {
  local name="$1"
  local out rc
  out=$("$PY" "$HERE/numba-probe/$name.py" 2>&1)
  rc=$?
  # 128+9 = 137이 SIGKILL이다. bash는 신호 종료를 이렇게 보고한다.
  if [ "$rc" -eq 137 ]; then
    echo "$name: SIGKILL (rc=137)"
    return 9
  elif [ "$rc" -ne 0 ]; then
    echo "$name: 실패 rc=$rc"
    echo "$out" | tail -5
    return 1
  fi
  echo "$name: OK — $(echo "$out" | tail -1)"
  return 0
}

VERDICT="survives"
for probe in import_only define_only call_it; do
  run_probe "$probe" || { VERDICT="$probe"; break; }
done

echo
echo "== 판정: $VERDICT"
[ "$VERDICT" = "survives" ] && echo "entitlement 최소 집합으로 충분하다." \
  || echo "여기서 죽었다. allow-jit을 더해 다시 재라."
```

```bash
chmod +x desktop/scripts/probe-numba.sh
```

- [ ] **Step 4: 최소 entitlement로 잰다**

`desktop/build-resources/entitlements.mac.plist`를 먼저 만든다 (Task 6이 이 파일을 그대로 쓴다):

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
       "서명 없음"은 허용하지 않으므로, 빌드에서 전수 서명하는 것과 짝이다 (Phase 0 R-5). -->
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

```bash
bash desktop/scripts/probe-numba.sh /tmp/numba-probe/python desktop/build-resources/entitlements.mac.plist
```

기대: 세 줄 모두 `OK`, 판정 `survives`.

- [ ] **Step 5: 죽었으면 `allow-jit`을 더해 다시 잰다**

**사본을 먼저 만들고 키를 더한다.** 순서를 뒤집으면 PlistBuddy가 없는 파일에 쓰려다
실패하고, `|| cp`가 **키 없는 원본**을 남겨 "allow-jit으로도 죽는다"는 거짓 판정이 나온다.

```bash
cp desktop/build-resources/entitlements.mac.plist /tmp/ents-with-jit.plist
/usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.allow-jit bool true" /tmp/ents-with-jit.plist

# 세 키가 다 있는지 확인한 뒤에만 잰다. 확인 없이 재면 무엇을 잰 건지 모른다.
for k in allow-unsigned-executable-memory disable-library-validation allow-jit; do
  /usr/libexec/PlistBuddy -c "Print :com.apple.security.cs.$k" /tmp/ents-with-jit.plist \
    || { echo "키 누락: $k"; exit 1; }
done

bash desktop/scripts/probe-numba.sh /tmp/numba-probe/python /tmp/ents-with-jit.plist
```

- [ ] **Step 6: 판정에 따라 갈라진다**

| 결과 | 조치 |
| --- | --- |
| 최소 집합으로 `survives` | `entitlements.mac.plist`를 그대로 둔다. Task 2로 |
| `allow-jit`을 더해야 `survives` | `entitlements.mac.plist`에 `allow-jit`을 더한다. 그 사실과 측정 출력을 결과 문서에 적는다. Task 2로 |
| `allow-jit`으로도 죽는다 | **여기서 멈춘다.** 스펙 §6.8대로 스펙 리뷰로 돌아간다 — `whisper_mlx.py:107-123`이 `segment["words"]`만 쓰므로 word-timestamp를 끄면 전사가 비고, 대안 정렬 경로 설계는 이 계획의 범위 밖이다. 사용자에게 알리고 지시를 받는다 |

**Verify:**
- `bash desktop/scripts/probe-numba.sh …`가 판정 한 줄을 낸다.
- 세 프로브가 **각각 별개 프로세스**로 돌았다 (스크립트가 `run_probe`를 세 번 부른다).
- 서명이 실제로 붙었다: `codesign -d --entitlements - /tmp/numba-probe/python/bin/python3.12`가 두(또는 세) 키를 보인다.

**Review:**
- 한 프로세스에서 셋을 다 하지 않았는가 (Phase 0의 실수 재발).
- `rc=137`(SIGKILL)과 평범한 예외 종료를 구분하는가.
- 서명 루프가 Mach-O만 대상으로 하는가 (`file -b`로 거른다).
- 판정이 세 갈래 중 하나로 **명확히** 떨어지는가.

- [ ] **Step 7: 커밋**

```bash
git add desktop/scripts/probe-numba.sh desktop/scripts/numba-probe/ desktop/build-resources/entitlements.mac.plist
git commit -m "chore(desktop): numba JIT이 hardened runtime에서 사는지 가르는 프로브를 더한다

Phase 0은 import·정의·호출을 한 프로세스에서 다 해 사망 지점을 구분하지
못한 채 넘겼다. 컴파일에서만 죽는다면 STT는 import가 아니라 word-timestamp
DTW 경로에서만 죽으므로 조치의 크기가 달라진다.

쓰기+실행 매핑 거부는 메시지 없이 SIGKILL이고 크래시 리포트도 안 남아,
부모가 자식의 종료 신호(rc=137)를 읽는 것이 유일한 관측 수단이다."
```

---

## Task 2: `mlx-lm`·`mlx`를 매니페스트에 고정한다

**이것은 정리가 아니라 기능 복구다.** 지금 렌즈·요약은 `~/.local/bin`의 uv tool 전역 설치에 기대고 있다 (스펙 §2.4).

**Files:**
- Modify: `be/worker/pyproject.toml:33-48`
- Modify: `be/worker/uv.lock` (생성물 — `uv lock`이 쓴다)
- Modify: `be/worker/damwha_worker/config.py:47`

**Interfaces:**
- Consumes: 없음
- Produces: `uv.lock`이 `mlx-lm`·`mlx`의 단일 진실 원천이 된다. Task 4의 `build-python.sh`가 `uv export`로 이 파일을 읽는다.

- [ ] **Step 1: 지금 상태를 기록한다 (기준선)**

```bash
cd /Users/gim-yeongjae/project/daewha
uv run --directory be/worker python -c "
import importlib.metadata as m
for p in ('mlx','mlx-whisper','torch','numpy'):
    try: print(p, m.version(p))
    except Exception as e: print(p, 'MISSING')
" | tee /tmp/phase4-versions-before.txt
uv tool list | grep -A1 mlx-lm
```

기대: `mlx 0.31.2`, `mlx-whisper 0.4.3`, uv tool의 `mlx-lm v0.31.3`.

- [ ] **Step 2: `pyproject.toml`의 `models` extra에 두 줄을 더한다**

`be/worker/pyproject.toml`의 `[project.optional-dependencies] models` 블록에서, `mlx-whisper` 줄 **아래**에:

```toml
    # mlx는 mlx-whisper·mlx-lm의 전이 의존이지만 여기서 명시 고정한다. Electron Phase 4가
    # 이 파일을 번들 설치의 단일 진실 원천으로 쓰기 때문이다 — 전이 해석에 맡기면 빌드 때마다
    # 다른 버전이 들어가고, 그것이 STT 출력을 바꿔도 아무 데도 기록이 남지 않는다.
    "mlx==0.31.2 ; sys_platform == 'darwin' and platform_machine == 'arm64'",
    # 렌즈·요약의 LLM 서버. 2026-09-16까지 이 패키지는 pyproject·uv.lock·.venv 어디에도
    # 없었고 `uv tool install mlx-lm`으로 깐 ~/.local/bin/mlx_lm.server에 의존했다
    # (llm_server.py의 옛 오류 문구가 그 증거다). 개발 도구가 없는 맥에서는 그 경로가
    # 없으므로, 번들에 넣지 않으면 렌즈·요약이 통째로 죽는다.
    "mlx-lm==0.31.3 ; sys_platform == 'darwin' and platform_machine == 'arm64'",
```

플랫폼 마커를 다는 이유: `mlx`는 Apple Silicon 전용이라 마커 없이 고정하면 다른 플랫폼에서 해석이 실패한다. 기존 `mlx-whisper` 줄과 같은 마커다.

- [ ] **Step 3: 잠금을 갱신하고 무엇이 바뀌었는지 본다**

```bash
uv lock --directory be/worker
git diff --stat be/worker/uv.lock
git diff be/worker/uv.lock | grep -E '^[+-]version|^[+-]name' | head -40
```

- [ ] **Step 4: 허용 변경 절차를 밟아 venv를 새 잠금으로 맞춘다**

`.venv` 변경은 **스펙 §5의 허용 변경**이다 — 절대 불변이 아니다. 절차가 정해져 있다.

```bash
# 1. Task 0이 기준선을 떴는지 확인한다. 없으면 여기서 멈춘다.
[ -f /tmp/p4-baseline/now/mut-uv.lock ] || { echo "Task 0을 먼저 돌려라"; exit 1; }

# 2. 복구용 사본. Task 0의 것과 별개로 이 Task 직전 상태를 남긴다.
cp be/worker/uv.lock /tmp/p4-uv.lock.before-task2

# 3. 정렬
pnpm worker:sync          # uv sync --extra models
```

**복구:** `cp /tmp/p4-uv.lock.before-task2 be/worker/uv.lock && pnpm worker:sync`.

`.venv`가 허용 변경인 근거는 **재생성 가능한 파생물**이라는 것이다 — `.env`(사람이 적은 값)나
`~/.cache/huggingface`(수십 GB의 다운로드)와 성질이 다르다. 그리고 `mlx-lm`을 매니페스트에
넣으면서 `.venv`를 그 잠금에 안 맞추면 **두 스택이 갈린 채로 남는다**(스펙 §6.1).

- [ ] **Step 5: 버전 변화를 기록하고 회귀를 확인한다**

```bash
uv run --directory be/worker python -c "
import importlib.metadata as m
for p in ('mlx','mlx-lm','mlx-whisper','torch','numpy'):
    try: print(p, m.version(p))
    except Exception: print(p, 'MISSING')
" | tee /tmp/phase4-versions-after.txt
diff /tmp/phase4-versions-before.txt /tmp/phase4-versions-after.txt || true
```

기대: `mlx-lm 0.31.3`이 **새로 나타난다.** `mlx`·`torch`·`numpy`는 그대로여야 한다 — 바뀌었으면 Step 6이 그 영향을 본다.

```bash
pnpm worker:test
uv run --directory be/worker ruff check .
```

- [ ] **Step 6: `mlx`나 `torch`가 바뀌었으면 실오디오 1건으로 확인한다 (P4-C25)**

Step 5의 diff에 `mlx`·`torch`·`numpy` 변화가 있을 때만 한다. 없으면 건너뛴다.

```bash
pnpm db:up
# 터미널 하나: pnpm worker
# 다른 터미널: 기존 회의 하나를 재처리하고 전사 결과를 이전 것과 대조한다.
```

기대: 전사 텍스트가 이전과 같거나, 다르다면 그 차이를 결과 문서에 적는다. 차이가 크면 `mlx` 고정값을 이전 버전으로 되돌린다.

**`lens_llm_server_bin`의 기본값은 이 Task에서 바꾸지 않는다.** 초안은 여기서 `""`로 내리고
"실제 사용은 다음 커밋"이라고 적었는데, 그러면 **이 커밋 시점에 관리형 LLM 서버가 뜨지
않는다**(`shutil.which("")` → `None`). 로드맵 §5는 각 단계가 검증 가능한 상태여야 한다고
못 박는다. 기본값과 그것을 읽는 코드를 **Task 8이 한 번에** 바꾼다.

- [ ] **Step 7: 커밋**

```bash
git add be/worker/pyproject.toml be/worker/uv.lock
git commit -m "fix(worker): mlx-lm과 mlx를 매니페스트에 고정한다

mlx-lm은 pyproject·uv.lock·.venv 어디에도 없었고, 렌즈·요약은
\`uv tool install mlx-lm\`으로 깐 ~/.local/bin/mlx_lm.server에 기대고 있었다.
llm_server.py의 오류 문구가 그 설치를 안내하는 것이 증거다. 개발 도구가 없는
맥에는 그 경로가 없으므로 번들에 넣지 않으면 두 기능이 통째로 죽는다.

mlx는 전이 의존이지만 함께 명시 고정한다 — Electron Phase 4의 번들 빌드가
이 파일을 단일 진실 원천으로 삼으므로, 전이 해석에 맡기면 빌드마다 다른
버전이 들어가고 그것이 STT 출력을 바꿔도 기록이 남지 않는다.

이 커밋은 매니페스트와 잠금만 바꾼다. 진입 방식은 Task 8이 기본값과 함께
한 번에 바꾼다 — 기본값만 먼저 내리면 그 시점에 관리형 LLM 서버가 뜨지
않는 상태가 커밋으로 남는다."
```

---

## Task 3: `build-ffmpeg.sh` — 가장 단순한 번들부터

ffmpeg는 완전 정적이라 `LC_RPATH`가 없고 재배치에서 아무것도 깨지지 않는다 — 세 번들 중 유일하다 (Phase 0). 빌드 스크립트 관례를 여기서 먼저 세운다.

**Files:**
- Create: `desktop/scripts/build-ffmpeg.sh`
- Create: `desktop/scripts/ffmpeg-checksums.txt`
- Modify: `.gitignore` (`desktop/.cache/`·`desktop/build/`가 이미 있으면 그대로)

**Interfaces:**
- Consumes: 없음
- Produces: `desktop/build/ffmpeg/bin/{ffmpeg,ffprobe}`. Task 7의 `ffmpegBinaries()`가 이 배치를 가정한다.

- [ ] **Step 1: 기존 관례를 읽는다**

```bash
sed -n '1,60p' desktop/scripts/build-postgres.sh
```

베낄 것: 셔뱅과 `set -euo pipefail`, 버전 상수, 중립 `BUILD_PREFIX`, 도구 존재 확인 루프, `KEY=$(… shasum …)` 캐시 키(스크립트 자신 포함), `WORK`/`OUT`/`DONE` 3종, `--fresh` 처리, `fetch()`.

- [ ] **Step 2: 체크섬 파일을 만든다**

```bash
cd /Users/gim-yeongjae/project/daewha
mkdir -p /tmp/ff && curl -fsSL -o /tmp/ff/ffmpeg-7.1.1.tar.xz https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
shasum -a 256 /tmp/ff/ffmpeg-7.1.1.tar.xz | awk '{print $1"  ffmpeg-7.1.1.tar.xz"}' > desktop/scripts/ffmpeg-checksums.txt
cat desktop/scripts/ffmpeg-checksums.txt
```

- [ ] **Step 3: 스크립트를 쓴다**

`desktop/scripts/build-ffmpeg.sh`:

```bash
#!/bin/bash
# desktop/scripts/build-ffmpeg.sh
#
# 내장 ffmpeg를 만든다 — LGPL 2.1 정적 빌드. 결과는 desktop/build/ffmpeg/.
# electron-builder의 extraResources(from: build)가 그대로 Resources/ffmpeg/로 싣고,
# dev 앱은 이 자리를 직접 쓴다 (Electron Phase 4 스펙 §6.1).
#
# Electron Phase 0의 experiments/electron-phase-0/ffmpeg/build.sh(태그
# archive/electron-phase-0-packaging-validation)를 옮겼다. 검증 하네스만 걷어냈고
# configure 플래그는 하나도 바꾸지 않았다.
#
#   bash desktop/scripts/build-ffmpeg.sh           캐시가 있으면 스테이징만
#   bash desktop/scripts/build-ffmpeg.sh --fresh   이 키의 캐시를 버리고 다시 빌드

set -euo pipefail

FFMPEG_VERSION=7.1.1
# 이 머신에 없는 중립 prefix. 최종 경로와 일부러 다르게 둬야 "재배치가 되는가"가 빌드 때 드러난다.
BUILD_PREFIX=/opt/damwha-embedded-ffmpeg

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$DESKTOP/scripts/build-ffmpeg.sh"
SUMS="$DESKTOP/scripts/ffmpeg-checksums.txt"
CACHE="$DESKTOP/.cache/ffmpeg"
DL="$CACHE/downloads"
STAGED="$DESKTOP/build/ffmpeg"

die() { echo "build-ffmpeg: $*" >&2; exit 1; }
say() { echo "== $*"; }

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "") ;;
  *) die "usage: build-ffmpeg.sh [--fresh]" ;;
esac

for t in curl tar make cc otool codesign shasum file ditto; do
  command -v "$t" >/dev/null 2>&1 || die "$t 가 없다 — Xcode Command Line Tools가 필요하다"
done

# 캐시 키 = 버전·prefix·체크섬 파일·이 스크립트 자신. 조작을 고치고 옛 산출물을 쓰는 것이
# 가장 조용한 실패라, 스크립트를 한 글자라도 고치면 다시 빌드한다.
KEY=$( { echo "$FFMPEG_VERSION $BUILD_PREFIX"; shasum -a 256 "$SUMS" "$SCRIPT" | awk '{print $1}'; } | shasum -a 256 | cut -c1-16)
WORK="$CACHE/work-$KEY"
OUT="$CACHE/ff-$KEY"
DONE="$CACHE/ff-$KEY.complete"

[ "$FRESH" = 1 ] && rm -rf "$WORK" "$OUT" "$OUT.tmp" "$DONE"
mkdir -p "$DL"

fetch() {
  local url="$1" out="$2"
  [ -f "$DL/$out" ] && return 0
  curl -fsSL -o "$DL/$out.part" "$url" || die "내려받기 실패: $url"
  mv "$DL/$out.part" "$DL/$out"
}

verify() {
  ( cd "$DL" && shasum -a 256 -c "$SUMS" ) || die "체크섬 불일치 — 아카이브를 지우고 다시 받아라: $DL"
}

if [ ! -f "$DONE" ]; then
  say "ffmpeg $FFMPEG_VERSION 소스 빌드 (키 $KEY)"
  fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz"
  verify

  rm -rf "$WORK" "$OUT.tmp"
  mkdir -p "$WORK"
  tar xJf "$DL/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK"

  cd "$WORK/ffmpeg-$FFMPEG_VERSION"
  # LGPL 2.1 구성. --disable-gpl/nonfree/version3이 셋 다 있어야 configure가
  # "License: LGPL version 2.1 or later"를 보고한다. 공개 정적 빌드는 관례적으로
  # libx264·libx265·libfdk-aac를 켜 GPL/nonfree 구성이라 쓰지 않는다 (Phase 0).
  #
  # 우리 파이프라인이 실제로 쓰는 것은 두 가지뿐이다 (pipeline/ffmpeg.py):
  #   ffprobe -show_entries format=duration   (컨테이너 길이)
  #   ffmpeg -ac 1 -ar 16000 -sample_fmt s16 -c:a flac   (16kHz mono s16 FLAC)
  # 디코더는 사용자가 올리는 모든 포맷을 받아야 하므로 끄지 않는다.
  ./configure \
    --prefix="$BUILD_PREFIX" \
    --disable-gpl --disable-nonfree --disable-version3 \
    --disable-shared --enable-static \
    --disable-doc --disable-debug \
    --disable-ffplay \
    --enable-pthreads \
    || die "configure 실패"

  # configure가 스스로 라이선스를 보고한다. 그 줄을 눈으로 확인하는 대신 검사한다 —
  # 플래그를 하나 지우면 GPL 구성이 조용히 나온다.
  grep -q "License: LGPL version 2.1 or later" ffbuild/config.log \
    || die "LGPL 2.1 구성이 아니다 — configure 플래그를 확인하라"

  make -j"$(sysctl -n hw.ncpu)" || die "make 실패"
  make install DESTDIR="$OUT.tmp" || die "make install 실패"

  # DESTDIR 아래 BUILD_PREFIX 경로가 한 겹 더 생긴다. 그것을 걷어내 bin/이 최상위가 되게 한다.
  mkdir -p "$OUT"
  ditto "$OUT.tmp$BUILD_PREFIX/bin" "$OUT/bin"
  rm -rf "$OUT.tmp"

  # arm64는 서명 없는 Mach-O를 실행하지 않는다. 최종 앱 서명은 package.mjs가 다시 하지만,
  # dev 앱은 여기서 나온 트리를 그대로 쓰므로 여기서도 서명한다.
  for b in "$OUT/bin"/*; do
    file -b "$b" | grep -q 'Mach-O' || continue
    codesign --force --sign - "$b" || die "서명 실패: $b"
  done

  # 정적 빌드 확인 — 외부 의존이 libSystem 계열뿐이어야 한다. 하나라도 Homebrew를 가리키면
  # 그 맥에서만 도는 바이너리다.
  for b in "$OUT/bin/ffmpeg" "$OUT/bin/ffprobe"; do
    bad=$(otool -L "$b" | tail -n +2 | awk '{print $1}' | grep -v '^/usr/lib/' | grep -v '^/System/' || true)
    [ -z "$bad" ] || die "외부 동적 의존이 남았다: $b → $bad"
  done

  rm -rf "$WORK"
  touch "$DONE"
fi

say "스테이징: $STAGED"
rm -rf "$STAGED"
mkdir -p "$(dirname "$STAGED")"
ditto "$OUT" "$STAGED"

"$STAGED/bin/ffmpeg" -version | head -1
"$STAGED/bin/ffprobe" -version | head -1
say "완료"
```

```bash
chmod +x desktop/scripts/build-ffmpeg.sh
```

- [ ] **Step 4: 돌린다**

```bash
bash desktop/scripts/build-ffmpeg.sh
```

기대: `License: LGPL version 2.1 or later` 검사 통과, 외부 동적 의존 없음, 마지막에 두 버전 줄.

- [ ] **Step 5: 캐시가 실제로 먹는지 확인한다**

```bash
time bash desktop/scripts/build-ffmpeg.sh    # 두 번째 — 스테이징만이라 몇 초
```

- [ ] **Step 6: 실제로 우리 파이프라인 명령이 도는지 확인한다**

```bash
SRC=$(ls be/storage/**/*.wav be/storage/**/*.m4a 2>/dev/null | head -1)
[ -n "$SRC" ] || SRC=/System/Library/Sounds/Glass.aiff
desktop/build/ffmpeg/bin/ffprobe -v error -show_entries format=duration -of json "$SRC"
desktop/build/ffmpeg/bin/ffmpeg -y -i "$SRC" -ac 1 -ar 16000 -sample_fmt s16 -c:a flac \
  -compression_level 5 -f flac /tmp/ff-probe-out.flac
desktop/build/ffmpeg/bin/ffprobe -v error -show_entries stream=sample_rate,channels,sample_fmt \
  -of json /tmp/ff-probe-out.flac
```

기대: 16000 / 1채널 / s16. **`be/storage`는 읽기만 한다** — 출력은 `/tmp`로 간다.

**Verify:** Step 4·5·6이 전부 통과. `git status`에 `desktop/build/`·`desktop/.cache/`가 안 뜬다 (gitignore).

**Review:**
- `BUILD_PREFIX`가 이 머신에 없는 경로인가.
- 캐시 키에 스크립트 자신의 shasum이 들어갔는가.
- LGPL 검사가 `config.log`를 실제로 보는가 (주석이 아니라 코드로).
- `otool -L` 검사가 `/usr/lib`·`/System` 밖을 전부 잡는가.
- `be/storage`에 쓰지 않는가.

- [ ] **Step 7: 커밋**

```bash
git add desktop/scripts/build-ffmpeg.sh desktop/scripts/ffmpeg-checksums.txt
git commit -m "feat(desktop): 내장 ffmpeg 빌드 스크립트를 더한다

LGPL 2.1 정적 소스 빌드. 공개 정적 빌드는 관례적으로 libx264·libx265·
libfdk-aac를 켜 GPL/nonfree 구성이라 쓰지 않는다.

configure가 스스로 보고하는 라이선스 줄을 config.log에서 검사한다 —
플래그를 하나 지우면 GPL 구성이 조용히 나오기 때문이다. otool -L로
외부 동적 의존이 남지 않았는지도 빌드 때 확인한다.

build-postgres.sh의 관례를 그대로 따른다: 이 머신에 없는 중립 prefix,
스크립트 자신의 shasum을 포함한 캐시 키, desktop/build 아래 스테이징."
```

---

## Task 4: `build-python.sh` — 런타임 층 (캐시 1층)

**Files:**
- Create: `desktop/scripts/build-python.sh` (런타임 층까지. worker 층은 Task 5)
- Create: `desktop/scripts/python-checksums.txt`

**Interfaces:**
- Consumes: Task 2의 `be/worker/uv.lock`
- Produces: `desktop/.cache/python/rt-<키>/` — 인터프리터 + 의존성 + 재배치 + 서명. Task 5가 이것을 복사해 worker 패키지를 얹는다.

- [ ] **Step 1: 체크섬 파일을 만든다**

```bash
cd /Users/gim-yeongjae/project/daewha
ASSET=cpython-3.12.11+20250818-aarch64-apple-darwin-install_only.tar.gz
curl -fsSL -o /tmp/$ASSET \
  "https://github.com/astral-sh/python-build-standalone/releases/download/20250818/$ASSET"
shasum -a 256 /tmp/$ASSET | awk -v a="$ASSET" '{print $1"  "a}' > desktop/scripts/python-checksums.txt
cat desktop/scripts/python-checksums.txt
```

- [ ] **Step 2: 스크립트의 뼈대와 런타임 층을 쓴다**

`desktop/scripts/build-python.sh`:

```bash
#!/bin/bash
# desktop/scripts/build-python.sh
#
# 내장 Python 트리를 만든다 — python-build-standalone 3.12.11 + be/worker의 고정 의존성
# + damwha_worker 패키지. 결과는 desktop/build/python/. electron-builder의
# extraResources(from: build)가 그대로 Resources/python/로 싣는다 (Electron Phase 4 스펙 §6.1).
#
# **캐시가 두 층이다.** 런타임(인터프리터 + 의존성 + 재배치 + 서명)은 거의 안 변하고
# worker 패키지는 매 커밋 변한다. 하나로 묶으면 worker를 고쳐도 캐시가 적중해 옛 코드가
# .app에 실린다 — Phase 2가 정확히 그 결함을 겪었다(24f9080).
#
#   bash desktop/scripts/build-python.sh           캐시가 있으면 그 층만 다시
#   bash desktop/scripts/build-python.sh --fresh   두 층 캐시를 버리고 다시 빌드

set -euo pipefail

PY_RELEASE=20250818
PY_VERSION=3.12.11
PY_ASSET="cpython-$PY_VERSION+$PY_RELEASE-aarch64-apple-darwin-install_only.tar.gz"
# 이 머신에 없는 중립 경로. 재배치가 되는지 빌드 때 드러나게 한다.
BUILD_PREFIX=/opt/damwha-embedded-py312

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$DESKTOP/.." && pwd -P)"
WORKER="$REPO/be/worker"
SCRIPT="$DESKTOP/scripts/build-python.sh"
SUMS="$DESKTOP/scripts/python-checksums.txt"
ENTS="$DESKTOP/build-resources/entitlements.mac.plist"
CACHE="$DESKTOP/.cache/python"
DL="$CACHE/downloads"
STAGED="$DESKTOP/build/python"

die() { echo "build-python: $*" >&2; exit 1; }
say() { echo "== $*"; }

FRESH=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  "") ;;
  *) die "usage: build-python.sh [--fresh]" ;;
esac

for t in curl tar uv otool install_name_tool codesign shasum file ditto find; do
  command -v "$t" >/dev/null 2>&1 || die "$t 가 없다"
done
[ -f "$ENTS" ] || die "entitlements가 없다: $ENTS"
[ -f "$WORKER/uv.lock" ] || die "uv.lock이 없다: $WORKER/uv.lock"

# ── 캐시 키 두 개 ────────────────────────────────────────────────────────────
# 런타임 층: Python 버전·prefix·체크섬·의존성 잠금·이 스크립트.
RT_KEY=$( {
  echo "$PY_VERSION $PY_RELEASE $BUILD_PREFIX"
  shasum -a 256 "$SUMS" "$SCRIPT" "$WORKER/pyproject.toml" "$WORKER/uv.lock" "$ENTS" | awk '{print $1}'
} | shasum -a 256 | cut -c1-16)

# worker 층: 런타임 키 + damwha_worker 소스 트리 전체.
#   -type f 로 디렉터리를 빼고, 경로까지 해시에 넣어 파일 이동도 키를 바꾼다.
#   __pycache__는 제외한다 — 소스가 같아도 내용이 달라져 캐시가 영영 안 맞는다.
#   **경로를 해시에 남긴다.** awk로 경로를 버리면 내용이 같은 두 파일의 rename이 같은 키가
#   되어, 모듈을 옮긴 변경이 캐시에 안 잡힌다. (삭제는 목록이 줄어 잡히지만 rename은 안 잡힌다.)
#   `.py`만 보지 않는 이유: 패키지 안의 자원 파일(.sql·.json 등)도 동작을 바꾼다.
WK_KEY=$( {
  echo "$RT_KEY"
  ( cd "$WORKER" && find damwha_worker -type f -not -path '*/__pycache__/*' -print0 |
      sort -z | xargs -0 shasum -a 256 )
} | shasum -a 256 | cut -c1-16)

RT_OUT="$CACHE/rt-$RT_KEY"
RT_DONE="$CACHE/rt-$RT_KEY.complete"
WK_OUT="$CACHE/wk-$WK_KEY"
WK_DONE="$CACHE/wk-$WK_KEY.complete"

if [ "$FRESH" = 1 ]; then
  rm -rf "$RT_OUT" "$RT_OUT.tmp" "$RT_DONE" "$WK_OUT" "$WK_OUT.tmp" "$WK_DONE"
fi
mkdir -p "$DL"

fetch() {
  local url="$1" out="$2"
  [ -f "$DL/$out" ] && return 0
  curl -fsSL -o "$DL/$out.part" "$url" || die "내려받기 실패: $url"
  mv "$DL/$out.part" "$DL/$out"
}

# ── 재배치 3종 ───────────────────────────────────────────────────────────────
# Phase 0이 실측으로 확정한 목록이다. 매 빌드 반복해야 한다 — Mach-O 처리(LC_RPATH 삭제,
# LC_ID_DYLIB 정규화)와 달리 이 셋은 멱등이 아니라 "옮길 때마다" 필요하다.
relocate() {
  local tree="$1"

  # 1. bin/ 콘솔 스크립트 셔뱅 (Phase 0 실측 65개).
  #    옛 경로가 **사라진** 경우에만 bad interpreter로 죽는다. 남아 있으면 죽지 않고
  #    조용히 다른 런타임을 실행한다 — 앱 업데이트로 두 버전이 공존할 때 그 형태다 (R-6).
  #    우리 실행 경로는 전부 `-m`이라 셔뱅을 안 타지만, 사람이 손으로 부를 수 있고
  #    일부 라이브러리가 자기 콘솔 스크립트를 부른다.
  local n=0
  while IFS= read -r f; do
    head -c 2 "$f" 2>/dev/null | grep -q '^#!' || continue
    grep -q '^#!.*python' "$f" 2>/dev/null || continue
    # 실행 위치와 무관하게 **자기 옆의** 인터프리터를 찾게 한다.
    #
    # `dirname`을 부르지 않는다. 앱이 주는 자식 PATH는 `<python>/bin:<ffmpeg>/bin`뿐이라
    # (스펙 §6.2) `/usr/bin/dirname`이 없다 — `dirname: command not found` 뒤 `/python3.12`를
    # 실행하려다 실패한다. 셸 매개변수 확장 `${0%/*}`은 외부 명령을 안 쓴다.
    #
    # 만들어지는 것은 sh와 Python 둘 다 읽는 polyglot이다 — sh는 `"true" '''...'''`를
    # 명령으로 보고 exec 줄에 닿고, Python은 그 전체를 문자열 리터럴로 본다.
    # **검증은 인터프리터 직접 실행이 아니라 이 스크립트 자체를 제한된 PATH에서
    # 실행해서 한다** (Step 5-b).
    python3 - "$f" <<'SHEBANG_PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
body = b"\n".join(p.read_bytes().split(b"\n")[1:])
new = (b"#!/bin/sh\n"
       b"'''exec' \"${0%/*}/python3.12\" \"$0\" \"$@\"\n"
       b"'''\n") + body
p.write_bytes(new)
SHEBANG_PY
    n=$((n+1))
  done < <(find "$tree/bin" -type f -perm -u+x 2>/dev/null)
  say "  셔뱅 $n개 재배치"

  # 2. _sysconfigdata의 prefix. sysconfig가 이 값으로 헤더·라이브러리를 찾는다.
  local sc
  sc=$(find "$tree/lib" -name '_sysconfigdata_*.py' | head -1)
  [ -n "$sc" ] || die "_sysconfigdata를 못 찾았다"
  python3 - "$sc" "$BUILD_PREFIX" <<'PYEOF'
import sys, pathlib
p, old = pathlib.Path(sys.argv[1]), sys.argv[2]
t = p.read_text()
# 절대 prefix를 지우면 sysconfig가 sys.prefix로 떨어진다 — 그것이 우리가 원하는 동작이다.
p.write_text(t.replace(old, "/usr/local"))
PYEOF
  say "  _sysconfigdata prefix 정리"

  # 3. __pycache__ 전부 삭제 (Phase 0 실측 760개). 옛 경로가 박힌 .pyc가 남으면
  #    소스보다 그것이 먼저 쓰인다.
  find "$tree" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
  say "  __pycache__ 삭제"
}

# ── Mach-O 처리 (멱등) ───────────────────────────────────────────────────────
fix_macho() {
  local tree="$1" rpaths=0 ids=0
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    # LC_RPATH가 빌드 prefix를 가리키면 지운다 (Phase 0 실측 58건).
    while IFS= read -r rp; do
      [ -n "$rp" ] || continue
      case "$rp" in "$BUILD_PREFIX"*) install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null && rpaths=$((rpaths+1)) ;; esac
    done < <(otool -l "$f" | awk '/LC_RPATH/{p=1} p&&/path /{print $2; p=0}')
    # LC_ID_DYLIB를 @rpath 상대로 정규화 (Phase 0 실측 64건).
    local id
    id=$(otool -D "$f" 2>/dev/null | tail -n +2)
    case "$id" in
      "$BUILD_PREFIX"*) install_name_tool -id "@rpath/$(basename "$f")" "$f" 2>/dev/null && ids=$((ids+1)) ;;
    esac
  done < <(find "$tree" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
  say "  LC_RPATH $rpaths건 삭제, LC_ID_DYLIB $ids건 정규화"
}

# ── 서명 ─────────────────────────────────────────────────────────────────────
# arm64는 서명 없는 Mach-O를 실행하지 않는다. disable-library-validation은 서명 주체를
# 안 따질 뿐 "서명 없음"은 허용하지 않는다 (Phase 0 R-5) — 선택이 아니라 필수다.
sign_tree() {
  local tree="$1" n=0
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    codesign --force --sign - --options runtime --entitlements "$ENTS" "$f" 2>/dev/null && n=$((n+1))
  done < <(find "$tree" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
  say "  Mach-O $n개 서명"
}

verify_signatures() {
  local tree="$1" bad=0
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q 'Mach-O' || continue
    # --arch arm64가 핵심이다. 없이 부르면 universal 파일의 x86_64 슬라이스 하나 때문에
    # 파일 전체가 "not signed at all"로 보고된다 (Phase 0). 이 번들의 arm64 무서명은 0개다.
    codesign --verify --arch arm64 "$f" 2>/dev/null || { echo "  무서명: $f"; bad=$((bad+1)); }
  done < <(find "$tree" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0)
  [ "$bad" -eq 0 ] || die "arm64 무서명 $bad건"
  say "  arm64 서명 전수 확인"
}

# ── 런타임 층 ────────────────────────────────────────────────────────────────
if [ ! -f "$RT_DONE" ]; then
  say "런타임 층 빌드 (키 $RT_KEY)"
  fetch "https://github.com/astral-sh/python-build-standalone/releases/download/$PY_RELEASE/$PY_ASSET" "$PY_ASSET"
  ( cd "$DL" && shasum -a 256 -c "$SUMS" ) || die "체크섬 불일치: $DL/$PY_ASSET"

  rm -rf "$RT_OUT" "$RT_OUT.tmp"
  mkdir -p "$RT_OUT.tmp"
  tar xzf "$DL/$PY_ASSET" -C "$RT_OUT.tmp"
  # 아카이브가 python/ 한 겹을 만든다.
  mv "$RT_OUT.tmp/python" "$RT_OUT.tmp/tree"

  say "  의존성 설치 (uv.lock 기준)"
  # uv.lock이 단일 진실 원천이다. 스크립트가 버전을 스스로 적지 않는다.
  uv export --directory "$WORKER" --extra models --no-hashes --no-emit-project \
    --format requirements-txt > "$RT_OUT.tmp/requirements.txt" || die "uv export 실패"
  uv pip install --python "$RT_OUT.tmp/tree/bin/python3.12" \
    -r "$RT_OUT.tmp/requirements.txt" || die "의존성 설치 실패"

  relocate "$RT_OUT.tmp/tree"
  fix_macho "$RT_OUT.tmp/tree"
  sign_tree "$RT_OUT.tmp/tree"
  verify_signatures "$RT_OUT.tmp/tree"

  mv "$RT_OUT.tmp/tree" "$RT_OUT"
  rm -rf "$RT_OUT.tmp"
  touch "$RT_DONE"
else
  say "런타임 층 캐시 적중 ($RT_KEY)"
fi

# worker 층과 스테이징은 Task 5가 이어 쓴다.
say "런타임 층 준비: $RT_OUT"
```

```bash
chmod +x desktop/scripts/build-python.sh
```

- [ ] **Step 3: 돌린다 (수십 분)**

```bash
time bash desktop/scripts/build-python.sh
```

기대: `uv export` → `uv pip install` → 재배치 3종 → Mach-O → 서명 → `arm64 서명 전수 확인` → `런타임 층 준비: …`.

- [ ] **Step 4: 트리가 실제로 도는지 확인한다**

```bash
RT=$(ls -d desktop/.cache/python/rt-* | head -1)
"$RT/bin/python3.12" -c "
import sys, torch, numpy, mlx, mlx_lm, mlx_whisper, pyannote.audio, sentence_transformers
print('executable', sys.executable)
print('prefix', sys.prefix)
print('mlx', mlx.__version__)
"
```

기대: `executable`·`prefix`가 그 트리 아래. import 전부 성공. **`mlx_lm`이 여기서 import되는 것이 Task 2가 제대로 됐다는 증거다.**

- [ ] **Step 5: 재배치가 실제로 되는지 확인한다 (R-6 회귀 방지)**

```bash
cp -R "$RT" /tmp/py-moved
/tmp/py-moved/bin/python3.12 -c "import sys; print(sys.executable, sys.prefix)"
```

기대: **옮긴 경로**를 보고한다. 원래 캐시 경로를 보고하면 재배치가 안 된 것이다.

```bash
sudo mv "$RT" "${RT}.hidden" 2>/dev/null || mv "$RT" "${RT}.hidden"
/tmp/py-moved/bin/python3.12 -c "import sys, torch; print('OK', sys.prefix)"
mv "${RT}.hidden" "$RT"
```

기대: 원래 경로가 **사라져도** 옮긴 트리가 돈다. 이것이 R-6의 진짜 검사다 — 옛 경로가 남아 있으면 깨진 트리도 조용히 돈다.

**5-b. 콘솔 스크립트 자체를 제한된 PATH에서 실행한다.** 인터프리터 직접 실행만으로는
셔뱅 래퍼를 검증하지 못한다 — 앱이 자식에게 주는 PATH에는 `/usr/bin`이 없다(스펙 §6.2).

```bash
BIN=$(ls /tmp/py-moved/bin/*.py 2>/dev/null | head -1)
[ -n "$BIN" ] || BIN=$(grep -rl '^#!/bin/sh' /tmp/py-moved/bin | head -1)
env -i PATH="/tmp/py-moved/bin" HOME=/tmp "$BIN" --version 2>&1 | head -3
```

기대: 정상 출력. `dirname: command not found`나 `/python3.12: not found`가 나오면
셔뱅 재작성이 외부 명령에 의존하고 있다는 뜻이다.

**공백이 든 경로에서도 확인한다** — 설치 경로에 공백은 흔하다.

```bash
mkdir -p "/tmp/py spaced" && ditto /tmp/py-moved "/tmp/py spaced/python"
env -i PATH="/tmp/py spaced/python/bin" HOME=/tmp "/tmp/py spaced/python/bin/$(basename "$BIN")" --version 2>&1 | head -3
rm -rf "/tmp/py spaced"
```

```bash
rm -rf /tmp/py-moved
```

- [ ] **Step 6: 캐시 키가 의존성 변화를 잡는지 확인한다**

```bash
touch be/worker/uv.lock          # mtime만 바꾼다 — 내용은 그대로
bash desktop/scripts/build-python.sh 2>&1 | head -3
```

기대: **캐시 적중** (키는 내용 해시라 mtime에 안 흔들린다).

```bash
printf '\n# cache-key probe\n' >> be/worker/pyproject.toml
bash desktop/scripts/build-python.sh 2>&1 | head -3
git checkout be/worker/pyproject.toml
```

기대: **캐시 미스** → 다시 빌드 시작. 확인했으면 Ctrl-C로 끊고 `git checkout`으로 되돌린다.

**Verify:** Step 3~6 전부 통과. `codesign -d --entitlements - "$RT/bin/python3.12"`가 entitlement 키를 보인다.

**Review:**
- 캐시 키에 `uv.lock`·`pyproject.toml`·`entitlements.plist`·스크립트 자신이 전부 들어갔는가.
- `uv export`가 `--extra models`를 포함하는가 (빠지면 ML 라이브러리가 통째로 빠진다).
- `verify_signatures`가 `--arch arm64`를 쓰는가.
- 재배치가 `__pycache__`를 지우는가 (옛 경로가 박힌 `.pyc`가 소스를 이긴다).
- Step 5의 "원래 경로를 지우고도 도는가"를 실제로 했는가 — 이것이 R-6의 유일한 진짜 검사다.

- [ ] **Step 7: 커밋**

```bash
git add desktop/scripts/build-python.sh desktop/scripts/python-checksums.txt
git commit -m "feat(desktop): 내장 Python 런타임 빌드 스크립트를 더한다 (런타임 층)

python-build-standalone 3.12.11에 be/worker의 고정 의존성을 uv.lock 기준으로
설치하고, Phase 0이 실측한 재배치 3종(셔뱅·_sysconfigdata·__pycache__)과
Mach-O 처리(LC_RPATH·LC_ID_DYLIB), arm64 전수 서명을 적용한다.

캐시를 두 층으로 나눈다. 런타임은 거의 안 변하고 worker 패키지는 매 커밋
변하는데, 하나로 묶으면 worker를 고쳐도 캐시가 적중해 옛 코드가 .app에
실린다 — Phase 2가 24f9080에서 정확히 그 결함을 겪었다. 이 커밋은 런타임
층까지이고 worker 층은 다음 커밋이다.

서명 검증은 --arch arm64로 한다. 없이 부르면 universal 파일의 x86_64
슬라이스 하나 때문에 파일 전체가 not signed at all로 보고된다."
```

---

## Task 5: `build-python.sh` — worker 층 + 스테이징 (캐시 2층)

**Files:**
- Modify: `desktop/scripts/build-python.sh` (Task 4가 남긴 자리에 이어 쓴다)

**Interfaces:**
- Consumes: Task 4의 `$RT_OUT`, `$WK_KEY`, `relocate`·`sign_tree`·`verify_signatures`
- Produces: `desktop/build/python/bin/python3.12` + `lib/python3.12/site-packages/damwha_worker/`. Task 10의 `pythonBinaries()`가 이 배치를 가정한다.

- [ ] **Step 1: 스크립트 끝의 `# worker 층과 스테이징은 Task 5가 이어 쓴다.` 두 줄을 아래로 바꾼다**

```bash
# ── worker 층 ────────────────────────────────────────────────────────────────
if [ ! -f "$WK_DONE" ]; then
  say "worker 층 빌드 (키 $WK_KEY)"
  rm -rf "$WK_OUT" "$WK_OUT.tmp"
  # 런타임 층을 복사해 그 위에 패키지만 얹는다. ditto는 심볼릭 링크와 권한을 보존한다.
  ditto "$RT_OUT" "$WK_OUT.tmp"

  say "  damwha_worker 설치"
  # --no-deps: 런타임 층이 이미 전부 깔았다. 여기서 해석이 다시 돌면 고정이 흔들린다.
  uv pip install --python "$WK_OUT.tmp/bin/python3.12" --no-deps "$WORKER" \
    || die "damwha_worker 설치 실패"

  # 설치가 만든 것만 다시 손본다 — 런타임 층의 재배치·서명은 ditto가 그대로 옮겼다.
  # damwha_worker는 순수 Python이라 Mach-O가 없지만, 콘솔 스크립트 둘(damwha-worker·
  # damwha-embed)이 bin/에 새로 생기고 그 셔뱅이 uv가 본 절대 경로를 담는다.
  relocate "$WK_OUT.tmp"
  sign_tree "$WK_OUT.tmp"
  verify_signatures "$WK_OUT.tmp"

  mv "$WK_OUT.tmp" "$WK_OUT"
  touch "$WK_DONE"
else
  say "worker 층 캐시 적중 ($WK_KEY)"
fi

# ── 진입점 확인 ──────────────────────────────────────────────────────────────
# 빌드에서 잡지 않으면 첫 실행에서야 드러난다. mlx_lm이 여기 걸리는 것이
# 스펙 §2.4의 결함(매니페스트 밖 전역 설치 의존)에 대한 회귀 방지다.
#
# **import하지 않고 찾기만 한다.** `import`는 부작용이 있는 모듈에서 위험하다 —
# embed_service는 Task 6이 고치기 전까지 모듈 수준에서 load_settings()와
# build_text_embedder()를 부르므로(embed_service.py:10-11), import하면 빌드 머신이
# DATABASE_URL을 요구하고 bge-m3 2.2GB를 받는다. importlib.util.find_spec은 모듈을
# **찾기만** 하고 실행하지 않는다.
say "진입점 확인"
"$WK_OUT/bin/python3.12" -c "
import importlib.util as u, sys
missing = [m for m in ('damwha_worker', 'damwha_worker.__main__', 'damwha_worker.embed_service',
                       'damwha_worker.llm_entry', 'mlx_lm.server')
           if u.find_spec(m) is None]
if missing:
    print('  없는 모듈:', ', '.join(missing)); sys.exit(1)
print('  모듈 확인 OK')
" || die "진입점 모듈이 없다 — pyproject.toml의 models extra와 damwha_worker 설치를 확인하라"

# 무거운 의존성이 실제로 로드되는지는 따로 본다. 이쪽은 부작용이 없는 것들만이다.
"$WK_OUT/bin/python3.12" -c "
import torch, numpy, mlx, mlx_whisper, pyannote.audio, sentence_transformers
print('  ML 스택 import OK')
" || die "ML 스택 import 실패"

# ── 스테이징 ─────────────────────────────────────────────────────────────────
say "스테이징: $STAGED"
rm -rf "$STAGED"
mkdir -p "$(dirname "$STAGED")"
ditto "$WK_OUT" "$STAGED"
"$STAGED/bin/python3.12" --version
say "완료"
```

- [ ] **Step 2: 돌린다**

```bash
bash desktop/scripts/build-python.sh
```

기대: `런타임 층 캐시 적중` → `worker 층 빌드` → `import OK` → `스테이징` → `Python 3.12.11`.

- [ ] **Step 3: worker 소스를 고치면 캐시가 미스하는지 확인한다 (Task 4의 이유)**

```bash
printf '\n# cache-key probe\n' >> be/worker/damwha_worker/__main__.py
bash desktop/scripts/build-python.sh 2>&1 | grep -E '층|import OK'
git checkout be/worker/damwha_worker/__main__.py
bash desktop/scripts/build-python.sh 2>&1 | grep -E '층'
```

기대: 첫 실행이 `런타임 층 캐시 적중` + **`worker 층 빌드`**(미스). 되돌린 뒤에는 둘 다 적중 — 원래 키로 돌아왔기 때문이다.

- [ ] **Step 4: 설치된 코드가 저장소와 같은지 확인한다**

```bash
diff -r be/worker/damwha_worker \
  desktop/build/python/lib/python3.12/site-packages/damwha_worker \
  -x '__pycache__' -x '*.pyc'
```

기대: 차이 없음.

- [ ] **Step 5: 트리 크기와 서명을 기록한다**

```bash
du -sh desktop/build/python desktop/build/ffmpeg
codesign -d --entitlements - desktop/build/python/bin/python3.12 2>&1 | grep -c 'security.cs'
```

기대: python 약 1.5 GB, ffmpeg 약 42 MB. entitlement 키 2개(또는 Task 1이 `allow-jit`을 더했으면 3개).

**Verify:** Step 2~5 전부 통과.

**Review:**
- `--no-deps`가 있는가 (없으면 해석이 다시 돌아 고정이 흔들린다).
- worker 층이 `relocate`를 다시 부르는가 — `uv pip install`이 만든 새 콘솔 스크립트의 셔뱅에 절대 경로가 박힌다.
- 진입점 확인이 `mlx_lm.server`를 포함하는가.
- `ditto`를 쓰는가 (`cp -R`는 확장 속성과 심볼릭 링크 처리가 다르다).

- [ ] **Step 6: 커밋**

```bash
git add desktop/scripts/build-python.sh
git commit -m "feat(desktop): Python 빌드에 worker 층과 진입점 확인을 더한다"
```

커밋 본문:

```
런타임 층을 복사해 damwha_worker만 --no-deps로 얹는다. 캐시 키에 소스 트리
해시가 들어가 worker를 고치면 이 층만 다시 빌드된다.

설치가 만든 콘솔 스크립트의 셔뱅에 uv가 본 절대 경로가 박히므로 worker
층도 재배치와 서명을 다시 돈다.

진입점 확인이 damwha_worker·embed_service·mlx_lm.server를 import한다.
mlx_lm이 여기 걸리는 것이 매니페스트 밖 전역 설치 의존의 회귀 방지다 —
빌드에서 안 잡으면 첫 실행에서야 드러난다.
```

---

## Task 6: 패키징·서명·번들 위생

**Files:**
- Modify: `desktop/scripts/package.mjs` (빌드 호출, 서명)
- Modify: `desktop/scripts/check-bundle.mjs` (끝에 추가)
- Modify: `desktop/package.json` (`start:desktop`)

**Interfaces:**
- Consumes: Task 3·4·5의 두 빌드 스크립트, Task 1의 `entitlements.mac.plist`
- Produces: `Resources/python`·`Resources/ffmpeg`를 가진 서명된 `.app`. Task 10·12가 그 경로를 읽는다.

- [ ] **Step 1: `package.mjs`가 두 스크립트를 부르게 한다**

`run("bash", [path.join("scripts", "build-postgres.sh")], desktop);` **바로 아래**에:

```javascript
// 내장 Python·ffmpeg 트리를 desktop/build에 스테이징한다. PG와 같은 자리, 같은 규칙이다
// (Electron Phase 4 스펙 §6.1). 캐시가 있으면 복사만 한다. 여기서 멈추는 이유도 같다 —
// Python이 빠진 .app은 첫 실행에서야 "worker를 띄울 수 없어요"로 드러난다.
run("bash", [path.join("scripts", "build-python.sh")], desktop);
run("bash", [path.join("scripts", "build-ffmpeg.sh")], desktop);
```

- [ ] **Step 2: 서명을 hardened runtime + entitlements로 바꾼다**

`package.mjs`의 `const appPath = …` 아래 `run("codesign", …)` 한 줄을 통째로 바꾼다:

```javascript
const appPath = path.join(desktop, "out", "mac-arm64", "Damwha.app");
const ents = path.join(desktop, "build-resources", "entitlements.mac.plist");

// electron-builder는 target: dir + identity: null이면 번들을 재서명하지 않는다. 그러면
// Electron 프리빌트의 링커 서명이 남아 Identifier가 Electron이 되고 Info.plist가 서명에
// 묶이지 않는다 — 그 상태의 앱은 자기 이름의 TCC 주체가 아니다.
//
// Phase 4부터는 **hardened runtime과 entitlement가 함께 필요하다.** Resources/python 안의
// 제3자 wheel .so는 우리 신원으로 서명되지 않으므로 disable-library-validation이 있어야
// 로드되고, MLX·numba의 JIT 매핑에는 allow-unsigned-executable-memory가 필요하다
// (Phase 0 R-4·R-5). 옵션 없이 서명하면 그 둘이 빠져 특정 모델에서만 조용히 죽는다.
//
// Resources 아래 Mach-O는 build-python.sh가 이미 같은 옵션으로 개별 서명했다.
// 여기서는 .app 자신을 봉한다.
run("codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime",
                 "--entitlements", ents, appPath], desktop);
```

- [ ] **Step 3: `check-bundle.mjs`에 검사를 더한다**

파일 끝의 실패 집계 직전에:

```javascript
// ── Phase 4: Python·ffmpeg 번들 위생 ────────────────────────────────────────
const pythonDir = path.join(contents, "Resources", "python");
const ffmpegDir = path.join(contents, "Resources", "ffmpeg");

check("Resources/python exists", fs.existsSync(path.join(pythonDir, "bin", "python3.12")));
check("Resources/ffmpeg exists", fs.existsSync(path.join(ffmpegDir, "bin", "ffmpeg")));
check("Resources/ffmpeg has ffprobe", fs.existsSync(path.join(ffmpegDir, "bin", "ffprobe")));

// damwha_worker가 실제로 설치됐나. 트리만 있고 패키지가 없으면 첫 실행에서야 드러난다.
check(
  "Resources/python has damwha_worker",
  fs.existsSync(path.join(pythonDir, "lib", "python3.12", "site-packages", "damwha_worker", "__main__.py")),
);
// mlx_lm은 2026-09-16까지 매니페스트 밖 전역 설치에 의존했다 (Phase 4 스펙 §2.4).
check(
  "Resources/python has mlx_lm",
  fs.existsSync(path.join(pythonDir, "lib", "python3.12", "site-packages", "mlx_lm", "server.py")),
);

function machOFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      // 심볼릭 링크는 건너뛴다 — python3 → python3.12 링크가 같은 파일을 두 번 검사하게 한다.
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      const executable = (st.mode & 0o111) !== 0;
      if (!executable && !/\.(so|dylib)$/.test(d.name)) continue;
      // file(1)이 실패해도 검사 전체를 멈추지 않는다.
      const r = spawnSync("file", ["-b", p], { encoding: "utf8" });
      if (r.status === 0 && (r.stdout ?? "").includes("Mach-O")) out.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

for (const [label, dir] of [["python", pythonDir], ["ffmpeg", ffmpegDir]]) {
  const machO = machOFiles(dir);
  check(`Resources/${label} has Mach-O files`, machO.length > 0, `${machO.length} files`);
  // --arch arm64가 핵심이다. 없이 부르면 universal 파일의 x86_64 슬라이스 하나 때문에
  // 파일 전체가 "not signed at all"로 보고된다 (Phase 0). 이 번들의 arm64 무서명은 0개다.
  const unsigned = machO.filter(
    (f) => spawnSync("codesign", ["--verify", "--arch", "arm64", f], { encoding: "utf8" }).status !== 0,
  );
  check(`Resources/${label} has no unsigned arm64 Mach-O`, unsigned.length === 0,
    unsigned.slice(0, 5).map((f) => path.relative(contents, f)).join(", "));
}

// entitlement가 실제로 붙었나. plist를 만드는 것만으로는 아무 일도 일어나지 않는다.
{
  const want = ["allow-unsigned-executable-memory", "disable-library-validation"];
  const r = spawnSync("codesign", ["-d", "--entitlements", "-", appDir], { encoding: "utf8" });
  const blob = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const missing = want.filter((k) => !blob.includes(k));
  check("Damwha.app has hardened-runtime entitlements", missing.length === 0, missing.join(", "));
}

// 개발 머신 경로가 번들에 샜나. Phase 1의 P1-C11을 Python 트리로 넓힌다.
// 제3자 wheel과 CPython 표준 라이브러리 **원본**의 문자열은 지울 수 없으므로
// (Phase 0의 G1 허용 목록 24건, Phase 6이 받는다) **우리가 만든 것**만 본다:
// 콘솔 스크립트의 셔뱅이다.
{
  const binDir = path.join(pythonDir, "bin");
  const home = process.env.HOME ?? "";
  const offenders = [];
  if (fs.existsSync(binDir)) {
    for (const name of fs.readdirSync(binDir)) {
      const p = path.join(binDir, name);
      if (!fs.statSync(p).isFile()) continue;
      const head = fs.readFileSync(p).subarray(0, 512).toString("utf8");
      if (!head.startsWith("#!")) continue;
      const leaks =
        head.includes(repo) ||
        head.includes("/opt/damwha-embedded") ||
        (home !== "" && head.includes(home));
      if (leaks) offenders.push(name);
    }
  }
  check("Resources/python shebangs point inside the bundle", offenders.length === 0, offenders.join(", "));
}
```

- [ ] **Step 4: dev 스크립트도 두 빌드를 부르게 한다**

`desktop/package.json`의 `start:desktop`을 아래로 바꾼다:

```
bash scripts/build-postgres.sh && bash scripts/build-python.sh && bash scripts/build-ffmpeg.sh && pnpm run compile && electron .
```

- [ ] **Step 5: 패키징한다 (오래 걸린다)**

```bash
pnpm --filter damwha-desktop run package:desktop
```

- [ ] **Step 6: 위생 검사를 돌린다**

```bash
node desktop/scripts/check-bundle.mjs
```

기대: 새 줄이 전부 `PASS`, exit 0. **기존 검사도 전부 PASS**(회귀 없음).

- [ ] **Step 7: 번들 크기를 기록한다**

```bash
du -sh desktop/out/mac-arm64/Damwha.app
du -sh desktop/out/mac-arm64/Damwha.app/Contents/Resources/python \
       desktop/out/mac-arm64/Damwha.app/Contents/Resources/ffmpeg \
       desktop/out/mac-arm64/Damwha.app/Contents/Resources/postgres \
       desktop/out/mac-arm64/Damwha.app/Contents/Resources/api
```

**Verify:** Step 5·6 통과.

**Review:**
- 서명이 `--options runtime --entitlements`를 실제로 주는가.
- `check-bundle`의 `--arch arm64`가 있는가.
- 금지 문자열 검사가 **우리가 만든 것**(셔뱅)만 보는가 — 제3자 wheel 원본을 보면 G1 24건에 걸려 영영 실패한다.
- `machOFiles`가 심볼릭 링크를 건너뛰는가.
- `package.mjs`가 빌드 실패 시 멈추는가 (`execFileSync`는 던진다).

- [ ] **Step 8: 커밋**

```bash
git add desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs desktop/package.json
git commit -m "feat(desktop): Python·ffmpeg를 번들에 싣고 hardened runtime으로 서명한다"
```

커밋 본문:

```
패키징이 두 빌드 스크립트를 부르고, 최종 서명에 --options runtime과
entitlements를 준다. 지금까지는 --force --deep --sign - 뿐이라 plist를
만들어도 아무 일도 일어나지 않았다 — Resources/python의 제3자 wheel .so는
우리 신원으로 서명되지 않으므로 disable-library-validation이 있어야 로드되고,
JIT 매핑에는 allow-unsigned-executable-memory가 필요하다.

번들 위생 검사가 두 트리의 존재, damwha_worker·mlx_lm 설치, arm64 무서명
Mach-O 0건, entitlement 실제 적용, 셔뱅이 번들 안을 가리키는지를 본다.
금지 문자열은 우리가 만든 셔뱅만 본다 — 제3자 wheel 원본의 문자열은
지울 수 없고 Phase 6이 받는다.
```

---

## Task 7: worker — ffmpeg 바이너리를 호출 시점에 env에서 읽는다

Phase 2가 넘긴 `FFMPEG_BIN`/`FFPROBE_BIN`을 닫는다. **`functools.partial` 안은 쓰지 않는다** — 스펙 §6.6의 근거를 읽고 시작하라.

**Files:**
- Modify: `be/worker/damwha_worker/pipeline/ffmpeg.py`
- Modify: `be/worker/damwha_worker/config.py`
- Modify: `be/worker/tests/test_ffmpeg.py`

**Interfaces:**
- Consumes: 없음
- Produces: `FFMPEG_BIN`·`FFPROBE_BIN` env를 읽는 `pipeline.ffmpeg`. Task 12가 그 값을 주입한다.
- **시그니처는 바뀌지 않는다** — `probe(path, runner)`·`normalize(src, dst, runner)` 그대로.

- [ ] **Step 1: 왜 인자 추가가 아닌지 확인한다**

```bash
sed -n '30,56p' be/worker/damwha_worker/pipeline/process_meeting.py
sed -n '19,34p' be/worker/damwha_worker/pipeline/enroll_speaker.py
sed -n '48,56p' be/worker/tests/test_worker_loop.py
```

보이는 것: 두 파이프라인 함수에 `settings`가 없고, 기본값을 **호출 시점에** `ffmpeg.normalize`로 해석해 테스트의 `monkeypatch.setattr(pm.ffmpeg, "normalize", lambda s, d: None)`를 받는다. partial을 def-time에 만들면 monkeypatch가 무력해지고, call-time에 만들면 그 lambda에 `ffmpeg_bin=` 키워드를 줘 `TypeError`다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`be/worker/tests/test_ffmpeg.py` 끝에:

```python
def test_probe_uses_ffprobe_bin_from_env(monkeypatch):
    monkeypatch.setenv("FFPROBE_BIN", "/bundle/ffmpeg/bin/ffprobe")
    seen = []

    def runner(cmd):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b'{"format":{"duration":"1.5"}}', b"")

    ffmpeg.probe("/x.wav", runner=runner)
    assert seen[0][0] == "/bundle/ffmpeg/bin/ffprobe"


def test_normalize_uses_ffmpeg_bin_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("FFMPEG_BIN", "/bundle/ffmpeg/bin/ffmpeg")
    monkeypatch.setenv("FFPROBE_BIN", "/bundle/ffmpeg/bin/ffprobe")
    src = tmp_path / "a.wav"
    src.write_bytes(b"RIFF")
    seen = []

    def runner(cmd):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b'{"format":{"duration":"1.0"}}', b"")

    # 재귀 검증 probe는 모듈 기본 runner를 탄다(기존 동작) — 그것을 스텁해 실제 ffprobe를
    # 부르지 않게 한다. 이 테스트가 보는 것은 ffmpeg 명령의 첫 인자다.
    monkeypatch.setattr(ffmpeg, "probe", lambda path: ffmpeg.ProbeResult(1000))

    ffmpeg.normalize(str(src), str(tmp_path / "b.flac"), runner=runner)
    assert seen[0][0] == "/bundle/ffmpeg/bin/ffmpeg"


def test_bins_default_to_bare_names(monkeypatch):
    # 웹 흐름(pnpm worker)에는 이 env가 없다. 기존 동작이 그대로여야 한다.
    monkeypatch.delenv("FFPROBE_BIN", raising=False)
    seen = []

    def runner(cmd):
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, b'{"format":{"duration":"1.0"}}', b"")

    ffmpeg.probe("/x.wav", runner=runner)
    assert seen[0][0] == "ffprobe"
```

- [ ] **Step 3: 실패를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_ffmpeg.py -k "bin" -v
```

기대: FAIL — 첫 인자가 `"ffprobe"` 리터럴이다.

- [ ] **Step 4: `ffmpeg.py`를 고친다**

파일 맨 위 `_run` 아래에:

```python
def _bin(name: str) -> str:
    """번들 실행 파일 경로. 앱이 `FFMPEG_BIN`·`FFPROBE_BIN`으로 준다 (Electron Phase 4 스펙 §6.6).

    **호출 시점에 읽는다.** 모듈 로드 시점에 상수로 굳히면 테스트가 env를 못 바꾸고,
    앱이 재시도로 값을 고쳐도 반영되지 않는다.

    인자로 받지 않는 이유: `run_process_meeting`·`run_enroll_speaker`에 `settings`가 없고,
    두 함수의 `normalize_fn`/`probe_fn` 기본값은 호출 시점에 이 모듈의 속성을 해석해
    테스트의 monkeypatch를 받는다(process_meeting.py:53). partial로 바이너리를 묶으면
    def-time이면 그 monkeypatch가 무력해지고 call-time이면 monkeypatch된 lambda에
    없는 키워드를 줘 TypeError가 난다 — 양쪽 다 깨진다.

    기본값이 맨 이름이라 웹 흐름(`pnpm worker`, env 없음)은 지금 그대로 PATH를 탄다.
    """
    return os.environ.get(f"{name.upper()}_BIN") or name
```

`probe()`의 `cmd`:

```python
    cmd = [_bin("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", path]
```

`normalize()`의 `cmd` 첫 원소:

```python
        cmd = [
            _bin("ffmpeg"),
            "-y",
```

`normalize()` 안의 재귀 검증 호출(`ffmpeg.py:82`)은 **건드리지 않는다.**

바이너리는 그쪽에서도 `_bin`을 다시 읽으므로 자동으로 따라온다. `runner`를 넘기는 것은
별개 변경이고 **이 Phase의 범위가 아니다** — 넘기면 기존 테스트가 깨진다:

```python
# tests/test_ffmpeg.py:49, :122 — 모듈 속성을 갈아 끼운다
monkeypatch.setattr(ffmpeg, "probe", lambda path: ffmpeg.ProbeResult(1))
```

`probe(temp_path, runner=runner)`는 저 lambda에 `TypeError: <lambda>() got an unexpected
keyword argument 'runner'`를 낸다. 지금 그 재귀 호출이 모듈 기본 runner를 타는 것은
**의도된 기존 동작**이고(정규화 결과를 진짜 ffprobe로 검증한다) 바꿀 이유가 없다.

- [ ] **Step 5: `config.py`에 필드를 더한다**

`storage_root` 아래에:

```python
    # pipeline/ffmpeg.py는 이 값을 Settings가 아니라 **env에서 직접** 읽는다 — 그 모듈이
    # Settings를 만들 수 없기 때문이다(database_url이 필수라 실패한다). 여기 두는 것은
    # 설정 문서화와 `.env` 운용 경로를 위해서다. pydantic이 같은 env를 읽으므로 두 값이
    # 갈리지 않는다. 단일 진실 원천은 env이고 이 둘은 그 사본이다.
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
```

- [ ] **Step 6: 통과를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_ffmpeg.py -v
pnpm worker:test
uv run --directory be/worker ruff check .
```

기대: 새 테스트 3개 통과, **기존 테스트 전부 통과** (monkeypatch 경로가 안 깨졌다는 증거).

**Verify:** 세 명령 통과.

**Review:**
- 시그니처가 안 바뀌었는가 (`probe(path, runner)`·`normalize(src, dst, runner)`).
- `_bin`이 **호출 시점에** `os.environ`을 읽는가 (모듈 상수가 아니라).
- 재귀 `probe(temp_path, runner=runner)`가 `runner`를 넘기는가.
- 기본값이 맨 이름이라 웹 흐름에 회귀가 없는가.
- `os`가 이미 import돼 있는가 (`ffmpeg.py:2` — 있다).

- [ ] **Step 7: 커밋**

```bash
git add be/worker/damwha_worker/pipeline/ffmpeg.py be/worker/damwha_worker/config.py be/worker/tests/test_ffmpeg.py
git commit -m "feat(worker): ffmpeg·ffprobe 경로를 env에서 호출 시점에 읽는다"
```

커밋 본문:

```
Phase 2가 넘긴 FFMPEG_BIN/FFPROBE_BIN을 닫는다. 지금까지 ["ffmpeg", …]
리터럴이라 개발 도구가 없는 맥에서는 번들에 ffmpeg를 넣어도 찾지 못했다.

인자로 받지 않는다. run_process_meeting·run_enroll_speaker에 settings가
없고, 두 함수의 normalize_fn/probe_fn 기본값은 호출 시점에 모듈 속성을
해석해 테스트의 monkeypatch를 받는다. partial로 묶으면 def-time이면 그
monkeypatch가 무력해지고 call-time이면 monkeypatch된 lambda에 없는
키워드를 줘 TypeError다 — 양쪽 다 깨진다.

normalize 안의 검증 probe에 runner를 넘기는 것도 함께 고쳤다. 안 넘기면
정규화 뒤 검증만 주입된 runner를 잃는다.

기본값이 맨 이름이라 웹 흐름(pnpm worker)은 그대로 PATH를 탄다.
```

---

## Task 8: worker — 모듈 진입, `llm_entry`, import 부작용 제거

**Files:**
- Create: `be/worker/damwha_worker/llm_entry.py`
- Create: `be/worker/tests/test_llm_entry.py`
- Modify: `be/worker/damwha_worker/embed_service.py`
- Modify: `be/worker/damwha_worker/llm_server.py`
- Modify: `be/worker/damwha_worker/config.py`
- Modify: `be/worker/tests/test_llm_server.py`

**Interfaces:**
- Consumes: Task 2의 `mlx-lm` 매니페스트
- Produces:
  - `damwha_worker.llm_entry` 모듈 — `python -m damwha_worker.llm_entry --run-id=X --model … --host … --port …`
  - `embed_service`가 import 부작용 없이 `python -m`으로 뜬다.
  - `lens_llm_server_bin` 기본값 `""` = 모듈 진입.
  Task 15의 고아 판정이 `llm_entry`를 모듈 목록에 넣는다.

- [ ] **Step 1: 지금 코드를 읽는다**

```bash
sed -n '1,15p' be/worker/damwha_worker/embed_service.py
sed -n '60,120p' be/worker/damwha_worker/llm_server.py
sed -n '1,40p' be/worker/tests/test_llm_server.py
```

확인할 것 셋:
- `embed_service.py:10-11`이 **모듈 수준**에서 `load_settings()`·`build_text_embedder()`를
  부른다 — import만으로 `DATABASE_URL`을 요구하고 bge-m3를 받는다.
- 실제 함수 이름은 `managed_llm_server(model, settings, *, popen, probe, monotonic, sleep)`다
  (`llm_server.py:68`). 인자 순서가 `(model, settings)`다.
- `_wait_ready(proc, model, settings, probe, monotonic, sleep)`가 600초를 센다(`:128`).

- [ ] **Step 2: `embed_service.py`의 import 부작용을 없앤다**

모듈 수준의 두 줄을 지연 초기화로 바꾼다:

```python
_settings = None
_embedder = None


def _ready():
    """설정과 임베더를 **처음 쓸 때** 만든다.

    모듈 수준에서 만들면 `import damwha_worker.embed_service`만으로 DATABASE_URL을 요구하고
    bge-m3(2.2 GB)를 내려받는다. 빌드의 진입점 확인(build-python.sh 8단계)과 어떤 정적
    분석도 이 모듈을 건드릴 수 없게 된다 (Electron Phase 4 스펙 §4.1-17).

    FastAPI 핸들러는 요청마다 부르지만 두 번째부터는 캐시를 돌려주므로 값싸다. main()이
    uvicorn 전에 한 번 불러 **기동 시점에** 모델을 올린다 — 첫 요청이 31초 걸리지 않게.
    """
    global _settings, _embedder
    if _embedder is None:
        _settings = load_settings()
        _embedder = build_text_embedder(_settings)
    return _settings, _embedder
```

`health()`는 `_ready()`를 부르지 않는다 — 모델이 아직 안 올라왔어도 프로세스가 살아 있음을
답해야 한다. `embed()`와 `main()`만 부른다.

`main()`에 자기 보고와 모델 선로딩을 넣는다:

```python
def main() -> None:  # pragma: no cover — 실모델 + uvicorn (로컬 실행)
    import json
    import logging

    import uvicorn

    from .runtime_report import runtime_facts

    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("runtime %s", json.dumps(runtime_facts(), ensure_ascii=False))
    settings, _ = _ready()   # uvicorn 전에 모델을 올린다
    uvicorn.run(app, host=settings.embed_service_host, port=settings.embed_service_port)


if __name__ == "__main__":  # pragma: no cover
    # `python -m damwha_worker.embed_service`. 앱은 콘솔 스크립트(bin/damwha-embed)를
    # 부르지 않는다 — 그것은 셔뱅을 타고, 옛 경로가 남아 있으면 죽지 않고 조용히 다른
    # 런타임을 실행한다 (Phase 0 R-6, Phase 4 스펙 §6.2).
    # [project.scripts]의 damwha-embed는 그대로 둔다 — deploy/README.md가 쓴다.
    main()
```

(`runtime_report`는 Task 9가 만든다. **Task 8과 9를 연달아 실행하거나**, 이 Step의 자기 보고
줄만 Task 9로 미룬다 — 미루면 이 커밋에서 그 import를 빼 둔다.)

- [ ] **Step 3: `llm_entry.py`를 쓴다**

```python
"""LLM 서버를 **앱이 소유를 증명할 수 있는 모양**으로 띄우는 얇은 진입 모듈.

`mlx_lm.server`를 직접 부르면 두 가지가 다 안 된다 — upstream CLI라 `--run-id`를 주면
모르는 인자로 죽고, 안 주면 소유 표식이 없는 프로세스가 된다. 부모 트리로 판정하는 것도
못 한다: Python supervisor는 두 번째 신호에서 `--once` 자식을 SIGKILL하고 `os._exit`하므로
(`__main__.py:268-287`), 부모와 `--once`가 둘 다 사라지면 훑을 트리가 없다
(Electron Phase 4 스펙 §6.2·§6.5).

그래서 이 모듈이 그 사이에 앉는다. 하는 일은 셋뿐이다:
  1. `--run-id`를 받아서 **버린다** (앱이 `ps -axo args`로 읽는 것이 전부다).
  2. 나머지 인자로 `sys.argv`를 재구성한다.
  3. **같은 프로세스에서** `mlx_lm.server`의 `main()`을 부른다.

중간 프로세스를 만들지 않는 것이 중요하다 — exec 래퍼나 부모-자식 구조로 하면 스펙 §6.2가
없앤 uv 구조가 되살아난다. 같은 프로세스라는 점의 부수 효과로 **HF 다운로드 훅을 걸 수
있다** — 별도 프로세스였다면 LLM 모델의 다운로드 진행을 관측할 길이 없었다 (§6.9).
"""

import sys

from .runtime_report import RUN_ID_PREFIX


def _passthrough(argv: list[str]) -> list[str]:
    """`--run-id=…`만 뺀 나머지. mlx_lm.server가 그대로 받는다."""
    return [a for a in argv if not a.startswith(RUN_ID_PREFIX)]


def main() -> None:  # pragma: no cover — 실서버 기동 (로컬 실행)
    import json
    import logging

    from mlx_lm.server import main as server_main

    from .downloads import install_hf_progress_hook
    from .runtime_report import runtime_facts

    logging.basicConfig(level=logging.INFO)
    logging.getLogger(__name__).info("runtime %s", json.dumps(runtime_facts(), ensure_ascii=False))

    # 같은 프로세스라 걸 수 있는 훅. LLM 모델의 다운로드 진행이 다른 모델과 똑같이
    # model_readiness로 올라간다 (Task 17).
    install_hf_progress_hook()

    # argv[0]은 남긴다 — argparse가 prog 이름으로 쓴다.
    sys.argv = [sys.argv[0], *_passthrough(sys.argv[1:])]
    server_main()


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: 실패하는 테스트를 쓴다**

`be/worker/tests/test_llm_entry.py`:

```python
from damwha_worker.llm_entry import _passthrough


def test_drops_run_id_only():
    argv = ["--run-id=abc-123", "--model", "m/x", "--host", "127.0.0.1", "--port", "9911"]
    assert _passthrough(argv) == ["--model", "m/x", "--host", "127.0.0.1", "--port", "9911"]


def test_keeps_everything_when_no_run_id():
    argv = ["--model", "m/x"]
    assert _passthrough(argv) == argv


def test_does_not_drop_a_value_that_merely_contains_run_id():
    # `--run-id`로 **시작하는** 토큰만 뺀다.
    argv = ["--model", "org/run-id-model"]
    assert _passthrough(argv) == argv
```

`be/worker/tests/test_llm_server.py`에 더한다 — **실제 시그니처는
`managed_llm_server(model, settings, *, popen, probe, monotonic, sleep)`다:**

```python
def test_starts_server_through_llm_entry_by_default(tmp_path):
    """기본값(빈 lens_llm_server_bin)이면 sys.executable의 llm_entry 모듈 진입이다."""
    seen = []

    class FakeProc:
        def poll(self): return None
        def terminate(self): pass
        def wait(self, timeout=None): return 0
        def kill(self): pass

    def popen(argv, **kw):
        seen.append(argv)
        return FakeProc()

    settings = _settings(lens_llm_server_bin="", lens_llm_base_url="http://127.0.0.1:9911")
    probes = iter([None, object()])   # 안 떠 있다 → 떴다
    with llm_server.managed_llm_server(
        "m/x", settings, popen=popen, probe=lambda url: next(probes),
        monotonic=lambda: 0.0, sleep=lambda s: None,
    ):
        pass

    assert seen[0][0] == sys.executable
    assert seen[0][1:3] == ["-m", "damwha_worker.llm_entry"]
    assert any(a.startswith("--run-id=") for a in seen[0]), "소유 표식이 argv에 있어야 한다"
    assert "--model" in seen[0]


def test_explicit_binary_still_wins(tmp_path):
    """값을 채우면 그것을 실행 파일로 그대로 쓴다 — 수동 운용·다른 백엔드용 탈출구."""
    exe = tmp_path / "my-server"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    seen = []

    class FakeProc:
        def poll(self): return None
        def terminate(self): pass
        def wait(self, timeout=None): return 0
        def kill(self): pass

    settings = _settings(lens_llm_server_bin=str(exe), lens_llm_base_url="http://127.0.0.1:9911")
    probes = iter([None, object()])
    with llm_server.managed_llm_server(
        "m/x", settings, popen=lambda a, **k: (seen.append(a), FakeProc())[1],
        probe=lambda url: next(probes), monotonic=lambda: 0.0, sleep=lambda s: None,
    ):
        pass

    assert seen[0][0] == str(exe)
    # 탈출구로 띄운 서버에는 표식이 없다 — 앱이 소유를 증명할 수 없다 (스펙 §6.5).
    assert not any(a.startswith("--run-id=") for a in seen[0])


def test_missing_explicit_binary_reports_the_setting_not_uv_tool(tmp_path):
    settings = _settings(lens_llm_server_bin="/nope/mlx_lm.server",
                         lens_llm_base_url="http://127.0.0.1:9911")
    with pytest.raises(WorkerError) as e:
        with llm_server.managed_llm_server(
            "m/x", settings, probe=lambda url: None,
            monotonic=lambda: 0.0, sleep=lambda s: None,
        ):
            pass
    msg = str(e.value)
    # 옛 문구는 `uv tool install mlx-lm`을 안내했다 — 번들에서는 틀린 안내다.
    assert "uv tool install" not in msg
    assert "LENS_LLM_SERVER_BIN" in msg
```

`_settings` 헬퍼가 없으면 기존 테스트의 설정 생성 방식을 그대로 쓴다.

- [ ] **Step 5: 실패를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_llm_entry.py tests/test_llm_server.py -v
```

- [ ] **Step 6: `config.py`와 `llm_server.py`를 함께 고친다**

`config.py`:

```python
    # 빈 문자열이 "번들 python의 모듈 진입(`-m damwha_worker.llm_entry`)을 쓴다"는 뜻이다.
    # 값을 채우면 그것을 실행 파일로 그대로 실행한다 — 수동 운용이나 다른 백엔드용 탈출구이고,
    # 그렇게 띄운 서버는 앱이 소유를 증명할 수 없다 (Electron Phase 4 스펙 §6.5).
    #
    # 옛 기본값 "mlx_lm.server"는 shutil.which가 PATH에서 찾는 콘솔 스크립트였고, 그것이 곧
    # 개발 머신의 uv tool 전역 설치 의존이었다 (스펙 §2.4).
    lens_llm_server_bin: str = ""
```

`llm_server.py`의 `binary = shutil.which(...)` 블록(`:92-100`)을 바꾼다:

```python
    if settings.lens_llm_server_bin == "":
        # 앱이 주입한 run-id를 그대로 물려준다. 없으면(웹 흐름) 붙이지 않는다.
        run_id = run_id_arg(sys.argv)
        argv_head = [sys.executable, "-m", "damwha_worker.llm_entry"]
        if run_id is not None:
            argv_head.append(f"--run-id={run_id}")
        shown = f"{sys.executable} -m damwha_worker.llm_entry"
    else:
        binary = shutil.which(settings.lens_llm_server_bin)
        if binary is None:
            raise WorkerError(
                LLM_SERVER_START_FAILED,
                f"LENS_LLM_SERVER_BIN이 가리키는 {settings.lens_llm_server_bin!r}를 실행할 수 "
                "없어요. 그 값을 비우면 번들에 들어 있는 mlx-lm을 씁니다. 서버를 직접 띄우려면 "
                "LENS_LLM_MANAGED=false로 두세요.",
                ErrorKind.PERMANENT,
            )
        argv_head = [binary]
        shown = binary

    log.info("starting LLM server: %s %s on %s:%s", shown, model, host, port)
    proc = popen([*argv_head, "--model", model,
                  "--chat-template-args", json.dumps({"enable_thinking": False}),
                  "--host", host, "--port", str(port)])
```

import를 더한다: `import sys`, `from .runtime_report import run_id_arg`.

- [ ] **Step 7: 통과를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_llm_entry.py tests/test_llm_server.py -v
pnpm worker:test
uv run --directory be/worker ruff check .
```

- [ ] **Step 8: 실제로 뜨는지 확인한다 (수동)**

```bash
# import가 부작용 없이 되는가 — 설정도 DB도 없이
env -u DATABASE_URL uv run --directory be/worker python -c \
  "import importlib.util as u; print(all(u.find_spec(m) for m in ('damwha_worker.embed_service','damwha_worker.llm_entry','mlx_lm.server')))"

# llm_entry가 mlx_lm.server의 인자를 그대로 받는가
uv run --directory be/worker python -m damwha_worker.llm_entry --run-id=probe --help 2>&1 | head -5
```

기대: 첫째가 `True`(부작용 없음). 둘째가 mlx_lm.server의 `--help`(run-id가 그쪽에 안 새고
argparse가 안 죽는다).

**Verify:** Step 7·8 통과.

**Review:**
- `embed_service` import가 **설정을 안 읽고 모델을 안 받는가** (Step 8 첫 명령이 그 증거).
- `health()`가 `_ready()`를 안 부르는가.
- `llm_entry`가 **중간 프로세스를 안 만드는가** (exec도 Popen도 없이 `main()` 직접 호출).
- `--run-id`가 `mlx_lm.server`에 안 새는가.
- 탈출구(`LENS_LLM_SERVER_BIN`)로 띄운 서버에 표식이 **없음을** 테스트가 확인하는가.
- 시그니처가 `managed_llm_server(model, settings, *, …)`인가.

- [ ] **Step 9: 커밋**

```bash
git add be/worker/damwha_worker/llm_entry.py be/worker/damwha_worker/embed_service.py \
        be/worker/damwha_worker/llm_server.py be/worker/damwha_worker/config.py \
        be/worker/tests/test_llm_entry.py be/worker/tests/test_llm_server.py
git commit -m "feat(worker): LLM 서버를 소유 표식이 남는 진입 모듈로 감싼다"
```

커밋 본문:

```
mlx_lm.server를 직접 부르면 두 가지가 다 안 된다 — upstream CLI라 --run-id를
주면 모르는 인자로 죽고, 안 주면 소유 표식이 없는 프로세스가 된다. 부모
트리로 판정하는 것도 못 한다: supervisor는 두 번째 신호에서 --once를
SIGKILL하고 os._exit하므로 둘 다 사라지면 훑을 트리가 없다.

그래서 llm_entry가 사이에 앉는다. run-id를 받아서 버리고, 나머지 인자로
sys.argv를 재구성해 같은 프로세스에서 mlx_lm.server.main()을 부른다. 중간
프로세스를 만들지 않아 uv 구조가 되살아나지 않고, 같은 프로세스라 HF
다운로드 훅을 걸 수 있다 — 별도 프로세스였다면 LLM 모델의 진행을 관측할
길이 없었다.

embed_service의 import 부작용도 함께 없앴다. 모듈 수준에서 load_settings()와
build_text_embedder()를 부르고 있어 import만으로 DATABASE_URL을 요구하고
bge-m3 2.2GB를 받았다 — 빌드의 진입점 확인이 그것을 건드릴 수 없었다.
```

## Task 9: worker — `--run-id` 수용·전파와 런타임 자기 보고

**Files:**
- Create: `be/worker/damwha_worker/runtime_report.py`
- Create: `be/worker/tests/test_runtime_report.py`
- Modify: `be/worker/damwha_worker/__main__.py`
- Modify: `be/worker/tests/test_worker_loop.py`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `run_id_arg(argv: list[str]) -> str | None` — argv에서 `--run-id=…`를 뽑는다.
  - `runtime_facts() -> dict` — `{executable, prefix, sys_path_head, version}`.
  - `--once` 자식이 부모의 `--run-id`를 물려받는다. Task 10의 고아 판정이 이것을 본다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_runtime_report.py`:

```python
import sys

from damwha_worker.runtime_report import run_id_arg, runtime_facts


def test_run_id_arg_picks_the_token():
    assert run_id_arg(["-m", "damwha_worker", "--run-id=abc-123"]) == "abc-123"


def test_run_id_arg_is_none_when_absent():
    assert run_id_arg(["-m", "damwha_worker", "--once"]) is None


def test_run_id_arg_ignores_a_bare_prefix():
    # `--run-id` 뒤에 =이 없으면 우리 형식이 아니다. 공백 분리형을 지원하지 않는 이유는
    # 앱이 언제나 `--run-id=<uuid>` 한 토큰으로 싣기 때문이다 (Phase 4 스펙 §6.5).
    assert run_id_arg(["--run-id", "abc"]) is None


def test_runtime_facts_reports_this_interpreter():
    f = runtime_facts()
    assert f["executable"] == sys.executable
    assert f["prefix"] == sys.prefix
    assert isinstance(f["sys_path_head"], list)
```

`be/worker/tests/test_worker_loop.py`에 자식 전파 테스트를 더한다 (기존 `_spawn` 접근 방식을 먼저 읽고 맞춘다):

```python
def test_once_child_inherits_run_id(monkeypatch):
    """--once 자식이 부모의 run-id를 물려받는다. 앱의 고아 정리가 이것을 본다."""
    import damwha_worker.__main__ as m

    seen = []
    monkeypatch.setattr(m.sys, "argv", ["-m", "damwha_worker", "--run-id=run-xyz"])
    monkeypatch.setattr(m.subprocess, "Popen", lambda argv, **kw: seen.append(argv) or object())

    m._spawn_once_child()

    assert seen[0][:4] == [m.sys.executable, "-m", "damwha_worker", "--once"]
    assert "--run-id=run-xyz" in seen[0]
```

- [ ] **Step 2: 실패를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_runtime_report.py tests/test_worker_loop.py -k "run_id or runtime_facts" -v
```

- [ ] **Step 3: `runtime_report.py`를 쓴다**

```python
"""이 프로세스가 **어느 런타임에서 도는지** 스스로 보고한다.

Electron Phase 4의 완료 기준 P4-C12가 "앱의 모든 Python 프로세스가 번들 런타임을 쓴다"인데,
번들 밖에서 도는 것과 안에서 도는 것은 겉보기가 같다 — 셔뱅 함정(Phase 0 R-6)은 죽지 않고
**조용히 다른 런타임을 실행한다.** 그래서 프로세스가 직접 말하게 한다.

`--run-id`는 앱이 argv에 싣는 소유 표식이다. env가 아닌 이유: `ps eww`는 SIP 때문에 다른
프로세스의 env를 내주지 않는다(2026-09-12 실측). worker는 이 값을 **읽어서 자식에게 넘기기만**
하고 자기 동작에 쓰지 않는다 — 유일한 독자는 앱이다.
"""

import sys

RUN_ID_PREFIX = "--run-id="


def run_id_arg(argv: list[str]) -> str | None:
    """argv에서 `--run-id=<값>`을 뽑는다. 없으면 None (웹 흐름이 그렇다)."""
    for token in argv:
        if token.startswith(RUN_ID_PREFIX):
            value = token[len(RUN_ID_PREFIX) :]
            return value or None
    return None


def runtime_facts() -> dict:
    """로그 한 줄로 찍을 사실들. sys_path는 앞 5개만 — 전체는 길고 판정에 필요한 것은
    '무엇이 site-packages보다 먼저 오는가'뿐이다(dev의 PYTHONPATH가 여기 보인다)."""
    return {
        "executable": sys.executable,
        "prefix": sys.prefix,
        "version": sys.version.split()[0],
        "sys_path_head": sys.path[:5],
    }
```

- [ ] **Step 4: `__main__.py`를 고친다**

(a) 자식 스폰을 함수로 꺼내고 run-id를 붙인다. 지금 `run_supervisor_main` 안의 `_spawn`을:

```python
def _spawn_once_child():
    """--once 자식. 모듈 수준 함수로 꺼내 테스트가 부를 수 있게 한다.

    sys.executable을 쓰므로 번들 python이 자동으로 승계된다 — 이 줄은 Phase 4에서
    고칠 것이 없었다. 더한 것은 run-id 전파뿐이다: 앱이 강제 종료된 뒤 남은 자식을
    다음 실행이 찾아 내리려면 자식도 표식을 갖고 있어야 한다 (Phase 4 스펙 §6.5).
    """
    argv = [sys.executable, "-m", "damwha_worker", "--once"]
    run_id = run_id_arg(sys.argv)
    if run_id is not None:
        argv.append(f"--run-id={run_id}")
    return subprocess.Popen(argv, start_new_session=True)
```

`run_supervisor_main` 안에서는 `def _spawn(): return _spawn_once_child()` 대신 `spawn_fn=_spawn_once_child`를 그대로 넘긴다.

(b) 자기 보고를 기동 로그에 더한다. `log.info("supervisor %s started", settings.worker_id)` **위에**:

```python
    # P4-C12가 읽는 줄이다. 번들 밖 런타임에서 도는 것과 안에서 도는 것은 겉보기가 같으므로
    # 프로세스가 직접 말하게 한다 (runtime_report 독스트링).
    log.info("runtime %s", json.dumps(runtime_facts(), ensure_ascii=False))
```

`run_child()`(= `--once` 자식) 첫머리에도 같은 줄을 넣는다 — 자식은 별도 프로세스라 부모의 보고가 그것을 증명하지 못한다.

import를 더한다: `import json`, `from .runtime_report import run_id_arg, runtime_facts`.

(c) `main()`의 argv 처리는 **건드리지 않는다**. `"--once" in sys.argv[1:]`는 모르는 인자가 있어도 안전하다.

- [ ] **Step 5: `capabilities.py`의 프로브에도 자기 보고를 넣는다**

`capabilities.py:68`의 `[sys.executable, "-c", _PROBE_CODE]`는 **별도 프로세스**다 — 부모의
보고가 그것을 증명하지 못한다. P4-C12가 다섯 프로세스를 전부 요구하므로 `_PROBE_CODE`에 한
줄을 더한다:

```python
# 프로브가 찍는 마지막 줄. 부모가 stdout에서 JSON을 파싱하므로 **stderr로** 보낸다 —
# stdout에 섞으면 기존 파싱이 깨진다 (P4-C12는 로그만 읽으면 된다).
_PROBE_CODE = _PROBE_CODE + '''
import sys as _s, json as _j
print("runtime " + _j.dumps({"executable": _s.executable, "prefix": _s.prefix}), file=_s.stderr)
'''
```

실제 형태는 `_PROBE_CODE`의 지금 모양을 읽고 맞춘다 (`sed -n '40,80p' be/worker/damwha_worker/capabilities.py`).
**stdout을 건드리면 안 된다** — 부모가 그것을 JSON으로 파싱한다.

`embed_service.py`의 자기 보고는 **Task 8이 이미 넣었다** (`main()` 안, `_ready()` 앞).

- [ ] **Step 6: 통과를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_runtime_report.py -v
pnpm worker:test
uv run --directory be/worker ruff check .
```

- [ ] **Step 7: 실제 로그를 눈으로 본다**

```bash
uv run --directory be/worker python -m damwha_worker --run-id=probe-1 2>&1 | head -5
```

기대: `runtime {"executable": …, "prefix": …, "sys_path_head": [...]}` 한 줄. (DB가 없으면 그 뒤에 접속 실패가 나온다 — 그것은 무관하다.)

**Verify:** Step 6·7 통과.

**Review:**
- worker가 `--run-id`를 **읽어 넘기기만** 하고 자기 동작에 안 쓰는가.
- `--once` 자식과 embed **둘 다** 자기 보고를 하는가 (별도 프로세스라 부모 보고로는 증명이 안 된다).
- `main()`의 `"--once" in sys.argv[1:]`를 안 건드렸는가.
- `sys_path_head`가 5개로 잘리는가 (전체는 길고 판정에 불필요).

- [ ] **Step 8: 커밋**

```bash
git add be/worker/damwha_worker/runtime_report.py be/worker/damwha_worker/__main__.py \
        be/worker/damwha_worker/embed_service.py be/worker/tests/test_runtime_report.py \
        be/worker/tests/test_worker_loop.py
git commit -m "feat(worker): run-id를 자식에게 전파하고 런타임을 스스로 보고한다"
```

커밋 본문:

```
--run-id는 앱이 argv에 싣는 소유 표식이다. env가 아닌 이유는 ps eww가 SIP
때문에 다른 프로세스의 env를 내주지 않기 때문이다. worker는 읽어서 --once
자식에게 넘기기만 하고 자기 동작에 쓰지 않는다 — 유일한 독자는 앱이다.
앱이 강제 종료된 뒤 남은 자식을 다음 실행이 찾아 내리려면 자식도 표식을
갖고 있어야 한다.

런타임 자기 보고는 완료 기준 P4-C12가 읽는다. 번들 밖에서 도는 것과 안에서
도는 것은 겉보기가 같다 — 셔뱅 함정은 죽지 않고 조용히 다른 런타임을
실행하므로, 프로세스가 직접 말하게 한다. --once 자식과 embed도 각자 찍는다.
별도 프로세스라 부모의 보고가 그것을 증명하지 못한다.
```

---

## Task 10: `runtime-paths.ts` — 앱이 아는 절대 경로

**Files:**
- Create: `desktop/src/process/runtime-paths.ts`
- Create: `desktop/tests/process/runtime-paths.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 모듈 — electron을 import하지 않는다)
- Produces:
  - `export const PY_MINOR = "3.12"`
  - `export interface PythonBinaries { python: string; sitePackages: string }`
  - `export interface FfmpegBinaries { ffmpeg: string; ffprobe: string }`
  - `export function pythonBinaries(bundleDir: string): PythonBinaries`
  - `export function ffmpegBinaries(bundleDir: string): FfmpegBinaries`
  Task 11·12·13·15가 전부 이것을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/process/runtime-paths.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ffmpegBinaries, PY_MINOR, pythonBinaries } from "../../src/process/runtime-paths";

describe("pythonBinaries", () => {
  it("번들 디렉터리 아래의 절대 경로를 만든다", () => {
    const b = pythonBinaries("/Apps/Damwha.app/Contents/Resources/python");
    expect(b.python).toBe("/Apps/Damwha.app/Contents/Resources/python/bin/python3.12");
    expect(b.sitePackages).toBe(
      `/Apps/Damwha.app/Contents/Resources/python/lib/python${PY_MINOR}/site-packages`,
    );
  });

  it("dev 스테이징 자리에도 같은 모양으로 붙는다", () => {
    expect(pythonBinaries("/repo/desktop/build/python").python)
      .toBe("/repo/desktop/build/python/bin/python3.12");
  });
});

describe("ffmpegBinaries", () => {
  it("두 실행 파일 경로를 만든다", () => {
    const b = ffmpegBinaries("/r/ffmpeg");
    expect(b.ffmpeg).toBe("/r/ffmpeg/bin/ffmpeg");
    expect(b.ffprobe).toBe("/r/ffmpeg/bin/ffprobe");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- runtime-paths
```

기대: FAIL — 모듈 없음.

- [ ] **Step 3: 구현한다**

`desktop/src/process/runtime-paths.ts`:

```typescript
import * as path from "path";

/**
 * 번들 Python·ffmpeg의 배치 (Electron Phase 4 스펙 §6.1). electron을 import하지 않는 순수
 * 모듈이다 — `services/postgres/layout.ts`의 `pgBinaries`와 같은 자리, 같은 이유다
 * (electron을 값으로 import하는 파일은 vitest가 못 불러온다).
 *
 * 번들 디렉터리 자체(packaged는 `process.resourcesPath/python`, dev는
 * `<appPath>/build/python`)는 main.ts가 정해 넘긴다. 이 모듈은 그 아래의 모양만 안다.
 */

/** 인터프리터 파일 이름과 site-packages 경로에 들어간다. build-python.sh의 PY_VERSION과 짝이다. */
export const PY_MINOR = "3.12";

export interface PythonBinaries {
  /**
   * 모든 Python 진입의 argv[0]. 콘솔 스크립트(bin/damwha-worker 등)를 부르지 않는 이유는
   * 그것이 셔뱅을 타기 때문이다 — 옛 경로가 남아 있으면 죽지 않고 조용히 다른 런타임을
   * 실행한다 (Phase 0 R-6). `-m`은 셔뱅을 안 탄다.
   */
  python: string;
  /** 고아 판정이 "이 프로세스가 번들 트리에서 왔는가"를 볼 때 쓴다 (스펙 §6.5 조건 3). */
  sitePackages: string;
}

export function pythonBinaries(bundleDir: string): PythonBinaries {
  return {
    python: path.join(bundleDir, "bin", `python${PY_MINOR}`),
    sitePackages: path.join(bundleDir, "lib", `python${PY_MINOR}`, "site-packages"),
  };
}

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * worker가 이 둘을 `FFMPEG_BIN`·`FFPROBE_BIN`으로 받아 호출 시점에 읽는다
 * (be/worker/damwha_worker/pipeline/ffmpeg.py의 `_bin`). 그 전에는 `["ffmpeg", …]`
 * 리터럴이라 개발 도구가 없는 맥에서 찾지 못했다 (Phase 2 스펙 §15의 인계 항목).
 */
export function ffmpegBinaries(bundleDir: string): FfmpegBinaries {
  return {
    ffmpeg: path.join(bundleDir, "bin", "ffmpeg"),
    ffprobe: path.join(bundleDir, "bin", "ffprobe"),
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- runtime-paths
pnpm --filter damwha-desktop run lint
```

**Verify:** 두 명령 통과.

**Review:**
- electron을 import하지 않는가.
- `PY_MINOR`가 `build-python.sh`의 `PY_VERSION`과 짝인가 — 어긋나면 런타임에 "파일 없음"으로만 드러난다.

- [ ] **Step 5: 커밋**

```bash
git add desktop/src/process/runtime-paths.ts desktop/tests/process/runtime-paths.test.ts
git commit -m "feat(desktop): 번들 Python·ffmpeg 경로 모듈을 더한다"
```

커밋 본문:

```
Phase 3의 pgBinaries와 같은 모양이다 — PATH 탐색이 아니라 앱이 아는 절대
경로. electron을 import하지 않아 테스트가 부를 수 있다.

sitePackages를 함께 내보내는 이유는 고아 판정이 '이 프로세스가 번들
트리에서 왔는가'를 봐야 하기 때문이다.
```

---

## Task 11: `python-launcher.ts` — `uv-launcher.ts` 대체

**Files:**
- Create: `desktop/src/process/python-launcher.ts`
- Create: `desktop/tests/process/python-launcher.test.ts`
- Modify: `desktop/src/services/types.ts` (`LaunchContext`)
- Modify: `desktop/src/diagnostics/causes.ts` (`pythonMissing`·`ffmpegMissing`)
- Delete: `desktop/src/process/uv-launcher.ts`, `desktop/tests/process/uv-launcher.test.ts`

**Interfaces:**
- Consumes: Task 10의 `pythonBinaries`·`ffmpegBinaries`
- Produces:
  - `export interface PythonLaunchOptions { ctx: LaunchContext; module: string; args?: readonly string[]; logId: "worker" | "embed"; extraEnv?: Record<string, string>; spawnFn?: SpawnFn; onStderr?: (t: string) => void }`
  - `export function launchPython(o: PythonLaunchOptions): LaunchResult`
  - `LaunchContext`가 `repoRoot: string | null`, `bins: { python: string; ffmpeg: string; ffprobe: string }`, `runId: string`을 갖는다.
  Task 13이 이것으로 worker·embed 어댑터를 다시 쓴다.

**옛 런처를 이 Task에서 지우지 않는다.** 초안은 여기서 `uv-launcher.ts`를 `git rm`해
Task 13까지 컴파일이 깨진 상태를 남겼는데, 로드맵 §5는 **필수 검증 실패가 다음 단계 진행을
막는다**고 못 박는다. 중간 상태가 초록불이 아니면 그 단계는 리뷰할 수 없다.

대신 **공존시킨다** — 새 런처를 더하고, Task 13이 소비자를 옮긴 뒤, **Task 13이 옛 것을
지운다.** `LaunchContext`도 같은 방식이다: `bins`에 새 키를 더하되 `uv`를 남겨 두고(옵셔널),
Task 13이 마지막 소비자를 옮긴 뒤 뺀다. 이 Task는 `test`·`lint` 둘 다 통과한 상태로 끝난다.

- [ ] **Step 1: 지금 런처를 읽는다**

```bash
cat desktop/src/process/uv-launcher.ts
cat desktop/tests/process/uv-launcher.test.ts
sed -n '40,75p' desktop/src/diagnostics/causes.ts
```

보존할 것: `makeSink`/`sinkTails`, stdout·stderr 분리, `detached: true`, `'error'` 리스너, `settle()`, 핸들 모양(`pid`·`alive`·`stderrTail`·`exitCode`·`onExit`·`stop`).
버릴 것: `ctx.bins.uv` 확인, `uv run --directory` 인자, "uv pid로 SIGTERM" 우회 주석.

- [ ] **Step 2: `LaunchContext`를 고친다**

`desktop/src/services/types.ts`:

```typescript
export interface LaunchContext {
  /**
   * dev 전용. packaged는 저장소를 보지 않는다 (Phase 4 스펙 §6.3).
   *
   * **nullable로 바꾸는 것은 Task 12다** — 이 Task는 `bins`만 더한다. 여기서 같이 바꾸면
   * `api.ts:172`(`path.join(root, "dist", "main.js")`)와 마이그레이션 러너가 그 자리에서
   * 타입 오류를 내고, 그것을 고치는 것은 Task 12의 범위다.
   */
  repoRoot: string;
  userData: string;
  packaged: boolean;
  env: ApiEnv;
  /**
   * 앱이 아는 절대 경로. uv는 Phase 4에서 런타임 의존이 아니게 된다 — 빌드 도구로만 남는다.
   *
   * `uv`를 **아직 남겨 둔다.** 마지막 소비자(worker·embed 어댑터)를 Task 13이 옮긴 뒤 그
   * Task가 뺀다. 여기서 빼면 이 Task가 컴파일되지 않는 상태로 끝난다.
   */
  bins: { python: string; ffmpeg: string; ffprobe: string; uv: string | null };
  /**
   * 이 **실행**의 식별자. 앱이 띄우는 모든 Python 프로세스가 argv에 `--run-id=<이 값>`을
   * 갖는다. env가 아니라 argv인 이유: `ps eww`는 SIP 때문에 다른 프로세스의 env를 내주지
   * 않는다(2026-09-12 실측). `ps -o args`는 argv를 내준다.
   *
   * `WORKER_ID`와 별개다 — 그것은 worker 전용이라 embed·`--once` 자식을 덮지 않는다.
   */
  runId: string;
  /** **앱 자신의** 도구 탐색용. 자식 env에는 가지 않는다 (스펙 §6.2). */
  searchDirs: readonly string[];
  logFile(id: ServiceId): string;
  signal: AbortSignal;
}
```

- [ ] **Step 3: 실패하는 테스트를 쓴다**

`desktop/tests/process/python-launcher.test.ts`:

```typescript
import { EventEmitter } from "events";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { launchPython } from "../../src/process/python-launcher";
import type { LaunchContext } from "../../src/services/types";

type Spawned = [string, string[], { env: Record<string, string>; detached: boolean; stdio: unknown; cwd: string }];

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & {
    pid?: number; stdout: EventEmitter; stderr: EventEmitter; kill: (s: string) => boolean;
  };
  c.pid = 4242;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => true;
  return c;
}

function ctx(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    repoRoot: null,
    userData: os.tmpdir(),
    packaged: true,
    env: { DATABASE_URL: "postgres:///x" },
    bins: { python: "/b/python/bin/python3.12", ffmpeg: "/b/ffmpeg/bin/ffmpeg", ffprobe: "/b/ffmpeg/bin/ffprobe" },
    runId: "run-abc",
    searchDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    logFile: (id) => path.join(os.tmpdir(), `p4-${id}.log`),
    signal: new AbortController().signal,
    ...over,
  };
}

function calls(fn: unknown): Spawned[] {
  return (fn as { mock: { calls: Spawned[] } }).mock.calls;
}

describe("launchPython", () => {
  it("번들 python을 -m 모듈 진입으로 부르고 run-id를 argv 끝에 싣는다", () => {
    const spawnFn = vi.fn(() => fakeChild()) as never;
    launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    const [bin, argv] = calls(spawnFn)[0];
    expect(bin).toBe("/b/python/bin/python3.12");
    expect(argv).toEqual(["-m", "damwha_worker", "--run-id=run-abc"]);
  });

  it("추가 인자는 모듈 뒤, run-id 앞에 온다", () => {
    const spawnFn = vi.fn(() => fakeChild()) as never;
    launchPython({ ctx: ctx(), module: "damwha_worker", args: ["--once"], logId: "worker", spawnFn });
    expect(calls(spawnFn)[0][1]).toEqual(["-m", "damwha_worker", "--once", "--run-id=run-abc"]);
  });

  it("자식 PATH가 번들 두 경로뿐이다 — 개발 도구 폴백을 주지 않는다", () => {
    const spawnFn = vi.fn(() => fakeChild()) as never;
    launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    const { env } = calls(spawnFn)[0][2];
    expect(env.PATH).toBe("/b/python/bin:/b/ffmpeg/bin");
    expect(env.PATH).not.toContain("/opt/homebrew");
    expect(env.PATH).not.toContain("/usr/local");
  });

  it("cwd가 userData다 — packaged에는 저장소가 없다", () => {
    const spawnFn = vi.fn(() => fakeChild()) as never;
    launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    expect(calls(spawnFn)[0][2].cwd).toBe(os.tmpdir());
  });

  it("detached로 띄우고 stdout·stderr를 나눠 받는다", () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const seen: string[] = [];
    launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn, onStderr: (t) => seen.push(t) });
    const opts = calls(spawnFn)[0][2];
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    child.stderr.emit("data", Buffer.from("supervisor w ready (db connected)\n"));
    expect(seen).toEqual(["supervisor w ready (db connected)\n"]);
  });

  it("spawn 실패('error')를 종료로 접어 main을 죽이지 않는다", () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child) as never;
    const r = launchPython({ ctx: ctx(), module: "damwha_worker", logId: "worker", spawnFn });
    child.emit("error", new Error("ENOENT"));
    expect(r.handle?.alive()).toBe(false);
    expect(r.handle?.exitCode()).toBe(-1);
    expect(r.handle?.stderrTail()).toContain("ENOENT");
  });

  it("python 경로가 비면 원인을 적어 던진다", () => {
    expect(() =>
      launchPython({
        ctx: ctx({ bins: { python: "", ffmpeg: "", ffprobe: "" } }),
        module: "damwha_worker",
        logId: "worker",
      }),
    ).toThrow(/Python/);
  });
});
```

- [ ] **Step 4: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- python-launcher
```

- [ ] **Step 5: `causes.ts`에 두 원인을 더한다**

기존 항목의 정확한 모양(`text`·`hint` 키 이름)을 Step 1에서 읽은 대로 맞춘다:

```typescript
  pythonMissing: {
    text: "내장 Python 실행 파일이 없어요.",
    hint: "앱을 다시 설치해 주세요. 개발 중이면 `bash desktop/scripts/build-python.sh`를 실행한 뒤 다시 시도해 주세요.",
  },
  ffmpegMissing: {
    text: "내장 ffmpeg 실행 파일이 없어요.",
    hint: "앱을 다시 설치해 주세요. 개발 중이면 `bash desktop/scripts/build-ffmpeg.sh`를 실행한 뒤 다시 시도해 주세요.",
  },
```

- [ ] **Step 6: `python-launcher.ts`를 쓴다**

```typescript
import { spawn } from "child_process";
import * as path from "path";
import { CAUSES } from "../diagnostics/causes";
import type { LaunchContext, LaunchResult } from "../services/types";
import { makeSink, sinkTails } from "./output";
import type { SpawnFn } from "./tool-runner";

export interface PythonLaunchOptions {
  ctx: LaunchContext;
  /** `-m` 뒤에 올 모듈. `damwha_worker` 또는 `damwha_worker.embed_service`. */
  module: string;
  /** 모듈 뒤에 붙는 인자. `--run-id`는 런처가 마지막에 스스로 붙인다. */
  args?: readonly string[];
  logId: "worker" | "embed";
  extraEnv?: Record<string, string>;
  /**
   * 실제 `child_process.spawn` 대신 부를 함수. 테스트가 여기에 가짜를 주입해 detached·
   * 'error' 리스너·스트림 분리를 진짜 프로세스 없이 검증한다 — 그 셋이 가장 조용히 깨지는
   * 지점이라는 것은 Phase 2가 실측했다(셋 중 무엇을 지워도 기존 179개 테스트가 전부 통과했다).
   */
  spawnFn?: SpawnFn;
  /** stderr 청크를 싱크와 같은 순서로 받는다. worker의 ReadinessWatch가 여기 붙는다. */
  onStderr?: (text: string) => void;
}

/**
 * 번들 Python을 **절대 경로 + `-m` 모듈 진입**으로 부른다 (Electron Phase 4 스펙 §6.2).
 *
 * `uv run --directory`를 쓰던 것이 Phase 3까지다. 그 런처가 하던 셋 중 둘은 사라지고
 * 하나는 옮겨 갔다 — (1) 프로젝트 환경 선택은 빌드가 한다(build-python.sh), (2) cwd 고정은
 * 필요 없다(worker가 경로를 절대값으로 받는다), (3) "uv pid로 SIGTERM, 그룹이 아니라"는
 * 우회도 필요 없다. 중간 프로세스가 없어 신호가 Python에 바로 닿는다.
 *
 * **콘솔 스크립트를 부르지 않는다.** `bin/damwha-worker`는 셔뱅을 타고, 옛 경로가 남아
 * 있으면 죽지 않고 조용히 다른 런타임을 실행한다 (Phase 0 R-6).
 */
export function launchPython(options: PythonLaunchOptions): LaunchResult {
  const { ctx, module, logId } = options;
  if (ctx.bins.python === "") throw new Error(CAUSES.pythonMissing.text);

  // stdout과 stderr를 합치지 않는다. worker의 ready 줄은 stderr에 나오고(console.py:110),
  // embed(uvicorn)의 접근 로그는 stdout에 나온다 — 합치면 readiness()가 읽는 stderrTail()에
  // 30초 헬스 프로브와 검색 요청마다 접근 로그가 섞여, 정작 죽었을 때 봐야 할 트레이스백을
  // 그 노이즈가 밀어낸다 (Phase 2 실측).
  const sink = makeSink(ctx.logFile(logId));
  const spawnFn = options.spawnFn ?? spawn;
  const argv = ["-m", module, ...(options.args ?? []), `--run-id=${ctx.runId}`];

  const child = spawnFn(ctx.bins.python, argv, {
    // 저장소가 아니라 사용자 데이터 폴더다. packaged에는 저장소가 없고, worker에 cwd 상대
    // 경로로 의존하는 코드가 없다. 단 pydantic Settings가 cwd의 .env를 읽으므로
    // (config.py:9) 앱은 여기에 .env를 만들지 않고, main.ts가 기동 시 있으면 경고한다.
    cwd: ctx.userData,
    stdio: ["ignore", "pipe", "pipe"],
    // 자기 프로세스 그룹을 갖게 한다. 없으면 Python이 **Electron의** 그룹에 들어가,
    // dev 터미널의 Ctrl-C 같은 그룹 신호가 우리 종료 절차를 거치지 않고 곧바로 닿는다.
    detached: true,
    env: {
      ...process.env,
      ...ctx.env,
      ...options.extraEnv,
      // **개발 도구 폴백을 주지 않는다** (스펙 §6.2). 완료 기준이 "번들 외부를 참조하지
      // 않음"인데 폴백이 남아 있으면 Homebrew ffmpeg가 조용히 쓰여도 검증이 통과하고,
      // lsof 스냅숏으로는 그것을 확정적으로 부정할 수 없다. 참조 경로 자체를 없앤다.
      PATH: `${path.dirname(ctx.bins.python)}:${path.dirname(ctx.bins.ffmpeg)}`,
    },
  });

  let code: number | null = null;
  const listeners: Array<(c: number) => void> = [];
  const settle = (c: number) => {
    if (code !== null) return;
    code = c;
    sink.close();
    for (const l of listeners) {
      try {
        l(c);
      } catch {
        // 알릴 곳이 없다. 자식은 이미 죽었다.
      }
    }
  };

  child.stdout?.on("data", (b: Buffer) => sink.write(b, false));
  child.stderr?.on("data", (b: Buffer) => {
    sink.write(b, true);
    options.onStderr?.(b.toString());
  });
  child.on("exit", (c) => settle(c ?? 0));
  // spawn 실패는 'exit'가 아니라 'error'로 온다. 리스너가 없으면 Electron main이 통째로 죽는다.
  child.on("error", (e: Error) => {
    sink.write(`spawn failed: ${e.message}\n`, true);
    settle(-1);
  });

  const pid = child.pid;
  const signalChild = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 이미 죽었다.
      }
    }
  };

  return {
    owned: true,
    handle: {
      get pid() {
        return pid;
      },
      alive: () => code === null,
      ...sinkTails(sink),
      exitCode: () => code,
      onExit(listener: (c: number) => void) {
        if (code !== null) listener(code);
        else listeners.push(listener);
      },
      async stop(graceMs: number) {
        if (code !== null) return;
        signalChild("SIGTERM");
        const until = Date.now() + graceMs;
        while (code === null && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
      },
    },
  };
}
```

- [ ] **Step 7: 통과를 확인한다 — 옛 런처는 그대로 둔다**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

기대: **둘 다 통과.** 옛 `uv-launcher.ts`와 그 테스트가 아직 살아 있고 소비자도 그대로라
이 Task는 초록불로 끝난다. 삭제는 Task 13이 한다.

**Verify:** `python-launcher` 테스트 7개 + 기존 테스트 전부 통과, `lint` 통과.

**Review:**
- `--run-id`가 argv **마지막**에 오는가 (모듈 자신의 인자와 안 섞이게).
- PATH에 `searchDirs`가 안 들어가는가.
- `'error'` 리스너가 있는가.
- stdout·stderr를 안 합치는가.
- `detached: true`가 남았는가.
- `cwd`가 `userData`인가.

- [ ] **Step 8: 커밋**

```bash
git add desktop/src/process/python-launcher.ts desktop/tests/process/python-launcher.test.ts \
        desktop/src/services/types.ts desktop/src/diagnostics/causes.ts
git commit -m "feat(desktop): 번들 Python 런처를 더한다 (옛 uv 런처와 공존)"
```

커밋 본문:

```
uv run --directory가 하던 셋 중 둘은 사라지고 하나는 옮겨 갔다 — 프로젝트
환경 선택은 빌드가 하고(build-python.sh), cwd 고정은 필요 없으며(worker가
경로를 절대값으로 받는다), 'uv pid로 SIGTERM' 우회도 중간 프로세스가 없어
불필요하다.

콘솔 스크립트가 아니라 -m 모듈로 부른다. 콘솔 스크립트는 셔뱅을 타고,
옛 경로가 남아 있으면 죽지 않고 조용히 다른 런타임을 실행한다.

자식 PATH에 개발 도구 폴백을 주지 않는다. 완료 기준이 '번들 외부 미참조'인데
폴백이 남으면 Homebrew ffmpeg가 조용히 쓰여도 검증이 통과하고, lsof
스냅숏으로는 그것을 확정적으로 부정할 수 없다 — 참조 경로 자체를 없앤다.

옛 uv 런처는 아직 지우지 않는다. 소비자를 옮긴 뒤 다음 커밋이 지운다 —
중간에 컴파일이 깨진 커밋을 남기지 않기 위해서다.
```

---

## Task 12: 설정·경로 계약 — env 위생과 packaged 저장소 게이트 제거

**Files:**
- Modify: `desktop/src/config/config.ts`
- Modify: `desktop/src/config/repo-root.ts`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/tests/config/config.test.ts`
- Create: `desktop/tests/config/child-env.test.ts`

**Interfaces:**
- Consumes: Task 10의 `pythonBinaries`·`ffmpegBinaries`
- Produces:
  - `export const STRIPPED_CHILD_ENV_KEYS: readonly string[]`
  - `export function sanitizeChildEnv(inherited: Record<string, string | undefined>): Record<string, string>`
  - `loadConfig`가 `uvBin`을 더 이상 내보내지 않는다.
  Task 13·15가 이것을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/config/child-env.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { sanitizeChildEnv, STRIPPED_CHILD_ENV_KEYS } from "../../src/config/config";

describe("sanitizeChildEnv", () => {
  it("번들 인터프리터의 prefix 해석을 흔드는 키를 지운다", () => {
    const out = sanitizeChildEnv({ PYTHONHOME: "/opt/py", PYTHONSTARTUP: "/x", PATH: "/usr/bin" });
    expect(out.PYTHONHOME).toBeUndefined();
    expect(out.PYTHONSTARTUP).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("다른 가상환경을 가리키는 키를 지운다", () => {
    const out = sanitizeChildEnv({ VIRTUAL_ENV: "/repo/be/worker/.venv", CONDA_PREFIX: "/c" });
    expect(out.VIRTUAL_ENV).toBeUndefined();
    expect(out.CONDA_PREFIX).toBeUndefined();
  });

  it("HF_HOME보다 구체적인 캐시 변수를 지운다", () => {
    // HF_HOME 하나가 모두를 이긴다는 근거가 없다 — 더 구체적인 변수가 있으면 그것이 이긴다.
    const out = sanitizeChildEnv({ HF_HUB_CACHE: "/a", TRANSFORMERS_CACHE: "/b", TORCH_HOME: "/c", XDG_CACHE_HOME: "/d" });
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("PYTHONPATH를 지운다 — dev만 뒤에서 다시 넣는다", () => {
    expect(sanitizeChildEnv({ PYTHONPATH: "/somewhere" }).PYTHONPATH).toBeUndefined();
  });

  it("undefined 값은 넘기지 않는다", () => {
    const out = sanitizeChildEnv({ FOO: undefined, BAR: "1" });
    expect("FOO" in out).toBe(false);
    expect(out.BAR).toBe("1");
  });

  it("지우는 키 목록이 비어 있지 않다", () => {
    expect(STRIPPED_CHILD_ENV_KEYS.length).toBeGreaterThan(0);
  });
});
```

`desktop/tests/config/config.test.ts`에 더한다:

```typescript
it("config.json의 UV_BIN은 note로만 남는다 — Phase 4부터 앱은 uv를 부르지 않는다", () => {
  const dir = mkTmpUserData({ UV_BIN: "/opt/homebrew/bin/uv" });
  const cfg = loadConfig(dir);
  expect(cfg.env.UV_BIN).toBeUndefined();
  expect(cfg.notes.join(" ")).toContain("uv");
  expect(cfg.warning).toBeUndefined();   // 화면 경고로 올리지 않는다
});

it("config.json의 HF_TOKEN은 앱 소유 키라 무시하고 경고한다", () => {
  const dir = mkTmpUserData({ HF_TOKEN: "hf_secret_value" });
  const cfg = loadConfig(dir);
  expect(cfg.env.HF_TOKEN).toBeUndefined();
  expect(cfg.warning).toContain("HF_TOKEN");
  // 값 자체는 경고에 안 싣는다 — 비밀이다.
  expect(cfg.warning).not.toContain("hf_secret_value");
});
```

(`mkTmpUserData` 헬퍼가 없으면 기존 테스트의 준비 방식을 그대로 쓴다.)

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- config child-env
```

- [ ] **Step 3: `config.ts`를 고친다**

(a) `APP_SETTING_KEYS`에서 `UV_BIN`을 뺀다:

```typescript
const APP_SETTING_KEYS = ["REPO_ROOT", "EXTRA_PATH", "DEBUG_EXTERNAL_DATABASE_URL"];
```

(b) `DOCKER_BIN` 처리 옆에 `UV_BIN`을 더한다:

```typescript
    if (key === "UV_BIN") {
      // Phase 4부터 uv는 빌드 도구일 뿐이다. 이 키를 고쳐도 "다시 시도"에 반영되지 않는
      // 문제(Phase 2 결과 §5-2)도 키가 사라지면서 함께 없어졌다.
      notes.push("config.json의 UV_BIN은 쓰지 않아요 — Phase 4부터 앱은 번들 Python을 직접 부릅니다.");
      continue;
    }
```

(c) `APP_OWNED_KEYS`에 `HF_TOKEN`을 더한다. **값을 경고에 싣지 않게** 분기한다:

```typescript
const APP_OWNED_KEYS = ["HOST", "EMBED_SERVICE_HOST", "HF_TOKEN"];
```

`APP_OWNED_KEYS` 경고 분기에서:

```typescript
    if (APP_OWNED_KEYS.includes(key)) {
      // HF_TOKEN은 비밀이다 — 화면과 supervisor.log에 남는 문구라 값을 옮기지 않는다.
      // 앱은 이 값을 Keychain에서만 읽는다 (Phase 4 스펙 §6.4).
      warnings.push(
        key === "HF_TOKEN"
          ? "config.json의 HF_TOKEN은 쓰지 않아요 — 토큰은 설정 화면에서 넣으면 Keychain에 안전하게 보관됩니다. 파일에 적은 값은 지워 주세요."
          : `config.json의 ${key}는 앱이 ${LOOPBACK}으로 고정합니다. 파일 값은 무시했습니다: ${JSON.stringify(value)}`,
      );
      continue;
    }
```

(d) `LoadedConfig`에서 `uvBin`을 지우고, `sanitizeChildEnv`를 더한다:

```typescript
/**
 * 자식 Python에게 **물려주지 않는** 키 (Electron Phase 4 스펙 §6.3).
 *
 * dev 터미널에서 띄운 Electron은 개발자의 전체 환경을 갖고 있다. 그것을 그대로 넘기면
 * 번들 인터프리터가 남의 prefix·가상환경·캐시를 보게 되고, 그 결과는 오류가 아니라
 * **조용한 오작동**이다 — 완료 기준 "번들 외부를 참조하지 않음"이 정확히 그것을 막는다.
 */
export const STRIPPED_CHILD_ENV_KEYS = [
  // 번들 인터프리터의 prefix 해석을 흔든다.
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  // 다른 환경을 가리킨다.
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  // HF_HOME 하나가 모두를 이긴다는 근거가 없다. 더 구체적인 변수가 있으면 그것이 이긴다.
  "HF_HUB_CACHE",
  "TRANSFORMERS_CACHE",
  "TORCH_HOME",
  "XDG_CACHE_HOME",
  // dev 전용이다. packaged로 새면 §6.7의 격리가 무너진다 — dev만 뒤에서 다시 넣는다.
  "PYTHONPATH",
] as const;

export function sanitizeChildEnv(inherited: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inherited)) {
    if (v === undefined) continue;
    if ((STRIPPED_CHILD_ENV_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}
```

**씻는 자리가 중요하다.** 상속분만 씻고 `ctx.env`를 뒤에 합치면 구멍이 남는다 —
`config.json`이 임의 문자열 키를 그대로 통과시키므로(`config.ts:299-300`) 사용자가
`PYTHONHOME`이나 `HF_HUB_CACHE`를 **다시 넣을 수 있다** (스펙 §6.3). 그래서
**합친 뒤에 씻고, 앱이 주장하는 값만 그 뒤에 얹는다:**

```typescript
      ...sanitizeChildEnv({ ...process.env, ...ctx.env, ...options.extraEnv }),
      // 앱이 **의도적으로** 넣는 값은 금지 목록보다 뒤다. HF_HOME과 dev PYTHONPATH가
      // 씻겨 나가면 안 된다.
      ...appOwnedChildEnv(ctx),
      PATH: `${path.dirname(ctx.bins.python)}:${path.dirname(ctx.bins.ffmpeg)}`,
```

`appOwnedChildEnv(ctx)`는 `HF_HOME`·`FFMPEG_BIN`·`FFPROBE_BIN`·`LENS_LLM_BASE_URL`·
`DAMWHA_SHARED_STATE`와 dev의 `PYTHONPATH`를 돌려준다.

그리고 `loadConfig`가 금지 키를 **버리고 경고한다** — 조용히 무시하면 사용자는 자기가 적은
값이 왜 안 먹는지 알 길이 없다(`EXTRA_PATH`·`HOST`가 이미 그 규칙을 쓴다).

- [ ] **Step 3-b: `config.json`의 금지 키를 거절하는 테스트를 더한다**

```typescript
it("config.json으로 금지 env를 다시 넣을 수 없다 (P4-C30)", () => {
  const dir = mkTmpUserData({ PYTHONHOME: "/opt/py", HF_HUB_CACHE: "/tmp/x" });
  const cfg = loadConfig(dir);
  expect(cfg.env.PYTHONHOME).toBeUndefined();
  expect(cfg.env.HF_HUB_CACHE).toBeUndefined();
  expect(cfg.warning).toContain("PYTHONHOME");
});
```

- [ ] **Step 4: `repo-root.ts`·`main.ts`·`api.ts`의 게이트와 타입을 고친다**

`repoRoot`를 nullable로 만들면 **두 소비자가 함께 깨진다.** 이 Step이 셋을 한 번에 본다:

| 자리 | 지금 | 고칠 것 |
| --- | --- | --- |
| `api.ts:172` | `const root = ctx.packaged ? path.join(process.resourcesPath, "api") : ctx.repoRoot;` | packaged가 아닌데 `repoRoot`가 null이면 **기동 자체가 dev 전용 실패**다. 그 자리에서 `CAUSES.repoRootMissing`으로 던진다 — `path.join(null, …)`에 닿기 전에 |
| 마이그레이션 러너 | `resolved`를 참조한다 | 같은 판정을 쓴다. packaged는 번들 러너라 `repoRoot`가 필요 없다 |
| `main.ts` | `resolveRepoRoot`가 `async` + 대화상자 | 동기 + 대화상자 없음 |

`repoRootMissing`은 **지우지 않고 dev 전용 원인으로 남긴다** — dev에서 저장소를 못 찾으면
API를 띄울 수 없는 것이 사실이기 때문이다.

`repo-root.ts` 주석을 사실에 맞게 고친다:

```typescript
/**
 * **dev 전용 표식이다.** Phase 4부터 packaged .app은 be/worker를 자기 안에 갖는다
 * (Resources/python/lib/python3.12/site-packages/damwha_worker) — 저장소를 가리킬 이유가
 * 없고, 없다고 기동을 막아서도 안 된다. dev는 PYTHONPATH로 저장소 소스를 앞세우므로
 * (Phase 4 스펙 §6.7) 그 경로를 찾을 때만 쓴다.
 */
const MARKERS = ["be/worker/pyproject.toml"] as const;
```

`main.ts`의 `resolveRepoRoot`:

```typescript
/**
 * dev의 저장소 체크아웃. **packaged는 null이다** (Phase 4 스펙 §6.3).
 *
 * Phase 3까지는 packaged도 이것을 요구해, 못 찾으면 폴더 선택창을 띄우고 취소하면 기동이
 * 실패했다 — repo-root.ts의 주석이 "Phase 4가 번들할 것이라 그때까지"라고 적어 둔 그 게이트다.
 * 이제 번들에 worker가 들어 있으므로 packaged는 저장소를 아예 보지 않는다.
 */
function resolveRepoRoot(configured: string | undefined): string | null {
  if (app.isPackaged) return null;
  if (configured !== undefined && isRepoRoot(configured)) return configured;
  const guess = path.resolve(app.getAppPath(), "..");
  return isRepoRoot(guess) ? guess : null;
}
```

- **`async`가 아니게 된다** (대화상자가 사라졌다). 호출부의 `await`를 지운다.
- `if (resolved === null) throw new Error(CAUSES.repoRootMissing.text);` 를 아래로 바꾼다:

```typescript
  repoRoot = resolveRepoRoot(cfg.repoRoot);
  // packaged는 null이 정상이다. dev에서 null이면 PYTHONPATH를 못 얹어 worker 소스 수정이
  // 반영되지 않는다 — 기동을 막을 일은 아니고 로그로 알린다.
  if (!app.isPackaged && repoRoot === null) {
    logLine("저장소를 찾지 못해 dev PYTHONPATH를 얹지 않습니다 — worker 소스 수정이 반영되지 않아요.");
  }
```

- `saveConfigValue(…, "REPO_ROOT", dir)` 호출을 지운다. **`config.json`에 앱이 쓰는 유일한 예외가 사라진다** (Phase 3 결과 §4.3이 적은 그 예외다).
- `CAUSES.repoRootMissing`은 **남긴다.** 문구만 dev 전용으로 고친다 — packaged는 이 원인에
  닿지 않는다.

(d) 같은 자리에서 `bins`와 `runId`를 만든다:

```typescript
  const pyDir = app.isPackaged
    ? path.join(process.resourcesPath, "python")
    : path.join(app.getAppPath(), "build", "python");
  const ffDir = app.isPackaged
    ? path.join(process.resourcesPath, "ffmpeg")
    : path.join(app.getAppPath(), "build", "ffmpeg");
  const py = pythonBinaries(pyDir);
  const ff = ffmpegBinaries(ffDir);

  // 실행마다 새 값. 이 실행이 띄우는 모든 Python 프로세스의 argv에 들어간다 (스펙 §6.5).
  const runId = `desktop-${randomUUID()}`;

  const ctx: Omit<LaunchContext, "signal"> = {
    repoRoot,
    userData,
    packaged: app.isPackaged,
    env: {
      ...cfg.env,
      HF_HOME: path.join(userData, "models"),
      FFMPEG_BIN: ff.ffmpeg,
      FFPROBE_BIN: ff.ffprobe,
      // 기본값 없는 필수 설정이다 — 주입하지 않으면 worker가 ValidationError로 기동 실패한다
      // (be/worker/damwha_worker/config.py). DATABASE_URL과 함께 둘뿐이고, 그쪽은 Phase 3이
      // 이미 넣는다.
      LENS_LLM_BASE_URL: `http://127.0.0.1:${await freePort()}`,
      // dev만. packaged에서는 sanitizeChildEnv가 상속분도 지운다 (스펙 §6.7).
      ...(repoRoot === null ? {} : { PYTHONPATH: path.join(repoRoot, "be", "worker") }),
    },
    bins: { python: py.python, ffmpeg: ff.ffmpeg, ffprobe: ff.ffprobe },
    runId,
    searchDirs: dirs,
    logFile: logPathOf,
  };
```

(e) cwd의 `.env` 경고. 기동 흐름에 한 줄:

```typescript
  // pydantic Settings가 cwd의 .env를 읽는다(config.py:9). 앱 env가 그것을 이기므로 실해는
  // 없지만, 있으면 "왜 내 값이 안 먹지"의 원인이 된다.
  if (fs.existsSync(path.join(userData, ".env"))) {
    logLine(`${path.join(userData, ".env")}가 있어요 — 앱은 이 파일을 만들지 않습니다. 설정은 config.json을 쓰세요.`);
  }
```

- [ ] **Step 5: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

기대: **둘 다 통과.** 옛 런처가 아직 살아 있고(Task 11) 소비자도 그대로라 이 Task도
초록불로 끝난다.

**Verify:** `config`·`child-env` 테스트 + 기존 테스트 전부 통과, `lint` 통과.

**Review:**
- `HF_TOKEN` 경고에 **값이 안 실리는가.**
- `UV_BIN`이 note(로그)이고 warning(화면)이 아닌가.
- packaged에서 `resolveRepoRoot`가 폴더 선택창을 **안 띄우는가.**
- `saveConfigValue(… "REPO_ROOT" …)`가 사라졌는가 — `config.json`에 앱이 쓰는 예외가 없어진다.
- `sanitizeChildEnv`가 **최종 합성 env**에 적용되는가 (상속분만이 아니라).
- 앱이 주장하는 값(`HF_HOME`·dev `PYTHONPATH`)이 그 **뒤에** 얹히는가.
- `config.json`의 금지 키가 버려지고 **경고가 나는가** (P4-C30).
- `api.ts`와 마이그레이션 러너가 dev에서 `repoRoot` null을 만나면 **`path.join`에 닿기 전에**
  원인을 내는가.
- `LENS_LLM_BASE_URL`이 실제로 들어가는가 (빠지면 worker가 기동 실패한다).

- [ ] **Step 6: 커밋**

```bash
git add desktop/src/config/config.ts desktop/src/config/repo-root.ts desktop/src/main.ts \
        desktop/src/process/python-launcher.ts desktop/tests/config/
git commit -m "feat(desktop): 자식 env를 씻고 packaged의 저장소 게이트를 지운다"
```

커밋 본문:

```
dev 터미널에서 띄운 Electron은 개발자의 전체 환경을 갖고 있다. 그대로
넘기면 번들 인터프리터가 남의 prefix·가상환경·캐시를 보게 되고, 그 결과는
오류가 아니라 조용한 오작동이다. PYTHONHOME·VIRTUAL_ENV·HF_HUB_CACHE 같은
키를 지운다 — HF_HOME 하나가 모두를 이긴다는 근거가 없고, 더 구체적인
변수가 있으면 그것이 이긴다.

packaged는 이제 저장소를 보지 않는다. repo-root.ts의 주석이 "Phase 4가
번들할 것이라 그때까지"라고 적어 둔 게이트를 지운다 — 못 찾으면 폴더
선택창이 뜨고 취소하면 기동이 실패했다. config.json에 앱이 쓰는 유일한
예외(REPO_ROOT)도 함께 사라진다.

UV_BIN은 로그 note로만 남긴다. 그 값을 고쳐도 다시 시도에 반영되지 않던
Phase 2의 한계가 키와 함께 없어진다.

HF_TOKEN은 앱 소유 키로 거절하되 값을 경고 문구에 싣지 않는다 — 그 문구는
화면과 supervisor.log에 남는다.
```

---

## Task 13: worker·embed 어댑터 교체 — `.env` 의존 제거

**Files:**
- Modify: `desktop/src/services/worker.ts`
- Modify: `desktop/src/services/embed.ts`
- Modify: `desktop/tests/services/worker.test.ts`, `desktop/tests/services/embed.test.ts`

**Interfaces:**
- Consumes: Task 11의 `launchPython`, Task 12의 `LaunchContext`
- Produces: `workerSpec`·`embedSpec`이 번들 python으로 뜬다. 시그니처는 그대로 — `WorkerDeps`에서 `exists`만 사라진다.

**옛 런처를 지우는 것이 이 Task다.** Task 11이 새 런처를 더해 공존시켰고, 여기서 소비자를
옮긴 **뒤에** 옛 것을 지운다. 그래야 중간에 컴파일이 깨진 커밋이 안 남는다(로드맵 §5).

- [ ] **Step 1: 지금 어댑터를 읽는다**

```bash
sed -n '110,160p' desktop/src/services/worker.ts
sed -n '80,100p' desktop/src/services/embed.ts
```

- [ ] **Step 2: 테스트를 고친다**

`desktop/tests/services/worker.test.ts`에서 `.env` 관련 케이스를 지우고 대신:

```typescript
it("번들 python을 -m damwha_worker로 띄운다", async () => {
  const spawnFn = vi.fn(() => fakeChild()) as never;
  const spec = workerSpec({ listExternal: async () => [], spawnFn });
  await spec.launch(ctx());
  const [bin, argv] = calls(spawnFn)[0];
  expect(bin).toBe("/b/python/bin/python3.12");
  expect(argv.slice(0, 2)).toEqual(["-m", "damwha_worker"]);
});

it("be/worker/.env가 없어도 기동한다 — 앱이 env를 전부 주입한다", async () => {
  const spawnFn = vi.fn(() => fakeChild()) as never;
  const spec = workerSpec({ listExternal: async () => [], spawnFn });
  // repoRoot가 null(=packaged)이라 .env를 볼 자리 자체가 없다.
  await expect(spec.launch(ctx({ repoRoot: null }))).resolves.toBeTruthy();
});

it("python 경로가 비면 원인을 적어 던진다", async () => {
  const spec = workerSpec({ listExternal: async () => [] });
  await expect(spec.launch(ctx({ bins: { python: "", ffmpeg: "", ffprobe: "" } })))
    .rejects.toThrow(/Python/);
});
```

`desktop/tests/services/embed.test.ts`:

```typescript
it("embed를 -m damwha_worker.embed_service로 띄운다", async () => {
  const spawnFn = vi.fn(() => fakeChild()) as never;
  const spec = embedSpec({ probe: async () => ({ kind: "absent" }), freePort: async () => 8100, spawnFn });
  await spec.prepare!(ctx());
  await spec.launch(ctx());
  expect(calls(spawnFn)[0][1].slice(0, 2)).toEqual(["-m", "damwha_worker.embed_service"]);
});
```

- [ ] **Step 3: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- services/worker services/embed
```

- [ ] **Step 4: `worker.ts`를 고친다**

import를 바꾼다: `import { launchWithUv } from "../process/uv-launcher";` → `import { launchPython } from "../process/python-launcher";`

`WorkerDeps`에서 `exists?`를 지운다 (`.env` 검사 전용이었다).

`launch(ctx)`를 바꾼다:

```typescript
    async launch(ctx) {
      // `be/worker/.env` 존재 검사가 여기 있었다. Phase 4부터 번들에는 그 파일이 없고
      // 앱이 필요한 값을 전부 env로 넣는다 (스펙 §6.3) — 기본값 없는 필수 키는
      // DATABASE_URL(Phase 3)과 LENS_LLM_BASE_URL(Phase 4) 둘뿐이고 main.ts가 둘 다 넣는다.
      // 검사를 남기면 packaged에서 항상 실패한다.
      if (ctx.bins.python === "") throw new Error(CAUSES.pythonMissing.text);
      // 감시를 spawn **전에** 만들어 onStderr로 넘긴다 — 첫 청크부터 빠짐없이 본다.
      const watch = makeReadinessWatch();
      const result = launchPython({
        ctx,
        module: "damwha_worker",
        logId: "worker",
        spawnFn: deps.spawnFn,
        onStderr: watch.feed,
      });
      if (result.handle !== null) watches.set(result.handle, watch);
      return result;
    },
```

`import * as fs`·`import * as path`·`const exists = …`가 쓰이지 않으면 지운다.

- [ ] **Step 5: `embed.ts`를 고친다**

```typescript
    async launch(ctx) {
      if (adopted) return { handle: null, owned: false };
      // 콘솔 스크립트(`damwha-embed`)가 아니라 모듈이다 — 그것은 셔뱅을 탄다 (스펙 §6.2).
      return launchPython({
        ctx,
        module: "damwha_worker.embed_service",
        logId: "embed",
        spawnFn: deps.spawnFn,
      });
    },
```

`EmbedDeps`에 `spawnFn?: SpawnFn`을 더한다 (테스트 주입용 — `WorkerDeps`와 같은 이유).

- [ ] **Step 6: 소비자를 다 옮긴 뒤 옛 런처와 `bins.uv`를 지운다**

```bash
grep -rn "uv-launcher\|bins.uv\|launchWithUv" desktop/src desktop/tests
```

**결과가 비어야** 다음으로 간다. 비었으면:

```bash
git rm desktop/src/process/uv-launcher.ts desktop/tests/process/uv-launcher.test.ts
```

`LaunchContext.bins`에서 `uv`를 뺀다(Task 11이 남겨 둔 것). `main.ts`의
`const uv = cfg.uvBin ?? findExecutable("uv", dirs);`도 지운다.

- [ ] **Step 7: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

기대: **둘 다 통과.** 이 Task도, 앞의 둘도 각각 초록불이다.

- [ ] **Step 8: dev에서 실제로 뜨는지 본다**

```bash
pnpm --filter damwha-desktop run start:desktop
```

기대: 네 서비스가 `running/ok`에 도달한다. `<userData>/logs/worker.log` 첫머리에 Task 9의 `runtime {...}` 줄이 있고 `executable`이 `desktop/build/python/bin/python3.12`다.

**Verify:** Step 6·7 통과.

**Review:**
- `.env` 검사가 완전히 사라졌는가.
- `uv-launcher`·`bins.uv`·`launchWithUv` 참조가 **하나도 안 남았는가** (Step 6의 grep).
- embed가 모듈 진입인가 (콘솔 스크립트가 아니라).
- `WorkerDeps.exists`를 쓰는 테스트가 남아 있지 않은가.

- [ ] **Step 9: 커밋**

```bash
git add desktop/src/services/worker.ts desktop/src/services/embed.ts desktop/tests/services/ \
        desktop/src/services/types.ts desktop/src/main.ts
git add -u desktop/src/process/uv-launcher.ts desktop/tests/process/uv-launcher.test.ts
git commit -m "feat(desktop): worker와 embed를 번들 Python으로 띄우고 uv 런처를 지운다"
```

커밋 본문:

```
be/worker/.env 존재 검사를 지운다. 번들에는 그 파일이 없고 앱이 필요한 값을
전부 env로 넣는다 — 기본값 없는 필수 키는 DATABASE_URL과 LENS_LLM_BASE_URL
둘뿐이고 main.ts가 둘 다 넣는다. 검사를 남기면 packaged에서 항상 실패한다.

embed는 콘솔 스크립트가 아니라 -m damwha_worker.embed_service로 뜬다.

Phase 1이 사람에게 맡겼다가 Phase 2가 없앤 STORAGE_ROOT 합의에 이어, 앱과
저장소 사이의 마지막 파일 의존이 사라졌다.
```

---

## Task 14: HF 토큰 — Keychain 저장소와 온보딩 게이트

**Files:**
- Create: `desktop/src/config/token-store.ts`
- Create: `desktop/tests/config/token-store.test.ts`
- Create: `desktop/src/windows/token-window.ts`
- Create: `desktop/shell/token.html`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/diagnostics/causes.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export interface TokenStore { read(): string | null; write(token: string): void; clear(): void; available(): boolean }`
  - `export function makeTokenStore(userData: string, storage?: SafeStorageLike): TokenStore`
  - `export function maskToken(token: string): string`
  - `export async function verifyHfToken(token: string, fetchFn?): Promise<{ ok: true; name: string } | { ok: false; kind: "invalid" | "offline"; detail: string }>`
  - `export function openTokenWindow(opts): Promise<string>` — 저장된 토큰으로 resolve.
  Task 19의 설정 화면이 `maskToken`·`TokenStore`를 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/config/token-store.test.ts`:

```typescript
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { makeTokenStore, maskToken, verifyHfToken } from "../../src/config/token-store";

/** electron의 safeStorage를 대신한다 — 테스트가 electron을 값으로 import할 수 없다. */
function fakeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    // 진짜 암호화가 아니어도 된다. 검사하는 것은 "평문이 그대로 안 적히는가"다.
    encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString("base64")}`),
    decryptString: (b: Buffer) => {
      const t = b.toString();
      if (!t.startsWith("enc:")) throw new Error("bad blob");
      return Buffer.from(t.slice(4), "base64").toString();
    },
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p4-token-"));
}

describe("makeTokenStore", () => {
  it("쓰고 읽는다", () => {
    const dir = tmp();
    const s = makeTokenStore(dir, fakeStorage());
    s.write("hf_abcdefghijklmnop");
    expect(s.read()).toBe("hf_abcdefghijklmnop");
  });

  it("평문이 디스크에 남지 않는다", () => {
    const dir = tmp();
    makeTokenStore(dir, fakeStorage()).write("hf_secret_token_value");
    const raw = fs.readFileSync(path.join(dir, "hf-token.bin")).toString();
    expect(raw).not.toContain("hf_secret_token_value");
  });

  it("파일 권한이 0600이다", () => {
    const dir = tmp();
    makeTokenStore(dir, fakeStorage()).write("hf_x");
    expect(fs.statSync(path.join(dir, "hf-token.bin")).mode & 0o777).toBe(0o600);
  });

  it("없으면 null", () => {
    expect(makeTokenStore(tmp(), fakeStorage()).read()).toBeNull();
  });

  it("복호화 실패는 null이고 파일을 지우지 않는다", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "hf-token.bin"), "garbage");
    const s = makeTokenStore(dir, fakeStorage());
    expect(s.read()).toBeNull();
    expect(fs.existsSync(path.join(dir, "hf-token.bin"))).toBe(true);
  });

  it("safeStorage를 못 쓰면 available()이 false이고 write가 던진다", () => {
    const s = makeTokenStore(tmp(), fakeStorage(false));
    expect(s.available()).toBe(false);
    expect(() => s.write("hf_x")).toThrow();
  });

  it("clear가 파일을 지운다", () => {
    const dir = tmp();
    const s = makeTokenStore(dir, fakeStorage());
    s.write("hf_x");
    s.clear();
    expect(s.read()).toBeNull();
  });
});

describe("maskToken", () => {
  it("앞뒤만 남긴다", () => {
    expect(maskToken("hf_abcdefghijklmnopqrstuvwx")).toBe("hf_abc…uvwx");
  });
  it("짧은 값도 전부 가린다", () => {
    expect(maskToken("hf_a")).not.toContain("hf_a");
  });
});

describe("verifyHfToken", () => {
  it("200이면 ok", async () => {
    const r = await verifyHfToken("hf_x", async () => ({ ok: true, status: 200, json: async () => ({ name: "me" }) }) as never);
    expect(r).toEqual({ ok: true, name: "me" });
  });

  it("401은 invalid — 사용자가 고칠 수 있다", async () => {
    const r = await verifyHfToken("hf_x", async () => ({ ok: false, status: 401, text: async () => "Unauthorized" }) as never);
    expect(r).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("네트워크 실패는 offline — invalid와 구별한다", async () => {
    const r = await verifyHfToken("hf_x", async () => { throw new Error("ENOTFOUND"); });
    expect(r).toMatchObject({ ok: false, kind: "offline" });
  });

  it("실패 사유에 토큰 원문이 없다", async () => {
    const r = await verifyHfToken("hf_secret", async () => { throw new Error("boom hf_secret"); });
    expect(JSON.stringify(r)).not.toContain("hf_secret");
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- token-store
```

- [ ] **Step 3: `token-store.ts`를 쓴다**

```typescript
import * as fs from "fs";
import * as path from "path";

/**
 * HF 토큰 보관 (Electron Phase 4 스펙 §6.4).
 *
 * 화자 분리 모델 `pyannote/speaker-diarization-community-1`이 HF에서 게이트되므로 토큰이
 * 없으면 그 기능이 돌지 않는다. 토큰은 비밀이라 **평문을 디스크에 남기지 않는다** —
 * safeStorage가 macOS에서 Keychain을 백엔드로 쓴다.
 *
 * electron을 값으로 import하지 않는다. 테스트가 이 모듈을 부를 수 있어야 하고
 * (shell-window.ts:1의 제약), main.ts가 진짜 safeStorage를 주입한다.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

export interface TokenStore {
  /** 없거나 못 읽으면 null. **파일을 지우지 않는다** — 사람이 복구할 수 있어야 한다. */
  read(): string | null;
  write(token: string): void;
  clear(): void;
  available(): boolean;
}

const FILE = "hf-token.bin";

export function makeTokenStore(userData: string, storage: SafeStorageLike): TokenStore {
  const file = path.join(userData, FILE);
  return {
    available: () => {
      try {
        return storage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    read() {
      try {
        if (!fs.existsSync(file)) return null;
        const plain = storage.decryptString(fs.readFileSync(file));
        return plain === "" ? null : plain;
      } catch {
        // 다른 맥에서 복사해 온 파일이거나 Keychain 항목이 지워졌다. 파일은 그대로 둔다 —
        // 사람이 옮겨 온 것일 수 있고, 우리가 지우면 복구할 길이 없다.
        return null;
      }
    },
    write(token: string) {
      if (!storage.isEncryptionAvailable()) {
        throw new Error("safeStorage를 쓸 수 없어 토큰을 저장하지 못했어요.");
      }
      fs.mkdirSync(userData, { recursive: true });
      // mode를 wrieFileSync에 주는 것만으로는 **이미 있는 파일**의 권한이 안 바뀐다.
      fs.writeFileSync(file, storage.encryptString(token), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    },
    clear() {
      try {
        fs.unlinkSync(file);
      } catch {
        // 없으면 그만이다.
      }
    },
  };
}

/** 화면에 보이는 형태. 앞 6자와 뒤 4자만 남긴다. 짧으면 전부 가린다. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "…".repeat(4);
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export type TokenVerdict =
  | { ok: true; name: string }
  | { ok: false; kind: "invalid" | "offline"; detail: string };

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<{ name?: string }>;
  text?(): Promise<string>;
}>;

/**
 * **저장 전에 실제로 검증한다.** 형식만 보면 오타난 토큰이 통과해 몇 분 뒤 job 실패로만
 * 드러난다.
 *
 * 게이트 수락 여부는 여기서 확인하지 않는다 — 수락은 모델 단위이고, 확인하려면 그 모델
 * 파일을 실제로 건드려야 한다. 403 구별은 worker 쪽 실패 분류가 맡는다 (스펙 §6.4).
 */
export async function verifyHfToken(token: string, fetchFn?: FetchLike): Promise<TokenVerdict> {
  const f = fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  try {
    const res = await f("https://huggingface.co/api/whoami-v2", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = await res.json();
      return { ok: true, name: body.name ?? "(이름 없음)" };
    }
    return {
      ok: false,
      kind: "invalid",
      detail: `허깅페이스가 토큰을 거절했어요 (HTTP ${res.status}).`,
    };
  } catch {
    // **오류 메시지를 그대로 옮기지 않는다** — 네트워크 스택이 요청 헤더를 메시지에 담는
    // 경우가 있고, 그러면 토큰이 화면과 로그에 샌다.
    return {
      ok: false,
      kind: "offline",
      detail: "지금은 토큰을 확인할 수 없어요. 네트워크를 확인하고 다시 시도해 주세요.",
    };
  }
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- token-store
```

- [ ] **Step 5: 온보딩 창을 만든다**

`desktop/shell/token.html` — 기존 `desktop/shell/` 화면들의 스타일을 먼저 읽고 맞춘다 (`ls desktop/shell/`).

화면이 가진 것 (스펙 §6.4):
1. `pyannote/speaker-diarization-community-1` 조건 수락 페이지 링크 — **외부 브라우저로 연다** (`shell.openExternal`).
2. HF 토큰 발급 페이지 링크.
3. 입력칸 + "확인" 버튼 + 상태 줄.

`desktop/src/windows/token-window.ts`가 창을 띄우고 IPC로 검증·저장을 중계한다. **건너뛰기 버튼을 두지 않는다** (스펙 §6.4: 건너뛸 수 없다). 창을 닫으면 앱이 종료된다.

```typescript
/**
 * 첫 실행 토큰 게이트 (Electron Phase 4 스펙 §6.4). **건너뛸 수 없다** — 사용자가 창을
 * 닫으면 앱이 종료된다. 서비스를 띄우기 **전에** 이 창이 resolve돼야 한다.
 *
 * 외부 링크는 shell.openExternal로 연다. 앱 창 안에서 huggingface.co를 열면 그 창이
 * 우리 origin 경계 밖의 내용을 렌더하게 된다 (Phase 1 windows/origin.ts의 규칙).
 */
export async function openTokenWindow(deps: {
  store: TokenStore;
  verify: (token: string) => Promise<TokenVerdict>;
  onCancelled: () => void;
}): Promise<string> { /* … */ }
```

- [ ] **Step 6: `main.ts` 기동 흐름에 게이트를 넣는다**

서비스를 띄우기 **전에**:

```typescript
  const store = makeTokenStore(userData, safeStorage);
  if (!store.available()) {
    // 평문 폴백은 두지 않는다 (스펙 §6.4). 기동을 막고 원인을 띄운다.
    showStatus({ state: "failed", cause: CAUSES.safeStorageUnavailable });
    return false;
  }
  let hfToken = store.read();
  if (hfToken === null) {
    hfToken = await openTokenWindow({
      store,
      verify: (t) => verifyHfToken(t),
      onCancelled: () => app.quit(),
    });
  }
```

그리고 `ctx.env`에 `HF_TOKEN: hfToken`을 더한다.

`CAUSES`에:

```typescript
  safeStorageUnavailable: {
    text: "맥 키체인을 쓸 수 없어 허깅페이스 토큰을 안전하게 보관할 수 없어요.",
    hint: "키체인 접근이 잠겨 있지 않은지 확인하고 앱을 다시 켜 주세요.",
  },
  hfTokenInvalid: {
    text: "허깅페이스 토큰이 유효하지 않아요.",
    hint: "설정에서 토큰을 다시 넣어 주세요.",
  },
  hfGateNotAccepted: {
    text: "이 모델은 허깅페이스에서 사용 조건을 먼저 수락해야 받을 수 있어요.",
    hint: "모델 페이지에서 조건을 수락한 뒤 '서비스 다시 시작'을 눌러 주세요.",
  },
```

- [ ] **Step 6-b: 토큰 교체가 live env에 닿는 경로를 만든다**

저장만으로는 안 된다. 감독자가 쥔 `ctx.env`는 기동 시점에 얼어붙고, 기존 설정 재적용
(`config-reload.ts:87-95`)은 **`config.json`만** 읽는다 — 토큰은 거기 없다(Keychain에 있다).

```typescript
/**
 * 토큰을 바꾼 뒤 **살아 있는 env**에 반영한다. 저장 → 재조회 → live env 갱신 → 재시작이
 * 한 흐름이어야 한다 (P4-C4).
 *
 * `refreshEnv`로 흘리지 않는 이유: 그것은 config.json이 진실인 키를 위한 것이고, 토큰은
 * 파일에 없다. 여기서 직접 얹는다.
 */
async function applyTokenChange(token: string): Promise<void> {
  store.write(token);
  liveEnv.HF_TOKEN = store.read() ?? "";   // 저장된 것을 다시 읽어 얹는다
  await restartService("worker");           // Task 18의 서비스 재시작 경로
  await restartService("embed");
}
```

**`store.write` 뒤에 `store.read()`로 다시 읽는다** — 암호화·복호화 왕복이 실제로 되는지를
그 자리에서 확인하는 것이 재시작 뒤 "왜 안 되지"보다 낫다.

테스트:

```typescript
it("토큰을 바꾸면 재시작한 자식이 새 값을 받는다 (P4-C4)", async () => {
  await applyTokenChange("hf_new_value");
  expect(liveEnv.HF_TOKEN).toBe("hf_new_value");
  expect(restarted).toEqual(["worker", "embed"]);
});
```

- [ ] **Step 7: 손으로 확인한다**

```bash
rm -f ~/Library/Application\ Support/Damwha/hf-token.bin
pnpm --filter damwha-desktop run start:desktop
```

기대: 토큰 창이 먼저 뜬다. 아무 문자열이나 넣으면 거절된다. 진짜 토큰을 넣으면 저장되고 서비스가 뜬다.

```bash
grep -c "$(echo -n 'hf_실제토큰앞부분')" ~/Library/Application\ Support/Damwha/hf-token.bin || echo "평문 없음 (기대)"
```

**Verify:** 테스트 전부 통과 + Step 7 수동 확인.

**Review:**
- `token-store.ts`가 electron을 값으로 import하지 않는가.
- 복호화 실패가 파일을 **안 지우는가.**
- `verifyHfToken`의 실패 문구에 토큰이나 원본 예외 메시지가 안 들어가는가.
- 온보딩 창에 건너뛰기 버튼이 **없는가.**
- 외부 링크가 `shell.openExternal`인가.
- `safeStorage` 불가 시 평문 폴백이 **없는가.**

- [ ] **Step 8: 커밋**

```bash
git add desktop/src/config/token-store.ts desktop/tests/config/token-store.test.ts \
        desktop/src/windows/token-window.ts desktop/shell/token.html \
        desktop/src/main.ts desktop/src/diagnostics/causes.ts
git commit -m "feat(desktop): 첫 실행에 허깅페이스 토큰을 받아 키체인에 보관한다"
```

커밋 본문:

```
화자 분리 모델이 HF에서 게이트되므로 토큰 없이는 그 기능이 돌지 않는다.
첫 실행에 토큰 창이 뜨고 건너뛸 수 없다 — 창을 닫으면 앱이 종료된다.

저장 전에 whoami-v2로 실제 검증한다. 형식만 보면 오타난 토큰이 통과해
몇 분 뒤 job 실패로만 드러난다. 네트워크 실패는 '확인할 수 없어요'로
무효와 구별해 말한다.

safeStorage(macOS Keychain)로 암호화해 0600으로 저장하고, 복호화는 main만
한다. 평문 폴백을 두지 않는다 — 키체인을 못 쓰면 기동을 막는다. 복호화
실패는 파일을 지우지 않는다. 다른 맥에서 옮겨 온 것일 수 있고 우리가
지우면 복구할 길이 없다.

실패 문구에 토큰 원문도, 원본 예외 메시지도 싣지 않는다 — 네트워크 스택이
요청 헤더를 메시지에 담는 경우가 있다.
```

---

## Task 15: 고아 스캔과 회수

**Files:**
- Create: `desktop/src/process/orphans.ts`
- Create: `desktop/tests/process/orphans.test.ts`
- Modify: `desktop/src/services/worker-discovery.ts`
- Modify: `desktop/src/services/embed.ts` (채택 규칙)
- Modify: `desktop/src/main.ts` (기동 전 정리)

**Interfaces:**
- Consumes: Task 10의 `pythonBinaries`, Task 11의 `LaunchContext.runId`
- Produces:
  - `export interface DamwhaProcess { pid: number; module: string; runId: string | null; once: boolean; argv0: string }`
  - `export function parseDamwhaProcesses(psText: string, bundleRoot: string): DamwhaProcess[]`
  - `export function classify(p: DamwhaProcess, myRunId: string): "mine" | "orphan" | "external"`
  - `export async function reapOrphans(deps): Promise<{ reaped: number[]; failed: true } | { reaped: number[] }>`

- [ ] **Step 1: 기존 판정을 읽는다**

```bash
sed -n '30,60p' desktop/src/services/worker-discovery.ts
```

**이 판정을 대체하지 않고 확장한다.** 세 조건(argv[0] basename이 python, `-m damwha_worker` 토큰 쌍, `--once` 유무)이 이미 `uv run …` 런처 줄과 `/bin/zsh -c "… damwha_worker …"` 셸 줄을 거른다. run-id만 보면 `grep --run-id=…` 같은 줄이 걸린다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`desktop/tests/process/orphans.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classify, parseDamwhaProcesses } from "../../src/process/orphans";

const BUNDLE = "/Apps/Damwha.app/Contents/Resources/python";
const PY = `${BUNDLE}/bin/python3.12`;

describe("parseDamwhaProcesses", () => {
  it("번들 python의 worker·embed·once를 잡는다", () => {
    const ps = [
      `  101 ${PY} -m damwha_worker --run-id=run-a`,
      `  102 ${PY} -m damwha_worker --once --run-id=run-a`,
      `  103 ${PY} -m damwha_worker.embed_service --run-id=run-a`,
    ].join("\n");
    const found = parseDamwhaProcesses(ps, BUNDLE, [PY]);
    expect(found.map((p) => p.pid)).toEqual([101, 102, 103]);
    expect(found[1].once).toBe(true);
    expect(found[2].module).toBe("damwha_worker.embed_service");
  });

  it("저장소 .venv의 worker는 잡지 않는다 — 조건 3(번들 트리 아래)에서 빠진다", () => {
    const ps = `  201 /repo/be/worker/.venv/bin/python -m damwha_worker`;
    expect(parseDamwhaProcesses(ps, BUNDLE, [PY])).toEqual([]);
  });

  it("uv 런처 줄을 잡지 않는다", () => {
    const ps = `  202 /opt/homebrew/bin/uv run --directory /repo/be/worker python -m damwha_worker`;
    expect(parseDamwhaProcesses(ps, BUNDLE, [PY])).toEqual([]);
  });

  it("모듈 이름만 언급하는 셸 줄을 잡지 않는다", () => {
    const ps = [
      `  203 /bin/zsh -c echo damwha_worker --run-id=run-x`,
      `  204 grep --run-id=run-x damwha_worker`,
    ].join("\n");
    expect(parseDamwhaProcesses(ps, BUNDLE)).toEqual([]);
  });

  it("run-id가 없는 번들 프로세스도 담되 runId는 null이다", () => {
    const found = parseDamwhaProcesses(`  205 ${PY} -m damwha_worker`, BUNDLE, [PY]);
    expect(found[0].runId).toBeNull();
  });

  it("**공백이 든 설치 경로를 견딘다**", () => {
    // /Applications 밖에 둔 앱, 이름에 공백이 있는 폴더 — 둘 다 흔하다.
    const spaced = "/Users/me/My Apps/Damwha.app/Contents/Resources/python";
    const spacedPy = `${spaced}/bin/python3.12`;
    const ps = `  301 ${spacedPy} -m damwha_worker --run-id=run-a`;
    const found = parseDamwhaProcesses(ps, spaced, [spacedPy]);
    expect(found).toHaveLength(1);
    expect(found[0].runId).toBe("run-a");
  });

  it("llm_entry도 같은 규칙으로 잡는다", () => {
    const ps = `  302 ${PY} -m damwha_worker.llm_entry --run-id=run-a --model m/x`;
    const found = parseDamwhaProcesses(ps, BUNDLE, [PY]);
    expect(found[0].module).toBe("damwha_worker.llm_entry");
  });

  it("dev와 packaged 두 인터프리터를 다 시험한다", () => {
    const dev = "/repo/desktop/build/python/bin/python3.12";
    const ps = `  303 ${dev} -m damwha_worker --run-id=run-a`;
    expect(parseDamwhaProcesses(ps, BUNDLE, [PY, dev])).toHaveLength(1);
  });

  it("ps 출력이 잘려 접두사가 안 맞으면 담지 않는다 — '고아 없음'과 구별은 호출부가 한다", () => {
    const ps = `  304 ${PY.slice(0, 20)}`;
    expect(parseDamwhaProcesses(ps, BUNDLE, [PY])).toEqual([]);
  });
});

describe("classify", () => {
  const base = { pid: 1, module: "damwha_worker", once: false, argv0: PY };

  it("내 run-id면 mine", () => {
    expect(classify({ ...base, runId: "run-a" }, "run-a")).toBe("mine");
  });

  it("다른 run-id면 orphan", () => {
    expect(classify({ ...base, runId: "run-old" }, "run-a")).toBe("orphan");
  });

  it("run-id가 없으면 external — 손대지 않는다", () => {
    expect(classify({ ...base, runId: null }, "run-a")).toBe("external");
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- orphans
```

- [ ] **Step 4: `orphans.ts`를 쓴다**

```typescript
import * as path from "path";

/**
 * 앱이 띄운 Python 프로세스를 찾아 **이전 실행의 고아**를 가려낸다
 * (Electron Phase 4 스펙 §6.5).
 *
 * Phase 3 결과 §5.2-2가 넘긴 문제다 — 앱 main이 강제 종료되면 worker 트리가 고아로 남고
 * 다음 실행이 정리하지 않았다. P3-C3에서 옛 worker와 새 worker가 함께 돌았고, 고아 embed는
 * 한 번 채택된 뒤로는 채택되지 않아 둘이 모델 메모리를 썼다.
 *
 * **판정은 네 조건을 모두 요구한다.** run-id 하나만 보면 `grep --run-id=…` 같은 셸 줄이
 * 걸린다 — worker-discovery.ts의 기존 세 조건이 정확히 그 오탐을 막으려고 만든 것이고,
 * 여기에 "번들 트리 아래 python"을 더해 저장소 .venv의 외부 worker까지 구별한다.
 */

const PYTHON_BASENAME = /^python[\d.]*$/;
const MODULES = [
  "damwha_worker",
  "damwha_worker.embed_service",
  // §6.2의 얇은 진입 모듈. 이것 덕에 LLM 서버도 다른 셋과 같은 규칙으로 판정된다 —
  // mlx_lm.server를 직접 띄웠다면 표식이 없어 부모 트리에 기대야 했고, 부모와 --once가
  // 둘 다 죽으면 그 트리가 사라진다.
  "damwha_worker.llm_entry",
] as const;
const RUN_ID_PREFIX = "--run-id=";
/** `ps -axo pid,args` 한 줄. */
const PS_ROW = /^\s*(\d+)\s+(\S.*?)\s*$/;

export interface DamwhaProcess {
  pid: number;
  module: string;
  /** 없으면 외부 실행이다 (터미널 `pnpm worker` 등). */
  runId: string | null;
  /** `--once` 자식인가. 종료 절차가 부모와 다르게 다룬다. */
  once: boolean;
  argv0: string;
}

/**
 * `knownPythons`는 앱이 아는 인터프리터 절대 경로들이다 — packaged(`Resources/python/bin/…`)와
 * dev(`desktop/build/python/bin/…`) 둘. 둘 다 시험하는 이유는 하나의 userData를 두 빌드가
 * 공유하기 때문이다(Phase 3의 결정) — dev로 띄웠다 끄고 packaged로 켜는 순서가 실제로 있다.
 */
export function parseDamwhaProcesses(
  psText: string,
  bundleRoot: string,
  knownPythons: readonly string[],
): DamwhaProcess[] {
  const out: DamwhaProcess[] = [];
  for (const line of psText.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m === null) continue;
    const args = m[2];

    // 조건 1·3 — **아는 접두사로 먼저 자른다.** `ps -axo pid,args`는 argv를 공백으로 이어
    // 붙인 평탄한 문자열이라 다시 토큰으로 쪼갤 수 없다. `/Users/x/My Apps/Damwha.app/…`처럼
    // 공백이 든 설치 경로는 흔하고, 단순 `split(/\s+/)`는 argv[0]을 `/Users/x/My`로 잘라
    // **정상 프로세스를 판정에서 누락시킨다** — 고아 정리가 조용히 생략된다.
    // 앱은 자기 인터프리터 경로를 정확히 알고 있으므로 그것으로 자른다 (스펙 §6.5).
    const argv0 = knownPythons.find((py) => args.startsWith(`${py} `) || args === py);
    if (argv0 === undefined) continue;
    const tokens = args.slice(argv0.length).split(/\s+/).filter((x) => x.length > 0);

    // 조건 2 — `-m <모듈>`이 토큰 **쌍**으로 있다. 모듈 이름만 언급하는 줄이 빠진다.
    const mi = tokens.findIndex((t, i) => t === "-m" && (MODULES as readonly string[]).includes(tokens[i + 1] ?? ""));
    if (mi === -1) continue;
    const moduleName = tokens[mi + 1];

    // 조건 3 — argv[0]이 **번들 트리 아래**다. 저장소 .venv·Homebrew python이 빠진다.
    //   외부 worker는 손대지 않는다는 Phase 2의 규칙을 이 한 줄이 지킨다.
    if (!isInside(argv0, bundleRoot)) continue;

    const runIdToken = tokens.find((t) => t.startsWith(RUN_ID_PREFIX));
    const runId = runIdToken === undefined ? null : runIdToken.slice(RUN_ID_PREFIX.length) || null;

    out.push({ pid: Number(m[1]), module: moduleName, runId, once: tokens.includes("--once"), argv0 });
  }
  return out;
}

function isInside(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 조건 4의 판정.
 *
 * - `mine` — 있을 수 없다(방금 만든 UUID다). 나오면 로그하고 무시한다.
 * - `orphan` — 이전 실행의 것. 내린다. 사용자에게 묻지 않는다 — 그 프로세스는 이미 죽은
 *   앱의 것이고, 살려 두면 job 테이블 잠금이 있어도 중복 처리 창이 열린다.
 * - `external` — 표식이 없다. 손대지 않는다.
 */
export function classify(p: DamwhaProcess, myRunId: string): "mine" | "orphan" | "external" {
  if (p.runId === null) return "external";
  return p.runId === myRunId ? "mine" : "orphan";
}
```

`reapOrphans`는 스캔 → 분류 → **신호 직전 pid 재확인** → SIGTERM → 유예 → SIGKILL 순서다. 스캔이 실패하면 `{ failed: true }`를 돌려 **호출부가 서비스를 안 띄우게** 한다 — `ps`가 실패했는데 진행하면 고아와 새 프로세스가 같은 job을 집는다.

- [ ] **Step 5: `embed.ts`의 채택 규칙을 좁힌다**

`detectExternal`에서, 프로브가 `match`여도 그 프로세스가 `--run-id`를 갖고 그것이 내 것이 아니면 **채택하지 않는다** — 고아다. `orphans.ts`의 스캔 결과를 `EmbedDeps`로 받아 판정한다.

- [ ] **Step 6: `main.ts`에서 서비스 기동 **전에** 정리한다**

```typescript
  // 기동 **전에** 한다. 뒤에 하면 새로 띄운 것과 고아가 잠시 공존한다.
  const reap = await reapOrphans({ runId, bundleRoot: pyDir });
  if ("failed" in reap) {
    showStatus({ state: "failed", cause: CAUSES.orphanScanFailed });
    return false;
  }
  if (reap.reaped.length > 0) logLine(`이전 실행이 남긴 프로세스 ${reap.reaped.length}개를 정리했어요.`);
```

`CAUSES.orphanScanFailed`를 더한다.

- [ ] **Step 7: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

**Verify:** 테스트 전부 통과.

**Review:**
- 네 조건을 **전부** 요구하는가.
- 저장소 `.venv` worker가 `external`로 빠지는가 (P4-C21의 근거).
- 스캔 실패가 기동을 **막는가.**
- 신호 직전 pid 재확인이 있는가.
- 정리가 기동 **전**인가.

- [ ] **Step 8: 커밋**

```bash
git add desktop/src/process/orphans.ts desktop/tests/process/orphans.test.ts \
        desktop/src/services/worker-discovery.ts desktop/src/services/embed.ts desktop/src/main.ts \
        desktop/src/diagnostics/causes.ts
git commit -m "feat(desktop): 이전 실행이 남긴 고아 프로세스를 기동 전에 정리한다"
```

커밋 본문:

```
Phase 3 결과 §5.2-2가 넘긴 문제다. 앱 main이 강제 종료되면 worker 트리가
고아로 남고 다음 실행이 정리하지 않아, P3-C3에서 옛 worker와 새 worker가
함께 돌았다. 고아 embed는 한 번 채택된 뒤로는 채택되지 않아 둘이 모델
메모리를 썼다.

판정은 네 조건을 모두 요구한다 — argv[0] basename이 python, -m <모듈>
토큰 쌍, argv[0]이 번들 트리 아래, --run-id 토큰. run-id만 보면
`grep --run-id=…` 같은 셸 줄이 걸리고, 번들 트리 조건이 없으면 저장소
.venv의 외부 worker까지 잡는다.

스캔이 실패하면 서비스를 띄우지 않는다. ps가 실패했는데 진행하면 고아와
새 프로세스가 같은 job을 집는다.
```

---

## Task 16: 앱 종료 회수 (B층) — 핸들과 독립인 마지막 단계

**Files:**
- Create: `desktop/src/app/reap-on-quit.ts`
- Create: `desktop/tests/app/reap-on-quit.test.ts`
- Modify: `desktop/src/app/quit-flow.ts`
- Modify: `desktop/tests/services/supervisor.test.ts` (통합 경로)

**Interfaces:**
- Consumes: Task 15의 `parseDamwhaProcesses`·`classify`·`reapOrphans`
- Produces: `export async function reapOwnedOnQuit(deps): Promise<{ reaped: DamwhaProcess[] }>`
  — `quit-flow`가 `stopAll()` **뒤에** 부른다.

- [ ] **Step 1: 왜 `stop()` 안에 넣으면 안 되는지 확인한다**

```bash
sed -n '262,292p' be/worker/damwha_worker/__main__.py
sed -n '432,455p' desktop/src/services/supervisor.ts
sed -n '530,542p' desktop/src/services/supervisor.ts
```

**두 가지가 겹친다:**

1. Python supervisor는 **두 번째 신호에서** `--once` 자식을 `proc.kill()`하고 `os._exit(1)`한다
   (`__main__.py:273-287`). 자식은 `start_new_session=True`라 별도 세션이므로, 부모가 먼저
   사라지면 자손 SIGKILL 단계가 훑을 트리가 없다.
2. **감독자가 죽은 서비스의 `stop()`을 아예 안 부른다.** `watchForDeath`가
   `rt.result = null`로 만들고(`supervisor.ts:453`), `stopAll`이
   `if (rt.result === null || !rt.result.owned) continue`로 건너뛴다(`:536`).
   그래서 **`stopWorkerProcess` 안에 무엇을 넣어도 이 경로에서는 실행되지 않는다.**

둘째가 결정적이다 — 초안은 회수 코드를 `stopWorkerProcess`에 넣었는데 그것은 호출조차 안 될
수 있다. 그래서 **핸들과 무관한 층**을 따로 만든다 (스펙 §6.5의 B층).

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`desktop/tests/app/reap-on-quit.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { reapOwnedOnQuit } from "../../src/app/reap-on-quit";

const PY = "/b/python/bin/python3.12";

function deps(psText: string, over = {}) {
  const killed: number[] = [];
  return {
    killed,
    d: {
      runId: "run-a",
      bundleRoot: "/b/python",
      knownPythons: [PY],
      ps: async () => psText,
      descendantsOf: async () => [],
      kill: (pid: number) => { killed.push(pid); },
      exists: (pid: number) => !killed.includes(pid),
      log: () => {},
      ...over,
    },
  };
}

describe("reapOwnedOnQuit", () => {
  it("핸들 없이도 내 run-id의 프로세스를 전부 회수한다", async () => {
    const { killed, d } = deps([
      `  101 ${PY} -m damwha_worker --run-id=run-a`,
      `  102 ${PY} -m damwha_worker --once --run-id=run-a`,
      `  103 ${PY} -m damwha_worker.llm_entry --run-id=run-a --model m/x`,
      `  104 ${PY} -m damwha_worker.embed_service --run-id=run-a`,
    ].join("\n"));
    const out = await reapOwnedOnQuit(d);
    expect(killed.sort()).toEqual([101, 102, 103, 104]);
    expect(out.reaped).toHaveLength(4);
  });

  it("**부모와 --once가 둘 다 없어도** 남은 llm_entry를 회수한다 (P4-C19-b)", async () => {
    const { killed, d } = deps(`  103 ${PY} -m damwha_worker.llm_entry --run-id=run-a --model m/x`);
    await reapOwnedOnQuit(d);
    expect(killed).toEqual([103]);
  });

  it("다른 run-id는 건드리지 않는다 — 그것은 기동 시 정리가 맡는다", async () => {
    const { killed, d } = deps(`  201 ${PY} -m damwha_worker --run-id=run-other`);
    await reapOwnedOnQuit(d);
    expect(killed).toEqual([]);
  });

  it("run-id 없는 외부 worker를 건드리지 않는다", async () => {
    const { killed, d } = deps(`  202 /repo/be/worker/.venv/bin/python -m damwha_worker`);
    await reapOwnedOnQuit(d);
    expect(killed).toEqual([]);
  });

  it("회수한 것이 있으면 로그에 남긴다 — A층이 놓쳤다는 뜻이다", async () => {
    const lines: string[] = [];
    const { d } = deps(`  101 ${PY} -m damwha_worker --run-id=run-a`, { log: (s: string) => lines.push(s) });
    await reapOwnedOnQuit(d);
    expect(lines.join(" ")).toMatch(/101/);
  });

  it("아무것도 없으면 조용하다", async () => {
    const lines: string[] = [];
    const { d } = deps("", { log: (s: string) => lines.push(s) });
    const out = await reapOwnedOnQuit(d);
    expect(out.reaped).toEqual([]);
    expect(lines).toEqual([]);
  });
});
```

감독자 통합 테스트 — **`watchForDeath` → `rt.result=null` → `stopAll` 경로를 실제로 밟는다:**

```typescript
it("worker가 먼저 죽어 stopAll이 건너뛴 뒤에도 B층이 회수한다 (P4-C19-a)", async () => {
  const sup = makeSupervisor(/* … */);
  await sup.start();
  killWorkerHandle();                 // onExit 발화 → rt.result = null
  await sup.stopAll(plan);            // worker의 stop()은 불리지 않는다
  expect(workerStopCalls).toBe(0);    // 그것이 이 경로의 전제다
  const out = await reapOwnedOnQuit(d);
  expect(out.reaped.map((p) => p.pid)).toContain(WORKER_PID);
});
```

- [ ] **Step 3: 실패를 확인한다**

```bash
pnpm --filter damwha-desktop run test -- reap-on-quit
```

- [ ] **Step 4: `reap-on-quit.ts`를 쓴다**

```typescript
/**
 * **B층 — 앱 종료 회수** (Electron Phase 4 스펙 §6.5).
 *
 * A층(서비스별 `stop()`)이 놓치는 경로가 둘이다:
 *
 *  1. Python supervisor가 두 번째 신호에서 `--once`를 `proc.kill()`하고 `os._exit(1)`한다
 *     (`__main__.py:273-287`). 자식은 `start_new_session=True`라 별도 세션이라, 부모가 먼저
 *     사라지면 자손 SIGKILL이 훑을 트리가 없다.
 *  2. **감독자가 죽은 서비스의 `stop()`을 부르지 않는다.** `watchForDeath`가 `rt.result=null`로
 *     만들고(`supervisor.ts:453`) `stopAll`이 그 서비스를 건너뛴다(`:536`).
 *
 * 그래서 이 층은 **핸들도 감독자 상태도 보지 않는다.** `ps`에서 내 run-id를 가진 프로세스를
 * 찾아 내리는 것이 전부다 — 판정 근거가 argv의 표식이라 부모가 있든 없든 똑같이 동작한다.
 *
 * 대상은 **내 run-id만**이다. 다른 run-id는 이전 실행의 고아이고 그것은 기동 시 정리가
 * 맡는다(`process/orphans.ts`) — 종료 중에 남의 것을 건드리지 않는다.
 */
export async function reapOwnedOnQuit(deps: ReapDeps): Promise<{ reaped: DamwhaProcess[] }> {
  // 스캔이 실패하면 빈 목록이다. 기동 때와 달리 여기서 막을 것이 없다 — 앱은 어차피 끝난다.
  // 그 사실만 로그에 남긴다.
  const found = await scanOwned(deps);
  // 자손을 부모보다 **먼저** 죽인다. 순서가 뒤집히면 부모가 사라지며 트리를 잃는다.
  for (const proc of found) {
    for (const child of await deps.descendantsOf(proc.pid)) deps.kill(child);
  }
  for (const proc of found) deps.kill(proc.pid);
  // 회수한 것이 있으면 A층이 놓쳤다는 뜻이다. 조용히 덮으면 그 결함이 영영 안 보인다.
  if (found.length > 0) {
    deps.log(`종료 회수: ${found.map((p) => `${p.module}(${p.pid})`).join(", ")}`);
  }
  return { reaped: found };
}
```

- [ ] **Step 5: `quit-flow.ts`가 `stopAll()` 뒤에 부르게 한다**

```typescript
  const outcome = await supervisor.stopAll(plan);
  // B층. 핸들 유무와 무관하게 **항상** 돈다 (스펙 §6.5).
  const swept = await reapOwnedOnQuit(reapDeps);
  // 종료 화면의 "남은 것" 판정에 B층 결과를 합친다 — A층이 clean이라고 해도 여기서
  // 회수한 것이 있으면 그것은 clean이 아니었다.
```

- [ ] **Step 6: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
```

**Verify:** `reap-on-quit` 6건 + 감독자 통합 1건 전부 통과.

**Review:**
- B층이 **핸들도 감독자 상태도 안 보는가.**
- `stopAll()` **뒤에** 도는가.
- 내 run-id만 대상인가.
- 자손을 부모보다 먼저 죽이는가.
- 회수한 것을 로그에 남기는가 (A층 결함의 유일한 단서다).
- 통합 테스트가 `rt.result=null` 상태를 **실제로 지나는가** — `workerStopCalls === 0`이
  그 증거다.

- [ ] **Step 7: 커밋**

```bash
git add desktop/src/app/reap-on-quit.ts desktop/tests/app/reap-on-quit.test.ts \
        desktop/src/app/quit-flow.ts desktop/tests/services/supervisor.test.ts
git commit -m "feat(desktop): 앱 종료에 핸들과 무관한 회수 단계를 더한다"
```

커밋 본문:

```
서비스별 stop()이 놓치는 경로가 둘이다. Python supervisor는 두 번째 신호에서
--once를 kill하고 os._exit하며 그 자식은 별도 세션이라 트리가 끊긴다. 그리고
감독자는 죽은 서비스의 stop()을 아예 부르지 않는다 — watchForDeath가
rt.result를 null로 만들고 stopAll이 그 서비스를 건너뛴다.

둘째가 결정적이다. stop() 안에 무엇을 넣어도 그 경로에서는 실행되지 않으므로
핸들과 무관한 층을 따로 둔다. ps에서 내 run-id를 가진 프로세스를 찾아 내리는
것이 전부라 부모가 있든 없든 똑같이 동작한다.

회수한 것이 있으면 로그에 남긴다 — 그것은 A층이 놓쳤다는 뜻이고, 조용히
덮으면 그 결함이 영영 안 보인다.
```

## Task 17: `model_readiness` — worker가 쓰고 API가 읽는다

**Files:**
- Modify: `be/worker/damwha_worker/db/core.py`, `db/__init__.py`
- Create: `be/worker/damwha_worker/models/downloads.py`
- Create: `be/worker/tests/test_model_readiness.py`
- Modify: `be/worker/damwha_worker/models/bge_embed.py`, `pyannote_diar.py`, `errors.py`
- Modify: `be/worker/damwha_worker/__main__.py`, `embed_service.py`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `MODEL_READINESS_KEY = "model_readiness"`
  - `def merge_model_readiness(conn, key: str, entry: dict) -> None` — **원자적 merge**
  - `def report_download(conn_factory, key: str)` — 컨텍스트 매니저. 진입에 `downloading`, 성공에 `ready`, 예외에 `failed`.
  - `errors.classify_download(exc) -> ErrorKind` — 401·403은 PERMANENT.
  Task 19의 API·FE가 이 행을 읽는다.

- [ ] **Step 1: 기존 공유 행을 읽는다**

```bash
sed -n '1,45p' be/worker/damwha_worker/db/core.py
sed -n '70,90p' be/src/system/capabilities.ts
```

`worker_capabilities`가 선례다 — worker가 쓰고 API는 읽기 전용. 같은 방향, 같은 자리.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`be/worker/tests/test_model_readiness.py`:

```python
import json

from damwha_worker.db.core import MODEL_READINESS_KEY, merge_model_readiness, read_model_readiness


def test_merge_writes_one_key(conn):
    merge_model_readiness(conn, "BAAI/bge-m3", {"state": "downloading", "bytes_done": 10})
    got = read_model_readiness(conn)
    assert got["entries"]["BAAI/bge-m3"]["state"] == "downloading"


def test_merge_does_not_erase_other_keys(conn):
    """여러 writer(supervisor·--once 자식·embed)가 한 행에 붙는다. 통째로 덮으면 서로를 지운다."""
    merge_model_readiness(conn, "a/x", {"state": "ready"})
    merge_model_readiness(conn, "b/y", {"state": "downloading"})
    entries = read_model_readiness(conn)["entries"]
    assert set(entries) == {"a/x", "b/y"}
    assert entries["a/x"]["state"] == "ready"


def test_older_update_does_not_overwrite_newer(conn):
    """ready를 본 뒤 도착한 늦은 downloading은 버린다 (Electron Phase 4 스펙 §6.9)."""
    merge_model_readiness(conn, "a/x", {"state": "downloading", "updated_at": "2026-09-16T00:00:10Z"})
    merge_model_readiness(conn, "a/x", {"state": "ready", "updated_at": "2026-09-16T00:00:20Z"})
    merge_model_readiness(conn, "a/x", {"state": "downloading", "updated_at": "2026-09-16T00:00:15Z"})
    assert read_model_readiness(conn)["entries"]["a/x"]["state"] == "ready"


def test_entry_carries_writer_and_timestamps(conn):
    merge_model_readiness(conn, "a/x", {"state": "downloading"}, writer="w-1")
    e = read_model_readiness(conn)["entries"]["a/x"]
    assert e["writer"] == "w-1"
    assert e["updated_at"]
```

`errors` 분류 테스트:

```python
def test_http_401_and_403_are_permanent():
    from damwha_worker.errors import ErrorKind, classify_download
    assert classify_download(_http_error(401)) is ErrorKind.PERMANENT
    assert classify_download(_http_error(403)) is ErrorKind.PERMANENT


def test_network_failure_is_transient():
    from damwha_worker.errors import ErrorKind, classify_download
    assert classify_download(ConnectionError("boom")) is ErrorKind.TRANSIENT
```

- [ ] **Step 3: 실패를 확인한다**

```bash
uv run --directory be/worker pytest tests/test_model_readiness.py -v
```

- [ ] **Step 3-b: 동시성과 외부 DB 모드 테스트를 더한다**

```python
def test_two_connections_do_not_erase_each_other(conn, conn2):
    """실제 writer는 supervisor·--once 자식·embed로 **다른 프로세스**다. 한 연결에서
    순차로 쓰는 테스트는 그 경합을 증명하지 못한다."""
    merge_model_readiness(conn, "a/x", {"state": "downloading"})
    merge_model_readiness(conn2, "b/y", {"state": "downloading"})
    assert set(read_model_readiness(conn)["entries"]) == {"a/x", "b/y"}


def test_creates_the_row_when_absent(conn):
    conn.execute("delete from app_setting where key = %s", (MODEL_READINESS_KEY,))
    merge_model_readiness(conn, "a/x", {"state": "downloading"})
    assert read_model_readiness(conn)["entries"]["a/x"]["state"] == "downloading"


def test_equal_timestamps_keep_the_stored_value(conn):
    """동률은 무시한다 — 먼저 쓴 것이 이긴다. 뒤집으면 진행 갱신이 ready를 덮을 수 있다."""
    merge_model_readiness(conn, "a/x", {"state": "ready", "updated_at": "2026-09-16T00:00:20Z"})
    merge_model_readiness(conn, "a/x", {"state": "downloading", "updated_at": "2026-09-16T00:00:20Z"})
    assert read_model_readiness(conn)["entries"]["a/x"]["state"] == "ready"


def test_shared_state_off_writes_nothing(conn, monkeypatch):
    """외부 DB 디버그 모드 (스펙 §5·§6.9). worker_capabilities도 같은 규칙이다."""
    monkeypatch.setenv("DAMWHA_SHARED_STATE", "off")
    merge_model_readiness(conn, "a/x", {"state": "downloading"})
    assert read_model_readiness(conn) == {} or "a/x" not in read_model_readiness(conn).get("entries", {})
```

`conn2`는 **두 번째 연결**을 주는 fixture다. 없으면 만든다 — 기존 `conn` fixture와 같은 DB를
가리키되 연결이 달라야 한다.

- [ ] **Step 4: `db/core.py`에 원자적 merge를 더한다**

```python
MODEL_READINESS_KEY = "model_readiness"


def merge_model_readiness(conn, key: str, entry: dict, writer: str | None = None) -> None:
    """`app_setting.model_readiness`의 **한 key만** 덮는다 (Electron Phase 4 스펙 §6.9).

    한 행에 writer가 셋 붙는다 — supervisor, `--once` 자식, embed. 읽고-고치고-쓰면 둘이
    서로의 항목을 지우므로 **한 SQL 문**으로 merge한다.

    같은 key의 역전도 여기서 막는다: 쓰려는 `updated_at`이 지금 값보다 오래됐으면 버린다.
    `ready`를 본 뒤 도착한 늦은 `downloading`이 그 경우다.
    """
```

한 문장으로 쓴다. `INSERT … ON CONFLICT DO UPDATE`에서 **충돌한 행의 현재 `entries`**에
`jsonb_build_object(key, entry)`를 `||`로 merge하고, 역전 방지는 `WHERE`에 넣는다:

```sql
INSERT INTO app_setting (key, value) VALUES (%(k)s, %(seed)s::jsonb)
ON CONFLICT (key) DO UPDATE SET value = jsonb_set(
  app_setting.value, '{entries}',
  COALESCE(app_setting.value->'entries', '{}'::jsonb) || %(entry)s::jsonb
)
WHERE COALESCE(
  app_setting.value->'entries'->%(mk)s->>'updated_at', ''
) < %(now)s
```

- `seed`는 이 key 하나만 담은 완성된 문서다 — 행이 없을 때 그대로 들어간다.
- `WHERE`의 `COALESCE(…, '')`가 **없는 key를 빈 문자열로** 만들어 항상 통과시킨다.
- `<` 비교라 **동률은 무시**한다 — 먼저 쓴 것이 이긴다. `<=`로 하면 같은 밀리초의 진행
  갱신이 `ready`를 덮을 수 있다.
- ISO8601 UTC 문자열이라 사전순 비교가 시간순과 같다.
- 최상위 `updated_at`도 같은 문장에서 갱신한다 (`jsonb_set`을 한 번 더 감싸거나
  `||`로 얹는다).

`WHERE`가 거짓이면 **아무 행도 안 바뀐다** — 그것이 의도다. 두 문장으로 나누면 그 사이에
다른 writer가 낀다.

- [ ] **Step 5: `downloads.py`를 쓴다**

```python
"""HF 다운로드의 진행·실패를 `app_setting.model_readiness`에 올린다.

**진행 갱신은 초당 1회 이하로 누른다.** 한 다운로드가 DB를 두들기지 않게.

여기서 다루지 않는 것이 하나 있다 — `mlx_lm.server`는 **별도 프로세스**라 이 훅이 자동으로
붙지 않는다. LLM 모델의 첫 다운로드는 그 서버가 자기 안에서 하고, 우리는 서버가 준비될
때까지의 시간으로만 그것을 안다 (llm_server.py의 start timeout). 그래서 LLM 항목은
`downloading`을 서버 기동 시작에, `ready`를 준비 완료에 적는다 — 바이트 진행은 없다.
"""
```

`bge_embed.py`·`pyannote_diar.py`·`whisper_mlx.py`의 모델 로드를 이 컨텍스트 매니저로 감싼다.

- [ ] **Step 5-b: `DAMWHA_SHARED_STATE`로 두 writer를 끈다**

`db/core.py`에 게이트 하나:

```python
def shared_state_enabled() -> bool:
    """외부 DB 디버그 모드에서는 공유 행을 쓰지 않는다 (Electron Phase 4 스펙 §5·§6.9).

    URL 모양으로 추정하지 않는다 — worker는 자기가 어느 DB에 붙었는지 알 수 없다. 앱이
    명시적으로 끈다. 기본은 켬이라 웹 흐름(`pnpm worker`, 이 변수 없음)의 기존 보고 동작은
    그대로다.
    """
    return os.environ.get("DAMWHA_SHARED_STATE", "on") != "off"
```

`merge_model_readiness`와 **`upsert_worker_capabilities` 둘 다** 첫 줄에서 이것을 본다.
Phase 3이 남긴 "외부 DB 모드에서 worker가 capabilities 한 행을 쓴다"는 한계가 여기서 닫힌다.

앱 쪽은 Task 12의 `appOwnedChildEnv`가 `databaseMode.kind === "external"`일 때
`DAMWHA_SHARED_STATE: "off"`를 넣는다.

- [ ] **Step 6: `pyannote_diar.py`의 401·403을 보존한다**

```python
    def __init__(self, model: str, hf_token: str | None, device: str) -> None:
        ...
        # HF의 401·403을 일반 RuntimeError로 접지 않는다. 그 둘은 다른 실패이고 다른
        # 안내가 필요하다 — 401은 "토큰이 유효하지 않아요", 403은 "사용 조건을 먼저
        # 수락해야 해요"다 (Electron Phase 4 스펙 §8). errors.py의 분류기가 옛 코드에서는
        # 이것을 TRANSIENT로 보고 재시도했는데, 둘 다 재시도해도 안 되는 실패다.
```

- [ ] **Step 7: bge-m3 리비전을 고정한다**

`bge_embed.py`에서 `revision=`을 명시하고 safetensors만 받게 한다. Phase 0 실측: 같은 가중치를 `pytorch_model.bin`(rev `5617a9f…`)과 `model.safetensors`(rev `9a0624b…`)로 두 벌, 리비전까지 갈려 받아 2.1 GB를 낭비했다.

- [ ] **Step 8: 통과를 확인한다**

```bash
pnpm worker:test
uv run --directory be/worker ruff check .
```

**Verify:** 새 테스트 + 기존 테스트 전부 통과.

**Review:**
- merge가 **한 SQL 문**인가 (읽고-쓰기 두 문장이면 경합이 남는다).
- 역전 방지가 실제로 동작하는가.
- 진행 갱신이 초당 1회 이하로 눌리는가.
- 401·403이 PERMANENT인가.
- `mlx_lm.server`의 한계가 주석에 적혀 있는가.

- [ ] **Step 9: 커밋**

```bash
git add be/worker/damwha_worker/db/ be/worker/damwha_worker/models/ be/worker/damwha_worker/errors.py \
        be/worker/damwha_worker/__main__.py be/worker/damwha_worker/embed_service.py \
        be/worker/tests/test_model_readiness.py
git commit -m "feat(worker): 모델 다운로드 상태를 app_setting에 올린다"
```

커밋 본문:

```
worker_capabilities와 같은 자리, 같은 방향이다 — worker가 쓰고 API는 읽기
전용. job 테이블 계약 밖의 두 번째 공유 행이 된다.

한 행에 writer가 셋 붙는다(supervisor·--once 자식·embed). 읽고-고치고-쓰면
서로의 항목을 지우므로 한 SQL 문으로 key 단위 merge한다. 같은 key의 역전도
막는다 — ready를 본 뒤 도착한 늦은 downloading은 버린다.

pyannote의 401·403을 일반 RuntimeError로 접지 않는다. 옛 코드는 그것을
TRANSIENT로 분류해 재시도했는데 둘 다 재시도해도 안 되는 실패이고, 서로
다른 안내가 필요하다 — 401은 토큰 무효, 403은 사용 조건 미수락이다.

bge-m3는 리비전을 고정하고 safetensors만 받는다. 지금까지 같은 가중치를
pytorch_model.bin과 model.safetensors로 두 벌, 리비전까지 갈려 받아
2.1 GB를 낭비했다.

mlx_lm.server는 별도 프로세스라 진행 훅이 안 붙는다 — LLM 항목은 바이트
진행 없이 기동 시작/준비 완료만 적는다.
```

---

## Task 18: 준비 유예와 재시도 3층

**Files:**
- Modify: `desktop/src/services/supervisor.ts`
- Create: `desktop/src/services/model-readiness.ts`
- Create: `desktop/tests/services/model-readiness.test.ts`
- Modify: `desktop/tests/services/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 17의 `model_readiness` 행 모양
- Produces:
  - `export interface ReadinessEntry { key: string; state: "downloading" | "ready" | "failed"; bytesDone: number; bytesTotal: number; updatedAt: number; writer: string; attempt: number; error: string | null }`
  - `export function parseModelReadiness(json: unknown): ReadinessEntry[]`
  - `export function downloadInProgress(entries: ReadinessEntry[], writer: string, now: number, stallMs: number): boolean`
    — **`writer`로 거른다.** 스펙 §6.9가 요구한 구별이다.
  - `export const STALL_MS = 120_000`
  - 감독자에 `restartService(id)` — `retry()`와 별개 경로.

`writer`와 `attempt`를 `ReadinessEntry`에 **남긴다.** 초안은 버렸는데, 그러면 다른 서비스의
다운로드로 이 서비스의 유예가 연장된다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```typescript
describe("downloadInProgress", () => {
  const entry = (over = {}) => ({
    key: "a", state: "downloading", bytesDone: 1, bytesTotal: 9,
    updatedAt: 1_000, writer: "embed", attempt: 1, error: null, ...over,
  });

  it("진행이 갱신되고 있으면 true — 준비 유예를 소모하지 않는다", () => {
    expect(downloadInProgress([entry()] as never, "embed", 1_000 + 30_000, STALL_MS)).toBe(true);
  });

  it("진행이 120초 멈추면 false — 무진행으로 본다", () => {
    expect(downloadInProgress([entry()] as never, "embed", 1_000 + 130_000, STALL_MS)).toBe(false);
  });

  it("downloading이 없으면 false", () => {
    expect(downloadInProgress([entry({ state: "ready" })] as never, "embed", 2_000, STALL_MS)).toBe(false);
  });

  it("**다른 writer의 다운로드는 이 서비스의 시계를 멈추지 않는다**", () => {
    // embed가 죽어 가는 동안 worker가 whisper를 받고 있으면, 그것 때문에 embed의 유예가
    // 영영 안 끝나서는 안 된다 (스펙 §6.9).
    const e = [entry({ writer: "desktop-uuid-worker", key: "mlx-community/whisper" })];
    expect(downloadInProgress(e as never, "embed", 1_000 + 30_000, STALL_MS)).toBe(false);
  });

  it("무진행 판정이 bytesDone이 아니라 updatedAt 기준이다", () => {
    // bytes_total을 모르는 다운로드가 있다. bytesDone만 보면 진행 중인 것을 멈춘 것으로 본다.
    const e = [entry({ bytesDone: 0, bytesTotal: 0, updatedAt: 1_000 })];
    expect(downloadInProgress(e as never, "embed", 1_000 + 30_000, STALL_MS)).toBe(true);
  });
});
```

감독자 테스트:

```typescript
it("다운로드가 진행 중이면 준비 유예를 소모하지 않는다", async () => {
  // embed의 readyTimeoutMs는 180초인데 bge-m3 첫 다운로드는 그보다 오래 걸린다
  // (services/embed.ts:47). 진행 중이면 시계를 멈춘다.
});

it("restartService는 살아 있는 서비스도 내리고 다시 띄운다 — retry()와 다르다", async () => {
  // needsRetry는 rt.status.process !== "running" || rt.result === null 이라
  // 살아 있는 worker를 건너뛴다(supervisor.ts:490). 토큰 교체는 그 경로로는 반영되지 않는다.
});
```

- [ ] **Step 2-b: LLM 쪽 제한을 Python에 넣는다**

`llm_server.py:_wait_ready`의 600초 deadline에 같은 규칙을 넣는다. **DB를 다시 읽을 필요가
없다** — Task 8의 `llm_entry`가 같은 프로세스에서 돌므로 다운로드 진행을 직접 안다.

```python
def _wait_ready(proc, model, settings, probe, monotonic, sleep) -> None:
    """서버가 /models에 응답할 때까지 기다린다. 조기 종료는 그 자리에서 실패.

    첫 실행은 HF 다운로드를 포함한다. **다운로드가 진행 중인 동안에는 deadline을 밀어
    준다** — 고정 600초로는 큰 모델의 첫 다운로드를 못 덮고, 넘으면 받다 만 것을 버리고
    처음부터 다시 받는 고리가 생긴다 (Electron Phase 4 스펙 §6.9).

    대신 **무진행 상한**을 둔다: 진행이 STALL_SECONDS 동안 멈추면 실패로 본다. 진행의
    근거는 자식이 model_readiness에 남기는 updated_at이다 — 바이트 수가 아니다.
    bytes_total을 모르는 다운로드가 있다.
    """
```

`llm_entry`가 `install_hf_progress_hook()`으로 진행을 올리고(Task 17), `_wait_ready`는 그
행의 `updated_at`을 본다. 부모(`--once` 자식)와 LLM 서버는 다른 프로세스라 DB가 그 사이의
유일한 통로다 — 이것이 §6.9의 관측 수단이 `llm_entry` 결정에 기대는 지점이다.

- [ ] **Step 3: 실패를 확인하고 구현한다**

`model-readiness.ts`는 순수 모듈이다(electron·DB를 모른다). 감독자가 DB에서 읽은 JSON을 넘긴다.

감독자 변경 둘:

```typescript
  /**
   * 준비 유예 계산에 다운로드를 끼워 넣는다 (Electron Phase 4 스펙 §6.9).
   *
   * embed의 readyTimeoutMs는 180초인데(embed.ts:47) bge-m3 첫 다운로드는 그보다 오래
   * 걸린다. 제한을 넘는 다운로드는 진행 중이어도 실패·재시작 대상이 되고, 그러면 받다 만
   * 것을 버리고 처음부터 다시 받는 고리가 생긴다.
   *
   * **이 규칙은 embed에만 적용된다.** LLM 서버의 600초 제한은 감독자가 아니라 Python
   * `llm_server.py:_wait_ready`(`config.py:53`) 안에 있다 — 그 서버는 이미 준비된 worker의
   * job 자식이 띄우고, `awaitReady()`는 서비스 기동 때만 돈다. 감독자는 그것을 볼 수 없다.
   * LLM 쪽은 Step 2-b가 Python에서 같은 규칙을 넣는다.
   *
   * 고정 deadline이 아니라 **다운로드 시간을 뺀 누적**으로 센다. 그러지 않으면 다운로드가
   * 끝난 뒤 남은 유예가 0이라 곧바로 실패한다.
   *
   * **`writer`로 서비스를 구별한다.** 다른 서비스가 받는 모델 때문에 이 서비스의 시계가
   * 멈추면 안 된다 — embed가 죽어 가는 동안 worker가 whisper를 받고 있으면 embed의 유예가
   * 영영 안 끝난다.
   */
```

```typescript
  /**
   * **서비스 재시작 — `retry()`와 별개 경로다** (스펙 §6.10 2층).
   *
   * `retry()`의 `needsRetry`는 `rt.status.process !== "running" || rt.result === null`이라
   * 살아 있는 서비스를 건너뛴다. 토큰을 바꾼 뒤 필요한 것은 정확히 그 반대다 — 멀쩡히
   * 돌고 있는 worker를 내리고 새 env로 다시 띄워야 한다.
   *
   * **앱이 소유하지 않은 것은 못 내린다.** 채택한 외부 embed(`owned: false`)와 stand-down
   * 상태의 worker에는 이 경로를 열지 않는다 — 화면이 그 버튼을 비활성으로 보인다.
   */
  async function restartService(id: ServiceId): Promise<void> { /* … */ }
```

- [ ] **Step 4: 통과를 확인한다**

```bash
pnpm --filter damwha-desktop run test
pnpm --filter damwha-desktop run lint
pnpm worker:test
```

**Verify:** 테스트 전부 통과.

**Review:**
- `restartService`가 `owned: false`(채택한 외부 embed)와 stand-down worker를 **거부하는가.**
- 무진행 판정이 `updatedAt` 기준인가 (`bytesDone`이 아니라).
- **`writer`로 서비스를 구별하는가** — 다른 서비스의 다운로드가 이 서비스의 시계를 멈추면 안 된다.
- 감독자가 **고정 deadline이 아니라 누적**으로 세는가.
- LLM 쪽 제한이 **Python에** 들어갔는가 (감독자가 아니라).

- [ ] **Step 4: 커밋**

```bash
git add desktop/src/services/supervisor.ts desktop/src/services/model-readiness.ts desktop/tests/services/
git commit -m "feat(desktop): 다운로드 중에는 준비 유예를 멈추고 서비스 재시작 경로를 연다"
```

커밋 본문:

```
embed의 준비 유예는 180초인데 bge-m3 첫 다운로드는 그보다 오래 걸린다.
LLM 서버도 600초 제한이다. 제한을 넘는 다운로드는 진행 중이어도 실패·
재시작 대상이 되고, 그러면 받다 만 것을 버리고 처음부터 다시 받는 고리가
생긴다. 진행이 갱신되고 있으면 유예를 소모하지 않고 무진행 120초로 판정한다.

서비스 재시작은 retry()와 별개 경로다. needsRetry는 살아 있는 서비스를
건너뛰는데, 토큰을 바꾼 뒤 필요한 것은 정확히 그 반대다. 앱이 소유하지
않은 것(채택한 외부 embed, stand-down worker)에는 열지 않는다.
```

---

## Task 19: 화면 — 모델 준비·토큰·재시도 3층

**Files:**
- Modify: `be/src/system/*` (설정 조회 응답에 `modelReadiness`)
- Modify: `desktop/src/windows/status-view.ts`, `shell-hints.ts`
- Modify: `desktop/shell/status.html` (또는 해당 화면 파일)
- Modify: `fe/src/**` (모델 준비 표시 — 최소 범위)
- Modify: `desktop/src/diagnostics/causes.ts`

**Interfaces:**
- Consumes: Task 17의 `model_readiness`, Task 18의 `parseModelReadiness`·`restartService`, Task 14의 `maskToken`·`TokenStore`
- Produces: 사용자에게 보이는 표면. 뒤 Task 없음.

- [ ] **Step 1: API가 행을 읽어 내보낸다**

`worker_capabilities`를 읽는 자리와 같은 방식으로 `model_readiness`를 읽어 설정 조회 응답에 `modelReadiness`로 얹는다. **읽기 전용이다** — API가 이 행을 쓰지 않는다.

- [ ] **Step 2: 상태 창에 세 가지를 더한다**

1. **모델 준비** — `downloading`이면 진행(`bytesTotal`이 0이면 "받는 중"만), `failed`면 사유와 §6.10의 층별 안내.
2. **토큰** — `maskToken`으로 마스킹 표시, 수정·삭제. 바꾸면 **"서비스 다시 시작"**이 필요하다고 말하고 그 버튼을 함께 둔다.
3. **재시도 3층을 구분해 말한다** (스펙 §6.10):

| 상황 | 화면이 주는 것 |
| --- | --- |
| 다운로드가 끊겼다, 서비스는 살아 있다 | "네트워크가 돌아오면 다음 처리에서 이어받아요" — 버튼 없음 |
| 서비스가 죽었거나 토큰을 바꿨다 | **"서비스 다시 시작"** 버튼 |
| job이 이미 실패했다 | "이 회의를 다시 처리하기" — 기존 `POST /meetings/:id/reprocess`로 보낸다 |

**"다시 시도" 하나로 뭉치지 않는다.** 뭉치면 눌러도 아무 일도 안 일어나는 경우가 생긴다 — Phase 2가 stand-down worker에서 정확히 그 문제를 겪었다.

- [ ] **Step 3: `causes.ts`에 남은 원인을 더한다**

```typescript
  modelDownloadFailed: { text: "모델을 받지 못했어요.", hint: "네트워크를 확인해 주세요. 다음 처리에서 받다 만 곳부터 이어받아요." },
  modelDownloadStalled: { text: "모델 받기가 멈췄어요.", hint: "'서비스 다시 시작'을 눌러 주세요." },
  diskFull: { text: "디스크 공간이 부족해요.", hint: "모델을 받으려면 공간이 더 필요해요." },
  orphanScanFailed: { text: "이전 실행이 남긴 프로세스를 확인하지 못했어요.", hint: "다시 시도해 주세요. 계속되면 앱을 다시 켜 주세요." },
```

`hfGateNotAccepted`(Task 14)의 안내에 **그 모델의 수락 페이지 링크**를 넣는다.

- [ ] **Step 4: FE에 모델 준비를 보인다**

`fe/DESIGN.md` 관례를 따른다. 최소 범위 — 검색이 키워드로만 도는 동안 그 이유를 말하고, 처리 중 모델을 받는 중이면 그것을 보인다.

- [ ] **Step 5: 통과를 확인한다**

```bash
pnpm build
pnpm test
pnpm lint
```

**Verify:** 세 명령 통과.

**Review:**
- API가 `model_readiness`를 **쓰지 않는가** (읽기 전용 계약).
- 토큰이 마스킹돼 보이는가.
- 세 층이 화면에서 **구분돼** 말해지는가.
- 소유하지 않은 서비스의 재시작 버튼이 비활성인가.

- [ ] **Step 6: 커밋**

```bash
git add be/src fe/src desktop/src/windows desktop/shell desktop/src/diagnostics/causes.ts
git commit -m "feat: 모델 준비 상태와 토큰 설정을 화면에 보인다"
```

---

## Task 20: 통합 검증과 결과 문서

스펙 §9의 완료 기준 28건을 판정한다. **증거 없이 "통과"라고 쓰지 않는다** (`superpowers:verification-before-completion`).

**Files:**
- Create: `docs/superpowers/reports/2026-09-16-electron-phase-4-embedded-python-runtime-results.md`
- Modify: `docs/electron-migration-roadmap.md` (Phase 4 상태)
- Modify: `desktop/CLAUDE.md`, `be/worker` 운영 문서

- [ ] **Step 1: 기준선을 대조할 수 있는지 먼저 본다**

기준선은 **Task 0이 이미 떴다.** 여기서 뜨면 Task 2가 `.venv`를 바꾼 뒤다.

```bash
ls /tmp/p4-baseline/now || { echo "Task 0의 기준선이 없다 — 이 검증은 성립하지 않는다"; exit 1; }
```

없으면 **여기서 멈추고 사용자에게 알린다.** 기준선 없이 "데이터가 보존됐다"고 적을 수 없다.

- [ ] **Step 2: packaged 앱으로 축 A~E를 순서대로 판정한다**

각 기준마다 **명령과 출력**을 결과 문서에 남긴다. 스펙 §9의 "확인" 열이 절차다.

축 순서를 지킨다 — A(토큰) → B(실사용) → C(격리) → D(수명주기) → E(회귀·보존). B가 모델을 받아 놓아야 C·D가 실제 프로세스를 볼 수 있다.

**P4-C11(번들 mlx-lm)의 함정:** `~/.local/bin/mlx_lm.server`를 일시 격리하고 재현한다.

```bash
mv ~/.local/bin/mlx_lm.server /tmp/mlx_lm.server.hidden
# 요약 job 실행 → 성공해야 한다
mv /tmp/mlx_lm.server.hidden ~/.local/bin/mlx_lm.server
```

**P4-C24(웹 회귀)는 별도 회차다** — 앱을 끄고 Docker DB + `be/storage` + `.venv`로 돈다 (스펙 §5).

- [ ] **Step 3: 기준선과 대조한다**

```bash
pnpm db:up          # Task 0과 **같은 조건**이어야 한다
bash desktop/scripts/phase4-baseline.sh verify
```

기대: `abs-*` 전부 `PASS`. 하나라도 `FAIL`이면 P4-C26 미충족이다.

`mut-*`(허용 변경)과 `app-*`(앱 데이터)는 스크립트가 판정하지 않는다 — 사람이 본다:

| 대조 | 합격 조건 |
| --- | --- |
| `mut-uv.lock` | Task 2가 의도한 차이(`mlx-lm`·`mlx` 추가)만. 다른 패키지 버전 변화가 있으면 P4-C25의 회귀 확인 결과를 함께 적는다 |
| `mut-venv-versions.txt` | 새 `uv.lock`과 일치 |
| `mut-local-bin.txt` | `mlx_lm.server`가 **제자리로 돌아왔는가** (P4-C11이 일시 이동시켰다) |
| `app-storage.txt` | 기준선의 모든 줄이 지금도 있다. **추가만** 있고 삭제·변경 0 |
| `app-db-rows.txt` | 회의 수가 줄지 않았다 |

- [ ] **Step 4: 결과 문서를 쓴다**

Phase 3 결과 문서(`2026-09-14-…-results.md`)의 절 구성을 따른다:

```
1. 스펙 리뷰      — 설계 대화의 결정, Codex 1회차(스펙 §17을 옮긴다), 메인 세션 리뷰, 사용자 승인
2. 계획 검증      — 완료 기준과 Task의 연결표, 지적과 조치, 사전 실측
3. 단계별 실행과 리뷰 — Task별 결과·커밋, 실제로 잡힌 결함, 판정 기록, 이월 항목
4. 최종 검증      — 축별 판정표(28건), 검증이 잡은 결함, 비고
5. 남은 제약과 후속 Phase 인계 — 구현 값과 근거, 안 고친 것, 리뷰가 남긴 것, Phase 5·6 인계
```

**Task 1의 numba 측정 결과와 entitlement 결정**을 §5.1 "구현 값과 근거" 표에 넣는다.

- [ ] **Step 5: 로드맵과 운영 문서를 갱신한다**

- `docs/electron-migration-roadmap.md` — 상태 줄, Phase 4 절의 판정표, Phase 5·6 인계.
- `desktop/CLAUDE.md` — 명령(`build-python.sh`·`build-ffmpeg.sh`), 구조 표(`process/orphans.ts`·`config/token-store.ts`·`windows/token-window.ts`), 데이터 위치(`models/`·`hf-token.bin`), 디버깅(런타임 자기 보고 줄 읽는 법).
- `be/worker` 문서 — `FFMPEG_BIN`·`FFPROBE_BIN`·`LENS_LLM_SERVER_BIN`의 새 의미, `mlx-lm` 편입.

- [ ] **Step 6: 브랜치를 마무리한다**

`superpowers:finishing-a-development-branch`로 병합 판단.

**Verify:** 28건 전부 판정되고 각각 증거가 있다. 미충족이 있으면 **Phase를 미완료로 유지한다** (로드맵 §6).

**Review:**
- 판정하지 않은 기준이 없는가.
- "통과"에 명령과 출력이 붙어 있는가.
- 기준선 대조가 §5의 두 부류(절대 불변 / 앱 쓰기 영역)를 **구분해서** 했는가.
- Task 1의 측정 결과가 문서에 있는가 (P4-C28).

---

## 자체 검토

**1. 스펙 coverage** — §6의 계약 10개와 Task의 대응:

| 스펙 | Task |
| --- | --- |
| §6.1 번들 계약 | 3, 4, 5, 6 |
| §6.2 실행 계약 | 8, 10, 11, 13 |
| §6.3 env 주입 | 12 |
| §6.4 HF 토큰 | 14 |
| §6.5 소유·고아 처분 | 9, 15, 16 |
| §6.6 ffmpeg·모델 경로 | 7, 17 |
| §6.7 dev 루프 | 12 (PYTHONPATH) |
| §6.8 numba 측정 | 1 |
| §6.9 model_readiness | 17, 18 |
| §6.10 재시도 3층 | 18, 19 |
| §2.4 mlx-lm 편입 | 2 |
| §9 완료 기준 28건 | 20 |

**2. 완료 기준 coverage** — 30건 각각의 구현 Task와 관찰 지점:

| ID | 만드는 Task | 판정 | 실패 재현 |
| --- | --- | --- | --- |
| C1 토큰 게이트 | 14 | 20 | 토큰 파일 삭제 |
| C2 평문 없음 | 14 | 20 | — (grep) |
| C3 오타 거절 | 14 | 14·20 | 잘못된 토큰 |
| C4 토큰 교체 반영 | 14 (Step 6-b) | 14·20 | 미수락 계정 → 수락 계정 |
| C5 모델 0에서 완주 | 8·17 | 20 | `models/` 비우기 |
| C6 진행 표시 | 17·19 | 20 | — |
| C7 끊김·이어받기 | 17·19 | 20 | 네트워크 차단 |
| C8 403 vs 401 | 17 (`pyannote_diar`·`errors`) | 20 | 미수락 계정 토큰 |
| C9 재다운로드 없음 | 17 | 20 | — |
| C10 bge-m3 한 벌 | 17 (Step 7) | 20 | — |
| C11 번들 mlx-lm | 2·5·8 | 20 | `~/.local/bin/mlx_lm.server` 일시 이동 |
| C12 번들 런타임 | 9 (`runtime_report`, capabilities 프로브 포함) | 20 | — |
| C13 외부 미참조 | 11 (PATH) ·12 (env 위생) | 20 | — |
| C14 캐시 재사용 | 12 (`HF_HOME`) | 20 | `.app` 교체 |
| C15 번들 위생 | 4·5·6 | 6·20 | — |
| C16 저장소 없이 기동 | 12 | 20 | 저장소 일시 이동 |
| C17 ⌘Q 정리 | 13·16 | 20 | — |
| C18 고아 정리 | 15 | 20 | `kill -9` main |
| C19 부모 선종료 (a·b) | 16 | 16 (통합)·20 | supervisor·`--once` `kill -9` |
| C20 자손 SIGKILL | 16 | 20 | `SIG_IGN` fixture 프로세스 |
| C21 외부 worker 보존 | 15 | 20 | `pnpm worker` 동시 실행 |
| C22 스캔 실패 시 중단 | 15 | 15 (단위) | `ps` 비영 종료·빈 출력 주입 |
| C23 dev 반영 | 12 (`PYTHONPATH`) | 20 | — |
| C24 웹 회귀 | — (회귀 방지) | 20 (별도 회차) | — |
| C25 mlx 정렬 회귀 | 2 (Step 6) | 2·20 | — |
| C26 절대 불변 | 0 | 20 | Task 0 Step 3이 탐지를 실증 |
| C27 앱 데이터 보존 | 0 | 20 | — |
| C28 numba 측정 | 1 | 1·20 | — |
| C29 오프라인 처리 | 17 | 20 | 네트워크 차단 |
| C30 env 재주입 차단 | 12 (Step 3-b) | 12 (단위)·20 | `config.json`에 `PYTHONHOME` |

**단위 테스트로만 판정하는 것**(스펙 §9 비고): C22, `safeStorage` 불가, 복호화 실패,
무진행 제한, `model_readiness` 동시 writer 역전.

**3. 타입 일관성** — `pythonBinaries`/`ffmpegBinaries`(Task 10) → `LaunchContext.bins`(Task 11) → `launchPython`(Task 11) → `workerSpec`/`embedSpec`(Task 13). `parseDamwhaProcesses`/`classify`(Task 15) → `worker-shutdown`(Task 16). `merge_model_readiness`(Task 17) → `parseModelReadiness`(Task 18) → 화면(Task 19).

**4. 순서 의존:**

- **Task 0이 맨 앞이다.** 기준선을 Task 2보다 뒤에 뜨면 `.venv` 변경을 못 잡는다.
- **Task 1은 Task 2 뒤, Task 6 앞이다.** 잠금에서 numba 버전을 읽어야 하고(Task 2),
  결과가 entitlement를 가른다(Task 6). `uv.lock`에 numba가 이미 있으면 Task 2 전에 재도 된다.
- **Task 2 → Task 4.** `uv.lock`이 빌드 입력이다.
- **Task 8 → Task 9.** `embed_service`의 자기 보고가 `runtime_report`(Task 9)를 쓴다.
  연달아 실행하거나, Task 8에서 그 줄만 빼 둔다.
- **Task 11 → 13.** 11이 새 런처를 더해 공존시키고, 13이 소비자를 옮긴 뒤 옛 것을 지운다.
  **각 Task가 초록불로 끝난다** — 중간에 컴파일이 깨진 커밋을 남기지 않는다.
- **Task 17 → 18.** 유예 계산이 `model_readiness`를 읽는다.
- **Task 18 → 14 Step 6-b.** 토큰 교체가 `restartService`를 쓴다. 14를 18 뒤로 미루거나,
  14에서 그 Step만 뒤로 뺀다.

**5. 각 Task의 종료 상태** — 모든 Task가 `test`·`lint` 통과 상태로 끝난다. 로드맵 §5는
필수 검증 실패가 다음 단계 진행을 막는다고 못 박으므로, 의도적 실패를 다음 Task로 넘기지
않는다 (초안의 Task 11–13과 Task 2 Step 7이 그것을 어겼다).
