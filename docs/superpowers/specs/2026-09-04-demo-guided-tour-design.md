# 공개 데모 둘러보기(투어) 설계

**작성일:** 2026-09-04
**범위:** 공개 데모의 첫 방문 흐름 — 안내 투어, 가짜 업로드 시뮬레이션, 숨겨진 시드 회의
**전제:** [공개 데모 배포 설계](2026-09-01-public-demo-deployment-design.md) §3.6 읽기 전용은
그대로다. 서버는 한 줄도 바뀌지 않는다.

## 1. 목적과 성공 기준

데모 링크를 배포한 뒤 가장 많이 받은 피드백은 **"어떻게 쓰는지 모르겠다"**였다. 화면은 뜨지만
무엇을 눌러야 무엇이 보이는지, 이 서비스가 오디오를 받아 무엇을 만드는지 방문자가 스스로
알아내야 한다. 읽기 전용이라 업로드를 눌러도 토스트 한 줄뿐이니 제품의 출발점(오디오 →
결과)이 아예 보이지 않는다.

이 설계는 데모를 **서비스 소개 형태**로 바꾼다. 방문자가 "둘러보기"를 누르면 투어가 화면
요소를 차례로 스포트라이트하고, 필요한 조작(모달 열기·탭 전환·발화 클릭)을 대신 해 가며
설명한다. 업로드는 실제 파일 대신 **테스트 오디오**로 제출하고, 워커 없이 브라우저 타이머로
파이프라인 진행을 재생한 뒤 **미리 구워 둔 3번째 회의**를 결과로 붙인다.

성공 기준:

- 첫 방문자가 아무 사전 지식 없이 "둘러보기 시작"만 눌러 90초 안에 업로드 → 처리 → 전사 →
  요약·렌즈 → 검색 → 메모까지 본다.
- 한 방문자의 투어·가짜 업로드가 다른 방문자에게 보이지 않는다(전부 브라우저 로컬 상태).
- 시뮬레이션이 끝난 뒤 보이는 결과는 실제 파이프라인이 처리한 시드 그대로다. 위조된 전사·
  요약은 없다.
- 실제 처리는 로컬 Apple Silicon에서 수 분이 걸린다는 사실이 투어 문구에 드러난다.
- 개발 빌드(`VITE_DEMO_MODE` 미설정)에는 투어 코드가 한 줄도 로드되지 않는다.
- 서버(`be/`)와 워커는 변경 없음.

## 2. 결정

### 2.1 결과 회의는 3번째 시드 회의를 숨겼다가 드러낸다

서버가 읽기 전용이라 방문자별로 회의를 만들 수 없다. 대안 셋을 비교했다.

| 안 | 내용 | 판정 |
|---|---|---|
| **A** | 회의 하나를 더 구워 시드에 넣고, 업로드 전엔 클라이언트가 목록에서 숨김 | **채택** |
| B | 기존 2건 중 하나를 숨겨 결과로 씀 | 첫 화면이 1건뿐이라 빈약 |
| C | 기존 회의를 클라이언트 메모리에서 복제해 제목만 바꿈 | 심사자가 "같은 내용"을 눈치채는 순간 나머지도 가짜로 의심받음 |

A는 시드 작업(§6)이 한 번 더 필요하지만, 기존 배포 설계의 정직성 원칙("결과는 실제
파이프라인 그대로")을 그대로 지킨다.

### 2.2 투어는 하이브리드 — 설명은 투어가, 진행은 사용자가

각 단계는 스포트라이트 + 말풍선으로 설명하고, **다음 단계에 필요한 조작(라우트 이동·모달
열기·탭 전환·발화 클릭)은 투어가 대신 실행**해 화면을 준비한다. 사용자는 "다음"만 누른다.
중간에 강조된 요소를 직접 눌러 봐도 된다.

완전 자동 재생(영상처럼 몇 초마다 넘어감)은 읽는 속도 차이로 놓치기 쉽고, 사용자 주도("여기를
클릭하세요" 후 대기)는 단계마다 완료 감지가 필요해 비용이 크다.

### 2.3 첫 방문 모달이 투어 입구다

기존 `DemoNoticeDialog`(첫 방문 1회, localStorage)를 개편한다. 버튼은 **둘러보기 시작** /
**그냥 볼게요** 둘. 정직성 문구(NotebookLM 생성 샘플·읽기 전용)는 짧게 남긴다. 왼쪽 네비
하단에 **둘러보기** 버튼을 상시 노출해 언제든 다시 시작할 수 있다.

### 2.4 업로드가 투어의 두 번째 단계다

순서는 **회의 목록 → 업로드 → 처리 → (방금 만들어진 회의 위에서) 전사 → 플레이어 → 요약 →
렌즈 → 검색 → 메모**. 업로드를 앞에 두면 이후 모든 기능 설명이 "방금 올린 오디오에서 나온
것"이라는 맥락을 얻는다.

### 2.5 시뮬레이션은 12초, 단계별 서술

기존 처리 배너가 `stage`(vad → diarize → identify → stt → align → persist → embed)를 그린다.
이 stage를 타이머로 전진시키고, 투어 말풍선이 각 stage가 무엇인지 설명한다. 이 구간이
방문자가 아키텍처를 이해하는 자리다. "실제로는 10분 회의에 수 분이 걸리고, 처리는 Apple
Silicon 로컬에서만 돈다"는 한 줄을 포함한다.

### 2.6 투어를 끝내려 하면 확인 모달을 띄운다

ESC·오버레이 클릭·팝오버 닫기·라우트 이동(네비 클릭, 브라우저 뒤로가기) 전부 **"둘러보기를
그만둘까요?"** 모달로 간다. 기본 포커스는 "계속 둘러보기". "그만두기"를 골라야 투어가 끝난다.
시뮬레이션은 투어와 독립 모듈이라 그만둬도 끝까지 돌고 회의는 정상 등장한다.
새로고침·탭 닫기는 막지 않는다.

### 2.7 가짜 데이터 층은 axios 응답 인터셉터다

데모 빌드에는 이미 요청 인터셉터(`shared/api/demo-read-only.ts`)가 있다. 같은 자리에 응답
인터셉터를 하나 더 둔다. TanStack Query 캐시를 직접 조작하는 방식은 폴링이 실제 응답으로
덮어써 깜빡이고, 서버 시뮬레이션 엔드포인트는 방문자 간 상태가 섞여 원래 걱정 그대로다.

### 2.8 투어 엔진은 `driver.js`

MIT, 의존성 0, ~5KB gz. 스포트라이트 마스크·팝오버·리사이즈 추적·단계 훅
(`onHighlightStarted`, `onDestroyStarted`)을 제공한다. 직접 구현은 SVG 마스크 + 포지셔닝 +
스크롤 컨테이너 엣지케이스를 재발명하는 200줄+이고, `react-joyride`는 무겁고 React 19
호환 이력이 나쁘다. 팝오버는 CSS 변수로 디자인 토큰에 맞춘다.

## 3. 구성요소

전부 `fe/src/`. 새 파일은 `features/demo/` 아래.

```
features/demo/
  model/tour-state.ts            localStorage {uploaded, noticeSeen} 읽기/쓰기 + 구독
  model/upload-simulation.ts     가짜 파이프라인 상태 머신
  api/demo-tour-interceptor.ts   axios 응답 인터셉터 — 숨김 필터 + 상태 덮어쓰기
  lib/tour-steps.ts              driver.js 단계 정의 (타깃·문구·진입 시 동작)
  lib/tour-runner.ts             driver 인스턴스 생성·시작·정리, waitFor 유틸, 종료 확인 연동
  lib/wait-for.ts                셀렉터가 DOM에 나타날 때까지 대기(MutationObserver, 3s 타임아웃)
  ui/demo-notice-dialog.tsx      개편: 둘러보기 시작 / 그냥 볼게요
  ui/tour-launch-button.tsx      LeftNav 하단 상시 버튼
  ui/tour-exit-dialog.tsx        종료 확인 모달
  ui/demo-upload-source.tsx      업로드 모달의 "테스트 오디오" 행
  ui/tour-navigation-guard.tsx   useBlocker로 투어 중 라우트 이동 차단 → 종료 모달
```

기존 파일 변경:

- `features/meeting/ui/upload-dialog.tsx` — `env.demoMode`면 파일 행을 `DemoUploadSource`로
  교체하고, 제출 시 `useUploadMeeting` 대신 `startUploadSimulation()`을 부른다. 제목·녹음
  일시·프리셋·후속 실행 시점 필드는 그대로 보이되 시뮬레이션에는 영향 없다.
- `features/meeting/ui/left-nav.tsx` — 하단에 `TourLaunchButton`(데모 빌드에서만 lazy).
- `app/providers.tsx` — 데모 빌드에서 `DemoNoticeDialog`와 함께 인터셉터 설치.
- `app/app-shell.tsx` — 데모 빌드에서 `TourNavigationGuard` 렌더.
- `shared/config/env.ts` — `demoTour: { meetingId, fileLabel, searchQuery } | null`.
- 스포트라이트 타깃 컴포넌트에 `data-tour` 속성만 추가. 로직 변경 없음.

| `data-tour` | 위치 |
|---|---|
| `meeting-list` | LeftNav 회의 목록 컨테이너 |
| `new-meeting` | LeftNav "새 회의" 항목 |
| `upload-submit` | UploadDialog 제출 버튼 |
| `processing-banner` | `pages/meeting.tsx` ProcessingBanner |
| `utterance` | TranscriptPane 각 발화(첫 번째를 타깃) |
| `player-bar` | PlayerBar |
| `insight-tab-summary` / `insight-tab-note` | InsightPane 탭 트리거 |
| `lens-section` | InsightPane 요약 탭의 렌즈 섹션(다음 할 일·핵심 결정) |
| `search-trigger` | AppShell 상단 검색 버튼(⌘K) |
| `search-palette` | CommandBar DialogPrimitive.Content (명령 팔레트) |
| `tour-launch` | LeftNav 둘러보기 버튼 |

의존성 추가: `driver.js` 하나.

## 4. 데이터 흐름

### 4.1 상태

`tour-state.ts`가 localStorage 키 `damwha.demo-tour.v1`에 `{ uploaded: boolean,
noticeSeen: boolean }`을 둔다. 읽기 실패(사생활 모드)는 `{uploaded:false, noticeSeen:false}`.
기존 `damwha.demo-notice.v1` 키는 이 키로 흡수한다(마이그레이션 없음 — 재방문자는 모달을 한
번 더 볼 뿐이다).

`upload-simulation.ts`는 모듈 싱글턴 상태 머신이다.

```
idle ──start(id)──▶ running{startedAt} ──12s──▶ done
                        ▲                          │
                        └────── start(id) ─────────┘   (재실행은 언제든)
```

stage 타임라인(누적 초): queued 0 → vad 1 → diarize 3 → identify 5 → stt 6 → align 9 →
persist 10 → embed 11 → done 12. `progress`는 각 stage 안에서 0→1 선형. 전환마다 구독자에게
알리고 `["meeting-status", id]`, `["meeting", id]`, `["meetings"]`를 invalidate해 폴링 주기(2초)를
기다리지 않는다. `done`이 되면 인터셉터 덮어쓰기가 해제되고 실제 응답이 그대로 흐른다.

### 4.2 숨김 (uploaded=false)

응답 인터셉터가 다음 응답에서 투어 회의를 제거한다.

| 요청 | 처리 |
|---|---|
| `GET /meetings` | `id === tourId` 원소 제거 |
| `POST /search` | `hits`에서 `meeting_id === tourId` 제거 |
| `GET /lenses?…` | `items`에서 `meeting.id === tourId` 제거 |
| `GET /saved-utterances?…` | 같은 방식 |

`GET /meetings/:tourId` 직접 접근(URL 공유)은 통과시킨다. 404를 위조하지 않는다.

### 4.3 덮어쓰기 (running)

| 요청 | 처리 |
|---|---|
| `GET /meetings` | 투어 회의의 `status`를 `processing`으로 |
| `GET /meetings/:tourId` | `status: "processing"`, 발화·요약은 응답 그대로 두되 화면은 status로 배너를 그림 |
| `GET /meetings/:tourId/status` | `{ status:"processing", stage, progress, error:null, summary:{status:"queued"}, search_index:{status:"queued"} }` |

`pages/meeting.tsx`는 `status !== "done"`이면 전사 대신 `ProcessingBanner`를 그리므로 발화가
응답에 실려 있어도 보이지 않는다. `<audio key={status}>`가 `done`에서 리마운트되어 재생도
정상이다.

### 4.4 업로드 제출

```
UploadDialog(demo) 제출
  → startUploadSimulation(tourId)   // uploaded=true 저장, running 진입, ["meetings"] invalidate
  → toast "업로드 완료"
  → onUploaded(tourId)              // LeftNav가 /meetings/:tourId로 이동
  → useMeeting / useMeetingStatus 폴링 시작 → 인터셉터가 가짜 stage 응답
  → 12초 뒤 done → 실제 응답
```

투어 밖에서 방문자가 업로드 모달을 직접 열어 제출해도 같은 경로다. 이미 `uploaded=true`면
회의를 잠깐 숨겼다가 다시 재생한다(`start`가 리셋을 포함).

### 4.5 투어 시작·재시작

`tourRunner.start()`:
1. `uploaded=false` 저장, `["meetings"]`·`["lenses"]`·`["saved-utterances"]` invalidate.
2. `tourNavigating=true`로 `/` 이동(가드 우회), 단계 1부터.

### 4.6 종료

driver `onDestroyStarted`(ESC·오버레이·X)와 `TourNavigationGuard`의 `useBlocker` 둘 다
`TourExitDialog`를 연다.

- 계속 둘러보기 → 모달 닫기, blocker면 `reset()`.
- 그만두기 → `driver.destroy()`, blocker면 `proceed()`.

모달이 열린 동안 driver의 키보드 제어를 끈다. `DialogContent`는 driver 오버레이(z-index
10000) 위에 뜨도록 z-index를 올린다. 투어 자체의 프로그램적 이동은 `tourNavigating` 플래그로
blocker를 우회한다.

## 5. 투어 단계

| # | 타깃 | 진입 시 동작 | 말풍선 요지 |
|---|---|---|---|
| 1 | `meeting-list` | `/` 이동 | 처리된 대화가 여기 쌓인다. 지금은 샘플 2건 |
| 2 | `new-meeting` | — | 새 대화는 오디오 업로드로 시작한다 |
| 3 | `upload-submit` | `new-meeting` click → 모달 대기 | 데모라 파일 대신 테스트 오디오. 제출하면 처리가 시작된다 |
| 4 | `processing-banner` | `upload-submit` click → 이동 → 배너 대기 | stage별 서술: 음성 구간 → 화자 분리 → 성문 대조 → Whisper 전사 → 정렬·저장 → 색인. 실제론 수 분, Apple Silicon 로컬. `done` 전엔 "다음" 비활성 |
| 5 | `utterance` | `done` 대기 → 첫 발화 click | 발화 = 화자·시각·원본 오디오. 클릭하면 그 순간으로 점프 |
| 6 | `player-bar` | — | 화자별 구간·배속·발화 이동 |
| 7 | `insight-tab-summary` | 탭 click | 참석자·주요 주제·단락 요약 |
| 8 | `lens-section` | scrollIntoView | 액션·결정·약속을 자동 추출. 사람이 고칠 수 있다 |
| 9 | `search-palette` | `search-trigger` click → 팔레트 대기 + `searchQuery` 주입 | 모든 대화를 가로질러 발화를 찾는다 |
| 10 | `insight-tab-note` | 팔레트 닫기 → 탭 click | 마크다운 메모. 마무리: 읽기 전용 데모, NotebookLM 샘플, 네비 버튼으로 다시 볼 수 있음 |

- 단계 4의 `description`은 시뮬레이션 구독으로 tick마다 `driver.refresh()`.
- `waitFor(selector, 3000)` 실패 시 그 단계를 건너뛰고 콘솔 `warn`. 투어는 죽지 않는다.
- `env.demoTour`가 `null`이면 단계 2~4를 제외하고 첫 회의 위에서 5~10만 돈다. 업로드 모달은
  기존 읽기 전용 토스트 그대로.
- 검색어 주입은 팔레트 input에 React 호환 방식(native value setter + `input` 이벤트)으로 넣는다.

## 6. 시드와 빌드 (코드 밖 작업 포함)

1. NotebookLM으로 3번째 대화 오디오를 만들고(`demo/audio/`), 로컬 Mac에서 실제 파이프라인으로
   렌즈·요약까지 `done`으로 처리한다. 렌즈가 0건이면 단계 8의 섹션이 사라져 그 단계가
   건너뛰어지므로, 렌즈가 1건 이상 나온 회의를 고른다. — **사용자 작업**
2. `demo/seed/build.sh`로 덤프·manifest를 갱신한다.
3. `demo/seed/tour.json`을 쓴다. — **사용자 작업**(id는 manifest에서)

   ```json
   { "meeting_id": "<uuid>", "file_label": "<원본 파일명> · 9.8 MB", "search_query": "<전사에 확실히 있는 단어>" }
   ```

4. `deploy/demo/release.sh`가 `tour.json`을 읽어 `--build-arg VITE_DEMO_TOUR_MEETING_ID`,
   `VITE_DEMO_TOUR_FILE_LABEL`, `VITE_DEMO_TOUR_SEARCH_QUERY`로 넘기고,
   `deploy/api.Dockerfile`이 세 ARG를 받아 SPA 빌드에 싣는다. `tour.json`이 없으면 release가
   실패한다(`manifest.json` 검사와 같은 자리).
5. 로컬 검증은 `fe/.env.local`에 `VITE_DEMO_MODE=true`와 세 값(아무 로컬 회의 id)을 넣고
   `pnpm dev`.

코드 구현은 시드와 독립이다. 덤프에 그 id가 없으면 `GET /meetings/:id`가 404라 상세 페이지의
기존 에러 상태가 뜬다 — 인터셉터는 404를 위조하지 않는다. `deploy/demo/README.md` 체크리스트에
적는다.

## 7. 테스트

vitest(jsdom):

- `upload-simulation.test.ts` — fake timer로 stage 순서·`done` 시각·재실행 리셋, invalidate
  호출(QueryClient mock).
- `demo-tour-interceptor.test.ts` — 숨김 4개 엔드포인트 / running 중 `GET /meetings/:id`·
  `/status`·`/meetings` 덮어쓰기 / done 후 통과 / 비데모 빌드 미설치.
- `tour-state.test.ts` — localStorage 실패 시 기본값, 저장·구독.
- `upload-dialog.test.tsx` — 데모: 파일 input 없음, `file_label` 표시, 제출 →
  `startUploadSimulation` + `onUploaded(tourId)`, 실제 mutation 미호출. 비데모: 기존 동작.
- `demo-notice-dialog.test.tsx` — 두 버튼, "둘러보기 시작" → `tourRunner.start`.
- `tour-exit-dialog` / `tour-navigation-guard` — 계속 → reset, 그만두기 → destroy + proceed.
- `tour-steps.test.ts` — 모든 step의 `data-tour` 값이 `src/` 어딘가에 실제로 존재하는지
  정적 검사(파일 grep). 셀렉터 리네임 드리프트 방지.

driver.js 스포트라이트 자체는 jsdom에 레이아웃이 없어 단위 테스트하지 않는다. 마무리 검증은
`VITE_DEMO_MODE=true pnpm dev`를 Playwright 브라우저로 열어 투어 10단계를 끝까지 돌리고
스크린샷을 남긴다.

## 8. 범위 밖

- 모바일 폭 대응 — 3분할 셸이 데스크톱 전제이고 투어도 같다.
- 투어 다국어 — 대상 독자가 한국 채용 심사자다.
- 서버·워커 변경 — 없다.
- 기존 `damwha.demo-notice.v1` 키 마이그레이션 — 재방문자가 모달을 한 번 더 보는 정도.
