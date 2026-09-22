# Electron Phase 6a — 서명·배포 실행 결과

스펙: [2026-09-20-electron-phase-6a-signing-distribution-design.md](../specs/2026-09-20-electron-phase-6a-signing-distribution-design.md)
계획: [2026-09-20-electron-phase-6a-signing-distribution.md](../plans/2026-09-20-electron-phase-6a-signing-distribution.md)
원장: `.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/progress.md`
브랜치: `feat/electron-migration-phase-6a-signing-distribution` (base `dev` = `1b92190`)

## 0. 이 문서의 범위 — Task 13이 앞당겨졌다

계획 순서는 Task 11(릴리스 발행) → Task 12(두 번째 맥) → Task 13(이 문서)이지만, 사용자가
"Task 13을 먼저 한다"를 골라 순서를 13 → 11 → 12 → 13 보충으로 바꿨다(원장 Ruling R19,
2026-09-21). 이유: Task 13을 먼저 하면 태그가 문서까지 정리된 HEAD를 가리킨다.

그래서 이 문서는:

- **T1~T10의 결과는 지금 완성한다** — 아래 §1·§2·§7.
- **T11(릴리스 발행)·T12(두 번째 맥)의 결과 칸은 "진행 전"으로 비워 둔다** — §6. 추측으로
  채우지 않는다. 두 Task가 끝난 뒤 짧은 보충 커밋으로 채운다.
- 스펙·계획 정정, 로드맵 갱신은 이 Task(13)의 몫이라 같이 마쳤다.

## 1. Task별 실행 요약 (T1~T10)

| Task | 범위 | 커밋 범위 | 리뷰 | 비고 |
| --- | --- | --- | --- | --- |
| T1 | postgres·ffmpeg를 macOS 15.0 타깃으로 소스 빌드 | `b47f29b..bd0d61f` | Approved, 수정 라운드 없음 | — |
| T2 | mlx·mlx-metal을 macOS 15.0 휠로 고정 | `bd0d61f..6010470` | Approved, 수정 라운드 없음 | 계획의 sed 정규식 결함을 구현자가 발견·수정(계획 본문도 고침) |
| T3 | minos 판독기 + check-bundle 전수 단언 | `6010470..e64f9ff` | Needs fixes(Critical 1·Important 1) → 1회 수정 → clean | **Ruling R7** — 계획이 준 정규식이 `LC_BUILD_VERSION` 하위 `tool LD` 레코드를 잘못 집어 `readMinos("/bin/echo")`가 `27037.1`을 냄. 로드 커맨드 블록 단위 파싱으로 고침 |
| T4 | `Info.plist` `LSMinimumSystemVersion`·probe 그물시험 | `e64f9ff..f5e0d81` | Approved, Critical·Important·Minor 0 | 세션 끊김 후 산출물을 검증으로 이어받음(Ruling R8). minos 전수 스캔 521개 Mach-O, 벽시계 ~3분 |
| T5 | ad-hoc → Developer ID 서명 전환 | `f5e0d81..0dcef63` | Needs fixes(Important 2·Minor 6) → 1회 수정 → clean | **Ruling R10**(ShipIt에 hardened runtime 추가 — electron-builder 기본값 퇴행 수정), **Ruling R11**(postgres의 runtime 없는 실행 파일 32개는 전역 제약이 시킨 것이라 T6로 이관). 예상과 달리 HF 토큰 재입력이 필요 없었다(미해명, §2 P6a-C12) |
| T6 | 공증·스테이플·DMG (발행 제외) | `0dcef63..847e2dd` | Needs fixes(Important 3·Minor 6) → 1회 수정 → clean | **Ruling R12**(스펙의 전역 제약을 뒤집음 — postgres에도 hardened runtime, 아래 §3), **Ruling R13**(desktop/CLAUDE.md 즉시 정정), **Ruling R14**(534MB zip 누수 정리) |
| T7 | worker 모델 다운로드 전 디스크 여유 점검 | `847e2dd..f84d52c` | Approved(Important 1) → 1회 수정 → clean | 배치 위치가 계획이 한 번 틀렸던 자리(우회 분기를 놓치는 자리)를 회피했음을 리뷰·회귀 테스트로 확인 |
| T8 | 업로드 중 ENOSPC → HTTP 507 | `f84d52c..9ae6e63` | Approved(Important 2) → 1회 수정 → clean | **Ruling R15** — 계획이 준 정리 코드(`tempFileOf`)가 실제 ENOSPC 오류엔 `.path`가 없어 절대 안 돌던 것을 요청 스코프 파일명 추적으로 고쳐 실제로 돌게 만듦 |
| T9 | 화면에 디스크 부족 사유 표시 | `9ae6e63..a368f12` | Approved(Minor 3), 수정 라운드 없음 | 구조 이탈 둘(공유 axios 인터셉터에 배치, 2부 `UploadError` 대신 단일 메시지)을 리뷰어가 개선으로 판정. **P5-C6이 이 시점 worker(T7)·API(T8)·화면(T9) 세 조각으로 닫힘** |
| T10 | packaged 통합 검증 + LLM 경로 디스크 부족 수정 | `a368f12..9791bcf` | Needs fixes(Important 4) → 1회 수정 → clean | 데이터 오염 사고(§4), **Ruling R16**(사용자 승인 — LLM 경로 디스크 부족을 Phase 6a 안에서 고침), **Ruling R17**(desktop/out 무효화→재패키징), **Ruling R18**(장수 릴레이 스레드로 재작성) |

## 2. 완료 기준 판정 — P6a-C1~C14

환경 표기는 스펙 §10 그대로: **static** = `check-bundle.mjs`/빌드 단언, **packaged** = 이 맥에서
`desktop:build`(또는 `--release`) 산출물, **원격** = 두 번째 맥(T12).

| ID | 기준 | 판정 | 증거 |
| --- | --- | --- | --- |
| P6a-C1 | 번들 Mach-O 전수의 `minos` ≤ 15.0, asar 안 Mach-O 0개 | **충족** | T4 구현(521개 Mach-O 전수 스캔 — postgres 66 + python·ffmpeg 455, probe로 27.0 하나 심어 exit 1 확인 후 제거해 exit 0), T10 재패키징에서도 `every Mach-O in the bundle targets macOS 15.0 or lower` PASS로 재확인 |
| P6a-C2 | `Info.plist`의 `LSMinimumSystemVersion=15.0`, `CFBundleShortVersionString`이 `package.json`과 일치 | **충족** | T4 리뷰가 세 자리 리터럴(`minos.mjs:10`, `build-target.sh:12`, `electron-builder.yml:37`) 일치를 직접 확인. T10 재패키징에서도 유지 |
| P6a-C3 | `.app`·DMG 전수가 Developer ID `L5Y9SZHGRN` 서명, python·ffmpeg(+R12 이후 postgres)에 hardened runtime | **충족** | T5(identity·TeamIdentifier 전수), T6 §14b(postgres 66/66 runtime), T10 재패키징에서 `postgres 66/66`·`python+ffmpeg 454/454` runtime PASS 재확인. 원래 완료 기준 문구의 "postgres 트리는 identity만"은 R12로 뒤집혔다(spec §3-3 정정 참고) |
| P6a-C4 | 공증 통과 + 스테이플 (`--release`) | **충족 (T11, 최종 발행판)** | T6은 T7~T10(디스크 부족 세 경로, R16)을 포함하지 않은 중간 산출물로 메커니즘만 확인(`.app`=`54dd2674-3806-4f12-8187-0ac8c50c10f6`·DMG=`cd12be62-dc47-49ff-87b3-1d8599ce8fe7`). **T11이 태그 `desktop-v0.3.0`(SHA `1a1a90e1db74d4808b413c9c46c8768b675400cd`)의 최종 HEAD로 재패키징·재공증** — `.app`=`e466e580-fddd-44de-bdbe-47c0953e8f79`·DMG=`2151eb74-a49d-449b-a2e8-63228a41bdfb` 둘 다 Accepted |
| P6a-C5 | 릴리스 빌드에서 태그·버전 어긋나면 멈춤 | **충족** | T6 Step 10b: 태그를 일부러 어긋나게 하고 `--release` 실행 → electron-builder 앞에서 exit 1 확인 |
| P6a-C6 | 디스크 부족 원인·복구 안내가 화면에 뜬다(worker job·embed·LLM 셋 + 업로드) | **충족(응답·계약 레벨) — 화면 렌더링 자체는 미관측. 단서 둘(최종 리뷰, §9): 렌즈 재추출 경로는 사유 미표시, 발행된 0.3.0의 "필요한 용량"은 과대 산정** | worker job·embed: T10 Step3 실측(`DISK_FULL`, 사유 문구 그대로). LLM: 최초 부분 충족(5분 뒤 `llm_request_failed`로 거짓 표면화) → **R16 수정 후 4.88초에 `DISK_FULL`로 충족**(task-10-report.md §fix round) — 그 실측은 요약(`summarize_meeting`) 경로이고 요약 카드가 `error.message`를 그린다. **렌즈(`extract_lenses`)만 다시 돌린 경우는 원인이 화면에 안 뜬다** — job에는 `DISK_FULL`이 남지만 API는 `extraction_status`만 주고 `insight-pane.tsx:380`은 "할 일과 결정을 찾지 못했어요."만 그린다(M3, API·FE 변경이 필요해 이 Phase 밖). **원인은 맞지만 숫자가 틀렸다** — 발행된 0.3.0은 저장소 전체를 세어 embed에 "필요한 용량 5.5 GB"를 냈다(embed가 실제로 받는 것은 2.3 GB, 고친 계산은 여유 계수를 포함해 2.7 GB — I1). 이 브랜치에서 고쳤고 사용자에게는 다음 릴리스로 닿는다. 업로드: T9가 FE 소비 로직을 unit·DOM 테스트로 고정하고 T10이 실제 API 응답이 그 모양(`{code:'DISK_FULL', free, needed:null}`)과 일치함을 소스 대조로 확인 — **실제 토스트 렌더링은 이 세션에 GUI 상호작용 권한이 없어 못 봤다**(T10 §7.1 Step1) |
| P6a-C7 | 업로드 ENOSPC → 507, 잔재 없음 | **충족** | T8(2MB HFS+ 이미지로 실측, `dw-upload-*` 잔재 0), T10 Step1/2 실측 — 507 `{code:'DISK_FULL', free:20250624, needed:null}`, `new_meetings=0`, `new_jobs=0`, 임시 파일 0개 |
| P6a-C8 | 디스크 부족 회차 뒤 기존 데이터 보존, 고아 행 없음 | **충족** | T10 Step5 — Phase 5 정합성 질의 넷 전부 0, `meeting`/`utterance` 행 수·`data/storage` 파일 수 불변 |
| P6a-C8b | 모델 다운로드 디스크 부족이 재시도 예산을 안 태움(worker job 경로) | **충족** | T10 Step3/4 — `job_198`(worker, DISK_FULL) attempts=1→failed, `job_199`(LLM, R16 수정 후) attempts=1→failed, 둘 다 `queued` 백오프 없음 |
| P6a-C9 | 두 번째 맥 Gatekeeper 없이 실행 | **충족 (T12)** | 사용자 실측(2026-09-22), 두 맥(맥 미니 — 이 프로젝트 clone 이력 없음, clone했던 맥 — 6a 이전 ad-hoc 빌드 실행 이력·기존 계정) 모두 macOS 26.x. Step 3 — 릴리스에서 받은 `desktop-v0.3.0` DMG의 sha256 일치. Step 4 — "확인되지 않은 개발자" 대화상자 없음(맥 미니: HF 토큰 창만 뜸). Step 5 — Wi-Fi 끈 상태에서 열림, `spctl`·`stapler validate` 대상 — 티켓이 앱에 스테이플됐다는 뜻 |
| P6a-C10 | 두 번째 맥 온보딩→다운로드→처리 `done` | **충족 (T12)** | Step 6 — 실오디오 1건 처리 정상 완료. 모델 다운로드 중 `DISK_FULL` 안 뜸 — **이 회차는 I1(필요 용량 과대 산정)이 남은 0.3.0에서 돌았다.** 그 맥의 여유가 과대 산정된 요구량보다도 컸다는 뜻이지 I1의 반증은 아니다(I1은 이 브랜치에서 고쳤고 0.3.1부터 반영 — §9.1) |
| P6a-C11 | 재빌드·재설치 후 TCC 마이크 권한·토큰 유지 | **깨끗한 설치 경로에서 충족 — 한계 있음 (T12)** — 스펙이 "이 Phase에서 가장 값진 기준"으로 꼽음 | Step 7 — 0.3.0→0.3.1(같은 DR, `certificate leaf[subject.OU]=L5Y9SZHGRN` 글자 그대로 동일. 0.3.1은 I1·I3 수정을 담은 로컬 서명·공증 빌드를 AirDrop으로 옮김, 공개 릴리스 아님 — 사용자 결정 R24. 공증 `.app`=`8ae8e966-4b86-48f8-8d8d-c608f77815ed`·DMG=`23cb2256-dbbb-4128-89d8-0304accdac9d` 둘 다 Accepted)로 덮어쓴 결과: **맥 미니(6a 이전 빌드 실행 이력 없음)는 마이크·토큰·키체인 전부 재요청 없음** — 이 Phase가 노린 신규 사용자 경로에서 충족. **clone했던 맥(6a 이전 ad-hoc 빌드 실행 이력이 있는 기존 계정)은 토큰 재입력·마이크 재요청은 없었으나 키체인 접근 창이 1회 떴다**("… 키체인의 기밀 정보를 사용하려고 합니다 … 'login' 키체인 암호"). 두 맥의 유일한 차이가 그 ad-hoc 시대 키체인 잔재라 원인으로 보지만 **표본 1**이다. 0.3.0 첫 실행에서 왜 안 물었는지는 미설명(첫 맥의 P6a-C12 현상과 같은 부류) |
| P6a-C12 | ad-hoc→Developer ID 전환에서 토큰이 1회 무효화되고 크래시 없이 온보딩으로 떨어짐 | **미판정 — 전제가 실측에서 발생하지 않았다** | T5 Step 8과 T10 Step3(세 차례 모델 로드, gated repo 인증 포함) 모두 **토큰이 무효화되지 않고 재입력 없이 그대로 작동**했다. 예고된 퇴행(§9) 자체가 안 일어났으므로 "크래시 없이 온보딩으로 떨어지는지"는 시험된 적이 없다. 왜 무효화되지 않는지 T5·T6·T10 공통으로 미해명. **T12(2026-09-22)도 같은 패턴을 재확인했다** — 6a 이전 ad-hoc 빌드 이력이 있는 맥에서 0.3.1 덮어쓰기 때도 토큰 재입력은 없었고, 대신 키체인 접근 창이 1회 떴다(C11 참고). 발행된 릴리스 노트(R21, "토큰을 다시 묻는다면 한 번 다시 넣어 주세요")는 이 키체인 창을 묘사하지 않는다 — **노트 문구가 실제 경험과 다르다는 사실만 기록한다.** 노트 수정은 공개 상태 변경이라 사용자 결정으로 남겨 둔다 |
| P6a-C13 | DMG 안 `.app`도 서명·공증·스테이플 살아있음 (`--release`) | **충족 (T11, 최종 발행판)** | T6은 C4와 같은 이유로 중간 산출물만 확인. T11의 최종 DMG(SHA-256 `4b38d343a075628f93b5ee0a4f6e4f86160d81ecc9e1695bd99593d25011db92`)를 마운트해 안의 `.app`까지 재검증 — 공증 Accepted 둘 다(위 C4) |
| P6a-C14 | `desktop-v<version>` 태그로 릴리스 발행, DMG+SHA-256 자산 | **충족 (T11)** | 태그 `desktop-v0.3.0`을 최종 HEAD(SHA `1a1a90e1db74d4808b413c9c46c8768b675400cd`)로 재태깅 후 `gh release create`로 발행 — `https://github.com/Yjason-K/Damwha/releases/tag/desktop-v0.3.0`. DMG(sha256 `4b38d343a075628f93b5ee0a4f6e4f86160d81ecc9e1695bd99593d25011db92`) + `.sha256` 자산 첨부, 원격 `.sha256` 자산이 로컬 계산값과 일치함을 컨트롤러가 확인. **발행 직후 부작용 발견 — §8** |

## 3. 뒤집힌·추가된 판정 (Ruling)

스펙·계획의 문구를 뒤집었거나 계획에 없던 것을 더한 판정. 원장 전문은
`.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/progress.md`.

### R12 — 스펙의 전역 제약을 뒤집었다: `Resources/postgres`에 hardened runtime을 건다 (Task 6)

원래 제약(스펙 §3-3·§6, 계획 Global Constraints): "`Resources/postgres`에는 hardened runtime을
걸지 않는다. 별개 프로세스라 자기 서명의 플래그로 돈다." 첫 공증 제출
(`88197b1f-daae-41bc-aa68-e62176a321de`)이 **status=Invalid**, 오류 32건 전부
`Resources/postgres/bin/*`의 "The executable does not have the hardened runtime enabled."였다.
제약의 근거는 실행 시 동작이었지 공증 요건이 아니었다 — 공증은 번들 안 모든 실행 파일에
hardened runtime을 요구한다는 사실이 실측으로 확정됐다.

최소 변경으로 검증했다: postgres를 `--options runtime`으로 서명하되 entitlements는 주지
않는다. postgres 트리 전체(pgvector·pg_bigm 포함)가 이미 같은 Team ID(`L5Y9SZHGRN`)로
서명돼 있어 hardened runtime의 library validation이 entitlement 없이도 통과할 것으로 보고,
재제출로 확인했다 — **`.app` 제출 `54dd2674-3806-4f12-8187-0ac8c50c10f6`, DMG 제출
`cd12be62-dc47-49ff-87b3-1d8599ce8fe7` 둘 다 Accepted.** 런타임에서도 검증됨: 재빌드한 앱을
띄워 postgres가 **pgvector 0.8.6·pg_bigm 1.2를 적재하며 뜨는 것**과 api·worker의 DB 연결을
확인했다. `check-bundle.mjs` §14b가 postgres 트리의 hardened runtime 플래그를 66/66 전수
단언하고, `{runtime:false}`로 재서명한 사본이 `flags=0x0(none)`으로 잡히는 회귀 시연도 했다.

스펙·계획 본문은 이 Task(13)에서 정정했다 — §정정 방식 참고.

### R16 — LLM 경로의 디스크 부족 결함을 Phase 6a 안에서 고쳤다 (사용자 승인, Task 10)

T10 packaged 검증 중 `mlx_lm.server`의 요청 처리 스레드에서 올라온 `DISK_FULL`이 Python 기본
스레드 예외 훅에 삼켜져, 사용자에게는 5분(`lens_llm_timeout_seconds`) 뒤 `llm_request_failed`/
"시간이 초과됐어요"로만 보이는 결함을 발견했다. 계획에 없던 코드 변경이라 사용자에게 먼저
물었다 — **"Phase 6a 안에서 고친다"로 승인받았다.** 근거: P6a-C6·P5-C6의 완료 기준은 "디스크
부족에서 원인과 복구 방법을 앱에서 확인 가능"인데, LLM 경로만 거짓 사유로 뜨면 세 경로 중
하나가 그 기준을 실제로는 못 채운다.

`be/worker/damwha_worker/llm_server.py`에 `run_guarding_disk_full`을 배선해 `DISK_FULL`
서명만 좁게 잡고 job을 그 자리에서 실패시켰다. `extract_lenses`도 같은 `managed_llm_server`
경로를 공유하는 것을 완전성 점검으로 찾아 함께 고쳤다. 격리된 testcontainer DB + 격리된
10MB HF 캐시 볼륨 + 실제 `mlx_lm.server` 서브프로세스로 실측: 5분 대신 **4.88초**, 거짓
`llm_request_failed` 대신 정직한 `code=DISK_FULL`. 리뷰 라운드에서 readiness 구간에 자식
stderr 파이프를 아무도 안 읽어 기동 실패 트레이스백이 유실되는 결함을 추가로 잡아 장수
릴레이 스레드로 고쳤다(R18). worker 테스트 713건 통과, ruff 클린.

### R10 — ShipIt에 hardened runtime (Task 5)

`package.mjs`가 Electron 프레임워크 안 `ShipIt`(Squirrel 업데이터, `MH_EXECUTE`)을 identity만
으로 서명해 electron-builder의 기본 서명 동작(`--options runtime`을 줌)에 대한 퇴행이었다.
공증이 실행 파일(dylib 아님)에 hardened runtime을 요구하는 것이 파일 종류로 갈린다는 사실을
리뷰어가 `/usr/bin/file -b`로 확인해 지적했고, `package.mjs:164`에 `--options runtime`을
더해 고쳤다. dylib 둘(`libvk_swiftshader`·`libffmpeg`)에 같이 붙여도 무해하다(플래그는 프로세스
주 실행 파일에서만 읽힌다).

### R17 — `desktop/out` 무효화 (Task 10)

LLM 경로 수정(R16)이 worker Python **소스**를 고쳤는데, 번들은 그 소스를 복사해 담으므로
당시 `desktop/out`은 수정을 담고 있지 않았다. "산출물을 재사용할 수 있게 뒀다"는 이 결과
문서 §7.4의 원래 문장이 이 전제를 깔고 있어 틀렸다 — 리뷰가 지적해 `desktop/out`을 통째로
`rm -rf`했다(`.DS_Store`로 인한 `ENOTEMPTY`를 피하려 파일만 지우지 않고 디렉터리째).

**정정 — 이후 재생성 사실이 §7.4에 이어서 적혀 있었으나 문단이 "rm -rf했다"로 끝나 재생성을
안 적은 것처럼 읽히는 부정확성이 리뷰에서 다시 지적됐다.** 실제로는 같은 fix round 안에서
재패키징까지 마쳤다(§7.6.1) — `desktop/out`은 **지금 존재하고**, R16 수정을 담은 번들이다
(`cmp` 4/4 SAME 확인, `check-bundle` 39/39 PASS). §7.4에 추가 정정 블록을 달았다. Task 11은
그래도 발행 시점 HEAD를 정확히 담기 위해 다시 `rm -rf out` 후 재패키징·재공증한다 — "재사용
금지" 방침 자체는 유효하다.

### 그 외 — 표로 요약

| Ruling | 요지 | 성격 |
| --- | --- | --- |
| R1 | worktree를 만들지 않는다(로드맵의 브랜치 운영 방식 원칙) | 계획 실행 방식, 스펙 불변 |
| R2 | `MAX_MINOS`를 `package.mjs`에서 안 들여온다(발행이 T11로 빠져 쓸 곳 소멸) | 계획 본문 정정(당시 반영) |
| R3 | T4 probe가 서명 단언도 함께 깨뜨리는 것을 받아들인다 | 계획 설계 확인, 변경 없음 |
| R4 | T11·T12 앞에서 멈추고 사용자에게 묻는다(되돌리기 어려움·부수효과) | 실행 순서 게이트 |
| R6 | 계획의 "되돌리는 법" 표가 틀렸다 — python 캐시는 옛 층이 안 남는다 | 계획 본문 정정(당시 반영) |
| R7 | minos 정규식이 `LC_BUILD_VERSION` 하위 `tool` 레코드를 잘못 집는다 | 계획 결함 → 구현 수정(§1 T3) |
| R8 | 세션 끊김 뒤 Task 4를 처음부터 다시 돌리지 않고 검증으로 이어받는다 | 실행 판단, 스펙 불변 |
| R9 | Task 5 우려4(테스트 자리표시자 정정)는 옳은 선택으로 확정 | 실행 판단 |
| R11 | postgres의 runtime 없는 실행 파일 32개는 (당시) 전역 제약이 시킨 것이라 T6로 이관 | R12로 최종 해소 |
| R13 | `desktop/CLAUDE.md`의 낡은 postgres-runtime 문구를 즉시 정정(R12 후속) | 운영 문서 정정 |
| R14 | 공증 실패 시 534MB zip이 안 지워지는 Minor를 즉시 수정 | 구현 버그 수정 |
| R15 | 업로드 임시 파일 정리 코드가 실제 ENOSPC에서 절대 안 돌던 것을 실제로 돌게 고침 | 계획 결함 → 구현 수정(§1 T8) |
| R18 | LLM 경로 감시를 호출당 스레드에서 `popen()` 직후 장수 릴레이 스레드로 재작성 | R16의 리뷰 수정 |
| R19 | 실행 순서를 13 → 11 → 12 → 13 보충으로 재배치(사용자 결정) | 실행 순서 |

## 4. 데이터 오염 사고 — 투명성 기록

Task 10 작업 중 실제 개발 DB·저장소가 두 차례 오염됐다. 둘 다 packaged 앱을 포트 3000(기존
`pnpm be:dev`가 이미 점유해 실제로는 다른 포트로 물러나 있었음)으로 착각해 요청을 보낸
것이 원인이다.

- **`mtg_39`(1차, Task 10 첫 시도 중).** 구현자가 "즉시 되돌렸다(0 rows / 파일 제거 확인)"고
  보고했으나 **컨트롤러가 직접 확인한 결과 되돌려지지 않았다** — `be/storage/meetings/mtg_39/
  original.bin`(100000바이트)과 DB `meeting` 행이 여전히 남아 있었다. 테스트 산물임을
  제목(`normal-upload-sanity-check`)과 생성 시각으로 확정한 뒤 **사용자 승인을 받고 컨트롤러가
  직접** 삭제했다(`meeting` 1행 + `job` 1행 DELETE, 디렉터리 `rm -rf`). 삭제 뒤 실제 회의 11개가
  온전함을 재확인했다 — 실 데이터 손실 없음.
- **`mtg_40`(2차, Task 10 재개 후).** 같은 원인(포트 3000 오인)으로 재발했으나 이번엔 `lsof`로
  즉시 발견해 자체적으로 되돌렸다(§7.1 "실수와 정정" 참고) — `DELETE 1`(meeting) + 저장소
  디렉터리 삭제, 0행으로 재확인됨.

두 사고 모두 packaged 앱이 포트 충돌 시 조용히 다른 포트로 물러나는 것이 원인이다(오류 없이
동작 자체는 의도된 것으로 보인다). T10 결과(§7.5 우려 3)가 "검증 절차에 먼저 lsof로 실제
포트를 확인하라는 한 줄을 넣을 가치가 있다"고 남겼다.

## 5. 남은 제약

- **macOS 15.0은 여전히 선언·단언까지만 증명됐다.** 이 맥(컨트롤러)이 26.x라 정적 검증은
  `LSMinimumSystemVersion=15.0` 선언과 `minos ≤ 15.0` 전수 단언(P6a-C1·C2)까지만 닿았다.
  **T12(두 번째 맥 종단간 검증)도 같은 자리에서 멈춘다** — 맥 미니·clone했던 맥 둘 다 macOS
  26.x였다(사용자 보고, 두 맥 모두). 증명된 것은 26.x 실행과 15.0 선언·단언이고, 15.0 맥에서의
  실제 실행은 여전히 증명되지 않았다(스펙 §11-3, T12 브리프 Step 8). 15.x 맥이 생기면 그때 1회
  확인한다.
- **두 번째 맥에 개발 도구가 시스템 전역으로 남아 있다.** T12가 새 사용자 계정으로 검증해도
  `/opt/homebrew`·`/usr/local`은 시스템 전역이라 지워지지 않는다(스펙 §11-6). T12가 증명하는
  것은 "개발 환경이 전혀 없는 맥"이 아니라 "개발자 계정 밖"이다. **실측에서 그 전제 자체가 한
  대는 더 어긋났다** — 브리프 Step 1은 새 사용자 계정을 요구했으나, clone했던 맥은 6a 이전
  ad-hoc 빌드를 실행한 **기존 계정**으로 시험됐다(그 계정에 남은 키체인 잔재로 알게 됐다). 이
  편차가 오히려 "6a 이전 빌드에서 올라온 경로"라는 추가 표본을 줬다 — 아래 C11 한계와 같은
  근거다. 맥 미니의 계정 종류, 그리고 두 맥의 Step 2(개발 도구 목록 `which python3 uv brew
  docker node pnpm`)는 **미기록**이다.
- **6a 이전(ad-hoc) 빌드 이력이 남은 맥은 업데이트 때 키체인 암호를 1회 묻는다.** T12 관찰 —
  clone했던 맥(6a 이전 ad-hoc 빌드 실행 이력, 기존 계정)은 0.3.1 덮어쓰기 때 키체인 접근 창이
  떴다("… 키체인의 기밀 정보를 사용하려고 합니다 … 'login' 키체인 암호"). 그 이력이 없는 맥
  미니는 0.3.1 덮어쓰기에서 아무것도 안 물었다. 두 맥의 차이가 그 잔재 하나뿐이라 원인으로
  보지만 **표본 1**이라 확증은 아니다(§2 C11). 0.3.0 첫 실행에서는 왜 안 물었는지도 미설명이다.
- **`mlx` 15.0 휠의 런타임 동작은 26.x 호스트에서는 확인됐다.** T12 Step 6에서 실오디오 1건이
  두 맥(둘 다 26.x) 모두 끝까지 처리 완료됐다 — 15.0 타깃 휠이 26.x 호스트에서 전방 호환됨을
  실측으로 확인했다(스펙 §11-4). **15.0 맥 자체에서의 동작은 여전히 아무도 못 봤다** — 위
  첫 번째 항목과 같은 이유다.
- **개인 서명 키의 이 맥 밖 추가 백업이 됐는지 확인된 적이 없다.** 스펙 §3-7은 `.p12` 백업이
  `~/Documents/damwha-signing`(0700, 저장소 밖)에 있다고 적었고, §12 위험 1은 "이 맥 밖에 한
  벌 더 두는 것을 결과 문서에 남긴다"고 완화책을 적었다. 이 Phase의 어떤 Task 보고서·원장에도
  그 오프사이트 복사가 실제로 됐다는 기록이 없다 — **위치 미기재, 사용자 확인 필요.** ~~잃으면
  재발급 인증서가 다른 identity가 돼 기존 사용자의 TCC 마이크 권한·`safeStorage` 토큰이 전부
  무효화된다(같은 §12).~~ **정정(최종 리뷰 M1):** 잃어도 연속성은 끊기지 않는다 — 앱의 DR이
  인증서가 아니라 Team ID(`certificate leaf[subject.OU] = L5Y9SZHGRN`)에 묶여, 같은 팀으로
  재발급한 인증서로 서명한 앱도 같은 앱이다(§9). 잃은 비용은 폐기·재발급과 그동안 릴리스를 못
  내는 것이다. 백업은 여전히 권한다.

## 6. Task 11·Task 12

Ruling R19에 따라 순서가 13 → 11 → 12 → 13 보충으로 바뀌었다.

**T11(릴리스 발행)은 끝났다.** 태그 `desktop-v0.3.0`을 최종 HEAD(SHA
`1a1a90e1db74d4808b413c9c46c8768b675400cd`)로 재태깅 후 재패키징·재공증·`gh release create`로
발행했다 — 결과는 위 §2의 C4·C13·C14. **발행 직후 부작용이 하나 발견됐다** — 이 릴리스가
저장소의 "Latest"를 차지해 셀프호스팅 웹 배포의 버전 조회(`deploy/Makefile`)가 깨지는
사이드 이펙트다. 사실관계·완화·근본 수정은 §8.

**T12(두 번째 맥 종단간 검증, P6a-C9~C11)도 2026-09-22에 사용자가 직접 두 대에서 마쳤다** —
결과는 위 §2의 C9·C10·C11(그리고 C12 갱신), §5의 관련 한계. 스펙 §10의 완료 기준(`C1~C14` +
`C8b`, 15행 — C1~C8(8) + C8b(1) + C9~C11(3) + C12(1) + C13~C14(2)) 중 14건 충족(C9~C11 포함,
C11은 깨끗한 설치 경로 한정 + 6a 이전 빌드 이력이 남은 맥에서 키체인 창 1회 뜨는 한계), 1건
(C12)은 예고된 퇴행이 실측에서 일어나지 않아 여전히 미판정이다.

## 7. Task 10 상세 — packaged 통합 검증 (원문, Task 10 구현자 작성)

작업 디렉터리: `desktop/`. 대상 `.app`: `desktop/out/mac-arm64/Damwha.app`.
브리프: `.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-brief.md`.

### 7.0 재패키징 증거

Task 1~9 끝에서 `desktop/out/`이 `dfd6c1a`(Task 6 중간) 산출물이었고, 그 뒤 커밋
(`847e2dd`·`ad108df`·`f84d52c`·`ecdbf41`·`9ae6e63`·`a368f12`)이 번들에 들어 있지
않았다. 재패키징부터 했다.

```bash
cd desktop
rm -rf out
pnpm run package:desktop > /tmp/t10-package.out 2>&1   # 백그라운드, --release 없음(공증 재제출 안 함)
```

- 재패키징 당시 HEAD: `a368f128b7f7860ca688cc2e49633578fbfe3a1b`(작업 시작 시 git status 그대로, clean).
- `.app` 디렉터리 mtime: `Sep 21 13:21:11 2026`(빌드 시작 13:17 ~ 완료 13:26, 소요 약 9분).
- `check-bundle.mjs`가 `package.mjs` 안에서 함께 돌았다(39개 PASS, 0 FAIL):

```
$ node scripts/check-bundle.mjs
... (39줄)
PASS  every Mach-O in the postgres tree carries hardened runtime — 66/66 flags=…(runtime)
PASS  every signed arm64 Mach-O in the python and ffmpeg trees carries hardened runtime — 454/454 flags=…(runtime)
PASS  no __pycache__ under Resources/python — 0
PASS  every script in Resources/python/bin has a bundle-relative shebang
      (64 console script(s) checked)
PASS  every Mach-O in the bundle targets macOS 15.0 or lower

Bundle hygiene: all checks passed.
```

**번들이 T7·T8·T9를 실제로 담고 있다는 근거(직접 확인, 소스가 아니라 산출물):**

| 조각 | 번들 안 경로 | 확인 |
| --- | --- | --- |
| T7 (worker 디스크 점검) | `Contents/Resources/python/lib/python3.12/site-packages/damwha_worker/models/disk.py` | `diff`로 저장소의 `be/worker/damwha_worker/models/disk.py`와 **바이트 단위 동일** 확인 |
| T8 (API 507 필터) | `Contents/Resources/api/dist/storage/disk-full.filter.js` | 컴파일된 JS에 `rmSync`(임시 파일 정리)·`freeBytes`·`DISK_FULL` 셋 다 존재 확인 |
| T9 (화면 문구) | `Contents/Resources/api/dist/public/assets/demo-read-only-*.js`(fe SPA), `app.asar`의 `dist/diagnostics/causes.js`(데스크톱 메인) | fe 번들에 `DISK_FULL` 문자열 존재, `causes.js`에 `디스크 공간이 부족해요` 정규식과 문구 템플릿 존재 확인 |

`app.asar`는 `desktop/node_modules/.bin/asar`로 열었다(`list`/`extract-file`).

### 7.1 브리프의 검증 항목별 결과

### Step 1 — 업로드 ENOSPC 주입 실증

```bash
hdiutil create -size 20m -fs APFS -volname DamwhaTiny -type SPARSE tiny.sparseimage
hdiutil attach tiny.sparseimage -mountpoint /Volumes/DamwhaTiny   # ~19MB 여유
APP=desktop/out/mac-arm64/Damwha.app
TMPDIR=/Volumes/DamwhaTiny "$APP/Contents/MacOS/Damwha" &   # open 대신 실행 파일 직접 호출
```

**첫 시도가 틀렸다 — 그리고 잡아냈다.** 최초 `curl -X POST http://127.0.0.1:3000/api/meetings`는
패키지된 앱이 아니라 포트 3000에 떠 있던 **무관한 `pnpm be:dev` 서버**(`node be/dist/main`,
`nest start --watch`)를 쳤다. `lsof -iTCP:3000`으로 발견 — 패키지된 앱은 3000이 이미 점유돼
있어 자동으로 다른 포트(`62798`)를 골랐다. 그 첫 시도가 실 개발 DB(`localhost:5432`)와
`be/storage`에 `mtg_40`을 만들었으므로 **즉시 되돌렸다**(§4 "실수와 정정" 참고). 이후
`lsof -iTCP -sTCP:LISTEN | grep Damwha`로 패키지된 앱의 실제 포트를 확인하고 그 포트로 다시 했다.

25MB 무작위 바이트 파일을 그 포트로 업로드:

```
HTTP_STATUS:507
{"code":"DISK_FULL","free":20250624,"needed":null}
```

`api.log`:
```
[Nest] 17674  - 09/21/2026, 1:36:47 PM   ERROR [HTTP] POST /api/meetings 500 86ms — ENOSPC: no space left on device, write
[Nest] 17674  - 09/21/2026, 1:36:47 PM   ERROR [DiskFullFilter] 업로드 중 디스크가 찼다 — 남은 용량 20250624 바이트
```

**판정: 통과.** `TMPDIR`이 `ps eww <api pid>`로 확인한 대로 API 자식(`utilityProcess.fork`)까지
그대로 상속됐고(`api-process.ts`의 `apiChildEnv`가 의도적으로 상속 env를 깐다), multer의
`os.tmpdir()`가 그 값을 따랐다. `os.tmpdir()`가 `TMPDIR`을 따른다는 브리프의 전제가 실측으로
확인됐다.

화면(`디스크 공간이 부족해요 — 남은 용량 …`) 자체는 **GUI 상호작용 권한이 없어 렌더링을 직접
보지 못했다** — API 응답이 `fe/src/shared/api/client.ts`의 `diskFullMessage(free, needed)`가
소비하는 정확한 모양(`{code:'DISK_FULL', free:20250624, needed:null}`)이라는 것만 소스 대조로
확인했다.

### Step 2 — 업로드 실패가 아무것도 안 남겼는지 (P6a-C7)

```bash
UD="$HOME/Library/Application Support/Damwha"
PSQL="$APP/Contents/Resources/postgres/bin/psql"
"$PSQL" -h "$UD/run" -U damwha damwha -c "select count(*) as new_meetings from meeting where created_at > now() - interval '5 minutes';"
"$PSQL" -h "$UD/run" -U damwha damwha -c "select count(*) as new_jobs from job where created_at > now() - interval '5 minutes';"
find /Volumes/DamwhaTiny -iname "dw-upload-*"
```

결과: `new_meetings=0`, `new_jobs=0`, 임시 파일 0개, 전체 `meeting`/`job` 행 수가 시도 전(11/65)과
동일. **판정: 통과.**

### Step 3 — 모델 다운로드 디스크 부족 재현 (P6a-C6·C8b), 주체 셋

**주입 방법.** `HF_HUB_CACHE` 환경변수 오버라이드는 **먹히지 않는다** — `desktop/src/config/config.ts`의
`STRIPPED_CHILD_ENV_KEYS`가 상속 env에서 `HF_HUB_CACHE`(+`TRANSFORMERS_CACHE`·`TORCH_HOME`·
`XDG_CACHE_HOME`)를 명시적으로 지운다("HF_HOME 하나가 모두를 이긴다"). `HF_HOME`도 마찬가지로
`appOwnedChildEnv`가 `<userData>/models`로 강제 고정해 env로 못 바꾼다. 그래서 **파일시스템
레벨로 캐시 자체를 옮겼다** — 브리프가 예시한 "HF 캐시를 작은 볼륨에 둔다" 그대로:

```bash
# 앱 정지 상태에서
mv "$UD/models" "$UD/models.real-backup"          # 실 캐시(8.8GB) 대피
ln -s /Volumes/DamwhaHFTiny "$UD/models"           # 8MB sparse volume(~7.6MB 여유)로 심볼릭 링크
```

**주체 1 — embed 기동.** 앱을 다시 띄우자 embed가 즉시 실패했다:

```
damwha_worker.errors.WorkerError: DISK_FULL: 디스크 공간이 부족해요 — 남은 용량 8.0 MB, 필요한 용량 5.5 GB.
```
`supervisor.log`:
```
embed: 기동 실패 — 3초 뒤 재시작 (1회차)
embed: 기동 실패 — 8초 뒤 재시작 (2회차)
embed: 기동 실패 — 20초 뒤 재시작 (3회차)
embed: 재시작 상한 3회를 넘겼다 — 수동 재시도를 기다린다
```
상한 있는 backoff 뒤 수동 재시도 대기로 정상 수렴. **PERMANENT 성격의 실패가 무한 재시작을
돌지 않는다** — 이 자체가 P6a-C8b의 정신(재시도 예산 보존)을 서비스 기동 경로에서도 지킨다는
방증.

**주체 2 — worker job(회의 카드).** 3초짜리 유효 WAV(`ffmpeg -f lavfi sine=440 -t 3`)를
같은 포트로 업로드(`mtg_109`/`job_198`). `pyannote/speaker-diarization-community-1`(gated
diarization 모델)이 캐시 미스로 실제 HF 메타데이터를 조회(`GET …?blobs=true → 200 OK`,
네트워크 접근은 됐다)한 뒤 디스크 부족으로 던졌다:

```sql
select id, status, attempts, max_attempts, next_attempt_at, error->>'code' as code, error->>'message' as msg
from job where id='job_198';
-- job_198 | failed | 1 | 5 | (null) | DISK_FULL | 디스크 공간이 부족해요 — 남은 용량 8.0 MB, 필요한 용량 40.4 MB.
select id, status, error->>'code' from meeting where id='mtg_109';
-- mtg_109 | failed | DISK_FULL
```
`worker.log`: `WARNING: job job_198 type=process_meeting failed: code=DISK_FULL kind=PERMANENT attempt=1/5`.
**판정: 통과.** job·meeting 둘 다 즉시 `failed`, `DISK_FULL`로 정직하게 표시.

**주체 3 — LLM 기동(상태 창).** 기존 `done` 회의(`mtg_107`, 이번 세션 이전부터 있던 테스트
데이터)에 `POST /api/meetings/mtg_107/summary/generate`로 수동 요약 재생성을 걸어 LLM 기동
경로를 탔다(`job_199`, type=`summarize_meeting`). `mlx_lm.server`가 뜨고 `/v1/models`
준비 프로브는 200으로 통과했지만(모델을 실제로 물지 않고도 응답 가능), 실제 채팅 요청이
지연 로드를 트리거하자:

```
Exception in thread Thread-1 (_generate):
...
damwha_worker.errors.WorkerError: DISK_FULL: 디스크 공간이 부족해요 — 남은 용량 8.0 MB, 필요한 용량 6.2 GB.
```

**이 예외가 job에 도달하지 않는다.** `mlx_lm.server`의 요청 처리 스레드(`Thread-1
(_generate)`) 안에서 일어나 Python 기본 스레드 예외 훅이 stderr에 찍기만 하고 삼킨다 — 그
스레드가 응답을 만들지 못한 채 조용히 죽는다. `summary_client.py`의 `httpx.Client`는
그 요청을 그냥 계속 기다리다가 `lens_llm_timeout_seconds`(기본 300초) 뒤에야 포기했다:

```
elapsed_ms=300014
job job_199 type=summarize_meeting failed: code=llm_request_failed kind=PERMANENT attempt=1/5
```

```sql
select error->>'code', error->>'message' from job where id='job_199';
-- llm_request_failed | timed out
```

**판정: 부분 충족.** 최종적으로 `attempts=1/5`, `status='failed'`, PERMANENT로 재시도 예산은
안 태웠다(Step 4의 요구는 만족) — 하지만 사용자가 보는 오류는 `DISK_FULL`이 아니라
`llm_request_failed`/"timed out"이고, 그 판정까지 **5분을 그대로 기다려야** 한다. 디스크
부족이 LLM 기동 경로에서는 정직하게 표면화되지 않는다. 아래 "우려"에 다시 적는다 — **이
Task는 관찰만 하고 고치지 않았다**(범위 밖).

**P6a-C12(토큰) 부수 관찰.** 이 세 시도 전부에서 HF 토큰 재입력 대화상자나 `supervisor.log`의
토큰 관련 줄이 **전혀 없었다**(`grep -n "토큰\|token"`의 마지막 줄은 9/17~9/20의 옛 항목뿐).
특히 주체 2에서 gated 모델(`pyannote/speaker-diarization-community-1`)의 메타데이터 조회가
토큰 없이는 401이 났을 텐데 `200 OK`로 통과했다 — 즉 **키체인에 저장된 토큰이 Developer ID
서명 아래서, 그리고 실제 gated 모델 인증이 걸리는 경로에서 재입력 없이 작동**했다. Task 5의
"왜 그런지 모른다"는 여전히 미해명이지만, 이번 Task는 그 정지 이후 **처음으로 토큰이 실제
gated-repo 인증에 쓰이는 경로를 탄** 사례를 하나 더 보탰다.

### Step 4 — 재시도 예산을 안 태웠는지 (P6a-C8b)

Step 3의 세 job이 그대로 증거다:

```sql
select id, status, attempts, max_attempts, error->>'code' from job where id in ('job_198','job_199') order by id;
--  job_198 | failed | 1 | 5 | DISK_FULL
--  job_199 | failed | 1 | 5 | llm_request_failed
```

둘 다 `attempts`가 1에 그쳤고 `status='failed'`, `next_attempt_at`이 없다(`queued`로 돌아
백오프를 돈 적이 없다). **판정: 통과** — `job_198`(worker job, DISK_FULL로 직접)과
`job_199`(LLM, 5분 타임아웃을 거쳐서지만 결국 PERMANENT 1회)에서 공통으로 확인.

### Step 5 — 데이터 보존과 정합성 (P6a-C8, Phase 5의 정합성 질의 넷)

`WORKER_ID`는 `worker.log`의 마지막 `ready (db connected)` 줄에서 읽었다
(`desktop-9c144237-3ee5-4a7f-8355-c83989b39899` — `ps`의 `--run-id`와 다른 값이라는 desktop/CLAUDE.md의
경고 그대로였다).

전체 카오스(ENOSPC 업로드 실패, embed 3회 재시작 상한, worker job DISK_FULL, LLM 5분 타임아웃)
**뒤**에 Phase 5 §11의 그 넷을 그대로 돌렸다:

```sql
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='processing' AND j.status NOT IN ('running','queued');        -- 0
SELECT count(*) FROM job WHERE status='running' AND locked_by IS NULL;         -- 0
SELECT count(*) FROM meeting m JOIN job j ON j.id=m.current_job_id
 WHERE m.status='done' AND j.status <> 'done';                                 -- 0
SELECT count(*) FROM job WHERE status='running' AND locked_by LIKE 'desktop-%'
   AND locked_by <> 'desktop-9c144237-3ee5-4a7f-8355-c83989b39899';            -- 0
```

넷 다 0. **판정: 통과.**

기존 데이터 대조: 시도 전 `meeting=11, job=65, utterance=127`. Step1/2(ENOSPC 업로드 거부)는
아무 행도 안 남겼다(위 확인). Step3에서 **의도적으로** 만든 정상 행 — `mtg_109`/`job_198`(업로드
성공 후 모델 로드 단계에서 정직하게 실패), `job_199`(기존 `mtg_107`에 붙인 요약 재시도) — 는
"정합성 위반"이 아니라 이 Task가 직접 유발한 정상적인 실패 기록이다. `mtg_107`의 `status`는
재시도 전후로 `done` 그대로였다(위 §Step3). `utterance` 수는 불변(127) — `job_198`이 STT
이전 단계(diarization 모델 로드)에서 죽었으므로 부분 `utterance`가 남지 않은 것과 일치.

### Step 6 — 정리

```bash
hdiutil detach -force /Volumes/DamwhaTiny      # "disk4" ejected
hdiutil detach -force /Volumes/DamwhaHFTiny    # "disk6" ejected
rm -f tiny.sparseimage hftiny.sparseimage
```

- `/Volumes/`에 Damwha 볼륨 없음, `diskutil list`에도 없음 확인.
- `models` 심볼릭 링크를 지우고 `models.real-backup`(8.8GB)을 `models`로 되돌림 — `du -sh`로
  8.8G 그대로 확인.
- 앱을 한 번 더 정상 기동해(env 개입 없이) embed가 실 8.8GB 캐시로 다시 `준비됨`까지 가는 것을
  확인한 뒤(`Loading weights: 100%` 즉시 완료, `POST /embed 200 OK`) 정상 종료.
- `Damwha.app/Contents/MacOS/Damwha`는 매번 `kill`(SIGTERM)로 정지했고 그때마다
  `SingletonLock` 없이 깨끗이 종료(`ps aux | grep -i damwha` 빈 결과) 확인.
- `Contents/Resources/python` 아래 `__pycache__` 0개 — 이 세션 내내 앱이 자기 스스로 띄운
  python 프로세스만 썼고(정상 동작 경로, `PYTHONPYCACHEPREFIX=<userData>/pycache`가 봉인 밖으로
  돌린다), 검증자가 번들 python을 직접 호출한 적은 없다.

### 실수와 정정 — 포트 3000 오인 (기록으로 남긴다)

Step 1의 첫 시도가 패키지된 앱이 아니라 `pnpm be:dev`(포트 3000, 실 개발 DB·`be/storage`)를
쳤다. `mtg_40`(25MB 무작위 파일, `job_222`)이 그쪽에 생겼다는 것을 `lsof`로 발견한 즉시:

```sql
delete from meeting where id='mtg_40';   -- DELETE 1
delete from job where id='job_222';      -- DELETE 0 (이미 cascade)
```
```bash
rm -rf be/storage/meetings/mtg_40
```
둘 다 0행으로 되돌아온 것을 확인했다. 그 뒤로는 `lsof -nP -iTCP -sTCP:LISTEN | grep Damwha`로
패키지된 앱의 실제 포트(매 기동마다 다름 — 3000이 점유돼 있어 앱이 빈 포트로 물러난다)를
먼저 확인하고서만 요청을 보냈다.

### 7.2 이월 항목 셋 — 관찰 결과

1. **P6a-C12(HF 토큰).** 위 Step 3 참고. **관찰함.** 세 번의 모델-로드 시도(embed, worker job의
   gated pyannote, LLM의 Qwen) 전부에서 토큰 재입력 대화상자가 뜨지 않았고, gated 모델
   메타데이터 조회가 인증 없이는 불가능한데 200 OK로 성공했다 — 키체인 토큰이 여전히 조용히
   작동한다는 것을 이번에도 확인했다. **왜** 무효화되지 않는지는 여전히 미해명 — 이 Task의
   범위가 아니다.
2. **훅 설치 성공 여부.** **관찰함.** 세 로그 전부에서 `hf download progress hook installed
   (writer=…, rebound=…)`(embed) 또는 그 뒤를 잇는 실제 `check_free_space` 호출·예외 스택(worker
   job·LLM)이 나타났다 — `_install`이 이번 재패키징 뒤 실제 packaged 실행에서 **매번 성공**했고,
   디스크 점검이 조용히 함께 멈추는 구조적 위험(브리프가 지목한 "같은 클로저 안이라…")이
   **이번 세 회차에서는 발현하지 않았다**. 다만 이것이 "_install이 실패할 수 없다"는 증명은
   아니다 — 세 회차 모두 정상 설치 경로만 실측했을 뿐, `_install` 실패를 인위로 유발해 롤백까지
   보지는 않았다(그건 이 Task의 범위 밖이다).
3. **`-1` 센티널.** **관찰 못 했다.** `be/src/storage/disk-full.filter.ts`의 `freeBytes()`는
   `fs.statfsSync(dir)`가 던질 때만 `-1`을 낸다 — 이번 Step 1 재현에서 `os.tmpdir()`은 항상
   유효한 마운트 지점(`/Volumes/DamwhaTiny`)이었으므로 `statfsSync`가 매번 성공했고(응답의
   `free:20250624`가 그 증거), `-1` 경로는 밟히지 않았다. 그 경로를 밟으려면 `os.tmpdir()`
   자체가 stat 불가능한 상태(예: 마운트가 검증 도중 예기치 않게 빠짐)가 되어야 하는데, 이는
   디스크 이미지를 예측 불가능하게 만드는 것이라 이 Task에서 인위로 시도하지 않았다. **고치라는
   요청도 없었고 고치지 않았다** — 범위 밖, 최종 리뷰가 판정한다.

### 7.3 바뀐 파일

없음. 이 Task는 검증 전용이며 코드를 수정하지 않았다(`git status --short`가 작업 종료 시
비어 있음을 확인). 재패키징 산출물(`desktop/out/`)은 gitignore 대상이라 커밋 대상이 아니다.

### 7.4 자기 리뷰에서 찾은 것

- **완전성.** 브리프의 Step 1~7을 전부 수행했다. Step 3의 "주체 셋"을 각각 실제 앱 경로로
  관찰했다(embed는 정상 기동 경로 재사용, worker job은 실제 업로드→claim→모델 로드, LLM은
  `POST /summary/generate`로 실제 job 큐를 태웠다 — 단위 테스트로 대체하지 않았다). 세 이월
  항목도 모두 손을 댔고, 하나는 정직하게 "못 했다"로 남겼다.
- **정직성.** Step 1의 화면 렌더링 자체는 GUI 권한이 없어 못 봤다고 명시했다. Step 3의 LLM
  주체는 "판정: 부분 충족"으로 적었다 — DISK_FULL이 아니라 타임아웃으로 새는 것을 숨기지
  않았다. 포트 3000 오인 실수와 그 정정 과정을 감췄다면 더 깔끔해 보였겠지만, 실 개발
  DB·스토리지를 건드렸던 사실이라 남겼다.
- **규율.** 태그·릴리스에 손대지 않았다(`git tag`·`gh release` 호출 없음). `--release`를
  쓰지 않아 공증을 다시 제출하지 않았다. `causes.ts`의 사유 문구를 새로 짓지 않았고, 발견한
  두 구조적 문제(LLM 경로의 타임아웃 새기, `-1` 센티널)를 **고치지 않고** 관찰만 남겼다.
  실 디스크는 채우지 않았고 격리된 sparse image만 썼다 — 끝에 detach·삭제 확인했다. 번들
  python을 검증자가 직접 실행한 적은 없다(check-bundle의 `__pycache__` 0건이 그 증거).
  `desktop/out`을 다시 `rm -rf`하지 않았다(이미 브리프 요구 이상이라 판단, 산출물은 그대로
  둬 다음 Task가 재사용할 수 있게 했다).

  **정정 (Ruling R17, fix round 1).** 위 문단의 전제가 틀렸다 — `desktop/out`의 번들은 worker
  파이썬 **소스를 복사해** 담으므로, fix round가 `be/worker/damwha_worker/*.py`를 고친 뒤에는
  이 산출물이 **그 수정을 담고 있지 않았다.** "재사용할 수 있게 했다"는 재패키징이 필요
  없다는 잘못된 결론(§7의 "재패키징 불필요") 위에서 쓴 문장이었다. `desktop/out`을 통째로
  `rm -rf`했다 — **Task 11은 반드시 재패키징 후 서명·공증한다**, 이 디렉터리를 재사용하지
  않는다. 자세한 내용은 §6.

  > **추가 정정 (Task 13, 2026-09-21).** 위 문단이 "rm -rf했다"로 끝나 디렉터리가 계속 빈 채로
  > 남은 것처럼 읽힌다 — 리뷰에서 이 부정확성이 지적됐다. **실제로는 같은 fix round 안에서
  > 재패키징까지 마쳤다.** §6.1이 그 증거다 — `desktop/out`을 재패키징(~11분, 캐시 적중)해
  > `check-bundle` 39/39 PASS, `/usr/bin/cmp -s`로 번들 안 worker 소스 4개 파일이 저장소본과
  > 바이트 단위로 동일함을 확인했고 앱을 띄워 worker가 `ready (db connected)`에 닿는 것까지
  > 봤다. 지금 `desktop/out`은 **존재하고, R16 수정(`run_guarding_disk_full`)을 담은 번들**이다.
  > 다만 "재사용 금지" 방침 자체는 유효하다 — Task 11은 발행 시점 HEAD를 정확히 담아야 하므로
  > 그래도 `rm -rf out` 후 처음부터 다시 서명·공증한다(Task 6이 남긴 태그 어긋남 RISK와 같은 이유).
- **찾아서 고친 것.** 작업 중 `desktop/causes.js`가 저장소 루트 바로 아래 실수로 추출돼
  `git status`에 걸렸다 — 즉시 지우고 `git status --short`가 빈 것을 재확인했다. 포트 3000
  오인으로 오염된 실 개발 DB·`be/storage`도 즉시 원복했다(위 "실수와 정정").

### 7.5 우려

1. ~~**LLM 기동 경로의 디스크 부족이 사용자에게 거짓 신호를 준다.**~~ **해소됨 (Ruling R16,
   fix round, 아래 §6).** `mlx_lm.server`의 지연 로드가 요청 스레드 안에서 일어나
   `check_free_space`의 `WorkerError(DISK_FULL, …)`가 그 스레드 안에서 죽고 절대 job에
   도달하지 않던 문제 — `run_guarding_disk_full`(`be/worker/damwha_worker/llm_server.py`)이
   서버 stderr를 감시해 그 서명을 잡으면 5분을 기다리지 않고 그 자리에서 같은 사유로 job을
   실패시키도록 고쳤다. `extract_lenses`·`summarize_meeting` 두 LLM job type 모두. 실측
   증거는 `.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-report.md`
   §4 — 격리된 testcontainer DB + 격리된 10MB volume + 실제 `mlx_lm.server`로 4.88초 만에
   `DISK_FULL`로 실패하는 것을 확인했다(원래는 5분 뒤 `llm_request_failed`였다).
2. **`-1` 센티널은 이번에도 실측하지 못했다.** Task 9 리뷰가 넘긴 그대로 미해결 — 재현하려면
   `os.tmpdir()`이 stat 불가능해지는 조건을 인위로 만들어야 하는데, 이는 디스크 이미지를 예측
   불가능한 상태로 만드는 것이라 이 Task의 "실제 디스크를 채우지 않는다"는 안전 수칙과 결이
   비슷해 시도하지 않았다.
3. **포트 3000 충돌은 이 환경에 국한된 우연이 아닐 수 있다.** 개발자 셸에 `pnpm be:dev`가 떠
   있는 상태에서 패키지된 앱을 띄우면 앱이 조용히 다른 포트로 물러난다(오류 없이) — 이번처럼
   검증자가 `lsof`로 확인하지 않으면 엉뚱한 서버를 테스트하고도 "통과"로 착각하기 쉽다. 이
   자체가 버그는 아니지만(포트 충돌 시 대체 포트로 물러나는 것은 의도된 동작으로 보인다),
   검증 절차 문서에 "먼저 실제 포트를 lsof로 확인하라"는 한 줄을 넣을 가치가 있어 보인다.

### 7.6 Fix round (Ruling R16) — 우려 1 해소

사용자 승인(Ruling R16, "Phase 6a 안에서 고친다")에 따라 위 우려 1을 같은 Task 10 작업
안에서 고쳤다. 전체 배선·RED/GREEN·실측 증거·자기 리뷰는
`.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-report.md`에
있다. 요지:

- `be/worker/damwha_worker/llm_server.py`의 `run_guarding_disk_full(proc, fn)`(전 라운드가
  구현, 이번 라운드가 배선)가 워커가 띄운 LLM 서버의 stderr에서
  `damwha_worker.errors.WorkerError: DISK_FULL: ` 서명을 감시해, 보이면 `fn`(LLM 클라이언트의
  블로킹 호출)의 완료를 기다리지 않고 그 자리에서 같은 사유로 실패시킨다. DISK_FULL만 좁게
  잡는다 — 다른 오류(타임아웃·연결 오류 등)는 기존 경로 그대로.
- `jobs.py`의 `ExtractLensesHandler`·`SummarizeMeetingHandler` 둘 다 — 완전성 확인 결과 두
  handler 모두 같은 `managed_llm_server`/`mlx_lm.server` 경로를 공유했다.
- 격리 testcontainer DB + 격리 10MB HF 캐시 volume + 실제 `mlx_lm.server` 서브프로세스로
  실측: 5분(`lens_llm_timeout_seconds`) 대신 **4.88초**, `llm_request_failed`/"timed out"
  대신 **`DISK_FULL`**로 job이 실패하는 것을 확인.
- worker 테스트 전체 708 passed(회귀 없음), ruff 클린.

#### 7.6.1 Fix round 1 (리뷰 fix round) — Important 4건

첫 리뷰가 **Needs fixes, Important 4건**을 냈다(잘한 것도 함께 확인함 — DISK_FULL만 잡는
것, 문구 재사용, 배선이 `ctx.llm_server` 두 사용처를 전부 덮는 것, extract_lenses가 같은
버그를 공유한다는 발견, 버려진 스레드가 `conn`을 안 만진다는 추론, 환경 정리 주장 전부
사실 확인됨). 전체 대응은 `.superpowers/sdd/2026-09-20-electron-phase-6a-signing-distribution/task-10-report.md`의
fix round 1 절에 있다. 요지:

- **Important 1 (Ruling R17) — `desktop/out`이 이 수정을 담지 않았다.** §5(위 문단)의
  "재패키징 불필요"가 **틀린 전제**였다 — 번들은 worker 파이썬 **소스를 복사해** 담는다.
  `desktop/out`을 통째로 `rm -rf`했다(정정한 문장 참고). Task 11은 반드시 재패키징 후
  서명·공증한다.
- **Important 2 (Ruling R18) — readiness 대기 구간에 `proc.stderr` 파이프를 아무도 안
  읽었다.** `run_guarding_disk_full`이 자기 감시 스레드를 새로 띄우는 대신, `managed_llm_server`가
  `popen()` 직후(= `_wait_ready`보다 먼저) **장수 릴레이 스레드 하나**(`_start_stderr_relay`)를
  띄워 `proc`의 수명 내내 stderr를 미러+감시한다. `run_guarding_disk_full`은 그 릴레이가
  붙인 `Event`만 기다린다. 이러면 (a) readiness 단계에 서버가 죽어도 자식 트레이스백이
  `_stop`에 버려지지 않고, (b) 파이프가 안 비워져 자식이 write에서 막히는 위험이 없어지고,
  (c) 같은 `proc`에 두 번 불러도 스트림을 나눠 먹지 않는다(이전 Minor 5). 검사를 미러보다
  먼저 하도록 순서도 바꿨다(이전 Minor 6 — 미러 실패가 탐지를 죽이지 않는다).
- **Important 3 — `stderr=subprocess.PIPE`가 popen에 실제로 전달되는지 테스트가 없었다.**
  `test_managed_llm_server_passes_stderr_pipe_to_popen`을 추가해 그 kwarg가 빠지면 실패하게
  고정했다.
- **Important 4 — 서명 문자열이 실제 `WorkerError` 포맷에 안 묶여 있었다.**
  `test_disk_full_marker_matches_the_real_worker_error_traceback_line`이
  `traceback.format_exception_only`로 만든 **실제** 예외 문자열이 `_DISK_FULL_MARKER`로
  시작하는지 직접 확인한다 — 손으로 적은 테스트 리터럴을 되읽지 않는다.

**검증.** worker 테스트 전체 713 passed(708 + 새 테스트 5), 경고 3건은 모두
`tests/test_eval_diarization.py`의 pyannote UEM 근사 경고(이 fix round와 무관, 기존부터
있던 것)로 확인했다. ruff check/format 클린. `desktop/out`을 재패키징하고(백그라운드,
로그 파일) 번들 소스에 `run_guarding_disk_full`이 실제로 들어갔는지, 앱이 떠서 worker가
준비에 닿는지 값싸게 확인했다 — 상세는 task-10-report.md.

## 8. T11 부작용 — 데스크톱 릴리스가 저장소 Latest를 차지해 웹 배포 버전 조회가 깨짐

### 8.1 무엇이 깨졌나

`desktop-v0.3.0`을 `gh release create`로 발행하자(§6·§2 C14) — 이 릴리스는 drafts·prerelease가
아니므로 GitHub이 자동으로 저장소의 "Latest" 릴리스로 지정했다. `deploy/Makefile`의 `setup`
타깃(151행 근처)은 `.env`의 `DAMWHA_VERSION`을 최신 버전으로 맞추는 로직에서
`gh release view -R $(REPO)` — **태그 없이** — 를 부른다. 이 호출은 "저장소의 Latest"를 받는다.

```
@if command -v gh >/dev/null && latest=$$(gh release view -R $(REPO) --json tagName -q .tagName 2>/dev/null); then \
  latest=$${latest#v}; cur=$$(sed -n 's/^DAMWHA_VERSION=//p' .env | tail -1); \
  if [ "$$cur" != "$$latest" ]; then \
    sed -i.bak "s/^DAMWHA_VERSION=.*/DAMWHA_VERSION=$$latest/" .env && rm -f .env.bak; \
```

Latest가 `desktop-v0.3.0`이 되자 `latest="desktop-v0.3.0"` → `$${latest#v}`는 **맨 앞의** `v` 하나만
떼는 셸 파라미터 확장이라 문자열이 그대로 남는다 → `.env`에
`DAMWHA_VERSION=desktop-v0.3.0`이 쓰인다. 이 값은 셀프호스팅 웹 배포가 이미지 태그로 쓰는
값이라 — 존재하지 않는 태그를 가리켜 웹 배포가 깨진다. `.env`가 이미 있는 설치에도 이 줄은
매번 돌므로, 기존 설치도 `make setup`을 다시 돌리면 덮어써진다.

**정정 (최종 리뷰 I2) — 더 나쁜 경로를 빠뜨렸다.** 위 문단은 `make setup`만 적었다. 기존 웹
설치는 저장소의 `deploy/Makefile`이 아니라 **자기가 받은 tarball의 Makefile**로 돈다
(`deploy/release.sh:38`이 tarball에 복사한다). 그 Makefile은 v0.2.1~v0.2.3에 들어 있고(v0.2.0
이전 태그에는 `deploy/Makefile`이 없다), 거기서 `make upgrade`는
`$(COMPOSE) down` → `$(SUBMAKE) setup` → `$(COMPOSE) pull` 순이다(v0.2.3 `deploy/Makefile:271-273`).
Latest가 `desktop-v*`면 setup이 `.env`를 덮고, pull이 없는 이미지 태그
(`ghcr.io/yjason-k/damwha-api:desktop-v0.3.0`)에서 실패한다 — **그때 스택은 이미 내려가 있다.**

### 8.2 왜 계획·리뷰가 못 봤나

웹 배포(`v<version>`)와 데스크톱 배포(`desktop-v<version>`)를 다른 태그 네임스페이스로 가른
이유는 desktop/CLAUDE.md(Task 13, §61 서명·배포 절)에 이미 적혀 있었다 — "섞으면
`deploy/release.sh`가 태그 버전을 `be/worker/pyproject.toml`과 대조해 거절하고, 6b의 자동
업데이트 조회가 웹 배포를 가리켜 앱이 사용자에게 tarball을 권하게 된다." 이 문장은 **데스크톱
쪽 조회가 웹 릴리스에 흔들리는 방향**만 봤다. 반대 방향 — **웹 쪽 조회(`deploy/Makefile`)가
데스크톱 릴리스에 흔들리는 방향** — 은 계획·스펙·리뷰 어디에도 없었다. `deploy/Makefile`은
Phase 6a(데스크톱 서명·배포)의 변경 범위 밖이라 이번 Task들의 리뷰 대상이 아니었고, 첫
데스크톱 릴리스가 나기 전에는 "저장소 Latest"가 항상 웹 배포였으므로 실제로 문제가 드러난
적도 없었다.

### 8.3 즉시 완화

컨트롤러가 `gh release edit v0.2.3 -R Yjason-K/Damwha --latest` 로 `v0.2.3`을 다시 저장소
Latest로 되돌렸다. 지금은 `make setup`이 정상 동작한다. 하지만 이 완화는 **다음 데스크톱
릴리스가 나오면 그대로 재발한다** — 근본 원인(태그 없는 `gh release view`가 네임스페이스를
가리지 않는다)이 그대로이기 때문이다.

### 8.4 근본 수정 (이 커밋)

세 곳을 고쳤다.

1. **`deploy/Makefile`** — `setup` 타깃의 버전 조회를 저장소 Latest에 기대지 않고, `gh release
   list`로 받은 태그 목록에서 `v`로 시작하는 것만 걸러 그중 가장 최신(목록의 첫 줄 — 정렬이
   최신 먼저임을 실측으로 확인, §T11b 보고서 참고)을 쓰도록 바꿨다. `desktop-v0.3.0`은 `v`로
   시작하지 않으므로 걸러진다. 기존 동작(`gh release view`는 draft·prerelease를 Latest로 안
   준다)과 맞추기 위해 `--exclude-drafts --exclude-pre-releases`도 유지했다.
2. **`desktop/CLAUDE.md`** — 데스크톱 릴리스 발행 절차에 `gh release create ... --latest=false`를
   더하고, 이유(저장소의 Latest는 웹 배포의 것 — Latest를 빼앗으면 웹 쪽 조회가 흔들린다;
   2026-09-21 `desktop-v0.3.0` 발행 때 실제로 일어나 `v0.2.3`을 Latest로 되돌렸다)를 적었다.
   ~~Makefile 수정이 웹 쪽을 이미 지키더라도 둘 다 둔다 — 이중 방어다.~~ **정정(최종 리뷰 I2):**
   이중 방어는 새 클론과 앞으로의 tarball로 설치한 곳에만 성립한다. 아래 마지막 문단의 정정.
3. **이 결과 문서** — §8(지금 이 절)과 §2·§6의 T11 결과 갱신.

이번 릴리스(`desktop-v0.3.0`)의 공개 상태는 건드리지 않았다 — `v0.2.3`이 여전히 Latest이고,
`desktop-v0.3.0`은 여전히 발행된 상태 그대로다. 다음 데스크톱 릴리스부터 `--latest=false`로
내면(2번) 애초에 Latest를 빼앗지 않고, ~~설령 실수로 빼앗기더라도 Makefile의 `v*` 필터(1번)가
웹 배포 조회를 지킨다.~~

**정정 (최종 리뷰 I2).** 지운 문장은 **기존 설치에 대해 거짓이다.** 1번은 저장소의
`deploy/Makefile`을 고쳤고, 그것은 새 클론과 앞으로 나올 tarball에만 닿는다. 이미 나가 있는
설치(v0.2.1~v0.2.3 tarball의 Makefile)는 여전히 태그 없는 `gh release view`로 Latest를 읽고,
§8.1 정정의 `make upgrade` 경로로 스택을 내린 채 남을 수 있다. **그 설치들을 지키는 방어는
발행 때의 `--latest=false` 하나뿐이다.** 그래서 그 플래그를 사람 손에 두지 않고 발행
스크립트(`desktop/scripts/publish.sh`)에 넣고, 발행 뒤 Latest가 여전히 `v*`인지 다시 확인하게
했다(§9 I2).

## 9. 최종 리뷰와 수정 (2026-09-21)

최종 whole-branch 리뷰(range `1b92190..7799dd6`, 26커밋)의 판정은 **With fixes** — Critical 0,
Important 3, Minor 9. 원장 Ruling R25에 따라 Important 셋(I1·I2·I3)과 판정끼리 어긋나는 문서
Minor 넷(M1·M2·M3 기록·M8)을 **병합 전에** 한 번에 고쳤다. 나머지 Minor(M4~M7·M9)와 Task별
deferred 항목은 원장의 트리아지표대로 병합 뒤로 넘겼다.

**I1은 이미 발행된 `desktop-v0.3.0`에 들어 있다.** 이 절의 수정은 0.3.0 사용자에게 닿지 않는다 —
**다음 릴리스가 필요하다**(§9.6).

### 9.1 I1 — 모델 다운로드 디스크 점검이 필요량을 과대 산정했다 (발행본 영향)

`downloads.py`의 `_needed_bytes`가 `sum(저장소의 모든 파일) × 1.2`를 여유와 비교했다. 세 가지가
틀렸고, 고치며 넷째를 찾았다.

- **(a) 호출이 받는 파일만 세지 않았다.** `hf_hub_download(filename=…)`은 파일 하나를,
  `snapshot_download(allow_patterns=…)`는 걸린 파일만 받는데 저장소 전체를 셌다.
- **(b) 캐시에 이미 있는 바이트를 빼지 않았다.** 큰 모델을 반쯤 받다 끊긴 재시도가 전체를 새로
  요구했다.
- **(c) snapshot 안쪽 파일마다 다시 쟀다.** 설치가 `_snapshot_download.hf_hub_download`를 훅으로
  다시 묶으므로 `thread_map` 워커가 파일마다 메타데이터를 다시 받고, 채우는 중인 여유를 전체
  요구량과 다시 비교했다 — 경계 여유면 다운로드 **도중에** `DISK_FULL`.
- **(d) 리비전을 무시했다** (고치며 찾음). 호출의 `revision` 없이 main을 쟀다. embed는 main에 없는
  `model.safetensors`를 고정 리비전(`bge_embed._PINNED_REVISIONS`)에서 받는다.

**T10의 "필요한 용량 5.5 GB"가 정확히 재현된다.** 2026-09-21 HF API로 bge-m3 main의 30개 파일
합이 4,587,317,404 B, × 1.2 = **5,504,780,884 B = 5.5 GB**다. 새 테스트를 옛 코드에 돌린 RED가
그 값을 그대로 냈다. embed가 실제로 받는 스냅샷은 11개 파일 2,293,250,249 B다.

**고친 것** (`be/worker/damwha_worker/models/downloads.py`):

- 호출이 받는 파일로 좁힌다 — `filename`이면 `subfolder/filename` 하나, snapshot이면
  `allow_patterns`·`ignore_patterns`를 **hub가 쓰는 그 함수**(`huggingface_hub.utils.filter_repo_objects`,
  고정 버전 1.20.1에서 시그니처 확인)로 거른다. 메타데이터는 호출의 `revision`·`repo_type`·`token`으로
  받는다.
- 캐시에 있는 blob은 뺀다 — hub는 `blobs/<etag>`가 있으면 받지 않는다(`_hf_hub_download_to_cache_dir`).
  etag는 LFS면 `lfs.sha256`, 아니면 `blob_id`다. **이 맥의 실제 캐시로 확인했다** — bge-m3 12개·
  Qwen3.5-4B 10개, blob 22개 전부가 이 규칙으로 sibling에 맞았고 크기도 같았다. **받다 끊긴 임시
  파일은 빼지 않는다** — 1.20.1은 이어 받지 않는다. 다운로드마다 새 임시 파일
  (`<etag>.<uuid>.incomplete`)에 받고 실패하면 지운다(`_download_to_tmp_and_move`). 빼면 과소
  산정이다. `force_download`·`local_dir`면 캐시를 보지 않고 전부 센다.
- snapshot 안쪽 호출은 건너뛴다. **표시는 스레드 로컬이 아니라 인자다** — 안쪽 호출은
  `thread_map` 워커에서 돌고 바깥 호출부터 무진행 감시 스레드에서 돌므로, 바깥 훅이 세운 스레드
  로컬은 거기서 안 보인다. hub가 안쪽 호출에만 넘기는 `tqdm_class`(`snapshot_download.<locals>._AggregatedTqdm`)는
  호출과 함께 스레드를 건넌다. 그 이름이 바뀌면 건너뛰기만 멈추고 안쪽 호출은 자기 파일 하나를
  재게 된다 — 위험한 방향이 아니다. 테스트가 그 전제도 고정한다.
- 1.2배 계수는 그대로 두고 주석만 고쳤다. "`.incomplete`와 최종 파일이 함께 있다"는 옛 근거는 1.20.1에서
  사실이 아니다 — 같은 `blobs/` 안에서 rename한다.

**새 숫자** (새 `_needed_bytes`를 실제 HF 메타데이터로 돌림 — 네트워크 읽기만, 다운로드 없음):

| 호출 | 옛 계산 | 새 계산 |
| --- | --- | --- |
| embed `hf_hub_download("model.safetensors", revision=고정)`, 빈 캐시 | 5.5 GB | **2.7 GB** (2,725,277,347 B) |
| embed가 부르는 11개 호출 각각의 합(참고), 빈 캐시 | 호출마다 5.5 GB | 2.8 GB |
| 같은 호출, 이 맥의 캐시(다 받아 둠) | 5.5 GB | 점검 없음(받을 것 없음) |
| LLM `snapshot_download("Qwen3.5-27B-8bit", mlx_lm 기본 패턴)`, 빈 캐시 | 35.4 GB | 35.4 GB (패턴이 거의 전부를 받는다) |
| LLM `snapshot_download("Qwen3.5-4B-8bit")`, 이 맥의 캐시(다 받아 둠) | 6.2 GB | 점검 없음 |

**테스트** — `be/worker/tests/test_downloads.py` 끝의 7건. `_needed_bytes`를 monkeypatch로 빼지 않고
훅을 지나 **진짜 계산**을 탄다. 가짜는 hub의 경계 둘(`HfApi`, 바이트를 옮기는 `hf_hub_download` 원본)뿐이고
캐시는 `tmp_path`다. 실제 `snapshot_download`(1.20.1)와 실제 `thread_map`이 돈다.
① 파일 하나만 센다(bge-m3 실측 크기) ② 없는 선택 파일은 점검하지 않는다 ③ 패턴으로 거른 snapshot
④ 캐시에 있는 blob은 뺀다 ⑤ **과소 산정 경계** — 실제 `snapshot_download`가 받으라고 한 파일과
계산이 센 파일을 맞댄다 ⑥ 캐시처럼 보일 뿐인 것(끊긴 임시 파일·옛 리비전·`force_download`)은 센다
⑦ snapshot 안쪽 호출은 다른 스레드에서 오고 다시 재지 않는다. 옛 코드에서 7건 전부 RED(①은
`[5504780884, …] != [2725277347, 824, 2720184729]`, ⑦은 점검 13회 `!= 1`), 고친 뒤 GREEN. Task 7의
배치 회귀 테스트 둘은 그대로 통과한다 — `_needed_bytes`를 빼는 람다의 인자 모양만 새 시그니처에 맞췄다.

**남는 한계.** 점검은 호출 단위다. transformers는 파일을 하나씩 받으므로 막힌 호출의 파일 크기가
"필요한 용량"으로 뜬다 — 여유가 10 MB면 먼저 `tokenizer.json`(20.5 MB)에서 막히고, 비운 뒤 다시
`model.safetensors`(2.7 GB)에서 막힐 수 있다. 모델 전체의 합을 알려면 소비자가 받을 파일 목록을
미리 알아야 한다. 또 크기 없는 sibling과 1,000개 넘는 저장소(hub가 목록을 따로 받는다)는 하한으로
센다 — 쓰는 모델 중 해당하는 것은 없다.

### 9.2 I2 — 웹 배포 Latest 방어는 새 설치에만 이중이다

§8.1·§8.4의 정정이 사실관계다. 기존 웹 설치는 자기 tarball의 Makefile로 돌고, 그 `make upgrade`가
Latest를 읽은 뒤 스택을 내린 채 남을 수 있다. 리뷰 원문은 "v0.1.1~v0.2.3 tarball"이라 했는데
`git show <tag>:deploy/Makefile`로 보니 **v0.2.0 이전 태그에는 Makefile이 없다** — 그 조회를
가진 설치는 v0.2.1~v0.2.3이다.

**발행 스크립트 `desktop/scripts/publish.sh`를 만들었다** (스펙 §7.1의 "별도 스크립트" 쪽 — 되돌리기
어려운 동작을 빌드에 숨기지 않는다). gh를 부르기 전에 작업 트리·태그(HEAD와 원격 둘 다, R22)·DMG
sha256을 보고, `gh release create … --verify-tag --latest=false`로 낸 뒤 **태그 없는
`gh release view`가 여전히 `v*`인지** 다시 본다. 아니면 되돌리는 명령을 출력하고 실패한다 —
자동으로 되돌리지 않는다. **실행하지 않았다**(실행은 공개 발행이다). `bash -n` 통과. 검증은 격리
환경의 드라이런이다 — scratch 저장소 + 로컬 bare `origin` + `PATH` 앞의 가짜 `gh`(받은 인자를 파일에
적기만 한다):

| 시나리오 | 결과 | 가짜 gh가 받은 호출 |
| --- | --- | --- |
| A. 정상, 가벼운 태그, Latest `v0.2.3` | exit 0 | `release create … --verify-tag --latest=false --title Damwha 0.3.0 (macOS) --notes-file …`, `release view` |
| B. 발행 뒤 Latest가 `desktop-v0.3.0` | **exit 1**, `gh release edit v0.2.3 -R Yjason-K/Damwha --latest` 출력 | create, view, list — `edit`은 없다 |
| C. 정상, 주석 태그 | exit 0 | A와 같음 |
| D. 태그가 원격에 없다 | exit 1 | 없음 |
| E. 추적 안 된 파일 | exit 1 | 없음 |
| F. DMG sha256 불일치 | exit 1 | 없음 |
| G. 태그가 HEAD가 아니다 | exit 1 | 없음 |
| H. 원격 태그가 다른 커밋 | exit 1 | 없음 |

드라이런이 결함 둘을 잡아 고쳤다. (1) macOS `/bin/bash` 3.2가 `$TAG가`에서 한글 첫 바이트까지 변수
이름으로 읽어 `unbound variable`로 죽었다 — 문구 안 변수를 전부 `${…}`로 감쌌다. (2) 주석 태그는
`git ls-remote`에 이름 하나만 주면 태그 객체 sha만 와서 HEAD와 어긋났다 — `^{}` 패턴을 함께 준다.

### 9.3 I3 — runtime 기본값과 Frameworks 단언

- **`lib/signing.mjs`의 `codesign()` 기본값을 `runtime = true`로 바꿨다**(`package.mjs`의 `signAll()`도
  `opts.runtime ?? true`). 필수 인자로 만들지 않은 이유: R12가 확정한 사실은 "공증이 번들 안 모든
  실행 파일에 hardened runtime을 요구한다"이고 이 저장소에 `false`가 옳은 호출이 없다(DMG는 이 함수를
  거치지 않고 따로 서명한다). 기본값 `true`는 틀려도 무해한 쪽으로 실패하고(dylib은 플래그를 무시한다,
  R10), 옛 기본값은 조용히 실패해 공증에서야 드러났다. docstring을 R12의 사실로 고쳤다.
- **호출부 동작은 그대로다** — 서명 호출 다섯 곳 전부 옛 값과 새 값이 같다:

  | 호출 | 옛 runtime | 새 runtime |
  | --- | --- | --- |
  | `signAll(python, pythonEnts, …)` | true(기본, ents 있음) | true(기본) |
  | `signAll(ffmpeg, pythonEnts, …)` | true(기본, ents 있음) | true(기본) |
  | `signAll(postgres, null, …, { runtime: true })` | true(명시) | true(명시) |
  | `signAll(Frameworks, null, …, { runtime: true })` | true(명시) | true(명시) |
  | `codesign(id, macEnts, [app], { extra: ["--deep"] })` | true(기본, ents 있음) | true(기본) |

  리뷰는 "이 기본값에 기대는 호출은 0"이라 했는데, 마지막 `.app` 서명은 기본값에 기댄다 — 두 기본값
  아래서 모두 `true`라 동작은 같다.
- **`check-bundle.mjs`에 8b를 더했다** — `Contents/Frameworks`의 Mach-O 전수에 hardened runtime을
  단언한다. 파일 종류로 가르지 않고 트리 전수에 건다 — `package.mjs`가 트리 전체를 runtime으로 서명하므로
  그것이 서명의 계약 그대로고, 14b(postgres)·17b(python·ffmpeg)와 같은 모양이다. 현재 번들(0.3.0
  발행본과 같은 서명 상태)에서 **12/12 통과**(실행 파일 6 — 헬퍼 넷·`chrome_crashpad_handler`·ShipIt,
  dylib 6), `check-bundle` 전체 **40/40 PASS**(39 → 40).
- **8b가 실제로 막는지** — 번들을 건드리지 않고 `Frameworks`를 APFS 클론으로 scratch에 떠, 그 사본의
  ShipIt만 `codesign(…, null, …, { runtime: false })`로 재서명하고 바깥 `Squirrel.framework`를 다시
  봉인했다(`.app --deep`이 하는 일). `check-bundle.mjs`의 `verifyArm64` **원문을 소스에서 잘라** 같은
  판정식으로 돌렸다: 원본 `PASS 12/12`, 사본
  `FAIL 1 of 12: Squirrel.framework/Versions/A/Resources/ShipIt (flags=0x0(none))`.
- **vitest 3건**(`tests/scripts/signing.test.ts`) — `codesign()`의 인자만 본다. 옛 `signing.mjs`에서
  "entitlements 없이도 runtime" 1건 RED(`--options runtime`이 빠짐), 고친 뒤 7/7.

### 9.4 문서 정확성 — M1·M2·M3·M8

- **M1 — 키를 잃어도 연속성은 끊기지 않는다.** `codesign -d -r- desktop/out/mac-arm64/Damwha.app`
  (2026-09-21): `designated => identifier "kr.damwha.app" and anchor apple generic and certificate
  1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13]
  /* exists */ and certificate leaf[subject.OU] = L5Y9SZHGRN`. 인증서 해시도 공개 키도 없다 — 같은
  팀으로 새 Developer ID Application 인증서를 받아 서명한 앱도 이 요구 조건을 만족한다. 키 분실은
  폐기·재발급의 불편이지 연속성 파괴가 아니다. 재발급을 실제로 해 보지는 않았다 — DR 판독에서 내린
  결론이다. `desktop/CLAUDE.md`, 이 문서 §5, 스펙 §12-1(취소선 + 정정 블록)을 고쳤다.
- **M2 — LLM의 `DISK_FULL`은 상태 창이 아니다.** R16 뒤로는 `run_guarding_disk_full`이 그 job을
  실패시키고 요약 카드에 뜬다. `causes.ts`의 주석(동작·문구 불변)과 `desktop/CLAUDE.md`의 표를 고쳤다.
- **M3 — 기록만 했다.** 렌즈만 다시 돌린 경우 사유가 화면에 안 뜬다. §2 C6 판정에 단서로 적었다.
  고치려면 API가 렌즈 실행의 오류를 내주고 `insight-pane.tsx`가 그것을 그려야 한다 — 이 Phase 밖이다.
- **M8 — 로드맵.** T11 발행 완료(URL), Latest 사고와 완화·수정, 최종 리뷰와 다음 릴리스의 필요를
  적었다. T12는 여전히 진행 전이다.

### 9.5 검증

- worker: `pnpm worker:test` 720건 통과(713 + 새 7건, 56.97초, 경고 3건은 `test_eval_diarization`의 pyannote UserWarning — 무관). `ruff check`·`ruff format --check` 통과.
- desktop vitest: 55 파일 1,087건 통과(1,084 + 새 3건). `tsc -p tsconfig.lint.json` 통과.
- `check-bundle.mjs`: 40/40 PASS. **`causes.ts` 주석을 고치기 전에 돌렸다.** tsc가 주석을 JS에 남기므로
  그 뒤로는 2b("app.asar desktop code equals a fresh compile")가 지금 `out/`에 대해 어긋난다 —
  `causes.js` 한 파일을 직접 대조해 확인했다. `out/`은 0.3.0 발행본이고 이 브랜치의 worker 수정(I1)도
  담고 있지 않으므로 어차피 다시 패키징해야 한다(R17과 같은 이유).
- 공개 상태·번들·DB는 건드리지 않았다 — 태그·릴리스 변경 없음, 발행 스크립트 미실행, 재패키징·
  재공증 없음, 번들 사본은 scratch의 APFS 클론에서만 재서명했다.

### 9.6 다음 릴리스가 필요하다

I1은 `desktop-v0.3.0`에 들어 있다. 0.3.0을 받은 사용자는 여유가 2.7~5.5 GB일 때 embed가 막히고
틀린 숫자를 본다. 이 수정이 닿으려면 **다시 패키징·공증한 다음 릴리스**가 필요하다 — Task 12
Step 7의 0.3.1 빌드(R24)가 이 수정 뒤에 오므로 두 번째 맥 시험이 I1 수정까지 함께 본다. 발행은
`desktop/scripts/publish.sh`로 한다.
