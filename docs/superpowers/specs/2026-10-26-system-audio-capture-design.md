# 시스템 오디오 녹음 설계

**작성일:** 2026-10-26 (구현과 같은 날, 구현 뒤에 정리했다 — 아래 "작성 경위")
**선행:** `dev` @ `3eb4fa9` (desktop 0.4.6). 브랜치 `feat/system-audio-capture`.
**대체:** 없음. 새 기능이다. 실시간 녹음의 캡처 계약(`2026-09-05-live-recording-browser-capture-design.md`,
`2026-09-07-live-recording-capture-hardening-design.md`)은 그대로 두고 그 위에 입력 하나를 더한다.
Phase 2 스펙 §6.11("렌더러 → main 경로를 만들지 않는다")에 **예외 하나**를 만든다(§2.4).
**범위:** desktop의 Swift 헬퍼·빌드·서명·번들 검사·커스텀 스킴, fe의 녹음기 믹싱과 녹음 모달 옵션. be·worker·계약 변경 없음.

**작성 경위:** 프로젝트 규칙(루트 `CLAUDE.md` "Work records")상 설계 승인 뒤에 써야 했으나 빠뜨렸고, 구현을 마친 뒤
사용자 지적으로 썼다. 결정 내용과 출처는 대화에서 내려진 그대로 옮겼다.

## 1. 목표

실시간 녹음은 지금 마이크 하나만 연다(`live-recorder.ts`의 `getUserMedia`, `channelCount: 1`). 줌·구글 Meet 같은
화상회의를 녹음하면 상대 목소리는 스피커 소리가 마이크로 다시 들어온 만큼만 남고, **이어폰을 끼면 아예 남지 않는다.**
이 spec은 데스크톱 앱에서 이 맥에서 나는 소리(시스템 오디오)를 마이크와 함께 녹음하게 한다.

후속으로 노션의 "회의 감지 알림"(마이크를 쓰는 앱이 생기면 녹음을 제안하는 팝업)을 만들 예정이고, 이 기능이 그 전제다 —
감지해서 녹음을 시작해도 상대 목소리가 빠지면 쓸모가 없다(사용자와 합의한 순서).

### 성공 기준

- C1. 데스크톱 앱의 실시간 녹음에서 옵션을 켜면 시스템 오디오가 마이크와 **샘플 단위로 더해져** 기존과 같은
  16 kHz·mono·int16 정본으로 업로드된다.
- C2. 옵션은 데스크톱 앱에서만 보인다. 기본은 켬이고, 끈 선택은 기억한다.
- C3. 시스템 오디오를 열지 못하면 **회의를 만들기 전에** 실패하고, 빈 `recording` 회의를 남기지 않으며 마이크도 닫는다.
- C4. 녹음 도중 시스템 오디오가 끊기면 녹음을 실패시키지 않는다. 마이크는 계속 녹음하고, 사용자에게 한 번 알린다.
- C5. 헬퍼(tap)는 녹음과 수명을 같이한다 — 녹음 종료·준비 취소·렌더러 새로고침·창 파괴·앱 종료에서 꺼진다.
  동시에 하나만 돈다.
- C6. 시스템 오디오 스킴은 담화 화면의 origin만 쓸 수 있다.
- C7. 헬퍼가 `Resources/system-audio/`에 hardened runtime으로 서명돼 실리고, Info.plist에
  `NSAudioCaptureUsageDescription`이 있으며, `check-bundle`이 둘을 검사한다.
- C8. 업로드 경로·worker·`job` 계약·API는 바뀌지 않는다.

### 비목표

- 회의 감지 알림(마이크 사용 감지 팝업). 후속 작업이다.
- 마이크와 시스템 오디오를 채널로 나눠 "나 vs 상대"를 화자 분리 없이 가르는 것(§2.3).
- 특정 앱(줌 등)만 골라 녹음하는 것. 지금은 담화 자신을 뺀 전체를 받는다.
- 웹(브라우저) 배포에서의 시스템 오디오. 데스크톱 전용이다.
- 시스템 오디오 녹음 권한 거부를 감지해 알리는 것(§4 알려진 한계).

### 반목표 (동작해도 실패인 것)

- 시스템 오디오 실패가 빈 회의를 남기거나 다음 녹음을 막는다.
- 렌더러가 죽었는데 tap이 열린 채 남는다.
- 담화가 아닌 페이지가 fetch 한 줄로 이 맥의 소리를 받아 간다.
- 섞은 결과의 길이가 마이크와 달라져 업로드 오프셋·경과 시간 규칙이 깨진다.

## 2. 결정 사항

### 2.1 캡처 방식 — CoreAudio Process Tap (사용자 결정)

macOS 14.2+의 Process Tap을 Swift 헬퍼(`desktop/native/system-audio/main.swift`)로 쓴다. 앱 최소 macOS가 15.0이라
버전 분기가 없다. 화면 녹화 권한이 아니라 "시스템 오디오 녹음" 권한만 받는다.

Electron의 `setDisplayMediaRequestHandler` + `audio: 'loopback'`은 쓰지 않는다. 화면(video) 소스를 함께 요청해야 하고,
앱이 픽커를 쥐면(`useSystemPicker: false`) 오디오 트랙이 `ended`로만 나와 0만 들어오는 버그가 열려 있다
(electron/electron#52738, Electron 43.3). 공식 문서도 권한이 없으면 오류 없이 무음 트랙을 준다고 적는다.

헬퍼 계약:
- 담화(부모 프로세스)가 내는 소리는 tap에서 뺀다 — 회의 화면의 샘플 재생이 녹음에 다시 섞이지 않게.
- stdout에 16 kHz·mono·int16 LE PCM **바이트만**. stderr에 준비되면 `READY`, 실패하면 `ERROR <단계> <OSStatus>`.
- stdin EOF·SIGTERM·SIGINT에 IOProc을 멈추고 aggregate·tap을 지운 뒤 0으로 끝난다. 둘 다 private이라 비정상 종료에도 OS가 거둔다.
- 사용자는 녹음 중에도 평소처럼 듣는다(`muteBehavior = .unmuted`).

### 2.2 옵션 — 녹음마다 고른다 (사용자 질문에 대한 합의)

대면 회의에서는 시스템 오디오가 알림음·음악만 섞고, 권한이 거부될 수 있으며, 이 맥의 소리 전부가 녹음되므로
사용자가 의식적으로 켜야 한다. 모달 실시간 녹음 탭의 마이크 선택 아래에 스위치를 두고, 기본은 켬(실시간 녹음의 가장
흔한 용도가 화상회의), 끈 선택은 `localStorage`의 `damwha:live-system-audio`에 기억한다. 스위치는 데스크톱 앱에서만
보인다(§2.4의 `status` 응답으로 판단).

### 2.3 한 채널로 섞는다 (에이전트 추천 — 사용자가 이 질문에는 답하지 않아 추천대로 진행)

마이크 프레임에 시스템 오디오 샘플을 더하고 int16 범위로 자른다. **마이크가 시계다** — 섞은 프레임의 길이는 언제나
마이크 프레임과 같아서 업로드 오프셋·경과 시간·청크 경계 규칙이 바뀌지 않는다(C8). 시스템 오디오가 모자라면 그 자리는
무음, 남으면 다음 프레임에 쓴다.

- 두 장치의 시계가 어긋나(drift) 큐가 자라면 상대 목소리가 점점 늦게 섞인다 — 큐를 0.5초로 묶고 넘치면 오래된 것부터 버린다.
- `begin`에서 큐를 비운다 — 그 전에 쌓인 소리는 녹음 시계 0 이전이다.
- 청크가 샘플 중간에서 잘려 오면(홀수 바이트) 다음 청크와 이어 붙인다.

대안(두 채널 분리)은 "나 vs 상대"를 화자 분리 없이 가를 수 있으나 worker 파이프라인·PCM worklet 계약을 함께 바꿔야
해서 이번 범위에서 뺐다. 이어폰 없이 쓰면 상대 소리가 스피커→마이크와 tap으로 두 번 들어가는 문제가 남는다(§4).

### 2.4 전달 경로 — 커스텀 스킴 스트림, §6.11의 예외 (사용자 결정)

헬퍼는 main이 띄우고 녹음은 렌더러가 하는데, 지금 앱에는 렌더러 → main 경로가 없다(preload·IPC 없음, §6.11).
세 안(커스텀 스킴 / preload+IPC / 공개 가상 입력 장치) 중 커스텀 스킴을 골랐다.

- main이 `protocol.handle("damwha-audio")`로 `damwha-audio://system/status`와 `/pcm`을 연다. 특권은
  `standard·secure·supportFetchAPI·corsEnabled·stream`.
- `/pcm`을 fetch하면 헬퍼가 뜨고 PCM이 응답 본문으로 흐른다. **수명은 요청에 묶인다** — 본문 cancel(녹음 종료·준비 취소),
  새로고침·창 파괴로 요청이 끊기면 본문의 cancel이 헬퍼를 끈다. 앱 종료는 `beginQuit`이 `stopAll()`로 끈다.
- 동시에 하나 — 돌고 있으면 409. 헬퍼 시작 실패는 503과 사유.
- 허용 origin만 받는다(C6). **실측(2026-10-26, Electron 44.3):** 렌더러의 fetch는 이 스킴에 `Origin` 헤더를 싣지 않고
  `referrer`(`http://localhost:5173/`)만 준다. 그래서 `Origin`이 없으면 referrer의 origin으로 판정한다. 페이지는 fetch의
  referrer를 자기 origin 밖으로 바꿀 수 없다. fe가 `referrerPolicy: "no-referrer"`로 부르면 403이 난다.
- fe는 `/status` fetch 성공 여부로 데스크톱인지 안다. 브라우저에는 이 스킴이 없어 fetch가 곧바로 거부된다.

### 2.5 녹음기 수명에 끼우는 자리

기존 규칙("캡처를 먼저 준비하고, 성공한 뒤에야 회의를 만든다")을 그대로 따른다.

- `prepare(deviceId, openSystemAudio?)` 안, Worklet `ready` 뒤에 스트림을 연다 — 실패는 회의 생성 전에 드러난다(C3).
- 여는 사이 `dispose`가 오면 `release()`는 이미 돌고 끝났으므로, 늦게 온 스트림은 그 자리에서 cancel한다(마이크 스트림과 같은 처리).
- 자원 반납(`release`)이 스트림을 cancel한다 — 그것이 헬퍼를 끄는 유일한 신호다.
- 녹음 도중 스트림이 스스로 끝나면 `status.systemAudio = "lost"`로만 알린다. `failed`가 아니다 — `failed`는 서버의
  `capture_error`로 남고 "마이크가 끊겼다"와 같은 칸이 된다(C4).

## 3. 빌드·서명·번들 (C7)

- `desktop/scripts/build-system-audio.sh` — `xcrun swiftc -O -target arm64-apple-macos$MACOSX_DEPLOYMENT_TARGET`로
  `desktop/build/system-audio/damwha-system-audio`에 스테이징. 캐시 없음(수 초).
- `start:desktop`와 `package.mjs`가 이 스크립트를 부른다. `package.mjs`는 `.app`보다 먼저 entitlements 없이 runtime으로 서명한다
  (Process Tap은 entitlement가 아니라 TCC와 Info.plist로 걸린다).
- `electron-builder.yml`의 `extendInfo`에 `NSAudioCaptureUsageDescription`.
- `check-bundle` 6a(plist 키)·25(헬퍼 존재·실행 가능·hardened runtime). 팀은 7c, minos는 22가 이미 덮는다.

## 4. 알려진 한계

- **권한 거부는 무음이다.** 시스템 오디오 녹음 권한이 거부되거나 plist 키가 없으면 tap 생성은 성공한 채 0만 흐른다.
  공개 API로 권한 상태를 미리 알 방법이 없어 감지하지 않는다.
- **이어폰 없이 쓰면 상대 소리가 두 번 들어간다**(스피커→마이크, tap). 지연이 짧아 전사에는 큰 영향이 없을 것으로 보지만
  측정하지 않았다.
- dev(`electron .`)에서는 권한의 주체가 앱이 아니라 그 앱을 띄운 터미널이다.

## 5. 검증 계획

- desktop: 헬퍼 실행 모듈(READY·ERROR·준비 전 종료·시간 초과 뒤 프로세스 소멸·신호 상승), 스킴 핸들러(origin·referrer·
  status·스트림·cancel→stop·동시성·503·stopAll) 단위 테스트.
- fe: 믹서(덧셈·길이 보존·이월·홀수 바이트·포화·지연 상한·reset), 녹음기(섞기·begin 이전 버림·종료 시 cancel·lost·열기 실패·
  취소 뒤 늦은 스트림 cancel), 모달(브라우저에서 숨김·데스크톱 기본 켬·끄면 안 열고 기억·실패 시 회의 없음).
- 실기: 헬퍼 단독 캡처, dev 앱 렌더러에서 스킴 수신·409·cancel 뒤 헬퍼 종료, 모달 스위치 표시.
- 패키징: `pnpm desktop:build` + `check-bundle`, 서명된 앱의 첫 녹음에서 권한 프롬프트.
