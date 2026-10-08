# 로컬 API 접근 제어 설계

**작성일:** 2026-10-08
**선행:** `dev` @ `a0f2f23` (desktop 0.4.4). 브랜치 `feat/local-api-access-control`.
**대체:** `be/src/main.ts:19`의 `app.enableCors()`("개인용 셀프호스팅 전제 (제한 없는 기본형)")와
`be/src/config/env.ts:7-9`의 `HOST` 기본값 `0.0.0.0` 결정. 둘 다 이 spec의 §3.3·§3.5로 바뀐다.
**범위:** be API(`:3000`)의 Host·Origin 검사와 CORS, `HOST` 기본값, desktop dev의 허용 Origin 주입, fe `<audio>`의
CORS 모드, 데모 compose의 허용 Host, embed 서비스와 LLM 서버(`mlx_lm.server`)의 "브라우저 금지" 가드.
**후속:** 회의 공유 링크(`2026-10-08-meeting-share-design.md`)의 선행 조건이다 — 그 spec의 §2.10 "로컬 API 접근 제어"와
§4 미결 마지막 항목.

## 1. 목표와 성공 기준

사용자가 브라우저로 연 아무 웹페이지가 로컬 API로 회의를 읽거나 바꾸지 못하게 한다. 정상 경로 셋(패키징 desktop,
`pnpm dev`, 데모)은 그대로 동작한다.

- 다른 Origin의 페이지는 `/api` 응답을 읽지 못한다.
- 다른 Origin의 페이지가 보낸 쓰기 요청은 preflight가 없는 simple request(form POST, `multipart/form-data`,
  `text/plain`, urlencoded)여도 핸들러에 닿기 전에 403으로 끝난다.
- `Host`가 허용 목록 밖인 요청은 경로와 관계없이 403이다(DNS rebinding).
- 이 보호는 **라우트별 선언 없이** 모든 `/api` 라우트에 걸린다. 새 라우트도 자동으로 보호된다.
- 패키징 desktop(같은 origin), `pnpm dev`(Vite `:5173` → `localhost:3000`, cross-origin), desktop dev
  (`localhost:5173` → `127.0.0.1:<port>`, cross-site), 데모(`damwha-demo.0kimjae.dev`, 같은 origin)에서
  회의 열람·오디오 재생·업로드·삭제·설정·실시간 녹음이 그대로 된다.
- embed 서비스와 LLM 서버는 브라우저에서 온 요청을 받지 않는다.

## 2. 위협 모델

조사 결과(2026-10-08, `pnpm be:dev`로 재현):

| # | 위협 | 지금 | 이 spec |
| --- | --- | --- | --- |
| 1 | 악성 페이지의 **읽기** | `GET /api/meetings`에 `Origin: https://evil.example` → 200, `Access-Control-Allow-Origin: *`. 회의 전체가 읽힌다 | §3.1 ②③, §3.3 |
| 2 | 악성 페이지의 **쓰기(CSRF)** | `POST /api/folders`에 urlencoded `name=…`, 다른 Origin → **201**. Nest가 `init()`에서 urlencoded 파서(`extended: true`)를 기본으로 건다(`main.ts`에는 없다) | §3.1 ② |
| 3 | **DNS rebinding** | `Host: attacker.example:3000` → 200 | §3.1 ① |
| 4 | 다른 로컬 리스너 | 아래 | §3.8 |
| 5 | 같은 Mac의 다른 로컬 프로세스 | 위협 모델 밖 | — |

**2번 — simple request로 닿는 라우트 전수.** 70개 라우트 중 GET은 모두 읽기다(부수 효과 있는 GET 없음).
preflight 없이 실행되는 POST:

- 본문이 필요 없거나 `{}`로 통과: `POST /meetings/live`(녹음 슬롯 `meeting_single_recording_idx`를 차지),
  `/meetings/:id/{cancel,reprocess,reindex}`, `/meetings/reindex-missing`, `/meetings/:id/lenses/{extract,cancel}`,
  `/meetings/:id/summary/{generate,cancel}`, `/lenses/:id/{complete,reopen}`, `/search`.
- multipart 업로드: `POST /meetings`, `POST /speakers`.
- urlencoded 필드로 통과: `/models/{download,delete,cancel}`, `POST /folders`, `/meetings/:id/clusters/:clusterId/resolve`,
  `POST /lenses`, `/lenses/:id/evidence`.

PUT·PATCH·DELETE(회의 삭제, 설정 변경 등)와 커스텀 헤더를 쓰는 `live/audio`·`live/stop`은 preflight를 거치지만,
지금은 `enableCors()`가 모든 preflight를 승인하므로 똑같이 열려 있다.

**4번 — 다른 로컬 리스너.**

| 리스너 | 상태 | 결정 |
| --- | --- | --- |
| 번들 Postgres | TCP를 열지 않는다(`listen_addresses` 비움, 소켓 디렉터리 0700). 브라우저가 닿을 수 없다 | 범위 밖 |
| embed (`127.0.0.1:8100`, FastAPI) | CORS 헤더 없음. `text/plain` 본문은 파싱하지 않아 422(실측). 일반 cross-origin은 막혀 있다. **rebinding이면** 같은 origin이 되어 `POST /embed`로 개수·길이 제한 없는 텍스트를 넣어 CPU·메모리를 쓸 수 있다. 돌려받는 건 공격자 자신의 텍스트 벡터뿐 | 포함 (§3.8) |
| LLM (`mlx_lm.server`, 실행마다 무작위 포트, job 동안만) | `--allowed-origins` 기본값 `*`로 모든 응답에 `ACAO: *`·`Allow-Methods: *`·`Allow-Headers: *`(`mlx_lm/server.py:1075-1084`). 본문을 Content-Type과 관계없이 `json.loads`(`:1137`)하므로 `text/plain` simple request가 통한다. 요청의 `model` 필드로 임의 HF 저장소를 받게 할 수 있다 | 포함 (§3.8) |
| 실시간 녹음 | 별도 채널 없음(WebSocket·SSE 없음). be API의 `live/*` 라우트일 뿐이다 | be 검사로 덮인다 |

**5번 — 로컬 프로세스를 빼는 이유.** 같은 사용자로 도는 프로세스는 `~/Library/Application Support/Damwha`의 DB
소켓·저장소 파일을 직접 읽을 수 있다. API에 비밀값을 걸어도 그 비밀값이 같은 사용자 권한 안(env, 디스크)에 있으므로
막지 못한다. 그래서 이 spec은 **브라우저가 강제하는 헤더**(`Host`, `Origin`, `Sec-Fetch-Site`)만으로 판정하고,
헤더가 없는 요청(curl, desktop 감독자의 헬스 프로브, be의 embed 호출)은 통과시킨다.

**그 밖에 확인한 것.** 브라우저 쿠키·`withCredentials`는 어디에도 없다 — 인증 정보를 실어 보내는 요청이 없으므로
CORS 응답에 `Access-Control-Allow-Credentials`가 필요 없다. 앱을 iframe에 넣는 곳도 없다(fe·site 전수) — 클릭재킹
방지 헤더를 무조건 걸 수 있다.

## 3. 설계

### 3.1 be 접근 제어 판정

모든 요청에 다음을 순서대로 적용한다. 판정은 순수 함수 하나(`evaluateAccess(req, policy)`)가 하고,
express 미들웨어가 그 결과로 응답한다.

**① Host (모든 경로).** `Host` 헤더에서 포트를 떼고 소문자로 비교한다. 허용:

- 항상: `localhost`, `127.0.0.1`, `[::1]` — **포트는 보지 않는다.** desktop은 3000이 막히면 무작위 포트로
  물러나고(`desktop/src/services/api.ts:168-188`), Docker 포트 매핑도 바깥 포트가 다르다.
- `ALLOWED_HOSTS`(쉼표 구분 호스트 이름, 포트 없음)에 있는 이름.
- `Host` 헤더가 없거나 파싱할 수 없으면 거부.

거부 → `403 { code: "HOST_NOT_ALLOWED" }`. `/api` 밖(SPA, 정적 파일, `/docs`)에도 적용한다 — rebinding으로
SPA를 같은 origin에 올리면 그 SPA가 `/api`를 같은 origin으로 부르기 때문이다.

**② 브라우저 출처 (`/api` 아래만).**

1. `Origin` 헤더가 있으면:
   - `"null"`(sandbox iframe, `file:` 등) → 거부.
   - `new URL(origin).host`가 요청의 `Host`와 같으면 같은 origin → 통과. scheme은 비교하지 않는다 — 데모는
     Cloudflare 터널 뒤라 바깥은 https, 컨테이너에 닿는 요청은 http다. ①을 통과한 Host이므로 그 호스트를 쓰는
     페이지는 우리 페이지뿐이다.
   - `ALLOWED_ORIGINS`(쉼표 구분, 정확히 일치)에 있으면 통과.
   - 그 밖 → 거부.
2. `Origin`이 없으면 `Sec-Fetch-Site`를 본다: `cross-site`·`same-site` → 거부. `same-origin`·`none`·헤더 없음 → 통과.
   - `Origin`이 없는 브라우저 요청은 no-cors GET(`<img>`, `<audio>`, `<script>`, 내비게이션)뿐이다. 모든 최신
     브라우저는 POST에 `Origin`을 보낸다(form 포함).
   - `same-site`도 거부하는 이유: `localhost:3000`과 `localhost:8080`은 포트만 다른 같은 site다. 사용자가 띄운
     다른 로컬 개발 서버의 페이지를 믿을 이유가 없다.
   - `Sec-Fetch-Site`가 없는 옛 브라우저(Safari < 16.4)의 cross-site no-cors GET은 통과하지만 응답이 opaque라
     읽을 수 없다. 쓰기는 1번의 `Origin` 검사가 막는다.
   - `Sec-Fetch-Mode`는 보지 않는다. Node `fetch`(undici)가 `sec-fetch-mode: cors`를 붙이지만(실측) `Origin`·
     `Sec-Fetch-Site`는 붙이지 않는다.

거부 → `403 { code: "ORIGIN_NOT_ALLOWED", message }`. message는 개발자가 고칠 곳을 알 수 있게 거부된
Origin과 `ALLOWED_ORIGINS` env 이름을 담는다.

**`/api` 밖을 ②에서 빼는 이유.** 제품 사이트(`site/src/i18n/{ko,en}.ts`)가 데모 `/?lang=…`로 링크한다 — 그건
cross-site 내비게이션이다. SPA·정적 파일은 공개 코드이고 읽어서 얻을 게 없다. `/docs-json`도 레포에 있는
스키마다.

**③ 응답 헤더 (모든 응답).** `Content-Security-Policy: frame-ancestors 'none'`과 `X-Frame-Options: DENY`.
②는 같은 origin 요청을 통과시키므로, 악성 페이지가 앱을 iframe에 넣고 사용자를 속여 삭제 버튼을 누르게 하는
경로는 ②로 막히지 않는다. 이 헤더가 막는다.

### 3.2 CORS

`app.enableCors()`를 지운다. CORS 응답은 같은 미들웨어가 만든다(라이브러리 `cors`를 쓰더라도 origin 판정은
§3.1과 **같은 함수**로 한다 — 둘이 따로 판정하면 어긋난다).

- `ALLOWED_ORIGINS`에 있는 Origin에만 `Access-Control-Allow-Origin: <그 origin>`과 `Vary: Origin`.
  `*`는 어떤 경우에도 내보내지 않는다.
- preflight(`OPTIONS` + `Access-Control-Request-Method`): 허용 Origin이면 204와 `Allow-Methods`
  (GET, HEAD, PUT, PATCH, POST, DELETE), `Allow-Headers`(요청한 헤더를 되돌린다), `Max-Age`. 아니면 ②대로 403.
- 같은 origin 요청에는 CORS 헤더가 필요 없다.
- `Access-Control-Allow-Credentials`는 보내지 않는다(쿠키를 쓰지 않는다).

### 3.3 적용 위치

e2e 26개는 `main.ts`를 거치지 않고 `Test.createTestingModule({ imports: [AppModule] })` → `app.init()`으로
앱을 만든다. `main.ts`에만 건 보호는 어떤 테스트도 실행하지 않는다. 또 `main.ts`는 SPA 정적 서빙을 `init()` 전에
`app.use`로 거는데, Nest 모듈 미들웨어는 그 뒤에 붙어 SPA·`/docs`를 덮지 못한다.

그래서 `main.ts`의 HTTP 구성(본문 파서, 접근 제어, 전역 prefix, SPA 정적 서빙, Swagger)을 **함수 하나**
(`configureHttp(app, env)`)로 옮긴다. `main.ts`는 그 함수를 부르고 listen만 한다. 접근 제어 e2e는 같은 함수로
앱을 만든다 — 테스트가 검사하는 구성이 곧 운영 구성이다. 접근 제어 미들웨어는 그 함수의 **첫 `app.use`**다
(SPA·정적·Swagger·Nest 라우터보다 앞).

기존 e2e는 고치지 않는다. 그 테스트들은 접근 제어를 거치지 않는 지금 모양 그대로 업무 로직을 검사한다.

### 3.4 env

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | 비움 | 같은 origin 말고 `/api`를 부를 수 있는 Origin. 쉼표 구분, 정확히 일치(`http://localhost:5173`). |
| `ALLOWED_HOSTS` | 비움 | loopback 셋 말고 허용할 `Host` 이름(포트 없음). |
| `HOST` | **`127.0.0.1`** (기존 `0.0.0.0`) | listen 주소. |

- `loadEnv()` 스키마에 넣고 시작할 때 형식을 검사한다 — `ALLOWED_ORIGINS`의 각 항목은 `new URL(x).origin === x`
  여야 하고(끝 슬래시·경로가 있으면 기동 실패), `ALLOWED_HOSTS`는 포트·scheme이 없는 이름이어야 한다. 조용히
  무시하면 "설정했는데 403"이 된다.
- `*` 같은 와일드카드는 받지 않는다.
- `be/.env.example`에 `ALLOWED_ORIGINS=http://localhost:5173`를 넣는다(`pnpm dev`용).

### 3.5 `HOST` 기본값

`pnpm dev`가 API를 LAN 전체에 열고 있었다(`0.0.0.0`). 기본값을 `127.0.0.1`로 바꾼다. 컨테이너는 바깥에서
닿아야 하므로 `deploy/api.Dockerfile`에 `ENV HOST=0.0.0.0`을 넣는다. desktop은 이미 `HOST=127.0.0.1`을 마지막에
덮어쓴다(`api-process.ts:46`) — 바뀌지 않는다.

### 3.6 desktop

- **dev:** 감독자가 API 자식 env에 `ALLOWED_ORIGINS=http://localhost:5173`(`main.ts:144`의 `VITE_ORIGIN`)을
  넣는다. packaged에는 넣지 않는다 — 렌더러가 API와 같은 origin이다(`main.ts:1017`).
- `config.json`이 `ALLOWED_ORIGINS`·`ALLOWED_HOSTS`를 덮을 수 없게 한다(`config.ts:106-124`의 거부 목록) —
  `HOST`를 막은 것과 같은 이유다. 설정 파일 한 줄로 보호가 풀리면 안 된다.
- 헬스 프로브(`process/readiness.ts`)는 Node `fetch`라 `Origin`·`Sec-Fetch-Site`가 없고 `Host`가 `127.0.0.1:<port>`다
  — §3.1을 통과한다. 테스트로 고정한다(§6).

### 3.7 fe

- axios 경로는 바꾸지 않는다. cross-origin dev에서 브라우저가 `Origin`을 붙이고, 같은 origin 빌드에서는
  `Origin`이 같거나 `Sec-Fetch-Site: same-origin`이다.
- **`<audio>`에 `crossOrigin="anonymous"`.** `GET /meetings/:id/audio`는 `<audio src>`(`pages/meeting.tsx:796`,
  `shared/lib/use-sample-player.tsx`)로 불려 커스텀 헤더를 실을 수 없고, no-cors GET이라 `Origin`도 없다. dev에서는
  `Sec-Fetch-Site`가 `same-site`(`pnpm dev`) 또는 `cross-site`(desktop dev)라 §3.1 ②에서 거부된다. CORS 모드로
  바꾸면 브라우저가 `Origin`을 붙이고 허용 Origin이면 통과한다. 같은 origin 빌드에서는 차이가 없다.
- 데모 읽기 전용 인터셉터는 그대로다.

### 3.8 embed·LLM: 브라우저 금지 가드

두 서버의 클라이언트는 be(Node `fetch`), desktop 프로브(Node `fetch`), worker(httpx)뿐이다. 브라우저 클라이언트가
없으므로 판정이 단순하다:

- `Origin` 헤더가 있거나 `Sec-Fetch-Site` 헤더가 있으면 403.
- `Host`의 호스트 이름이 `localhost`·`127.0.0.1`·`[::1]`이 아니면 403(rebinding).
- CORS 헤더를 내보내지 않는다.

**embed** (`be/worker/damwha_worker/embed_service.py`): FastAPI HTTP 미들웨어로 건다. `/health`를 포함한 모든 경로.

**LLM** (`be/worker/damwha_worker/llm_entry.py`): `mlx_lm.server.main()`을 부르기 전에 같은 프로세스에서
`mlx_lm.server`의 요청 핸들러 클래스를 감싸 `do_GET`·`do_POST`·`do_OPTIONS`(그 밖에 정의된 `do_*`) 앞에서 위 판정을
한다. 또한 `llm_server.py`가 `--allowed-origins`에 브라우저가 보낼 수 없는 값을 넘겨 `*`를 끈다(정확한 값은
plan에서 `server.py`의 비교 방식을 보고 정한다). mlx_lm 버전이 바뀌어 핸들러 클래스 이름이 사라지면 **기동을
실패시킨다** — 조용히 가드 없이 뜨면 안 된다.

이 가드가 덮지 않는 것(문서에 적는다): `LENS_LLM_SERVER_BIN` 탈출구(그때는 `llm_entry`를 거치지 않는다)와
"이미 떠 있는 서버를 재사용"하는 경로(`llm_server.py` — 우리 프로세스가 아니다).

### 3.9 데모

데모 컨테이너는 Cloudflare 터널 뒤에서 `Host: damwha-demo.0kimjae.dev`로 요청을 받는다(cloudflared 기본은 원래
Host를 그대로 넘긴다). `deploy/demo/docker-compose.yml`에 `ALLOWED_HOSTS: damwha-demo.0kimjae.dev`를 넣는다.
`curl localhost:3000/api/health`(README의 확인 명령)와 같은 origin SPA는 그대로 된다. `DEMO_READ_ONLY`와는 독립이다.

## 4. 마이그레이션 안내

| 누구 | 바뀌는 것 | 할 일 |
| --- | --- | --- |
| 패키징 desktop 사용자 | 없음 | 없음 |
| `pnpm dev` 개발자 | 기존 `be/.env`에 `ALLOWED_ORIGINS`가 없으면 SPA의 API 호출이 403(`ORIGIN_NOT_ALLOWED`, 본문이 env 이름을 알려 준다). LAN에서 API가 안 보인다 | `be/.env`에 `ALLOWED_ORIGINS=http://localhost:5173` 한 줄. LAN 노출이 필요하면 `HOST=0.0.0.0` |
| desktop dev | 감독자가 넣는다 | 없음 |
| 데모 운영 | 새 이미지 + 옛 compose면 모든 요청 403(`HOST_NOT_ALLOWED`) | **compose 파일을 다시 받은 뒤** `pull`·`up`. `deploy/demo/README.md`의 시드 갱신 절차에 적는다 |
| Docker 셀프호스팅 | 은퇴(`docs/electron-migration-roadmap.md`, 2026-09-23). 남은 이미지 사용자가 있다면 접속 호스트 이름을 `ALLOWED_HOSTS`에 | README·be/CLAUDE.md에 env 설명 |

## 5. 하지 않는 것

- 같은 Mac의 다른 로컬 프로세스 차단(§2 5번).
- 비밀값·토큰·쿠키 기반 인증. 브라우저 헤더 검사로 위협 1~3이 막히므로 렌더러 전달·`<audio>`·dev·데모 경로를
  복잡하게 만들 이유가 없다.
- 쓰기 요청에 커스텀 헤더 강제(이중 장치). §3.1 ②가 같은 것을 막는다.
- `Origin`·`Sec-Fetch-*`를 보내지 않는 옛 브라우저의 cross-site no-cors GET 차단(응답은 opaque).
- Chromium Local Network Access(Private Network Access) 프롬프트에 기대는 것. 브라우저마다 다르고 우리가
  통제하지 못한다.
- `LENS_LLM_SERVER_BIN`·재사용 서버의 LLM 가드(§3.8).
- 번들 Postgres(TCP 없음).
- 오디오 스트리밍을 Blob으로 바꾸기(Range·스트리밍을 잃는다).

## 6. 검증

**be 단위 (`evaluateAccess`)** — 표 기반:

- Host: loopback 셋 × 여러 포트 통과, `[::1]` 통과, `attacker.example:3000` 거부, `ALLOWED_HOSTS` 이름 통과,
  Host 없음 거부, 대소문자.
- Origin: 같은 origin(`http://127.0.0.1:3000` + `Host: 127.0.0.1:3000`) 통과, 다른 포트 거부, `"null"` 거부,
  `ALLOWED_ORIGINS` 통과, 끝 슬래시 달린 Origin 거부, 데모(`https://damwha-demo…` + `Host: damwha-demo…`) 통과.
- Origin 없음: `Sec-Fetch-Site` `cross-site`·`same-site` 거부, `same-origin`·`none`·없음 통과.
- `/api` 밖 경로는 ②를 건너뛴다(①은 적용).
- env 파싱: 잘못된 `ALLOWED_ORIGINS`·`ALLOWED_HOSTS` 항목은 기동 실패.

**be e2e (`configureHttp`로 만든 앱, 공격 시나리오별)**:

1. 다른 Origin의 `GET /api/meetings` → 403이고 `Access-Control-Allow-Origin` 없음.
2. 다른 Origin의 urlencoded `POST /api/folders` → 403이고 **폴더 행이 생기지 않음**(DB 확인).
3. 다른 Origin의 multipart `POST /api/meetings` → 403이고 회의 행·저장 파일이 생기지 않음.
4. 다른 Origin의 `text/plain` `POST /api/meetings/live` → 403이고 회의 행이 생기지 않음.
5. `Origin` 없이 `Sec-Fetch-Site: cross-site`인 `GET /api/meetings/:id/audio` → 403.
6. 다른 Origin의 preflight(`OPTIONS /api/meetings/:id`, `DELETE`) → 403. 허용 Origin의 preflight → 204와
   그 Origin을 담은 `ACAO`.
7. `Host: attacker.example:3000` → `/api/health`·`/docs` 모두 403(`/api` 밖도 ①이 막는다).
8. 정상: 같은 origin(packaged 모양) GET·POST·DELETE 통과, 허용 Origin(dev 모양) GET에 `ACAO: http://localhost:5173`,
   헤더 없는 요청(헬스 프로브 모양) 통과, `Range` 오디오 요청 206.
9. 모든 응답에 `frame-ancestors 'none'`·`X-Frame-Options: DENY`.

**변이 확인.** 보안 테스트마다 검사 코드를 일부러 지운 상태(Host 검사 제거, Origin 검사 제거, `Sec-Fetch-Site`
분기 제거, `enableCors()` 되살리기, 미들웨어 등록 순서를 SPA 뒤로)에서 해당 테스트가 **실패하는지** 돌려 보고 결과를
result에 적는다. 실패하지 않는 테스트는 고친다.

**desktop:** `apiChildEnv`/감독자 env가 dev에서만 `ALLOWED_ORIGINS`를 넣고 packaged에선 넣지 않음, `config.json`의
두 키 거부, 헬스 프로브 요청 모양이 §3.1을 통과함(be 판정 함수와의 계약 — 헤더 목록 고정).

**worker (pytest):** embed 미들웨어 — `Origin` 있음·`Sec-Fetch-Site` 있음·비 loopback Host 각각 403, 헤더 없는
요청 통과. LLM 가드 — 감싼 핸들러에 같은 표를 적용(실제 mlx 모델 없이 핸들러만), mlx_lm 핸들러 클래스가 없으면
기동 실패.

**수동 (result에 기록):**

- `pnpm dev`: 회의 목록·상세·오디오 재생(구간 미리듣기 포함)·업로드·삭제·설정 저장·실시간 녹음 시작/정지.
- 패키징 desktop(`pnpm package:desktop`): 같은 항목.
- 임시 로컬 HTML(다른 포트에서 서빙)에서 `fetch` GET, form POST, multipart 업로드, `<audio src>`를 보내
  모두 막히는지. 브라우저 개발자 도구로 응답 코드를 확인한다.
- `curl`로 rebinding 흉내(`-H 'Host: attacker.example'`) be·embed 403.

## 7. 완료 기준

1. §6 be e2e 1~9가 통과하고, 변이 확인에서 각 보안 테스트가 대응 변이에 실패한다.
2. `enableCors()`가 코드에 없고, 어떤 응답에도 `Access-Control-Allow-Origin: *`가 없다.
3. `HOST` 기본값이 `127.0.0.1`이고 Docker 이미지는 `0.0.0.0`으로 뜬다.
4. `pnpm dev`·패키징 desktop에서 §6 수동 항목이 된다.
5. 다른 origin 페이지에서 보낸 읽기·쓰기·업로드·오디오 요청이 막힌다(수동).
6. embed·LLM 가드가 테스트로 고정되고, `curl` rebinding 흉내가 403이다.
7. 데모 compose·README, `be/.env.example`, be/CLAUDE.md(불변식 항목), desktop/CLAUDE.md가 갱신된다.
8. result 끝에 공유 기능이 따라야 할 규칙(§8)을 남긴다.

## 8. 공유 기능에 넘기는 규칙 (초안 — result에서 확정)

- 새 `/api` 라우트는 선언 없이 §3.1의 Host·Origin 검사를 받는다. 공유 생성·미리보기·중지 라우트도 같다.
- 공유 라우트를 GET으로 상태를 바꾸게 만들지 않는다 — no-cors GET은 `Origin` 없이 오므로 쓰기 보호가 POST·PUT·
  PATCH·DELETE의 `Origin` 검사에 기대고 있다.
- 공유 응답(링크·키)은 같은 origin 또는 `ALLOWED_ORIGINS`에서만 읽힌다. `ALLOWED_ORIGINS`에 공유 서비스 도메인을
  넣지 않는다.
