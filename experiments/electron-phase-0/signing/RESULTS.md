# Task 8 — 서명 · hardened runtime · Gatekeeper 제약

**스펙:** P0-C9 (`docs/superpowers/specs/2026-09-09-electron-phase-0-packaging-validation-design.md`)
**위험:** R-4, R-5, R-12
**측정 도구:** `experiments/electron-phase-0/signing/probe.sh`
**검증:** `experiments/electron-phase-0/verify/t8-hardened.sh`, `t8-signed-runtime.sh`, `t8-results-complete.sh`

이 문서는 **"성공/실패"가 아니라 "제약이 특정되었는가"로 읽는다** (스펙 P0-C9 비고).
서명이 불가능하다는 결론도 유효한 결과이며, 그 경우 Phase 6의 범위가 바뀐다.

## 결론 먼저

| 물음 | 실측 답 |
| --- | --- |
| ad-hoc 서명 + hardened runtime을 거부하는 파일이 있나 | **없다.** Mach-O 526개 전부가 받아들였다 (§2). |
| 서명이 아예 없는 Mach-O가 있나 | **arm64 슬라이스에는 0개.** universal 10개의 x86_64 슬라이스만 서명이 없었다 (§1). |
| 필요한 entitlement 최소 집합 | **`allow-unsigned-executable-memory` + `disable-library-validation` 둘.** `allow-jit`은 필요 없다 (§3). |
| R-4가 나타났나 | **나타났다 — 다만 MLX/torch가 아니라 `numba`에서.** MLX의 Metal 셰이더 런타임 컴파일과 `torch.jit.script`는 hardened runtime에서 멀쩡했다 (§4). |
| R-5가 나타났나 | **나타났다. 두 겹으로.** ad-hoc 서명에서는 library validation을 켜 두면 **자기 자신의 dylib조차** 로드하지 못하고, 그것을 끈 뒤에도 **서명이 없는 `.so`는 여전히 막힌다** (§5). |
| Gatekeeper 동작 | **차단.** 격리 속성이 붙은 ad-hoc 서명 바이너리는 SIGKILL되고, GUI 프롬프트가 뜨며, **파일이 휴지통으로 옮겨질 수 있다**(휴지통 이동은 증거가 보존되지 않은 1차 관찰이다 — §6). |
| 공증 | **하지 않았다.** 선결 조건만 목록으로 정리했다 (§7). |
| R-12 | **해소되지 않았다.** Phase 6으로 인계한다 (§8). |

## 0. 범위와 방법

**범위는 ad-hoc 서명까지다.** Apple Developer Program 미가입이 확정됐다(스펙 §7.1 U-3,
2026-09-09 사용자 결정). `codesign -s -`와 `--options runtime`은 멤버십 없이 쓸 수 있고,
R-4·R-5는 그 조합으로 실측된다. **공증은 제출하지 않았다** — 선결 조건만 §7에 목록으로
정리했다. `probe.sh`에는 공증 제출 도구의 이름조차 들어 있지 않다(계획 Task 8 V6).

| 원칙 | 무엇을 했나 |
| --- | --- |
| 원본을 지킨다 | 서명은 `bundle/`의 사본 `signed/`에만 적용했다. 원본은 `codesign --display` / `--verify`로 **읽기만** 했다. 계획 V7이 원본의 G1 무결성을 다시 확인하고(아래 루트 문제를 함께 보라), `verify/t8-hardened.sh`가 원본에 `runtime` 플래그가 붙지 않았음을 음성 대조로 확인한다. |
| 서명 도구는 격리 대상이 아니다 | `codesign`·`xattr`·`spctl`·`file`·`log`는 피검사 대상이 아니라 측정 수단이다(스펙 §4.0). |
| 서명 후 실행은 격리 러너로 | 이 문서의 모든 실행 결과는 `lib/run-isolated.sh`(G2, 스펙 §4.2)를 지났다. |
| 사본은 자기 자신을 써야 한다 | `bundle/python/bin/`의 콘솔 스크립트 셔뱅은 **원본의 절대 경로**를 가리킨다(Task 3의 G1 INFO 5231건). 사본에서 그대로 두면 `signed/…/mlx_lm.server`를 실행해도 커널이 원본의 서명 안 된 python을 exec한다. 복사 직후 셔뱅 접두사를 `signed/`로 돌렸고, `selfcheck` 검사가 `sys.prefix`·`stdlib`가 `signed/` 아래인지 회차마다 확인한다. |
| 검사마다 프로세스를 새로 띄운다 | hardened runtime 위반은 파이썬 예외가 아니라 **프로세스 종료**로 나타난다. 한 프로세스에 몰면 첫 위반에서 나머지 결과가 통째로 사라진다. |

**계획 V7과 허용 목록의 루트 — 충돌 하나를 그대로 적어 둔다.** 계획 Task 8 V7은
`check-macho.sh experiments/electron-phase-0/bundle`이 exit 0이기를 기대하는데, 그 명령은
**exit 1**을 낸다. 서명 때문이 아니다. `lib/g1-allowlist.txt`의 경로 열은 **검사 대상 루트
기준 상대 경로**이고(`check-macho.sh`의 `allow_reason "${f#$ROOT/}"`), 그 목록은 Task 3이
`ROOT=bundle/python`으로 돌리며 쓴 것이다(계획 Task 3 V1). `ROOT=bundle`로 부르면 같은
파일의 상대 경로가 `python/lib/…`로 한 칸 깊어져 24개 규칙이 하나도 걸리지 않고, Task 3이
ALLOW로 분류한 42건이 그대로 위반으로 다시 나온다. 같은 트리를 하위 셋으로 나눠 부르면
`bundle/python` ALLOW 42건·위반 0건, `bundle/pg`·`bundle/ffmpeg` 위반 0건으로 **전부
exit 0**이다(증거 `docs/superpowers/reports/evidence/phase-0/t8-bundle-integrity.txt`).
즉 원본은 멀쩡하고, 어긋난 것은 검사 호출의 루트다. 이 Task는 공유 검사기와 허용 목록을
고치지 않았다 — 그 둘은 Task 3에서 리뷰를 거쳤다. **고친 쪽은 호출이다.** 커밋
`a276953`이 계획 Task 8 V7을 번들별 V7·V7b·V7c로 쪼개고 규칙 6e("G1 정적 검사는 번들을
하나씩 부른다")를 신설했으며, 계획 Task 11 V1도 `t11-g1-all-bundles.sh`로 셋을 각각
검사한다. 검사기를 접미사 매칭으로 바꾸는 대안은 택하지 않았다 — 그러면 "경로를 반드시
적게 해 전역 면제를 막는다"는 허용 목록 설계가 무너지고, 상위 루트 호출은 형제 번들 간
절대경로 참조를 INFO로 흡수해 오히려 느슨해진다.

**디스크 판단.** 데이터 볼륨 여유가 12~15 GiB뿐이고 `bundle/python`이 1.5 GiB다. `bundle/`
전체(약 1.6 GiB)를 복사해도 여유가 10 GiB 이상 남으므로 **부분 복사를 택하지 않고 전체를
복사했다.** `probe.sh`가 복사 전에 `du`로 번들 크기를 재고 `df`로 여유를 확인해, 여유가
(번들 크기 + 2) GiB 미만이면 시작하지 않고 실패한다(스펙 §4.4, R-14). 사본은 지우지 않고
남겨 둔다 — V2·V3이 그 사본을 다시 검사하기 때문이다. `signed/`는
`experiments/electron-phase-0/.gitignore`가 무시한다.

## 1. 번들 Mach-O 서명 전수 조사

원본 `bundle/` 하위의 정규 파일을 `file`로 전수 훑어 Mach-O를 뽑고, 각각에
`codesign --verify`를 `--arch arm64`와 `--arch` 없이 두 번 돌려 분류했다. 전수 목록은
`signing/unsigned-inventory.txt`에 있다.

<!-- BEGIN:inventory -->

측정: `2026-09-10T02:43:31Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-inventory.txt`

| 분류 | 개수 |
| --- | --- |
| Mach-O 정규 파일 전체 | 526개 |
| **arm64 슬라이스에 서명이 없는 것** | **0개** |
| arm64는 서명 / 다른 슬라이스가 서명 없음 | 10개 |
| 전 슬라이스 서명 | 516개 |
| arm64 슬라이스가 아예 없는 것 | 0개 |

`codesign --display` 분류 (원본, 서명 전):

```
282 signed sig=adhoc flags=0x20002(adhoc,linker-signed) team=not set
234 signed sig=adhoc flags=0x2(adhoc) team=not set
10 arm64-signed-otherarch-unsigned sig=adhoc flags=0x20002(adhoc,linker-signed) team=not set
```

**Task 3 리뷰의 관찰을 이 측정이 정정한다.** Task 3 리뷰는 `codesign -v`가
`code object is not signed at all`을 낸 파일을 "서명이 아예 없는 것"으로
기록했다. `--arch`를 나눠 다시 재 보니 그 파일들은 **arm64 슬라이스가
ad-hoc(linker-signed) 서명돼 있고 x86_64 슬라이스만 서명이 없는** universal
바이너리였다. `codesign --verify`를 `--arch` 없이 부르면 슬라이스 하나만
서명이 없어도 파일 전체를 그렇게 보고한다. 지금 로드되는 이유가 그것이다 —
arm64 호스트는 arm64 슬라이스만 매핑한다.

다른 슬라이스에 서명이 없는 10개 전량 (전수 목록은 `signing/unsigned-inventory.txt`):

- `python/lib/python3.12/site-packages/_sounddevice_data/portaudio-binaries/libportaudio.dylib`
- `python/lib/python3.12/site-packages/charset_normalizer/cd.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/charset_normalizer/md.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/cu2qu/cu2qu.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/feaLib/lexer.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/misc/bezierTools.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/pens/momentsPen.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/qu2cu/qu2cu.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/varLib/iup.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/grpc/_cython/cygrpc.cpython-312-darwin.so`

arm64 슬라이스에 서명이 없는 Mach-O는 **0개**다. 즉 이 번들에는 우리가
실제로 매핑하는 코드 중 서명이 없는 것이 없다.

<!-- END:inventory -->

## 2. ad-hoc 서명과 hardened runtime 적용

<!-- BEGIN:signing -->

측정: `2026-09-10T02:43:31Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-sign.txt`

적용한 명령:

```
codesign --force --sign - --options runtime --timestamp=none <Mach-O>
```

| 항목 | 값 |
| --- | --- |
| 사본 `signed/`의 Mach-O 정규 파일 | 526개 |
| 서명 성공 | 526개 |
| **서명 실패** | **0개** |
| 서명 후 `codesign --verify`(전 슬라이스) 실패 | 0개 |
| 서명 후 `runtime` 플래그가 없는 파일 | 0개 |
| 셔뱅을 사본으로 돌린 콘솔 스크립트 | 65개 |

**서명 실패 파일 목록**

**0건.** 번들의 Mach-O 526개 전부가 ad-hoc 서명과 hardened runtime
옵션을 받아들였다 — 서명 자체를 거부하는 파일은 없었다. 서명 뒤에는 x86_64
슬라이스까지 포함해 전 슬라이스가 서명됐고(`--verify` 실패 0건),
`runtime` 플래그가 전량에 붙었다.

<!-- END:signing -->

## 3. entitlement 최소 집합

<!-- BEGIN:entitlements -->

측정: `2026-09-10T02:43:31Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-entitlements.txt`

회차마다 `signed/python/bin/python3.12`를 그 조합으로 재서명하고, 검사 일곱 개를
**각각 별도 프로세스로** 돌렸다 (hardened runtime 위반은 예외가 아니라 프로세스
종료로 나타나서, 한 프로세스에 몰면 첫 위반에서 나머지 결과가 사라진다).
실행은 전부 `lib/run-isolated.sh`를 지난다.

토큰: `jit` = `com.apple.security.cs.allow-jit`, `uem` = `com.apple.security.cs.allow-unsigned-executable-memory`,
`dlv` = `com.apple.security.cs.disable-library-validation`.

| 단계 | 회차 | selfcheck | unsigned-so | numba-jit | stack-imports | torch-mps | torch-jit | mlx-metal | mlx-compile | mlx-lm-gen | 
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| escalate | `none` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| escalate | `jit` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| escalate | `jit+uem` | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL |
| escalate | `jit+uem+dlv` | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| reduce | `uem+dlv` | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| reduce | `dlv` | OK | OK | FAIL | - | - | - | - | - | - |
| reduce | `uem` | FAIL | - | - | - | - | - | - | - | - |

`-`는 그 회차에서 돌리지 않았다는 뜻이다. `reduce` 단계는 첫 FAIL에서 멈춘다 —
그 entitlement가 필요한지만 알면 되고, 같은 회차의 나머지 검사를 더 돌려도
결론이 바뀌지 않는다.

**결론: 필요한 entitlement 최소 집합 = com.apple.security.cs.allow-unsigned-executable-memory, com.apple.security.cs.disable-library-validation**

`escalate`가 처음 통과한 회차는 `jit+uem+dlv`이고, 거기서 하나씩 빼 본
`reduce` 결과가 `uem+dlv`이다. 누적으로만 재면 "마지막에 더한 것이
필요했다"까지만 알 수 있어서 빼는 단계를 따로 뒀다.

**`DYLD_PRINT_LIBRARIES` 실측 상태: MEASUREMENT_UNAVAILABLE.**
hardened runtime은 프로세스를 dyld 기준 restricted로 만들어 `DYLD_*`를
무시하게 한다. 즉 **서명한 뒤에는 G2의 dyld 실측이 끊긴다.** 앞 Task들이
쌓은 dyld 증거는 서명 전 번들에서만 얻을 수 있다는 뜻이고, Phase 6이
서명된 산출물에서 같은 측정을 하려면 `com.apple.security.cs.allow-dyld-environment-variables`
를 **측정용으로만** 붙여야 한다. 이 Task는 그것을 최소 집합에 넣지 않았다 —
제품 동작에 필요한 것이 아니라 계측에만 필요하기 때문이다.

실패한 검사의 오류 원문:

```
[escalate none] selfcheck
  {"check": "selfcheck", "ok": false, "exit": 134, "reason": "dyld[61340]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] unsigned-so
  {"check": "unsigned-so", "ok": false, "exit": 134, "reason": "dyld[61446]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] numba-jit
  {"check": "numba-jit", "ok": false, "exit": 134, "reason": "dyld[61549]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] stack-imports
  {"check": "stack-imports", "ok": false, "exit": 134, "reason": "dyld[61652]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] torch-mps
  {"check": "torch-mps", "ok": false, "exit": 134, "reason": "dyld[61755]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] torch-jit
  {"check": "torch-jit", "ok": false, "exit": 134, "reason": "dyld[61858]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] mlx-metal
  {"check": "mlx-metal", "ok": false, "exit": 134, "reason": "dyld[61961]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] mlx-compile
  {"check": "mlx-compile", "ok": false, "exit": 134, "reason": "dyld[62064]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate none] mlx-lm-gen
  {"check": "mlx-lm-gen", "ok": false, "exit": 134, "reason": "dyld[62168]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] selfcheck
  {"check": "selfcheck", "ok": false, "exit": 134, "reason": "dyld[62284]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] unsigned-so
  {"check": "unsigned-so", "ok": false, "exit": 134, "reason": "dyld[62387]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] numba-jit
  {"check": "numba-jit", "ok": false, "exit": 134, "reason": "dyld[62490]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] stack-imports
  {"check": "stack-imports", "ok": false, "exit": 134, "reason": "dyld[62593]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] torch-mps
  {"check": "torch-mps", "ok": false, "exit": 134, "reason": "dyld[62696]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] torch-jit
  {"check": "torch-jit", "ok": false, "exit": 134, "reason": "dyld[62800]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] mlx-metal
  {"check": "mlx-metal", "ok": false, "exit": 134, "reason": "dyld[62907]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] mlx-compile
  {"check": "mlx-compile", "ok": false, "exit": 134, "reason": "dyld[63010]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit] mlx-lm-gen
  {"check": "mlx-lm-gen", "ok": false, "exit": 134, "reason": "dyld[63113]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] selfcheck
  {"check": "selfcheck", "ok": false, "exit": 134, "reason": "dyld[63230]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] unsigned-so
  {"check": "unsigned-so", "ok": false, "exit": 134, "reason": "dyld[63333]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] numba-jit
  {"check": "numba-jit", "ok": false, "exit": 134, "reason": "dyld[63436]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] stack-imports
  {"check": "stack-imports", "ok": false, "exit": 134, "reason": "dyld[63539]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] torch-mps
  {"check": "torch-mps", "ok": false, "exit": 134, "reason": "dyld[63642]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] torch-jit
  {"check": "torch-jit", "ok": false, "exit": 134, "reason": "dyld[63745]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] mlx-metal
  {"check": "mlx-metal", "ok": false, "exit": 134, "reason": "dyld[63848]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] mlx-compile
  {"check": "mlx-compile", "ok": false, "exit": 134, "reason": "dyld[63951]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[escalate jit+uem] mlx-lm-gen
  {"check": "mlx-lm-gen", "ok": false, "exit": 134, "reason": "dyld[64054]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
[reduce dlv] numba-jit
  {"check": "numba-jit", "ok": false, "exit": 137, "reason": "종료 코드 137 = 128+9 — 신호 9 로 죽었다. dyld/stderr 에 남은 줄이 없다"}
[reduce uem] selfcheck
  {"check": "selfcheck", "ok": false, "exit": 134, "reason": "dyld[66162]: Library not loaded: @executable_path/../lib/libpython3.12.dylib Referenced from: <4C4C44A6-5555-3144-A1BD-F878E0600D6B> /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 Reason: tried: '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' (code signature in <4C4C440E-5555-3144-A1C9-83F1C4E3DE68> '/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/lib/libpython3.12.dylib' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs) "}
```

<!-- END:entitlements -->

### 해석

세 가지가 나왔다.

1. **`disable-library-validation`이 없으면 프로세스가 아예 뜨지 않는다.** `none` /
   `jit` / `jit+uem` 회차는 전 검사가 `exit 134`로 끝났고, 이유는 전부 같다.

   ```
   dyld[…]: Library not loaded: @executable_path/../lib/libpython3.12.dylib
     Reason: … (code signature in … '…/signed/python/lib/libpython3.12.dylib'
     not valid for use in process: mapping process and mapped file (non-platform)
     have different Team IDs)
   ```

   메인 실행 파일과 그 dylib을 **같은 `codesign -s -` 실행으로 서명했는데도** "Team ID가
   다르다"고 한다. ad-hoc 서명에는 Team ID가 없고(`TeamIdentifier=not set`), library
   validation은 Team ID가 없는 코드를 "같은 팀"으로 쳐 주지 않기 때문이다. 즉 **ad-hoc
   서명으로는 library validation을 켠 채로 아무것도 못 돌린다.** 이 제약은 Developer ID
   서명에서는 사라질 수 있다 — 그쪽은 Team ID가 실제로 같아지기 때문이다. §8(R-12)이
   그 사각이다.

2. **`allow-unsigned-executable-memory`가 필요하다.** 빼면 `numba-jit`이 SIGKILL된다.
   자세한 것은 §4.

3. **`allow-jit`은 필요 없다.** `escalate`가 처음 통과한 회차는 셋 다 붙인
   `jit+uem+dlv`지만, `reduce`가 `jit`을 빼도 아홉 검사가 전부 통과함을 확인했다.
   누적으로만 재고 멈췄다면 "셋 다 필요하다"는 **틀린 최소 집합**을 기록했을 것이다.

**부수 결과 — 서명하면 dyld 실측이 끊긴다.** hardened runtime은 프로세스를 dyld 기준
restricted로 만들어 `DYLD_*`를 무시하게 한다. 서명된 사본에서는 `run-isolated.sh`의
dyld 증거가 전부 `MEASUREMENT_UNAVAILABLE`이다. P0-C7·P0-C8이 요구하는 dyld 실측은
**서명 전 번들에서만** 얻을 수 있다는 뜻이고, Phase 6이 서명된 산출물에서 같은 측정을
하려면 `com.apple.security.cs.allow-dyld-environment-variables`를 **계측용으로만**
붙여야 한다. 제품 동작에 필요한 것이 아니므로 최소 집합에 넣지 않았다.

## 4. R-4 — JIT / 쓰기+실행 메모리와 GPU 셰이더 컴파일

> R-4: hardened runtime이 MLX의 Metal 셰이더 런타임 컴파일이나 torch의 JIT을 막을 수
> 있다. entitlement로 풀리지 않으면 서명된 앱에서 GPU 경로가 죽는다.

<!-- BEGIN:r4 -->

측정: `2026-09-10T02:43:32Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-r4.txt`

R-4 표면 넷을 골라 **최소 집합**과 **거기서 `allow-unsigned-executable-memory`를
뺀 회차**를 나란히 잰다.

| 검사 | 무엇을 하는가 | A `uem+dlv` | B `dlv` |
| --- | --- | --- | --- |
| `numba-jit` | numba 의 LLVM JIT — 기계어를 쓰기+실행 메모리에 올린다. `mlx_whisper` 가 import 사슬로 끌어온다 | OK | FAIL |
| `torch-jit` | `torch.jit.script` | OK | OK |
| `mlx-metal` | `mx.fast.metal_kernel` — Metal 셰이더 **소스**를 런타임에 컴파일 | OK | OK |
| `mlx-compile` | `mx.compile` 그래프 컴파일 | OK | OK |

실패한 검사의 오류 원문:

```
[B dlv] numba-jit
  {"check": "numba-jit", "ok": false, "exit": 137, "reason": "종료 코드 137 = 128+9 — 신호 9 로 죽었다. dyld/stderr 에 남은 줄이 없다"}
```

쓰기+실행 매핑 거부는 프로세스에 아무 메시지도 주지 않고 커널이 신호로 끝낸다.
**종료 코드 말고는 남는 것이 없다** — 시스템 로그에도, `~/Library/Logs/DiagnosticReports`의
크래시 리포트에도 그 죽음에 대응하는 줄이 생기지 않는다(SIGKILL 은 크래시 리포트를
만들지 않는다). 그래서 이 절의 인과는 **entitlement 하나를 넣고 빼는 대조**로만
세워진다: 위 표에서 A와 B의 차이는 `com.apple.security.cs.allow-unsigned-executable-memory` 하나뿐이다.

같은 창에서 수집한 코드 서명 관련 로그 줄 전량은 증거 파일에 있다. 아래는 그 앞부분이며,
여기 보이는 것은 `dyld`/library validation 쪽 사건이지 JIT 매핑 거부가 아니다:

```
2026-09-10 11:43:25.153 Df amfid[76589:102a84d] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 11:43:26.955 Df amfid[76589:104f6c8] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
```

<!-- END:r4 -->

### 해석

**R-4는 실재한다. 다만 스펙이 지목한 자리가 아니었다.**

- **MLX의 Metal 셰이더 런타임 컴파일은 막히지 않는다.** `mx.fast.metal_kernel`은 Metal
  소스 문자열을 그 자리에서 컴파일하는데, hardened runtime 아래에서 그대로 돈다. Metal
  셰이더 컴파일이 우리 프로세스가 아니라 **Apple이 서명한 별도 컴파일러 서비스**에서
  일어나고 결과가 GPU 주소 공간에 올라가기 때문으로 보인다(그 인과는 실측하지 않았고,
  관찰한 사실은 "막히지 않는다"까지다). `mx.compile`과 `mlx_lm`의 실제 8토큰 생성도
  같이 통과했다.
- **`torch.jit.script`도 막히지 않는다.** TorchScript는 IR 인터프리터라 기계어를 만들지
  않는다. (참고: `torch.compile`/inductor는 런타임에 C++ 컴파일러를 부르는데, 번들에
  툴체인이 없어 어차피 이 번들의 경로가 아니다. Phase 4가 그 경로를 쓰지 않는지 확인해야
  한다.)
- **실제로 죽는 것은 `numba`다.** `numba`는 LLVM MCJIT으로 기계어를 만들어 **쓰기+실행**
  메모리에 올린다. hardened runtime은 그 매핑을 거부하고, 파이썬 예외가 아니라
  프로세스를 SIGKILL한다(`exit 137 = 128+9`).

  **사망 지점은 이 Task가 특정하지 못했다.** `check_numba_jit`(`probe.sh:391-406`)이 한
  프로세스에서 `import numba` + `@njit` 정의 + 호출을 모두 하므로, SIGKILL이 import에서
  났는지 컴파일에서 났는지 증거가 구분하지 않는다. 잰 것은 **그 셋을 묶어 돌리면
  SIGKILL이고 `uem`을 붙이면 통과한다**까지다.

  **방향이 Phase 4 작업량을 바꾼다.** 이것이 담화에 걸리는 자리는 `mlx_whisper` →
  `numba` import 사슬인데, 번들의 `mlx_whisper/timing.py`는 `:8`에서 `import numba`를
  하고 `:47`·`:72`에서 `@numba.jit(nopython=True)`로 함수를 **지연 컴파일**한다. 사망
  지점이 컴파일이라면 STT는 import에서 죽지 않고 **word-timestamp DTW 경로에서만**
  죽는다 — 그러면 사슬을 끊는 대신 그 기능만 피하는 선택지가 생긴다. import 자체가
  거부되는 것이라면 STT 경로가 통째로 죽는다. **재측정 대상이며 Phase 4로 넘긴다**
  (`import numba` 만 하는 프로세스와 `@njit` 호출까지 하는 프로세스를 갈라 재면 된다).

  덧붙여 **`dlv`만 붙인 회차에서 `stack-imports`를 직접 재지는 않았다** — `reduce` 단계는
  첫 FAIL(`numba-jit`)에서 멈추고, §3 표의 그 행이 나머지를 `-`로 남긴 이유가 그것이다.

  **`com.apple.security.cs.allow-jit`은 최소 집합에 들어가지 않는다.** `allow-jit`은
  `MAP_JIT` 매핑을 허용하는 entitlement이고 numba의 LLVM MCJIT은 그 경로를 쓰지 않는
  것으로 알려져 있는데, **이 Task가 실측한 것은 거기까지가 아니다.** 잰 회차는
  `uem+dlv`(numba-jit OK)와 `dlv`(numba-jit SIGKILL) 둘이고 **`jit+dlv`는 재지 않았다** —
  `reduce`가 통과 회차 `jit+uem+dlv`에서 `jit`을 먼저 빼 `uem+dlv`가 전 검사를 통과하는
  것을 본 뒤, 다음으로 `uem`을 빼 `dlv`가 깨지는 것을 봤기 때문이다. 그래서 실측이
  말하는 것은 **`uem`이 있으면 `@njit`이 컴파일되고 실행되며 없으면 SIGKILL이다**까지고,
  쓰기+실행 매핑을 허용하는 것이
  `com.apple.security.cs.allow-unsigned-executable-memory`라는 것까지다. "`jit`만으로는
  안 된다"는 문헌 지식이지 이 Task의 관찰이 아니다.

**Phase 4·6에 대한 함의:** 서명된 앱의 entitlements plist에
`com.apple.security.cs.allow-unsigned-executable-memory`가 반드시 들어가야 한다. 이
entitlement는 hardened runtime의 메모리 보호를 상당 부분 무력화하므로 공증 심사에서
정당화가 필요할 수 있다. 대안은 `numba`를 번들에서 빼는 것인데 `mlx_whisper`가 끌어오는
의존이라 STT 경로를 함께 봐야 한다 — Phase 4의 결정 항목이다.

## 5. R-5 — 서명되지 않은 `.so` 로딩

> R-5: 라이브러리 검증(library validation)이 Python이 런타임에 여는 서명되지 않은
> `.so` 로딩을 막을 수 있다.

<!-- BEGIN:r5 -->

측정: `2026-09-10T02:43:32Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-r5.txt`

메인 실행 파일 `signed/python/bin/python3.12`는 ad-hoc 서명 + `--options runtime`
이다. 그 프로세스가 여는 `.so`의 서명 상태와 entitlement만 바꿔 세 번 잰다.
대상은 원본에서 슬라이스 하나라도 서명이 없던 10개이고, B·C는 사본에서
그 파일들만 `codesign --remove-signature`로 되돌려 만들었다(10개).
관찰 뒤 전부 도로 서명했다.

| # | `.so` 서명 | entitlement | 결과 |
| --- | --- | --- | --- |
| A | ad-hoc 서명함 | `uem+dlv` | 열린다 |
| B | **서명 없음** | `uem+dlv` | **막힌다** |
| C | 서명 없음 | `uem` (library validation 켠 상태) | **막힌다** — 4단계 `escalate`에서 이 회차가 이미 깨졌다 |

```
A  so=ad-hoc 서명  ent=uem+dlv  OK
B  so=서명 없음  ent=uem+dlv  FAIL
C  so=서명 없음  ent=uem  REF
```

<!-- END:r5 -->

### 해석

**R-5는 두 겹으로 실재한다.**

1. **library validation을 켠 채로는 아무것도 못 연다.** ad-hoc 서명에서는 `.so`가
   서명돼 있든 아니든 상관없이 `libpython3.12.dylib`부터 막힌다(§3 해석 1). C 회차가
   그것이다.
2. **library validation을 꺼도 서명이 없는 `.so`는 여전히 막힌다.** B 회차에서 대상
   10개의 서명을 떼자 `dlopen`이 이렇게 실패했다.

   ```
   ImportError: dlopen(…/charset_normalizer/cd.cpython-312-darwin.so, 0x0002):
     tried: '…/cd.cpython-312-darwin.so' (missing code signature in <…>)
   ```

   `disable-library-validation`은 "서명 주체를 따지지 말라"는 뜻이지 "서명이 없어도
   된다"는 뜻이 아니다. Apple Silicon에서는 실행 페이지에 유효한 서명이 필요하다.

**그런데 이 번들에서는 그 조건이 이미 충족돼 있다.** §1이 보여 주듯 arm64 슬라이스에
서명이 없는 Mach-O는 0개다. Task 3 리뷰가 "서명이 아예 없다"고 본 10개는 x86_64
슬라이스만 서명이 없는 universal 바이너리였고, arm64 호스트는 그 슬라이스를 매핑하지
않는다. 게다가 §2에서 전량을 ad-hoc 서명하면서 x86_64 슬라이스까지 채워졌다.

**Phase 4·6에 대한 함의:** 번들에 새 wheel을 넣을 때마다 §1과 같은 전수 조사를 돌려야
한다. arm64 슬라이스에 서명이 없는 `.so`가 하나라도 들어오면 서명된 앱에서 그 모듈만
조용히 `ImportError`가 된다. 반대로, **모든 Mach-O에 서명을 다시 거는 빌드 단계가 있으면
이 위험은 구조적으로 사라진다** — 이 Task가 실측한 대로 526개 전부가 서명을 받아들였다.

## 6. Gatekeeper 동작

<!-- BEGIN:gatekeeper -->

측정: `2026-09-10T01:49:42Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-quarantine.txt`

부여한 격리 속성: `0081;6aa20ca4;damwha-phase0-probe;` (Finder·브라우저가 쓰는 형식 그대로)

같은 명령을 격리 속성 **없이** 한 번, **붙인 채로** 한 번 돌렸다. 대조군이
없으면 종료 코드가 Gatekeeper 때문인지 알 수 없다. 격리 실행 직전에 대상마다
`--identifier`를 그 회차 전용 값으로 바꿔 다시 서명한다 — Gatekeeper의 판정은
cdhash 단위로 기억돼서, 같은 cdhash를 한 번 통과시키면 그 다음 회차가 조용히
달라지기 때문이다(실측: 1회차 SIGKILL, 2회차 exit 0).

| 대상 | 대조군 실행 (속성 없음) | `spctl --assess --type execute` | 격리 속성이 붙은 채로 실행 | OS가 파일을 지웠나 |
| --- | --- | --- | --- | --- |
| `python/bin/python3.12` | exit 0 | exit 3 | exit 137 | no |
| `ffmpeg/bin/ffprobe` | exit 0 | exit 3 | exit 137 | no |
| `pg/bin/postgres` | exit 0 | exit 3 | exit 137 | no |

`spctl` 원문과 실행 출력은 증거 파일에 그대로 있다. 종료 코드 137은 128+9,
즉 **SIGKILL**이다. 누가 죽였는지는 시스템 로그가 말해 준다:

```
2026-09-10 10:49:24.649 Df amfid[76589:fa0a0e] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 10:49:24.792 Df syspolicyd[728:fa0c70] [com.apple.syspolicy.exec:default] GK evaluateScanResult: 1, PST: (path: 40b87848f627f51a), (team: (null)), (id: damwha-t8-gk-20260910014924-python3.12), (bundle_id: NOT_A_BUNDLE), 1, 0, 1, 0, 0, 0, 5
2026-09-10 10:49:24.792 Df syspolicyd[728:fa0c70] [com.apple.syspolicy.exec:default] Prompt shown (8, 0), waiting for response: PST: (path: 40b87848f627f51a), (team: (null)), (id: damwha-t8-gk-20260910014924-python3.12), (bundle_id: NOT_A_BUNDLE)
2026-09-10 10:49:31.236 Df amfid[76589:fa0a0e] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/ffmpeg/bin/ffprobe not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/ffmpeg/bin/ffprobe, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 10:49:31.727 Df syspolicyd[728:fa040b] [com.apple.syspolicy.exec:default] GK evaluateScanResult: 2, PST: (path: 8e9bacff6298e297), (team: (null)), (id: ffprobe-555549441c8c837ca7da384fa0363ce1e40ae71c), (bundle_id: NOT_A_BUNDLE), 0, 0, 1, 0, 0, 0, 0
2026-09-10 10:49:32.304 Df amfid[76589:fa0a0e] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/ffmpeg/bin/ffprobe not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/ffmpeg/bin/ffprobe, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 10:49:32.626 Df syspolicyd[728:fa0c71] [com.apple.syspolicy.exec:default] GK evaluateScanResult: 1, PST: (path: 8e9bacff6298e297), (team: (null)), (id: damwha-t8-gk-20260910014924-ffprobe), (bundle_id: NOT_A_BUNDLE), 1, 0, 1, 0, 0, 0, 0
2026-09-10 10:49:32.626 Df syspolicyd[728:fa0c71] [com.apple.syspolicy.exec:default] Prompt shown (6, 0), waiting for response: PST: (path: 8e9bacff6298e297), (team: (null)), (id: damwha-t8-gk-20260910014924-ffprobe), (bundle_id: NOT_A_BUNDLE)
2026-09-10 10:49:34.327 Df amfid[76589:fa0a0e] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/pg/bin/postgres not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/pg/bin/postgres, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 10:49:34.668 Df syspolicyd[728:fa0c72] [com.apple.syspolicy.exec:default] GK evaluateScanResult: 2, PST: (path: d29b941d1e24aa8e), (team: (null)), (id: postgres-55554944168653d2bad83513864afc9ff5a3e35e), (bundle_id: NOT_A_BUNDLE), 0, 0, 1, 0, 0, 0, 0
2026-09-10 10:49:35.107 Df amfid[76589:fa0a0e] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/pg/bin/postgres not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/pg/bin/postgres, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 10:49:35.702 Df syspolicyd[728:fa0c74] [com.apple.syspolicy.exec:default] GK evaluateScanResult: 1, PST: (path: d29b941d1e24aa8e), (team: (null)), (id: damwha-t8-gk-20260910014924-postgres), (bundle_id: NOT_A_BUNDLE), 1, 0, 1, 0, 0, 0, 0
```


**위 블록의 출처를 밝혀 둔다.** 이 절의 값은 `2026-09-10T01:49:42Z`에 완주한
`probe.sh quarantine` 회차가 만든 것이지만, 그 회차가 쓴 증거 파일은 남아 있지 않다.
그 뒤 `02:17:51Z`에 시작한 회차가 중단되면서 대상별 상세 파일을 0바이트로 비웠고,
`signed/python/bin/python3.12`에 `com.apple.quarantine`을 남겨 사용자 화면에 Gatekeeper
대화상자가 반복해서 떴다. 속성은 제거됐고 지금 `signed/`·`bundle/` 전체에 0건이다.
증거 파일 `t8-quarantine.txt`는 그 완주 회차가 남긴 작업 산출물
(`sandbox/t8/frag-gatekeeper.md`, `sandbox/t8/gk-syslog.txt`)에서 **복구한 것**이며,
파일 머리말이 그 사실을 적고 있다. **격리 속성을 다시 붙이지 않기로 한 결정에 따라
재실행하지 않았다.**

이 문단은 `<!-- END:gatekeeper -->` **안쪽**에 있다. 밖에 두면 다음 회차가 블록만 갈아
끼우고 이 문단은 그대로 남아 진짜 증거를 "복구본"이라고 거짓말한다.

**다음 회차 주의.** `cmd_quarantine`의 정리 트랩은 2026-09-10 시점에 **주장하는 보장을
하지 못했다** — 핸들러가 읽는 `targets`가 함수의 `local`이라 EXIT 트랩 시점에 스코프
밖이고, `set -u` 아래에서 `targets: unbound variable`로 즉시 죽어 정리를 0건 했다.
INT/TERM 에서는 정리하되 bash 가 루프 다음 문장으로 복귀해 남은 대상에 속성을 다시
붙였고, `HUP`은 트랩 목록에 없었다. 위에 적힌 "속성이 남았다"가 그 결과다. 상태를
`T8_GK_*` 전역으로 올리고 신호 핸들러가 정리 후 기본 처분으로 자신에게 같은 신호를 다시
올려 실제로 멈추도록 고쳤으며, `HUP`을 추가했다. **그 수정은 재현 대조군으로만
확인했고(정리 0건→3건, 신호 시 exit 0·끝까지 진행→exit 130·즉시 중단) 이 경로 자체는
아직 실행되지 않았다 — 다음 `probe.sh quarantine`이 첫 실측이다.**

<!-- END:gatekeeper -->


### 해석

**격리 속성이 붙은 ad-hoc 서명 바이너리는 실행되지 않는다.** 대조군(속성 없음)은 exit 0,
같은 바이너리에 `com.apple.quarantine`을 붙이면 exit 137(SIGKILL)이다.
`spctl --assess --type execute`도 셋 다 `rejected`(exit 3)를 낸다. 시스템 로그가 이유를
그대로 적는다.

```
amfid: … not valid: Error Domain=AppleMobileFileIntegrityError Code=-423
  "The file is adhoc signed or signed by an unknown certificate chain"
syspolicyd: GK evaluateScanResult: … (team: (null)) …
syspolicyd: Prompt shown (…), waiting for response: …
```

세 가지를 따로 기록한다.

1. **차단이지 프롬프트가 아니다 — 명령줄에서는.** GUI 프롬프트(`Prompt shown`)가 뜨지만
   프로세스는 그것과 무관하게 이미 죽어 있다.
2. **macOS가 파일을 휴지통으로 옮길 수 있다.** 백업 로직이 들어가기 전 회차에서
   `signed/ffmpeg/bin/ffprobe`와 `signed/pg/bin/postgres`가 실제로 사라졌고, 시스템 로그에
   `-[LSCodeEvaluation moveItemToTrashWithReply:]` / `moved … to trash`가 남았다.
   `probe.sh quarantine`은 그 뒤로 대상마다 사본을 먼저 떠 두고 관찰이 끝나면 되돌린다.
   **서명을 원본이 아니라 사본에 건 판단이 여기서 값을 했다** — 원본에 걸었다면 앞 Task의
   산출물이 휴지통으로 갔을 것이다.

   **이 항목만은 증거 파일로 재현되지 않는다.** 그 회차의 로그는 보존되지 않았고, 남아
   있는 `01:49:42Z` 회차에서는 세 대상 모두 파일이 남았다(위 표의 마지막 열 `no`) —
   백업·복구가 들어간 뒤였고 Gatekeeper가 매번 옮기지도 않는다. 즉 파일이 사라진 것은
   1차 관찰이고 `probe.sh`가 백업 로직을 갖게 된 이유지만, 증거로 되짚을 수는 없다.
3. **관찰은 cdhash 단위로 한 번뿐이다.** 같은 바이너리를 격리 속성 없이 한 번 실행해
   두면 그 다음 격리 실행이 통과해 버린다(실측: 1회차 SIGKILL, 2회차 exit 0). 그래서
   `probe.sh quarantine`은 격리 실행 직전에 대상마다 `--identifier`를 그 회차 전용 값으로
   바꿔 다시 서명한다 — 한 번도 평가된 적 없는 cdhash가 되어 항상 "첫 실행" 조건에서
   잰다. 이 처리가 없으면 회차마다 결과가 달라진다.

**Phase 4·6에 대한 함의:** 배포 산출물(DMG)에는 반드시 격리 속성이 붙는다. Developer ID
서명 + 공증 + 스테이플링이 없으면 사용자 맥에서 **앱이 실행되지 않고 지워질 수도 있다.**
"서명 없이 배포하고 사용자가 우클릭으로 열게 한다"는 우회는 `.app` 번들에는 있지만 이
번들처럼 앱 내부에서 exec되는 보조 실행 파일(`postgres`, `ffprobe`, `python3.12`)에는
적용되지 않는다.

## 7. 공증 선결 조건 (목록만 — 제출하지 않았다)

스펙 P0-C9 4항이 요구한 대로 **목록으로만** 정리한다. Phase 0에서는 아무것도 제출하지
않았고, `probe.sh`에는 제출 도구를 부르는 코드가 없다(계획 V6이 그 문자열이 0건임을
검사한다).

| # | 선결 조건 | 지금 상태 |
| --- | --- | --- |
| 1 | Apple Developer Program 유료 멤버십 (연 $99) | **미가입.** 사용자 결정으로 Phase 6 착수 전까지 미룬다. |
| 2 | Developer ID Application 인증서 (앱·dylib 서명용) | 없음. 1이 선결 조건이다. |
| 3 | Developer ID Installer 인증서 (`.pkg`를 낼 경우에만) | 없음. DMG만 낼 것이면 필요 없다. |
| 4 | 모든 Mach-O에 Developer ID 서명 + `--options runtime` | 형태는 이 Task에서 ad-hoc으로 실측했다(526개 전량 성공). 인증서만 바꾸면 되는 자리다. |
| 5 | 서명 타임스탬프 (`--timestamp`) | 이 Task는 ad-hoc이라 `--timestamp=none`으로 껐다. 공증에는 **필수**다. |
| 6 | 앱 번들 안의 nested code 전량 서명 (inside-out 순서) | Phase 6이 Electron `.app` 구조를 만들 때 확정된다. Phase 0의 번들은 `.app`이 아니라 평평한 디렉터리라 순서 문제가 없었다. |
| 7 | entitlements plist 확정 — §3의 최소 집합 | `allow-unsigned-executable-memory`는 hardened runtime의 메모리 보호를 크게 무력화한다. 공증 심사에서 문제 삼을 수 있으므로 근거(§4)를 함께 준비한다. |
| 8 | 제출 아카이브 (`.zip` / `.dmg` / `.pkg`) | Phase 0은 배포 산출물을 만들지 않는다(스펙 §3.2). |
| 9 | App Store Connect API 키 또는 Apple ID + 앱 암호 (제출 자격 증명) | 없음. 1의 결과물이다. |
| 10 | 공증 티켓 스테이플링 | 제출 이후 단계. §6이 그것 없이는 실행이 막힌다는 것을 실측했다. |
| 11 | 하드닝 요구사항 — 서명되지 않은 실행 코드가 번들에 없을 것 | §1의 전수 조사가 그 검사다. arm64 슬라이스 기준 0건. |
| 12 | `com.apple.security.get-task-allow`가 **없을 것** | 이 Task의 entitlement plist에는 없다. 디버그 서명에서 흘러들지 않게 Phase 6이 확인한다. |

## 8. 재현되지 않은 것 — R-12 (미재현 사각)

> R-12: ad-hoc 서명에는 Team ID가 없어, Developer ID 서명 시의 library
> validation("같은 Team ID의 dylib만 허용")을 Phase 0에서 재현할 수 없다.

**이 Task는 이 사각을 없애지 못한다. 없앨 수 없다.**

`codesign -s -`가 만드는 서명에는 Team Identifier가 없다(`TeamIdentifier=not set`).
library validation은 두 갈래로 동작한다.

1. **서명 유무 검사** — 프로세스가 여는 코드에 유효한 서명이 있는가. ad-hoc으로도
   그대로 재현된다. §5의 B 회차가 그것을 쟀다.
2. **Team ID 일치 검사** — 로드되는 dylib의 Team ID가 메인 실행 파일의 것과 같은가.
   여기가 재현되지 않는다.

**§3이 관찰한 것이 R-12를 없애 주지 않는다는 점을 분명히 해 둔다.** `none` 회차의 오류
메시지에 `have different Team IDs`가 나오므로 "Team ID 검사를 이미 봤다"고 읽기 쉽다.
그렇지 않다. 거기서 본 것은 **양쪽 모두 Team ID가 없을 때 검사가 무조건 거부하는**
동작이고, Developer ID 서명에서 문제가 되는 것은 **양쪽에 Team ID가 있는데 서로 다를
때**다. 방향이 반대다. 구체적으로 이 Task의 측정은 다음 두 가지를 **말해 주지 못한다.**

- Developer ID로 전량을 서명하면 `disable-library-validation` 없이 돌아가는가.
  (돌아갈 가능성이 높다 — 그러면 §3의 최소 집합에서 `dlv`가 빠진다.)
- 번들 안에 **제3자 Team ID로 서명된 Mach-O**가 남아 있으면 그때 처음 막히는가.
  Phase 0은 전량을 우리 서명으로 덮어썼으므로 그 상황을 만들지 않았다.

즉 **§3의 최소 집합은 상한이다.** Developer ID에서 다시 재면 줄어들 수 있고, 반대로
Team ID 불일치로 새 실패가 드러날 수도 있다. **Phase 6 선결 조건으로 인계한다.**

## 9. Phase 6 인계 목록

| # | 항목 | 근거 |
| --- | --- | --- |
| 1 | Apple Developer Program 가입 → Developer ID 인증서 발급 | §7 1·2 |
| 2 | Developer ID 서명으로 §3·§5를 **다시 측정** — Team ID 기반 library validation이 켜진 상태에서 `disable-library-validation`이 여전히 필요한지 | §8 (R-12) |
| 3 | 공증 제출과 스테이플링, `--timestamp` 켜기 | §7 5·8·9·10 |
| 4 | Electron `.app` 번들의 nested code inside-out 서명 순서 확정 | §7 6 |
| 5 | entitlements plist에 `com.apple.security.cs.allow-unsigned-executable-memory` 포함, 공증 심사용 근거 준비 | §4, §7 7 |
| 6 | 서명된 산출물에서 dyld 실측이 필요하면 `allow-dyld-environment-variables`를 계측 전용으로 | §3 해석 |
| 7 | 번들에 새 wheel을 넣을 때마다 arm64 슬라이스 서명 전수 조사 | §5 함의 |
| 8 | 진짜 독립 설치 검증(개발 환경 없는 다른 맥) | 스펙 §4.3 |
