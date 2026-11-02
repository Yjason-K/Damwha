# 녹음 중 입력 장치 복구 결과

**작성일:** 2026-11-02
**스펙:** [`specs/2026-11-02-live-mic-recovery-design.md`](../specs/2026-11-02-live-mic-recovery-design.md)
**계획:** [`plans/2026-11-02-live-mic-recovery.md`](../plans/2026-11-02-live-mic-recovery.md)
**브랜치:** `fix/live-recording-device-change` (`main` @ `c754420` 기반)

## 원인 실측 (Electron 44.3 측정 앱, 앱 코드 없음)

| 상황 | 기본 장치 트랙 | 고정 트랙 |
| --- | --- | --- |
| 내장 마이크 녹음 중 AirPods 연결, 기본 입력 전환 | 유지 | 유지 |
| 내장 마이크 녹음 중 다른 프로세스가 AirPods 입력 사용 | 유지 | 유지 |
| AirPods 녹음 중 연결 해제 | `ended` | AirPods `ended`, 내장 유지 |
| AirPods 녹음 중 한쪽 빼기, 다시 꽂기 | 유지 | 유지 |
| AirPods 녹음 중 Zoom 시작 | 유지 | 유지 |

AirPods 연결로 기본 입력이 바뀔 때 `AudioContext` 시계가 약 1.7초 멈췄다. 측정 앱의 관측이고 실제 녹음의 손실량은 재지 않았다.

## 앱 실측 (개발 모드, Zoom 회의 중)

- **모달:** `mtg_124`, AirPods로 시작해 케이스에 넣었다. 녹음이 이어져 139.5초, `capture_error` 없음. 끊긴 뒤에도 신호가 있었다.
- **카드:** `mtg_125`, 카드로 시작해 같은 동작을 했다. 카드 안내 문구를 사용자가 눈으로 확인했다. Zoom 종료 뒤 자동 정지, 60.4초, `capture_error` 없음.
- **공백:** 정확한 값은 재지 않았다. 두 회의 모두 `capture_gap`이 남지 않아 서버 기준 2초 미만이다.

## 완료 기준 판정

| 기준 | 판정 | 근거 |
| --- | --- | --- |
| C1 기본 입력 유지 | 통과 | `mtg_124`, `mtg_125` |
| C2 고른 장치 분리 | 테스트만 | `falls back to the default input...` |
| C3 복구 실패 마감 | 테스트만 | `ends as device_ended...`, `gives up on a reopen...` |
| C4 멈춘 뒤 도착 | 테스트만 | `closes a stream that arrives...` |
| C5 알림 | 부분 | 카드 문구는 실측. 토스트는 테스트만 |
| C6 두 시작 경로 | 통과 | 모달 `mtg_124`, 카드 `mtg_125` |

## 남은 것

- `mtg_121`이 끊긴 정확한 계기는 재현하지 못했다. 시작 시 입력이 무엇이었는지 기록이 없다. AirPods가 잠깐 끊겼다 붙었다면 이번 수정 경로로 처리된다.
- 패키징한 서명 앱에서는 재지 않았다.
- 앱 창이 없으면 카드가 뜨지 않는다(`ready()`). 회의 감지 설계대로이고 이번 변경과 무관하다. 시험 중 카드가 안 뜬 원인이었다.
