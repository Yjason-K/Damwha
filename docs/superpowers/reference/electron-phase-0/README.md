# Phase 0 빌드 스크립트 — 참조 사본

태그 `archive/electron-phase-0-packaging-validation`의
`experiments/electron-phase-0/{python,ffmpeg}/` 에서 그대로 꺼낸 것이다. **고치지 않는다.**

Phase 4가 이 조작을 `desktop/scripts/build-python.sh`·`build-ffmpeg.sh`로 옮긴다. 옮긴 것이
원본과 다르면 원본이 맞다 — 하나하나가 Phase 0의 실측으로 정해졌다.

| 파일 | 무엇 |
| --- | --- |
| `python-build.sh` | python-build-standalone 재배치·Mach-O·서명. 511줄 |
| `python-selfreport.py` | 런타임 자기 보고 (P0-C8). Phase 4의 `runtime_report.py`가 이 형태를 받는다 |
| `ffmpeg-fetch.sh` | LGPL 정적 빌드. `:151-161`이 configure stdout에서 라이선스를 검사한다 |
| `ffmpeg-checksums.txt` | 소스 아카이브 체크섬 |

## 여기서 읽어야 하는 것 다섯

1. **셔뱅** (`python-build.sh:269-297`) — Phase 0는 절대 경로 재작성을 썼고 `#!/bin/sh` 트릭을
   기각했다. 그 근거(`:274-277`)와 Phase 4가 뒤집은 이유는 Phase 4 스펙 §17.3에 있다.
2. **sysconfigdata** (`:301-338`) — 파일을 regex로 긁지 말고 **런타임에게 묻는다.** 따옴표
   표기가 배포본마다 달라 홑따옴표 regex가 조용히 빈 값을 냈다.
3. **direct_url.json** (`:342-356`) — 파일 경로 설치가 남기는 절대 경로. 지운다.
4. **LC_RPATH** (`:370-399`) — "이 Task에서 가장 실질적인 발견". 번들 밖 **전부** 삭제.
   scipy의 `/opt/homebrew` gcc 경로가 실제 위험이다.
5. **LC_ID_DYLIB** (`:401-435`) — `libpython3.12.dylib`만 `@executable_path/../lib/…`이고
   나머지는 `@rpath/<base>`. 고친 파일마다 **즉시 재서명**한다.
