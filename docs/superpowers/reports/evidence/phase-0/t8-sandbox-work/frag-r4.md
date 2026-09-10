
측정: `2026-09-10T04:08:35Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-r4.txt`

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
2026-09-10 13:08:24.285 Df amfid[76589:1445d12] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 13:08:28.257 Df amfid[76589:1445d12] /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12 not valid: Error Domain=AppleMobileFileIntegrityError Code=-423 "The file is adhoc signed or signed by an unknown certificate chain" UserInfo={NSURL=file:///Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/signed/python/bin/python3.12, NSLocalizedDescription=The file is adhoc signed or signed by an unknown certificate chain}
2026-09-10 13:08:28.357 Df launchd[1:1446d76] [pid/99755/com.apple.intents.intents-helper [99756]:] signaled service: Killed: 9
2026-09-10 13:08:28.357 Df launchd[1:1446d76] [pid/99755/com.apple.intents.intents-helper [99756]:] scheduling cleanup in 9 sec after sending Killed: 9
2026-09-10 13:08:30.701 Df launchd[1:1446d76] [pid/99952/com.apple.intents.intents-helper [127]:] signaled service: Killed: 9
2026-09-10 13:08:30.701 Df launchd[1:1446d76] [pid/99952/com.apple.intents.intents-helper [127]:] scheduling cleanup in 9 sec after sending Killed: 9
```

