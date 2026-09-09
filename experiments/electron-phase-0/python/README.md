# Task 3 — Python·ML 런타임 후보

스펙 P0-C3이 요구하는 것: 개발 venv(`be/worker/.venv`)가 아닌 **독립** Python
3.12 런타임에 `models` extra 전량 + `mlx-lm` + `damwha_worker`를 넣고, **다른
절대 경로로 옮긴 뒤** 전부 import 되고 MPS가 잡히는가. 핵심 관찰 대상은 스펙이
적은 그대로 **"이동 전에는 되는데 이동 후에 깨지는 것"** 이다.

실측값은 전부 `docs/superpowers/reports/evidence/phase-0/`에 있다.

| 증거 | 내용 |
| --- | --- |
| `t3-candidates.txt` | 후보 4종 조사에서 **실제로 확인한 값** |
| `t3-g1-stage.txt` | 이동 **전** G1 (스테이징 자리에서) |
| `t3-relocation-symptom.txt` | 이동 직후 무엇이 죽는가 — 실제로 실행해 본 결과 |
| `t3-relocation-attempt1.txt` | 이동 **후** G1, 사후 처리 **전** |
| `t3-relocate-fix.txt` | 사후 처리가 무엇을 고쳤는지 전량 |
| `t3-g1-bundle.txt` | 사후 처리 **후** G1 |
| `t3-g1-bundle-after-verify.txt` | verify 넷을 돌린 뒤 다시 잰 G1 (차이는 `__pycache__`뿐) |
| `t3-imports*.txt`, `t3-mps*.txt`, `t3-selfreport*.txt`, `t3-versions*.txt` | 격리 실행 검증과 그 dyld 실측 |
| `t3-detector-recheck.txt` | `check-macho.sh`를 고친 뒤 Task 1 음성 대조군(V5)을 다시 돌린 기록 |
| `t3-dev-assets.txt` | 개발 자산 무변화 확인 (be/storage 매니페스트 동일) |

`t3-relocation-symptom.txt`는 **이미 relocate를 마친 번들을 한 번 더 옮겨서**
잰 것이다(`bundle/python` → `bundle/pytrial` → 되돌림). "옮길 때마다 사후
처리가 필요하다"는 아래 결론의 직접 증거이고, 이름을 원래대로 돌려놓으므로
번들 상태는 그대로다.

숫자로 본 전체 (한 번의 `build.sh all` 실행):

| | 파일 수 | 위반 | STALE-PATH | OTOOL-L | LC_RPATH | INFO | ALLOW |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 이동 전 (`stage/python`) | 33289 | **136** | 13 | 65 | 58 | 65 | 39 |
| 이동 후·사후 처리 전 | 33289 | **201** | 78 | 65 | 58 | 0 | 39 |
| 사후 처리 후 (`bundle/python`) | 33285 | **0** | 0 | 0 | 0 | 77 | 36 |

가운데 줄의 STALE-PATH가 13 → 78로 뛰고 INFO가 65 → 0으로 떨어지는 것이
**이동 때문에 생긴 것**의 전부다. 같은 65개 셔뱅 문자열이 이동 전에는 검사
대상 안을 가리켜 INFO였다가, 이동한 순간 검사 대상 밖을 가리켜 위반이 된다.

## 고른 것 — python-build-standalone + `uv pip install --python` (스펙 §9 후보 1)

```
CPython 3.12.11   cpython-3.12.11-macos-aarch64-none  (BUILD 20250902)
                  uv 0.8.16 이 내려받는 것과 같은 배포본
mlx-lm 0.31.3     mlx 0.32.2 — 개발 uv tool 설치본과 같은 버전
damwha_worker     be/worker 에서 만든 wheel 을 설치 (PYTHONPATH 아님)
models extra      pyproject.toml 의 == 고정 버전 그대로
```

`bin/python3.12`이 libpython을 `@executable_path/../lib/libpython3.12.dylib`로
참조하고 `LC_RPATH`가 없다. 실행 파일 위치에서 prefix를 다시 계산하므로 트리를
통째로 옮겨도 `sys.prefix`가 따라온다 — 실제로 옮긴 뒤 실측했다
(`t3-relocation-symptom.txt` ## 1).

**설치는 venv를 만들지 않고 이 배포본의 `site-packages`에 직접 한다.** 층이
하나라 절대 경로가 박히는 자리도 하나뿐이다.

세 경로를 일부러 다르게 둔다. Task 2의 `pg/build.sh`와 같은 이유다.

```
내려받은 자리 : $EXP/stage/pydist/cpython-3.12.11-macos-aarch64-none
스테이징      : $EXP/stage/python        (여기에 설치)
최종          : $EXP/bundle/python       (여기로 옮긴 뒤 모든 검증)
```

## 탈락시킨 것

**후보 2 — `uv venv --relocatable`.** *`--relocatable`이 상대화하는 것은
activate 스크립트뿐이다.* 두 번 재 봤다 (`t3-candidates.txt` ## 후보 2).

- 기본값으로 만들면 base로 **Homebrew의 `/opt/homebrew/opt/python@3.12`** 를
  잡는다. `bin/python3.12`이 거기로 가는 심볼릭 링크이고, 옮긴 뒤 `sys.base_prefix`가
  `/opt/homebrew/…/Python.framework/Versions/3.12`로 나온다. G1 금지 문자열
  두 개(`/opt/homebrew`, `Python.framework`)에 정면으로 걸린다.
- base를 후보 1의 배포본으로 지정해도 `pyvenv.cfg`의 `home`은 **절대 경로**로
  남는다. venv를 옮겨도 base는 옛 자리를 가리킨다.

즉 이 후보를 쓰려면 결국 후보 1의 배포본을 번들 안에 두어야 하고, 그 위에
`pyvenv.cfg`라는 절대 경로 층이 하나 더 생긴다. 얻는 것이 없다.

**후보 3 — PyInstaller / py2app.** 받아서 시도하지 않았다. 근거는 셋이다.

- **검증 대상이 사라진다.** P0-C8은 런타임이 스스로 보고하는 `sys.prefix` /
  `sys.path` / `sysconfig.get_paths()` / `site.getsitepackages()`를 본다.
  동결 번들은 그 값들이 실행 시점 임시 디렉터리(`_MEIxxxx`)나 앱 내부의
  가상 경로가 되어, "번들 밖을 가리키는 항목이 없는가"라는 질문 자체가
  다른 뜻이 된다. 스펙 §4.3이 계정 분리 대신 이 자기 보고를 채택했으므로
  거기를 흐리면 축 D 전체가 약해진다.
- **필요한 산출물 형태가 아니다.** 워커는 `mlx_lm.server`를 `subprocess`로
  부르고(`llm_server.py`), 설정 기본값이 실행 파일 이름이다
  (`config.py::lens_llm_server_bin`). embed는 uvicorn 서버다. 즉 **여러 개의
  독립 실행 진입점**이 필요한데 동결 번들은 하나의 실행 파일을 전제한다.
- **hook 유지 비용이 그대로 위험이다.** torch·mlx·pyannote·speechbrain은
  런타임에 데이터 파일과 동적 import에 크게 기댄다(`.metallib`, 모델 정의
  레지스트리). Phase 0의 목적은 "재배치가 되는가"를 재는 것이지 동결 도구의
  hook을 맞추는 것이 아니다.

**후보 4 — conda-pack.** *이 머신에 conda 계열이 없다* — `t3-candidates.txt`의
"후보 4" 절에 `conda`·`mamba`·`micromamba`가 전부 없고 `~/miniconda3`·
`~/anaconda3`도 없다는 실측이 있다. 도입하면 검증 대상이 아닌 머신 전역 설치물이 하나 더 늘어난다. 게다가
`models` extra는 PyPI의 `==` 고정 버전이라 conda 환경 안에서도 결국 pip으로
깔아야 하고, conda-pack이 제공하는 `conda-unpack`은 **재배치 후 사후 처리**
그 자체다 — 아래에서 보듯 그 사후 처리는 후보 1에서도 필요하므로, conda를
얹어서 없어지는 문제가 아니다.

## 재배치에서 실제로 깨진 것

`t3-relocation-attempt1.txt`가 이동 직후의 전수 결과다. 이동 전
(`t3-g1-stage.txt`)과 나란히 보면 무엇이 **이동 때문에** 생긴 것인지 갈린다.

### 깨진 것 1 — 콘솔 스크립트 셔뱅의 절대 경로 (R-9). 이동 즉시 전멸

스펙 §2가 지목한 `mlx_lm.server`가 정확히 이 형태다.

```
$ bundle/python/bin/mlx_lm.server --help
bad interpreter: …/stage/python/bin/python3.12: no such file or directory
$ head -1 bundle/python/bin/mlx_lm.server
#!…/stage/python/bin/python3.12
```

첫 이동(`stage/python` → `bundle/python`)의 잔존 셔뱅은
`t3-relocation-attempt1.txt`의 STALE-PATH 65건으로 남아 있고,
`t3-relocation-symptom.txt`는 사후 처리를 마친 번들을 **다시 한 번 옮겨**
같은 고장을 재현한 것이다. 두 번 다 65개 중 65개가 죽는다.

`bin/`의 셔뱅 스크립트 **65개 전부**가 인터프리터를 잃었다
(`t3-relocation-symptom.txt` ## 3 — 65개 중 65개). 거기에는 `mlx_lm.server`·`uvicorn`뿐 아니라
`damwha-worker`·`damwha-embed`(pyproject.toml의 `project.scripts`)도 들어 있다.
`lib/config.sh`의 `LENS_LLM_SERVER_BIN`이 가리키는 파일이 바로 이것이라, 고치지
않으면 Task 5가 시작도 못 한다.

고친 방법: `build.sh relocate`가 셔뱅 첫 줄만 현재 번들 경로로 다시 쓴다.

**셔뱅을 `#!/bin/sh` + 자기 위치 계산으로 바꾸는 방법은 쓰지 않았다.**
python-build-standalone 자신의 `bin/pip`·`bin/pydoc3`이 그 형태이고 재배치에는
강하지만, SIP가 `/bin/sh`를 exec할 때 `DYLD_*`를 지워 **Task 5의 dyld 실측이
통째로 끊긴다**(계획 규칙 2a). 계획 규칙 6c도 "셔뱅 스크립트의 dyld 메인
이미지는 셔뱅의 Python 인터프리터"를 전제한다. 그래서 커널이 번들 python을
직접 exec하는 형태를 유지하고 경로만 다시 쓴다. 그 `/bin/sh` 셔뱅 스크립트
5개는 어차피 빌드·개발 도구라 번들에서 뺐다.

### 깨진 것 2 — `_sysconfigdata`의 설치 시점 prefix

`uv`는 설치할 때 `_sysconfigdata__darwin_darwin.py`의 prefix 계열 값을 자기
설치 디렉터리로 다시 쓴다. 우리는 그 트리를 복사해 왔으므로 처음부터 어긋나
있었고(`t3-g1-stage.txt`의 STALE-PATH 13건 중 12건이 이 파일이다. 나머지 1건은
아래 `direct_url.json`), 이동 후에도 그대로다.

```
sysconfig.get_config_var('prefix')  →  …/stage/pydist/cpython-3.12.11-…
sys.prefix                          →  …/bundle/python
```

`sys.prefix`는 실행 파일 위치에서 다시 계산돼 맞는데 `sysconfig`는 틀린,
**두 값이 갈리는** 상태다. P0-C8이 보는 자리가 정확히 여기다.
`build.sh relocate`가 그 문자열을 현재 번들 경로로 치환하고, **치환 뒤 런타임에게
다시 물어** 값이 맞는지 확인한 결과까지 증거에 남긴다. (처음에는 이 파일을
홑따옴표 정규식으로 긁었는데 실제 표기가 겹따옴표라 조용히 아무것도 하지
않았다. 지금은 `sysconfig.get_config_var('prefix')`를 런타임에서 읽어 그
문자열을 치환한다 — 표기 형식에 기대지 않는다.)

### 깨진 것 3 — wheel 배포자의 빌드 머신 `LC_RPATH` 58건

이 Task에서 가장 실질적인 발견이다. **이동과 무관하게 처음부터 있었고**
(`t3-g1-stage.txt`), 재배치 검증을 하지 않았으면 드러나지 않았을 자리다.

| 남아 있던 rpath | 건수 | 어디 |
| --- | --- | --- |
| `/Users/runner/miniconda3/envs/build/lib` | 51 | scikit-learn 확장 모듈 |
| `/opt/homebrew/Cellar/gcc@13/13.4.0/…` | 3 | scipy `_fblas` |
| `/Users/ec2-user/runner/…/conda_environment_…/lib` | 2 | torchaudio |
| `/Users/runner/work/Pillow/Pillow/build/deps/darwin/lib` | 1 | Pillow `libjpeg` |
| `/tmp/vendor/lib` | 1 | PyAV `libsharpyuv` |

`LC_RPATH`는 **dyld의 실제 검색 경로**다. `/opt/homebrew/Cellar/gcc@13/…`는 이
머신에 실제로 존재할 수 있는 경로이고, 그 자리에 같은 이름의 dylib이 있으면
번들이 아니라 Homebrew 쪽이 열릴 수 있다. 스펙 §4.1이 `otool -L`과 별도로
`LC_RPATH`를 검사하게 한 이유 그대로다.

고친 방법: `install_name_tool -delete_rpath` 후 `codesign -f -s -` 재서명.

### 깨진 것 4 — wheel dylib의 자리표시자 `LC_ID_DYLIB` 64건

`delocate`가 넣은 `/DLC/<pkg>/.dylibs/<name>`, torch의
`/opt/llvm-openmp/lib/libomp.dylib`, protobuf의 `bazel-out/…` 이 그대로 남아
있다. 의존 참조는 전부 `@loader_path`/`@rpath`라 dyld가 이 id를 해석하는 일은
없지만, `otool -L`의 첫 줄로 나오므로 G1이 의존 경로와 함께 읽는다. Task 2가
pg의 dylib id를 `@rpath/`로 바꾼 것과 같은 처리를 했다 (`-id` + 재서명).

### 깨진 것 5 — `__pycache__`

번들 python을 한 번이라도 실행하면 `.pyc`가 생기고, 그 안에는 컴파일 시점의
소스 절대 경로와 모듈 문자열 상수가 그대로 들어간다. 위 2번을 고쳐도 옛
`.pyc`가 남아 있으면 검사에 그대로 잡힌다. `relocate`가 지운다.

여기에 검사기 쪽 함정이 하나 더 있었다. `.pyc`는 원본 `.py`의 문자열 상수를
그대로 담으므로, `.py`가 허용 목록에 있어도 그 `.pyc`는 **다른 경로**라 위반이
된다. 그러면 "V1을 V2~V5보다 먼저 돌리면 통과, 나중에 돌리면 실패"하는 —
**검사 순서에 따라 답이 달라지는** 검사기가 된다. 실제로 그 상태를 한 번
만들었다(위반 6건, 전부 `__pycache__` 안의 `mimetypes`·`ctypes.macholib.dyld`·
`soundfile`·`huggingface_hub._runtime`). `check-macho.sh`가
`…/__pycache__/X.cpython-312.pyc`를 `…/X.py`로 되짚어 원본의 분류를 따르게
해서 없앴다. 매핑은 그 한 방향뿐이고, 대응하는 `.py` 규칙이 없으면 여전히
위반이다. `t3-g1-bundle.txt`(relocate 직후)와 `t3-g1-bundle-after-verify.txt`
(verify 넷을 돌린 뒤)가 둘 다 위반 0건인 것이 그 확인이다.

**Phase 4 참고:** `/Applications` 아래의 앱 번들은 보통 쓰기 권한이 없어
Python이 `.pyc`를 만들지 못하고 조용히 건너뛴다. 즉 실제 앱에서는 이 문제가
"매 실행 재컴파일로 인한 기동 지연"으로 모습을 바꾼다. 빌드 시점에 미리
컴파일해 넣을지는 그때 판단할 문제이고, 넣는다면 **설치 경로로 컴파일해야**
한다.

### 깨지지 **않은** 것

- **`sys.prefix` 계산.** 실행 파일 위치 기준이라 이동 후에도 번들을 가리켰다.
  후보 1을 고른 이유가 이것이고, 실측으로 확인했다.
- **`otool -L`의 실제 의존 경로.** 번들 전체에서 `LC_LOAD_DYLIB`가 허용 접두사
  (`@rpath` / `@loader_path` / `@executable_path` / `/usr/lib` / `/System/Library`)
  밖을 가리킨 것은 **0건**이었다. 위 4번의 위반은 전부 의존이 아니라 id다.
  torch·mlx의 `.dylib`가 빌드 시점 절대 경로를 참조할까 봐 R-3이 걱정한
  자리인데, **그쪽은 깨지지 않았다.** 실제로 깨진 것은 rpath와 셔뱅이었다.
- **`.metallib`.** mlx는 `mlx/lib/mlx.metallib`을 패키지 상대 경로로 연다.
  이동 후 `import mlx` / `mps_available()`이 성립하는 것으로 확인된다
  (`t3-imports.txt`, `t3-mps.txt`).

## 결론: 이 런타임은 "복사만 하면 도는" 형태가 아니다

Phase 4에 넘길 가장 중요한 사실이다. **번들을 옮길 때마다
`build.sh relocate`에 해당하는 사후 처리가 한 번 필요하다.** 앱 패키징에서는
`.app` 안으로 복사한 **뒤에** 그 단계를 돌려야 하고, 그 결과물은 설치 위치가
`/Applications/Damwha.app`으로 고정된다는 가정 위에서만 유효하다. 사용자가
`.app`을 다른 디렉터리로 옮기면 셔뱅이 다시 깨진다.

Phase 4가 선택할 수 있는 방향은 둘이고, 판단은 그쪽 몫이다.

1. 설치 위치를 고정하고 빌드 시점에 셔뱅을 박는다. 지금 형태 그대로다.
2. 콘솔 스크립트를 아예 쓰지 않고 워커가 `python -m mlx_lm.server` 형태로
   부른다. 그러려면 `lens_llm_server_bin` 기본값과 `llm_server.py`의 호출
   방식을 바꿔야 하므로 **제품 코드 변경**이고, Phase 0의 범위 밖이다
   (스펙 §3.2).

## 번들에서 뺀 것

두 종류뿐이고 둘 다 디렉터리 단위다. `site-packages` 안은 건드리지 않았다 —
uv가 설치한 패키지 집합을 그대로 두어야 버전 대조와 재현이 성립한다.

| 종류 | 뺀 것 |
| --- | --- |
| 빌드 전용 | `include/`, `lib/pkgconfig`, `lib/python3.12/config-3.12-darwin`, `*-config` 스크립트, `share/man` |
| 쓰지 않는 서브시스템 | tcl/tk·tkinter·idlelib·turtledemo, `lib2to3`, `ensurepip`, `pip`(+`bin/pip*`), `bin/2to3*`·`bin/pydoc3*`·`bin/idle3*` |

부수 효과가 둘 있다. (1) tcl의 `libitcl`·`libthread`가 갖고 있던 **맨 파일명
install_name** 위반이 사라진다. (2) `/bin/sh` 셔뱅 스크립트가 번들에서 전부
없어져, `bin/`의 모든 스크립트가 번들 python을 직접 exec하는 형태로 통일된다
(계획 규칙 6c의 전제).

## G1 문자열 검사와 스펙 §4.1의 긴장 — `lib/g1-allowlist.txt`

스펙 §4.1은 "어떤 파일에도 금지 문자열이 나타나지 않아야 한다"고 적었고,
Task 2의 PostgreSQL은 그대로 위반 0건으로 끝났다. **우리가 빌드한 산출물**이기
때문이다. Python·ML 런타임은 다르다. CPython 표준 라이브러리와 제3자 wheel
수백 개에 다음이 **구조적으로** 들어 있다.

| 종류 | 예 | 실행 영향 |
| --- | --- | --- |
| 독스트링·예제·패키지 문서 | `site.py`의 `/usr/local/lib/python2.5/…` | 없음 |
| 다른 플랫폼용 코드 분기 | `torch/backends/xeon/run_cpu.py` | 없음 (macOS에서 실행 안 됨) |
| 배포자의 빌드 머신 경로 문자열 | scipy `.so` 안의 gcc 경로 | 없음 (rpath는 지웠다) |
| ctypes/dlopen 폴백 목록 | `soundfile.py`, `ctypes/macholib/dyld.py`, PIL fribidi | **있음** — 번들에서 못 찾을 때만 |

마지막 줄만 실제 동작이고, 그것도 폴백이다. 그리고 `site.py`·`mimetypes.py`·
`ctypes/macholib/dyld.py`는 **어떤 CPython 배포본에나** 있으므로, 문자 그대로의
0건은 Python 런타임에서 달성 불가능하다. 지우면 표준 라이브러리가 아니게 된다.

그래서 셋을 갈랐다.

1. **재배치를 깨는 것**(STALE-PATH·OTOOL-L·LC_RPATH)은 전부 **고쳤다.**
   허용 목록에 하나도 넣지 않았다. 이것이 P0-C3의 본론이다.
2. **뺄 수 있는 것**은 뺐다 (위 "번들에서 뺀 것" — `pip`이 여기서 빠지면서
   vendored `platformdirs`의 `/opt/homebrew`도 함께 사라졌다).
3. 남은 것만 `lib/g1-allowlist.txt`에 **(상대 경로, 금지 문자열, 근거)** 로
   분류해 남겼다. `check-macho.sh`는 이 목록에 걸린 적중을 숨기지 않고
   `ALLOW <파일>: <토큰> (근거: …)` 로 매 회차 출력한다.

경로를 반드시 적게 해서 전역 면제가 생기지 않게 했다 — **같은 문자열이 다른
파일에 나타나면 여전히 위반**이고, `bundle/pg`처럼 상대 경로가 다른 검사
대상에는 이 목록의 어떤 줄도 걸리지 않는다. Task 1의 README가 "허용하기로
정하면 그때 근거를 적고 넓힌다"고 남긴 자리를 그대로 쓴 것이다.

**이것은 스펙 §4.1을 문자 그대로 충족하지 못했다는 뜻이다.** 결과 문서가
그렇게 적어야 하고, 실동작 폴백 3건(`soundfile`, `ctypes.macholib.dyld`,
PIL fribidi)은 Phase 4 인계 목록에 남는다. 실제로 로드되지 않는다는 것은
G2 dyld 실측과 P0-C8 자기 보고가 따로 확인한다(`t3-selfreport.txt`의
"로드된 이미지 … 허용 밖 0개").

## 용량

| | 크기 | 비고 |
| --- | --- | --- |
| 내려받은 배포본 (`stage/pydist`) | 47 MiB | 재사용, 번들에 들어가지 않는다 |
| 가지치기 전 `stage/python` | 1413 MiB | |
| 가지치기 후 = `bundle/python` (relocate 직후) | 1392 MiB | 파일 33285개 |
| `bundle/python` (verify 넷을 돌린 뒤) | 1509 MiB | `__pycache__` 5137개 파일이 늘었다 |

상위 다섯: torch 411 MiB, mlx 203 MiB, llvmlite 124 MiB, scipy 81 MiB,
onnxruntime 75 MiB. **모델은 하나도 들어 있지 않다** — 코드만이다. 모델 용량은
Task 9(P0-C13)가 잰다.

llvmlite·onnxruntime·pandas·matplotlib·fontTools 같은 것은 우리가 직접 쓰지
않는데 `models` extra의 전이 의존으로 딸려 온다(numba ← silero-vad,
onnxruntime ← silero-vad, matplotlib ← pyannote). 줄일 여지가 있지만 Phase 0의
질문이 아니라 손대지 않았다 — `site-packages`를 그대로 두는 것이 버전 대조와
재현의 전제다.

## 뒤 Task가 알아야 하는 것

1. **`bundle/python/bin/mlx_lm.server`가 존재하고 셔뱅이 번들 python이다.**
   `lib/config.sh`의 `ISO_LENS_LLM_SERVER_BIN`이 이미 그 경로를 가리킨다.
   Task 5의 런처는 그것을 **직접 exec**하면 된다 — 커널이 셔뱅의 번들 python을
   exec하므로 `DYLD_*`가 살아 있고, dyld의 메인 이미지는 `bundle/python/bin/python3.12`가
   된다. 판정은 계획 규칙 6c대로 `bundle/python/` **접두사**로 한다
   (`verify/t3-lib.sh::t3_assert_dyld_measured`가 그 형태다).
2. **`uvicorn`도 같은 자리에 있다.** embed 서비스는 `damwha-embed` 또는
   `uvicorn` 어느 쪽으로 띄워도 번들 안이다.
3. **`bundle/python`을 옮기면 `build.sh relocate`를 다시 돌려야 한다.**
   그냥 `mv` 하고 검증하면 65개 스크립트가 전부 죽은 상태로 시작한다.
4. **`uv pip install`은 `--link-mode=copy`로 해야 한다.** 기본 하드링크면
   설치 파일이 개발자 uv 캐시의 inode를 공유하고, 그 캐시는 **개발
   venv(`be/worker/.venv`)에도 하드링크돼 있다.** `install_name_tool`로 번들
   Mach-O를 고치는 순간 개발 venv의 같은 파일이 함께 바뀐다 (스펙 §4.4 금지).
5. **G1 전수 검사는 오래 걸린다.** 파일 3만 3천 개·Mach-O 460개라 한 번에
   10분 안팎이다. Verify를 돌리는 쪽은 그것을 예상하고 시작해야 한다.
6. **모델은 하나도 들어 있지 않다.** 이 번들은 코드뿐이다. HF 캐시는 격리
   실행의 `HF_HOME`(샌드박스)으로 가고, 그 다운로드는 Task 9가 잰다.
