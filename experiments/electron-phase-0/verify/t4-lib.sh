# Task 4 verify 스크립트가 공유하는 헬퍼.
#
# t2-lib.sh / t3-lib.sh와 같은 이유로 한 군데 모았다 — 네 스크립트가 같은
# 것(번들 ffmpeg/ffprobe를 격리로 부르기, dyld 증거 판독)을 필요로 하는데
# 각자 복사해 두면 한 곳만 느슨해져도 나머지가 멀쩡해 보인다.
#
# 여기에는 판정이 없다. 판정은 각 t4-*.sh가 자기 조건으로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
BUNDLE_FF_DIR="$EXP_ROOT/bundle/ffmpeg"
BUNDLE_FFMPEG="$BUNDLE_FF_DIR/bin/ffmpeg"
BUNDLE_FFPROBE="$BUNDLE_FF_DIR/bin/ffprobe"
SAMPLE_AUDIO="$SANDBOX/audio/sample.flac"

t4_require_bundle() {
  [ -x "$BUNDLE_FFMPEG" ] && [ -x "$BUNDLE_FFPROBE" ] || {
    echo "FAIL: 번들 ffmpeg/ffprobe가 없다: $BUNDLE_FF_DIR"
    echo "      experiments/electron-phase-0/ffmpeg/fetch.sh 를 먼저 돌려라"
    return 1
  }
  return 0
}

t4_require_sample() {
  [ -f "$SAMPLE_AUDIO" ] || {
    echo "FAIL: 검증 오디오가 없다: $SAMPLE_AUDIO"
    echo "      experiments/electron-phase-0/lib/sandbox.sh copy-audio <meeting_id> 를 먼저 돌려라"
    return 1
  }
  return 0
}

# 번들 ffmpeg/ffprobe를 **격리 래퍼를 통해** 부른다. 실행 검증은 전부 이
# 통로를 지난다 (스펙 §4.2). 둘 다 완전 정적 링크된 Mach-O이고 env -i가
# 직접 exec하므로 셸 런처를 거치지 않는다 — 계획 규칙 1의 re-export가 필요
# 없는 형태이고, 그래서 dyld 실측이 그대로 살아 있다 (t3_run과 같은 이유).
t4_run_ffmpeg() {
  local label="$1"; shift
  bash "$RUN_ISO" --label "$label" -- "$BUNDLE_FFMPEG" "$@"
}

t4_run_ffprobe() {
  local label="$1"; shift
  bash "$RUN_ISO" --label "$label" -- "$BUNDLE_FFPROBE" "$@"
}

# --- dyld 증거 판독 (계획 규칙 6 / 6b) --------------------------------------
# 파일 전체를 grep하지 않는다. 증거 헤더의 `# argv:` 줄에 번들 경로가 그대로
# 들어 있어서, dyld 줄에 0건이어도 항상 매치된다.

t4_dyld_lines() {
  local n
  n=$(grep -c '^dyld' "$1" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) echo 0 ;; *) echo "$n" ;; esac
}

t4_dyld_pids() {
  awk '/^dyld\[/ { p = $1; sub(/^dyld\[/, "", p); sub(/\]:$/, "", p); print p }' "$1" 2>/dev/null \
    | sort -u
}

# <파일> <pid> <접두사 디렉터리> — 그 pid가 그 디렉터리 아래 이미지를 연 줄 수.
t4_dyld_pid_loads_under() {
  awk -v p="dyld[$2]:" -v d="$3" \
    '$1 == p && index($NF, d) == 1 { n++ } END { print n + 0 }' "$1" 2>/dev/null
}

# dyld 증거가 **진짜 번들 바이너리를 잰 것인지** 본다. 줄 수만 세지 않고
# pid를 고정한 뒤 그 pid의 로드 목록에 번들 경로가 있는지까지 확인한다.
# 성공하면 0, 아니면 1이고 근거를 출력한다.
t4_assert_dyld_measured() {
  local file="$1" n pid hits total=0
  if [ ! -f "$file" ]; then
    echo "  FAIL dyld 증거가 없다: $file"
    return 1
  fi
  if head -n 1 "$file" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
    echo "  FAIL dyld 증거가 MEASUREMENT_UNAVAILABLE이다 — 통과로 집계하지 않는다"
    return 1
  fi
  n=$(t4_dyld_lines "$file")
  if [ "$n" -eq 0 ]; then
    echo "  FAIL dyld 줄이 0건이다"
    return 1
  fi
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    hits=$(t4_dyld_pid_loads_under "$file" "$pid" "$BUNDLE_FF_DIR/")
    [ "$hits" -gt 0 ] && total=$((total + hits))
  done <<EOT
$(t4_dyld_pids "$file")
EOT
  if [ "$total" -gt 0 ]; then
    echo "  OK   dyld 줄 ${n}건 중 ${total}건이 $BUNDLE_FF_DIR/ 아래 이미지다"
    return 0
  fi
  echo "  FAIL dyld 줄은 ${n}건인데 번들 아래 이미지를 연 pid가 없다 — 가짜 증거다"
  return 1
}

# 증거 파일을 덮어쓰지 않는다 (스펙 §6). 같은 이름이 있으면 옆으로 돌린다.
t4_evidence_path() {
  local name f
  name="$1"
  f="$EVIDENCE/$name"
  mkdir -p "$EVIDENCE"
  if [ -f "$f" ]; then
    mv "$f" "${f%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  fi
  echo "$f"
}
