#!/bin/bash
# Task 8 — ad-hoc 서명 · hardened runtime · Gatekeeper 제약 실측 (스펙 P0-C9).
#
#   probe.sh sign         bundle/ 전수 조사 → signed/ 사본 → ad-hoc 서명(+runtime)
#                         → entitlement 최소 집합 실측 → R-5 실험 → RESULTS.md 갱신
#   probe.sh quarantine   com.apple.quarantine 부여 후 실행 → Gatekeeper 동작 관찰
#   probe.sh status       현재 signed/ 의 서명 상태 요약 (판정하지 않는다)
#
# ## 범위
#
# **ad-hoc 서명(`codesign -s -`)까지다.** Apple Developer Program 미가입이
# 확정됐으므로(스펙 §7.1 U-3) Developer ID 인증서와 공증은 다루지 않는다.
# 이 파일에는 공증 제출 도구의 이름조차 나오지 않는다 — 계획 Task 8 V6이
# 그것을 검사한다. 공증 선결 조건은 RESULTS.md 에 **목록으로만** 있다.
#
# ## 왜 사본에 서명하는가
#
# 원본 bundle/ 은 Task 2~7 의 산출물이고 계획 Task 8 V7 이 그 G1 무결성을
# 다시 확인한다. 서명은 파일을 바꾸는 작업이라 원본에 하면 앞 Task 의 증거가
# 되돌릴 수 없게 오염된다. 그래서 signed/ 로 복사한 뒤 사본에만 적용한다.
# signed/ 는 experiments/electron-phase-0/.gitignore 가 무시한다.
#
# ## 사본을 만들 때 한 가지를 고친다 — 콘솔 스크립트 셔뱅
#
# bundle/python/bin/ 의 콘솔 스크립트 셔뱅은 **원본 bundle 의 절대 경로**를
# 가리킨다(Task 3 의 G1 INFO 5231건이 그것이다). 사본에서 그대로 두면
# signed/python/bin/mlx_lm.server 를 실행해도 커널이 **원본의 서명되지 않은
# python** 을 exec 해서, 측정 대상이 signed/ 가 아니게 된다. 복사 직후
# 셔뱅의 접두사를 signed/ 로 바꾸는 이유다. 이것은 사본에 대한 조정이며
# 원본과 제품 코드는 건드리지 않는다.
#
# ## 서명 상태는 **슬라이스 단위**로 본다
#
# 이 번들의 Mach-O 일부는 universal(x86_64 + arm64) 이다. 그런 파일에서는
# arm64 슬라이스만 linker 가 ad-hoc 서명하고 x86_64 슬라이스는 서명되지 않은
# 채로 남는 일이 흔하다. `codesign --verify` 를 --arch 없이 부르면 그 파일
# 전체를 "code object is not signed at all" 이라고 보고한다 — 실제로는
# **우리가 도는 arm64 슬라이스가 서명돼 있는데도** 그렇다. 그래서 이
# 스크립트는 파일마다 --arch arm64 와 전체를 따로 재고, 셋으로 나눈다:
#
#   arm64-unsigned                    arm64 슬라이스에 서명이 없다 (진짜 R-5 대상)
#   arm64-signed-otherarch-unsigned   arm64 는 서명돼 있고 다른 슬라이스가 없다
#   signed                            전 슬라이스 서명
#
# ## 격리 (스펙 §4.0 / §4.2)
#
# 서명·검사 도구(codesign, xattr, spctl, file, otool)는 **측정 수단**이라
# 격리 대상이 아니다. 반면 **서명 후의 실행 재시도는 전부 run-isolated.sh 를
# 지난다** (계획 Task 8 Interfaces).
#
# ## hardened runtime 과 dyld 실측
#
# hardened runtime 은 프로세스를 dyld 기준 restricted 로 만들어 DYLD_* 환경
# 변수를 무시하게 한다. 즉 서명 후에는 G2 의 dyld 실측이 끊기고,
# run-isolated.sh 는 그것을 MEASUREMENT_UNAVAILABLE 로 남긴다. 그것은 이
# Task 의 관찰 대상이지 실패가 아니다 — RESULTS.md 에 사실로 기록한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

export LC_ALL=C

SIGN_DIR="$EXP_ROOT/signing"
BUNDLE_ROOT="$EXP_ROOT/bundle"
SIGNED_ROOT="$EXP_ROOT/signed"
INVENTORY="$SIGN_DIR/unsigned-inventory.txt"
RESULTS="$SIGN_DIR/RESULTS.md"
WORK="$SANDBOX/t8"
ENT_DIR="$WORK/ent"
PAYLOAD="$WORK/payload.py"
LEVEL_FILE="$WORK/level.txt"
MATRIX="$WORK/matrix.txt"

RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
SIGNED_PY="$SIGNED_ROOT/python/bin/python3.12"

CODESIGN=/usr/bin/codesign
XATTR=/usr/bin/xattr
SPCTL=/usr/sbin/spctl
FILE=/usr/bin/file
RSYNC=/usr/bin/rsync

# entitlement 토큰. 정규 순서는 이 순서다 — 회차 이름이 회차마다 달라지면
# 캐시 조회가 어긋난다.
ENT_TOKENS="jit uem dlv"

# 각 회차에서 도는 검사. payload.py 가 이름 하나를 받아 그 검사만 한다.
# **검사마다 프로세스를 새로 띄운다.** hardened runtime 위반은 예외가 아니라
# 프로세스 종료로 나타나서, 한 프로세스에 몰아넣으면 첫 번째 위반에서
# 나머지 결과가 통째로 사라진다.
CHECKS="selfcheck unsigned-so numba-jit stack-imports torch-mps torch-jit mlx-metal mlx-compile mlx-lm-gen"

# --- 작은 도구 ---------------------------------------------------------------

t8_die() { echo "FAIL: $*" >&2; exit 1; }

# 증거를 덮어쓰지 않는다 (스펙 §6). 회전 파일명은 1초 단위라 같은 초에 두 번
# 돌리면 앞의 것이 덮인다 — 충돌하면 -2, -3 을 붙인다.
t8_rotate() {
  local f base ext ts cand n
  f="$1"
  [ -f "$f" ] || return 0
  base="${f%.*}"
  ext="${f##*.}"
  ts=$(date -u '+%Y%m%dT%H%M%SZ')
  cand="$base.prev-$ts.$ext"
  n=2
  while [ -e "$cand" ]; do
    cand="$base.prev-$ts-$n.$ext"
    n=$((n + 1))
  done
  mv "$f" "$cand"
}

t8_utc() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# RESULTS.md 의 마커 사이를 파일 내용으로 갈아 끼운다.
#
# RESULTS.md 를 이 스크립트가 통째로 만들지 않는 이유가 있다. 공증 선결
# 조건 절에는 제출 도구의 이름이 나와야 하는데, 그 문자열이 이 스크립트에
# 들어가면 계획 V6(probe.sh 에 그 이름이 0건)이 깨진다. 그래서 산문은
# 커밋된 RESULTS.md 에 두고 이 스크립트는 기계가 만든 절만 끼운다.
t8_splice() {
  local marker src tmp
  marker="$1"
  src="$2"
  [ -f "$RESULTS" ] || t8_die "RESULTS.md 가 없다: $RESULTS (커밋된 문서다 — 이 스크립트는 절만 갈아 끼운다)"
  grep -q "^<!-- BEGIN:$marker -->\$" "$RESULTS" \
    || t8_die "RESULTS.md 에 <!-- BEGIN:$marker --> 마커가 없다"
  grep -q "^<!-- END:$marker -->\$" "$RESULTS" \
    || t8_die "RESULTS.md 에 <!-- END:$marker --> 마커가 없다"
  tmp="$WORK/results.splice.$$"
  awk -v m="$marker" -v src="$src" '
    $0 == "<!-- BEGIN:" m " -->" {
      print
      while ((getline line < src) > 0) print line
      close(src)
      skip = 1
      next
    }
    $0 == "<!-- END:" m " -->" { skip = 0 }
    !skip { print }
  ' "$RESULTS" > "$tmp" || t8_die "splice 실패: $marker"
  mv "$tmp" "$RESULTS"
}

# <디렉터리> <출력파일> — 하위 **정규 파일** 중 Mach-O 전량.
#
# find 에 -L 을 주지 않는다. 심볼릭 링크를 따라가면 같은 실물이 링크 이름으로
# 한 번 더 목록에 들어가고, codesign 은 링크를 따라가 같은 파일에 두 번
# 서명한다. bundle 에는 심볼릭 링크된 **디렉터리**가 없으므로(실측) -L 없이도
# 하위 전량을 본다.
t8_macho_list() {
  local root out files
  root="$1"
  out="$2"
  files="$WORK/files.$$.nul"
  find "$root" -type f -print0 > "$files" 2>/dev/null
  xargs -0 "$FILE" < "$files" 2>/dev/null \
    | grep -a 'Mach-O' \
    | sed -e 's/:[[:space:]]*Mach-O.*$//' -e 's/ (for architecture [^)]*)$//' \
    | sort -u > "$out"
  rm -f "$files"
}

# <파일> — "<분류> <flags 요약>" 한 줄. 파일 머리말의 세(+한) 분류다.
t8_sig_class() {
  local f whole arm cls d flags team sig
  f="$1"
  whole=$("$CODESIGN" --verify "$f" 2>&1)
  arm=$("$CODESIGN" --verify --arch arm64 "$f" 2>&1)
  case "$arm" in
    *"does not contain"*|*"no such architecture"*) cls="no-arm64-slice" ;;
    *"not signed at all"*)                          cls="arm64-unsigned" ;;
    *)
      case "$whole" in
        *"not signed at all"*) cls="arm64-signed-otherarch-unsigned" ;;
        *)                     cls="signed" ;;
      esac
      ;;
  esac
  d=$("$CODESIGN" --display --verbose=2 "$f" 2>&1)
  flags=$(printf '%s\n' "$d" | sed -n 's/.*flags=\([^ ]*\).*/\1/p' | head -n 1)
  team=$(printf '%s\n' "$d" | sed -n 's/^TeamIdentifier=//p' | head -n 1)
  sig=$(printf '%s\n' "$d" | sed -n 's/^Signature=//p' | head -n 1)
  echo "$cls sig=${sig:-none} flags=${flags:-none} team=${team:-none}"
}

# --- entitlement 회차 --------------------------------------------------------
#
# 회차 이름은 토큰을 정규 순서(jit, uem, dlv)로 '+' 로 이은 것이다.
# 빈 집합은 none 이다.

t8_ent_key() {
  case "$1" in
    jit) echo "com.apple.security.cs.allow-jit" ;;
    uem) echo "com.apple.security.cs.allow-unsigned-executable-memory" ;;
    dlv) echo "com.apple.security.cs.disable-library-validation" ;;
    *)   echo "" ;;
  esac
}

# <토큰 공백 목록> — 정규 순서로 정렬해 '+' 로 이은 회차 이름.
t8_level_norm() {
  local want tok out=""
  want=" $* "
  for tok in $ENT_TOKENS; do
    case "$want" in
      *" $tok "*) out="${out:+$out+}$tok" ;;
    esac
  done
  echo "${out:-none}"
}

# <회차> — 그 회차에 든 토큰을 공백으로 나열한다.
t8_level_tokens() {
  [ "$1" = "none" ] && return 0
  printf '%s' "$1" | tr '+' ' '
}

# <회차> <뺄 토큰> — 그 토큰을 뺀 회차 이름.
t8_level_drop() {
  local lvl drop tok keep=""
  lvl="$1"
  drop="$2"
  for tok in $(t8_level_tokens "$lvl"); do
    [ "$tok" = "$drop" ] && continue
    keep="$keep $tok"
  done
  t8_level_norm $keep
}

t8_ent_names() {
  local tok out=""
  [ "$1" = "none" ] && { echo "(없음)"; return 0; }
  for tok in $(t8_level_tokens "$1"); do
    out="${out:+$out, }$(t8_ent_key "$tok")"
  done
  echo "$out"
}

# <회차> — entitlement plist 를 만들고 그 경로를 낸다. none 이면 빈 문자열.
t8_plist_for() {
  local lvl out tok
  lvl="$1"
  [ "$lvl" = "none" ] && { echo ""; return 0; }
  mkdir -p "$ENT_DIR"
  out="$ENT_DIR/$lvl.plist"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    for tok in $(t8_level_tokens "$lvl"); do
      printf '  <key>%s</key>\n  <true/>\n' "$(t8_ent_key "$tok")"
    done
    echo '</dict>'
    echo '</plist>'
  } > "$out"
  echo "$out"
}

# <회차> — 메인 실행 파일을 그 조합으로 재서명한다.
#
# 프로세스 수준 entitlement 는 **메인 실행 파일**의 서명에서 읽힌다.
# 라이브러리에 붙여도 읽히지 않으므로 python3.12 하나만 다시 서명한다.
t8_apply_level() {
  local lvl plist
  lvl="$1"
  plist=$(t8_plist_for "$lvl")
  if [ -z "$plist" ]; then
    "$CODESIGN" --force --sign - --options runtime --timestamp=none "$SIGNED_PY" 2>&1 || return 1
  else
    "$CODESIGN" --force --sign - --options runtime --timestamp=none \
      --entitlements "$plist" "$SIGNED_PY" 2>&1 || return 1
  fi
  echo "$lvl" > "$LEVEL_FILE"
  return 0
}

# --- payload -----------------------------------------------------------------
#
# 서명된 런타임 안에서 실제로 도는 검사다. 검사 이름 하나를 받아 그것만 하고
# JSON 한 줄을 낸다. 프로세스가 통째로 죽으면 stdout 이 비고, 그것이 곧
# "hardened runtime 이 프로세스를 죽였다"는 관찰이다.
t8_write_payload() {
  mkdir -p "$WORK"
  cat > "$PAYLOAD" <<'PYEOF'
"""Task 8 — 서명된 번들 런타임에서 R-4 / R-5 표면을 하나씩 건드린다.

usage: payload.py <check> <expected-prefix>

검사 하나당 프로세스 하나다. hardened runtime 위반은 파이썬 예외가 아니라
프로세스 종료로 나타날 수 있어서, 한 프로세스에 몰아넣으면 첫 위반에서
나머지 결과가 통째로 사라진다.
"""
import json
import sys
import traceback

# 원본 번들에서 x86_64 슬라이스에 서명이 없던 Mach-O 를 실제로 여는 모듈들.
# 파일 → 모듈 대응은 RESULTS.md 와 signing/unsigned-inventory.txt 에 있다.
UNSIGNED_MODULES = [
    "charset_normalizer.md",
    "charset_normalizer.cd",
    "fontTools.cu2qu.cu2qu",
    "fontTools.feaLib.lexer",
    "fontTools.misc.bezierTools",
    "fontTools.pens.momentsPen",
    "fontTools.qu2cu.qu2cu",
    "fontTools.varLib.iup",
    "grpc._cython.cygrpc",
    "sounddevice",
]

# 스펙 P0-C3 이 이름을 든 스택 전량. Task 3 V2(t3-imports.sh)와 같은 목록이다.
# 서명 전에는 전부 import 되는 것이 확인돼 있으므로, 여기서 깨지는 것이 있으면
# 그것은 서명·hardened runtime 이 만든 차이다.
STACK_MODULES = [
    "torch", "torchaudio", "mlx", "mlx_whisper", "mlx_lm",
    "pyannote.audio", "speechbrain", "silero_vad", "sentence_transformers",
    "faster_whisper", "soundfile", "sounddevice", "numpy",
    "fastapi", "uvicorn", "damwha_worker",
]

METAL_SOURCE = """
    uint i = thread_position_in_grid.x;
    out[i] = inp[i] * 2.0f + 1.0f;
"""


def emit(name, ok, **kw):
    rec = {"check": name, "ok": bool(ok)}
    rec.update(kw)
    json.dump(rec, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")
    sys.stdout.flush()


def check_selfcheck(prefix):
    """사본이 정말 자기 자신을 쓰는가.

    셔뱅과 sys.prefix 가 원본 bundle/ 로 새면 이 Task 의 측정 대상이
    서명되지 않은 원본이 되어 버린다.
    """
    import sysconfig
    stdlib = sysconfig.get_paths().get("stdlib")
    paths = [sys.executable, sys.prefix, stdlib]
    ok = bool(prefix) and all(str(p).startswith(prefix) for p in paths)
    return ok, {
        "executable": sys.executable,
        "prefix": sys.prefix,
        "base_prefix": sys.base_prefix,
        "stdlib": stdlib,
        "expected_prefix": prefix,
    }


def check_unsigned_so(prefix):
    import importlib
    rows = []
    ok = True
    for name in UNSIGNED_MODULES:
        try:
            mod = importlib.import_module(name)
            row = {"module": name, "ok": True,
                   "file": getattr(mod, "__file__", None)}
            if name == "sounddevice":
                row["libname"] = getattr(mod, "_libname", None)
            rows.append(row)
        except BaseException as exc:
            rows.append({"module": name, "ok": False,
                         "error": "%s: %s" % (type(exc).__name__, exc)})
            ok = False
    return ok, {"modules": rows}


def check_numba_jit(prefix):
    """numba 의 LLVM JIT — 이 번들에서 R-4 가 실제로 나타나는 자리다.

    `mlx_whisper` 가 import 사슬로 numba 를 끌어온다(mlx_whisper.audio ->
    ... -> numba). numba 는 LLVM MCJIT 으로 기계어를 만들어 **쓰기+실행**
    메모리에 올린다. hardened runtime 아래에서는 그 매핑이 거부되고, 파이썬
    예외가 아니라 프로세스가 SIGKILL 로 죽는다.

    import 만으로도 죽으므로 실행까지 갈 필요는 없지만, JIT 이 정말 도는지를
    보려고 @njit 함수를 하나 컴파일해 부른다.
    """
    import numba
    import numpy as np

    @numba.njit
    def double_plus_one(x):
        return x * 2.0 + 1.0

    out = double_plus_one(np.arange(4.0))
    return True, {"numba_version": numba.__version__,
                  "sum": float(out.sum())}


def check_stack_imports(prefix):
    import importlib
    rows = []
    ok = True
    for name in STACK_MODULES:
        try:
            mod = importlib.import_module(name)
            rows.append({"module": name, "ok": True,
                         "file": getattr(mod, "__file__", None)})
        except BaseException as exc:
            rows.append({"module": name, "ok": False,
                         "error": "%s: %s" % (type(exc).__name__, exc)})
            ok = False
    return ok, {"modules": rows}


def check_torch_mps(prefix):
    import torch
    from damwha_worker.models.device import mps_available
    avail = bool(mps_available())
    info = {
        "torch_version": torch.__version__,
        "torch_file": torch.__file__,
        "mps_available": avail,
        "torch_mps_is_available": bool(torch.backends.mps.is_available()),
    }
    if avail:
        a = torch.randn(256, 256, device="mps")
        b = torch.randn(256, 256, device="mps")
        info["mps_matmul_sum"] = float((a @ b).sum().item())
    return avail, info


def check_torch_jit(prefix):
    import torch

    @torch.jit.script
    def f(x):
        return x * 2.0 + 1.0

    r = f(torch.ones(8))
    return True, {"torch_version": torch.__version__,
                  "jit_sum": float(r.sum().item())}


def check_mlx_metal(prefix):
    """R-4 의 본론 — Metal 셰이더 **소스**를 런타임에 컴파일한다.

    mx.fast.metal_kernel 은 위 문자열을 그 자리에서 Metal 컴파일러에 넘긴다.
    미리 만들어 둔 metallib 를 여는 것과 달리 hardened runtime 이 막을 수
    있는 형태가 이쪽이다.
    """
    import mlx.core as mx
    kernel = mx.fast.metal_kernel(
        name="t8_double",
        input_names=["inp"],
        output_names=["out"],
        source=METAL_SOURCE,
    )
    a = mx.arange(16, dtype=mx.float32)
    out = kernel(
        inputs=[a],
        grid=(16, 1, 1),
        threadgroup=(16, 1, 1),
        output_shapes=[(16,)],
        output_dtypes=[mx.float32],
    )[0]
    mx.eval(out)
    return True, {
        "mlx_version": mx.__version__,
        "device": str(mx.default_device()),
        "first": float(out[0].item()),
        "last": float(out[15].item()),
    }


def check_mlx_compile(prefix):
    import mlx.core as mx
    f = mx.compile(lambda x: mx.exp(mx.sin(x)) + 1.0)
    a = mx.random.normal((256, 256))
    r = f(a)
    mx.eval(r)
    return True, {"mlx_version": mx.__version__,
                  "sum": float(mx.sum(r).item())}


def check_mlx_lm_gen(prefix):
    """서명된 런타임에서 실제 LLM 추론이 도는가 (계획 Task 8 Steps 3).

    Task 5 는 같은 모델을 mlx_lm.server 로 띄웠다. 여기서는 서버 대신
    같은 코드를 in-process 로 부른다 — 서명 표면은 같고 포트와 수명 관리가
    빠져 이 Task 의 관찰 대상만 남는다.
    """
    from mlx_lm import load, generate
    model, tokenizer = load("mlx-community/Qwen3.5-4B-8bit")
    text = generate(model, tokenizer, prompt="1 + 1 =", max_tokens=8,
                    verbose=False)
    return True, {"text": str(text)[:200]}


CHECKS = {
    "selfcheck": check_selfcheck,
    "unsigned-so": check_unsigned_so,
    "numba-jit": check_numba_jit,
    "stack-imports": check_stack_imports,
    "torch-mps": check_torch_mps,
    "torch-jit": check_torch_jit,
    "mlx-metal": check_mlx_metal,
    "mlx-compile": check_mlx_compile,
    "mlx-lm-gen": check_mlx_lm_gen,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in CHECKS:
        sys.stderr.write("usage: payload.py <%s> [prefix]\n"
                         % "|".join(sorted(CHECKS)))
        return 2
    name = sys.argv[1]
    prefix = sys.argv[2] if len(sys.argv) > 2 else ""
    try:
        ok, info = CHECKS[name](prefix)
    except BaseException as exc:
        emit(name, False,
             error="%s: %s" % (type(exc).__name__, exc),
             traceback=traceback.format_exc(limit=6).strip().splitlines()[-4:])
        return 1
    emit(name, ok, **info)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
PYEOF
}

# <label> — 프로세스가 stdout 없이 죽었을 때 왜 죽었는지.
#
# 결정적인 줄은 dyld 가 낸다("dyld[pid]: Library not loaded: ..."). 그 줄은
# run-isolated.sh 가 dyld 증거 파일로 갈라 놓으므로 stderr 파일만 봐서는
# 원인을 못 읽는다. 두 파일을 다 본다.
t8_failure_reason() {
  local label d s out
  label="$1"
  d="$EVIDENCE/$label-dyld.txt"
  s="$EVIDENCE/$label-stderr.txt"
  out=""
  [ -f "$d" ] && out=$(grep -a '^dyld' "$d" | head -n 2 | tr '\n' ' ')
  if [ -f "$s" ]; then
    out="$out$(grep -a -v '^#' "$s" | head -n 3 | tr '\n' ' ')"
  fi
  printf '%s' "$out" | tr -s ' ' | cut -c1-700
}

# JSON 문자열 값으로 넣을 수 있게 이스케이프한다.
t8_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# <label> <check> — 격리 러너를 통해 검사 하나를 돌리고 JSON 한 줄을 낸다.
# 표준 출력에 JSON 이 없으면 그 사실을 JSON 으로 만들어 돌려준다 — 읽는 쪽이
# 형식을 하나만 다루게.
t8_run_check() {
  local label check raw rc line reason
  label="$1"
  check="$2"
  raw=$(bash "$RUN_ISO" --label "$label" -- \
        "$SIGNED_PY" "$PAYLOAD" "$check" "$SIGNED_ROOT/python" 2>/dev/null)
  rc=$?
  line=$(printf '%s\n' "$raw" | grep -a '^{' | tail -n 1)
  if [ -z "$line" ]; then
    reason=$(t8_failure_reason "$label")
    # 쓰기+실행 매핑 거부는 dyld 오류도 stderr 도 남기지 않고 커널이 곧바로
    # 신호를 보낸다. 그럴 때 종료 코드만 남으면 증거가 "exit 137" 한 줄이라
    # 무엇이 죽였는지 읽을 수 없다. 최소한 신호 번호를 풀어 적는다.
    if [ -z "$reason" ] && [ "$rc" -ge 128 ]; then
      reason="종료 코드 $rc = 128+$((rc - 128)) — 신호 $((rc - 128)) 로 죽었다. dyld/stderr 에 남은 줄이 없다"
    fi
    reason=$(t8_json_escape "$reason")
    printf '{"check": "%s", "ok": false, "exit": %d, "reason": "%s"}\n' \
      "$check" "$rc" "$reason"
    return 1
  fi
  printf '%s\n' "$line"
  [ "$rc" -eq 0 ] || return 1
  return 0
}

# --- 회차 실행과 캐시 ---------------------------------------------------------
# matrix.txt 형식: <단계>\t<회차>\t<검사>\t<OK|FAIL>\t<JSON>

t8_level_recorded() {
  awk -F'\t' -v l="$1" '$2 == l { n++ } END { exit !(n > 0) }' "$MATRIX" 2>/dev/null
}

t8_level_was_ok() {
  awk -F'\t' -v l="$1" '
    $2 == l { n++; if ($4 != "OK") bad++ }
    END { exit !(n > 0 && bad == 0) }
  ' "$MATRIX" 2>/dev/null
}

# <단계> <회차> [stop-on-fail] — 그 회차로 재서명하고 검사 전량을 돌린다.
# 전부 통과하면 0.
t8_run_level() {
  local phase lvl stop check line ok_all
  phase="$1"
  lvl="$2"
  stop="${3:-no}"
  t8_apply_level "$lvl" >/dev/null || t8_die "재서명 실패: $lvl"
  ok_all=1
  for check in $CHECKS; do
    line=$(t8_run_check "t8-$phase-$lvl-$check" "$check")
    if [ $? -eq 0 ]; then
      echo "      OK   $check"
      printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$lvl" "$check" "OK" "$line" >> "$MATRIX"
    else
      echo "      FAIL $check  $(printf '%s' "$line" | cut -c1-220)"
      printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$lvl" "$check" "FAIL" "$line" >> "$MATRIX"
      ok_all=0
      [ "$stop" = "stop" ] && break
    fi
  done
  [ "$ok_all" -eq 1 ]
}

# ---------------------------------------------------------------------------
# 1. 전수 조사 — bundle/ 의 Mach-O 서명 상태
# ---------------------------------------------------------------------------
step_inventory() {
  local list total f cls
  echo "== 1. bundle/ Mach-O 서명 전수 조사 (codesign, 슬라이스 단위)"
  [ -d "$BUNDLE_ROOT" ] || t8_die "번들이 없다: $BUNDLE_ROOT"
  mkdir -p "$WORK"

  list="$WORK/macho-bundle.txt"
  t8_macho_list "$BUNDLE_ROOT" "$list"
  total=$(wc -l < "$list" | tr -d ' ')
  echo "   Mach-O(정규 파일): ${total}개"

  local full="$WORK/inventory-full.txt"
  : > "$full"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    cls=$(t8_sig_class "$f")
    printf '%s\t%s\n' "$cls" "${f#$BUNDLE_ROOT/}" >> "$full"
  done < "$list"

  local n_arm_unsigned n_mixed n_signed n_noarm
  n_arm_unsigned=$(awk -F'\t' '$1 ~ /^arm64-unsigned /' "$full" | wc -l | tr -d ' ')
  n_mixed=$(awk -F'\t' '$1 ~ /^arm64-signed-otherarch-unsigned /' "$full" | wc -l | tr -d ' ')
  n_signed=$(awk -F'\t' '$1 ~ /^signed /' "$full" | wc -l | tr -d ' ')
  n_noarm=$(awk -F'\t' '$1 ~ /^no-arm64-slice /' "$full" | wc -l | tr -d ' ')
  echo "   arm64 슬라이스 서명 없음        : ${n_arm_unsigned}개"
  echo "   arm64 서명 / 다른 슬라이스 없음 : ${n_mixed}개"
  echo "   전 슬라이스 서명                : ${n_signed}개"
  echo "   arm64 슬라이스 자체가 없음      : ${n_noarm}개"

  t8_rotate "$INVENTORY"
  {
    echo "# 서명이 없는 Mach-O 전수 목록 (계획 Task 8 Files, 스펙 P0-C9 / R-5)"
    echo "#"
    echo "# 대상  : $BUNDLE_ROOT  (원본 번들. 서명은 사본 signed/ 에만 적용한다)"
    echo "# 방법  : find -type f | file | grep Mach-O 로 정규 파일 전량을 열거한 뒤"
    echo "#         파일마다 codesign --verify 를 두 번 돌렸다."
    echo "#           (1) --arch arm64   : 우리가 실제로 도는 슬라이스"
    echo "#           (2) --arch 없이    : 파일 안의 **모든** 슬라이스"
    echo "# utc   : $(t8_utc)"
    echo "#"
    echo "# ## 왜 두 번 재는가"
    echo "#"
    echo "# codesign --verify 를 --arch 없이 부르면 universal 파일에서 x86_64"
    echo "# 슬라이스 하나만 서명이 없어도 파일 전체를 'code object is not signed"
    echo "# at all' 이라고 보고한다. 그 메시지만 보면 arm64 에서도 서명이 없는"
    echo "# 것처럼 읽히는데 사실이 아니다. 이 실측이 바로 그 경우였다 —"
    echo "# Task 3 리뷰가 '서명이 아예 없다'고 본 파일들은 **arm64 슬라이스가"
    echo "# ad-hoc(linker-signed) 서명돼 있고 x86_64 슬라이스만 서명이 없는**"
    echo "# universal 바이너리였다. 지금 로드되는 이유가 그것이다."
    echo "#"
    echo "# ## 집계"
    echo "#"
    echo "# Mach-O 정규 파일 전체                       : ${total}개"
    echo "# arm64 슬라이스에 서명이 없는 것             : ${n_arm_unsigned}개"
    echo "# arm64 는 서명 / 다른 슬라이스가 서명 없음   : ${n_mixed}개"
    echo "# 전 슬라이스 서명                            : ${n_signed}개"
    echo "# arm64 슬라이스가 아예 없는 것               : ${n_noarm}개"
    echo "#"
    echo "# 경로는 번들 루트 기준 상대 경로다."
    echo
    echo "## arm64 슬라이스에 서명이 없는 Mach-O (${n_arm_unsigned}개)"
    if [ "$n_arm_unsigned" -eq 0 ]; then
      echo "  (0건)"
    else
      awk -F'\t' '$1 ~ /^arm64-unsigned / { print "  " $2 }' "$full" | sort
    fi
    echo
    echo "## arm64 는 서명돼 있고 다른 슬라이스에 서명이 없는 Mach-O (${n_mixed}개)"
    if [ "$n_mixed" -eq 0 ]; then
      echo "  (0건)"
    else
      awk -F'\t' '$1 ~ /^arm64-signed-otherarch-unsigned / { print "  " $2 }' "$full" | sort
    fi
    echo
    echo "## arm64 슬라이스가 없는 Mach-O (${n_noarm}개)"
    if [ "$n_noarm" -eq 0 ]; then
      echo "  (0건)"
    else
      awk -F'\t' '$1 ~ /^no-arm64-slice / { print "  " $2 }' "$full" | sort
    fi
    echo
    echo "## 분류 요약 (전체 ${total}개)"
    awk -F'\t' '{ print $1 }' "$full" | sort | uniq -c | sort -rn | sed 's/^ */  /'
  } | exp_scrub > "$INVENTORY"

  t8_rotate "$EVIDENCE/t8-inventory.txt"
  {
    echo "# Task 8 — bundle/ Mach-O 서명 상태 전수 (원본, 서명 전)"
    echo "# utc: $(t8_utc)   대상: $BUNDLE_ROOT   Mach-O 정규 파일: ${total}개"
    echo "# 형식: <분류> <codesign --display 요약>\\t<번들 기준 상대 경로>"
    echo
    sort "$full"
  } | exp_scrub > "$EVIDENCE/t8-inventory.txt"

  echo "   목록: $INVENTORY"
  echo "   증거: $EVIDENCE/t8-inventory.txt"

  T8_TOTAL="$total"
  T8_ARM_UNSIGNED="$n_arm_unsigned"
  T8_MIXED="$n_mixed"
  T8_SIGNED="$n_signed"
  T8_NOARM="$n_noarm"
  T8_INV_FULL="$full"
}

# ---------------------------------------------------------------------------
# 2. 사본 만들기
# ---------------------------------------------------------------------------
step_copy() {
  local avail need bin n
  echo
  echo "== 2. bundle/ → signed/ 복사"

  # 디스크가 좁다. 사본은 번들 크기만큼 더 든다.
  need=$(du -sk "$BUNDLE_ROOT" | awk '{print int($1/1024/1024) + 1}')
  avail=$(df -g "$EXP_ROOT" | tail -n 1 | awk '{print $4}')
  echo "   번들 크기: 약 ${need} GiB   데이터 볼륨 여유: ${avail} GiB"
  if [ "$avail" -lt $((need + 2)) ]; then
    t8_die "여유가 부족하다 (필요 $((need + 2)) GiB, 여유 ${avail} GiB) — 스펙 §4.4 / R-14"
  fi

  rm -rf "$SIGNED_ROOT"
  mkdir -p "$SIGNED_ROOT"
  "$RSYNC" -a --delete "$BUNDLE_ROOT/" "$SIGNED_ROOT/" || t8_die "복사 실패"
  # codesign 은 파일에 쓴다. 원본에 555 인 파일이 있으면 서명이 거부된다.
  chmod -R u+w "$SIGNED_ROOT"

  # 콘솔 스크립트 셔뱅을 사본으로 돌린다 (파일 머리말 참조).
  n=0
  for bin in "$SIGNED_ROOT"/python/bin/*; do
    [ -f "$bin" ] || continue
    head -n 1 "$bin" | grep -q "^#!$BUNDLE_ROOT/python/bin/" || continue
    sed -i '' "1s|^#!$BUNDLE_ROOT/python/bin/|#!$SIGNED_ROOT/python/bin/|" "$bin"
    n=$((n + 1))
  done
  echo "   셔뱅을 사본으로 돌린 콘솔 스크립트: ${n}개"
  T8_SHEBANG_FIXED="$n"

  [ -x "$SIGNED_PY" ] || t8_die "사본에 python 이 없다: $SIGNED_PY"
  echo "   사본: $SIGNED_ROOT"
}

# ---------------------------------------------------------------------------
# 3. ad-hoc 서명 + hardened runtime
# ---------------------------------------------------------------------------
step_sign() {
  local list total ok fail f err
  echo
  echo "== 3. ad-hoc 서명(codesign -s -) + --options runtime 전수 적용"

  list="$WORK/macho-signed.txt"
  t8_macho_list "$SIGNED_ROOT" "$list"
  total=$(wc -l < "$list" | tr -d ' ')
  echo "   대상 Mach-O: ${total}개"

  local failtxt="$WORK/sign-failures.txt"
  : > "$failtxt"
  ok=0
  fail=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if err=$("$CODESIGN" --force --sign - --options runtime --timestamp=none "$f" 2>&1); then
      ok=$((ok + 1))
    else
      fail=$((fail + 1))
      printf '%s\t%s\n' "${f#$SIGNED_ROOT/}" "$(printf '%s' "$err" | tr '\n' ' ')" >> "$failtxt"
    fi
  done < "$list"
  echo "   서명 성공: ${ok}개 / 실패: ${fail}개"

  # 검증 — 정말 전 슬라이스가 서명됐고 runtime 플래그가 켜졌는가.
  local vfail=0 nort=0 cls
  local aftertxt="$WORK/after-sign.txt"
  : > "$aftertxt"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    "$CODESIGN" --verify "$f" >/dev/null 2>&1 || vfail=$((vfail + 1))
    cls=$(t8_sig_class "$f")
    case "$cls" in
      *runtime*) ;;
      *) nort=$((nort + 1)) ;;
    esac
    printf '%s\t%s\n' "$cls" "${f#$SIGNED_ROOT/}" >> "$aftertxt"
  done < "$list"
  echo "   codesign --verify 실패: ${vfail}개 / runtime 플래그 없음: ${nort}개"

  t8_rotate "$EVIDENCE/t8-sign.txt"
  {
    echo "# Task 8 — signed/ 전수 ad-hoc 서명 결과"
    echo "# utc: $(t8_utc)"
    echo "# 명령: codesign --force --sign - --options runtime --timestamp=none <파일>"
    echo "# 대상: $SIGNED_ROOT   Mach-O 정규 파일: ${total}개"
    echo "#"
    echo "# 서명 성공               : ${ok}개"
    echo "# 서명 실패               : ${fail}개"
    echo "# 서명 후 --verify 실패   : ${vfail}개  (전 슬라이스 기준)"
    echo "# runtime 플래그 없음     : ${nort}개"
    echo
    echo "## 서명 실패 목록"
    if [ "$fail" -eq 0 ]; then
      echo "0건"
    else
      sed 's/^/  /' "$failtxt"
    fi
    echo
    echo "## 서명 후 분류 요약"
    awk -F'\t' '{ print $1 }' "$aftertxt" | sort | uniq -c | sort -rn | sed 's/^ */  /'
    echo
    echo "## 서명 후 전량 (<분류> <요약>\\t<사본 기준 상대 경로>)"
    sort "$aftertxt"
  } | exp_scrub > "$EVIDENCE/t8-sign.txt"

  T8_SIGN_TOTAL="$total"
  T8_SIGN_OK="$ok"
  T8_SIGN_FAIL="$fail"
  T8_SIGN_FAILTXT="$failtxt"
  T8_VERIFY_FAIL="$vfail"
  T8_NO_RUNTIME="$nort"
  echo "   증거: $EVIDENCE/t8-sign.txt"
}

# ---------------------------------------------------------------------------
# 4. entitlement 최소 집합 실측
# ---------------------------------------------------------------------------
#
# 두 단계다.
#
#   escalate  없음 → jit → jit+uem → jit+uem+dlv 로 **하나씩 더해** 가며 처음
#             전 검사가 통과하는 회차를 찾는다 (계획 Task 8 Interfaces).
#   reduce    그 회차에서 하나씩 **빼** 본다. 누적 escalate 만으로는 "마지막에
#             더한 것이 필요했다"까지만 알 수 있고, 앞에서 더한 것이 정말
#             필요했는지는 모른다. 빼도 통과하면 필요 없는 것이다.
step_entitlements() {
  local lvl pass_level="" cur tok cand changed
  echo
  echo "== 4. hardened runtime 아래 실행 — entitlement 최소 집합"

  t8_write_payload
  : > "$MATRIX"

  echo
  echo "   [escalate] 하나씩 더해 간다"
  for lvl in none $(t8_level_norm jit) $(t8_level_norm jit uem) $(t8_level_norm jit uem dlv); do
    echo "   -- 회차 [$lvl]  entitlement: $(t8_ent_names "$lvl")"
    if t8_run_level escalate "$lvl"; then
      pass_level="$lvl"
      echo "   => [$lvl] 에서 전 검사 통과. 더 붙이지 않는다."
      break
    fi
  done

  T8_PASS_LEVEL="$pass_level"

  if [ -z "$pass_level" ]; then
    T8_MIN_LEVEL=""
    echo "   [reduce] 건너뜀 — 통과한 회차가 없다"
  elif [ "$pass_level" = "none" ]; then
    T8_MIN_LEVEL="none"
    echo "   [reduce] 건너뜀 — entitlement 없이 통과했다"
  else
    echo
    echo "   [reduce] 통과 회차 [$pass_level] 에서 하나씩 빼 본다"
    cur="$pass_level"
    changed=1
    while [ "$changed" -eq 1 ]; do
      changed=0
      for tok in $(t8_level_tokens "$cur"); do
        cand=$(t8_level_drop "$cur" "$tok")
        if t8_level_recorded "$cand"; then
          if t8_level_was_ok "$cand"; then
            echo "   -- [$cand] 는 이미 통과로 기록돼 있다 — $tok 는 필요 없다"
            cur="$cand"
            changed=1
            break
          fi
          echo "   -- [$cand] 는 이미 실패로 기록돼 있다 — $tok 가 필요하다"
          continue
        fi
        echo "   -- 회차 [$cand]  ($tok 를 뺀다)  entitlement: $(t8_ent_names "$cand")"
        if t8_run_level reduce "$cand" stop; then
          echo "      => 빼도 통과한다. $tok 는 필요 없다."
          cur="$cand"
          changed=1
          break
        fi
        echo "      => 빼면 깨진다. $tok 가 필요하다."
      done
    done
    T8_MIN_LEVEL="$cur"
  fi

  # 결론 회차로 돌려 놓는다. 통과한 회차가 없으면 마지막으로 시도한 회차를 남긴다.
  [ -n "${T8_MIN_LEVEL}" ] && t8_apply_level "${T8_MIN_LEVEL}" >/dev/null

  # dyld 실측이 hardened runtime 아래에서 살아 있는가.
  local dyld_file dyld_state
  dyld_file="$EVIDENCE/t8-escalate-none-selfcheck-dyld.txt"
  if [ -f "$dyld_file" ] && head -n 1 "$dyld_file" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
    dyld_state="MEASUREMENT_UNAVAILABLE"
  else
    dyld_state="측정됨"
  fi
  if [ -n "${T8_MIN_LEVEL}" ]; then
    dyld_file="$EVIDENCE/t8-escalate-${T8_MIN_LEVEL}-selfcheck-dyld.txt"
    [ -f "$dyld_file" ] || dyld_file="$EVIDENCE/t8-reduce-${T8_MIN_LEVEL}-selfcheck-dyld.txt"
    if [ -f "$dyld_file" ] && head -n 1 "$dyld_file" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
      dyld_state="MEASUREMENT_UNAVAILABLE"
    fi
  fi
  T8_DYLD_STATE="$dyld_state"

  t8_rotate "$EVIDENCE/t8-entitlements.txt"
  {
    echo "# Task 8 — hardened runtime + entitlement 조합별 실행 결과 (R-4 / R-5)"
    echo "# utc: $(t8_utc)"
    echo "# 대상: $SIGNED_PY  (ad-hoc 서명 + --options runtime)"
    echo "# 실행: lib/run-isolated.sh 를 통해 검사마다 프로세스 하나"
    echo "#"
    echo "# 단계"
    echo "#   escalate : 없음 → jit → jit+uem → jit+uem+dlv 로 하나씩 더한다"
    echo "#   reduce   : 통과한 회차에서 하나씩 빼 본다 (최소성 확인).  누적으로만"
    echo "#              재면 '마지막에 더한 것이 필요했다'까지만 알 수 있다."
    echo "#              reduce 는 첫 FAIL 에서 멈춘다 — 필요 여부만 알면 되고,"
    echo "#              같은 회차의 나머지 검사를 더 돌려도 결론이 바뀌지 않는다."
    echo "#"
    echo "# entitlement 토큰"
    echo "#   jit : $(t8_ent_key jit)"
    echo "#   uem : $(t8_ent_key uem)"
    echo "#   dlv : $(t8_ent_key dlv)"
    echo "#"
    echo "# 검사"
    echo "#   selfcheck     : 사본이 정말 자기 자신을 쓰는가 (sys.prefix / stdlib)"
    echo "#   unsigned-so   : 원본에서 x86_64 슬라이스에 서명이 없던 Mach-O 를 여는 모듈 10개"
    echo "#   numba-jit     : numba 의 LLVM JIT — 쓰기+실행 메모리 (R-4)"
    echo "#   stack-imports : 스펙 P0-C3 이 이름을 든 스택 전량 (Task 3 V2 와 같은 목록)"
    echo "#   torch-mps     : damwha_worker.models.device.mps_available() + MPS 행렬곱"
    echo "#   torch-jit     : torch.jit.script"
    echo "#   mlx-metal     : mx.fast.metal_kernel — Metal 셰이더 소스 런타임 컴파일 (R-4)"
    echo "#   mlx-compile   : mx.compile 그래프 컴파일"
    echo "#   mlx-lm-gen    : mlx_lm 로 Qwen3.5-4B-8bit 8토큰 생성"
    echo "#"
    echo "# escalate 가 처음 통과한 회차 : ${T8_PASS_LEVEL:-없음}"
    echo "# reduce 후 최소 집합          : ${T8_MIN_LEVEL:-없음}"
    echo "# dyld 실측(DYLD_PRINT_LIBRARIES) : ${T8_DYLD_STATE}"
    echo
    echo "## 단계 x 회차 x 검사 (<단계>\\t<회차>\\t<검사>\\t<판정>\\t<payload JSON>)"
    cat "$MATRIX"
  } | exp_scrub > "$EVIDENCE/t8-entitlements.txt"

  echo "   escalate 통과 회차: ${T8_PASS_LEVEL:-없음}"
  echo "   최소 집합         : ${T8_MIN_LEVEL:-없음}"
  echo "   증거: $EVIDENCE/t8-entitlements.txt"
}

# ---------------------------------------------------------------------------
# 5. R-4 — JIT / 쓰기+실행 메모리와 GPU 셰이더 컴파일
# ---------------------------------------------------------------------------
#
# R-4 는 "hardened runtime 이 MLX 의 Metal 셰이더 런타임 컴파일이나 torch 의
# JIT 을 막는가" 를 묻는다. 4 단계의 회차 표에도 답이 들어 있지만, 그 표는
# entitlement 를 찾는 것이 목적이라 **무엇이 왜 깨졌는지**가 흩어져 있다.
# 여기서 R-4 표면 넷만 골라 최소 집합과 "거기서 하나를 뺀 회차"를 나란히 재고,
# 커널이 남긴 로그를 붙인다.
step_r4() {
  local base_level lvl_b check line out syslog log_start
  echo
  echo "== 5. R-4 — JIT / 쓰기+실행 메모리와 GPU 셰이더 컴파일"

  base_level="${T8_MIN_LEVEL:-}"
  [ -n "$base_level" ] || base_level="none"
  lvl_b=$(t8_level_drop "$base_level" uem)

  out="$WORK/r4.txt"
  : > "$out"
  log_start=$(date '+%Y-%m-%d %H:%M:%S')

  local R4_CHECKS="numba-jit torch-jit mlx-metal mlx-compile"

  echo "   (A) 최소 집합 [$base_level]"
  t8_apply_level "$base_level" >/dev/null || t8_die "재서명 실패: $base_level"
  for check in $R4_CHECKS; do
    line=$(t8_run_check "t8-r4-a-$check" "$check")
    if [ $? -eq 0 ]; then
      echo "      OK   $check"
      printf 'A\t%s\t%s\tOK\t%s\n' "$base_level" "$check" "$line" >> "$out"
    else
      echo "      FAIL $check"
      printf 'A\t%s\t%s\tFAIL\t%s\n' "$base_level" "$check" "$line" >> "$out"
    fi
  done

  if [ "$lvl_b" != "$base_level" ]; then
    echo "   (B) 거기서 allow-unsigned-executable-memory 를 뺀 [$lvl_b]"
    t8_apply_level "$lvl_b" >/dev/null || t8_die "재서명 실패: $lvl_b"
    for check in $R4_CHECKS; do
      line=$(t8_run_check "t8-r4-b-$check" "$check")
      if [ $? -eq 0 ]; then
        echo "      OK   $check"
        printf 'B\t%s\t%s\tOK\t%s\n' "$lvl_b" "$check" "$line" >> "$out"
      else
        echo "      FAIL $check"
        printf 'B\t%s\t%s\tFAIL\t%s\n' "$lvl_b" "$check" "$line" >> "$out"
      fi
    done
  else
    echo "   (B) 건너뜀 — 최소 집합에 allow-unsigned-executable-memory 가 없다"
  fi

  t8_apply_level "$base_level" >/dev/null

  # 커널·AMFI 가 남긴 줄. 쓰기+실행 매핑 거부는 프로세스에 아무 메시지도
  # 주지 않고 신호로 끝나므로, 이 로그가 유일한 직접 근거다.
  syslog="$WORK/r4-syslog.txt"
  echo "   시스템 로그 수집: $log_start 부터 (수십 초 걸린다)"
  log show --start "$log_start" --style compact 2>/dev/null \
    | grep -a -E 'AppleMobileFileIntegrityError|CODE SIGNING|cs_invalid|mac_vm_map|EXC_BAD_ACCESS|Killed' \
    | head -n 40 > "$syslog" || true
  echo "   수집된 줄: $(wc -l < "$syslog" | tr -d ' ')"

  t8_rotate "$EVIDENCE/t8-r4.txt"
  {
    echo "# Task 8 — R-4 실측: JIT / 쓰기+실행 메모리와 GPU 셰이더 컴파일"
    echo "# utc: $(t8_utc)"
    echo "# 메인 실행 파일: $SIGNED_PY (ad-hoc + --options runtime)"
    echo "#"
    echo "# A 최소 집합 [$base_level]"
    echo "# B 거기서 $(t8_ent_key uem) 를 뺀 [$lvl_b]"
    echo "#"
    echo "# 쓰기+실행 매핑 거부는 프로세스에 메시지를 주지 않고 SIGKILL 로 끝난다."
    echo "# 시스템 로그에도 크래시 리포트에도 그 죽음에 대응하는 줄이 생기지 않는다"
    echo "# (SIGKILL 은 크래시 리포트를 만들지 않는다). 아래 로그는 같은 창에서 수집한"
    echo "# 코드 서명 관련 줄 전량이며, 인과는 A/B 대조가 세운다."
    echo "#"
    echo "# 검사"
    echo "#   numba-jit   : numba 의 LLVM JIT (mlx_whisper 가 import 사슬로 끌어온다)"
    echo "#   torch-jit   : torch.jit.script"
    echo "#   mlx-metal   : mx.fast.metal_kernel — Metal 셰이더 소스를 런타임에 컴파일"
    echo "#   mlx-compile : mx.compile 그래프 컴파일"
    echo
    echo "## 회차 x 검사 (<회차기호>\\t<entitlement 회차>\\t<검사>\\t<판정>\\t<payload JSON>)"
    cat "$out"
    echo
    echo "## 시스템 로그 (log show --start '$log_start')"
    if [ -s "$syslog" ]; then
      sed 's/^/  /' "$syslog"
    else
      echo "  (수집된 줄이 없다)"
    fi
  } | exp_scrub > "$EVIDENCE/t8-r4.txt"

  T8_R4_OUT="$out"
  T8_R4_LVL_A="$base_level"
  T8_R4_LVL_B="$lvl_b"
  T8_R4_SYSLOG="$syslog"
  echo "   증거: $EVIDENCE/t8-r4.txt"
}

# ---------------------------------------------------------------------------
# 6. R-5 — 서명되지 않은 .so 를 hardened runtime 아래에서 여는가
# ---------------------------------------------------------------------------
#
# 4 단계는 **전부 서명한 뒤**를 본다. R-5 가 묻는 것은 그 반대다 — 서명되지
# 않은 .so 를 hardened runtime 프로세스가 열 수 있는가. 사본에서 목록의
# 파일만 서명을 떼어 재현하고, 관찰이 끝나면 도로 서명한다.
step_r5() {
  local rel f line stripped=0 base_level n
  echo
  echo "== 6. R-5 — 서명을 뗀 .so 를 hardened runtime 아래에서 여는가"

  base_level="${T8_MIN_LEVEL:-}"
  [ -n "$base_level" ] || base_level="none"

  # 대상은 원본에서 슬라이스 하나라도 서명이 없던 Mach-O 전량이다.
  # codesign --remove-signature 를 걸면 arm64 슬라이스까지 서명이 사라져,
  # "서명 없는 .so" 를 그대로 재현한다.
  local list="$WORK/r5-files.txt"
  awk -F'\t' '$1 ~ /^arm64-unsigned |^arm64-signed-otherarch-unsigned / { print $2 }' \
    "$T8_INV_FULL" | sort > "$list"
  n=$(wc -l < "$list" | tr -d ' ')
  echo "   대상: 원본에서 슬라이스 하나라도 서명이 없던 ${n}개"

  local out="$WORK/r5.txt"
  : > "$out"

  # (A) 전부 서명된 상태 — 4단계 결론 회차 그대로.
  t8_apply_level "$base_level" >/dev/null || t8_die "재서명 실패: $base_level"
  line=$(t8_run_check "t8-r5-signed" "unsigned-so")
  local rc_a=$?
  printf 'A\tso=ad-hoc 서명\tent=%s\t%s\t%s\n' "$base_level" \
    "$([ $rc_a -eq 0 ] && echo OK || echo FAIL)" "$line" >> "$out"
  echo "   (A) .so 서명 있음 / ent=$base_level : $([ $rc_a -eq 0 ] && echo OK || echo FAIL)"

  # (B) 목록의 파일만 서명 제거.
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    f="$SIGNED_ROOT/$rel"
    [ -f "$f" ] || continue
    "$CODESIGN" --remove-signature "$f" >/dev/null 2>&1 && stripped=$((stripped + 1))
  done < "$list"
  echo "   서명을 뗀 파일: ${stripped}개"
  line=$(t8_run_check "t8-r5-stripped" "unsigned-so")
  local rc_b=$?
  printf 'B\tso=서명 없음\tent=%s\t%s\t%s\n' "$base_level" \
    "$([ $rc_b -eq 0 ] && echo OK || echo FAIL)" "$line" >> "$out"
  echo "   (B) .so 서명 없음 / ent=$base_level : $([ $rc_b -eq 0 ] && echo OK || echo FAIL)"

  # (C) 같은 상태에서 library validation 을 **켠다**(dlv 를 뺀 회차).
  #     dlv 가 최소 집합에 있다면 그 회차는 이미 4단계에서 깨졌으므로 여기서는
  #     그 사실을 참조만 하고, 없다면 실제로 재 본다.
  local rc_c="" lvl_c
  lvl_c=$(t8_level_drop "$base_level" dlv)
  case " $(t8_level_tokens "$base_level") " in
    *" dlv "*)
      printf 'C\tso=서명 없음\tent=%s\tREF\t{"note": "이 회차는 4단계 escalate 에서 이미 깨졌다 — 그 증거를 참조한다"}\n' \
        "$lvl_c" >> "$out"
      echo "   (C) ent=$lvl_c : 4단계에서 이미 실패로 기록됨 (참조)"
      ;;
    *)
      t8_apply_level "$lvl_c" >/dev/null || t8_die "재서명 실패: $lvl_c"
      line=$(t8_run_check "t8-r5-stripped-lv-on" "unsigned-so")
      rc_c=$?
      printf 'C\tso=서명 없음\tent=%s\t%s\t%s\n' "$lvl_c" \
        "$([ $rc_c -eq 0 ] && echo OK || echo FAIL)" "$line" >> "$out"
      echo "   (C) .so 서명 없음 / ent=$lvl_c : $([ $rc_c -eq 0 ] && echo OK || echo FAIL)"
      ;;
  esac

  # 복구: 뗀 서명을 도로 붙이고 결론 회차로 되돌린다.
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    f="$SIGNED_ROOT/$rel"
    [ -f "$f" ] || continue
    "$CODESIGN" --force --sign - --options runtime --timestamp=none "$f" >/dev/null 2>&1
  done < "$list"
  t8_apply_level "$base_level" >/dev/null
  echo "   복구: ${stripped}개 재서명, 메인 실행 파일을 [$base_level] 로 되돌렸다"

  t8_rotate "$EVIDENCE/t8-r5.txt"
  {
    echo "# Task 8 — R-5 실측: 서명되지 않은 .so 를 hardened runtime 이 막는가"
    echo "# utc: $(t8_utc)"
    echo "# 메인 실행 파일: $SIGNED_PY (ad-hoc + --options runtime)"
    echo "#"
    echo "# 대상 ${n}개 (원본 bundle/ 에서 슬라이스 하나라도 서명이 없던 Mach-O)"
    sed 's/^/#   /' "$list"
    echo "#"
    echo "# A .so 를 ad-hoc 서명한 상태로 연다"
    echo "# B 대상만 codesign --remove-signature 로 서명을 떼고 연다"
    echo "# C 같은 상태에서 library validation 을 켠 회차 — dlv 가 최소 집합에"
    echo "#   들어 있으면 4단계 escalate 의 증거를 참조한다"
    echo "#"
    echo "# 관찰이 끝나면 대상 ${n}개를 도로 ad-hoc 서명한다."
    echo
    cat "$out"
  } | exp_scrub > "$EVIDENCE/t8-r5.txt"

  T8_R5_A="$rc_a"
  T8_R5_B="$rc_b"
  T8_R5_C="$rc_c"
  T8_R5_LVL_C="$lvl_c"
  T8_R5_N="$n"
  T8_R5_STRIPPED="$stripped"
  T8_R5_OUT="$out"
  echo "   증거: $EVIDENCE/t8-r5.txt"
}

# ---------------------------------------------------------------------------
# 7. RESULTS.md 갱신
# ---------------------------------------------------------------------------
step_write_results() {
  local frag
  echo
  echo "== 7. RESULTS.md 갱신"
  mkdir -p "$WORK"

  # --- 전수 조사 절 ---
  frag="$WORK/frag-inventory.md"
  {
    echo
    echo "측정: \`$(t8_utc)\` · 증거 \`docs/superpowers/reports/evidence/phase-0/t8-inventory.txt\`"
    echo
    echo "| 분류 | 개수 |"
    echo "| --- | --- |"
    echo "| Mach-O 정규 파일 전체 | ${T8_TOTAL}개 |"
    echo "| **arm64 슬라이스에 서명이 없는 것** | **${T8_ARM_UNSIGNED}개** |"
    echo "| arm64는 서명 / 다른 슬라이스가 서명 없음 | ${T8_MIXED}개 |"
    echo "| 전 슬라이스 서명 | ${T8_SIGNED}개 |"
    echo "| arm64 슬라이스가 아예 없는 것 | ${T8_NOARM}개 |"
    echo
    echo "\`codesign --display\` 분류 (원본, 서명 전):"
    echo
    echo '```'
    awk -F'\t' '{ print $1 }' "$T8_INV_FULL" | sort | uniq -c | sort -rn | sed 's/^ *//'
    echo '```'
    echo
    echo "**Task 3 리뷰의 관찰을 이 측정이 정정한다.** Task 3 리뷰는 \`codesign -v\`가"
    echo "\`code object is not signed at all\`을 낸 파일을 \"서명이 아예 없는 것\"으로"
    echo "기록했다. \`--arch\`를 나눠 다시 재 보니 그 파일들은 **arm64 슬라이스가"
    echo "ad-hoc(linker-signed) 서명돼 있고 x86_64 슬라이스만 서명이 없는** universal"
    echo "바이너리였다. \`codesign --verify\`를 \`--arch\` 없이 부르면 슬라이스 하나만"
    echo "서명이 없어도 파일 전체를 그렇게 보고한다. 지금 로드되는 이유가 그것이다 —"
    echo "arm64 호스트는 arm64 슬라이스만 매핑한다."
    echo
    if [ "${T8_MIXED}" -gt 0 ]; then
      echo "다른 슬라이스에 서명이 없는 ${T8_MIXED}개 전량 (전수 목록은 \`signing/unsigned-inventory.txt\`):"
      echo
      awk -F'\t' '$1 ~ /^arm64-signed-otherarch-unsigned / { print "- `" $2 "`" }' "$T8_INV_FULL" | sort
      echo
    fi
    if [ "${T8_ARM_UNSIGNED}" -gt 0 ]; then
      echo "arm64 슬라이스에 서명이 없는 ${T8_ARM_UNSIGNED}개:"
      echo
      awk -F'\t' '$1 ~ /^arm64-unsigned / { print "- `" $2 "`" }' "$T8_INV_FULL" | sort
      echo
    else
      echo "arm64 슬라이스에 서명이 없는 Mach-O는 **0개**다. 즉 이 번들에는 우리가"
      echo "실제로 매핑하는 코드 중 서명이 없는 것이 없다."
      echo
    fi
  } > "$frag"
  t8_splice inventory "$frag"

  # --- 서명 절 ---
  frag="$WORK/frag-signing.md"
  {
    echo
    echo "측정: \`$(t8_utc)\` · 증거 \`docs/superpowers/reports/evidence/phase-0/t8-sign.txt\`"
    echo
    echo "적용한 명령:"
    echo
    echo '```'
    echo "codesign --force --sign - --options runtime --timestamp=none <Mach-O>"
    echo '```'
    echo
    echo "| 항목 | 값 |"
    echo "| --- | --- |"
    echo "| 사본 \`signed/\`의 Mach-O 정규 파일 | ${T8_SIGN_TOTAL}개 |"
    echo "| 서명 성공 | ${T8_SIGN_OK}개 |"
    echo "| **서명 실패** | **${T8_SIGN_FAIL}개** |"
    echo "| 서명 후 \`codesign --verify\`(전 슬라이스) 실패 | ${T8_VERIFY_FAIL}개 |"
    echo "| 서명 후 \`runtime\` 플래그가 없는 파일 | ${T8_NO_RUNTIME}개 |"
    echo "| 셔뱅을 사본으로 돌린 콘솔 스크립트 | ${T8_SHEBANG_FIXED}개 |"
    echo
    echo "**서명 실패 파일 목록**"
    echo
    if [ "${T8_SIGN_FAIL}" -eq 0 ]; then
      echo "**0건.** 번들의 Mach-O ${T8_SIGN_TOTAL}개 전부가 ad-hoc 서명과 hardened runtime"
      echo "옵션을 받아들였다 — 서명 자체를 거부하는 파일은 없었다. 서명 뒤에는 x86_64"
      echo "슬라이스까지 포함해 전 슬라이스가 서명됐고(\`--verify\` 실패 ${T8_VERIFY_FAIL}건),"
      echo "\`runtime\` 플래그가 전량에 붙었다."
    else
      echo '```'
      cat "${T8_SIGN_FAILTXT}"
      echo '```'
    fi
    echo
  } > "$frag"
  t8_splice signing "$frag"

  # --- entitlement 절 ---
  frag="$WORK/frag-entitlements.md"
  {
    echo
    echo "측정: \`$(t8_utc)\` · 증거 \`docs/superpowers/reports/evidence/phase-0/t8-entitlements.txt\`"
    echo
    echo "회차마다 \`signed/python/bin/python3.12\`를 그 조합으로 재서명하고, 검사 일곱 개를"
    echo "**각각 별도 프로세스로** 돌렸다 (hardened runtime 위반은 예외가 아니라 프로세스"
    echo "종료로 나타나서, 한 프로세스에 몰면 첫 위반에서 나머지 결과가 사라진다)."
    echo "실행은 전부 \`lib/run-isolated.sh\`를 지난다."
    echo
    echo "토큰: \`jit\` = \`$(t8_ent_key jit)\`, \`uem\` = \`$(t8_ent_key uem)\`,"
    echo "\`dlv\` = \`$(t8_ent_key dlv)\`."
    echo
    echo "| 단계 | 회차 | $(for c in $CHECKS; do printf '%s | ' "$c"; done)"
    echo "| --- | --- |$(for c in $CHECKS; do printf ' --- |'; done)"
    local ph lvl c cell
    while IFS='|' read -r ph lvl; do
      [ -n "$ph" ] || continue
      printf '| %s | `%s` |' "$ph" "$lvl"
      for c in $CHECKS; do
        cell=$(awk -F'\t' -v p="$ph" -v l="$lvl" -v k="$c" \
               '$1==p && $2==l && $3==k { print $4 }' "$MATRIX")
        printf ' %s |' "${cell:--}"
      done
      printf '\n'
    done <<EOT
$(awk -F'\t' '{ key = $1 "|" $2 } !seen[key]++ { print key }' "$MATRIX")
EOT
    echo
    echo "\`-\`는 그 회차에서 돌리지 않았다는 뜻이다. \`reduce\` 단계는 첫 FAIL에서 멈춘다 —"
    echo "그 entitlement가 필요한지만 알면 되고, 같은 회차의 나머지 검사를 더 돌려도"
    echo "결론이 바뀌지 않는다."
    echo
    if [ -n "${T8_MIN_LEVEL}" ]; then
      echo "**결론: 필요한 entitlement 최소 집합 = $(t8_ent_names "${T8_MIN_LEVEL}")**"
      echo
      echo "\`escalate\`가 처음 통과한 회차는 \`${T8_PASS_LEVEL}\`이고, 거기서 하나씩 빼 본"
      echo "\`reduce\` 결과가 \`${T8_MIN_LEVEL}\`이다. 누적으로만 재면 \"마지막에 더한 것이"
      echo "필요했다\"까지만 알 수 있어서 빼는 단계를 따로 뒀다."
    else
      echo "**결론: 마지막 회차까지도 통과하지 못한 검사가 남았다.** 위 표의 FAIL 칸과"
      echo "아래 오류가 그 근거다."
    fi
    echo
    echo "**\`DYLD_PRINT_LIBRARIES\` 실측 상태: ${T8_DYLD_STATE}.**"
    if [ "${T8_DYLD_STATE}" = "MEASUREMENT_UNAVAILABLE" ]; then
      echo "hardened runtime은 프로세스를 dyld 기준 restricted로 만들어 \`DYLD_*\`를"
      echo "무시하게 한다. 즉 **서명한 뒤에는 G2의 dyld 실측이 끊긴다.** 앞 Task들이"
      echo "쌓은 dyld 증거는 서명 전 번들에서만 얻을 수 있다는 뜻이고, Phase 6이"
      echo "서명된 산출물에서 같은 측정을 하려면 \`com.apple.security.cs.allow-dyld-environment-variables\`"
      echo "를 **측정용으로만** 붙여야 한다. 이 Task는 그것을 최소 집합에 넣지 않았다 —"
      echo "제품 동작에 필요한 것이 아니라 계측에만 필요하기 때문이다."
    fi
    echo
    echo "실패한 검사의 오류 원문:"
    echo
    echo '```'
    if awk -F'\t' '$4 == "FAIL"' "$MATRIX" | grep -q .; then
      awk -F'\t' '$4 == "FAIL" { printf "[%s %s] %s\n  %s\n", $1, $2, $3, $5 }' "$MATRIX"
    else
      echo "FAIL 0건"
    fi
    echo '```'
    echo
  } > "$frag"
  t8_splice entitlements "$frag"

  # --- R-4 절 ---
  frag="$WORK/frag-r4.md"
  {
    echo
    echo "측정: \`$(t8_utc)\` · 증거 \`docs/superpowers/reports/evidence/phase-0/t8-r4.txt\`"
    echo
    echo "R-4 표면 넷을 골라 **최소 집합**과 **거기서 \`allow-unsigned-executable-memory\`를"
    echo "뺀 회차**를 나란히 잰다."
    echo
    echo "| 검사 | 무엇을 하는가 | A \`${T8_R4_LVL_A}\` | B \`${T8_R4_LVL_B}\` |"
    echo "| --- | --- | --- | --- |"
    local rc4 a4 b4 desc
    for rc4 in numba-jit torch-jit mlx-metal mlx-compile; do
      a4=$(awk -F'\t' -v k="$rc4" '$1=="A" && $3==k { print $4 }' "${T8_R4_OUT}")
      b4=$(awk -F'\t' -v k="$rc4" '$1=="B" && $3==k { print $4 }' "${T8_R4_OUT}")
      case "$rc4" in
        numba-jit)   desc="numba 의 LLVM JIT — 기계어를 쓰기+실행 메모리에 올린다. \`mlx_whisper\` 가 import 사슬로 끌어온다" ;;
        torch-jit)   desc="\`torch.jit.script\`" ;;
        mlx-metal)   desc="\`mx.fast.metal_kernel\` — Metal 셰이더 **소스**를 런타임에 컴파일" ;;
        mlx-compile) desc="\`mx.compile\` 그래프 컴파일" ;;
      esac
      printf '| `%s` | %s | %s | %s |\n' "$rc4" "$desc" "${a4:--}" "${b4:--}"
    done
    echo
    echo "실패한 검사의 오류 원문:"
    echo
    echo '```'
    if awk -F'\t' '$4 == "FAIL"' "${T8_R4_OUT}" | grep -q .; then
      awk -F'\t' '$4 == "FAIL" { printf "[%s %s] %s\n  %s\n", $1, $2, $3, $5 }' "${T8_R4_OUT}"
    else
      echo "FAIL 0건"
    fi
    echo '```'
    echo
    echo "쓰기+실행 매핑 거부는 프로세스에 아무 메시지도 주지 않고 커널이 신호로 끝낸다."
    echo "**종료 코드 말고는 남는 것이 없다** — 시스템 로그에도, \`~/Library/Logs/DiagnosticReports\`의"
    echo "크래시 리포트에도 그 죽음에 대응하는 줄이 생기지 않는다(SIGKILL 은 크래시 리포트를"
    echo "만들지 않는다). 그래서 이 절의 인과는 **entitlement 하나를 넣고 빼는 대조**로만"
    echo "세워진다: 위 표에서 A와 B의 차이는 \`$(t8_ent_key uem)\` 하나뿐이다."
    echo
    echo "같은 창에서 수집한 코드 서명 관련 로그 줄 전량은 증거 파일에 있다. 아래는 그 앞부분이며,"
    echo "여기 보이는 것은 \`dyld\`/library validation 쪽 사건이지 JIT 매핑 거부가 아니다:"
    echo
    echo '```'
    if [ -s "${T8_R4_SYSLOG}" ]; then
      head -n 6 "${T8_R4_SYSLOG}"
    else
      echo "(수집된 줄이 없다)"
    fi
    echo '```'
    echo
  } > "$frag"
  t8_splice r4 "$frag"

  # --- R-5 절 ---
  frag="$WORK/frag-r5.md"
  {
    local a b c
    a=$([ "${T8_R5_A}" -eq 0 ] && echo "열린다" || echo "막힌다")
    b=$([ "${T8_R5_B}" -eq 0 ] && echo "열린다" || echo "막힌다")
    if [ -z "${T8_R5_C}" ]; then
      c="**막힌다** — 4단계 \`escalate\`에서 이 회차가 이미 깨졌다"
    elif [ "${T8_R5_C}" -eq 0 ]; then
      c="열린다"
    else
      c="막힌다"
    fi
    echo
    echo "측정: \`$(t8_utc)\` · 증거 \`docs/superpowers/reports/evidence/phase-0/t8-r5.txt\`"
    echo
    echo "메인 실행 파일 \`signed/python/bin/python3.12\`는 ad-hoc 서명 + \`--options runtime\`"
    echo "이다. 그 프로세스가 여는 \`.so\`의 서명 상태와 entitlement만 바꿔 세 번 잰다."
    echo "대상은 원본에서 슬라이스 하나라도 서명이 없던 ${T8_R5_N}개이고, B·C는 사본에서"
    echo "그 파일들만 \`codesign --remove-signature\`로 되돌려 만들었다(${T8_R5_STRIPPED}개)."
    echo "관찰 뒤 전부 도로 서명했다."
    echo
    echo "| # | \`.so\` 서명 | entitlement | 결과 |"
    echo "| --- | --- | --- | --- |"
    echo "| A | ad-hoc 서명함 | \`${T8_MIN_LEVEL:-none}\` | ${a} |"
    echo "| B | **서명 없음** | \`${T8_MIN_LEVEL:-none}\` | **${b}** |"
    echo "| C | 서명 없음 | \`${T8_R5_LVL_C}\` (library validation 켠 상태) | ${c} |"
    echo
    echo '```'
    awk -F'\t' '{ printf "%s  %s  %s  %s\n", $1, $2, $3, $4 }' "${T8_R5_OUT}"
    echo '```'
    echo
  } > "$frag"
  t8_splice r5 "$frag"

  echo "   RESULTS.md: $RESULTS"
}

# ---------------------------------------------------------------------------
cmd_sign() {
  exp_ensure_sandbox
  mkdir -p "$WORK"
  [ -x "$CODESIGN" ] || t8_die "codesign 이 없다: $CODESIGN"
  [ -f "$RESULTS" ] || t8_die "RESULTS.md 가 없다: $RESULTS"

  echo "probe.sh sign — ad-hoc 서명 + hardened runtime 실측 (스펙 P0-C9)"
  echo "  원본(읽기만): $BUNDLE_ROOT"
  echo "  사본(서명)  : $SIGNED_ROOT"
  echo

  step_inventory
  step_copy
  step_sign
  step_entitlements
  step_r4
  step_r5
  step_write_results

  echo
  echo "요약"
  echo "  Mach-O 정규 파일           : ${T8_TOTAL}개"
  echo "  arm64 슬라이스 서명 없음   : ${T8_ARM_UNSIGNED}개"
  echo "  다른 슬라이스 서명 없음    : ${T8_MIXED}개"
  echo "  서명 실패                  : ${T8_SIGN_FAIL}개"
  echo "  escalate 통과 회차         : ${T8_PASS_LEVEL:-없음}"
  echo "  entitlement 최소 집합      : $(t8_ent_names "${T8_MIN_LEVEL:-none}")"
  echo "  dyld 실측                  : ${T8_DYLD_STATE}"
  echo
  echo "판정은 하지 않는다 — 이 Task 는 제약을 특정하는 것이 목적이다 (스펙 P0-C9 비고)."
  return 0
}

# ---------------------------------------------------------------------------
# Gatekeeper — 격리 속성을 붙인 뒤 실행한다.
# ---------------------------------------------------------------------------
#
# ## 이 단계는 파일을 잃을 수 있다 — 실측으로 확인했다
#
# 격리 속성이 붙은 ad-hoc 서명 바이너리를 실행하면 macOS 는 프로세스를 죽이는
# 데서 그치지 않는다. syspolicyd 가 GUI 프롬프트를 띄우고 LSCodeEvaluation 이
# **그 파일을 휴지통으로 옮긴다.** 첫 회차에서 signed/ffmpeg/bin/ffprobe 와
# signed/pg/bin/postgres 가 실제로 그렇게 사라졌다. 그래서 이 단계는
#
#   (1) 대상마다 사본을 $WORK/gk-backup/ 에 먼저 떠 두고,
#   (2) 관찰이 끝나면 파일이 없어졌는지 확인해 되돌린다.
#   (3) 그 되돌리기를 trap 으로도 건다 — 중간에 끊겨도 격리 속성이 남지 않게.
#
# 되돌린 뒤 원래 서명 상태로 다시 서명한다. 원본 bundle/ 은 이 단계에 전혀
# 관여하지 않는다.
#
# ## 왜 매번 고유 identifier 로 다시 서명하는가
#
# Gatekeeper 의 판정은 cdhash 단위로 기억된다. 같은 바이너리를 격리 속성 없이
# 한 번 실행해 두면 그 다음 격리 실행이 통과해 버려서, 회차마다 결과가 달라진다
# (실측: 1회차 SIGKILL, 2회차 exit 0). 관찰을 재현 가능하게 하려고 대상마다
# `--identifier` 를 그 회차 전용 값으로 바꿔 서명한다 — 한 번도 평가된 적 없는
# cdhash 가 되어 항상 "첫 실행" 조건에서 잰다.
cmd_quarantine() {
  exp_ensure_sandbox
  mkdir -p "$WORK"
  [ -f "$RESULTS" ] || t8_die "RESULTS.md 가 없다: $RESULTS"
  [ -x "$SIGNED_PY" ] || t8_die "서명된 사본이 없다 — probe.sh sign 을 먼저 돌린다"
  t8_write_payload

  echo "probe.sh quarantine — Gatekeeper 동작 관찰 (스펙 P0-C9 3)"
  echo

  local level backup_dir stamp
  level="none"
  [ -f "$LEVEL_FILE" ] && level=$(cat "$LEVEL_FILE")
  backup_dir="$WORK/gk-backup"
  rm -rf "$backup_dir"
  mkdir -p "$backup_dir"
  stamp=$(date -u '+%Y%m%d%H%M%S')

  # log show 의 --start 는 **현지 시각**을 받는다. 이 하네스의 증거는 UTC 지만
  # 여기만은 현지 시각이 맞는 값이다 (t7-lib.sh 의 경고와 반대 방향의 예외).
  local log_start
  log_start=$(date '+%Y-%m-%d %H:%M:%S')

  # 격리 속성 값은 Finder·브라우저가 쓰는 형식 그대로다.
  #   <플래그>;<16진 epoch>;<에이전트>;<UUID>
  local qval
  qval="0081;$(printf '%x' "$(date +%s)");damwha-phase0-probe;"

  local targets out
  targets="$SIGNED_ROOT/python/bin/python3.12 $SIGNED_ROOT/ffmpeg/bin/ffprobe $SIGNED_ROOT/pg/bin/postgres"
  out="$WORK/quarantine.txt"
  : > "$out"

  # 대상을 격리 러너로 한 번 부른다. 결과는 T8_Q_RC / T8_Q_OUT 에 남는다.
  t8_quarantine_exec() {
    local target label res
    target="$1"
    label="$2"
    case "${target#$SIGNED_ROOT/}" in
      python/bin/python3.12)
        res=$(bash "$RUN_ISO" --label "$label" -- \
              "$target" "$PAYLOAD" selfcheck "$SIGNED_ROOT/python" 2>&1) ;;
      # 버전 플래그가 도구마다 다르다 — ffprobe 는 -version(대시 하나),
      # postgres 는 --version 이다. 틀리면 사용법 오류로 죽어서 Gatekeeper
      # 관찰과 구분되지 않는다.
      ffmpeg/bin/*)
        res=$(bash "$RUN_ISO" --label "$label" -- "$target" -version 2>&1) ;;
      *)
        res=$(bash "$RUN_ISO" --label "$label" -- "$target" --version 2>&1) ;;
    esac
    T8_Q_RC=$?
    T8_Q_OUT=$(printf '%s\n' "$res" | grep -a -v '^dyld' | grep -a -v '^run-isolated:' | head -n 6)
  }

  # 대상을 원래 서명 상태로 되돌린다. python 은 4단계 결론 회차의 entitlement 를
  # 다시 붙여야 한다.
  t8_restore_sig() {
    local target plist
    target="$1"
    if [ "$target" = "$SIGNED_PY" ]; then
      plist=$(t8_plist_for "$level")
      if [ -z "$plist" ]; then
        "$CODESIGN" --force --sign - --options runtime --timestamp=none "$target" >/dev/null 2>&1
      else
        "$CODESIGN" --force --sign - --options runtime --timestamp=none \
          --entitlements "$plist" "$target" >/dev/null 2>&1
      fi
    else
      "$CODESIGN" --force --sign - --options runtime --timestamp=none "$target" >/dev/null 2>&1
    fi
  }

  # 중간에 끊겨도 격리 속성을 남기지 않는다.
  #
  # 아래 회차는 (4)에서 com.apple.quarantine 을 붙이고 (7)에서 뗀다. 그 사이에
  # Ctrl-C·오류·외부 종료로 끊기면 속성이 붙은 채로 남고, 그때부터 그 파일을
  # 건드리는 모든 실행에서 Gatekeeper 가 사용자 화면에 대화상자를 띄운다
  # ("… Not Opened — Apple could not verify …"). 2026-09-10 실제로 그렇게 됐고
  # signed/python/bin/python3.12 에 속성이 남았다. 그래서 회차 밖에서 한 번 더
  # 보장한다 — trap 은 정상 종료·인터럽트·오류 모두에서 돈다.
  #
  # 되돌리기까지 여기서 한다. 휴지통으로 옮겨진 파일이 있으면 백업에서 복구하고
  # 원래 서명 상태로 다시 서명한다. 같은 일을 (7)이 이미 했더라도 무해하다.
  t8_gk_cleanup() {
    local rc_saved c
    rc_saved=$?
    for c in $targets; do
      if [ ! -f "$c" ] && [ -f "$backup_dir/$(basename "$c")" ]; then
        cp -p "$backup_dir/$(basename "$c")" "$c" 2>/dev/null || true
        chmod u+w "$c" 2>/dev/null || true
      fi
      [ -f "$c" ] || continue
      "$XATTR" -d com.apple.quarantine "$c" 2>/dev/null || true
      t8_restore_sig "$c"
    done
    return $rc_saved
  }
  trap 't8_gk_cleanup' EXIT INT TERM

  local t rel rc body crc cout assess arc got ident gone plist
  for t in $targets; do
    [ -f "$t" ] || { echo "-- ${t#$SIGNED_ROOT/}: 파일이 없다 — 건너뛴다"; continue; }
    rel="${t#$SIGNED_ROOT/}"
    echo "-- $rel"

    # (1) 대조군 — 격리 속성 없이, 원래 서명 그대로.
    t8_quarantine_exec "$t" "t8-gk-control-$(basename "$t")"
    crc="$T8_Q_RC"
    cout="$T8_Q_OUT"
    echo "   대조군(격리 속성 없음) 실행 exit: $crc"

    # (2) 백업 — Gatekeeper 가 파일을 휴지통으로 옮길 수 있다 (파일 머리말).
    cp -p "$t" "$backup_dir/$(basename "$t")"

    # (3) 이 회차 전용 identifier 로 다시 서명해 "첫 실행" 조건을 만든다.
    ident="damwha-t8-gk-$stamp-$(basename "$t")"
    if [ "$t" = "$SIGNED_PY" ]; then
      plist=$(t8_plist_for "$level")
      if [ -z "$plist" ]; then
        "$CODESIGN" --force --sign - --options runtime --timestamp=none \
          --identifier "$ident" "$t" >/dev/null 2>&1
      else
        "$CODESIGN" --force --sign - --options runtime --timestamp=none \
          --identifier "$ident" --entitlements "$plist" "$t" >/dev/null 2>&1
      fi
    else
      "$CODESIGN" --force --sign - --options runtime --timestamp=none \
        --identifier "$ident" "$t" >/dev/null 2>&1
    fi

    # (4) 격리 속성을 붙인다.
    "$XATTR" -w com.apple.quarantine "$qval" "$t" 2>/dev/null \
      || { echo "   격리 속성 부여 실패"; continue; }
    got=$("$XATTR" -p com.apple.quarantine "$t" 2>/dev/null)
    echo "   com.apple.quarantine = $got"

    # (5) spctl 은 Gatekeeper 정책 엔진의 판정을 그대로 낸다. 실행 결과와 별개로
    # 남긴다 — 둘이 다를 수 있고, 그 차이가 이 절의 관찰 대상이다.
    assess=$("$SPCTL" --assess --type execute --verbose=4 "$t" 2>&1)
    arc=$?
    echo "   spctl --assess --type execute -> exit $arc"
    printf '%s\n' "$assess" | sed 's/^/     /'

    # (6) 같은 명령을 격리 속성이 붙은 채로 돌린다. 서명 후 실행 재시도는
    # 격리 러너로 한다 (계획 Task 8 Interfaces).
    t8_quarantine_exec "$t" "t8-quarantine-$(basename "$t")"
    rc="$T8_Q_RC"
    body="$T8_Q_OUT"
    echo "   격리 속성 부여 후 실행 exit: $rc"

    # (7) 파일이 남아 있는지 본다. 없으면 Gatekeeper 가 휴지통으로 옮긴 것이다.
    if [ -f "$t" ]; then
      gone="no"
      "$XATTR" -d com.apple.quarantine "$t" 2>/dev/null || true
    else
      gone="yes"
      echo "   ** 파일이 사라졌다 — Gatekeeper 가 휴지통으로 옮겼다. 백업에서 되돌린다."
      cp -p "$backup_dir/$(basename "$t")" "$t"
      chmod u+w "$t"
    fi
    t8_restore_sig "$t"
    echo "   복구: 서명 상태를 되돌렸다 (python 은 회차 [$level])"

    {
      printf '## %s\n' "$rel"
      printf 'signing identifier : %s   (회차 전용 — 항상 첫 실행 조건에서 잰다)\n' "$ident"
      printf 'control exit       : %d   (격리 속성 없음)\n' "$crc"
      printf 'control out        :\n'
      printf '%s\n' "$cout" | sed 's/^/  /'
      printf 'quarantine         : %s\n' "$got"
      printf 'spctl exit         : %d\n' "$arc"
      printf 'spctl out          :\n'
      printf '%s\n' "$assess" | sed 's/^/  /'
      printf 'exec exit          : %d   (격리 속성 있음)\n' "$rc"
      printf 'exec out           :\n'
      printf '%s\n' "$body" | sed 's/^/  /'
      printf 'file removed by OS : %s\n' "$gone"
      printf '\n'
    } >> "$out"
    echo
  done

  # --- 시스템 로그 — 커널·syspolicyd 쪽에서 무슨 일이 있었는가 ----------------
  # exit 137 만으로는 "누가 죽였는지"를 말할 수 없다. amfid 의 거부 사유와
  # LSCodeEvaluation 의 휴지통 이동이 이 로그에만 남는다.
  local syslog="$WORK/gk-syslog.txt"
  echo "시스템 로그 수집: $log_start 부터 (수십 초 걸린다)"
  log show --start "$log_start" --style compact 2>/dev/null \
    | grep -a -i -E 'moveItemToTrash|moved .* to trash|AppleMobileFileIntegrityError|GK evaluateScanResult|Prompt shown' \
    | head -n 40 > "$syslog" || true
  echo "  수집된 줄: $(wc -l < "$syslog" | tr -d ' ')"

  t8_rotate "$EVIDENCE/t8-quarantine.txt"
  {
    echo "# Task 8 — Gatekeeper 동작 관찰"
    echo "# utc: $(t8_utc)"
    echo "# 방법"
    echo "#   1. 대상을 격리 속성 없이 한 번 실행한다 (대조군)"
    echo "#   2. 파일을 백업한다 — Gatekeeper 가 휴지통으로 옮길 수 있다 (실측)"
    echo "#   3. 회차 전용 --identifier 로 다시 서명한다 (항상 첫 실행 조건)"
    echo "#   4. xattr -w com.apple.quarantine '<플래그>;<16진 epoch>;<에이전트>;'"
    echo "#   5. spctl --assess --type execute 로 정책 엔진 판정을 본다"
    echo "#   6. 같은 명령을 격리 속성이 붙은 채로 실행한다 (lib/run-isolated.sh)"
    echo "#   7. 파일이 사라졌으면 백업에서 되돌리고 서명 상태를 복구한다"
    echo "# 부여한 값: $qval"
    echo "# python 의 entitlement 회차: $level"
    echo "#"
    echo "# 사본 signed/ 에만 붙였다. 원본 bundle/ 은 이 단계에 관여하지 않는다."
    echo
    cat "$out"
    echo "## 시스템 로그 (log show --start '$log_start')"
    echo "# exit 137 만으로는 누가 죽였는지 말할 수 없다. amfid 의 거부 사유와"
    echo "# LSCodeEvaluation 의 휴지통 이동이 여기에만 남는다."
    echo
    if [ -s "$syslog" ]; then
      sed 's/^/  /' "$syslog"
    else
      echo "  (수집된 줄이 없다)"
    fi
  } | exp_scrub > "$EVIDENCE/t8-quarantine.txt"

  # --- RESULTS.md ---
  local frag="$WORK/frag-gatekeeper.md"
  {
    echo
    echo "측정: \`$(t8_utc)\` · 증거 \`docs/superpowers/reports/evidence/phase-0/t8-quarantine.txt\`"
    echo
    echo "부여한 격리 속성: \`$qval\` (Finder·브라우저가 쓰는 형식 그대로)"
    echo
    echo "같은 명령을 격리 속성 **없이** 한 번, **붙인 채로** 한 번 돌렸다. 대조군이"
    echo "없으면 종료 코드가 Gatekeeper 때문인지 알 수 없다. 격리 실행 직전에 대상마다"
    echo "\`--identifier\`를 그 회차 전용 값으로 바꿔 다시 서명한다 — Gatekeeper의 판정은"
    echo "cdhash 단위로 기억돼서, 같은 cdhash를 한 번 통과시키면 그 다음 회차가 조용히"
    echo "달라지기 때문이다(실측: 1회차 SIGKILL, 2회차 exit 0)."
    echo
    echo "| 대상 | 대조군 실행 (속성 없음) | \`spctl --assess --type execute\` | 격리 속성이 붙은 채로 실행 | OS가 파일을 지웠나 |"
    echo "| --- | --- | --- | --- | --- |"
    local name se ee ce ge
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      ce=$(awk -v n="## $name" '$0==n {f=1;next} f && /^control exit /{print $4; exit}' "$out")
      se=$(awk -v n="## $name" '$0==n {f=1;next} f && /^spctl exit /{print $4; exit}' "$out")
      ee=$(awk -v n="## $name" '$0==n {f=1;next} f && /^exec exit /{print $4; exit}' "$out")
      ge=$(awk -v n="## $name" '$0==n {f=1;next} f && /^file removed by OS /{print $6; exit}' "$out")
      printf '| `%s` | exit %s | exit %s | exit %s | %s |\n' \
        "$name" "${ce:-?}" "${se:-?}" "${ee:-?}" "${ge:-?}"
    done <<EOT
$(grep '^## ' "$out" | sed 's/^## //')
EOT
    echo
    echo "\`spctl\` 원문과 실행 출력은 증거 파일에 그대로 있다. 종료 코드 137은 128+9,"
    echo "즉 **SIGKILL**이다. 누가 죽였는지는 시스템 로그가 말해 준다:"
    echo
    echo '```'
    if [ -s "$syslog" ]; then
      head -n 12 "$syslog"
    else
      echo "(수집된 줄이 없다)"
    fi
    echo '```'
    echo
  } > "$frag"
  t8_splice gatekeeper "$frag"

  echo "증거: $EVIDENCE/t8-quarantine.txt"
  echo "RESULTS.md 갱신: $RESULTS"
  return 0
}

# ---------------------------------------------------------------------------
cmd_status() {
  echo "원본 : $BUNDLE_ROOT"
  echo "사본 : $SIGNED_ROOT"
  if [ -x "$SIGNED_PY" ]; then
    echo "메인 실행 파일: $SIGNED_PY"
    "$CODESIGN" --display --verbose=2 "$SIGNED_PY" 2>&1 | sed 's/^/  /'
    echo "  entitlements:"
    "$CODESIGN" --display --entitlements - "$SIGNED_PY" 2>/dev/null | sed 's/^/    /'
    [ -f "$LEVEL_FILE" ] && echo "  마지막 적용 회차: $(cat "$LEVEL_FILE")"
  else
    echo "사본이 없다 — probe.sh sign 을 먼저 돌린다"
  fi
  return 0
}

case "${1:-}" in
  sign)       shift; cmd_sign       "$@" ;;
  quarantine) shift; cmd_quarantine "$@" ;;
  status)     shift; cmd_status     "$@" ;;
  *) echo "usage: probe.sh {sign|quarantine|status}" >&2; exit 2 ;;
esac
