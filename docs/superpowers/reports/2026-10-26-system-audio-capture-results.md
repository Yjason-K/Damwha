# 시스템 오디오 녹음 결과

**작성일:** 2026-10-26
**Spec:** [`specs/2026-10-26-system-audio-capture-design.md`](../specs/2026-10-26-system-audio-capture-design.md)
**Plan:** [`plans/2026-10-26-system-audio-capture.md`](../plans/2026-10-26-system-audio-capture.md) (사후 기록)
**브랜치:** `feat/system-audio-capture` (`3eb4fa9`에서 시작). **이 문서를 쓰는 시점에 커밋은 없다** — 변경은 작업 트리에만 있다.
**선행:** [`reports/2026-10-20-cli-mcp-results.md`](2026-10-20-cli-mcp-results.md)

## 요약

데스크톱 앱의 실시간 녹음에 "시스템 오디오도 녹음" 옵션을 더했다. 켜면 Swift 헬퍼가 CoreAudio Process Tap으로 이 맥의 소리
(담화 자신 제외)를 받고, desktop main이 커스텀 스킴 `damwha-audio://system/pcm`으로 렌더러에 흘리며, 녹음기가 그것을 마이크
프레임에 샘플 단위로 더해 기존 정본 형식 그대로 업로드한다. 업로드·worker·계약은 그대로다.

- `desktop/` — 헬퍼(`native/system-audio/main.swift`), 빌드 스크립트, 서명·`check-bundle` 6a·25, `NSAudioCaptureUsageDescription`,
  헬퍼 실행 모듈(`process/system-audio.ts`), 스킴 핸들러(`windows/system-audio-protocol.ts`)와 `main.ts` 배선.
- `fe/` — 믹서(`lib/pcm-mix.ts`), 녹음기·세션 연결(`live-recorder.ts`·`live-session.ts`), 어댑터(`lib/system-audio.ts`), 모달 스위치.
- `desktop/CLAUDE.md`·`fe/CLAUDE.md` — 살아 있는 문서 갱신.

## 변경 파일 (`git status --short`, 이 기록 문서 제외)

```
 M desktop/CLAUDE.md
 M desktop/electron-builder.yml
 M desktop/package.json
 M desktop/scripts/check-bundle.mjs
 M desktop/scripts/package.mjs
 M desktop/src/main.ts
 M fe/CLAUDE.md
 M fe/src/features/meeting/lib/live-recorder.test.ts
 M fe/src/features/meeting/lib/live-recorder.ts
 M fe/src/features/meeting/lib/live-session.ts
 M fe/src/features/meeting/ui/new-meeting-dialog.live.test.tsx
 M fe/src/features/meeting/ui/new-meeting-dialog.tsx
?? desktop/native/
?? desktop/scripts/build-system-audio.sh
?? desktop/src/process/system-audio.ts
?? desktop/src/windows/system-audio-protocol.ts
?? desktop/tests/process/system-audio.test.ts
?? desktop/tests/windows/system-audio-protocol.test.ts
?? fe/src/features/meeting/lib/pcm-mix.test.ts
?? fe/src/features/meeting/lib/pcm-mix.ts
?? fe/src/features/meeting/lib/system-audio.ts
```

진행 방식: 에이전트 한 명이 직접 구현·검증했다. 서브에이전트 검토·계획 리뷰는 거치지 않았다. spec·plan은 구현 뒤에 썼다(규칙 위반,
사용자 지적으로 보완).

## 검증

| 대상 | 명령 | 결과 |
| --- | --- | --- |
| 헬퍼 단독 | `swiftc -O -target arm64-apple-macos15.0 …` 후 시스템 사운드 재생 중 캡처, stdin 닫기 | 4.26초, peak 9648, RMS 631, 샘플 절반 0 아님. exit 0, 남은 프로세스 없음 |
| 빌드 스크립트 | `bash desktop/scripts/build-system-audio.sh` · `vtool -show-build` | 스테이징됨, `minos 15.0` |
| 패키징 스크립트 | `node --check scripts/check-bundle.mjs scripts/package.mjs`, `electron-builder.yml` YAML 파싱 | 통과, `extendInfo`에 `NSAudioCaptureUsageDescription` |
| desktop | `cd desktop && pnpm test` | 78 files, 1290/1290 (신규 15: 헬퍼 실행 7, 스킴 8) |
| desktop | `pnpm run lint` (`tsc -p tsconfig.lint.json`) | 통과 |
| fe | `cd fe && pnpm test` | 96 files, 910/910 (신규 16: 믹서 6, 녹음기 6, 모달 4) — 아래 주의 |
| fe | `pnpm exec tsc -b` | 통과 |
| fe | `pnpm lint` | 오류 0, 경고 1(`saved-utterance-dashboard.tsx:60`, 기존·무관) |
| 실기(dev 앱, CDP) | 렌더러(`http://localhost:5173`)에서 `fetch('damwha-audio://system/status')`·`/pcm` 5초 읽기 + 시스템 사운드 재생 | status 200 `{available:true,busy:false}`, pcm 200, 약 3.71초 수신, peak 9723, 0 아닌 샘플 59% |
| 실기 | 수신 중 두 번째 `/pcm` | 409 |
| 실기 | 본문 cancel 뒤 `pgrep damwha-system-audio` · supervisor.log | 헬퍼 종료, `시스템 오디오 헬퍼 종료 — code=0 signal=null` |
| 실기 | 모달 실시간 탭 열기, 스크린샷 | 마이크 선택 아래 "시스템 오디오도 녹음" 스위치, `checked: true` |
| 실기 | 앱에 SIGTERM 뒤 `pgrep` (postgres·worker·vite·헬퍼·Electron) | 남은 프로세스 없음 |

**fe 테스트 주의:** 전체 실행 첫 회차(desktop·tsc와 동시)에 2건 실패, 단독 재실행은 910/910, 부하를 다시 걸자
`src/pages/meeting.test.tsx > 회의 셸은 전사·인사이트·플레이어를 렌더한다` 1건이 재현됐다. lazy route의 `findByRole`이 1초 기본 한도를
넘는 실패이고 이번 변경 파일을 import하지 않는다 — **기존의 시간 의존 flaky로 판단해 손대지 않았다.** 신규 테스트는 부하 회차에서도 통과했다.

**실기에서 잡은 결함:** 첫 회차는 렌더러 요청이 전부 403이었다. 로그로 확인하니 이 스킴의 요청에는 `Origin` 헤더가 없고 `referrer`만
있었다. referrer의 origin으로 판정하도록 고치고 테스트를 더한 뒤 위 실기 결과를 얻었다.

**테스트로 잡은 결함:** 준비 중 `dispose`가 시스템 오디오를 여는 사이에 오면 늦게 도착한 스트림이 cancel되지 않아 헬퍼가 남는 경로.
녹음기 테스트를 쓰며 발견해 고쳤다.

## 성공 기준 판정

| 기준 | 판정 | 근거 |
| --- | --- | --- |
| C1 섞어서 같은 정본으로 업로드 | **부분** | 믹서·녹음기 단위 테스트(정본 바이트 = 마이크 + 시스템), 실기 스킴 수신까지. **실제 녹음 한 건(업로드·전사)은 하지 않았다** — dev와 packaged가 같은 DB라 사용자 데이터에 회의가 생긴다 |
| C2 데스크톱만·기본 켬·기억 | 충족 | 모달 테스트 3, 실기 스크린샷 |
| C3 실패는 회의 생성 전, 마이크 닫힘 | 충족 | 녹음기 "열기 실패" 테스트, 모달 503 테스트 |
| C4 끊겨도 녹음 계속, 한 번 알림 | 충족(단위) | 녹음기 `lost` 테스트(`failed` null·phase recording). 토스트 문구는 실기 미확인 |
| C5 헬퍼 수명·동시 하나 | 충족(일부 실측) | 실기: cancel→exit 0, 409. 단위: 준비 취소 뒤 늦은 스트림 cancel, stopAll. **새로고침·창 파괴 경로는 실측하지 않았다** |
| C6 담화 origin만 | 충족 | 단위 403(낯선 origin·없음·낯선 referrer), 실기 통과 |
| C7 번들·서명·plist·check-bundle | **미검증** | 스크립트·설정은 넣었고 문법·minos는 확인. **`pnpm desktop:build`와 `check-bundle`은 돌리지 않았다** |
| C8 업로드·worker·계약 불변 | 충족 | be·worker·packages 변경 없음(위 파일 목록) |

## 남은 작업

- `pnpm desktop:build` + `check-bundle`로 C7을 닫는다. 서명된 앱의 첫 녹음에서 권한 프롬프트가 뜨는지 본다.
- 화상회의 소리로 실시간 녹음 한 건을 전사까지 돌려 C1을 닫는다(이어폰 있음·없음).
- 녹음 중 새로고침해서 헬퍼가 꺼지는지 본다(C5의 남은 경로).
- `src/pages/meeting.test.tsx`의 flaky는 별건으로 다룬다.
- 회의 감지 알림 — 후속 spec.
