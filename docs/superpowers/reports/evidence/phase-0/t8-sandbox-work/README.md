# Task 8 작업 산출물 — `sandbox/t8/` 사본

`signing/probe.sh`가 `$SANDBOX/t8/`에 남긴 중간 산출물이다. 옆의 `t8-*.txt`가
격리 러너를 거친 **회차별 증거**라면, 여기 있는 것은 `probe.sh`가 그 회차들을
집계하며 만든 **작업 파일**이다. 둘은 내용이 다르다.

원래는 커밋 대상이 아니었다. 2026-09-10에 워크트리의 재생성 가능한 자산
(`bundle/` 1.6 GB, `signed/` 1.5 GB, HF 모델 11 GB 등 약 15 GB)을 지우면서
이 디렉터리만 증거로 옮겨 커밋했다 — **번들이 사라진 지금은 다시 만들 수 없기
때문이다.** 옮기지 않은 것은 `.DS_Store`와 `gk-backup/python3.12`(서명 실험용
바이너리 백업 49 KB)뿐이다.

## 꼭 필요한 것

| 파일 | 왜 |
| --- | --- |
| `gk-syslog.txt` · `frag-gatekeeper.md` | `signing/RESULTS.md` §6 Gatekeeper 블록의 **출처**다. 그 절은 복구본이고 이 둘이 유일한 근거다. 다시 만들려면 격리 속성을 또 붙여야 하는데 그러지 않기로 결정했다 |
| `ent/*.plist` | 회차마다 실제로 서명에 넣은 entitlement 원본 6종. Phase 4가 최소 집합 `{uem, dlv}`를 다시 구성할 때 문서의 결론이 아니라 이 파일이 정확한 형태를 준다 |
| `macho-bundle.txt` · `macho-signed.txt` · `inventory-full.txt` | 삭제된 `bundle/`·`signed/`의 Mach-O 526개 전수 목록. 번들이 없어진 지금 이 트리의 실제 구성을 되짚는 유일한 기록이다 |
| `r4-syslog.txt` | R-4(hardened runtime에서 죽는 것) 회차의 시스템 로그. 옆 `t8-r4*.txt`에는 없는 원본이다 |

`frag-*.md`는 `probe.sh`가 `RESULTS.md`의 `<!-- BEGIN:… -->` 블록에 끼워 넣는
조각이다. 커밋된 `RESULTS.md`와 겹치지만, 스플라이스 전 원본이라 남겼다.

## 되살리는 법

이 디렉터리를 `probe.sh`가 다시 읽게 하려면 원래 자리로 되돌린다.

```sh
mkdir -p experiments/electron-phase-0/sandbox/t8
cp -a docs/superpowers/reports/evidence/phase-0/t8-sandbox-work/. \
      experiments/electron-phase-0/sandbox/t8/
rm experiments/electron-phase-0/sandbox/t8/README.md
```

번들부터 다시 만들어야 한다면 `experiments/electron-phase-0/README.md`의
"정리된 상태에서 되살리기"를 먼저 본다.
