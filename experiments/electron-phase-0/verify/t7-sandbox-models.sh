#!/bin/bash
# 계획 Task 7 V5 — 샌드박스 HF 캐시에 pyannote 저장소가 존재하는가.
# 게이트 모델을 **새로 받았다** (스펙 P0-C4, §4.2 HOME 격리, R-6).
#
# "존재한다"만으로는 부족하다. 확인해야 하는 것은 셋이다.
#
#   (1) 그 저장소가 **샌드박스 HOME 아래**에 있다. 개발자 캐시
#       ($HOME/.cache/huggingface, 40 GB, pyannote 3종이 이미 있음)를 재사용했다면
#       P0-C4 의 "새로 내려받아 사용했다"가 성립하지 않는다.
#   (2) blobs/ 에 **실체 파일**이 있다. 심볼릭 링크로 개발자 캐시를 가리키고
#       있으면 (1)을 통과해도 실제로는 남의 것을 읽은 것이다. 하드링크도 같이
#       본다 — 경로로는 보이지 않지만 `nlink>1` 이면 다른 캐시와 실체를
#       공유한다는 뜻이다. 생성 시각도 남긴다.
#   (3) **새로 받은 회차가 기록돼 있다.** 드라이버가 실행 전후로 hub/ 를 재서
#       `NEW <저장소>` 로 남긴다.
#
# ## (3)을 "현재 회차"로 판정하지 않는 이유 — 2026-09-10 리뷰 지적으로 고침
#
# 처음 구현은 **현재** `t7-pipeline.txt` 의 NEW 표시만 봤다. 그러면 캐시가
# 남아 있는 한 재실행은 영원히 NEW 0건이 되어 exit 1 이다. 실제로 verifier
# 재실행이 그 이유로 실패했다.
#
# 스펙 §4.4 가 정한 것은 그 반대다 — "재실행은 멱등해야 한다", "모델
# 다운로드는 재실행 시 샌드박스 캐시를 지우지 않고 이어받는다. 단 처음부터
# 받은 측정은 **빈 캐시에서 한 번만** 수행하고 **그 회차를 증거에 명시**한다."
# 계획 V5 의 기대 문구도 "샌드박스 HF 캐시에 pyannote 저장소가 **존재**"다.
# 즉 판정 대상은 "매 회차 새로 받았는가"가 아니라 "새로 받힌 실체이며 그
# 회차가 어디에 기록돼 있는가"다.
#
# 그래서 이 스크립트는 두 축으로 본다.
#   - 재실행에도 변하지 않는 **파일시스템 사실** (2) — 멱등을 준다.
#   - 회전된 `t7-pipeline.prev-*.txt` 까지 뒤진 **회차 기록** (3) — 회차를
#     특정한다. 회전 규칙(스펙 §6)상 첫 회차의 파일은 지워지지 않고 옆으로
#     남으므로, 그 파일이 그대로 근거가 된다.
#
# 개발자 캐시는 **읽지도 않는다.** 존재 여부를 확인하려 들면 그 자체가
# 스펙 §4.4 의 "~/.cache/huggingface 에 대한 쓰기 금지"와 무관하게 검사
# 스크립트가 개발자 홈을 뒤지는 형태가 된다. 판정은 샌드박스 쪽 사실과
# run-isolated.sh 가 기록한 HF_HOME 값만으로 한다. `nlink=1` 이 "개발자 캐시와
# 실체를 공유하지 않는다"를 그쪽을 건드리지 않고 말해 준다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t7-lib.sh"

FAIL=0
OUT=$(t7_evidence_path "t7-sandbox-models.txt")

HUB="$ISO_HF_HOME/hub"

REPORT=$(
  echo "== HF_HOME (스펙 §4.2 주입 화이트리스트)"
  echo "  config.sh 의 값     : $ISO_HF_HOME"
  if [ -f "$T7_ENV_TXT" ]; then
    RECORDED=$(sed -n 's/^HF_HOME=//p' "$T7_ENV_TXT" | head -n 1)
    echo "  t7-pipeline-env.txt : ${RECORDED:-없음}"
    if [ "$RECORDED" = "$ISO_HF_HOME" ]; then
      echo "  OK   그 실행이 실제로 이 HF_HOME 으로 돌았다"
      echo "RC_ENV=0"
    else
      echo "  FAIL 기록된 HF_HOME 이 샌드박스 값과 다르다"
      echo "RC_ENV=1"
    fi
  else
    echo "  FAIL $T7_ENV_TXT 가 없다 — V2 를 먼저 돌린다"
    echo "RC_ENV=1"
  fi
  if t7_under "$ISO_HF_HOME" "$SANDBOX"; then
    echo "  OK   HF_HOME 이 샌드박스 아래다"
    echo "RC_SANDBOX=0"
  else
    echo "  FAIL HF_HOME 이 샌드박스 밖이다"
    echo "RC_SANDBOX=1"
  fi

  echo
  echo "== 샌드박스 캐시의 저장소 (hub/)"
  if [ ! -d "$HUB" ]; then
    echo "  FAIL $HUB 가 없다"
    echo "RC_PYANNOTE=1"
    echo "RC_BLOBS=1"
    echo "RC_NEW=1"
  else
    for d in "$HUB"/models--*; do
      [ -e "$d" ] || continue
      n=$(find "$d" -type f ! -type l 2>/dev/null | wc -l | tr -d ' ')
      b=$(find "$d" -type f ! -type l -exec stat -f '%z' {} + 2>/dev/null | awk '{s+=$1} END {print s+0}')
      echo "  $(basename "$d")  실체파일 ${n}개  ${b} bytes"
    done

    echo
    echo "== pyannote 게이트 저장소"
    PYA=$(find "$HUB" -maxdepth 1 -type d -name 'models--pyannote--*' 2>/dev/null | sort)
    if [ -z "$PYA" ]; then
      echo "  FAIL 샌드박스 캐시에 pyannote 저장소가 없다"
      echo "RC_PYANNOTE=1"
      echo "RC_BLOBS=1"
    else
      RC=0
      RCB=0
      # `for` 로 순회한다. $EXP 이하 경로에는 공백이 없다 (계획 규칙 6d) —
      # heredoc 을 명령 치환 안에서 쓰면 bash 3.2 에서 깨진다.
      for d in $PYA; do
        [ -n "$d" ] || continue
        echo "  저장소: $(basename "$d")"
        echo "    경로: $d"
        # (2) blobs/ 의 실체 파일. 심볼릭 링크는 세지 않는다.
        nb=$(find "$d/blobs" -type f ! -type l 2>/dev/null | wc -l | tr -d ' ')
        bb=$(find "$d/blobs" -type f ! -type l -exec stat -f '%z' {} + 2>/dev/null \
             | awk '{s+=$1} END {print s+0}')
        nsym=$(find "$d/blobs" -type l 2>/dev/null | wc -l | tr -d ' ')
        echo "    blobs 실체 파일: ${nb}개  ${bb} bytes  (심볼릭 링크 ${nsym}개)"
        if [ "$nb" -lt 1 ] || [ "$bb" -lt 1000000 ]; then
          echo "    FAIL blobs 에 실체 가중치가 없다 — 남의 캐시를 참조했을 수 있다"
          RCB=1
        else
          echo "    OK   가중치가 샌드박스 안에 실체로 있다"
        fi
        # (2b) 하드링크 수. 다른 캐시(개발자 홈)에서 하드링크로 끌어온 것이면
        # nlink 가 2 이상이다. 전부 1 이면 이 캐시에만 존재하는 실체다.
        # 심볼릭 링크와 달리 경로로는 보이지 않으므로 따로 센다.
        nbad=$(find "$d/blobs" -type f ! -type l -exec stat -f '%l' {} + 2>/dev/null \
               | awk '$1 != 1 { n++ } END { print n + 0 }')
        echo "    하드링크 수가 1이 아닌 blob: ${nbad}개"
        if [ "$nbad" -eq 0 ]; then
          echo "    OK   전부 nlink=1 — 다른 캐시에서 하드링크로 끌어온 것이 아니다"
        else
          echo "    FAIL nlink>1 인 blob 이 있다 — 다른 캐시와 실체를 공유한다"
          RCB=1
        fi
        # (2c) 생성 시각. 이 캐시 안에서 언제 만들어졌는지다. 회차를 특정하는
        # 것은 아래 "어느 회차가 받았는가" 절이고, 여기서는 사실만 남긴다.
        bmin=$(find "$d/blobs" -type f ! -type l -exec stat -f '%B' {} + 2>/dev/null \
               | sort -n | head -n 1)
        bmax=$(find "$d/blobs" -type f ! -type l -exec stat -f '%B' {} + 2>/dev/null \
               | sort -n | tail -n 1)
        if t7_is_uint "${bmin:-}" && t7_is_uint "${bmax:-}"; then
          echo "    blob 생성 시각(UTC): $(t7_utc_of_epoch "$bmin") ~ $(t7_utc_of_epoch "$bmax")"
        else
          echo "    FAIL blob 생성 시각을 읽지 못했다"
          RCB=1
        fi
        # 이 저장소가 정말 게이트 파이프라인인지 — refs/main 과 snapshots 확인
        if [ -f "$d/refs/main" ]; then
          echo "    refs/main: $(cat "$d/refs/main")"
        else
          echo "    FAIL refs/main 이 없다"
          RCB=1
        fi
      done
      echo "RC_PYANNOTE=$RC"
      echo "RC_BLOBS=$RCB"
    fi

    echo
    echo "== 어느 회차가 받았는가 (스펙 §4.4 \"그 회차를 증거에 명시\")"
    echo "   **현재 회차의 NEW 표시로 판정하지 않는다.** 드라이버는 실행 전후의"
    echo "   hub/ 차집합으로 NEW 를 찍는데, 스펙 §4.4 는 재실행 시 샌드박스"
    echo "   캐시를 지우지 않고 이어받으라고 정한다. 그래서 두 번째 실행부터는"
    echo "   NEW 가 반드시 0건이고, 그것으로 판정하면 검사가 영영 실패한다."
    echo "   스펙이 요구하는 것은 \"빈 캐시에서 한 번만 재고 그 회차를 증거에"
    echo "   명시\"이므로, **회전된 회차 파일까지 전부** 뒤져 그 회차를 찾는다."
    NEW_HITS=0
    NEW_FILES=""
    for f in "$T7_PIPELINE_TXT" "$EVIDENCE"/t7-pipeline.prev-*.txt; do
      [ -f "$f" ] || continue
      hits=$(t7_count_literal "$f" 'NEW models--pyannote--')
      stamp=$(sed -n 's/^# utc: *//p' "$f" | head -n 1)
      if [ "$hits" = "0" ]; then
        echo "  --   $(basename "$f")  (utc ${stamp:-?})  pyannote NEW 0건 — 캐시를 이어받은 회차"
      else
        echo "  NEW  $(basename "$f")  (utc ${stamp:-?})"
        grep '^NEW models--' "$f" | sed 's/^/         /'
        NEW_HITS=$((NEW_HITS + 1))
        NEW_FILES="$NEW_FILES $(basename "$f")"
      fi
    done
    if [ "$NEW_HITS" -ge 1 ]; then
      echo "  OK   pyannote 게이트 저장소를 새로 받은 회차가 ${NEW_HITS}개 기록돼 있다:${NEW_FILES}"
      echo "RC_NEW=0"
      # 판정 문장에 회차 파일명을 싣기 위해 밖으로 내보낸다. `RC_` 로 시작해야
      # 보고 본문에서 걸러진다 (아래 grep -v '^RC_').
      echo "RC_NEW_FILES=$NEW_FILES"
    else
      echo "  FAIL 어느 회차 기록에도 'NEW models--pyannote--' 가 없다."
      echo "       V2 를 한 번도 빈 캐시에서 돌리지 않았거나, 그 회차의"
      echo "       t7-pipeline*.txt 가 지워졌다는 뜻이다."
      echo "RC_NEW=1"
    fi

    echo
    echo "== 참고 — 이 실행이 쓴 다른 모델 (게이트 아님)"
    echo "  $T7_EMBED_MODEL  (화자 임베딩)"
    echo "  $T7_WHISPER_REPO  (STT)"
    echo "  silero-vad 는 pip 패키지가 가중치를 동봉해 다운로드가 없다:"
    echo "    $BUNDLE_PY_DIR/lib/python3.12/site-packages/silero_vad/data/silero_vad.jit"
  fi
)

printf '%s\n' "$REPORT" | grep -v '^RC_'

for k in RC_ENV RC_SANDBOX RC_PYANNOTE RC_BLOBS RC_NEW; do
  v=$(printf '%s\n' "$REPORT" | sed -n "s/^$k=//p" | tail -n 1)
  [ "$v" = "0" ] || FAIL=1
done
NEW_FILES_OUT=$(printf '%s\n' "$REPORT" | sed -n 's/^RC_NEW_FILES=//p' | tail -n 1)

{
  echo "# Task 7 V5 — 게이트 모델이 샌드박스 HOME 에 새로 받힌 실체인가 (P0-C4, R-6)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 개발자 캐시(~/.cache/huggingface)는 읽지도 쓰지도 않는다 (스펙 §4.4)."
  echo "# HF_TOKEN 은 set/unset 만 기록한다 (스펙 §4.2) — 이 파일에 값이 없다."
  echo "# 판정은 재실행에도 변하지 않는 파일시스템 사실(실체·nlink=1·생성 시각)과,"
  echo "# 회전된 회차 파일까지 뒤진 다운로드 기록 둘로 한다. '현재 회차가 새로"
  echo "# 받았는가'는 보지 않는다 — 스펙 §4.4 가 재실행 시 캐시를 이어받으라고"
  echo "# 정하므로 그것으로 판정하면 두 번째 실행부터 반드시 실패한다."
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 않는다"; exit 1; }
echo "판정: pyannote 게이트 저장소가 샌드박스 HF 캐시에 새로 받힌 실체(nlink=1)로 있고, 그 회차가${NEW_FILES_OUT:- ?} 에 기록돼 있다"
exit 0
