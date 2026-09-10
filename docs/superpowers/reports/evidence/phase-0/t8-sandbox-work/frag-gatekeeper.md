
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

