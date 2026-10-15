# damwha-share

공유 링크 서버 (spec `docs/superpowers/specs/2026-10-09-meeting-share-selfhost-v2-design.md`). Node 프로세스 하나가
`/api/shares`(암호문 업로드·조회·삭제·교체)와 `/s/:id`(정적 뷰어)를 서빙한다. 서버에는 암호문만 저장되고 키는 저장하지 않는다 — 키는 링크의 `#` 뒤에만 있다.

## 로컬

    pnpm share:dev                         # :8787, 데이터는 share/.data/
    cp share/.env.example share/.env       # DEV_EXPIRY_SECONDS=60 — 만료 흐름을 1분 만에 본다

be는 `be/.env`의 `SHARE_API_URL=http://localhost:8787`로 붙는다. 스크립트 이름을 `dev`로 바꾸지 않는다 —
루트 `pnpm dev`가 `--recursive run dev`라 끌려 들어간다.

## 구조

- `src/app.ts` — 순수 핸들러 `createApp(deps).fetch(req, { ip })`. 테스트는 네트워크 없이 이것을 부른다.
- `src/store.ts` — `shares/<id>.bin` + `<id>.json`. 메타가 있어야 존재한다(쓰기는 봉투 → 메타, 지우기는 메타 → 봉투).
- `src/limits.ts` — IP별 제한(분당 업로드 10·조회 120·삭제 30)과 일일 상한(업로드 500건·500 MB). 프로세스 하나 전제라 카운터는 메모리에 있고 재시작하면 초기화된다.
- `src/main.ts` — `@hono/node-server`로 붙이고 10분마다 만료 파일을 지운다.

## 배포

`deploy/share/README.md` (개인 서버 Docker + Cloudflare Tunnel).
