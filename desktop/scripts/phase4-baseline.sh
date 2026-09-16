#!/bin/bash
# desktop/scripts/phase4-baseline.sh
#
# Electron Phase 4의 데이터 안전 기준선 (스펙 §5). 두 부류를 **따로** 찍는다 —
# 절대 불변은 바이트 단위로, 허용 변경은 복구에 필요한 것만.
#
#   bash desktop/scripts/phase4-baseline.sh baseline   기준선 (첫 Task보다 먼저)
#   bash desktop/scripts/phase4-baseline.sh verify     지금 상태와 대조

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
OUT="${P4_BASELINE_DIR:-/tmp/p4-baseline}"
MODE="${1:?usage: phase4-baseline.sh baseline|verify}"
case "$MODE" in baseline) DEST="$OUT/now" ;; verify) DEST="$OUT/later" ;; *) echo "모드: baseline|verify" >&2; exit 2 ;; esac

mkdir -p "$DEST"
cd "$REPO"

sums() {   # 경로 하나 → 해시 목록. 없으면 빈 파일 ("없음"도 상태다).
  if [ -e "$1" ]; then
    find "$1" -type f -exec shasum -a 256 {} + 2>/dev/null | sort > "$DEST/$2"
  else
    : > "$DEST/$2"
  fi
}

# ── 절대 불변 ────────────────────────────────────────────────────────────────
sums be/worker/.env  abs-worker-env.txt
sums be/.env         abs-be-env.txt
sums fe/.env         abs-fe-env.txt
sums be/storage      abs-be-storage.txt
sums "$HOME/Library/Application Support/Damwha/storage" abs-userdata-legacy-storage.txt
# HF 캐시는 수십 GB다. 우리가 걱정하는 것은 "새 다운로드가 여기 떨어졌나"이지 비트 손상이
# 아니므로 파일 목록과 크기로 충분하다.
find "$HOME/.cache/huggingface" -type f -exec stat -f '%z %N' {} + 2>/dev/null | sort > "$DEST/abs-hf-cache.txt"
ls -la "$HOME/.local/share/uv/tools" > "$DEST/abs-uv-tools.txt" 2>/dev/null || : > "$DEST/abs-uv-tools.txt"
# Docker 볼륨은 메타데이터로 내용 보존을 증명하지 못한다 — 행 수를 직접 센다. host psql이
# 없는 맥이 많아 컨테이너 안의 것을 쓰고, 못 재면 **빈 파일이 아니라 "측정 불가"**를 적는다.
if docker exec damwha-postgres psql -U postgres -d damwha -tAc \
     "select relname||'='||n_live_tup from pg_stat_user_tables order by relname" \
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

# ── 앱 데이터: 기존 레코드 보존으로 판정 ──────────────────────────────────────
APP="$HOME/Library/Application Support/Damwha"
sums "$APP/data/storage" app-storage.txt
"$REPO/desktop/build/postgres/bin/psql" -h "$APP/run" -U damwha damwha -tAc \
  "select 'meeting='||count(*) from meeting" > "$DEST/app-db-rows.txt" 2>/dev/null \
  || echo "MEASUREMENT-UNAVAILABLE (embedded psql)" > "$DEST/app-db-rows.txt"

echo "== $MODE → $DEST"

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
