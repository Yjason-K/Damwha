# 검증 증거 — Task 3 (Python·ML 런타임 구성과 재배치)

- 커밋: 시작 시 `git -C <worktree> rev-parse HEAD` = `3246ca8751948c77477924aadb68a6f9f0ed04a8`
  - 지시된 대상 커밋(`aaf02f1`)과 다르다. `git diff --stat aaf02f1..HEAD`로 확인한 결과, 그 사이 커밋은
    `docs/superpowers/plans/2026-09-09-electron-phase-0-packaging-validation.md`(+2줄)와
    `docs/superpowers/reports/2026-09-09-electron-phase-0-packaging-validation-results.md`(+10줄) 두 문서
    파일만 바꿨다. `be/`·`fe/`·`packages/`·`experiments/`는 손대지 않았다. 아래 검증은 이 worktree의
    실제 HEAD(`3246ca8`)에서 수행했다.
- 환경:
  - node: v22.21.1
  - pnpm: 10.26.0
  - PATH python3: Python 3.10.21 (`python3` 별칭, 개발 셸)
  - 시스템 `/usr/bin/python3`: Python 3.9.6 (t3-*.sh의 판정용 파서가 쓰는 고정 경로)
  - 번들 python: `experiments/electron-phase-0/bundle/python/bin/python3.12` (검증 대상 자신)
  - Docker: 실행하지 않음 (지시에 따라 `docker` 명령 미실행)
  - 개발 DB(5432): OrbStack이 이미 리스닝 중이었다(사전 상태, 이 검증이 띄우지 않았다). `be/storage`·
    `damwha_pgdata`에 쓰기 없음 (아래 "쓰기 확인" 참조)
- 실행 일시: 2026-09-09T12:51Z ~ 2026-09-09T13:00Z (UTC), KST 21:51 ~ 22:00

## V1. `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/python`
- cwd: `<repo root>` (`/Users/gim-yeongjae/project/daewha-electron-phase-0`)
- 기대: exit 0
- 실제: `위반 : 0건`. 스크립트 로직상 위반 건수 0이면 exit 0으로 귀결된다(`viol_count`→`exit !(N>0)`와 동치인 305행 `exit 0`). 백그라운드로 실행해 셸의 `$?`를 직접 캡처하지 못했으나, 출력의 위반 0건이 그 결론을 내포한다.
- 소요 시간: 시작 12:51:16Z(KST 21:51:16), 프로세스 종료 확인 KST 21:58:16 → 약 7분
- 일치: 예 (exit 0으로 귀결되는 출력 기준. `$?` 직접 캡처는 못함 — 아래 "주의" 참고)
- 종료 코드: 직접 캡처 못함(백그라운드 실행). 출력상 위반 0건 → 스크립트 로직상 0

**요구된 세부 집계 (항목 1)**

| 구분 | 건수 |
| --- | --- |
| 파일 수 | 38,422 |
| Mach-O 수 | 460 |
| 문자열 후보 파일 | 5,225개 |
| ALLOW 총건 | 42건 |
| ALLOW 중 `soundfile.py` | 4건 (규칙 2줄 × 원본 2건 + `__pycache__` 바이트코드 캐시 2건) |
| ALLOW 중 `ctypes/macholib/dyld.py` | 1건 (원본만; 이번 실행에는 `__pycache__/dyld.cpython-312.pyc`도 1건 더 있었으나 그 pyc 매치는 아래 "관찰" 참고) |
| ALLOW 중 `PIL/_imagingft…so` | 1건 |
| INFO(검사 대상 내부 절대경로) | 5,231건 |
| STALE-PATH 위반 | 0건 |
| OTOOL-L 위반 | 0건 |
| LC_RPATH 위반 | 0건 |
| STRING 위반 | 0건 |
| 위반 총계 | 0건 |

관찰: 전체 출력을 다시 세면 `ALLOW` 줄은 42건이고, `ctypes/macholib/dyld.py`(원본)에 대한 정확 매치는 1건, 같은 파일의 바이트코드 캐시(`ctypes/macholib/__pycache__/dyld.cpython-312.pyc`)에 대한 매치가 별도로 1건 더 있다 — grep 패턴 `ctypes/macholib/dyld.py`가 원본 `.py` 파일 경로에만 일치하고 `.pyc`(파일명이 `dyld.cpython-312.pyc`로 다르다)에는 일치하지 않아 위 표의 "1건"은 원본 `.py` 파일 하나에 대한 카운트다. 전체 42건 ALLOW 목록의 전문은 아래 `<details>`에 있다.

<details><summary>전체 출력</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python
  파일 수       : 38422
  Mach-O 수     : 460
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 5225개 파일
  허용 목록(ALLOW): 42건 / 규칙 24줄 (lib/g1-allowlist.txt)
    ALLOW .../bundle/python/lib/libpython3.12.dylib: /usr/local/lib/python2.5/site-packages  (금지 문자열: /usr/local/lib, 근거: site 모듈 독스트링의 예시 경로 (frozen). 실행 경로가 아니다)
    ALLOW .../bundle/python/lib/libpython3.12.dylib: /usr/local/lib/python2.5/site-packages/bar  (금지 문자열: /usr/local/lib, 근거: site 모듈 독스트링의 예시 경로 (frozen). 실행 경로가 아니다)
    ALLOW .../bundle/python/lib/libpython3.12.dylib: /usr/local/lib/python2.5/site-packages/foo  (금지 문자열: /usr/local/lib, 근거: site 모듈 독스트링의 예시 경로 (frozen). 실행 경로가 아니다)
    ALLOW .../bundle/python/lib/python3.12/__pycache__/mimetypes.cpython-312.pyc: /usr/local/lib/netscape/mime.typesrz/usr/local/etc/mime.typesFc[binary]  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. knownfiles에 있는 선택적 설정 파일 목록 — 없으면 건너뛴다 (바이트코드 캐시))
    ALLOW .../bundle/python/lib/python3.12/cgi.py: /usr/local/bin  (금지 문자열: /usr/local/bin, 근거: deprecated cgi 모듈의 셔뱅 예제 문자열)
    ALLOW .../bundle/python/lib/python3.12/cgi.py: /usr/local/bin/python  (금지 문자열: /usr/local/bin, 근거: deprecated cgi 모듈의 셔뱅 예제 문자열)
    ALLOW .../bundle/python/lib/python3.12/ctypes/macholib/__pycache__/dyld.cpython-312.pyc: /usr/local/libz/libz/usr/lib[binary]  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. ctypes.util.find_library의 DEFAULT_LIBRARY_FALLBACK (바이트코드 캐시))
    ALLOW .../bundle/python/lib/python3.12/ctypes/macholib/dyld.py: /usr/local/lib  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. ctypes.util.find_library의 DEFAULT_LIBRARY_FALLBACK)
    ALLOW .../bundle/python/lib/python3.12/mimetypes.py: /usr/local/lib/netscape/mime.types  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. knownfiles에 있는 선택적 설정 파일 목록 — 없으면 건너뛴다)
    ALLOW .../bundle/python/lib/python3.12/pydoc_data/topics.py: /usr/local/lib/pythonX.Y/os.pyc  (금지 문자열: /usr/local/lib, 근거: help() 본문 텍스트)
    ALLOW .../bundle/python/lib/python3.12/site-packages/PIL/_imagingft.cpython-312-darwin.so: /usr/local/lib/libfribidi.dylib...(바이너리 심볼 나열)  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. fribidi를 dlopen할 때의 후보 경로. 없으면 bidi 기능만 꺼진다)
    ALLOW .../bundle/python/lib/python3.12/site-packages/__pycache__/soundfile.cpython-312.pyc: /opt/homebrew/lib/z/usr/local/lib/[binary]  (금지 문자열: /opt/homebrew, 근거: 실동작-폴백. 번들 _soundfile_data의 libsndfile을 못 찾을 때만 쓰이는 탐색 경로 (바이트코드 캐시))
    ALLOW .../bundle/python/lib/python3.12/site-packages/__pycache__/soundfile.cpython-312.pyc: /usr/local/lib/[binary]  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. 같은 탐색 목록의 다른 항목 (바이트코드 캐시))
    ALLOW .../bundle/python/lib/python3.12/site-packages/av/datasets.py: /usr/local/lib  (금지 문자열: /usr/local/lib, 근거: FFmpeg 예제 데이터 탐색 경로 (Linux 관례))
    ALLOW .../bundle/python/lib/python3.12/site-packages/certifi-2026.7.22.dist-info/METADATA: /usr/local/lib/python3.7/site-packages/certifi/cacert.pem  (금지 문자열: /usr/local/lib, 근거: 패키지 문서)
    ALLOW .../bundle/python/lib/python3.12/site-packages/contourpy/util/_build_config.py: /usr/local/lib/python3.12/site-packages/  (금지 문자열: /usr/local/lib, 근거: 빌드 구성 보고용 상수)
    ALLOW .../bundle/python/lib/python3.12/site-packages/huggingface_hub/cli/lfs.py: /.venv/bin/python  (금지 문자열: /.venv, 근거: 독스트링의 예제 셔뱅)
    ALLOW .../bundle/python/lib/python3.12/site-packages/huggingface_hub/utils/__pycache__/_runtime.cpython-312.pyc: /opt/homebrew/Cellar/hf/0.30.0/libexec/.  (금지 문자열: /opt/homebrew, 근거: Homebrew 설치를 감지하는 코드의 예제 주석 (바이트코드 캐시))
    ALLOW .../bundle/python/lib/python3.12/site-packages/huggingface_hub/utils/__pycache__/_runtime.cpython-312.pyc: /opt/homebrew/Cellar/python@3.12/...  (금지 문자열: /opt/homebrew, 근거: Homebrew 설치를 감지하는 코드의 예제 주석 (바이트코드 캐시))
    ALLOW .../bundle/python/lib/python3.12/site-packages/huggingface_hub/utils/_runtime.py: /opt/homebrew/...  (금지 문자열: /opt/homebrew, 근거: Homebrew 설치를 감지하는 코드의 예제 주석)
    ALLOW .../bundle/python/lib/python3.12/site-packages/huggingface_hub/utils/_runtime.py: /opt/homebrew/Cellar/hf/0.30.0/libexec/.  (금지 문자열: /opt/homebrew, 근거: Homebrew 설치를 감지하는 코드의 예제 주석)
    ALLOW .../bundle/python/lib/python3.12/site-packages/huggingface_hub/utils/_runtime.py: /opt/homebrew/Cellar/python@3.12/...  (금지 문자열: /opt/homebrew, 근거: Homebrew 설치를 감지하는 코드의 예제 주석)
    ALLOW .../bundle/python/lib/python3.12/site-packages/opentelemetry/semconv/_incubating/attributes/process_attributes.py: /usr/local/bin  (금지 문자열: /usr/local/bin, 근거: semantic convention 문서의 예시 값)
    ALLOW .../bundle/python/lib/python3.12/site-packages/scipy/odr/__odrpack.cpython-312-darwin.so: /opt/homebrew/Cellar/gcc@13/13.4.0/lib/gcc/13/gcc/aarch64-apple-darwin23/13/libgcc.a  (금지 문자열: /opt/homebrew, 근거: 같음 (libgcc.a 경로 문자열))
    ALLOW .../bundle/python/lib/python3.12/site-packages/setuptools/tests/test_sdist.py: /.venv  (금지 문자열: /.venv, 근거: 테스트 픽스처)
    ALLOW .../bundle/python/lib/python3.12/site-packages/setuptools/tests/test_sdist.py: /.venv/lib/python3.9/site-packages/bar-2.dist-info/AUTHORS.rst  (금지 문자열: /.venv, 근거: 테스트 픽스처)
    ALLOW .../bundle/python/lib/python3.12/site-packages/soundfile.py: /opt/homebrew/lib  (금지 문자열: /opt/homebrew, 근거: 실동작-폴백. 번들 _soundfile_data의 libsndfile을 못 찾을 때만 쓰이는 탐색 경로)
    ALLOW .../bundle/python/lib/python3.12/site-packages/soundfile.py: /opt/homebrew/lib/  (금지 문자열: /opt/homebrew, 근거: 실동작-폴백. 번들 _soundfile_data의 libsndfile을 못 찾을 때만 쓰이는 탐색 경로)
    ALLOW .../bundle/python/lib/python3.12/site-packages/soundfile.py: /usr/local/lib  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. 같은 탐색 목록의 다른 항목)
    ALLOW .../bundle/python/lib/python3.12/site-packages/soundfile.py: /usr/local/lib/  (금지 문자열: /usr/local/lib, 근거: 실동작-폴백. 같은 탐색 목록의 다른 항목)
    ALLOW .../bundle/python/lib/python3.12/site-packages/sympy-1.14.0.dist-info/METADATA: /usr/local/lib/antlr-4.11.1-complete.jar  (금지 문자열: /usr/local/lib, 근거: 패키지 문서 (antlr jar 설치 안내))
    ALLOW .../bundle/python/lib/python3.12/site-packages/threadpoolctl-3.6.0.dist-info/METADATA: /usr/local/lib/libflexiblas.so.3.3  (금지 문자열: /usr/local/lib, 근거: 패키지 문서)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torch/backends/xeon/run_cpu.py: /usr/local/lib  (금지 문자열: /usr/local/lib, 근거: Linux/Xeon 전용 실행기의 경로 조립)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torch/backends/xeon/run_cpu.py: /usr/local/lib/  (금지 문자열: /usr/local/lib, 근거: Linux/Xeon 전용 실행기의 경로 조립)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torch/backends/xeon/run_cpu.py: /usr/local/lib64  (금지 문자열: /usr/local/lib, 근거: Linux/Xeon 전용 실행기의 경로 조립)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torch/backends/xeon/run_cpu.py: /usr/local/lib64/  (금지 문자열: /usr/local/lib, 근거: Linux/Xeon 전용 실행기의 경로 조립)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torch/distributed/_symmetric_memory/_nvshmem_triton.py: /usr/local/lib  (금지 문자열: /usr/local/lib, 근거: NVIDIA NVSHMEM 경로. CUDA 전용이라 macOS에서 실행되지 않는다)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torch/distributed/elastic/agent/server/local_elastic_agent.py: /usr/local/bin/trainer  (금지 문자열: /usr/local/bin, 근거: 독스트링의 예제 명령)
    ALLOW .../bundle/python/lib/python3.12/site-packages/torchcodec/_core/CMakeLists.txt: /opt/homebrew/opt/ffmpeg/lib  (금지 문자열: /opt/homebrew, 근거: wheel에 같이 들어온 CMake 빌드 파일. 런타임에 읽지 않는다)
    ALLOW .../bundle/python/lib/python3.12/site.py: /usr/local/lib/python2.5/site-packages  (금지 문자열: /usr/local/lib, 근거: 모듈 독스트링의 예시 경로("/usr/local/lib/python2.5/site-packages"))
    ALLOW .../bundle/python/lib/python3.12/site.py: /usr/local/lib/python2.5/site-packages/bar  (금지 문자열: /usr/local/lib, 근거: 모듈 독스트링의 예시 경로("/usr/local/lib/python2.5/site-packages"))
    ALLOW .../bundle/python/lib/python3.12/site.py: /usr/local/lib/python2.5/site-packages/foo  (금지 문자열: /usr/local/lib, 근거: 모듈 독스트링의 예시 경로("/usr/local/lib/python2.5/site-packages"))
  검사 대상 내부 절대경로(INFO): 5231건
    INFO  .../bundle/python/bin/alembic: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/cffi-gen-src: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-fairseq-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-marian-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-openai-gpt2-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-opennmt-py-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-opennmt-tf-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-opus-mt-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/ct2-transformers-converter: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/damwha-embed: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/damwha-worker: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/dotenv: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/f2py: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/fabric: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/fastapi: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/fonttools: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/hf: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/httpx: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/huggingface-cli: .../bundle/python/bin/python3.12
    INFO  .../bundle/python/bin/idna: .../bundle/python/bin/python3.12
    ... (5231건 중 20건만 표시)
  위반          : 0건
```

(원본 raw 출력 — otool 심볼 바이너리 포함 — 은 `/private/tmp/claude-501/-Users-gim-yeongjae-project-daewha/ce4fc665-b7b4-47af-bae7-c9645b5363af/scratchpad/v1-check-macho-python.out`에 그대로 남아 있다. 위 인용은 장황한 절대경로를 `...`로 축약하고 바이너리 심볼 나열을 `(바이너리 심볼 나열)`/`[binary]`로 표기한 것 외에는 원문 그대로다.)

</details>

## V2. `bash experiments/electron-phase-0/verify/t3-imports.sh`
- cwd: `<repo root>`
- 기대: exit 0, 격리 실행에서 torch·torchaudio·mlx_whisper·mlx_lm·pyannote.audio·speechbrain·silero_vad·sentence_transformers·faster_whisper·soundfile·numpy·fastapi·uvicorn·damwha_worker 전부 import 성공
- 실제: 16개 모듈(mlx·sounddevice 포함) 전부 `OK`, `damwha_worker`가 `bundle/python/lib/python3.12/site-packages/damwha_worker/__init__.py`에서 옴, dyld 줄 1135건 중 300건이 `bundle/python/` 아래 이미지
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 격리 실행 (스펙 §4.2) — 번들 python이 env -i에 직접 exec된다
run-isolated: label=t3-imports  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.IFYvBW/stderr.raw)

== 모듈별 결과
  OK   torch  lib/python3.12/site-packages/torch/__init__.py
  OK   torchaudio  lib/python3.12/site-packages/torchaudio/__init__.py
  OK   mlx  None
  OK   mlx_whisper  lib/python3.12/site-packages/mlx_whisper/__init__.py
  OK   mlx_lm  lib/python3.12/site-packages/mlx_lm/__init__.py
  OK   pyannote.audio  lib/python3.12/site-packages/pyannote/audio/__init__.py
  OK   speechbrain  lib/python3.12/site-packages/speechbrain/__init__.py
  OK   silero_vad  lib/python3.12/site-packages/silero_vad/__init__.py
  OK   sentence_transformers  lib/python3.12/site-packages/sentence_transformers/__init__.py
  OK   faster_whisper  lib/python3.12/site-packages/faster_whisper/__init__.py
  OK   soundfile  lib/python3.12/site-packages/soundfile.py
  OK   sounddevice  lib/python3.12/site-packages/sounddevice.py
  OK   numpy  lib/python3.12/site-packages/numpy/__init__.py
  OK   fastapi  lib/python3.12/site-packages/fastapi/__init__.py
  OK   uvicorn  lib/python3.12/site-packages/uvicorn/__init__.py
  OK   damwha_worker  lib/python3.12/site-packages/damwha_worker/__init__.py

== damwha_worker의 출처 (계획 Review: 설치인가 PYTHONPATH인가)
  OK   번들 site-packages에 설치돼 있다: lib/python3.12/site-packages/damwha_worker/__init__.py

== dyld 실측이 진짜인가 (계획 규칙 6b)
  OK   dyld 줄 1135건 중 300건이 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/ 아래 이미지다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t3-imports.txt
모든 모듈이 번들 안에서 import 됐다
```

</details>

## V3. `bash experiments/electron-phase-0/verify/t3-mps.sh`
- cwd: `<repo root>`
- 기대: exit 0, `damwha_worker.models.device.mps_available()`가 `True`
- 실제: `mps_available() = True (모듈: damwha_worker.models.device)`, torch도 번들 안, dyld 줄 727건 중 13건이 `bundle/python/` 아래
- 일치: 예
- 종료 코드: 0

<details><summary>전체 출력</summary>

```
== 격리 실행 — damwha_worker.models.device.mps_available()
run-isolated: label=t3-mps  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.GNtdJc/stderr.raw)
  {"mps_available": true, "source": "damwha_worker.models.device", "torch_version": "2.12.1", "torch_backends_mps_is_available": true, "torch_backends_mps_is_built": true, "torch_file": "/Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/lib/python3.12/site-packages/torch/__init__.py"}

  OK   mps_available() = True  (모듈: damwha_worker.models.device)
  OK   torch가 번들 안이다: lib/python3.12/site-packages/torch/__init__.py

== dyld 실측이 진짜인가 (계획 규칙 6b)
  OK   dyld 줄 727건 중 13건이 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/ 아래 이미지다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t3-mps.txt
번들 런타임에서 MPS가 잡힌다
```

</details>

## V4. `bash experiments/electron-phase-0/verify/t3-selfreport.sh`
- cwd: `<repo root>`
- 기대: exit 0, 덤프된 모든 경로가 bundle/ 또는 sandbox/ 하위이고 `/Library/Frameworks/Python.framework`·`/opt/homebrew`·`.venv`가 0건
- 실제: 경로 토큰 888개 모두 bundle/sandbox/시스템 하위, 금지 문자열 8종 전부 0건, `sys.executable/prefix/base_prefix` 전부 bundle 안, `VIRTUAL_ENV`/`PYTHONPATH`/`PYTHONHOME` 없음, 로드된 이미지 831개 중 허용 밖 0개
- 일치: 예
- 종료 코드: 0

**요구된 경로 집계 (항목 5)**: 검사한 절대 경로 토큰 총수 **888개**, 그중 번들·샌드박스·시스템 밖을 가리키는 것 **0개**. (별도로 이 프로세스가 실제로 dyld로 연 Mach-O 이미지는 831개 집계했고 그중 허용 밖은 0개.)

<details><summary>전체 출력</summary>

```
== 격리 실행 — 번들 python이 자기 경로를 보고한다
run-isolated: label=t3-selfreport  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.Atd0Hy/stderr.raw)

== 절대 경로 분류 (888개)
  OK   전부 bundle/ · sandbox/ · 시스템 경로 하위다

== 금지 문자열 (스펙 §4.1) — 자기 보고 덤프 전체
  OK   0건  /Library/Frameworks/Python.framework
  OK   0건  /opt/homebrew
  OK   0건  /usr/local/bin
  OK   0건  /usr/local/lib
  OK   0건  /usr/local/Cellar
  OK   0건  /usr/local/opt
  OK   0건  .venv
  OK   0건  /Library/Developer/CommandLineTools

== 핵심 필드
  OK   sys.executable = /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/bin/python3.12
  OK   sys.prefix = /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python
  OK   sys.base_prefix = /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python
  OK   env.VIRTUAL_ENV 없음
  OK   env.PYTHONPATH 없음
  OK   env.PYTHONHOME 없음

== 이 프로세스가 실제로 연 Mach-O 이미지 (런타임 자신의 보고)
  로드된 이미지: 831개, 허용 밖: 0개

== dyld 실측이 진짜인가 (계획 규칙 6b)
  OK   dyld 줄 1074건 중 312건이 /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/python/ 아래 이미지다

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t3-selfreport.txt , /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t3-selfreport-json.txt
런타임이 보고하는 경로가 전부 번들·샌드박스·시스템 안이다
```

</details>

## V5. `bash experiments/electron-phase-0/verify/t3-versions.sh`
- cwd: `<repo root>`
- 기대: exit 0, 설치된 패키지 버전이 `pyproject.toml`의 `models` extra 고정 버전과 전부 일치
- 실제: 아래 표. 17개 고정 버전(models extra 10개 + 기본 dependencies 7개) 전부 `OK`. `mlx-lm`은 pyproject.toml에 선언이 없어 스크립트가 별도 절에서 설치 여부·버전만 기록한다(대조 기준이 없으므로 "일치"가 아니라 "설치 확인").
- 일치: 예 (models extra 10개 항목 기준)
- 종료 코드: 0

**요구된 버전 대조표 (항목 6)**

| 패키지 | pyproject.toml `models` extra 고정 버전 | 번들 런타임 실측 버전 (`importlib.metadata`) | 일치 |
| --- | --- | --- | --- |
| torch | 2.12.1 | 2.12.1 | 예 |
| torchaudio | 2.11.0 | 2.11.0 | 예 |
| silero-vad | 6.2.1 | 6.2.1 | 예 |
| pyannote.audio | 4.0.5 | 4.0.5 | 예 |
| speechbrain | 1.1.0 | 1.1.0 | 예 |
| soundfile | 0.14.0 | 0.14.0 | 예 |
| numpy | 2.4.6 | 2.4.6 | 예 |
| mlx-whisper | 0.4.3 | 0.4.3 | 예 |
| faster-whisper | 1.2.1 | 1.2.1 | 예 |
| sentence-transformers | 5.6.0 | 5.6.0 | 예 |
| mlx-lm | (pyproject.toml에 선언 없음) | 0.31.3 (mlx 0.32.2) | 대조 기준 없음 — 설치·버전만 기록 |

기본 dependencies(참고, `models` extra는 아니지만 스크립트가 함께 대조): httpx 0.28.1, pydantic 2.13.4, pydantic-settings 2.14.2, psycopg 3.3.4, fastapi 0.138.1, uvicorn 0.49.0, sounddevice 0.5.2 — 전부 `OK`. `damwha-worker` 0.2.3도 확인됨.

<details><summary>전체 출력</summary>

```
== 격리 실행 — 번들 런타임의 importlib.metadata
run-isolated: label=t3-versions  stderr는 실행이 끝난 뒤에 나온다 (실시간: tail -f /var/folders/br/j4gx9hf16yn0bpvlwp7jdnpm0000gn/T//runiso.wMXmCl/stderr.raw)

== 대조 (17개 고정 버전)
  OK   httpx 0.28.1
  OK   pydantic 2.13.4
  OK   pydantic-settings 2.14.2
  OK   psycopg 3.3.4
  OK   torch 2.12.1
  OK   torchaudio 2.11.0
  OK   silero-vad 6.2.1
  OK   pyannote.audio 4.0.5
  OK   speechbrain 1.1.0
  OK   soundfile 0.14.0
  OK   numpy 2.4.6
  OK   mlx-whisper 0.4.3
  OK   faster-whisper 1.2.1
  OK   sentence-transformers 5.6.0
  OK   fastapi 0.138.1
  OK   uvicorn 0.49.0
  OK   sounddevice 0.5.2

== mlx-lm (pyproject.toml에 없는 네 번째 런타임, 스펙 §2)
  OK   mlx-lm 0.31.3 (mlx 0.32.2) — 같은 런타임 안에 있다

== damwha-worker
  OK   damwha-worker 0.2.3

증거: /Users/gim-yeongjae/project/daewha-electron-phase-0/docs/superpowers/reports/evidence/phase-0/t3-versions.txt
고정 버전이 전부 일치한다
```

</details>

## V6. `git status --porcelain be/src be/worker/damwha_worker be/worker/scripts fe/src packages/contracts`
- cwd: `<repo root>`
- 기대: 출력 없음
- 실제: 출력 없음
- 일치: 예
- 종료 코드: 0

---

## 이번 Task에서 특히 확인한 것 (사실만, 판정 아님)

**항목 1 (G1 허용 목록 적중 내역)**: V1 섹션의 표 참조. ALLOW 총 42건, `soundfile.py` 4건(원본 2 + `__pycache__` 2), `ctypes/macholib/dyld.py` 1건(원본; `.pyc`는 파일명이 달라 별도 매치 1건이 이 문자열 규칙이 아닌 같은 근거의 `__pycache__/dyld.cpython-312.pyc` 항목으로 잡혔다), `PIL/_imagingft…so` 1건. STALE-PATH·OTOOL-L·LC_RPATH·STRING 위반은 전부 0건.

**항목 2 (허용 목록이 bundle/pg에 안 번짐)**: `bash experiments/electron-phase-0/lib/check-macho.sh experiments/electron-phase-0/bundle/pg` — exit 0, `허용 목록(ALLOW): 0건`, `위반: 0건` (파일 767개, Mach-O 70개). Task 2 때(위반 0건)와 같다.

<details><summary>bundle/pg check-macho.sh 전체 출력</summary>

```
check-macho.sh (G1, 스펙 §4.1)
  대상          : /Users/gim-yeongjae/project/daewha-electron-phase-0/experiments/electron-phase-0/bundle/pg
  파일 수       : 767
  Mach-O 수     : 70
  금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
  문자열 후보   : 0개 파일
  허용 목록(ALLOW): 0건 / 규칙 24줄 (lib/g1-allowlist.txt)
  검사 대상 내부 절대경로(INFO): 0건
  위반          : 0건
```

</details>

**항목 3 (검사기 회귀)**: `bash experiments/electron-phase-0/verify/t1-detector-negative.sh` — exit 0. A(합성 대조군: 금지 문자열 9종 전부 검출, otool -L·LC_RPATH 위반 검출, 재배치 잔존 경로 3종 검출, fat 바이너리 처리 OK), B(실물 대조군 `/opt/homebrew/bin`: 비정상 종료 exit 1, 위반 6건 검출), C(dyld 실측 대조군: dyld 81건 실측), D(런처 dyld 대조군: D1 re-export 없음→0건, D2 re-export 있음→81건 실측 및 pid 일치, D3 가짜 증거→82건이지만 로드 pid 없음을 올바로 판정) 전부 통과. 이 실행은 공유 증거 디렉터리의 `t1-dyld-*.txt` 8개 파일을 다시 썼고(harness의 `t1_evidence_path`류 회전 설계에 따라 이전 값은 `.prev-<timestamp>.txt`로 보존됨), 그 결과 `git status --porcelain`에 `M`(수정)과 `??`(신규 .prev 파일)로 나타난다.

<details><summary>t1-detector-negative.sh 전체 출력</summary>

```
== A. 합성 대조군 — 금지 문자열 9종 + otool -L + LC_RPATH
  금지 문자열 대조 파일 9개 생성
  OK   check-macho.sh가 비정상 종료했다 (exit 1)
    check-macho.sh (G1, 스펙 §4.1)
      대상          : .../sandbox/tmp/g1-detector-fixture
      파일 수       : 14
      Mach-O 수     : 2
      금지 문자열   : 9개 (lib/forbidden-strings.txt + 실행 시점 HOME)
      문자열 후보   : 12개 파일
      허용 목록(ALLOW): 0건 / 규칙 24줄 (lib/g1-allowlist.txt)
      검사 대상 내부 절대경로(INFO): 0건
      위반          : 14건
        STRING  .../pattern-1.txt: /opt/homebrew/g1-detector-probe  (금지 문자열: /opt/homebrew)
        STRING  .../pattern-2.txt: /Library/Frameworks/Python.framework/g1-detector-probe  (금지 문자열: /Library/Frameworks/Python.framework)
        STRING  .../pattern-3.txt: /usr/local/bin/g1-detector-probe  (금지 문자열: /usr/local/bin)
        STRING  .../pattern-4.txt: /usr/local/lib/g1-detector-probe  (금지 문자열: /usr/local/lib)
        STRING  .../pattern-5.txt: /usr/local/Cellar/g1-detector-probe  (금지 문자열: /usr/local/Cellar)
        STRING  .../pattern-6.txt: /usr/local/opt/g1-detector-probe  (금지 문자열: /usr/local/opt)
        STRING  .../pattern-7.txt: /Users/gim-yeongjae/g1-detector-probe  (금지 문자열: /Users/gim-yeongjae)
        STRING  .../pattern-8.txt: /.venv/g1-detector-probe  (금지 문자열: /.venv)
        STRING  .../pattern-9.txt: /Library/Developer/CommandLineTools/g1-detector-probe  (금지 문자열: /Library/Developer/CommandLineTools)
        STALE-PATH .../stale-pkgconfig.pc: .../sandbox/stale-prefix  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        STALE-PATH .../stale-pyvenv.cfg: .../downloads/cpython/bin  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        STALE-PATH .../stale-shebang: .../stage/python/bin/python3  (번들 밖 절대 경로 — 검사 대상이 아닌 실험 디렉터리를 가리킨다, 금지 문자열: /Users/gim-yeongjae)
        OTOOL-L .../dep-bad: /tmp/g1-detector-probe/libSystem.B.dylib  (허용 접두사가 아니다)
        LC_RPATH .../rpath-bad: /tmp/g1-detector-probe-rpath  (번들 밖 절대 경로)
  OK   금지 문자열 9종을 모두 검출했다 (스펙 §4.1 표 7행 전부)
  OK   otool -L 의존 경로 위반을 검출했다
  OK   LC_RPATH 위반을 검출했다
  OK   재배치 잔존 경로를 검출했다: stale-shebang
  OK   재배치 잔존 경로를 검출했다: stale-pyvenv.cfg
  OK   재배치 잔존 경로를 검출했다: stale-pkgconfig.pc
  OK   fat 바이너리 경로를 아키텍처 꼬리표 없이 다뤘다

== B. 실물 대조군 — check-macho.sh /opt/homebrew/bin
  OK   비정상 종료했다 (exit 1)
    검출한 위반 줄 수: 6
      위반          : 6건

== C. dyld 실측 대조군 — 플랫폼 바이너리가 아닌 Mach-O
run-isolated: label=t1-dyld-control  stderr는 실행이 끝난 뒤에 나온다
  OK   dyld 줄 81건을 실측했다
    dyld[18715]: <1847B2BD-6C7D-3600-82B0-AC6B5F8F823F> .../sandbox/tmp/g2-dyld-control/echo
    dyld[18715]: <4FDC9AA6-B344-37FE-B8C6-A4C94A038F57> /usr/lib/libSystem.B.dylib
    dyld[18715]: <83E81326-A587-374F-ABC1-BAE48D0FEE0D> /usr/lib/system/libcache.dylib

== D. 런처 dyld 대조군 — re-export 없음 / 있음 / 가짜 증거
run-isolated: label=t1-dyld-launcher-noexport  stderr는 실행이 끝난 뒤에 나온다
  OK   D1: re-export 없는 런처는 dyld 0건이다 (SIP가 /bin/bash exec에서 지웠다)
  OK   D1: 증거가 MEASUREMENT_UNAVAILABLE로 표시됐다 — 통과로 집계되지 않는다
run-isolated: label=t1-dyld-launcher-reexport  stderr는 실행이 끝난 뒤에 나온다
  OK   D2: re-export 있는 런처는 dyld 81건을 실측했다 (pid: 19262 )
  OK   D2: pid 19262가 자식 Mach-O를 로드했다 — 검증 대상이 실제로 측정됐다
run-isolated: label=t1-dyld-launcher-fake  stderr는 실행이 끝난 뒤에 나온다
  OK   D3: 가짜 증거 런처가 dyld 82건을 남겼다 — 줄 수만 보면 통과처럼 보인다
  OK   D3: 자식 Mach-O를 로드한 pid가 없다고 올바로 판정했다 (pid: 19637 )
  정보 파일 전체를 grep하면 이 가짜 증거도 매치된다 (헤더의 # argv: 줄).
       ^dyld 줄로 한정해야 하는 이유다 (규칙 6).

모든 대조군이 위반을 실제로 검출했다 — 계측기가 살아 있다
```

</details>

**항목 4 (재배치 증거 대비)**: 기존 증거 파일(구현자가 남긴 것, 이번 회차에 새로 만들지 않았다)을 그대로 세었다.

| 증거 파일 | 대상 | 위반 총계 | STALE-PATH | OTOOL-L | LC_RPATH | STRING |
| --- | --- | --- | --- | --- | --- | --- |
| `t3-g1-stage.txt` (이동 전, `stage/python`) | `.../stage/python` | 136 | 13 | 65 | 58 | 0 |
| `t3-relocation-attempt1.txt` (이동 후, 사후처리 전, `bundle/python`) | `.../bundle/python` | 201 | 78 | 65 | 58 | 0 |
| `t3-g1-bundle.txt` (사후처리 후) | `.../bundle/python` | 0 | 0 | 0 | 0 | 0 |
| 이번 회차 V1 (검증 실행, 위 최종 상태) | `.../bundle/python` | 0 | 0 | 0 | 0 | 0 |

구현자 보고(136 → 201 → 0)와 세 파일의 실측이 일치한다. 이번 검증에서 다시 돌린 V1도 0건으로 같은 최종 상태를 재현했다.

**항목 5 (V4 selfreport 경로 집계)**: V4 섹션 참조. 검사한 절대 경로 토큰 888개, 번들·샌드박스·시스템 밖 0개.

**항목 6 (V5 버전 대조)**: V5 섹션의 표 참조. `models` extra 10개 전부 일치, 기본 dependencies 7개 전부 일치, `mlx-lm`은 pyproject.toml에 선언이 없어(대조 기준 없음) 설치 여부·버전(0.31.3, mlx 0.32.2)만 기록.

## 쓰기 확인 (금지 대상)

- 개발 DB(포트 5432, `damwha_pgdata`): OrbStack이 사전부터 리스닝 중이었고(`lsof -iTCP:5432 -sTCP:LISTEN` → `OrbStack` 프로세스), 이 검증이 그 포트에 연결하거나 쓴 적 없다 — Task 3 Verify(V1~V6)는 DB를 건드리지 않는다.
- `be/storage`: `find be/storage -newermt "2026-09-09 21:50:00"` → 결과 없음 (검증 시작 이후 변경된 파일 없음).
- `~/.cache/huggingface`: `find ~/.cache/huggingface -newermt "2026-09-09 21:50:00"` → 결과 없음.
- `docker`: 실행하지 않았다 (지시에 따름). `snapshot-dev-assets.sh`는 이번 검증에서 호출하지 않았다 — Task 3 Verify 표(V1~V6)에 포함되지 않는다.

## 부가 확인

- `du -sh experiments/electron-phase-0/bundle/python` → **1.5G**
- `df -g /System/Volumes/Data` → `Filesystem 1G-blocks Used Available Capacity iused ifree %iused Mounted on` / `/dev/disk3s5 460 405 23 95% 4461936 242690840 2% /System/Volumes/Data` (여유 23GB)
- `docs/superpowers/reports/evidence/phase-0/` 파일 목록(이번 검증 실행 **후** 기준): `.md` 5개(`task-1-r1.md`~`task-1-r4.md`, `task-2-r1.md`; 이번에 새로 만든 `task-3-r1.md`는 목록 산정 시점 이후 파일이라 미포함), `.txt` 69개(이번 검증이 다시 쓴 `t1-dyld-*.txt` 8개·`t3-imports*.txt`·`t3-mps*.txt`·`t3-selfreport*.txt`·`t3-versions*.txt` 및 그 `.prev-<timestamp>.txt` 회전본 포함).
- `git status --porcelain` 전체 출력(V6과 별개로, worktree 전체 기준):

```
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.txt
 M docs/superpowers/reports/evidence/phase-0/t3-imports-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t3-imports-env.txt
 M docs/superpowers/reports/evidence/phase-0/t3-imports.txt
 M docs/superpowers/reports/evidence/phase-0/t3-mps-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t3-mps-env.txt
 M docs/superpowers/reports/evidence/phase-0/t3-mps.txt
 M docs/superpowers/reports/evidence/phase-0/t3-selfreport-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t3-selfreport-env.txt
 M docs/superpowers/reports/evidence/phase-0/t3-selfreport-json.txt
 M docs/superpowers/reports/evidence/phase-0/t3-selfreport.txt
 M docs/superpowers/reports/evidence/phase-0/t3-versions-dyld.txt
 M docs/superpowers/reports/evidence/phase-0/t3-versions-env.txt
 M docs/superpowers/reports/evidence/phase-0/t3-versions.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-dyld.prev-20260909T125243Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-control-env.prev-20260909T125243Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-dyld.prev-20260909T125244Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-fake-env.prev-20260909T125244Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-dyld.prev-20260909T125243Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-noexport-env.prev-20260909T125243Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-dyld.prev-20260909T125243Z.txt
?? docs/superpowers/reports/evidence/phase-0/t1-dyld-launcher-reexport-env.prev-20260909T125243Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-imports-dyld.prev-20260909T125903Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-imports-env.prev-20260909T125903Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-imports.prev-20260909T125854Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-mps-dyld.prev-20260909T125910Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-mps-env.prev-20260909T125910Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-mps.prev-20260909T125909Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-selfreport-dyld.prev-20260909T125921Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-selfreport-env.prev-20260909T125921Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-selfreport-json.prev-20260909T125915Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-selfreport.prev-20260909T125915Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-versions-dyld.prev-20260909T125929Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-versions-env.prev-20260909T125929Z.txt
?? docs/superpowers/reports/evidence/phase-0/t3-versions.prev-20260909T125929Z.txt
```

이 변경들은 이 검증(V1~V6, 그리고 지시받은 t1-detector-negative.sh·bundle/pg 재확인)을 실행한 결과다 — `t3_evidence_path`/`run-isolated.sh`의 증거 회전 설계에 따라 각 verify 스크립트가 자기 실행마다 공유 증거 디렉터리(`$EVIDENCE`)의 같은 이름 파일을 갱신하고 이전 값을 `.prev-<timestamp>.txt`로 옆에 남긴다. 이 verifier는 `docs/superpowers/reports/evidence/phase-0/task-3-r1.md` 외에는 아무것도 직접 작성하지 않았다 — 위 목록은 지시받은 명령을 그대로 실행한 부수효과다.

## 프로세스 정리

- 기동 전: 관련 프로세스(`check-macho.sh`, 번들 python, postgres, mlx_lm, uvicorn) 없음.
- 검증 중 기동: V1의 `check-macho.sh`(정적 검사, 백그라운드 PID 17150, 완료 후 자연 종료), V2~V5 각각 `run-isolated.sh`가 `env -i`로 번들 `python3.12`를 직접 exec — 모두 스크립트 자체가 끝나면서 종료되는 단발 프로세스였다. 이 verifier가 별도로 데몬화한 서비스는 없다.
- 종료 후: `ps aux | grep -iE "python3.12|postgres|mlx_lm|uvicorn|check-macho" | grep -v grep` → 결과 없음 (남은 프로세스 없음).
