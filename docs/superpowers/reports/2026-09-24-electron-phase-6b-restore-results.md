# Electron Phase 6b-2 — 업데이트 전 스냅샷·되돌리기·실패 복구 (결과)

스펙: [2026-09-24-electron-phase-6b-restore-design.md](../specs/2026-09-24-electron-phase-6b-restore-design.md) ·
계획: [2026-09-24-electron-phase-6b-restore.md](../plans/2026-09-24-electron-phase-6b-restore.md) ·
변이 기록: [2026-09-24-electron-phase-6b-restore-mutations.md](2026-09-24-electron-phase-6b-restore-mutations.md) ·
브랜치 `feat/electron-migration-phase-6b-restore` (dev `ad82f2d`에서 분기, 실측 빌드 `c75ba05`).

## 0. 전 패키지 초록 (C11)

- desktop: `pnpm --filter damwha-desktop exec vitest run` — **70 files / 1279 tests passed**. `tsc --noEmit` clean.
- `pnpm lint` — 오류 0. 경고 1건(fe `react-hooks/exhaustive-deps`)은 이 브랜치 이전부터 있던 것.
- be·fe·packages·worker는 이 브랜치가 건드리지 않았다(`git diff --stat ad82f2d..HEAD -- be fe packages` 빈 결과) — ruff 대상 없음.
- packaged 빌드 `pnpm desktop package:desktop` 통과, `check-bundle` 전 항목 PASS — 새 단언
  `Resources/build-info.json carries this version and a 12-char commit — {"version":"0.3.1","commit":"c75ba05c6303"}` 포함.

## 1. 변이 검증 (C7·C8·C9 보강)

M1~M24 **24/24 빨간불**, 동치 0. M7(교체 표 `staged`의 "그 밖의 조합" 거부)이 처음 살아남았다 — `moved-aside`의
독립 가드가 6개 무효 조합 중 5개를 우연히 잡아서다. 남은 하나(D·R 있음, S 없음, D의 신원이 스냅샷과 일치)는 조용히
`hold`로 끝났다. 그것을 잡는 테스트를 더했다(`12aca7e`). 최종 리뷰 수정분의 변이 셋(훅의 `refuse` 조기 거부, 가드
catch-all, 방금 뜬 스냅샷 보호)도 각각 빨간불 — 앞의 하나와 M7은 컨트롤러가 직접 재현했다. 상세는 변이 기록 문서.

## 2. 완료 기준 판정 (스펙 §13)

| # | 기준 | 판정 | 근거 |
| --- | --- | --- | --- |
| C1 | 판이 바뀌면 postmaster 기동 전에 스냅샷 완료, manifest·system identifier·마커 일치 | **충족** | §3 C1 |
| C2 | 되돌리기 왕복 뒤 0.3.1 정상 기동, 기준선이 업데이트 전과 같음, 새 판 데이터는 보관본에 | **충족** | §3 C2 — 기준선 54줄 전부 동일 |
| C3 | 재업그레이드가 보류를 날짜 문구로 다시 띄우고 [이 판으로 계속]이 새 스냅샷·새 덤프로 진행, 번호 충돌 없음 | **충족** | §3 C3 |
| C4 | 보류 중 같은 판을 다시 열어도 마이그레이션하지 않음, [이 판으로 계속]이 다시 업데이트 | **충족** | §3 C2·C3 |
| C5 | 교체의 모든 중단 지점에서 이어서 마치고 `initdb` 없음, 정의 밖 조합은 무변경 거부 | **충족** | 단위(§6.3 표 전 행) + §3 C5 (`staged`·`moved-aside` 두 지점 실측) |
| C6 | 스냅샷을 못 만들면 기동하지 않고 원인 표시, 미완료물 없음 | **충족** | §3 C6 |
| C7 | 게이트 재시도(부분 성공 포함)에도 업그레이드 시작 덤프 생존 | **충족** | 단위 + 변이 M15·M16 |
| C8 | 보존 2개, 저널 대상 스냅샷·`data.replaced-*` 보존 | **충족** | 단위 + 실측(§3 C5·C6에서 상한 초과 스냅샷이 새 것 **뒤에** 지워짐) |
| C9 | 외부 DB·스냅샷 없음·저널 있음에서 메뉴 비활성, dev는 스냅샷·기록 안 만듦 | **충족** | 단위 + 변이 M2·M19 |
| C10 | `docs/RESTORE.md`를 실제로 따라 해 이전 판 기동 | **충족** | §3 C10 (확장: 재업그레이드가 새 스냅샷을 뜸) |
| C11 | 전 패키지 초록, 변이 전부 빨간불 | **충족** | §0·§1 |

**로드맵 6b 완료 기준 두 번째 줄("업데이트 실패 시 정의된 복구 절차로 데이터와 실행 상태 복구 가능")이 채워졌다** —
앱 안의 절차(C2·C4·C5)와 수동 절차(C10) 둘 다 실데이터에서 0.3.1 기동까지 닿았다.

## 3. 실측 기록 (2026-09-24, packaged, GUI 조작은 사용자)

재료: 발행판 `~/damwha-builds/Damwha-0.3.1-published.app`(codesign 검증), 6b-3 복구 세트
`~/damwha-6b3-recovery-20260924T173744`(`026` 이전), 새 빌드 `0.3.1+c75ba05c6303`. 매 단계 전후와 판을 바꿀 때마다
`pgrep -fl "Damwha.app/Contents|Electron.app/Contents/MacOS/Electron|electron/cli.js|bin/postgres -D .*Damwha|damwha_worker|mlx_lm"`이
빈 것을 확인했다. 시작 전 userData를 `~/damwha-6b2-before-20260924T221213`(513 MB, models·캐시 제외)으로 떠 두었다.
디스크 여유 14 GB(시작) → 13 GB(끝).

### 준비 — 0.3.1 기준선

복구 세트를 userData에 들여놓고(models 유지) 발행판 0.3.1을 설치·기동. `025`, 회의 `mtg_5`~`mtg_9`, 세대 기록 없음.
기준선 `b0`(54줄): `_migrations` 마지막, 회의 id·상태·제목, 회의별 발화 수·해시, 요약 해시, 화자, `processing_defaults`,
job(id·type·status·attempts·max_attempts), `mtg_id_seq`, 스토리지 파일 sha256 전수, 마커.

### C1 — 판올림 스냅샷

새 빌드 설치·기동. `supervisor.log`:

```
13:20:47.387Z 스냅샷: 떴다 — …/snapshots/20260924T132047Z (기록 없음 → 0.3.1+c75ba05c6303, shut down)
13:20:47.855Z postgres: 준비됨
13:20:48.023Z 마이그레이션 게이트: 적용 전 백업 — …/20260924T132047Z-before-026_job_interruptions.sql.dump
13:20:48.023Z 마이그레이션 게이트: 1개 적용 — 026_job_interruptions.sql
```

manifest `{"fromBuild":null,"toBuild":"0.3.1+c75ba05c6303","fromRecord":null,"pgVersion":"16","clusterId":"7687238228739395787","databaseOid":16384,"clusterState":"shut down","complete":true}`.
사본·원본의 `pg_controldata` system identifier와 마커 동일. `data/.damwha-generation` = `{"build":"0.3.1+c75ba05c6303","snapshot":"20260924T132047Z"}`,
스냅샷 안에는 기록 없음. 덤프 sidecar `{"firstPending":"026_job_interruptions.sql","applied":25,"generation":"20260924T132047Z"}`.
논리 71 MB 스냅샷에 여유 감소 약 25 MB(덤프 3 MB·기동분 포함) — clone.

### C2·C4 — 되돌리기 왕복

새 판에서 회의 하나 업로드 → `mtg_10` done(`original.wav`·`normalized.flac` sha256 기록). 메뉴 → 확인(스냅샷 한 줄) → 재시작:

```
13:28:46.326Z 되돌리기: 예약했다 — 스냅샷 20260924T132047Z
13:28:47.812Z 되돌리기: 20260924T132846Z — staged
13:28:47.812Z 되돌리기: 20260924T132846Z — moved-aside
13:28:47.816Z 되돌리기: 20260924T132846Z — hold
```

보류 대화상자에서 디스크 확인 — postgres·worker 없음, `data/`는 스냅샷 복제(회의 폴더 `mtg_8`·`mtg_9`, 기록
`{"build":null,"snapshot":null,"restoredFrom":"20260924T132846Z"}`, id 동일·`shut down`), `data.replaced-20260924T132846Z`에
`mtg_10` 두 파일이 해시째 그대로. [종료] → **같은 새 판을 다시 열자 보류가 다시 떴고 스냅샷·마이그레이션·백업 줄 없음,
postgres 미기동(C4)**. [종료] → 발행판 0.3.1 설치·기동: 거부 없이 `postgres: 준비됨`·`api: 준비됨`. 기준선 `b1`이
`b0`과 **54줄 전부 동일**(C2).

### C3 — 재업그레이드

0.3.1에서 회의 하나 업로드 → 시퀀스가 9였으므로 `mtg_10`(`original.m4a`·`normalized.flac`)으로 done. 보관본의 새 판
`mtg_10`(wav·flac)은 해시째 그대로 — 번호가 같아도 덮지 않았다. 새 빌드 설치·기동 → 저널이 `hold`라 보류 대화상자가
다시 떴고 문구에 "그 뒤 이전 판에서 쓴 내용은 지금 데이터에 그대로 있어요"가 있었다(사용자 확인). [이 판으로 계속]:

```
13:35:20.228Z 스냅샷: 떴다 — …/snapshots/20260924T133519Z (기록 없음 → 0.3.1+c75ba05c6303, shut down)
13:35:20.895Z 마이그레이션 게이트: 적용 전 백업 — …/20260924T133520Z-before-026_job_interruptions.sql.dump
13:35:20.895Z 마이그레이션 게이트: 1개 적용 — 026_job_interruptions.sql
```

새 스냅샷 id ≠ A. 새 manifest `fromRecord` = `{"build":null,"snapshot":null,"restoredFrom":"20260924T132846Z"}` —
옛 스냅샷 재사용이 막혔다. 새 덤프 sidecar `generation` = `20260924T133519Z`, A 묶음 첫 덤프도 남음. 저널 삭제.
0.3.1에서 올린 `mtg_10`이 화면에 정상 표시(사용자 확인). 스펙 §12.2-5의 "새 판에서 회의 하나 더"는 생략했다 —
번호 충돌 무해성은 0.3.1의 `mtg_10`으로 이미 확인됐다.

### C5 — 교체 중 크래시 (두 지점)

`DAMWHA_RESTORE_PAUSE_AFTER_STEP`을 붙여 `/Applications/Damwha.app/Contents/MacOS/Damwha`를 직접 실행 → 메뉴로
되돌리기 → `app.relaunch()`한 앱까지 env가 전달됐다(`되돌리기: 실측용 대기 60초 — <step>` 줄). 대기 중 postgres·worker
없음을 확인하고 main을 `pkill -9`.

- **`staged`** (`13:37:29`, D·S 있음, 이번 rid의 R 없음) → 평소대로 재기동:
  `13:38:05.783Z moved-aside` → `13:38:05.790Z hold`. initdb 줄 0. 새 `data.replaced-20260924T133727Z` 생성, 임시 사본 비움.
- **`moved-aside`** (`13:40:43`, **`data/` 없음**, R·S 있음) → 재기동: `13:41:03.905Z hold`, **initdb 줄 0**.
  `data/` 들여놓임 — id·마커 일치, 기록 `restoredFrom: 20260924T134042Z`.

그 사이 [이 판으로 계속]에서 보존이 작동했다 — `13:39:15.000Z 스냅샷: 떴다 …133914Z` 뒤 `13:39:15.049Z 스냅샷: 지웠다
(보존 상한 초과) …132047Z`. 되돌리기 확인 대화상자에 스냅샷 버튼 두 개가 보였다(사용자 확인).

### C6 — 스냅샷 실패

보류 상태에서 `chmod 500 snapshots/` → [이 판으로 계속]:

```
13:42:30.796Z 앱을 시작하지 못했어요 — 업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요 (…/snapshots).
EACCES: permission denied, mkdir '…/snapshots/20260924T134230Z.partial'
```

`.partial` 없음, `.damwha-generation` 불변, postgres·worker 미기동. 창을 닫고 Dock으로 다시 열어도 같은 실패 화면·자동
재시도 없음. **가드가 거부한 상태에서도 되돌리기 메뉴는 활성**(최종 리뷰 수정 반영, 사용자 확인). 권한을 되돌리고
"다시 시도" → `13:45:13.371Z 스냅샷: 떴다 …134513Z`, 상한 초과분 삭제, `026` 적용, 정상 기동.

### C10 — 수동 절차

앱 종료 뒤 `docs/RESTORE.md`를 글자 그대로 — 1(pgrep 빈 결과), 2(manifest 목록), 3(`SID=20260924T134513Z`, `mv data →
data.replaced-manual-20260924224555`, `cp -c -R`, `restoredFrom: manual-…` 기록, 저널·staging 삭제), 4(발행판 0.3.1
설치·기동). **0.3.1 정상 기동**, `025`, 회의에 0.3.1의 `mtg_10` 포함.

확장(최종 리뷰 Important 2): 같은 새 빌드를 다시 설치·기동 → 옛 `134513Z`를 재사용하지 않고 **새 스냅샷
`20260924T134714Z`**, `fromRecord` = `{"build":null,"snapshot":null,"restoredFrom":"manual-20260924224555"}`.
같은 기동에서 게이트가 sidecar 없는 가장 오래된 `before-022` 덤프만 지웠다(5개 규칙, 고정 덤프는 유지).

### 복구

앱 종료·pgrep 확인 → 시작 전 백업을 `rsync -a --delete`(models·캐시 제외)로 되돌림. 실측 중의 스냅샷·보관본·저널·덤프는
사라지고 백업 3개·마커 원상. 새 빌드 기동: 기록이 없어 스냅샷 하나(`134743Z`), 마이그레이션 없음, `026`, 회의 7개
(`mtg_5`~`mtg_11`), job 28행 — 실측 전 상태.

## 4. 관찰

- **스냅샷 로그의 "기록 없음"**: 되돌린 데이터(`build: null, restoredFrom: …`)에서 뜬 스냅샷도 `(기록 없음 → …)`로 찍힌다.
  `fromBuild`가 null이라서다. 기록이 "없는" 것이 아니라 "판이 없는" 것이다 — 로그 문구 개선 여지(동작 무관).
- **교체 자체는 밀리초**: `staged`→`hold`가 4 ms. 시간은 staging clone(1초 미만)에 든다.
- **`app.relaunch()`는 env를 물려준다**: 실측용 대기 env가 재시작한 인스턴스에 그대로 닿았다.
- **첫 설치·첫 기동 스냅샷**: 복구 뒤 기동처럼, 기록이 없는 데이터를 이 빌드가 처음 열면 스냅샷을 하나 뜬다
  (설계대로 — 최종 리뷰 minor 3, 유지 판정).

## 5. 리뷰 기록

- **코덱스 탐색**(스펙 전)·**코덱스 스펙 리뷰**(14건)·**코덱스 계획 검증**(중간 보고 5건 + GPT-6-Luna 6건) — 스펙 §16.
- **Task 리뷰**: 10개 모두 clean. 수정 라운드는 Task 9 한 번 — `RESTORE.md` 최후 수단의 `pg_ctl -o
  "…unix_socket_directories=$D/run"`이 "Application Support"의 공백에서 쪼개져 postgres가 뜨지 않았다(리뷰어가 번들
  바이너리로 재현) → `mktemp` 소켓 디렉터리. 같은 라운드에서 `{ exit 1; }` → 서브셸, `mv 2>/dev/null` 제거.
- **최종 whole-branch 리뷰**(opus): "With fixes" — Important 2, 수정 한 번과 범위 재리뷰로 해소(스펙 §16.4).
  1. `preLaunch` 훅이 앱이 떠 있는 채로 저널을 끝까지 진행할 수 있었다(postgres 자동 재시작·상태 창 재시작) →
     훅은 `journal: "refuse"`로 아무것도 건드리지 않고 `restorePending`으로 멈춘다.
  2. 수동 절차 뒤 같은 판 재설치가 옛 스냅샷을 재사용했다 → `RESTORE.md`가 `restoredFrom: manual-…`을 남긴다(C10 확장으로 실측 확인).
- **판정 목록**(SDD 장부의 Ruling 전부)은 PR 설명에 싣는다.

## 6. 남은 일

- 6b 전체 완료 — **v0.4.0 릴리스**(버전 올리기·태그·공증·DMG·발행)는 이 브랜치 병합 뒤 따로.
- 보류한 minor(스펙 §14·SDD 장부): 첫 설치 두 번째 기동의 같은 스키마 스냅샷, 읽을 수 없는 저널에서의 `restorePending` 안내 문구,
  `survivingOrphans`가 표식 없는 자손을 세지 않는 것, 교체 거부 테스트가 저널 step 불변을 단언하지 않는 것 등.
- 알려진 한계(스펙 §14): 메뉴 없이 손으로 이전 판으로 내렸다가 **같은** 빌드를 다시 깔면 새 스냅샷이 없다(게이트의 직전 덤프만).
