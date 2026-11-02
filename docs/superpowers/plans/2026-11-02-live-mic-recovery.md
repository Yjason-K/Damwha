# 녹음 중 입력 장치 복구 구현 계획

**Spec:** [`specs/2026-11-02-live-mic-recovery-design.md`](../specs/2026-11-02-live-mic-recovery-design.md)

## Task 1: 레코더 복구 (`fe`)

- `live-recorder.ts`: `micConstraints()`, `watchMic()`, `reopenMic()`, `status.micSwitches`, `MIC_REOPEN_TIMEOUT_MS = 5_000`.
- 테스트: `live-recorder.test.ts`의 `LiveRecorder input device loss` 6건. 기존 `ended` 실패 테스트는 입력이 없는 경우로 옮긴다.

## Task 2: 알림 (`fe`, `desktop`)

- `live-session.ts`: 전환마다 토스트, 스냅숏 `micSwitched`.
- `desktop`: `RecordingSnapshot.micSwitched`, 카드 `recording` 뷰의 `micSwitched`, 문구 `detect.recording.micSwitched`.

## Task 3: 실측

- 측정 앱으로 원인을 재현한 뒤 실제 앱에서 모달·카드 경로를 AirPods 분리로 확인한다.
