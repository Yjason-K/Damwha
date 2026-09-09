#!/bin/bash
# Task 3 — 독립 Python 3.12 + models extra + mlx-lm + damwha_worker 런타임을
# 구성하고 **다른 절대 경로로 옮긴 뒤** 검증한다 (스펙 P0-C3).
#
#   build.sh all        stage → check-stage → move → check-moved → relocate → check-bundle
#   build.sh stage      $STAGE/python 구성 (내려받기 · 설치 · 가지치기)
#   build.sh prune      가지치기만 (스테이징을 손으로 만든 뒤 이어 붙일 때)
#   build.sh check <stage|bundle> <증거 이름>   G1 정적 검사를 돌려 증거로 남긴다
#   build.sh move       $STAGE/python → $BUNDLE  (재배치)
#   build.sh relocate   이동 후 사후 처리. **옮길 때마다 다시 돌려야 한다**
#   build.sh sizes      용량 보고
#
# 고른 후보와 탈락시킨 것은 README.md에 있다. 여기서는 "무엇을 했는가"만 적는다.
#
# ## 왜 세 경로를 나누는가
#
#   내려받은 자리 : $STAGE/pydist/cpython-3.12.11-macos-aarch64-none  (uv가 받는다)
#   스테이징      : $STAGE/python                                     (여기에 설치)
#   최종          : $EXP/bundle/python                                (여기로 옮긴 뒤 검증)
#
# Task 2의 pg/build.sh와 같은 이유다. 설치한 자리에서만 검증하면 재배치를 한
# 번도 묻지 않은 채 통과한다. 스펙 P0-C3이 "이동 전에는 되는데 이동 후에
# 깨지는 것"을 핵심 관찰 대상으로 두었다.
#
# ## 이 스크립트가 건드리지 않는 것 (스펙 §4.4)
#
# - 개발 venv(be/worker/.venv). 읽지도 쓰지도 않는다.
# - 개발자 HF 캐시. 이 스크립트는 모델을 내려받지 않는다 (Task 9의 몫).
# - be/worker의 소스. wheel을 만들 때 읽기만 하고, 산출물은 $STAGE/wheels에 둔다.
#
# **`uv pip install`은 `--link-mode=copy`로 한다.** 기본값(하드링크)이면 설치된
# 파일이 개발자 uv 캐시의 inode를 그대로 공유하고, 그 캐시는 개발 venv에도
# 하드링크돼 있다. 뒤에서 install_name_tool로 Mach-O를 고치는 순간 **개발
# venv의 같은 파일이 함께 바뀐다.** 복사는 디스크를 더 쓰지만 그 사고를 막는다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

PY_DIR="$EXP_ROOT/python"
STAGE="$EXP_ROOT/stage"
PYDIST="$STAGE/pydist"
STAGE_PY="$STAGE/python"
WHEELS="$STAGE/wheels"
BUNDLE="$EXP_ROOT/bundle/python"

PY_VERSION="3.12"
PY_FULL="3.12.11"
PBS_DIR="cpython-${PY_FULL}-macos-aarch64-none"
# 개발 환경의 uv tool 설치본과 같은 버전으로 고정한다 (be/worker/SMOKE.md의
# `uv tool install mlx-lm`이 지금 깔아 둔 것). 스펙 §2가 지적한 대로
# mlx_lm.server는 어떤 매니페스트에도 없어서 pyproject.toml에 기준이 없다 —
# 그래서 "지금 개발자가 쓰고 있는 것"을 실측해 여기 적는다.
MLX_LM_VERSION="0.31.3"

die() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

# 증거 파일은 덮어쓰지 않는다 (스펙 §6, 계획 "Verify 명령 작성 규칙").
# 같은 이름이 이미 있으면 옆으로 회전시킨다.
evidence_path() {
  # `local a="$1" b="...$a"` 는 쓰지 않는다 — bash가 같은 local 문 안의 앞
  # 변수를 아직 못 보고, set -u 아래에서 unbound variable로 죽는다. 호출자에
  # 같은 이름의 local이 있으면 조용히 **그 값**을 읽어 더 나쁘다.
  local name f
  name="$1"
  f="$EVIDENCE/$name"
  mkdir -p "$EVIDENCE"
  if [ -f "$f" ]; then
    mv "$f" "${f%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  fi
  echo "$f"
}

need_tool() { command -v "$1" >/dev/null 2>&1 || die "$1 이 없다"; }

# ---------------------------------------------------------------------------
# stage — 내려받기 · 설치 · 가지치기
# ---------------------------------------------------------------------------

do_download() {
  step "1. python-build-standalone $PY_FULL 내려받기 (스펙 §9 Python 후보 1)"
  need_tool uv
  if [ -d "$PYDIST/$PBS_DIR" ]; then
    echo "  이미 있다: $PYDIST/$PBS_DIR (다시 받지 않는다)"
  else
    mkdir -p "$PYDIST"
    # --no-bin: 개발자 홈의 ~/.local/bin 에 python 링크를 심지 않는다.
    uv python install --install-dir "$PYDIST" --no-bin "$PY_VERSION" \
      || die "uv python install 실패"
  fi
  [ -x "$PYDIST/$PBS_DIR/bin/python3.12" ] || die "받은 트리에 bin/python3.12 이 없다"
  echo "  BUILD 태그: $(cat "$PYDIST/$PBS_DIR/BUILD" 2>/dev/null)"
}

do_copy() {
  step "2. $STAGE_PY 로 복사"
  [ -d "$STAGE_PY" ] && die "$STAGE_PY 이 이미 있다. 다시 만들려면 먼저 지워라"
  cp -R "$PYDIST/$PBS_DIR" "$STAGE_PY" || die "복사 실패"
  # uv가 자기 관리 디렉터리 표시로 넣는 파일이다. 우리는 이 트리를 uv 관리
  # **밖으로** 복사해 번들의 런타임으로 쓰므로 표시가 남아 있으면 안 된다
  # (uv pip install이 거부한다).
  rm -f "$STAGE_PY/lib/python$PY_VERSION/EXTERNALLY-MANAGED"
  echo "  복사 완료: $STAGE_PY"
}

do_wheel() {
  step "3. damwha_worker wheel 빌드 (PYTHONPATH로 개발 venv를 끌어오지 않는다)"
  need_tool uv
  mkdir -p "$WHEELS"
  rm -f "$WHEELS"/damwha_worker-*.whl
  uv build --wheel --out-dir "$WHEELS" "$REPO_ROOT/be/worker" >/dev/null \
    || die "uv build 실패"
  ls -1 "$WHEELS"/damwha_worker-*.whl | sed 's/^/  /'
}

do_install() {
  step "4. models extra 전량 + mlx-lm + damwha_worker 설치"
  need_tool uv
  local whl
  whl=$(ls -1 "$WHEELS"/damwha_worker-*.whl 2>/dev/null | head -n 1)
  [ -n "$whl" ] || die "wheel이 없다 — build.sh stage 를 처음부터 돌려라"

  # extras 표기로 wheel을 직접 가리킨다. 그러면 pyproject.toml의 `==` 고정
  # 버전이 그대로 해석에 들어간다 — 하한만 맞춘 설치가 되지 않는다.
  uv pip install \
    --python "$STAGE_PY/bin/python$PY_VERSION" \
    --link-mode=copy \
    "damwha-worker[models] @ file://$whl" \
    "mlx-lm==$MLX_LM_VERSION" \
    || die "uv pip install 실패"
}

# 번들에서 빼는 것. 두 종류뿐이고, 둘 다 **디렉터리 단위**다.
#
#   (a) 빌드 전용 — C 헤더, pkgconfig, config-*/Makefile. 앱 실행에 쓰지 않는다.
#       Task 2가 pgxs·include·lib/pkgconfig를 뺀 것과 같은 이유다.
#   (b) 쓰지 않는 서브시스템 — tkinter/tcl/tk, pip/ensurepip, lib2to3, man.
#
# site-packages 안은 **건드리지 않는다.** uv가 설치한 패키지 집합을 그대로 두어야
# t3-versions.sh의 버전 대조와 재현이 성립한다. 거기 남는 금지 문자열은
# lib/g1-allowlist.txt에 분류해 남긴다 (pip은 (b)로 통째로 빠진다).
#
# (b)의 부수 효과가 하나 더 있다. python-build-standalone의 bin/ 스크립트
# (pip·2to3·idle3·pydoc3·python3.12-config)는 셔뱅이 `#!/bin/sh` + 자기 위치
# 계산이라 **exec 시점에 SIP가 DYLD_*를 지운다.** 그것들을 빼면 번들 bin/의
# 모든 스크립트가 번들 python을 직접 exec하는 형태로 통일되고, 계획 규칙 6c의
# "셔뱅 스크립트의 dyld 메인 이미지 = 번들 python"이 예외 없이 성립한다.
PRUNE_BUILD_ONLY="
include
lib/pkgconfig
lib/python3.12/config-3.12-darwin
bin/python3.12-config
bin/python3-config
share/man
"

PRUNE_UNUSED="
lib/tcl8
lib/tcl8.6
lib/tk8.6
lib/itcl4.2.4
lib/thread2.8.9
lib/libtcl8.6.dylib
lib/libtk8.6.dylib
lib/python3.12/tkinter
lib/python3.12/idlelib
lib/python3.12/turtledemo
lib/python3.12/turtle.py
lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so
lib/python3.12/lib2to3
lib/python3.12/ensurepip
bin/idle3
bin/idle3.12
bin/2to3
bin/2to3-3.12
bin/pydoc3
bin/pydoc3.12
bin/pip
bin/pip3
bin/pip3.12
lib/python3.12/site-packages/pip
"

do_prune() {
  local root="$1"
  step "5. 가지치기 — 빌드 전용 · 쓰지 않는 서브시스템"
  local before after p
  before=$(du -sk "$root" | awk '{print $1}')
  # -e 는 끊어진 심볼릭 링크에 false다. 목록이 링크와 그 대상을 함께 담고
  # 있어서(bin/python3-config → bin/python3.12-config) -L 도 같이 본다.
  for p in $PRUNE_BUILD_ONLY; do
    if [ -e "$root/$p" ] || [ -L "$root/$p" ]; then
      rm -rf "$root/$p"; echo "  빌드전용 제거: $p"
    fi
  done
  for p in $PRUNE_UNUSED; do
    if [ -e "$root/$p" ] || [ -L "$root/$p" ]; then
      rm -rf "$root/$p"; echo "  미사용   제거: $p"
    fi
  done
  rm -rf "$root"/lib/python3.12/site-packages/pip-*.dist-info
  rmdir "$root/share" 2>/dev/null
  after=$(du -sk "$root" | awk '{print $1}')
  echo "  $before KiB → $after KiB"
}

cmd_stage() {
  do_download
  do_copy
  do_wheel
  do_install
  do_prune "$STAGE_PY"
  echo
  echo "스테이징 완료: $STAGE_PY"
}

# ---------------------------------------------------------------------------
# move — 재배치
# ---------------------------------------------------------------------------

cmd_move() {
  step "6. 재배치 $STAGE_PY → $BUNDLE"
  [ -d "$STAGE_PY" ] || die "$STAGE_PY 이 없다"
  [ -d "$BUNDLE" ] && die "$BUNDLE 이 이미 있다. 다시 하려면 먼저 지워라"
  mkdir -p "$(dirname "$BUNDLE")"
  mv "$STAGE_PY" "$BUNDLE" || die "이동 실패"
  echo "  이동 완료. 이후 모든 검증은 $BUNDLE 에서 한다"
}

# ---------------------------------------------------------------------------
# relocate — 이동 후 사후 처리
#
# **옮길 때마다 다시 돌려야 한다.** 이것이 이 Task의 결론 중 하나다: 이 구성의
# Python 런타임은 "복사만 하면 도는" 형태가 아니라 **재배치 후 한 번의 사후
# 처리가 필요한** 형태다. 그 처리를 손이 아니라 여기에 적어 재현 가능하게 둔다.
# ---------------------------------------------------------------------------

# 번들 안의 Mach-O 목록. check-macho.sh와 같은 방식으로 뽑는다(아키텍처 꼬리표
# 제거 포함) — 검사기가 보는 집합과 고치는 집합이 어긋나면 안 된다.
macho_list() {
  local root="$1"
  # 심볼릭 링크는 뺀다 — 같은 inode를 두 번 고치면 두 번째가 실패로 보인다.
  find -L "$root" -type f -print0 2>/dev/null \
    | xargs -0 file -L 2>/dev/null | grep -a 'Mach-O' \
    | sed -e 's/:[[:space:]]*Mach-O.*$//' -e 's/ (for architecture [^)]*)$//' \
    | sort -u
}

# install_name_tool로 고친 Mach-O는 **반드시 다시 서명한다.** arm64는 서명 없는
# Mach-O를 실행하지 않는다 — Task 2가 이걸로 걸렸다. ad-hoc 서명은 플랫폼
# 바이너리를 만들지 않으므로 DYLD_* 실측은 그대로 살아 있다.
resign() { codesign -f -s - "$1" >/dev/null 2>&1 || echo "  경고: 재서명 실패 $1"; }

cmd_relocate() {
  local root="${1:-$BUNDLE}"
  [ -d "$root" ] || die "$root 이 없다"
  root=$(cd "$root" && pwd -P)
  need_tool install_name_tool
  need_tool codesign

  local out
  out=$(evidence_path "t3-relocate-fix.txt")
  {
    echo "# Task 3 재배치 사후 처리 (build.sh relocate)"
    echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# 대상: $root"
    echo

    echo "## R-9 — 콘솔 스크립트 셔뱅의 절대 경로"
    # uv/pip이 만드는 콘솔 스크립트는 셔뱅에 **설치 시점 인터프리터의 절대
    # 경로**를 박는다. 옮기면 그 경로가 없어져 스크립트가 통째로 죽는다.
    # 이것이 R-9이고, 스펙 §2가 지목한 mlx_lm.server가 정확히 이 형태다.
    #
    # 고칠 때 셔뱅을 `#!/bin/sh` + 자기 위치 계산으로 바꾸는 방법도 있지만
    # **쓰지 않는다.** 그러면 SIP가 /bin/sh exec에서 DYLD_*를 지워 Task 5의
    # dyld 실측이 통째로 끊긴다 (계획 규칙 2a·6c). 번들 python을 커널이
    # 직접 exec하는 형태를 유지하고, 경로만 현재 위치로 다시 쓴다.
    local n=0 f first
    for f in "$root"/bin/*; do
      [ -f "$f" ] || continue
      first=$(head -c 2 "$f" 2>/dev/null)
      [ "$first" = "#!" ] || continue
      local line
      line=$(head -n 1 "$f")
      case "$line" in
        "#!$root/bin/python$PY_VERSION") continue ;;
        \#\!*/bin/python3.12)
          # 첫 줄만 바꾼다. 나머지 바이트는 손대지 않는다.
          local tmp="$f.reloc.$$"
          { echo "#!$root/bin/python$PY_VERSION"; tail -n +2 "$f"; } > "$tmp"
          chmod 755 "$tmp"
          mv "$tmp" "$f"
          echo "  셔뱅 수정: bin/$(basename "$f")   $line"
          n=$((n + 1))
          ;;
      esac
    done
    echo "  → ${n}개 수정"
    echo

    echo "## sysconfig 데이터의 설치 시점 prefix"
    # uv는 설치 시점에 _sysconfigdata__darwin_darwin.py의 prefix 계열 값을
    # 자기 설치 디렉터리로 다시 쓴다. 우리가 그 트리를 복사해 왔으므로 값이
    # 처음부터 어긋나 있고, 옮기면 한 번 더 어긋난다. sysconfig.get_config_vars()가
    # 이 값을 그대로 돌려주므로 P0-C8(런타임 자기 보고)에서 바로 드러난다.
    local sysdata="$root/lib/python$PY_VERSION/_sysconfigdata__darwin_darwin.py"
    if [ -f "$sysdata" ]; then
      local cur
      # 파일을 정규식으로 긁지 않고 **런타임에게 직접 묻는다.** 이 파일의 표기가
      # 홑따옴표인지 겹따옴표인지, 한 줄인지 여러 줄인지는 배포본마다 다르다
      # (실제로 겹따옴표라 홑따옴표 regex가 조용히 빈 값을 냈다).
      cur=$("$root/bin/python$PY_VERSION" -c \
            "import sys,sysconfig; sys.stdout.write(sysconfig.get_config_var('prefix') or '')" \
            2>/dev/null)
      if [ -n "$cur" ] && [ "$cur" != "$root" ]; then
        local esc_from esc_to
        esc_from=$(printf '%s' "$cur"  | sed 's/[&/\]/\\&/g')
        esc_to=$(printf '%s'   "$root" | sed 's/[&/\]/\\&/g')
        LC_ALL=C sed -i '' "s/$esc_from/$esc_to/g" "$sysdata"
        echo "  prefix 재작성: $cur → $root"
        # 고쳐졌는지 런타임에게 다시 묻는다. 조용히 실패하면 P0-C8이 그대로
        # 무너지므로 여기서 확인하고 남긴다.
        local after
        after=$("$root/bin/python$PY_VERSION" -c \
                "import sys,sysconfig; sys.stdout.write(sysconfig.get_config_var('prefix') or '')" \
                2>/dev/null)
        if [ "$after" = "$root" ]; then
          echo "  확인: sysconfig.get_config_var('prefix') = $after"
        else
          echo "  경고: 재작성 후에도 값이 다르다: '${after:-없음}'"
        fi
      elif [ -z "$cur" ]; then
        echo "  경고: prefix 값을 읽지 못했다 (번들 python이 실행되지 않는다?)"
      else
        echo "  prefix 이미 일치: $cur"
      fi
    else
      echo "  파일 없음: $sysdata"
    fi
    echo

    echo "## PEP 610 direct_url.json (설치 출처 메타데이터)"
    # wheel을 파일 경로로 설치하면 그 경로가 여기 남는다. 우리 경우
    # $STAGE/wheels 를 가리켜 이동 후 번들 밖 절대 경로가 된다. 런타임이
    # 읽지 않는 **설치 출처 기록**이므로 지운다 (PEP 610은 선택 사항이다).
    local d cnt=0
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      rm -f "$d"
      echo "  삭제: ${d#$root/}"
      cnt=$((cnt + 1))
    done <<EOT
$(find "$root/lib/python$PY_VERSION/site-packages" -name direct_url.json 2>/dev/null)
EOT
    echo "  → ${cnt}개 삭제"
    echo

    echo "## __pycache__ 정리"
    # 번들 python을 한 번이라도 실행하면 .pyc가 생기고, 그 안에는 컴파일 시점의
    # **소스 절대 경로**(co_filename)와 모듈의 문자열 상수가 그대로 들어간다.
    # _sysconfigdata의 옛 prefix가 .pyc에 남아 있으면 위에서 .py를 고쳐도
    # 검사에는 그대로 잡힌다. 재배치할 때마다 지우는 것이 맞다 — 어차피 다시
    # 만들어지고, 앱 번들에 미리 넣어 둘 것도 아니다.
    local pc
    pc=$(find "$root" -type d -name __pycache__ 2>/dev/null | wc -l | tr -d ' ')
    find "$root" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null
    echo "  → ${pc}개 디렉터리 삭제"
    echo

    echo "## Mach-O — 번들 밖 LC_RPATH 삭제"
    # 이것이 이 Task에서 **가장 실질적인** 발견이다. wheel 배포자의 빌드 머신
    # 경로가 LC_RPATH로 그대로 남아 있고, LC_RPATH는 dyld의 실제 검색 경로다.
    # 특히 scipy의 확장 모듈에는 /opt/homebrew 의 gcc 경로가 들어 있어,
    # 그 자리에 같은 이름의 dylib이 있으면 번들이 아니라 Homebrew 쪽을 열 수
    # 있다. 스펙 §4.1이 LC_RPATH를 따로 검사하게 한 이유 그대로다.
    local m rp rn=0 rfiles=0 touched
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      touched=0
      while IFS= read -r rp; do
        [ -n "$rp" ] || continue
        case "$rp" in
          @*|"$root"|"$root"/*|/usr/lib|/usr/lib/*|/System/Library|/System/Library/*) continue ;;
        esac
        if install_name_tool -delete_rpath "$rp" "$m" 2>/dev/null; then
          echo "  LC_RPATH 삭제: ${m#$root/}  <- $rp"
          rn=$((rn + 1)); touched=1
        else
          echo "  경고: LC_RPATH 삭제 실패 ${m#$root/}  <- $rp"
        fi
      done <<EOT
$(otool -l "$m" 2>/dev/null | awk '/^ *cmd LC_RPATH/{r=1;next} r&&/^ *path /{print $2; r=0}' | sort -u)
EOT
      if [ "$touched" = 1 ]; then resign "$m"; rfiles=$((rfiles + 1)); fi
    done <<EOT
$(macho_list "$root")
EOT
    echo "  → ${rn}건 삭제 / ${rfiles}개 파일 재서명"
    echo

    echo "## Mach-O — 번들 밖 LC_ID_DYLIB 정규화"
    # wheel의 dylib은 delocate가 넣은 자리표시자 id(`/DLC/...`)나 빌드 시점
    # 경로(`/opt/llvm-openmp/...`, bazel-out/...)를 그대로 갖고 있다. 의존
    # 참조는 전부 @loader_path/@rpath 라서 그 id가 dyld에서 해석되는 일은
    # 없지만, otool -L의 첫 줄로 나오므로 G1이 의존 경로와 함께 읽는다.
    # Task 2가 pg의 dylib id를 @rpath/로 바꾼 것과 같은 처리를 한다.
    local idv base newid in_=0 ifiles=0
    while IFS= read -r m; do
      [ -n "$m" ] || continue
      # otool -D는 fat 바이너리에서 헤더 줄("path:", "path (architecture x):",
      # "Architectures in the fat file: ...")을 섞어 낸다. id만 남긴다.
      idv=$(otool -D "$m" 2>/dev/null \
            | grep -v ':$' | grep -v '^Architectures in the fat file' \
            | sed -n '1p')
      [ -n "$idv" ] || continue
      case "$idv" in
        @*|"$root"|"$root"/*) continue ;;
      esac
      base=$(basename "$idv")
      case "${m#$root/}" in
        lib/libpython3.12.dylib)
          # bin/python3.12 이 @executable_path/../lib/... 로 참조하므로 id도
          # 같은 형태로 맞춘다.
          newid="@executable_path/../lib/libpython$PY_VERSION.dylib" ;;
        *) newid="@rpath/$base" ;;
      esac
      if install_name_tool -id "$newid" "$m" 2>/dev/null; then
        echo "  LC_ID_DYLIB: ${m#$root/}  $idv → $newid"
        resign "$m"
        in_=$((in_ + 1)); ifiles=$((ifiles + 1))
      else
        echo "  경고: id 변경 실패 ${m#$root/}  ($idv)"
      fi
    done <<EOT
$(macho_list "$root")
EOT
    echo "  → ${in_}건 변경 / ${ifiles}개 파일 재서명"
    echo
    echo "재배치 사후 처리 끝."
  } 2>&1 | tee "$out"
  echo
  echo "증거: $out"
}

# ---------------------------------------------------------------------------
# check — G1 정적 검사
# ---------------------------------------------------------------------------

cmd_check() {
  local which="${1:-bundle}" name="${2:-}"
  local root
  case "$which" in
    stage)  root="$STAGE_PY" ;;
    bundle) root="$BUNDLE" ;;
    *)      root="$which" ;;
  esac
  [ -d "$root" ] || die "$root 이 없다"
  [ -n "$name" ] || name="t3-g1-$which.txt"
  local out
  out=$(evidence_path "$name")
  {
    echo "# G1 정적 검사 (check-macho.sh) — Task 3"
    echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "# 대상: $root"
    echo
  } > "$out" 2>&1
  local rc
  bash "$EXP_LIB_DIR/check-macho.sh" "$root" >> "$out" 2>&1
  rc=$?
  echo "" >> "$out"
  echo "# check-macho.sh exit: $rc" >> "$out"
  # 증거 파일에는 임의의 바이트가 들어 있다(Mach-O에서 뽑은 토큰). 기본
  # 로케일이면 sed/grep이 "illegal byte sequence"로 죽는다.
  local n
  n=$(LC_ALL=C sed -n 's/^  위반 *: *\([0-9]*\)건$/\1/p' "$out" | tail -n 1)
  echo "G1($which) → $out   (check-macho.sh exit=$rc, 위반 ${n:-?}건)"
  return 0
}

cmd_sizes() {
  step "용량"
  for d in "$PYDIST" "$STAGE_PY" "$WHEELS" "$BUNDLE"; do
    [ -d "$d" ] && du -sh "$d" | sed 's/^/  /'
  done
  if [ -d "$BUNDLE" ]; then
    echo "  --- bundle/python 내부 상위 10 ---"
    du -sk "$BUNDLE"/lib/python$PY_VERSION/site-packages/* 2>/dev/null \
      | sort -rn | head -10 | awk '{printf "  %8.1f MiB  %s\n", $1/1024, $2}'
  fi
}

cmd_all() {
  cmd_stage
  cmd_check stage t3-g1-stage.txt
  cmd_move
  cmd_check bundle t3-relocation-attempt1.txt
  cmd_relocate "$BUNDLE"
  cmd_check bundle t3-g1-bundle.txt
  cmd_sizes
}

case "${1:-all}" in
  all)      cmd_all ;;
  stage)    cmd_stage ;;
  prune)    shift; do_prune "${1:-$STAGE_PY}" ;;
  move)     cmd_move ;;
  relocate) shift; cmd_relocate "${1:-$BUNDLE}" ;;
  check)    shift; cmd_check "${1:-bundle}" "${2:-}" ;;
  sizes)    cmd_sizes ;;
  *)        die "usage: build.sh {all|stage|prune [dir]|move|relocate [dir]|check <stage|bundle> <name>|sizes}" ;;
esac
