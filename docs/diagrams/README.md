# 다이어그램

[archify](https://github.com/tt-a1i/archify)로 만든 대화형 다이어그램. 각 `.html`은 의존성 없는
단일 파일이라 브라우저로 바로 열면 된다 — 검색·포커스·경로 추적·다크/라이트·PNG/SVG 내보내기가
파일 안에 들어 있다. 옆의 `.json`이 정본 소스이고, HTML은 거기서 결정적으로 컴파일된 산출물이다.

| 파일 | 종류 | 무엇을 말하는가 |
| --- | --- | --- |
| `damwha-runtime.architecture.html` | architecture | 런타임 전체. FE → API → Postgres, 그리고 워커가 **같은 테이블로 반대편에서** 들어오는 구도. `job` 테이블이 API↔워커의 유일한 계약이라는 것이 그림의 중심. |
| `live-recording.sequence.html` | sequence | 라이브 녹음 한 세션의 시간 순서. 브라우저 AudioWorklet 캡처 → API가 `live.wav`의 유일한 writer → 워커가 자라는 파일을 tail → `sealed_bytes` 봉인 → `process_meeting` 인계. |

## 근거 문서

다이어그램은 요약이지 원본이 아니다. 결정과 그 이유는 아래에 있다.

- 런타임 분할과 `job` 계약 — [`be/CLAUDE.md`](../../be/CLAUDE.md) "Architecture: two runtimes joined by one table"
- 워커 프로세스 모델 — [`be/docs/worker-architecture.md`](../../be/docs/worker-architecture.md) §4
- 라이브 녹음(원 설계, 워커 마이크) — [`docs/superpowers/specs/2026-09-05-live-recording-design.md`](../superpowers/specs/2026-09-05-live-recording-design.md)
- 라이브 녹음(브라우저 캡처, §2.1이 위 문서를 뒤집는다) — [`docs/superpowers/specs/2026-09-05-live-recording-browser-capture-design.md`](../superpowers/specs/2026-09-05-live-recording-browser-capture-design.md)

## 다시 만들기

archify는 이 저장소의 의존성이 아니라 전역 에이전트 스킬(`~/.claude/skills/archify`)이다.
JSON을 고친 뒤:

```bash
ARCHIFY=~/.claude/skills/archify
node $ARCHIFY/bin/archify.mjs validate <architecture|sequence> <소스>.json --quality showcase --json
node $ARCHIFY/bin/archify.mjs deliver  <architecture|sequence> <소스>.json <출력>.html --quality showcase --json
node $ARCHIFY/bin/archify.mjs visual-check <출력>.html --json   # 1440×900 등에서 실제 브라우저 검증
```

`deliver`가 0이 아닌 코드로 끝나면 이전 HTML이 그대로 남는다 — 실패한 산출물이 커밋되지 않는다.
`visual-check`는 PNG와 contact sheet를 HTML 옆에 떨군다. 저장소에 넣을 것이 아니면 지운다.

## 손댈 때 알아둘 것

- **뷰포트 상한이 레이아웃을 정한다.** 1440×900에서 세로 스크롤이 생기면 `visual-check`가 실패한다.
  현재 시퀀스는 그 상한에 맞춰 메시지 14개 / 28px 간격 / viewBox 1080×620으로 눌러둔 것이다.
  메시지를 더하려면 무언가를 빼거나 카드 줄을 줄여야 한다.
- **시퀀스의 참가자 서브라벨은 7px**이라 viewBox 폭이 1085를 넘으면 판독성 검사에 걸린다.
  아키텍처(9px)보다 폭 예산이 빡빡하다.
- **본문은 한국어지만 뷰어 UI는 영어다.** `meta.locale`이 `en`/`zh-CN`만 지원해서 한국어는 생략했고,
  `Explore this system`·`Legend`·`Export`와 `<html lang>`이 영어로 폴백된다.
