
측정: `2026-09-10T04:08:35Z` · 증거 `docs/superpowers/reports/evidence/phase-0/t8-inventory.txt`

| 분류 | 개수 |
| --- | --- |
| Mach-O 정규 파일 전체 | 526개 |
| **arm64 슬라이스에 서명이 없는 것** | **0개** |
| arm64는 서명 / 다른 슬라이스가 서명 없음 | 10개 |
| 전 슬라이스 서명 | 516개 |
| arm64 슬라이스가 아예 없는 것 | 0개 |

`codesign --display` 분류 (원본, 서명 전):

```
282 signed sig=adhoc flags=0x20002(adhoc,linker-signed) team=not set
234 signed sig=adhoc flags=0x2(adhoc) team=not set
10 arm64-signed-otherarch-unsigned sig=adhoc flags=0x20002(adhoc,linker-signed) team=not set
```

**Task 3 리뷰의 관찰을 이 측정이 정정한다.** Task 3 리뷰는 `codesign -v`가
`code object is not signed at all`을 낸 파일을 "서명이 아예 없는 것"으로
기록했다. `--arch`를 나눠 다시 재 보니 그 파일들은 **arm64 슬라이스가
ad-hoc(linker-signed) 서명돼 있고 x86_64 슬라이스만 서명이 없는** universal
바이너리였다. `codesign --verify`를 `--arch` 없이 부르면 슬라이스 하나만
서명이 없어도 파일 전체를 그렇게 보고한다. 지금 로드되는 이유가 그것이다 —
arm64 호스트는 arm64 슬라이스만 매핑한다.

다른 슬라이스에 서명이 없는 10개 전량 (전수 목록은 `signing/unsigned-inventory.txt`):

- `python/lib/python3.12/site-packages/_sounddevice_data/portaudio-binaries/libportaudio.dylib`
- `python/lib/python3.12/site-packages/charset_normalizer/cd.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/charset_normalizer/md.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/cu2qu/cu2qu.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/feaLib/lexer.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/misc/bezierTools.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/pens/momentsPen.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/qu2cu/qu2cu.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/fontTools/varLib/iup.cpython-312-darwin.so`
- `python/lib/python3.12/site-packages/grpc/_cython/cygrpc.cpython-312-darwin.so`

arm64 슬라이스에 서명이 없는 Mach-O는 **0개**다. 즉 이 번들에는 우리가
실제로 매핑하는 코드 중 서명이 없는 것이 없다.

