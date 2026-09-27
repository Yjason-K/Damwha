# 제품 사이트 설계

**작성일:** 2026-09-26
**상태:** 설계 초안 — 사용자 리뷰 대기. 2026-09-27 다국어 기반(0.4.1, `2026-09-26-i18n-ko-en-design.md`) 반영
**범위:** `damwha.0kimjae.dev` 한 페이지 제품 소개 사이트(영어·한국어) — 스택, URL, 페이지 구성,
SEO, 발화 점프 영상, 배포

## 1. 목적과 성공 기준

Damwha는 2026-09부터 **서명·공증된 macOS 데스크톱 앱**(GitHub Release의 DMG)으로만 배포된다
(`b8ca13e`, `desktop/scripts/publish.sh`). 그런데 사람이 도착하는 곳은 둘뿐이다.

- **README** — 개발자용 Quickstart·배지·아키텍처가 섞여 있다. 앱을 받아 쓰려는 사람에게는
  길을 잃게 하는 문서다.
- **공개 데모** (`damwha-demo.0kimjae.dev`) — 써 보는 곳이지 설명하고 다운로드를 받는 곳이
  아니다. 이력서 링크용으로 만들었고(2026-09-01 데모 설계 §1) 그 역할은 그대로 둔다.

"이게 뭐고, 왜 내 Mac에서 도는지, 어디서 받는지"에 한 번에 답하는 곳이 없다. 이 설계는
그 한 곳을 만든다.

성공 기준:

- 첫 화면에서 한 줄 소개와 **다운로드 / 데모 써보기** 버튼 두 개가 보인다.
- 핵심 기능인 **발화 점프**(검색 결과 → 원본 음성의 그 순간)를 실제 앱 영상으로 보여 준다.
- 영어(`/`)와 한국어(`/ko/`)가 각자 색인된다. Google에서 "Damwha"를 검색하면 이 사이트가 1위에 온다.
- 모바일 Lighthouse의 Performance·SEO·Accessibility·Best Practices가 모두 95 이상이다.
- 릴리스가 새로 나가도 사이트를 손으로 고치지 않는다.

## 2. 범위

### 2.1 포함

- `site/` 새 pnpm 워크스페이스 패키지(`damwha-site`) — Astro 정적 사이트
- 영어·한국어 랜딩 페이지 각 1장, 404 페이지 1장
- SEO 일체: 메타·OG·hreflang·canonical·sitemap·robots·JSON-LD
- 발화 점프 데모 영상(데모 사이트에서 자동 녹화)
- Cloudflare Pages 배포 + `damwha.0kimjae.dev` 연결
- 공개 데모 SPA에 `noindex` 추가(§3.6)
- `publish.sh`가 릴리스 뒤 사이트 재빌드를 트리거(§3.7)
- README 두 벌 상단에 사이트 링크 추가

### 2.2 비포함 (YAGNI)

- 블로그·문서·변경 이력 페이지 — 필요해지면 Astro에 페이지를 더하면 된다
- 다크/라이트 토글 — 시스템 설정만 따른다
- 분석 도구(GA 등) — 쿠키 배너가 따라온다. 필요하면 Cloudflare Web Analytics(쿠키 없음)를 대시보드에서 켠다
- 영상 오디오 트랙 — 자동 재생은 음소거가 조건이다
- 언어 자동 리다이렉트 — §3.3
- `FAQPage` 구조화 데이터 — Google이 2023-08부터 FAQ 리치 결과를 정부·보건 사이트로 제한했다. FAQ 본문은 넣되 스키마는 넣지 않는다
- 새 도메인 — 커지면 산다(§9)

## 3. 확정된 결정

### 3.1 한 페이지로 만든다

기능·가격·문서 페이지로 나눌 분량이 없다. 무료 오픈소스 앱이라 가격 페이지도 없다. 긴 랜딩
한 장이 스크롤 한 번에 모든 질문에 답한다.

### 3.2 Astro를 쓴다 (Next.js 대신)

- **기본 출력이 정적 HTML이고 클라이언트 JS가 0이다.** 이 페이지에서 JS가 필요한 곳은 영상
  재생 제어 정도다. Next는 정적 export여도 React 런타임과 hydration을 싣는다.
- **Next의 강점(SSR, API 라우트, Server Actions, ISR)을 쓸 곳이 없다.** `output: 'export'`에서는
  이미지 최적화·미들웨어·내장 i18n 라우팅이 꺼져, 큰 프레임워크를 들이고 기능은 끈 채로 쓰게 된다.
- Vite 기반이라 Tailwind 4를 `fe`와 같은 방식(`@tailwindcss/vite`)으로 붙인다.
- 버전은 구현 시점의 최신 안정 메이저를 쓴다.

### 3.3 언어는 URL로 나눈다

| URL | 언어 | `<html lang>` |
|---|---|---|
| `https://damwha.0kimjae.dev/` | 영어 (기본) | `en` |
| `https://damwha.0kimjae.dev/ko/` | 한국어 | `ko` |

- JS 토글로 문구만 바꾸면 Google은 한 언어만 색인한다. 두 URL은 **각자 완성된 HTML**이다.
- Astro 내장 i18n 라우팅: `defaultLocale: "en"`, `locales: ["en", "ko"]`,
  `routing.prefixDefaultLocale: false`.
- 언어 전환은 두 URL 사이의 평범한 `<a>` 링크다. **Accept-Language 자동 리다이렉트는 하지 않는다.**
  Googlebot은 주로 미국에서 영어 헤더로 오므로, 리다이렉트하면 `/ko/`가 크롤러에게서 사라진다.
- 기본이 영어인 이유: 루트 URL이 해외 검색·GitHub 방문자의 첫 도착지이고, 한국어 사용자는
  hreflang으로 Google이 `/ko/`를 대신 보여 준다.

사이트의 언어 사전은 앱의 i18next 사전(`fe/src/shared/i18n/`)과 **별개**다. 사이트 문구는 빌드 때
HTML에 박히므로 런타임 i18n 라이브러리가 필요 없고, 앱 문구와 공유할 키도 없다. 다만 용어와 문체는
앱 다국어 설계(`2026-09-26-i18n-ko-en-design.md` §7)의 용어집을 그대로 따른다. 예를 들어
Utterance, Speaker, Lens, Enroll speaker, 프리셋 Light / Standard / Quality(가볍게 / 표준 / 정확하게)이고,
영어는 sentence case·느낌표 없음이다. 앱 화면과 사이트가 같은 기능을 다른 이름으로 부르지 않게 하려는 것이다.

**앱 화면의 영어는 아직 일부뿐이다 — 그 상태를 영어 페이지에서 숨기지 않는다.**
0.4.1은 맥 언어를 따라 한국어·영어로 뜨고 설정에서 바꿀 수 있다(`UI_LANGUAGES`, `pickUiLanguage`
— `packages/contracts/src/index.ts`). 그러나 번역된 곳은 **설정 › 일반과 앱 메뉴뿐**이고, 나머지 화면은
다국어 설계 §9의 3·4단계(FE·desktop 문구 이전)에서 차례로 옮긴다(0.4.1 릴리스 노트). 그래서:

- 영어 페이지의 요구사항·FAQ는 "English UI is rolling out — some screens are still in Korean"이라고 적는다.
  이 문구는 사전 한 줄이라, 3·4단계가 끝난 릴리스에서 "Korean and English"로 바꾼다(§10).
- 스크린샷과 영상은 지금 한국어 UI다. 3단계가 끝나면 영어 페이지용 영어 UI 캡처로 바꾼다(§7).
- 대화 콘텐츠의 언어는 화면 언어와 따로다. **인식 언어**는 자동·한국어·영어·일본어·중국어이고
  (`STT_LANGUAGES`), **요약 언어**는 녹취 언어 따름·한국어·영어 중에서 고른다(`SUMMARY_LANGUAGES`). 고르기
  전에는 맥 언어를 따른다. 한국어 회의를 영어로 요약받을 수 있다는 점은 영어 페이지에서 내세울 만한 기능이다(§4).

### 3.4 호스팅은 Cloudflare Pages

- `0kimjae.dev`의 DNS가 이미 Cloudflare에 있다(데모가 Cloudflare Tunnel로 나가고 있다).
  커스텀 도메인을 붙이면 CNAME과 인증서가 자동으로 생긴다.
- 서버가 없다. 데모처럼 홈 서버 가동에 묶이지 않는다.
- Git 연동: `main` push → 프로덕션, PR → 미리보기 URL.
- Workers + Static Assets도 가능하지만, 정적 사이트 하나에서는 차이가 없고 Pages의 Git 연동
  흐름이 더 단순하다. 옮겨야 해도 산출물(`site/dist`)은 같다.

### 3.5 도메인

`damwha.0kimjae.dev`로 시작한다. 새 도메인을 사면 페이지별 301과 Search Console 주소 변경으로
옮긴다(§9). URL 경로(`/`, `/ko/`)는 도메인이 바뀌어도 유지한다 — 그게 이전 비용을 0에 가깝게 한다.

### 3.6 데모는 링크로만 연결하고 색인에서 뺀다

- 데모는 API·DB가 붙은 앱이고 사이트는 정적 HTML이다. iframe으로 넣으면 무겁고 모바일에서 깨진다.
  사이트는 스크린샷·영상으로 보여 주고 "데모 써보기" 버튼으로 넘긴다.
- **데모 링크에 페이지 언어를 싣는다.** 영어 페이지는 `https://damwha-demo.0kimjae.dev/?lang=en`, 한국어
  페이지는 `?lang=ko`로 건다. 브라우저 단독 FE는 `?lang` → localStorage → `navigator.languages` 순으로
  화면 언어를 정하므로(`fe/src/shared/i18n/language-store.ts`) 이것이 가장 앞선다. 지금은 번역된 화면이
  적지만, 문구 이전(다국어 설계 §9의 3단계, 데모·투어 포함)이 데모에 반영되면 사이트는 고칠 것 없이 따라간다.
  샘플 회의의 발화·요약 본문은 번역 대상이 아니므로(다국어 설계 §2) 영어 데모에서도 한국어 대화가 보인다.
  영어 페이지의 버튼 옆 설명에 "sample conversations are in Korean"을 적는다.
- **데모 SPA에 `<meta name="robots" content="noindex">`를 넣는다.** 안 그러면 "Damwha" 검색에서
  데모(빈 `<div id="root">`와 한국어 메타)가 제품 사이트와 경쟁한다.
- 넣는 자리는 `fe/index.html` 한 줄이다. 같은 파일을 데스크톱 앱도 쓰지만 앱 화면은 어디서도 색인
  대상이 아니므로 조건 분기가 필요 없다. 이력서·카톡 링크 공유는 noindex와 무관하게 그대로 된다
  (OG 태그는 남는다).

### 3.7 다운로드 링크는 빌드 시점에 최신 릴리스를 읽는다

릴리스 자산 이름에 버전이 들어간다(`Damwha-0.4.0-arm64.dmg`). 그래서
`releases/latest/download/<고정이름>`식 영구 링크를 쓸 수 없다.

- **빌드 시** GitHub API `GET /repos/Yjason-K/Damwha/releases/latest`를 한 번 호출해 태그, `.dmg`
  자산 URL과 크기, 발행일을 얻는다. 버튼은 DMG를 바로 받고, 옆에 `v0.4.1 · 1.2 GB · macOS 15+`처럼 적는다(값은 예시).
- **호출이 실패하면 빌드는 실패하지 않는다.** 버튼이 `https://github.com/Yjason-K/Damwha/releases/latest`
  (릴리스 페이지)를 가리키고 버전 표기를 뺀다. 빌드 로그에 경고를 남긴다.
- **릴리스 → 재빌드:** Cloudflare Pages의 Deploy Hook URL을 만들어 로컬 환경변수
  `DAMWHA_SITE_DEPLOY_HOOK`에 둔다. `desktop/scripts/publish.sh`가 "Latest" 확인까지 끝난 뒤
  변수가 있으면 `curl -fsS -X POST`로 호출하고, 없으면 "사이트 재빌드 건너뜀"을 출력한다. 훅
  호출 실패는 릴리스를 실패시키지 않는다(이미 발행됐다).
- 재빌드가 빠져도 옛 DMG 링크는 여전히 유효한 서명본이고, 0.4.0부터는 앱이 새 버전을 알린다.
  최악의 경우가 "한 버전 늦은 설치"라서 이 정도 자동화로 충분하다.

### 3.8 시각 방향: 앱과 같은 재료, 마케팅 간격

`fe/DESIGN.md` §1은 "Mintlify 마케팅 페이지 쪽은 참조 대상이 아니다"라고 적었다. 그건 **앱의
정보 밀도**를 지키려는 규칙이다. 이 사이트는 앱이 아니라 소개 페이지이므로 밀도 규칙(14px 본문,
좁은 간격)은 따르지 않는다. 가져오는 것은 **재료**다.

- **색 토큰** — 무채색 잉크 + 민트 신호, `.dark` 한 벌. 화자 팔레트(`--spk-*`)는 사이트에서도
  화자를 표시할 때만 쓴다.
- **서체** — Inter + Geist Mono. 한국어는 `fe`와 같은 시스템 폴백.
- **브랜드 마크** — `fe/public/favicon.svg`·`favicon.ico`·`apple-touch-icon.png`를 쓴다. 토큰과 같은
  스크립트가 빌드 때 `site/public/`으로 복사하고(gitignore), 커밋하는 사본은 없다. 그래서 `fe/DESIGN.md` §2의
  "마크가 흩어진 여섯 군데"는 늘지 않는다. §0에 더하는 한 줄에 "마크 래스터도 빌드 때 가져간다"를 함께 적는다.
- 평면, hairline 경계, 그라디언트·글래스 없음은 그대로다. 본문 16px 이상, 섹션 간격은 넓게 둔다.

**색 토큰의 단일 출처를 유지한다.** 지금은 `fe/src/index.css`의 `:root`/`.dark` 블록(22–307행)이
유일한 출처다. **사이트는 이 파일을 건드리지 않고 빌드 때 두 블록을 뽑아 쓴다.**
`site/scripts/sync-from-fe.mjs`가 `fe/src/index.css`를 읽어 `:root { … }`와 `.dark { … }`만 떼어
`site/src/styles/tokens.generated.css`(gitignore)에 쓰고, `site.css`가 그것을 import한다. `dev`·`build`
스크립트가 이 추출을 먼저 돌린다. 값을 복사해 커밋하지 않는다.

- 블록을 찾는 정규식은 `fe/src/design-tokens.test.ts`가 쓰는 것과 같다(`/^:root\s*\{([^}]*)\}/m`,
  `/^\.dark\s*\{([^}]*)\}/m`). 블록 안에 `}`가 없다는 전제를 그 테스트가 이미 지키고 있다.
- 둘 중 하나라도 못 찾거나 변수가 40개 미만이면 추출이 실패하고 빌드가 멈춘다. 조용히 빈 토큰으로
  배포되는 것을 막는다.
- **토큰을 별도 파일로 옮기지 않는 이유:** `fe/src/design-tokens.test.ts`와 desktop의
  `tests/windows/window-background.test.ts`가 `fe/src/index.css`를 직접 읽고, `desktop/shell/*.html`의
  주석도 이 파일을 원본으로 가리킨다. 옮기면 사이트 하나 때문에 fe·desktop 테스트 두 곳과 문서를 고쳐야 한다.
- `fe/DESIGN.md` §0 표 아래에 "제품 사이트(`site/`)는 빌드 때 `:root`/`.dark`를 뽑아 쓴다 — 두 블록의
  선택자를 바꾸면 사이트 빌드가 멈춘다"는 한 줄을 더한다.

사이트의 다크 모드는 `fe/index.html`과 같은 방식이다. `<head>` 인라인 스크립트가
`prefers-color-scheme`을 읽어 `<html class="dark">`를 붙인다. 토글이 없으므로 localStorage는 읽지 않는다.

폰트는 Google Fonts `@import` 대신 `@fontsource-variable/inter`·`@fontsource/geist-mono`로
자체 호스팅한다. 외부 CSS 요청이 렌더링을 막지 않게 하려는 것이다.

## 4. 페이지 구성

같은 컴포넌트를 두 언어가 공유한다. 섹션 순서와 각 섹션이 답하는 질문은 아래와 같다.
문구 초안은 §4.1에 있고, 최종 문구는 구현 중 사용자 리뷰로 확정한다.

| # | 섹션 | 답하는 질문 | 시각 자료 |
|---|---|---|---|
| 1 | **Hero** | 이게 뭔가? 어떻게 시작하나? | `00-hero.png`(앱 창) · 다운로드 / 데모 버튼 |
| 2 | **Problem** | 왜 필요한가? | 없음 — 짧은 글 |
| 3 | **Utterance jump** | 대표 기능이 실제로 어떻게 보이나? | 발화 점프 영상(§7) |
| 4 | **Features** | 그 밖에 뭘 하나? | 4칸 그리드 — 화자 식별·회의 간 화자 연결 / ⌘K 하이브리드 검색 / 렌즈(할 일·결정·약속) + 근거 링크 / 요약(한국어·영어·녹취 언어 중 선택)·실시간 녹음 |
| 5 | **Private by design** | 내 녹음이 어디로 가나? | 파이프라인 한 줄 다이어그램(HTML/CSS) |
| 6 | **Requirements & download** | 내 Mac에서 도나? 얼마나 받나? | 요구사항 표 + 다운로드 버튼 반복 |
| 7 | **Recording & consent** | 뭘 조심해야 하나? | 없음 — README §녹음과 동의 요약 |
| 8 | **FAQ** | 남은 질문 | `<details>` 목록 |
| 9 | **Footer** | 더 보려면? | GitHub · 데모 · 릴리스 노트 · MIT 라이선스 · 언어 전환 |

스크린샷 출처는 `docs/images/2026-09-20/`(데모 시드를 복원한 데스크톱 앱 캡처)이다. 필요한 것만
`site/src/assets/`로 복사하고 Astro `<Picture>`로 AVIF/WebP + `srcset`을 만든다. Hero 이미지만
`loading="eager"` + `fetchpriority="high"`이고 나머지는 lazy다.

Features 그리드의 네 이미지: `app-01-transcript`(화자 타임라인), `app-02-search`, `app-04-lenses`,
`app-05-speakers`. 발화 점프는 영상이 맡으므로 `app-03`은 영상 포스터로 쓴다.

### 4.1 문구 초안

**Hero**

- EN — *Find the moment it was said.* / Damwha records your conversations and turns them into
  speaker-attributed, searchable utterances — every line one click from the original audio.
  Runs entirely on your Mac.
- KO — *그 말, 그 순간으로.* / 담화는 대화를 녹음해 누가·언제·무슨 말을 했는지 발화 단위로
  정리합니다. 어떤 줄이든 한 번에 원본 음성으로. 모든 처리는 내 Mac 안에서.
- 버튼: `Download for Mac` / `Mac용 다운로드`, `Try the live demo` / `데모 써보기`
- 버튼 아래: `v0.4.1 · Apple Silicon · macOS 15+`(§3.7 빌드 값, 여기 적은 것은 예시)

**Private by design** — README의 한 문장을 중심으로: 클라우드 ML 없음, 성문은 디스크에만,
모델은 처음 쓸 때 한 번 받는다. 파이프라인은
`audio → normalize → VAD → diarization → speaker ID → Whisper → search index → lens ∥ summary`.

**Requirements**

| | |
|---|---|
| Mac | Apple Silicon, macOS 15 이상 |
| 디스크 (모델, 처음 쓸 때 받음) | 가볍게 약 8 GB · 표준 약 20 GB · 정확하게 약 40 GB (EN: Light · Standard · Quality) |
| Hugging Face 토큰 | 화자 분리 모델에만 필요. 앱 안에서 넣는다. 없어도 앱은 뜬다 |
| 화면 언어 | 한국어·영어 — 영어는 차례로 번역 중(§3.3) |
| 대화 언어 | 인식: 자동·한국어·영어·일본어·중국어 / 요약: 녹취 언어·한국어·영어 |

디스크 값은 `be/src/settings/presets.ts`의 프리셋(전사 · 요약 모델)에, 렌즈 추출용 최소 요약 모델
(4B, 5.2 GB)과 고정 모델 합계 2.4 GB를 더한 것이다. 크기는 `docs/MODELS.md`의 용량 표를 따른다.
가볍게 0.5+5.2+2.4, 표준 1.6+10.5+5.2+2.4, 정확하게 3.1+29.5+5.2+2.4. 프리셋이나 모델 표가
바뀌면 이 값도 고친다.

**FAQ 후보** — 무료인가(MIT) · 인터넷이 필요한가(모델 받을 때만) · Intel Mac·Windows는(아니오,
MLX 전용) · 영어 화면·영어 대화도 되나(§3.3 — 화면은 번역 중, 인식 5개 언어, 요약 언어 선택) · 업데이트는 어떻게(앱이 알리고 DMG를 받는다) · 데모의 목소리는
진짜인가(NotebookLM 합성, `demo/README.md`) · 데이터를 되돌릴 수 있나(업데이트 전 스냅샷, `docs/RESTORE.md`).

**Recording & consent** — README의 해당 절을 세 문장으로 줄인다. 녹음 고지를 띄우지 않는다는 것,
모든 참여자의 성문이 저장된다는 것, 적법성 책임은 쓰는 사람에게 있다는 것. 법률 조문은 인용하지
않는다(README와 같은 원칙).

## 5. 구조

```
site/
  package.json            # name: damwha-site, scripts: dev / build / preview / check
  astro.config.mjs        # site URL, i18n, sitemap 통합, @tailwindcss/vite
  public/
    favicon.svg · favicon.ico · apple-touch-icon.png   # sync-from-fe.mjs가 복사, gitignore (§3.8)
    og-en.png · og-ko.png                              # 1200×630 (§6)
    media/utterance-jump.<lang>.{mp4,webm} · utterance-jump-poster.<lang>.jpg   # §7
    robots.txt
  src/
    i18n/
      en.ts · ko.ts       # 문구 사전. ko.ts는 `satisfies Dictionary` (en.ts에서 뽑은 타입)
      index.ts            # getDictionary(lang), 경로 헬퍼
    lib/release.ts        # 빌드 시 GitHub latest release 조회 + 폴백 (§3.7)
    layouts/Base.astro    # <head>: 메타·OG·hreflang·canonical·JSON-LD·다크 인라인 스크립트
    components/
      Landing.astro       # 섹션 조립 — lang prop 하나로 두 언어를 만든다
      Hero.astro · Problem.astro · UtteranceJump.astro · Features.astro
      Privacy.astro · Requirements.astro · Consent.astro · Faq.astro · Footer.astro
      DownloadButton.astro · LangSwitch.astro
    pages/
      index.astro         # <Landing lang="en" />
      ko/index.astro      # <Landing lang="ko" />
      404.astro
    styles/site.css       # @import "tailwindcss"; @import "./tokens.generated.css"; 사이트 전용 규칙
    styles/tokens.generated.css   # sync-from-fe.mjs 산출물, gitignore (§3.8)
  scripts/
    sync-from-fe.mjs            # 토큰 추출 + 마크 복사 (§3.8)
    record-utterance-jump.mjs   # §7
    verify-seo.mjs              # §8
```

- **번역 누락은 타입 오류다.** `en.ts`가 사전 모양을 정하고 `ko.ts`가 `satisfies`로 맞춘다.
  키가 하나라도 빠지면 `astro check`가 실패한다.
- 컴포넌트는 문구를 직접 갖지 않는다. 사전의 해당 가지만 받는다.
- 클라이언트 JS는 영상 섹션의 작은 인라인 스크립트 하나뿐이다(§7). 프레임워크 아일랜드는 없다.

워크스페이스 반영:

- `pnpm-workspace.yaml`에 `site`를 더한다.
- 루트 `package.json`에 `site`, `site:dev`, `site:build` 스크립트를 `be`·`fe`와 같은 모양
  (`pnpm --filter damwha-site run …`)으로 더한다. 루트 `pnpm build`는 이제 사이트도 빌드한다.
  이때 GitHub API 호출 실패는 경고일 뿐이라(§3.7) 오프라인 빌드를 막지 않는다.
- `site/.env`는 없다. 필요한 값(사이트 URL)은 `astro.config.mjs`에 적는다. 비밀이 없다.

## 6. SEO

### 6.1 페이지마다 넣는 것 (`Base.astro`)

- `<title>` · `<meta name="description">` — 언어별. 예: `Damwha — Local, speaker-attributed
  conversation search for Mac` / `담화 Damwha — 내 Mac에서 도는 화자별 대화 기록·검색`
- `<link rel="canonical">` — 자기 자신의 절대 URL
- `<link rel="alternate" hreflang="en">`, `hreflang="ko"`, `hreflang="x-default"`(→ `/`) — 양쪽 페이지에 똑같이
- OG / Twitter — `og:locale`(`en_US` / `ko_KR`) + `og:locale:alternate`, `og:image`는 언어별 PNG의 절대 URL
- `theme-color` — `fe/index.html`과 같은 값
- JSON-LD `SoftwareApplication`:
  `name`(Damwha), `alternateName`(담화), `operatingSystem`(macOS 15+), `applicationCategory`
  (`ProductivityApplication`), `offers`(price 0), `downloadUrl`·`softwareVersion`(§3.7 값, 폴백 시 생략),
  `image`, `url`, `inLanguage`, `license`(MIT URL), `sameAs`(GitHub 저장소)

### 6.2 사이트 전체

- `@astrojs/sitemap`의 i18n 옵션으로 hreflang이 들어간 `sitemap-index.xml`을 만든다.
- `robots.txt` — 전부 허용 + `Sitemap:` 절대 URL
- `404.astro`는 `noindex`

### 6.3 성능 (Core Web Vitals)

- 클라이언트 JS 사실상 0, 폰트 자체 호스팅 + `font-display: swap`, Inter는 latin 서브셋만 preload
- Hero 이미지는 LCP 후보이므로 eager·high priority, 명시적 width/height로 CLS 0
- 영상은 `preload="none"` + 포스터 이미지. 화면에 들어올 때만 로드한다(§7)

### 6.4 키워드

제목·소제목·본문에 자연스럽게 들어가게 문구를 짠다. 키워드를 나열한 숨은 텍스트는 쓰지 않는다.

- EN: self-hosted / local meeting transcription for Mac, speaker diarization app, on-device
  transcription, searchable meeting recordings, private voice notes
- KO: 로컬 회의록 앱, 맥 녹음 전사, 화자 구분 녹음, 온디바이스 음성 기록, 회의 녹음 검색, 담화 앱

"담화" 단독은 일반 명사라 상위 노출을 노리지 않는다. "Damwha"와 "담화 Damwha"는 노린다.

### 6.5 배포 후 등록 (사람이 할 일)

1. **Google Search Console** — `0kimjae.dev` **도메인 속성**을 Cloudflare DNS TXT로 인증하고
   `https://damwha.0kimjae.dev/sitemap-index.xml`을 제출한다. `/`와 `/ko/` 모두 URL 검사 → 색인 요청.
2. **네이버 서치어드바이저** — 사이트를 등록하고, 인증용 HTML 파일을 받아 `site/public/`에 커밋한다.
   사이트맵을 제출한다.
3. **링크 걸기** — README 두 벌 상단, GitHub 저장소 About의 Website 칸, 릴리스 노트 끝, 데모의
   첫 방문 모달이나 사이드바(선택)에 사이트 링크를 건다.

## 7. 발화 점프 영상

**내용 (10–15초, 반복 재생):** 데모 투어 회의 화면 → `⌘K` → 검색어 입력(`인지적 부채`,
`docs/images/2026-09-20/README.md`의 `app-02`와 같은 질의) → 결과 목록 → Enter → `mtg_6` 05:05
발화로 착지, 하이라이트, 재생 헤드와 타임라인 커서가 같이 이동한다(`web-03`이 찍은 장면이다).

**녹화 방식:** `site/scripts/record-utterance-jump.mjs`가 Playwright로 라이브 데모를 조작하고
`recordVideo`로 녹화한다.

- 뷰포트 1440×900, `deviceScaleFactor` 2, `colorScheme: "dark"`, `locale: "ko-KR"` —
  기존 캡처(`capture-web.mjs`)와 같은 조건이다. 여기에 URL로 `?lang=ko`를 붙여 화면 언어를 못 박는다.
  데모가 이제 `navigator.languages`와 localStorage로도 언어를 정하므로, 브라우저 설정에 녹화 결과가
  흔들리지 않게 하려는 것이다.
- 스크립트는 `--lang ko|en`을 받는다. 지금은 `ko` 한 벌만 만들어 두 페이지가 같이 쓴다. 다국어 설계
  §9의 3단계가 데모에 반영되면 `en`으로 한 벌 더 녹화해 영어 페이지에 붙인다. 검색어는 두 벌 모두
  `인지적 부채`다 — 샘플 대화가 한국어라서다. 파일 이름은 `utterance-jump.<lang>.{mp4,webm}`으로 처음부터
  언어를 붙인다.
- 첫 방문 모달·투어 안내는 스크립트가 닫는다.
- 타이핑은 사람 속도(글자당 80–120ms), 동작 사이에는 0.6–1초씩 쉰다. 너무 빠르면 무엇이
  일어났는지 보이지 않는다.
- Playwright headless 페이지는 `visibilityState`가 `visible`이므로 TanStack 폴링 정지 문제가
  없다. Chrome 확장 자동화 탭은 hidden으로 잡혀 폴링이 멈추므로 쓰지 않는다.
- Playwright는 **스크립트 전용 devDependency**로 `site/`에 두고, 브라우저 바이너리는 사용자가
  한 번 `pnpm --filter damwha-site exec playwright install chromium`으로 받는다. 빌드와 CI에는 끼지 않는다.

**후처리:** ffmpeg로 앞뒤를 자르고 두 벌을 인코딩한다.

- `utterance-jump.<lang>.mp4` — H.264, `yuv420p`, `+faststart`, 오디오 없음, 1440 폭
- `utterance-jump.<lang>.webm` — VP9, 같은 크기
- `utterance-jump-poster.<lang>.jpg` — 첫 프레임
- 목표 크기는 각 2 MB 이하다. 넘으면 폭을 1280으로 줄인다.

**재생:** `<video muted loop playsinline preload="none" poster=…>`에 `<source>` 두 개를 둔다.
`IntersectionObserver` 인라인 스크립트가 화면에 들어오면 `play()`, 나가면 `pause()`한다.
`prefers-reduced-motion: reduce`이면 자동 재생하지 않고 `controls`를 붙인다.
캡션(EN/KO)이 "검색 결과에서 Enter → 원본 음성의 그 순간"을 설명한다.

산출물은 커밋한다(`site/public/media/`). 데모 시드가 바뀌면 스크립트를 다시 돌린다.

## 8. 배포

### 8.1 Cloudflare Pages 프로젝트 (사람이 대시보드에서 한 번)

| 항목 | 값 |
|---|---|
| 프로젝트 이름 | `damwha-site` |
| 연결 | GitHub `Yjason-K/Damwha`, production branch `main` |
| Root directory | (비움 — 저장소 루트) |
| Build command | `pnpm install --frozen-lockfile --filter damwha-site... && pnpm --filter damwha-site build` |
| Output directory | `site/dist` |
| 환경변수 | `SKIP_DEPENDENCY_INSTALL=1`, `NODE_VERSION=22` |
| Build watch paths | 포함: `site/**`, `fe/src/index.css`, `fe/public/favicon*`, `pnpm-lock.yaml` |
| Custom domain | `damwha.0kimjae.dev` |
| Deploy hook | 만들어서 URL을 로컬 `DAMWHA_SITE_DEPLOY_HOOK`에 둔다(§3.7) |

- **루트에서 필터 설치를 하는 이유:** Pages가 자동으로 `pnpm install`을 돌리면 워크스페이스 전체
  (Electron·NestJS 포함)를 설치한다. `SKIP_DEPENDENCY_INSTALL`로 끄고 `--filter damwha-site...`
  (사이트와 그 의존성만)으로 직접 설치한다. pnpm 10.26.0은 루트 `packageManager`로 corepack이 고른다.
- **첫 배포 로그에서 확인할 것:** pnpm 버전, Node 22, 설치된 패키지 수, `release.ts`의 API 호출 성공.
  pnpm이 corepack으로 잡히지 않으면 build command 앞에 `corepack enable &&`를 붙인다.
- **DNS:** `damwha` 서브도메인에 기존 레코드(예: 과거 Tunnel 라우트)가 있으면 지우고 붙인다.
  `damwha-demo`는 이름이 달라 영향이 없다.

### 8.2 SEO 검증 스크립트

`site/scripts/verify-seo.mjs`가 `site/dist`를 읽어 확인한다. `site`의 `check` 스크립트가
`astro check && astro build && node scripts/verify-seo.mjs`를 돌린다.

- `/index.html`과 `/ko/index.html`이 존재하고 `<html lang>`이 각각 `en`/`ko`다
- 두 페이지 모두 canonical이 자기 절대 URL이고, hreflang 세 개가 같은 URL 집합을 가리킨다
- `<title>`·description·`og:image`가 비어 있지 않고 두 언어에서 서로 다르다
- JSON-LD가 JSON으로 파싱되고 `@type`이 `SoftwareApplication`이다
- `sitemap-index.xml`과 `robots.txt`가 있고, robots의 `Sitemap:`이 절대 URL이다
- 모든 `<img>`에 `alt`가 있다
- `<h1>`이 페이지당 정확히 하나다

이 스크립트가 지키는 것을 변이로 확인한다. hreflang 한 줄 지우기, `ko.ts`의 title을 `en.ts`와
같게 바꾸기, alt 하나 지우기가 각각 실패로 잡혀야 한다.

### 8.3 배포 후 수동 확인

- `https://damwha.0kimjae.dev/`와 `/ko/`가 HTTPS로 뜨고 언어 전환 링크가 서로를 가리킨다
- 모바일 Lighthouse 네 항목 95 이상(§1)
- Google Rich Results Test에서 `SoftwareApplication`이 인식된다
- 카카오 링크 디버거와 슬랙에서 두 URL의 OG 미리보기가 언어별로 뜬다
- `damwha-demo.0kimjae.dev` HTML에 `noindex`가 있다(데모 재릴리스 뒤)
- 다운로드 버튼이 최신 DMG를 받는다. `publish.sh` 다음 실행 때 훅으로 사이트가 재빌드되는지 본다

## 9. 나중에 도메인을 바꿀 때

1. 새 도메인을 Cloudflare Pages 프로젝트에 추가하고, `astro.config.mjs`의 `site`를 바꿔 배포한다.
2. `damwha.0kimjae.dev`에 Cloudflare **Bulk Redirect**(또는 Redirect Rule)로 경로와 쿼리를 보존하는
   301을 건다. `/` → 새 `/`, `/ko/` → 새 `/ko/`.
3. Search Console에 새 도메인 속성을 추가하고, 옛 속성에서 **주소 변경**을 신청한다. 사이트맵을 다시 제출한다.
4. README·GitHub About·데모 링크를 새 주소로 바꾼다.

경로를 그대로 두는 한 옮기는 비용은 이 네 단계가 전부다.

## 10. 위험과 대응

| 위험 | 대응 |
|---|---|
| 영어 사용자가 한국어 UI 스크린샷을 보고 실망한다 | §3.3 — 요구사항·FAQ에 "rolling out"으로 명시. 숨기면 다운로드 후 이탈로 돌아온다 |
| 앱 번역이 끝났는데 사이트 문구와 캡처가 그대로 남는다 | 다국어 설계 §9의 3·4단계가 들어간 릴리스에서 사이트 사전의 두 줄(요구사항·FAQ)을 고치고, 영어 캡처·영상으로 바꾼다. 다국어 설계 §9 6단계(문서)의 체크리스트에 이 사이트를 한 줄 더한다 |
| GitHub API rate limit(비인증 60회/시) | 빌드당 1회 호출이라 닿지 않는다. 닿아도 §3.7 폴백 |
| Pages 빌드 환경에서 pnpm·Node 버전이 어긋난다 | §8.1 첫 배포 로그 확인 항목 |
| `fe/src/index.css`의 블록 구조가 바뀌어 사이트 토큰이 빈다 | 추출이 못 찾으면 빌드가 실패한다(§3.8). 조용한 빈 배포는 없다 |
| 데모 시드가 바뀌어 영상 장면이 사라진다 | 영상은 커밋된 산출물이라 깨지지 않는다. 시드 갱신 체크리스트(`deploy/demo/README.md`)에 "영상 재녹화 여부" 한 줄을 더한다 |
| 초기 색인이 느리다 | Search Console 색인 요청 + README·GitHub About 백링크. 브랜드명 검색은 보통 며칠 안에 잡힌다 |
