#!/bin/bash
# 계획 Task 1 V5 — **계측기가 실제로 계측하는가.**
#
# 이 하네스의 증거는 전부 두 계측기에서 나온다: G1 정적 검사(check-macho.sh)와
# G2 dyld 실측(run-isolated.sh). 둘 중 하나가 눈이 멀면 나머지 열 Task의
# "위반 0건"은 아무 의미가 없다. 그래서 셋을 확인한다.
#
#   A. 합성 대조군 — 금지 문자열 9종 전부, otool -L 의존 위반, LC_RPATH 위반,
#      그리고 **재배치 잔존 경로**(STALE-PATH)를 일부러 심은 디렉터리를 만들고
#      check-macho.sh가 **전부** 잡는지 본다. 패턴 목록은
#      lib/forbidden-strings.txt에서 읽어 만들므로, 표에 행이 늘어나면
#      대조군도 저절로 늘어난다.
#   B. 실물 대조군 — 계획 V5가 지정한 그대로 check-macho.sh /opt/homebrew/bin이
#      비정상 종료하는지 본다.
#   C. dyld 실측 대조군 — 플랫폼 바이너리가 아닌 Mach-O를 격리 실행했을 때
#      dyld 줄이 실제로 잡히는지 본다. 이게 없으면 모든 실행이 조용히
#      MEASUREMENT_UNAVAILABLE로 기록돼도 아무도 모른다.
#   D. 런처 dyld 대조군 — SIP는 플랫폼 바이너리(/bin/bash 등)를 exec할 때마다
#      환경에서 DYLD_*를 지운다. 그래서 번들 Mach-O를 bash 런처로 감싸는
#      순간 실측이 끊긴다. 계획 "런처 스크립트의 dyld 실측 규칙"이 요구하는
#      re-export가 실제로 그 차이를 만드는지 한 쌍으로 확인한다. 뒤 Task의
#      런처(pg/run.sh, services/*.sh, lib/selfreport-all.sh)에서 누가
#      re-export를 빠뜨리면 여기가 깨져서 바로 드러난다.
#
# 넷 다 "실패를 검출했을 때만" 통과다. 스크립트가 뒤집어 exit 0으로 만든다
# (계획 "Verify 명령 작성 규칙").

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

FAIL=0
CHECK="$EXP_LIB_DIR/check-macho.sh"
PATTERN_SRC="$EXP_LIB_DIR/forbidden-strings.txt"

exp_ensure_sandbox

for t in install_name_tool codesign cc; do
  command -v "$t" >/dev/null 2>&1 \
    || { echo "FAIL: $t 가 없다 — 대조군을 만들 수 없다 (Command Line Tools 필요)"; exit 1; }
done

# ---------------------------------------------------------------------------
# A. 합성 대조군
# ---------------------------------------------------------------------------
echo "== A. 합성 대조군 — 금지 문자열 9종 + otool -L + LC_RPATH"
FIX="$SANDBOX/tmp/g1-detector-fixture"
rm -rf "$FIX"
mkdir -p "$FIX"

PATTERNS=$(grep -v '^[[:space:]]*#' "$PATTERN_SRC" | grep -v '^[[:space:]]*$')
PN=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  PN=$((PN + 1))
  # 토큰이 $EXP_ROOT로 시작하면 검사기가 "번들 내부"로 분류해 위반이 아니다.
  # 어떤 패턴도 $EXP_ROOT의 접두사 전체가 되지는 않으므로 아래 형태면 안전하다.
  printf '%s/g1-detector-probe\n' "$p" > "$FIX/pattern-$PN.txt"
done <<EOT
$PATTERNS
EOT
echo "  금지 문자열 대조 파일 ${PN}개 생성"

# otool -L 위반: 의존 경로 하나를 허용 접두사 밖으로 바꾼다.
# 여기에는 일부러 **universal(fat) 바이너리**를 쓴다. file이 fat 바이너리에
# 대해 "path (for architecture arm64e)" 형태의 줄을 더 내는데, 그걸 경로로
# 오해하면 fat 바이너리가 Mach-O 검사에서 통째로 빠진다. 아래 "(for
# architecture" 단정이 그 회귀를 막는다.
cp /bin/echo "$FIX/dep-bad"
install_name_tool -change /usr/lib/libSystem.B.dylib \
  /tmp/g1-detector-probe/libSystem.B.dylib "$FIX/dep-bad" >/dev/null 2>&1 \
  || { echo "  FAIL dep-bad 대조군을 만들지 못했다"; FAIL=1; }

# LC_RPATH 위반: 번들 밖 절대 경로를 rpath로 넣는다.
# 시스템 바이너리 복사본에는 -add_rpath가 들어가지 않는다(헤더 여유 없음).
# 그래서 rpath를 가진 바이너리를 직접 만든다.
printf 'int main(void){return 0;}\n' > "$FIX/rpath-bad.c"
cc -o "$FIX/rpath-bad" "$FIX/rpath-bad.c" \
   -Wl,-rpath,/tmp/g1-detector-probe-rpath >/dev/null 2>&1 \
  || { echo "  FAIL rpath-bad 대조군을 컴파일하지 못했다"; FAIL=1; }
rm -f "$FIX/rpath-bad.c"

# STALE-PATH: 실험 디렉터리 안이지만 **검사 대상 밖**을 가리키는 경로.
# 스테이징 자리(stage/)나 원본 아카이브 자리(downloads/), 샌드박스를 그대로
# 박아 둔 형태이며, 번들을 옮기는 순간 깨진다 (스펙 P0-C3의 "이동 후에 깨지는
# 것", R-9의 콘솔 스크립트 shebang). 검사기가 이걸 "실험 디렉터리 안이니까
# 괜찮다"고 면제하면 재배치 검증이 통째로 무력화되므로 회귀를 여기서 막는다.
# 세 형태 모두 스펙 §4.1이 텍스트 검사 대상으로 든 자리 그대로다.
printf '#!%s/stage/python/bin/python3\n' "$EXP_ROOT" > "$FIX/stale-shebang"
printf 'home = %s/downloads/cpython/bin\n' "$EXP_ROOT" > "$FIX/stale-pyvenv.cfg"
printf 'prefix=%s/sandbox/stale-prefix\n' "$EXP_ROOT" > "$FIX/stale-pkgconfig.pc"

OUT_A=$(bash "$CHECK" "$FIX" 2>&1); RC_A=$?
if [ "$RC_A" -eq 0 ]; then
  echo "  FAIL check-macho.sh가 심어 둔 위반을 하나도 잡지 못했다 (exit 0)"
  FAIL=1
else
  echo "  OK   check-macho.sh가 비정상 종료했다 (exit $RC_A)"
fi
printf '%s\n' "$OUT_A" | sed 's/^/    /'

MISSING=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  if ! printf '%s\n' "$OUT_A" | grep -qF "금지 문자열: $p"; then
    MISSING="$MISSING $p"
  fi
done <<EOT
$PATTERNS
EOT
if [ -n "$MISSING" ]; then
  echo "  FAIL 검출되지 않은 금지 문자열:$MISSING"
  FAIL=1
else
  echo "  OK   금지 문자열 ${PN}종을 모두 검출했다 (스펙 §4.1 표 7행 전부)"
fi

if printf '%s\n' "$OUT_A" | grep -q '^ *OTOOL-L '; then
  echo "  OK   otool -L 의존 경로 위반을 검출했다"
else
  echo "  FAIL otool -L 의존 경로 위반을 검출하지 못했다"
  FAIL=1
fi
if printf '%s\n' "$OUT_A" | grep -q '^ *LC_RPATH '; then
  echo "  OK   LC_RPATH 위반을 검출했다"
else
  echo "  FAIL LC_RPATH 위반을 검출하지 못했다"
  FAIL=1
fi
# 재배치 잔존 경로를 면제하지 않았는가. stage/ downloads/ sandbox/ 각각을
# 따로 확인한다 — 한 종류만 잡고 나머지를 흘리는 회귀를 막기 위해서다.
for stale in stale-shebang stale-pyvenv.cfg stale-pkgconfig.pc; do
  if printf '%s\n' "$OUT_A" | grep -q "^ *STALE-PATH .*/$stale:"; then
    echo "  OK   재배치 잔존 경로를 검출했다: $stale"
  else
    echo "  FAIL $stale 의 재배치 잔존 경로를 검출하지 못했다 —"
    echo "       검사 대상 밖(stage/ downloads/ sandbox/)을 가리키는 경로가"
    echo "       면제되고 있다. 그러면 재배치 검증이 무력화된다 (스펙 P0-C3, R-9)"
    FAIL=1
  fi
done
if printf '%s\n' "$OUT_A" | grep -q "^ *INFO .*/stale-"; then
  echo "  FAIL 재배치 잔존 경로가 위반이 아니라 INFO로 집계됐다"
  FAIL=1
fi

# fat 바이너리의 아키텍처 꼬리표를 경로로 오해하지 않았는가.
if printf '%s\n' "$OUT_A" | grep -q '(for architecture'; then
  echo "  FAIL 위반 목록에 '(for architecture ...)' 유사 경로가 있다 —"
  echo "       fat 바이너리 경로 파싱이 깨졌다는 뜻이고, 그러면 fat 바이너리가"
  echo "       Mach-O 검사에서 조용히 빠진다"
  FAIL=1
else
  echo "  OK   fat 바이너리 경로를 아키텍처 꼬리표 없이 다뤘다"
fi

# ---------------------------------------------------------------------------
# B. 실물 대조군 (계획 V5가 지정한 대상)
# ---------------------------------------------------------------------------
echo
echo "== B. 실물 대조군 — check-macho.sh /opt/homebrew/bin"
HB=/opt/homebrew/bin
if [ ! -d "$HB" ]; then
  echo "  FAIL $HB 가 없다 — 대조군을 수행할 수 없다"
  FAIL=1
else
  # 609개를 끝까지 읽을 필요는 없다. 위반 몇 건만 확인되면 검출력은 증명된다.
  OUT_B=$(CHECK_MACHO_MAX_VIOLATIONS=3 bash "$CHECK" "$HB" 2>&1); RC_B=$?
  if [ "$RC_B" -eq 0 ]; then
    echo "  FAIL Homebrew 트리에서 위반을 하나도 잡지 못했다 (exit 0) — 검사기가 눈이 멀었다"
    FAIL=1
  else
    echo "  OK   비정상 종료했다 (exit $RC_B)"
    printf '%s\n' "$OUT_B" | grep -c '^    STRING\|^    OTOOL-L\|^    LC_RPATH' \
      | sed 's/^/    검출한 위반 줄 수: /'
    printf '%s\n' "$OUT_B" | grep '위반          :' | sed 's/^/    /'
  fi
fi

# grep -c는 0건일 때 "0"을 찍고 **동시에** exit 1을 낸다. `|| echo 0`을 붙이면
# 0이 두 줄 나와서 이어지는 정수 비교가 깨진다 — 하나만 낸다.
dyld_lines() {
  local n
  n=$(grep -c '^dyld' "$1" 2>/dev/null)
  case "$n" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$n" ;;
  esac
}

# ---------------------------------------------------------------------------
# C. dyld 실측 대조군
# ---------------------------------------------------------------------------
echo
echo "== C. dyld 실측 대조군 — 플랫폼 바이너리가 아닌 Mach-O"
# 시스템 바이너리를 복사하면 서명 컨텍스트를 잃어 실행이 막힌다. ad-hoc으로
# 다시 서명하면 실행되고, 플랫폼 바이너리가 아니게 되어 SIP가 DYLD_*를 지우지
# 않는다. Task 8이 쓸 codesign -s - 경로를 여기서 미리 한 번 밟는 셈이기도 하다.
DYFIX="$SANDBOX/tmp/g2-dyld-control"
rm -rf "$DYFIX"; mkdir -p "$DYFIX"
cp /bin/echo "$DYFIX/echo"
codesign -f -s - "$DYFIX/echo" >/dev/null 2>&1 \
  || { echo "  FAIL ad-hoc 서명에 실패했다"; FAIL=1; }
if bash "$EXP_LIB_DIR/run-isolated.sh" --label t1-dyld-control -- "$DYFIX/echo" g2-control >/dev/null; then
  DY="$EVIDENCE/t1-dyld-control-dyld.txt"
  if [ ! -f "$DY" ]; then
    echo "  FAIL dyld 증거 파일이 없다: $DY"
    FAIL=1
  elif head -n 1 "$DY" | grep -q '^MEASUREMENT_UNAVAILABLE$'; then
    echo "  FAIL 플랫폼 바이너리가 아닌데도 MEASUREMENT_UNAVAILABLE로 기록됐다"
    echo "       — dyld 실측이 동작하지 않는다는 뜻이다"
    FAIL=1
  else
    N=$(dyld_lines "$DY")
    if [ "$N" -ge 1 ]; then
      echo "  OK   dyld 줄 ${N}건을 실측했다"
      grep '^dyld' "$DY" | head -n 3 | sed 's/^/    /'
    else
      echo "  FAIL dyld 줄이 0건이다"
      FAIL=1
    fi
  fi
else
  echo "  FAIL 대조군 바이너리를 격리 실행하지 못했다"
  FAIL=1
fi

# ---------------------------------------------------------------------------
# D. 런처 dyld 대조군 (계획 "런처 스크립트의 dyld 실측 규칙" 5)
# ---------------------------------------------------------------------------
echo
echo "== D. 런처 dyld 대조군 — re-export 없음 / 있음"
# C절이 만든 ad-hoc 서명 Mach-O를 그대로 쓴다. 런처만 두 벌 만든다.
cat > "$DYFIX/launch-noexport.sh" <<'LAUNCHER'
#!/bin/bash
# 규칙을 어긴 런처. SIP가 /bin/bash를 exec하며 DYLD_*를 지웠으므로 자식은
# 계측 없이 뜬다. 대조군 전용이다 — 뒤 Task의 런처는 이렇게 쓰면 안 된다.
exec "$1"
LAUNCHER
cat > "$DYFIX/launch-reexport.sh" <<'LAUNCHER'
#!/bin/bash
# 규칙을 지킨 런처. 번들 Mach-O를 exec하기 직전에 다시 설정한다.
export DYLD_PRINT_LIBRARIES=1
exec "$1"
LAUNCHER
chmod +x "$DYFIX/launch-noexport.sh" "$DYFIX/launch-reexport.sh"

# D1 — re-export 없는 런처: dyld 줄 0건이어야 한다.
if bash "$EXP_LIB_DIR/run-isolated.sh" --label t1-dyld-launcher-noexport \
     -- "$DYFIX/launch-noexport.sh" "$DYFIX/echo" >/dev/null; then
  D1="$EVIDENCE/t1-dyld-launcher-noexport-dyld.txt"
  N1=$(dyld_lines "$D1")
  if [ "$N1" -eq 0 ]; then
    echo "  OK   D1: re-export 없는 런처는 dyld 0건이다 (SIP가 /bin/bash exec에서 지웠다)"
    if head -n 1 "$D1" | grep -q '^MEASUREMENT_UNAVAILABLE$'; then
      echo "  OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다 — 통과로 집계되지 않는다"
    else
      echo "  FAIL D1: dyld 0건인데 MEASUREMENT_UNAVAILABLE 표시가 없다"
      FAIL=1
    fi
  else
    echo "  FAIL D1: re-export 없는 런처인데 dyld 줄이 ${N1}건이다 —"
    echo "       이 대조군의 전제(SIP가 플랫폼 바이너리 exec에서 DYLD_*를 지운다)가"
    echo "       깨졌다. 계획 '런처 스크립트의 dyld 실측 규칙'을 다시 재야 한다"
    FAIL=1
  fi
else
  echo "  FAIL D1: 런처를 격리 실행하지 못했다"
  FAIL=1
fi

# D2 — re-export 있는 런처: dyld 줄 1건 이상이고, 그 줄이 **자식 Mach-O의**
# 것이어야 한다. 줄 수만 보면 런처 자신의 로드 목록만 남은 가짜 증거를
# 통과시킨다 (계획 규칙 2가 막는 형태).
if bash "$EXP_LIB_DIR/run-isolated.sh" --label t1-dyld-launcher-reexport \
     -- "$DYFIX/launch-reexport.sh" "$DYFIX/echo" >/dev/null; then
  D2="$EVIDENCE/t1-dyld-launcher-reexport-dyld.txt"
  N2=$(dyld_lines "$D2")
  if [ "$N2" -ge 1 ]; then
    echo "  OK   D2: re-export 있는 런처는 dyld ${N2}건을 실측했다"
  else
    echo "  FAIL D2: re-export를 했는데도 dyld 줄이 0건이다 — 실측이 끊겼다"
    FAIL=1
  fi
  if grep -q -F "$DYFIX/echo" "$D2" 2>/dev/null; then
    echo "  OK   D2: 실측된 줄이 자식 Mach-O의 것이다 (런처 자신의 목록만 남은 가짜 증거가 아니다)"
  else
    echo "  FAIL D2: dyld 줄에 자식 Mach-O($DYFIX/echo)가 없다 —"
    echo "       줄 수는 0이 아닌데 정작 검증 대상의 라이브러리가 하나도 없는"
    echo "       가짜 증거다 (계획 '런처 스크립트의 dyld 실측 규칙' 2)"
    FAIL=1
  fi
else
  echo "  FAIL D2: 런처를 격리 실행하지 못했다"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다"
else
  echo "대조군 중 하나 이상이 검출에 실패했다"
fi
exit $FAIL
