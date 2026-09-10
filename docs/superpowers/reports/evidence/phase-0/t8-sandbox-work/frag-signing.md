
측정: `2026-09-10T04:08:35Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-sign.txt`

적용한 명령:

```
codesign --force --sign - --options runtime --timestamp=none <Mach-O>
```

| 항목 | 값 |
| --- | --- |
| 사본 `signed/`의 Mach-O 정규 파일 | 526개 |
| 서명 성공 | 526개 |
| **서명 실패** | **0개** |
| 서명 후 `codesign --verify`(전 슬라이스) 실패 | 0개 |
| 서명 후 `runtime` 플래그가 없는 파일 | 0개 |
| 셔뱅을 사본으로 돌린 콘솔 스크립트 | 65개 |

**서명 실패 파일 목록**

**0건.** 번들의 Mach-O 526개 전부가 ad-hoc 서명과 hardened runtime
옵션을 받아들였다 — 서명 자체를 거부하는 파일은 없었다. 서명 뒤에는 x86_64
슬라이스까지 포함해 전 슬라이스가 서명됐고(`--verify` 실패 0건),
`runtime` 플래그가 전량에 붙었다.

