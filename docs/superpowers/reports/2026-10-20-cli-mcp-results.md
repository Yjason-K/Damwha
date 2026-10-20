# CLI · MCP 결과

**작성일:** 2026-10-20
**Spec:** [`specs/2026-10-20-cli-mcp-design.md`](../specs/2026-10-20-cli-mcp-design.md)
**Plan:** [`plans/2026-10-20-cli-mcp.md`](../plans/2026-10-20-cli-mcp.md)
**브랜치:** `feat/cli-mcp` (`783c790`에서 시작, 커밋 범위 `783c790..19904ef`)
**선행:** [`reports/2026-10-09-meeting-share-results.md`](2026-10-09-meeting-share-results.md)

## 요약

터미널의 `damwha` 명령과 Claude Code·Codex가 쓰는 `damwha mcp` 서버를 더했다. 둘은 한 실행 파일과 한 HTTP 클라이언트를
공유하며, 실행 중인 담화 앱의 로컬 API 위에서 동작한다. 렌즈·회의·전사·검색 조회와 오디오 업로드가 되고, 렌즈 완료는
클라이언트의 elicitation 확인 창에서 수락이 왔을 때만 처리한다. 앱 설정 화면의 버튼으로 명령 설치와 Claude Code·Codex 등록·해제를 한다.

- `be/` — 렌즈 단건·전사 페이지·회의 목록 keyset 페이지·status 단계별 상태, health의 desktop 인스턴스 nonce, 데스크톱 전용 `/integrations`(CLI 링크 판정·설치, Claude Code·Codex MCP 등록·해제), 로그인 셸 PATH 기준 `on_path`.
- `cli/` — 패키지 골격, 앱 연결 판정, API 클라이언트, `upload`·`search`·`meetings`·`meeting`·`lenses`·`transcript`·`status` 명령, MCP 읽기 도구·`upload_audio`·`complete_lens`(elicitation 수락일 때만 완료).
- `desktop/` — API 포트 파일(`api.json`)과 인스턴스 nonce, CLI 런처 경로 주입, CLI 번들 탑재와 `check-bundle` 검사.
- `fe/` — 설정의 CLI · MCP 설치 섹션.
- `site/`, `cli/README.md`, `CLAUDE.md` — 사이트 페이지(en/ko)와 문서.

## 커밋 (`git log --oneline 783c790..HEAD`, 결과 문서 커밋 제외)

```
19904ef docs(site): 인젝션 완화 문구를 '줄인다'로 고치고 meetings --cursor를 적는다
7f20371 fix(be): on_path를 로그인 셸 PATH로 판정하고 claude·codex 자식 PATH에 설치 위치를 붙인다
ad71763 feat(cli): damwha meetings에 --cursor와 다음 페이지 안내를 더한다
a16ab12 fix(cli): --version과 MCP serverInfo가 앱 버전을 보인다
49eec70 fix(cli): list_meetings·get_meeting 응답을 허용 목록으로 자른다
ca2b680 fix(cli): 다른 CLI·MCP 프로세스를 앱으로 오인하지 않는다
8e206d1 fix(cli): 제목 없는 회의에서 complete_lens가 죽지 않게 하고 확인 창의 bidi·폭 0 문자를 지운다
35fa361 docs: CLI · MCP 사이트 페이지와 README, CLAUDE.md
3df64a4 fix(fe): 연동 상태 로드 실패를 보이고 재시도하게 하며 접근성 이름을 더한다
c81ede5 feat(fe): 설정에 CLI · MCP 설치 섹션
5d7e328 fix(cli): 빌드가 출력 디렉터리를 만들고, 런처 테스트에 공백 경로를 더한다
900743d feat(desktop): CLI를 번들에 싣고 런처·번들 검사를 더한다
ba6f878 fix(desktop): api.json을 정지·종료 중에도 확실히 지운다
456e1c9 feat(desktop): API 포트 파일과 인스턴스 nonce, CLI 런처 경로 주입
2605b5f fix(cli): complete_lens 거절·닫기·확인 실패를 구분해 이유를 돌려준다
942fc26 feat(cli): complete_lens — elicitation 수락일 때만 완료
83933b4 fix(cli): get_meeting_status의 오류 문장을 untrusted_meeting_data 아래로
f82bab5 feat(cli): MCP 서버 읽기 도구와 upload_audio
6da9aec fix(cli): Ctrl-C는 걸린 요청에서도 바로 끝낸다(--wait 0, 그 밖 130)
daceab5 feat(cli): upload·search·meetings·lenses·transcript·status 명령
0439184 feat(cli): 업로드 옵션 검증과 multipart 매핑, 메시지 ko/en
ef9b078 feat(cli): 패키지 골격·앱 연결 판정·API 클라이언트
02ac9cb fix(be): 연동 GET은 클라이언트별 mcp get 실패를 registration.error로 가둔다
1d12823 feat(be): 데스크톱 전용 연동 설치 API /integrations
7f27b09 feat(be): Claude Code·Codex MCP 등록·해제
a3fcb3f fix(be): CLI 링크 설치의 inspect-쓰기 경합에서 남의 파일을 덮지 않는다
b8151b5 feat(be): CLI 링크 판정·설치 로직과 연동 게이트
debaafa fix(be): 실패한 회의의 후속 단계는 skipped, 커서 sort_at·id 엄격 검증
e89a25a feat(be): 회의 목록 keyset 페이지와 status 단계별 상태
7d7c4f1 feat(be): 전사 페이지 조회 GET /meetings/:id/transcript
e7f8094 feat(be): 렌즈 단건 조회 GET /lenses/:id
021f7d1 feat(be): health 응답에 desktop 인스턴스 nonce를 싣는다
0478020 docs(plan): CLI · MCP 구현 계획 16개 task, spec의 링크 판정 경로 정정
e115942 docs(spec): CLI · MCP 설계 — 렌즈 조회·업로드 MCP, elicitation 완료 확인, 앱 설정 원클릭 설치
```

진행 방식: 작업마다 새 서브에이전트가 구현하고 다른 서브에이전트가 spec 준수·품질을 검토했으며, 지적은 작업별 수정 라운드로
고쳤다. 마지막에 브랜치 전체(`783c790..35fa361`)를 한 번 더 검토했고(준비 안 됨: Critical 1, Important 2 등 10건), 지적을
한 번의 수정 파동(`35fa361..19904ef`, 7커밋)으로 모두 고쳤다. 재검토에서 10건 모두 해결, 새 Critical·Important 없음.

## 검증

| 패키지 | 명령 | 결과 |
| --- | --- | --- |
| be | `cd be && pnpm exec jest test/integrations` | 6 suites, 73/73 (testcontainers Postgres의 `integrations.e2e-spec.ts` 포함) |
| be | `pnpm --filter damwha-be exec jest --runInBand` (전체, Task 7 시점) | 1008 tests 통과 |
| be | `cd be && pnpm exec tsc --noEmit -p tsconfig.build.json` | 통과 |
| cli | `pnpm --filter damwha-cli exec vitest run` | 8 files, 113/113 |
| cli | `pnpm --filter damwha-cli run lint` / `run build` | `tsc --noEmit` 통과 / 빌드 통과, `node cli/dist/damwha.cjs --version` = `0.4.5`(= `desktop/package.json`) |
| cli | `node cli/dist/damwha.cjs status --json` (앱 꺼진 상태) | `{"connected":false,"state":"not_running"}`, exit 2 |
| desktop | `pnpm --filter damwha-desktop exec vitest run` | 1272 통과 |
| desktop | 로컬 서명 `package` + `check-bundle` | `package` exit 0, check-bundle 51 PASS / 0 FAIL (CLI 검사 6개 포함) |
| fe | integrations 테스트 / 전체 `pnpm fe test` | 13/13 / 892 통과 |
| site | `pnpm --filter damwha-site run build` / check / test | 통과 (최종 수정 후 build는 `5 page(s) built`) |

각 중간 수정 커밋은 cli 전체 vitest와 `tsc --noEmit`을 돌린 뒤 커밋했다. RED 단계(테스트 먼저 실패)는 최종 수정 파동에서
cli 17건·be 1건 실패로 확인했다. Task 4·5는 구현자가 RED를 건너뛰어 이후 작업 지침에서 RED를 의무로 못박았다.

## C2 탐침 — elicitation 수락 경로

stub HTTP API(`DAMWHA_API_URL`)에 붙여 실행했고, 사용자의 실제 개발 DB와 `~/.claude.json`·`~/.codex/config.toml`은 건드리지 않았다
(MCP 서버는 실행마다 임시로 붙였고, 끝난 뒤 설정에 `damwha-dev`가 없음을 확인했다). stub은 `complete` 호출을 기록한다.

처음 `claude -p`(기본 권한)와 `codex exec`는 도구 승인 단계에서 거절돼 서버의 elicitation까지 가지 못했다. 검토에서 이 두
구성이 비어 있다는 지적이 나와, 도구를 미리 승인해 다시 돌렸다.

| # | 구성 | 관찰 | `complete` 호출 |
| --- | --- | --- | --- |
| 1 | `claude -p --allowedTools=…` (도구 사전 승인) | elicitation 도달, 클라이언트가 `cancel`. 처음 사전 승인 없이 돌린 실행은 권한 거절로 서버 이전에 멈춤 | 없음 |
| 2 | `claude -p --permission-mode bypassPermissions` | elicitation 도달, 클라이언트가 자동 `cancel` | 없음 |
| 3 | `codex exec -c mcp_servers.damwha-dev.default_tools_approval_mode="approve"` | elicitation 도달, `decline`. 처음 승인 설정 없이 돌린 실행은 approval policy never로 거절 | 없음 |
| 4 | Claude Code 2.1.304 대화형(사용자 기본 auto 모드, tmux) | 권한 프롬프트 없이 도구 실행, elicitation 창이 51초 넘게 대기. Decline 시 에이전트가 "거절됨"을 전달. 두 번째 요청에서 Accept | Decline 0회, Accept 정확히 1회 |
| 5 | Codex 0.163.0 TUI (tmux) | 첫 프롬프트는 MCP 시작과 경합해 도구가 목록에 없었음. 재시도에서 Codex 도구 승인(Allow once) 뒤 담화 elicitation 창. Deny 시 "사용자가 거절해 완료 처리하지 않았습니다" | Deny 0회, 재시도 Allow 정확히 1회 |

모든 구성에서 사람의 수락 없이 `accept`가 온 경우는 없었다. 대화형 두 구성에서 사람 수락만 완료로 이어지는 것을 확인했다.

## 컨트롤러 e2e

**읽기 전용 CLI · MCP vs 실제 개발 API** (`DAMWHA_INSTANCE=e2e-check`): health가 인스턴스를 되돌려줌. CLI `status`·`meetings`·
`meeting`·`transcript`(`--limit 3`, 다음 offset 표시)·`lenses`·`search` 정상. `lenses --mine`은 `is_me` 화자가 없으면 noMeSpeaker로
exit 1. 없는 파일 업로드는 exit 1, `--preset bad`는 허용값을 알리며 exit 1. MCP stdio에서 도구 8개(elicitation 미지원 클라이언트에는
`complete_lens` 숨김), `list_lenses`가 데이터를 돌려줌.

**실제 원클릭 설치 (API 직접 호출, 사용자 승인, 끝난 뒤 복원)**: 시작 전 `~/.local/bin/damwha` 없음, claude·codex에 damwha 등록 없음.
`DAMWHA_CLI_LAUNCHER=desktop/build/cli/damwha`로 GET은 absent/none/none, `on_path` true(로그인 셸). `claude-code/install`·`codex/install`
POST 뒤 링크 current, 둘 다 ours. `~/.local/bin/damwha`가 개발 런처를 가리켰고 `--version` 0.4.5, `meetings`가 실제 데이터를
보임. `claude mcp get damwha` Connected(user scope, command `~/.local/bin/damwha mcp`), `codex mcp get damwha` enabled. DELETE
`claude-code`·`codex`·`cli` 모두 204, 링크 사라짐, 두 클라이언트 등록 해제, 설정 파일에 damwha 항목 없음을 확인해 원상 복구했다.

## spec 성공 기준별 판정

| 기준 | 판정 | 근거 | 남은 것 |
| --- | --- | --- | --- |
| C1 MCP 조회(렌즈 목록·상세, 회의 목록·상세, 검색, 전사) | 충족 | MCP stdio에서 도구 8개, `list_lenses` 실데이터, 도구 단위 테스트(허용 목록 응답 포함), 실제 등록한 Claude Code·Codex 연결 확인 | 에이전트가 모든 조회 도구를 실제 실행한 기록은 없다(단위 테스트와 stdio 호출 수준) |
| C2 accept일 때만 완료 | 충족 | 5개 구성 탐침에서 사람 수락 없는 `accept` 없음, 거절·취소·시간 초과는 이유가 구분돼 변경 없음(`2605b5f`), 완료 창의 bidi·폭 0 문자 제거 | 담화는 `accept`를 사람이 눌렀는지 검증하지 못한다(spec 결정). 사용자가 직접 자동 수락을 설정한 환경은 그 설정을 따른다 |
| C3 `damwha upload`·`upload_audio`, `--wait` | 부분 충족 | 업로드 옵션 검증·multipart 매핑·계약 테스트, 잘못된 입력 exit 1, `--wait` 폴링·Ctrl-C 종료 테스트 | 실제 worker에 붙인 `upload --wait` 완료까지의 실행은 하지 않았다(쓰기 e2e 제외) |
| C4 `search`·`meetings`·`meeting`·`lenses`·`transcript` | 충족 | 실제 개발 API 대상 읽기 e2e에서 전부 정상, `--cursor`·페이지 안내 추가 | — |
| C5 설정 화면 버튼으로 설치·등록·해제, 수동 명령 복사 | 부분 충족 | 설치·등록·해제를 API로 직접 호출해 실제 설치·복원 확인, fe 테스트 13/13, 수동 명령은 화면과 같은 `manualCommands` | 설정 화면의 버튼은 클릭하지 않았다. 패키징된 앱에서의 설치도 하지 않았다 |
| C6 앱 종료 시 안내, 창만 닫힘은 정상 | 충족 | 앱이 꺼진 Mac에서 `status --json`이 not_running, exit 2. 다른 CLI·MCP 프로세스를 앱으로 오인하지 않게 고침(`ca2b680`), nonce 교차 확인, `api.json` 정지·종료 중 제거(`ba6f878`) | 개발 Electron은 api.json 경로로만 연결되고, api.json이 없는 "starting" 구간은 설치된 `Damwha.app`만 인식한다 |

미실행 항목:

- **공증된 DMG 실행** — 사용자 결정(2026-10-20)으로 이번에는 건너뛴다. 로컬 서명 `package`와 check-bundle 51 PASS까지만 확인했다.
- **설정 화면 버튼 클릭** — API를 직접 호출해 같은 작업을 확인했다.
- **실제 worker에 붙인 `upload --wait`** — 쓰기가 필요해 e2e에서 제외했다.
- **패키징된 앱에서 설치** — 하지 않았다.

## 판단 기록

작업 중 컨트롤러가 내린 판단과, 틀렸을 때의 비용이다.

1. 별도 worktree 없이 메인 체크아웃의 `feat/cli-mcp`에서 작업 — 틀리면 개발 편집이 사용자의 다른 작업과 체크아웃을 공유한다(시작 시 status는 깨끗했음).
2. Task 12 Step 5는 비대화형 탐침만 구현자가 돌리고 대화형 TUI는 나중으로 미룸 — 틀리면 C2 대화형 동작이 미확인으로 남는다(이후 컨트롤러가 tmux로 실측해 해소).
3. Task 14 로컬 `package`는 기존 signing.json 신원 사용, 키체인 신원이 없으면 서명 없는 `--dir` 빌드로 check-bundle — 틀리면 서명·공증 문제가 Task 16에서야 드러난다.
4. Task 15는 vercel-react-best-practices·web-design-guidelines 스킬 적용(훅 요구) — 틀려도 비용 없음.
5. Task 3: `limit=0`은 400 — 0이면 `next_offset`이 전진하지 않아 페이징이 끝나지 않는다. 틀리면 0을 보낸 클라이언트가 빈 페이지 대신 400을 받는다.
6. Task 4: process 실패 + 후속 행 없음 → summary·lens는 `skipped`(`pending` 아님) — `--wait`이 done/failed/skipped에서만 끝나므로 `pending`이면 영원히 멈춘다. 틀리면 "시작된 적 없음"과 구분이 안 된다.
7. Task 4: meeting.status `recording` → process `pending` — 틀려도 CLI에는 영향 없음(업로드는 recording 상태가 없다).
8. Task 5: 남의 링크나 없는 링크에 대한 `removeLink`는 조용한 no-op — DELETE는 멱등이어야 한다. 틀리면 UI가 아무것도 안 지워진 이유를 설명하지 못한다(상태는 foreign으로 보인다).
9. Task 6: `mcp get` 픽스처는 임시 HOME·CODEX_HOME에서 캡처 — 틀리면 실제 설정의 출력 형식과 조금 다를 수 있다.
10. Task 6: `mcp get` 파서는 Command/Args 줄을 읽고 `command==linkPath && args=="mcp"`일 때만 우리 것으로 판정(부분 문자열 규칙보다 엄격) — 틀리면 출력 형식이 바뀔 때 우리 등록이 other로 보이지만 교체는 가능하다.
11. Task 6: 없음은 exit 1 + 빈 stdout, 그 밖의 비정상 종료는 throw — 틀리면 특이한 실패가 "없음" 대신 오류로 나온다.
12. Task 6: npm 전역 bin을 알려진 경로에서 제외(plan 목록에 없음) — 로그인 셸 탐색이 zsh·bash의 npm·nvm 설치를 찾는다. 틀리면 `$SHELL`이 둘이 아닌 사용자는 "설치 안 됨"으로 본다.
13. Task 7: 한 클라이언트의 `mcp get` 실패가 `GET /integrations` 전체를 500으로 만들지 않도록 클라이언트별 오류 상태를 둔다 — 틀리면 fe가 상태 하나를 더 그려야 한다(`02ac9cb`로 반영).
14. Task 7: 설치 POST는 200 — 만든 리소스가 아니라 결과 상태를 돌려준다. 틀려도 비용 없음.
15. Task 8: `DAMWHA_API_URL`이 있고 health가 실패하면 `starting` — 개발 전용 재정의. 틀리면 잘못된 개발 URL이 "미실행" 대신 "준비 중"으로 읽힌다.
16. Task 10: 개발 스택 수동 확인은 끝에서 한 번의 e2e로 미룸 — 틀리면 실제 API 연동 버그가 늦게 드러난다(이후 e2e에서 확인).
17. Task 10: `run()`은 `cli/src/run.ts`에 두고 `main.ts`는 SIGINT와 `process.exit`만 — 틀려도 비용 없음.
18. Task 11: `list_meetings` 기본 limit 50 — 에이전트 컨텍스트 예산. 틀려도 비용 없음(커서로 나머지).
19. Task 12(Ruling 2 보완): 탐침은 stub API와 실행별 MCP 부착으로, 실제 DB·사용자 설정은 건드리지 않음 — 틀리면 등록된 서버의 elicitation 동작과 다를 수 있다.
20. Task 12: 대화형 TUI 탐침은 사용자에게 미룸 — 틀리면 대화형 C2가 사용자 실행 전까지 미확인(이후 컨트롤러가 tmux로 실측해 해소).
21. Task 13: 중복 게시를 닫힘 래치 대신 "제거한 인스턴스를 기억해 다시 게시하지 않는다"로 해결 — 복원·재시도가 같은 서비스를 다시 켜기 때문이다. 틀리면 같은 인스턴스 id의 재시작이 게시되지 않는데, 실행마다 `randomUUID`라 일어나지 않는다.
22. Task 14: `cli/build.mjs`가 esbuild 모듈 라벨의 `/.pnpm/`을 `/_pnpm/`으로 바꿈(brief 밖) — check-bundle §4가 번들 안 `/.pnpm/`을 금지한다. 틀리면 esbuild 출력이 바뀌어 이 경로가 런타임에 의미를 가질 때 깨지지만 check-bundle 스모크가 잡는다.
23. Task 15: 공유 클라이언트의 `ApiError`에 선택 필드 `details`(응답 본문) 추가 — 409 대상·500 이전 등록을 보이는 데 필요하다. 틀리면 모든 fe 호출처의 공유 타입이 바뀐다(선택·추가형).
24. Task 15: 교체 확인에 기존 `Dialog`(role=dialog) 사용, 새 AlertDialog 없음 — 틀리면 스크린 리더가 일반 대화상자로 읽는다.
25. Task 15: CLI 행 버튼은 보이는 글자 이름만 유지(이미 행별로 구분됨) — 틀려도 비용 없음.
26. Task 16: 분할 — 구현자는 Step 1(사이트·README·CLAUDE.md), Step 2 공증은 사용자 확인 후, Step 3 보고서는 e2e·TUI 탐침·공증 결정 뒤, Step 4 graphify는 마지막 — 순서만의 문제.
27. 최종: `meetings`의 다음 커서 안내는 stderr — stdout을 파이프에 쓸 수 있게 한다(`lenses` 개수 줄과 같은 방식). 틀려도 비용 없음.
28. 최종: `get_meeting`의 화자 이름은 `clusters[].speaker_name`에서 — 상세 응답에 `speakers` 필드가 없다. 틀리면 클러스터가 없는 화자가 빠진다.
29. 최종: `api.json`의 `app_pid`는 "살아 있고 `damwha.cjs` 프로세스가 아님"이면 수용하고 신원은 health nonce로 증명 — 개발 Electron이 연결된다. `api.json` 없는 "starting" 판정은 설치된 `Damwha.app`만 인식. 틀리면 pid가 재사용된 낡은 `api.json`이 "미실행" 대신 "준비 중"으로 읽힌다.
30. 최종: `plainForPrompt`는 U+2028·2029를 공백으로 바꿈 — 단어가 붙지 않게 한다. 틀려도 비용 없음.

## 남은 minor

최종 검토가 머지를 막지 않는 것으로 본 보류 항목이다.

- **be 연동**
  - `isExecutable` 실구현(정규 파일 + X_OK)은 Task 7에서 처리됨. 남은 것: `clients.ts`의 `\s*`가 빈 필드에서 줄을 넘음(`[ \t]*`로), 중복된 run 함수 타입, `runCommand` 타임아웃·maxBuffer 거부 경로 테스트 없음.
  - 교체는 제거 뒤 추가라 추가 실패 시 이전 항목이 사라짐(오류에 이전 명령은 포함), 범위 지정 없는 `mcp get`이 local·project 범위 damwha와 섞일 수 있음, 명령 실패가 500(502가 더 정확).
  - 링크 설치 후 `registerClient` 충돌 시 링크만 남음(무해), `removeLink`의 inspect-unlink 경합(주석만), 디렉터리가 링크 경로에 있으면 `isFile:true`로 보고, 임시 symlink 뒤 중단 시 `.tmp-*` 잔존, `target === launcher` 문자열 비교(resolve 필요), `other_damwha`가 실존 대상을 가리키는 경우 테스트 없음.
  - `loginShellPath`가 GET마다 실행됨(재검토 지적), 실제 `integrationsEnabled(loadEnv())` 팩토리(HOST=0.0.0.0, 런처 미설정) 테스트 없음.
- **be 회의·렌즈·health**
  - health 컨트롤러가 요청마다 `loadEnv()`로 전체 스키마를 파싱, 빈 문자열 `DAMWHA_INSTANCE`가 `''`로 통과, `LENS_ID_RE` 중복, 전사 `findById`+COUNT+페이지가 트랜잭션 밖, `listPage`의 `LIST_SELECT.replace` 문자열 패치, `getStatus`의 non-null 단언(삭제 경합 시 500), `parseTranscriptInt` 재사용(`parseQueryInt`로 개명), 조인된 `speaker_name` 비-null 테스트와 500행 초과 clamp 테스트 없음.
- **cli 연결·명령**
  - `api.json` 포트 범위 검사 없음, `DAMWHA_API_URL` 끝 슬래시, 2xx 비-JSON 본문과 fetch 네트워크 오류의 원시 예외, 실제 `run()`/`fetchHealth` 래퍼 테스트 없음.
  - `--recorded-at`이 느슨한 `Date.parse`, `pickFlag`가 '1'/'yes'를 조용히 무시, 계약 테스트 임시 디렉터리 미정리.
  - 텍스트 모드 `upload --wait` 결과가 id와 렌즈 개수만 보임(단계별 최종 상태는 stderr), 실패한 process 뒤 `listLenses` 예외가 exit 3 보고를 덮을 수 있음, `act()`의 `any`와 `status.ts`의 미검사 캐스트, `--wait` 폴링 중 일시적 네트워크 오류가 exit 1, 완료 직후 SIGINT가 waitInterrupted를 찍을 수 있는 좁은 경합.
- **cli MCP**
  - `deps.lang()`이 try 밖이라 `detectLang` 예외가 프로토콜 오류가 됨, `ApiRequestError.message`에 stripControl 없음, `initialized` 중복 시 "already registered", url 전용 elicitation 클라이언트 테스트 없음, `completeFailed`가 클라이언트 오류 첫 줄을 길이 제한 없이 되풀이, 스킴 없는 도메인이 `plainForPrompt`를 통과.
  - `INVISIBLE`이 U+00AD·U+061C·태그 블록을 놓침(재검토 지적), `list_meetings` 기본 limit·strip 및 `get_meeting` 제목 위치 테스트 없음, 상태 테스트가 `retry.error`·`search_index.error`를 직접 주입하지 않음(일반 워커가 덮음).
- **desktop**
  - 동시 갱신·빠른 재시작 순서 테스트 없음, `restartService`가 `stopped` 상태 없이 결과를 null로 만들어 옛 파일이 다음 ok까지 남음(nonce가 막음), `published===null`인 `removeNow`가 retired를 세우지 않음.
  - 런처 테스트에 공백 경로 케이스는 추가됨. 남은 것: node 없음 안내, check-bundle의 `HOME='/'` 경계, `build.mjs`의 `replaceAll('/.pnpm/')`이 번들 전체 텍스트를 바꾸는데 주석은 라벨만이라고 적음.
- **fe**
  - 안 쓰는 `group` 클래스, foreign 링크에 해결 안내 없음, 교체 다이얼로그가 닫힐 때 빈 명령이 번쩍임, PATH 복사와 CLI `other_damwha` 교체 테스트 없음, 코드·pre의 `aria-label`에 `role="region"` 필요, "PATH" 라벨 i18n 안 됨.
- **site·문서**
  - `verify-seo.mjs`가 랜딩 페이지만 다뤄 새 페이지의 canonical·hreflang은 수동 확인, 사이트의 수동 명령이 `manualCommands`의 q() 인용과 다름, ko `jsonNote` 문체(-세요/-요) 불일치.
- **절차**
  - Task 4·5의 RED 단계 누락과 Task 7 수정 보고의 RED/GREEN 요약 처리(원문 출력 아님).

## 알려진 불안정 be 테스트

전체 be 스위트에서 일시적인 supertest 실패를 두 번 봤다(Task 3, Task 4). 재현되지 않았고 단독 실행은 통과했다.
`access-control.e2e-spec` §10이 의심되지만 확인하지 못했다. 이 브랜치의 변경과의 관계도 확인하지 못했다.
