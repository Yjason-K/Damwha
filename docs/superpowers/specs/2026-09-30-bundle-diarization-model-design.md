# 화자 분리 모델 번들 — HF 토큰 없이 쓰는 앱 (구현 스펙)

작성일: 2026-09-30
선행: `dev` = `b5e7d47` (desktop 0.4.2). 브랜치 `feature/bundle-diarization-model`.
대체: [2026-09-25 HF 토큰 스펙](2026-09-25-hf-token-in-app-design.md) 전체. 그 문서는 날짜가 박힌 기록이라
고치지 않는다 — 이 스펙이 이긴다.

## 1. 목표

**사용자는 Hugging Face 계정도 토큰도 없이 설치 직후부터 화자 분리까지 쓴다.**

지금 앱은 화자 분리가 필요한 동작(새 회의·재처리·화자 분리 모델 다운로드)을 HF 토큰으로 막는다. 사용자는
HF 가입 → 모델 사용 조건 동의 → 토큰 발급 → 앱에 붙여넣기를 거쳐야 한다. 제품의 핵심 기능 앞에 놓인 가장
큰 진입장벽이다.

토큰이 필요한 모델은 `pyannote/speaker-diarization-community-1` 하나다(2026-09-30 HF API 확인 — 카탈로그의
나머지 whisper 6종·Qwen3.5 3종·`BAAI/bge-m3`·`speechbrain/spkrec-ecapa-voxceleb`는 `gated: false`).
그 모델은:

- 라이선스 **CC-BY-4.0** — 출처 표기 조건으로 재배포가 허용된다.
- 게이트 `auto` — 자동 승인이다. 게이트의 목적은 권리 보호가 아니라 연락처 수집이고, 게이트 문구 자체가
  "will always remain freely accessible"이라고 적는다.
- 31 MB(리비전 `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`) — `config.yaml`, `segmentation/pytorch_model.bin`,
  `embedding/pytorch_model.bin`, `plda/plda.npz`, `plda/xvec_transform.npz`. `config.yaml`이 하위 모델을
  `$model/segmentation`처럼 **상대 경로**로 가리켜 폴더 하나가 자기 완결이다.

그래서 이 모델만 앱에 싣고, 토큰 기능은 걷어낸다. 다른 모델은 지금처럼 처음 쓸 때 받는다.

## 2. 범위

### 2.1 포함

- 빌드 때 모델을 받아 `Resources/models/`에 싣는 스크립트와 번들 검사(§4).
- worker가 번들 폴더에서 토큰 없이 적재하는 경로, 번들 모델의 inventory 보고(§3).
- pyannote 텔레메트리 끄기(§3.5).
- desktop·fe의 HF 토큰 기능 전부 제거, 기존 토큰 파일 삭제(§5).
- 문서 갱신과 CC-BY-4.0 출처 표기(§6).

### 2.2 제외

- 다른 모델의 번들. 비게이트이고 크다(whisper large-v3만 3 GB).
- 셀프호스팅 웹·터미널 worker의 토큰 제거. 앱 없이 `pnpm worker`를 돌리는 개발 경로는 지금처럼
  `HF_TOKEN`으로 hub에서 받는다(§3.1 폴백).
- 이미 `<userData>/models/hub`에 받아 둔 community-1 사본의 정리. 31 MB이고 지워도 얻는 것이 작다. 모델
  카드의 합계 용량에 남는다(알려진 한계).
- 공증·DMG·릴리스 발행.

## 3. worker

### 3.1 적재 — `registry.py`·`pyannote_diar.py`

- `Settings.diarization_model_dir: str | None = None` — env `DIARIZATION_MODEL_DIR`.
- `build_models`가 `PyannoteDiarizer`에 `bundle_dir`을 넘긴다. 규칙:
  - 요청 모델(payload의 `diarization.model`)이 `specs.DIARIZATION_MODEL`과 같고 `bundle_dir`이 설정돼 있으면
    **번들 경로**: `Pipeline.from_pretrained(bundle_dir)`. `token`을 넘기지 않고 `load_cache_first`를
    거치지 않는다 — pyannote 4.0.5는 `os.path.isdir(checkpoint)`면 hub를 부르지 않는다
    (`pyannote/audio/core/pipeline.py:174-179`, `core/model.py:557-566`, `core/plda.py:95-101`).
  - 그 밖(설정 없음, 또는 다른 모델 id)은 **지금 경로 그대로** — `load_cache_first` + `token=hf_token`,
    401·403 매핑(`_raise_auth_failure`) 유지.
- 저장된 job payload는 repo id 문자열을 그대로 싣는다(`be/src/config/env.ts:25` →
  `job-payload.schema.ts:242`). 매핑은 worker가 하므로 payload·API는 바꾸지 않는다. 옛 job도 번들로 돈다.
- 번들 경로는 `from_pretrained` **전에** 명세(`specs._fixed_specs()`의 diarization `required`, 파일 다섯)가
  전부 일반 파일로 있는지 본다. 하나라도 없으면 `WorkerError(DIARIZATION_BUNDLE_MISSING, PERMANENT)` — 새 코드
  `diarization_bundle_missing`. 번들이 깨진 것이라 재시도로 풀리지 않는다. 실행 시 해시는 재지 않는다 —
  무결성은 빌드(§4.1)·봉인(§4.4)이 맡는다(§4.5). `from_pretrained`의 다른 예외는 지금처럼
  `errors.classify`에 맡긴다.
- 번들 유효성 판정(`bundle_complete(bundle_dir) -> bool`)은 한 함수로 두고 §3.1·§3.2·§3.3이 같이 쓴다.
- 번들 경로도 적재에 성공하면 `model_readiness`의 그 키를 `ready`로 표시한다. `load_cache_first`가 하던
  `_mark_ready`를 같은 함수로 부른다 — 상태 창 모델 줄이 "준비 중"에 멈추지 않게.

### 3.2 inventory — `inventory.py`

- `build_inventory(..., diarization_model_dir: str | None)` — 인자로 명시하고, 호출자
  `run_inventory_loop`가 `Settings.diarization_model_dir`를 넘긴다. 그 폴더가 `bundle_complete`이면 `repos[DIARIZATION_MODEL]`을
  `{"size_bytes": <폴더 파일 합>, "complete": true}`로 **덮어쓴다**. HF 캐시에 옛 사본이 있어도 번들이 이긴다.
- API(`model-inventory.ts`)의 행 모양은 바뀌지 않는다 → `models-view.ts`가 `installed: "yes"`로 읽고
  fe 카드는 "받음"을 그린다. 다운로드 버튼은 installed가 yes라 안 뜬다. 삭제는 지금도 막혀 있다
  (`model_jobs._DELETABLE`).
- 필요한 파일 하나라도 없으면 덮어쓰지 않는다 — 캐시 스캔 결과가 그대로 보인다(대개 `no`).
- 테스트: 캐시 사본 있음 + 유효 번들 → 번들이 이김, 캐시 사본 있음 + 깨진 번들 → 캐시 결과.

### 3.3 다운로드 job

- `_download_kwargs`의 `token: hf_token`은 그대로 둔다. 앱에서는 `HF_TOKEN`이 오지 않으므로 None이 간다 —
  비게이트 모델은 토큰 없이 받아진다.
- **업그레이드 전에 대기열에 선 화자 분리 다운로드 job.** 옛 앱에서 토큰이 있던 사용자가 넣은
  `download_model`(role diarization)이 새 앱에서 돌면 토큰 없이 게이트 저장소를 불러 401로 실패한다.
  worker는 그 job의 모델이 `DIARIZATION_MODEL`이고 번들이 `bundle_complete`이면 **아무것도 받지 않고 성공으로
  끝낸다**(readiness `ready`). 번들이 없으면(개발 경로) 지금처럼 받는다. 테스트를 둔다.

### 3.4 라이브 세션

라이브 미리보기(`build_live_models`)는 pyannote를 띄우지 않는다 — 바뀌는 것 없다. 녹음을 멈추면 worker
(`db/live.py`)나 API(`live.service.ts`)가 `process_meeting`을 넣고, 그 job이 §3.1의 번들 경로로 화자 분리를
한다. 업로드와 같은 경로라 따로 배선할 것은 없고, 실측(§7)에 라이브 녹음 → 마무리 화자 분리를 넣는다.

### 3.5 텔레메트리

pyannote.audio 4.x는 `telemetry/config.yaml`의 `metrics_enabled: true`로 `otel.pyannote.ai`에 사용 통계를
보낸다. env `PYANNOTE_METRICS_ENABLED`가 이미 있으면 그 값을 쓴다(`telemetry/metrics.py:139-156`).
desktop이 모든 python 자식(worker·embed)에 일관되게 `PYANNOTE_METRICS_ENABLED=false`를 싣는다(§4.3) —
pyannote를 import하는 것은 지금 worker의 `process_meeting` 자식뿐이다. worker의 `--once` 자식은 env 없이
spawn돼 supervisor의 env를 물려받으므로(`__main__.py`) `DIARIZATION_MODEL_DIR`과 함께 따로 배선하지 않는다. `be/worker/.env.example`에도 적는다.

### 3.6 개발 스크립트

`be/worker/scripts/`(`download_models.py`·`smoke_*.py`·`eval_*.py`)는 **바꾸지 않는다** — 터미널 전용이고
`HF_TOKEN`을 요구한다. 일부는 registry를 거치지 않고 `Pipeline.from_pretrained`를 직접 부르며
(`eval_speaker_attribution.py`), `eval_stt.py`는 옛 `speaker-diarization-3.1`을 적재한다. 번들로 옮기는 것은
이 스펙 밖이다. `SMOKE.md`에는 "앱 밖 개발 스크립트는 토큰이 필요하다"를 남긴다(§6).

## 4. 패키징 — desktop

### 4.1 `desktop/scripts/build-models.sh` (새)

`build-ffmpeg.sh`와 같은 모양이다.

- 고정값: 저장소 `pyannote/speaker-diarization-community-1`, 리비전 `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee`.
- `desktop/scripts/models-checksums.txt`(커밋): 다섯 파일의 sha256. `shasum -a 256 -c`로 대조한다.
- 받기: worker venv(`uv run --directory be/worker python -c …`)의
  `huggingface_hub.snapshot_download(repo, revision=…)`. 게이트 모델이라 **빌드하는 머신에만** 토큰이
  필요하다 — 개발자의 HF 캐시·`hf auth login`·`HF_TOKEN`을 그대로 쓴다. 실패하면 "HF 토큰으로 로그인하고
  모델 사용 조건에 동의하라"는 안내와 주소를 찍고 멈춘다.
- 캐시 키 = 저장소·리비전·체크섬 파일·스크립트 자신의 해시. 캐시 `desktop/.cache/models/<키>`,
  스테이징 `desktop/build/models/pyannote-speaker-diarization-community-1/`. HF 캐시 snapshot은 blob
  심링크라 **역참조해 실제 파일로** 복사한다(`cp -L`/`ditto`).
- 스테이징 폴더에 `NOTICE.txt`를 쓴다 — 모델 이름·저장소 URL·리비전·CC-BY-4.0 라이선스 URL·
  "Damwha가 변경 없이 재배포함".
- 스테이징 **전에** 체크섬을 대조한다 — 어긋나면 스테이징하지 않고 멈춘다.
- `--fresh`: 이 키의 캐시를 버린다. `--print-key`는 두지 않는다(빌드가 몇 초라 필요 없다).

### 4.2 연결

- `desktop/package.json`의 `start:desktop`과 `scripts/package.mjs`의 빌드 순서에 `build-models.sh`를 더한다.
- `electron-builder.yml`은 고치지 않는다 — `extraResources: from: build`가 `Resources/models/`로 싣는다.
- 모델 파일은 Mach-O가 아니다 — 개별 서명 대상이 아니고 `.app` 봉인에 들어간다.

### 4.3 경로와 env

- `main.ts`의 `bundleDir` 이름에 `"models"`를 더한다(packaged: `process.resourcesPath/models`, dev:
  `app.getAppPath()/build/models`).
- `process/runtime-paths.ts`에 `diarizationModelDir(modelsBundleDir)` —
  `<dir>/pyannote-speaker-diarization-community-1`. 폴더 이름의 원천은 이 함수와 `build-models.sh` 둘이고,
  테스트가 스크립트 문자열과 대조한다.
- `ctx.bins`(또는 같은 결의 필드)에 경로를 싣고, `appOwnedChildEnv`가
  `DIARIZATION_MODEL_DIR=<경로>`·`PYANNOTE_METRICS_ENABLED=false`를 얹는다. 둘 다 `APP_OWNED_KEYS`에 넣어
  config.json 값은 무시한다(`FFMPEG_BIN`과 같은 규칙).
- `HF_HOME=<userData>/models`(HF 캐시)와 이름이 겹치지 않게 번들 쪽은 항상 `Resources/models`/
  `DIARIZATION_MODEL_DIR`로 부른다.

### 4.4 `check-bundle.mjs`

새 검사 그룹: `Resources/models/pyannote-speaker-diarization-community-1/`의 다섯 파일이 있고 sha256이
`models-checksums.txt`와 같으며 `NOTICE.txt`가 있다.

### 4.5 신뢰 경계

pyannote는 체크포인트를 `weights_only=False`로 적재한다(pickle 가능, `core/model.py:601-625`). 그래서 번들
파일은 **신뢰하는 릴리스 산출물**로 다룬다: 빌드 때 고정 리비전 + 커밋된 sha256으로 대조하고(§4.1), 패키징
뒤 `check-bundle`이 다시 대조하며(§4.4), 그 뒤로는 `.app` 서명 봉인이 지킨다. dev의
`desktop/build/models`는 개발자가 만든 입력이라 신뢰한다 — 실행 시 해시 검사는 두지 않는다.

## 5. 토큰 기능 제거

### 5.1 desktop

- 삭제: `config/token-store.ts`, `app/token-boot.ts`, `windows/token-bridge.ts`,
  `windows/apply-token-change.ts`와 각 테스트.
- `main.ts`: 전역 `hfToken`, `createTokenBridge` 배선, `tokenBridge.attach`(두 곳), 기동 시 읽기,
  `launchEnv`의 토큰 인자, 상태 창의 `maskedToken`·`tokenStatus`, `safeStorage` import를 걷는다.
- **기존 토큰 파일 삭제**: 기동 때 `<userData>/hf-token.bin`을 지운다(없으면 아무것도 안 함, 실패는
  로그만 — 기동을 막지 않는다). 순수 함수로 빼서 테스트한다. `desktop/CLAUDE.md` "지키는 것"의 삭제
  목록에 더한다.
- `config/config.ts`:
  - `childEnv`가 상속 env에서 `HF_TOKEN`을 버리는 규칙은 **남긴다** — 개발자 셸의 토큰이 앱 동작(번들이
    없을 때의 hub 폴백)을 조용히 바꾸지 않게.
  - `PYTHON_ONLY_ENV_KEYS`는 `HF_TOKEN` 하나를 위한 장치였다 — 없앤다. `nodeChildEnv`도 그것만 하면 없앤다.
  - `APP_OWNED_KEYS`의 `HF_TOKEN` 항목은 남기고 규칙 문구를 "앱은 HF 토큰을 쓰지 않습니다"로 바꾼다.
  - `launchEnv`의 `hfToken` 인자를 없앤다.
- 상태 창: `services.html`의 "허깅페이스 토큰" 줄, `status-view.ts`의 `TokenView`·토큰 안내 문구·
  401(`hf_token_invalid`)·403(`hf_gate_not_accepted`) 분기를 뺀다. 모델 줄의 그 둘은 일반 실패
  (`modelDownloadFailed`)로 떨어진다.
- `diagnostics/causes.ts`·`windows/shell-hints.ts`: `hfTokenInvalid`·`hfGateNotAccepted`·
  `safeStorageUnavailable`(토큰 전용 — 2026-09-30 확인)을 뺀다. `diarizationBundleMissing`을 더한다 —
  "앱에 포함된 화자 분리 모델을 찾을 수 없어요." / 힌트 "앱을 다시 설치해 주세요."
- `services/model-readiness.ts`의 `HF_TOKEN_INVALID_CODE`·`HF_GATE_NOT_ACCEPTED_CODE`를 뺀다.
- "token-bridge를 본떴다"는 주석(`language-bridge.ts`, `status-window.ts`, `release-check.ts`,
  `ui-language-store.ts`)은 규칙을 직접 적는 문장으로 고친다. 주석만 바뀐다.

### 5.2 fe

- 삭제: `features/hf-token/` 전체.
- 게이트 제거: `app/app-shell.tsx`(provider·온보딩), `features/meeting/ui/left-nav.tsx`(새 회의 버튼·N
  단축키), `features/meeting/ui/transcript-pane.tsx`(재처리), `features/models/ui/model-row-actions.tsx`
  (다운로드·`HfFailureAction`).
- `pages/settings.tsx`의 토큰 섹션, `features/meeting/lib/desktop-bridge.ts`의 `hfToken` 필드,
  `eslint.config.js`의 react-refresh 허용 이름 둘.
- 실패 문구:
  - `pages/meeting.tsx` 배너 — `hf_token_invalid`·`hf_gate_not_accepted`는 일반 실패 문구로. 그 회의는
    재처리하면 번들로 성공한다.
  - `diarization_bundle_missing` — "앱에 포함된 화자 분리 모델을 찾을 수 없어요. 앱을 다시 설치해 주세요."
  - `features/models/lib/actions.ts`의 `jobErrorText`에서 두 코드를 뺀다.
- i18n 키는 없다(토큰 문구는 컴포넌트 안 하드코딩이었다). 새 문구도 주변 코드의 방식을 따른다.

### 5.3 be(API)

바꾸지 않는다. 테스트 픽스처의 `hf_gate_not_accepted` 문자열은 옛 readiness 행 모양 검증이라 그대로 둔다.

### 5.4 worker

§3.1의 폴백을 위해 `Settings.hf_token`·`HF_TOKEN_INVALID`·`HF_GATE_NOT_ACCEPTED`·`_raise_auth_failure`를
남긴다.

## 6. 문서

- `README.md`·`README.ko.md`: 필수 조건 표·`.env` 설명에서 토큰을 뺀다. "ML models (gated, heavy)" 절을
  "화자 분리 모델은 앱에 포함, 나머지는 처음 쓸 때 받는다"로 고친다(옛 3.1·segmentation-3.0 언급도).
  License 절의 "neither vendored nor redistributed"를 고치고 pyannote CC-BY-4.0 출처를 적는다. 앱 없이
  worker를 돌리는 개발 경로의 토큰 안내는 개발 절에 한 단락으로 남긴다.
- `docs/HUGGINGFACE.md`: 삭제한다(사용자용 토큰 안내서). 그 문서로 가는 링크를 같이 고친다.
- `docs/MODELS.md:50`, `desktop/CLAUDE.md`(토큰 bullet → 번들 규칙, `Resources/` 표에 `models/`, 명령에
  `build-models.sh`, 캐시 경로에 `models`), `fe/CLAUDE.md:162`, `be/CLAUDE.md`(gated chain·`HF_TOKEN`
  문구), `be/docs/worker-architecture.md`, `be/worker/SMOKE.md`, `be/worker/.env.example`, `be/.env.example`.
- `site/src/i18n/en.ts:77`·`ko.ts:79`의 "Hugging Face 토큰" 요구 항목을 뺀다.
- 과거 기록(`docs/electron-migration-roadmap.md`, 옛 스펙)은 고치지 않는다.

## 7. 테스트와 검증

TDD — 실패하는 테스트를 먼저 쓴다.

- worker: 번들 경로 적재(가짜 `Pipeline.from_pretrained`가 폴더 경로·토큰 없음으로 불린다, readiness
  `ready`), 설정 없음 → 기존 hub 경로, 다른 모델 id → 기존 경로, `config.yaml` 없음 → PERMANENT
  `diarization_bundle_missing`, inventory 덮어쓰기(파일 전부 있을 때만).
- desktop: `diarizationModelDir`, 폴더 이름이 `build-models.sh`와 같음, `appOwnedChildEnv`의 두 env와
  `APP_OWNED_KEYS`, 토큰 파일 삭제 함수, 상태 창에 토큰 줄 없음, `check-bundle` 새 그룹.
- fe: 새 회의·재처리·다운로드가 게이트 없이 바로 열림, `diarization_bundle_missing` 문구.
- 제거한 기능의 테스트는 함께 지운다 — 파일째 지우는 것(`tests/config/token-store.test.ts`,
  `tests/app/token-boot.test.ts`, `tests/windows/token-bridge.test.ts`, `tests/windows/apply-token-change.test.ts`,
  `fe/src/features/hf-token/**/*.test.*`) 외에 부분 수정: desktop `status-view.test.ts`(토큰 줄·401/403),
  `config.test.ts`(HF_TOKEN python 전용 블록), `config-reload.test.ts`, `api-process.test.ts`,
  `postgres/migration-runner.test.ts`, `shell-html.test.ts`(`maskToken` import), fe `models-card.test.tsx`(게이트·
  403 UI), `actions.test.ts`, `left-nav`·`transcript-pane`·`app-shell` 관련 테스트, worker `test_pyannote_diar.py`·
  `test_offline_load.py`(번들 경로 추가). 통과 기준: `pnpm test`, `pnpm lint`, `pnpm worker:test`, desktop
  vitest, `pnpm fe build`.
- 실측:
  1. `bash desktop/scripts/build-models.sh`로 스테이징하고 체크섬 대조.
  2. `pnpm desktop:dev` — 셸에 `HF_TOKEN` 없이, `<userData>/hf-token.bin`을 미리 만들어 둔 상태로 기동 →
     파일이 지워진다. 회의 하나를 업로드 → 화자 분리까지 성공. 모델 카드에 화자 분리가 "받음".
  3. 라이브 녹음 → 멈춤 → 마무리 `process_meeting`의 화자 분리 성공.
  4. 스테이징한 폴더로 실제 적재: `uv run --directory be/worker python -c` 로
     `Pipeline.from_pretrained(<desktop/build/models/...>)`가 네트워크 없이(`HF_HUB_OFFLINE=1`) 성공.
  5. 텔레메트리: launcher 단위 테스트가 `PYANNOTE_METRICS_ENABLED=false`를 단언하고, worker 테스트가 그 env에서
     `pyannote.audio.telemetry.metrics.is_metrics_enabled()`가 False임을 단언한다.
  6. `pnpm desktop:build` → `check-bundle` 통과.
