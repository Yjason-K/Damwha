# 회의 공유 링크 결과

**작성일:** 2026-10-09
**Spec:** [`specs/2026-10-09-meeting-share-selfhost-v2-design.md`](../specs/2026-10-09-meeting-share-selfhost-v2-design.md)
**Plan:** [`plans/2026-10-09-meeting-share.md`](../plans/2026-10-09-meeting-share.md)
**브랜치:** `feat/meeting-share` (`9636697`에서 시작, `main`과의 merge-base `67acdd3`)
**선행:** [`reports/2026-10-08-local-api-access-control-results.md`](2026-10-08-local-api-access-control-results.md)의 "공유 기능이 따를 규칙"

## 요약

회의 하나를 암호화된 고정 스냅샷으로 개인 서버의 공유 서버에 올리고, `/s/<id>#<key>` 링크를 가진 사람만 브라우저에서
읽게 했다. 링크는 1·7·30일 뒤 막히고, 앱에서 언제든 중지할 수 있다.

- `@damwha/contracts` — 공유 기간 목록·동의 문구 버전.
- `packages/share-format` — 페이로드 타입·가드, AES-256-GCM 봉투, 공유 id·삭제 토큰 규칙, 5MB 상한. CJS+ESM.
- `packages/share-view` — fe 미리보기와 뷰어가 함께 쓰는 렌더러. 메모 마크다운은 raw HTML 없이, http(s) 링크만, 이미지 없이 그린다.
- `share/` — Node 공유 서버(디스크 저장, 업로드·조회·삭제·같은 요청 안의 교체, IP별 제한, 일일 상한, 업로드 스위치, 개발용 만료 단축)와 정적 뷰어.
- `be/src/shares/` — 주소 검증·활성 조건·HTTP 클라이언트, REPEATABLE READ 스냅샷, 허용 목록 페이로드 빌더, 예약→업로드→확정 흐름, 스위퍼, 회의 삭제 연동. 마이그레이션 032, GET 라우트 스냅샷 테스트.
- `fe/src/features/share/` — API 훅, 공유 다이얼로그, 헤더 버튼, 설정 "공유한 링크", 회의 삭제 안내.
- `deploy/share/`(Dockerfile·compose·Tunnel 안내), `deploy/api.Dockerfile`, desktop env·패키징, 데모 덤프 제외, 제품 사이트 문구, 문서.

## 커밋 (`git log --oneline 9636697..HEAD`, 결과 문서 커밋 제외)

```
34ffc9b test(access): 다른 Origin의 공유 만들기 검사가 실제로 판별하게 한다
2b89981 fix(share): 철회 재시도 간격 비교에 30초 여유 — 5분 틱이 한 번씩 건너뛰지 않게
125dc20 fix(share): 빈 메모는 페이로드에 싣지 않고, 뷰어도 빈 메모 섹션을 그리지 않는다
fdd3c7c fix(share): 회의 삭제·공유 중지가 회의 행을 먼저 잠근다
0c38acc fix(share): 요청이 나가지 못한 업로드는 예약을 지우고, 철회 대기 중에도 새 링크를 연다
791a0fd fix(site): 공유 FAQ의 키 문구를 spec §2.3 표현으로 맞춘다
6fec936 fix(deploy): 공유 볼륨 이름을 damwha_share_data로 고정 (spec §2.8), README 백업 안내도 같은 이름
089b9e6 docs: 공유 링크 — 모노레포 지도, 불변식, 공유 서버 안내
176f593 feat(site): 공유 링크를 프라이버시 문구와 FAQ에 반영한다
35628a3 build: 공유 서버 Docker 이미지·compose·Tunnel 안내, API 이미지·desktop 패키징에 공유 패키지, 데모 덤프에서 공유 데이터 제외
e1833fe feat(fe): 설정의 공유한 링크, 회의 삭제 시 공유 중지 안내
59c090e feat(fe): 공유 다이얼로그 — 범위·실제 페이로드 미리보기·동의, 헤더 공유 버튼
c77a341 feat(fe): 공유 API 훅과 share 사전 — 꺼진 실행(404)은 disabled
6d560ad test(be): GET 라우트 스냅샷과 공유 라우트의 접근 제어 시나리오
4f05c01 feat(be): 공유 스위퍼와 회의 삭제 시 링크 철회 — 오프라인이면 대기열로
d4867f9 feat(be): 공유 API — 예약·스냅샷·업로드·확정, 교체·중지·목록, 꺼진 실행은 404
04322fa feat(be): 공유 스냅샷(REPEATABLE READ)과 허용 목록 페이로드 빌더
5c876a2 feat(be): 공유 서비스 주소 검증·활성 조건·HTTP 클라이언트
86ecedc feat(be): meeting_share 마이그레이션 — 회의를 지워도 철회할 수 있게 SET NULL
1cb7fa0 feat(share): 공유 뷰어 — 브라우저에서 복호화, 만료 시각은 서버 헤더, 같은 서버가 정적 서빙
d3c90da fix(share-view): 색을 fe/src/index.css 토큰 값으로 — 링크·시각은 민트, 배경은 무채색
88bac92 feat(share-view): 공유본 렌더러 — fe 미리보기와 뷰어가 같은 컴포넌트를 쓴다
e31dc83 feat(share): IP별 요청 제한(삭제 분리)·정확한 일일 상한·업로드 차단·개발용 만료 단축
e9b6d21 chore(share): typescript를 레포와 같은 5.9로 맞춘다
cde9c16 feat(share): 공유 서버 — 디스크 저장, 업로드·조회·삭제·원자적 교체, 보안 헤더
33f4b30 feat(share-format): 공유 페이로드와 AES-GCM 봉투
db221c4 feat(contracts): 공유 기간 목록과 동의 문구 버전
```

진행 방식: 작업마다 새 서브에이전트가 TDD(실패 확인 → 구현 → 통과)와 plan의 변이 확인을 밟아 구현하고, 다른 서브에이전트가
spec 준수·품질을 검토했다. 검토 단계마다 테스트 명령을 직접 다시 돌렸다. 마지막에 브랜치 전체를 한 번 더 검토하고 지적을
한 번의 수정 파동으로 고쳤다(`0c38acc..34ffc9b`).

## 검증 — Task 19 Step 1 (최종 수정 뒤 `34ffc9b`에서 다시 실행)

| 명령 | 결과 |
| --- | --- |
| `pnpm --filter @damwha/contracts test` | 6/6 |
| `pnpm --filter @damwha/share-format test` | 15/15 (CJS·ESM import 포함) |
| `pnpm --filter @damwha/share-view test` | 11/11 |
| `pnpm share:test` / `pnpm share typecheck` | 서버 48/48 + 뷰어 7/7 / 통과 |
| `pnpm --filter damwha-be exec jest --runInBand` | 71 suites, 894/894. 첫 실행은 893/894 — `saved-utterances` "far past any id-list cap" 1건 실패. 이 브랜치가 건드리지 않은 테스트이고 단독 2회 통과, 전체 재실행 894/894 통과(부하 flake) |
| `pnpm fe test` / `pnpm fe build` / `pnpm fe lint` | 865/865 / 통과 / 오류 0, 경고 1(이 브랜치 밖의 기존 경고) |
| `pnpm --filter damwha-desktop exec vitest run` | 74 files, 1249/1249 |
| `pnpm --filter damwha-site run test` / `pnpm site:build` | 30/30 / 3 pages |

이 밖에 Task 16에서 사용자 승인을 받아 돌린 이미지·덤프 확인:

- API 이미지(`deploy/api.Dockerfile`): `/api/health` 200, `/api/shares` 404(`HOST=0.0.0.0`이라 공유 꺼짐), 컨테이너 안 `require('@damwha/share-format')` 성공.
- 공유 서버 이미지(`deploy/share`): 빈 새 볼륨에서 `/healthz` `{"ok":true}`, 업로드 → 재시작 → 조회 200, `/s/<id>` 200, `/data/shares` 파일 2개, uid 1000(node)로 실행. compose 볼륨 이름은 `docker compose config`로 `damwha_share_data` 확인.
- 데모 덤프: 탐침 행을 넣고 `--exclude-table-data=meeting_share`로 덤프 → `pg_restore --data-only -t meeting_share | grep -c PROBE` = 0(대조: 플래그 없이 1). 탐침 행은 지웠다. 이 과정에서 개발 DB에 마이그레이션 032가 적용됐다.

## 개발 환경 연계 시나리오 — Task 19 Step 2·3

`791a0fd`(최종 수정 파동 전)에서 실행했다. 사용자 `.env`는 고치지 않고 프로세스 env로 넘겼다(`SHARE_API_URL=http://localhost:8787`
등). 사용자의 실제 회의 13개는 건드리지 않고 합성 회의 `[share-e2e] …`를 만들어 썼고, 끝난 뒤 합성 회의·화자·`meeting_share`
행·`share/.data`·컨테이너를 모두 지웠다(`meeting_share` 0행, 회의 13개 그대로 확인). 무관한 vite가 5173을 쓰고 있어 fe는 5174로
띄웠다(`ALLOWED_ORIGINS=http://localhost:5174`).

| # | 시나리오 | 결과 |
| --- | --- | --- |
| 1 | 공유 → 다른 탭에서 열람 | **PASS.** 요약·할 일만 보이고 발화·메모 없음. 하단 만료 "2026년 10월 16일 오후 10:10" = 서버 `expires_at` 13:10:11Z. `grep -ac '주간' *.bin` = 0. 시크릿 창 대신 별도 탭(origin이 달라 저장소 공유 없음) |
| 2 | 같은 회의에서 새 링크 | **PASS.** 기존 행 `revoked`, 기존 링크 410·"이 공유는 만료되었거나 중지되었어요.", 새 링크 열림, `.json` 하나 |
| 3 | 공유 중지 | **PASS.** 서버 `DELETE 204`, 링크 410, 행 `revoked`·키/토큰 NULL, 설정 목록에서 사라짐 |
| 4 | share 서버를 끈 채 회의 삭제 → 다시 켜고 재시도 | **PASS.** 삭제 다이얼로그에 "이 회의의 공유 링크도 중지돼요.", 토스트 "인터넷에 연결되어 있지 않아요… 늦어도 10월 16일 오후 10:11에는 막혀요.", 목록 "삭제된 회의 / 중지 대기 중", 재시도 후 `revoked`·링크 410. 재시도는 5분 백오프가 지난 뒤 be 재시작으로 앞당겼다 |
| 5 | `DEV_EXPIRY_SECONDS=60` → 1분 뒤 | **PASS.** 링크 410, 공유 버튼 "공유"로 복귀, 스위퍼 뒤 행 `expired`·키/토큰 NULL, 공유 서버 파일은 만료 약 9분 뒤 삭제 |
| 6 | `UPLOADS_ENABLED=false` | **PASS.** "공유 서버가 지금 바빠요. 잠시 후 다시 시도해 주세요."(en도 확인), 기존 링크 열람 200 |
| 7 | 공유 서버 재시작 | **PASS.** 재시작 전후 모두 200, 파일 유지 |
| 8 | 5MB 넘는 페이로드(무작위 16,000,037자, 3시간) | **PASS.** "공유할 내용이 너무 커요…", be 413(봉투 8,719,573바이트), 공유 서버에 POST 없음, 행 없음 |
| 9 | 화면 언어 English | **PASS(부분 모사).** 다이얼로그·헤더·뷰어 영어. 뷰어의 영어 브라우저는 `navigator.languages` 덮어쓰기로 모사했고 실제 영어 Chrome 프로필은 미확인 |
| 10 | be `HOST=0.0.0.0` | **PASS.** 공유 라우트 전부 404, 공유 버튼·"공유한 링크" 섹션 없음. 되돌림 |
| Step 3 | Docker 이미지로 1·2·3 | **PASS.** production 7일 만료, `.bin`에 평문 없음, 교체 뒤 기존 링크 410, 목록에서 중지 |

최종 수정 파동(`0c38acc..34ffc9b`)은 위 시나리오 뒤에 들어갔다. 그 변경(연결 자체가 안 된 업로드, 회의 잠금 순서, 빈 메모,
재시도 여유, 접근 제어 테스트)은 e2e·단위 테스트로 확인했고 시나리오를 다시 돌리지는 않았다.

## 패키징된 앱 — Task 19 Step 4: **미확인**

사용자와 확인해 이번에는 하지 않았다. spec §3이 패키징된 앱의 공유 성공을 "배포 후 확인"(Tunnel 연결 뒤)에 두고, 연결 전에는
"인터넷에 연결해야 공유할 수 있어요"로 끝나는 것이 정상이라 지금 패키징해도 성공 판정을 할 수 없기 때문이다. 대신:

- packaged 모드에서 상속·설정 `SHARE_API_URL`을 지우는 것은 desktop 단위 테스트가 지킨다(`tests/services/api-process.test.ts`, 변이 확인 포함).
- be가 `@damwha/share-format`을 `require`하는 것은 API Docker 이미지에서 확인했다. 패키징된 앱 안의 `require`는 미확인.
- 연결 전 공유 실패가 "중지 대기 중"으로 남지 않고 예약이 지워지는 것은 최종 수정(`0c38acc`)의 e2e가 지킨다.

## 연결 후 확인 — Task 19 Step 5: **미확인**

공유 서버 컨테이너와 Cloudflare Tunnel(`damwha-share.0kimjae.dev`)이 아직 연결되지 않았다. 실제 도메인·TLS·응답 헤더,
`CF-Connecting-IP` 기준 요청 제한(분당 120회 초과 시 429), 다른 기기 열람 → 새 링크 → 중지 → 410, 서버 스위퍼의 물리 삭제는
연결 뒤에 확인한다.

## spec §1 성공 기준별 판정

| 기준 | 판정 | 근거 |
| --- | --- | --- |
| 회의 화면에서 시작, 링크 `https://<share>/s/<id>#<key>` 하나 | 충족 | 시나리오 1, `toView` url. 운영 도메인은 미연결 |
| 서버는 암호문만, 키는 `#` 뒤에만 | 충족 | `.bin`에 평문 없음(S1, Step 3), 키는 로컬 `share_key`에만, 서버 로그·be 로그/오류에 키·토큰 없음(테스트) |
| 기간 1/7/30일, 무제한 없음 | 충족 | `SHARE_DURATION_DAYS`, `SHARE_ID_RE`, 다이얼로그 선택지 |
| 만료 시각에 즉시 막힘, 서버 기록은 그 뒤 한 시간 안에 삭제 | 충족(개발 환경) | S5: 만료 직후 410, 파일은 약 9분 뒤 삭제. 운영 서버는 미확인 |
| 만든 순간의 스냅샷 | 충족 | REPEATABLE READ 스냅샷, 재처리 커밋이 끼어도 한 버전만(테스트) |
| 회의당 활성 링크 1개, 새 링크는 같은 요청에서 기존 삭제 | 충족 | S2·Step 3, 교체 테스트, 동시 공유 409 e2e |
| 동의 체크, 발화 기록이면 책임 확인 추가 | 충족 | 다이얼로그 테스트, be `CONSENT_REQUIRED` 400 |
| 언제든 중지, 오프라인이면 보관했다가 연결되면 보냄 | 충족 | S3, S4, 재시도 e2e |
| 회의 삭제 시 공유 철회, 오프라인이어도 삭제는 막지 않음 | 충족 | S4, lifecycle e2e, 삭제·확정 경합 e2e(`fdd3c7c`) |
| 최악의 경우에도 최대 30일에 막힘 | 충족 | 서버가 만료 권위, 로컬 행도 `created_at + duration_days`로 만료 |
| 공유 서버가 꺼져 있으면 열리지 않고 철회는 쌓였다가 처리 | 충족 | S4 |
| 앱(loopback)에서만, Docker·데모에서는 공유 라우트 없음 | 충족 | S10, API 이미지 `/api/shares` 404, 비활성 e2e |
| 개발 환경에서 끝에서 끝까지 연계 확인 | 충족 | 시나리오 1–10, Step 3 |
| 패키징된 앱에서 공유 동작 | 미확인 | Step 4 보류(위) |
| 운영 도메인·Tunnel 연결 후 동작 | 미확인 | Step 5 |

## plan에서 벗어난 것과 그 이유

**사전 판정(구현 전 계획 점검에서 나온 것):**

- share-format의 상대 import에 `.js` 확장자 — 없으면 Node ESM이 `dist/esm`을 못 읽는다.
- fe 테스트 명령을 `pnpm --filter damwha-fe exec vitest run …`으로 — plan의 `pnpm fe vitest run`은 테스트 없이 0으로 끝난다.
- `shareErrorKey`를 문자열 리터럴 유니온으로 — typed `t()`가 `string`을 받지 않아 빌드가 깨진다.
- `DiskStore.sweep`이 이미 지워진 쌍(ENOENT)을 견딘다 — readdir 순서에 따라 흔들렸다.
- 변이가 빨개질 수 없던 테스트 픽스처를 고쳤다(Task 5 메모 제목, Task 8 `replaced`, Task 9 침묵 발화 본문).
- Task 9 스냅샷 테스트에 "재처리 커밋이 끼어도 한 버전만"을 추가 — spec §3 기준이 plan 테스트에 없었다.
- Task 10 storeThenDrop은 경합하는 `objects.size` 대신 서버가 받은 POST→DELETE를 기다린다. Task 15 중지 단언은 `waitFor`, 토스트 테스트는 `<Toaster />`.
- 미리보기 기본 기간은 `DEFAULT_SHARE_DURATION_DAYS`, 미리보기 실패는 `dialog.previewFailed`.

**구현 중:**

- `share/`의 TypeScript가 7.0.2로 설치돼 레포와 같은 `^5.9.3`으로 고정했다.
- 확정 트랜잭션이 업로드 성공 뒤 실패하면 plan 코드는 `creating` 행을 지워 유일한 삭제 토큰을 잃었다 → `revoke_pending`으로 돌려 철회한다(Task 10).
- 결과를 모르는 업로드의 행은 `expires_at`이 NULL이라 영원히 만료되지 않았다 → `created_at + duration_days`로 채운다. 스위퍼·재시도 로그는 오류 이름만 남긴다(Task 11).
- share-view 색은 plan의 하드코딩 hex(파란 링크) 대신 `fe/src/index.css` 토큰 값(민트 신호, 무채색 바탕)을 옮겼다 — spec §2.5 "디자인 토큰은 fe/DESIGN.md".
- GET 라우트 목록은 plan이 센 22+2가 아니라 라우터에서 모은 21개다.
- lint 때문에 다이얼로그 상태 초기화를 effect가 아니라 `DialogContent` 언마운트로, 고지 날짜의 `Date.now()`를 lazy state로 바꿨다.
- 공유 데이터 볼륨은 plan의 compose 문구대로면 `damwha-share_share_data`가 되어 spec §2.8의 `damwha_share_data`로 이름을 고정했다.
- 사이트 FAQ의 "서버는 키를 갖지 않아요"를 spec §2.3 문구 "서버에는 암호문만 저장되고 키는 저장하지 않아요"로 바꿨다(과장 금지).

**최종 리뷰 뒤:**

- **"분명히 만들지 않음"의 범위를 넓혔다.** spec §2.7 3단계는 4xx만 "만들지 않음"으로 본다. 연결 자체가 안 된 경우(ENOTFOUND·EAI_AGAIN·ECONNREFUSED — 요청 바이트가 나가지 않음)도 "만들지 않음"으로 보고 예약을 지운다. 그대로 두면 Tunnel 연결 전이나 오프라인에서 공유를 시도한 회의가 받은 적도 없는 링크로 "중지 대기 중"에 묶이고 새 공유가 막혔다. 타임아웃·연결 끊김·5xx·3xx는 여전히 결과 불명(철회 대기열)이다.
- 철회 대기 화면에 "새 링크 만들기"를 더했다(be는 원래 `revoke_pending`이 있어도 새 예약을 받는다).
- 리뷰어가 제안한 "한 번도 active가 아니었던 행을 숨기는 컬럼"(마이그레이션 032 수정)은 DB 스키마 변경이라 하지 않았다. 남는 경우(타임아웃 등 결과 불명)는 서버에 객체가 있을 수 있어 "중지 대기 중" 표시가 사실과 맞고, 위 버튼으로 새 공유도 막히지 않는다.
- 회의 삭제·공유 중지가 회의 행을 먼저 잠근다 — 확정과 겹치면 회의 없는 `active` 링크가 남던 경합을 막는다.
- 빈 메모를 싣지도 그리지도 않는다. 철회 재시도 비교에 30초 여유를 둔다. 접근 제어 e2e가 유효한 본문으로 행 수까지 판별한다.

## 알려진 작은 남은 것 (이번에 고치지 않음)

- 결과 불명(타임아웃·5xx) 업로드는 "중지 대기 중"을 보인다 — 철회되면 사라진다.
- `UPLOADS_DISABLED`·`DAILY_CAP` 503도 결과 불명으로 분류돼 시도마다 `revoked` 행이 하나씩 남는다(목록에는 안 보임).
- 클립보드 쓰기 실패에 안내가 없다. 설정 목록 행의 버튼 aria-label이 회의 이름을 담지 않는다.
- 사이트 FAQ는 받는 사람의 브라우저(확장 기능 포함)가 평문을 본다는 점을 적지 않는다(다이얼로그 고지에는 있다).
- English 화면에서도 좌측 내비·설정 제목 일부가 한국어다(공유 범위 밖의 기존 하드코딩).
- ENOTFOUND 클라이언트 테스트는 실제 DNS를 조회한다 — 느린 리졸버에서 흔들릴 수 있다(같은 판정은 단위 테스트가 지킨다).

## 남은 것 (spec §4 미결)

- **요청 제한·일일 상한 수치 확정.** 지금 기본값: IP별 분당 업로드 10·조회 120·삭제 30, 하루 업로드 500건·500MB(env로 바꿈, 메모리 카운터라 재시작하면 0부터).
- **Tunnel 연결 후 확인.** 개인 서버에 `deploy/share`를 띄우고 `damwha-share.0kimjae.dev`를 연결한 뒤 Step 4(패키징된 앱)·Step 5를 한다.
- **법률 검토.** 개인정보처리방침과 다이얼로그·사이트 고지 문구는 초안이다.
