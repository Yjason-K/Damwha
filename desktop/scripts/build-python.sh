#!/bin/bash
# desktop/scripts/build-python.sh
#
# 내장 Python 3.12 런타임 트리를 만든다 — python-build-standalone 3.12.11(20250818) +
# be/worker의 models extra 전량. 런타임 층의 결과는 desktop/.cache/python/rt-<키>/ 이고,
# 재배치·Mach-O 정규화·전수 서명까지 끝난 상태다. 그 위에 damwha_worker만 얹은 것이 worker 층
# (desktop/.cache/python/wk-<키>/)이고, 그것을 desktop/build/python/으로 스테이징한다.
# electron-builder의 extraResources(from: build)가 그 자리를 그대로 Resources/python/으로 싣고,
# dev 앱도 같은 자리를 직접 쓴다 (스펙 §6.1).
#
# Electron Phase 0의 experiments/electron-phase-0/python/build.sh(태그
# archive/electron-phase-0-packaging-validation, 참조 사본은
# docs/superpowers/reference/electron-phase-0/python-build.sh)의 재배치 조작을 옮겼다.
# 옮긴 것이 원본과 다르면 원본이 맞다 — 하나하나가 Phase 0의 실측으로 정해진 것이라 근거를
# 그 자리에 적는다. 의도적으로 다르게 간 것은 둘뿐이고 각각 그 자리에 근거를 적었다:
#   (1) 셔뱅을 절대 경로가 아니라 **위치 독립 폴리글랏**으로 쓴다 (스펙 §6.1-b 1번, §17.3)
#   (2) _sysconfigdata의 prefix 목표값이 실제 경로가 아니라 **중립 자리표시자**다 (스펙 §6.1-b 2번)
#
# **BUILD_PREFIX가 없다.** build-postgres.sh·build-ffmpeg.sh와 다른 점이다 — 그 둘은
# ./configure --prefix로 소스에서 빌드하지만 Python은 배포 아카이브를 풀 뿐이라 우리가 정한
# prefix가 트리 어디에도 없다. 그 대신 "빌드한 자리와 최종 자리가 다르다"는 성질은 work-<키>에서
# 풀고 설치한 뒤 rt-<키>로 옮겨 재배치하는 것으로 유지한다.
#
#   bash desktop/scripts/build-python.sh              캐시가 있으면 스테이징만
#   bash desktop/scripts/build-python.sh --fresh      이 키의 캐시를 버리고 다시 빌드 (수십 분)
#   bash desktop/scripts/build-python.sh --print-key  두 층의 캐시 키와 적중 여부만 찍고 끝낸다
#
# --print-key 가 따로 있는 이유: 캐시 키가 바뀌었는지 확인하려고 그냥 실행하면 미스일 때
# 1.3 GB 빌드가 시작된다. 출력을 head로 끊으면 SIGPIPE로 죽어 work-* 가 반쯤 남는다.

set -euo pipefail

PY_VERSION=3.12
PY_FULL=3.12.11
PBS_RELEASE=20250818
PBS_ASSET="cpython-${PY_FULL}+${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${PBS_ASSET}"

# _sysconfigdata의 prefix 계열 값이 가리킬 자리. **실제 경로를 넣지 않는다** (스펙 §6.1-b 2번).
# 이 트리는 dev에서 desktop/build/python, packaged에서 .app/Contents/Resources/python 두 자리에
# 놓이므로 어느 한쪽 절대 경로를 구우면 다른 쪽에서 거짓말이 된다. 런타임은 sys.prefix를 자기
# 실행 파일 위치에서 계산하므로 이 값은 참조되지 않고, 중립 자리표시자로 두면 "절대 경로가
# 구워졌는가" 검사(Task 7 check-bundle.mjs)가 조용히 통과하는 일이 없다.
PLACEHOLDER=/damwha-bundled-python

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO="$(cd "$DESKTOP/.." && pwd -P)"
SCRIPT="$DESKTOP/scripts/build-python.sh"
SUMS="$DESKTOP/scripts/python-checksums.txt"
# 번들 Python 트리 전용 entitlement(최소 집합 둘). .app 본체는 entitlements.mac.plist를 쓴다 —
# 거기에만 있는 allow-jit은 Python 트리에 주지 않는다 (안 쓰는 권한이다).
ENTS="$DESKTOP/build-resources/entitlements.python.plist"
WORKER="$REPO/be/worker"
CACHE="$DESKTOP/.cache/python"
DL="$CACHE/downloads"
# 스테이징 자리. build-postgres.sh·build-ffmpeg.sh와 같은 관례다 (desktop/build/<이름>).
STAGED="$DESKTOP/build/python"

die() { echo "build-python: $*" >&2; exit 1; }
say() { echo "== $*"; }

FRESH=0
PRINT_KEY=0
case "${1:-}" in
  --fresh) FRESH=1 ;;
  --print-key) PRINT_KEY=1 ;;
  "") ;;
  *) die "usage: build-python.sh [--fresh|--print-key]" ;;
esac

for t in curl tar shasum file otool install_name_tool codesign uv ditto ps; do
  command -v "$t" >/dev/null 2>&1 || die "$t 가 없다 — Xcode Command Line Tools와 uv가 필요하다"
done
[ -f "$SUMS" ] || die "$SUMS 가 없다"
[ -f "$ENTS" ] || die "$ENTS 가 없다"
[ -f "$WORKER/uv.lock" ] || die "$WORKER/uv.lock 이 없다"

# ---------------------------------------------------------------------------
# 캐시 키
#
# 두 층으로 나눈다. 런타임(인터프리터+의존성+재배치+서명)은 거의 안 변하고 worker 패키지는 매
# 커밋 변한다. 하나로 묶으면 worker를 고쳐도 캐시가 적중해 **옛 코드가 .app에 실린다** —
# Electron Phase 2가 24f9080에서 정확히 그 결함을 겪었다.
# ---------------------------------------------------------------------------

# 설치 목록은 uv.lock이 단일 진실 원천이다. 스크립트가 버전을 스스로 적지 않는다.
#   --no-dev          기본은 dev 그룹 포함이라 pytest·ruff·testcontainers가 1.3 GB 번들에 실린다.
#   --locked          uv.lock이 pyproject.toml과 어긋나면 실패한다. 없으면 빌드가 자기 캐시 키
#                     입력(uv.lock)을 다시 써 버린다.
#   --no-emit-project 없으면 목록 3행에 `-e .`가 나온다(실측). 그대로 install에 넣으면 cwd를
#                     editable로 깔아 .pth에 저장소 절대 경로가 박힌다 (스펙 §6.7 위반).
REQS="$(mktemp -t damwha-build-python-reqs)"
trap 'rm -f "$REQS"' EXIT
( cd "$WORKER" && uv export --extra models --no-dev --locked --no-emit-project ) > "$REQS" \
  || die "uv export 실패 — uv.lock이 pyproject.toml과 어긋난다(--locked)"
NPKG=$(grep -cE '^[a-zA-Z0-9]' "$REQS" || true)

# rt 키 = Python 버전·릴리스 + 체크섬 파일 + **uv export 출력** + entitlement + 이 스크립트 자신.
#
# uv.lock이 아니라 export 출력을 해시하는 이유: uv.lock은 dev 그룹까지 담으므로 ruff·pytest
# 버전이 올라가는 것만으로 1.3 GB 런타임 층이 통째로 무효화된다. export 출력은 실제로 설치되는
# 목록이라 더 정확하다.
#
# 조작을 고치고 옛 산출물을 쓰는 것이 가장 조용한 실패라, 스크립트를 한 글자라도 고치면 다시
# 빌드한다. entitlement가 키에 드는 것도 같은 이유다 — 서명 내용이 바뀌면 트리가 달라진다.
RT_KEY=$( { echo "$PY_FULL $PBS_RELEASE"; shasum -a 256 "$SUMS" "$SCRIPT" "$ENTS" "$REQS" | awk '{print $1}'; } | shasum -a 256 | cut -c1-16)
RT_WORK="$CACHE/work-$RT_KEY"
RT_OUT="$CACHE/rt-$RT_KEY"
RT_DONE="$CACHE/rt-$RT_KEY.complete"

# wk 키 = rt 키 + damwha_worker 트리 해시.
#
# 해시에서 경로를 버리지 않는다(`awk '{print $1}'` 금지). 버리면 내용이 같은 두 파일의 rename이
# 같은 키가 되어 모듈을 옮긴 변경이 캐시에 안 잡힌다. .py만 보지도 않는다 — 패키지 안의 자원
# 파일도 동작을 바꾼다. 경로는 $WORKER 기준 상대라 체크아웃 위치가 키를 흔들지 않는다.
#
# rt 키가 들어 있으므로 런타임 층이 다시 빌드되면 worker 층도 따라 무효가 된다.
WK_KEY=$( { echo "$RT_KEY"; ( cd "$WORKER" && find damwha_worker -type f ! -name .DS_Store ! -path '*/__pycache__/*' -exec shasum -a 256 {} + | sort ); } | shasum -a 256 | cut -c1-16)
WK_OUT="$CACHE/wk-$WK_KEY"
WK_DONE="$CACHE/wk-$WK_KEY.complete"

if [ "$PRINT_KEY" = 1 ]; then
  echo "rt 키: $RT_KEY"
  if [ -f "$RT_DONE" ] && [ -x "$RT_OUT/bin/python$PY_VERSION" ]; then
    echo "rt 캐시: 적중 ($RT_OUT)"
  else
    echo "rt 캐시: 미스 ($RT_OUT 없음)"
  fi
  echo "wk 키: $WK_KEY"
  if [ -f "$WK_DONE" ] && [ -x "$WK_OUT/bin/python$PY_VERSION" ]; then
    echo "wk 캐시: 적중 ($WK_OUT)"
  else
    echo "wk 캐시: 미스 ($WK_OUT 없음)"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# 재배치·서명 함수 일곱. 아래 worker 층이 그중 넷을 그대로 다시 부르고
# (relocate·sign_tree·verify_signatures·purge_pycache), 뒤 둘 중 sign_tree·verify_signatures가
# macho_list를 안에서 쓴다.
#
# **fix_macho는 부르지 않는다** — 따라서 그것만 쓰는 resign도 worker 층 경로에는 안 걸린다.
# damwha_worker는 순수 Python이라 새 Mach-O가 없고(실측: LC_RPATH 0건·LC_ID_DYLIB 0건), 런타임
# 층이 이미 번들 밖 LC_RPATH를 전부 지운 트리에서 다시 부르면 fix_macho가 그 "0건"을 필터
# 오류로 보고 die한다.
# ---------------------------------------------------------------------------

# 번들 안의 Mach-O 목록. Phase 0 python-build.sh:240-249 그대로다 — 검사기가 보는 집합과
# 고치는 집합이 어긋나면 안 된다. 아키텍처 꼬리표("(for architecture arm64)")를 떼고 sort -u 한다.
macho_list() {
  find -L "$1" -type f -print0 2>/dev/null \
    | xargs -0 file -L 2>/dev/null | grep -a 'Mach-O' \
    | sed -e 's/:[[:space:]]*Mach-O.*$//' -e 's/ (for architecture [^)]*)$//' \
    | sort -u
}

# install_name_tool로 고친 Mach-O는 **반드시 다시 서명한다.** arm64는 서명 없는 Mach-O를
# 실행하지 않는다 (Phase 0 :251-252). 원본은 경고만 냈지만 이 저장소의 관례
# (build-postgres.sh:113)는 die다 — 재서명이 빠진 파일은 그 자리에서 실행 불가가 된다.
#
# **실패 사유를 버리지 않는다.** codesign은 진단을 stderr에 쓰는데 그것을 /dev/null로 보내면
# 남는 것이 파일 이름뿐이라 고칠 수가 없다 (sign_tree도 같다).
resign() {
  local out
  out=$(codesign -f -s - "$1" 2>&1) || die "재서명 실패: $1 — ${out:-codesign이 사유를 남기지 않았다}"
}

# 파이썬 층 재배치 셋 — 셔뱅 · _sysconfigdata prefix · direct_url.json.
# Mach-O는 건드리지 않는다(fix_macho의 몫). worker 층이 이 함수만 다시 부르면 되도록 갈랐다.
relocate() {
  local root="$1"
  root=$(cd "$root" && pwd -P)
  local py="$root/bin/python$PY_VERSION"
  [ -x "$py" ] || die "$py 가 없다"

  # ── (a) 콘솔 스크립트 셔뱅 → 위치 독립 폴리글랏 ─────────────────────────────
  #
  # uv/pip이 만드는 콘솔 스크립트는 셔뱅에 **설치 시점 인터프리터의 절대 경로**를 박는다.
  # 옮기면 그 경로가 없어져 스크립트가 통째로 죽는다(Phase 0 R-9). Phase 0은 그 경로를 현재
  # 위치로 다시 쓰는 쪽을 골랐고 #!/bin/sh 트릭을 기각했다(:274-277 — SIP가 /bin/sh exec에서
  # DYLD_*를 지워 Phase 0의 dyld 실측이 끊긴다). **Phase 4는 반대로 간다**: dyld 실측을 하지
  # 않는 대신 한 산출물이 dev와 .app 두 자리에 놓이므로 어느 절대 경로도 옳지 않다
  # (스펙 §6.1-b 1번·§17.3).
  #
  # 순진한 `exec "${0%/*}/python3.12" "$0" "$@"` 는 **python이 그 줄을 파싱해
  # SyntaxError: Missing parentheses in call to 'exec' 로 죽는다**(실측). 아래 형태는 셸이
  # 2행을 exec로 읽고 python은 2·3행을 문자열 리터럴로 읽어 무시한다. PBS 원본이 같은
  # 폴리글랏에 dirname·realpath를 쓰는 것을 ${0%/*}로 바꾼 것이다 — 앱이 자식에게 주는
  # PATH에는 /usr/bin이 없어(스펙 §6.2) 외부 명령을 부르면 그 자리에서 죽는다.
  local sb1='#!/bin/sh'
  local sb2="'''exec' \"\${0%/*}/python$PY_VERSION\" \"\$0\" \"\$@\""
  local sb3="' '''"

  # **uv는 셔뱅을 두 형태로 쓴다.** 인터프리터 경로가 짧으면 1행이 그 절대 경로인 평문,
  # 127바이트를 넘거나 공백을 담으면 1행이 #!/bin/sh 인 폴리글랏이다(실측: 이 저장소의
  # work-<키> 경로는 99자라 평문이지만, 스크래치패드 경로로 설치하면 폴리글랏이 나온다).
  # Phase 0의 매처(:285-296)는 `\#\!*/bin/python3.12`, 즉 평문만 잡는다. 그대로 옮기면
  # 체크아웃 경로가 긴 머신에서 **재작성이 조용히 0건이 되고** 절대 경로가 bin/에 남아
  # Task 7의 금지 문자열 검사에서 원인 불명의 FAIL이 난다. 그래서 둘 다 매치한다.
  local n_rewrote=0 n_already=0 n_other=0 f l1 l2 l3 tmp
  for f in "$root"/bin/*; do
    [ -f "$f" ] || continue
    [ "$(LC_ALL=C head -c 2 "$f" 2>/dev/null)" = '#!' ] || continue
    l1=$(LC_ALL=C sed -n '1p' "$f")
    l2=$(LC_ALL=C sed -n '2p' "$f")
    l3=$(LC_ALL=C sed -n '3p' "$f")
    tmp="$f.reloc.$$"
    case "$l1" in
      '#!/bin/sh')
        if [ "$l2" = "$sb2" ] && [ "$l3" = "$sb3" ]; then
          n_already=$((n_already + 1)); continue     # 이미 우리 형태다 (멱등)
        fi
        case "$l2" in
          "'''exec' '"*"/python$PY_VERSION' \"\$0\" \"\$@\"")
            # uv 폴리글랏. 1~3행을 우리 것으로 갈고 나머지 바이트는 손대지 않는다.
            { printf '%s\n' "$sb1" "$sb2" "$sb3"; LC_ALL=C tail -n +4 "$f"; } > "$tmp"
            chmod 755 "$tmp"; mv "$tmp" "$f"
            n_rewrote=$((n_rewrote + 1)) ;;
          *)
            rm -f "$tmp"
            n_other=$((n_other + 1))
            echo "  경고: 알 수 없는 /bin/sh 스크립트 bin/$(basename "$f"): $l2" ;;
        esac ;;
      "#!"*"/bin/python$PY_VERSION")
        # 평문. 1행만 갈고 나머지 바이트는 손대지 않는다.
        { printf '%s\n' "$sb1" "$sb2" "$sb3"; LC_ALL=C tail -n +2 "$f"; } > "$tmp"
        chmod 755 "$tmp"; mv "$tmp" "$f"
        n_rewrote=$((n_rewrote + 1)) ;;
      *)
        rm -f "$tmp"
        n_other=$((n_other + 1))
        echo "  경고: 알 수 없는 셔뱅 bin/$(basename "$f"): $l1" ;;
    esac
  done
  echo "  셔뱅 ${n_rewrote}개 재작성 / ${n_already}개는 이미 폴리글랏 / ${n_other}개 미처리"
  # 0건은 "고칠 게 없었다"가 아니라 매처가 틀렸다는 뜻이다 — prune 뒤 bin/에 남는 스크립트는
  # 전부 uv가 만든 콘솔 스크립트뿐이다.
  [ $((n_rewrote + n_already)) -gt 0 ] \
    || die "셔뱅을 하나도 재작성하지 못했다 — 매처가 uv의 두 형태를 놓쳤다"
  # **부분 미스도 실패다.** 위 조건만으로는 worker 층을 못 지킨다 — 거기서는 런타임 층에서
  # 물려받은 폴리글랏 62개가 n_already로 들어와 조건을 **항상** 만족시키므로, uv가 새 콘솔
  # 스크립트 damwha-worker·damwha-embed에 제3의 셔뱅 형태를 쓰면 그 둘이 wk-<키>.tmp 절대
  # 경로를 지닌 채 경고만 찍고 지나간다. 그 절대 경로는 Task 7의 금지 문자열 검사에서
  # 원인 불명의 FAIL이 된다 — 여기서 형태를 밝히고 죽는 편이 낫다.
  [ "$n_other" = 0 ] \
    || die "셔뱅 ${n_other}개를 재작성하지 못했다 — 위 경고가 찍은 형태를 매처에 더한다"

  # ── (b) _sysconfigdata의 설치 시점 prefix → 중립 자리표시자 ─────────────────
  #
  # **파일을 정규식으로 긁지 않고 런타임에게 직접 묻는다.** 이 파일의 표기가 홑따옴표인지
  # 겹따옴표인지, 한 줄인지 여러 줄인지는 배포본마다 다르다 — Phase 0에서 실제로 겹따옴표라
  # 홑따옴표 regex가 조용히 빈 값을 냈다(:301-338).
  #
  # 목표값이 Phase 0과 다르다. 원본은 $root(절대 경로)로 재작성하지만 여기서는 자리표시자다
  # (위 PLACEHOLDER 주석). 그리고 tarball 전개 경로에서는 uv가 prefix에 손대지 않아 PBS
  # 원본값 `/install`이 남는다(실측 35회 출현) — 스펙 §6.1-b 2번이 말한 "uv가 캐시 경로로
  # 다시 쓴다"는 Phase 0의 `uv python install` 경로에서만 성립한다.
  local sysdata="$root/lib/python$PY_VERSION/_sysconfigdata__darwin_darwin.py"
  [ -f "$sysdata" ] || die "$sysdata 가 없다"
  local cur after esc_from esc_to
  cur=$("$py" -c "import sys,sysconfig; sys.stdout.write(sysconfig.get_config_var('prefix') or '')" 2>/dev/null) || cur=""
  [ -n "$cur" ] || die "sysconfig prefix를 읽지 못했다 — 번들 python이 실행되지 않는다"
  if [ "$cur" != "$PLACEHOLDER" ]; then
    esc_from=$(printf '%s' "$cur" | sed 's/[&/\]/\\&/g')
    esc_to=$(printf '%s' "$PLACEHOLDER" | sed 's/[&/\]/\\&/g')
    LC_ALL=C sed -i '' "s/$esc_from/$esc_to/g" "$sysdata"
    echo "  sysconfig prefix 재작성: $cur → $PLACEHOLDER"
  else
    echo "  sysconfig prefix 이미 자리표시자: $cur"
  fi
  # 고쳐졌는지 런타임에게 다시 묻는다. 조용히 실패하면 Task 7의 검사에서야 드러난다.
  after=$("$py" -c "import sys,sysconfig; sys.stdout.write(sysconfig.get_config_var('prefix') or '')" 2>/dev/null) || after=""
  [ "$after" = "$PLACEHOLDER" ] \
    || die "sysconfig prefix 재작성 실패: '${after:-없음}' (기대: $PLACEHOLDER)"

  # ── (c) PEP 610 direct_url.json 삭제 ───────────────────────────────────────
  #
  # wheel이나 디렉터리를 경로로 설치하면 그 절대 경로가 여기 남는다(worker 층에서
  # {"url":"file:///…/be/worker"} 가 생긴다). 런타임이 읽지 않는 **설치 출처 기록**이고
  # PEP 610은 선택 사항이라 지운다. 텍스트 파일이라 check-bundle.mjs의 기존 검사가 실제로
  # 잡는 몇 안 되는 경우이기도 하다 (Phase 0 :342-356).
  local d cnt=0
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    rm -f "$d"
    cnt=$((cnt + 1))
  done < <(find "$root/lib/python$PY_VERSION/site-packages" -name direct_url.json 2>/dev/null)
  echo "  direct_url.json ${cnt}개 삭제"
}

# Mach-O 층 — 번들 밖 LC_RPATH 삭제 + LC_ID_DYLIB 정규화. 고친 파일은 그 자리에서 재서명한다.
fix_macho() {
  local root="$1"
  root=$(cd "$root" && pwd -P)
  local machos m rp idv base newid touched
  local rn=0 rfiles=0 idn=0
  machos=$(macho_list "$root") || die "Mach-O 목록을 만들지 못했다"
  [ -n "$machos" ] || die "Mach-O가 하나도 없다 — 트리가 비었거나 file(1)이 바뀌었다"
  echo "  Mach-O $(printf '%s\n' "$machos" | wc -l | tr -d ' ')개"

  # ── (a) 번들 밖 LC_RPATH 삭제 (Phase 0 :370-399) ───────────────────────────
  #
  # Phase 0이 "이 Task에서 가장 실질적인 발견"이라고 부른 것이다. wheel 배포자의 빌드 머신
  # 경로가 LC_RPATH로 그대로 남아 있고, LC_RPATH는 dyld의 **실제 검색 경로**다. 그 자리에 같은
  # 이름의 dylib이 있으면 번들이 아니라 그쪽을 연다 — 이 트리의 실측은 84파일 86건이고
  # /Users/runner/miniconda3 64건, /opt/homebrew/opt/ffmpeg/lib 15건, gcc@13 3건이다.
  #
  # **필터는 BUILD_PREFIX 매칭이 아니라 "@*·번들 안·/usr/lib·/System 을 뺀 전부"다.**
  # Python은 아카이브 전개라 우리가 정한 prefix 문자열이 트리에 없고, BUILD_PREFIX로 걸렀으면
  # 86건을 하나도 못 잡는다. build-postgres.sh의 relocate()가 BUILD_PREFIX를 쓰는 것과 다른
  # 점이고, 여기서 갈리는 이유가 그것이다.
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    touched=0
    while IFS= read -r rp; do
      [ -n "$rp" ] || continue
      case "$rp" in
        @*|"$root"|"$root"/*|/usr/lib|/usr/lib/*|/System/Library|/System/Library/*) continue ;;
      esac
      install_name_tool -delete_rpath "$rp" "$m" 2>/dev/null \
        || die "LC_RPATH 삭제 실패: ${m#"$root"/} <- $rp"
      echo "  LC_RPATH 삭제: ${m#"$root"/}  <- $rp"
      rn=$((rn + 1)); touched=1
    done < <(otool -l "$m" 2>/dev/null | awk '/^ *cmd LC_RPATH/{r=1;next} r&&/^ *path /{print $2; r=0}' | sort -u)
    # install_name_tool은 서명을 무효로 만든다 → 파일별 즉시 재서명 (Phase 0 :398).
    if [ "$touched" = 1 ]; then resign "$m"; rfiles=$((rfiles + 1)); fi
  done <<< "$machos"
  echo "  → LC_RPATH ${rn}건 삭제 / ${rfiles}개 파일 재서명"
  # 0건은 "깨끗했다"가 아니라 필터가 틀렸다는 뜻이다 (Phase 0 실측 58건, 이 트리 실측 86건).
  [ "$rn" -gt 0 ] || die "번들 밖 LC_RPATH를 하나도 지우지 않았다 — 필터가 틀렸다"

  # ── (b) LC_ID_DYLIB 정규화 (Phase 0 :401-435) ──────────────────────────────
  #
  # wheel의 dylib은 delocate가 넣은 자리표시자 id(/DLC/…)나 빌드 시점 경로(/opt/llvm-openmp/…,
  # bazel-out/…)를 그대로 갖고 있다. 의존 참조는 전부 @loader_path/@rpath라 dyld가 그 id를
  # 해석하는 일은 없지만 otool -L의 첫 줄로 나오므로 검사기가 의존 경로와 함께 읽는다.
  #
  # **libpython3.12.dylib만 @executable_path/../lib/… 이고 나머지는 @rpath/<base>다.**
  # bin/python3.12가 libpython을 그 형태로 참조하기 때문이다.
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    # otool -D는 fat 바이너리에서 헤더 줄("path:", "Architectures in the fat file: …")을 섞어
    # 낸다. id만 남긴다.
    idv=$(otool -D "$m" 2>/dev/null | grep -v ':$' | grep -v '^Architectures in the fat file' | sed -n '1p') || idv=""
    [ -n "$idv" ] || continue
    case "$idv" in
      @*|"$root"|"$root"/*) continue ;;
    esac
    base=$(basename "$idv")
    case "${m#"$root"/}" in
      lib/libpython$PY_VERSION.dylib) newid="@executable_path/../lib/libpython$PY_VERSION.dylib" ;;
      *) newid="@rpath/$base" ;;
    esac
    install_name_tool -id "$newid" "$m" 2>/dev/null \
      || die "LC_ID_DYLIB 변경 실패: ${m#"$root"/} ($idv)"
    resign "$m"
    idn=$((idn + 1))
  done <<< "$machos"
  echo "  → LC_ID_DYLIB ${idn}건 정규화 / 같은 수만큼 재서명"
}

# 트리 안 Mach-O 전수 서명. ad-hoc 서명 + hardened runtime + 번들 Python 전용 entitlement.
#
# 제3자 wheel의 .so는 우리 Team ID로 서명되지 않는다. disable-library-validation은 서명 주체를
# 안 따질 뿐 "서명 없음"은 허용하지 않으므로 전수 서명과 짝이다 (Phase 0 R-5).
#
# **codesign의 stderr를 버리지 않는다.** entitlements plist가 AMFI의 파서를 통과하지 못하면
# codesign은 `Failed to parse entitlements: AMFIUnserializeXML: syntax error near line N`을
# stderr에만 쓴다. 그것을 /dev/null로 보내면 남는 것이 "서명 실패: <파일>"뿐이고, 그 메시지는
# 무엇이 틀렸는지 한 글자도 말하지 않는다 — `plutil -lint`는 그 plist를 통과시키므로 lint로도
# 못 잡는다. $ENTS는 rt 캐시 키의 입력이라, plist를 고치면 이 경로가 반드시 다시 돈다.
sign_tree() {
  local root="$1" machos m out n=0
  root=$(cd "$root" && pwd -P)
  machos=$(macho_list "$root") || die "Mach-O 목록을 만들지 못했다"
  [ -n "$machos" ] || die "Mach-O가 하나도 없다"
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    out=$(codesign --force --sign - --options runtime --entitlements "$ENTS" "$m" 2>&1) \
      || die "서명 실패: ${m#"$root"/} — ${out:-codesign이 사유를 남기지 않았다}"
    n=$((n + 1))
  done <<< "$machos"
  echo "  서명 ${n}개 (--options runtime, $(basename "$ENTS"))"
}

# 전수 서명 검증. **반드시 --arch arm64 다.**
#
# arm64 슬라이스만 서명된 fat 바이너리를 plain --verify는 "not signed at all"로 잡지만
# --arch arm64는 통과시킨다 — 즉 --arch 는 반쪽 서명 fat 바이너리 방어다. 거꾸로 x86_64 전용
# thin 파일에는 "object file format unrecognized"로 rc 1을 낸다. 그것은 **무서명이 아니라
# arm64 슬라이스가 없다는 뜻**이라 따로 세어 보고한다 (arm64 맥에서 어차피 실행되지 않는다).
verify_signatures() {
  local root="$1" machos m out n=0 bad=0 noarch=0
  root=$(cd "$root" && pwd -P)
  machos=$(macho_list "$root") || die "Mach-O 목록을 만들지 못했다"
  [ -n "$machos" ] || die "Mach-O가 하나도 없다"
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    n=$((n + 1))
    if out=$(codesign --verify --arch arm64 "$m" 2>&1); then continue; fi
    case "$out" in
      *unrecognized*|*unsuitable*)
        noarch=$((noarch + 1))
        echo "  arm64 슬라이스 없음(x86_64 전용 thin?): ${m#"$root"/} — $out" >&2 ;;
      *)
        bad=$((bad + 1))
        echo "  서명 검증 실패: ${m#"$root"/} — $out" >&2 ;;
    esac
  done <<< "$machos"
  echo "  arm64 서명 전수 확인: ${n}개 중 실패 ${bad}건, arm64 슬라이스 없음 ${noarch}건"
  [ "$bad" = 0 ] || die "codesign --verify --arch arm64 가 ${bad}건 실패했다"
}

# __pycache__ 정리. **번들 python을 돌리는 모든 단계보다 뒤여야 한다** (스펙 §6.1-b 4번).
#
# .pyc에는 컴파일 시점의 소스 절대 경로(co_filename)와 모듈의 문자열 상수가 그대로 들어간다.
# _sysconfigdata의 옛 prefix가 .pyc에 남아 있으면 .py를 고쳐도 검사에는 그대로 잡힌다.
purge_pycache() {
  local root="$1" n left
  n=$(find "$root" -type d -name __pycache__ -prune | wc -l | tr -d ' ')
  find "$root" -type d -name __pycache__ -prune -exec rm -rf {} +
  left=$(find "$root" -name '*.pyc' | wc -l | tr -d ' ')
  echo "  __pycache__ ${n}개 디렉터리 삭제 (남은 .pyc ${left}개)"
  [ "$left" = 0 ] || die "__pycache__ 밖에 .pyc가 ${left}개 남았다"
}

# ---------------------------------------------------------------------------
# 런타임 층 빌드
# ---------------------------------------------------------------------------

fetch() {
  local url="$1" out="$2"
  [ -f "$DL/$out" ] && return 0
  curl -fsSL -o "$DL/$out.part" "$url" || die "내려받기 실패: $url"
  mv "$DL/$out.part" "$DL/$out"
}

# 번들에서 빼는 것. 두 종류뿐이고 둘 다 디렉터리 단위다 (Phase 0 :133-205 그대로).
#   (a) 빌드 전용 — C 헤더, pkgconfig, config-*/Makefile. 앱 실행에 쓰지 않는다.
#   (b) 쓰지 않는 서브시스템 — tkinter/tcl/tk, pip/ensurepip, lib2to3, man.
#
# (b)에는 부수 효과가 하나 더 있다. PBS의 bin/ 스크립트(pip·2to3·idle3·pydoc3·python3.12-config)는
# 셔뱅이 #!/bin/sh + `dirname -- "$(realpath -- "$0")"` 형태다. 앱이 자식에게 주는 PATH에는
# /usr/bin이 없어(스펙 §6.2) 그대로 두면 `realpath: command not found`로 죽고, 그것이 우리
# 셔뱅의 결함으로 오독된다. 빼면 bin/의 스크립트가 전부 우리 폴리글랏으로 통일된다.
#
# site-packages 안은 건드리지 않는다 — uv가 설치한 패키지 집합을 그대로 두어야 설치 목록과
# 재현이 성립한다 (pip은 (b)로 통째로 빠진다).
PRUNE_BUILD_ONLY="
include
lib/pkgconfig
lib/python3.12/config-3.12-darwin
bin/python3.12-config
bin/python3-config
share/man
"

PRUNE_UNUSED="
lib/tcl8
lib/tcl8.6
lib/tk8.6
lib/itcl4.2.4
lib/thread2.8.9
lib/libtcl8.6.dylib
lib/libtk8.6.dylib
lib/python3.12/tkinter
lib/python3.12/idlelib
lib/python3.12/turtledemo
lib/python3.12/turtle.py
lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so
lib/python3.12/lib2to3
lib/python3.12/ensurepip
bin/idle3
bin/idle3.12
bin/2to3
bin/2to3-3.12
bin/pydoc3
bin/pydoc3.12
bin/pip
bin/pip3
bin/pip3.12
lib/python3.12/site-packages/pip
"

prune() {
  local root="$1" before after p n=0
  before=$(du -sk "$root" | awk '{print $1}')
  # -e 는 끊어진 심볼릭 링크에 false다. 목록이 링크와 그 대상을 함께 담고 있어서
  # (bin/python3-config → bin/python3.12-config) -L 도 같이 본다.
  for p in $PRUNE_BUILD_ONLY $PRUNE_UNUSED; do
    if [ -e "$root/$p" ] || [ -L "$root/$p" ]; then
      rm -rf "$root/$p"; n=$((n + 1))
    fi
  done
  rm -rf "$root"/lib/python3.12/site-packages/pip-*.dist-info
  rmdir "$root/share" 2>/dev/null || true
  after=$(du -sk "$root" | awk '{print $1}')
  echo "  ${n}개 항목 제거, ${before} KiB → ${after} KiB"
}

build_rt() {
  local started=$SECONDS
  rm -rf "$RT_WORK" "$RT_OUT.tmp"
  mkdir -p "$DL" "$RT_WORK"

  say "1. python-build-standalone $PY_FULL ($PBS_RELEASE) 내려받기 + 체크섬"
  fetch "$PBS_URL" "$PBS_ASSET"
  ( cd "$DL" && grep -v '^[[:space:]]*#' "$SUMS" | grep -v '^[[:space:]]*$' | shasum -a 256 -c - ) \
    || die "체크섬이 다르다"

  say "2. 풀기"
  tar xzf "$DL/$PBS_ASSET" -C "$RT_WORK"
  [ -x "$RT_WORK/python/bin/python$PY_VERSION" ] || die "푼 트리에 bin/python$PY_VERSION 이 없다"
  # uv가 자기 관리 디렉터리 표시로 넣는 파일. install_only 아카이브에는 없지만 있으면
  # uv pip install이 거부한다 (Phase 0 :106).
  rm -f "$RT_WORK/python/lib/python$PY_VERSION/EXTERNALLY-MANAGED"

  say "3. 의존성 설치 — uv export 목록 ${NPKG}개"
  # --link-mode=copy: 기본값이면 설치된 파일이 개발자 uv 캐시의 inode를 공유할 수 있고, 그
  # 캐시는 개발 venv(be/worker/.venv)에도 걸려 있다. 뒤에서 install_name_tool로 Mach-O를 고치는
  # 순간 **개발 venv의 같은 파일이 함께 바뀐다.** Phase 0 :31-34,127이 같은 이유로 그렇게 한다.
  cp "$REQS" "$RT_WORK/requirements.txt"
  uv pip install --python "$RT_WORK/python/bin/python$PY_VERSION" --link-mode=copy \
     -r "$RT_WORK/requirements.txt" || die "uv pip install 실패"

  say "4. 가지치기"
  prune "$RT_WORK/python"

  # 설치한 자리와 최종 자리를 다르게 둔다. 같은 자리에서만 검증하면 재배치를 한 번도 묻지 않은
  # 채 통과한다 (Phase 0 :216-227과 같은 이유).
  mv "$RT_WORK/python" "$RT_OUT.tmp"

  say "5. 재배치 — 셔뱅 · sysconfig prefix · direct_url.json"
  relocate "$RT_OUT.tmp"

  say "6. Mach-O — 번들 밖 LC_RPATH 삭제 · LC_ID_DYLIB 정규화"
  fix_macho "$RT_OUT.tmp"

  say "7. 전수 서명"
  sign_tree "$RT_OUT.tmp"

  say "8. arm64 서명 전수 확인"
  verify_signatures "$RT_OUT.tmp"

  # relocate가 sysconfig를 물으려고 번들 python을 두 번 돌렸다. 그보다 뒤에서 지운다.
  say "9. __pycache__ 정리"
  purge_pycache "$RT_OUT.tmp"

  rm -rf "$RT_WORK"
  mv "$RT_OUT.tmp" "$RT_OUT"
  say "런타임 층 빌드 $((SECONDS - started))초"
}

# ---------------------------------------------------------------------------
# worker 층 빌드
# ---------------------------------------------------------------------------

# 진입점 확인. **find_spec으로 "찾기"만 한다 — import하지 않는다** (스펙 §6.1 8단계).
#
# import가 위험한 이유: embed_service는 Part 2가 고치기 전까지 모듈 수준에서 load_settings()와
# build_text_embedder()를 부른다(embed_service.py:10-11). import하면 빌드 머신이 DATABASE_URL을
# 요구하고 bge-m3 2.2 GB를 받는다.
#
# 다만 find_spec도 무부작용은 아니다 — **점 표기는 부모 패키지를 import한다**(실측:
# pkg/__init__.py의 print가 찍히고 `pkg in sys.modules: True`). damwha_worker.* 가 안전한 것은
# damwha_worker/__init__.py가 0바이트이기 때문이지 find_spec이 아무것도 실행하지 않아서가
# 아니다. 그래서 그 파일이 비어 있음을 **함께 assert한다** — 목록에 모듈을 더할 때는 그 패키지의
# __init__.py를 먼저 본다. mlx_lm.server는 mlx_lm/__init__.py를 실행하고 그것은 실제 import를
# 담지만 다운로드는 없다.
#
# **find_spec은 부모가 없으면 None이 아니라 ModuleNotFoundError를 던진다**(실측:
# find_spec('definitely_missing_pkg_xyz.sub')). 감싸지 않으면 mlx_lm이 빠졌을 때 트레이스백으로
# 죽어 뒤의 tqdm_class assert에 닿지 못한다 — 빌드는 어차피 멈추지만 진단이 사라진다.
#
# damwha_worker.llm_entry는 Part 2가 만든다 — 그때 이 목록에 더한다.
#
# huggingface_hub만은 실제로 import한다. 다운로드 진행 훅이 snapshot_download·hf_hub_download의
# tqdm_class 인자에 얹히므로(스펙 §6.9), 라이브러리가 그 인자를 없애면 **.app이 아니라 빌드가
# 깨져야 한다.** 이 모듈의 import는 설정을 요구하지도 모델을 받지도 않는다.
#
# ── 이 검사는 "번들 단독"이어야 의미가 있다 ─────────────────────────────────────
#
# 스펙 §6.1 8단계가 이 단계에 준 목적은 "§2.4의 결함(모듈이 번들 밖에 있음)이 다시 나면 여기서
# 잡힌다"이다. 호출 환경으로 만족되는 검사는 그 목적을 달성하지 못한다. 셋을 뗀다 — 셋 다
# 3.12가 지원한다.
#
#   -P  cwd(그리고 -c가 넣는 sys.path[0]=='')를 뺀다. 없으면 be/worker에서 빌드를 돌린 것만으로
#       damwha_worker 세 spec이 **소스 트리**로 해석되고, 소스의 __init__.py도 0바이트라
#       아래 assert까지 함께 통과한다 — 번들을 하나도 안 본 채 "모듈 확인 OK"가 찍힌다.
#       이 스크립트는 아직 어느 package.json 스크립트에도 걸려 있지 않아 cwd가 개발자 셸에
#       달려 있다.
#   -E  PYTHONPATH·PYTHONHOME을 뗀다. 가정이 아니다 — 런타임 층에는 damwha_worker가 없어서
#       Task 5가 정확히 PYTHONPATH로 그 모듈에 닿아 확인했다. PYTHONOPTIMIZE도 함께 무력화되는데,
#       그것이 살아 있으면 아래 assert 둘이 통째로 사라지고도 "모듈 확인 OK"가 찍힌다.
#   -s  user site(~/.local/lib/python3.12/site-packages)를 뗀다.
#
# -E는 PYTHONPYCACHEPREFIX도 무시하므로 .pyc가 트리에 쓰인다. 그것은 계약대로다 —
# purge_pycache가 뒤에 온다.
#
# 셋을 떼도 **site-packages 안의 .pth는 남는다.** 저장소 경로를 sys.path에 얹는 .pth가 바로
# 스펙 §6.7이 경계하는 형태이고(위 `uv export --no-emit-project` 주석이 그 사고를 적는다),
# -E·-P·-s 어느 것도 그것을 막지 못한다. 그래서 찾은 spec의 origin이 번들 아래인지 함께
# 판정한다 — root를 argv로 넘긴다(문자열 보간으로 파이썬 소스에 굽지 않는다).
check_entrypoints() {
  local root="$1"
  "$root/bin/python$PY_VERSION" -E -s -P -c "
import importlib.util as u, inspect, os, pathlib, sys
root = os.path.realpath(sys.argv[1])
TARGETS = ('damwha_worker', 'damwha_worker.__main__', 'damwha_worker.embed_service',
           'mlx_lm.server')
missing, outside = [], []
for m in TARGETS:
    try:
        spec = u.find_spec(m)
    except ModuleNotFoundError:      # 부모 패키지가 없다
        spec = None
    if spec is None:
        missing.append(m); continue
    # namespace 패키지는 origin이 None이다. 이 넷은 전부 실체가 있어야 하므로 그것도 실패다.
    origin = spec.origin
    if not origin or not os.path.realpath(origin).startswith(root + os.sep):
        outside.append(m + ' <- ' + str(origin))
if missing:
    print('  없는 모듈:', ', '.join(missing)); sys.exit(1)
if outside:
    print('  번들 밖 모듈:', ', '.join(outside)); sys.exit(1)
# damwha_worker.* 가 안전한 것은 __init__.py 가 비어 있기 때문이다 — 그것을 못 박는다.
import damwha_worker
src = pathlib.Path(damwha_worker.__file__).read_text()
assert src.strip() == '', 'damwha_worker/__init__.py 에 부작용이 생겼다'
import huggingface_hub
for fn in ('snapshot_download', 'hf_hub_download'):
    params = inspect.signature(getattr(huggingface_hub, fn)).parameters
    assert 'tqdm_class' in params, 'huggingface_hub.' + fn + ' 에 tqdm_class 가 없다'
print('  모듈 확인 OK')
" "$root" || die "진입점 확인 실패 — 번들에 실린 모듈 집합이 기대와 다르다"
}

build_wk() {
  local started=$SECONDS
  rm -rf "$WK_OUT.tmp"

  say "w1. 런타임 층 복사"
  # ditto는 심볼릭 링크와 코드 서명을 그대로 옮긴다 (build-postgres.sh:205 관례).
  ditto "$RT_OUT" "$WK_OUT.tmp" || die "런타임 층 복사 실패"

  say "w2. damwha_worker 설치 (--no-deps)"
  # --no-deps: 런타임 층이 uv export 목록으로 이미 전부 깔았다. 여기서 해석이 다시 돌면 고정이
  # 흔들린다 (스펙 §6.1 3단계).
  # --link-mode=copy: 런타임 층과 같은 이유 — 개발 venv와 inode를 공유하면 뒤의 서명이 그쪽
  # 파일까지 건드린다.
  uv pip install --python "$WK_OUT.tmp/bin/python$PY_VERSION" --link-mode=copy --no-deps \
     "$WORKER" || die "uv pip install --no-deps 실패"

  # 설치가 만든 것만 다시 손본다. damwha_worker는 순수 Python이라 새 Mach-O가 없지만
  # 콘솔 스크립트 둘(damwha-worker·damwha-embed)이 bin/에 절대 경로 셔뱅으로 생기고
  # direct_url.json({"url":"file:///…/be/worker"})도 이때 생긴다 — relocate가 그 셋을 고친다
  # (실측: LC_RPATH 0건·LC_ID_DYLIB 0건이라 fix_macho는 부르지 않는다).
  say "w3. 재배치 — 새 콘솔 스크립트 셔뱅 · sysconfig prefix · direct_url.json"
  relocate "$WK_OUT.tmp"

  # 전수 서명이 "그 파일만 재서명"(스펙 §6.1)과 같은 결과를 내면서 더 단순하고 멱등이다.
  say "w4. 전수 서명"
  sign_tree "$WK_OUT.tmp"

  say "w5. arm64 서명 전수 확인"
  verify_signatures "$WK_OUT.tmp"

  say "w6. 진입점 확인"
  check_entrypoints "$WK_OUT.tmp"

  # relocate가 sysconfig를 물으며 두 번, 진입점 확인이 한 번 — 번들 python을 돌리는 것이
  # 여기서 끝난다. 그 **뒤에** 지운다 (스펙 §6.1-b 4번).
  say "w7. __pycache__ 정리"
  purge_pycache "$WK_OUT.tmp"

  rm -rf "$WK_OUT"
  mv "$WK_OUT.tmp" "$WK_OUT"
  say "worker 층 빌드 $((SECONDS - started))초"
}

# ---------------------------------------------------------------------------
# 스테이징 — 여기서부터 번들 python을 실행하지 않는다 (스펙 §6.1 10단계)
# ---------------------------------------------------------------------------

stage() {
  # dev 앱이 이 트리의 python을 쓰는 중이면 갈아엎지 않는다. python은 모듈을 지연 로드하므로
  # 실행 중에 rm -rf(미스)나 __pycache__ 삭제(적중)를 하면 살아 있는 프로세스가 깨진다.
  # build-postgres.sh:200의 가드와 같은 이유다.
  #
  # **pgrep을 쓰지 않는다.** 이 가드의 실패 형태는 "조용히 꺼짐"이라 사전 필터를 두지 않는다.
  #   (a) `pgrep -f <패턴>`의 패턴은 ERE다 — 경로에 + ( [ 가 있으면 매치가 어긋난다
  #       (실측: `+`가 든 경로에서 0건, 없는 같은 구조에서 1건).
  #   (b) `pgrep -lf python3.12`로 먼저 거르는 것도 안 된다. 스테이징된 트리는 bin/python·
  #       bin/python3을 python3.12 심볼릭 링크로 싣고, `$STAGED/bin/python3 -m damwha_worker`로
  #       뜬 프로세스의 argv에는 "python3.12"가 없다 — 사전 필터가 먼저 침묵해 아래 고정 문자열
  #       비교에 닿지도 못한다 (실측).
  # 그래서 `ps -Ao command=`로 전체를 받아 경로만 고정 문자열로 비교한다.
  #
  # **파이프로 잇지 않고 변수에 받는다.** 이유가 둘이다.
  #   (a) `ps … | grep -qF …`는 둘이 동시에 도는 탓에 ps가 **grep 자신의 argv**를 잡는다. 거기에
  #       비교 문자열이 통째로 들어 있으므로 아무것도 안 돌 때도 매치한다 — 실측으로 가드가
  #       거짓 양성을 냈고, 그러면 빌드가 항상 죽는다. 변수에 먼저 받으면 ps가 grep보다 앞서
  #       끝나 자기 매치가 없다.
  #   (b) set -o pipefail 아래에서 grep -q가 매치 즉시 끝나면 ps가 SIGPIPE로 죽어 파이프라인
  #       rc가 141이 되고, if가 그것을 "매치 없음"으로 읽어 가드가 또 조용히 꺼진다.
  #
  # grep을 절대 경로로 부르는 것도 같은 이유다 — 가드의 판정을 grep이 무엇으로 풀리는지에
  # 맡기지 않는다 (개발 머신의 셸에서 grep이 바이너리를 건너뛰는 ugrep 함수인 경우가 있다).
  local procs
  procs=$(ps -Ao command= 2>/dev/null) || procs=""
  if /usr/bin/grep -qF "$STAGED/bin/" <<< "$procs"; then
    die "번들 python이 실행 중이다 — 앱을 끄고 다시 하라: $STAGED"
  fi

  if [ -f "$STAGED/.build-key" ] && [ "$(cat "$STAGED/.build-key")" = "$WK_KEY" ]; then
    say "이미 스테이징됨: $STAGED ($WK_KEY)"
  else
    mkdir -p "$(dirname "$STAGED")"
    rm -rf "$STAGED.tmp"
    ditto "$WK_OUT" "$STAGED.tmp" || die "스테이징 복사 실패"
    echo "$WK_KEY" > "$STAGED.tmp/.build-key"
    rm -rf "$STAGED"
    mv "$STAGED.tmp" "$STAGED"
    say "스테이징: $STAGED ($(du -sh "$STAGED" | cut -f1))"
  fi

  # **캐시 적중 여부와 무관하게** 지운다. 이 자리는 산출물이면서 dev가 실제로 실행하는 트리라,
  # pnpm desktop:dev가 한 번 돌면 co_filename이 <저장소>/desktop/build/python/…인 .pyc가 쌓인다
  # (실측: 트리의 python을 한 번 돌린 것만으로 .pyc 448개가 전부 트리 절대 경로를 담았다).
  # build-postgres.sh의 .build-key 관례는 "적중이면 아무것도 안 한다"인데 여기서는 적중일수록
  # 오염된 트리가 남는다 (스펙 §6.1-b).
  say "스테이징 트리 __pycache__ 정리"
  purge_pycache "$STAGED"
}

if [ "$FRESH" = 1 ]; then
  rm -rf "$RT_WORK" "$RT_OUT" "$RT_OUT.tmp" "$RT_DONE" "$WK_OUT" "$WK_OUT.tmp" "$WK_DONE"
fi

say "uv export — ${NPKG}개 패키지 (rt 키 $RT_KEY)"
if [ -f "$RT_DONE" ] && [ -x "$RT_OUT/bin/python$PY_VERSION" ]; then
  say "런타임 층 캐시 적중: $RT_OUT"
else
  rm -rf "$RT_WORK" "$RT_OUT" "$RT_OUT.tmp" "$RT_DONE"
  build_rt
  touch "$RT_DONE"
fi
say "런타임 층: $RT_OUT ($(du -sh "$RT_OUT" | cut -f1))"

say "worker 층 (wk 키 $WK_KEY)"
if [ -f "$WK_DONE" ] && [ -x "$WK_OUT/bin/python$PY_VERSION" ]; then
  say "worker 층 캐시 적중: $WK_OUT"
else
  rm -rf "$WK_OUT" "$WK_OUT.tmp" "$WK_DONE"
  build_wk
  touch "$WK_DONE"
fi
say "worker 층: $WK_OUT ($(du -sh "$WK_OUT" | cut -f1))"

stage
