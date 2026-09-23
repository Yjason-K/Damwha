#!/bin/bash
# desktop/scripts/phase4-baseline.sh
#
# Electron Phase 4의 데이터 안전 기준선 (스펙 §5). 두 부류를 **따로** 찍는다 —
# 절대 불변은 바이트 단위로, 허용 변경은 복구에 필요한 것만.
#
#   bash desktop/scripts/phase4-baseline.sh baseline       기준선 (첫 Task보다 먼저)
#   bash desktop/scripts/phase4-baseline.sh verify         지금 상태와 대조
#   bash desktop/scripts/phase4-baseline.sh retake app|hf  그 한 부류만 다시 찍는다
#
# `retake`가 따로 있는 이유: 기준선의 한 부류만 다시 떠야 할 때가 있는데 `baseline`을 다시
# 부르면 **나머지 전부를 지금 값으로 덮어써** 그때까지의 변경을 통째로 잃는다. 특히
# `mut-uv.lock`은 Part 1이 `.venv`를 바꾸기 **전** 사본이라 그것이 복구 경로다.
#
#   retake app — 앱 데이터(app-*). 첫 기준선을 뜰 때는 앱 내장 클러스터가 아직 없어
#                "측정 불가"로 떨어졌다. 앱을 띄운 뒤 한 번 부른다.
#   retake hf  — `abs-hf-cache.txt`. 이 경로가 Phase 4 **밖의** 요인으로 바뀌었을 때,
#                무엇이 바뀌었는지 결과 문서에 적고 나서 새 기준선을 잡는다.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OUT="${P4_BASELINE_DIR:-/tmp/p4-baseline}"
MODE="${1:?usage: phase4-baseline.sh baseline|verify|retake <app|hf>}"
case "$MODE" in
  baseline) DEST="$OUT/now";   SCOPE=all ;;
  verify)   DEST="$OUT/later"; SCOPE=all ;;
  retake)   DEST="$OUT/now";   SCOPE="${2:?usage: phase4-baseline.sh retake <app|hf>}"
            case "$SCOPE" in app|hf) ;; *) echo "retake 대상: app|hf" >&2; exit 2 ;; esac ;;
  *) echo "모드: baseline|verify|retake <app|hf>" >&2; exit 2 ;;
esac

mkdir -p "$DEST"
cd "$REPO"

sums() {   # 경로 하나 → 해시 목록. 없으면 빈 파일 ("없음"도 상태다).
  if [ -e "$1" ]; then
    find "$1" -type f -exec shasum -a 256 {} + 2>/dev/null | sort > "$DEST/$2"
  else
    : > "$DEST/$2"
  fi
}

if [ "$SCOPE" = all ]; then
# ── 절대 불변 ────────────────────────────────────────────────────────────────
sums be/worker/.env  abs-worker-env.txt
sums be/.env         abs-be-env.txt
sums fe/.env         abs-fe-env.txt
sums be/storage      abs-be-storage.txt
sums "$HOME/Library/Application Support/Damwha/storage" abs-userdata-legacy-storage.txt
ls -la "$HOME/.local/share/uv/tools" > "$DEST/abs-uv-tools.txt" 2>/dev/null || : > "$DEST/abs-uv-tools.txt"
# Docker 볼륨은 메타데이터로 내용 보존을 증명하지 못한다 — 행 수를 직접 센다. host psql이
# 없는 맥이 많아 컨테이너 안의 것을 쓰고, 못 재면 **빈 파일이 아니라 "측정 불가"**를 적는다.
# pg_stat_user_tables.n_live_tup은 **추정치**라 ANALYZE만으로 흔들려 거짓 FAIL을 낸다.
# 정확한 count(*)를 센다 — 이 규모에서 전체가 0.1초다.
# 빈 스키마면 string_agg가 NULL이라 출력이 개행 1바이트다 — [ -s ]를 통과해 "빈 측정"으로
# 기록된다. 비슈퍼유저면 query_to_xml이 질의 전체를 실패시켜 UNAVAILABLE로 떨어진다.
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
fi

# ── 절대 불변: HF 캐시 (retake hf 로 따로 뜰 수 있다) ─────────────────────────
# 수십 GB다. 우리가 걱정하는 것은 "새 다운로드가 여기 떨어졌나"이지 비트 손상이 아니므로
# 파일 목록과 크기로 충분하다.
if [ "$SCOPE" = all ] || [ "$SCOPE" = hf ]; then
  find "$HOME/.cache/huggingface" -type f -exec stat -f '%z %N' {} + 2>/dev/null | sort > "$DEST/abs-hf-cache.txt"
fi

# ── 앱 데이터: 기존 레코드 보존으로 판정 ──────────────────────────────────────
if [ "$SCOPE" = all ] || [ "$SCOPE" = app ]; then
APP="$HOME/Library/Application Support/Damwha"
PSQL="$REPO/desktop/build/postgres/bin/psql"
sums "$APP/data/storage" app-storage.txt

# app_psql <파일명> <질의> — 못 재면 **빈 파일이 아니라 "측정 불가"**를 적는다.
# 빈 결과와 "앱이 안 떠 있어서 못 쟀다"를 구분하지 못하면 대조가 거짓 통과한다.
app_psql() {
  if "$PSQL" -h "$APP/run" -U damwha damwha -tAc "$2" > "$DEST/$1" 2>/dev/null; then
    :
  else
    echo "MEASUREMENT-UNAVAILABLE (embedded psql)" > "$DEST/$1"
  fi
}

# 스펙 §9 P4-C27은 "회의 **ID**·행 수·체크섬이 검증 뒤에도 전부 존재"를 요구한다. 행 수만
# 세면 "하나 지우고 하나 넣었다"가 통과한다 — ID 목록이 있어야 소실을 잡는다.
app_psql app-meeting-ids.txt "select id from meeting order by id"
# 행 수는 abs-docker-db-rows.txt와 같은 방식으로 **전체 테이블**을 센다. meeting 하나만
# 세면 utterance·summary가 사라져도 보이지 않는다. 빈 스키마면 string_agg가 NULL이라
# 출력이 개행 1바이트다 — 그 경우도 "빈 측정"으로 기록된다.
# 앱 클러스터는 `query_to_xml`을 쓸 수 없다 — 내장 postgres 빌드에 libxml이 없어
# "unsupported XML feature"로 질의 전체가 실패한다(2026-09-18 실측. Docker 이미지에는 있다).
# 그래서 테이블 목록을 먼저 받고 테이블마다 count(*)를 센다. 출력 형태는
# `abs-docker-db-rows.txt`와 같은 `<테이블>=<행 수>` 줄이고 테이블 이름으로 정렬한다.
# reltuples 추정치는 쓰지 않는다 — ANALYZE만으로 흔들려 거짓 FAIL을 낸다.
app_db_rows() {
  local tables out=""
  if ! tables=$("$PSQL" -h "$APP/run" -U damwha damwha -tAc \
        "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'r' and n.nspname = 'public' order by relname" 2>/dev/null); then
    echo "MEASUREMENT-UNAVAILABLE (embedded psql)" > "$DEST/app-db-rows.txt"
    return
  fi
  local t c
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    if ! c=$("$PSQL" -h "$APP/run" -U damwha damwha -tAc "select count(*) from public.\"$t\"" 2>/dev/null); then
      echo "MEASUREMENT-UNAVAILABLE (embedded psql)" > "$DEST/app-db-rows.txt"
      return
    fi
    out+="$t=$c"$'\n'
  done <<< "$tables"
  printf '%s' "$out" > "$DEST/app-db-rows.txt"
}
app_db_rows
fi

echo "== $MODE${2:+ $2} → $DEST"

if [ "$MODE" = retake ]; then
  echo
  echo "아래 것만 다시 찍었다. 나머지 기준선은 건드리지 않았다:"
  case "$SCOPE" in
    app) ls "$DEST" | grep -E '^app-' ;;
    hf)  ls "$DEST" | grep -E '^abs-hf-' ;;
  esac | sed 's/^/  /'
  exit 0
fi

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
