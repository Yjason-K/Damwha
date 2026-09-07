# Hugging Face 토큰 발급 · 모델 라이선스 수락

Damwha의 화자 분리 모델(pyannote)은 **gated 모델**이다. 누구나 무료로 쓸 수 있지만,
Hugging Face에 로그인해 라이선스에 동의한 계정의 토큰이 있어야 가중치를 내려받는다.
토큰이 없거나 라이선스를 하나라도 안 눌러 놓으면 회의가 화자 분리 단계에서 실패한다.

5분이면 끝난다. 승인 대기 없이 즉시 처리된다(세 저장소 모두 자동 승인).

## 1. 계정 만들기

https://huggingface.co/join — 이메일 인증까지 끝내고 로그인 상태를 유지한다.

> **2번의 라이선스 수락과 3번의 토큰 발급은 반드시 같은 계정**이어야 한다.
> 이게 제일 흔한 실패 원인이다.

## 2. 라이선스 3개 수락

아래 세 개를 **전부** 눌러야 한다. 하나라도 빠지면 실패한다 — pyannote 파이프라인이
세 저장소를 연쇄로 불러오기 때문이다.

1. https://huggingface.co/pyannote/speaker-diarization-community-1
2. https://huggingface.co/pyannote/segmentation-3.0
3. https://huggingface.co/pyannote/speaker-diarization-3.1

각 페이지 상단의 **You need to agree to share your contact information to access this model**
박스에서 이름 / 소속 / 용도를 채우고 **Agree and access repository**. 용도는 "research",
"internal meeting transcription" 정도면 된다. 박스가 사라지고 파일 목록이 보이면 완료다 —
승인 대기 화면은 뜨지 않는다. 이미 수락한 저장소는 박스가 아예 안 보인다.

## 3. Read 토큰 발급

https://huggingface.co/settings/tokens → **Create new token**

- Token type: **Read**. 이름은 아무거나(`damwha` 정도).
- **Create token** → 토큰 문자열(`hf_...`)이 **이때 한 번만** 보인다. 바로 복사한다.
  놓쳤으면 지우고 새로 만들면 된다.

> **Fine-grained 토큰을 쓰겠다면** Repositories 권한에서
> *"Read access to contents of all public gated repos you can access"* 를 반드시 켠다.
> 이걸 빼먹으면 라이선스를 다 수락했는데도 403이 난다.

토큰은 비밀번호와 같다. 채팅·이슈·커밋에 붙여넣지 않는다. 다 쓰고 나면 같은 페이지에서
**Revoke**로 폐기하면 된다. 읽기 전용이라 계정에 쓰기 작업은 못 한다.

## 4. `.env`에 넣기

설치 폴더(`docker-compose.yml`이 있는 곳)의 `.env`에 붙인다. `.env`가 아직 없으면 그 폴더에서
`make setup`을 먼저 돌린다 — 나머지는 다 채워 주고 이 줄만 남긴다.

```
HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

따옴표 없이, `=` 뒤와 줄 끝에 공백 없이 붙인다. 워커는 `.env`를 **시작할 때 한 번** 읽으므로,
이미 떠 있었다면 껐다 켠다(`make worker`).

## 5. 확인

```bash
make check
```

토큰으로 세 저장소를 실제로 찔러 본다. 조용히 "준비 완료."면 끝이다. 아니면:

| 나오는 말 | 원인 |
|---|---|
| `HF_TOKEN이 비었다` | 4번을 안 했거나 다른 폴더의 `.env`를 고쳤다 |
| `HF_TOKEN이 거부됐다 (401)` | 토큰이 잘못됐거나 복사 중 잘렸다 → 3번 |
| `<저장소> 라이선스 미수락 (403)` | 그 저장소를 안 눌렀다 → 2번. 라이선스를 다 눌렀는데도 나오면 수락한 계정과 토큰 발급 계정이 다르거나, Fine-grained 토큰에 gated repo 권한이 없다 |

모델은 첫 회의를 처리할 때 알아서 받는다(수 GB, 수 분). 미리 받아 두려면 `make models`.
