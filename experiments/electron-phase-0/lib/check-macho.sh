#!/bin/bash
# G1 — 정적 링크 검사 (스펙 §4.1).
#
#   check-macho.sh <디렉터리>
#
# 하위 전체를 훑어 세 가지를 본다.
#   (1) 모든 Mach-O의 otool -L 의존 경로가 허용 접두사인가
#       (@rpath / @loader_path / @executable_path / /usr/lib / /System/Library)
#   (2) otool -l의 LC_RPATH에 번들 밖 절대 경로가 없는가
#   (3) **모든 파일**에 금지 문자열(lib/forbidden-strings.txt)이 없는가
#
# (3)을 Mach-O로 좁히지 않는 이유는 스펙 §4.1이 적은 그대로다 — 재배치가
# 깨지는 흔한 자리는 컴파일된 바이너리가 아니라 sysconfig 데이터, *.pc,
# postgresql.conf, 셸 래퍼, 콘솔 스크립트 shebang처럼 빌드 시점 경로가 그대로
# 박힌 텍스트다. .metallib 같은 비 Mach-O 자산도 같은 이유로 포함된다.
#
# 위반이 1건이라도 있으면 exit 1이고 목록을 stdout에 출력한다.
#
# otool / file은 **검사 도구**이지 피검사 대상이 아니므로 격리 규칙의 예외다
# (스펙 §4.1 마지막 문단). 이 스크립트는 격리 밖에서 돌린다.
#
# 환경 변수:
#   CHECK_MACHO_MAX_VIOLATIONS  위반을 이 개수만큼 모으면 스캔을 중단한다.
#                               0(기본) = 무제한. 음성 대조군(verify/t1-detector-
#                               negative.sh)이 609개 Homebrew 바이너리를 끝까지
#                               읽지 않게 하려고만 쓴다. 실제 번들 검사는 기본값
#                               그대로 전수 조사한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/config.sh"

# 검사 대상은 임의의 바이트를 담은 바이너리다. 기본 로케일에서는 grep/sort가
# "Illegal byte sequence"로 줄을 버리거나 멈춘다 — 그러면 위반이 조용히 사라진다.
export LC_ALL=C

MAX_VIOLATIONS=${CHECK_MACHO_MAX_VIOLATIONS:-0}

[ $# -eq 1 ] || { echo "usage: check-macho.sh <directory>" >&2; exit 2; }
[ -d "$1" ] || { echo "FAIL: 검사 대상 디렉터리가 없다: $1" >&2; exit 2; }
ROOT=$(cd "$1" && pwd -P)

command -v otool >/dev/null 2>&1 || { echo "FAIL: otool이 없다 (G1을 수행할 수 없다)" >&2; exit 2; }
command -v file  >/dev/null 2>&1 || { echo "FAIL: file이 없다 (G1을 수행할 수 없다)" >&2; exit 2; }

PATTERN_SRC="$EXP_LIB_DIR/forbidden-strings.txt"
[ -f "$PATTERN_SRC" ] || { echo "FAIL: 금지 문자열 파일이 없다: $PATTERN_SRC" >&2; exit 2; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/checkmacho.XXXXXX") || exit 2
trap 'rm -rf "$WORK"' EXIT

PATTERNS="$WORK/patterns.txt"
grep -v '^[[:space:]]*#' "$PATTERN_SRC" | grep -v '^[[:space:]]*$' > "$PATTERNS"

# 실행 시점의 실제 개발자 홈도 금지 문자열에 덧붙인다. 스펙 §4.1 표는 이
# 머신의 홈을 문자열로 적어 두었지만, 그 값에만 의존하면 홈이 바뀐 순간
# 검사기가 조용히 눈이 먼다. $EXP_ROOT 하위 경로는 아래에서 걸러 내므로
# 샌드박스/번들 자신의 절대 경로가 위반으로 잡히지는 않는다.
case "${HOME:-}" in
  ""|"$EXP_ROOT"*) ;;
  *) grep -qxF "$HOME" "$PATTERNS" || echo "$HOME" >> "$PATTERNS" ;;
esac

PATTERN_COUNT=$(wc -l < "$PATTERNS" | tr -d ' ')

FILES="$WORK/files.nul"
find -L "$ROOT" \( -type f -o -type l \) -print0 > "$FILES" 2>/dev/null
FILE_COUNT=$(tr '\0' '\n' < "$FILES" | wc -l | tr -d ' ')

VIOL="$WORK/violations.txt"
INFO="$WORK/internal.txt"
: > "$VIOL"
: > "$INFO"

viol_count() { wc -l < "$VIOL" | tr -d ' '; }
over_budget() {
  [ "$MAX_VIOLATIONS" -gt 0 ] || return 1
  [ "$(viol_count)" -ge "$MAX_VIOLATIONS" ]
}
add_viol() { echo "$1" >> "$VIOL"; }

# --- (3) 금지 문자열 전수 검사 ------------------------------------------------
# 먼저 배치 grep으로 후보 파일만 뽑고(수만 개 파일에서 파일당 fork를 피한다),
# 후보에 대해서만 패턴별로 전체 토큰을 뽑아 보고한다.
CANDIDATES="$WORK/candidates.txt"
: > "$CANDIDATES"
if [ "$FILE_COUNT" -gt 0 ]; then
  xargs -0 grep -a -l -F -f "$PATTERNS" < "$FILES" 2>/dev/null | sort -u > "$CANDIDATES" || true
fi

ere_escape() { printf '%s' "$1" | sed 's/[].[^$*\\]/\\&/g'; }

while IFS= read -r f; do
  [ -n "$f" ] || continue
  # 패턴 원본 파일 자신은 검사 대상에서 제외한다 (파일 주석 참조).
  [ "$f" = "$PATTERN_SRC" ] && continue
  over_budget && break
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    esc=$(ere_escape "$p")
    # 패턴에서 시작해 경로가 끝날 때까지를 토큰으로 잡는다. 어느 경로가
    # 박혀 있는지까지 보고해야 Task 2·3이 install_name_tool로 고칠 자리를
    # 특정할 수 있다.
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      case "$tok" in
        "$EXP_ROOT"*)
          # 번들·샌드박스 자기 자신의 절대 경로다. 개발 환경 의존이 아니므로
          # 위반이 아니다. 재배치 위험은 아래 (1)(2)의 Mach-O 검사가 맡는다.
          echo "$f: $tok" >> "$INFO"
          ;;
        *)
          add_viol "STRING  $f: $tok  (금지 문자열: $p)"
          ;;
      esac
    done <<EOT
$(grep -a -o -E "${esc}[^[:space:]\"'\`|;:,()<>]*" "$f" 2>/dev/null | sort -u)
EOT
  done < "$PATTERNS"
done < "$CANDIDATES"

# --- (1)(2) Mach-O 검사 -------------------------------------------------------
MACHO="$WORK/macho.txt"
: > "$MACHO"
if [ "$FILE_COUNT" -gt 0 ]; then
  # universal(fat) 바이너리에 대해 file은 요약 한 줄 + 아키텍처마다 한 줄을 낸다:
  #   path: Mach-O universal binary with 2 architectures: [...]
  #   path (for architecture arm64e):\tMach-O 64-bit executable arm64e
  # 두 번째 형태를 그대로 두면 존재하지 않는 경로가 목록에 들어가고, 그 항목에
  # 대한 otool은 조용히 실패한다 — 즉 fat 바이너리가 검사에서 통째로 빠진다.
  # 아키텍처 꼬리표를 떼고 중복을 없앤다.
  xargs -0 file -L < "$FILES" 2>/dev/null | grep -a 'Mach-O' \
    | sed -e 's/:[[:space:]]*Mach-O.*$//' -e 's/ (for architecture [^)]*)$//' \
    | sort -u > "$MACHO" || true
fi
MACHO_COUNT=$(wc -l < "$MACHO" | tr -d ' ')

allowed_dep() {
  case "$1" in
    @rpath/*|@loader_path/*|@executable_path/*) return 0 ;;
    /usr/lib/*|/System/Library/*)               return 0 ;;
    *) return 1 ;;
  esac
}

allowed_rpath() {
  # 스펙 §4.1: LC_RPATH에 "번들 밖 절대 경로"가 없어야 한다. 번들 안을
  # 가리키는 절대 경로는 스펙 문면상 위반이 아니다 — 다만 재배치에 약하므로
  # INFO로 남긴다.
  case "$1" in
    @*)                       return 0 ;;
    "$ROOT"|"$ROOT"/*)        return 0 ;;
    /usr/lib|/usr/lib/*|/System/Library|/System/Library/*) return 0 ;;
    *) return 1 ;;
  esac
}

while IFS= read -r m; do
  [ -n "$m" ] || continue
  over_budget && break
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    allowed_dep "$dep" || add_viol "OTOOL-L $m: $dep  (허용 접두사가 아니다)"
  done <<EOT
$(otool -L "$m" 2>/dev/null | sed -n 's/^[[:space:]]\{1,\}\(.*\) (compatibility.*$/\1/p' | sort -u)
EOT
  while IFS= read -r rp; do
    [ -n "$rp" ] || continue
    if ! allowed_rpath "$rp"; then
      add_viol "LC_RPATH $m: $rp  (번들 밖 절대 경로)"
    else
      case "$rp" in
        "$ROOT"|"$ROOT"/*) echo "$m: LC_RPATH $rp (번들 안 절대 경로 — 재배치에 약함)" >> "$INFO" ;;
      esac
    fi
  done <<EOT
$(otool -l "$m" 2>/dev/null | awk '/^ *cmd LC_RPATH/{r=1;next} r&&/^ *path /{print $2; r=0}' | sort -u)
EOT
done < "$MACHO"

# --- 보고 --------------------------------------------------------------------
N=$(viol_count)
INFO_N=$(wc -l < "$INFO" | tr -d ' ')

echo "check-macho.sh (G1, 스펙 §4.1)"
echo "  대상          : $ROOT"
echo "  파일 수       : $FILE_COUNT"
echo "  Mach-O 수     : $MACHO_COUNT"
echo "  금지 문자열   : ${PATTERN_COUNT}개 (lib/forbidden-strings.txt + 실행 시점 HOME)"
echo "  문자열 후보   : $(wc -l < "$CANDIDATES" | tr -d ' ')개 파일"
echo "  번들 내부 절대경로(INFO): ${INFO_N}건"
if [ "$INFO_N" -gt 0 ]; then
  head -n 20 "$INFO" | sed 's/^/    INFO  /'
  [ "$INFO_N" -gt 20 ] && echo "    ... (${INFO_N}건 중 20건만 표시)"
fi
echo "  위반          : ${N}건"
if [ "$N" -gt 0 ]; then
  sed 's/^/    /' "$VIOL"
  if [ "$MAX_VIOLATIONS" -gt 0 ] && [ "$N" -ge "$MAX_VIOLATIONS" ]; then
    echo "  (CHECK_MACHO_MAX_VIOLATIONS=$MAX_VIOLATIONS 에 도달해 스캔을 중단했다)"
  fi
  exit 1
fi
exit 0
