# 2026-09-20 스크린샷

서비스 대표 이미지와 사용 흐름 캡쳐. 기존 `docs/images/01~04.png`와
`fe/public/og.png`는 건드리지 않았다 — 여기 있는 것은 전부 새 파일이다.

두 출처에서 찍었다. 같은 SPA지만 담고 있는 이야기가 다르다.

| 접두사 | 출처 | 해상도 | 데이터 |
|---|---|---|---|
| `app-` | Electron 데스크톱 앱 (`desktop/out/mac-arm64/Damwha.app`) | 1280×860 (1x) | 번들 Postgres에 복원한 `demo/seed` |
| `web-` | 라이브 데모 `damwha-demo.0kimjae.dev` | 2880×1800 (2x) | 데모 배포본 |

데스크톱 쪽이 1x인 것은 이 맥에 붙은 두 디스플레이가 모두 4K 네이티브(HiDPI 아님)라
`screencapture`가 백킹 스케일 1배로 찍기 때문이다. 창 크기 1280×860은
`desktop/src/main.ts`의 `createWindow()`에 하드코딩된 기본값이다.

## 대표 이미지

| 파일 | 내용 |
|---|---|
| `00-hero.png` | 데스크톱 앱 전사 화면. macOS 창 그림자 포함(1392×972, 여백은 투명) |

그림자 없는 같은 화면은 `app-01-transcript.png`. 2x 해상도가 필요하면
`web-01-transcript.png`를 쓴다 — 데모 사이드바의 "1분 가이드 보기" 버튼이 같이 찍힌다.

## 데스크톱 앱 — 사용 흐름

| 파일 | 내용 |
|---|---|
| `app-01-transcript.png` | 3분할 셸: 회의 목록 · 전사 · 인사이트 패널, 하단에 화자별 활동 타임라인 |
| `app-02-search.png` | 검색 팔레트. `인지적 부채` 한 건으로 회의 2건에 걸쳐 발화 6건이 걸린다 |
| `app-03-utterance-jump.png` | 검색 결과에서 Enter → `mtg_6` 05:05 발화로 착지, 해당 발화가 하이라이트된다 |
| `app-04-lenses.png` | 모든 회의의 결정사항. 항목마다 `원문 보기`로 근거 발화 링크 |
| `app-05-speakers.png` | 화자 관리. 성문 등록 상태와 등록일 |
| `app-06-settings.png` | 처리 설정. **호스트 맥의 실제 스펙(Apple M4 Pro · 48GB)** 을 읽어 프리셋을 추천한다 |

`app-06`이 데스크톱 앱에서만 의미가 있다. 워커가 부팅할 때
`app_setting.worker_capabilities`를 자기 하드웨어로 덮어쓰므로, 데모 시드에 들어 있던
`Apple M2 · 16GB`가 이 맥의 값으로 바뀌었다. 웹 캡쳐(`web-07`)는 데모 서버 기준이라
여전히 M2로 보인다.

## 라이브 데모 — 같은 흐름, 2x

| 파일 | 내용 |
|---|---|
| `web-01-transcript.png` | 3분할 셸 (`mtg_7`, 23분 대화) |
| `web-02-search.png` | ⌘K 팔레트 + 하이브리드 검색 결과, 검색어 하이라이트 |
| `web-03-utterance-jump.png` | 검색 결과 → `mtg_6` 05:05. 재생 헤드와 타임라인 커서가 같이 이동한다 |
| `web-04-lenses.png` | 렌즈 대시보드 (결정사항 4건) |
| `web-05-lens-evidence.png` | 렌즈 카드의 `원문 보기` → 근거 발화 06:40으로 착지 |
| `web-06-speakers.png` | 화자 관리 |
| `web-07-settings.png` | 처리 설정 (데모 서버 스펙: Apple M2 · 16GB) |

빈 상태의 ⌘K 팔레트도 찍었지만 데모에서는 "결과가 없어요"가 떠서 뺐다. 팔레트가
열린 직후 최근 발화를 보여주는 쪽은 `app-02`다.

## 캡쳐하지 않은 것

- **저장한 발언** — 데모는 읽기 전용이라 비어 있고, 데스크톱 앱도 시드에 저장 발화가 없다
- **메모 탭** — 세 회의 모두 메모가 없다
- **액션아이템 / 약속·책임 렌즈** — 데모 대화 3건의 렌즈는 전부 `decision`이다
  (`demo/README.md`가 설명하듯 팟캐스트형 대화라 원래 드물다)
- **녹음 · 업로드 · 처리중** — 이번 범위는 사용 흐름까지였다

## 재현

```bash
# 웹 (playwright, 스크래치패드에 설치)
node capture-web.mjs        # 1440×900 · deviceScaleFactor 2 · dark · ko-KR

# 데스크톱 앱 (창만 원본 해상도로)
screencapture -o -l <windowId> out.png   # -o 는 그림자 제외
```

창 id는 `CGWindowListCopyWindowInfo`로 얻었다(스크래치패드의 `winlist.swift`).
`osascript`로 창 좌표를 읽는 경로는 이 셸에 손쉬운 접근 권한이 없어 쓸 수 없었다.
