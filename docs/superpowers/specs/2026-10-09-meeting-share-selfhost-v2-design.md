# 회의 공유 링크 설계

**작성일:** 2026-10-09
**선행:** `dev` @ `d34ef46` (PR #58 로컬 API 접근 제어 병합). 결과 문서
`reports/2026-10-08-local-api-access-control-results.md` 끝의 "공유 기능이 따를 규칙" 네 가지를 따른다.
**대체:** `2026-10-09-meeting-share-selfhost-design.md` 전체(그것이 대체한 `2026-10-09-meeting-share-design.md` 포함).
selfhost판에서 바뀐 것 — Codex 후속 리뷰와 그에 대한 결정(2026-10-09):
- **공유 id와 삭제 토큰은 be가 만들어** 업로드 전에 `creating` 행에 저장하고 업로드 헤더로 보낸다(§2.4·§2.7). 응답이
  유실되거나 확정이 실패해도 be가 그 토큰으로 서버 객체를 지울 수 있어 **주인 없는 객체가 서버에 남지 않는다.**
  같은 id·토큰으로 다시 올리면 서버는 같은 결과를 돌려준다(멱등).
- **교체의 보장 범위:** 업로드가 서버에 닿지 않았으면 기존 링크는 그대로다. 응답 유실·확정 실패 같은 드문 경우에는
  기존 링크가 새 링크보다 **먼저 막힐 수 있다** — 실패는 늘 "닫히는 쪽"이고 내용이 새는 쪽이 아니다. 서버는 같은
  기존 링크에 대한 교체를 하나씩만 처리한다.
- **업로드 중 중지:** 새 링크 생성은 취소되지 않는다. 중지는 그 링크에 대한 동작이고, 새 링크는 사용자가 명시적으로
  요청한 것이다(§2.7).
- **IP 신뢰 경계:** 공유 서버 호스트의 로컬 프로세스는 신뢰 경계 안이다(§2.4).

Worker판에서 바뀐 것:
- 공유 서비스를 Cloudflare Worker·R2가 아니라 **개인 서버의 Docker 컨테이너**(Node 22, 디스크 파일)로 띄우고,
  공개는 사용자가 직접 연결하는 **Cloudflare Tunnel**로 한다(§2.4). 주소는 `https://damwha-share.0kimjae.dev`.
- 새 링크를 만들면 기존 링크는 **같은 요청 안에서** 서버가 지운다 — 기존 링크는 즉시 "만료되었거나 중지되었어요"가 된다(§2.4 교체).
- 만료 시각의 권위는 **공유 서버**다. 페이로드에서 `expires_at`을 빼고, 뷰어는 서버 응답 헤더로 받는다(§2.2·§2.5).
- Codex 계획 리뷰 반영: GET이 상태를 바꾸지 않는다(§2.7), 근거 이동 링크는 실제로 공유된 발화일 때만(§2.1),
  미리보기가 성공해야 공유할 수 있다(§2.6), 철회 DELETE는 조회 제한과 분리한다(§2.4).
제품 사이트의 프라이버시 문구는 이 기능에 맞춰 고친다(§2.9).
**범위:** 회의 하나를 암호화된 고정 스냅샷으로 올리고, 링크를 가진 사람만 브라우저에서 읽게 한다. 새 패키지
`share/`(Node 공유 서버 + 정적 뷰어)와 `packages/share-format`, `packages/share-view`, `be`의 공유 모듈, `fe`의 공유 UI,
`@damwha/contracts`의 기간 목록, 마이그레이션 032, `deploy/share/`(Dockerfile·compose), Docker·desktop 패키징 수정,
루트 스크립트 `share:dev`를 더한다.
**리뷰:** Codex(gpt-6-sol) spec 리뷰·계획 리뷰, 선행 작업 독립 검증 반영.

## 1. 목표와 성공 기준

회의 기록을 앱 밖의 사람에게 보여 주되, 서버에는 암호문만 남고 기간이 지나면 남지 않게 한다.

- 공유는 회의 화면에서 시작한다. 링크는 `https://<share 도메인>/s/<id>#<key>` 하나다.
- 서버는 암호문만 받는다. 복호화 키는 URL `#` 뒤에만 있고 서버·레포·env에 저장되지 않는다.
- 기간은 **1일 / 7일(기본) / 30일** 중 고른다. 무제한은 없다.
- 만료 시각이 되면 **링크가 즉시 막힌다.** 서버 기록은 그 뒤 한 시간 안에 물리 삭제된다(서버가 켜져 있을 때, §2.4).
- 공유본은 만든 순간의 스냅샷이다. 이후 회의를 고쳐도 반영되지 않는다.
- 회의당 활성 링크는 1개다. 새 링크를 만들면 기존 링크는 **같은 요청에서** 서버에서 지워지고 바로 막힌다.
- 모든 공유는 사용자가 직접 체크한 동의를 거친다. 발화 기록을 포함하면 책임 확인 체크가 하나 더 붙는다.
- 사용자는 언제든 공유를 중지할 수 있다. 오프라인이면 중지 요청을 보관했다가 연결되면 보낸다.
- 회의를 지우면 그 회의의 공유도 철회된다. 오프라인이어도 회의 삭제는 막지 않는다.
- 최악의 경우(앱을 지웠거나 다시 연결하지 않음)에도 링크는 최대 30일에 막히고 서버 기록은 그 뒤 곧 사라진다.
- 공유 서버가 꺼져 있으면 링크가 열리지 않는다. 철회 요청은 앱에 쌓였다가 서버가 다시 켜지면 처리된다.
- 공유는 앱(be가 loopback에 바인드된 상태)에서만 된다. Docker 셀프호스팅과 데모에서는 공유 라우트가 없다.
- 앱 API와 공유 서비스를 둘 다 로컬에 띄워 개발 환경에서 끝에서 끝까지 연계를 확인할 수 있다.

## 2. 설계

### 2.1 공유 범위

| 항목 | 기본 | 비고 |
| --- | --- | --- |
| 요약 (`meeting_summary`) | 포함 | 현재 `processing_version`이고 `status='done'`일 때만 고를 수 있다. |
| 렌즈 (`lens_item`, `lifecycle_status='active'`) | 포함 | kind, text, 완료 여부, 기한, 담당자. `source`·`user_modified`는 넣지 않는다. |
| 발화 기록 (현재 버전 `utterance`, `status='ok'`) | 제외 | 켜면 §2.6의 책임 확인 체크가 추가로 필요하다. |
| 메모 (`meeting_note`) | 제외 | |
| 오디오 | **항상 제외** | 고를 수 없다. |
| 성문·임베딩, 저장한 발화, 태그·폴더, 즐겨찾기, 최근 본 회의, '나' 표시 | **항상 제외** | |

- 페이로드는 DB 행을 직렬화하지 않고 허용 목록으로 새로 만든다(§2.2). 위 표에 없는 필드는 나갈 수 없다.

**화자 이름 익명화** 토글(기본 끔)을 둔다. 켜면 구조화된 화자 이름 — 발화 기록의 화자, 렌즈 담당자 — 을
`화자 1`, `화자 2`로 바꾼다. **요약 bullet·렌즈 문장·메모 본문 같은 자유 텍스트 안의 이름은 바꾸지 않는다.**
LLM이 쓴 문장 속 이름을 안전하게 찾아 바꿀 방법이 없기 때문이다. 다이얼로그는 이 한계를 토글 바로 아래에
적는다: "요약·할 일 문장 안에 적힌 이름은 그대로 남아요. 미리보기에서 확인해 주세요."

**항목 간 참조 규칙.** 요약 세그먼트는 `start_utterance_id`/`end_utterance_id`를, 렌즈는 `lens_evidence`로 근거
발화를 가리킨다. 공유본에는 **내부 id를 넣지 않는다.**

- 요약 세그먼트는 `start_ms`/`end_ms`만 남긴다. 세그먼트는 현재 버전 요약에서 나오므로 현재 발화와 시각이 맞는다.
- 렌즈 근거는 마이그레이션 013 이후 **예전 `processing_version`의 발화를 가리킬 수 있다**(재처리해도 근거를 보존한다).
  그래서 primary 근거 발화가 **공유본의 발화 기록에 실제로 들어가는 발화**(현재 버전, `status='ok'`, 본문 있음)일
  때만 `linkable: true`다. 아니면(예전 버전, silence·전사 실패, 빈 본문) `start_ms`만 넣고 `linkable: false` — 뷰어는
  시각을 글자로만 보여 주고 발화 목록으로 스크롤하지 않는다.
- 발화 기록을 포함하지 않았으면 모든 시각은 글자로만 보인다.
- 근거 발화의 원문 인용은 넣지 않는다. 발화 기록을 빼고 공유했는데 인용으로 원문이 새는 일을 막는다.

### 2.2 페이로드 v1 (`packages/share-format`)

```ts
type SharePayloadV1 = {
  v: 1;
  created_at: string;          // ISO. 만료 시각은 페이로드에 없다 — 서버가 정하고 뷰어는 응답 헤더로 받는다(§2.5)
  ui_language: UiLanguage;     // 공유한 사람의 UI 언어 (뷰어 기본값 후보)
  meeting: { title: string | null; recorded_at: string; duration_ms: number | null };
  speakers: { ref: string; name: string | null }[];  // ref = "s1"…; 익명화면 name=null
  summary?: { topics: string[]; segments: { title: string; bullets: string[]; start_ms: number; end_ms: number }[] };
  lenses?: { kind: 'action' | 'decision' | 'promise'; text: string; done: boolean; due_at: string | null;
             assignee_ref: string | null; start_ms: number | null; linkable: boolean }[];
  transcript?: { speaker_ref: string | null; start_ms: number; end_ms: number; text: string }[];
  note?: { body_md: string };
};
```

- `speakers`에는 공유본에 실제로 나오는 화자만 넣는다.
- 이 패키지는 타입, 형태 가드(`isSharePayloadV1`), `encryptShare`/`decryptShare`, 포맷 버전, 공유 id 규칙, 봉투 상한을
  가진다. be(암호화)·공유 서버(id·상한)·뷰어(복호화)가 같은 포맷을 써야 하므로 한 곳에 둔다. **CJS와 ESM을 둘 다 내고
  `prepare`로 빌드한다**(CLAUDE.md의 `vite dev` 함정). zod는 쓰지 않는다 — 요청 검증은 be의 zod가 하고, 뷰어가 받는
  페이로드는 GCM이 출처를 보장하므로 버전과 큰 모양만 본다.
- 공유 기간 목록 `SHARE_DURATION_DAYS = [1, 7, 30]`과 기본값 7은 be·fe가 함께 쓰므로 `@damwha/contracts`에 둔다.

### 2.3 암호화와 신뢰 경계

- 공유할 때마다 be가 WebCrypto(`globalThis.crypto.subtle`, Node 22)로 **AES-256-GCM 키를 새로 만든다.**
  공용 키·env 키는 없다.
- 평문 = `gzip(JSON.stringify(payload))`(`CompressionStream`). 봉투 = `[포맷 버전 1바이트][IV 12바이트][암호문+태그]`.
- 키는 base64url로 URL `#` 뒤에 넣는다. 브라우저는 `#` 뒤를 서버로 보내지 않는다.
- 키는 로컬 DB(`meeting_share.share_key`)에 보관한다. "링크 복사"를 다시 할 수 있어야 하고, 회의 원본과 같은
  Mac 안에 있으므로 신뢰 범위가 같다. 공유가 끝나면(중지·만료) 키를 지운다.

**신뢰 경계.** 복호화하는 뷰어 코드를 같은 서버가 내려준다. 서버나 배포 계정이 침해돼 뷰어가 바뀌면 그 뒤에
열리는 링크의 키와 평문을 빼낼 수 있다 — 웹 기반 종단간 암호화의 공통 한계다. 그래서 **"우리도 읽을 수 없다"는
쓰지 않고**, "서버에는 암호문만 저장되고 키는 저장하지 않아요"라고만 말한다. 링크를 받은 사람과 그 브라우저(확장
기능 포함)는 평문을 본다는 점도 고지에 들어간다(§2.6).

### 2.4 공유 서버 (`share/`, `deploy/share/`)

개인 서버에서 Docker 컨테이너 하나로 돈다. Node 22 프로세스 하나가 API와 정적 뷰어를 같이 서빙한다. 공개는
사용자가 직접 설정하는 Cloudflare Tunnel(`cloudflared`)이 `https://damwha-share.0kimjae.dev` → 컨테이너 포트로 잇는다.

**저장.** 데이터 디렉터리(`DATA_DIR`, 컨테이너 `/data`, 볼륨)에 공유본 하나당 파일 둘:
`shares/<id>.bin`(봉투)과 `shares/<id>.json`(`expires_at`, `token_hash`, `size`, `created_at`). 임시 파일에 쓰고 rename해
반쯤 쓴 파일이 보이지 않게 한다. 파일 이름은 `SHARE_ID_RE`를 통과한 id만 쓴다(경로 탈출 차단).

| 요청 | 동작 |
| --- | --- |
| `POST /api/shares` (본문: 봉투, 헤더: `X-Share-Days`, `X-Share-Id`, `X-Delete-Token`) | id·토큰은 **be가 만든다**(id = `<기간>-<128비트 base64url>`, 기간이 `X-Share-Days`와 같아야 함; 토큰 = 32바이트 base64url). 본문을 읽으면서 5MB 상한을 강제한다(넘으면 즉시 413). 저장하고 `201 { id, expires_at, replaced }`. 삭제 토큰은 SHA-256 해시만 저장한다. 같은 id가 이미 있고 토큰 해시가 같으면 **아무것도 바꾸지 않고** `200`으로 같은 `{ id, expires_at, replaced: false }`(재시도 멱등), 토큰이 다르면 `409 ID_TAKEN`. |
| 위 요청 + `X-Replace-Id`·`X-Replace-Token` | **교체.** 기존 공유의 토큰이 맞는지 먼저 확인하고(틀리면 403, 아무것도 만들지 않음), 새 공유를 저장한 뒤 기존 공유를 지운다. 기존 공유가 이미 없으면 그냥 새로 만든다. 응답에 `replaced: true/false`. 같은 기존 id에 대한 교체가 이미 진행 중이면 `409 REPLACE_IN_PROGRESS`(서버가 id별로 직렬화). 서버 안에서 파일 삭제가 중간에 실패하면 새 공유는 되돌리고 500 — 이때 기존 링크도 이미 막혔을 수 있다(닫히는 쪽 실패). |
| `GET /api/shares/:id` | `expires_at`이 지났거나 없으면 `410`. 아니면 봉투와 헤더 `X-Share-Expires-At`. |
| `DELETE /api/shares/:id` (`Authorization: Bearer <delete_token>`) | 해시가 맞으면 삭제 `204`. 없으면 `404` — 클라이언트는 성공으로 본다. 틀리면 `403`. |
| `GET /s/:id` | 뷰어 `index.html`. `GET /assets/<파일>` — 뷰어 번들. |
| `GET /healthz` | `200` (컨테이너 헬스체크). |

- **만료.** 정확한 차단은 읽을 때의 `expires_at` 검사가 맡는다. 물리 삭제는 서버 안의 스위퍼가 기동 시와 10분마다
  만료된 파일 쌍을 지운다. 고지는 "링크는 <날짜>에 막히고 서버 기록은 그 뒤 한 시간 안에 삭제돼요"로 쓴다.
  서버가 꺼져 있던 동안 만료된 공유는 다시 켜질 때 지워진다(그동안에도 열람은 막힌다 — 꺼져 있으니까).
- **만료 시각의 권위는 서버다.** be는 서버가 돌려준 `expires_at`만 저장·표시한다. 동의 문구와 미리보기의 날짜는
  "지금 + 기간"의 예상값이고, 실제 값과는 업로드 지연만큼(초 단위) 다를 수 있다.
- **클라이언트 IP.** 컨테이너 포트는 호스트의 `127.0.0.1`에만 연다(또는 `cloudflared`와 같은 Docker 네트워크에만 둔다).
  그래서 들어오는 요청은 모두 Tunnel을 거치고, Tunnel이 붙이는 `CF-Connecting-IP`를 클라이언트 IP로 믿을 수 있다.
  다른 경로로 포트가 열리면 이 헤더를 누구나 위조할 수 있으므로, 포트를 바깥에 열지 않는 것이 이 설계의 전제다.
  호스트 안의 로컬 프로세스(`127.0.0.1:8787` 직접 접근)는 신뢰 경계 안으로 본다 — 헤더를 위조해 얻는 것은 요청 제한
  우회뿐이고, 그 프로세스는 이미 서버 디스크에 닿는다.
- **남용 방지.** 앱 바이너리에 업로드용 비밀을 넣지 않는다. 대신 프로세스 안에서:
  - IP별 요청 제한 — 업로드·조회·**삭제를 각각 따로** 센다(조회가 많아도 "지금 중지"가 막히지 않는다).
  - 서비스 전체 일일 업로드 상한(객체 수·바이트). 프로세스 하나라 정확하게 센다. 넘으면 `503`과 "잠시 후 다시".
    카운터는 메모리에 있어 재시작하면 0부터 다시 센다 — 문서에 적는다.
  - 업로드만 끄는 env 스위치(`UPLOADS_ENABLED=false`) — 조회·삭제는 그대로.
- **헤더.** 모든 응답에 `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, 엄격한 CSP. CORS 헤더는 내지 않는다(뷰어는 같은 origin이고 be는 서버 간 호출).
- **로그.** 요청 로그에는 메서드·경로의 id·상태 코드만. 본문·`Authorization`·교체 토큰은 남기지 않는다.
- **백업.** 데이터 볼륨은 서버 백업에서 뺀다 — 백업에 남으면 만료 삭제 약속이 깨진다. 운영 문서에 적는다.
- 레포에 비밀이 없다. Tunnel 자격 증명은 사용자의 서버에만 있다.

**로컬 실행.** 같은 서버를 개발 머신에서 `pnpm share:dev`로 `http://localhost:8787`에 띄운다(데이터는 `share/.data/`).

- 루트 스크립트 `pnpm share:dev`(= `pnpm --filter damwha-share run start`). `share/`의 스크립트 이름을 **`dev`로
  짓지 않는다** — 루트 `pnpm dev`가 `pnpm --parallel --recursive run dev`라 자동으로 끌려 들어간다.
- 개발 중에는 `pnpm dev`(be :3000 + fe :5173)와 `pnpm share:dev`(:8787)를 함께 띄우고 `be/.env`에
  `SHARE_API_URL=http://localhost:8787`을 둔다. `be/.env.example`에 이 줄을 주석과 함께 넣는다.
- 뷰어는 `localhost:8787`에서 공유 서버만 부른다. be의 `ALLOWED_ORIGINS`에 넣지 않는다(선행 결과 규칙 2).
- **만료 단축.** `DEV_EXPIRY_SECONDS`가 있으면 기간 대신 그 초 수로 만료한다. `NODE_ENV=production`(Docker 이미지)이면
  무시하고, 요청 Host가 `localhost`·`127.0.0.1`일 때만 따른다(Tunnel을 거친 요청의 Host는 공개 도메인이다).

### 2.5 뷰어

- `location.hash`에서 키를 읽고, 봉투를 받아 브라우저에서 복호화한 뒤 그린다. 키가 없거나 복호화에 실패하면
  "링크가 올바르지 않아요"를 보여 준다. `410`이면 "이 공유는 만료되었거나 중지되었어요"를 보여 준다.
- 구성: 제목·일시·길이 → 요약 → 렌즈(결정 / 할 일 / 약속) → 발화 기록 → 메모. 없는 항목은 그리지 않는다.
- 메모 마크다운은 HTML로 바꾼 뒤 **반드시 sanitize한다.** 키가 페이지 URL에 있으므로 XSS가 곧 키 유출이다.
- 언어는 `pickUiLanguage`(브라우저 언어) → 실패 시 `ui_language`. ko·en 문구를 둘 다 둔다.
- 하단에 "담화로 만든 공유본 · 링크 만료 <날짜>"와 "보낸 사람이 공유한 시점의 내용이에요"를 적는다. 날짜는
  `GET /api/shares/:id` 응답의 `X-Share-Expires-At`이다. fe 미리보기는 예상값(지금 + 기간)을 넘긴다.
- 외부 스크립트·폰트를 불러오지 않는다. 디자인 토큰은 `fe/DESIGN.md`를 따른다.
- 렌더러는 fe 공유 다이얼로그의 미리보기와 같은 코드를 쓴다(§2.6).

### 2.6 동의와 고지 (fe 공유 다이얼로그)

다이얼로그는 한 화면에서 범위 → 미리보기 → 고지·확인 순으로 읽힌다.

1. **범위**: 요약·렌즈·발화 기록·메모 체크(§2.1 기본값), 화자 이름 익명화 토글과 그 한계 문구, 기간 선택(1 / 7 / 30일).
2. **미리보기**: "받는 사람에게 이렇게 보여요". be가 **실제로 암호화할 페이로드**를 만들어(`POST …/share/preview`,
   업로드 없음) 뷰어와 같은 렌더러로 보여 준다. 화면이 따로 조립한 근사치가 아니다.
3. **고지와 기본 동의** (모든 공유, 미리 체크하지 않음):
   > 링크를 가진 사람은 누구나 이 내용을 볼 수 있어요. 요약·할 일에도 참석자의 이름과 발언 내용이 담길 수 있어요.
   > 서버에는 암호문만 저장되고 키는 저장하지 않아요. 링크는 <날짜>에 막히고 서버 기록은 그 뒤 한 시간 안에 삭제돼요.
   > 공유한 뒤 회의를 고쳐도 반영되지 않아요. 받은 사람이 이미 복사하거나 캡처한 내용은 되돌릴 수 없어요.
   > ☐ 위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요
4. **발화 기록을 켰을 때만** 추가되는 책임 확인(미리 체크하지 않음):
   > **발화 기록에는 다른 참석자의 발언이 그대로 담겨 있어요.** 공유하기 전에 참석자에게 허락을 받았는지 확인해
   > 주세요. 공유로 생기는 책임은 공유한 사람에게 있어요.
   > ☐ 참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요
5. 필요한 체크가 모두 되어 있고 **지금 고른 범위·기간·언어의 미리보기가 성공했을 때만** 공유 버튼이 켜진다.
   값을 바꾸면 새 미리보기가 올 때까지 다시 꺼진다 — 사용자가 보지 못한 내용이 나가지 않는다.
6. **이미 공유 중이면**: "기존 링크(N일 남음)는 바로 중지되고 서버에서 삭제돼요. 기존 링크를 받은 사람은 더 이상
   볼 수 없어요."

- 동의 기록(`consent_version`, `consented_at`, 포함 항목)을 `meeting_share`에 남긴다. 문구를 바꾸면 버전을 올린다.
  be는 요청의 `consent_version`이 현재 버전이 아니면 400으로 거절한다. 발화 기록 포함이면 `transcript_ack: true`도 필수다.
- 공유가 만들어지면 링크와 "복사" 버튼, 링크 만료 날짜를 보여 준다.
- 데모 모드에서는 공유 버튼을 숨긴다.

### 2.7 BE 데이터와 흐름 (`be/src/shares/`)

**마이그레이션 032 — `meeting_share`:**

```sql
CREATE SEQUENCE shr_id_seq;
CREATE TABLE meeting_share (
  id               text PRIMARY KEY DEFAULT 'shr_' || nextval('shr_id_seq') CHECK (id ~ '^shr_[1-9][0-9]*$'),
  meeting_id       text REFERENCES meeting(id) ON DELETE SET NULL,  -- CASCADE 금지
  status           text NOT NULL CHECK (status IN ('creating','active','revoke_pending','revoked','expired')),
  remote_id        text UNIQUE,                    -- 서버가 준 공유 id. creating 동안 NULL
  share_key        text,                           -- 끝나면 NULL
  delete_token     text,                           -- 끝나면 NULL
  scope            jsonb NOT NULL,                 -- {summary, lenses, transcript, note, anonymize}
  duration_days    int NOT NULL,
  expires_at       timestamptz,                    -- 서버가 준 값. creating 동안 NULL
  consent_version  int NOT NULL,
  consented_at     timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoke_attempted_at timestamptz,
  revoke_error     jsonb
);
CREATE UNIQUE INDEX meeting_share_one_creating_idx ON meeting_share(meeting_id) WHERE status = 'creating';
CREATE UNIQUE INDEX meeting_share_one_active_idx   ON meeting_share(meeting_id) WHERE status = 'active';
```

`meeting`에 CASCADE로 묶으면 회의와 함께 삭제 토큰이 사라져 철회할 수 없다. 그래서 `SET NULL`로 행을 살린다.
이 테이블이 철회 대기열을 겸한다(`revoke_pending`).

**공유 생성·교체** (`POST /meetings/:id/share`):

1. **예약 트랜잭션.** `meeting` 행을 `FOR UPDATE`로 잠가 존재를 확인하고, be가 만든 공유 id(`remote_id`)·삭제 토큰을
   담은 `creating` 행을 넣는다. 같은 회의에 이미 `creating`이 있으면 유니크 인덱스가 막는다 → `409 share in progress`.
   동시 공유 요청 두 개가 둘 다 링크를 남길 수 없다.
2. **스냅샷.** `REPEATABLE READ READ ONLY` 트랜잭션 하나에서 회의·현재 버전·요약(현재 버전·`done` 확인 포함)·렌즈와
   근거·발화·메모·화자를 모두 읽고 닫는다. 재처리나 편집 중에도 한 시점의 값만 담긴다. 암호화·업로드는 트랜잭션 밖에서 한다.
3. **업로드.** 실패하면 오류를 돌려준다. 서버가 **분명히 만들지 않았으면**(4xx 응답) `creating` 행을 지운다. 결과를
   알 수 없으면(연결 끊김·타임아웃·5xx) 서버에 객체가 생겼을 수 있으므로 행을 `revoke_pending`으로 돌려 철회한다
   (`DELETE`는 없으면 404 = 성공이라 해가 없다). 기존 활성 공유 행은 그대로다 — 단, 교체 요청이 서버에 닿은 뒤 응답만
   잃었다면 기존 링크는 이미 막혔을 수 있다(닫히는 쪽).
4. **확정 트랜잭션.** `meeting` 행을 다시 `FOR UPDATE`로 잠근다.
   - 회의가 그사이 지워졌으면(`meeting_id`가 NULL) 이 행을 곧바로 `revoke_pending`으로 바꾸고 `410`.
   - 아니면 **기존 `active` 행을 먼저 `revoked`(서버가 교체로 지웠다) 또는 `revoke_pending`(서버가 그 공유를 몰랐다
     — 다른 서버 주소 등)으로 바꾸고**, 그다음 이 행을 `active`로 바꾼다(`remote_id`, 키, 토큰, `expires_at` 기록).
     순서 덕분에 활성 행 유니크 인덱스와 충돌하지 않는다.
5. 교체는 3단계 업로드 요청에 기존 active의 `remote_id`·삭제 토큰을 `X-Replace-Id`·`X-Replace-Token`으로 실어 서버가
   한 번에 처리한다(§2.4). 서버가 교체 토큰을 403으로 거절하면 업로드도 실패한 것이고 기존 링크는 그대로다.
6. **업로드 중 중지.** 업로드하는 사이 사용자가 기존 링크를 중지해도 새 링크 생성은 계속된다. 확정 단계에서 기존 행이
   이미 `revoke_pending`·`revoked`면 그대로 두고 새 행만 `active`로 바꾼다.

**고아 정리.** 스위퍼가 10분 넘은 `creating` 행을 `revoke_pending`으로 바꾼다 — 업로드가 됐는지 알 수 없지만 id와
삭제 토큰을 알고 있으니 철회하면 된다. 서버에 주인 없는 객체가 남지 않는다.

**공유 활성 조건.** 선행 작업의 접근 제어는 브라우저를 막을 뿐 인증이 아니다 — Origin·`Sec-Fetch-Site`가 없는
요청(curl 등)은 통과한다(`be/src/access/evaluate-access.ts` 마지막 `return`). 앱은 `127.0.0.1`에만 바인드되므로
그런 요청은 같은 Mac에서만 오고, 이는 선행 spec이 범위 밖으로 둔 위협이다. 그러나 Docker 이미지는 `HOST=0.0.0.0`
(`deploy/api.Dockerfile`)이라 같은 네트워크 누구나 닿고, 데모는 인터넷에 열려 있다. 그래서:

- `SHARE_ENABLED` = `HOST`가 loopback(`127.0.0.1`, `::1`, `localhost`)이고 데모 모드(`DEMO_READ_ONLY`)가 아닐 때만 참.
  기동 시 한 번 정한다.
- 거짓이면 공유 라우트 전부(`…/share`, `…/share/preview`, `/shares`)가 `404`이고, 재시도 루프도 돌지 않는다.
  fe는 `GET /meetings/:id/share`의 `404`를 보고 공유 버튼을 숨긴다.
- 서비스는 앱으로 제공되므로 Docker 셀프호스팅에서 공유를 쓸 수 없는 것은 의도된 결과다.

**상태를 바꾸는 GET 금지.** 쓰기 보호는 GET이 아닌 요청의 Origin 검사에 기댄다(no-cors GET은 Origin 없이 온다).
공유 라우트의 쓰기는 모두 POST·DELETE다. 이 규칙이 문서에만 있지 않도록 be의 **GET 라우트 목록 스냅샷 테스트**를
더한다 — Nest 라우터에서 GET 라우트를 모아 저장된 목록과 비교하고, GET이 새로 생기면 테스트가 실패해 리뷰를 거친다.

**나머지 API:**

| 요청 | 동작 |
| --- | --- |
| `POST /meetings/:id/share/preview` `{ scope }` | 위 2단계 스냅샷과 같은 코드로 페이로드만 만들어 돌려준다. 업로드·저장 없음. |
| `GET /meetings/:id/share` | 활성 공유(링크, 만료, 범위) 또는 `null`. 만료 시각이 지난 행은 **읽을 때 걸러낼 뿐 바꾸지 않는다.** |
| `DELETE /meetings/:id/share` | `active` → `revoke_pending` 후 철회 시도. 성공하면 `revoked`, 실패하면 `202`로 대기. |
| `GET /shares` | 공유 목록(설정 화면용). `revoke_pending` 포함, 만료가 지난 행은 걸러낸다(바꾸지 않는다). |

- **회의 삭제**(`MeetingsService.remove`): 회의 삭제 트랜잭션 안에서 그 회의의 `active` 행을 `revoke_pending`으로
  바꾼다(`creating` 행은 위 4단계가 처리한다). 커밋 후 철회를 한 번 시도한다.
- **재시도**: be 시작 시와 5분마다 `revoke_pending` 행에 `DELETE`를 보낸다. `2xx`/`404`/`410`이면 `revoked`로 바꾸고
  키·토큰을 지운다. 연속 실패하면 간격을 늘린다(5분 → 최대 1시간).
- **만료**: 스위퍼가 `expires_at`이 지난 `active`·`revoke_pending` 행을 `expired`로 바꾸고 키·토큰을 지운다. GET은 이
  정리를 하지 않는다(상태를 바꾸는 GET 금지). 그 뒤 물리 삭제는 공유 서버의 스위퍼가 책임진다.

**밖으로 나가는 HTTP.** be가 외부로 보내는 첫 요청이다.

- 주소는 `SHARE_API_URL` env(`be/.env`, 기본값 `https://damwha-share.0kimjae.dev`). packaged desktop은 상속된 값을
  지워 기본값을 쓴다.
  `https:`만 허용(개발용 `http://localhost` 예외).
- 리다이렉트를 따라가지 않는다. 요청별 타임아웃 10초, 업로드 본문 5MB 상한을 be에서도 먼저 검사한다.
- 키·삭제 토큰은 로그와 오류 응답에 남기지 않는다(마스킹).
- 프록시 환경 대응은 이번 범위가 아니다.

### 2.8 패키징

새 워크스페이스 패키지가 빌드·배포 경로에서 빠지지 않게 한다.

- `deploy/api.Dockerfile`: 빌드 단계는 `packages/` 전체를, 런타임 단계는 `share-format`의 package.json과 dist를 더 복사한다.
- `deploy/share/Dockerfile`·`deploy/share/docker-compose.yml`(신규): 공유 서버 이미지. 포트는 `127.0.0.1:8787`에만,
  데이터는 볼륨 `damwha_share_data`, `NODE_ENV=production`. Tunnel 설정 예시는 `deploy/share/README.md`.
- `pnpm-workspace.yaml`에 `share`를 더한다.
- `desktop/scripts/package.mjs:82-92`: `pnpm deploy`가 박아 넣는 `file:` 경로를 `workspace:*`로 되돌리는 처리를
  `@damwha/share-format`에도 적용한다.
- 패키징된 앱과 Docker 이미지에서 be가 `@damwha/share-format`을 `require`할 수 있는지 확인한다(§3).
- **데모 시드.** `demo/seed/build.sh:29`는 개발 DB 전체를 `pg_dump`한다. 개발 중 만든 공유의 키·삭제 토큰이 데모로
  넘어가지 않도록 `--exclude-table-data=meeting_share`를 붙인다(스키마는 남긴다). 데모는 공유가 꺼져 있어 행이 쓰이지
  않지만, 덤프 파일에 키가 남는 것 자체를 막는다.

### 2.9 FE·사이트

- **회의 화면**: 헤더에 공유 버튼. 공유 중이면 "공유 중 · 10월 15일까지" 표시와 복사·중지 메뉴.
  `revoke_pending`이면 "중지 대기 중 — 인터넷에 연결되면 중지돼요".
- **설정 화면**: "공유한 링크" 섹션 — 회의 제목(삭제된 회의는 "삭제된 회의"), 남은 기간, 상태, 복사, 지금 중지.
- **회의 삭제 확인 창**: 활성 공유가 있으면 "이 회의의 공유 링크도 중지돼요"를 덧붙인다. 삭제 후 철회가
  대기 상태로 남으면 토스트로 "인터넷에 연결되어 있지 않아요. 공유 링크는 다음에 연결될 때 중지되고, 늦어도
  <날짜>에는 막혀요."
- **오프라인에서 공유**: 업로드 실패를 "인터넷에 연결해야 공유할 수 있어요"로 알린다.
- 모든 문구는 ko·en 둘 다(`2026-09-26-i18n-ko-en-design.md`).
- **사이트** (`site/src/i18n/ko.ts`, `en.ts`): 프라이버시 섹션과 FAQ를 고친다. "녹음과 처리는 모두 내 Mac에서.
  공유를 켰을 때만 암호화된 사본이 서버에 올라가고, 링크는 최대 30일 뒤 막혀요. 오디오는 공유되지 않아요."

### 2.10 하지 않는 것

- 오디오 공유.
- 회의당 여러 링크(범위를 달리한 동시 공유). 실제 요구가 생기면 다음 spec에서 다룬다.
- 같은 링크의 내용 갱신. 갱신은 새 링크다.
- 자유 텍스트 안 이름의 자동 익명화.
- 뷰어 코드 무결성 검증 장치(서명된 뷰어, 별도 신뢰 배포). 대신 §2.3대로 주장을 낮춘다.
- Cloudflare Worker·R2. 공유 서버는 개인 서버의 컨테이너다.
- 공유 서버 여러 대(수평 확장). 일일 상한·요청 제한은 프로세스 하나를 전제로 한다.
- 링크 비밀번호, 열람 횟수 집계, 받는 사람 계정·로그인, 뷰어의 다운로드 버튼.
- 업로드용 앱 내장 비밀키, 프록시 환경 대응.
- 로컬 API 접근 제어 — 별도 선행 작업으로 끝났다.
- Docker 셀프호스팅·데모에서의 공유, 그리고 그 모드를 위한 API 인증.

## 3. 검증

- `packages/share-format`: 암호화→복호화 왕복, 잘못된 키·변조된 봉투 거부, 버전 바이트 불일치 거부, CJS·ESM 둘 다
  import 가능(`vite dev` 포함).
- be 페이로드 빌더: 범위 조합별로 허용 목록 밖 필드가 없음(id, `source`, `is_me`, 성문 등), 익명화가 구조화된 화자
  이름 두 곳에 적용됨, 발화 기록을 빼면 근거 인용이 없음, 예전 버전·silence·빈 본문 발화를 가리키는 렌즈 근거는
  `linkable: false`, 페이로드에 `expires_at`이 없음.
- be 스냅샷: 스냅샷 트랜잭션 도중 다른 연결이 재처리 결과를 커밋해도 페이로드가 한 버전만 담음.
- be 공유 흐름: 동시 공유 두 개 중 하나는 `409`, 업로드 실패 시 기존 공유 유지, 서버가 저장한 뒤 응답을 잃으면
  새 객체가 철회됨(서버에 남지 않음), 업로드 중 기존 링크를 중지해도 새 링크가 active, 교체 시 업로드 요청에 교체 헤더가
  실리고 응답 직후 기존 링크가 서버에 없음·기존 행 `revoked`, 업로드 중 회의 삭제 시 새 행 `revoke_pending`과 `410`,
  회의 삭제 시 행 보존, 재시도의 `404`/`410` 성공 처리, 만료 정리(스위퍼) 후 키·토큰 NULL, GET은 행을 바꾸지 않음,
  오래된 `creating` 정리, 현재가 아닌 동의 버전 거절, 서버가 준 `expires_at`을 그대로 저장.
- be 외부 HTTP: 리다이렉트 거부, 타임아웃, 로그에 키·토큰 없음.
- 공유 서버: be가 준 id·토큰으로 저장, 같은 id·토큰 재전송은 멱등 `200`, 다른 토큰은 `409`, 같은 기존 id의 동시
  교체는 하나만, 만료 후 `410`, 틀린 삭제 토큰 거부, 스트리밍 크기 상한, 일일 상한 초과 시 `503`(동시 요청에서도 상한을
  넘지 않음), `UPLOADS_ENABLED=false` 시 업로드만 거부, 조회 제한이 삭제를 막지 않음, 교체(토큰 틀리면 아무것도
  만들지 않음, 맞으면 새것 생기고 옛것 사라짐), 경로 탈출 id 거부, 스위퍼가 만료 파일 삭제, 반쯤 쓴 파일이 보이지
  않음, `X-Share-Expires-At` 헤더, 응답 헤더(noindex, no-referrer, no-store, CSP), 로그에 토큰 없음.
- 뷰어: 메모 마크다운 XSS 페이로드가 실행되지 않음, 키 없음·변조 시 안내.
- 공유 서버: `DEV_EXPIRY_SECONDS`는 로컬 Host·`NODE_ENV≠production`에서만 적용되고 그 밖에서는 무시됨.
- fe: 미리보기가 성공하기 전·실패 시 공유 버튼이 꺼져 있음.
- Docker 이미지(`deploy/share`): 컨테이너가 뜨고 `/healthz` 200, 볼륨에 공유 파일이 생기고 재시작 뒤에도 열람됨.
- be 공유 활성 조건: `HOST=0.0.0.0` 또는 `DEMO_READ_ONLY=true`면 공유 라우트 전부 `404`, 재시도 루프 미기동.
  loopback이면 켜짐.
- be 접근 제어(선행 결과 규칙 3): `configureHttp`로 만든 앱에서 다른 Origin의 `POST …/share`가 `403`이고
  `meeting_share` 행이 생기지 않음.
- be GET 라우트 스냅샷: 현재 목록과 일치. 변이로 GET 라우트 하나를 더하면 실패함을 확인.
- 데모 시드: 만든 덤프에 `meeting_share` 데이터가 없음(`pg_restore --data-only -t meeting_share`가 비어 있음).
- 패키징: `pnpm package:desktop` 산출물에서 공유 생성이 동작함. Docker 이미지에서는 공유 라우트가 `404`.

**개발 환경 연계 테스트** (`pnpm dev` + `pnpm share:dev`, `SHARE_API_URL=http://localhost:8787`):

| 시나리오 | 기대 |
| --- | --- |
| 앱에서 공유 → 다른 브라우저로 `localhost:8787/s/<id>#<key>` 열람 | 고른 범위만 보임 |
| 같은 회의에서 새 링크 생성 | 새 링크 열람됨, 기존 링크는 응답 직후부터 "만료되었거나 중지되었어요" |
| 공유 중지 | 링크 `410`, 목록에서 `revoked` |
| `share:dev`를 끈 채 회의 삭제 → 다시 켬 | 처음엔 `revoke_pending`, 재시도 후 `revoked`, 링크 `410` |
| `DEV_EXPIRY_SECONDS=60`으로 공유 → 1분 뒤 | 링크 `410`, 앱 목록 `expired` |
| `UPLOADS_ENABLED=false`로 `share:dev` 재시작 | 공유 생성 실패 안내, 기존 링크 열람은 됨 |
| `share:dev` 재시작 | 기존 링크가 계속 열림(디스크 저장) |
| 5MB 넘는 페이로드 | be에서 먼저 거부 |

**배포 후 확인** (사용자가 개인 서버에 컨테이너를 띄우고 Tunnel로 `damwha-share.0kimjae.dev`를 연결한 뒤):
실제 도메인·TLS·응답 헤더, `CF-Connecting-IP` 기준 요청 제한, 스위퍼의 물리 삭제, 패키징된 데스크톱 앱에서 공유 →
다른 기기로 열람 → 새 링크(기존 링크 막힘) → 중지 → `410`. 연결 전에는 패키징된 앱의 공유가 "인터넷에 연결해야
공유할 수 있어요"로 끝나는 것이 정상이며, 성공 판정은 연결 뒤에 한다.

## 4. 미결

- IP별 요청 제한과 서비스 전체 일일 상한 수치(기본값은 계획에서 정하고 env로 바꾼다).
- 개인 서버의 Tunnel 연결 시점. 도메인은 `damwha-share.0kimjae.dev`로 정했다(아직 연결 전).
- 개인정보처리방침 페이지와 고지 문구의 법률 검토. 이 spec의 문구는 초안이다.
