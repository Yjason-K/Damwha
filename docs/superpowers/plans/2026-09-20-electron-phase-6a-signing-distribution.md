# Electron Phase 6a — 서명·배포 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이 맥 밖에서도 뜨고, 뜬 것이 위조가 아님을 macOS가 스스로 확인할 수 있는 설치물(서명·공증된 DMG)을 만들고 다른 맥에서 실제 처리까지 확인한다.

**Architecture:** `desktop/scripts/package.mjs`가 이미 electron-builder 뒤에 손으로 서명하는 구조다. 그 구조를 유지하되 identity를 ad-hoc에서 Developer ID로 바꾸고, DMG를 **서명이 끝난 `.app`에서 `--prepackaged`로 따로** 만든다. 최소 macOS 15.0은 세 갈래(소스 빌드 둘의 `MACOSX_DEPLOYMENT_TARGET`, mlx 두 휠의 URL 고정, `check-bundle`의 `minos` 전수 단언)로 강제한다. 디스크 부족은 세 다운로드 주체가 공유하는 `models/downloads.py` 한 곳에서 재고, 표면화만 주체별로 가른다.

**Tech Stack:** Electron 44 / electron-builder 26.15.3 / `codesign`·`notarytool`·`stapler`·`vtool` / uv 0.8.16 / NestJS 10 / Python 3.12 / bash

**Spec:** [docs/superpowers/specs/2026-09-20-electron-phase-6a-signing-distribution-design.md](../specs/2026-09-20-electron-phase-6a-signing-distribution-design.md) (`b871421`)

## Global Constraints

이 절의 값은 스펙에서 그대로 옮긴 것이다. **모든 Task의 요구사항에 암묵적으로 포함된다.**

- **최소 macOS는 `15.0`이다.** 세 자리에 같은 값이 들어간다 — `MACOSX_DEPLOYMENT_TARGET`, `LSMinimumSystemVersion`, `check-bundle`의 `minos` 상한.
- **서명 identity는 sha1 지문 `C35965CC0997E3897DED5C0975B4064D8AA4E27A`다** (`Developer ID Application: Youngjae Kim (L5Y9SZHGRN)`). **이름이 아니라 지문을 쓴다** — 이 키체인에 동명 `iPhone Distribution` 항목이 넷 있고, 2026-09-13에 이름 중복이 `codesign`을 `ambiguous`로 실패시킨 적이 있다.
- **Team ID는 `L5Y9SZHGRN`.** notarytool 키체인 프로필 이름은 `damwha`.
- **안쪽을 먼저 서명한다.** `.app` 서명이 Resources를 해시로 봉인하므로 순서가 뒤집히면 `codesign --verify`가 깨진다.
- **plist는 둘로 갈린다.** `build-resources/entitlements.python.plist`(키 둘) → `Resources/python`의 Mach-O 전수 + `Resources/ffmpeg/bin/*`. `build-resources/entitlements.mac.plist`(키 셋, `allow-jit` 추가) → `.app`에 `--deep`. **`.app`에 python plist를 주면 V8이 `allow-jit` 없이 rc=133으로 죽는다.**
- **`Resources/postgres`에는 hardened runtime을 걸지 않는다.** 별개 프로세스라 자기 서명의 플래그로 돈다. identity는 확인하되 runtime 플래그는 단언하지 않는다.
- **서명한 뒤 번들 python을 실행하지 않는다.** `__pycache__`가 봉인 밖에 생기고 `.pyc`에 빌드 머신의 절대 경로가 박힌다.
- **데스크톱 태그는 `desktop-v<version>`이다.** `deploy/release.sh`가 쓰는 `v<version>`과 섞지 않는다 — 그 스크립트는 태그 버전이 `be/worker/pyproject.toml`과 다르면 거절하고, 섞으면 6b의 릴리스 조회가 웹 배포를 가리킨다.
- **버전의 단일 진실 원천은 `desktop/package.json`의 `version`이다.** 이 Phase가 내는 값은 `0.3.0`.
- **`--release`가 이 Phase의 유일한 새 플래그다.** 없으면 지금과 같다(`--dir`, DMG·공증·릴리스 없음). 개발 루프의 시간이 늘지 않는다.
- **사유 문구를 새로 만들지 않는다.** `desktop/src/diagnostics/causes.ts`의 `diskFull`이 이미 모양을 정했다(`디스크 공간이 부족해요 — 남은 용량 X, 필요한 용량 Y`). 그 파일의 머리 주석이 사본 만들기를 금한다.
- **작업 디렉터리 규칙.** 루트에서 패키지를 직접 띄우지 않는다. `desktop` 명령은 `desktop/`에서, worker는 `uv run --directory be/worker`로.

---

## File Structure

| 경로 | 신규/수정 | 맡는 일 |
| --- | --- | --- |
| `desktop/scripts/lib/build-target.sh` | 신규 | `MACOSX_DEPLOYMENT_TARGET` 한 값. 두 빌드 스크립트가 source한다 |
| `desktop/scripts/build-postgres.sh` | 수정 | 위 값을 export하고 `configure` 앞에 둔다 |
| `desktop/scripts/build-ffmpeg.sh` | 수정 | 같음 |
| `desktop/scripts/mlx-pin.txt` | 신규 | macOS 15.0용 mlx·mlx-metal 휠 URL + sha256 + 버전 |
| `desktop/scripts/build-python.sh` | 수정 | `uv pip install` 뒤에 위 두 휠 고정 단계 |
| `desktop/scripts/lib/minos.mjs` | 신규 | Mach-O 하나의 `minos`를 읽는다. `check-bundle`이 쓴다 |
| `desktop/scripts/signing.json` | 신규 | 서명 지문·팀 ID·notary 프로필. 비밀이 아니다 |
| `desktop/scripts/lib/signing.mjs` | 신규 | `signing.json`을 읽고 키체인에 그 지문이 있는지 확인 |
| `desktop/scripts/package.mjs` | 수정 | `--release` 플래그, Developer ID 서명, 공증·스테이플·DMG·릴리스 |
| `desktop/scripts/check-bundle.mjs` | 수정 | `minos`·asar·버전·identity·공증 단언 추가 |
| `desktop/electron-builder.yml` | 수정 | `LSMinimumSystemVersion` |
| `be/worker/damwha_worker/models/disk.py` | 신규 | 여유 용량 판정 한 곳. 세 주체가 공유 |
| `be/worker/damwha_worker/models/downloads.py` | 수정 | 훅 설치 시 디스크 점검을 끼운다 |
| `be/worker/damwha_worker/errors.py` | 수정 | `DISK_FULL` 코드 |
| `be/src/storage/disk-full.filter.ts` | 신규 | ENOSPC → 507 |
| `be/src/app.module.ts` 또는 `main.ts` | 수정 | 위 필터 등록 |
| `desktop/src/diagnostics/causes.ts` | 수정 | `diskFull` 어댑터 연결 (문구는 그대로) |
| `fe/src/…` | 수정 | 507 사유 코드를 화면 문구로 |

---

## Task 1: 최소 macOS 15.0 — 소스 빌드 둘

**Files:**
- Create: `desktop/scripts/lib/build-target.sh`
- Modify: `desktop/scripts/build-postgres.sh:155`, `desktop/scripts/build-ffmpeg.sh:120`

**Interfaces:**
- Consumes: 없음 (첫 Task)
- Produces: `desktop/scripts/lib/build-target.sh`가 `MACOSX_DEPLOYMENT_TARGET=15.0`을 export한다. Task 2·5가 같은 파일을 읽는다.

**왜 `--fresh`가 필요 없나:** 두 스크립트의 캐시 키가 **스크립트 자신의 sha256을 포함한다**(`build-postgres.sh:48`, `build-ffmpeg.sh:52`). 스크립트를 고치면 키가 바뀌어 새 트리가 난다. 옛 `pg-<옛키>`·`ffmpeg-<옛키>`는 `desktop/.cache`에 남으므로 디스크 여유를 먼저 본다.

- [ ] **Step 1: 지금 값을 기준선으로 남긴다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
df -h . | tail -1
for f in .cache/postgres/pg-*/bin/postgres .cache/ffmpeg/ffmpeg-*/bin/ffmpeg; do
  [ -f "$f" ] && echo "$(xcrun vtool -show-build "$f" 2>/dev/null | grep -m1 minos | awk '{print $2}')  $f"
done
```

기대: 둘 다 `27.0`. 이 줄을 결과 기록에 남긴다 — Task 4의 단언이 무엇을 고쳤는지 이것만이 보인다.

- [ ] **Step 2: 공용 상수 파일을 만든다**

`desktop/scripts/lib/build-target.sh`:

```bash
# desktop/scripts/lib/build-target.sh
# 번들 전체가 목표하는 최소 macOS. build-postgres.sh·build-ffmpeg.sh가 source하고,
# build-python.sh의 mlx 휠 고정(mlx-pin.txt)과 electron-builder.yml의
# LSMinimumSystemVersion, check-bundle.mjs의 minos 상한이 **같은 값**이어야 한다.
#
# 15.0인 이유 (Phase 6a 스펙 §5.1): 우리가 못 내리는 바닥은 PyPI 휠의 14.0인데,
# mlx만 14.0 아래 휠이 없고 15.0은 있다. 14.0으로 더 내리려면 mlx 0.29.x까지 내려가
# mlx-whisper·mlx-lm 호환 조합을 다시 찾고 STT·요약 품질을 재측정해야 한다.
#
# 이 값을 올리면 두 스크립트의 캐시 키(자기 sha256을 포함하지 않는다 — 아래 주의)가
# 바뀌지 않는다. 그래서 두 스크립트의 KEY 계산에 이 파일의 sha256도 넣는다.
export MACOSX_DEPLOYMENT_TARGET=15.0
```

- [ ] **Step 3: `build-postgres.sh`가 그것을 읽게 한다**

`build-postgres.sh`에서 `KEY=` 줄(48행) **앞에** source를 넣고, `KEY` 계산에 이 파일의 해시를 더한다.

```bash
# (SUMS·SCRIPT 정의 뒤, KEY= 앞)
TARGET_LIB="$DESKTOP/scripts/lib/build-target.sh"
# shellcheck source=lib/build-target.sh
. "$TARGET_LIB"

KEY=$( { echo "$PG_VERSION $PGVECTOR_VERSION $PG_BIGM_VERSION $BUILD_PREFIX $MACOSX_DEPLOYMENT_TARGET"; \
         shasum -a 256 "$SUMS" "$SCRIPT" "$TARGET_LIB" | awk '{print $1}'; } | shasum -a 256 | cut -c1-16)
```

`MACOSX_DEPLOYMENT_TARGET`은 export되어 있으므로 155행의 `./configure`가 그대로 받는다. **`configure` 줄은 고치지 않는다.**

- [ ] **Step 4: `build-ffmpeg.sh`에 같은 것을 한다**

```bash
TARGET_LIB="$DESKTOP/scripts/lib/build-target.sh"
# shellcheck source=lib/build-target.sh
. "$TARGET_LIB"

KEY=$( { echo "$FFMPEG_VERSION $BUILD_PREFIX $MACOSX_DEPLOYMENT_TARGET"; \
         shasum -a 256 "$SUMS" "$SCRIPT" "$TARGET_LIB" | awk '{print $1}'; } | shasum -a 256 | cut -c1-16)
```

- [ ] **Step 5: 새 키가 나오는지 먼저 본다 (빌드 전)**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
bash -n scripts/build-postgres.sh && bash -n scripts/build-ffmpeg.sh && echo "문법 OK"
```

기대: `문법 OK`. 문법 오류로 두 시간짜리 빌드를 날리지 않는다.

- [ ] **Step 6: 재빌드**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
bash scripts/build-postgres.sh 2>&1 | tail -20
bash scripts/build-ffmpeg.sh 2>&1 | tail -20
```

기대: 캐시 미스로 새로 빌드하고 새 키의 트리가 난다. postgres ~3분, ffmpeg ~4분(실측 범위).

- [ ] **Step 7: 실측으로 확인 — 선언만 바뀌고 산출물이 안 따라올 수 있다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
for root in build/postgres build/ffmpeg; do
  echo "== $root"
  /usr/bin/find "$root" -type f -print0 | while IFS= read -r -d '' f; do
    v=$(xcrun vtool -show-build "$f" 2>/dev/null | grep -m1 minos | awk '{print $2}')
    [ -n "$v" ] && echo "$v"
  done | sort -V | uniq -c
done
```

기대: 두 트리 모두 `15.0`만. **다른 값이 하나라도 있으면 멈추고 그 파일의 빌드 경로를 따로 본다** — 일부 서브 빌드가 자기 플래그를 쓴다(스펙 §12-4).

- [ ] **Step 8: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/lib/build-target.sh desktop/scripts/build-postgres.sh desktop/scripts/build-ffmpeg.sh
git commit -m "build(phase6a): postgres·ffmpeg를 macOS 15.0 타깃으로 빌드한다

두 스크립트가 MACOSX_DEPLOYMENT_TARGET 없이 빌드해 호스트 SDK(27.0)를 상속했다.
그 결과 번들이 macOS 27 미만에서 뜨지 않았다. 값을 lib/build-target.sh 한 곳에
두고 두 스크립트가 source한다 — 한쪽만 올라가면 바닥이 조용히 갈린다.
캐시 키에 그 파일의 해시도 넣어 값이 바뀌면 재빌드되게 했다."
```

**Verify:** Step 7의 출력이 두 트리 모두 `15.0`만. Step 1의 기준선(`27.0`)과 대조해 실제로 바뀌었음을 보인다.

**Review:** `configure` 줄과 플래그가 하나도 바뀌지 않았는지 (`git diff`로 확인 — ffmpeg는 LGPL 라이선스 검사가 configure 플래그에 걸려 있다). 캐시 키에 `TARGET_LIB` 해시가 들어갔는지. 옛 캐시 트리를 지우지 않았는지(되돌릴 길을 남긴다).

---

## Task 2: 최소 macOS 15.0 — mlx 두 휠

**Files:**
- Create: `desktop/scripts/mlx-pin.txt`
- Modify: `desktop/scripts/build-python.sh:106` (`RT_KEY`), `:536-537` (`uv pip install` 뒤)

**Interfaces:**
- Consumes: Task 1의 `desktop/scripts/lib/build-target.sh` (값 대조용)
- Produces: `desktop/build/python/lib/python3.12/site-packages/mlx`의 `minos`가 15.0. Task 4의 단언이 이것에 기댄다.

**왜 `--python-platform`이 아닌가:** uv 0.8.16의 `--python-platform`에는 macOS 버전 knob이 없고, `aarch64-apple-darwin`은 `macosx_13_0_arm64`로 내려가 mlx 해석이 `unsatisfiable`이 된다(스펙 §3-10 실측). 26.0 휠을 집는 패키지가 `mlx`·`mlx-metal` 둘뿐이므로 그 둘만 URL로 못 박는다.

- [ ] **Step 1: 핀 파일을 만든다**

`desktop/scripts/mlx-pin.txt`:

```
# desktop/scripts/mlx-pin.txt
# macOS 15.0용 mlx 휠. build-python.sh가 uv pip install 뒤에 이 둘로 갈아 끼운다.
#
# **왜 있나** (Phase 6a 스펙 §5.3): uv는 호스트의 macOS 버전(27.0)에 맞는 가장 높은 태그의
# 휠을 집는다. mlx는 macosx_14_0 / 15_0 / 26_0 셋을 내므로 이 맥에서 그냥 깔면 26.0이 들어와
# 번들 전체의 바닥이 26.0이 된다. uv의 --python-platform으로는 "macOS 15"를 표현할 수 없다
# (값 목록에 버전 knob이 없고, aarch64-apple-darwin은 macosx_13_0으로 내려가 mlx 해석이
# unsatisfiable이 된다 — 2026-09-20 실측).
#
# **핀을 올릴 때**: be/worker/pyproject.toml의 mlx 버전과 아래 VERSION이 같아야 한다.
# 스크립트가 다르면 멈춘다. 새 URL은 PyPI의 그 버전 JSON에서 macosx_15_0_arm64 휠을 찾는다.
VERSION=0.31.2
mlx https://files.pythonhosted.org/packages/08/e7/a851a451b1327af9fb4df3991b9ae87d066b6f6630e854af55c288b0995a/mlx-0.31.2-cp312-cp312-macosx_15_0_arm64.whl edb9797db7d852477ca1c99708058654ee860d4148fe5765f0d55528e2b1aa22
mlx-metal https://files.pythonhosted.org/packages/4f/5d/4c690d5b93c30ba002656c37363159d978705bf8eb801b8481840fb942c2/mlx_metal-0.31.2-py3-none-macosx_15_0_arm64.whl e9d4e5fce6ca10a87a0e388597f99519ad594d09e674708b5312bd8bd4f5997d
```

- [ ] **Step 2: `build-target.sh`를 source하고 `RT_KEY`에 둘을 넣는다**

`build-python.sh:106`의 `RT_KEY=` **앞에** 넣는다. **이 스크립트는 `set -euo pipefail`이다**(31행) — source 없이 `$MACOSX_DEPLOYMENT_TARGET`을 쓰면 unbound variable로 그 자리에서 죽는다.

```bash
TARGET_LIB="$DESKTOP/scripts/lib/build-target.sh"
MLX_PIN="$DESKTOP/scripts/mlx-pin.txt"
[ -f "$TARGET_LIB" ] || die "$TARGET_LIB 가 없다"
[ -f "$MLX_PIN" ] || die "$MLX_PIN 이 없다"
# shellcheck source=lib/build-target.sh
. "$TARGET_LIB"

RT_KEY=$( { echo "$PY_FULL $PBS_RELEASE $MACOSX_DEPLOYMENT_TARGET"; \
            shasum -a 256 "$SUMS" "$SCRIPT" "$ENTS" "$REQS" "$TARGET_LIB" "$MLX_PIN" | awk '{print $1}'; } \
          | shasum -a 256 | cut -c1-16)
```

핀이나 배포 타깃이 바뀌면 런타임 층이 새로 난다.

- [ ] **Step 3: 핀 버전이 `pyproject.toml`과 같은지 단언한다**

`uv pip install`(536행) **앞에** 넣는다.

```bash
MLX_PIN_VERSION=$(sed -n 's/^VERSION=//p' "$MLX_PIN")
MLX_LOCK_VERSION=$(sed -n 's/.*"mlx==\([0-9.]*\)".*/\1/p' "$WORKER/pyproject.toml" | head -1)
[ -n "$MLX_PIN_VERSION" ] || die "mlx-pin.txt에 VERSION= 줄이 없다"
[ "$MLX_PIN_VERSION" = "$MLX_LOCK_VERSION" ] \
  || die "mlx-pin.txt는 $MLX_PIN_VERSION, pyproject.toml은 $MLX_LOCK_VERSION — 핀을 맞춰라"
```

- [ ] **Step 4: 설치 뒤 두 휠로 갈아 끼운다**

`build-python.sh:537`의 `uv pip install ... -r requirements.txt` **바로 뒤에**:

```bash
  # macOS 15.0 휠로 갈아 끼운다. 위 uv pip install은 호스트(27.0)에 맞춰 26.0 휠을 집는다.
  # --no-deps: 의존성 해석을 다시 돌리지 않는다. --reinstall: 같은 버전이라 그냥은 안 바꾼다.
  say "3b. mlx를 macOS ${MACOSX_DEPLOYMENT_TARGET} 휠로 고정"
  MLX_URLS=$(awk '$1=="mlx"||$1=="mlx-metal"{print $2}' "$MLX_PIN")
  [ "$(echo "$MLX_URLS" | wc -l)" -eq 2 ] || die "mlx-pin.txt에 휠 URL이 둘이 아니다"
  # shellcheck disable=SC2086
  uv pip install --python "$RT_WORK/python/bin/python$PY_VERSION" --link-mode=copy \
     --reinstall --no-deps $MLX_URLS || die "mlx 15.0 휠 고정 실패"

  # 받은 것이 핀의 그 바이트인지 확인한다. URL만 맞고 내용이 다를 수 있다.
  while read -r name url sha; do
    case "$name" in ''|'#'*|VERSION=*) continue;; esac
    got=$(curl -sL "$url" | shasum -a 256 | awk '{print $1}')
    [ "$got" = "$sha" ] || die "$name 휠의 sha256이 다르다: $got != $sha"
  done < "$MLX_PIN"
```

- [ ] **Step 5: 재빌드**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
bash scripts/build-python.sh --print-key    # 새 rt 키가 나오는지 먼저 본다
bash scripts/build-python.sh 2>&1 | tail -25
```

기대: `--print-key`가 캐시 미스를 보고하고, 본 실행이 런타임 층(~140초) + worker 층(~150초)을 새로 짓는다.

- [ ] **Step 6: mlx가 15.0인지 확인**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
for f in build/python/lib/python3.12/site-packages/mlx/core.cpython-312-darwin.so \
         build/python/lib/python3.12/site-packages/mlx/lib/libmlx.dylib \
         build/python/lib/python3.12/site-packages/mlx/lib/libjaccl.dylib; do
  echo "$(xcrun vtool -show-build "$f" 2>/dev/null | grep -m1 minos | awk '{print $2}')  $f"
done
```

기대: 셋 다 `15.0`.

- [ ] **Step 7: 파이썬 트리 전체에 15.0 초과가 없는지**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
/usr/bin/find build/python \( -name "*.dylib" -o -name "*.so" -o -path "*/bin/*" \) -type f -print0 |
while IFS= read -r -d '' f; do
  v=$(xcrun vtool -show-build "$f" 2>/dev/null | grep -m1 minos | awk '{print $2}')
  [ -n "$v" ] && echo "$v"
done | sort -V | uniq -c
```

기대: 최대값이 `15.0`. (대부분은 11.0·12.0·14.0이다.)

- [ ] **Step 8: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/mlx-pin.txt desktop/scripts/build-python.sh
git commit -m "build(phase6a): mlx를 macOS 15.0 휠로 고정한다

uv는 호스트(27.0)에 맞는 가장 높은 태그의 휠을 집으므로 mlx·mlx-metal이
macosx_26_0으로 들어와 번들 바닥을 26.0으로 올렸다. uv의 --python-platform에는
macOS 버전 knob이 없고 aarch64-apple-darwin은 macosx_13_0으로 내려가 mlx 해석이
unsatisfiable이 된다. 26.0 휠을 집는 패키지가 이 둘뿐이라 URL로 못 박는다.
핀 버전이 pyproject.toml과 어긋나면 빌드가 멈추고, 받은 휠의 sha256도 확인한다."
```

**Verify:** Step 6·7. 그리고 워커 테스트가 여전히 통과: `pnpm worker:test`.

**Review:** `pyproject.toml`의 핀은 건드리지 않았는지. `--no-deps`가 붙었는지(없으면 해석이 다시 돌아 다른 것까지 바뀐다). sha256 확인이 `die`로 멈추는지. `wk` 층에는 손대지 않았는지.

---

## Task 3: `minos` 판독기와 asar 단언

**Files:**
- Create: `desktop/scripts/lib/minos.mjs`
- Create: `desktop/tests/scripts/minos.test.ts`
- Modify: `desktop/scripts/check-bundle.mjs`

**Interfaces:**
- Consumes: `desktop/scripts/lib/macho.mjs`의 `machOFiles(root)` — 트리 안 Mach-O 경로 배열
- Produces:
  - `readMinos(file: string): string | null` — `"15.0"` 꼴 또는 Mach-O가 아니면 `null`
  - `compareVersion(a: string, b: string): number` — `-1|0|1`
  - `MAX_MINOS: string` — `"15.0"`

**왜 별도 Task인가:** Task 4가 이 단언을 켜기 전에 판독기 자체가 맞아야 한다. `vtool` 출력 파싱이 틀리면 "전부 통과"라는 거짓을 낸다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/scripts/minos.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { compareVersion, readMinos } from "../../scripts/lib/minos.mjs";

describe("compareVersion", () => {
  it("메이저가 다르면 메이저로 가른다", () => {
    expect(compareVersion("15.0", "26.0")).toBe(-1);
    expect(compareVersion("27.0", "15.0")).toBe(1);
  });
  it("마이너까지 본다", () => {
    expect(compareVersion("15.1", "15.0")).toBe(1);
    expect(compareVersion("15.0", "15.0")).toBe(0);
  });
  it("자릿수가 다른 마이너를 문자열로 비교하지 않는다", () => {
    // "15.10" < "15.9" 가 되면 안 된다
    expect(compareVersion("15.10", "15.9")).toBe(1);
  });
  it("세 자리도 받는다", () => {
    expect(compareVersion("15.0.1", "15.0")).toBe(1);
  });
});

describe("readMinos", () => {
  it("Mach-O가 아닌 파일에는 null이다", () => {
    expect(readMinos("package.json")).toBeNull();
  });
  it("시스템 바이너리에서 값을 읽는다", () => {
    const v = readMinos("/bin/echo");
    expect(v).not.toBeNull();
    expect(v).toMatch(/^\d+\.\d+/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
pnpm exec vitest run tests/scripts/minos.test.ts
```

기대: FAIL — `Cannot find module '../../scripts/lib/minos.mjs'`.

- [ ] **Step 3: 판독기를 쓴다**

`desktop/scripts/lib/minos.mjs`:

```javascript
// desktop/scripts/lib/minos.mjs
// Mach-O의 최소 macOS 선언(LC_BUILD_VERSION의 minos, 옛 바이너리는 LC_VERSION_MIN_MACOSX)을 읽는다.
//
// **왜 있나** (Phase 6a 스펙 §5.4): 번들 전체의 minos 최대값이 배포 가능한 최소 macOS를 정한다.
// 이 단언이 없으면 다음에 누가 의존성을 올리거나 새 SDK에서 빌드할 때 바닥이 **조용히** 올라간다 —
// 2026-09-20에 실제로 그랬다(postgres·ffmpeg가 27.0, mlx가 26.0이었고 이 맥이 27.0이라 안 보였다).
import { spawnSync } from "node:child_process";

/** 번들이 허용하는 최대 minos. lib/build-target.sh·electron-builder.yml과 **같은 값**이어야 한다. */
export const MAX_MINOS = "15.0";

/** "15.10" > "15.9"가 되게 숫자로 비교한다. 문자열 비교는 그 자리에서 틀린다. */
export function compareVersion(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 파일의 minos. Mach-O가 아니거나 빌드 버전 로드 커맨드가 없으면 null.
 *
 * fat 바이너리는 슬라이스마다 한 블록씩 나오므로 **가장 높은 값**을 쓴다 — 낮은 쪽만 보면
 * 실제로 못 뜨는 슬라이스를 통과시킨다.
 */
export function readMinos(file) {
  const r = spawnSync("xcrun", ["vtool", "-show-build", file], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const out = r.stdout ?? "";
  const found = [];
  for (const m of out.matchAll(/^\s*(?:minos|version)\s+(\d+(?:\.\d+)*)\s*$/gm)) found.push(m[1]);
  if (found.length === 0) return null;
  return found.reduce((hi, v) => (compareVersion(v, hi) > 0 ? v : hi));
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
pnpm exec vitest run tests/scripts/minos.test.ts
```

기대: PASS 6건.

- [ ] **Step 5: `check-bundle.mjs`에 단언 둘을 더한다**

파일 머리의 import에 더한다:

```javascript
import { MAX_MINOS, compareVersion, readMinos } from "./lib/minos.mjs";
```

`app.asar` 단언(2번) 바로 뒤에 asar Mach-O 단언을 넣는다:

```javascript
// 2c. app.asar 안에 Mach-O가 없다. 아래 minos 전수 검사는 파일시스템 트리만 훑으므로
// asar 안은 보지 못한다 — 네이티브 모듈이 들어오면 "전수"가 거짓이 된다. 지금은 열 것이
// 없지만(desktop에 runtime 의존성 0개, 위 2번이 node_modules 부재를 단언한다) 그 성질이
// 유지되는지는 따로 물어야 한다 (Phase 6a 스펙 §5.4).
if (fs.existsSync(asarPath)) {
  const nativeExt = [".node", ".dylib", ".so"];
  const native = asar
    .listPackage(asarPath, { isPack: false })
    .filter((e) => nativeExt.some((x) => e.endsWith(x)));
  check("app.asar has no native modules", native.length === 0, native.join(", "));
}
```

파일 끝의 실패 집계 **앞에** minos 전수 단언을 넣는다:

```javascript
// 22. 번들 Mach-O 전수의 minos가 MAX_MINOS 이하다 (Phase 6a 스펙 §5.4, P6a-C1).
// 이 하나가 최소 macOS 바닥 전체의 회귀 방지다. 대상은 Contents/ 전부 — Resources의 세 트리와
// Electron 프레임워크·헬퍼까지.
const overMinos = [];
for (const f of machOFiles(contents)) {
  const v = readMinos(f);
  if (v !== null && compareVersion(v, MAX_MINOS) > 0) overMinos.push(`${path.relative(contents, f)}=${v}`);
}
check(
  `every Mach-O in the bundle targets macOS ${MAX_MINOS} or lower`,
  overMinos.length === 0,
  // 전부 보고한다 — 하나만 보이면 원인 패키지를 못 찾는다.
  overMinos.join(", "),
);
```

- [ ] **Step 6: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/lib/minos.mjs desktop/tests/scripts/minos.test.ts desktop/scripts/check-bundle.mjs
git commit -m "build(phase6a): 번들 minos 전수 단언과 asar 네이티브 모듈 단언을 더한다

번들 Mach-O의 minos 최대값이 배포 가능한 최소 macOS를 정하는데, 그것을 묻는
자리가 없어 2026-09-20까지 바닥이 27.0인 줄 몰랐다. 이 단언이 회귀 방지다.
fat 바이너리는 슬라이스 중 가장 높은 값을 쓴다 — 낮은 쪽만 보면 실제로 못 뜨는
슬라이스를 통과시킨다. 버전 비교는 숫자로 한다(15.10 > 15.9).
asar 안은 파일시스템 순회가 보지 못하므로 네이티브 모듈 부재를 따로 단언한다."
```

**Verify:** `pnpm exec vitest run tests/scripts/minos.test.ts` 6건 PASS. `check-bundle.mjs`는 `.app`이 있어야 돌므로 Task 5에서 종단간 확인한다.

**Review:** `compareVersion`이 문자열 비교가 아닌지. `readMinos`가 fat 바이너리에서 **최대값**을 고르는지. 초과 파일을 `slice`로 자르지 않고 전부 보고하는지. `MAX_MINOS`가 `lib/build-target.sh`의 값과 같은지.

---

## Task 4: 15.0 바닥 종단간 확인

**Files:**
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/scripts/check-bundle.mjs` (버전 일치 단언)

**Interfaces:**
- Consumes: Task 1·2의 빌드 산출물, Task 3의 `readMinos`·`MAX_MINOS`
- Produces: `Info.plist`에 `LSMinimumSystemVersion=15.0`. Task 7의 원격 검증이 이것에 기댄다.

- [ ] **Step 1: `LSMinimumSystemVersion`을 박는다**

`desktop/electron-builder.yml`의 `mac.extendInfo`에 더한다 (기존 `NSMicrophoneUsageDescription` 옆):

```yaml
  extendInfo:
    # 없으면 macOS가 마이크 요청 시 앱을 죽인다 (스펙 §6.6).
    NSMicrophoneUsageDescription: 담화가 회의를 녹음하려면 마이크를 사용해요. 녹음과 처리는 이 맥 안에서만 일어나요.
    # 번들 Mach-O의 minos 최대값과 **같은 값**이어야 한다 (Phase 6a 스펙 §5.4).
    # scripts/lib/build-target.sh·scripts/lib/minos.mjs의 MAX_MINOS가 같은 값을 든다.
    # 이것만 낮추면 Finder는 실행을 허용하고 dyld가 죽인다.
    LSMinimumSystemVersion: "15.0"
```

- [ ] **Step 2: `check-bundle.mjs`에 plist 단언 둘을 더한다**

기존 `Info.plist` 검사 근처(`NSMicrophoneUsageDescription` 단언 옆)에 넣는다:

```javascript
// 6b. 최소 macOS 선언이 번들의 실제 바닥과 같다 (P6a-C2). 셋이 한 값이어야 한다 —
// 이 plist 키, scripts/lib/build-target.sh, minos.mjs의 MAX_MINOS.
const lsMin = plistValue("LSMinimumSystemVersion");
check(`Info.plist LSMinimumSystemVersion is ${MAX_MINOS}`, lsMin === MAX_MINOS, lsMin || "(not found)");

// 6c. 앱 버전이 package.json과 같다 (P6a-C2). 어긋나면 6b의 업데이트 알림이
// 자기보다 낮은 버전을 "새 버전"이라 말한다.
const shortVersion = plistValue("CFBundleShortVersionString");
check("Info.plist CFBundleShortVersionString equals package.json version", shortVersion === pkg.version,
  `plist=${shortVersion || "(none)"} package.json=${pkg.version}`);
```

`plistValue`가 없으면 기존 `Info.plist` 읽는 방식을 따라 헬퍼를 하나 둔다:

```javascript
// Info.plist에서 문자열 값 하나. PlistBuddy는 없을 수 있으므로 plutil로 JSON을 떠서 읽는다.
let infoPlistJson = null;
function plistValue(key) {
  if (infoPlistJson === null) {
    const r = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")], { encoding: "utf8" });
    infoPlistJson = r.status === 0 ? JSON.parse(r.stdout) : {};
  }
  const v = infoPlistJson[key];
  return typeof v === "string" ? v : "";
}
```

- [ ] **Step 3: 버전을 0.3.0으로 올린다**

`desktop/package.json`의 `"version": "0.2.3"` → `"0.3.0"`.

- [ ] **Step 4: 패키징하고 단언을 돌린다**

**`out/`을 통째로 지운다** — 파일만 지우면 Finder의 `.DS_Store` 때문에 `ENOTEMPTY`가 난다.

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
rm -rf out
pnpm run package:desktop 2>&1 | tail -40
```

기대: `check-bundle`이 새 단언 넷(minos 전수, asar 네이티브, `LSMinimumSystemVersion`, 버전 일치)을 포함해 전부 통과.

- [ ] **Step 5: minos 단언이 **실제로 무언가를 막는지** 시험한다**

통과만 보면 단언이 늘 참을 내는 빈 그물일 수 있다.

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
# 27.0짜리 Mach-O를 하나 심어 넣고 단언이 그것을 잡는지 본다.
cp /bin/echo out/mac-arm64/Damwha.app/Contents/Resources/ffmpeg/bin/_minos_probe
xcrun vtool -set-build-version macos 27.0 27.0 -replace \
  -output out/mac-arm64/Damwha.app/Contents/Resources/ffmpeg/bin/_minos_probe \
  out/mac-arm64/Damwha.app/Contents/Resources/ffmpeg/bin/_minos_probe
node scripts/check-bundle.mjs; echo "종료코드 $?"
rm -f out/mac-arm64/Damwha.app/Contents/Resources/ffmpeg/bin/_minos_probe
```

기대: 비영 종료 + 실패 메시지에 `_minos_probe=27.0`이 **경로와 함께** 나온다. 나오지 않으면 단언이 그물이 아니다.

- [ ] **Step 6: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/electron-builder.yml desktop/scripts/check-bundle.mjs desktop/package.json
git commit -m "build(phase6a): 최소 macOS 15.0을 선언하고 버전을 0.3.0으로 올린다

LSMinimumSystemVersion이 번들의 실제 minos 바닥과 같은지, 앱 버전이
package.json과 같은지를 check-bundle이 본다. 후자가 어긋나면 6b의 업데이트
알림이 자기보다 낮은 버전을 새 버전이라 말한다."
```

**Verify:** Step 4의 `check-bundle` 전부 통과 + Step 5에서 심은 27.0 파일을 **경로와 함께** 잡고 비영 종료.

**Review:** Step 5의 probe를 지웠는지(번들에 남으면 서명이 깨진다). 세 자리의 `15.0`이 정말 같은 값인지. `plutil`이 없는 환경을 가정하지 않았는지(macOS 기본 탑재라 괜찮다).

---

## Task 5: Developer ID 서명 전환

**Files:**
- Create: `desktop/scripts/signing.json`
- Create: `desktop/scripts/lib/signing.mjs`
- Create: `desktop/tests/scripts/signing.test.ts`
- Modify: `desktop/scripts/package.mjs:112-135`
- Modify: `desktop/scripts/check-bundle.mjs`

**Interfaces:**
- Consumes: 키체인의 Developer ID identity (이미 설치됨)
- Produces:
  - `loadSigning(desktopDir: string): { identity: string; teamId: string; notaryProfile: string }`
  - `assertIdentityInKeychain(identity: string): void` — 없으면 throw
  - Task 6의 공증이 이 signing.json을 읽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/scripts/signing.test.ts`:

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSigning } from "../../scripts/lib/signing.mjs";

function tmpWith(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signing-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "signing.json"), contents);
  return dir;
}

describe("loadSigning", () => {
  it("세 값을 읽는다", () => {
    const dir = tmpWith(JSON.stringify({ identity: "ABC123", teamId: "L5Y9SZHGRN", notaryProfile: "damwha" }));
    expect(loadSigning(dir)).toEqual({ identity: "ABC123", teamId: "L5Y9SZHGRN", notaryProfile: "damwha" });
  });

  it("파일이 없으면 던진다 — ad-hoc으로 조용히 떨어지지 않는다", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signing-"));
    fs.mkdirSync(path.join(dir, "scripts"));
    expect(() => loadSigning(dir)).toThrow(/signing\.json/);
  });

  it("identity가 sha1 지문 모양이 아니면 던진다 — 이름은 중복될 수 있다", () => {
    const dir = tmpWith(JSON.stringify({ identity: "Developer ID Application: Someone", teamId: "X", notaryProfile: "y" }));
    expect(() => loadSigning(dir)).toThrow(/지문/);
  });

  it("키가 하나라도 빠지면 던진다", () => {
    const dir = tmpWith(JSON.stringify({ identity: "A".repeat(40) }));
    expect(() => loadSigning(dir)).toThrow(/teamId/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
pnpm exec vitest run tests/scripts/signing.test.ts
```

기대: FAIL — 모듈 없음.

- [ ] **Step 3: `signing.json`과 로더를 쓴다**

`desktop/scripts/signing.json`:

```json
{
  "identity": "C35965CC0997E3897DED5C0975B4064D8AA4E27A",
  "teamId": "L5Y9SZHGRN",
  "notaryProfile": "damwha"
}
```

`desktop/scripts/lib/signing.mjs`:

```javascript
// desktop/scripts/lib/signing.mjs
// 서명 신원을 한 곳에서 읽는다. **비밀이 아니다** — 지문과 팀 ID는 서명된 바이너리에서 누구나
// 읽을 수 있고, notary 프로필은 키체인 항목의 이름일 뿐이다. 개인 키는 이 저장소에 없다.
//
// **이름이 아니라 지문을 쓴다** (Phase 6a 스펙 §6): 2026-09-13에 이 맥의 키체인에 이름이 같은
// "Apple Development" 인증서가 둘 생기자 codesign이 `ambiguous`로 실패했다. 지금도 동명
// "iPhone Distribution" 항목이 넷 있다.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const FINGERPRINT = /^[0-9A-F]{40}$/;

/** scripts/signing.json을 읽고 모양을 확인한다. 없거나 어긋나면 **던진다** — ad-hoc 폴백은 없다. */
export function loadSigning(desktopDir) {
  const file = path.join(desktopDir, "scripts", "signing.json");
  if (!fs.existsSync(file)) {
    throw new Error(`scripts/signing.json이 없다 — 서명 없이 패키징하지 않는다: ${file}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const key of ["identity", "teamId", "notaryProfile"]) {
    if (typeof raw[key] !== "string" || raw[key] === "") throw new Error(`signing.json에 ${key}가 없다`);
  }
  if (!FINGERPRINT.test(raw.identity)) {
    throw new Error(`signing.json의 identity는 sha1 지문 40자여야 한다 (이름은 중복될 수 있다): ${raw.identity}`);
  }
  return { identity: raw.identity, teamId: raw.teamId, notaryProfile: raw.notaryProfile };
}

/** 그 지문이 이 키체인에 실제로 있는지. 없으면 빌드를 여기서 멈춘다 — 서명 실패는 늦게 알수록 비싸다. */
export function assertIdentityInKeychain(identity) {
  const r = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("security find-identity 실패");
  if (!(r.stdout ?? "").includes(identity)) {
    throw new Error(`키체인에 서명 신원 ${identity}가 없다. ~/Documents/damwha-signing의 .p12를 import해라`);
  }
}

/** codesign 한 번. --timestamp는 공증의 선행 조건이고 인증서 만료 뒤에도 서명을 유효하게 한다. */
export function codesign(identity, entitlements, targets, extraArgs = []) {
  execFileSync(
    "codesign",
    ["--force", "--sign", identity, "--options", "runtime", "--timestamp",
     "--entitlements", entitlements, ...extraArgs, ...targets],
    { stdio: "inherit" },
  );
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
pnpm exec vitest run tests/scripts/signing.test.ts
```

기대: PASS 4건.

- [ ] **Step 5: `package.mjs`가 그것을 쓰게 한다**

머리에 import를 더하고:

```javascript
import { assertIdentityInKeychain, codesign, loadSigning } from "./lib/signing.mjs";
```

`electron-builder --dir` **앞에** 신원 확인을 둔다 — 두 시간짜리 빌드 끝에서 서명이 없다고 알면 늦다:

```javascript
// 서명 신원을 **빌드 전에** 확인한다. 뒤에서 알면 그때까지의 시간이 날아간다.
const signing = loadSigning(desktop);
assertIdentityInKeychain(signing.identity);
```

`signAll`과 `.app` 서명을 갈아 끼운다:

```javascript
function signAll(targets, entitlements, label) {
  if (targets.length === 0) throw new Error(`서명 대상이 없다: ${label}`);
  console.log(
    `$ codesign --sign ${signing.identity} --options runtime --timestamp` +
      ` --entitlements ${path.relative(desktop, entitlements)} — ${label} ${targets.length}개`,
  );
  // argv 길이 한계를 넘지 않게 끊어 부른다. execFileSync는 비0에 throw하므로 한 건이라도
  // 서명에 실패하면 패키징이 여기서 멈춘다.
  for (let i = 0; i < targets.length; i += 200) {
    codesign(signing.identity, entitlements, targets.slice(i, i + 200));
  }
}

signAll(machOFiles(path.join(resources, "python")), pythonEnts, "Resources/python Mach-O");
signAll(ffmpegTargets, pythonEnts, "Resources/ffmpeg/bin");

// .app은 --deep으로. plist는 mac 쪽이다 — python plist를 주면 V8이 allow-jit 없이 rc=133으로 죽는다.
codesign(signing.identity, macEnts, [appPath], ["--deep"]);
```

**`--sign -`이 파일 어디에도 남지 않아야 한다.**

- [ ] **Step 6: `check-bundle.mjs`의 서명 단언을 identity까지 올린다**

**머리의 import에 먼저 더한다.** 이 파일은 지금 `./lib/macho.mjs`의 `machOFiles`만 들여온다 — 없으면 `ReferenceError: loadSigning is not defined`로 패키징이 막힌다.

```javascript
import { loadSigning } from "./lib/signing.mjs";
```

기존 7번(Identifier) 단언 뒤에 더한다:

```javascript
// 7b. 서명이 Developer ID이고 팀이 우리 팀이다 (P6a-C3). "서명이 있다"와 "**우리** 서명이다"는
// 다른 질문이다 — ad-hoc도 --verify를 통과한다.
const sig = loadSigning(desktop);
const authority = /^Authority=(.+)$/m.exec(codesignInfo.stderr ?? "");
check("app is signed by Developer ID Application", (authority?.[1] ?? "").startsWith("Developer ID Application:"),
  authority?.[1] ?? "(not found)");
const teamLine = /^TeamIdentifier=(.+)$/m.exec(codesignInfo.stderr ?? "");
check(`app TeamIdentifier is ${sig.teamId}`, (teamLine?.[1] ?? "").trim() === sig.teamId, teamLine?.[1] ?? "(not found)");

// 7c. 번들 Mach-O 전수가 같은 팀으로 서명됐다. postgres 트리도 포함한다 — 그쪽은 hardened
// runtime 플래그만 예외이지 identity는 같아야 한다 (Phase 6a 스펙 §6).
const wrongTeam = [];
for (const f of machOFiles(contents)) {
  const r = spawnSync("codesign", ["-dv", "--verbose=2", f], { encoding: "utf8" });
  const t = /^TeamIdentifier=(.+)$/m.exec(r.stderr ?? "");
  if ((t?.[1] ?? "").trim() !== sig.teamId) wrongTeam.push(`${path.relative(contents, f)}=${t?.[1]?.trim() ?? "none"}`);
}
check(`every Mach-O carries TeamIdentifier ${sig.teamId}`, wrongTeam.length === 0, wrongTeam.slice(0, 10).join(", "));
```

- [ ] **Step 7: 패키징하고 확인**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
rm -rf out
pnpm run package:desktop 2>&1 | tail -40
codesign -dv --verbose=2 out/mac-arm64/Damwha.app 2>&1 | grep -E "Authority|TeamIdentifier|flags|Timestamp"
codesign -d --requirements - out/mac-arm64/Damwha.app 2>&1 | tail -2
```

기대: `Authority=Developer ID Application: Youngjae Kim (L5Y9SZHGRN)` → `Developer ID Certification Authority` → `Apple Root CA`, `TeamIdentifier=L5Y9SZHGRN`, `flags=0x10000(runtime)`, `Timestamp=…`. DR에 `certificate leaf[subject.OU] = L5Y9SZHGRN`.

- [ ] **Step 8: 앱이 실제로 뜨는지 본다 — 서명은 통과하고 실행은 죽을 수 있다**

```bash
open /Users/gim-yeongjae/project/daewha/desktop/out/mac-arm64/Damwha.app
```

기대: 앱이 뜬다. **토큰 창이 뜨는 것이 정상이다**(P6a-C12) — 서명 신원이 바뀌어 `safeStorage`의 Keychain ACL이 1회 무효가 된다. 크래시(rc=133 등)면 plist가 잘못 붙은 것이다. 토큰을 다시 넣고 서비스가 뜨는 것까지 확인한다.

- [ ] **Step 9: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/signing.json desktop/scripts/lib/signing.mjs desktop/tests/scripts/signing.test.ts desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs
git commit -m "build(phase6a): ad-hoc 서명을 Developer ID로 바꾼다

이름이 아니라 sha1 지문으로 서명한다 — 이 키체인에 동명 항목이 넷 있고,
2026-09-13에 이름 중복이 codesign을 ambiguous로 실패시킨 적이 있다.
signing.json이 없거나 그 지문이 키체인에 없으면 빌드 전에 멈춘다. ad-hoc으로
조용히 떨어지는 길은 두지 않는다. --timestamp를 더했다 — 공증의 선행 조건이고
인증서 만료 뒤에도 서명을 유효하게 한다.

check-bundle이 '서명이 있다'에서 '우리 팀 서명이다'까지 올라간다. ad-hoc도
--verify를 통과하므로 전자만으로는 계약을 못 지킨다. postgres 트리도 identity는
확인한다 — 그쪽은 hardened runtime 플래그만 예외다.

서명 신원이 바뀌므로 safeStorage 토큰이 1회 무효가 된다(예고된 퇴행, 스펙 §9).
token-store의 read()가 복호화 실패에 파일을 지우지 않고 null을 내므로 크래시가
아니라 온보딩 재호출로 떨어진다."
```

**Verify:** Step 7의 세 출력 + Step 8에서 앱이 실제로 뜨고 토큰 재입력 뒤 서비스가 준비됨.

**Review:** `--sign -`이 저장소에 하나도 안 남았는지 (`grep -rn '"--sign", "-"' desktop/scripts`). 안쪽→바깥 순서가 유지됐는지. `.app`에 `macEnts`가 가는지(python plist면 V8이 죽는다). 신원 확인이 `electron-builder` **앞**인지. `--timestamp`가 세 호출 모두에 붙었는지.

---

## Task 6: 공증·스테이플·DMG (발행 제외)

**Files:**
- Modify: `desktop/scripts/package.mjs`
- Modify: `desktop/scripts/check-bundle.mjs`
- Modify: `desktop/package.json` (scripts)

**Interfaces:**
- Consumes: Task 5의 `loadSigning`, 서명된 `out/mac-arm64/Damwha.app`
- Produces: `desktop/out/Damwha-0.3.0-arm64.dmg`(서명·공증·스테이플됨) + `.sha256`, 그리고 그것을 만드는 `--release` 기구. **발행은 하지 않는다** — Task 11이 모든 코드가 커밋된 뒤 다시 만들어 올린다.

**순서가 계약이다.** 지금 구조는 `electron-builder --dir` → 손 서명이다. `mac.target`을 `dmg`로 바꾸고 `--dir`을 떼면 **electron-builder가 서명 전 `.app`을 DMG에 담는다** — 뒤의 서명은 `out/mac-arm64`의 사본만 고치고 DMG 안은 링커 ad-hoc인 채 남는다. 그래서 DMG는 서명이 끝난 `.app`에서 `--prepackaged`로 따로 만든다.

- [ ] **Step 1: `--release` 플래그와 태그 대조를 넣는다**

`package.mjs` 머리 근처. **`spawnSync`와 `MAX_MINOS` import를 함께 더한다** — 이 Task가 둘 다 쓰는데 지금 파일에는 `execFileSync`만 있다.

```javascript
import { execFileSync, spawnSync } from "node:child_process";
import { MAX_MINOS } from "./lib/minos.mjs";

const RELEASE = process.argv.includes("--release");

// DMG 경로는 Step 5가 정하고 Step 6·8이 쓴다. if (RELEASE) 블록 밖에 두지 않으면 스코프가 끊긴다.
let dmgPath = null;

// 릴리스에서만 태그를 본다. 개발 중 패키징이 잦아 태그 없는 커밋에서 자주 돈다.
//
// **태그는 desktop-v<version>이다** (Phase 6a 스펙 §4): v<version>은 deploy/release.sh가
// 셀프호스팅 웹 배포에 이미 쓰고 있고(v0.1.1~v0.2.3 실재, 자산은 tarball과 wheel), 그 스크립트는
// 태그 버전이 be/worker/pyproject.toml과 다르면 거절한다. 섞으면 6b의 릴리스 조회가 웹 배포를
// 가리켜 앱이 사용자에게 tarball을 권한다.
const desktopPkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const expectedTag = `desktop-v${desktopPkg.version}`;
if (RELEASE) {
  const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "--match", "desktop-v*"], {
    cwd: repo, encoding: "utf8",
  }).trim();
  if (tag !== expectedTag) {
    throw new Error(`태그가 ${tag}인데 package.json은 ${desktopPkg.version}이다 — ${expectedTag}여야 한다`);
  }
}
```

- [ ] **Step 2: `electron-builder`는 `--dir` 그대로 둔다**

82행을 바꾸지 않는다. `electron-builder.yml`의 `mac.target`도 `dir`로 둔다 — DMG는 Step 4가 만든다. `--release`가 붙어도 여기서는 `.app`만 만든다.

- [ ] **Step 3: 서명·`check-bundle` 뒤에 `.app` 공증·스테이플을 넣는다**

기존 `check-bundle` 호출 **뒤에**:

```javascript
// notarytool은 디렉터리를 받지 않는다. ditto로 zip을 떠서 제출하고, 통과하면 **zip이 아니라
// 원본 .app에** 스테이플한다 — DMG 밖으로 꺼낸 .app이 오프라인에서도 통과하려면 필요하다.
function notarize(target, label) {
  console.log(`$ notarytool submit ${label}`);
  const r = spawnSync("xcrun", [
    "notarytool", "submit", target,
    "--keychain-profile", signing.notaryProfile,
    "--wait", "--timeout", "30m",
    "--output-format", "json",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const out = r.stdout ?? "";
  console.log(out);
  let parsed = {};
  try { parsed = JSON.parse(out); } catch { /* 출력이 JSON이 아니면 아래 status 검사가 잡는다 */ }
  if (parsed.status !== "Accepted") {
    // 거절 사유는 목록이라 요약하면 원인을 잃는다. 로그를 통째로 뱉고 멈춘다.
    if (parsed.id !== undefined) {
      spawnSync("xcrun", ["notarytool", "log", parsed.id, "--keychain-profile", signing.notaryProfile], { stdio: "inherit" });
      console.error(`제출 id ${parsed.id} — 나중에 notarytool log로 이어 볼 수 있다`);
    }
    throw new Error(`공증 실패 (${label}): status=${parsed.status ?? "unknown"}`);
  }
}

if (RELEASE) {
  const appZip = path.join(desktop, "out", "Damwha.zip");
  run("ditto", ["-c", "-k", "--keepParent", appPath, appZip], desktop);
  notarize(appZip, ".app");
  fs.rmSync(appZip, { force: true });
  run("xcrun", ["stapler", "staple", appPath], desktop);

  // 스테이플이 .app 안에 티켓 파일을 넣는다. 번들 위생과 서명이 그 뒤에도 성립하는지 다시 묻는다
  // (스펙 §7 공통 규칙). 여기서 지면 DMG를 만들지 않는다 — 깨진 앱을 담은 DMG가 더 나쁘다.
  run("node", [path.join("scripts", "check-bundle.mjs")], desktop);
}
```

- [ ] **Step 4: 서명된 `.app`에서 DMG를 만든다**

```javascript
if (RELEASE) {
  // --prepackaged: 이미 서명·스테이플된 그 바이트를 그대로 담는다. 재빌드하지 않는다.
  // 이것이 없으면 electron-builder가 서명 전 앱을 다시 만들어 담는다.
  run("pnpm", ["exec", "electron-builder", "--prepackaged", appPath, "--mac", "dmg"], desktop);
}
```

- [ ] **Step 5: DMG를 서명·공증·스테이플한다**

```javascript
if (RELEASE) {
  const dmgs = fs.readdirSync(path.join(desktop, "out")).filter((f) => f.endsWith(".dmg"));
  if (dmgs.length !== 1) throw new Error(`out에 DMG가 정확히 하나여야 한다: ${dmgs.join(", ") || "(없음)"}`);
  dmgPath = path.join(desktop, "out", dmgs[0]);   // Step 1에서 선언한 것에 담는다 — Step 6·8이 쓴다

  // DMG 자신도 서명한다. entitlements는 주지 않는다 — 디스크 이미지는 실행 파일이 아니다.
  run("codesign", ["--force", "--sign", signing.identity, "--timestamp", dmgPath], desktop);
  notarize(dmgPath, "DMG");
  run("xcrun", ["stapler", "staple", dmgPath], desktop);

  // 받은 것이 우리가 낸 것인지 사용자가 확인할 수 있어야 한다.
  const sha = execFileSync("shasum", ["-a", "256", dmgs[0]], { cwd: path.join(desktop, "out"), encoding: "utf8" });
  fs.writeFileSync(`${dmgPath}.sha256`, sha);
  console.log(sha.trim());
}
```

- [ ] **Step 6: DMG 안을 실제로 열어 확인한다**

```javascript
if (RELEASE) {
  // 3·4번이 의도대로 이어졌는지는 마운트해서 보는 것만이 증명한다 (P6a-C13).
  // out/mac-arm64의 .app이 통과하는 것과 DMG 안의 .app이 통과하는 것은 다른 질문이다.
  const mnt = execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly"], { encoding: "utf8" })
    .split("\n").map((l) => l.split("\t").pop()?.trim()).filter((p) => p?.startsWith("/Volumes/")).pop();
  if (mnt === undefined) throw new Error("DMG 마운트 지점을 찾지 못했다");
  try {
    const inner = path.join(mnt, "Damwha.app");
    run("spctl", ["--assess", "--type", "execute", "-vv", inner], desktop);
    run("xcrun", ["stapler", "validate", inner], desktop);
  } finally {
    spawnSync("hdiutil", ["detach", mnt, "-quiet"]);
  }
}
```

- [ ] **Step 7: `--release` 스크립트를 추가한다**

`desktop/package.json`의 `scripts`에:

```json
"package:release": "node scripts/package.mjs --release"
```

- [ ] **Step 8: 발행은 여기서 하지 않는다**

**`gh release create`를 `package.mjs`에 넣지 않는다.** Task 7~9가 디스크 부족 처리를 아직 안 넣었으므로, 여기서 릴리스를 내면 **그 처리가 빠진 DMG가 배포된다.** 발행은 모든 코드가 들어가고 packaged 검증까지 끝난 뒤(Task 11)에 한다.

이 Task가 만드는 것은 **발행 직전까지의 산출물** — 서명·공증·스테이플된 `.app`과 DMG, 그리고 `.sha256`. Task 11이 그것을 그대로 올린다.

- [ ] **Step 9: dev 경로가 안 깨졌는지 먼저 본다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
rm -rf out
pnpm run package:desktop 2>&1 | tail -20
```

기대: 지금과 같다 — `.app`만 만들고 DMG·공증·릴리스 없음. `check-bundle` 통과. **`--release` 경로가 개발 루프를 건드리지 않았음을 이것이 보인다.**

- [ ] **Step 10: 코드를 먼저 커밋하고, 그 커밋에 태그를 찍은 뒤 돌린다**

**순서가 중요하다.** 태그는 산출물을 만든 코드를 가리켜야 한다. 미커밋 작업트리에서 빌드하고 나중에 커밋하면 태그가 그 코드를 안 가리켜 릴리스를 재현할 수 없다.

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs desktop/package.json
git commit -m "build(phase6a): 공증·스테이플·DMG를 --release에 넣는다"   # 본문은 Step 12
git tag desktop-v0.3.0
cd desktop
rm -rf out
pnpm run package:release 2>&1 | tail -60
```

기대: 서명 → check-bundle → `.app` 공증(수 분) → 스테이플 → check-bundle 재실행 → DMG 생성 → DMG 서명·공증·스테이플 → 마운트 확인. 공증 두 번이라 10~20분. **릴리스는 만들지 않는다**(Task 11).

**여기서 찍은 태그는 임시다.** Task 7~9가 코드를 더 넣으므로 Task 11이 태그를 옮긴다(`git tag -f`). 이 단계의 목적은 기구가 도는지 보는 것이지 최종 산출물을 내는 것이 아니다.

- [ ] **Step 10b: 태그 대조가 실제로 막는지 시험한다 (P6a-C5)**

통과만 보면 단언이 늘 참을 내는 빈 그물일 수 있다. 일부러 어긋나게 해서 멈추는지 본다.

```bash
cd /Users/gim-yeongjae/project/daewha
git tag desktop-v9.9.9              # package.json은 0.3.0인데 태그는 9.9.9
git tag -d desktop-v0.3.0
cd desktop && node scripts/package.mjs --release 2>&1 | tail -3; echo "종료코드 ${PIPESTATUS[0]}"
cd .. && git tag -d desktop-v9.9.9 && git tag desktop-v0.3.0   # 되돌린다
```

기대: 비영 종료 + `태그가 desktop-v9.9.9인데 package.json은 0.3.0이다`. **electron-builder가 돌기 전에** 멈춰야 한다 — 두 시간짜리 빌드 끝에서 알면 늦다.

- [ ] **Step 11: 산출물을 손으로 확인 (P6a-C4)**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop/out
# P6a-C4 — 공증과 스테이플
spctl --assess --type execute -vv mac-arm64/Damwha.app
xcrun stapler validate mac-arm64/Damwha.app
xcrun stapler validate Damwha-0.3.0-arm64.dmg
shasum -a 256 -c Damwha-0.3.0-arm64.dmg.sha256
```

기대: `accepted / source=Notarized Developer ID`, `stapler validate`가 `.app`·DMG 둘 다 통과, sha256 `OK`. (C14는 Task 11이 판정한다 — 아직 릴리스를 내지 않았다.)

- [ ] **Step 12: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/scripts/package.mjs desktop/scripts/check-bundle.mjs desktop/package.json
git commit -m "build(phase6a): 공증·스테이플·DMG를 --release에 넣는다

DMG를 서명이 끝난 .app에서 --prepackaged로 따로 만든다. mac.target을 dmg로
바꾸고 --dir을 떼면 electron-builder가 서명 전 앱을 담고, 뒤의 서명과 스테이플이
DMG 내부 사본에 닿지 않는다 — 검증을 통과한 .app과 배포되는 DMG의 내용물이
달라진다. 마운트해서 안을 보는 단계를 넣은 이유가 그것이다.

.app과 DMG를 각각 공증·스테이플한다. DMG만 하면 사용자가 앱을 꺼낸 뒤
오프라인에서 Gatekeeper에 막힌다.

태그는 desktop-v<version>이다. v<version>은 deploy/release.sh의 셀프호스팅 웹
배포가 이미 쓰고 있고, 섞으면 6b의 릴리스 조회가 웹 배포를 가리켜 앱이
사용자에게 tarball을 권한다.

--release 없이는 지금과 같다. 개발 루프에 공증 몇 분과 DMG 압축을 물리지 않는다.

발행은 여기서 하지 않는다. Task 7~9가 디스크 부족 처리를 아직 안 넣었으므로 지금
내면 그 처리가 빠진 DMG가 배포된다."
```

**Verify:** Step 9(dev 경로 무변) + Step 10b(태그 대조가 막는다) + Step 11 전부. 특히 DMG 마운트 검증(P6a-C13).

**Review:** `--release` 없는 경로가 정말 안 바뀌었는지 (Step 9로 확인). `--prepackaged`가 쓰였는지. 스테이플 뒤 `check-bundle`이 다시 도는지. `.app`과 DMG 둘 다 공증·스테이플되는지. 공증 실패가 `notarytool log`를 뱉고 멈추는지. `hdiutil detach`가 `finally`에 있는지. **`gh release create`가 이 Task에 남아 있지 않은지** — 남아 있으면 Task 7~9 없는 DMG가 배포된다.

---

## Task 7: 디스크 부족 — worker 쪽 사전 점검

**Files:**
- Create: `be/worker/damwha_worker/models/disk.py`
- Create: `be/worker/tests/test_disk.py`
- Modify: `be/worker/damwha_worker/errors.py`
- Modify: `be/worker/damwha_worker/models/downloads.py`

**Interfaces:**
- Consumes: 없음 (worker 내부)
- Produces:
  - `free_bytes(path: str) -> int`
  - `format_bytes(n: int) -> str` — `"12.3 GB"`
  - `check_free_space(dest: str, needed: int) -> None` — 모자라면 `WorkerError(DISK_FULL, …, PERMANENT)`
  - `errors.DISK_FULL: str = "DISK_FULL"`

**세 주체가 공유한다.** `models/downloads.py`의 `install_hf_progress_hook`은 worker job(`dispatch.py`)·embed 서비스(`embed_service.py:84`)·LLM 서버(`llm_entry.py:57`) 셋이 각자 부른다. 점검을 거기 두면 한 번에 셋을 덮는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/worker/tests/test_disk.py`:

```python
import pytest

from damwha_worker.errors import ErrorKind, WorkerError
from damwha_worker.models.disk import check_free_space, format_bytes, free_bytes


def test_free_bytes_is_positive(tmp_path):
    assert free_bytes(str(tmp_path)) > 0


def test_format_bytes_reads_like_a_person_wrote_it():
    assert format_bytes(0) == "0 B"
    assert format_bytes(1_500) == "1.5 KB"
    assert format_bytes(12_300_000_000) == "12.3 GB"


def test_check_passes_when_there_is_room(tmp_path):
    check_free_space(str(tmp_path), needed=1)  # 던지지 않는다


def test_check_raises_permanent_when_short(tmp_path):
    with pytest.raises(WorkerError) as e:
        check_free_space(str(tmp_path), needed=free_bytes(str(tmp_path)) + 10**12)
    assert e.value.kind is ErrorKind.PERMANENT
    assert e.value.code == "DISK_FULL"
    # 화면 문구가 남은 용량과 필요한 용량 둘을 말해야 한다 (causes.ts의 diskFull이 정한 모양)
    assert "남은 용량" in str(e.value)
    assert "필요한 용량" in str(e.value)


def test_check_skips_when_needed_is_unknown(tmp_path):
    # 필요한 용량을 모르면 막지 않는다 — 추정으로 막으면 받을 수 있는 것을 못 받는다
    check_free_space(str(tmp_path), needed=None)


def test_check_skips_when_path_is_missing(tmp_path):
    # 경로가 아직 없으면(첫 다운로드) 가장 가까운 상위로 올라가 잰다
    check_free_space(str(tmp_path / "not" / "yet"), needed=1)
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
uv run --directory be/worker pytest tests/test_disk.py -v
```

기대: FAIL — `ModuleNotFoundError: damwha_worker.models.disk`.

- [ ] **Step 3: `errors.py`에 코드를 더한다**

```python
# 디스크 부족. PERMANENT인 이유: 디스크가 그대로인 채 재시도해 봐야 같은 자리에서 진다.
# Phase 5가 만든 백오프 5회를 여기에 태우지 않는다 (Phase 6a 스펙 §8.1).
DISK_FULL = "DISK_FULL"
```

- [ ] **Step 4: `disk.py`를 쓴다**

```python
"""모델 다운로드 전 디스크 여유 판정 (Electron Phase 6a 스펙 §8.1).

**세 주체가 공유한다** — worker job, embed 서비스, LLM 서버. 셋 다
`models/downloads.py`의 훅을 거치므로 판정을 여기 한 곳에 둔다. 다른 것은
실패가 도달하는 곳뿐이다: job은 `job.status='failed'`, 나머지 둘은 서비스 기동 실패.

문구는 데스크톱의 `causes.ts`가 정한 모양(`남은 용량 X, 필요한 용량 Y`)에 맞춘다.
**사본을 만들지 않는다** — 그 파일의 머리 주석이 금하는 것이다.
"""

from __future__ import annotations

import os
import shutil

from ..errors import DISK_FULL, ErrorKind, WorkerError

_UNITS = ("B", "KB", "MB", "GB", "TB")


def free_bytes(path: str) -> int:
    """`path`가 앉은 볼륨의 남은 바이트. 경로가 아직 없으면 있는 상위로 올라간다."""
    probe = path
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    return shutil.disk_usage(probe).free


def format_bytes(n: int) -> str:
    """사람이 읽는 크기. 1000 기준이다 — Finder가 그렇게 보이므로 화면과 어긋나지 않게."""
    if n < 1000:
        return f"{n} B"
    size = float(n)
    for unit in _UNITS[1:]:
        size /= 1000
        if size < 1000:
            return f"{size:.1f} {unit}"
    return f"{size:.1f} {_UNITS[-1]}"


def check_free_space(dest: str, needed: int | None) -> None:
    """여유가 `needed`보다 적으면 PERMANENT로 던진다.

    `needed`가 None이면 **점검하지 않는다.** 저장소 크기를 못 얻었다는 뜻이고,
    추정으로 막으면 받을 수 있는 것을 못 받는다.
    """
    if needed is None:
        return
    free = free_bytes(dest)
    if free >= needed:
        return
    raise WorkerError(
        DISK_FULL,
        f"디스크 공간이 부족해요 — 남은 용량 {format_bytes(free)}, 필요한 용량 {format_bytes(needed)}.",
        ErrorKind.PERMANENT,
    )
```

- [ ] **Step 5: 통과를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
uv run --directory be/worker pytest tests/test_disk.py -v
```

기대: PASS 6건.

- [ ] **Step 6: 다운로드 훅에 끼운다 — `_run_watched`가 아니라 `hooked`다**

**`_run_watched`에 두면 다운로드의 일부만 덮는다.** `_wrap`의 `hooked`는 `writer is None`이거나 `tqdm_class`가 주어졌거나 `local_files_only`·`dry_run`이거나 `repo_id`가 문자열이 아니면 **`_run_watched`를 건너뛰고 원본을 바로 부른다**(`downloads.py:574-583`). 같은 파일의 머리 주석(19-24행)이 faster-whisper 등이 `tqdm_class`를 넘겨 진행 감시에서 빠진다고 적어 뒀다. 그 경로들도 디스크는 똑같이 쓴다.

그래서 점검은 **`hooked` 안, 캐시 우선 분기 뒤·우회 분기 앞**에 둔다. 캐시 우선(`attempt is not None`)은 `local_files_only=True`로 돌아 아무것도 받지 않으므로 그 앞은 아니다.

```python
        # (attempt 블록 뒤, `writer = _STATE.writer` 앞)
        #
        # **여기가 맞는 자리다**: 아래 우회 분기(tqdm_class·writer None·repo_id 비문자열)가
        # _run_watched를 건너뛰므로 거기 두면 다운로드의 일부만 덮는다. 진행 보고와 달리
        # 디스크는 모든 경로가 똑같이 쓴다.
        #
        # local_files_only·dry_run은 받지 않으므로 건너뛴다.
        _repo = args[0] if args else kwargs.get("repo_id")
        if isinstance(_repo, str) and not kwargs.get("local_files_only") and not kwargs.get("dry_run"):
            from huggingface_hub import constants as hub_constants

            from .disk import check_free_space

            check_free_space(hub_constants.HF_HUB_CACHE, _needed_bytes(_repo))
```

**`install_hf_progress_hook`의 "던지지 않는다" 계약은 깨지 않는다.** 그 계약은 훅 **설치**에 대한 것이고(`downloads.py:714`), 여기는 훅이 감싼 **호출**이다 — 그 호출은 원래도 던진다.

아래는 `_needed_bytes`다. `_wrap` 옆 모듈 수준에 둔다. 저장소 크기는 `huggingface_hub`의 `HfApi().model_info(repo_id, files_metadata=True)`로 얻고, **못 얻으면 `None`을 넘겨 건너뛴다.**

```python
def _needed_bytes(repo_id: str) -> int | None:
    """저장소 전체 크기 × 여유 계수. 못 얻으면 None — 추정으로 막지 않는다."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo_id, files_metadata=True)
        total = sum(s.size for s in (info.siblings or []) if s.size is not None)
    except Exception:  # noqa: BLE001 — 크기를 모르는 것은 실패가 아니다
        return None
    if total <= 0:
        return None
    # 1.2배: 받는 동안 .incomplete 파일과 최종 파일이 잠깐 함께 있는다.
    return int(total * 1.2)
```

**캐시 경로를 새로 계산하지 않는다.** `downloads.py`가 이미 `apply_hf_limits()`로
`huggingface_hub.constants`를 이 프로세스의 env에 맞춰 놓았고(`downloads.py:664-666`),
`HF_HUB_CACHE`가 그 결과다. 따로 재면 앱이 실제로 쓰는 볼륨과 다른 곳을 잴 수 있다.

받기 전에 재는 이유: 수 GB를 다 받고 마지막에 ENOSPC로 지면 받은 것도 버린다.

- [ ] **Step 7: 워커 테스트 전체**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm worker:test
```

기대: 기존 테스트 전부 통과 + 새 6건.

- [ ] **Step 8: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add be/worker/damwha_worker/models/disk.py be/worker/tests/test_disk.py be/worker/damwha_worker/errors.py be/worker/damwha_worker/models/downloads.py
git commit -m "feat(worker): 모델 다운로드 전에 디스크 여유를 잰다

모델 한 벌이 수 GB라 받는 도중에 디스크가 차는 것이 주 사고 지점인데, 지금은
사유 없이 실패한다. 다운로드 주체가 셋(worker job, embed 서비스, LLM 서버)이고
셋 다 models/downloads.py의 훅을 거치므로 판정을 거기 한 곳에 둔다.

PERMANENT다 — 디스크가 그대로인 채 재시도해 봐야 같은 자리에서 진다. Phase 5가
만든 백오프 5회를 디스크 부족으로 태우지 않는다.

저장소 크기를 못 얻으면 점검을 건너뛴다. 추정으로 막으면 받을 수 있는 것을
못 받는다.

문구는 desktop의 causes.ts가 정한 모양(남은 용량 X, 필요한 용량 Y)에 맞췄다."
```

**Verify:** Step 7. 그리고 실제로 한 번 막히는지 — `needed`를 크게 만든 단위 테스트가 그 역할이다(실디스크를 채우지 않는다).

**Review:** `check_free_space`가 `needed=None`에 조용히 통과하는지. 문구가 `causes.ts`의 `diskFull` 인자 모양과 정확히 맞는지. `_needed_bytes`의 `except`가 넓은데 그것이 의도인지(크기를 모르는 것은 실패가 아니다). 훅 설치 경로가 **던지지 않는다**는 기존 계약(`downloads.py:714`)을 깨지 않았는지 — 점검은 훅 설치가 아니라 **다운로드 실행** 자리에 있어야 한다.

---

## Task 8: 디스크 부족 — 업로드 ENOSPC

**Files:**
- Create: `be/src/storage/disk-full.filter.ts`
- Create: `be/test/disk-full.filter.spec.ts`
- Modify: `be/src/app.module.ts`

**Interfaces:**
- Consumes: 없음
- Produces: ENOSPC → HTTP 507 + `{ code: "DISK_FULL", free, needed }`. Task 9의 화면이 이 `code`를 읽는다.

**왜 한 자리인가:** `meetings.controller.ts:63`과 `speakers.controller.ts:27`이 같은 `uploadInterceptorOptions`를 쓴다. 컨트롤러마다 try/catch를 뿌리면 다음에 생기는 업로드 경로가 또 빠진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`be/test/disk-full.filter.spec.ts`:

```typescript
import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { DiskFullFilter } from '../src/storage/disk-full.filter';

function hostWith(): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('DiskFullFilter', () => {
  it('ENOSPC를 507과 DISK_FULL 코드로 바꾼다', () => {
    const { host, sent } = hostWith();
    const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    new DiskFullFilter().catch(err, host);
    expect(sent.status).toBe(HttpStatus.INSUFFICIENT_STORAGE);
    expect((sent.body as { code: string }).code).toBe('DISK_FULL');
  });

  it('multer가 감싼 ENOSPC도 잡는다 — code가 cause에 있다', () => {
    const { host, sent } = hostWith();
    const inner = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    const err = Object.assign(new Error('upload failed'), { cause: inner });
    new DiskFullFilter().catch(err, host);
    expect(sent.status).toBe(HttpStatus.INSUFFICIENT_STORAGE);
  });

  it('스택트레이스를 응답에 싣지 않는다', () => {
    const { host, sent } = hostWith();
    const err = Object.assign(new Error('ENOSPC: /var/folders/xyz/dw-upload-abc'), { code: 'ENOSPC' });
    new DiskFullFilter().catch(err, host);
    expect(JSON.stringify(sent.body)).not.toContain('/var/folders');
  });

  it('ENOSPC가 아닌 오류는 기본 처리로 넘긴다 — 다시 던지면 응답이 없다', () => {
    const { host } = hostWith();
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const filter = new DiskFullFilter(new HttpAdapterHost().httpAdapter);
    const spy = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(filter)), 'catch').mockImplementation(() => undefined);
    filter.catch(err, host);
    expect(spy).toHaveBeenCalledWith(err, host);
    spy.mockRestore();
  });

  it('HttpException의 상태 코드가 보존된다', () => {
    const { host, sent } = hostWith();
    const filter = new DiskFullFilter(new HttpAdapterHost().httpAdapter);
    // BaseExceptionFilter에 위임하면 404가 404로 나간다. 다시 던졌다면 응답이 아예 없다.
    expect(() => filter.catch(new NotFoundException('없어요'), host)).not.toThrow();
    expect(sent.status === undefined || sent.status === 404).toBe(true);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm be test -- disk-full.filter
```

기대: FAIL — 모듈 없음.

- [ ] **Step 3: 필터를 쓴다**

`be/src/storage/disk-full.filter.ts`:

```typescript
import { ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as fs from 'fs';
import * as os from 'os';

/**
 * 업로드 중 디스크가 찬 것(ENOSPC)을 507로 바꾼다 (Electron Phase 6a 스펙 §8.2).
 *
 * **왜 한 자리인가:** meetings.controller.ts와 speakers.controller.ts가 같은
 * uploadInterceptorOptions를 쓴다. multer는 컨트롤러 진입 **전에** os.tmpdir()에 쓰므로
 * 컨트롤러 안의 try/catch로는 잡히지 않고, 처리되지 않은 500(스택트레이스)이 나간다 —
 * Phase 5가 디스크가 실제로 찬 회차에서 그것을 관측했다.
 *
 * 이 시점에는 meeting·job 행이 아직 없다. 그래서 여기서 정리할 DB 상태도 없다 —
 * 지워야 할 것은 multer가 남긴 임시 파일뿐이다.
 *
 * **`BaseExceptionFilter`를 상속한다.** 이 앱에는 전역 예외 필터가 하나도 없어서(app.module.ts의
 * providers에 APP_FILTER가 없다) 이것이 유일한 필터가 된다. 필터 안에서 `throw`하면 Nest가
 * 그것을 **다시 처리하지 않는다** — ENOSPC가 아닌 모든 오류의 응답이 사라진다. 기본 동작은
 * `super.catch()`로 넘겨야 보존된다.
 */
@Catch()
export class DiskFullFilter extends BaseExceptionFilter {
  private readonly log = new Logger(DiskFullFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (!isNoSpace(exception)) {
      // 우리 것이 아니면 Nest 기본 처리로. 여기서 throw하면 응답이 아예 나가지 않는다.
      super.catch(exception, host);
      return;
    }

    // multer가 반쯤 쓴 임시 파일을 지운다. 디스크가 찬 판에 남겨 두면 다음 시도도 진다.
    const file = tempFileOf(exception);
    if (file !== null) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        this.log.warn('임시 파일을 지우지 못했다');
      }
    }

    const free = freeBytes(os.tmpdir());
    this.log.error(`업로드 중 디스크가 찼다 — 남은 용량 ${free} 바이트`);

    // 원본 메시지를 싣지 않는다 — 경로와 스택이 담긴다.
    host.switchToHttp().getResponse().status(HttpStatus.INSUFFICIENT_STORAGE).json({
      code: 'DISK_FULL',
      free,
      // 업로드 시점에는 "필요한 용량"을 모른다. 화면은 free만 말한다.
      needed: null,
    });
  }
}

/** code가 예외 자신에도, cause에도 있을 수 있다 — multer는 감싸서 던진다. */
function isNoSpace(e: unknown): boolean {
  const code = (v: unknown): string | null =>
    v !== null && typeof v === 'object' && typeof (v as { code?: unknown }).code === 'string'
      ? ((v as { code: string }).code)
      : null;
  if (e === null || typeof e !== 'object') return false;
  return code(e) === 'ENOSPC' || code((e as { cause?: unknown }).cause) === 'ENOSPC';
}

function tempFileOf(e: unknown): string | null {
  if (e === null || typeof e !== 'object') return null;
  const p = (e as { path?: unknown }).path;
  return typeof p === 'string' && p.includes('dw-upload-') ? p : null;
}

function freeBytes(dir: string): number {
  try {
    return Number(fs.statfsSync(dir).bavail) * Number(fs.statfsSync(dir).bsize);
  } catch {
    return -1;
  }
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm be test -- disk-full.filter
```

기대: PASS 4건.

- [ ] **Step 5: 필터를 등록한다**

`be/src/app.module.ts`의 `providers`에 더한다:

```typescript
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import { DiskFullFilter } from './storage/disk-full.filter';

// providers 배열에. BaseExceptionFilter는 httpAdapter를 생성자로 받는다 —
// useClass로 걸면 그것이 주입되지 않아 super.catch()가 런타임에 죽는다.
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (host: HttpAdapterHost) => new DiskFullFilter(host.httpAdapter),
    },
```

- [ ] **Step 6: 전체 테스트**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm be test && pnpm be lint
```

기대: 기존 전부 통과. **`@Catch()`가 모든 예외를 받으므로 ENOSPC가 아닌 것을 다시 던지는지가 핵심이다** — Step 1의 네 번째 테스트가 그것을 본다.

- [ ] **Step 7: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add be/src/storage/disk-full.filter.ts be/test/disk-full.filter.spec.ts be/src/app.module.ts
git commit -m "feat(api): 업로드 중 ENOSPC를 507로 바꾼다

multer는 컨트롤러 진입 전에 os.tmpdir()에 쓰므로 컨트롤러 안의 try/catch로는
잡히지 않고 처리되지 않은 500(스택트레이스)이 나갔다. Phase 5가 디스크가 실제로
찬 회차에서 그것을 관측했다.

meetings와 speakers 두 컨트롤러가 같은 업로드 옵션을 쓰므로 필터 한 자리에서
잡는다. 컨트롤러마다 뿌리면 다음에 생기는 업로드 경로가 또 빠진다.

이 시점에는 meeting·job 행이 아직 없다 — 지워야 할 것은 multer의 임시 파일뿐이다.
응답에 원본 메시지를 싣지 않는다(경로와 스택이 담긴다)."
```

- [ ] **Step 6b: 기존 오류 응답이 안 깨졌는지 실제로 확인한다**

단위 테스트는 위임을 확인할 뿐 실제 HTTP 응답을 보지 않는다. 이 필터가 앱의 **유일한** 전역 필터가 되므로 종단간으로 한 번 본다.

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm db:up && pnpm be start:dev &   # 또는 기존 dev 기동 방식
sleep 15
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/meetings/99999999   # 없는 회의
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/no-such-route
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
```

기대: `404`, `404`, `200`. **하나라도 빈 응답이거나 타임아웃이면 위임이 안 된 것이다** — 그것이 이 Task의 유일한 진짜 위험이다.

**Verify:** Step 4·6·6b. 특히 6b — 다시 던지기와 위임의 차이는 단위 테스트에 잘 안 잡히고 실제 응답에서만 드러난다.

**Review:** `BaseExceptionFilter`를 상속하고 `super.catch()`로 넘기는지(`throw`가 남아 있지 않은지). `APP_FILTER`가 `useFactory`로 `httpAdapter`를 주입받는지 — `useClass`면 생성자 인자가 없어 `super.catch()`가 런타임에 죽는다. 응답 본문에 경로가 안 들어가는지. `statfsSync`가 이 Node 버전에 있는지(`engines`가 `>=22 <23`).

---

## Task 9: 화면 — 디스크 부족 사유 표시

**Files:**
- Modify: `desktop/src/diagnostics/causes.ts` (어댑터 연결)
- Modify: `fe/src/` 업로드 오류 처리 (507 → 문구)
- Test: `desktop/tests/diagnostics/causes.test.ts`, `fe/src/**/__tests__`

**Interfaces:**
- Consumes: Task 7의 worker `DISK_FULL` 사유 문자열, Task 8의 507 + `{ code: 'DISK_FULL', free }`
- Produces: 화면에 `디스크 공간이 부족해요 — 남은 용량 X, 필요한 용량 Y.` + `shell-hints.ts:78`의 안내

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`desktop/tests/diagnostics/causes.test.ts`에 더한다:

```typescript
import { CAUSES } from "../../src/diagnostics/causes";

describe("diskFull", () => {
  it("남은 용량과 필요한 용량을 둘 다 말한다", () => {
    expect(CAUSES.diskFull.text("1.2 GB", "12.3 GB"))
      .toBe("디스크 공간이 부족해요 — 남은 용량 1.2 GB, 필요한 용량 12.3 GB.");
  });

  it("worker가 낸 사유 문자열을 자기 것으로 알아본다", () => {
    // worker의 disk.py가 만드는 문구와 이 match가 어긋나면 화면에 사유가 안 뜬다
    const fromWorker = "디스크 공간이 부족해요 — 남은 용량 1.2 GB, 필요한 용량 12.3 GB.";
    expect(CAUSES.diskFull.match.test(fromWorker)).toBe(true);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
pnpm exec vitest run tests/diagnostics/causes.test.ts
```

기대: 두 번째 테스트가 통과할 수도 있다(`match`가 이미 있다). 통과하면 **그 자체가 결과**다 — `match`가 맞다는 뜻이니 Step 3에서 어댑터만 잇는다. 첫 번째가 실패하면 `text`의 모양이 다른 것이다.

- [ ] **Step 3: `causes.ts`의 "어댑터가 없다" 주석을 걷는다**

`diskFull`의 주석에서 **이 Phase에는 이 문구를 내는 어댑터가 아직 없다** 단락을 지우고, 어디서 오는지로 갈아 끼운다:

```typescript
  /**
   * 디스크가 찼다 (스펙 §8 — "남은 용량과 필요한 용량"). 모델 한 벌이 수 GB라 받는 도중에 이것이
   * 난다.
   *
   * **내는 곳이 둘이다** (Phase 6a 스펙 §8):
   *   - worker의 `models/disk.py`가 다운로드 전에 재고 `DISK_FULL`(PERMANENT)로 던진다.
   *     job 경로면 회의 카드에, embed·LLM 기동이면 상태 창에 뜬다.
   *   - API의 `storage/disk-full.filter.ts`가 업로드 ENOSPC를 507 + `code: "DISK_FULL"`로 바꾼다.
   *     업로드 시점에는 "필요한 용량"을 모르므로 화면은 남은 용량만 말한다.
   *
   * 두 곳이 **같은 문구**에 닿는 것이 요점이다. worker 쪽 문자열은 아래 `match`가 알아본다 —
   * 그 둘이 어긋나면 사유가 로그에만 남고 화면은 벙어리가 된다. `causes.test.ts`가 그것을 고정한다.
   */
```

- [ ] **Step 4: FE의 업로드 호출부를 먼저 찾는다**

```bash
cd /Users/gim-yeongjae/project/daewha
/usr/bin/grep -rn "FormData\|multipart\|'audio'" fe/src --include="*.ts" --include="*.tsx" | head -10
/usr/bin/grep -rn "res.status\|response.status\|=== 4\|>= 400" fe/src --include="*.ts" | head -10
```

기대: 업로드를 부르는 파일 하나와, 이 코드베이스가 HTTP 오류를 화면 문구로 옮기는 기존 자리가 나온다. **그 관례를 따른다** — 새 오류 타입을 만들지 않는다.

- [ ] **Step 5: 거기서 507을 잡는다**

`needed`가 `null`이면 남은 용량만 말한다:

```typescript
// 507 = 디스크 부족. 서버가 code와 남은 용량을 준다 (be/src/storage/disk-full.filter.ts).
// 업로드 시점에는 필요한 용량을 알 수 없으므로 needed가 null이고, 그때는 남은 용량만 말한다.
if (res.status === 507) {
  const body = await res.json().catch(() => ({}));
  throw new UploadError(
    body.needed == null
      ? `디스크 공간이 부족해요 — 남은 용량 ${formatBytes(body.free)}.`
      : `디스크 공간이 부족해요 — 남은 용량 ${formatBytes(body.free)}, 필요한 용량 ${formatBytes(body.needed)}.`,
    '다른 파일을 정리해 공간을 만든 뒤 다시 올려 주세요.',
  );
}
```

`UploadError`와 `formatBytes`는 Step 4가 찾은 기존 것을 쓴다. 없으면 그 파일 안에 지역 헬퍼로 둔다 — **`causes.ts`의 문구는 건드리지 않는다.**

- [ ] **Step 6: 테스트**

```bash
cd /Users/gim-yeongjae/project/daewha
pnpm desktop test 2>/dev/null || (cd desktop && pnpm test)
pnpm fe test
```

- [ ] **Step 7: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha
git add desktop/src/diagnostics/causes.ts desktop/tests/diagnostics/causes.test.ts fe/src
git commit -m "feat(ui): 디스크 부족 사유를 화면에 띄운다

causes.ts의 diskFull은 문구만 있고 그것을 내는 어댑터가 없다고 그 파일이 스스로
적어 뒀다. 이제 둘이 낸다 — worker의 models/disk.py와 API의 disk-full.filter.ts.
둘이 같은 문구에 닿는 것이 요점이라, worker 쪽 문자열을 causes의 match가
알아보는지 테스트로 고정한다. 어긋나면 사유가 로그에만 남고 화면은 벙어리가 된다.

업로드 시점에는 필요한 용량을 알 수 없어 남은 용량만 말한다."
```

**Verify:** Step 6 전부 통과. 특히 worker 문자열 ↔ `causes.match` 대조 테스트.

**Review:** 문구 사본이 생기지 않았는지 (`causes.ts`가 유일한 원천). FE의 `formatBytes`가 worker의 `format_bytes`와 같은 기준(1000)인지 — 다르면 같은 디스크가 두 화면에서 다른 숫자로 보인다.

---

## Task 10: packaged 통합 검증

**Files:** 없음 (검증 전용). 기록은 결과 문서.

**Interfaces:** Consumes: Task 1~9 전부.

**주입 방법이 미확정이다**(스펙 §11-2). Step 1이 그것을 먼저 실증하고, 안 되면 그 자리에서 후보를 내린다. **실제 디스크를 채우는 방법은 쓰지 않는다** — 회수 불가능한 위험이다.

- [ ] **Step 1: 업로드 ENOSPC 주입을 실증한다**

작은 sparse image를 만들어 `TMPDIR`을 거기로 돌린다.

```bash
cd /private/tmp/claude-501/*/scratchpad 2>/dev/null || cd /tmp
hdiutil create -size 20m -fs APFS -volname DamwhaTiny -type SPARSE tiny.sparseimage
hdiutil attach tiny.sparseimage -mountpoint /Volumes/DamwhaTiny
df -h /Volumes/DamwhaTiny | tail -1
```

`TMPDIR`을 그 볼륨으로 돌려 앱을 띄운다. **`open`은 환경을 물려주지 않는다** — 실행 파일을 직접 부른다.

```bash
APP=/Users/gim-yeongjae/project/daewha/desktop/out/mac-arm64/Damwha.app
TMPDIR=/Volumes/DamwhaTiny "$APP/Contents/MacOS/Damwha" &
```

앱이 뜨면 20 MB보다 큰 오디오를 업로드한다.

기대: 507 + 화면에 `디스크 공간이 부족해요 — 남은 용량 …`. `os.tmpdir()`가 `TMPDIR`을 따르는지는 Node의 문서화된 동작이지만, 안 먹으면 후보를 내려 다른 길을 찾는다.

- [ ] **Step 2: 업로드 실패가 아무것도 안 남겼는지 (P6a-C7)**

`psql`은 번들 것을 쓴다. 소켓은 userData의 `run/`이다(`desktop/CLAUDE.md`의 "데이터 위치").

```bash
APP=/Users/gim-yeongjae/project/daewha/desktop/out/mac-arm64/Damwha.app
UD="$HOME/Library/Application Support/Damwha"
PSQL="$APP/Contents/Resources/postgres/bin/psql"

"$PSQL" -h "$UD/run" -U damwha damwha -c \
  "select count(*) as new_meetings from meeting where created_at > now() - interval '5 minutes';"
"$PSQL" -h "$UD/run" -U damwha damwha -c \
  "select count(*) as new_jobs from job where created_at > now() - interval '5 minutes';"
ls /Volumes/DamwhaTiny | grep dw-upload || echo "임시 파일 0개"
```

기대: `new_meetings` 0, `new_jobs` 0, 임시 파일 0개.

- [ ] **Step 3: 모델 다운로드 디스크 부족을 재현한다 (P6a-C6·C8b)**

실디스크를 채우지 않는다. `_needed_bytes`가 큰 값을 내도록 HF 캐시를 작은 볼륨에 두거나, 통합 테스트에서 `check_free_space`의 `needed`를 크게 준다. **주체 셋을 각각 본다** — worker job(회의 카드), embed 기동(상태 창), LLM 기동(상태 창).

- [ ] **Step 4: 재시도 예산을 안 태웠는지 (P6a-C8b)**

```sql
select id, status, attempts, error_code from job order by id desc limit 3;
```

기대: `attempts`가 1 증가에 그치고 `status='failed'`, `error_code='DISK_FULL'`. `queued`로 돌아 백오프를 도는 일이 없다.

- [ ] **Step 5: 데이터 보존과 정합성 (P6a-C8)**

Phase 5의 정합성 질의 넷을 그대로 돌린다(스펙 P5-C10). 전후 `meeting`·`utterance` 행 수와 `data/storage` 파일 수를 대조한다.

기대: 넷 다 0행, 행 수·파일 수 불변.

- [ ] **Step 6: 정리**

```bash
hdiutil detach /Volumes/DamwhaTiny
rm -f tiny.sparseimage
```

- [ ] **Step 7: 결과를 기록한다**

`docs/superpowers/reports/2026-09-20-electron-phase-6a-signing-distribution-results.md`에 회차마다 명령·출력·판정을 적는다. **실행하지 않은 검증을 성공으로 적지 않는다.**

**Verify:** P6a-C6·C7·C8·C8b 넷에 증거가 붙는다.

**Review:** 주입이 앱의 실제 경로를 거쳤는지(단위 테스트로 대체하지 않았는지). 정합성 질의가 Phase 5의 그 넷과 같은 것인지. sparse image를 떼고 지웠는지.

---

## Task 11: 릴리스 발행

**Files:** 없음 (발행 전용). 태그와 GitHub Release가 산출물.

**Interfaces:**
- Consumes: Task 6의 발행 기구, Task 1~10의 **모든 코드가 커밋된 상태**
- Produces: `desktop-v0.3.0` 태그와 그 릴리스(DMG + `.sha256`). Task 12가 두 번째 맥에서 그것을 받는다.

**왜 여기인가:** Task 6에서 발행하면 Task 7~9의 디스크 부족 처리가 **빠진 DMG**가 배포된다. 그리고 태그는 산출물을 만든 코드를 가리켜야 하므로 코드가 전부 커밋된 뒤여야 한다. 이 Task는 **되돌리기 어려운 유일한 자리**다 — 공개 릴리스는 지워도 받아 간 사람에게서 사라지지 않는다.

- [ ] **Step 1: 모든 코드가 커밋됐는지 확인한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git status --short
git log --oneline dev..HEAD
```

기대: 작업트리가 깨끗하고, Task 1~9의 커밋이 전부 보인다. **더러우면 여기서 멈춘다** — 미커밋 코드로 만든 DMG는 재현할 수 없다.

- [ ] **Step 2: 태그를 지금 커밋으로 옮긴다**

Task 6 Step 10이 임시로 찍은 태그가 Task 7~9 코드를 안 가리킨다.

```bash
cd /Users/gim-yeongjae/project/daewha
git tag -f desktop-v0.3.0
git describe --tags --exact-match --match 'desktop-v*'
```

기대: `desktop-v0.3.0`이 지금 HEAD를 가리킨다.

- [ ] **Step 3: 최종 산출물을 처음부터 다시 만든다**

Task 6 Step 10의 DMG는 Task 7~9 코드가 없다. **재사용하지 않는다.**

```bash
cd /Users/gim-yeongjae/project/daewha/desktop
rm -rf out
pnpm run package:release 2>&1 | tail -60
```

기대: 서명 → check-bundle → `.app` 공증 → 스테이플 → check-bundle 재실행 → DMG → DMG 서명·공증·스테이플 → 마운트 확인. 10~20분.

- [ ] **Step 4: 발행한다 (P6a-C14)**

`package.mjs`에 넣지 않고 손으로 한 번 부른다 — 되돌리기 어려운 동작이라 스크립트에 숨기지 않는다. **`deploy/release.sh`를 고치지 않는다**: 그 스크립트는 태그를 `be/worker/pyproject.toml` 버전에 묶고 있어, 한 스크립트에 합치면 웹 배포의 단언이 데스크톱 버전까지 묶는다.

```bash
cd /Users/gim-yeongjae/project/daewha/desktop/out
DMG=$(ls *.dmg)
gh release create desktop-v0.3.0 "$DMG" "$DMG.sha256" \
  --repo Yjason-K/Damwha \
  --target "$(git -C /Users/gim-yeongjae/project/daewha rev-parse HEAD)" \
  --title "Damwha 0.3.0 (macOS)" \
  --notes "$(cat <<'NOTES'
macOS 15.0 이상, Apple Silicon.

설치 후 첫 실행에서 Hugging Face 토큰을 한 번 넣어야 해요.
이전 버전에서 올라오는 경우에도 토큰을 한 번 다시 넣어야 합니다 — 앱 서명 방식이 바뀌었어요.

`shasum -a 256 -c Damwha-0.3.0-arm64.dmg.sha256`으로 받은 파일을 확인할 수 있어요.
NOTES
)"
```

- [ ] **Step 5: 발행 결과와 네임스페이스를 확인한다 (P6a-C14)**

```bash
gh release view desktop-v0.3.0 --repo Yjason-K/Damwha --json tagName,assets -q '.tagName, (.assets[]|.name)'
gh release list --repo Yjason-K/Damwha --limit 6
```

기대: 태그가 `desktop-v0.3.0`, 자산 둘(DMG와 `.sha256`). **`v0.2.3`(셀프호스팅 웹 배포)이 그대로 있고 건드려지지 않았다** — 네임스페이스를 가른 이유가 그것이다.

- [ ] **Step 6: 태그를 푸시한다**

```bash
cd /Users/gim-yeongjae/project/daewha
git push origin desktop-v0.3.0
```

(`gh release create`가 이미 원격에 태그를 만들었으면 이 단계는 no-op이다.)

**Verify:** Step 5. 그리고 받은 DMG의 sha256이 자산의 값과 같은지 — Task 12 Step 3이 다른 맥에서 그것을 다시 본다.

**Review:** Step 1이 깨끗한 트리에서 돌았는지. Step 3이 **새로** 만든 DMG인지(Task 6의 것을 재사용하지 않았는지). 릴리스 노트에 최소 macOS와 토큰 재입력 안내가 있는지. `v*` 태그를 건드리지 않았는지.

**되돌리기:** `gh release delete desktop-v0.3.0 --repo Yjason-K/Damwha --yes && git push --delete origin desktop-v0.3.0 && git tag -d desktop-v0.3.0`. **이미 받아 간 사람에게서는 사라지지 않는다.**

---

## Task 12: 두 번째 맥 종단간 검증

**Files:** 없음 (검증 전용).

**Interfaces:** Consumes: Task 6의 DMG + 릴리스.

**환경:** 두 번째 맥(macOS 26.x), **새 사용자 계정**. 개발 도구가 시스템 전역(`/opt/homebrew`)에 남는 것은 한계로 적는다 — 이 검증이 증명하는 것은 "개발 환경이 전혀 없는 맥"이 아니라 "개발자 계정 밖"이다.

- [ ] **Step 1: 새 사용자 계정을 만든다**

시스템 설정 → 사용자 및 그룹 → 새 계정. 로그아웃 후 그 계정으로 로그인.

- [ ] **Step 2: 개발 환경이 없음을 기록한다**

```bash
which python3 uv brew docker node pnpm; echo "---"; echo $PATH
ls ~/Library/Application\ Support/Damwha 2>&1
```

기대: `uv`·`pnpm`·`docker` 없음(`/opt/homebrew`에 있으면 그것을 한계로 적는다). `Damwha` 폴더 없음(첫 실행 전).

- [ ] **Step 3: 릴리스에서 받는다 — 우리가 만든 파일이 아니라 배포된 파일로**

```bash
cd ~/Downloads
gh release download desktop-v0.3.0 --repo Yjason-K/Damwha   # 또는 브라우저로
shasum -a 256 -c Damwha-0.3.0-arm64.dmg.sha256
```

기대: `OK`. **`gh`가 없으면 브라우저로 받는다** — 그쪽이 진짜 사용자 경로다.

- [ ] **Step 4: Gatekeeper (P6a-C9)**

DMG를 더블클릭해 `.app`을 `/Applications`로 끌고, 더블클릭으로 연다.

기대: **"확인되지 않은 개발자" 대화상자가 뜨지 않는다.** 뜨면 공증·스테이플이 실제로는 안 된 것이다.

- [ ] **Step 5: 오프라인에서도 열리는지 (스테이플 확인)**

Wi-Fi를 끄고 앱을 완전히 종료한 뒤 다시 연다.

기대: 열린다. 막히면 티켓이 앱에 스테이플되지 않고 DMG에만 붙은 것이다.

```bash
spctl --assess --type execute -vv /Applications/Damwha.app
xcrun stapler validate /Applications/Damwha.app
```

- [ ] **Step 6: 토큰 온보딩 → 모델 → 실제 처리 (P6a-C10)**

Wi-Fi를 켜고, 토큰 창에 HF 토큰을 넣는다. 마이크 대화상자가 뜨는지 본다. 실오디오 1건을 올려 끝까지 돌린다.

기대: 토큰 검증 통과 → 모델 다운로드(수 GB, 시간 걸림) → `meeting.status='done'` + `utterance` 행 존재. 상태 창에서 서비스 넷이 `ok`.

- [ ] **Step 7: 재빌드·재설치 후 권한·토큰 유지 (P6a-C11 — 이 Phase에서 가장 값진 기준)**

첫 맥에서 버전을 `0.3.1`로 올려 `desktop-v0.3.1` 태그로 `package:release`를 다시 돌리고, 두 번째 맥에 설치한다(기존 앱을 덮어쓴다).

기대: **마이크 권한을 다시 묻지 않고, 토큰 재입력도 없다.** Developer ID의 DR이 identity 기반이라 재빌드에 걸쳐 안정적임의 종단간 증명이다. 다시 물으면 §3-7의 판단이 틀린 것이고 결과 문서에 그대로 적는다.

- [ ] **Step 8: 결과를 기록한다**

결과 문서에 회차·명령·출력·판정. **macOS 15.0은 실행으로 증명되지 않았음**(두 번째 맥이 26.x)을 한계로 적는다 — 증명된 것은 26.x 실행과 15.0 선언·단언이다.

**Verify:** P6a-C9·C10·C11 셋에 증거가 붙는다.

**Review:** Step 3이 **릴리스에서 받은** 파일인지(첫 맥에서 복사한 것이면 배포 경로를 시험하지 않은 것이다). Step 5가 정말 오프라인이었는지. Step 7이 같은 identity로 서명된 다른 버전인지.

---

## Task 13: 결과 문서와 로드맵 갱신

**Files:**
- Create: `docs/superpowers/reports/2026-09-20-electron-phase-6a-signing-distribution-results.md`
- Modify: `docs/electron-migration-roadmap.md`
- Modify: `desktop/CLAUDE.md`

- [ ] **Step 1: 결과 문서를 쓴다**

스펙의 완료 기준 14건(P6a-C1~C14)마다 **충족/미충족/미판정**과 증거(명령·출력·커밋)를 적는다. 스펙 리뷰·계획 검증·Task별 실행과 리뷰·최종 검증을 구분해 기록한다. **실행하지 않은 검증을 성공으로 적지 않는다.**

남은 제약으로 최소 세 가지를 적는다:
- macOS 15.0은 선언·단언까지만 증명됐다(검증 맥이 26.x).
- 두 번째 맥에 개발 도구가 시스템 전역으로 남아 있다.
- mlx 15.0 휠의 런타임 동작은 C10이 처음 본 것이다(스펙 §11-4).

- [ ] **Step 2: 로드맵을 갱신한다**

Phase 6a 절의 상태를 "스펙 작성 완료, 리뷰 전"에서 실제 결과로 바꾼다. 머리말의 상태 단락도 함께. P0-C11(최소 macOS)이 닫혔음을 Phase 0 절에서 가리킨다.

- [ ] **Step 3: `desktop/CLAUDE.md`를 갱신한다**

바뀐 사실을 운영 문서에 반영한다:
- 서명이 ad-hoc에서 Developer ID로 바뀌었다(`signing.json`, 지문, 팀 ID).
- `--release` 플래그와 그때만 도는 것들(공증·DMG·릴리스).
- 최소 macOS 15.0과 그것을 지키는 세 자리 + `check-bundle`의 minos 단언.
- 태그 네임스페이스가 `desktop-v*`이고 `deploy/release.sh`의 `v*`와 다르다.
- 디스크 부족의 두 진입점.
- 개인 키 백업 위치와 그것을 잃었을 때 일어나는 일.

- [ ] **Step 4: 커밋하고 PR을 연다**

```bash
cd /Users/gim-yeongjae/project/daewha
git add docs/ desktop/CLAUDE.md
git commit -m "docs(phase6a): 결과를 기록하고 로드맵·운영 문서를 갱신한다"
git push -u origin feat/electron-migration-phase-6a-signing-distribution
gh pr create --base dev --title "Phase 6a — 서명·배포" --body-file docs/superpowers/reports/2026-09-20-electron-phase-6a-signing-distribution-results.md
```

**Verify:** 완료 기준 14건 전부에 판정과 증거 경로가 있다.

**Review:** 미판정을 충족으로 적지 않았는지. 한계 셋이 적혔는지. `desktop/CLAUDE.md`가 실제 코드와 맞는지.

---

## 실행 순서와 의존성

```
Task 1 (postgres·ffmpeg 15.0) ─┐
Task 2 (mlx 15.0) ─────────────┼→ Task 4 (plist) → Task 5 (Developer ID) → Task 6 (공증·DMG 기구) ─┐
Task 3 (minos 판독기·단언) ────┘                                                                    │
                                                                                                    ├→ Task 10 (packaged 검증)
Task 7 (worker 디스크) ─┬→ Task 9 (화면) ───────────────────────────────────────────────────────────┘
Task 8 (업로드 507) ────┘                                                                            │
                                                                                                    ↓
                                                              Task 11 (릴리스 발행) → Task 12 (두 번째 맥) → Task 13 (결과·로드맵)
```

- **Task 1·2·3은 서로 독립이다.** 병렬 가능하지만 1·2는 각각 5~10분 빌드를 물고 같은 `.cache`를 쓰므로 순차가 안전하다.
- **Task 7·8은 서명 갈래와 완전히 독립이다.** 다른 세션에서 병행할 수 있다.
- **Task 5 뒤에는 토큰을 한 번 다시 넣어야 한다**(예고된 퇴행). Task 10의 packaged 회차 전에 해 둔다 — 스펙 §12-5.
- **발행은 Task 11 하나뿐이고, 모든 코드가 커밋되고 packaged 검증이 끝난 뒤다.** Task 6에서 내면 Task 7~9의 디스크 부족 처리가 빠진 DMG가 배포되고, 태그가 산출물을 만든 코드를 안 가리킨다.
- **Task 6의 태그는 임시다.** 기구가 도는지 보려고 찍는 것이고 Task 11이 `git tag -f`로 옮긴다.

## 되돌리는 법

| 무엇 | 되돌리기 |
| --- | --- |
| Task 1·2의 빌드 | 옛 캐시 트리(`pg-<옛키>`·`ffmpeg-<옛키>`·`rt-<옛키>`)가 `.cache`에 남아 있다. 스크립트를 되돌리면 옛 키가 다시 적중한다 |
| Task 5의 서명 전환 | `signing.json`을 지우면 빌드가 멈춘다(ad-hoc으로 조용히 안 떨어진다). 되돌리려면 커밋을 revert |
| Task 5 뒤 토큰 무효 | 되돌릴 것이 아니다. 온보딩에서 다시 넣는다. 옛 `hf-token.bin`은 지워지지 않고 남는다 |
| Task 6의 DMG | 산출물일 뿐이다. `rm -rf desktop/out`. 발행하지 않았으므로 밖으로 나간 것이 없다 |
| Task 11의 릴리스 | `gh release delete desktop-v0.3.0 --repo Yjason-K/Damwha --yes` + `git push --delete origin desktop-v0.3.0` + `git tag -d desktop-v0.3.0`. **이미 받아 간 사람에게서는 사라지지 않는다** — 이것이 계획에서 유일하게 되돌리기 어려운 자리다 |
| 두 번째 맥의 설치 | `/Applications/Damwha.app`과 `~/Library/Application Support/Damwha` 삭제. 그 계정 전용이라 첫 맥에 영향 없음 |
| 전체 | 브랜치를 버린다. `dev`는 손대지 않았다 |
