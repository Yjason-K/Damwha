# Hugging Face 토큰 발급 · 모델 라이선스 수락

Damwha의 화자 분리 모델(pyannote)은 **gated 모델**이다. 누구나 무료로 쓸 수 있지만,
Hugging Face에 로그인해 라이선스에 동의한 계정의 토큰이 있어야 가중치를 내려받는다.
토큰이 없거나 라이선스 하나라도 안 눌러 놓으면 업로드한 회의가 화자 분리 단계에서 실패한다.

5분이면 끝난다. 승인 대기 없이 즉시 처리된다(세 저장소 모두 자동 승인).

## 1. 계정 만들기

https://huggingface.co/join — 이메일 인증까지 끝내고 로그인 상태를 유지한다.

> 회사 이메일이든 개인 이메일이든 상관없다. 다만 **2번의 라이선스 수락과 3번의 토큰 발급은
> 반드시 같은 계정**이어야 한다. 이게 제일 흔한 실패 원인이다.

## 2. 라이선스 3개 수락

아래 세 개를 **전부** 눌러야 한다. 하나라도 빠지면 실패한다 — pyannote 파이프라인이
세 저장소를 연쇄로 불러오기 때문이다.

1. https://huggingface.co/pyannote/speaker-diarization-community-1
2. https://huggingface.co/pyannote/segmentation-3.0
3. https://huggingface.co/pyannote/speaker-diarization-3.1

각 페이지 상단에 이런 박스가 있다:

> **You need to agree to share your contact information to access this model**

- 이름 / 소속(company or affiliation) / 용도 같은 칸을 채운다. 실명·소속이면 충분하고,
  용도는 "research", "internal meeting transcription" 정도면 된다.
- **Agree and access repository** 버튼을 누른다.
- 박스가 사라지고 파일 목록이 보이면 완료. 승인 대기 화면은 뜨지 않는다.

세 페이지 모두 같은 방식이다. 이미 수락한 저장소는 박스가 아예 안 보인다.

## 3. Read 토큰 발급

https://huggingface.co/settings/tokens → **Create new token**

- Token type: **Read** 를 고른다. (기본값인 Fine-grained를 고르면 권한을 직접 켜야 한다 —
  아래 주의 참고.)
- Token name: 아무거나. `damwha` 정도.
- **Create token** → 토큰 문자열(`hf_...`)이 **이때 한 번만** 보인다. 바로 복사한다.
  놓쳤으면 지우고 새로 만들면 된다.

> **Fine-grained 토큰을 쓰겠다면**: Repositories 권한에서
> *"Read access to contents of all public gated repos you can access"* 를 반드시 켠다.
> 이걸 빼먹으면 라이선스를 다 수락했는데도 403이 난다.

토큰은 비밀번호와 같다. Slack·이슈·커밋에 붙여넣지 않는다. 체험이 끝나면
같은 페이지에서 **Revoke**로 폐기하면 된다. 이 토큰은 읽기 전용이라 계정에 쓰기 작업은 못 한다.

## 4. `.env`에 넣기

설치 폴더(`docker-compose.yml`이 있는 곳)의 `.env`를 열어 채운다:

```
HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- 따옴표 없이, `=` 뒤에 공백 없이, 줄 끝에 공백 없이 붙인다.
- 워커는 `.env`를 **시작할 때 한 번** 읽는다. 이미 `damwha-worker`가 떠 있었다면 껐다 켠다.

## 5. 확인

토큰을 넣고 나면 아래 한 줄로 검증할 수 있다. 설치 폴더에서:

```bash
curl -sIL -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $(grep '^HF_TOKEN=' .env | cut -d= -f2-)" \
  https://huggingface.co/pyannote/speaker-diarization-community-1/resolve/main/config.yaml
```

| 결과 | 뜻 |
|---|---|
| `200` | 정상. 워커를 띄우면 된다 |
| `401` | 토큰이 비었거나 잘못됨 — 3번을 다시 (복사 중 잘렸는지, 따옴표가 붙었는지 확인) |
| `403` | 토큰은 맞는데 라이선스 미수락 — 2번을 다시. Fine-grained 토큰이면 위 주의사항 확인 |

세 저장소를 한 번에 확인하려면 위 URL의 `pyannote/speaker-diarization-community-1` 자리를
`pyannote/segmentation-3.0`, `pyannote/speaker-diarization-3.1`로 바꿔 각각 실행한다.
셋 다 `200`이어야 한다.

## 6. 모델 다운로드

따로 할 건 없다. `damwha-worker`를 처음 띄우고 첫 회의를 올리면 그때 모델을 내려받는다
(수 GB, 수 분). 이 다운로드가 조용히 오래 걸리는 것이지 멈춘 게 아니다.

소스 체크아웃이 있다면 미리 받아둘 수 있다:

```bash
uv run --directory be/worker python scripts/download_models.py
```

마지막 `[4/4] pyannote gated (...)` 줄이 `ok`면 토큰·라이선스가 모두 정상이다.
`token invalid or license not accepted`가 보이면 2~3번으로 돌아간다.

## 자주 막히는 지점

| 증상 | 원인 |
|---|---|
| 회의가 `diarization` 단계에서 실패 / 워커 로그에 `failed to load gated diarization model` | `HF_TOKEN` 비었거나 라이선스 3개 중 하나 미수락 |
| 라이선스는 다 눌렀는데 403 | 라이선스를 수락한 계정과 토큰을 발급한 계정이 다름. 또는 Fine-grained 토큰에 gated repo 권한이 없음 |
| `.env`를 고쳤는데 그대로 실패 | 워커를 재시작하지 않음. `.env`는 시작 시 한 번만 읽는다 |
| 워커가 `.env`를 아예 못 찾음 | `.env`가 없는 폴더에서 `damwha-worker`를 실행함 — 설치 폴더에서 실행해야 한다 |

설치 전체 절차는 [README.md](README.md)에 있다.
