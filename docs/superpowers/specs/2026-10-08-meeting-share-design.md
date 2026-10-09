# 회의 공유 링크 설계

**작성일:** 2026-10-08
**선행:** `dev` @ `a0f2f23` (desktop 0.4.4). 그리고 **로컬 API 접근 제어 작업**(별도 spec, 이 기능보다 먼저 병합).
지금 API는 인증 없이 모든 Origin을 허용한다(`be/src/main.ts:18` `enableCors()`). 그 상태로 외부로 내보내는
API를 더하면 아무 웹페이지나 공유를 실행해 링크를 받아 갈 수 있다.
**대체:** 없음. 다만 제품 사이트의 프라이버시 문구("녹음은 이 Mac을 떠나지 않아요", "인터넷은 모델 받을 때와
업데이트 확인할 때만")는 이 기능에 맞춰 고친다(§2.9).
**범위:** 회의 하나를 암호화된 고정 스냅샷으로 올리고, 링크를 가진 사람만 브라우저에서 읽게 한다. 새 패키지
`share/`(Cloudflare Worker + 정적 뷰어)와 `packages/share-format`, `be`의 공유 모듈, `fe`의 공유 UI,
`@damwha/contracts`의 기간 목록, 마이그레이션 032, Docker·desktop 패키징 수정을 더한다.
**리뷰:** Codex(gpt-6-sol) 리뷰 반영 — 교체 경합, 렌즈 근거 버전, 스냅샷 일관성, 익명화 범위, 삭제 시한, 패키징.

## 1. 목표와 성공 기준

회의 기록을 앱 밖의 사람에게 보여 주되, 서버에는 암호문만 남고 기간이 지나면 남지 않게 한다.

- 공유는 회의 화면에서 시작한다. 링크는 `https://<share 도메인>/s/<id>#<key>` 하나다.
- 서버는 암호문만 받는다. 복호화 키는 URL `#` 뒤에만 있고 서버·레포·env에 저장되지 않는다.
- 기간은 **1일 / 7일(기본) / 30일** 중 고른다. 무제한은 없다.
- 만료 시각이 되면 **링크가 즉시 막힌다.** 서버 기록은 그 뒤 하루 안팎에 물리 삭제된다(§2.4).
- 공유본은 만든 순간의 스냅샷이다. 이후 회의를 고쳐도 반영되지 않는다.
- 회의당 활성 링크는 1개다. 새 링크를 만들면 기존 링크는 중지·삭제된다.
- 모든 공유는 사용자가 직접 체크한 동의를 거친다. 발화 기록을 포함하면 책임 확인 체크가 하나 더 붙는다.
- 사용자는 언제든 공유를 중지할 수 있다. 오프라인이면 중지 요청을 보관했다가 연결되면 보낸다.
- 회의를 지우면 그 회의의 공유도 철회된다. 오프라인이어도 회의 삭제는 막지 않는다.
- 최악의 경우(앱을 지웠거나 다시 연결하지 않음)에도 링크는 최대 30일에 막히고 서버 기록은 그 뒤 곧 사라진다.

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
  그래서 primary 근거 발화가 현재 버전일 때만 `start_ms`와 `linkable: true`를 넣는다. 예전 버전이면 `start_ms`만
  넣고 `linkable: false` — 뷰어는 시각을 글자로만 보여 주고 발화 목록으로 스크롤하지 않는다.
- 발화 기록을 포함하지 않았으면 모든 시각은 글자로만 보인다.
- 근거 발화의 원문 인용은 넣지 않는다. 발화 기록을 빼고 공유했는데 인용으로 원문이 새는 일을 막는다.

### 2.2 페이로드 v1 (`packages/share-format`)

```ts
type SharePayloadV1 = {
  v: 1;
  created_at: string;          // ISO
  expires_at: string;          // ISO
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
- 이 패키지는 타입, zod 스키마, `encryptShare`/`decryptShare`, 포맷 버전을 가진다. be(암호화)와 뷰어(복호화)가
  같은 포맷을 써야 하므로 한 곳에 둔다. `@damwha/contracts`와 같이 **CJS와 ESM을 둘 다 내고 `prepare`로 빌드한다**
  (CLAUDE.md의 `vite dev` 함정). contracts는 의존성이 없어야 하므로 zod를 쓰는 이 패키지는 따로 둔다.
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

### 2.4 공유 서비스 (`share/`)

Cloudflare Worker 하나가 API와 정적 뷰어를 같이 서빙한다. `site/`처럼 독립 배포하고 `pnpm dev`에는 끼지 않는다.

| 요청 | 동작 |
| --- | --- |
| `POST /api/shares` (본문: 봉투, 헤더: 기간) | 본문을 읽으면서 5MB 상한을 강제한다(넘으면 즉시 413). 무작위 id(128비트 이상)와 삭제 토큰을 만들어 R2에 저장하고 `{ id, delete_token, expires_at }`을 돌려준다. 삭제 토큰은 SHA-256 해시만 저장한다. |
| `GET /api/shares/:id` | `expires_at`이 지났거나 없으면 `410`. 아니면 봉투를 돌려준다. |
| `DELETE /api/shares/:id` (`Authorization: Bearer <delete_token>`) | 해시가 맞으면 삭제. 이미 없으면 `404` — 클라이언트는 성공으로 본다. |
| `GET /s/:id` | 정적 뷰어 HTML. |

- **만료.** 정확한 차단은 읽을 때의 `expires_at` 검사가 맡는다. 물리 삭제는 R2 lifecycle 규칙이 맡는다. 기간별로
  저장 경로(prefix)를 나누고 각각 **`N`일** 뒤 삭제 규칙을 건다. R2는 수명이 다한 객체를 보통 24시간 안에 지우므로,
  고지는 "링크는 <날짜>에 막히고 서버 기록은 그 뒤 하루 안팎에 삭제돼요"로 쓴다. 정확한 키 체계는 plan에서 정한다.
- **남용 방지.** 앱 바이너리에 업로드용 비밀을 넣지 않는다(꺼낼 수 있어서 비밀이 못 된다). 대신
  - IP별 요청 제한(Workers Rate Limiting),
  - **서비스 전체 일일 업로드 상한**(객체 수·바이트). 넘으면 그날은 `503`과 "잠시 후 다시 시도해 주세요".
  - Cloudflare 사용량 알림. 이상 징후 시 업로드만 끄는 env 스위치(`UPLOADS_ENABLED`)로 긴급 차단한다. 조회·삭제는 그대로 둔다.
- 공유 객체는 백업하지 않는다. 접근 로그에는 공유 id만 남는다. 응답에 `X-Robots-Tag: noindex`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, 엄격한 CSP를 건다.
- 비밀은 Cloudflare 배포 토큰 하나뿐이다. GitHub Actions secret 또는 로컬 `wrangler login`에 두고 레포에는 넣지 않는다.

### 2.5 뷰어

- `location.hash`에서 키를 읽고, 봉투를 받아 브라우저에서 복호화한 뒤 그린다. 키가 없거나 복호화에 실패하면
  "링크가 올바르지 않아요"를 보여 준다. `410`이면 "이 공유는 만료되었거나 중지되었어요"를 보여 준다.
- 구성: 제목·일시·길이 → 요약 → 렌즈(결정 / 할 일 / 약속) → 발화 기록 → 메모. 없는 항목은 그리지 않는다.
- 메모 마크다운은 HTML로 바꾼 뒤 **반드시 sanitize한다.** 키가 페이지 URL에 있으므로 XSS가 곧 키 유출이다.
- 언어는 `pickUiLanguage`(브라우저 언어) → 실패 시 `ui_language`. ko·en 문구를 둘 다 둔다.
- 하단에 "담화로 만든 공유본 · 링크 만료 <날짜>"와 "보낸 사람이 공유한 시점의 내용이에요"를 적는다.
- 외부 스크립트·폰트를 불러오지 않는다. 디자인 토큰은 `fe/DESIGN.md`를 따른다.
- 렌더러는 fe 공유 다이얼로그의 미리보기와 같은 코드를 쓴다(§2.6).

### 2.6 동의와 고지 (fe 공유 다이얼로그)

다이얼로그는 한 화면에서 범위 → 미리보기 → 고지·확인 순으로 읽힌다.

1. **범위**: 요약·렌즈·발화 기록·메모 체크(§2.1 기본값), 화자 이름 익명화 토글과 그 한계 문구, 기간 선택(1 / 7 / 30일).
2. **미리보기**: "받는 사람에게 이렇게 보여요". be가 **실제로 암호화할 페이로드**를 만들어(`POST …/share/preview`,
   업로드 없음) 뷰어와 같은 렌더러로 보여 준다. 화면이 따로 조립한 근사치가 아니다.
3. **고지와 기본 동의** (모든 공유, 미리 체크하지 않음):
   > 링크를 가진 사람은 누구나 이 내용을 볼 수 있어요. 요약·할 일에도 참석자의 이름과 발언 내용이 담길 수 있어요.
   > 서버에는 암호문만 저장되고 키는 저장하지 않아요. 링크는 <날짜>에 막히고 서버 기록은 그 뒤 하루 안팎에 삭제돼요.
   > 공유한 뒤 회의를 고쳐도 반영되지 않아요. 받은 사람이 이미 복사하거나 캡처한 내용은 되돌릴 수 없어요.
   > ☐ 위 내용을 확인했고, 참석자에게 공유해도 되는 내용이에요
4. **발화 기록을 켰을 때만** 추가되는 책임 확인(미리 체크하지 않음):
   > **발화 기록에는 다른 참석자의 발언이 그대로 담겨 있어요.** 공유하기 전에 참석자에게 허락을 받았는지 확인해
   > 주세요. 공유로 생기는 책임은 공유한 사람에게 있어요.
   > ☐ 참석자의 허락을 받았고, 공유 책임이 나에게 있음을 이해했어요
5. 필요한 체크가 모두 되어야 공유 버튼이 켜진다.
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

1. **예약 트랜잭션.** `meeting` 행을 `FOR UPDATE`로 잠가 존재를 확인하고 `creating` 행을 넣는다. 같은 회의에 이미
   `creating`이 있으면 유니크 인덱스가 막는다 → `409 share in progress`. 동시 공유 요청 두 개가 둘 다 링크를 남길 수 없다.
2. **스냅샷.** `REPEATABLE READ READ ONLY` 트랜잭션 하나에서 회의·현재 버전·요약(현재 버전·`done` 확인 포함)·렌즈와
   근거·발화·메모·화자를 모두 읽고 닫는다. 재처리나 편집 중에도 한 시점의 값만 담긴다. 암호화·업로드는 트랜잭션 밖에서 한다.
3. **업로드.** 실패하면 `creating` 행을 지우고 오류를 돌려준다. 기존 활성 공유는 그대로다.
4. **확정 트랜잭션.** `meeting` 행을 다시 `FOR UPDATE`로 잠근다.
   - 회의가 그사이 지워졌으면(`meeting_id`가 NULL) 이 행을 곧바로 `revoke_pending`으로 바꾸고 `410`.
   - 아니면 **기존 `active` 행을 먼저 `revoke_pending`으로 바꾸고**, 그다음 이 행을 `active`로 바꾼다(`remote_id`,
     키, 토큰, `expires_at` 기록). 순서 덕분에 활성 행 유니크 인덱스와 충돌하지 않는다.
5. 커밋 뒤 `revoke_pending` 행 철회를 한 번 시도한다. 응답은 결과를 기다리지 않는다.

**고아 정리.** be 시작 시 10분 넘은 `creating` 행을 지운다. 업로드는 됐는데 확정 전에 프로세스가 죽은 경우 서버
객체가 남지만 삭제 토큰을 모르므로 철회할 수 없다 — 링크가 바깥에 나간 적이 없고 만료일에 지워지므로 받아들인다.

**나머지 API:**

| 요청 | 동작 |
| --- | --- |
| `POST /meetings/:id/share/preview` `{ scope }` | 위 2단계 스냅샷과 같은 코드로 페이로드만 만들어 돌려준다. 업로드·저장 없음. |
| `GET /meetings/:id/share` | 활성 공유(링크, 만료, 범위) 또는 `null`. |
| `DELETE /meetings/:id/share` | `active` → `revoke_pending` 후 철회 시도. 성공하면 `revoked`, 실패하면 `202`로 대기. |
| `GET /shares` | 공유 목록(설정 화면용). `revoke_pending` 포함. |

- **회의 삭제**(`MeetingsService.remove`): 회의 삭제 트랜잭션 안에서 그 회의의 `active` 행을 `revoke_pending`으로
  바꾼다(`creating` 행은 위 4단계가 처리한다). 커밋 후 철회를 한 번 시도한다.
- **재시도**: be 시작 시와 5분마다 `revoke_pending` 행에 `DELETE`를 보낸다. `2xx`/`404`/`410`이면 `revoked`로 바꾸고
  키·토큰을 지운다. 연속 실패하면 간격을 늘린다(5분 → 최대 1시간).
- **만료**: `expires_at`이 지난 `active`·`revoke_pending` 행은 `expired`로 바꾸고 키·토큰을 지운다. 그 뒤 물리 삭제는
  서버 lifecycle 규칙이 책임진다 — 로컬은 더 할 일이 없다.

**밖으로 나가는 HTTP.** be가 외부로 보내는 첫 요청이다.

- 주소는 `SHARE_API_URL` env(`be/.env`, 기본값 운영 주소). desktop 감독자가 번들 be에 운영 주소를 넘긴다.
  `https:`만 허용(개발용 `http://localhost` 예외).
- 리다이렉트를 따라가지 않는다. 요청별 타임아웃 10초, 업로드 본문 5MB 상한을 be에서도 먼저 검사한다.
- 키·삭제 토큰은 로그와 오류 응답에 남기지 않는다(마스킹).
- 프록시 환경 대응은 이번 범위가 아니다.

### 2.8 패키징

새 워크스페이스 패키지가 빌드·배포 경로에서 빠지지 않게 한다.

- `deploy/api.Dockerfile`: 빌드 단계(`:20`)와 런타임 단계(`:53`, `:59`)에서 `packages/contracts`를 복사하는 곳마다
  `packages/share-format`도 복사한다.
- `desktop/scripts/package.mjs:82-92`: `pnpm deploy`가 박아 넣는 `file:` 경로를 `workspace:*`로 되돌리는 처리를
  `@damwha/share-format`에도 적용한다.
- 패키징된 앱과 Docker 이미지에서 be가 `@damwha/share-format`을 `require`할 수 있는지 확인한다(§3).

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
- 링크 비밀번호, 열람 횟수 집계, 받는 사람 계정·로그인, 뷰어의 다운로드 버튼.
- 업로드용 앱 내장 비밀키, 프록시 환경 대응.
- 로컬 API 접근 제어 — 별도 선행 작업이다.

## 3. 검증

- `packages/share-format`: 암호화→복호화 왕복, 잘못된 키·변조된 봉투 거부, 버전 바이트 불일치 거부, CJS·ESM 둘 다
  import 가능(`vite dev` 포함).
- be 페이로드 빌더: 범위 조합별로 허용 목록 밖 필드가 없음(id, `source`, `is_me`, 성문 등), 익명화가 구조화된 화자
  이름 두 곳에 적용됨, 발화 기록을 빼면 근거 인용이 없음, 예전 버전 발화를 가리키는 렌즈 근거는 `linkable: false`.
- be 스냅샷: 스냅샷 트랜잭션 도중 다른 연결이 재처리 결과를 커밋해도 페이로드가 한 버전만 담음.
- be 공유 흐름: 동시 공유 두 개 중 하나는 `409`, 업로드 실패 시 기존 공유 유지, 교체 시 기존 행 `revoke_pending`
  후 새 행 `active`, 업로드 중 회의 삭제 시 새 행 `revoke_pending`과 `410`, 회의 삭제 시 행 보존,
  재시도의 `404`/`410` 성공 처리, 만료 정리 후 키·토큰 NULL, 오래된 `creating` 정리, 현재가 아닌 동의 버전 거절.
- be 외부 HTTP: 리다이렉트 거부, 타임아웃, 로그에 키·토큰 없음.
- share Worker: 만료 후 `410`, 틀린 삭제 토큰 거부, 스트리밍 크기 상한, 일일 상한 초과 시 `503`, `UPLOADS_ENABLED=false`
  시 업로드만 거부, 응답 헤더(noindex, no-referrer, no-store, CSP).
- 뷰어: 메모 마크다운 XSS 페이로드가 실행되지 않음, 키 없음·변조 시 안내.
- 패키징: `pnpm package:desktop` 산출물과 Docker 이미지에서 공유 생성이 동작함.
- 수동: 데스크톱 앱에서 공유 → 다른 브라우저에서 열람 → 중지 → `410` 확인. 오프라인에서 회의 삭제 → 재연결 후
  서버 객체 삭제 확인.

## 4. 미결

- 공유 서비스 도메인(예: `share.damwha.0kimjae.dev`)과 Cloudflare 계정·요금제 한도.
- IP별 요청 제한과 서비스 전체 일일 상한 수치.
- 개인정보처리방침 페이지와 고지 문구의 법률 검토. 이 spec의 문구는 초안이다.
- 선행 작업인 로컬 API 접근 제어 spec.
