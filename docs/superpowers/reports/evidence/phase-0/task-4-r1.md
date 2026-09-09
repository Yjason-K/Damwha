# 검증 증거 — Task 4 (ffmpeg / ffprobe 번들)

- 커밋: 8f8645270cd96a89dce116f25c909449adb356a7 (`git -C <worktree> rev-parse HEAD`로 시작 전 확인, COMMIT 인자와 일치)
- 환경:
  - node: v22.21.1
  - pnpm: 10.26.0
  - python3 (시스템, `/usr/bin/python3`): Python 3.10.21
  - Docker: `docker info`·`docker volume ls` 모두 무응답 (아래 "개발 자산" 절 참조). OrbStack 앱(PID 1300)·Helper(PID 1397)는 살아 있음.
  - OS: Darwin 27.0.0 (macOS, arm64)
- 실행 일시: 2026-09-09T13:46Z ~ 2026-09-09T13:50Z 경 (UTC)

## 사전 확인

```
$ git -C /Users/gim-yeongjae/project/daewha-electron-phase-0 rev-parse HEAD
8f8645270cd96a89dce116f25c909449adb356a7
```

COMMIT 인자(`8f86452`)와 일치. 계획대로 실행 진행.

---

## V1. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/ffmpeg`
- cwd: `<repo root>` (`/Users/gim-yeongjae/project/daewha-electron-phase-0`)
- 기대: exit 0
- 실제:
```
check-macho.sh (G1, 스펙 §4.1)
  대상          : .../experiments/electron-phase-0/bundle/ffmpeg
  파일 수       : 2
  Mach-O 수     : 2
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 0개 파일
  허용 목록(ALLOW): 0건 / 규칙 24줄 (lib/g1-allowlist.txt)
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
```
- 일치: 예
- 종료 코드: 0

---

## V2. `bash experiments/electron-phase-0/verify/t4-probe.sh`
- cwd: `<repo root>`
- 기대: exit 0. 번들 `ffprobe`가 `format.duration`을 담은 JSON을 반환
- 실제:
```
== 격리 실행 (스펙 §4.2) — 번들 ffprobe가 env -i에 직접 exec된다
   명령: ffprobe -v error -show_entries format=duration -of json <sample.flac>
== JSON 판정 (system python3 — 검사 도구, 스펙 §4.0 예외)
  얻은 duration : 1883.254422
  기대 duration : 1883.254422
  OK   원본 duration과 일치 (오차 0us < 1ms)
== dyld 실측이 진짜인가 (계획 규칙 6b)
  OK   dyld 줄 688건 중 1건이 .../bundle/ffmpeg/ 아래 이미지다
번들 ffprobe가 pipeline/ffmpeg.py와 같은 명령으로 정확한 duration을 반환했다
```
- **duration 실측값 (사용자 요청 사항 3):** 얻은 값 `1883.254422`, 기대값(`probe/audio-source.txt`에 Task 1이 기록한 원본 duration) `1883.254422`. 두 값이 **문자열 그대로 완전 일치**한다 — 구현자가 보고한 "완전 일치"와 실측이 같다. 오차 계산 결과도 `0us`.
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 격리 실행 (스펙 §4.2) — 번들 ffprobe가 env -i에 직접 exec된다
   명령: ffprobe -v error -show_entries format=duration -of json <sample.flac>
run-isolated: label=t4-probe  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.hOAyI0/stderr.raw)

== JSON 판정 (system python3 — 검사 도구, 스펙 §4.0 예외)
  얻은 duration : 1883.254422
  기대 duration : 1883.254422
  OK   원본 duration과 일치 (오차 0us < 1ms)

== dyld 실측이 진짜인가 (계획 규칙 6b)
  OK   dyld 줄 688건 중 1건이 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/ffmpeg/ 아래 이미지다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t4-probe.txt
번들 ffprobe가 pipeline/ffmpeg.py와 같은 명령으로 정확한 duration을 반환했다
```
</details>

---

## V3. `bash experiments/electron-phase-0/verify/t4-normalize.sh`
- cwd: `<repo root>`
- 기대: exit 0. normalize 산출물이 생성되고 `sample_rate=16000`, `channels=1`
- 실제: 산출물 생성(`t4-normalized.flac`, 43322865 bytes). 산출물을 별도 격리 실행 ffprobe로 재확인한 결과:
  - **`sample_rate = 16000`** (기대 16000과 일치)
  - **`channels = 1`** (기대 1과 일치)
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 격리 실행 1/2 (스펙 §4.2) — 번들 ffmpeg가 env -i에 직접 exec된다
   명령: ffmpeg -y -i <sample.flac> -ac 1 -ar 16000 -sample_fmt s16 -c:a flac -compression_level 5 -f flac <출력>
run-isolated: label=t4-normalize  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.rjHVkx/stderr.raw)
ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers
  built with Apple clang version 21.0.0 (clang-2100.3.33.1)
  configuration: --prefix=/opt/damwha-phase0/ffmpeg --disable-gpl --disable-nonfree --disable-version3 --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages --disable-avdevice --disable-network --disable-ffplay --enable-static --disable-shared --disable-debug
  libavutil      61.  1.101 / 61.  1.101
  libavcodec     63.  1.101 / 63.  1.101
  libavformat    63.  1.101 / 63.  1.101
  libavfilter    12.  1.101 / 12.  1.101
  libswscale     10.  1.101 / 10.  1.101
  libswresample   7.  1.101 /  7.  1.101
Input #0, flac, from '.../sandbox/audio/sample.flac':
  Metadata:
    major_brand     : mp42
    minor_version   : 0
    compatible_brands: isommp42
    encoder         : Lavf63.1.101
  Duration: 00:31:23.25, start: 0.000000, bitrate: 653 kb/s
  Stream #0:0: Audio: flac, 44100 Hz, stereo, s32 (24 bit)
Stream mapping:
  Stream #0:0 -> #0:0 (flac (native) -> flac (native))
Press [q] to stop, [?] for help
Output #0, flac, to '.../sandbox/run/t4-normalized.flac':
  Metadata:
    major_brand     : mp42
    minor_version   : 0
    compatible_brands: isommp42
    encoder         : Lavf63.1.101
  Stream #0:0: Audio: flac, 16000 Hz, mono, s16, 128 kb/s
    Metadata:
      encoder         : Lavc63.1.101 flac
size=   13824KiB time=00:10:13.12 bitrate= 184.7kbits/s speed=1.22e+03x elapsed=0:00:00.50    size=   27648KiB time=00:20:17.53 bitrate= 186.0kbits/s speed=1.21e+03x elapsed=0:00:01.00    size=   41472KiB time=00:30:52.12 bitrate= 183.4kbits/s speed=1.23e+03x elapsed=0:00:01.50    [out#0/flac @ 0x7540c48180] video:0KiB audio:42299KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: 0.019289%
size=   42307KiB time=00:31:23.25 bitrate= 184.0kbits/s speed=1.23e+03x elapsed=0:00:01.53    
  OK   산출물 생성: .../sandbox/run/t4-normalized.flac (43322865 bytes)

== 격리 실행 2/2 — 산출물을 ffprobe로 다시 읽어 sample_rate/channels 확인
run-isolated: label=t4-normalize-check  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.GAwV4l/stderr.raw)

== JSON 판정 (system python3 — 검사 도구, 스펙 §4.0 예외)
  OK   sample_rate = 16000
  OK   channels = 1

== dyld 실측이 진짜인가 (계획 규칙 6b) — normalize를 수행한 ffmpeg 프로세스
  OK   dyld 줄 688건 중 1건이 .../bundle/ffmpeg/ 아래 이미지다

증거: .../t4-normalize.txt
번들 ffmpeg가 pipeline/ffmpeg.py와 같은 명령으로 16 kHz mono 산출물을 만들었다
```
</details>

---

## V4. `bash experiments/electron-phase-0/verify/t4-no-homebrew.sh`
- cwd: `<repo root>`
- 기대: exit 0. `t4-probe`·`t4-normalize`의 dyld 증거에 `/opt/homebrew`가 0건
- 실제: 세 dyld 증거 파일(`t4-probe-dyld.txt`, `t4-normalize-dyld.txt`, `t4-normalize-check-dyld.txt`) 모두 `/opt/homebrew` 0건
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== t4-probe (ffprobe)
  증거 파일: .../t4-probe-dyld.txt
  OK   dyld 줄 688건 중 /opt/homebrew 0건 — Homebrew ffmpeg 9.0.1이 실행되지 않았다
  OK   dyld 줄 688건 중 1건이 .../bundle/ffmpeg/ 아래 이미지다

== t4-normalize (ffmpeg)
  증거 파일: .../t4-normalize-dyld.txt
  OK   dyld 줄 688건 중 /opt/homebrew 0건 — Homebrew ffmpeg 9.0.1이 실행되지 않았다
  OK   dyld 줄 688건 중 1건이 .../bundle/ffmpeg/ 아래 이미지다

== t4-normalize-check (산출물 재확인 ffprobe)
  증거 파일: .../t4-normalize-check-dyld.txt
  OK   dyld 줄 688건 중 /opt/homebrew 0건 — Homebrew ffmpeg 9.0.1이 실행되지 않았다
  OK   dyld 줄 688건 중 1건이 .../bundle/ffmpeg/ 아래 이미지다

판정: 번들 ffmpeg/ffprobe만 실행됐다 — Homebrew 9.0.1 흔적 없음
```
</details>

---

## V5. `bash experiments/electron-phase-0/verify/t4-license-recorded.sh`
- cwd: `<repo root>`
- 기대: exit 0. `ffmpeg/README.md`에 빌드의 라이선스 구성(GPL / LGPL / nonfree 플래그)이 기록됨
- 실제: LGPL 언급, `--disable-gpl`, `--disable-nonfree` 기록 확인, 충분성 판단 문장 확인, 활성 인코더/디코더 언급 확인 — 5개 항목 전부 OK
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== t4-license-recorded — ffmpeg/README.md 점검 (스펙 R-8)
  대상: .../ffmpeg/README.md
  OK   LGPL 언급 — configure가 보고한 License 줄
  OK   GPL 비활성 플래그 기록
  OK   nonfree 비활성 플래그 기록
  OK   LGPL 구성이 담화의 용도(정규화·probe)에 충분한지 판단 문장이 있다
  OK   활성 인코더/디코더에 대한 언급이 있다

판정: README에 라이선스 구성과 판단이 기록돼 있다
```
</details>

---

## 이번 Task의 핵심 — Homebrew ffmpeg와 구분이 되는가 (사용자 요청 사항 1·2)

### 1. dyld 증거 세부 집계

`^dyld`로 시작하는 줄에 한정해 세었다 (`grep -c '^dyld'`, `; true`로 exit code 문제 회피).

| 증거 파일 | `^dyld` 줄 수 | `/opt/homebrew` 포함 줄 수 | 실행된 메인 이미지 (첫 `dyld[<pid>]` 줄의 경로) |
| --- | --- | --- | --- |
| `t4-probe-dyld.txt` | 688 | 0 | `.../experiments/electron-phase-0/bundle/ffmpeg/bin/ffprobe` |
| `t4-normalize-dyld.txt` | 688 | 0 | `.../experiments/electron-phase-0/bundle/ffmpeg/bin/ffmpeg` |
| `t4-normalize-check-dyld.txt` | 688 | 0 | `.../experiments/electron-phase-0/bundle/ffmpeg/bin/ffprobe` |

세 파일 모두 헤더의 `# argv:` 줄이 아니라 `^dyld[<pid>]:` 줄 자체를 대상으로 세었고, pid를 고정한 뒤 그 pid의 로드 목록에 `bundle/ffmpeg/` 경로가 있는지를 `t4_assert_dyld_measured`(계획 규칙 6b 방식, pid 우선 고정 → 로드 목록 확인)로 다시 확인해 세 파일 모두 `OK`였다.

### 2. Homebrew ffprobe vs 번들 ffprobe — `-version` 첫 줄 대조

```
Homebrew (/opt/homebrew/bin/ffprobe -version 첫 줄):
ffprobe version 9.0.1 Copyright (c) 2007-2026 the FFmpeg developers

Bundle (experiments/electron-phase-0/bundle/ffmpeg/bin/ffprobe -version 첫 줄):
ffprobe version 9.0.1 Copyright (c) 2007-2026 the FFmpeg developers
```

**두 줄은 문자 그대로 완전히 같다.** (`readlink -f /opt/homebrew/bin/ffprobe` → `/opt/homebrew/Cellar/ffmpeg/9.0.1/bin/ffprobe`, 즉 Homebrew도 정확히 9.0.1이다.) `-version` 문자열만으로는 어느 바이너리가 실행됐는지 구분할 수 없다는 계획의 전제가 실측으로 확인된다. 구분 근거는 위 1절의 dyld 로그 경로뿐이다.

---

## 그 밖의 실측 사항

### 5. 이동 전/후 G1 대비 (`t4-build-relocation.txt`)

```
## 6. 이동 전 G1 (stage/ffmpeg) — exit 0
  파일 수       : 2
  Mach-O 수     : 2
  위반          : 0건

## 8. 이동 후 G1 (bundle/ffmpeg) — exit 0
  파일 수       : 2
  Mach-O 수     : 2
  위반          : 0건
```

이동 전(`stage/ffmpeg`) 위반 **0건**, 이동 후(`bundle/ffmpeg`) 위반 **0건**. 구현자가 보고한 "둘 다 0건"과 실측이 일치한다.

### 6. `otool -L` / `LC_RPATH` 실측

```
$ otool -L experiments/electron-phase-0/bundle/ffmpeg/bin/ffmpeg
.../bundle/ffmpeg/bin/ffmpeg:
	/System/Library/Frameworks/OpenGL.framework/Versions/A/OpenGL (...)
	/usr/lib/libSystem.B.dylib (...)
	/usr/lib/libz.1.dylib (...)
	/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox (...)
	/System/Library/Frameworks/CoreImage.framework/Versions/A/CoreImage (...)
	/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (...)
	/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (...)
	/System/Library/Frameworks/CoreMedia.framework/Versions/A/CoreMedia (...)
	/System/Library/Frameworks/CoreVideo.framework/Versions/A/CoreVideo (...)
	/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices (...)
	/usr/lib/libbz2.1.0.dylib (...)
	/usr/lib/libiconv.2.dylib (...)
	/System/Library/Frameworks/AudioToolbox.framework/Versions/A/AudioToolbox (...)
	/System/Library/Frameworks/CoreGraphics.framework/Versions/A/CoreGraphics (...)
	/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation (...)
	/usr/lib/libobjc.A.dylib (...)

$ otool -L experiments/electron-phase-0/bundle/ffmpeg/bin/ffprobe
(bin/ffmpeg와 동일한 16개 의존 목록)

$ otool -l experiments/electron-phase-0/bundle/ffmpeg/bin/ffmpeg | grep -A2 LC_RPATH ; true
(출력 없음)

$ otool -l experiments/electron-phase-0/bundle/ffmpeg/bin/ffprobe | grep -A2 LC_RPATH ; true
(출력 없음)
```

두 바이너리 모두 `otool -L` 의존 목록에 `/System/Library/Frameworks/*`, `/usr/lib/*`만 있고 `/opt/homebrew`나 상대·빌드 경로가 없다. `otool -l | grep -A2 LC_RPATH`는 두 바이너리 모두 **출력이 없다** — 구현자가 보고한 "정적 링크라 LC_RPATH 커맨드 자체가 없다"와 실측이 일치한다.

### 7. `bundle/ffmpeg` 크기와 구성

```
$ du -sh experiments/electron-phase-0/bundle/ffmpeg
 42M	experiments/electron-phase-0/bundle/ffmpeg

$ ls -la experiments/electron-phase-0/bundle/ffmpeg/bin/
drwxr-xr-x  .  128 B
drwxr-xr-x  .. 96 B
-rwxr-xr-x  ffmpeg   21 MB
-rwxr-xr-x  ffprobe  21 MB
```

### 8. 개발 자산 — `snapshot-dev-assets.sh after` (사용자 요청 사항 8)

**docker는 이번 실행에서도 응답하지 않았다.** 시작 전 `docker context ls`는 즉시 응답했지만(정상), 실제 볼륨 조회(`docker volume ls`)는 두 가지 방식 모두 무응답이었다:

```
$ timeout 15 docker volume ls
(15초간 아무 출력 없음, exit 124 — timeout이 강제 종료)
```

이후 `snapshot-dev-assets.sh after`를 `timeout 30`으로 감싸 실행:

```
$ timeout 30 bash experiments/electron-phase-0/lib/snapshot-dev-assets.sh after
(30초간 아무 출력 없음, exit 124 — timeout이 강제 종료. 출력 파일은 비어 있음 —
 스크립트가 "## docker volumes" 헤더를 echo하기 전에 이미 docker volume ls 호출에서
 멎어 있었고, timeout이 프로세스 그룹째 죽여 stdout 버퍼가 전혀 flush되지 않았다)
```

지시대로 매달린 docker 클라이언트 PID만 종료하려 했으나, `timeout` 명령이 이미 시간 초과 시 자식(및 그 하위 `docker` CLI 프로세스)에 종료 시그널을 보내 정리했다 — 실행 직후 `ps aux | egrep -i "docker|orbstack"`로 확인한 결과 남아 있는 `docker` CLI 프로세스는 없었다(별도 `pkill`/`kill`을 이 세션에서 실행하지 않았다):

```
프로세스 정리 — 개발 자산 확인 중 docker CLI 무응답
- 기동 전: (docker/orbstack 관련 프로세스 없음 — `docker context ls`만 정상 응답)
- `timeout 15 docker volume ls` 실행 후: exit 124, 잔존 docker 프로세스 없음
- `timeout 30 bash .../snapshot-dev-assets.sh after` 실행 후: exit 124, 잔존 docker 프로세스 없음
- 종료 후 (`ps aux | egrep -i "docker|orbstack"`):
  gim-yeongjae  1397  OrbStack Helper.app/.../OrbStack Helper vmgr ...   (계속 실행 중 — 건드리지 않음)
  gim-yeongjae  1300  /Applications/OrbStack.app/Contents/MacOS/OrbStack (계속 실행 중 — 건드리지 않음)
```

**`be/storage` 부분만 별도로 확인**(지시대로) — `snapshot-dev-assets.sh`가 계산하는 것과 같은 방식(파일 수·바이트 합·최신 mtime·경로/크기/mtime SHA-256 매니페스트)을 읽기 전용으로 직접 계산:

```
root: /Users/gim-yeongjae/project/daewha/be/storage
files: 29
bytes: 2227477523
newest_mtime: 1788857034
manifest_sha256: a18870e6592f160f3545fa349ec3fa972a1993f3b3203fdf21303012cf6391be
```

Task 3의 before 스냅샷(`t3-dev-assets.txt`)과 구현자가 이미 남긴 Task 4 자체 before/after(`t4-dev-assets.txt`)의 `be/storage` 값(`files: 29`, `bytes: 2227477523`, `newest_mtime: 1788857034`, `manifest_sha256: a18870e6592f160f...6391be`)과 **전부 일치**한다. `docker volume ls` 자체는 이번 검증 세션에서도 15~30초 타임아웃 내에 한 번도 응답하지 않아, Task 3 before 목록(볼륨 15개)과의 대조는 **이번 회차에서도 완성하지 못했다** — 구현자의 `t4-dev-assets.txt` 기록과 같은 증상이다.

- 일치: `be/storage` 부분 — 예 (Task 3·Task 4 이전 기록과 완전 일치). `docker volume ls` 대조 — 실행 불가 (무응답)
- 종료 코드: `timeout 30 bash .../snapshot-dev-assets.sh after` → 124 (timeout에 의한 강제 종료. 스크립트 자체의 exit code 아님)

---

## 부속 항목

### `docs/superpowers/reports/evidence/phase-0/` 파일 목록과 확장자별 개수

검증 실행(V2·V3) 자체가 `t4-lib.sh`의 `t4_evidence_path` 회전 로직을 통해 `t4-probe*.txt`·`t4-normalize*.txt`·`t4-normalize-check*.txt`를 다시 썼다 — 스크립트를 지시대로 그대로 실행한 결과이며, 이 verifier가 별도로 편집한 것은 없다. 기존 파일은 `.prev-<timestamp>.txt`로 자동 회전되어 보존됐다(스펙 §6 규칙대로).

확장자별 개수(검증 실행 후):
```
   6 md
  83 txt
```

파일 목록 전체는 `ls -la`로 확인했으며 상세 크기·타임스탬프는 위 실행 로그에 포함(디렉터리 안 신규 `.prev-20260909T1347*.txt` 9개 포함, `.log` 파일 0개).

### `git status --porcelain` 전체 출력 (검증 실행 후)

```
 M docs/superpowers/reports/evidence/phase-0/t4-normalize-check-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t4-normalize-check-env.txt
 M docs/superpowers/reports/evidence/phase-0/t4-normalize-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t4-normalize-env.txt
 M docs/superpowers/reports/evidence/phase-0/t4-normalize-stderr.txt
 M docs/superpowers/reports/evidence/phase-0/t4-normalize.txt
 M docs/superpowers/reports/evidence/phase-0/t4-probe-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t4-probe-env.txt
 M docs/superpowers/reports/evidence/phase-0/t4-probe.txt
?? docs/superpowers/reports/evidence/phase-0/t4-normalize-check-dyld.prev-20260909T134722Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-normalize-check-env.prev-20260909T134722Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-normalize-dyld.prev-20260909T134722Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-normalize-env.prev-20260909T134722Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-normalize-stderr.prev-20260909T134722Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-normalize.prev-20260909T134720Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-probe-dyld.prev-20260909T134717Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-probe-env.prev-20260909T134717Z.txt
?? docs/superpowers/reports/evidence/phase-0/t4-probe.prev-20260909T134717Z.txt
```

이 변경은 이 verifier가 V2·V3 검증 스크립트를 계획에 적힌 그대로(수정 없이) 실행한 데서 나온 **스크립트 자체의 회전 동작**이다. `docs/superpowers/reports/evidence/phase-0/task-4-r1.md`(본 파일) 외에는 이 verifier가 직접 쓴 파일이 없다 — 소스·설정·계획 문서는 건드리지 않았다. 이 diff를 원상복구할지 여부는 reviewer 판단이다.

---

## 프로세스 정리

Task 4는 지속 서비스(DB·embed·LLM)를 띄우지 않는다 — V2·V3가 `run-isolated.sh`를 통해 실행하는 `ffmpeg`/`ffprobe`는 각 호출마다 즉시 종료되는 단발성 프로세스이며, 별도의 kill이 필요 없었다(각 실행이 스스로 exit).

유일하게 매달린 프로세스는 위 "개발 자산" 절의 `docker`/`docker volume ls` CLI 클라이언트였다:
- 기동 전: docker/orbstack 관련 프로세스 없음 (`docker context ls`만 즉시 응답, `docker volume ls`는 시도하지 않은 상태)
- `timeout` 만료 후: `docker` CLI 프로세스는 `timeout` 자체가 정리(이 verifier가 별도로 `kill`/`pkill`을 실행하지 않았음). 종료 후 `ps aux | egrep -i "docker|orbstack"` 결과 `docker` CLI는 없고 OrbStack 앱(PID 1300)·Helper(PID 1397)만 계속 실행 중 — 건드리지 않았다.
