# Phase 6b-2 되돌리기 — 변이 검증 (Task 10)

M1~M24를 한 줄씩 순서대로 적용 → 지정 테스트만 `pnpm --filter damwha-desktop exec vitest run <path>`로 실행 →
결과 기록 → `git checkout -- <file>`로 되돌리고 `git status --short desktop/src`가 깨끗함을 확인한 뒤 다음
변이로 넘어갔다. 코드가 브리프의 서술과 정확히 같은 곳에서는 그대로, 달라진 자리는 "적용한 편집"에 실제로
바꾼 줄을 적었다.

## 결과표

| # | 파일 | 적용한 편집 | 결과 | 잡은 테스트 |
| --- | --- | --- | --- | --- |
| M1 | `src/process/clone.ts` | `if (occupied(dst)) throw new Error(...)` 줄 삭제 | 빨강 | `refuses an existing destination instead of nesting into it`, `refuses a dangling symlink at the destination` |
| M2 | `src/services/postgres/generation.ts` | `needsSnapshot`의 `if (!i.packaged \|\| i.currentBuild === null) return false;` 삭제(대체 없음) | 빨강 | `never in dev, even with no record` |
| M3 | `src/services/postgres/snapshot.ts` | `findUnrecorded`에서 `&& s.manifest.fromRecord === fromRecord` 삭제 | 빨강 | `findUnrecorded ignores a snapshot whose fromRecord differs (restored data)` |
| M4 | `src/services/postgres/snapshot.ts` | `pruneSnapshots`의 `if (protect.has(s.id)) continue;` 삭제 | 빨강 | `prune keeps the newest KEEP_SNAPSHOTS and never a protected one` |
| M5 | `src/services/postgres/snapshot.ts` | `takeSnapshot`의 `readControldata(path.join(copy, "postgres"), signal)`를 `readControldata(d.layout.pgdata, signal)`로 | 빨강 | `reads pg_controldata from the copy, not the live cluster` |
| M6 | `src/services/postgres/snapshot.ts` | `takeSnapshot`의 `catch` 안 `removeDir(partial, d.log, "실패한 스냅샷");` 삭제 | 빨강 | `removes its .partial when the clone fails and rethrows`, `removes its .partial when controldata has no identifier` |
| M7 | `src/services/postgres/restore-journal.ts` | `staged`의 `else if (!(!D && R && S)) throw new RestoreIncomplete(...)` 삭제 | **살아남음 → 테스트 추가 후 빨강** | 추가한 `staged with D already matching the snapshot's identity and R present, no staging` |
| M8 | `src/services/postgres/restore-journal.ts` | `moved-aside`의 `verifyIdentity` 검사(`if (!(await d.verifyIdentity(...))) throw ...`) 삭제 | 빨강 | `moved-aside where data/ is not the snapshot (identity mismatch) refuses` |
| M9 | `src/services/postgres/restore-journal.ts` | `markRestored();` 삭제 | 빨강 | restore-journal: `marks the restored data's generation record with restoredFrom, keeping build and snapshot`, `writes restoredFrom with null build/snapshot when the snapshot had no record`, `moved-aside with staging already renamed into data/ (crash after rename, before step write)`; data-guard: `hold then release: next guard takes a NEW snapshot (fromRecord differs), not the old one` |
| M10 | `src/services/postgres/restore-journal.ts` | `requested`의 `catch` 안 `removeJournal(layout.restoreJournal);` 삭제 | 빨강 | `snapshot missing → aborted, journal removed, data/ untouched` |
| M11 | `src/app/data-guard.ts` | 저널 처리 블록(`if (jr.kind === "ok") { … }`)을 판정표 1(`decideCluster`와 그 `if (decision.kind !== "start") return …`) **뒤**로 옮김 | 빨강 | `journal is processed before decideCluster when data/ is missing (never initdb-shaped)`, `data/ already swapped in but with a different pg_controldata id → restoreIncomplete` |
| M12 | `src/app/data-guard.ts` | `if (decision.kind !== "start") return { kind: "proceed", snapshot: null, notice };` 삭제 | 빨강 | `pairing refusal (marker missing): creates nothing and does not touch the lock` |
| M13 | `src/app/data-guard.ts` | `writeGenerationAtomic(...)`을 `takeSnapshot` **앞**으로 옮김. `snapshot.id`가 그 시점에 없어 문자 그대로는 옮길 수 없어, 가장 가까운 동치 변이로 `writeGenerationAtomic(layout.generationFile, { build: currentBuild, snapshot: recorded?.snapshot ?? null })`를 `takeSnapshot` 호출 **앞**에 추가하고 원래 자리(스냅샷 성공 뒤)의 호출은 지웠다 — "스냅샷이 성공한 뒤에만 기록한다"는 같은 판정을 깨는 편집이다 | 빨강 | `packaged, no record: takes a snapshot, then records the generation`, `snapshot failure: manual snapshotFailed, no record, no .partial left`, `hold then release: next guard takes a NEW snapshot (fromRecord differs), not the old one` |
| M14 | `src/app/reap-on-start.ts` | `if (alive.length > 0) throw new ServiceFailure(CAUSES.writersAlive.text(alive), "manual");` 삭제 | 빨강 | `refuses to start when an orphan survives the reap (writersAlive)` |
| M15 | `src/services/postgres/migration-gate.ts` | `const candidates = dumps.filter((n) => !pinned.has(n));`를 `const candidates = dumps;`로 | 빨강 | `keeps the first dump of a generation through six partial-success retries`, `same failing file five times also keeps the first dump` |
| M16 | `src/services/postgres/migration-gate.ts` | `if (fs.existsSync(path.join(deps.layout.snapshots, gen))) pinned.add(name);`의 조건을 `if (true)`로 | 빨강 | `unpins a generation whose snapshot no longer exists` |
| M17 | `src/app/quit-flow.ts` | `commit`의 `catch` 안 `return;` 삭제 | 빨강 | `a throwing commit starts no quit: no beginQuit, no stopServices, no quit` |
| M18 | `src/app/restore-flow.ts` | `confirmRestoreDialog`의 `cancelId: buttons.length - 1`을 `cancelId: 0`으로 | 빨강 | `one button per snapshot plus cancel; Escape picks cancel` |
| M19 | `src/app/restore-flow.ts` | `restoreMenuEnabled`의 `!s.journalPresent &&` 삭제 | 빨강 | `enabled only with a restorable snapshot, no journal, embedded mode` |
| M20 | `src/windows/status-view.ts` | `shellStatusFrom`의 `input.restoreAvailable === true &&` 삭제 | 빨강 | `appends the restore note only for update failures and only when restorable (Phase 6b-2 §7.1)` |
| M21 | `src/services/postgres/service.ts` | `launch`의 `await deps.preLaunch?.(ctx.signal);` 삭제 | 빨강 | `calls preLaunch before anything else and refuses without creating anything when it throws`, `goes on to launch when preLaunch resolves` |
| M22 | `src/process/orphans.ts` | `survivingOrphans`의 `&& d.exists(p.pid)` 삭제 | 빨강 | `resolves with what it reaped when the scan works` (지정된 기존 테스트) |
| M23 | `src/app/restore-flow.ts` | `afterIo`의 `await io.settled();` 삭제 | 빨강 | `afterIo does not start stopping services until a tracked clone has finished` |
| M24 | `src/app/data-guard.ts` | `verifyIdentity`의 `id === m.clusterId &&` 삭제 | 빨강 | `staging whose pg_controldata id differs from the manifest is refused (aborted, data/ untouched)`, `data/ already swapped in but with a different pg_controldata id → restoreIncomplete` |

## 살아남은 변이 — M7

M7(`staged` 단계의 "판정표 밖 조합은 아무것도 옮기지 않고 멈춘다" 거부)을 지우고 기존 20개 테스트를 모두
돌려도 초록불이었다. 원인: `staged`에서 유효하지 않은 (D, R, S) 조합 6가지 중 5가지는, 거부 줄이 없어도
그대로 `moved-aside` 단계로 넘어가면 **그 단계 자신의 독립된 조합 검사**(`else if (!(D && R && !S)) throw
...`)가 우연히 같은 결론(`RestoreIncomplete`)에 닿아 걸러진다. 유일하게 빠져나가는 조합은
**(D=있음, R=있음, S=없음)이면서 D가 이미 그 스냅샷과 같은 신원인 경우**다 — `moved-aside`는 이 모양을
"D→R 이관까지 이미 끝난 정상 재개 상태"로 읽어 통과시키고, 그 뒤 `verifyIdentity(dataDir, ...)`도 D가
실제로 스냅샷과 같으므로 통과해, `staged`가 막아야 했던 미기재 조합이 조용히 `hold`(성공)로 끝난다 — 이때
아무것도 옮기거나 지우지는 않지만(거부 규칙 자체는 어기지 않는다), R에 있는 구 데이터가 영영 방치되고
`markRestored()`가 잘못된 완료를 기록한다.

`tests/services/postgres/restore-journal.test.ts`의 `advanceJournal — refusals move nothing` 표에
`"staged with D already matching the snapshot's identity and R present, no staging"` 케이스를
추가해 이 조합을 잡았다(별도 커밋 `test(phase6b): staged 단계의 미기재 조합(D·R만 있고 S 없음) 거부를
지킨다`). 추가한 테스트는 변이 없는 코드에서 통과함을 먼저 확인했고, M7을 다시 적용해 그 테스트가 빨간불이
되는 것을 확인한 뒤 소스를 되돌렸다.

## 전체 재확인

- `pnpm --filter damwha-desktop exec vitest run` → 70개 파일, 1272개 테스트 전부 통과.
- `git status --short` → `desktop/src` 변경 없음(추적되지 않은 `docs/images/2026-09-20/`만 남음, 손대지 않았다).

## 요약

24/24 빨간불, 동치 변이 0, 살아남은 변이 1(M7, 테스트 추가로 해소), 추가한 테스트 1개.
