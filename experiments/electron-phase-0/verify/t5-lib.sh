# Task 5 verify 스크립트가 공유하는 헬퍼.
#
# t2-lib.sh / t3-lib.sh / t4-lib.sh와 같은 이유로 한 군데 모았다 — 여덟
# 스크립트가 같은 것(서비스 기동 보장, HTTP 호출, dyld 증거 판독)을 필요로
# 하는데 각자 복사해 두면 한 곳만 느슨해져도 나머지가 멀쩡해 보인다.
#
# 여기에는 판정이 없다. 판정은 각 t5-*.sh가 자기 조건으로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
BUNDLE_PY_DIR="$EXP_ROOT/bundle/python"
EMBED_SH="$EXP_ROOT/services/embed.sh"
LLM_SH="$EXP_ROOT/services/llm.sh"
EMBED_BASE="http://127.0.0.1:$EXP_EMBED_PORT"
LLM_BASE="http://127.0.0.1:$EXP_LLM_PORT/v1"
LLM_MODEL="mlx-community/Qwen3.5-4B-8bit"
EMBED_MODEL="BAAI/bge-m3"

# 검사 도구다 — 피검사 대상이 아니므로 격리 규칙의 예외다 (스펙 §4.0).
CURL=/usr/bin/curl
SYSPY=/usr/bin/python3

t5_require_bundle() {
  [ -x "$BUNDLE_PY_DIR/bin/damwha-embed" ] && [ -x "$BUNDLE_PY_DIR/bin/mlx_lm.server" ] || {
    echo "FAIL: 번들 콘솔 스크립트가 없다: $BUNDLE_PY_DIR/bin"
    echo "      experiments/electron-phase-0/python/build.sh all 을 먼저 돌려라"
    return 1
  }
  return 0
}

# --- 서비스 수명 ------------------------------------------------------------
# 떠 있지 않으면 **격리 래퍼를 통해** 띄운다. 실행 검증은 전부 그 통로를
# 지난다 (스펙 §4.2). 이미 떠 있으면 그대로 둔다 — start가 멱등하지만
# 불필요한 증거 회전을 만들지 않는다.
t5_require_embed() {
  if exp_pid_alive embed; then
    echo "  embed: 살아 있음 (pid $(cat "$(exp_pid_file embed)"))"
    return 0
  fi
  echo "  embed가 떠 있지 않다 — run-isolated.sh --label t5-embed 로 기동한다"
  bash "$RUN_ISO" --label t5-embed -- "$EMBED_SH" start || return 1
  exp_pid_alive embed || return 1
  echo "  embed: 기동됨 (pid $(cat "$(exp_pid_file embed)"))"
}

t5_require_llm() {
  if exp_pid_alive llm; then
    echo "  llm: 살아 있음 (pid $(cat "$(exp_pid_file llm)"))"
    return 0
  fi
  echo "  llm이 떠 있지 않다 — run-isolated.sh --label t5-llm 로 기동한다"
  bash "$RUN_ISO" --label t5-llm -- "$LLM_SH" start || return 1
  exp_pid_alive llm || return 1
  echo "  llm: 기동됨 (pid $(cat "$(exp_pid_file llm)"))"
}

# 측정 대상 PID. 살아 있는 동안은 PID 파일이 유일한 출처다(계획 규칙 4).
# stop 뒤에는 PID 파일이 지워지므로, 런처가 **PID 파일과 같은 순간에 같은
# $! 로** 남긴 기동 기록에서 읽는다. 계획 Verify 표의 순서상 V11(dyld 판정)이
# V5·V9(stop) 뒤에 오기 때문에 이 폴백이 없으면 판정 자체가 불가능해진다.
# 두 값이 갈릴 수 없게 런처가 한 번에 쓴다 (services/*.sh cmd_start).
t5_measured_pid() {
  local name f pid
  name="$1"
  f=$(exp_pid_file "$name")
  if [ -f "$f" ]; then
    pid=$(cat "$f" 2>/dev/null)
    case "$pid" in
      ''|*[!0-9]*) ;;
      *) echo "$pid"; return 0 ;;
    esac
  fi
  f="$SANDBOX/run/$name-start.txt"
  [ -f "$f" ] || return 1
  pid=$(sed -n 's/^pid  *: *//p' "$f" | head -n 1)
  case "$pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  echo "$pid"
}

t5_measured_pid_source() {
  local name
  name="$1"
  if [ -f "$(exp_pid_file "$name")" ]; then
    echo "$(exp_pid_file "$name") (살아 있는 PID 파일)"
  else
    echo "$SANDBOX/run/$name-start.txt (stop 뒤 — 런처가 PID 파일과 같이 남긴 기동 기록)"
  fi
}

# 포트가 정말 죽었는가. LISTEN 소켓과 HTTP 응답을 둘 다 본다.
t5_port_dead() {
  local port
  port="$1"
  if exp_port_pid "$port" >/dev/null; then
    return 1
  fi
  if "$CURL" -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# --- dyld 증거 판독 (계획 규칙 6 / 6b / 6c) ---------------------------------
# 파일 전체를 grep하지 않는다. 증거 헤더의 `# argv:` 줄에 번들 경로가 그대로
# 들어 있어서, dyld 줄에 0건이어도 항상 매치된다 (Task 1이 이 함정에 빠졌다).

t5_dyld_lines() {
  local n
  n=$(grep -c '^dyld' "$1" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) echo 0 ;; *) echo "$n" ;; esac
}

t5_dyld_pids() {
  awk '/^dyld\[/ { p = $1; sub(/^dyld\[/, "", p); sub(/\]:$/, "", p); print p }' "$1" 2>/dev/null \
    | sort -u | tr '\n' ' '
}

# **증거의 dyld 줄은 두 모양이다.** 실측하며 확인했다.
#
#   dyld[<pid>]: <UUID> /절대/경로        — 이미지를 실제로 연 줄 (필드 3개)
#   dyld[<pid>]: move loaded to delayed: <이름>
#                                         — dyld의 지연 초기화 기록 (필드 6개).
#                                           **로드가 아니고 경로도 없다.** 잎
#                                           이름만 찍힌다(AVFoundation, libtidy.A.dylib).
#
# 그래서 $NF만 보고 "번들 밖 경로"를 세면 두 번째 모양이 전부 위반으로 잡힌다.
# 실제로 그렇게 만들어 봤고 t5-embed·t5-llm에서 각각 160여 건이 나왔다 —
# 전부 존재하지 않는 위반이다. Task 2의 postgres는 이 줄을 하나도 내지 않아
# (t2-start-dyld.txt 0건) 거기서는 드러나지 않았고, Task 3·4는 "아래에서 연
# 이미지 수"만 세어(접두사가 `/`로 시작해야 매치된다) 영향이 없었다.
#
# 그러니 판정은 **이미지 로드 줄로 한정**한다: 필드 3개, 둘째가 <UUID>,
# 셋째가 절대 경로.
t5_awk_load_line='$1 == p && NF == 3 && $2 ~ /^</ && substr($3, 1, 1) == "/"'

# <파일> <pid> <접두사 디렉터리> — 그 pid가 그 디렉터리 아래 이미지를 연 줄 수.
t5_dyld_pid_loads_under() {
  awk -v p="dyld[$2]:" -v d="$3" \
    "$t5_awk_load_line"' && index($3, d) == 1 { n++ } END { print n + 0 }' "$1" 2>/dev/null
}

# 그 pid가 번들·/usr/lib·/System/Library 밖에서 연 이미지 목록 (스펙 §4.1).
t5_dyld_pid_foreign() {
  awk -v p="dyld[$2]:" -v d="$3" "$t5_awk_load_line"' {
      img = $3
      if (index(img, d) == 1) next
      if (index(img, "/usr/lib/") == 1) next
      if (index(img, "/System/Library/") == 1) next
      print img
    }' "$1" 2>/dev/null | sort -u
}

# dyld 증거가 **그 서비스 프로세스를 잰 것인지** 본다 (계획 규칙 6b).
#   <증거 파일> <PID 이름(embed|llm)> <표시용 라벨>
# 순서를 뒤집어 "경로로 pid를 찾는" 방식은 쓰지 않는다 — 런처가 기동 전에
# 같은 번들 python을 한 번 더 부르므로(llm.sh의 모델 다운로드) 첫 매치가
# 서버 pid가 아니다. Task 2에서 pg_isready가 정확히 그 형태였다.
#
# 일치는 **접두사**로 본다 (규칙 6c). damwha-embed와 mlx_lm.server는 셔뱅
# 스크립트라 dyld의 메인 이미지가 셔뱅의 인터프리터
# (bundle/python/bin/python3.12)이고, 스크립트 경로 정확 일치는 언제나 0건이다.
t5_assert_dyld_measured() {
  local file name label n pid under foreign rc
  file="$1"; name="$2"; label="$3"
  rc=0
  echo "== $label — dyld 실측 판독 (계획 규칙 6 / 6b / 6c)"
  echo "  증거 파일 : $file"
  if [ ! -f "$file" ]; then
    echo "  FAIL 증거 파일이 없다 — 먼저 run-isolated.sh --label $label 로 기동한다"
    return 1
  fi
  if head -n 1 "$file" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
    echo "  FAIL 첫 줄이 MEASUREMENT_UNAVAILABLE이다 — 실측이 끊겼다."
    echo "       런처가 exec 직전에 export DYLD_PRINT_LIBRARIES=1 을 하지 않았거나"
    echo "       자식 stderr를 리다이렉트했다 (계획 규칙 1·2)."
    return 1
  fi
  echo "  OK   MEASUREMENT_UNAVAILABLE 표시가 없다"

  n=$(t5_dyld_lines "$file")
  if [ "$n" -ge 1 ]; then
    echo "  OK   ^dyld 줄 ${n}건 (헤더가 아니라 dyld 줄만 셌다)"
  else
    echo "  FAIL ^dyld 줄이 0건이다"
    return 1
  fi

  pid=$(t5_measured_pid "$name") || {
    echo "  FAIL 측정 대상 PID를 찾지 못했다 ($(exp_pid_file "$name") 도 기동 기록도 없다)"
    return 1
  }
  echo "  대상 pid  : $pid  (출처: $(t5_measured_pid_source "$name"))"
  echo "  증거의 pid: $(t5_dyld_pids "$file")"

  under=$(t5_dyld_pid_loads_under "$file" "$pid" "$BUNDLE_PY_DIR/")
  if [ "$under" -ge 1 ]; then
    echo "  OK   pid $pid 이 $BUNDLE_PY_DIR/ 아래 이미지를 ${under}건 로드했다"
    awk -v p="dyld[$pid]:" -v d="$BUNDLE_PY_DIR/" \
      "$t5_awk_load_line"' && index($3, d) == 1 { print "       " $3; if (++c >= 3) exit }' "$file"
  else
    echo "  FAIL pid $pid 이 번들 아래 이미지를 로드한 dyld 줄이 없다."
    echo "       (a) PID 파일에 서버가 아니라 래퍼 bash의 PID가 들어갔거나"
    echo "       (b) 실측이 런처 자신의 것만 담은 가짜 증거이거나 (Task 1 D3의 형태)"
    echo "       (c) 증거가 그 회차의 것이 아니다"
    rc=1
  fi

  foreign=$(t5_dyld_pid_foreign "$file" "$pid" "$BUNDLE_PY_DIR/")
  if [ -n "$foreign" ]; then
    echo "  FAIL 서버가 번들·/usr/lib·/System/Library 밖에서 라이브러리를 로드했다:"
    printf '%s\n' "$foreign" | sed 's/^/       /'
    rc=1
  else
    echo "  OK   pid $pid 이 연 이미지가 전부 번들 / usr/lib / System/Library 안이다"
  fi
  return $rc
}

# 증거 파일을 덮어쓰지 않는다 (스펙 §6). 같은 이름이 있으면 옆으로 돌린다.
t5_evidence_path() {
  local name f
  name="$1"
  f="$EVIDENCE/$name"
  mkdir -p "$EVIDENCE"
  if [ -f "$f" ]; then
    mv "$f" "${f%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  fi
  echo "$f"
}
