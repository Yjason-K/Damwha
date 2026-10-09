# 로컬 API 접근 제어 결과

**작성일:** 2026-10-08 (구현·검증은 2026-10-08~09에 진행)
**Spec:** [`specs/2026-10-08-local-api-access-control-design.md`](../specs/2026-10-08-local-api-access-control-design.md)
**Plan:** [`plans/2026-10-08-local-api-access-control.md`](../plans/2026-10-08-local-api-access-control.md)
**브랜치:** `feat/local-api-access-control` (`dev` @ `a0f2f23`에서 분기)

## 요약

브라우저가 로컬 API(be), embed 서비스, LLM 서버를 건드리지 못하게 막았다.
- be: `enableCors()`를 없애고, 라우터보다 앞선 미들웨어에서 Host·Origin·`Sec-Fetch-Site`를 판정한다. 어떤 응답에도 `Access-Control-Allow-Origin: *`가 없다.
- `HOST` 기본값은 `127.0.0.1`이고 Docker 이미지만 `0.0.0.0`으로 뜬다. 허용 목록은 `ALLOWED_HOSTS`·`ALLOWED_ORIGINS` env다.
- desktop이 API 자식의 허용 Origin을 정한다(dev는 Vite origin, packaged는 없음). fe는 오디오를 CORS 모드로 요청하고 Vite를 5173에 고정한다.
- worker: embed 서비스와 LLM 서버의 `APIHandler`에 같은 브라우저 금지 가드(`browser_guard`)를 건다.

## 커밋 (`git log --oneline 8fd6ca8..HEAD`)

```
e417455 docs: LAN 접속 시 ALLOWED_HOSTS·ORIGINS, embed 가드 문서, llm_guard 멱등 테스트 보강
6bcdd09 feat(be): 거부된 Origin·Host를 처음 한 번 로그하고 게이트 경로 전체에 Vary: Origin
5a2e62b test(be): 큰 본문 거부 행을 raw http로 결정적으로 — supertest 쓰기 중 403 응답 ECONNRESET 경합 제거
cdddeaf docs: 로컬 API 접근 제어 — 데모 ALLOWED_HOSTS, 불변식, desktop·worker 문서
b2d7723 feat(worker): LLM 서버의 APIHandler에 브라우저 금지 가드를 건다
37c7441 feat(worker): embed 서비스가 브라우저·rebinding 요청을 거부한다
3f19633 feat(worker): embed·LLM 서버용 브라우저 금지 판정
422ac0d feat(desktop): API 자식의 허용 Origin을 앱이 정한다 — dev는 Vite origin, packaged는 없음
3d5e074 feat(fe): 오디오를 CORS 모드로 요청하고 Vite를 5173에 고정
6fccd76 feat(be): 로컬 API 접근 제어 미들웨어 — enableCors를 Host·Origin 검사로 대체
90c7a68 feat(be): Host·Origin 접근 판정 함수
d0d4712 feat(be): 접근 제어 허용 목록 env와 HOST 기본값 127.0.0.1
ae4b149 docs(plan): 로컬 API 접근 제어 구현 계획
4804684 docs(spec): 로컬 API 접근 제어 — Codex 리뷰 반영
08d20d0 docs(spec): 로컬 API 접근 제어 설계
```

## 계획·spec과 달라진 점

- **`llm_server.py`에 `--allowed-origins`를 넣지 않았다.**
  - spec §3.8은 `--allowed-origins`에 브라우저가 보낼 수 없는 값을 넘겨 `*`를 끄는 이중 장치를 말했다.
  - 그러나 그 인자를 읽는 곳은 `_set_cors_headers`뿐이고, Task 9의 가드가 이 메서드를 무력화해 CORS 헤더 자체를 없앤다. 인자를 더하면 효과 없이 CLI 표면만 늘고, 탈출구 백엔드가 모르는 인자를 거부할 위험도 생긴다.
  - 그래서 spec §6의 `test_llm_server.py` 기동 인자 고정(`--allowed-origins` 추가)은 **대체**됐다. 가드는 `test_llm_guard.py`가 고정한다. 틀렸을 때의 비용은 인자 하나를 나중에 더하는 정도이고, 가드가 CORS 헤더를 없애므로 노출은 없다.
- **`vite-config` 테스트는 `loadConfigFromFile`로 설정을 읽는다.** 계획은 `../vite.config`를 import하는 것이었으나 jsdom/node pragma에서 깨졌고, 리뷰어가 이 방식을 받아들였다.
- **최종 리뷰에서 둘이 더 들어왔다.**
  - F2: 거부된 Origin·Host를 처음 한 번 warn 로그(개발자가 거부를 볼 수 있게).
  - F3: 게이트 경로 전체(403·Origin 없는 응답 포함)에 `Vary: Origin`.
  - 함께 F1(큰 본문 행 결정화), F4(LAN 문서), F5(`llm_guard` 멱등 단언), F6(embed 가드 문서)를 한 번에 처리했다.

## 검증

| 명령 | 결과 |
| --- | --- |
| `pnpm be test` (수정 파동 전, Task 11) | 775/777. 부하 flake 둘: access-control "큰 JSON은 413이 아니라 403"(ECONNRESET), lenses keyset("socket hang up"). 둘 다 단독 실행은 통과, access-control은 3/3 재실행 통과 |
| `pnpm be test` (수정 파동 뒤) | 63/64 suites, 782/783. 실패 1건은 speakers-management "DELETE clears me and is idempotent"(501) — 접근 제어와 무관, 단독 17/17 통과 |
| `jest` access-control.middleware + e2e + evaluate-access | 3 suites, 84 passed |
| `tsc --noEmit -p tsconfig.build.json` (be) | 통과 |
| `fe`: vitest / `pnpm lint` | 835/835 / 오류 0 |
| `desktop`: 테스트 / lint | 1247/1247 / 통과 |
| `uv run --directory be/worker pytest -q` | 973 passed |
| `ruff check` (worker) | 4건, 모두 이 브랜치가 건드린 파일 밖의 기존 오류 |
| `pytest tests/test_llm_guard.py` + ruff check·format | 21 passed, 깨끗 |

**flake 메모.**
- 우리 쪽 flake는 큰 본문 거부 행이었다. 서버가 본문이 오기 전에 403을 보내면 supertest 쓰기 중 ECONNRESET이 난다. F1이 이 두 행을 raw `node:http`(선언된 Content-Length가 파서 한도 초과, 1 KB만 쓰고 요청을 끝내지 않음)로 바꿔 없앴다. 수정 뒤 `-t "본문 파서"` 5회 연속 통과.
- meetings(task 3에서 base `90c7a68`에서도 재현), lenses, speakers-management의 부하 flake는 이 브랜치 이전부터 있던 것이고 전체 실행에서만 가끔 나온다.

### 변이 검증 (be e2e)

변이를 하나씩 적용하고 `pnpm --filter damwha-be exec jest test/access-control.e2e-spec.ts -t "<패턴>"`을 돌린 뒤 `git checkout`으로 되돌렸다. 원복 뒤 `git status --short be/`가 비었고 두 spec이 78개 통과했다.

| 변이 | 실패한 테스트 | 판정 |
| --- | --- | --- |
| M1 Host 검사 제거 | DNS rebinding: 공격자 Host로 `/api/health`·`/docs`·`/` 403 (3건, 200이 나옴) | 잡힘 3/3 |
| M2 Origin 거부 제거 | 다른 Origin GET, urlencoded POST, multipart, text/plain 녹음, 다른 Origin preflight, `GET /API/meetings`, urlencoded `POST /Api/folders` (7건). 허용 Origin preflight와 대조군은 통과 | 잡힘 |
| M3 `Sec-Fetch-Site` 분기 제거 | no-cors 오디오 cross-site·same-site 403 (2건) | 잡힘 2/2 (컨트롤러가 독립 재현) |
| M4 `enableCors()` 복원 | ACAO `*` 없음, packaged 모양, dev 모양, 헬스 프로브, dev 오디오 (5건) | 잡힘 |
| M5 접근 제어를 `useBodyParser` 뒤로 | "다른 Origin의 큰 JSON은 413이 아니라 403". F1 뒤 재실행에서는 Expected 403, Received `no-response`로 실패한다. urlencoded 파서는 `init()`에서 붙으므로 그 행은 통과(예상대로) | 잡힘 |
| M6 `isGatedPath`의 `/i` 제거 | `GET /API/meetings` 403 (1건). `POST /Api/folders` 행은 **통과** — 비-GET은 경로와 무관하게 게이트되므로 대소문자 변이를 가려내지 못한다. 가려내는 쪽은 GET 행 | 잡힘 (GET 행만 판별력 있음) |
| M7 프레임 헤더를 `next()` 앞으로 | HOST_NOT_ALLOWED·ORIGIN_NOT_ALLOWED 403에도 붙음 (2건) | 잡힘 2/2 |
| M8 (worker) `llm_guard`를 하위 클래스에 걸고 `server.APIHandler`에 대입 | `test_real_mlx_server_path_is_guarded` 실패 | 잡힘, 아래 참고 |

M8은 기대한 "403 대신 200"이 아니라 정상 요청(첫 `/health`)의 `RemoteDisconnected`로 실패했다. 가드 없는 원본 `APIHandler`가 `FakeGenerator`로 `_set_cors_headers`(`cli_args` 접근)에서 예외를 내 연결을 끊었기 때문이다. 최종 리뷰어가 `cli_args`가 있는 현실적인 generator로 재현했고, 하위 클래스 교체 시 모든 행이 200 + ACAO로 나왔다 — 테스트는 판별력이 있다. `FakeGenerator`에 `cli_args`가 없어 실패 메시지가 헷갈리는 점은 남은 것에 적었다.

### 수동 검증

- **`pnpm dev`** (be:3000 + Vite:5173)
  - curl과 Chrome에서 로드 시 모든 `/api`가 200이었다.
  - 오디오 CORS + Range fetch가 206이었다.
  - Chrome 자동화 탭이 hidden이라 `<audio>` 요소의 실제 로드는 관찰하지 못했다(fetch로만 확인).
  - curl: 오디오 no-cors의 cross-site·same-site 요청이 403이다.
- **악성 교차 origin 페이지** (`127.0.0.1:8765`)
  - `pnpm dev` 대상: 읽기와 DELETE는 막혔고, no-cors 쓰기(live·upload·form)는 행을 만들지 않았다. DB 13|0|0이 전후 같았다.
  - packaged 앱 대상: 읽기·DELETE 막힘, 행 없음(회의 8, 폴더 1, 녹음 0이 전후 같음).
- **embed rebinding** (:8101): 위조 Host·Origin이 403, node 스타일 요청은 200.
- **packaged desktop** (`cdddeaf`에서 빌드 — F2의 warn 로그와 F3의 Vary 추가 전, 둘은 동작을 바꾸지 않는다)
  - `127.0.0.1:3000`에서 curl: 같은 origin 200, Vite·악성 Origin 403, 위조 Host 403, 번들 embed의 Origin 403.
  - Electron UI: 목록·상세 로드, 오디오 재생(00:03), 즐겨찾기 DELETE/PUT 왕복.
  - UI 업로드는 파일 선택창 때문에 하지 않았다. multipart는 e2e와 같은 origin 동작으로 갈음한다.
- **데모 smoke** (`PUSH=0 release.sh smoke`, `e417455`로 이미지 빌드, :3100)
  - 컨테이너 `HOST=0.0.0.0`, `ALLOWED_HOSTS=damwha-demo.0kimjae.dev`.
  - health 200, 데모 Host+Origin GET 200, `POST /search` 201, cross-site 내비게이션 `/` 200, 공격자 Host 403, 악성 Origin 403, DELETE 403. `-v`로 스택을 내렸다.

**검증하지 않은 것.**
- 실제 브라우저에서 실시간 녹음 시작·정지.
- UI를 통한 업로드, UI를 통한 설정 저장.
- 실제 모델 job으로 도는 LLM 가드(테스트의 가짜 서버와 `mlx_lm.server` 경로 테스트까지만).

## 완료 기준 (spec §7)

| # | 기준 | 판정 | 근거 |
| --- | --- | --- | --- |
| 1 | §6 be e2e 통과, 변이에서 대응 테스트 실패 | 충족 | e2e 84개 통과. M1–M7이 잡혔고 M5는 F1 뒤 `no-response`로 다시 확인. M6의 POST 행은 대소문자를 가리지 못하나 GET 행이 가린다 |
| 2 | `enableCors()` 없음, `ACAO: *` 없음 | 충족 | M4 변이가 5건 실패, 실서버 curl·악성 페이지·데모 smoke에서 ACAO `*` 없음 |
| 3 | `HOST` 기본값 `127.0.0.1`, Docker는 `0.0.0.0` | 충족 | env 테스트, 데모 smoke 컨테이너에서 `HOST=0.0.0.0`으로 접속 확인 |
| 4 | `pnpm dev`·packaged에서 §6 수동 항목 | 충족 (조건) | 위 수동 검증. `<audio>` 로드의 Chrome 관찰과 UI 업로드·녹음·설정 저장은 하지 못했다 |
| 5 | 다른 origin 페이지의 읽기·쓰기·업로드·오디오 차단 | 충족 | 악성 페이지를 `pnpm dev`·packaged 양쪽에 대고 읽기·DELETE 차단, no-cors 쓰기 행 0 |
| 6 | embed·LLM 가드가 테스트로 고정, curl rebinding 403 | 충족 (조건) | worker 973 passed, M8 판별 확인, embed :8101 rebinding 403. 실제 모델 job은 하지 않았다 |
| 7 | 데모 compose·README, `be/.env.example`, be/CLAUDE.md, desktop/CLAUDE.md 갱신 | 충족 | `cdddeaf`·`e417455`(LAN 문서, embed 가드 문서 포함) |
| 8 | result 끝에 공유 규칙 | 충족 | 아래 단락 |

## 알아 둘 것

- **로컬 `be/.env`에 `ALLOWED_ORIGINS=http://localhost:5173`이 있어야 `pnpm dev`가 된다.** 없으면 Vite 페이지의 요청이 403이다. packaged 앱은 desktop이 정하므로 불필요하다.
- **데모 운영자는 compose를 다시 받아야 한다.** `ALLOWED_HOSTS`가 새로 생겼고, 비우면 데모 도메인의 Host가 403이다.
- **LAN에서 접속하려면** 클라이언트의 IP·이름을 `ALLOWED_HOSTS`에, 페이지 origin을 `ALLOWED_ORIGINS`에 넣어야 한다(`be/.env.example`).
- Task 11 중 4일 전의 desktop-dev 고아 프로세스(postgres, worker, embed)를 사용자 승인으로 멈췄고, Docker Desktop이 중간에 꺼져 `open -a Docker`로 다시 켰다.
- 데모 smoke가 로컬 `:latest` 이미지 태그를 덮어썼다.

## 남은 것 (최종 리뷰가 미룬 minor)

- 접근 제어 거부 로그가 100개를 넘으면 이후의 새 Origin·Host는 로그되지 않는다. 상한 테스트 이름도 오해를 부른다.
- `isSameOrigin`이 `Origin`에 userinfo·path가 붙은 값을 받아들인다(`u.origin === origin` 추가 필요). `Sec-Fetch-Site`는 정확 일치이며, 헤더가 중복된 "cross-site, same-origin"은 통과한다(브라우저가 위조할 수 없는 경우).
- `access-policy.spec`에 파서 throw 직접 테스트가 없고, 일부 `evaluateAccess` 행(게이트 밖 비-GET, OPTIONS, `localhost.`, `::ffff` Host)도 없다. 대소문자 `POST /Api/folders` 행은 판별력이 없고, 403 쓰기 시나리오가 `body.code`를 확인하지 않고, preflight의 Max-Age·Vary도 확인하지 않는다.
- 413 대조군 행이 stderr에 스택을 찍는다(원인 미확인). `main.ts`에 `enableCors`가 되돌아와도 감지되지 않는다(`main.ts`가 3줄).
- vite-config 테스트는 5173과 `ALLOWED_ORIGINS`의 어긋남을 잡지 못한다. readiness "no headers" 테스트는 init 키만 본다.
- worker: 비정규 미지정 주소 바인드(`0:0:0:0:0:0:0:0`)를 와일드카드로 보지 않는다. 빈 Origin·잘못된 포트·후행 점 행과 embed의 Host 누락·와일드카드 행이 없다. `global _bind_host`가 함수 중간에 있다. `FakeGenerator`에 `cli_args`가 없어 M8이 `RemoteDisconnected`로 실패한다. 실서버 테스트가 `APIHandler` 패치와 스레드를 남기고, `Sec-Fetch-Site`·POST 행이 없다. `install()` 멱등성은 상속된 마커에 기댄다(`_MARK in vars(cls)`가 맞다). `llm_entry` 테스트는 `bind_host` 전달을 단언하지 않는다.
- 문서: desktop/CLAUDE.md의 "다시 정한다"는 dev에서 `ALLOWED_HOSTS`를 과장한다(`be/.env`가 채울 수 있다). be/CLAUDE.md에 빈 줄 하나가 어색하다.
- speakers-management의 501 flake는 원인 미확인이다. 다시 나오면 살펴본다.

## 공유 기능이 따를 규칙

선행 조건은 `be/src/access/`의 접근 제어로 충족됐다. 공유 API(`POST /meetings/:id/share`, `…/share/preview`,
`GET`·`DELETE /meetings/:id/share`, `GET /shares`)는 `/api` 아래에 두기만 하면 별도 선언 없이 Host·Origin 검사를 받는다 —
미들웨어가 라우터보다 앞에서 모든 요청을 판정하기 때문이다(`test/access-control.e2e-spec.ts`). 지킬 것: (1) 상태를 바꾸는
공유 동작을 GET으로 만들지 않는다 — no-cors GET은 Origin 없이 오고 쓰기 보호는 POST·PUT·PATCH·DELETE의 Origin 검사에 기대므로;
(2) 공유 서비스 도메인을 `ALLOWED_ORIGINS`에 넣지 않는다 — 공유 응답(링크·키)은 같은 origin(앱)과 dev Vite에서만 읽혀야
한다; (3) 공유 라우트의 e2e 하나는 `configureHttp`로 앱을 만들어 다른 Origin의 `POST …/share`가 403이고 `meeting_share` 행이
생기지 않는지 확인한다; (4) be가 외부로 보내는 요청(공유 업로드)은 이 미들웨어와 무관하다 — 들어오는 요청만 다룬다.
