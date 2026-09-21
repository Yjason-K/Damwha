# Electron Phase 6a — 서명·배포 (구현 스펙)

작성일: 2026-09-20
브랜치: `feat/electron-migration-phase-6a-signing-distribution`
선행: Phase 5 완료 (PR #26, `dev` = `1b92190`)

## 1. 목표

**이 맥 밖에서도 뜨고, 뜬 것이 위조가 아님을 macOS가 스스로 확인할 수 있는 설치물을 만든다.**

지금 `desktop:build`가 내는 `.app`은 ad-hoc 서명이고 `target: dir`이며, 무엇보다
**macOS 27 미만에서는 아예 실행되지 않는다**(§3-8 실측). 즉 산출물이 있어도 배포할 수 없다.
이 Phase는 그 셋 — 최소 OS 바닥, Developer ID 서명·공증, DMG — 을 닫고, 실제로 다른 맥에
설치해 처리까지 돌려 확인한다.

업데이트 기구는 여기 없다. §2.2 참조.

## 2. 범위

### 2.1 포함

| # | 항목 | 근거 |
| --- | --- | --- |
| A | 버전 단일화 — git 태그 = `desktop/package.json` = `app.getVersion()` = DMG 파일명 | 로드맵 Phase 6 "재현 가능한 빌드와 버전 관리". 6b의 업데이트 알림이 버전 비교에 기대므로 6a가 먼저 못 박는다 |
| B | 최소 macOS 15.0 확정과 강제 | **P0-C11 미충족 이월.** 실측 결과 현재 번들의 바닥이 27.0이라 이 맥 전용이다(§3-8) |
| C | Developer ID Application 서명 전환 | 로드맵 Phase 6 "앱 및 포함 바이너리 서명". Phase 1 결과가 **TCC 권한이 업데이트를 넘어 살아남기 위한 선행 조건**으로 재규정했다 |
| D | 공증·스테이플 + DMG 생성 | 같은 항목. 공증 없는 `.app`은 다른 맥에서 Gatekeeper에 막힌다 |
| E | 디스크 부족의 원인·복구 안내 | **P5-C6 이월.** `causes.ts:159`에 문구만 있고 내는 어댑터가 없다 |
| F | 두 번째 맥 설치·처리 종단간 검증 | 로드맵 Phase 6 완료 기준 1. Phase 0 §11이 여기로 미뤄 둔 검증 |

### 2.2 제외 — 그리고 어디로 가나

Phase 6은 6a·6b로 나눈다(2026-09-20 결정). **6a의 산출물(서명·공증된 v1이 두 번째 맥에 설치된
상태)이 6b의 선행 조건이다** — 업그레이드를 시험하려면 업그레이드할 대상이 먼저 있어야 한다.

| 제외 | 이유 | 인계 |
| --- | --- | --- |
| 업데이트 알림 (GitHub Releases API) | 설치된 v1 없이는 "새 버전이 있다"를 시험할 수 없다 | **6b**. 원천은 `GET /repos/Yjason-K/Damwha/releases/latest`로 확정(§11-1) |
| 백업·복원 기구 | Phase 5에서 넘어온 항목. 동인이 "업데이트 전 백업"이라 업데이트와 같은 Phase에 있어야 한다 | **6b** |
| `attempts` 한 컬럼이 크래시 회수와 일시 실패를 함께 세는 문제 | Phase 5 스펙 §2.2 이월. 스키마 변경이 필요하다 | **6b** — 이 마이그레이션이 v1→v2 업그레이드 검증의 **실물 시험체**가 된다 |
| 자동 다운로드·설치 (electron-updater) | 번들이 수 GB라 delta 없이는 매 판올림이 전체 재다운로드다. 사용자가 알림만 받기로 결정(2026-09-20) | 범위 밖 |
| Intel 맥, Mac App Store | 로드맵 전제에서 이미 제외 | 범위 밖 |
| `model_readiness` 스키마 문제 4종 | Phase 5 §2.2가 미뤘고 배포와 독립이다 | 별도 작업 |

## 3. 선행 사실 — 인계받은 것과 이 스펙을 쓰며 실측한 것

1. **서명은 electron-builder가 아니라 `scripts/package.mjs`가 한다.** `electron-builder.yml`의
   `mac.identity: null`이 자동 탐색을 끄고(2026-09-13 키체인에 동명 인증서가 둘 생겨 `ambiguous`로
   실패한 사고의 결과), `package.mjs:112-135`가 그 뒤에 `codesign --force --sign -`으로 세 번 건다.
2. **서명은 plist 둘로 갈리고 안쪽이 먼저다.** `entitlements.python.plist`(키 둘)를
   `Resources/python`의 Mach-O 전수와 `Resources/ffmpeg/bin/*`에, `entitlements.mac.plist`(키 셋,
   `allow-jit` 추가)를 `.app`에 `--deep`으로. 순서가 뒤집히면 `.app` 서명의 Resources 봉인이
   서명 전 내용을 가리켜 `--verify`가 깨진다. `.app`에 python plist를 주면 V8이 rc=133으로 죽는다.
3. ~~**`Resources/postgres`만 hardened runtime이 없고 그것이 맞다** — 별개 프로세스라 자기 서명의
   플래그로 돈다. `check-bundle.mjs`의 runtime 단언은 python·ffmpeg 트리에만 건다.~~
   > **뒤집힘 (Task 6, Ruling R12, 2026-09-21).** 첫 공증 제출(`88197b1f-daae-41bc-aa68-e62176a321de`)이
   > status=Invalid, 오류 32건 전부 `Resources/postgres/bin/*`의 "hardened runtime enabled 아님"이었다.
   > 공증이 실행 파일에 hardened runtime을 요구한다는 사실이 이 스펙이 몰랐던 사실로 실측됐다 —
   > postgres도 이제 `--options runtime`으로 서명하고 `check-bundle.mjs` §14b가 66/66 전수 단언한다.
   > entitlements는 여전히 주지 않는다(같은 Team ID 서명 트리라 library validation을 통과, 재제출
   > `54dd2674…`·`cd12be62…` 둘 다 Accepted, pgvector 0.8.6·pg_bigm 1.2 적재까지 확인). 근거는
   > [결과 문서](../reports/2026-09-20-electron-phase-6a-signing-distribution-results.md) Ruling R12 절.
4. **서명 뒤 번들 python을 실행하지 않는다.** `__pycache__`가 봉인 밖에 생기고 `.pyc`에 빌드
   머신의 절대 경로가 박힌다. `check-bundle.mjs`가 둘 다 잡는다.
5. **`check-bundle.mjs`는 31건을 판정하고 실패하면 `exit 1`이다**(373줄). `check(label, ok, detail)`
   한 함수로 단언을 쌓는 구조라 항목 추가 비용이 낮다.
6. **세 빌드 스크립트의 캐시 키는 스크립트 자신의 sha256을 포함한다**
   (`build-postgres.sh:48`, `build-ffmpeg.sh:52`, `build-python.sh:106`). 스크립트를 고치면
   키가 바뀌어 **`--fresh` 없이도 새로 빌드된다.** 이 Phase의 B가 그 성질에 기댄다.
7. **Developer ID 인증서는 이 스펙을 쓰는 중에 발급·검증을 마쳤다**(2026-09-20).
   - identity `Developer ID Application: Youngjae Kim (L5Y9SZHGRN)`,
     sha1 `C35965CC0997E3897DED5C0975B4064D8AA4E27A`, 유효기간 2031-09-17.
   - 실제 서명이 Apple Root까지 체인을 이루고 보안 타임스탬프·`TeamIdentifier`가 붙는 것을
     throwaway 바이너리로 확인했다. 키체인 ACL이 `codesign`을 막지 않는다(GUI 프롬프트 없음).
   - **DR이 identity 기반으로 바뀌었다** —
     `certificate leaf[subject.OU] = L5Y9SZHGRN`. ad-hoc의 `cdhash H"…"`와 달리 재빌드에 걸쳐
     안정적이라, Phase 1이 경고한 "재빌드마다 마이크 권한 무효화"가 사라진다.
   - notarytool 프로필 `damwha`(앱 암호 방식)가 Apple에 인증됨을 `notarytool history`로 확인.
   - 개인 키·`.p12` 백업은 `~/Documents/damwha-signing`(0700). **저장소 밖이고 커밋하지 않는다.**
8. **현재 번들의 `minos` 바닥은 27.0이고, 그 원인의 절반은 우리 빌드다.**
   `xcrun vtool -show-build` 전수 실측:

   | 구성요소 | `minos` | 성격 |
   | --- | --- | --- |
   | Electron 44 | 13.0 | 고정 |
   | PyPI 휠 대부분 (442개) | 14.0 | 고정 |
   | `mlx`·`mlx-metal` 0.31.2 | **26.0** | PyPI 배포판. uv가 호스트(27.0)에 맞춰 26.0 휠을 집었다 |
   | postgres 소스 빌드 (66개) | **27.0** | **우리 탓** — `MACOSX_DEPLOYMENT_TARGET` 미지정, 호스트 SDK 상속 |
   | ffmpeg 소스 빌드 (2개) | **27.0** | 같음 |

   이 맥이 27.0이라 여태 드러나지 않았다.
9. **mlx는 핀을 내리지 않고도 15.0으로 갈 수 있다.** `mlx==0.31.2`·`mlx-metal==0.31.2` 둘 다
   `macosx_14_0` / `macosx_15_0` / `macosx_26_0` 휠을 낸다. `mlx-whisper==0.4.3`·`mlx-lm==0.31.3`은
   순수 파이썬이다.
10. **uv의 `--python-platform`으로는 macOS 15를 표현할 수 없다.** 값 목록에 버전 knob이 없고,
    `aarch64-apple-darwin`은 `macosx_13_0_arm64`로 내려가 mlx 해석이 `unsatisfiable`이 된다(실측).
    직접 URL 설치는 통한다 — 15.0 휠 두 개를 `--reinstall --no-deps`로 넣는 dry-run이 통과했다.
11. **업로드는 두 곳에서 같은 옵션을 쓴다** — `meetings.controller.ts:63`과
    `speakers.controller.ts:27`이 `uploadInterceptorOptions`(`storage/upload-options.ts:18`)로
    multer `diskStorage`를 걸고 목적지는 `os.tmpdir()`다. **ENOSPC 처리가 없어** Phase 5 실측에서
    처리되지 않은 500(스택트레이스)이 나갔다.
12. **디스크 부족 문구와 안내는 이미 있다** — `causes.ts:159`의 `diskFull`(남은 용량·필요한 용량
    인자 둘)과 `shell-hints.ts:78`. 같은 파일이 "이 Phase에는 이 문구를 내는 어댑터가 아직 없다"고
    스스로 적고 있다.
13. **HF 토큰 온보딩은 Phase 4가 이미 만들었다** — `safeStorage` + `app/token-gate.ts`,
    토큰이 없으면 서비스를 하나도 띄우지 않는다. `token-store.ts`의 `read()`는 **복호화에 실패해도
    파일을 지우지 않고 `null`을 돌려준다.** 서명 신원이 바뀌어 Keychain ACL이 무효가 되어도
    크래시가 아니라 온보딩 재호출로 떨어진다 — F가 그것을 실제로 관찰한다.

## 4. 변경 A — 버전 단일화

버전이 세 군데(`desktop/package.json`, git 태그, DMG 파일명)에 따로 적히면 앱이 자기보다 낮은
버전을 "새 버전"이라 말하게 된다. 6b의 알림이 그 값을 비교하므로 6a가 먼저 한 줄로 만든다.

**`v<version>` 태그는 이미 임자가 있다.** `deploy/release.sh`가 셀프호스팅 웹 배포를 그 이름으로
내고 있고(`v0.1.1`~`v0.2.3` 실재), 그 스크립트는 태그 버전이 `be/worker/pyproject.toml`과 다르면
거절한다(`release.sh:19-22`). 지금 `v0.2.3` 릴리스의 자산은 `damwha-deploy-0.2.3.tar.gz`와
`damwha_worker-0.2.3-py3-none-any.whl` 둘이고 **DMG는 없다.** 두 제품이 한 네임스페이스를 쓰면
`release.sh`의 단언과 부딪히고, 더 나쁘게는 **6b의 `/releases/latest`가 제품을 가리지 못한다** —
웹 릴리스를 나중에 내면 데스크톱 앱이 "새 버전이 있어요"라며 tarball을 가리킨다.

- **단일 진실 원천은 `desktop/package.json`의 `version`이다.** `app.getVersion()`이 그것을 읽고,
  electron-builder의 DMG 파일명(`${productName}-${version}-arm64.dmg`)도 그것에서 나온다.
  `be/worker/pyproject.toml`의 버전과 **묶지 않는다** — 두 제품의 배포 주기가 다르다.
- **데스크톱 태그는 `desktop-v<version>`이다.** 웹 배포의 `v<version>`과 네임스페이스가 갈린다.
  `package.mjs`가 `--release` 빌드에서 `git describe --tags --exact-match --match 'desktop-v*'`로
  현재 커밋의 태그를 읽어 `desktop-v${pkg.version}`과 다르면 **거절한다.**
- **6b는 `/releases/latest`를 쓰지 않는다.** `GET /repos/Yjason-K/Damwha/releases`를 받아
  `tag_name`이 `desktop-v`로 시작하는 것 중 가장 최신을 고른다. 이 제약을 6a가 만들어 두고
  스펙 §11-1과 로드맵 Phase 6b 절에 적는다.
- **`--release`가 6a의 유일한 새 플래그다**(§7과 공유). 없으면 지금과 같다 — `--dir`,
  DMG·공증 없음, 버전·태그 대조 없음. 개발 중 패키징 루프의 시간이 늘지 않는다. 산출물의
  버전 문자열은 어느 쪽이든 `package.json`의 값 그대로다(파일명이 흔들리면 수동 배포가 헷갈린다).
- `check-bundle.mjs`가 `Contents/Info.plist`의 `CFBundleShortVersionString`이
  `package.json`의 `version`과 같은지 본다 — 이 단언은 두 모드 모두에서 돈다.

이 Phase가 내는 첫 배포 버전은 **`0.3.0`**이다(현재 `0.2.3`에서 마이너 올림 — 배포 형태가 바뀐다).

## 5. 변경 B — 최소 macOS 15.0

### 5.1 왜 15.0인가

§3-8의 표에서 우리가 못 내리는 바닥은 PyPI 휠의 14.0이다. mlx는 15.0 휠이 있으므로 **15.0이
핀을 하나도 내리지 않고 닿을 수 있는 가장 낮은 값**이다. 14.0으로 더 내리려면 mlx 0.29.x까지
내려가 `mlx-whisper`·`mlx-lm` 호환 조합을 다시 찾고 STT·요약 품질을 재측정해야 한다 —
이 Phase의 범위를 두 배로 만든다.

### 5.2 로컬 빌드 둘 (postgres·ffmpeg)

- `build-postgres.sh`·`build-ffmpeg.sh`에 `export MACOSX_DEPLOYMENT_TARGET=15.0`을 `configure`
  앞에 둔다. 값은 `scripts/lib`의 공용 파일 한 곳에 두고 두 스크립트가 source한다 —
  한쪽만 올라가면 바닥이 조용히 갈린다. `build-python.sh`의 §5.3도 같은 값을 읽는다.
- `--fresh`는 필요 없다 — 스크립트 sha256이 캐시 키에 들어가므로(§3-6) 새 키로 새 트리가 난다.
  기존 `pg-<옛키>`·`ffmpeg-<옛키>`는 그대로 남는다(디스크 여유 확인 항목).
- **재빌드 후 실측으로 확인한다.** 선언만 바꾸고 실제 산출물이 따라오지 않는 경우가 있다
  (일부 서브 빌드가 자기 플래그를 쓴다). 5.4의 단언이 그 그물이다.

### 5.3 mlx 두 휠

`build-python.sh`의 `uv pip install -r requirements.txt`(536행) **뒤에** 고정 단계를 하나 더 둔다.

```
uv pip install --python <interp> --link-mode=copy --reinstall --no-deps \
  <mlx 15.0 휠 URL> <mlx-metal 15.0 휠 URL>
```

- URL과 sha256은 **`python-checksums.txt` 관례에 맞춰 파일에 적는다.** 버전이 `pyproject.toml`의
  핀과 어긋나면 스크립트가 멈춘다 — 핀만 올리고 이 URL을 잊으면 26.0 휠이 조용히 돌아온다.
- 이 단계는 `rt` 층에서만 돈다. `wk` 층은 `--no-deps`로 `damwha_worker`만 얹으므로 영향이 없다.
- **`--python-platform`은 쓰지 않는다** — §3-10이 그 길이 막혀 있음을 실측했다. 그 사실을
  스크립트 주석에 남긴다(다음 사람이 같은 실험을 반복하지 않게).

### 5.4 단언 — 이것이 없으면 조용히 되돌아간다

`check-bundle.mjs`에 **번들 Mach-O 전수의 `minos` 최대값 ≤ 15.0** 단언을 더한다.

- 대상은 `Contents/` 전체(`Resources/python`·`ffmpeg`·`postgres`·Electron 프레임워크 포함).
  순회는 `scripts/lib/macho.mjs`가 이미 하는 파일시스템 트리 훑기를 쓴다.
- **`app.asar` 안은 그 순회가 보지 못한다.** 지금은 열 것이 없다 — `desktop`에 runtime 의존성이
  0개이고 `check-bundle`이 "app.asar has no node_modules"를 이미 단언한다. 그래도 "전수"라는
  말이 참이려면 **asar 안에 Mach-O가 없다**를 따로 단언한다(`@electron/asar`가 devDependency에
  있고 기존 단언이 이미 그것으로 목록을 읽는다). 언젠가 네이티브 모듈이 들어오면 여기서 멈춘다.
- 초과한 파일은 **경로와 값을 전부 보고한다** — 하나만 보이면 원인 패키지를 못 찾는다.
- 이 단언 하나가 B 전체의 회귀 방지다. 다음에 누가 의존성을 올리거나 새 SDK에서 빌드하면
  여기서 멈춘다.

`electron-builder.yml`의 `mac.extendInfo`에 `LSMinimumSystemVersion: "15.0"`을 더하고,
`check-bundle.mjs`가 `Info.plist`에서 그 값을 확인한다.

## 6. 변경 C — Developer ID 서명 전환

`package.mjs`의 세 `codesign` 호출에서 `--sign -`을 **sha1 지문**으로 바꾼다.

- **이름이 아니라 지문(`C35965CC…`)을 쓴다.** 2026-09-13 사고가 이름 중복이 `ambiguous`를
  낸다는 것을 보였고, 이 키체인에는 지금도 동명 `iPhone Distribution` 항목이 넷 있다.
- 지문은 `desktop/scripts/signing.json`(gitignore 아님, 비밀이 아니다)에 두고 스크립트가 읽는다.
  없거나 키체인에서 찾을 수 없으면 **패키징을 멈춘다** — ad-hoc으로 조용히 떨어지지 않는다.
- `--timestamp`를 더한다. 공증의 선행 조건이고, 인증서 만료 뒤에도 서명이 유효하게 한다.
- **plist 둘·순서는 그대로다**(§3-2). ~~postgres 예외도 그대로다(§3-3).~~ **postgres 예외는 Task 6,
  Ruling R12(2026-09-21)로 뒤집혔다 — §3-3의 정정 참고.** 바뀌는 것은 identity와 타임스탬프뿐이다.
- `check-bundle.mjs`의 서명 단언을 **"서명이 있고 runtime 플래그가 붙었다"에서 "Authority가
  Developer ID Application이고 TeamIdentifier가 `L5Y9SZHGRN`이다"까지** 올린다. ~~postgres 트리도
  identity는 확인한다(runtime 플래그만 예외다).~~ **postgres 트리도 R12 이후로는 runtime 플래그까지
  확인한다(§14b) — entitlements는 여전히 안 준다.**

**ad-hoc 산출물과 섞이지 않게 한다.** 전환 후 첫 빌드 전에 `desktop/out`을 통째로 지운다 —
파일만 지우면 `.DS_Store` 때문에 `ENOTEMPTY`가 난다.

## 7. 변경 D — 공증·스테이플·DMG

**순서가 계약이다.** 지금 `package.mjs`는 `electron-builder --dir`로 `.app`을 만든 **뒤에** 손으로
서명한다(`package.mjs:82` → `112-135`). `mac.target`을 `dmg`로 바꾸고 `--dir`을 떼면
**electron-builder가 서명 전 `.app`을 DMG에 담아 버린다** — 뒤의 서명은 `out/mac-arm64`의 사본만
고치고 DMG 안은 링커 ad-hoc 서명인 채로 남는다. 스테이플도 마찬가지로 DMG 내부 사본에 닿지 않는다.

그래서 **DMG는 서명이 끝난 `.app`에서 따로 만든다.** `--release`일 때만 도는 순서:

1. **`electron-builder --dir`은 그대로 둔다.** `.app`만 만든다. `mac.target`도 `dir`로 둔다 —
   DMG는 아래 4번이 만든다.
2. **서명 → `check-bundle`** — 지금 순서 그대로(안쪽 먼저, plist 둘, postgres 예외).
   DMG를 만들기 전에 번들 단언을 통과해야 한다.
3. **`.app` 공증·스테이플** — `notarytool`은 디렉터리를 받지 않으므로 `ditto -c -k --keepParent`로
   zip을 떠서 제출한다. 통과하면 **zip이 아니라 원본 `.app`에** `xcrun stapler staple`을 건다.
   DMG 밖으로 꺼낸 `.app`이 오프라인에서도 통과하려면 이 단계가 있어야 한다.
4. **DMG 생성** — `electron-builder --prepackaged out/mac-arm64/Damwha.app --mac dmg`.
   `--prepackaged`가 **이미 서명·스테이플된 그 바이트를 그대로** 담는다(재빌드하지 않는다).
5. **DMG 서명 → 공증 → 스테이플** — DMG 자신도 Developer ID로 서명한 뒤
   `notarytool submit --wait`, 통과하면 `stapler staple <dmg>`.
6. **검증** — `spctl --assess --type execute -vv <app>`이
   `accepted / source=Notarized Developer ID`를 내는지, `stapler validate`가 `.app`·DMG 양쪽에서
   통과하는지. **DMG를 마운트해 그 안의 `.app`으로도 같은 둘을 확인한다** — 3·4번이 의도대로
   이어졌는지는 그것만이 증명한다.

공통 규칙:

- 프로필 이름 `damwha`도 `signing.json`에 둔다.
- 공증 실패는 `notarytool log <id>`를 그대로 출력하고 멈춘다. 거절 사유는 목록이라 요약하면
  원인을 잃는다.
- 타임아웃 상한을 둔다(기본 대기는 무한). 30분으로 하고 넘으면 제출 id를 남기고 멈춘다 —
  제출은 살아 있으므로 나중에 `notarytool log`로 이어 볼 수 있다.
- **서명·스테이플 뒤 번들 python을 실행하지 않는다**(§3-4). `stapler`는 `.app`의
  `Contents/CodeResources` 옆에 티켓을 넣을 뿐 Mach-O를 고치지 않지만, 3번 뒤의 어떤 단계도
  번들 안에 파일을 만들지 않는지 4번 전에 `check-bundle`이 한 번 더 확인한다.

### 7.1 릴리스 발행

공증까지 끝난 DMG를 GitHub Release로 올린다. 여기까지가 6a의 산출물이고, **6b의 알림이 읽을
첫 응답이 이것이다.**

- 태그는 `desktop-v<version>`(§4). `deploy/release.sh`가 쓰는 `v<version>`과 섞지 않는다.
- 자산은 DMG 하나와 그 **SHA-256 파일**. 사용자가 받은 것이 우리가 낸 것인지 확인할 수 있어야 한다.
- 릴리스 본문에 최소 macOS 버전(15.0)과 §9의 예고된 퇴행(전환 빌드에서 토큰 1회 재입력)을 적는다.
- **`deploy/release.sh`를 고치지 않는다.** 데스크톱 발행은 별도 스크립트이거나 `package.mjs`의
  마지막 단계다. 둘을 한 스크립트에 넣으면 웹 배포의 버전 단언이 데스크톱 버전까지 묶는다.

공증은 네트워크와 Apple 서버에 기댄다. 개발 루프는 `--release` 없이 돌므로 이미 분리돼 있고,
**`--release` 빌드에서 공증을 건너뛰는 길은 두지 않는다** — 공증 안 된 DMG가 배포물로 새 나가는
것이 개발 편의보다 나쁘다. `check-bundle`의 공증 단언(P6a-C4)도 `--release`에서만 돈다.

## 8. 변경 E — 디스크 부족 (P5-C6)

두 자리에 건다. 하나는 사고 전, 하나는 사고 후다.

### 8.1 사전 — 모델 다운로드 앞

모델 한 벌이 수 GB라 여기가 주 사고 지점이다. 다운로드를 시작하기 전에 목적지 볼륨의 여유를
재고, **필요한 용량보다 적으면 받지 않고 실패한다.**

**다운로드 주체가 셋이고 실패가 도달하는 곳이 서로 다르다.** 하나만 고치면 나머지 둘에서
같은 증상이 그대로 남는다.

| 주체 | 다운로드 지점 | 실패가 가는 곳 |
| --- | --- | --- |
| worker job | `dispatch.py`의 job 처리 안 | `job.status='failed'` + 사유. 화면은 회의 카드 |
| embed 서비스 | `embed_service.py:84`가 훅을 걸고 **기동 시점에** 모델을 올린다 | job이 아니다 — 서비스 기동 실패. 화면은 상태 창 |
| LLM 서버 | `llm_entry.py:57`이 훅을 걸고 `mlx_lm.server`를 띄운다 | 같음 — 서비스 기동 실패 |

- **점검 자체는 한 곳에 둔다.** 세 주체가 공유하는 `models/downloads.py`가 이미 세 곳 모두의
  훅 지점이다. 여유 계산과 판정을 거기 두고, **사유를 표면화하는 방식만** 주체별로 다르게 한다.
- 필요한 용량은 HF API가 주는 저장소 크기에 여유 계수를 곱한다. 값을 못 얻으면 이 점검을
  건너뛴다(추정으로 막지 않는다 — 막는 쪽이 틀리면 받을 수 있는 것을 못 받는다).
- **worker job 경로에서만 PERMANENT다.** 디스크가 그대로인 채 재시도해 봐야 같은 자리에서
  지므로, Phase 5가 만든 백오프 5회를 디스크 부족으로 태우지 않는다. embed·LLM은 job이 아니라
  **서비스 기동 실패**로 나가고, Phase 2가 만든 서비스 실패 표시·재시작 정책을 탄다 —
  `app/retry-policy.ts`의 `manual` 갈래(자동 재시도하지 않고 "다시 시도"만)가 맞는 분류다.
- 사유 문자열은 `causes.ts`의 `diskFull`이 이미 정한 모양(`남은 용량 X, 필요한 용량 Y`)을 쓴다.
  **문구를 새로 만들지 않는다** — 그 파일의 머리 주석이 금하는 것이다. 세 주체가 같은 문구에
  닿는 것이 이 설계의 요점이다.

### 8.2 사후 — 업로드 ENOSPC

`upload-options.ts`의 multer는 `os.tmpdir()`에 쓴다. 그 쓰기가 ENOSPC로 지면 지금은 처리되지
않은 500이 나간다.

- 두 컨트롤러가 같은 옵션을 공유하므로 **한 자리(예외 필터 또는 multer 오류 변환)에서 잡는다.**
  컨트롤러마다 try/catch를 뿌리지 않는다.
- ENOSPC를 HTTP **507 Insufficient Storage**와 기계가 읽을 수 있는 사유 코드로 바꾼다.
  화면은 그 코드를 `diskFull` 문구·안내로 옮긴다.
- **반쯤 쓴 임시 파일을 지운다.** 지금도 multer가 지우지만 오류 경로에서의 동작을 확인한다.
- **DB 행을 남기지 않는다.** 업로드가 실패했는데 `meeting` 행만 생기면 고아가 된다 —
  P6a-C7의 정합성 질의가 본다.

### 8.3 경계

앱은 디스크를 **재기만 하고 비우지 않는다.** 캐시 삭제·백업 회전 같은 자동 정리를 이 Phase에
넣지 않는다. 안내는 `shell-hints.ts:78`이 이미 "다른 파일을 정리해 공간을 만든 뒤"라고 말한다.

## 9. 소유권과 계약의 변화

**데이터·프로세스 소유권 규칙은 바뀌지 않는다.** `WORKER_ID` 신분 체계, 회수 네 층, PGDATA·
저장소 페어링 전부 그대로다. 바뀌는 것은 셋이다.

| 계약 | 전 | 후 |
| --- | --- | --- |
| 코드 서명 identity | ad-hoc (`-`) | Developer ID Application `L5Y9SZHGRN` |
| TCC 권한의 수명 | 빌드 하나 (cdhash에 고정) | identity 전체 (재빌드·업데이트에 걸쳐 유지) |
| `safeStorage` 토큰 | ad-hoc 서명에 묶인 Keychain ACL | Developer ID에 묶인 ACL. **전환 시 1회 무효** — §3-13 경로로 재입력 |

마지막 줄이 사용자에게 보이는 유일한 퇴행이다. 전환 빌드에서 **한 번** 토큰을 다시 넣어야 하고,
그 다음부터는 재빌드에도 살아남는다. 배포 문구에 적는다.

## 10. 완료 기준

환경 표기: **packaged** = 이 맥에서 `desktop:build` 산출물. **원격** = 두 번째 맥(macOS 26.x,
새 사용자 계정). **static** = `check-bundle.mjs` 또는 빌드 단언.

| ID | 기준 | 환경 | 확인 방법 |
| --- | --- | --- | --- |
| P6a-C1 | 번들 Mach-O 전수의 `minos` 최대값이 15.0 이하다 | static | `vtool -show-build` 전수. 초과 파일 0개. 실패 시 경로·값 전부 보고. **`app.asar` 안에 Mach-O가 0개임도 함께 단언**(§5.4) |
| P6a-C2 | `Info.plist`의 `LSMinimumSystemVersion`이 `15.0`이고 `CFBundleShortVersionString`이 `package.json`의 `version`과 같다 | static | plist 읽기 |
| P6a-C3 | `.app`·DMG의 모든 서명이 Developer ID Application `L5Y9SZHGRN`이고, python·ffmpeg 트리에 hardened runtime 플래그가 붙어 있다 | static | `codesign -dv --verbose=2` 전수. Authority 3단(leaf → Developer ID CA → Apple Root), ~~postgres 트리는 identity만~~ **postgres 트리도 R12(각주 §3-3) 이후 runtime 플래그까지 66/66 확인 — entitlements는 없음** |
| P6a-C4 | 공증을 통과하고 스테이플이 붙었다 | static (`--release`) | `spctl --assess --type execute -vv`가 `accepted, source=Notarized Developer ID`. `stapler validate` 통과. DMG와 그 안의 `.app` 양쪽 |
| P6a-C5 | 릴리스 빌드에서 태그와 `package.json` 버전이 어긋나면 빌드가 멈춘다 | static | 일부러 어긋나게 하고 `--release`로 실행 → 비영(非零) 종료 |
| P6a-C6 | 디스크 부족에서 원인과 복구 안내가 화면에 뜬다 | packaged | §11-2의 주입 절차. **세 주체 전부**(worker job·embed 기동·LLM 기동, §8.1의 표)와 업로드(8.2)에서 관찰. 화면에 `디스크 공간이 부족해요 — 남은 용량 …, 필요한 용량 …`과 안내 문구. worker job은 회의 카드에, embed·LLM은 상태 창에 뜬다 |
| P6a-C7 | 업로드 ENOSPC가 507로 나가고 아무것도 남기지 않는다 | packaged | HTTP 507 + 사유 코드. 임시 파일(`os.tmpdir()`의 `dw-upload-*`)이 0개로 정리됨. **`meeting`·`job` 행이 생기지 않는다** — multer가 컨트롤러 진입 전에 쓰므로 회의 생성은 아직 일어나지 않았어야 한다 |
| P6a-C8 | 디스크 부족 회차 뒤 기존 데이터가 보존되고 고아 행이 없다 | packaged | 전후 `meeting`·`utterance` 행 수와 `data/storage` 파일 수가 같다. Phase 5의 정합성 질의 넷이 0행 |
| P6a-C8b | 모델 다운로드 디스크 부족이 재시도 예산을 태우지 않는다 | packaged | **worker job 경로에 한정한다**(업로드 경로에는 job이 아직 없다 — C7이 본다). 해당 job의 `attempts`가 1 증가에 그치고 `failed`. `queued`로 돌아 백오프를 도는 일이 없다 |
| P6a-C9 | 두 번째 맥에서 DMG를 열어 설치하고 Gatekeeper 경고 없이 실행된다 | 원격 | 새 사용자 계정. 첫 실행에 "확인되지 않은 개발자" 대화상자가 **뜨지 않는다**. 네트워크를 끊고도 실행된다(스테이플 확인) |
| P6a-C10 | 두 번째 맥에서 토큰 온보딩 → 모델 다운로드 → 실제 회의 처리가 `done`까지 간다 | 원격 | 개발 도구 없는 새 계정. 실오디오 1건. `meeting.status='done'`, `utterance` 행 존재. 마이크 권한 대화상자가 정상적으로 뜬다 |
| P6a-C11 | 재빌드·재설치 후에도 TCC 마이크 권한과 토큰이 유지된다 | 원격 | C10 뒤 버전을 올려 다시 빌드·설치 → 마이크 권한을 **다시 묻지 않고**, 토큰 재입력도 없다. DR이 identity 기반임의 종단간 증명 |
| P6a-C12 | ad-hoc → Developer ID 전환 빌드에서 토큰이 1회 무효가 되고, 크래시 없이 온보딩으로 떨어진다 | packaged | §9의 예고된 퇴행. 앱이 토큰 창을 띄우고 서비스를 0개 띄운다(Phase 4 C1과 같은 모양) |
| P6a-C13 | DMG 안의 `.app`도 서명·공증·스테이플이 살아 있다 | static (`--release`) | DMG를 마운트해 그 안의 `.app`에 `spctl --assess`·`stapler validate`·`codesign -dv`. §7의 3·4번이 의도대로 이어졌는지는 이것만이 증명한다 |
| P6a-C14 | 릴리스가 `desktop-v<version>` 태그로 발행되고 DMG와 SHA-256이 자산으로 올라간다 | static | `gh release view desktop-v<version>`에 자산 둘. `deploy/release.sh`가 쓰는 `v<version>` 태그와 충돌하지 않는다. 받은 DMG의 sha256이 자산의 값과 같다 |

**P6a-C11이 이 Phase에서 가장 값진 기준이다.** Phase 1이 이론으로만 말한 것(DR 안정성)을 실제
사용자 경험으로 닫는다. 6b의 업데이트가 그 위에 선다.

## 11. 미확정 사항

구현에 영향을 주므로 **계획의 이른 Task에서 실증한다.** 스펙 리뷰 통과의 조건이 아니라 별도
검증 단계로 명시한다(로드맵 "1. 구현 스펙"의 규칙).

1. ~~6b의 알림 원천은 `/releases/latest`~~ — **스펙 리뷰에서 뒤집혔다.** `v<version>` 태그
   네임스페이스를 셀프호스팅 웹 배포가 이미 쓰고 있어 `/releases/latest`가 제품을 가리지
   못한다. §4가 태그를 `desktop-v<version>`으로 가르고, 6b는 `GET /releases`를 받아 그 접두사로
   거른다. 6a의 할 일은 §7.1이고 P6a-C14가 판정한다. 미확정이 아니라 **결정**이다.
2. **디스크 부족 주입 방법이 여전히 미확정이다.** Phase 5 스펙 §12가 후보 둘을 적었고 실제로는
   "디스크가 실제로 찬 회차"로 관측했다(Phase 5 결과). 6a는 **어댑터가 생긴 뒤**라 더 작은
   주입으로 충분할 수 있다 — 후보 3: 작은 sparse image를 마운트하고 `TMPDIR`을 거기로 돌려
   업로드(8.2)만 재현, 모델 쪽(8.1)은 필요한 용량 계산을 크게 만들어 단위 테스트로. 실제 디스크를
   채우는 방법은 쓰지 않는다.
3. **두 번째 맥이 26.x라 15.0은 실행으로 증명되지 않는다.** 선언(`LSMinimumSystemVersion`)과
   단언(`minos` ≤ 15.0)까지가 이 Phase가 닿는 곳이고, **26.x에서의 실행은 증명된다.**
   결과 문서에 한계로 적는다. 15.x 맥이 생기면 그때 1회 확인한다.
4. **`mlx` 15.0 휠의 런타임 동작은 미관측이다.** 26.0 휠과 같은 소스의 다른 배포 타깃이므로
   전방 호환이 기대되지만, 실제로 STT·요약이 같은 결과를 내는지는 C10이 처음 본다. 다르면
   §5.1의 판단(15.0)을 다시 본다.
5. **DMG 레이아웃·배경은 정하지 않았다.** electron-builder 기본값으로 시작하고, 필요하면
   별도 작업으로 다듬는다. 배포 가능성에 영향이 없다.

## 12. 기술 위험

1. **개인 키를 잃으면 업데이트 연속성이 끊긴다.** 인증서는 재발급되지만 새 키는 다른
   identity가 되고, 그러면 **기존 사용자의 TCC 권한과 `safeStorage` 토큰이 전부 무효**가 된다.
   완화: `.p12` 백업이 이미 있고(§3-7), 이 맥 밖에 한 벌 더 두는 것을 결과 문서에 남긴다.
2. **공증이 빌드를 Apple 서버에 묶는다.** 장애·심사 지연이 배포를 막는다. 완화: 개발 루프가
   `--release` 없이 돌아 공증을 타지 않고, 릴리스 쪽은 타임아웃과 제출 id 기록으로 재개 가능하게
   한다(§7-2).
3. **`minos` 단언이 의존성 갱신을 막을 수 있다.** 새 버전의 휠이 16.0만 낸다면 그 갱신이
   `check-bundle`에서 멈춘다. **그것이 의도다** — 조용히 바닥이 올라가는 것보다 낫다. 대신 실패
   메시지가 "무엇을 올려야 하는가"를 말하게 한다(패키지 이름과 값).
4. **postgres·ffmpeg 재빌드가 실측과 다를 수 있다.** `MACOSX_DEPLOYMENT_TARGET`을 존중하지 않는
   서브 빌드가 섞이면 선언만 바뀌고 산출물은 27.0으로 남는다. §5.4의 단언이 그 그물이고,
   걸리면 해당 컴포넌트의 `configure`·`Makefile`을 개별로 본다.
5. **전환 빌드의 토큰 무효화가 검증 회차를 방해한다.** C12가 그것을 기준으로 삼아 놀라지 않게
   하지만, C6~C8의 packaged 회차 전에 토큰을 다시 넣어야 한다. 검증 순서에 반영한다.
6. **두 번째 맥에 개발 도구가 깔려 있다.** 새 사용자 계정이 `PATH`·`~/Library`·TCC를 가르지만
   `/opt/homebrew`·`/usr/local`은 시스템 전역이라 남는다. C10은 "개발 환경이 전혀 없는 맥"이
   아니라 "개발자 계정 밖"을 증명한다. 한계로 적는다.
7. **`out/` 정리를 잊으면 옛 ad-hoc 산출물이 섞인다.** §6의 마지막 줄이 그것이고,
   디렉터리를 통째로 지운다(파일만 지우면 `.DS_Store`로 `ENOTEMPTY`).

## 13. 로드맵 변경

이 Phase와 함께 `docs/electron-migration-roadmap.md`를 고친다.

- Phase 6을 **6a(배포)·6b(업데이트)**로 나누고 각자의 범위·완료 기준·병합 순서를 적는다.
  근거는 "6a의 산출물이 6b의 선행 조건"(§2.2)이고, 로드맵의 "Phase가 너무 커서 리뷰하기 어렵다면
  구현 전에 하위 Phase로 나눈다" 규칙을 따른다.
- P5-C6(디스크 부족)이 **6a**로, `attempts` 분리가 **6b**로 간다고 명시한다.
- 업데이트 방식 결정("알림만, GitHub Releases API, 설치는 사람이")을 Phase 6b 절에 기록한다 —
  로드맵이 "해당 Phase 스펙에서 결정"이라고 남겨 둔 자리다.
- 최소 macOS 버전 **15.0**을 기록하고, P0-C11이 여기서 닫혔음을 Phase 0 절에서 가리킨다.

## 14. 리뷰 기록

**1차 — 코덱스 (읽기 전용, 구현 대화 미제공), 대상 `c0415e9`.** 지적 5건 전부 유효했다.
검증 중 2번이 리뷰가 말한 것보다 크다는 것이 드러났다.

| 지적 | 판정 | 조치 |
| --- | --- | --- |
| P0 `mac.target: dmg`로 바꾸면 DMG가 **서명 전 앱**을 담고, 뒤의 `.app` 스테이플이 DMG 내부 사본에 닿지 않는다 | **유효** — `package.mjs:82`가 electron-builder를 먼저 돌리고 `112-135`가 그 뒤에 서명한다 | §7을 6단계 순서로 다시 썼다. `--dir` 유지 → 서명 → `check-bundle` → `.app` 공증·스테이플 → `--prepackaged`로 DMG 생성 → DMG 서명·공증·스테이플. `--prepackaged` 플래그 존재를 실측 확인. P6a-C13 신설(마운트해 DMG 안을 본다) |
| P0 "GitHub Release로 낸다"만 있고 업로드 절차·완료 기준이 없다 | **유효, 그리고 더 크다** — 검증하다 `v<version>` 태그를 `deploy/release.sh`가 이미 쓰고 있음을 발견했다(`v0.1.1`~`v0.2.3` 실재, 자산은 tarball·wheel이고 DMG 없음). `release.sh:19-22`는 태그 버전이 `be/worker/pyproject.toml`과 다르면 거절한다. 그대로 두면 **6b의 `/releases/latest`가 웹 릴리스를 가리켜** 앱이 tarball을 권한다 | §4에 네임스페이스 분리(`desktop-v<version>`)와 6b의 조회 방식 변경을 넣었다. §7.1(릴리스 발행)을 신설하고 P6a-C14로 판정한다. §11-1의 "미확정"을 결정으로 뒤집었다 |
| P0 디스크 부족을 worker job의 PERMANENT로만 설계했으나 다운로드 주체가 셋이다 — `embed_service.py:84`와 `llm_entry.py:57`도 훅을 걸고 모델을 올리며 둘 다 `dispatch.py`의 job 경로 밖이다 | **유효** | §8.1에 주체 3열 표를 넣고, 점검은 공통 훅 지점(`models/downloads.py`) 한 곳에 두되 표면화만 갈랐다. embed·LLM은 job이 아니라 Phase 2의 서비스 실패·`manual` 재시도 갈래로 간다. P6a-C6이 셋 전부를 관찰한다 |
| P0 C8이 "job의 `attempts` 1 증가"를 요구하나 업로드 ENOSPC에는 job이 없다 — multer가 컨트롤러 진입 전에 쓰고 회의 생성은 그 뒤다 | **유효** | 기준을 갈랐다. C7은 업로드 전용(507·임시 파일 정리·`meeting`/`job` 0행), C8b는 모델 다운로드 job 경로 전용, C8은 데이터 보존으로 남겼다 |
| P1 `Contents/` 전수 순회가 `app.asar` 안을 보지 못한다 | **유효(부분)** — 지금은 열 것이 없다. `desktop`에 runtime 의존성이 0개이고 기존 단언이 "app.asar has no node_modules"를 이미 본다 | §5.4에 "asar 안에 Mach-O 0개" 단언을 더해 "전수"를 참으로 만들었다. P6a-C1에 반영 |
