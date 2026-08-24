# Damwha 워커 — STT 품질 개선: 환각 방어 + VAD clip_timestamps 설계

> 상태: 확정 (설계 합의 완료) · 작성일: 2026-07-23 · 대상: `worker/` STT 경로
> 배경: 클로바노트 파이프라인 벤치마크(`docs/reference/clova-note.md`) 기반 STT 품질 진단
> 관련: `docs/worker-architecture.md` §6 (`process_meeting` 상세 흐름)

---

## 0. 이 문서의 범위

회의 녹음 STT 품질 저하의 두 가지 원인을 제거한다.

1. **Whisper 환각(hallucination) 방어 부재** — 두 transcriber 어댑터가 Whisper 기본
   옵션만 사용. 긴 오디오에서 `condition_on_previous_text=True`(기본)로 오류가 뒤로
   전파되어 반복 루프가 생기고, 무음/잡음 구간에서 환각 텍스트가 생성된다.
2. **VAD 결과의 STT 미활용** — Silero VAD가 이미 발화 구간(SpeechSpan)을 계산하지만
   STT는 정규화 WAV 전체를 디코딩한다(`process_meeting.py`의 stt stage). 무음 구간이
   그대로 Whisper에 들어가 환각의 주 원인이 된다. 클로바노트의 EPD 세그먼테이션
   (speech 구간만 디코딩)에 대응하는 개선.

**범위에 포함:**
- `Transcriber` protocol 확장: `speech_spans` 선택 인자
- 두 어댑터(`whisper_mlx.py`, `whisper_faster.py`)에 환각 방어 파라미터 하드코딩 +
  `clip_timestamps` 변환
- `process_meeting.py`: VAD span 전처리(pad/merge/clamp) 후 STT에 전달, 빈 VAD 가드
- span 전처리 pure helper + 단위 테스트, 파이프라인/어댑터 테스트
- STT 관측 지표 로그(stt stage detail)

**범위 밖 (이번 변경에서 하지 않음):**
- payload/DB 계약 변경 — **없음**. zod/pydantic/CHECK 모두 무변경.
- keyword boosting(`initial_prompt`/`hotwords`) — payload 스키마 확장 필요, 별도 작업.
- ffmpeg `loudnorm` 등 음성 향상 — 별도 작업.
- `compression_ratio_threshold`(2.4), `no_speech_threshold`(0.6) 명시 전달 — 두 라이브러리
  기본값과 동일해 동작 변화가 없으므로 넘기지 않는다.
- faster-whisper `vad_filter` — 사용하지 않음(§1.2).

---

## 1. 아키텍처 결정

### 1.1 A안: protocol 확장 + 파이프라인 전처리 (채택)

`SpeechSpan`(ms, 도메인 타입)을 파이프라인 경계까지 유지하고, Whisper 전용 초 단위
flat list 변환은 각 어댑터 내부에 가둔다.

```
process_meeting (stt stage)
  speech_spans(ms)                      ← VAD stage 결과 (이미 존재)
    │ prepare_stt_spans()               ← pure helper: pad ±200ms → clamp → merge
    ▼
  transcriber.transcribe(wav, language, speech_spans=prepared)
    │ 어댑터 내부: [SpeechSpan] → [s0, e0, s1, e1, ...] (초, flat)
    ▼
  mlx_whisper / faster_whisper  clip_timestamps=...
```

기각한 대안:
- **B. 파이프라인에서 초 단위 flat list 변환** — Whisper 형식이 파이프라인으로 누출.
- **C. span별 transcribe 루프** — 호출 N회, timestamp offset 수동 보정, 컨텍스트 손실.

### 1.2 VAD 단일화 — 파이프라인 Silero가 유일한 발화 구간 기준

faster-whisper의 내장 `vad_filter`(자체 Silero)는 켜지 않는다. 이유:
- 파이프라인 Silero 결과가 이미 존재하고, 같은 span이 align 단계의
  `transcribe_failed`/`silence` 분류(`failed_spans`)에도 쓰인다. 기준이 하나여야
  timestamp 복원과 실패 분류가 일관된다.
- 백엔드(MLX/faster-whisper) 간 동작 일치.

### 1.3 환각 방어 파라미터 — 어댑터 하드코딩

payload 재현성 원칙(모델 선택은 payload 책임)을 유지하면서 계약 변경 없이 넣기 위해
어댑터 모듈 상수로 고정한다. env/Settings 노출은 하지 않는다(설정 표면 증가 +
재현성 약화). 튜닝 변경 = 코드 변경.

| 파라미터 | 값 | 적용 대상 | 근거 |
|---|---|---|---|
| `condition_on_previous_text` | `False` | 두 어댑터 | 긴 오디오에서 이전 창 오류가 다음 창으로 전파되어 반복 루프 유발. False로 창 간 독립 디코딩 |
| `hallucination_silence_threshold` | `2.0` (초) | 두 어댑터 | 무음이 2초 이상인 구간에서 환각 의심 단어 제거. `word_timestamps=True`가 전제이며 두 어댑터 모두 이미 충족 |

버전 확인 완료: 잠금 버전 **mlx-whisper 0.4.3, faster-whisper 1.2.1** 모두 두 파라미터와
초 단위 flat list `clip_timestamps`를 지원한다.

### 1.4 트레이드오프 — VAD false negative

VAD가 놓친 실제 발화는 STT에 아예 전달되지 않는다(이전에는 전체 파일 디코딩이라
잡힐 수 있었다). ±200ms padding이 시작/끝 절단을 줄이지만 완전한 해결은 아니다.
이를 감수하는 이유: 무음 환각 제거 이득이 경계 절단 손실보다 크고, Silero의 한국어
회의 오디오 false negative는 실측상 드물다. 회귀 감지는 §4의 관측 지표로 한다.

---

## 2. 컴포넌트 설계

### 2.1 `Transcriber` protocol (`models/base.py`)

```python
class Transcriber(Protocol):
    def transcribe(
        self, wav_path: str, language: str, speech_spans: list[SpeechSpan] | None = None
    ) -> list[Word]: ...
```

- `speech_spans=None` → 기존 동작(전체 파일 디코딩). 기본값이 있어
  `transcribe(wav, language)`로 직접 호출하는 기존 호출자는 호환된다. 단, 변경된
  `process_meeting`은 항상 세 번째 인자를 전달하므로 위치 인자 2개만 받는 기존
  fake transcriber는 시그니처 갱신이 필요하다(§5.2).
- `speech_spans`가 주어지면 해당 구간만 디코딩.
- 호출부는 `process_meeting`뿐(enroll/index는 transcriber 미사용).

### 2.2 span 전처리 helper (`pipeline/stt_spans.py`, 신규)

```python
PAD_MS = 200

def prepare_stt_spans(
    spans: list[SpeechSpan], duration_ms: int, pad_ms: int = PAD_MS
) -> list[SpeechSpan]:
```

pure 함수. 순서대로:
1. **유효성 필터** — `end_ms <= start_ms`이거나 duration 밖에 완전히 벗어난 span 제거.
2. **pad** — 각 span을 `start-pad_ms`, `end+pad_ms`로 확장 (경계 절단 완화).
3. **clamp** — `start = max(0, start)`, `end = min(duration_ms, end)`.
4. **merge** — 정렬 후 겹치거나 맞닿은 span 병합 (pad로 인접 span이 겹치는 경우 포함).

반환은 정렬된 비겹침 `SpeechSpan` 리스트. duration은 파이프라인의 ffprobe 결과를
사용한다 (어댑터는 duration을 모르므로 clamp는 파이프라인 책임).

위치를 `pipeline/`에 두는 이유: duration 의존 + STT 정책(pad 값)은 파이프라인 소관.
어댑터는 받은 span의 포맷 변환만 한다.

### 2.3 어댑터 변경 (`whisper_mlx.py`, `whisper_faster.py`)

공통:
- 시그니처를 protocol에 맞춰 확장.
- `speech_spans`가 비-None이면 `clip_timestamps=[s.start_ms/1000, s.end_ms/1000 반복 flat]` 전달.
- **빈 리스트 방어**: `speech_spans=[]`(비-None)이면 라이브러리 호출 없이 `[]` 반환.
  `clip_timestamps=[]`가 "전체 오디오"로 해석되는 것을 어댑터 레벨에서도 차단 —
  **None만** 전체 파일 전사를 의미한다. (파이프라인의 빈 VAD 가드 §2.4와 이중 방어.)
- `condition_on_previous_text=False`, `hallucination_silence_threshold=2.0` 상수 전달.

mlx: `mlx_whisper.transcribe(..., clip_timestamps=..., condition_on_previous_text=False, hallucination_silence_threshold=2.0)`.
faster-whisper: `self._model.transcribe(..., clip_timestamps=..., condition_on_previous_text=False, hallucination_silence_threshold=2.0)`. `vad_filter`는 건드리지 않는다(기본 False).

### 2.4 파이프라인 변경 (`process_meeting.py` stt stage)

```python
prepared = prepare_stt_spans(speech_spans, duration_ms)  # duration_ms = probe_fn(...) 보관값
if prepared:
    words = models.transcriber.transcribe(norm_path, payload.models.language, prepared)
else:
    words = []   # VAD 0개 → STT 호출 생략 (필수 가드)
```

- **빈 VAD 가드는 필수** — `clip_timestamps=[]`는 두 라이브러리 모두 "전체 오디오"로
  해석될 수 있어, 빈 리스트를 어댑터로 넘기면 안 된다. 호출 자체를 생략한다.
- `words=[]`이면 이후 흐름은 기존과 동일하며, 빈 VAD에서는 `failed_spans`(=원본 VAD
  span)도 빈 리스트이므로 word 없는 diar 세그먼트는 **전부 `silence`**로 분류된다.
  `transcribe_failed`는 VAD 양성 span과 겹치는데 word가 없는 경우에만 나온다(§2.5).

### 2.5 align/실패 분류 — 무변경

`build_utterances(words, segments, failed_spans=speech_spans)`는 그대로다. VAD 양성인데
인식 단어가 없는 diar 세그먼트는 계속 `transcribe_failed`, VAD 음성 구간은 `silence`.
clip STT 이후에도 "words는 speech span 안에서만 나온다"가 성립하므로 분류 의미가
오히려 더 정확해진다. `failed_spans`에는 전처리 **전** 원본 VAD span을 유지한다
(분류 기준은 실제 발화 탐지 결과여야 하고, pad는 STT 입력 확장일 뿐).

---

## 3. 오류 처리

- helper는 pure 함수 — 예외를 던지지 않는다(빈 입력 → 빈 출력).
- 어댑터 내부 라이브러리 예외는 기존 오류 분류(`errors.classify`) 경로 그대로 —
  이번 변경으로 새 오류 클래스 없음.
- `speech_spans=None` 경로(전체 파일)는 남아 있으므로, 문제 발생 시 파이프라인
  한 줄(전처리 호출)만 되돌리면 롤백된다.

## 4. 관측 지표 (품질 회귀 감지)

stt stage의 `timed_stage` detail에 추가 (카운트/길이만 — 텍스트·PII 금지 규칙 준수):

```
stage=stt done elapsed_ms=... words=N spans=M clipped_ms=X duration_ms=Y
```

- `spans` — 전처리 후 span 수
- `clipped_ms` — STT에 전달된 총 길이(전처리 후 span 합)
- `duration_ms` — 원본 길이
- `words` — 인식 단어 수 (기존에 있으면 유지)

`clipped_ms/duration_ms` 비율이 비정상적으로 낮으면 VAD false negative 의심 신호.

## 5. 테스트 계획

기존 결정론 스위트(fake 모델 + testcontainers) 관례 유지. 실모델은 smoke만.

### 5.1 helper 단위 테스트 (`prepare_stt_spans`)
- 음수 시작(pad로 0 미만) → 0으로 clamp
- end가 duration 초과(pad로) → duration으로 clamp
- pad 후 겹치는/맞닿는 span 병합
- `end <= start`인 잘못된 span 제거, 빈 입력 → 빈 출력
- duration 완전 밖 span 제거

### 5.2 파이프라인 테스트 (fake transcriber)
- 전처리된 span이 fake transcriber의 `speech_spans` 인자로 전달되는지
- VAD 0개 → transcriber **호출 안 됨** + 결과 utterance가 기존처럼 silence
- 기존 process_meeting 테스트 전체 통과 (fake transcriber 시그니처 갱신)

### 5.3 어댑터 계약 (라이브러리 mock 수준)
- `speech_spans=None` → `clip_timestamps` 미전달(전체 파일 동작)
- `speech_spans=[]` → 라이브러리 호출 없이 `[]` 반환 (빈 리스트 방어)
- span 제공 → 올바른 flat 초 리스트(`[0.5, 3.2, 4.0, 9.9]` 형태)로 변환되는지
- 환각 방어 상수 2종이 호출 kwargs에 포함되는지

### 5.4 실모델 smoke (수동)
- `scripts/smoke_process_meeting.py`를 실제 회의 오디오로 실행, 변경 전/후 전사 비교.
- 확인 항목: 반복 루프 소멸, 무음 구간 환각 텍스트 소멸, 발화 시작/끝 절단 여부,
  §4 로그 지표 출력.

## 6. 롤아웃

- 코드 병합 후 재처리(`reprocess`)한 회의부터 적용 — 저장된 기존 utterance는 불변.
- 계약/DB 변경이 없어 API·마이그레이션 작업 없음.
- 프리셋 무관 적용 (light/standard/quality 모두 동일 경로). 단, light(small+CPU int8)의
  base 품질 한계는 이 변경과 별개 — 품질 기대치는 standard 이상 기준.
