# damwha-site

`damwha.0kimjae.dev` 제품 사이트. Astro 7 정적 빌드, 영어 `/`·한국어 `/ko/`.
설계: `docs/superpowers/specs/2026-09-26-product-site-design.md`.

## 명령 (저장소 루트에서)

```bash
pnpm site:dev              # :4321 — fe 토큰·마크를 먼저 가져온다
pnpm site:build            # site/dist
pnpm site check            # astro check + build + verify-seo (배포 전 이것 하나)
pnpm site test             # vitest
pnpm site record --lang ko   # 발화 점프 영상 재녹화 (Playwright + ffmpeg)
pnpm site og               # OG 이미지 재생성
```

## 알아 둘 것

- **문구는 `src/i18n/en.ts`·`ko.ts`에만 있다.** `ko.ts`가 `satisfies Dictionary`라 키가 빠지면 `astro check`가 실패한다. 용어는 `docs/superpowers/specs/2026-09-26-i18n-ko-en-design.md` §7을 따른다.
- **색과 마크는 `fe/`가 원본이다.** `scripts/sync-from-fe.mjs`가 빌드 때 `fe/src/index.css`의 `:root`·`.dark`와 `fe/public`의 마크 세 파일을 가져온다(gitignore). 직접 고치지 않는다.
- **다운로드 버튼은 빌드 때 GitHub 최신 릴리스를 읽는다.** 실패하면 빌드는 성공하고 버튼이 릴리스 페이지를 가리킨다. 로그에 `[release]` 경고가 남는다.
- **`pnpm site check`가 "@astrojs/check를 설치할까요?"에서 멈추면** 패키지가 없는 게 아니라 pnpm 설치 상태가
  어긋난 것이다. `@napi-rs/wasm-runtime`이 wasm32 선택 의존성 경로로 먼저 잡혀 "skipped"로 기억되면,
  `@astrojs/check`를 import할 때 깨진다. 루트에서 `pnpm install --force`를 한 번 돌리면 된다(락파일은 바뀌지 않는다).
  Cloudflare 빌드는 `astro build`만 쓰므로 영향이 없다.
- **`hero.title`을 바꾸면** `scripts/make-og.mjs`의 `TITLES`도 바꾸고 `pnpm site og`를 다시 돌린다.
- **영어 UI 번역(다국어 설계 §9의 3·4단계)이 끝난 릴리스에서** `en.ts`의 `requirements.rows`의 Display language 줄, `faq`의 "Is the app in English?"와 `ko.ts`의 대응 문구를 고친다. 그리고 `pnpm site record --lang en` 뒤 `en.ts`의 `jump.videoLang`을 `"en"`으로 바꾼다.

## 배포 — Cloudflare Pages (처음 한 번, 사람이)

| 항목 | 값 |
|---|---|
| 프로젝트 이름 | `damwha-site` |
| 연결 | GitHub `Yjason-K/Damwha`, production branch `main` |
| Root directory | (비움) |
| Build command | `pnpm install --frozen-lockfile --filter damwha-site... && pnpm --filter damwha-site build` |
| Output directory | `site/dist` |
| 환경변수 | `SKIP_DEPENDENCY_INSTALL=1`, `NODE_VERSION=22`, (권장) `GITHUB_TOKEN` — 권한 없는 fine-grained 토큰. Pages 빌더는 나가는 IP를 공유해 비인증 한도(60/h)에 남의 빌드가 닿을 수 있다. 없으면 403 때 버튼이 릴리스 페이지로 폴백한다 |
| Build watch paths (include) | `site/**`, `fe/src/index.css`, `fe/public/favicon*`, `fe/public/apple-touch-icon.png`, `pnpm-lock.yaml` |
| Custom domain | `damwha.0kimjae.dev` |

1. 대시보드 → Workers & Pages → Create → Pages → Connect to Git에서 위 값을 넣는다.
2. 첫 배포 로그에서 확인한다: pnpm 10.26.0, Node 22, `[release]` 경고 없음, `Complete!`. pnpm이 잡히지 않으면
   Build command 앞에 `corepack enable && `를 붙인다.
3. Custom domains → `damwha.0kimjae.dev`. `damwha` 서브도메인에 기존 DNS 레코드(예: 과거 Tunnel)가 있으면
   먼저 지운다. `damwha-demo`는 이름이 달라 영향이 없다.
4. Settings → Builds → Deploy hooks → 이름 `desktop-release`, 브랜치 `main`으로 만든다. URL을 셸 프로필에
   `export DAMWHA_SITE_DEPLOY_HOOK=…`로 둔다. `desktop/scripts/publish.sh`가 발행 뒤 이 훅을 부른다.
   비밀 URL이라 저장소에 넣지 않는다.

## 배포 뒤 (사람이)

- `https://damwha.0kimjae.dev/`와 `/ko/`가 뜨고, 언어 링크가 서로를 가리킨다.
- PageSpeed Insights 모바일에서 Performance·SEO·Accessibility·Best Practices가 모두 95 이상이다.
- Google Rich Results Test에서 `SoftwareApplication` 항목이 감지되고 파싱 오류가 없다. "리치 결과 대상 아님(aggregateRating·review 없음)" 경고는 정상이다 — 가짜 평점은 넣지 않는다.
- 카카오 링크 디버거와 슬랙에서 두 URL의 미리보기가 언어별로 다르게 뜬다.
- Google Search Console: `0kimjae.dev` 도메인 속성을 Cloudflare DNS TXT로 인증하고, `https://damwha.0kimjae.dev/sitemap-index.xml`을 제출한다. `/`와 `/ko/`는 URL 검사 → 색인 요청.
- 네이버 서치어드바이저: 사이트를 등록하고, 받은 인증 HTML 파일을 `site/public/`에 커밋해 배포한 뒤 인증한다. 사이트맵을 제출한다.
- GitHub 저장소 About → Website에 `https://damwha.0kimjae.dev`를 넣는다.
- 데모 이미지를 다시 릴리스해(`deploy/demo/release.sh`) `fe/index.html`의 noindex를 싣는다. 확인은
  `curl -s https://damwha-demo.0kimjae.dev/ | grep noindex`.
- 데모를 다시 릴리스하면 다크 테마가 실린다. 그 뒤 `pnpm site record --lang ko`로 영상을 다시 녹화한다(2026-09-27
  영상은 다크 테마 이전 배포본이라 라이트 화면이다).
- Safari에서 발화 점프 영상(mp4 경로)이 재생되는지 본다.
