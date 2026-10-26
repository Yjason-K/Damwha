# 시스템 오디오 녹음 구현 계획

> **사후 기록이다.** 프로젝트 규칙상 구현 전에 써야 했으나 빠뜨렸고, 구현을 마친 뒤 **실제로 진행한 순서**를 그대로
> 적었다. 따라서 체크박스는 모두 끝난 상태이고, 계획 단계의 리뷰는 거치지 않았다. 남은 일은 맨 아래 "남은 작업"에 있다.

**Goal:** 데스크톱 앱의 실시간 녹음이 마이크와 함께 이 맥의 시스템 오디오(화상회의 상대 목소리)를 한 채널로 섞어 녹음한다.

**Architecture:** Swift 헬퍼가 CoreAudio Process Tap으로 시스템 오디오를 16 kHz·mono·int16 PCM으로 stdout에 흘린다. desktop main이
커스텀 스킴 `damwha-audio://system/pcm`의 응답 본문으로 그 PCM을 내보내고(§6.11의 예외), fe 녹음기가 `prepare()`에서 그 스트림을
열어 Worklet의 마이크 프레임에 샘플 단위로 더한다. 업로드·worker는 그대로다.

**Tech Stack:** Swift 6.4(swiftc, CoreAudio·AVFoundation), Electron 44.3(`protocol.handle`, vitest), React 19(vitest+jsdom).

**Spec:** `docs/superpowers/specs/2026-10-26-system-audio-capture-design.md`

## Global Constraints

- 캡처 준비는 회의 생성 **전**이다. 시스템 오디오 실패도 `POST /meetings/live` 전에 드러나야 한다 (spec C3).
- 섞은 프레임 길이 = 마이크 프레임 길이. 업로드 오프셋·경과 시간·청크 규칙을 건드리지 않는다 (spec §2.3, C8).
- 헬퍼를 끄는 신호는 스트림 cancel 하나다. 녹음기의 자원 반납이 반드시 cancel한다 (spec §2.5).
- 스킴은 허용 origin만. Origin이 없으면 referrer의 origin (spec §2.4).
- desktop의 판단 로직은 electron을 import하지 않는 모듈에 두고, `main.ts`에는 배선만 (desktop/CLAUDE.md "지키는 것").
- 테스트는 시간에 기대지 않는다 — 고정 sleep·폴링 없이 정확한 신호를 기다린다.

---

### Task 1: Swift 헬퍼

**Files:**
- Create: `desktop/native/system-audio/main.swift`

- [x] Process Tap(`CATapDescription(monoGlobalTapButExcludeProcesses:)`, 부모 프로세스 제외, private, unmuted) → private aggregate
  device(기본 출력 장치를 주 장치로, tap 자동 시작·drift 보정) → `AVAudioConverter`로 16 kHz int16 mono → stdout.
- [x] stderr `READY` / `ERROR <단계> <OSStatus>`, stdin EOF·SIGTERM·SIGINT에 정리 후 종료, SIGPIPE 무시.
- [x] 실측: `swiftc -O -target arm64-apple-macos15.0`로 컴파일, 시스템 사운드 재생 중 4.26초 캡처 — peak 9648, RMS 631,
  샘플 절반 0 아님, stdin을 닫자 exit 0, 남은 프로세스 없음.

### Task 2: 빌드·서명·번들 검사

**Files:**
- Create: `desktop/scripts/build-system-audio.sh`
- Modify: `desktop/package.json`(`start:desktop`), `desktop/scripts/package.mjs`, `desktop/electron-builder.yml`, `desktop/scripts/check-bundle.mjs`

- [x] 빌드 스크립트 — `build-target.sh`의 `MACOSX_DEPLOYMENT_TARGET`으로 컴파일해 `desktop/build/system-audio/`에 스테이징.
- [x] `package.mjs` — 빌드 스크립트 호출, `.app`보다 먼저 `signAll([...], null, "Resources/system-audio", { runtime: true })`.
- [x] `electron-builder.yml` — `NSAudioCaptureUsageDescription`.
- [x] `check-bundle` — 6a(plist 키), 25(헬퍼 존재·실행 가능·hardened runtime).
- [x] 확인: 스크립트 실행 → `vtool -show-build` minos 15.0, `node --check`(두 .mjs), YAML 파싱에 새 키.

### Task 3: desktop 헬퍼 실행 모듈

**Files:**
- Create: `desktop/src/process/system-audio.ts`
- Test: `desktop/tests/process/system-audio.test.ts`

**Interfaces:**
- Produces: `startSystemAudio(bin, opts?) → Promise<SystemAudioSession { pcm: Readable; exited; stop() }>`,
  `systemAudioHelperPath(bundleDir)`, `SystemAudioStartError`.

- [x] READY를 기다려 세션을 준다. READY 전 ERROR·종료·시간 초과는 **프로세스가 끝난 뒤** reject한다(반쯤 뜬 tap을 남기지 않는다).
- [x] `stop()`은 stdin을 닫고, 안 끝나면 SIGTERM, 다시 SIGKILL.
- [x] 테스트 7 — `/bin/sh` 가짜 헬퍼로 READY·ERROR·준비 전 종료·없는 바이너리·시간 초과 뒤 프로세스 소멸(`spawnFn`으로 자식을 잡아
  종료 상태를 바로 본다)·신호 상승·스크립트의 파일 이름과 짝.
  - 처음엔 pid 파일로 소멸을 확인했는데 부하에서 sh가 pid를 쓰기 전에 100 ms 한도가 지나 실패했다 — 테스트를 고쳤다.

### Task 4: fe 믹서

**Files:**
- Create: `fe/src/features/meeting/lib/pcm-mix.ts`
- Test: `fe/src/features/meeting/lib/pcm-mix.test.ts`

**Interfaces:**
- Produces: `SystemAudioMixer { pushBytes(bytes); mixInto(mic): Int16Array; reset() }`, `MAX_SYSTEM_LAG_SAMPLES = SR / 2`.

- [x] 덧셈·길이 보존·이월·홀수 바이트 이어 붙이기·int16 포화·0.5초 상한에서 오래된 샘플 버림·reset. 테스트 6.

### Task 5: 녹음기에 끼우기

**Files:**
- Modify: `fe/src/features/meeting/lib/live-recorder.ts`, `fe/src/features/meeting/lib/live-session.ts`
- Test: `fe/src/features/meeting/lib/live-recorder.test.ts`

**Interfaces:**
- Produces: `OpenSystemAudio = () => Promise<ReadableStream<Uint8Array>>`, `RecorderStatus.systemAudio: "off" | "on" | "lost"`,
  `LiveRecorder.prepare(deviceId?, openSystemAudio?)`, `prepareLiveRecorder(deviceId?, openSystemAudio?)`.

- [x] `prepare`의 Worklet ready 뒤에 스트림을 열고 읽기 루프를 돌린다. `begin`에서 믹서 reset. `pcm` 이벤트마다 섞는다.
  `release`가 reader를 cancel. 스스로 끝나면 `lost`.
- [x] `live-session` — 인자 전달, `lost`에 토스트 한 번.
- [x] 테스트 6 — `highWaterMark: 0` 스트림의 "다음 pull"을 소비 완료 신호로 써서 시간을 기다리지 않는다. 섞기·begin 이전 버림·
  종료 시 cancel·lost·열기 실패 시 마이크·ctx 반납·준비 취소 뒤 늦은 스트림 cancel.
  - 마지막 테스트를 쓰다가 **버그를 찾았다**: 여는 사이 `dispose`가 오면 `release()`가 이미 메모이즈돼 늦게 온 스트림을 아무도
    cancel하지 않아 헬퍼가 계속 돈다. 세대가 바뀌었으면 그 자리에서 cancel하도록 고쳤다.

### Task 6: 스킴 핸들러와 main 배선

**Files:**
- Create: `desktop/src/windows/system-audio-protocol.ts`
- Modify: `desktop/src/main.ts`
- Test: `desktop/tests/windows/system-audio-protocol.test.ts`

**Interfaces:**
- Produces: `SYSTEM_AUDIO_SCHEME`, `SYSTEM_AUDIO_PRIVILEGES`, `createSystemAudioProtocol({ allowedOrigins, start, log })
  → { handle(request): Promise<Response>; stopAll() }`.

- [x] 핸들러 — origin(없으면 referrer) 검사 403, `/status` 200, `/pcm` 스트림·409·503, 본문 cancel → `stop()`, `exited`에 슬롯 해제·로그.
- [x] `main.ts` — ready 전 `registerSchemesAsPrivileged`, `whenReady`에서 `protocol.handle`, `beginQuit`에서 `stopAll()`,
  `bundleDir`에 `"system-audio"`.
- [x] 테스트 8 — 낯선 origin·origin 없음 403, referrer만 있을 때 통과/거부, status, 스트림, cancel→stop, 동시성·슬롯 해제, 503, stopAll.

### Task 7: fe 어댑터와 모달 옵션

**Files:**
- Create: `fe/src/features/meeting/lib/system-audio.ts`
- Modify: `fe/src/features/meeting/ui/new-meeting-dialog.tsx`
- Test: `fe/src/features/meeting/ui/new-meeting-dialog.live.test.tsx`

- [x] `isSystemAudioAvailable()`(status fetch 성공), `openDesktopSystemAudio`(실패면 `SystemAudioUnavailable`), 선호 저장·읽기.
- [x] 모달 — 실시간 탭이 열리면 한 번 확인, 마이크 선택 아래 `Switch`("시스템 오디오도 녹음"), 시작 때 켜져 있으면 opener 전달,
  `SystemAudioUnavailable`은 전용 토스트.
- [x] 테스트 4 — 브라우저에서 숨김, 데스크톱 기본 켬·시작 시 pcm 요청, 끄면 요청 안 함·`off` 저장, 503이면 회의 없음·마이크 닫힘.

### Task 8: 문서

- [x] `desktop/CLAUDE.md` — 번들 표에 `system-audio/`, "시스템 오디오" 단락(§6.11 예외, 권한·무음 한계, loopback을 안 쓰는 이유), 명령 줄.
- [x] `fe/CLAUDE.md` — "시스템 오디오는 마이크에 더해져 한 채널로 올라간다" 항목.

### Task 9: 검증

- [x] desktop `pnpm test` / `pnpm run lint`, fe `pnpm test` / `tsc -b` / `pnpm lint`.
- [x] dev 앱 실기(CDP) — 렌더러에서 스킴 수신, 409, cancel 뒤 헬퍼 종료, 모달 스위치.
  - 실기 첫 회차에서 전부 403 — Origin 헤더가 없고 referrer만 온다는 것을 로그로 확인하고 Task 6을 고쳤다.

## 남은 작업

- `pnpm desktop:build` + `check-bundle` (패키징·서명·6a·25 실측).
- 서명된 앱의 첫 녹음에서 "시스템 오디오 녹음" 권한 프롬프트가 뜨는지.
- 실제 화상회의 소리로 실시간 녹음 한 건(전사까지) — dev와 packaged가 같은 DB를 써서 이번에 하지 않았다.
- 회의 감지 알림(후속 spec).
