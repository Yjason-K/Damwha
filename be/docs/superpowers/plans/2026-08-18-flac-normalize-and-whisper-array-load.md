# FLAC 정규화 + mlx-whisper 배열 로드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커 정규화 산출물을 16 kHz mono WAV에서 16 kHz mono FLAC으로 바꾸고, 그 전에 mlx-whisper가 클립마다 파일 전체를 재디코드하던 경로를 오디오 1회 로드로 고친다.

**Architecture:** 순서가 중요하다. mlx-whisper는 `speech_spans` 하나당 `mlx_whisper.transcribe(wav_path, ...)`를 개별 호출하고, 매 호출이 `load_audio()`로 파일 전체를 ffmpeg 디코드한다. WAV에서는 I/O 비용뿐이지만 FLAC에서는 디코드 CPU가 클립 수만큼 곱해진다. 따라서 Task 1에서 오디오를 한 번만 로드해 `mx.array`로 재사용하도록 고친 뒤에야 Task 2에서 컨테이너를 FLAC으로 바꾼다. Task 3은 FLAC이 브라우저 `<audio>`로 나갈 때 필요한 Content-Type을 붙인다.

**Tech Stack:** Python 3.12 / pytest (worker), NestJS + Jest (be), ffmpeg CLI, mlx-whisper, soundfile(libsndfile), pyannote.audio, silero-vad

**Spec:** 별도 스펙 문서 없음 — 이 계획이 스펙을 겸한다. 근거는 아래 "결정 근거"에 인라인으로 싣는다.

## Global Constraints

- 저장소는 `be/` 하나. 브랜치 `dev`. `fe/`는 이번 변경에서 손대지 않는다.
- 정규화 샘플레이트 16000, 채널 1은 불변. 바꾸는 건 컨테이너/코덱뿐이다.
- FLAC은 무손실 — 정규화 PCM은 기존 WAV와 비트 단위로 동일하다. 임베딩·전사 결과가 달라지면 안 된다. 이를 위해 `-sample_fmt s16`이 필수다(아래).
- 워커 테스트는 실모델 없이 돌아야 한다. `sys.modules` stub 패턴(`worker/tests/test_whisper_adapters.py`)을 유지하고 `models` extra에 의존하는 테스트를 새로 만들지 않는다.
- ruff line-length 100, target py312.
- `-f` 포맷 플래그는 반드시 명시 유지한다. `normalize()`는 `.tmp` 접미사 임시 파일에 쓰므로 ffmpeg가 확장자로 컨테이너를 추론할 수 없다.
- `-sample_fmt s16`도 필수다. 실측: 없이 인코딩하면 디코더의 float 출력을 받아 FLAC 인코더가 24비트를 고르고 39.3MB가 나온다 — s16 WAV(39.7MB) 대비 1% 감소에 그친다. s16을 명시하면 19.6MB(50.7% 감소)이고 PCM이 기존 WAV와 비트 단위로 일치한다.

## 결정 근거 (변경 이유)

1. **왜 mlx 먼저인가** — `models/whisper_mlx.py`의 clip 루프는 span당 1회 `transcribe()` 호출이다(다중 clip을 한 번에 넘기면 mlx-whisper seek 루프가 일부 clip 출력을 드랍하는 기존 이슈 때문). `mlx_whisper.transcribe`는 첫 인자가 `str`이면 `load_audio()`로 파일 전체를 ffmpeg 디코드한다. 73 clip이면 73회 전체 디코드다.
2. **왜 FLAC인가** — `models/ecapa_embed.py`는 `soundfile.read()`로 오디오를 읽는데 libsndfile은 리샘플을 하지 않는다. 즉 ECAPA는 입력 파일이 이미 16 kHz여야만 정상 동작한다(원본 m4a/webm은 디코드조차 안 된다). FLAC은 libsndfile 네이티브 지원 + 16 kHz 유지 + 무손실이라 ECAPA 경로를 그대로 두고 디스크만 약 50% 줄인다. silero(torchaudio), pyannote(torchaudio/soundfile), whisper(ffmpeg/PyAV) 모두 FLAC을 읽는다.
3. **왜 Content-Type인가** — `meetings.controller.ts`가 `application/octet-stream`을 하드코딩하고 FE `pages/meeting.tsx:390`은 그 URL을 `<audio src>`에 그대로 물린다. 지금은 브라우저 sniff에 기대고 있고 FLAC은 sniff 경로에서 Safari가 거부할 수 있다.

## 범위 밖 (후속)

- 기존 `meetings/*/normalized.wav` 고아 파일 정리. 신규 키가 `.flac`이라 `storage.exists()`가 미스 → 재처리 시 소스에서 재정규화되고 구 `.wav`는 남는다. DB의 `normalized_key`는 구 행에서 `.wav`를 계속 가리키므로 재생·평가는 깨지지 않는다. 정리 스크립트는 별도 작업으로 뺀다.
- `models/whisper_faster.py`는 clip 목록을 한 번에 넘겨 `transcribe()`를 1회만 호출하므로 재디코드 문제가 없다. 손대지 않는다.

---

### Task 1: mlx-whisper 오디오 1회 로드

**Files:**
- Modify: `worker/damwha_worker/models/whisper_mlx.py:53-90`
- Test: `worker/tests/test_whisper_adapters.py:16-36` (fake 확장), 신규 테스트 2개 추가

**Interfaces:**
- Consumes: 없음 (기존 `Transcriber` 프로토콜 그대로)
- Produces: `MlxWhisper.transcribe(wav_path, language, speech_spans=None, *, on_progress=None) -> list[Word]` — 시그니처·반환 타입 변화 없음. 내부 동작만 바뀐다. Task 2가 이 함수에 `.flac` 경로를 넘긴다.

작업 디렉터리는 전부 `/Users/gim-yeongjae/project/daewha/be/worker` 기준이다.

- [ ] **Step 1: fake mlx 모듈에 `audio` 서브모듈과 `mx.array`를 추가한다**

`worker/tests/test_whisper_adapters.py`의 `_install_fake_mlx`를 통째로 아래로 교체한다. 호출 인자를 kwargs만이 아니라 첫 위치 인자까지 기록하도록 바꾸는 게 핵심이다.

```python
def _install_fake_mlx(monkeypatch, calls, loads=None):
    fake_core = types.ModuleType("mlx.core")
    fake_core.set_memory_limit = lambda n: None
    fake_core.array = lambda a: ("mx", a)
    fake_mlx = types.ModuleType("mlx")
    fake_mlx.core = fake_core

    fake_audio = types.ModuleType("mlx_whisper.audio")

    def load_audio(file, sr=16000):
        if loads is not None:
            loads.append((file, sr))
        return ["pcm", file]

    fake_audio.load_audio = load_audio

    fake_whisper = types.ModuleType("mlx_whisper")

    def transcribe(audio, **kwargs):
        calls.append({"audio": audio, **kwargs})
        return {
            "segments": [
                {"words": [{"word": " 안녕", "start": 0.5, "end": 0.9, "probability": 0.9}]}
            ]
        }

    fake_whisper.transcribe = transcribe
    fake_whisper.audio = fake_audio
    monkeypatch.setitem(sys.modules, "mlx", fake_mlx)
    monkeypatch.setitem(sys.modules, "mlx.core", fake_core)
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake_whisper)
    monkeypatch.setitem(sys.modules, "mlx_whisper.audio", fake_audio)
```

`sys.modules["mlx_whisper.audio"]`와 `fake_whisper.audio` 둘 다 설정하는 이유: `from mlx_whisper.audio import load_audio`는 sys.modules 조회와 부모 모듈 속성 조회를 모두 거칠 수 있다.

- [ ] **Step 2: 실패하는 테스트 2개를 추가한다**

같은 파일 맨 끝에 붙인다.

```python
def test_mlx_loads_audio_once_regardless_of_clip_count(monkeypatch):
    # clip마다 경로를 넘기면 mlx_whisper가 호출마다 파일 전체를 ffmpeg로 재디코드한다.
    # 디코드는 1회여야 하고, 이후 호출은 그 배열을 재사용해야 한다.
    calls, loads = [], []
    _install_fake_mlx(monkeypatch, calls, loads)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    MlxWhisper("large-v3-turbo").transcribe("a.flac", "ko", SPANS)
    assert loads == [("a.flac", 16000)]
    assert len(calls) == 2


def test_mlx_passes_decoded_array_not_path(monkeypatch):
    # 경로 문자열을 그대로 넘기면 라이브러리가 다시 디코드한다 — mx.array를 넘겨
    # 라이브러리 내부의 str 분기와 numpy→mx 변환을 둘 다 건너뛴다.
    calls, loads = [], []
    _install_fake_mlx(monkeypatch, calls, loads)
    from damwha_worker.models.whisper_mlx import MlxWhisper

    MlxWhisper("large-v3-turbo").transcribe("a.flac", "ko", SPANS)
    for kwargs in calls:
        assert kwargs["audio"] == ("mx", ["pcm", "a.flac"])
```

- [ ] **Step 3: 테스트를 돌려 실패를 확인한다**

Run: `uv run pytest tests/test_whisper_adapters.py -v`
Expected: 신규 2개 FAIL. `loads == []` (load_audio 미호출) 및 `kwargs["audio"] == "a.flac"` 불일치. 기존 테스트는 전부 PASS여야 한다 — 여기서 기존 테스트가 깨지면 Step 1의 fake 교체가 틀린 것이다.

- [ ] **Step 4: `whisper_mlx.py`의 `transcribe`를 고친다**

`worker/damwha_worker/models/whisper_mlx.py`에서 `import os` 아래 블록부터 `_run` 정의까지를 아래로 교체한다.

```python
        import os

        import mlx.core as mx
        import mlx_whisper
        from mlx_whisper.audio import load_audio

        # job 내부 GPU 피크 억제: MLX active 메모리 상한(물리 메모리의 절반).
        # subprocess 격리는 job '간' 누적만 막고, 단독 process_meeting의 내부 피크는
        # 이 상한으로 방어한다. mlx 0.31 top-level API — 정확 심볼은 로컬 smoke에서 확인.
        _phys = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        mx.set_memory_limit(int(_phys * 0.5))

        # 오디오는 한 번만 디코드한다. 아래 clip 루프는 span당 transcribe()를 개별
        # 호출하는데, 경로를 넘기면 mlx_whisper가 호출마다 파일 전체를 ffmpeg로
        # 다시 디코드한다(WAV는 I/O 비용뿐이지만 FLAC은 디코드 CPU가 clip 수만큼
        # 곱해진다). mx.array까지 미리 만들어 호출당 numpy→mx 복사도 없앤다.
        # clip_timestamps는 배열 입력에서도 같은 '초 단위 절대 시각'으로 해석된다.
        audio = mx.array(load_audio(wav_path))

        def _run(**extra) -> dict:
            return mlx_whisper.transcribe(
                audio,
                path_or_hf_repo=self._repo,
                language=language,
                word_timestamps=True,
                condition_on_previous_text=_CONDITION_ON_PREVIOUS_TEXT,
                hallucination_silence_threshold=_HALLUCINATION_SILENCE_S,
                **extra,
            )
```

`speech_spans`가 빈 리스트일 때 조기 return 하는 기존 가드는 이 블록 위에 그대로 남는다 — 발화가 없으면 디코드도 하지 않는다.

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run: `uv run pytest tests/test_whisper_adapters.py -v`
Expected: 전부 PASS (신규 2개 포함). 특히 `test_mlx_empty_spans_skips_library_and_returns_empty`가 계속 PASS여야 한다 — 빈 span에서 `load_audio`가 불리면 조기 return 가드가 밀린 것이다.

- [ ] **Step 6: 워커 전체 테스트와 린트를 돌린다**

Run: `uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: 전부 PASS.

- [ ] **Step 7: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/be
git add worker/damwha_worker/models/whisper_mlx.py worker/tests/test_whisper_adapters.py
git commit -m "perf(worker): decode audio once in mlx-whisper clip loop

clip당 transcribe() 개별 호출이 매번 파일 전체를 ffmpeg로 재디코드했다.
load_audio()를 1회 호출하고 mx.array로 재사용한다."
```

---

### Task 2: 정규화 산출물을 16 kHz mono FLAC으로 전환

**Files:**
- Modify: `worker/damwha_worker/pipeline/ffmpeg.py:39-58`
- Modify: `worker/damwha_worker/storage.py:15-16`
- Modify: `worker/damwha_worker/pipeline/enroll_speaker.py:42`
- Test: `worker/tests/test_ffmpeg.py:42-53`, `worker/tests/test_storage.py:21-23`

**Interfaces:**
- Consumes: Task 1의 `MlxWhisper.transcribe` — FLAC 경로를 받아도 동작해야 한다(Task 1이 `load_audio`로 넘기므로 ffmpeg가 처리한다).
- Produces: `Storage.normalized_key(meeting_id) -> "meetings/{id}/normalized.flac"`. `ffmpeg.normalize(src_path, dst_path, runner=_run) -> None` — 시그니처 불변, 산출 컨테이너만 FLAC. Task 3이 이 확장자를 Content-Type 매핑에 쓴다.

- [ ] **Step 1: 실패하는 테스트로 기존 WAV 단언을 FLAC으로 바꾼다**

`worker/tests/test_ffmpeg.py`의 `test_normalize_builds_16k_mono_wav_command`를 아래로 교체한다.

```python
def test_normalize_builds_16k_mono_flac_command(monkeypatch, tmp_path):
    captured = {}

    def runner(cmd):
        captured["cmd"] = cmd
        return ok_proc()

    monkeypatch.setattr(ffmpeg, "probe", lambda path: ffmpeg.ProbeResult(1))

    ffmpeg.normalize("/in/a.m4a", str(tmp_path / "n.flac"), runner=runner)
    cmd = captured["cmd"]
    assert "-ar" in cmd and "16000" in cmd and "-ac" in cmd and "1" in cmd
    # -f 명시는 필수다 — 임시 파일이 .tmp 접미사라 확장자 추론이 안 된다
    assert cmd[cmd.index("-f") + 1] == "flac"
    assert cmd[cmd.index("-c:a") + 1] == "flac"
    # s16 명시가 없으면 FLAC 인코더가 24비트를 골라 s16 WAV 대비 1%밖에 안 줄어든다
    assert cmd[cmd.index("-sample_fmt") + 1] == "s16"
    assert cmd[-1] != str(tmp_path / "n.flac")
```

`worker/tests/test_storage.py:23`을 바꾼다.

```python
    assert s.normalized_key("abc") == "meetings/abc/normalized.flac"
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `uv run pytest tests/test_ffmpeg.py tests/test_storage.py -v`
Expected: `test_normalize_builds_16k_mono_flac_command` FAIL (`-f` 뒤가 `wav`), `test_normalized_key` FAIL (`.wav` != `.flac`).

- [ ] **Step 3: `ffmpeg.normalize`의 명령을 바꾼다**

`worker/damwha_worker/pipeline/ffmpeg.py:46`의 `cmd = [...]` 한 줄을 아래로 교체한다.

```python
        # FLAC 16 kHz mono s16: 무손실이라 PCM은 기존 WAV와 비트 단위로 동일하고
        # 디스크는 약 50% 줄어든다.
        # libsndfile 네이티브 지원이라 ecapa_embed의 soundfile.read()가 그대로 동작한다.
        # -f 명시 필수 — temp_path가 .tmp 접미사라 확장자 추론이 안 된다.
        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
            "-c:a", "flac", "-compression_level", "5",
            "-f", "flac", temp_path,
        ]
```

ruff format이 이 리스트를 재배치할 수 있다 — Step 6의 `ruff format`을 신뢰하고 포맷 결과를 그대로 받는다.

- [ ] **Step 4: 키 확장자를 바꾼다**

`worker/damwha_worker/storage.py:16`:

```python
        return f"meetings/{meeting_id}/normalized.flac"
```

`worker/damwha_worker/pipeline/enroll_speaker.py:42`:

```python
    norm_key = f"speakers/{speaker_id}/normalized.flac"
```

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run: `uv run pytest tests/test_ffmpeg.py tests/test_storage.py tests/test_enroll_speaker.py -v`
Expected: 전부 PASS. `test_enroll_speaker.py`는 소스 키(`speakers/s/sample.wav`)만 단언하고 정규화 키는 단언하지 않으므로 수정이 필요 없다 — 회귀 확인용으로만 같이 돌린다.

- [ ] **Step 6: 워커 전체 테스트와 린트를 돌린다**

Run: `uv run pytest -q && uv run ruff check . && uv run ruff format .`
Expected: 전부 PASS. `test_db_persist.py`의 `normalized_key="meetings/x/normalized.wav"`는 DB 컬럼에 임의 문자열을 넣는 테스트라 바꾸지 않아도 통과한다 — 굳이 손대지 않는다.

- [ ] **Step 7: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/be
git add worker/damwha_worker/pipeline/ffmpeg.py worker/damwha_worker/storage.py \
        worker/damwha_worker/pipeline/enroll_speaker.py worker/tests/
git commit -m "feat(worker): normalize to 16k mono FLAC instead of WAV

무손실이라 PCM은 동일하고 디스크는 약 45% 줄어든다. libsndfile 네이티브
지원이라 ECAPA의 soundfile.read() 경로가 그대로 동작한다."
```

---

### Task 3: 오디오 스트리밍 Content-Type

**Files:**
- Create: `src/storage/content-type.ts`
- Create: `test/content-type.spec.ts`
- Modify: `src/meetings/meetings.controller.ts:175`

**Interfaces:**
- Consumes: Task 2가 만드는 `.flac` 확장자의 `normalized_key`.
- Produces: `audioContentType(key: string): string` — 확장자 기반 MIME 문자열. 미지 확장자는 `'application/octet-stream'`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`test/content-type.spec.ts` 신규 생성:

```typescript
import { audioContentType } from '../src/storage/content-type';

describe('audioContentType', () => {
  it('maps the formats the pipeline produces and accepts', () => {
    expect(audioContentType('meetings/x/normalized.flac')).toBe('audio/flac');
    expect(audioContentType('meetings/x/normalized.wav')).toBe('audio/wav');
    expect(audioContentType('meetings/x/original.m4a')).toBe('audio/mp4');
    expect(audioContentType('meetings/x/original.mp3')).toBe('audio/mpeg');
    expect(audioContentType('meetings/x/original.webm')).toBe('audio/webm');
    expect(audioContentType('meetings/x/original.ogg')).toBe('audio/ogg');
  });

  it('is case-insensitive', () => {
    expect(audioContentType('meetings/x/A.FLAC')).toBe('audio/flac');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(audioContentType('meetings/x/original.xyz')).toBe('application/octet-stream');
    expect(audioContentType('meetings/x/original')).toBe('application/octet-stream');
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/gim-yeongjae/project/daewha/be && npx jest --runInBand test/content-type.spec.ts`
Expected: FAIL — `Cannot find module '../src/storage/content-type'`.

- [ ] **Step 3: 매핑 모듈을 만든다**

`src/storage/content-type.ts`:

```typescript
import * as path from 'path';

// FE는 이 응답을 <audio src>에 그대로 물린다(pages/meeting.tsx). octet-stream을
// 흘리면 브라우저 sniff에 의존하게 되고 Safari가 FLAC을 거부할 수 있다.
const AUDIO_MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
};

export function audioContentType(key: string): string {
  return AUDIO_MIME[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
}
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `npx jest --runInBand test/content-type.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 컨트롤러가 이 매핑을 쓰게 한다**

`src/meetings/meetings.controller.ts`의 import 블록에 추가:

```typescript
import { audioContentType } from '../storage/content-type';
```

`audio()` 핸들러의 `res.setHeader('Content-Type', 'application/octet-stream');` 한 줄을 교체:

```typescript
    res.setHeader('Content-Type', audioContentType(key));
```

`@ApiProduces('application/octet-stream')` 데코레이터는 그대로 둔다 — 실제 타입이 키에 따라 달라지므로 OpenAPI 상 가장 넓은 선언이 맞다.

- [ ] **Step 6: 빌드와 유닛 테스트를 돌린다**

Run: `npx tsc --noEmit && npx jest --runInBand test/content-type.spec.ts test/job-payload.spec.ts`
Expected: 타입 에러 없음, 테스트 PASS.

- [ ] **Step 7: e2e를 돌린다 (Docker 필요)**

Run: `npx jest --runInBand test/audio.e2e-spec.ts`
Expected: PASS. `a.wav`를 업로드하므로 이제 `audio/wav`가 나간다. e2e가 Content-Type을 단언하지 않으므로 수정 없이 통과한다. Docker가 없으면 이 스텝은 건너뛰고 그 사실을 보고한다 — 조용히 통과 처리하지 않는다.

- [ ] **Step 8: 커밋**

```bash
cd /Users/gim-yeongjae/project/daewha/be
git add src/storage/content-type.ts src/meetings/meetings.controller.ts test/content-type.spec.ts
git commit -m "fix(api): serve audio with a real Content-Type

FE가 <audio src>로 직접 물기 때문에 octet-stream이면 브라우저 sniff에
의존하게 된다. FLAC 전환 후 Safari에서 재생이 깨질 수 있다."
```

---

### Task 4: 지식 그래프 갱신

**Files:**
- Modify: `graphify-out/` (도구가 생성)

- [ ] **Step 1: 그래프를 갱신한다**

Run: `cd /Users/gim-yeongjae/project/daewha && graphify update .`
Expected: AST 재파싱 완료, API 비용 0.

- [ ] **Step 2: 커밋 (graphify-out이 be 저장소 밖이면 건너뛴다)**

```bash
cd /Users/gim-yeongjae/project/daewha/be
git status --short
```

`graphify-out/`은 저장소 루트(`/Users/gim-yeongjae/project/daewha`) 아래이고 그 루트는 git 저장소가 아니다. 변경이 `be` status에 잡히지 않으면 커밋 없이 종료한다.

---

## 검증 (전체 완료 후)

- [ ] `cd be/worker && uv run pytest -q` — 전부 PASS
- [ ] `cd be/worker && uv run ruff check .` — 클린
- [ ] `cd be && npx tsc --noEmit` — 클린
- [ ] 실오디오 스모크: 짧은 m4a로 `process_meeting` 1회 실행 → `meetings/<id>/normalized.flac` 생성 확인, `ffprobe`로 `sample_rate=16000 channels=1 codec_name=flac` 확인, utterance가 비어있지 않은지 확인. 이 스모크가 Task 1(mlx 배열 경로)과 Task 2(FLAC 디코드)를 동시에 실증하는 유일한 지점이다 — 유닛 테스트는 전부 stub이라 실제 mlx/libsndfile 동작을 증명하지 못한다.


## 실행 기록 (2026-08-18)

계획대로 Task 1–4 완료. 계획에서 빠졌다가 실오디오 스모크에서 잡힌 것 하나:

- **`-sample_fmt s16` 누락.** 최초 구현은 `-c:a flac`만 줬는데 ffmpeg가 디코더의
  float 출력을 받아 24비트로 인코딩했다. 20.7분 m4a 기준 39.3MB — s16 WAV
  39.7MB 대비 1.1% 감소로, 전환의 이유였던 디스크 절감이 사실상 없었다.
  `-sample_fmt s16` 추가 후 19.6MB(50.7% 감소), PCM은 기존 WAV와 비트 단위 일치.
  유닛 테스트는 전부 stub이라 이걸 잡지 못한다 — 스모크가 유일한 검출 지점이었다.

실오디오 검증 결과 (`odyssey-raw.m4a`, 20.7분):

| 항목 | 결과 |
|---|---|
| normalize | 1.0s, 19,596,141 B (WAV 대비 50.7% 감소) |
| ffprobe | `flac / s16 / 16000 Hz / 1ch`, duration 1,241,872 ms |
| ECAPA 경로 `sf.read()` | sr=16000, mono, PCM이 기존 WAV와 비트 동일 |
| VAD 경로 `silero read_audio()` | (19869966,) float32 |
| whisper 경로 `mx.array(load_audio())` | 274 ms, float32 — 클립당 반복되던 비용이 1회로 |
| `mlx_whisper.transcribe` 시그니처 | `audio: Union[str, np.ndarray, mx.array]` — 배열 입력 확인 |

pyannote는 게이트 모델이라 이 스모크에서 제외했다. torchaudio/soundfile 경로를 쓰므로
silero·ECAPA 결과가 그 경로를 대리 검증한다.
