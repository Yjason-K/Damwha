# 시스템 오디오 녹음 리뷰 후속 수정 결과

**작성일:** 2026-10-27 (작업은 2026-10-26)
**Spec:** [`specs/2026-10-26-system-audio-capture-design.md`](../specs/2026-10-26-system-audio-capture-design.md) — 이 수정은 새 spec 없이
그 spec의 C5와 §2.1 계약("담화가 내는 소리는 tap에서 뺀다")을 실제로 지키게 한다.
**Plan:** [`plans/2026-10-26-system-audio-capture.md`](../plans/2026-10-26-system-audio-capture.md) — 별도 plan 없음. 리뷰 지적 두 건을 바로 고쳤다.
**선행 결과:** [`reports/2026-10-26-system-audio-capture-results.md`](2026-10-26-system-audio-capture-results.md)
**브랜치:** `feat/system-audio-capture`. **이 문서를 쓰는 시점에 커밋은 없다** — 선행 작업과 함께 작업 트리에만 있다.

## 배경

선행 결과 문서와 코드를 리뷰해 고칠 것 두 건을 찾았다.

1. **담화 자신의 소리가 tap에서 빠지지 않는다.** 헬퍼는 `getppid()`(Electron main)만 뺐다. Chromium은 소리를 main이 아니라
   오디오 서비스 utility 프로세스(`--utility-sub-type=audio.mojom.AudioService`)에서 낸다 — 이 맥에서 돌던 Electron·Chrome 앱
   넷 모두 그 구조임을 `ps`로 확인했다. 회의 화면에서 샘플을 재생하면 녹음에 다시 섞인다.
2. **C5 "수명은 요청에 묶인다"는 실측되지 않은 전제였다.** 새로고침·창 파괴에서 Electron `protocol.handle`이 응답 본문을
   cancel하지 않으면 헬퍼가 남아 슬롯을 쥐고, 앱을 다시 켤 때까지 모든 녹음이 409를 받는다.

## 변경

| 파일 | 내용 |
| --- | --- |
| `desktop/native/system-audio/main.swift` | 제외 대상을 "부모"에서 "부모와 그 자식 전부"로. `kAudioHardwarePropertyProcessObjectList`를 돌며 `kAudioProcessPropertyPID`와 `sysctl(KERN_PROC_PID)`의 `e_ppid`로 고른다. 쓰지 않게 된 `processObject(pid:)`는 지웠다 |
| `desktop/src/windows/system-audio-protocol.ts` | `stopOnRendererReset(contents, stop)` 추가 — 메인 프레임의 다른 문서 이동(`did-start-navigation`, `isSameDocument` 아님)·`render-process-gone`·`destroyed`에서 끈다. `stopAll()`이 세대를 올려, 시작 중에 도착한 헬퍼는 끄고 503(`stopped`) |
| `desktop/src/main.ts` | `createWindow`에서 `stopOnRendererReset(created.webContents, () => systemAudio.stopAll())` 배선 |
| `desktop/tests/windows/system-audio-protocol.test.ts` | 테스트 4 — 시작 중 stopAll, 문서 이동, 같은 문서 라우팅·서브프레임은 유지, 렌더러 사망·파괴 |
| `desktop/CLAUDE.md` | 시스템 오디오 단락 갱신 — 렌더러 리셋 배선, 제외 대상, 제외 목록이 tap 생성 때 한 번 정해진다는 것과 그에 기대는 순서 |

## 결정과 그 근거

### 제외 목록은 tap을 만들 때 한 번 정한다

처음에는 프로세스 목록 리스너에서 제외 목록을 다시 세워 `kAudioTapPropertyDescription`을 쓰려 했다. 실측(macOS 27.2)에서
돌고 있는 tap에 설명을 쓰면 **`560492391`(`'!hog'`, kAudioDevicePermissionsError)로 거부됐다.** 같은 설명 객체 수정, 같은 uuid의
새 객체, public tap, aggregate를 멈춘 뒤 쓰기 — 넷 다 같은 오류. 리스너는 동작하지 않는 코드라 넣지 않았다.

대신 순서에 기댄다. 녹음기는 `prepare()`에서 마이크(`getUserMedia`)·AudioContext·Worklet을 연 **뒤에** 시스템 오디오를 연다.
그 시점에 담화의 오디오 서비스는 이미 CoreAudio 프로세스다. 이 맥의 Chromium 계열 앱 넷의 오디오 서비스는 유휴 상태에서도
전부 CoreAudio 프로세스 목록에 있었고, 부모는 각자의 main이었다. 이 순서는 `desktop/CLAUDE.md`에 "바꾸지 않는다"로 적었다.

### 렌더러 리셋은 "모두 끄기"

창이 하나이고 헬퍼도 하나다. 요청과 webContents를 짝짓지 않고 `stopAll()`로 충분하다. 첫 로드에서도 `did-start-navigation`이
오지만 그때는 끌 것이 없다. `showShell`의 file:// 전환도 문서 이동이라 끈다 — 그 문서의 녹음기는 이미 없다.

## 검증

| 대상 | 명령 | 결과 |
| --- | --- | --- |
| 테스트 선행 실패 | 테스트 4를 먼저 쓰고 `pnpm exec vitest run tests/windows/system-audio-protocol.test.ts` | 4 failed / 8 passed (구현 전) |
| 스킴 테스트 | 같은 명령 (구현 후) | 12/12 |
| desktop 전체 | `cd desktop && pnpm test` | 1294/1294 (선행 1290 + 4) |
| desktop lint | `pnpm run lint` | 통과 — `WebContents`가 `RendererEvents`에 그대로 들어간다 |
| 헬퍼 빌드 | `bash scripts/build-system-audio.sh` | 경고·오류 없음 |
| 헬퍼 실측: 제외 | Python 부모가 `say`를 먼저 띄우고(자식) 0.8초 뒤 헬퍼를 띄움, 0.7초 뒤 관계없는 `afplay Submarine`(재부모화) | 250 ms 구간 peak `[4742, 8381, 1624, 156, 40, …]` — Submarine(약 8380)만, `say`(약 2만)는 없음 |
| 헬퍼 실측: 대조 | 같은 순서, `say`를 `sh -c '… &'`로 띄워 부모가 다르게 | peak 1.7만~2.4만이 3초 내내 — 녹음됨 |
| 헬퍼 실측: 늦게 생긴 형제 | 헬퍼 READY 뒤에 형제 `afplay` 세 번 | 세 번 모두 녹음됨 — 아래 "알려진 한계" |
| 헬퍼 종료 | 위 실측마다 stdin 닫기 | exit 0, 0.02~0.03초, 남은 프로세스 없음 |
| Chromium 오디오 서비스 | CoreAudio 프로세스 목록의 pid와 `pgrep -f audio.mojom.AudioService` 대조 | 4개 앱 모두 목록에 있고 부모는 각 앱의 main |

**실측 중 겪은 것:** 처음 실측 스크립트는 `sleep 5 | helper &`로 띄워 헬퍼가 bash가 포크한 서브셸의 자식이 됐다 — 형제 판정이
어긋나 "제외 실패"로 잘못 보였다. 부모를 Python `subprocess`로 바꿔 다시 쟀다. 그 사이 FIFO를 stdin으로 준 회차에서는 쓰는 쪽이
모두 닫혀도 헬퍼가 끝나지 않았다(`readabilityHandler`가 EOF를 알리지 않음, SIGTERM으로는 정리됨). Node `spawn`의 stdio는 pipe이고
pipe에서는 0.03초에 끝나므로 제품 경로에는 영향이 없다고 판단했다.

## 성공 기준 판정

선행 spec의 기준 중 이번에 영향받는 것만.

| 기준 | 판정 | 근거 |
| --- | --- | --- |
| §2.1 담화 소리 제외 | 충족(헬퍼 단독) | 위 제외·대조 실측. **실제 담화 앱에서 회의 샘플 재생으로는 확인하지 않았다** |
| C5 헬퍼 수명 | 충족(단위) | 렌더러 리셋 테스트 3, 시작 중 stopAll 테스트 1. **dev 앱에서 녹음 중 ⌘R 실측은 하지 않았다** |
| C8 계약 불변 | 충족 | fe·be·worker·packages 변경 없음 |

## 알려진 한계 (선행 spec §4에 더한다)

- 헬퍼가 뜬 **뒤에** 처음 CoreAudio 프로세스가 된 담화 자식은 빠지지 않는다. 녹음 도중 오디오 서비스가 죽었다가 다시 뜨면
  그 뒤의 담화 재생음은 섞인다.
- 담화의 자식 전부를 빼므로 postgres·worker·embed 같은 자식이 소리를 내도 빠진다. 지금은 소리를 내는 자식이 없다.

## 남은 작업

- dev 앱 실측: 녹음 중 ⌘R → `pgrep damwha-system-audio`가 비는지, 회의 화면에서 샘플을 재생해도 녹음에 섞이지 않는지.
- 선행 결과 문서의 남은 작업(C7 패키징·`check-bundle`, C1 실제 녹음 한 건)은 그대로다.
