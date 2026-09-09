# Phase 0 의존성 조사 — U-4 / U-5

**작성:** Task 1 (실험 하네스). 기준 코드 `4f0b02c`.

이 문서는 스펙 §7.2가 "계획 첫 Task에서 해결한다"고 남긴 두 항목의 결론이다.
제품 코드는 한 줄도 고치지 않았다 — 읽기만 했다 (스펙 §3.2).

---

## U-4 — `sounddevice`(PortAudio)가 실사용 경로에 남아 있는가

**결론: 실사용 경로에 없다. 그래도 번들에 포함한다.**

### 실사용 경로가 없다는 근거

`sounddevice`를 실제로 부르는 것은 `MicSource` 하나뿐이고
(`be/worker/damwha_worker/audio/source.py:70` `_import_sounddevice()`,
`source.py:83` `class MicSource`, `source.py:106`에서 지연 import),
`MicSource`를 만드는 자리를 역추적하면 제품 경로가 남아 있지 않다.

1. 워커의 유일한 라이브 소스 팩토리는 `default_live_source`다.
   `be/worker/damwha_worker/__main__.py:206`이 `build_live_source_fn=default_live_source`로
   못 박는다.
2. `be/worker/damwha_worker/jobs.py:381`은 `payload.source == "browser"`일 때만
   `TailSource`를 만들고, 그 외에는 `jobs.py:392`에서
   `live source ... is not supported — capture moved to the browser`로
   **즉시 PERMANENT 거절**한다. `MicSource`로 가는 분기 자체가 없다.
3. 남은 호출자는 둘 다 제품 경로가 아니다.
   - `be/worker/scripts/smoke_live_session.py:213` — `--mic` 플래그를 준 개발자
     smoke 도구. 배포물에 들어가지 않는다.
   - `be/worker/tests/test_audio_source.py:86,101,124,133` — 전부
     `sounddevice_module=` 로 가짜 모듈을 주입한다. `:143`
     `test_mic_source_without_sounddevice_installed_is_permanent`는 반대로
     import가 **실패하는** 경로를 시험한다. 즉 테스트 스위트는 진짜
     `sounddevice`를 한 번도 import 하지 않는다.

`source.py:87-90`의 주석이 이 상태를 그대로 적어 두었다 — `MicSource`는
시스템 오디오 캡처 구현이 들어올 자리의 참조 구현으로 **일부러** 남긴 것이다.

### 그런데도 번들에 포함하는 이유

- 스펙 §7.2 U-4의 기본 제안이 "불확실하면 포함한다 — 빼서 깨지는 쪽이 더
  비싸다"이다. 여기서는 불확실하지도 않지만, 아래 두 가지가 포함 쪽을 강제한다.
- **스펙 P0-C3이 `models` extra 전량 설치를 요구한다.** `sounddevice==0.5.2`는
  `be/worker/pyproject.toml:47`에 있는 `models` extra의 일원이다. 이걸 빼면
  Task 3이 검증하는 것이 "지금 워커가 쓰는 스택"이 아니게 되고, Task 3의
  버전 대조(V5)도 pyproject와 어긋난다.
- **`import damwha_worker.audio.source`는 `sounddevice` 없이도 성공한다.**
  import가 함수 안에 있어서다(`source.py:70-80`). 그래서 "빼도 당장은 안
  깨진다"가 성립하고, 바로 그래서 **런타임에만** 깨진다 — 로드맵이 시스템
  오디오 캡처를 다시 켜는 순간 PERMANENT `audio_device_failed`로 나타난다.

### Phase 4로 넘기는 판단

`sounddevice`는 PortAudio 네이티브 라이브러리를 끌고 온다. G1의 재배치 검사
대상이며(R-3과 같은 성격), 실사용 경로가 없는 지금은 **용량 최적화 후보**다.
빼는 결정은 로드맵이 시스템 오디오 캡처의 구현 방식을 정한 뒤에 한다. Task 3은
포함한 상태로 검증하고, 그 결과(PortAudio가 재배치를 견디는가)를 남긴다.

---

## U-5 — Whisper 카탈로그 중 무엇을 Task 9의 실측 대상으로 삼는가

**결론: 프리셋이 실제로 쓰는 것만 실측하고, 나머지는 산정만 한다.**
스펙 §7.2 U-5의 기본 제안("프리셋이 쓰는 것 + `large-v3-turbo`")을 따르되,
프리셋의 `devices.stt`까지 보면 **백엔드가 갈려서 저장소가 달라진다**는 것이
조사에서 드러났다. 그 부분을 반영해 구체화한다.

### 프리셋 → 백엔드 → 저장소

`be/src/settings/presets.ts:21-35`가 프리셋을 정하고,
`be/worker/damwha_worker/models/registry.py:24`(및 라이브 경로 `:59`)가
`devices.stt`로 백엔드를 고른다 — `gpu`면 mlx-whisper, `cpu`면 faster-whisper.

| 프리셋 | whisper_model | devices.stt | 백엔드 | 실제 내려받는 저장소 |
| --- | --- | --- | --- | --- |
| light | `small` | **cpu** | faster-whisper | `Systran/faster-whisper-small` |
| standard | `large-v3-turbo` | gpu | mlx-whisper | `mlx-community/whisper-large-v3-turbo` |
| quality | `large-v3` | gpu | mlx-whisper | `mlx-community/whisper-large-v3-mlx` |

매핑 근거: `be/worker/damwha_worker/models/whisper_mlx.py:19` `_REPO`,
`be/worker/damwha_worker/models/whisper_faster.py:15` `_MODEL`,
그리고 faster-whisper 1.2.1의 `faster_whisper/utils.py:11` `_MODELS`
(`small` → `Systran/faster-whisper-small`).

### Task 9의 실측 / 산정 구분

계획 Task 9는 "light·standard가 쓰는 모델은 실제로 내려받아 실측"이라고
정했다. 위 표를 대입하면 다음과 같다.

**실측(빈 샌드박스 캐시에서 실제 다운로드)**

- `Systran/faster-whisper-small` — light의 STT
- `mlx-community/whisper-large-v3-turbo` — standard의 STT
- `mlx-community/Qwen3.5-4B-8bit` — light의 요약 LLM. Task 5의 `mlx_lm.server`
  검증에도 같은 모델을 쓴다(스펙 P0-C5b)
- `BAAI/bge-m3`, silero-vad, `speechbrain/spkrec-ecapa-voxceleb`,
  pyannote 게이트 3종 — 프리셋과 무관하게 전 프리셋이 쓴다

**산정(HF 파일 메타데이터로 계산, 내려받지 않음)**

- `mlx-community/whisper-{tiny, base-mlx, small-mlx, medium-mlx, large-v3-mlx}`
  — `_REPO`의 6종 중 프리셋이 안 쓰는 5종. `large-v3-mlx`는 quality가 쓰지만
  quality 자체가 산정 대상이다.
- `Systran/faster-whisper-{tiny, base, medium, large-v3}` — cpu STT를 custom
  설정으로 고른 경우의 대응 저장소
- `mlx-community/Qwen3.5-9B-8bit` — standard의 요약 LLM. **standard 프리셋이지만
  산정으로 둔다.** 아래 디스크 사유를 본다.
- `mlx-community/Qwen3.5-27B-8bit` — quality. 스펙 P0-C13이 명시적으로
  내려받지 말라고 한 항목(R-7, R-11, R-14)

### `Qwen3.5-9B-8bit`을 산정으로 두는 이유 (Task 9가 다시 판단할 것)

데이터 볼륨 여유가 **25 GiB**다(`preflight.sh`의 실측, 2026-09-09).
Task 3의 번들 Python(torch + mlx 포함)만으로도 수 GiB를 먹고,
위 실측 목록에 9B 8bit(대략 10 GiB급)를 더하면 R-14의 "조용히 디스크를 채워
개발 환경까지 죽인다"에 그대로 걸린다. Task 9는 `preflight.sh`로 여유를 다시
재고, 남는다면 9B를 실측으로 승격하고 아니면 산정으로 남긴 뒤 그 사실을
`SIZING.md`에 `산정`으로 표시한다. **산정값을 실측으로 적지 않는다**
(스펙 P0-C13).

### 조사 중 드러난 것 — 고치지 않고 기록만 한다

faster-whisper 1.2.1의 `_MODELS`에는 **`large-v3-turbo` 항목이 없다**
(`faster_whisper/utils.py:11-27`). `download_model`은 이름에 `/`가 없으면
`_MODELS`에서만 찾고, 없으면 `ValueError: Invalid model size`를 낸다
(`utils.py:82-89`). 즉 `whisper_model='large-v3-turbo'` + `devices.stt='cpu'`
조합은 모델 생성 시점에 죽는다. 이름 있는 프리셋 중에는 그런 조합이 없어서
(standard는 `stt=gpu`) 지금은 드러나지 않지만, 설정 화면에서 개별 필드를
바꿔 `custom`으로 만들면 만들 수 있는 조합이다.

Phase 0의 범위가 아니므로 **고치지 않는다**(스펙 §3.2). Task 9의 산정 표에서
`Systran/faster-whisper-large-v3-turbo`에 해당하는 행이 비는 이유이기도 하니
여기 남긴다.
