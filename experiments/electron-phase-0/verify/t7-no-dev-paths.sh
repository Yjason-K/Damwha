#!/bin/bash
# 계획 Task 7 V6 — t7-pipeline 의 dyld 증거에 개발자 `~/.cache`·`/opt/homebrew`·
# `.venv` 가 0건이고, ffmpeg 실행 경로가 `bundle/ffmpeg` 하위인가 (스펙 §4.1/§4.2).
#
# ## 판독 규칙 (계획 "런처 스크립트의 dyld 실측 규칙" 6 / 6b / 6c)
#
# 규칙 6  — `^dyld` 로 시작하는 줄만 본다. 증거 헤더의 `# argv:` 줄에 번들 경로가
#           그대로 들어 있어서, 파일 전체를 grep 하면 dyld 줄에 0건이어도 항상
#           매치된다 (Task 1 의 D2 가 이 함정에 빠졌다).
# 규칙 6b — pid 를 **먼저 고정**하고 그 pid 의 로드 목록을 본다. "경로로 pid 를
#           찾는" 역순은 틀린다.
# 그리고 dyld 줄에는 두 모양이 섞인다.
#           dyld[pid]: <UUID> /절대/경로            ← 이미지 로드 (필드 3개)
#           dyld[pid]: move loaded to delayed: 이름  ← 로드가 아니고 경로도 없다
#         `$NF` 로 세면 두 번째가 전부 거짓 위반이 된다. 그래서 이미지 로드 줄로
#         한정한다 (t7-lib.sh::t7_awk_load_line).
#
# ## ffmpeg 를 어떻게 확인하는가
#
# **파이프라인이 부른 ffmpeg/ffprobe 는 dyld 증거에 나오지 않는다.**
# `be/worker/damwha_worker/pipeline/ffmpeg.py::_run` 이 `capture_output=True` 로
# 자식의 stderr 를 파이프로 가져가므로, `DYLD_PRINT_LIBRARIES=1` 이 찍은 줄이
# 래퍼의 fd 2 에 도달하지 못한다. "나왔을 것"이라 가정하지 않고 두 가지를 각각
# 확인한다.
#
#   (a) 해석 경로 — 드라이버가 파이프라인과 **같은 프로세스·같은 PATH** 에서 잰
#       `shutil.which()` 값. t7-pipeline.txt 의 `which ffmpeg` / `which ffprobe`.
#   (b) dyld 실측 — 드라이버가 파이프라인 뒤에 stderr 를 **물려준 채로** 부른
#       번들 ffprobe. 그 pid 의 메인 이미지가 bundle/ffmpeg 아래여야 한다.
#
# (a) 는 파이프라인이 쓴 바이너리가 무엇이었는지, (b) 는 그 바이너리가 번들
# 안 이미지만 열고 도는지를 각각 말한다. 둘 다 있어야 통과다.

set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/t7-lib.sh"

FAIL=0
OUT=$(t7_evidence_path "t7-no-dev-paths.txt")

# 검사할 금지 문자열. lib/forbidden-strings.txt 는 G1 정적 검사용이고 개발자 홈
# 전체(`/Users/gim-yeongjae`)를 담는데, 이 worktree 자체가 그 아래 있어서 dyld
# 경로 판정에는 그대로 쓸 수 없다. 그래서 **개발자 홈 안의 실제 위험 지점만**
# 골라 적는다. $HOME 은 이 스크립트가 도는 사용자 홈(개발자 홈)이다.
DEV_HOME=$(cd ~ && pwd -P)
FORBIDDEN="/opt/homebrew
/Library/Frameworks/Python.framework
/usr/local/bin
/usr/local/lib
/usr/local/Cellar
/usr/local/opt
/Library/Developer/CommandLineTools
/.venv
$DEV_HOME/.cache
$DEV_HOME/.local
$DEV_HOME/.pyenv"

REPORT=$(
  echo "== dyld 증거"
  echo "  파일: $T7_DYLD_TXT"
  if [ ! -f "$T7_DYLD_TXT" ]; then
    echo "  FAIL 증거가 없다 — V2 를 먼저 돌린다"
    echo "RC_MEASURED=1"; echo "RC_FORBIDDEN=1"; echo "RC_FFMPEG=1"; echo "RC_FOREIGN=1"
  else
    RC=0
    if head -n 1 "$T7_DYLD_TXT" | grep -q '^MEASUREMENT_UNAVAILABLE'; then
      echo "  FAIL 첫 줄이 MEASUREMENT_UNAVAILABLE 이다 — 통과로 집계하지 않는다"
      RC=1
    fi
    N=$(t7_dyld_lines "$T7_DYLD_TXT")
    NIMG=$(t7_dyld_all_images "$T7_DYLD_TXT" | wc -l | tr -d ' ')
    echo "  dyld 줄        : $N"
    echo "  이미지 로드 줄 : $NIMG  (필드 3개 + <UUID> + 절대 경로)"
    [ "$N" -gt 0 ] || { echo "  FAIL dyld 줄이 0건이다"; RC=1; }
    [ "$NIMG" -gt 0 ] || { echo "  FAIL 이미지 로드 줄이 0건이다"; RC=1; }
    echo "RC_MEASURED=$RC"

    echo
    echo "== pid 별 메인 이미지 (규칙 6b — pid 를 먼저 고정한다)"
    for pid in $(t7_dyld_pids "$T7_DYLD_TXT"); do
      main=$(t7_dyld_main_image "$T7_DYLD_TXT" "$pid")
      nb=$(t7_dyld_pid_loads_under "$T7_DYLD_TXT" "$pid" "$BUNDLE_DIR/")
      echo "  pid $pid  번들 아래 로드 ${nb}건"
      echo "    메인 이미지: ${main:-없음}"
    done

    echo
    echo "== 금지 문자열 (이미지 로드 줄의 경로만 본다 — 규칙 6)"
    RCF=0
    # `for` 로 순회한다 — 금지 문자열에는 공백이 없고, heredoc 을 명령 치환
    # 안에서 쓰면 bash 3.2 에서 깨진다.
    for pat in $FORBIDDEN; do
      [ -n "$pat" ] || continue
      # grep -c 는 0건일 때 exit 1 을 낸다 — `|| true` 로 흘리고 수만 읽는다.
      hits=$(t7_dyld_all_images "$T7_DYLD_TXT" | grep -c -F -- "$pat" || true)
      t7_is_uint "$hits" || hits=0
      if [ "$hits" -eq 0 ]; then
        echo "  OK   0건  $pat"
      else
        echo "  FAIL ${hits}건  $pat"
        t7_dyld_all_images "$T7_DYLD_TXT" | grep -F -- "$pat" | sort -u | head -5 | sed 's/^/       /'
        RCF=1
      fi
    done
    echo "RC_FORBIDDEN=$RCF"

    echo
    echo "== 번들·/usr/lib·/System/Library 밖에서 연 이미지 (스펙 §4.1)"
    RCX=0
    for pid in $(t7_dyld_pids "$T7_DYLD_TXT"); do
      fo=$(t7_dyld_pid_foreign "$T7_DYLD_TXT" "$pid" "$BUNDLE_DIR/")
      if [ -n "$fo" ]; then
        echo "  FAIL pid $pid:"
        printf '%s\n' "$fo" | sed 's/^/       /'
        RCX=1
      fi
    done
    [ "$RCX" -eq 0 ] && echo "  OK   0건 — 모든 pid 가 번들·/usr/lib·/System/Library 안에서만 열었다"
    echo "RC_FOREIGN=$RCX"

    echo
    echo "== ffmpeg / ffprobe 실행 경로"
    RCM=0
    echo "  (a) 해석 경로 — 파이프라인과 같은 프로세스·같은 PATH 에서 잰 shutil.which()"
    if [ -f "$T7_PIPELINE_TXT" ]; then
      for tool in ffmpeg ffprobe; do
        v=$(sed -n "s/^which $tool *: *//p" "$T7_PIPELINE_TXT" | head -n 1)
        echo "      which $tool: ${v:-없음}"
        if t7_under "$v" "$BUNDLE_FF_DIR"; then
          echo "      OK   bundle/ffmpeg 하위다"
        else
          echo "      FAIL bundle/ffmpeg 하위가 아니다"
          RCM=1
        fi
      done
      echo "      # 파이프라인이 부른 두 자식의 dyld 줄은 증거에 없다 —"
      echo "      #   pipeline/ffmpeg.py::_run 이 capture_output=True 로 그 stderr 를"
      echo "      #   파이프로 가져가기 때문이다. 그래서 (b) 를 따로 잰다."
    else
      echo "      FAIL $T7_PIPELINE_TXT 가 없다"
      RCM=1
    fi

    echo "  (b) dyld 실측 — 드라이버가 stderr 를 물려준 채로 부른 번들 ffprobe"
    FFPID=""
    for pid in $(t7_dyld_pids "$T7_DYLD_TXT"); do
      main=$(t7_dyld_main_image "$T7_DYLD_TXT" "$pid")
      if t7_under "$main" "$BUNDLE_FF_DIR"; then
        FFPID="$pid"
        break
      fi
    done
    if [ -n "$FFPID" ]; then
      nb=$(t7_dyld_pid_loads_under "$T7_DYLD_TXT" "$FFPID" "$BUNDLE_FF_DIR/")
      echo "      pid $FFPID 의 메인 이미지: $(t7_dyld_main_image "$T7_DYLD_TXT" "$FFPID")"
      echo "      그 pid 가 bundle/ffmpeg 아래에서 연 이미지: ${nb}건"
      if [ "$nb" -ge 1 ]; then
        echo "      OK   번들 ffmpeg 바이너리가 실제로 실행됐다"
      else
        echo "      FAIL 메인 이미지는 번들인데 로드 수가 0이다"
        RCM=1
      fi
    else
      echo "      FAIL 메인 이미지가 $BUNDLE_FF_DIR 아래인 pid 가 없다"
      RCM=1
    fi
    echo "RC_FFMPEG=$RCM"
  fi

  echo
  echo "== 주입 변수 기록 (스펙 §4.2 — HF_TOKEN 은 set/unset 만)"
  if [ -f "$T7_ENV_TXT" ]; then
    grep -a -E '^(PATH|HOME|TMPDIR|DATABASE_URL|STORAGE_ROOT|MODEL_CACHE_DIR|HF_HOME|EMBED_SERVICE_HOST|EMBED_SERVICE_PORT|LENS_LLM_BASE_URL|LENS_LLM_SERVER_BIN|HF_TOKEN)=' \
      "$T7_ENV_TXT" | sed 's/^/  /'
    if grep -aq '^HF_TOKEN=set' "$T7_ENV_TXT"; then
      echo "  OK   HF_TOKEN 은 set 으로만 기록됐다 (값 없음)"
      echo "RC_TOKEN=0"
    else
      echo "  FAIL HF_TOKEN 이 set 으로 기록되지 않았다"
      echo "RC_TOKEN=1"
    fi
  else
    echo "  FAIL $T7_ENV_TXT 가 없다"
    echo "RC_TOKEN=1"
  fi
)

printf '%s\n' "$REPORT" | grep -v '^RC_'

for k in RC_MEASURED RC_FORBIDDEN RC_FOREIGN RC_FFMPEG RC_TOKEN; do
  v=$(printf '%s\n' "$REPORT" | sed -n "s/^$k=//p" | tail -n 1)
  [ "$v" = "0" ] || FAIL=1
done

{
  echo "# Task 7 V6 — dyld 증거에 개발 환경 경로가 0건이고 ffmpeg 가 번들인가"
  echo "# utc: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "# 판정은 ^dyld 줄 중 **이미지 로드 줄**(필드 3개 + <UUID> + 절대 경로)만"
  echo "# 대상으로 한다. 'move loaded to delayed' 줄은 로드가 아니고 경로도 없다."
  echo "# 개발자 홈: $DEV_HOME  (worktree 가 이 아래 있어 홈 경로 전체를 금지어로"
  echo "#   쓸 수 없다 — .cache/.local/.pyenv 만 검사한다)"
  echo
  printf '%s\n' "$REPORT"
} | exp_scrub > "$OUT"

echo
echo "증거: $OUT"
[ "$FAIL" -eq 0 ] || { echo "판정: 조건을 만족하지 않는다"; exit 1; }
echo "판정: dyld 이미지 로드 줄에 금지 경로가 0건이고, ffmpeg/ffprobe 가 bundle/ffmpeg 하위다"
exit 0
