# 데모 시드

공개 데모(`docs/superpowers/specs/2026-09-01-public-demo-deployment-design.md`)에 실리는 회의
2건의 원본 오디오와, 호스트 Mac에서 **진짜 파이프라인으로 처리한 결과**를 데모 DB에 넣는
시드다. 데모는 읽기 전용(설계 §3.6)이라 이 시드가 데모 데이터의 전부다.

## 오디오 (`audio/`)

Google NotebookLM에 주제를 주고 Audio Overview로 생성한 2인 대화. 실제 인물의 음성이 아니며,
화면의 첫 방문 모달이 이를 고지한다. 약관상 상업 이용·재배포가 가능하다(설계 §4.3).

| 파일 | 길이 | 처리 결과 |
|---|---|---|
| `v0와_Cursor가_불러온_프론트엔드_숙련도_논쟁.m4a` | 7.4분 | 발화 39 · 화자 2 · 렌즈 1 · 요약 |
| `AI_코딩이_만든_가짜_생산성의_함정.m4a` | 7.1분 | 발화 49 · 화자 2 · 렌즈 3 · 요약 |

두 회의의 화자 2명(`화자_1`, `화자_2`)은 같은 speaker 행에 연결돼 있다 — 회의 간 화자 동일성이
시연된다. 렌즈가 적은 것은 팟캐스트형 대화라 액션아이템·결정이 원래 드물기 때문이다
(설계 §3.4에서 예상한 대로).

처음엔 4인 대본을 TTS 4목소리로 읽힌 재연 오디오(`demo/tts`, 커밋 `78cfad5`~`ad2fee0`)로
갔다가 NotebookLM으로 바꿨다. 경위는 설계 §3.4.

## 시드 (`seed/`)

| 파일 | 내용 |
|---|---|
| `damwha-demo.dump` | `pg_dump -Fc` 전체 DB — 스키마·`_migrations`·`app_setting` 포함 |
| `manifest.json` | 회의 id ↔ 원본 파일명 ↔ storage 키 |
| `storage/meetings/<id>/normalized.flac` | 워커가 만든 16kHz FLAC. FE 오디오 스트리밍은 이 파일을 쓴다 |
| `build.sh` | 로컬 DB·스토리지에서 위 셋을 다시 굽는다 |
| `restore.sh` | 빈 데모 DB와 `STORAGE_ROOT`를 채운다 |
| `find-original.py` | 파일명 NFC/NFD(macOS) 차이를 무시하고 `audio/`에서 원본을 찾는다 |

```bash
# 굽기 (호스트 Mac, 처리가 끝난 로컬 DB에서)
demo/seed/build.sh

# 복원 (데모 서버). 대상은 damwha/postgres-bigm 이미지의 빈 DB. 마이그레이션은 돌리지 않는다.
DATABASE_URL=postgres://... STORAGE_ROOT=/var/lib/damwha/storage demo/seed/restore.sh
# pg 클라이언트가 호스트에 없으면: PG_EXEC="docker exec -i <postgres-container>"
```

원본 m4a는 `audio/`에서 `manifest.json`의 `original_filename`으로 찾아 `audio_key` 자리에 복사한다.
`storage/`에 다시 넣지 않는 것은 28MB를 두 번 커밋하지 않기 위해서다.

제목과 `original_filename`은 DB에서 NFC로 정규화해 뒀다. macOS 업로드는 NFD로 들어오는데,
그대로 두면 pg_bigm 검색(NFC 입력)이 제목에 걸리지 않고 Linux에서 파일명 매칭도 어긋난다.

## 다음 단계

설계 §6.2 배포처 결정 → `restore.sh`로 시드 → `DEMO_READ_ONLY=true`, `VITE_DEMO_MODE=true`로 배포.
