# Task 4 — ffmpeg / ffprobe 번들 후보

스펙 P0-C6이 요구하는 것: 번들 ffmpeg·ffprobe가
`be/worker/damwha_worker/pipeline/ffmpeg.py`가 실제로 쓰는 두 명령(`probe`,
`normalize`)을 재배치 후에도 실행하고, Homebrew의 `/opt/homebrew/bin/ffmpeg`
(9.0.1)가 대신 실행되지 않았음을 G2 dyld 로그로 확인하는 것이다. 그리고
R-8이 요구하는 대로 선택한 빌드의 라이선스 구성을 기록한다.

실측값은 전부 `docs/superpowers/reports/evidence/phase-0/`에 있다.

| 증거 | 내용 |
| --- | --- |
| `t4-build-relocation.txt` | 체크섬 대조·configure 결과·빌드·이동 전후 G1·otool 요약 전 과정 (fetch.sh가 생성) |
| `t4-probe*.txt`, `t4-probe-dyld.txt` | V2 — `ffprobe -show_entries format=duration` 실행과 dyld 실측 |
| `t4-normalize*.txt`, `t4-normalize-dyld.txt`, `t4-normalize-check-dyld.txt` | V3 — `ffmpeg` normalize 실행, 산출물을 다시 읽은 ffprobe, 둘의 dyld 실측 |
| `dev-assets-latest.txt` (Task 2 커밋 상태) / 이 Task가 남긴 `docker volume ls` 보완 기록 | 아래 "개발 자산 무변화" 절 |

## 고른 것 — 소스 빌드, LGPL 구성 (스펙 §9 후보 2)

```
ffmpeg 9.0.1   ffmpeg.org 공식 소스 배포 (2026-09-09 기준 최신 안정판)
```

`ffmpeg/fetch.sh`가 `--disable-gpl --disable-nonfree --disable-version3`로
빌드한다. configure가 스스로 보고하는 결과:

```
License: LGPL version 2.1 or later
```

즉 **GPL·nonfree 코드를 하나도 켜지 않았다** — `-lib*`(libx264, libx265,
libmp3lame, libfdk-aac 등) 플래그를 아무것도 주지 않았으므로 이런 외부
라이브러리가 링크에 들어올 방법이 없다. `--enable-static --disable-shared`로
`bin/ffmpeg`·`bin/ffprobe`를 완전 정적으로 링크했다.

### 활성 인코더 / 디코더 (R-8)

`bin/ffmpeg -encoders` / `-decoders`로 직접 확인했다(재배치 후 바이너리).

- **오디오 인코더 79종, 디코더 다수** — 전부 ffmpeg 내장(native) 구현이다.
  `pipeline/ffmpeg.py::normalize()`가 쓰는 `flac` 인코더도 이 안에 있다
  (`A....D flac  FLAC (Free Lossless Audio Codec)`).
- 외부 GPL 라이브러리로만 존재하는 인코더(`libx264`, `libx265`, `libmp3lame`,
  `libfdk_aac`, `libvpx` 등)는 **하나도 목록에 없다** — configure에서
  `--enable-libXXX`를 하나도 주지 않았으므로 애초에 컴파일되지 않는다.
- 디코더 쪽은 `aac`·`mp3`(`mp3float`)·`opus`·`vorbis`·`alac`·`pcm_*` 전부
  native로 존재한다 — `normalize()`가 임의 입력 형식을 디코드하는 데 외부
  라이브러리가 필요 없다.
- `-protocols`에는 `file`만 있고 `http`/`rtmp` 등 네트워크 프로토콜이 없다
  (`--disable-network`) — `pipeline/ffmpeg.py`가 넘기는 입력은 항상 로컬
  경로이므로 지장이 없다.

### LGPL 구성으로 충분한가 — 판단 (R-8)

**충분하다.** 담화 워커가 ffmpeg를 부르는 자리는 `pipeline/ffmpeg.py`의
`probe()`와 `normalize()` 둘뿐이고(스펙 P0-C6 확인 방법이 그대로 이 둘을
지정한다), 둘 다:

- `probe()` — 컨테이너 메타데이터(`format=duration`)만 읽는다. 코덱 종류와
  무관하다.
- `normalize()` — 임의 입력을 디코드해 **FLAC으로 인코드**한다. 디코드는
  native 디코더가 담당하고(위 목록), FLAC 인코더도 native다.

GPL이 필요해지는 지점은 보통 x264/x265 같은 **특허·라이선스가 있는 비디오
인코더**나 `libfdk_aac`(nonfree) 같은 케이스인데, 담화는 비디오를 다루지
않고 손실 인코딩도 하지 않는다. 그래서 LGPL 구성이 앱의 실제 요구사항을
전부 충족하며, GPL/nonfree를 켜서 얻는 이점이 없다. Phase 6에서 담화가
회의 녹화의 비디오 트랙까지 다뤄야 하는 요구가 생기면 그때 이 판단을
다시 본다(R-8이 Phase 6로 넘기는 이유이기도 하다).

## configure 플래그와 이유

| 플래그 | 이유 |
| --- | --- |
| `--disable-gpl` `--disable-nonfree` `--disable-version3` | GPL·논프리 코드와 GPLv3/LGPLv3 재라이선싱을 전부 끈다. 위 판단의 근거. |
| `--disable-avdevice` | 카메라·마이크 디바이스 캡처. 담화는 2026-09-05 브라우저 캡처 전환 이후 오디오를 파일로만 받는다 (U-4 조사, `probe/deps-survey.md`) — ffmpeg가 디바이스를 열 필요가 없다. |
| `--disable-network` | http/rtmp 등 네트워크 프로토콜. `pipeline/ffmpeg.py`가 넘기는 입력은 항상 로컬 파일 경로다. |
| `--disable-doc` 계열(`htmlpages`/`manpages`/`podpages`/`txtpages`) | texi2html·pod2man 같은 문서 빌드 도구 없이도 빌드되게 한다. 실행과 무관하다. |
| `--disable-ffplay` | SDL 의존 재생 도구. `pipeline/ffmpeg.py`는 `ffmpeg`·`ffprobe`만 부른다. |
| `--enable-static --disable-shared` | 두 실행 파일을 완전 정적으로 링크한다. 아래 "재배치" 절이 그 결과를 실측한다. |

빌드 시점 prefix는 이 머신에 존재하지 않는 `/opt/damwha-phase0/ffmpeg`다
(pg/build.sh·python/build.sh와 같은 장치) — DESTDIR로 그 아래에 설치한 뒤
`bin/ffmpeg`·`bin/ffprobe`만 뽑아 `$EXP/stage/ffmpeg`에 두고 `$EXP/bundle/ffmpeg`로
옮긴 **뒤에** 전 검증을 수행한다.

## 탈락시킨 것 — 공개 정적 빌드 (스펙 §9 후보 1)

evermeet.cx(Zebulon의 macOS arm64 정적 빌드)와 osxexperts.net을 조사했다.
받아서 뜯어보지 않고 조사만으로 탈락시켰다 — 이유는 라이선스다.

- 두 배포처 모두 `libx264`·`libx265`·`libfdk-aac` 등을 켜서 빌드한다.
  이런 공개 "완전 기능" 정적 빌드는 관례적으로 **GPL(v2 또는 v3) 또는
  거기에 nonfree까지 얹은 구성**이다 — R-8이 경고한 그대로("ffmpeg 정적
  빌드가 GPL 구성이면 배포 조건이 바뀐다").
- 담화가 실제로 쓰는 두 명령(`probe`, `normalize`)에는 그 라이선스 비용을
  치를 이유가 없다. GPL 구성을 받아 놓고 R-8 판단에서 "우리는 GPL 부분을
  쓰지 않는다"고 적는 것보다, 애초에 GPL 코드가 링크되지 않은 바이너리를
  만드는 쪽이 배포 조건에 대한 논쟁의 여지를 없앤다.
- 소스 빌드가 이 머신에서 **≈107초**(configure+make, 8코어)로 끝난다
  (`t4-build-relocation.txt`) — "빌드를 피하려고" 공개 바이너리를 쓸
  이유가 pg_bigm 케이스(Task 2)와 달리 없다. ffmpeg는 pg_bigm처럼 배포
  바이너리가 아예 없는 것이 아니라, 있는 배포 바이너리가 우리 라이선스
  요구와 맞지 않는 경우다.

## 체크섬 — pgvector/pg_bigm과 같은 한계

`ffmpeg.org/releases/`는 이 경로에 gpg 서명(`.asc`)만 두고 배포처 공개
`sha256sum` 파일은 두지 않는다 — `ffmpeg-9.0.1.tar.xz.sha256sum`은 404다.
이 머신에는 `gpg`가 없어(`which gpg` 없음, 2026-09-09) 서명을 검증할 수
없었다. `postgresql-16.15.tar.bz2`처럼 배포처가 공개한 체크섬과 대조하지
못했다는 뜻이다 — pgvector·pg_bigm의 GitHub 태그 아카이브와 같은 처지다.
2026-09-09에 HTTPS(TLS)로 받은 값을 `ffmpeg/checksums.txt`에 적어 두고
재실행 시 같은 바이트인지만 대조한다. Phase 6에서 실제 배포용 바이너리를
받을 때는 gpg 검증 경로를 마련하는 편이 낫다 — 이 한계는 결과 문서에
인계 사항으로 남긴다.

## 재배치 — PostgreSQL·Python과 달리 아무것도 깨지지 않았다

Task 2(PostgreSQL)는 `install_name`에 박힌 빌드 시점 libdir 절대 경로가,
Task 3(Python)은 wheel의 배포자 빌드 머신 rpath와 콘솔 스크립트 shebang이
이동 후 깨졌다. ffmpeg는 **둘 다 해당하지 않는다**:

```
$ otool -L bundle/ffmpeg/bin/ffmpeg   # 이동 후
	/System/Library/Frameworks/OpenGL.framework/... (컴파일 시점 Core* 프레임워크 연결 — VideoToolbox 등)
	/usr/lib/libSystem.B.dylib
	/usr/lib/libz.1.dylib
	/System/Library/Frameworks/VideoToolbox.framework/...
	/System/Library/Frameworks/CoreImage.framework/...
	... (전부 /usr/lib 또는 /System/Library/Frameworks)
```

`otool -l`의 `LC_RPATH`는 **커맨드 자체가 없다** — 지울 rpath가 없다.
`--enable-static --disable-shared`로 링크한 결과 실행 파일이 필요로 하는
것은 시스템이 어차피 제공하는 프레임워크와 `/usr/lib`뿐이고, 번들 자신을
가리키는 경로도, 빌드 트리를 가리키는 경로도 바이너리 안에 없다. 그래서
`install_name_tool`·`codesign -f -s -` 같은 사후 처리가 **필요 없었다** —
이동 전(`stage/ffmpeg`)과 이동 후(`bundle/ffmpeg`)의 `check-macho.sh` 출력이
위반 0건으로 완전히 같다(`t4-build-relocation.txt`의 6·8절 대비).

VideoToolbox·CoreImage·AppKit 등 무거워 보이는 프레임워크가 나오는 것은
`--disable-avdevice`를 줘도 avcodec의 하드웨어 가속 경로(VideoToolbox
인코더/디코더)와 스케일링(libswscale)이 남아서다 — 전부 macOS가 기본
제공하는 System 프레임워크라 G1 위반이 아니다.

## `--enable-static`에서 뺀 것 — 빌드 전용 산출물

`make install`은 `include/`(헤더), `lib/*.a`(정적 라이브러리 자체),
`lib/pkgconfig/*.pc`, `share/ffmpeg/`(예제 소스, ffpreset, `ffprobe.xsd`)도
함께 설치한다. `fetch.sh`는 이 중 **`bin/ffmpeg`·`bin/ffprobe` 둘만**
번들로 옮긴다 — pg/build.sh가 `lib/pgxs`·`include/`를 뺀 것과 같은 이유다.
`lib/pkgconfig/*.pc`에는 빌드 트리 절대 경로(`$BUILD_PREFIX`)가 그대로
박혀 있어 남겨 두면 재배치와 무관한 빌드 기록이 G1 위반으로 잡히고, 헤더·
정적 라이브러리·예제 소스는 실행에 전혀 쓰이지 않는다.

## 개발 자산 무변화 — docker volume ls 보완

Task 3의 `docker volume ls` after 측정이 OrbStack API 무응답(26분 매달림)으로
빠졌다(`t3-dev-assets.txt`). Task 4 시작 시 다시 대조를 시도했다.

- `be/storage`: **무변화.** manifest_sha256이 Task 3 before/after와 완전히
  같다(`a18870e6…6391be`, 29 files, 2227477523 bytes) — Task 1 이후 아무
  Task도 원본에 쓰지 않았다.
- `docker volume ls`: **여전히 응답 없음.** 두 차례 시도했고 각각 20초
  넘게 매달려 그 `docker` CLI 프로세스(클라이언트, 볼륨 자체가 아니다)의
  PID만 종료했다 — OrbStack 앱·헬퍼 프로세스 자체는 계속 살아 있다
  (`ps ax`로 확인, PID 1300/1397). 이 Task도 `docker` 명령을 읽기 전용
  조회 외에는 실행하지 않으므로(`docker volume rm`·`docker compose down -v`
  없음, README 공통 원칙 참조) 볼륨에 대한 쓰기 경로 자체가 존재하지
  않는다 — damwha_pgdata를 포함해 Task 3 before 목록의 15개 볼륨이 바뀔
  방법이 없다. 뒤 Task가 OrbStack이 회복된 뒤 다시 대조하면 된다.

## 뒤 Task가 알아야 하는 것

1. **ffmpeg/ffprobe는 완전 정적 Mach-O라 셸 런처가 필요 없다.** 번들
   python(Task 3)과 같은 형태 — `env -i`가 직접 `exec`하므로 계획 규칙
   1(exec 직전 재-export)이 필요 없고 dyld 실측이 그대로 산다.
   `verify/t4-lib.sh::t4_run_ffmpeg` / `t4_run_ffprobe`가 그 통로다.
2. **Homebrew ffmpeg도 우연히 9.0.1이다.** `/opt/homebrew/bin/ffmpeg
   -version`이 같은 버전 문자열을 내므로 버전 번호로는 번들 실행과 구분되지
   않는다(clang 빌드 번호는 다르다: 번들 `2100.3.33.1` 대 Homebrew
   `2100.1.1.101` — 이것도 신뢰할 신호는 아니다). 실제로 구분되는 것은
   dyld가 연 이미지의 **경로**뿐이다(`t4-no-homebrew.sh`).
3. **`normalize()`의 산출물은 WAV가 아니라 FLAC이다** (`pipeline/ffmpeg.py`
   주석 참조: FLAC 16 kHz mono s16이 무손실이라 PCM과 비트 단위로 동일하고
   디스크는 절반이다). `t4-normalize.sh`가 검증하는 것도 FLAC 컨테이너의
   `sample_rate`/`channels`이지 WAV가 아니다.
4. Task 5(임베딩·`mlx_lm.server`)나 Task 7(전체 파이프라인)이 ffmpeg를
   부를 때도 이 번들의 `bin/ffmpeg`·`bin/ffprobe`를 쓴다. 경로는
   `$EXP/bundle/ffmpeg/bin/{ffmpeg,ffprobe}`.
