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
#       있으면 (1)을 통과해도 실제로는 남의 것을 읽은 것이다.
#   (3) **이 실행이 받았다.** 드라이버가 실행 전후로 hub/ 를 재서
#       t7-pipeline.txt 에 `NEW <저장소>` 로 남긴다. 그 표시가 근거다.
#
# 개발자 캐시는 **읽지도 않는다.** 존재 여부를 확인하려 들면 그 자체가
# 스펙 §4.4 의 "~/.cache/huggingface 에 대한 쓰기 금지"와 무관하게 검사
# 스크립트가 개발자 홈을 뒤지는 형태가 된다. 판정은 샌드박스 쪽 사실과
# run-isolated.sh 가 기록한 HF_HOME 값만으로 한다.

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
        nlink=$(find "$d/blobs" -type l 2>/dev/null | wc -l | tr -d ' ')
        echo "    blobs 실체 파일: ${nb}개  ${bb} bytes  (심볼릭 링크 ${nlink}개)"
        if [ "$nb" -lt 1 ] || [ "$bb" -lt 1000000 ]; then
          echo "    FAIL blobs 에 실체 가중치가 없다 — 남의 캐시를 참조했을 수 있다"
          RCB=1
        else
          echo "    OK   가중치가 샌드박스 안에 실체로 있다"
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
    echo "== 이 실행이 새로 받았는가 (드라이버가 전후로 재서 남긴 NEW 표시)"
    if [ -f "$T7_PIPELINE_TXT" ]; then
      NEWLINES=$(sed -n 's/^NEW //p' "$T7_PIPELINE_TXT")
      if [ -z "$NEWLINES" ]; then
        echo "  FAIL t7-pipeline.txt 에 NEW 표시가 없다 — 전부 이미 있던 캐시였다"
        echo "RC_NEW=1"
      else
        printf '%s\n' "$NEWLINES" | sed 's/^/  NEW /'
        if printf '%s\n' "$NEWLINES" | grep -q '^models--pyannote--'; then
          echo "  OK   pyannote 게이트 저장소를 이 실행이 새로 받았다"
          echo "RC_NEW=0"
        else
          echo "  FAIL NEW 목록에 pyannote 저장소가 없다"
          echo "RC_NEW=1"
        fi
      fi
    else
      echo "  FAIL $T7_PIPELINE_TXT 가 없다 — V2 를 먼저 돌린다"
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

{
  echo "# Task 7 V5 — 게이트 모델을 샌드박스 HOME 에 새로 받았는가 (P0-C4, R-6)"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 개발자 캐시(~/.cache/huggingface)는 읽지도 쓰지도 않는다 (스펙 §4.4)."
  echo "# HF_TOKEN 은 set/unset 만 기록한다 (스펙 §4.2) — 이 파일에 값이 없다."
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 않는다"; exit 1; }
echo "판정: pyannote 게이트 저장소가 샌드박스 HF 캐시에 실체로 있고, 이 실행이 새로 받았다"
exit 0
