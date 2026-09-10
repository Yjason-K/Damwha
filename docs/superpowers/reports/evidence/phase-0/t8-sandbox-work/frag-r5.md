
측정: `2026-09-10T04:08:35Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-r5.txt`

메인 실행 파일 `signed/python/bin/python3.12`는 ad-hoc 서명 + `--options runtime`
이다. 그 프로세스가 여는 `.so`의 서명 상태와 entitlement만 바꿔 세 번 잰다.
대상은 원본에서 슬라이스 하나라도 서명이 없던 10개이고, B·C는 사본에서
그 파일들만 `codesign --remove-signature`로 되돌려 만들었다(10개).
관찰 뒤 전부 도로 서명했다.

| # | `.so` 서명 | entitlement | 결과 |
| --- | --- | --- | --- |
| A | ad-hoc 서명함 | `uem+dlv` | 열린다 |
| B | **서명 없음** | `uem+dlv` | **막힌다** |
| C | 서명 없음 | `uem` (library validation 켠 상태) | **막힌다** — 4단계 `escalate`에서 이 회차가 이미 깨졌다 |

```
A  so=ad-hoc 서명  ent=uem+dlv  OK
B  so=서명 없음  ent=uem+dlv  FAIL
C  so=서명 없음  ent=uem  REF
```

