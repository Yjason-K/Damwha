# Electron Phase 4 — Python·ML 실행 환경 내장 결과

브랜치: `feat/electron-migration-phase-4-embedded-python-runtime`
분기점: `f71a888`
스펙: [2026-09-16-electron-phase-4-embedded-python-runtime-design.md](../specs/2026-09-16-electron-phase-4-embedded-python-runtime-design.md)
계획: [Part 1 — 번들 런타임](../plans/2026-09-16-electron-phase-4-bundled-runtime.md) · [Part 2 — 실행 통합](../plans/2026-09-16-electron-phase-4-runtime-integration.md)
로드맵: [electron-migration-roadmap.md](../../electron-migration-roadmap.md) § "Phase 4. Python·ML 실행 환경 내장"

**상태 (2026-09-19): Phase 4는 완료다.** Part 1(번들 런타임, Task 1~7)과 Part 2(실행 통합,
Task 1~12 + 9b)를 구현·단계별 리뷰·최종 전체 리뷰·수정 파동·통합 검증까지 마쳤다.
스펙 완료 기준 **30건 중 29건 판정 완료, 미충족 0**이다. 남은 하나는 P4-C2의 절반(토큰 문자열
전수 grep)으로, **토큰 원문을 쥔 사용자만 실행할 수 있다**(§12.9).

**이 문서는 §1~§11이 Part 1, §12가 Part 2다.** Part 1의 서술은 그때의 기록으로 보존하고 고치지
않았다 — 아래 §1이 "Part 2는 미착수"를 전제로 쓴 문장을 만나면 §12를 본다. 로드맵 §6이 요구하는
네 기록 중 스펙 리뷰와 **Part 1 계획 검증**은 스펙 §17에, **단계별 실행·리뷰**와 완료 조건 판정은
이 문서에 있다. **실행하지 않은 검증을 성공으로 가정하지 않는다** — 밟지 않은 표면은 Part 1이 §11,
Part 2가 §12.8에 "미검증"으로 따로 적었다.

Phase 4의 스펙 완료 기준 30건 중 **Part 1이 만든 것은 넷**이다 — P4-C15(번들 위생), P4-C25(mlx
정렬 회귀), P4-C26·C27의 **기준선**, P4-C28(numba). 나머지는 Part 2가 만들었고 판정은 Part 2의
마지막 Task가 한꺼번에 했다(§12.4).

**Part 2 계획의 검증은 §17에 없다.** 5·6·7회차의 대상은 제목 그대로 "Part 1 계획 + 이 스펙"이고,
1~4회차는 **분할 이전의 통합 계획**(5,249줄)을 봤다. 분할(§17.5)은 자르기만 한 것이 아니라
Part 2의 서술 방식을 바꿨으므로("시그니처·계약·테스트 표만 싣고 구현 본문은 구현 시 작성"),
1~4회차가 본 텍스트와 지금의 Part 2는 같지 않다. 분할 후 Part 2 파일은 2커밋에서 21줄(+20/-1)만
바뀌었고 그것도 Part 1 리뷰의 파급이었다. **Part 2는 실행 전에 계획 검증을 따로 받아야 한다**
(로드맵 §4·§5).

**실제로 받은 것은 계획 검증이 아니라 사전 충돌 스캔이다.** Part 2 착수 시점(2026-09-17)에
Task별 자기 일관성과 공유 파일·인터페이스 쌍을 훑어 룰링 여덟(R-P1~R-P8, §12.2)으로 닫았고,
남은 판단은 Task 실행 중 룰링으로 처리했다. 그 차이를 여기에 적어 둔다.

---

## 1. 개요 — Part 1이 만든 것

Part 1은 **빌드 산출물과 그 산출물이 도는 것을 빌드 시점에 증명하는 검사**만 만든다. 앱 코드는
한 줄도 바꾸지 않았다 — 런처·env 주입·고아 처분·모델 준비·토큰 온보딩은 전부 Part 2다.

| 산출물 | 무엇 |
| --- | --- |
| `desktop/scripts/phase4-baseline.sh` | 데이터 안전 기준선(절대 불변 `abs-*` 8건 + 허용 변경 + 앱 데이터) 찍기·대조 |
| `desktop/scripts/probe-numba.sh` + `numba-probe/*.py` | numba LLVM MCJIT이 hardened runtime에서 사는지 가르는 측정 |
| `desktop/build-resources/entitlements.python.plist` | 번들 Python 트리·ffmpeg용 — 최소 집합 **둘** |
| `desktop/build-resources/entitlements.mac.plist` | `.app` 본체용 — 위 둘 + `allow-jit` |
| `be/worker/pyproject.toml`·`uv.lock` | `mlx==0.31.2`·`mlx-lm==0.31.3` 매니페스트 고정 |
| `desktop/scripts/build-ffmpeg.sh` + `ffmpeg-checksums.txt` | ffmpeg 9.0.1 LGPL 2.1 정적 빌드 |
| `desktop/scripts/build-python.sh` + `python-checksums.txt` | Python 3.12.11 + 의존성 1.3 GB, 캐시 2층(rt·wk), 재배치·전수 서명 |
| `desktop/scripts/package.mjs`(수정) | 세 빌드 호출 + 서명 3단(안쪽 → 바깥쪽) |
| `desktop/scripts/check-bundle.mjs`(수정) | 번들 위생 검사 14건 → **31건** |
| `desktop/CLAUDE.md`·`electron-builder.yml`(수정) | 번들 넷·빌드 스크립트 셋·plist 둘을 문서에 맞춤 |

결과물은 `Contents/Resources/` 아래 넷(`api`·`postgres`·`python`·`ffmpeg`)을 실은 **1.8 GB의
`.app`**이고, Mach-O 454개가 전부 hardened runtime으로 서명돼 있으며, 번들 어디에도 이 저장소의
절대 경로가 없다.

**이 Phase가 뒤집은 Phase 0의 전제 하나.** Phase 0의 `python-build.sh`는 "한 최종 위치에서
relocate 한 번"을 전제로 쓰였다. Phase 4의 산출물은 dev(`desktop/build/python`)와
packaged(`.app/Contents/Resources/python`) **두 자리**에 놓이므로 어떤 절대 경로도 옳지 않다 —
셔뱅은 위치 독립 폴리글랏, `_sysconfigdata`의 prefix는 중립 자리표시자
`/damwha-bundled-python`, `direct_url.json`은 삭제다(스펙 §6.1-b).

---

## 2. 커밋과 Task의 연결

`f71a888..197ab7d`, **13커밋.** 로드맵 §"브랜치 운영 방식"이 요구하는 단계↔커밋 연결이다.

| 단계 | 커밋(범위) | 제목 | 비고 |
| --- | --- | --- | --- |
| Task 1 — 기준선 | `f71a888..db3f0a8` | `chore(desktop): Phase 4 데이터 안전 기준선 스크립트를 더한다` | 이전 세션 |
| Task 2 — numba 측정 | `db3f0a8..0f94a50` | `chore(desktop): numba JIT이 hardened runtime에서 사는지 가르는 프로브를 더한다` | 이전 세션 |
| 계획·스펙 5회차 리뷰 반영 | `0f94a50..86c74e1` | `fix(desktop): 5회차 리뷰의 blocking 5건을 닫고 entitlement를 둘로 가른다` | `entitlements.python.plist` 신설 |
| 계획·스펙 6회차 리뷰 반영 | `86c74e1..c9765b7` | `fix(desktop): 5회차의 오진 2건을 철회하고 6회차 지적을 반영한다` | 도구 오염 판정 |
| 계획·스펙 7회차 리뷰 반영 | `c9765b7..46bc7c2` | `docs: 7회차 리뷰의 important 5건과 minor 9건을 닫는다` | 계획 확정 |
| Task 3 — 매니페스트 고정 | `46bc7c2..fdd3440` | `fix(worker): mlx-lm과 mlx를 매니페스트에 고정한다` | 수정 라운드 0 |
| Task 4 — ffmpeg 빌드 | `fdd3440..eaeee4b` | `feat(desktop): 내장 ffmpeg 빌드 스크립트를 더한다` | 수정 라운드 0 |
| Task 5 — Python 런타임 층 | `eaeee4b..17b1814` | `feat(desktop): 내장 Python 런타임 빌드 스크립트를 더한다 (런타임 층)` | 수정 라운드 0 |
| Task 6 — worker 층·스테이징 | `17b1814..bd4eaac` | `feat(desktop): Python 빌드에 worker 층과 진입점 확인을 더한다` | **수정 라운드 1** |
| Task 6 수정 라운드 1 | `bd4eaac..070ea2b` | `fix(desktop): 진입점 확인을 번들 단독으로 격리하고 가드 둘을 조인다` | R-10·R-11·R-12 |
| Task 7 — 패키징·서명·위생 | `070ea2b..f5dfea1` | `feat(desktop): Python·ffmpeg를 번들에 싣고 hardened runtime으로 서명한다` | 수정 라운드 0 |
| 최종 리뷰 수정 (코드) | `f5dfea1..faaed64` | `fix(desktop): ffmpeg 서명 계약에 회귀 가드를 두고 codesign 사유를 남긴다` | I-1 + 격상 Minor |
| 최종 리뷰 수정 (문서) | `faaed64..197ab7d` | `docs(desktop): 번들 넷·빌드 스크립트 셋·plist 둘을 문서에 맞춘다` | I-2 |

Task 1·2는 이전 세션에서 끝났고, 그 뒤 계획·스펙이 외부 리뷰 5·6·7회차를 받으며 세 커밋
(`86c74e1`·`c9765b7`·`46bc7c2`)으로 확정됐다. **entitlement plist가 둘로 갈린 것은 5회차
blocking B-1의 산물**이고 그것이 Task 2의 실제 산출물이므로, 그 커밋은 계획 수정이면서 동시에
Task 2의 일부다.

Task 3~7은 **Subagent-Driven Development**로 돌렸다 — Task마다 새 구현자를 붙이고, 그 diff만
보는 리뷰어를 따로 붙였다. 판정(Ruling)은 전부 원장
(`.superpowers/sdd/2026-09-16-electron-phase-4-bundled-runtime/progress.md`)에 남겼고 §6에 옮겼다.
수정 루프 상한은 로드맵 규칙대로 3회, 실제로 연 것은 Task 6의 1회뿐이다.

---

## 3. 검증 환경과 결과

### 3.1 측정 도구 — `/usr/bin/` 절대 경로

**판정에 쓴 `grep`·`find`·`diff`는 전부 `/usr/bin/` 절대 경로로 불렀다.** 이 저장소의 대화형
zsh에서 셋 다 셸 **함수**이고 `grep`은 `ugrep -I`로 도는데, `-I`는 바이너리를 건너뛴다 — 1.3 GB
바이너리 트리에서 그것은 판정을 통째로 뒤집는다. **5회차 리뷰의 blocking 5건 중 2건이 정확히 이
오염의 산물**이었고 6회차가 그것을 철회했다(스펙 §17.8 BL-2, §17.9). 컨트롤러 룰링 R-5가 이
규칙을 Task 3~7 전체에 걸었다.

반대로 **빌드 스크립트 본문 안의 맨몸 호출은 손대지 않았다.** `#!/bin/bash` 스크립트는 대화형
zsh의 함수를 상속하지 않는다 — 최종 리뷰가 그것을 실측으로 확인했다
(`bash -c 'command -v grep'` → `/usr/bin/grep`).

`check-bundle.mjs`의 `spawnSync("grep", …)`도 셸을 거치지 않아 PATH의 진짜 BSD grep
(2.6.0-FreeBSD)을 받는다. 리뷰어가 격리 트리에서 needle을 바이너리에 심어 재현했고 `-rlF`·
`-ralF` 둘 다 동일하게 잡았다 — 5회차의 "검사가 바이너리를 건너뛴다"가 오진이었다는 6회차
판정을 뒷받침한다.

### 3.2 데이터 안전 기준선

`bash desktop/scripts/phase4-baseline.sh baseline`을 **첫 Task보다 먼저** 찍었다(2026-09-16,
rc=0, 7.9초, 산출 13개). 절대 불변은 `abs-*` 8건이다 — `be/.env`·`be/worker/.env`·`fe/.env`·
`~/.cache/huggingface`·Docker 볼륨 `damwha_pgdata`의 행 수·`be/storage`·`<userData>/storage/`·
`~/.local/share/uv/tools`.

**Task 3·4·5·6·7의 끝과 최종 수정 파동의 끝에서 매번 `verify`를 돌렸고 8건 전부 PASS, SKIP·FAIL
0이다.** 기준선을 뜰 때 `app-db-rows.txt`만 `MEASUREMENT-UNAVAILABLE (embedded psql)`로 남았는데
(앱 내장 클러스터가 떠 있지 않았다) 그것은 앱 데이터 쪽이고 `abs-*`가 아니다.

**Part 2 계획 검증이 그 파일에서 결함 둘을 더 찾았다(2026-09-17에 고쳤다).** 첫째, 측정 질의가
`select 'meeting='||count(*) from meeting` 한 줄이라 **회의 ID를 담지 않았다** — 스펙 §9의
P4-C27이 "회의 **ID**·행 수·체크섬"을 요구하므로 재촬영해도 ID 대조가 불가능했고, 행 수만으로는
"하나 지우고 하나 넣었다"가 통과한다. `abs-docker-db-rows.txt`와 같은 방식의 **전체 테이블** 행
수로 바꾸고 `app-meeting-ids.txt`를 따로 뒀다. 둘째, 한 부류만 다시 뜰 방법이 없어 `baseline`을
재실행하면 `abs-*` 8건과 `mut-*` 3건까지 덮어썼다 — `retake <app|hf>` 모드를 더해 국한시켰다.
산출은 13개 → **14개**다.

허용 변경 둘(`be/worker/.venv`, `~/.local/bin/mlx_lm.server`)은 자동 판정하지 않고 사람이
대조했다. 구간 전체에서 실제로 움직인 것은 **Task 3의 `uv lock`·`uv sync` 하나**다
(`mut-uv.lock`에 `mlx`·`mlx-lm` 추가, `.venv`에 `mlx-lm 0.31.3`·`sounddevice 0.5.2` 설치).

**Docker 개발 DB에는 읽기 질의만 발행했다.** Task 3의 요약 검증이 `mtg_34`의 28발화를 SELECT로
가져왔고, 그 뒤 `job=94`·`meeting_summary=12`가 기준선과 바이트 단위로 같음을 확인했다.
리뷰어가 같은 두 행 수를 **직접 재질의해 독립 확인**했다.

#### 3.2-a Part 1 종료 뒤 `~/.cache/huggingface`가 Phase 4 밖의 요인으로 바뀌었다 (2026-09-17)

Part 2 계획 검증 중에 돌린 `verify`가 `FAIL abs-hf-cache.txt`를 냈다. 기준선 187줄 → 105줄,
**파일 66개(lock 제외) 16.7 GiB가 사라졌고 새로 생긴 것은 0건**이다. 디스크 여유가 12 → 34 GiB로
늘어난 것이 같은 원인이다.

**Part 1의 작업이 아니다.** Part 1의 어느 Task도 이 경로에 쓰기를 하지 않았고, Task 3·4·5·6·7과
최종 수정 파동의 끝에서 매번 돌린 `verify`가 그때마다 `abs-hf-cache` PASS를 냈다. 그 8건 PASS가
이 변경이 Part 1 구간 **이후**임을 시간으로 가른다.

사라진 모델 저장소 여덟은 **전부 평가·구세대 모델이고 프로덕션 파이프라인이 참조하지 않는다**:

| 저장소 | 무엇 |
| --- | --- |
| `facebook/nllb-200-distilled-600M` | 번역 실험 |
| `Helsinki-NLP/opus-mt-tc-big-en-ko` | 번역 실험 |
| `mlx-community/Qwen3-ASR-0.6B-bf16`·`1.7B-bf16` | `be/worker/SMOKE.md`의 "Qwen3-ASR 도입 검토" (미채택) |
| `lmstudio-community/gemma-4-E4B-it-MLX-4bit` | 대안 LLM |
| `pyannote/speaker-diarization-3.1`·`segmentation-3.0`·`wespeaker-voxceleb-resnet34-LM` | 옛 3.1 화자분리 스택 |

파이프라인이 실제로 쓰는 것은 전부 남아 있다 — `whisper-large-v3-mlx`(2.9 G),
`BAAI/bge-m3`(4.3 G), `Qwen3.5-4B-8bit`·`9B-8bit`, `whisper-large-v3-turbo`,
`speechbrain/spkrec-ecapa-voxceleb`(85 M), 그리고 **`pyannote/speaker-diarization-community-1`**.
화자분리 기본값이 `community-1`인 것은 `be/worker/damwha_worker/models/pyannote_diar.py:3`이
못 박는다 — 삭제된 `3.1` 스택은 코드 어디에서도 참조되지 않는다(`/usr/bin/grep -rn` 0건).

**조치:** 사용자 판단으로 `abs-hf-cache.txt` **하나만** 다시 떴다. 그 목적의 모드를 스크립트에
더했다 — `phase4-baseline.sh retake hf`. `baseline`을 다시 부르면 `mut-uv.lock`(Part 1이 `.venv`를
바꾸기 **전** 사본이자 유일한 복구 경로)까지 덮어쓰기 때문이다. 재촬영 뒤 `verify`가 **8건 전부
PASS**로 돌아왔고, 나머지 `abs-*` 7건과 `mut-*` 3건은 원래 값 그대로다.

**P4-C26의 판정 기준이 이 시점부터 새 기준선이다.** Part 2가 대조하는 `~/.cache/huggingface`의
기준은 2026-09-16이 아니라 2026-09-17의 105줄이다.

### 3.3 Task 1 — 기준선 (커밋 `db3f0a8`)

- `baseline` rc=0, 7.9초, 산출 13개.
- 탐지 실증: 기준선 **사본**의 `now/`를 조작 → `FAIL abs-be-env.txt` + `< probe-line`. 조작
  대상을 사본으로 한 이유는 `be/.gitignore:7`이 `be/.env`를 무시해 `git checkout`으로 되돌릴 수
  없기 때문이다(3회차 리뷰의 실측).
- Review 6항 전부 통과 — 2026-09-16, 메인 세션.

### 3.4 Task 2 — numba 사망 지점 (커밋 `0f94a50`, `86c74e1`)

**판정: `survives`.** 최소 집합 둘로 numba LLVM MCJIT이 hardened runtime 아래서 산다. 세 프로브를
각각 **별개 프로세스**로 돌렸다(한 프로세스에서 셋을 다 한 Phase 0의 실수를 피한다). 잠금 버전
(numba 0.65.1 · llvmlite 0.47.0 · numpy 2.4.6)만 `/tmp/numba-probe`에 격리 설치했고 Mach-O 42개를
서명했다.

| entitlement 집합 | 결과 | 죽는 지점 |
| --- | --- | --- |
| 서명 없음 (대조군) | 3/3 통과 | — |
| hardened runtime, 키 0개 | **rc=134 SIGABRT** | dyld — `mapping process and mapped file (non-platform) have different Team IDs` |
| `disable-library-validation`만 | **rc=137 SIGKILL** | **`import numba`** — W+X 매핑 거부 |
| 최소 집합 (둘 다) | 3/3 통과 | — |

**둘 다 load-bearing이고 서로 다른 지점에서 그렇다.** 그리고 `allow-unsigned-executable-memory`가
필요한 곳은 **호출이 아니라 import**다 — LLVM이 모듈 로드 시점에 실행 메모리를 잡는다. Phase 0
R-4가 적은 "메시지 없는 SIGKILL"이 그대로 재현됐다.

**Step 6-c — 같은 entitlement를 `.app`에 주면 앱이 죽는다** (5회차 blocking B-1). Electron
44.3.0 사본 3벌로 쟀다.

| 서명 | 실행 rc | 결과 |
| --- | --- | --- |
| 손 안 댐 (대조군) | 0 | `RESULT JS-OK 2` |
| 최소 집합 (= Python용 plist) | **133** | `Fatal process out of memory: Failed to reserve virtual memory for CodeRange` |
| `.app`용 plist (+`allow-jit`) | 0 | `RESULT JS-OK 2`, `flags=0x10002(adhoc,runtime)`, 키 셋 |

`--deep`이 Electron Framework와 헬퍼에도 hardened runtime을 걸기 때문이다. **plist가 둘인 이유가
이 측정**이다. `allow-jit`을 더한 plist로 numba 프로브를 다시 돌려도 `survives`이지만, 트리에는
권한 최소화로 최소 집합만 준다.

**부수 실측 — entitlements plist의 XML 주석에 하이픈 두 개를 연달아 쓰면 `codesign`이 rc=1로
실패한다**(`Failed to parse entitlements: AMFIUnserializeXML: syntax error near line N`). `plutil
-lint`는 그것을 통과시키고, **서명에 실패한 `.app`도 linker-signed 상태로 그냥 실행된다** — 실행
성공을 서명 성공으로 읽으면 거짓 통과가 난다. 계획 작성 중 주석에 `codesign --deep`을 적었다가
그대로 당했다.

Review 8항 전부 통과 — 2026-09-16, 메인 세션.

### 3.5 Task 3 — `mlx-lm`·`mlx` 매니페스트 고정 (`fdd3440`)

2026-09-16까지 `mlx-lm`은 `pyproject.toml`·`uv.lock`·`.venv` **어디에도 없었고** 렌즈·요약이
`uv tool install mlx-lm`으로 깐 `~/.local/bin/mlx_lm.server`(Python 3.14.7 + mlx 0.32.2)에
의존했다(스펙 §2.4). 개발 도구가 없는 맥에는 그 경로가 없다.

| 항목 | 실측 |
| --- | --- |
| `uv lock` | `Resolved 163 packages in 618ms`, `Added mlx-lm v0.31.3`. `uv.lock` +24줄 |
| `pnpm worker:sync` | `+ mlx-lm==0.31.3`, `+ sounddevice==0.5.2`, `~ damwha-worker==0.2.3` |
| 버전 대조 | `mlx 0.31.2`·`torch 2.12.1`·`numpy 2.4.6`·`numba 0.65.1`·`llvmlite 0.47.0` 불변, `mlx-lm MISSING → 0.31.3` 한 줄만 바뀜 |
| `pnpm worker:test` | **526 passed**, 3 warnings, 44.02s |
| `uv run ruff check .` | `All checks passed!` |
| 요약 실구동 | `mlx_lm.server`(Qwen3.5-4B-8bit, `--no-sync`, :18091) + `SummaryClient.summarize()`를 `mtg_34` 28발화로 구동 → topics 4개 + segments 4묶음 출력 |

**`mlx-lm 0.31.3 + mlx 0.31.2` 조합은 이 맥에서 한 번도 돈 적이 없었다** — 이 실행이 처음이다.
DB에는 아무것도 쓰지 않았다(§3.2).

### 3.6 Task 4 — ffmpeg (`eaeee4b`)

Phase 0 원본(`reference/electron-phase-0/ffmpeg-fetch.sh`)과 버전·configure 플래그 14개·체크섬·
라이선스 검사 대상(configure stdout)이 같다. 원본이 "기록만" 하던 두 지점(라이선스, 정적 링크)에
`die` 게이트를 얹었다.

| 항목 | 실측 |
| --- | --- |
| 버전·라이선스 | ffmpeg **9.0.1**, `License: LGPL version 2.1 or later`. `config.mak`에 `!CONFIG_GPL=yes`(비활성) |
| 1차 빌드 | 빌드 105초, zsh `time` total **1:46.98** |
| 2차 실행 | **0.025초** — 캐시 적중 `ffmpeg-0e6637c2bdc24ad3` |
| `otool -L` | 외부 의존 16개 전부 `/usr/lib`·`/System/Library` |
| `LC_RPATH` | **0건** (커맨드 자체가 없다) |
| 크기 | `desktop/build/ffmpeg` **42M** (`bin/ffmpeg`·`bin/ffprobe`만) |
| 파이프라인 | `mtg_34/original.m4a`(읽기 전용) → FLAC **16000 Hz / 1ch / s16** |
| 저장소 경로 | `/usr/bin/grep -rlF "$(pwd)"` **0건**. `BUILD_PREFIX` 문자열은 `-version`의 `configuration:` 자기 보고 줄에만 있다 |

`be/storage/meetings/mtg_34/original.m4a`의 mtime이 전후로 불변이다.

### 3.7 Task 5 — Python 런타임 층 (`17b1814`)

`build-python.sh` 527줄. python-build-standalone 3.12.11(릴리스 `20250818`)의 `install_only`
아카이브를 받아 업스트림 `SHA256SUMS`와 대조하고(`fabb5fd4…e478` 일치), `uv export` 목록을 venv
없이 배포본 `site-packages`에 직접 설치한 뒤 가지치기 → 재배치 → Mach-O 정규화 → 전수 서명 →
검증 → `__pycache__` 정리를 한다.

| 단계 | 실측 | 7회차 프로토타입 실측과 대조 |
| --- | --- | --- |
| `uv export` | 153개 패키지, 설치 131개 | — |
| 가지치기 | 30개 항목 제거, 1,395,776 KiB → **1,374,476 KiB** | 30건 일치 |
| 셔뱅 | **62개 재작성** / 0개 이미 폴리글랏 / **0개 미처리** | 46개(프로토타입은 설치 집합이 달랐다) |
| `_sysconfigdata` prefix | `/install` → `/damwha-bundled-python` | **35회** 치환 |
| `direct_url.json` | rt 층 0개(로컬 경로 설치 없음) | 1건(wk 층에서 나온다) |
| Mach-O | **454개** | 454개 일치 |
| `LC_RPATH` | **86건 삭제 / 84개 파일 재서명** | 86건/84파일 일치 |
| `LC_ID_DYLIB` | **58건 정규화** | 58건 일치 |
| 전수 서명 | 454개 (`--options runtime`, python plist) | 454/454 |
| `--verify --arch arm64` | 454개 중 **실패 0건**, arm64 슬라이스 없음 0건 | 0 실패 |
| `__pycache__` | 5개 디렉터리 삭제, 남은 `.pyc` **0개** | — |
| 빌드 시간 | **138초** (`~/.cache/uv` 온난) | — |

**`LC_RPATH` 86건의 출처** (`/usr/bin/grep '^  LC_RPATH 삭제' | sed | sort | uniq -c`):

```
  51 /Users/runner/miniconda3/envs/build/lib
  15 /opt/homebrew/opt/ffmpeg/lib
  13 /Users/runner/miniconda3/envs/test/lib
   2 /Users/ec2-user/runner/_work/_temp/conda_environment_23408961961/lib
   1 /Users/runner/work/Pillow/Pillow/build/deps/darwin/lib
   1 /tmp/vendor/lib
   1 /opt/homebrew/Cellar/gcc@13/13.4.0/lib/gcc/13/gcc/aarch64-apple-darwin23/13
   1 /opt/homebrew/Cellar/gcc@13/13.4.0/lib/gcc/13/gcc
   1 /opt/homebrew/Cellar/gcc@13/13.4.0/lib/gcc/13
```

`/Users/runner/miniconda3` **64건**(51+13), `/opt/homebrew/opt/ffmpeg/lib` **15건**, `gcc@13`
**3건** — 스펙 §17.10의 사전 실측과 같다. **전부 wheel 배포자의 빌드 머신 경로다.** 3회차가
`LC_RPATH` 필터를 `BUILD_PREFIX` 매칭이 아니라 "번들 밖 전부"로 고집한 결정이 여기서 정당해진다
— `BUILD_PREFIX`였다면 한 건도 못 잡았다.

**재배치가 실제로 자리 독립인지 — 원본을 치우고 쟀다.**

```
$ cp -R "$RT" /tmp/py-moved && mv "$RT" "${RT}.hidden"
$ /tmp/py-moved/bin/python3.12 -c "import sys, torch; print('OK', sys.prefix)"
OK /tmp/py-moved          rc=0
```

- 재작성된 셔뱅 62개가 계약 형태와 **바이트 단위로 같다**: `#!/bin/sh` / `'''exec' "${0%/*}/python3.12" "$0" "$@"` / `' '''`.
- `env -i PATH="/tmp/py-moved/bin" HOME=/tmp` — 즉 **`/usr/bin`이 없는 PATH**에서 `alembic
  --version`·`mlx_lm.server --help` 정상. `dirname: command not found`도 `/python3.12: not
  found`도 나오지 않는다(셔뱅이 외부 명령에 의존하지 않는다).
- **공백이 든 경로**(`/tmp/py spaced/python`)에서도 rc=0.
- 파이프라인 모듈 묶음 import(`torch`·`torchaudio`·`numba`·`mlx.core`·`mlx_whisper`·
  `pyannote.audio`·`speechbrain`·`faster_whisper`·`sentence_transformers`) → `BUNDLE-IMPORT-OK`.
  실패한 것은 `torchcodec` 하나뿐이고 그것이 맞다(§8.1).
- 금지 문자열 — 저장소 경로 / `~/.pnpm-store` / `/.pnpm/` / **빌드 자리 `work-<키>` 흔적**
  네 패턴 전부 **0건**. `sysconfig.get_config_var('prefix')` → `/damwha-bundled-python`.
- entitlement 표본 `bin/python3.12` = 키 **둘**, `allow-jit` **0건**. `.so`는 키 0개(그래서
  판정 표본이 `.so`가 아니라 `bin/python3.12`여야 한다 — 6회차 important).
- `libpython3.12.dylib`만 `@executable_path/../lib/…`, 나머지 57건 `@rpath/<base>`.

리뷰어가 산출 트리 `rt-f040c515ca97ccc3`에 **직접 대고** 재판정했다 — 남은 rpath는
`@loader_path` 22 + `/usr/lib` 1뿐, `_sysconfigdata` 35회가 `/damwha-bundled-python`이고
`/install` 0건, `.pyc` 0. 셔뱅 두 형태 매칭은 `case` 패턴을 격리 스크립트로 뽑아 합성 입력(긴
경로·공백 경로 폴리글랏 + 평문)으로 갈랐고 셋 다 옳게 갈렸다.

### 3.8 Task 6 — worker 층 + 스테이징 (`bd4eaac`, `070ea2b`)

런타임 층 위에 `damwha_worker`만 얹는 worker 층과 `desktop/build/python` 스테이징.

```
== w2. damwha_worker 설치 (--no-deps)   + damwha-worker==0.2.3 (from file:///…/be/worker)
== w3. 재배치   셔뱅 2개 재작성 / 62개는 이미 폴리글랏 / 0개 미처리
                sysconfig prefix 이미 자리표시자: /damwha-bundled-python
                direct_url.json 1개 삭제
== w4. 전수 서명 454개    == w5. 실패 0건, arm64 슬라이스 없음 0건
== w6. 진입점 확인   모듈 확인 OK
== w7. __pycache__ 457개 디렉터리 삭제 (남은 .pyc 0개)
== 스테이징: desktop/build/python (1.3G)   스테이징 트리 __pycache__ 0개
```

**`__pycache__` 457개가 순서 계약의 증거다.** 진입점 확인이 `mlx_lm/__init__.py`와
`huggingface_hub`를 실제로 import하면서 트리 전역에 `.pyc`를 만든다 — 그래서 계약은
`relocate → sign_tree → verify_signatures → check_entrypoints → purge_pycache → stage`이고,
`purge_pycache`가 **모든 python 실행 뒤**다. 서명 뒤에 번들 python을 돌리면 `.pyc`가 봉인 밖에
생기고 그 안에 빌드 머신 절대 경로가 박힌다(5회차 B-4: 448개가 **전부** `co_filename`에 트리
절대 경로를 담았다).

| 검사 | 실측 |
| --- | --- |
| 코드 동일성 | `/usr/bin/diff -r -x __pycache__ -x .DS_Store be/worker/damwha_worker …/site-packages/damwha_worker` → **rc=0** |
| `diff -rq`의 `Only in` 7건 | **전부 소스 쪽**(`__pycache__` 6 + `.DS_Store` 1) — 5회차 B-3이 예측한 그대로 |
| 저장소 경로 | `/usr/bin/grep -ralF "$(pwd)" desktop/build/python` **0건** |
| `__pycache__`·`.pyc`·`direct_url.json` | 각각 **0건** |
| 크기 | python **1.3G** / ffmpeg **42M** |
| 새 콘솔 스크립트 | `bin/damwha-worker`·`bin/damwha-embed`가 폴리글랏 3줄 |

**`fix_macho`를 worker 층에서 부르지 않는다.** `damwha_worker`는 순수 Python이라 새 Mach-O가
없고(`LC_RPATH` 0·`LC_ID_DYLIB` 0), 이미 정리된 트리에 다시 부르면 `[ "$rn" -gt 0 ] || die`가
**정상 상태를 필터 오류로 읽고 빌드를 죽인다.**

### 3.9 캐시 2층 — 무엇이 무엇을 무효화하는가

| 층 | 키 입력 |
| --- | --- |
| `rt-*` | `"3.12.11 20250818"` + `python-checksums.txt` + **`build-python.sh` 자신** + **`entitlements.python.plist`** + **`uv export --extra models --no-dev --locked --no-emit-project` 출력** 의 shasum |
| `wk-*` | **위 rt 키 전체** + `damwha_worker/` 트리 해시(**경로 포함**, `__pycache__`·`.DS_Store` 제외) |

**`WK_KEY ⊇ RT_KEY`다.** rt가 새로 빌드되면 wk가 반드시 따라 빌드되고, rt만 새로 만들어지고
wk가 적중하는 경로는 **존재하지 않는다**. 최종 리뷰가 이 관계로 이월 지적 하나를 구조적으로
닫았다(§9.2).

| 프로브 | rt | wk | 소요 |
| --- | --- | --- | --- |
| `touch be/worker/uv.lock` | 적중 | — | 내용 해시라 mtime 무관 |
| `pyproject.toml`에 주석 한 줄 | **적중** | — | export 출력이 바이트 단위로 같다 → R-8 |
| `build-python.sh` 한 글자 | 미스 | 미스 | — |
| `entitlements.python.plist` 수정 | 미스 | 미스 | — |
| `damwha_worker/__main__.py` 한 줄 | **적중** | **미스** | wk 층 **124초** + 스테이징 |
| 실제 의존성 변경(`numpy 2.4.6→2.4.5`) | — | — | `uv export --locked`가 **rc=1로 빌드를 세운다** |
| 캐시 키만 담은 트리 rename | — | — | 경로가 키에 들어 있어 키가 바뀐다(`259ad5fd…`→`20d94db3…`, 경로를 버린 변형은 불변) |

**전 층 미스의 실측 시간** (최종 수정 파동, `~/.cache/uv` 온난):

```
== 런타임 층 빌드 152초 → rt-f1f9748ded8fe4dc (1.3G)
== worker 층 빌드 159초 → wk-969845ce35fbd8f8 (1.3G)
합 311초
```

앞선 회차도 같은 크기다(rt 138·141·152초 / wk 153·159초). **깨끗한 머신이나 CI에서는 1.3 GB를
실제로 내려받으므로 수십 분이 맞다** — 138초는 이 개발 머신의 `~/.cache/uv`가 온난해
`Installed 131 packages in 2.88s`로 끝났기 때문이다. 캐시를 지우고 재측정하지는 않았다.

전 층 적중 재실행은 **0.58~1.5초**, `--print-key`는 **0.19초**다.

### 3.10 Task 7 + 최종 수정 파동 — 패키징·서명·번들 위생 (`f5dfea1`, `faaed64`)

서명 순서는 **안쪽 → 바깥쪽**이다. `.app` 서명이 `Resources/`를 해시로 봉인하므로 뒤집으면
봉인이 서명 전 내용을 가리킨다.

| # | 대상 | 집합 | plist | 옵션 |
| --- | --- | --- | --- | --- |
| 1 | `Resources/python` Mach-O | **452** | `entitlements.python.plist` | `--force --sign - --options runtime --entitlements` |
| 2 | `Resources/ffmpeg/bin/*` | **2** | 같음 | 같음 (**첫 서명** — `build-ffmpeg.sh`엔 서명 단계가 없다) |
| 3 | `Damwha.app` | 1 | `entitlements.mac.plist` | `--force --deep --sign -` + 위 둘 |

452 + 2 = **454**, 검사 17의 454와 일치한다.

| 항목 | 실측 |
| --- | --- |
| `package:desktop` | **EXIT=0** |
| `.app` 크기 | **1.8 GB** — `python` **1.4G** / `ffmpeg` **42M** / `postgres` 25M / `api` 64M |
| `check-bundle.mjs` | **exit 0, PASS 31 / FAIL 0** (Task 7 시점 28건 → 최종 파동에서 +3) |
| Mach-O flags | 454개 전수 `codesign -dv` → **runtime 454/454**, `allow-jit` **0건**, 448개 0키 / 6개 정확히 2키 |
| entitlement | `.app` **3키** / `bin/python3.12` **2키** / `bin/ffmpeg`·`ffprobe` **2키** / 렌더러 헬퍼 **3키**, 전부 `flags=0x10002(adhoc,runtime)` |
| 저장소 경로 | `/usr/bin/grep -ralF -- "$(pwd)" …/Damwha.app/Contents` → **rc=1, 0줄**. pnpm store도 0건 |
| 증거 사슬 | `uv export`(153) → rt `f1f9748ded8fe4dc` → wk `969845ce35fbd8f8` → `desktop/build/python/.build-key` → `Resources/python/.build-key` 전부 동일. ffmpeg `0e6637c2bdc24ad3` 동일 |
| 회귀 | `desktop lint` rc=0, `desktop test` 41파일 **675테스트** 전부 통과 |

`check-bundle.mjs` 전문(최종, 31건 PASS)은 워크스페이스의 최종 수정 보고서에 있고, 새로 는
검사는 셋이다 — `every signed arm64 Mach-O … carries hardened runtime`(454/454),
`bin/ffmpeg carries exactly the two entitlements`, `Damwha Helper (Renderer).app inherits the
three entitlements`.

**그 셋이 실제로 회귀를 잡는지 격리 실험으로 증명했다.** `.app`과 `desktop/build/`는
변형하지 않고 `/tmp/p4-f1`에 `ditto` 사본(1.7 GB)을 만들어 거기서만 조작했다.

| 실험 | 결과 |
| --- | --- |
| 대조군 — 격리 사본 그대로 | `EXIT=0 PASS=31 FAIL=0` (스캐폴딩이 거짓 FAIL을 만들지 않는다) |
| `signAll(ffmpegTargets, …)`가 사라진 상태 재현 — 서명 전 진짜 산출물(`flags=0x20002(adhoc,linker-signed)`, entitlement 0개)을 덮고 `.app`만 `--deep` 재봉인 | `EXIT=1 PASS=29 FAIL=2`. **옛 28건 체계였다면 전부 PASS로 남았을 상태**에서 새 단언 둘이 파일 이름과 실제 flags를 찍었다. `codesign --verify --deep --strict`와 `… is signed`는 여전히 PASS — 그 둘로는 못 잡는다 |
| x86_64 thin Mach-O를 심어 기존 구분이 사는지 | `EXIT=0 PASS=31`. Mach-O **455개**인데 runtime 판정 모수는 **454** — x86_64 thin은 무서명으로도 runtime 없음으로도 세지 않고 따로 센다 |

`.app`에 `entitlements.python.plist`를 주면 안 되는 이유의 직접 증거도 이 회차에 나왔다 —
`--deep`이 `Electron Framework.framework`와 헬퍼 넷에 전부 `flags=0x10002(adhoc,runtime)`을
걸고, 헬퍼가 상속한 entitlement가 **세 키**다.

---

## 4. 완료 기준 판정

### 4.1 스펙 완료 기준 중 이 계획이 만드는 넷

| ID | 기준 | 판정 | 근거 |
| --- | --- | --- | --- |
| **P4-C15** | `.app`에 arm64 무서명 Mach-O 0건, 개발 머신 경로 문자열 0건, entitlement 적용, `Resources/python` 아래 `__pycache__` 0개 | **충족** | `check-bundle.mjs` **31건 PASS·exit 0**. `--verify --arch arm64` 454개 전수 무서명 0 / runtime 454·454 / `allow-jit` 0건. 금지 문자열 3종 0건(`/.pnpm/` 1건은 `_CodeSignature` 자기 참조로 기존 필터가 배제). `__pycache__` 0. `bin/`의 콘솔 스크립트 64개 전부 번들 상대 셔뱅. 회귀 가드를 격리 실험으로 증명(§3.10) |
| **P4-C25** | `mlx` 버전 정렬이 STT·요약 출력을 깨지 않는다 — `uv.lock` 갱신 뒤 worker 테스트 전체 + 실오디오 1건 | **충족 (조건)** | `pnpm worker:test` **526 통과**, ruff clean. 요약은 `mlx-lm 0.31.3 + mlx 0.31.2`로 실전사 세그먼트 28개를 구동해 출력을 확인했다. **조건:** 실오디오 전사 1건은 돌리지 않았다 — `mlx`·`torch`·`numpy` 버전이 한 바이트도 바뀌지 않아 브리프가 조건부로 지정한 대로 건너뛰었다. 실오디오 완주는 Part 2의 P4-C5가 받는다 |
| **P4-C26** | 절대 불변 목록이 바이트 단위로 불변 — `abs-*` 8건이 기준선과 같고 `SKIP` 없음 | **기준선 수립 + 구간 판정 충족** | Task 1이 첫 Task보다 먼저 기준선을 떴고, Task 3·4·5·6·7과 최종 수정 파동의 끝에서 매번 `verify` **8/8 PASS·SKIP 0**. **최종 판정은 Part 2 종료 시점이다** |
| **P4-C27** | 앱 데이터 영역의 기존 레코드·파일 보존 | **기준선 수립** | `app-db-rows.txt`·`app-storage.txt`를 기준선에 담았다. Part 1은 `.app`을 실행하지 않아 앱 데이터에 닿지 않았고(`<userData>` 무변화), Docker DB는 읽기 질의만 받았다(`job=94`·`meeting_summary=12` 불변, 리뷰어 독립 확인). **판정은 Part 2** |
| **P4-C28** | numba 사망 지점이 측정되고 그 결과가 문서에 있다 | **충족** | §3.4가 그 결과다. 판정 `survives`, 최소 집합 둘이 각각 다른 지점에서 load-bearing, `.app`은 `allow-jit` 필수. entitlement plist 둘이 그 측정을 그대로 담고 산출물에 새겨졌다 |

**나머지 25건(P4-C1~C14, C16~C24, C29, C30)은 Part 2 몫이다.** Part 1은 그 기준들이 요구하는
제품 코드를 만들지 않았다.

### 4.2 Part 1의 완료 조건 셋

계획이 "Part 2로 넘어가기 전에 셋이 참이어야 한다"고 정한 것이다. 구현자 판정 뒤 **리뷰어가
독립 재판정**했고, 최종 수정 파동이 검사를 셋 늘린 뒤 다시 확인했다.

| # | 조건 | 판정 | 증거 |
| --- | --- | --- | --- |
| 1 | `package:desktop`이 끝까지 돌고 `check-bundle.mjs`가 exit 0 | **PASS** | `EXIT=0`. 단독 재실행 `node desktop/scripts/check-bundle.mjs` → **exit 0, 31건 전부 PASS**(94~96초). `package.mjs`가 `execFileSync`로 부르므로 비0이면 패키징 자체가 비0으로 끝난다. **리뷰어 독립 실행:** PASS 28 / FAIL 0 / exit 0 (당시 검사 수. 구현자 보고의 "27건"은 오기였고 리뷰어가 정정했다) |
| 2 | `/usr/bin/grep -ralF <저장소> …/Damwha.app/Contents` 가 0건 | **PASS** | rc=1·0줄. pnpm store 0건. `/.pnpm/` 1건은 `Contents/_CodeSignature/CodeResources`의 자기 참조이고 이 diff 이전부터 있던 필터(`check-bundle.mjs:166`)가 배제한다. **리뷰어가 격리 트리에서 needle을 바이너리에 심어 `spawnSync("grep", …)`를 재현** → `-rlF`·`-ralF` 둘 다 동일하게 잡았다 |
| 3 | Task 2의 numba 판정이 나와 있고 entitlements가 그 결과를 반영한다 | **PASS** | `plutil -convert json`으로 plist 둘의 키 집합을 확인(python=2, mac=3)했고, 서명 산출물이 그것과 정확히 일치한다(§3.10 표). **리뷰어가 Mach-O 454개 전수 `codesign -dvvv`로 재판정** — runtime 454/454, `allow-jit` 0건. numba 런타임 측정 자체는 Task 2의 증거이고 `.app` 실행이 금지돼 재유도하지 않았다 |

**(4) 증거 사슬** — 계획이 명시하지 않았지만 최종 리뷰가 추가로 잡은 것이다. `uv export` →
rt 키 → wk 키 → `desktop/build/python/.build-key` → `Resources/python/.build-key`가 전부 같고
ffmpeg도 같다(§3.10). 최종 수정 파동이 `build-python.sh`를 고쳐 전 층을 다시 빌드한 뒤 **다시
일치**시켰다.

---

## 5. 단계별 리뷰 기록

로드맵 §5는 "검토자와 검토 대상 커밋 또는 diff를 기록한다"를 요구한다. Task 3~7은 구현 대화를
받지 않고 **diff·스펙·계획·검증 증거만** 받은 별도 리뷰어가 봤다. diff는 워크스페이스에
`review-<범위>.diff`로 떴다.

| Task | 검토 대상 | Critical | Important | Minor | 판정 | 수정 라운드 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 메인 세션 자체 리뷰 (Review 6항) | 0 | 0 | 0 | 통과 | 0 |
| 2 | 메인 세션 자체 리뷰 (Review 8항) | 0 | 0 | 0 | 통과 | 0 |
| 3 | `review-46bc7c2..fdd3440.diff` | 0 | 0 | 2(이월) | Approved | 0 |
| 4 | `review-fdd3440..eaeee4b.diff` | 0 | 0 | 2(이월) | Approved | 0 |
| 5 | `review-eaeee4b..17b1814.diff` (Review 15항 전부 PASS) | 0 | 0 | 8(이월) | Approved | 0 |
| 6 | `review-17b1814..bd4eaac.diff` (Review 11항 전부 PASS) | 0 | **1** | 5 | **Needs fixes** | **1** |
| 6 수정 | `review-bd4eaac..070ea2b.diff` | 0 | 0 | 0 | 재리뷰 통과(새 breakage 0) | — |
| 7 | `review-070ea2b..f5dfea1.diff` (Review 8항 + Step 3 표 검사 6개) | 0 | 0 | 8(원장에 이월로 적힌 것 7) | Approved | 0 |
| 최종 전체 | `review-f71a888..f5dfea1.diff` (11커밋) | 0 | **2** | 5(신규) | **병합 전 수정 필요(경미)** | 1 (파동) |
| 최종 수정 | `review-f5dfea1..197ab7d.diff` | — | — | — | 자체 검증 + 격리 실험 | — |

### 5.1 리뷰가 실제로 잡은 것

**Task 6 Important — 진입점 확인이 호출 환경에서 격리돼 있지 않았다.** `check_entrypoints`의
`python -c`를 리뷰어가 셋으로 깼다. (1) `python -c`는 cwd를 `sys.path`에 넣으므로 `be/worker`에서
돌리면 세 모듈이 **소스 트리**로 해석되고 `__init__.py` 0바이트 assert까지 같이 통과한다.
(2) `PYTHONPATH`도 같게 먹는다 — R-9가 기록한 Task 5의 우회가 정확히 그것이다.
(3) `PYTHONOPTIMIZE=1`이 assert 둘을 **통째로 지우면서** `모듈 확인 OK`는 그대로 찍힌다.
R-9가 이 단계를 "유일한 번들 단독 검증"으로 지정했으므로 그 목적이 무너진다. 브리프의 코드
블록이 그 형태를 글자 그대로 싣고 있었지만, 스펙 §6.1 8단계가 이 검사에 부여한 목적("§2.4의
결함 — 모듈이 번들 밖에 있음 — 이 다시 나면 여기서 잡힌다")을 달성하지 못하므로 **고쳤다**
(R-10). `-E -s -P` 셋과 origin 판정이 들어갔다. 구현자가 격리 행렬로 증명했다:

| 조건 | 결과 |
| --- | --- |
| cwd=`be/worker`, 플래그 없음 | `번들 밖 모듈: damwha_worker <- …/be/worker/…` rc=1 |
| cwd=`be/worker`, `-E -s -P` | `모듈 확인 OK` |
| `PYTHONPATH=…/be/worker`, 플래그 없음 | `번들 밖 모듈: …` rc=1 |
| `PYTHONPATH` + `PYTHONOPTIMIZE=1`, `-E -s -P` | `모듈 확인 OK` (`sys.flags.optimize` 1→**0**) |

**플래그와 origin 판정은 서로 다른 구멍을 막는다** — `-E -s -P`는 `site-packages` 안의 `.pth`가
저장소 경로를 `sys.path`에 얹는 것을 막지 못한다.

**Task 6 Minor 2건을 같은 라운드에서 고쳤다** (R-11·R-12). 규칙상 Minor는 루프에 넣지 않지만
둘 다 이미 열린 라운드가 만지는 바로 그 함수였고 리뷰어가 회피를 실측했다. `pgrep -lf` 사전
필터는 `$STAGED/bin/python3`(심볼릭 링크)로 뜬 프로세스를 **0건으로 놓쳤고**(가드가 조용히
꺼진다), 셔뱅 부분 미스(`n_other>0`)는 경고만 내고 지나갔다. 구현자가 지시받은 형태(`ps … |
grep -qF`) 대신 변수 포획을 골랐고 재리뷰가 **정당하다고 판정**했다 — 파이프 직결은 `ps`가
grep 자신의 argv를 잡는 자기 매치로 **미끼 0건에서도 가드가 발동**하고(실측), `grep -q`의 조기
종료가 SIGPIPE/pipefail 구멍을 낸다. 변수 포획은 둘 다 구조적으로 없앤다.

**Task 7 — 리뷰어가 `.app`에 직접 대고 재판정했다.** Mach-O 454개 전수 `codesign -dv`, 격리
트리에 일부러 위반을 심어 검사를 **속여 봤고 전부 잡혔다**(평문 셔뱅, 2행이 `/opt/homebrew`인
위조 폴리글랏, 심볼릭 링크, x86_64 thin vs 서명 제거된 arm64, `.dylib`을 entitlement 표본으로
쓰면 영구 FAIL이 되는 것까지). 구현자 보고의 검사 수 "27건"도 **28건**으로 정정했다.

**최종 전체 리뷰 Important 2건.**

- **I-1 — `verifyArm64`가 linker ad-hoc 서명을 통과시킨다.** 사본으로 재현:
  `flags=0x20002(adhoc,linker-signed)` + entitlement 0개 + hardened runtime 없음 →
  `--verify --arch arm64` **rc=0**. 즉 `package.mjs:159`의 `signAll(ffmpegTargets, …)`가 미래에
  사라져도 28건이 전부 PASS로 남는다 — 스펙 §6.1이 이름 붙인 바로 그 실패 모드에 회귀 가드가
  없었다. 검사 18의 표본은 `.app`·`bin/python3.12`뿐이라 ffmpeg를 안 본다. **수정은 (a)
  `verifyArm64`에 runtime 플래그 단언(전수 그물, 실측 3.4초)과 (b) 검사 18 표본에 ffmpeg +
  렌더러 헬퍼 추가(plist 선택 축을 회귀로 고정) 둘 다**다 — 하나만 하면 구멍이 남는다(§3.10의
  격리 실험이 `ffprobe`가 (a)에만 잡히는 것을 보인다).
- **I-2 — `desktop/CLAUDE.md`가 이 브랜치가 무효화한 서술을 담고 있다.** 루트 `CLAUDE.md`가
  "서브트리를 고치기 전에 그 패키지 문서를 읽으라"를 규약으로 세웠고 **Part 2의 전 Task가 이
  서브트리**다. 11~13행만이 아니라 전문을 읽고 여섯 곳을 고쳤으며, 번들 배치·서명 계약을 담은
  절("## 번들 — `Resources/` 아래 넷")을 신설했다. `electron-builder.yml:17-18`의 주석
  ("build/에는 api·postgres 둘")도 **넷**으로 고쳤다.

**격상된 Minor 1건.** `codesign`을 `2>/dev/null || die`로 불러 실패 사유를 버리는 두 곳
(`resign()`, `sign_tree()`). 이 브랜치가 한 회차를 통째로 쓴 AMFI 하이픈 버그의 메시지가 정확히
거기서 사라진다. `plutil -lint`가 **통과시키는** plist로 AMFI 파싱 실패를 재현해 전후를 쟀다:

```
== 수정 전:  build-python: 서명 실패: bin/ffprobe
== 수정 후:  build-python: 서명 실패: bin/ffprobe — Failed to parse entitlements:
             AMFIUnserializeXML: syntax error near line 4
```

`local out=$(…)`는 `local`의 종료 상태가 이겨 `|| die`가 영원히 안 돌기 때문에 선언과 대입을
갈랐다. **부수 발견:** `plutil -lint`를 통과하면서 AMFI가 거부하는 형태가 최소 셋이다 — 문자
참조(`allow&#45;jit`), `<real>` 값, **`<true />`처럼 닫는 슬래시 앞에 공백이 있는 것.**

---

## 6. 컨트롤러 룰링 14건

원장의 `Ruling:` 줄 전부다. **이것이 사용자가 되돌릴 수 있어야 하는 결정 목록이다.**

| # | 결정 | 왜 | 틀렸을 때의 비용 |
| --- | --- | --- | --- |
| **R-1** | Task 3 Step 6의 요약 검증은 **job 행을 만들지 않는다.** `.venv`의 `mlx_lm.server`를 띄우고 `SummaryClient.summarize()`를 실전사 세그먼트(Docker DB에서 **읽기만**)로 구동해 출력을 본다 | 증명해야 할 것은 "mlx-lm 0.31.3 + mlx 0.31.2가 이 맥에서 요약을 낸다"이고 job 행은 거기에 아무것도 더하지 않는다. job을 걸면 `job`·`meeting_summary` 행이 늘어 §5 절대 불변(`damwha_pgdata`)과 P4-C26이 깨진다 | payload→handler→DB 기록의 배선이 Part 2 P4-C11까지 미검증으로 남는다(계획이 원래 그것을 P4-C11의 자리로 지정해 두었다) |
| **R-2** | rt 캐시 키는 계획대로 **`uv export` 출력 해시**를 쓴다 (스펙 §6.1 표의 `pyproject`·`uv.lock` 해시가 아니다) | 그 표는 7회차 minor로 좁혀진 결정 **이전**의 문장이다(§17.10에 기록) | dev 그룹 변경이 1.5 GB 층을 무효화하지 않게 되는 것뿐 — 정확도는 export 쪽이 높다 |
| **R-3** | Task 6의 진입점 목록은 넷 — `damwha_worker`·`damwha_worker.__main__`·`damwha_worker.embed_service`·`mlx_lm.server`. **`llm_entry`는 넣지 않는다** | Part 2가 만드는 모듈이라 지금 넣으면 빌드가 항상 실패한다 | 없음 (Part 2가 목록에 더한다 — §10) |
| **R-4** | `--print-key`는 Task 5에서 rt 키를, Task 6 뒤에는 rt·wk 두 키와 각 적중 여부를 낸다 | 계획 Task 5 Step 7의 용법(rt 미스 판정)이 그대로 성립한다 | 출력 한 줄 더 나오는 것뿐 |
| **R-5** | 판정에 쓰는 `find`·`diff`·`grep`은 **전부 `/usr/bin/` 절대 경로**로 부른다. 계획 본문이 맨몸으로 쓴 자리(T4 S5, T5 S5·S5-b, T6 S6)도 바꿔 실행한다 | 이 셸에서 셋 다 함수이고 **5회차 오진 2건이 정확히 그것**이었다(스펙 §17.8·§17.9) | 없음 — 더 엄격한 도구다 |
| **R-6** | Task 7의 셔뱅 검사 대상은 `Resources/python/bin/` 아래 파일**뿐**이다. 그 안에 평문 절대 경로 셔뱅이 하나라도 있으면 FAIL | 실행되는 콘솔 스크립트는 전부 `bin/`에 있다. `site-packages` 안 제3자 wheel이 자기 데이터에 담은 문자열은 금지 문자열 검사의 소관 | `bin/` 밖에 남은 평문 셔뱅을 놓친다 — 실효 위험은 없다 |
| **R-7** | ffmpeg `BUILD_PREFIX`를 Phase 0 원본 리터럴(`/opt/damwha-phase0/ffmpeg`) 대신 **`/opt/damwha-embedded-ffmpeg`**로 쓴 것을 받아들인다 | 계획이 "원본 그대로"를 요구한 것은 버전·configure 플래그·라이선스 검사 셋이고, `BUILD_PREFIX`의 제약은 리터럴이 아니라 성질("이 머신에 없는 중립 경로")이다. 원본 값은 이름에 "phase0"을 담아 Phase 4 산출물에 부정확하고, 채택한 값이 `build-postgres.sh:22`(`/opt/damwha-embedded-pg16`) 관례와 맞는다 | 없음 — 두 값 다 이 머신에 없고 트리에 박히는 문자열만 다르다 |
| **R-8** | 브리프 Task 5 Step 7의 "`pyproject.toml`에 주석을 붙이면 캐시 미스"라는 **기대를 철회한다.** 적중이 옳은 동작이다 | 계획 Step 3이 rt 키를 `uv export` 출력 해시로 정했고(R-2) 주석은 그 출력을 바꾸지 않는다. **계획 안의 모순**이다 — Step 3과 Step 7이 서로 다른 키 구성을 전제한다 | `pyproject.toml`만 고치고 `uv lock`을 안 돌린 상태가 캐시에 안 잡히는 것 — 그 상태는 `--locked`가 빌드를 비0으로 세우므로 조용히 통과하지 않는다 |
| **R-9** | 브리프 Step 5-c의 `damwha_worker.models.audio_io`를 rt 층에서 `PYTHONPATH`로 얹어 확인한 것을 받아들인다 | `damwha_worker`는 **Task 6이 설치한다** — rt 층에 그것을 요구한 것은 계획의 결함이다. 구현자가 번들 단독 9모듈을 따로 검증했다 | 없음 — Task 6 Step 4가 같은 트리에서 다시 판정한다 (그리고 그 판정의 격리가 R-10이 된다) |
| **R-10** | Task 6 리뷰의 Important를 **수정한다** — `check_entrypoints`에 `-E -s -P`를 붙인다 | 브리프 코드 블록이 그 형태를 글자 그대로 싣고 있지만, 스펙 §6.1 8단계가 이 검사에 부여한 목적을 cwd·`PYTHONPATH`로 만족되는 검사는 달성하지 못한다. **스펙이 구속력 있는 권위이고 계획은 그 논증이다** | 없음 — 검사가 더 좁아질 뿐이고 오늘 통과하는 번들은 그대로 통과한다 |
| **R-11** | Task 6 Minor 1(`pgrep` 사전 필터가 심볼릭 링크 실행을 놓친다)도 **같은 라운드에서 고친다** | (a) 이미 열린 라운드가 만지는 바로 그 함수이고, (b) 계획이 7회차 I-5에서 "가드가 조용히 꺼지는 것"을 명시적 위험으로 다뤘으며, (c) 리뷰어가 회피를 실측했다 | `ps -Ao command=`가 `pgrep`보다 약간 넓게 훑는 것뿐 — 비교는 여전히 `$STAGED/bin/` 고정 문자열이다 |
| **R-12** | Task 6 Minor 2(셔뱅 부분 미스가 경고만 낸다)도 **같은 라운드에서 고친다** | 계획 I-1의 목적이 "재작성이 uv의 두 번째 형태를 놓쳐 Task 7에서 원인 불명의 FAIL이 나는 것을 막는다"인데 부분 미스가 정확히 그 시나리오다. 오늘 rt·wk 양쪽 `n_other=0`이라 회귀 위험이 없다 | 장래 제3자 wheel이 알 수 없는 셔뱅 형태를 들여오면 빌드가 선다 — 조용히 절대 경로를 싣는 것보다 낫다 |
| **R-13** | 최종 전체 리뷰의 베이스를 `git merge-base main HEAD`(`f41e619`)가 아니라 **`f71a888`**(Task 1의 `db3f0a8` 직전)로 잡는다 | merge-base는 Phase 0~3의 185커밋·2.8 MB를 끌어오는데 그것들은 각자의 Phase에서 이미 리뷰·병합됐고 이 계획의 범위가 아니다. `f71a888..HEAD`가 Part 1의 제품 코드 전부다 | Phase 0~3 코드가 이 회차에서 다시 안 읽히는 것 — 그 코드는 이 계획이 바꾸지 않았다 |
| **R-14** | 최종 리뷰의 Important 2건 + 격상된 `codesign 2>/dev/null` 2곳을 **수정 파동 하나로 묶어 고친다.** `build-python.sh` 수정 → 전 층 재빌드 → 재패키징까지 이 회차에서 치른다 | 스크립트 shasum이 rt 키의 입력이라 1.3 GB 층이 다시 빌드되고 `.app`도 다시 말아야 증거 사슬(`.build-key` 동일성)이 유지된다. 지금이 가장 싼 시점이고 **Part 2는 어차피 plist를 고쳐 같은 재빌드를 부른다** | 10~20분의 재빌드 |

---

## 7. 계획·스펙과 실제가 갈린 곳

확정된 계획·스펙은 **당시 결정의 기록으로 보존한다**(로드맵 §6 규약). 그래서 계획 파일을 고치지
않고 여기에 적는다. 아래는 룰링이 계획 텍스트를 뒤집었거나 스펙 문장과 실제가 달라진 자리다.

| 자리 | 계획·스펙이 적은 것 | 실제 | 룰링 |
| --- | --- | --- | --- |
| Task 3 Step 6 — 요약 검증 형태 | job 행을 걸어 payload→handler→DB까지 본다 | job 없이 `SummaryClient.summarize()` 직접 구동, DB는 읽기만 | R-1 |
| 스펙 §6.1 표 — rt 캐시 키 | `pyproject`·`uv.lock` 해시 | `uv export` 출력 해시 | R-2 |
| 스펙 §6.1 8단계 — 진입점 목록 | `llm_entry` 포함 8개 | 넷(`llm_entry` 제외) | R-3 |
| Task 5 Step 7 — 캐시 키 프로브 | `pyproject.toml`에 주석 → **미스**를 기대 | **적중**이 옳다. 계획 안의 모순(Step 3 ↔ Step 7) | R-8 |
| Task 5 Step 5-c — import 묶음 | rt 층에서 `damwha_worker.models.audio_io`를 확인 | rt 층에 `damwha_worker`가 없다. `PYTHONPATH`로 얹어 원문을 돌리고, 번들 단독 9모듈을 따로 판정 | R-9 |
| Task 6 Step 2 — `check_entrypoints` 코드 블록 | `python -c "…"` (격리 플래그 없음) | `python -E -s -P -c "…" "$root"` + origin 판정 | R-10 |
| Task 6 Step 3 — 스테이징 가드 | `pgrep -lf … \| grep -qF` | `ps -Ao command=` 변수 포획 + herestring | R-11 |
| Task 4 — `BUILD_PREFIX` | Phase 0 원본 `/opt/damwha-phase0/ffmpeg` | `/opt/damwha-embedded-ffmpeg` | R-7 |
| 최종 리뷰 베이스 | (로드맵 관례상 merge-base) | `f71a888` | R-13 |

그 밖에 **계획의 기대 수치가 실제와 달랐던 것**(결함이 아니라 어림값):

- Task 5 빌드 시간 "수십 분" → **138초**(온난 `~/.cache/uv`). 깨끗한 머신은 여전히 수십 분이다.
- Task 6 스테이징 크기 "약 1.5 GB" → `du -sh` **1.3G**(prune 뒤 1,374,476 KiB ≒ 1.31 GiB).
- Task 5 Review 항목 "열넷" → 실제 **열다섯**. 구현자가 열다섯 전부 확인했다.
- Task 5 사전 정보의 `torchcodec` 사장 Mach-O "5개" → **15개**(§8.1).
- Task 7 보고서의 검사 수 "27건" → 리뷰어 독립 실행 **28건**(그 뒤 최종 파동에서 31건).

---

## 8. 남은 제약과 알려진 사실

계획이 "결과 문서에 적는다"로 미룬 것들이다. **전부 이번 회차에서 고치지 않았고, 고치지 않은
것이 맞다고 판정한 이유를 함께 적는다.**

### 8.1 `torchcodec`의 사장 Mach-O 15개가 번들에 실린다

`Resources/python/lib/python3.12/site-packages/torchcodec/` 아래
`libtorchcodec_core{4..8}.dylib`·`libtorchcodec_custom_ops{4..8}.dylib`·
`libtorchcodec_pybind_ops{4..8}.so` — **셋 × FFmpeg 메이저 4~8 = 15개**다. (그 밖에
`torchcodec/.dylibs/`에 `libc++.1.0.dylib`·`libpython3.12.dylib` 둘이 더 있다.)

**로드되지 않는다. 그게 맞다.** dylib이 `@rpath/libavcodec.{58..62}`류를 요구하는데 유일한
`LC_RPATH`가 **우리가 지운 `/opt/homebrew/opt/ffmpeg/lib`**(15건)다. worker는 이미
`sys.modules.setdefault("torchcodec", None)`로 우회하고
(`be/worker/damwha_worker/models/bge_embed.py:14`), **이 맥의 Homebrew libavcodec은 63이라
원래도 로드된 적이 없다.** Task 5의 import 묶음에서 나온 경고
(`torchcodec is not installed correctly … use audio preloaded in-memory`)가 스스로 제안하는
해법이 정확히 `audio_io.load_mono`가 하는 일이다.

이 15개도 서명·검증 대상에는 들어갔고 `--verify --arch arm64`를 통과했다. **제거는 이 Phase의
범위 밖이다** — `torchcodec`은 `torchaudio`의 전이 의존이라 패키지째 빼려면 `uv export` 목록,
즉 `uv.lock` 쪽을 고쳐야 한다.

### 8.2 `libllvmlite.dylib`에 남은 `/Users/runner/…` 문자열 — 금지 문자열 규칙의 경계

`llvmlite/binding/libllvmlite.dylib`에 `/Users/runner/miniconda3/conda-bld/…`가 **LLVM assertion
메시지의 문자열 데이터**로 남아 있다. **로드 커맨드가 아니다** — Task 5가 Mach-O 454개를
`otool -L`로 전수 확인해 `/usr/lib`·`/System` 밖 의존이 **0건**임을 이미 판정했다.

**그래서 금지 문자열 규칙을 넓은 `/Users/`로 쓰면 안 된다.** 판정 기준은 **이 저장소 경로와
pnpm store 경로**여야 한다. 7회차 리뷰가 1.3 GB 의존성 전체(torch 포함)에서 그 기준으로 오탐 0을
확인했다.

### 8.3 `Resources/postgres`는 runtime 플래그 없는 ad-hoc 서명이고 그것이 맞다

실측 `Resources/postgres/bin/postgres` → `flags=0x20002(adhoc,linker-signed)`. postgres는 앱과
별개 프로세스라 hardened runtime이 필요 없다. F1-(a)의 새 단언은 `verifyArm64`에 걸었고 그
호출자는 python·ffmpeg 하나뿐이다 — **postgres 검사는 기존 plain `--verify` 그대로 뒀고,
`desktop/CLAUDE.md`의 새 절이 "그쪽에 단언을 옮겨 붙이지 말 것"을 문서로 막는다.**

### 8.4 `build-postgres.sh:200`의 `pgrep -f` ERE 한계

`pgrep -f -- "$STAGED/bin/postgres"`의 패턴은 ERE다. 이 저장소의 체크아웃 경로에는 메타문자가
없어 오늘은 동작하지만, 경로에 `+`·`(`·`[`가 들어가면 **가드가 조용히 꺼진다**(7회차 I-5가
`+`가 든 경로에서 0건 vs 1건으로 재현). `build-python.sh`의 같은 결함은 R-11이 고쳤다
(`ps -Ao command=` + 고정 문자열 비교). **`build-postgres.sh`는 그대로다.**

세 빌드 스크립트의 실행 중 가드가 지금 **세 상태**다 — postgres `pgrep` ERE / python `ps` +
`grep -qF` / ffmpeg 없음.

### 8.5 세 빌드 스크립트에 캐시 GC가 없다

키가 바뀌면 옛 키 트리가 그대로 남는다. Task 6 중 옛 키 트리 넷을 손으로 지웠고, Task 7 시작
시점의 `desktop/.cache`는 3.3 GB(python 2.6 G / ffmpeg 397 M / postgres 267 M)였다. 최종 수정
파동은 전 층을 다시 빌드해 **옛 층 둘(`rt-a00eba1b05c06156`·`wk-280867314a673c31`, 합 2.6 GB)을
남겼다** — 캐시 GC가 이월 항목이고 임의로 지우지 말라는 지시가 있어 손대지 않았다.

디스크 실측: Task 7 회차 17 GiB → 15 GiB, 최종 파동 14 GiB → 약 **11 GiB**. rt 1.3 + wk 1.3 +
staged 1.3 = 약 4 GB를 상시 쓴다.

### 8.6 `.build-key`가 제품에 실린다

`Resources/python/.build-key`·`Resources/ffmpeg/.build-key`가 `.app` 안에 있다. **postgres가
세운 관례이고 무해하다** — 오히려 증거 사슬(§4.2-4)의 마지막 고리다.

### 8.7 그 밖

- `check-bundle.mjs` 전체가 **~96초**다. 늘어난 몫은 `codesign -d` 454회(3~4초)이고 지배적인
  비용은 1.8 GB 번들에 대한 `grep -ralF` 3회다. 패키징 전체는 세 빌드가 전부 캐시 적중인데도
  수십 분 걸리며 대부분이 electron-builder의 1.4 GB 복사와 이 검사다. **CI에 올릴 때 고려할
  값이다.**
- `check-bundle.mjs:47`의 `build-python.sh:378` 참조가 드리프트했다(실제 `:389` → 수정 후
  `:395`). 이 저장소의 주석은 줄 번호를 자주 인용하는데 그 정합을 지키는 장치가 없다.
- `entitlementKeys`의 `length === 2/3` 단언이 표본 **넷**에 걸린다. 값이 dict나 array인
  entitlement가 추가되면 `<key>`를 XML 전체에서 세는 성질 때문에 넷이 동시에 어긋난다. 오늘은
  두 plist 다 `<true/>`뿐이라 노출이 없다.
- `build-ffmpeg.sh:82-89` `verify_tree`의 `< <(otool -L … | sed …)` 프로세스 치환은 `pipefail`이
  잡지 못한다. 뒤의 `env -i <bin> -version || die`가 가려 주지만, 스모크가 덜 결정적인 번들에
  이 패턴을 재사용하면 위험하다.
- `uv.lock`에 `greenlet` wheel URL 2건(s390x·riscv64)이 PyPI 인덱스 드리프트로 딸려 들어왔다 —
  버전 이동이 아니고 darwin 대상에 무영향. 커밋 본문의 "추가 하나뿐"이 줄 단위로는 부정확하다.

---

## 9. 후속으로 넘기는 이월 지적

per-Task 리뷰의 Minor와 컨트롤러가 이월로 적은 것 전부다. **최종 리뷰가 하나씩 Part 2와
"기록만"으로 갈랐고, 수정 파동은 그중 하나도 건드리지 않았다.** 아래 표의 "분류"는 원장·최종
보고서에 **명시된 것만** Part 2로 적었다 — 나머지는 이 문서에 기록으로 남는다.

| 출처 | 지적 | 분류 |
| --- | --- | --- |
| T3 | `uv.lock`의 greenlet wheel URL 2건이 인덱스 드리프트로 딸려 들어왔다 | 기록만 (§8.7) |
| T3 | 보고서 Step 6-4가 `SummaryClient.summarize()` 구동 명령줄을 싣지 않았다(출력만). `--no-sync` 사용이 그 한 건만 자기 진술에 의존 | 기록만 |
| T4 | `build-ffmpeg.sh:82-89`의 프로세스 치환을 `pipefail`이 못 잡는다 | 기록만 (§8.7) |
| T4 | Step 5가 브리프의 `find … \| head -1` 리터럴 대신 실파일을 골랐다(첫 매치가 1바이트 placeholder) | 기록만 (보고서가 공개, 읽기 전용 유지) |
| T5 | `macho_list()`가 Phase 0 원본대로 `find -L`이라 `build-postgres.sh`의 `machos()`와 다르다 | 기록만 |
| T5 | 같은 이유로 "454개"가 실제 파일 수보다 2 많다(`bin/python`·`python3` 링크). 세 조작이 전부 멱등이라 무해 | 기록만 |
| T5 | 재배치·서명 **뒤** 런타임 층 단독에 스모크가 없다 | **최종 리뷰가 실측으로 닫았다** → §9.2 |
| T5 | `WK_KEY`가 그 시점에 죽은 코드다 | Task 6이 살렸다 (닫힘) |
| T5 | 셔뱅 부분 미스가 경고만 낸다 | R-12가 고쳤다 (닫힘) |
| T5 | `install_name_tool`·`codesign`을 `2>/dev/null || die`로 불러 사유를 버린다 | `codesign` 2곳은 **격상해 고쳤다**(F3). **`install_name_tool` 쪽(`:321`,`:355`)은 Part 2** |
| T5 | prune 목록이 `lib/python3.12/...`를 하드코딩(원본 그대로). 3.13 이행 시 조용히 0건 prune | 기록만 |
| T5 | `task-5-report.md`의 함수 표 줄 번호가 1~4 어긋난다 | 기록만 (**Task 6은 보고서가 아니라 스크립트를 읽었다**) |
| T6 | `--fresh`가 `$STAGED`를 버리지 않는다(`__pycache__`만 쓸어낸다). 손으로 고친 `desktop/build/python`이 키가 같으면 살아남는다 | 기록만 |
| T6 | wk 층에 Mach-O 정규화가 없는 근거가 판단이 아니라 트립와이어다(`:143-146`/`:318`). 장래 `damwha_worker`에 컴파일 확장이 생기면 서명은 되고 번들 밖 `LC_RPATH` 제거는 안 된다. 오늘 노출 0 | 기록만 |
| T6 | `WK_KEY`/`RT_KEY`의 `$( … \| cut … )`가 내부 `find`/`shasum` 실패를 삼킨다 | **최종 리뷰가 실측으로 정정 — 사실이 아니다** → §9.2 |
| T6 | `build-postgres.sh:200`의 `pgrep -f` ERE 한계 | 기록만 (§8.4) |
| T6 | 세 빌드 스크립트에 캐시 GC가 없다 | **Part 2 이월** (§8.5) |
| T7 | 검사 17이 linker ad-hoc 서명을 통과시킨다 | **최종 리뷰가 I-1로 격상 → 고쳤다**(F1) |
| T7 | `machOFiles()`가 `package.mjs`·`check-bundle.mjs`에 축자 중복(본문 완전 동일) | **Part 2 — `desktop/scripts/lib/macho.mjs`로** |
| T7 | `noArm64`의 파일명이 계산되고 버려진다(개수만 출력) | 기록만. **최종 리뷰가 절반을 정정** — 잘린 Mach-O는 실제로 FAIL한다. 조용히 용인되는 것은 **진짜 x86_64 thin 무서명**뿐 |
| T7 | `__pycache__` 실패가 개수만 말한다(경로 배열이 있는데 안 쓴다) | 기록만 |
| T7 | `package.mjs:157`의 `readdirSync(ffmpegBin)`이 필터 없이 전부 codesign에 넘어간다 | 기록만 |
| T7 | `check-bundle.mjs:71`이 `<key>`를 XML 전체에서 세므로 dict/array 값 entitlement가 추가되면 단언이 어긋난다 | 기록만 (§8.7) |
| T7 | `electron-builder.yml:17-18` 주석이 낡았다 | **I-2에 흡수해 고쳤다** |
| 최종 | M-1 `build-python.sh:256·267`의 sysconfig 두 질의가 R-10의 `-E -s -P` 격리에서 빠졌다(조용히 틀리지는 않는다 — 오염되면 `:267` 재질의가 `die`) | 기록만 |
| 최종 | M-2 `check-bundle.mjs:236`의 postgres 검사만 `--arch` 없는 옛 형태 | 기록만 |
| 최종 | M-4 세 빌드 스크립트의 실행 중 가드가 세 상태 | 기록만 (§8.4) |
| 최종 | M-5 `.build-key`가 제품에 실린다 | 기록만 (§8.6) |

### 9.1 우선순위가 바뀐 것

Task 7의 첫 Minor(검사 17)는 원장에 **`[최종 리뷰가 우선 판정할 것]`** 표시를 달아 이월했고,
최종 리뷰가 그것을 Important I-1로 격상해 고쳤다. `codesign 2>/dev/null` 2곳도 T5의 이월
Minor에서 "병합 전 수정"으로 격상됐다 — **Part 2가 entitlements plist를 고치는 순간(그것이 rt
캐시 키의 입력) 재빌드가 돌고 그때 사유 없는 "서명 실패: <파일>"만 남기 때문**이다.

### 9.2 최종 리뷰가 실측으로 **정정한** 이월 지적 둘

1. **`WK_KEY`/`RT_KEY`가 내부 실패를 삼킨다는 지적은 사실이 아니다.** `$( … | cut … )`의 종료
   상태가 `cut`의 것인 건 맞지만 `set -euo pipefail`이 그 줄에서 잡는다 — 격리 재현으로
   **rc=1로 죽는 것**을 확인했다.
2. **Task 5의 "재배치 후 스모크 부재"는 구조적으로 닫혔다.** `WK_KEY ⊇ RT_KEY`라 rt가 빌드되면
   wk가 반드시 따라 빌드되고, `build_wk`가 `check_entrypoints`에서 **번들 python을 실제로
   실행한다**(재배치·전수 서명을 지난 인터프리터가 기동하고 `mlx_lm`·`huggingface_hub`까지
   import해 C 확장을 dlopen한다 — `build-postgres.sh`의 `env -i … --version`보다 깊은 스모크다).
   **rt만 새로 만들어지고 wk가 적중하는 경로는 존재하지 않는다.**

---

## 10. Part 2가 알아야 할 계약

Part 1이 빌드에 박아 둔 **깨지면 빌드가 서는** 계약이다.

**빌드가 죽는 조건**

- **`damwha_worker/__init__.py`는 0바이트여야 한다.** `check_entrypoints`가
  `assert src.strip() == ''`로 못 박는다. 이 assert가 없으면 `find_spec('damwha_worker.X')`의
  부모 import가 조용히 부작용을 실행한다. Part 2가 거기에 무엇을 넣으면 **빌드가 선다.**
- **`huggingface_hub.snapshot_download`·`hf_hub_download`에 `tqdm_class` 파라미터가 있어야
  한다.** 같은 함수가 `inspect.signature`로 단언한다(실측 `huggingface_hub 1.20.1`, 둘 다 보유).
  스펙 §6.9의 진행 훅이 그 인자에 걸린다 — 라이브러리 버전이 그것을 빼면 빌드가 선다.
- **`check_entrypoints`는 `-E -s -P`로 돈다.** 진입점 목록에 `llm_entry`를 더하려면 그 모듈이
  **cwd·`PYTHONPATH`·`.pth` 없이 번들 단독으로 import 가능**해야 한다. origin이 번들 아래가
  아니거나 namespace 패키지(`origin is None`)면 실패로 센다.

**비용이 드는 조건**

- **진입점 목록에 `llm_entry`를 더하면 `build-python.sh`의 shasum이 바뀐다** — 그것이 rt 키의
  입력이므로 rt·wk **두 층 1.3 GB씩이 다시 빌드된다**(온난 캐시 합 ~311초 + 재패키징).
  `entitlements.python.plist`를 고쳐도 같다. **한 번에 몰아서 하는 편이 싸다**(R-14가 그 판단의
  선례다).

**실행 경로 계약**

- **`bin/python`·`bin/python3`은 `python3.12`로 가는 심볼릭 링크다.** 런처는 `python3.12`를
  명시할 것 — Task 6의 가드 실측이 심볼릭 링크로 뜬 프로세스를 `pgrep`이 놓치는 것을 보였다.
- **`bin/`에 `pip`·`pip3`·`ensurepip`·`python-config`·`tkinter`·`idle`·`2to3`·`pydoc`이 없다**
  (prune). 런타임에 `pip install`을 할 수 없고, PBS 원본 스크립트의
  `dirname -- "$(realpath -- "$0")"` 셔뱅도 함께 사라졌다 — 앱이 자식에게 주는 PATH에
  `/usr/bin`이 없으므로(스펙 §6.2) 그대로 뒀으면 `realpath: command not found`로 죽고 그것이
  우리 셔뱅의 결함으로 오독됐을 것이다. **`bin/`의 스크립트 64개가 전부 우리 폴리글랏이다.**
- **ffmpeg는 `--disable-network` 빌드다.** URL 입력을 받지 않는다. `--disable-avdevice`이므로
  캡처 장치도 없다.
- **`PYTHONPYCACHEPREFIX`를 반드시 넣고 `PYTHONDONTWRITEBYTECODE`는 씻을 것.** 후자가 상속되면
  전자를 조용히 이기고 `import numba`가 0.14초 → 0.63초(4.5배)가 된다(6회차 실측). 전자를 안
  넣으면 번들 트리에 `.pyc`가 생겨 봉인 밖 파일이 되고 검사 19가 FAIL한다.
- **서명 뒤에 번들 python을 실행하지 않는다.** `__pycache__`가 봉인 밖에 생기고 `.pyc`에 빌드
  머신 절대 경로가 박힌다(5회차 B-4: 448개가 전부 그랬다).
- **서명 순서는 안쪽 → 바깥쪽.** `.app` 서명이 `Resources/`를 해시로 봉인한다.
- **`.app`에 python plist를 주면 V8이 `allow-jit` 없이 rc=133으로 죽는다.** 거꾸로 Python
  트리에 `allow-jit`은 주지 않는다.
- **캐시가 비면 `pnpm desktop:dev`도 1.3 GB를 빌드한다**(rt ~140초 + wk ~150초). `desktop:dev`와
  `desktop:build`가 이제 빌드 스크립트 **셋**을 부른다. 키만 보려면 `--print-key`(0.19초).

이 계약들은 `desktop/CLAUDE.md`의 "## 번들 — `Resources/` 아래 넷" 절에도 들어갔다(`197ab7d`).

---

## 11. 미검증 표면

**이 절의 항목을 "동작한다"로 읽지 않는다.**

1. **hardened runtime으로 서명한 `.app`을 실제로 띄운 적이 없다.** Part 1은 `.app`을 한 번도
   실행하지 않았다(검사 19의 `__pycache__` 0개가 그 증거이기도 하다). Task 2 Step 6-c가 잰 것은
   **`BrowserWindow` 없는 맨 Electron 셸**이다 — `app.disableHardwareAcceleration()` + `ready`에서
   `new Function('return 1+1')()`을 한 번 돌리고 `app.exit(0)`. 렌더러·GPU 프로세스·실제 창은
   그 측정에 없었다. **Part 2가 처음 띄운다.**
2. **번들 안 numba의 첫 실행도 Part 2의 STT다.** Task 2는 `/tmp/numba-probe`에 잠금 버전 셋만
   깐 **별도 PBS 트리**에서 쟀다. 번들 트리의 numba는 `check_entrypoints`가 import하는 경로에
   없고(대상 넷에 없다), `@numba.jit` 함수를 **호출**하는 것은 `mlx_whisper/timing.py`의
   word-timestamp 경로다.
3. **`.app` 안에서 worker·embed·`llm_entry`가 뜬 적이 없다.** 실행·env 주입·고아 처분 계약은
   전부 Part 2다.
4. **깨끗한 캐시에서의 빌드 시간을 재지 않았다.** 311초는 `~/.cache/uv`가 온난한 값이다.
5. **다른 맥에서의 독립 설치를 검증하지 않았다.** 로드맵이 그것을 Phase 6에 두고 있다.

**반대로, 이번 회차에서 확인된 것** (Part 2가 다시 의심하지 않아도 되는 것):

- **헬퍼 넷(`Damwha Helper{,(Renderer),(GPU),(Plugin)}.app`)이 전부 3키를 상속했다** —
  `--deep`의 entitlement 전파가 최종 리뷰에서 처음 확인됐다. 검사 18이 렌더러 헬퍼를 표본으로
  회귀 고정한다.
- **`Resources/api`에 Mach-O가 0개다.** 이 문서를 쓰며 읽기 전용으로 확인했다(2026-09-17):
  `/usr/bin/find …/Resources/api -type f -print0 | xargs -0 -n 400 file -L | /usr/bin/grep -c "Mach-O"` → **0**
  (전체 7,390 파일). api 트리는 네이티브 모듈을 담지 않으므로 이번 서명 대상 454개 밖에 서명이
  필요한 Mach-O가 없다.
- `codesign --verify --deep --strict`가 1.4 GB `Resources/python`을 얹은 뒤에도 통과한다.
- Phase 3의 postgres 검사 7줄과 Phase 2의 기존 검사 14건이 전부 그대로 PASS다 — `env -i postgres
  --version`·`env -i psql --version`이 번들에서 16.15로 돈다.

---

## 12. Part 2 — 실행 통합 (Task 1~12)

[Part 2 계획](../plans/2026-09-16-electron-phase-4-runtime-integration.md) — Task 12개(+ Task 9b).
worker의 ffmpeg 경로·`run_id_arg`·`llm_entry`·import 부작용 제거, desktop의 경로 모듈·env 위생·
런처 교체·토큰 저장소와 온보딩·프로세스 판독과 고아 정리·앱 종료 회수(B층)·`model_readiness`와
HF 진행 훅·준비 유예와 재시작·화면 3층, 그리고 마지막 Task의 통합 검증.

**범위: `6627342..0859727`.** 구현 25커밋(`6627342..7439e8f`) + 최종 전체 리뷰의 수정 파동
`d6ed75f` + Task 12가 검증 중에 실측으로 잡은 수정 넷(`b97b6ba`·`0bcf4c9`·`c00d6b8`·`0859727`).

### 12.1 Task별 실행 기록

| Task | 무엇을 만들었나 | 커밋 | 수정 라운드 |
| --- | --- | --- | --- |
| 1 | worker `Settings.ffmpeg_bin`/`ffprobe_bin` — **호출 시점 env 읽기**(시그니처·호출부·테스트 불변) | `6627342..1bd4da5` | 0 |
| 2 | worker 런타임 자기 보고(`runtime_report`·`runtime_facts`) + `--run-id` 인자 + capabilities 프로브 보고 | `1bd4da5..38fb12f` | 0 |
| 3 | `managed_llm_server`·`llm_entry` 진입(`-m`, 셔뱅 없음), `lens_llm_server_bin=""` 기본값, `embed_service` import 무부작용 | `38fb12f..084a8ea` | 0 |
| 4 | desktop 계약·경로 — `PythonBinaries`, `childEnv` 합성·위생, `knownBundleDirs`, `LaunchContext.databaseMode` | `084a8ea..ba5e0be` | 1 |
| 5 | **uv 층 제거** — 번들 python 직접 기동(`python-launcher`), embed `-m` 진입, `worker.ts`의 `.env` 검사 삭제 | `ba5e0be..a75343a` | 1 + 리뷰 전 1 |
| 6 | HF 토큰 — `safeStorage` 토큰 저장소 + 온보딩 창(`token-gate.ts`·`token.html`), **토큰 없으면 서비스 0** | `a75343a..02bc383` | 0 + 리뷰 전 1 |
| 7 | 고아 판독·회수 **A층**(`orphans.ts`·`parseDamwhaScan`), 외부 worker stand-down, embed 채택 규칙, `reap-on-start.ts` | `02bc383..88433d7` | 1 |
| 8 | 종료 시 **B층** `reapOwnedOnQuit`(`main.ts::stopServices`) + 종료 화면 판정·문구 | `88433d7..edacfc4` | 1 |
| 9 | `model_readiness` 기록(HF 진행 훅, merge SQL 1문장, writer 게이팅), bge-m3 40-hex 리비전 고정 + safetensors 한정 | `edacfc4..35b5d7e` | 1 |
| 9b | **캐시 우선 적재**(로더 5종 `local_files_only` 선행), 모든 HF 호출에 유한 상한, 무진행 90s → TRANSIENT | `35b5d7e..228c566` | 1 |
| 10 | 감독자 유예 계산(`STALL_MS`, 다운로드 시간 제외 누적), `readModelReadiness`(번들 psql 주입), `restartService` | `228c566..9b26dc1` | **3 (상한)** |
| 11 | API·FE 노출 + 토큰 교체 버튼(`applyTokenChange`), 원인 3종 추가·2종 삭제, 401/403 구별 | `9b26dc1..7439e8f` | 1 |
| 12 | 통합 검증 — 이 절의 나머지 전부 | (검증 중 수정 넷) | — |

**최종 전체 리뷰**(opus, `6627342..7439e8f` 25커밋): **Ready for verification — 조건부**. 조건 5건
= 코드 3건(`statusLine` 게이트 / `token.html` 4096자 초과 뒤 입력칸 영구 비활성 / `refreshReadiness`가
quitting을 무시) + 문서 2건. 수정 파동 `d6ed75f`가 코드 3건을 닫았다(desktop 1052 passed, RED 둘 확인,
CSP 해시 불변). **문서 2건은 Task 12 Step 6에서 닫았다**(§12.7). 리뷰가 새로 연 Important 2건은
고치지 않고 §12.6에 남겼다 — 스키마 변경이 필요하거나(Important-1) 절차로 받아들였다(Important-2).

**일시 중지 3회**(모두 사용자 지시, 전부 트리 깨끗한 지점): Task 9 수정 1회차 구현자 중단(`1952305`),
Task 9 scoped re-review 발송 전(`35b5d7e`), Task 10 리뷰 발송 후(`7bea1bd`).

### 12.2 Part 2 룰링

Part 1의 R-1~R-14는 §6에 있다. 아래는 Part 2의 것이고 **되돌릴 수 있어야 하는 결정 목록**이다.

**사전 충돌 스캔(pre-flight)**

| ID | 결정 |
| --- | --- |
| R-P1 | 기준선을 `~/.local/state/damwha-p4-baseline`에 ditto 복사, `/tmp/p4-baseline`은 심볼릭 링크, 원본은 `/tmp/p4-baseline.orig-20260917`로 보존. verify는 `P4_BASELINE_DIR` 명시 |
| R-P2 | `knownBundleDirs(ctx)`는 IO 없는 순수 함수로 dev↔packaged를 유도한다(반환 순서 [packaged, dev]) — 다른 곳에 설치된 packaged가 dev 트리 고아를 못 올리는 것이 비용 |
| R-P3 | Task 3 Step 6에 `import damwha_worker.embed_service`를 `.env` 없는 cwd + `DATABASE_URL` 미설정으로 실행 |
| R-P4 | Task 6 Step 5는 서브에이전트가 절반만(토큰 없이 기동 → 창·서비스 0), 실토큰 절반은 Task 12 축 A |
| R-P5 | 실행 중 계획 파일을 고치지 않는다 — 결론은 원장 → 이 절 |
| R-P6 | 수정 루프 상한 3회(사용자 지시가 스킬보다 우선). Task 10이 이 상한에 걸렸다 |
| R-P7 | embed가 180s 유예를 넘기면 원인이 bge-m3 다운로드임을 증거로 보이고 **완료 뒤 상태로** 판정한다(가정 통과 금지) |
| R-P8 | `model_readiness` 읽기는 주입 가능한 reader + `main.ts`가 번들 psql로 배선(API 경유 재작업 회피) |

**Task 실행 중** — 계약 개정은 굵게.

| ID | 결정 |
| --- | --- |
| R-2a | capabilities 프로브는 `DATABASE_URL=postgresql://nobody@127.0.0.1:1/none` + `timeout`으로 돌린다(개발 DB claim 방지) |
| R-3a | `ps \| grep` 자기 매칭 → `procs=$(ps -Ao command=)` 포획 후 herestring. 원인은 Bash 도구가 명령 전문을 `zsh -c` argv로 싣는 것 |
| R-3b | Task 3의 계획 밖 `fix_macho` herestring 수정을 같은 파동에 수용(rt 재빌드 1회) |
| R-4a | **계약 개정** — `LaunchContext.databaseMode: "embedded" \| "external"` |
| R-4b | `LENS_LLM_BASE_URL`은 `http://127.0.0.1:<빈 포트>/v1` 형태를 쓴다 |
| R-4c | 임베디드 모드에서 `DAMWHA_SHARED_STATE=on`을 명시 주입한다 |
| R-4d | **`childEnv(ctx, inherited)`가 env 합성 규칙의 유일한 구현**이다 |
| R-4e | `LENS_LLM_MANAGED`는 앱 소유 키 — `config.json` 값은 버리고 경고한다 |
| R-4f | Minor 2건(상대 `REPO_ROOT` resolve, 쓰기 불가 pycache)을 같은 라운드에 |
| R-5a | Part 2 코드로 앱을 처음 띄우기 전 `<userData>/data`(151 MB)를 `data.p4-part2-pre-launch-backup`으로 ditto 복사 |
| R-5b | dev 앱 종료는 osascript graceful quit, SIGKILL 금지 |
| R-5c | 자식 PATH에 `/usr/bin:/bin`을 **넣지 않는다** — 넣으면 `/usr/bin/python3`(Xcode CLT 심)가 맨 이름으로 풀려 C13(a)의 구조적 증명이 깨진다. 대신 `capabilities.py`가 `/usr/sbin/sysctl` 절대 경로를 쓴다 |
| R-5d | **계약 개정** — `PythonLaunchOptions.extraEnv`를 두지 않는다(HF_TOKEN은 `ctx.env` 경로로) |
| R-5e | 수정 1회차에 Minor 2건(주석 전제, ffmpeg 경로 가드 무테스트)을 묶는다 |
| R-6a | Task 6 뒤로 dev 기동에 토큰이 필요하므로 Task 7~11 Verify는 앱을 띄우지 않는다(test·lint·worker:test) |
| R-6b | HF_TOKEN을 API 프로세스·마이그레이션 러너 env에서 뺀다 |
| R-7a | `CAUSES.orphanScanFailed`는 Task 7이 만들고 Task 11은 나머지 셋만 더한다 |
| R-7b | 고아 스캔 실패는 `recovery=manual` — 자동 재시도 없음 |
| R-7c | **계약 보강** — `DamwhaProcess.tree`, `ReapDeps.terminate?`·`sleep?`, `knownBundleDirs`는 `{bins, repoRoot}`만 받는다 |
| R-7d → **R-7g** | 신호 직전 재확인을 `exists(pid)`로 두려 했으나(pid 재사용 위험), **SIGKILL 직전 `ps()`를 다시 읽어 첫 스냅숏과 args가 같은 pid에만** 보내는 것으로 대체 |
| R-7e | B층은 terminate 모드(SIGTERM→유예→SIGKILL) |
| R-7f | 알려진 트리인데 run-id를 읽을 수 없는 줄이 하나라도 있으면 `reapOrphans`는 `{failed:true}`(신호 0) — **fail-closed** |
| R-7h | 규칙 3으로 추정한 argv[0]은 `tree`를 갖지 않는다 |
| R-7i | 증명된 고아 `--once`의 자손인 탈출구 서버(`LENS_LLM_SERVER_BIN`)는 내린다 |
| R-7j | 스펙 편차 수용 — 이번 run-id를 가진 embed도 채택(도달 불가 경로) |
| R-7k | 두 번째 ps가 실패하면 SIGKILL 생략 + `{failed:true}`, 읽을 수 없는 리스너 줄을 가진 embed는 채택하지 않는다 |
| R-8a | B층 자리는 `main.ts::stopServices()` — 스펙 §17 표의 `quit-flow.ts`와 다르다(§12.7) |
| R-8b | 공개 계약 `reapOwnedOnQuit(d): Promise<{reaped}>` 유지, 실패는 내부 함수가 운반 |
| R-8c | 같은 라운드에 Minor 4건 |
| R-9a | `model_readiness` writer — worker 쪽은 `WORKER_ID`, embed는 리터럴 `"embed"` |
| R-9b | `downloading`은 **실제 바이트 전송이 시작될 때만** 쓴다(캐시 적중이면 안 쓴다) — C9 판정의 근거 |
| R-9c | 수정 1회차 5건(보고서 정정, 훅 install 가드, 비-dict jsonb 안전, `_iso_now` 공개화, 0바이트에 ready 금지) |
| R-9d | 캐시 우선 적재 성공은 **명시적으로** ready를 기록한다(바이트 훅 경유 아님) |
| R-9e | 수정 1회차 — **`be/worker/tests/conftest.py` autouse 세션 픽스처로 `DATABASE_URL` 강제**(데이터 안전 사고 2의 재발 차단), 워치독 가드, env·hub 상수 복원 |
| R-10a~c | 수정 1·2·3회차 — 정지 결과로 bring 결정·진짜 가드 검증·`canRestart` 일치·백오프 해제 / `restartOnce` in-flight 가드·정지 실패 뒤 재시작 거부·"정리 중" 문구 / `cleaningUp`을 렌더링 게이트에 배선 |
| R-10d | **고치지 않는다** — ⌘Q 시 `stopAll`이 정리 중 서비스에 두 번째 신호를 보내는 것은 설계된 강제 종료 경로(§12.6에 실측 대가를 적었다) |
| (park) | Task 10의 `statusLine` 게이트 좁힘은 상한에 걸려 **최종 리뷰 수정 파동으로 이월** — `d6ed75f`가 실행 |
| R-11a | 401 vs 403은 `error`의 `"<code>: <message>"` 선두 코드로 가른다(스키마에 코드 필드가 없다) |
| R-11b | **계약 개정** — `TokenChangeDeps.cacheToken(token)`(모듈 캐시 부활 경로 차단) |
| R-11c | 스펙 산문의 "5분"과 구현 `STALL_MS=120s`의 불일치는 **120s 유지**(§12.7) |
| R-11d | 수정 1회차에 Minor 4건 |
| R-12a | `phase4-baseline.sh`의 앱 행 수 측정을 테이블별 `count(*)` 루프로 — 내장 postgres에 libxml이 없어 `query_to_xml`이 실패한다. 안 고치면 C27 행 수 절반을 영영 판정 못 한다 |
| R-12b | C21 탐지 결함 — **`worker-discovery.ts`의 외부 worker 탐지에서만** 조건 1(basename `python3.12`)을 완화한다. **`orphans.ts`는 그대로** — 살상 경로에서 느슨해지면 남의 프로세스를 죽인다 |
| R-12c | C20 수정 — desktop은 2차 SIGTERM **직전**에 트리를 다시 걷고 supervisor 생사와 무관하게 SIGKILL, worker는 2차 신호를 `os.killpg`로 |
| R-12d | 그 수정 리뷰의 must-fix 2 + 테스트 구멍 2를 즉시 반영 |
| R-12e | (1) 도달 불가가 된 `mtg_3`를 `UPDATE … status='failed'`로 푼다 (2) `mark_processing` job 가드는 C14 재빌드에 얹는다 |
| R-12f | 한 커밋(`0859727`)으로 셋 — `_hard_exit`, 버려진 다운로드면 캐시 우선 건너뛰기, `mark_processing` job 가드 |
| R-12g | C7은 2단계로 확인 — 표식을 `app_setting`에 복원해 건너뛰기만 시험한 뒤, 부분 캐시를 지우고 끊김 시험을 다시 한다. **시뮬레이션한 전제라는 사실을 문서에 명시한다** |

### 12.3 데이터 안전 사고와 복구

절대 불변 기준(§3.2)을 Part 2가 세 번 건드렸고 **세 번 다 사용자 승인으로 원상 복구**했다.

| # | 무엇이 어떻게 | 복구 | 재발 차단 |
| --- | --- | --- | --- |
| D-A | Task 9 실험이 `~/.cache/huggingface/xet/logs/`에 로그 1개(1001 B) 생성 | 그 파일만 삭제 → 8/8 PASS | `hf_xet`은 **import 시점**에 `HF_XET_CACHE` → `HF_HOME` → 기본 순으로 경로를 고른다 — 실험에 **둘 다** 스크래치로 지정 |
| 2 | **Docker 개발 DB `app_setting` 2행 → 3행.** `tests/test_offline_load.py`가 `hook_db` 픽스처 없이 훅을 설치해 `_STATE.writer`가 남고, `_mark_ready`가 `be/worker/.env`의 실 `DATABASE_URL`로 지연 연결했다. 쓰기 실패를 삼키는 코드라 조용했고 `pnpm worker:test`마다 재발했다 | 그 행만 삭제 | **R-9e (b)** — `conftest.py` autouse 세션 픽스처가 `DATABASE_URL`을 닿지 않는 DSN으로 강제(가드 2겹 + `core.connect` 스파이 테스트) |
| 3 | C24 웹 회귀 회차의 `pnpm embed`가 기본 `HF_HOME`으로 bge-m3를 적재해 `.no_exist/` 아래 **0바이트 표식 6개** 생성(사라진 줄 0) | 그 6개와 빈 폴더만 삭제 → `abs-hf-cache` PASS | 웹 흐름을 돌릴 때도 `HF_HOME`·`HF_XET_CACHE`를 스크래치로 |

그 밖에 **아차 사고 1건**(구현자 자진 보고): Task 9 수정 중 `git checkout -- be/worker/damwha_worker`가
`llm_entry.py`를 되돌렸고 스텁 때문에 스위트는 초록이었다. `git show --stat`으로 발견 → 재적용·amend +
되돌린 파일에서 실패하는 테스트 추가. **예방 조치**는 R-P1(기준선 사본 둘 + 원본 보존)과
R-5a(`<userData>/data` 151 MB ditto 백업)다.

### 12.4 스펙 완료 기준 30건 판정

**충족 29 · 미충족 0 · 남음 1(P4-C2의 절반).** 판정 도구는 §3.1 그대로 `/usr/bin/` 절대 경로다.

| ID | 판정 | 증거 |
| --- | --- | --- |
| C1 | 충족 | 토큰 없는 packaged 첫 기동 — `"토큰 창을 띄웁니다. 서비스는 아직 띄우지 않았어요"`, 번들 python 0·postgres 0·소켓 0·3000/8100 리슨 0, Electron만 생존 |
| C2 | **충족(부분)** | `hf-token.bin`은 51바이트 바이너리(0600). 상태 창은 토큰을 **마스킹해** 보인다(`hf_****_****wLlQ`) — 화면 어디에도 평문이 없다(2026-09-19 관측). **남은 절반은 토큰 문자열 전수 grep이고 사용자만 실행할 수 있다** — 에이전트가 토큰 원문을 받지 않는 것이 절차 규칙이다 |
| C3 | 충족 | 아무 문자열 → `"허깅페이스 토큰이 유효하지 않아요. (HTTP 401 …)"`, 토큰 원문·원본 예외 노출 없음, 파일 미생성 |
| C4 | 충족 | 토큰 A로 교체 → 재시작(run-id `8b48…`→`b126…`→`a30c…`, 옛 run-id 프로세스 0) → 403 해소, pyannote·whisper·speechbrain ready, job_8·job_9 done |
| C5 | 충족 | `models/` 비움(4.3G → 0, 승인) 뒤 서비스 4개 기동 → 실오디오 1건이 전사·화자분리·요약·검색까지 완주(job_8·job_9 done) |
| C6 | 충족(부분) | `model_readiness`의 bge-m3가 `state=ready, writer=embed, bytes=2,271,064,456 = bytes_total`, started/updated 기록 — **진행이 실제로 올라왔다.** 화면도 확인했다(2026-09-19 관측 회차): 상태 창의 **"모델 준비"** 절이 다섯 모델을 각각 한 줄로 그리고 전부 `● 준비됨`이다(`BAAI/bge-m3`·`mlx-community/Qwen3.5-4B-8bit`·`speechbrain/spkrec-ecapa-voxceleb`·`mlx-community/whisper-large-v3-turbo`·`pyannote/speaker-diarization-community-1`). **다운로드 중의 진행 표시는 여전히 미관측**이다 — 그 화면은 받는 중이어야 뜬다 |
| C7 | 충족(**기준 좁힘**) | 좁힘(사용자 결정 D-B, 스펙 개정 `1952305`): *"사유가 뜨고 복구 뒤 **다음 job**이 완주한다"* — 바이트 이어받기는 Phase 5로. 재판정: 마지막 진행 08:06:12 → 08:07:42 failed = **무진행 90초 정확**, `kind=TRANSIENT`, job_42 queued → **5초 만에 자동 재claim**(1차에서는 11분 방치였다), 복구 뒤 job_43 done(attempts=1, 1759MB) |
| C8 | 충족 | pyannote 항목 `kind=PERMANENT`, `error="hf_gate_not_accepted: … (403) — accept the model's user conditions…"`, job 오류 payload에 코드·수락 URL, 전사 전 단계에서 멈춰 utterance 0. 401 절반의 문구는 C3가 보인다 |
| C9 | 충족 | 두 번째 실행에 새 `downloading` **0건**(R-9b — 실제 바이트 전송에만 쓴다). C14·C29가 같은 사실을 파일 목록 diff로 재확인 |
| C10 | 충족 | bge-m3를 **한 벌(2.27 GB)만** 받았다. 리비전 40-hex 고정 + safetensors 한정(Task 9)이 두 벌 문제를 닫았다 |
| C11 | 충족(증거) | worker.log — `starting LLM server: <APP>/Resources/python/bin/python3.12 -m damwha_worker.llm_entry --run-id=…`. **전역 `mlx_lm.server`가 아니다.** `~/.local/bin` 일시 격리 회차는 돌리지 않았다(§12.8) |
| C12 | 충족 | 다섯 다 번들 트리 — worker·embed argv가 `<APP>/Contents/Resources/python/bin/python3.12 -m …`, `llm_entry`, run-id 없는 capabilities 프로브(`capabilities probe: runtime {...}`), `resource_tracker`. `PythonBinaries`에서 `sitePackages`를 지웠으므로 "site-packages가 번들 아래"는 런타임 자기 보고(`prefix`·`sys_path_head`)로 판정한다 |
| C13 | 충족 | **구조적 증명**: 자식 PATH가 `<python>/bin:<ffmpeg>/bin`뿐이라 맨 이름이 개발 도구로 풀릴 자리가 없다(R-5c). `capabilities.py`가 `/usr/sbin/sysctl`을 절대 경로로 부르는 것이 그 대가다 |
| C14 | 충족 | `out/mac-arm64`(+`.tmp`) 디렉터리째 삭제 → 재빌드 `PACKAGE_RC=0`·`CHECKBUNDLE_RC=0`·**31 PASS/0 FAIL**, wk 키 `bafc8282af270b36` 동일, 기동 15.5초. **`<userData>/models/hub` 47파일의 크기·경로·mtime이 `diff` 0건, 8.8G 불변, 새 `downloading` 0건** |
| C15 | 충족 | `check-bundle.mjs` **31건 PASS** — 패키징 회차마다 재확인(C14 회차 포함) |
| C16 | 충족 | 저장소를 rename해 **디스크에서 사라진 상태**로 사본 실행 — 21초에 네 서비스 running/ok, 저장소 경로 참조 0건, 실행 python 3개 전부 사본 트리, `health=200`, **`config.json` 무변**(옛 `REPO_ROOT`가 적혀 있어도 packaged는 읽지 않는다 — `repo-root.ts`의 `if (q.packaged) return null`). **화면도 확인했다**(2026-09-19 관측 회차, 저장소를 다시 치운 상태로 재기동해 10초에 네 서비스 running/ok): 폴더 선택창 없이 메인 창이 뜨고 회의 목록·전사·요약이 그려졌으며, 상태 창의 디버깅 접속 경로가 **`/Users/gim-yeongjae/Applications/Damwha.app/Contents/Resources/postgres/bin/psql`** — 저장소 밖 사본이다(저장소가 제자리일 때의 같은 줄은 `project/daewha/desktop/out/…`였다) |
| C17 | 충족 | ⌘Q 뒤 번들 python 0·postgres 0·psql 0·Electron 0. **run-id 없는 capabilities 프로브와 `resource_tracker`도 사라졌다** |
| C18 | 충족 | main을 `kill -9` → 고아 4개 + 고아 postmaster → 재실행이 전부 정리(옛 pid 전멸), `"고아 postmaster(pid 49921) 종료 결과 — fast"` |
| C19-a | 충족 | supervisor만 `kill -9` → `"worker: 종료 (코드 137)"`(Task 5 수정 실증 — 전에는 코드 0), `--once`·`llm_entry`가 부모 없이 생존 → ⌘Q에 전부 사라짐 |
| C19-b | 충족 | supervisor+`--once` 동시 `kill -9` → `llm_entry(ppid=1)`만 고아 → ⌘Q에 **B층이 argv run-id로 찾아** SIGTERM. 화면: `"…1개를 종료 마지막 단계에서 찾아 내렸어요 (pid 52548). 내린 프로세스가 모두 끝난 것을 확인했어요."` |
| C20 | **미충족 2회 → 수정 후 충족** | SIGTERM 무시 fixture가 196초+ 생존. 원인: worker의 2차 핸들러가 `proc.kill()`+`os._exit(1)`이라 supervisor가 반드시 즉사 → desktop의 `if (await waitForExit(graceMs)) return …`이 언제나 찍혀 **4단계가 죽은 코드**였고, 단위 테스트는 `stillAlive`를 실물과 반대로 모형화해 초록이었다. 수정(`0bcf4c9`·`c00d6b8`) 뒤 변종 둘로 재판정 — A: `killpg`가 닿는 자리(worker가 거둠), **B: `killpg`가 구조적으로 못 닿는 자리에서 fixture 사망 = desktop 4단계 발화 증거**. 둘 다 `종료:` 줄 0개 = `{stopped:true, leaked:[]}` |
| C21 | **부분 → 충족** | 최초: 외부 worker에 **신호 0**(§6.5 충족)이지만 stand-down이 안 돼 앱이 자기 worker를 띄웠다 — `pnpm worker`의 argv[0]이 `…/Python.app/Contents/MacOS/Python`(심볼릭 링크 실체)이라 basename 조건에서 빠졌다. R-12b 수정 뒤: `"worker: 외부 인스턴스가 있어 앱이 띄우지 않는다 … (pid 84485)"`, 번들 worker 미기동, 외부 worker는 앱 종료 뒤에도 생존 |
| C22 | 충족 | 단위 131건 통과(orphans·reap-on-start·config). 절차서대로 **실앱 발화 경로가 아니다** |
| C23 | 충족 | `__main__.py`에 표식 로그 → dev 재기동에 `P4-C23-DEV-REFLECT-PROBE-003727` 출현(**재빌드 없이**) → 표식 원복(diff 없음) |
| C24 | 충족(**범위 좁힘**) | `pnpm build` 통과, lint rc=0, **BE 487 · FE 594 통과**, `pnpm worker`·`pnpm embed`가 `.venv`로 기동해 Docker DB 접속. 좁힘: **job 행은 만들지 않았다**(절대 불변 — Part 1 R-1과 같은 이유). 처리 로직 회귀는 worker 테스트가 덮는다 |
| C25 | 충족 | worker 테스트 전체(회차별 670 → 673 → **683 passed**) + C5의 실오디오 1건이 이 조건을 닫는다 |
| C26 | **충족(조건)** | `abs-*` 8건 중 `abs-be-storage`만 FAIL이고 차이는 **Finder의 `.DS_Store` 2개**뿐이다(해시가 세션마다 바뀐다). 실데이터 29줄은 바이트 단위 동일, Phase 4 코드에 `be/storage` 쓰기 경로 없음, 기준선 재촬영 안 함. 세션마다 `7 PASS / 1 FAIL`로 재확인 — **무회귀** |
| C27 | 충족 | `app-storage.txt` 기준선 5줄 **전부 존재**(추가 4줄만), `app-meeting-ids.txt`의 mtg_1·mtg_2 **둘 다 존재**, `app-db-rows.txt` 16테이블 **감소 0**(job 6→50, meeting 2→4, utterance 34→81 …). **판정 구간이 갈린다** — 파일은 2026-09-16 기준, DB 행 수는 앱 기준선 재촬영 시점 기준(R-12a로 측정 방식을 바꾼 뒤에야 가능했다) |
| C28 | Part 1에서 완료 | §3.4. 여기서는 재확인만 |
| C29 | 충족 | 캐시가 찬 상태로 Wi-Fi 차단 → 오디오 1건 완주(job_47 process_meeting → job_50 summarize → job_48 index → job_49 extract_lenses, **mtg_4 done**). 차단 구간 내내 **검색 HTTP 201 / hits=20**, 모델 파일 47줄 바이트 단위 동일·8989MB 불변·`downloading=0`. 스펙 개정 `1952305`가 §9에 검색·색인 포함을 명시했고 §6.6-b 캐시 우선 적재가 그것을 닫았다 |
| C30 | 충족 | `config.json`에 `PYTHONHOME`·`HF_HUB_CACHE`를 넣어도 자식 env에 없고 화면이 경고한다(단위 131건에 포함) |

**로드맵 완료 기준 3개**(§219 절)도 이 판정으로 충족이다 — (1) 개발 도구 없는 맥에서 전사·화자분리·
요약·검색 성공(C5·C29), (2) 번들 밖 개발 환경·도구 미참조(C12·C13·C15·C16·C21), (3) 모델·캐시가
패키지 외부에 있고 재실행에 재사용(C9·C14).

### 12.5 검증이 실측으로 잡아 고친 결함

**통합 검증이 리뷰가 못 잡은 것을 넷 잡았다.** 전부 실기동이라야 드러나는 종류다.

| 커밋 | 무엇 | 왜 리뷰가 못 잡았나 |
| --- | --- | --- |
| `b97b6ba` | C21 — 외부 worker 탐지가 **심볼릭 링크로 뜬** `pnpm worker`를 못 본다. `worker-discovery`만 완화하고 `orphans`는 바이트 단위 무변경 | argv[0]이 `.venv/bin/python3`가 아니라 그 실체 경로로 찍히는 것은 실행해야 보인다 |
| `0bcf4c9` | C20 — 종료 4단계가 **프로덕션에서 도달 불가능한 죽은 코드**였다. 3·4단계 재배치 + worker 2차 신호를 `os.killpg`로 | 단위 테스트가 `stillAlive: async (pids) => pids`로 실물과 정반대를 모형화해 초록이었다 |
| `c00d6b8` | 그 수정 리뷰의 must-fix 2 + 테스트 구멍 2 — `poll()` 가드(`killpg`가 pid 재사용 가드를 우회), `!exited` 갈래에서 트리 재탐색(3단계 트리는 유예가 **90초**라 낡는다), 뮤테이션으로 초록이던 구멍 둘 | — |
| `0859727` | C7 셋 — (1) `--once` 자식이 finalize에서 **영구 정지**(멈춘 `hf-xet` 네이티브 스레드가 `threading._shutdown()`을 붙잡는다. 11분 관측, `kill -9`하자 8초 만에 재claim) → `_hard_exit`, (2) 버려진 다운로드 표식이면 캐시 우선을 건너뛴다(부분 캐시를 완전한 캐시로 착각했다), (3) **`mark_processing`의 job 가드** | (3)은 **Phase 4 범위 밖**이다 — 취소가 claim과 `mark_processing` 사이에 들어오면 회의가 도달 불가가 된다(취소도 재처리도 409). `be/docs/backlog.md`에 남겼다 |

`R-12a`의 기준선 측정 수정(테이블별 `count(*)`)과 **데이터 복구 둘**(도달 불가 `mtg_3` 해제, 사고 3의
표식 삭제)도 이 Task에서 났다. `mtg_3` 해제는 **행 수·회의 ID 불변**이라 C27에 영향이 없다.

### 12.6 Part 2가 남긴 제약

고치지 않은 것과 그 이유다. **이 절의 항목을 "고쳤다"로 읽지 않는다.**

**스키마·모델 준비**

1. **`model_readiness`는 repo id로만 키를 잡는데 bge-m3를 두 writer가 쓴다.** embed와 `--once`
   자식(`index_meeting`이 자체 임베더를 만든다)이 같은 키를 쓰므로 늦은 writer가 앞의 유예를
   지우거나 실패를 ready로 뒤집을 수 있다 — **실증됐다**(writer가 `embed` → 처리기 run-id로 바뀌고
   `bytes 0/0`). 제대로 된 수정은 worker+BE+FE+desktop 스키마 변경이라 열어 두었다(최종 리뷰 Important-1).
2. **`_mark_ready`가 mlx 경로에서 부분 캐시를 `ready`로 보고한다** — `whisper_mlx.py:71`의 `load`는
   `snapshot_download`뿐이라 가중치를 읽지 않는데 그 성공을 "통째로 적재됐다"로 읽는다. C7 수정 2의
   전제를 지워 재패키징 직후 첫 회차가 여전히 실패한 이유가 이것이다.
3. **readiness는 캐시 삭제를 모른다** — 파일을 지운 뒤에도 `state: ready`가 남고 writer는 이미 죽은 run-id다.
4. **`llm_entry`는 캐시 우선 적재가 적용되지 않는다**(상한·워치독만). C29에서 요약이 정상 동작함을 확인했다.
5. `model_readiness`의 `entries`가 가지치기되지 않는다(단조 증가).
6. **`model_readiness`는 테이블이 아니라 `app_setting`의 설정 키다** — 이전 기록의 "행"은 그 키를 말한다.

**종료·수명주기**

7. **capabilities 프로브(`-c`, run-id 없음, `start_new_session` 없음)는 supervisor가 먼저 죽으면
   A층도 B층도 거두지 못한다** — 수십 초 뒤 자연 종료하지만 C17/C19의 측정 창과 겹친다(Important-2, 절차로 수용).
8. **`llm_server.py::_wait_ready`가 `shutdown`을 보지 않는다** → LLM 서버 기동 중 SIGTERM이 최대
   600초 무효. **600초보다 나쁘다** — 예산이 `_download_in_progress`가 거짓일 때만 쌓이므로
   다운로드 중이면 무한정 늘어난다.
9. **`worker-shutdown.ts`의 report-only 경로 넷**(진입 `!alive`, `askUser` 없음, 대화상자 뒤 `!alive`,
   supervisor가 유예 안에 스스로 죽음)은 **의도된 stale-snapshot 원칙**이라 그대로 둔다(리뷰 low #7).
10. **⌘Q 시 `stopAll`이 정리 중 서비스에 두 번째 신호를 보낸다**(R-10d). 실측 대가: C20 강제 종료
    두 회차가 job 둘을 `running`인 채 남겼고 reaper가 stale로 거뒀다.
11. **고아 회수의 pid 재사용 잔여 위험**은 R-7g(SIGKILL 직전 args 재확인)로 좁혔을 뿐 0은 아니다.
    `--run-id=` 토큰이 통째로 잘린 줄은 external로 읽혀 건드리지 않는다(`-ww`라 실제로는 안 잘린다).

**재시도·정직성**

12. **같은 job의 재시도 3회가 ~3분에 다 탄다** — 백오프가 `least(power(2, attempts-1), 60)`초라
    1·2초뿐이다. 3분짜리 끊김이 job을 영구 실패로 만들고, 복구 뒤 사람이 재처리를 한 번 눌러야 한다.
    C7의 기준이 "다음 job"이라 판정은 충족이지만 **같은 job은 살아남지 못한다.**
13. **오프라인에서 캐시 건너뛰기가 발화해도 사유가 정직하지 않다** — `snapshot_download`의 조용한
    캐시 폴백 때문에 `uncategorized / load_npz`로 보고된다("HF에 못 닿았고 캐시가 불완전하다"가 아니다).
14. 무거운 처리 중 embed가 `AbortError`로 **키워드 전용 degrade**된다(C29 회차에 6회). 결과는
    정직하지만(HTTP 200/201 유지) **화면이 `semantic=false`를 어떻게 말하는지는 확인하지 않았다.**

**화면·코드 위생**

15. `statusLine`이 **채택된 뒤 degraded된 embed**의 사유를 셸 화면에서만 떨어뜨렸다 — `d6ed75f`가
    게이트를 좁혔다(services 창은 처음부터 정상이었다).
16. **죽은 코드** — `buildChildPath`·`findExecutable`의 호출자 0, `ctx.searchDirs` 소비자 0.
17. `knownBundleDirs`가 `/Applications` 등 **다른 곳에 설치된 packaged**에서 dev 트리 고아를 목록에
    못 올린다(R-P2, 개발자 전용 위험).
18. embed 기동 경합 — 외부 embed가 **모델 적재 중**이면 프로브가 "없음"으로 보고 앱이 같은 포트에
    띄우려다 `errno 48`로 3회 재시도 뒤 수동 재시도를 기다린다. 이미 서빙 중이면 정상 채택한다.
19. dev 앱을 `pkill`로 죽이면 `<userData>`에 `SingletonLock`·`Cookie`·`Socket` 잔재가 남아 **다음
    packaged 기동이 출력 없이 rc=0으로 조용히 물러난다**(설계대로). 그 셋을 지우면 뜬다.
20. `abs-be-storage`가 **Finder의 `.DS_Store` 때문에** 조건부 충족이다(C26).
21. `utterance=81`인데 `utterance_embedding=80` — 빠진 `utt_73`은 `text`가 비어 있어 색인이 건너뛴
    것이라 결함이 아니다. 다만 **전사가 빈 발화 행을 하나 만들었다**는 사실이 남는다.

### 12.7 계획·스펙과 실제가 갈린 곳 (Part 2)

§7과 같은 이유로 계획 파일을 고치지 않고 여기에 적는다.

| 자리 | 계획·스펙이 적은 것 | 실제 | 룰링 |
| --- | --- | --- | --- |
| 스펙 §17 표 — B층 자리 | `quit-flow.ts` | `main.ts::stopServices()` | R-8a |
| 스펙 §6.9 산문 — 무진행 상한 | "5분" | `STALL_MS=120s`(구현) | R-11c |
| 스펙 §9 P4-C7 | 끊겼다 이어받아 **같은 job**이 완주 | 사유 + **다음 job** 완주(바이트 이어받기는 Phase 5). 스펙 개정 `1952305` | 사용자 결정 D-B |
| 스펙 §9 P4-C29 | 오프라인 처리 | **검색·색인 포함**을 명시(같은 개정). Task 9가 "검색·색인에는 거짓"을 발견한 결과 | — |
| 계약 — `PythonLaunchOptions` | `extraEnv`로 HF_TOKEN 전달 | 두지 않는다. `ctx.env` 경로로 | R-5d |
| 계약 — embed 채택 | 이번 run-id를 가진 embed는 채택하지 않는다 | 채택한다(도달 불가 경로) | R-7j |
| Task 12 절차서 — C27 측정 | `query_to_xml` 한 방 | 테이블별 `count(*)` 16회(내장 postgres에 libxml 없음) | R-12a |
| Task 12 절차서 — C16 방식 | 저장소를 옮긴 뒤 제자리 `.app` 실행 | `.app`이 저장소 안이라 **사본을 밖에 두고** 저장소를 rename | 사용자 승인 |

**최종 리뷰가 문서 조건으로 건 2건**은 Task 12 Step 6에서 닫았다 — `be/worker/.env.example`의
`LENS_LLM_SERVER_BIN=mlx_lm.server`(복사하면 **표식 없는 탈출구**로 간다)를 빈 값 + 설명으로,
`desktop/CLAUDE.md`의 uv 런처 서술을 번들 python 서술로. 같은 파동에서 `README.md`·`README.ko.md`·
`be/CLAUDE.md`·`be/worker/SMOKE.md`·`deploy/Makefile`·`deploy/README.md`의 "mlx-lm을 PATH에 따로
깔아라" 서술도 고쳤다 — mlx-lm 0.31.3은 이제 worker의 `models` extra에 고정돼 있다.

### 12.8 미검증·미관측으로 남는 것

§11과 같은 규칙이다. **아래를 "동작한다"로 읽지 않는다.**

1. **P4-C2의 절반** — `<userData>`와 로그 전수에서 토큰 문자열을 찾는 grep. 토큰 원문을 쥔
   **사용자만 실행할 수 있다.** 파일이 바이너리(0600, 51바이트)라는 것까지가 이 문서의 증거다.
2. **C7의 화면 사유를 직접 보지 않았다.** 증거는 `model_readiness`의 `error` 전문과
   `error_kind=TRANSIENT`이고, 화면은 그 값을 그리는 코드 경로다.
3. **C7 1단계의 전제(버려진 다운로드 표식)는 `app_setting`에 시뮬레이션해 넣은 것**이다(R-12g).
   2단계에서 실제 끊김으로 다시 확인했다.
4. ~~C16의 화면을 직접 보지 않았다~~ — **2026-09-19에 관측했다.** 저장소를 다시 치운 상태로
   사본을 띄워 폴더 선택창 없는 기동과, 상태 창의 psql 경로가 저장소 밖 사본을 가리키는 것을
   화면으로 확인했다(§12.4의 C16 행).
5. **C11의 `~/.local/bin/mlx_lm.server` 일시 격리 회차는 돌리지 않았다.** 증거는 argv가 번들
   python의 `-m damwha_worker.llm_entry`라는 것이고, 기본 경로가 PATH를 보지 않는다는 것은 코드다.
6. **C13의 `lsof` 전 구간 샘플링 기록이 없다.** 판정은 구조적 증명(자식 PATH에 개발 도구가 없다)이다.
7. **C6의 다운로드 진행 표시는 여전히 미관측이다.** 준비 완료 상태(다섯 모델 `● 준비됨`)는 화면으로 확인했지만(§12.4), 진행 막대·바이트는 받는 중이어야 떠서 이 회차에 볼 수 없었다.
8. **`semantic=false`를 화면이 어떻게 말하는지 확인하지 않았다**(§12.6-14).

### 12.9 사용자에게 남은 숙제

- **검증용으로 대화에 붙였던 미수락 계정 HF 토큰을 폐기(revoke)한다.**
- **P4-C2 잔여** — 토큰 문자열로 `<userData>`와 로그를 전수 grep한다.
- 수락 계정 토큰은 앱에 저장돼 있다(`hf-token.bin`). C14에서 `.app`을 갈아도 그대로 쓰인다.
