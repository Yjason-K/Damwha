# 데모 시드

공개 데모(`docs/superpowers/specs/2026-09-01-public-demo-deployment-design.md`)에 실리는 회의
3건의 원본 오디오와, 호스트 Mac에서 **진짜 파이프라인으로 처리한 결과**를 데모 DB에 넣는
시드다. 데모는 읽기 전용(설계 §3.6)이라 이 시드가 데모 데이터의 전부다.

여기는 **데모에 들어가는 데이터**다. 이걸 이미지로 구워 서버에 올리는 쪽은
[`deploy/demo/README.md`](../deploy/demo/README.md).

## 오디오 (`audio/`)

Google NotebookLM에 주제를 주고 Audio Overview로 생성한 2인 대화. 실제 인물의 음성이 아니며,
화면의 첫 방문 모달이 이를 고지한다. 약관상 상업 이용·재배포가 가능하다(설계 §4.3).

| 파일 | 길이 | 처리 결과 |
|---|---|---|
| `v0와_Cursor가_불러온_프론트엔드_숙련도_논쟁.m4a` | 7.4분 | 발화 39 · 화자 2 · 렌즈 1 · 요약 |
| `AI_코딩이_만든_가짜_생산성의_함정.m4a` | 7.1분 | 발화 49 · 화자 2 · 렌즈 3 · 요약 |
| `AI가_내_머릿속_미지를_사냥하게_하라.m4a` | 23.0분 | 발화 124 · 화자 2 · 렌즈 1 · 요약 |

세 번째가 투어 회의다 — `seed/tour.json`의 `meeting_id`가 `mtg_7`을 가리킨다.

앞의 두 회의는 화자 2명이 같은 speaker 행(`spk_9`, `spk_10`)에 연결돼 있다 — 회의 간 화자
동일성이 시연된다. `mtg_7`은 나중에 따로 처리해서 자기 speaker 행(`spk_11`, `spk_12`)을
쓴다. 렌즈가 적은 것은 팟캐스트형 대화라 액션아이템·결정이 원래 드물기 때문이다
(설계 §3.4에서 예상한 대로). 세 회의의 렌즈는 전부 `decision`이다.

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
`storage/`에 다시 넣지 않는 것은 69MB를 두 번 커밋하지 않기 위해서다.

제목과 `original_filename`은 DB에서 NFC로 정규화해 뒀다. macOS 업로드는 NFD로 들어오는데,
그대로 두면 pg_bigm 검색(NFC 입력)이 제목에 걸리지 않고 Linux에서 파일명 매칭도 어긋난다.

## 시드를 고친 뒤

`build.sh`로 다시 구웠으면 배포는 [`deploy/demo/README.md`](../deploy/demo/README.md)의
`release.sh` 경로다 — 이미지가 덤프와 오디오를 안에 들고 나가므로 서버에서 `restore.sh`를
돌릴 일은 없다.

```bash
demo/seed/build.sh        # 로컬 처리 결과 → demo/seed/
deploy/demo/release.sh    # 이미지 빌드 + ghcr 푸시
```

`restore.sh`는 손으로 띄운 빈 DB를 채우는 수동 경로로만 남아 있다.

## 새 마이그레이션이 생기면

덤프는 그때의 스키마로 굳어 있다. API 컨테이너가 기동 때 마이그레이션을 돌리므로 낡은 덤프로도
뜨기는 하지만, 새 기능의 데이터가 비어 데모에서 보이지 않는다(2026-10 이전 덤프는 021에 멈춰 있어
폴더·태그·'나'가 전부 비었다). 그래서 기능이 데이터를 요구하면 덤프를 다시 굽는다 — **실제 로컬
DB와 `be/storage`는 쓰지 않는다**:

```bash
# 1) 데모 전용 Postgres에 지금 덤프를 올리고 마이그레이션
docker run -d --name damwha-demo-seed -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=damwha \
  -p 55432:5432 damwha/postgres-bigm:pg16
docker exec -i damwha-demo-seed pg_restore --no-owner --no-acl -U postgres -d damwha < demo/seed/damwha-demo.dump
DATABASE_URL=postgres://postgres:postgres@localhost:55432/damwha pnpm be migrate

# 2) 새 기능의 데이터 — 태그·태그 추천·폴더·'나'는 enrich.sql
docker exec -i damwha-demo-seed psql -v ON_ERROR_STOP=1 -U postgres -d damwha < demo/seed/enrich.sql

# 3) 다시 굽기. build.sh는 STORAGE_ROOT의 normalized.flac을 seed/storage로 복사하므로(먼저 지운다)
#    지금 seed/storage를 임시 폴더에 떠 두고 그걸 가리킨다.
cp -R demo/seed/storage /tmp/demo-storage
PG_EXEC="docker exec -i damwha-demo-seed" DATABASE_URL=postgres://postgres:postgres@localhost:5432/damwha \
  STORAGE_ROOT=/tmp/demo-storage demo/seed/build.sh
docker rm -f damwha-demo-seed
```

`enrich.sql`은 이미 들어간 덤프에 다시 돌리면 이름 유일 제약에 걸린다 — 한 번만 쓴다.
