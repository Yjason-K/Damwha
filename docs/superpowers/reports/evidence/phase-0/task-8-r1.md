# 검증 증거 — Task 8 (서명·hardened runtime·Gatekeeper 제약)

- 계획: `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md` — "### Task 8: 서명·hardened runtime·Gatekeeper 제약" (V1~V7c, 규칙 6e 신설분 포함)
- worktree: `/Users/gim-yeongjae/project/daewha-electron-phase-0`
- COMMIT 지시값: `a07e17e`
- 실행 시작 시 `git -C <worktree> rev-parse HEAD` = `a276953fafb225c99fb0a3fcf838592bea8dd79e`

  지시값(`a07e17e`)과 다르다. 지시에 따라 `git diff --stat a07e17e..HEAD`로 그 사이 범위를 확인했다:

  ```
   .../2026-09-09-electron-phase-0-packaging-validation.md   | 15 +++++++++++----
   1 file changed, 11 insertions(+), 4 deletions(-)
  ```

  파일 1개, `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md`뿐이다 — 계획 문서 수정 커밋(`a276953`, "계획 수정")만 얹혀 있고 코드·실험 산출물은 `a07e17e`와 동일하다. 이 사실만 확인했고, 그 이상의 판정(동일 취급 가능 여부)은 하지 않는다.

- 환경:
  - node `v22.21.1`
  - pnpm `10.26.0`
  - 저장소 기본 `python3` `3.10.21` (worktree 시스템 python; 검증 대상은 번들 `python3.12`)
  - macOS `27.0` (BuildVersion `26A5425a`), `Darwin ... 27.0.0 ... RELEASE_ARM64_T8112 arm64`
  - Docker: `damwha-postgres` 컨테이너 `Up (healthy)` — 이 Task의 어떤 명령도 이 컨테이너를 쓰지 않는다. 참고로만 기록.
- 실행 일시(UTC): 시작 `2026-09-10T04:01:35Z`, V1 완료 `2026-09-10T04:09:12Z`경, V7b 완료 `2026-09-10T04:19:xxZ`경(로그 타임스탬프 기준), 전체 종료 `2026-09-10T04:22:00Z`경

## 사전 확인 — quarantine 잔여 (V4 실행 금지 지시에 따른 관찰)

지시에 따라 **V4(`probe.sh quarantine`)는 실행하지 않았다.**

- V4 칸: `미실행(사용자 환경 보호 — 관찰은 앞 회차에 완료)`
- 잔여 quarantine 확인 (검증 시작 시점):
  ```
  $ find experiments/electron-phase-0/signed experiments/electron-phase-0/bundle -type f -xattrname com.apple.quarantine 2>/dev/null | wc -l
  0
  ```
- 검증 종료 시점(V1 실행으로 `signed/`가 다시 만들어진 뒤) 재확인:
  ```
  0
  ```
- `signing/RESULTS.md` §6 관찰 결과(옮김, `t8-quarantine.txt` 그대로):

  측정: `2026-09-10T01:49:42Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-quarantine.txt`

  부여한 격리 속성: `0081;6aa20ca4;damwha-phase0-probe;`

  | 대상 | 대조군 실행 (속성 없음) | `spctl --assess --type execute` | 격리 속성이 붙은 채로 실행 | OS가 파일을 지웠나 |
  | --- | --- | --- | --- | --- |
  | `python/bin/python3.12` | exit 0 | exit 3 | exit 137 | no |
  | `ffmpeg/bin/ffprobe` | exit 0 | exit 3 | exit 137 | no |
  | `pg/bin/postgres` | exit 0 | exit 3 | exit 137 | no |

  시스템 로그(`amfid`): `not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain"`. `syspolicyd`가 `Prompt shown`을 남기지만 프로세스는 이미 SIGKILL로 죽어 있었다(명령줄 경로는 프롬프트와 무관하게 차단).

  `t8-quarantine.txt` 자체의 머리말에 따르면, 이 값은 `2026-09-10T01:49:42Z`에 완주한 회차가 만든 것이나 그 회차의 원본 증거 파일은 남아 있지 않고 `sandbox/t8/frag-gatekeeper.md`·`gk-syslog.txt`에서 복구한 것이다. 그 뒤 `02:17:51Z` 회차가 중단되면서 `signed/python/bin/python3.12`에 quarantine을 남겼고(사용자 화면에 Gatekeeper 대화상자 반복), 그 속성은 이후 제거됐다. **재실행하지 않았다** — 위 두 번의 0건 확인이 이번 회차의 실측이다.
  - `open`·Finder·더블클릭 경로는 쓰지 않았다.

## Verify

| # | 명령 | 기대 | 실제 | 종료 코드 | 일치 |
| --- | --- | --- | --- | --- | --- |
| V1 | `bash experiments/electron-phase-0/signing/probe.sh sign` | exit 0. 서명 결과·실패 목록이 RESULTS.md에 기록 | exit 0. `서명 성공: 526개 / 실패: 0개`, `codesign --verify 실패: 0개 / runtime 플래그 없음: 0개`, `escalate 통과 회차: jit+uem+dlv`, `entitlement 최소 집합: com.apple.security.cs.allow-unsigned-executable-memory, com.apple.security.cs.disable-library-validation` | 0 | 예 |
| V2 | `bash experiments/electron-phase-0/verify/t8-hardened.sh` | exit 0. `codesign -dv`가 runtime 플래그 보고 | exit 0. 대표 Mach-O 9개 전부 사본 flags에 `runtime`(`0x10002(adhoc,runtime)`), 원본 flags에는 없음(`0x20002(adhoc,linker-signed)`/`0x2(adhoc)`). `runtime 플래그 없음: 0개 / --verify 실패: 0개` | 0 | 예 |
| V3 | `bash experiments/electron-phase-0/verify/t8-signed-runtime.sh` | exit 0. import·`mps_available()` 성공 또는 실패+entitlement 기록 | exit 0. 사본에 붙은 entitlement와 RESULTS.md 결론 일치(`uem+dlv`) 확인 후, torch/torchaudio/mlx/mlx_whisper/mlx_lm/pyannote.audio/speechbrain/silero_vad/sentence_transformers/faster_whisper/soundfile/sounddevice/numpy/fastapi/uvicorn/damwha_worker 전부 OK, `mps_available() = True` | 0 | 예 |
| V4 | `bash experiments/electron-phase-0/signing/probe.sh quarantine` | exit 0. Gatekeeper 동작이 RESULTS.md에 기록 | **미실행(사용자 환경 보호 — 관찰은 앞 회차에 완료).** 위 "사전 확인" 절 참조 | — | 미실행(수동 필요 아님 — 사용자 보호를 위한 의도적 미실행) |
| V5 | `bash experiments/electron-phase-0/verify/t8-results-complete.sh` | exit 0. RESULTS.md에 실패 목록·entitlement 결론·Gatekeeper 동작·공증 선결조건·R-12 모두 존재 | exit 0. `검사 20개 중 FAIL 0개, 음성 대조 실패 0개` | 0 | 예 |
| V6 | `grep -c 'notarytool' experiments/electron-phase-0/signing/probe.sh` | `0` | 출력값 `0`. **단 종료 코드는 `1`** — `grep -c`는 매치 0건일 때 exit 1을 낸다. 계획의 기대칸은 출력값 `0`을 가리키는 것으로 읽었고, 그 값은 일치한다 | 1 (grep -c 관례. 출력값 자체는 `0`) | 예(출력값 기준) — 종료 코드는 계획 기대와 별개 사실로 병기 |
| V7 | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/pg` | exit 0. 원본 무훼손 | exit 0. 파일 767 / Mach-O 70 / ALLOW 0건 / 위반 0건 | 0 | 예 |
| V7b | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/python` | exit 0 (ALLOW 42건) | exit 0. 파일 39254 / Mach-O 460 / ALLOW 42건 / 위반 0건 (10~12분 소요, 백그라운드 실행) | 0 | 예 |
| V7c | `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/ffmpeg` | exit 0 | exit 0. 파일 2 / Mach-O 2 / ALLOW 0건 / 위반 0건 | 0 | 예 |

<details><summary>V1 전체 출력</summary>

```
probe.sh sign — ad-hoc 서명 + hardened runtime 실측 (스펙 P0-C9)
  원본(읽기만): /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle
  사본(서명)  : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed

== 1. bundle/ Mach-O 서명 전수 조사 (codesign, 슬라이스 단위)
   Mach-O(정규 파일): 526개
   arm64 슬라이스 서명 없음        : 0개
   arm64 서명 / 다른 슬라이스 없음 : 10개
   전 슬라이스 서명                : 516개
   arm64 슬라이스 자체가 없음      : 0개
   목록: .../signing/unsigned-inventory.txt
   증거: .../t8-inventory.txt

== 2. bundle/ → signed/ 복사
   번들 크기: 약 2 GiB   데이터 볼륨 여유: 16 GiB
   셔뱅을 사본으로 돌린 콘솔 스크립트: 65개
   사본: .../signed

== 3. ad-hoc 서명(codesign -s -) + --options runtime 전수 적용
   대상 Mach-O: 526개
   서명 성공: 526개 / 실패: 0개
   codesign --verify 실패: 0개 / runtime 플래그 없음: 0개
   증거: .../t8-sign.txt

== 4. hardened runtime 아래 실행 — entitlement 최소 집합
   [escalate] 하나씩 더해 간다
   -- 회차 [none]  entitlement: (없음)               -> 전부 FAIL (dyld: Library not loaded: libpython3.12.dylib)
   -- 회차 [jit]  entitlement: allow-jit              -> 전부 FAIL (동일)
   -- 회차 [jit+uem]  entitlement: allow-jit, allow-unsigned-executable-memory -> 전부 FAIL (동일)
   -- 회차 [jit+uem+dlv]  entitlement: allow-jit, allow-unsigned-executable-memory, disable-library-validation -> 전부 OK
   => [jit+uem+dlv] 에서 전 검사 통과. 더 붙이지 않는다.

   [reduce] 통과 회차 [jit+uem+dlv] 에서 하나씩 빼 본다
   -- 회차 [uem+dlv]  (jit 를 뺀다) -> 전부 OK => jit 는 필요 없다.
   -- 회차 [dlv]  (uem 를 뺀다) -> numba-jit FAIL(exit 137, SIGKILL) => uem 가 필요하다.
   -- 회차 [uem]  (dlv 를 뺀다) -> selfcheck FAIL(exit 134, dyld Library not loaded) => dlv 가 필요하다.
   escalate 통과 회차: jit+uem+dlv
   최소 집합         : uem+dlv
   증거: .../t8-entitlements.txt

== 5. R-4 — JIT / 쓰기+실행 메모리와 GPU 셰이더 컴파일
   (A) 최소 집합 [uem+dlv] -> numba-jit/torch-jit/mlx-metal/mlx-compile 전부 OK
   (B) 거기서 allow-unsigned-executable-memory 를 뺀 [dlv] -> numba-jit FAIL, 나머지 OK
   수집된 줄: 6
   증거: .../t8-r4.txt

== 6. R-5 — 서명을 뗀 .so 를 hardened runtime 아래에서 여는가
   대상: 원본에서 슬라이스 하나라도 서명이 없던 10개
   (A) .so 서명 있음 / ent=uem+dlv : OK
   (B) .so 서명 없음 / ent=uem+dlv : FAIL
   (C) ent=uem : 4단계에서 이미 실패로 기록됨 (참조)
   복구: 10개 재서명, 메인 실행 파일을 [uem+dlv] 로 되돌렸다
   증거: .../t8-r5.txt

== 7. RESULTS.md 갱신
   RESULTS.md: .../signing/RESULTS.md

요약
  Mach-O 정규 파일           : 526개
  arm64 슬라이스 서명 없음   : 0개
  다른 슬라이스 서명 없음    : 10개
  서명 실패                  : 0개
  escalate 통과 회차         : jit+uem+dlv
  entitlement 최소 집합      : com.apple.security.cs.allow-unsigned-executable-memory, com.apple.security.cs.disable-library-validation
  dyld 실측                  : MEASUREMENT_UNAVAILABLE

판정은 하지 않는다 — 이 Task 는 제약을 특정하는 것이 목적이다 (스펙 P0-C9 비고).
EXIT:0
```
(경로는 가독성을 위해 일부 `...`로 축약했다. 원본 전체는 스크래치패드
`/private/tmp/claude-501/-Users-gim-yeongjae-project-daewha/ce4fc665-b7b4-47af-bae7-c9645b5363af/scratchpad/v1-sign.out`에 있으며, 이 커밋 대상 파일이 아니라 실행 환경의 임시 파일이다.)
</details>

<details><summary>V2 전체 출력</summary>

```
# Task 8 V2 — hardened runtime 이 실제로 켜졌는가
# utc: 2026-09-10T04:08:59Z
# 사본: .../signed
# 원본: .../bundle  (서명하지 않았다 — 음성 대조)

## 대표 Mach-O 의 CodeDirectory flags
경로(사본 기준)                                                    사본 flags                 원본 flags
python/bin/python3.12                                                    0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
python/lib/libpython3.12.dylib                                           0x10002(adhoc,runtime)       0x2(adhoc)
python/lib/python3.12/site-packages/torch/lib/libtorch_cpu.dylib         0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
python/lib/python3.12/site-packages/mlx/lib/libmlx.dylib                 0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
python/lib/python3.12/site-packages/charset_normalizer/cd.cpython-312-darwin.so 0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
ffmpeg/bin/ffmpeg                                                        0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
ffmpeg/bin/ffprobe                                                       0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
pg/bin/postgres                                                          0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)
pg/lib/postgresql/pg_bigm.dylib                                          0x10002(adhoc,runtime)       0x20002(adhoc,linker-signed)

== 판정
  OK   사본에 runtime 플래그가 있다: (9개 전부)

== 사본 전량에 runtime 플래그가 붙었는가
  증거: .../t8-sign.txt
  runtime 플래그 없음: 0개 / --verify 실패: 0개
  OK   전수 서명 증거가 0건이라고 적고 있다

증거: .../t8-hardened.txt
사본은 hardened runtime 으로 서명됐고 원본은 서명되지 않은 그대로다
```
</details>

<details><summary>V3 전체 출력</summary>

```
== 사본에 붙어 있는 entitlement 와 RESULTS.md 의 결론
  사본에 붙은 것 : com.apple.security.cs.allow-unsigned-executable-memory com.apple.security.cs.disable-library-validation
  RESULTS.md 결론: com.apple.security.cs.allow-unsigned-executable-memory com.apple.security.cs.disable-library-validation
  OK   둘이 같다 — 아래 실행은 문서가 말하는 조건에서 잰 것이다

== 격리 실행 (스펙 §4.2) — 서명된 사본의 python 을 env -i 가 직접 exec 한다
run-isolated: label=t8-signed-runtime  stderr는 실행이 끝난 뒤에 나온다

== 사본이 자기 자신을 쓰는가
  OK   sys.prefix = .../signed/python

== 모듈별 결과
  OK   torch / torchaudio / mlx / mlx_whisper / mlx_lm / pyannote.audio / speechbrain /
       silero_vad / sentence_transformers / faster_whisper / soundfile / sounddevice /
       numpy / fastapi / uvicorn / damwha_worker  (16개 전부)

  OK   mps_available() = True  (제품 코드 damwha_worker.models.device 그대로)

== dyld 실측 상태 (참고 — 판정에 쓰지 않는다)
  MEASUREMENT_UNAVAILABLE — hardened runtime 이 DYLD_* 를 지운다.
  이 Task 의 관찰 대상이며 RESULTS.md 에 사실로 적혀 있다.

증거: .../t8-signed-runtime.txt
서명되고 hardened runtime 이 켜진 사본에서 스택 전량이 import 되고 MPS 가 잡힌다
```
</details>

<details><summary>V5 전체 출력</summary>

```
== RESULTS.md 완비 검사
   문서: .../signing/RESULTS.md
   전수 목록: .../signing/unsigned-inventory.txt

  OK   sign-fail-count      서명 실패 0개로 집계돼 있다
  OK   sign-fail-list       실패 0건이 "0건"으로 명시돼 있다
  OK   sign-fail-evidence   증거 t8-sign.txt 도 0개라고 적고 있다
  OK   ent-conclusion       결론이 entitlement 를 이름으로 든다: allow-unsigned-executable-memory disable-library-validation
  OK   ent-matrix           회차 표에 escalate 4행 / reduce 3행이 있다
  OK   ent-error-text       실패 회차의 오류 원문이 29줄 실려 있다
  OK   gk-block             §6 에 실측 블록이 들어 있다
  OK   gk-exit              대상 3개의 종료 코드가 표로 적혀 있다
  OK   gk-attr              §6 이 com.apple.quarantine 부여를 적고 있다
  OK   gk-verdict           §6 이 허용/차단/프롬프트 중 무엇이었는지 말한다
  OK   gk-evidence          인용한 증거가 있다: t8-quarantine.txt
  OK   notarize-list        공증 선결 조건이 12개 항목으로 있다
  OK   notarize-scope       제출하지 않았다고 명시돼 있다
  OK   notarize-devid       목록이 Developer ID 인증서를 선결 조건으로 든다
  OK   r12-present          R-12 가 7줄에 나온다
  OK   r12-blind            R-12 가 미재현 사각으로 서술돼 있다
  OK   r12-handoff          Phase 6 인계 목록이 R-12 를 가리킨다
  OK   inv-doc              §1 집계: 전체 526 / arm64 무서명 0 / 타슬라이스만 무서명 10
  OK   inv-file             전수 목록과 집계가 일치한다 (526 / 0 / 10)
  OK   inv-arch-split       문서가 arm64 슬라이스와 다른 슬라이스를 구분해 적는다

== 음성 대조 — 항목을 지운 사본이 FAIL 로 잡히는가
  OK   no-sign-fail-list / wrong-sign-count / no-ent-conclusion / no-ent-matrix /
       gk-placeholder / no-notarize / no-r12 / inv-mismatch  (8개 전부 FAIL 로 잡힘)

증거: .../t8-results-complete.txt
검사 20개 중 FAIL 0개, 음성 대조 실패 0개
RESULTS.md 에 서명 실패 목록·entitlement 결론·Gatekeeper 동작·공증 선결 조건·R-12 가 모두 있다
```
</details>

<details><summary>V7 전체 출력</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : .../experiments/electron-phase-0/bundle/pg
  파일 수       : 767
  Mach-O 수     : 70
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 0개 파일
  허용 목록(ALLOW): 0건 / 규칙 24줄 (lib/g1-allowlist.txt)
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
```
</details>

<details><summary>V7b 전체 출력 (allow-list 42건, 요약. 상세 목록은 실행 로그 참조)</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : .../experiments/electron-phase-0/bundle/python
  파일 수       : 39254
  Mach-O 수     : 460
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 6051개 파일
  허용 목록(ALLOW): 42건 / 규칙 24줄 (lib/g1-allowlist.txt)
    ... (42건 각각 파일 경로 + 금지 문자열 + ALLOW 근거, 생략 — 스크래치패드
        v7b-python.out 에 전량 있음)
  검사 대상 내부 절대경로(INFO): 6057건
    ... (6057건 중 20건만 표시)
  위반          : 0건
EXIT:0
```
</details>

<details><summary>V7c 전체 출력</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : .../experiments/electron-phase-0/bundle/ffmpeg
  파일 수       : 2
  Mach-O 수     : 2
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 0개 파일
  허용 목록(ALLOW): 0건 / 규칙 24줄 (lib/g1-allowlist.txt)
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
```
</details>

## 참고 실측 — 규칙 6e 근거 확인 (Verify 행이 아니다)

계획 규칙 6e: "`bundle/` 전체를 한 번에 넘기면 상대 경로가 한 칸 깊어져 24개
ALLOW 규칙이 하나도 걸리지 않고 42건이 위반으로 되살아난다"는 주장의 근거를
한 번만 실측했다.

```
$ bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle
```

- 종료 코드: `1`
- 출력 요약: 파일 40024 / Mach-O 532 / 허용 목록(ALLOW) `0건` / 위반 `42건`
- 위반 42건은 V7b에서 ALLOW로 분류됐던 것과 동일한 42개 파일·문자열 조합이다 (예: `python/lib/libpython3.12.dylib: /usr/local/lib/python2.5/site-packages`, `python/lib/python3.12/site-packages/soundfile.py: /opt/homebrew/lib` 등). ALLOW 목록의 경로 열이 `bundle/python` 기준 상대 경로라 `ROOT=bundle`에서는 매치되지 않는다는 계획의 서술과 일치한다.
- 기대(계획 서술): exit 1, ALLOW 0, 위반 42 — 실제와 일치.

## 그 밖의 기록 (판정 아님, 사실만)

### 1. V1 서명 결과 (재확인)
- 서명 대상 Mach-O: 526개
- 서명 성공: 526개 / 실패: 0개
- `codesign --verify` 실패: 0개 / runtime 플래그 없음: 0개
- entitlement 최소 집합(escalate→reduce로 실측): `com.apple.security.cs.allow-unsigned-executable-memory` + `com.apple.security.cs.disable-library-validation` (`uem+dlv`)
- 참고: 이 값들은 이번 회차가 `probe.sh sign`을 다시 돌려 새로 만든 것이며, 지난 회차 보고("526개 서명 / 실패 0 / 최소 집합 uem+dlv")와 수치가 같다.

### 2. V7·V7b·V7c 종료 코드·ALLOW·위반
| 대상 | 종료 코드 | ALLOW | 위반 |
| --- | --- | --- | --- |
| `bundle/pg` (V7) | 0 | 0 | 0 |
| `bundle/python` (V7b) | 0 | 42 | 0 |
| `bundle/ffmpeg` (V7c) | 0 | 0 | 0 |

V7b는 파일 39254개·Mach-O 460개를 훑는 데 약 10~12분이 걸렸다(백그라운드 실행, 타임아웃으로 죽이지 않았다).

### 3. 참고 실측 — 상위 루트(`bundle`)로 부른 결과
위 "참고 실측 — 규칙 6e 근거 확인" 절 참조. exit 1 / ALLOW 0 / 위반 42.

### 4. V5(`t8-results-complete.sh`) 출력
검사 20개, FAIL 0개, 음성 대조(negative control) 8개 전부 FAIL로 정확히 잡힘. 전문은 위 `<details>` 참조.

### 5. V6의 `grep -c 'notarytool'`
- 출력값: `0`
- 종료 코드: `1`

`grep -c`는 매치 0건일 때 표준출력에 `0`을 쓰면서 종료 코드는 `1`(매치 없음)을 반환한다. 계획의 기대칸 `0`은 grep의 종료 코드가 아니라 **출력값**을 가리키는 것으로 읽었다 — 두 수치를 구분해 병기했다.

### 6. `signing/unsigned-inventory.txt`의 세 숫자
- arm64 슬라이스에 서명이 없는 것: **0개**
- arm64는 서명 / 다른 슬라이스만 무서명: **10개**
- 전 슬라이스 서명: **516개**

(합계 526개, 지난 회차 보고 0/10/516과 동일)

파일 자체가 이 구분의 근거를 명시하고 있다(발췌):

> `codesign --verify`를 `--arch` 없이 부르면 universal 파일에서 x86_64 슬라이스 하나만 서명이 없어도 파일 전체를 'code object is not signed at all'이라고 보고한다. 그 메시지만 보면 arm64에서도 서명이 없는 것처럼 읽히는데 사실이 아니다. 이 실측이 바로 그 경우였다 — Task 3 리뷰가 '서명이 아예 없다'고 본 파일들은 arm64 슬라이스가 ad-hoc(linker-signed) 서명돼 있고 x86_64 슬라이스만 서명이 없는 universal 바이너리였다.

파일은 방법을 "파일마다 `codesign --verify`를 두 번 돌렸다 — (1) `--arch arm64`, (2) `--arch` 없이(전 슬라이스)"로 적어, `--arch` 유무에 따른 판정 차이를 정확히 구분해 놓았다.

### 7. R-4·R-5 요약 (`t8-r4.txt`·`t8-r5.txt`에서 옮김)

**R-4** (`t8-r4.txt`):
- (A) 최소 집합 `uem+dlv`: `numba-jit`·`torch-jit`·`mlx-metal`·`mlx-compile` 전부 `OK`
- (B) 거기서 `uem`을 뺀 `dlv`: `numba-jit` `FAIL`(exit 137=SIGKILL, "dyld/stderr에 남은 줄이 없다"), `torch-jit`·`mlx-metal`·`mlx-compile`은 `OK`

**R-5** (`t8-r5.txt`):
- (A) `.so`를 ad-hoc 서명한 상태로 열기, ent=`uem+dlv`: 대상 10개(charset_normalizer 2·fontTools 6·grpc 1·libportaudio 1) 전부 `OK`
- (B) 대상만 서명을 뗀 상태, ent=`uem+dlv`: 10개 전부 `FAIL` (`dlopen ... missing code signature`)
- (C) ent=`uem`(dlv 없음): "4단계 escalate에서 이미 깨졌다 — 그 증거를 참조한다"(참조, 재실행 없음)

## 잔여 quarantine — 최종 재확인

```
$ find experiments/electron-phase-0/signed experiments/electron-phase-0/bundle -type f -xattrname com.apple.quarantine 2>/dev/null | wc -l
0
```

## 프로세스 정리

- 기동 전 `ps aux | wc -l`: 815
- V1(`probe.sh sign`) 진행 중 확인: `bash experiments/electron-phase-0/signing/probe.sh sign` 프로세스만 관찰됨 (정상 종료 후 사라짐)
- 종료 후 `ps aux | wc -l`: 799
- 종료 후 `ps aux | grep -Ei "signed/python|signed/pg|signed/ffmpeg"`: 빈 결과 — signed/ 사본을 실행한 잔여 프로세스 없음
- 이 Task의 검증은 서버 프로세스를 띄우지 않는다(V2·V3은 `run-isolated.sh`가 짧게 실행하고 종료하는 1회성 프로세스만 만든다). `pkill`·`killall`을 쓰지 않았고 쓸 필요도 없었다.

## 디스크 여유
- 시작: `/System/Volumes/Data` 17Gi 여유 (460Gi 중 413Gi 사용, 97%)
- V1(`probe.sh sign`, `signed/` 재구성) 도중: 14Gi 여유
- 종료 시: 17Gi 여유 (412Gi 사용, 97%) — `signed/`가 재구성 뒤 원래 크기로 정리됨

## git status --porcelain (검증 종료 시점, 전체)

`probe.sh sign`(V1)을 계획에 적힌 그대로 실행한 결과, 그 스크립트 자신이
`docs/superpowers/reports/evidence/phase-0/t8-*` 증거 파일들(및
`experiments/electron-phase-0/signing/{RESULTS.md,unsigned-inventory.txt}`)을
자기 회전 규약(`.prev-<UTC 타임스탬프>.txt`로 이전 값을 옮기고 원래 이름에
새 값을 쓰는 방식)에 따라 다시 썼다. 이 에이전트가 직접 편집한 파일은 없다 —
아래 변경분은 전부 V1 명령 실행의 부수 효과다.

- 수정(M): 기존에 추적되던 `t8-*` 증거 파일 다수(`t8-entitlements.txt`,
  `t8-escalate-*-{dyld,env,stderr}.txt`, `t8-reduce-*-{dyld,env,stderr}.txt`,
  `t8-r4*.txt`, `t8-r5*.txt`, `t8-hardened.txt`, `t8-inventory.txt`,
  `t8-results-complete.txt`, `t8-sign.txt`, `t8-signed-runtime*.txt`) +
  `experiments/electron-phase-0/signing/{RESULTS.md,unsigned-inventory.txt}`
- 신규(??): 위 각 파일의 `.prev-<타임스탬프>.txt` 회전본
- 그 밖의 신규 미추적 파일: `docs/superpowers/reports/evidence/phase-0/task-8-r1.md`(이 증거 파일 자신)

전체 `git status --porcelain` 원문은 이 세션의 실행 로그에 있으며, 요약하면
위 `t8-*` 관련 파일들과 이 증거 파일 외에 다른 경로(제품 코드·`be/storage`·
`packages/`·`fe/`)의 변경은 없다. `experiments/electron-phase-0/bundle/`
(원본)은 이번 실행에서 건드리지 않았다 — V1·V2·V3·V7·V7b·V7c 전부 `bundle/`을
읽기 전용으로만 참조했고 쓰기는 `signed/`에만 있었다(V2 출력의 원본 flags 열이
서명 전 그대로임이 그 증거다).

## `docs/superpowers/reports/evidence/phase-0/` 파일 수·확장자별 개수 (검증 종료 시점)

- 총 파일 수: 613
- 확장자별: `.md` 11개, `.txt` 602개
- `.log` 확장자 파일: 0개

## 비고

- Task 8 Verify 표의 지시대로 V1~V7c를 순서대로 실행했다. 명령을 고치거나 생략하지 않았다.
- V4만 사용자 지시에 따라 미실행으로 남겼다.
- 판정(통과/실패)은 하지 않았다 — 위 표의 "일치" 열은 계획에 적힌 기대값과 실제 관찰값의 문자 그대로의 일치 여부만 기록한 것이다.
