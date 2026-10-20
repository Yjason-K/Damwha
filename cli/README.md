# damwha-cli

`damwha` 명령과 코딩 에이전트용 stdio MCP 서버. 데스크톱 앱에 `Resources/cli/`로 실려 나가며,
**앱의 HTTP API만** 쓴다 — Postgres나 스토리지(`STORAGE_ROOT`)를 직접 열지 않는다.
설계: `docs/superpowers/specs/2026-10-20-cli-mcp-design.md`. 사용자용 문서는 제품 사이트의 `/cli/`(영어)·`/ko/cli/`.

## 명령 (저장소 루트에서)

```bash
pnpm cli build        # dist/damwha.cjs — esbuild 단일 CJS 번들
pnpm cli test         # vitest
pnpm cli lint         # tsc --noEmit
```

dev에서 API를 직접 가리키려면 `DAMWHA_API_URL=http://localhost:3000/api`를 준다. 이 값이 있으면
`api.json`을 보지 않고 health만 확인한다.

## 연결

앱이 API가 준비된 뒤 `~/Library/Application Support/Damwha/api.json`
(`{ port, app_pid, instance, version }`)을 쓰고 정지·종료 때 지운다. CLI는 파일, `app_pid` 생존,
`/health`의 `instance` 일치를 모두 확인한다. 앱이 없으면 종료 코드 2.

## 명령과 종료 코드

| 명령 | 설명 |
| --- | --- |
| `damwha status` | 연결과 모델 준비 상태 진단. 연결되면 0, 아니면 2 |
| `damwha upload <file>` | 오디오를 새 회의로 업로드. `--title` `--recorded-at` `--folder` `--preset` `--whisper-model` `--stt-device` `--diarization-device` `--language` `--speakers` `--min-speakers` `--max-speakers` `--no-summary` `--no-lens` `--wait` |
| `damwha search <query>` | 발화 검색. `--limit` `--from` `--to` `--meeting` `--folder` |
| `damwha meetings` | 회의 목록. `--limit`(기본 100) |
| `damwha meeting <id>` | 회의 하나 |
| `damwha transcript <id>` | 전사. `--offset` `--limit` |
| `damwha lenses` | 렌즈 목록. `--kind` `--mine` `--open` `--done` `--meeting` `--due-from` `--due-to` `--limit` |
| `damwha mcp` | stdio MCP 서버 |

모든 명령에 `--json`. 종료 코드: `0` 성공 · `1` 옵션·파일·API 오류 · `2` 앱 미실행/준비 중 ·
`3` `upload --wait`가 끝났으나 처리 단계 실패. 오류 메시지는 앱 UI 언어를 따른다(`src/messages.ts`).

## MCP 도구

`list_lenses` `get_lens` `list_meetings` `get_meeting` `get_transcript` `search`
`get_meeting_status` `upload_audio` `complete_lens` (`src/mcp/tools.ts`).

- 읽기 도구는 `readOnlyHint`. 대화에서 나온 문자열(제목·요약·전사·화자 이름 등)은 전부
  `untrusted()`로 감싸 에이전트에게 지시처럼 읽히지 않게 한다 (`src/mcp/untrusted.ts`).
- `complete_lens`는 완료 처리 전에 클라이언트에 **확인 창(elicitation)**을 띄운다. 창의 문장은
  에이전트 인자가 아니라 API에서 다시 읽은 값으로 만들고, `accept`가 아니면 아무것도 바꾸지 않는다.
  elicitation을 지원하지 않는 클라이언트에는 도구를 등록하지 않는다.
- 연결은 도구를 부를 때마다 다시 확인한다. 앱이 나중에 켜져도 서버를 다시 띄울 필요가 없다.

## 설치

설정 화면 › CLI · MCP(`fe/src/features/integrations`, API는 `be/src/integrations`)가
`~/.local/bin/damwha` 심볼릭 링크를 만들고 Claude Code·Codex의 자체 `mcp add` 명령을 부른다.
수동 설치 명령(`manualCommands`):

```bash
mkdir -p ~/.local/bin && ln -s /Applications/Damwha.app/Contents/Resources/cli/damwha ~/.local/bin/damwha
claude mcp add --transport stdio --scope user damwha -- ~/.local/bin/damwha mcp
codex mcp add damwha -- ~/.local/bin/damwha mcp
```

## 규칙

- Postgres·스토리지를 직접 열지 않는다. be API의 HTTP만 쓴다.
- stdout은 MCP 프레임 전용이다 — `damwha mcp`에서 로그를 stdout에 쓰지 않는다.
- 번들(`dist/damwha.cjs`)에는 `/.pnpm/` 경로 조각이 남으면 안 된다 (`build.mjs`가 지운다, desktop `check-bundle` 4번).
