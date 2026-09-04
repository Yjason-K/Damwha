# 공개 데모 배포

읽기 전용 데모(설계 §3.6)를 홈 서버(arm64)에 올리고 Cloudflare Tunnel로 노출한다.
팀 트라이얼 배포(`deploy/README.md`, `damwha-api`/`damwha-postgres`)와는 **이미지 이름부터
다른 별개 릴리스**다.

## 이미지

| 이미지 | 내용 |
|---|---|
| `ghcr.io/yjason-k/damwha-demo-postgres` | pgvector + pg_bigm + `demo/seed/damwha-demo.dump`. 빈 볼륨으로 **처음 뜰 때만** initdb.d에서 복원 |
| `ghcr.io/yjason-k/damwha-demo-api` | API + SPA(`VITE_DEMO_MODE=true`) + 시드 오디오가 `./storage`에 베이크됨. 볼륨 없음 |

둘 다 `linux/arm64` 단일 플랫폼, 태그는 날짜(`YYYYMMDD`) + `latest`.

## 서버에서

```bash
mkdir damwha-demo && cd damwha-demo
curl -O https://raw.githubusercontent.com/Yjason-K/Damwha/main/deploy/demo/docker-compose.yml
docker compose up -d
curl localhost:3000/api/health          # {"status":"ok","db":"ok"}
```

`.env`가 필요 없다. 바꿀 수 있는 것은 `DAMWHA_DEMO_TAG`(기본 `latest`)와
`DAMWHA_DEMO_PORT`(기본 3000)뿐이다. 이미지가 비공개면 `docker login ghcr.io` 먼저.

Cloudflare Zero Trust → Tunnels → 기존 터널 → Public Hostname 추가:
서브도메인 지정, Service `HTTP` / `localhost:3000`. 그게 전부다 — 컨테이너가 같은 호스트에
있으면 cloudflared가 그대로 붙는다. cloudflared가 컨테이너라면 `host.docker.internal:3000`
또는 compose 네트워크에 붙여 `damwha-demo-api:3000`.

## 시드 갱신

```bash
demo/seed/build.sh                      # 로컬 처리 결과 → demo/seed/
deploy/demo/release.sh                  # 빌드 + ghcr 푸시 (태그 = 오늘)
# 서버
docker compose pull && docker compose down -v && docker compose up -d
```

`down -v`가 필요한 이유: 복원은 빈 볼륨의 첫 기동에서만 일어난다. 볼륨을 지우지 않으면
새 덤프가 무시된다. 로컬 스모크는 `PUSH=0 deploy/demo/release.sh smoke` 뒤
`DAMWHA_DEMO_TAG=smoke DAMWHA_DEMO_PORT=3100 docker compose up -d`.

## 둘러보기(투어) 회의

`demo/seed/tour.json`이 투어의 "테스트 오디오 업로드" 결과로 드러낼 회의를 정한다
(투어 설계 `docs/superpowers/specs/2026-09-04-demo-guided-tour-design.md`).

- `meeting_id` — `manifest.json`에 있는 id. release.sh가 없으면 실패한다.
- `file_label` — 업로드 모달에 보일 "파일명 · 크기".
- `search_query` — 검색 단계에서 넣을 예시어. 그 회의 전사에 확실히 있는 단어.

시드를 새로 구울 때 체크리스트: 투어 회의는 렌즈가 1건 이상, 요약 done, `demo/audio/`에
원본 m4a 존재(`find-original.py`가 확인). 로컬에서 보려면 `fe/.env.local`에
`VITE_DEMO_MODE=true`와 위 세 값을 `VITE_DEMO_TOUR_*`로 넣고 `pnpm fe dev`. vitest도 `.env.local`을 읽으므로 그 상태로 `pnpm fe test`를 돌리면 upload-dialog 테스트 6개가 실패한다 — 테스트 전에 파일을 지우거나 이름을 바꾼다.

## 링크 미리보기

`fe/index.html`의 Open Graph 태그가 `og:image`로 `/og.png`(1200×630, `fe/public/og.png`)를 가리킨다.
크롤러는 절대 URL만 받으므로 릴리스 때 공개 주소를 넘긴다:

```bash
DEMO_PUBLIC_URL=https://<데모 도메인> deploy/demo/release.sh
```

비우면 상대 경로로 남아 카카오·슬랙 등의 미리보기에 이미지가 안 뜬다. 바뀐 미리보기가
안 보이면 각 서비스의 캐시(카카오 링크 디버거, 슬랙은 재공유) 때문이다.

## 데모에서 꺼진 것

- 쓰기 전부 — API `DEMO_READ_ONLY=true`가 GET/HEAD/OPTIONS와 `POST /search` 외 요청을 403으로
  닫는다. SPA는 같은 요청을 서버에 보내기 전에 끊고 토스트를 띄운다.
- 워커·임베드 서비스 — 없다. 검색은 BM25(pg_bigm)로 폴백한다(`"mode":"keyword"`).
- 첫 방문 안내 모달이 합성 오디오임을 고지한다(설계 §1 정직성 항목).
