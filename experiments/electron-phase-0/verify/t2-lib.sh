# Task 2 verify 스크립트가 공유하는 헬퍼.
#
# 계획 Task 2의 Files 목록에는 없는 파일이다. verify 스크립트 8개 중 다섯이
# 같은 세 가지(서버 준비, _migrations 세기, dyld 줄 판독)를 필요로 하는데,
# 그것을 각자 복사해 두면 한 곳만 느슨해져도 다른 곳이 멀쩡해 보인다 —
# 계측기가 눈이 머는 방식 그대로다. 그래서 한 군데 모았다.
#
# 여기에는 판정이 없다. 판정은 각 t2-*.sh가 자기 조건으로 한다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)/config.sh"

PG_RUN="$EXP_ROOT/pg/run.sh"
PG_PSQL="$EXP_ROOT/pg/psql.sh"
RUN_ISO="$EXP_LIB_DIR/run-isolated.sh"
BUNDLE_PG="$EXP_ROOT/bundle/pg"
PGDATA="$SANDBOX/pgdata"
MIGRATIONS_DIR="$REPO_ROOT/be/src/database/migrations"

# --- 서버 -------------------------------------------------------------------
t2_server_alive() { exp_pid_alive pg; }
t2_server_pid()   { cat "$(exp_pid_file pg)" 2>/dev/null; }

# 서버가 떠 있지 않으면 **격리 래퍼를 통해** 띄운다. 실행 검증은 전부 그
# 통로를 지난다 (스펙 §4.2). 이미 떠 있으면 그대로 둔다 — run.sh start가
# 멱등하므로 다시 불러도 무해하지만, 불필요한 증거 파일을 만들지 않는다.
t2_require_server() {
  local label="$1"
  if t2_server_alive; then
    echo "  서버 상태: 살아 있음 (pid $(t2_server_pid))"
    return 0
  fi
  echo "  서버가 떠 있지 않다 — run-isolated.sh --label $label 로 기동한다"
  bash "$RUN_ISO" --label "$label" -- "$PG_RUN" start || return 1
  t2_server_alive || return 1
  echo "  서버 상태: 기동됨 (pid $(t2_server_pid))"
}

# --- 마이그레이션 -----------------------------------------------------------
t2_migration_file_count() {
  ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' '
}

# 55432의 _migrations 행 수. 테이블이 없으면 빈 문자열.
t2_migrations_applied() {
  bash "$PG_PSQL" -tAc \
    "SELECT count(*) FROM _migrations" 2>/dev/null | tr -d ' '
}

t2_scalar() {
  bash "$PG_PSQL" -tAc "$1" 2>/dev/null | tr -d ' '
}

# --- 서버 로그 --------------------------------------------------------------
t2_server_logs() { ls -1t "$PGDATA"/log/*.txt 2>/dev/null; }
t2_newest_server_log() { t2_server_logs | head -n 1; }

# --- dyld 증거 판독 (계획 규칙 6 / 6b) ---------------------------------------
#
# 함정이 둘이다. (1) 증거 헤더에 `# argv: <명령>`이 있어서 파일 전체를 grep하면
# dyld 줄에 없는 경로도 매치된다. (2) 줄 수만 세면 런처 자신의 로드 목록만
# 남은 가짜 증거도 통과한다. 그래서 **^dyld 줄에 한정**하고, **pid를 먼저
# 고정한 뒤 그 pid의 로드 목록에 대상 경로가 있는지**까지 본다.
#
# 순서를 뒤집어 "경로로 pid를 찾는" 방식은 쓰지 않는다 — 같은 바이너리를
# 기동 전에 한 번 더 부르면(postgres --version 류) 첫 매치가 서버 pid가 아니다.

t2_dyld_lines() {
  local n
  n=$(grep -c '^dyld' "$1" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) echo 0 ;; *) echo "$n" ;; esac
}

t2_dyld_pids() {
  awk '/^dyld\[/ { p = $1; sub(/^dyld\[/, "", p); sub(/\]:$/, "", p); print p }' "$1" 2>/dev/null \
    | sort -u | tr '\n' ' '
}

# <파일> <pid> <접두사 디렉터리> — 그 pid가 그 디렉터리 아래 이미지를 로드한 줄 수.
t2_dyld_pid_loads_under() {
  awk -v p="dyld[$2]:" -v d="$3" \
    '$1 == p && index($NF, d) == 1 { n++ } END { print n + 0 }' "$1" 2>/dev/null
}

# <파일> <pid> <절대 경로> — 그 pid가 그 이미지를 정확히 로드한 줄 수.
# postgres처럼 실행 파일 자신이 메인 이미지인 대상은 정확 일치로 본다 (규칙 6c).
t2_dyld_pid_loads_exact() {
  awk -v p="dyld[$2]:" -v b="$3" \
    '$1 == p && $NF == b { n++ } END { print n + 0 }' "$1" 2>/dev/null
}
