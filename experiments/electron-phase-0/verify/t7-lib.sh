# Task 7 verify 스크립트가 공유하는 헬퍼.
#
# t2-lib.sh / t4-lib.sh / t5-lib.sh / t6-lib.sh 와 같은 이유로 한 군데 모았다 —
# 네 스크립트가 같은 것(회의 id 읽기, mtg_2 스코프 질의, dyld 증거 판독,
# 증거 회전)을 필요로 하는데 각자 복사해 두면 한 곳만 느슨해져도 나머지가
# 멀쩡해 보인다.
#
# 여기에는 판정이 없다. 판정은 각 t7-*.sh 가 자기 조건으로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
PG_RUN="$EXP_ROOT/pg/run.sh"
PG_PSQL="$EXP_ROOT/pg/psql.sh"
BUNDLE_DIR="$EXP_ROOT/bundle"
BUNDLE_FF_DIR="$EXP_ROOT/bundle/ffmpeg"
BUNDLE_PY_DIR="$EXP_ROOT/bundle/python"

T7_MEETING_ID_FILE="$EVIDENCE/t7-meeting-id.txt"
T6_MEETING_ID_FILE="$EVIDENCE/t6-meeting-id.txt"
T7_PIPELINE_TXT="$EVIDENCE/t7-pipeline.txt"
T7_DYLD_TXT="$EVIDENCE/t7-pipeline-dyld.txt"
T7_ENV_TXT="$EVIDENCE/t7-pipeline-env.txt"
T7_STDERR_TXT="$EVIDENCE/t7-pipeline-stderr.txt"

# payload 가 고른 모델. 드라이버의 상수와 같은 값이며, 검증이 "무엇을 확인하는지"를
# 여기 한 번만 적는다 (drivers/process_meeting_driver.py 의 payload 주석이 근거).
T7_DIAR_MODEL="pyannote/speaker-diarization-community-1"
T7_EMBED_MODEL="speechbrain/spkrec-ecapa-voxceleb"
T7_EMBED_DIM=192
T7_WHISPER_REPO="models--mlx-community--whisper-large-v3-turbo"
T7_PROCESSING_VERSION=0

TAB=$'\t'

# --- 증거 회전 (스펙 §6) -----------------------------------------------------
# `> "$OUT"` 으로 덮어쓰지 않는다. 같은 이름이 있으면 옆으로 돌린다.
t7_evidence_path() {
  local name f
  name="$1"
  f="$EVIDENCE/$name"
  mkdir -p "$EVIDENCE"
  if [ -f "$f" ]; then
    mv "$f" "${f%.txt}.prev-$(date -u '+%Y%m%dT%H%M%SZ').txt"
  fi
  echo "$f"
}

# --- 작은 술어 (bash 3.2 회피) ------------------------------------------------
# macOS 의 /bin/bash 는 3.2 다. 그 버전의 `$( )` 파서는 **명령 치환 안의 `case`**
# 를 파싱하지 못하고 `syntax error near unexpected token ';;'` 를 낸다 (실측).
# 이 스크립트들은 판정 근거를 통째로 `REPORT=$( ... )` 안에서 만들므로 case 를
# 쓸 수 없다. 그래서 필요한 술어를 함수로 빼 둔다 — 함수 본문은 치환 밖이라
# case 를 써도 된다.
t7_is_uint() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# <경로> <접두사> — 경로가 그 접두사(디렉터리) 아래인가.
t7_under() {
  case "${1:-}" in
    "$2"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# <epoch 초> — UTC ISO8601 로 바꾼다.
#
# `stat -t '%Y-%m-%dT%H:%M:%SZ'` 를 쓰지 않는다. 그 형식은 **현지 시각**을
# 찍으면서 리터럴 `Z` 를 붙여 UTC 인 척하는 값을 만든다(KST 면 9시간 어긋난
# 값에 Z 가 붙는다). 이 하네스의 증거는 전부 UTC 라 섞이면 안 된다.
t7_utc_of_epoch() {
  date -u -r "$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
}

# <파일> <고정 문자열> — 그 문자열이 파일에 몇 줄에 나오는가 (대소문자 무시).
#
# **`grep -c` 의 종료 코드에 기대지 않는다.** grep 은 매치가 0건이면 `0` 을
# 출력하면서 exit 1 을 낸다. 즉 "없어야 정상"인 검사를 종료 코드로 판정하면
# 통과해야 할 때 실패한다 — 계획 V9 가 `grep -c` 직접 호출에서
# verify/t7-no-docker.sh 호출로 바뀐 이유가 이것이다. 여기서는 값만 읽고
# 종료 코드는 `|| true` 로 흘린다.
t7_count_literal() {
  local n
  n=$(grep -c -i -F -- "$2" "$1" 2>/dev/null || true)
  t7_is_uint "$n" || n=0
  echo "$n"
}

# --- 회의 id -----------------------------------------------------------------
# **모든 결과 검증은 이 id 로 스코프한다.** 같은 DB 에 Task 6 의 시드
# (mtg_1, 발화 12건)가 남아 있어서, 스코프 없이 세면 그것까지 센다
# (계획 Task 7 Interfaces).
t7_meeting_id() {
  [ -f "$T7_MEETING_ID_FILE" ] || return 1
  local id
  id=$(head -n 1 "$T7_MEETING_ID_FILE" | tr -d '[:space:]')
  case "$id" in
    mtg_[1-9]*) echo "$id" ;;
    *) return 1 ;;
  esac
}

t6_meeting_id() {
  [ -f "$T6_MEETING_ID_FILE" ] || return 1
  head -n 1 "$T6_MEETING_ID_FILE" | tr -d '[:space:]'
}

# --- DB ----------------------------------------------------------------------
# 떠 있지 않으면 **격리 래퍼를 통해** 띄운다 (스펙 §4.2). Verify 표에 기동 행이
# 따로 없고 V2 가 이미 띄웠을 것이므로 보통은 아무 일도 하지 않는다.
t7_require_db() {
  if exp_pid_alive pg; then
    echo "  db: 살아 있음 (pid $(cat "$(exp_pid_file pg)"))"
    return 0
  fi
  echo "  db 가 떠 있지 않다 — run-isolated.sh --label t7-pg-restart 로 기동한다"
  bash "$RUN_ISO" --label t7-pg-restart -- "$PG_RUN" start || return 1
  exp_pid_alive pg || return 1
  echo "  db: 기동됨 (pid $(cat "$(exp_pid_file pg)"))"
}

# -A(정렬 없음)라 패딩이 없다. t6_scalar 와 같은 이유로 `tr -d ' '` 를 붙이지
# 않는다 — 값 안의 공백까지 지워져 증거가 사실과 달라진다.
t7_scalar() {
  bash "$PG_PSQL" -q -t -A -c "$1" 2>/dev/null | head -n 1
}

t7_tsv() {
  bash "$PG_PSQL" -q -t -A -F "$TAB" -c "$1" 2>&1
}

# --- 파이프라인 단계 로그 -----------------------------------------------------
# `pipeline/timing.py::timed_stage` 가 단계마다 남기는 완료 줄이다.
#   "job=<id> meeting=<id> stage=<name> done elapsed_ms=<n> <detail>"
# DB 결과가 못 보여 주는 단계(특히 VAD — 산출물이 DB 행이 아니라 STT 입력
# 구간이다)는 이 줄이 유일한 직접 증거다.
t7_stage_line() {
  local mid stage
  mid="$1"; stage="$2"
  [ -f "$T7_STDERR_TXT" ] || return 1
  grep -a "meeting=$mid stage=$stage done " "$T7_STDERR_TXT" 2>/dev/null | tail -n 1
}

# --- dyld 증거 판독 (계획 규칙 6 / 6b / 6c) ---------------------------------
# 파일 전체를 grep 하지 않는다. 증거 헤더의 `# argv:` 줄에 번들 경로가 그대로
# 들어 있어서, dyld 줄에 0건이어도 항상 매치된다 (Task 1 이 이 함정에 빠졌다).
#
# **증거의 dyld 줄은 두 모양이다** (t5-lib.sh 가 실측으로 확인했다).
#   dyld[<pid>]: <UUID> /절대/경로          — 이미지를 실제로 연 줄 (필드 3개)
#   dyld[<pid>]: move loaded to delayed: <이름>
#                                           — 지연 초기화 기록 (필드 6개).
#                                             로드가 아니고 경로도 없다.
# $NF 로 세면 두 번째 모양이 전부 거짓 위반으로 잡힌다. 그래서 판정은
# **이미지 로드 줄로 한정**한다: 필드 3개, 둘째가 <UUID>, 셋째가 절대 경로.
t7_awk_load_line='$1 == p && NF == 3 && $2 ~ /^</ && substr($3, 1, 1) == "/"'

t7_dyld_lines() {
  local n
  n=$(grep -c '^dyld' "$1" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) echo 0 ;; *) echo "$n" ;; esac
}

t7_dyld_pids() {
  awk '/^dyld\[/ { p = $1; sub(/^dyld\[/, "", p); sub(/\]:$/, "", p); print p }' "$1" 2>/dev/null \
    | sort -un
}

# <파일> <pid> — 그 pid 가 처음 연 이미지(= 메인 이미지).
t7_dyld_main_image() {
  awk -v p="dyld[$2]:" "$t7_awk_load_line"' { print $3; exit }' "$1" 2>/dev/null
}

# <파일> <pid> <접두사 디렉터리> — 그 pid 가 그 디렉터리 아래 이미지를 연 줄 수.
t7_dyld_pid_loads_under() {
  awk -v p="dyld[$2]:" -v d="$3" \
    "$t7_awk_load_line"' && index($3, d) == 1 { n++ } END { print n + 0 }' "$1" 2>/dev/null
}

# 그 pid 가 번들·/usr/lib·/System/Library 밖에서 연 이미지 목록 (스펙 §4.1).
t7_dyld_pid_foreign() {
  awk -v p="dyld[$2]:" -v d="$3" "$t7_awk_load_line"' {
      img = $3
      if (index(img, d) == 1) next
      if (index(img, "/usr/lib/") == 1) next
      if (index(img, "/System/Library/") == 1) next
      print img
    }' "$1" 2>/dev/null | sort -u
}

# 이미지 로드 줄 전체 (pid 무관). 금지 문자열 검사가 이것만 본다.
t7_dyld_all_images() {
  awk '$1 ~ /^dyld\[/ && NF == 3 && $2 ~ /^</ && substr($3, 1, 1) == "/" { print $3 }' \
    "$1" 2>/dev/null
}
