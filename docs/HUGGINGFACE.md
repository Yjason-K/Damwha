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

## 4. Damwha 앱에 넣기

Damwha 데스크톱 앱은 토큰 없이도 켜진다 — 토큰이 필요한 건 화자 분리뿐이라, 회의 목록을 보거나
검색하는 데는 아무것도 필요 없다.

처음 실행하면 담화 화면 안에 "화자 분리를 쓰려면 토큰이 필요해요" 대화상자가 뜬다. 위 세 링크와
토큰 발급 페이지로 바로 이동하는 버튼이 같이 있다. **나중에 하기**를 누르면 이번 실행에서는
다시 뜨지 않는다 — 토큰 없이 하던 대로 계속 쓰면 된다. 다만 토큰 없이 앱을 다시 켜면 다음
실행에서 또 뜬다. 새 회의를 만들거나 실패한 회의를 재처리할 때도 토큰이 없으면 같은
대화상자가 그 동작 대신 뜬다.

`hf_...` 토큰을 붙여넣고 저장하면 앱이 즉시 검증한다 — `.env` 파일을 직접 만들거나 편집할
필요는 없다. 토큰은 이 맥의 macOS Keychain에 암호화해 저장되고, 앱을 감독하는 프로세스가
워커·embed 같은 Python 자식 프로세스에만 넘겨준다(API 프로세스는 받지 않는다).

나중에 토큰을 바꾸거나 지우고 싶으면 **담화 설정 › 허깅페이스 토큰**에서 한다.

## 5. 확인

토큰을 저장하면 앱이 그 자리에서 세 저장소를 찔러 검증한다. 실패하면 입력칸 바로 아래에
이유가 그대로 뜬다:

| 나오는 말 | 원인 |
|---|---|
| 토큰이 거부됨 (401) | 토큰이 잘못됐거나 복사 중 잘렸다 → 3번 |
| `<저장소>` 라이선스 미수락 (403) | 그 저장소를 안 눌렀다 → 2번. 라이선스를 다 눌렀는데도 나오면 수락한 계정과 토큰 발급 계정이 다르거나, Fine-grained 토큰에 gated repo 권한이 없다 |

검증을 통과하면 앱이 바로 회의 처리를 시작할 수 있다. 모델 가중치는 첫 회의를 처리할 때 알아서
받는다(수 GB, 수 분).
