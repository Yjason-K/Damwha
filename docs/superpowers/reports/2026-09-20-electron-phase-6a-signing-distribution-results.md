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
| P6a-C4 | 공증 통과 + 스테이플 (`--release`) | **메커니즘 충족 확인(T6, 커밋 `dfd6c1a`/`847e2dd` 기준)** — 최종 발행판은 진행 전(T11) | T6: 첫 제출 `88197b1f-daae-41bc-aa68-e62176a321de` status=Invalid(오류 32건, R12로 해소) → 재제출 `.app`=`54dd2674-3806-4f12-8187-0ac8c50c10f6`·DMG=`cd12be62-dc47-49ff-87b3-1d8599ce8fe7` 둘 다 Accepted. `spctl --assess`가 `source=Notarized Developer ID`, `stapler validate` 통과. **단 이 산출물은 T7~T10(디스크 부족 세 경로, R16)을 포함하지 않은 코드 상태다** — 최종 발행판 재공증은 T11이 한다 |
| P6a-C5 | 릴리스 빌드에서 태그·버전 어긋나면 멈춤 | **충족** | T6 Step 10b: 태그를 일부러 어긋나게 하고 `--release` 실행 → electron-builder 앞에서 exit 1 확인 |
| P6a-C6 | 디스크 부족 원인·복구 안내가 화면에 뜬다(worker job·embed·LLM 셋 + 업로드) | **충족(응답·계약 레벨) — 화면 렌더링 자체는 미관측** | worker job·embed: T10 Step3 실측(`DISK_FULL`, 사유 문구 그대로). LLM: 최초 부분 충족(5분 뒤 `llm_request_failed`로 거짓 표면화) → **R16 수정 후 4.88초에 `DISK_FULL`로 충족**(task-10-report.md §fix round). 업로드: T9가 FE 소비 로직을 unit·DOM 테스트로 고정하고 T10이 실제 API 응답이 그 모양(`{code:'DISK_FULL', free, needed:null}`)과 일치함을 소스 대조로 확인 — **실제 토스트 렌더링은 이 세션에 GUI 상호작용 권한이 없어 못 봤다**(T10 §7.1 Step1) |
| P6a-C7 | 업로드 ENOSPC → 507, 잔재 없음 | **충족** | T8(2MB HFS+ 이미지로 실측, `dw-upload-*` 잔재 0), T10 Step1/2 실측 — 507 `{code:'DISK_FULL', free:20250624, needed:null}`, `new_meetings=0`, `new_jobs=0`, 임시 파일 0개 |
| P6a-C8 | 디스크 부족 회차 뒤 기존 데이터 보존, 고아 행 없음 | **충족** | T10 Step5 — Phase 5 정합성 질의 넷 전부 0, `meeting`/`utterance` 행 수·`data/storage` 파일 수 불변 |
| P6a-C8b | 모델 다운로드 디스크 부족이 재시도 예산을 안 태움(worker job 경로) | **충족** | T10 Step3/4 — `job_198`(worker, DISK_FULL) attempts=1→failed, `job_199`(LLM, R16 수정 후) attempts=1→failed, 둘 다 `queued` 백오프 없음 |
| P6a-C9 | 두 번째 맥 Gatekeeper 없이 실행 | **진행 전 (T12)** | — |
| P6a-C10 | 두 번째 맥 온보딩→다운로드→처리 `done` | **진행 전 (T12)** | — |
| P6a-C11 | 재빌드·재설치 후 TCC 마이크 권한·토큰 유지 | **진행 전 (T12)** — 스펙이 "이 Phase에서 가장 값진 기준"으로 꼽음 | — |
| P6a-C12 | ad-hoc→Developer ID 전환에서 토큰이 1회 무효화되고 크래시 없이 온보딩으로 떨어짐 | **미판정 — 전제가 실측에서 발생하지 않았다** | T5 Step 8과 T10 Step3(세 차례 모델 로드, gated repo 인증 포함) 모두 **토큰이 무효화되지 않고 재입력 없이 그대로 작동**했다. 예고된 퇴행(§9) 자체가 안 일어났으므로 "크래시 없이 온보딩으로 떨어지는지"는 시험된 적이 없다. 왜 무효화되지 않는지 T5·T6·T10 공통으로 미해명 |
| P6a-C13 | DMG 안 `.app`도 서명·공증·스테이플 살아있음 (`--release`) | **메커니즘 충족 확인(T6, C4와 같은 커밋 기준)** — 최종 발행판은 진행 전(T11) | DMG 마운트 후 내부 `.app`에 `spctl --assess`·`stapler validate`·`codesign -dv` 통과(T6). C4와 같은 이유로 T7~T10 미포함 |
| P6a-C14 | `desktop-v<version>` 태그로 릴리스 발행, DMG+SHA-256 자산 | **진행 전 (T11)** | 태그 `desktop-v0.3.0`은 T6이 `dfd6c1a`에 로컬로만 만들었다(`git ls-remote --tags origin 'desktop-v*'` 빈 결과 확인). T11이 최종 HEAD로 재태깅 후 발행해야 한다(T6 RISK 메모) |

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

- **macOS 15.0은 선언·단언까지만 증명됐다.** 검증 맥이 26.x라 `LSMinimumSystemVersion=15.0`
  선언과 `minos ≤ 15.0` 전수 단언(P6a-C1·C2)까지가 이 Phase가 닿는 곳이고, 15.0 맥에서의 실제
  실행은 증명되지 않았다(스펙 §11-3). 15.x 맥이 생기면 그때 1회 확인한다.
- **두 번째 맥에 개발 도구가 시스템 전역으로 남아 있다.** T12가 새 사용자 계정으로 검증해도
  `/opt/homebrew`·`/usr/local`은 시스템 전역이라 지워지지 않는다(스펙 §11-6). T12가 증명하는
  것은 "개발 환경이 전혀 없는 맥"이 아니라 "개발자 계정 밖"이다.
- **`mlx` 15.0 휠의 런타임 동작은 아직 아무도 못 봤다.** 26.0 휠과 같은 소스의 다른 배포
  타깃이라 전방 호환이 기대되지만, 실제로 STT·요약이 같은 결과를 내는지는 T12(스펙의 C10)가
  처음 본다(스펙 §11-4). 다르면 §5.1의 15.0 선택을 다시 봐야 한다.
- **개인 서명 키의 이 맥 밖 추가 백업이 됐는지 확인된 적이 없다.** 스펙 §3-7은 `.p12` 백업이
  `~/Documents/damwha-signing`(0700, 저장소 밖)에 있다고 적었고, §12 위험 1은 "이 맥 밖에 한
  벌 더 두는 것을 결과 문서에 남긴다"고 완화책을 적었다. 이 Phase의 어떤 Task 보고서·원장에도
  그 오프사이트 복사가 실제로 됐다는 기록이 없다 — **위치 미기재, 사용자 확인 필요.** 잃으면
  재발급 인증서가 다른 identity가 돼 기존 사용자의 TCC 마이크 권한·`safeStorage` 토큰이 전부
  무효화된다(같은 §12).

## 6. Task 11·Task 12 — 진행 전

Ruling R19에 따라 순서가 13 → 11 → 12 → 13 보충으로 바뀌었다. 이 절은 **의도적으로 비워
둔다** — T11(릴리스 발행, 태그 `desktop-v0.3.0`을 최종 HEAD로 재태깅 후 재패키징·재공증·
`gh release create`)과 T12(두 번째 맥 종단간 검증, P6a-C9~C11)의 결과는 추측하지 않는다.
두 Task가 끝난 뒤 이 문서에 짧은 보충 커밋으로 채운다 — §2의 C4·C9·C10·C11·C13·C14와 §5의
세 제약이 그 보충의 대상이다.

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
