/**
 * 사람에게 보이는 실패 원인 문구의 **목록**. 어댑터·감독자·main.ts가 원인을 적을 때 여기서
 * 가져다 쓰고, shell-hints.ts의 HINTS가 같은 키로 복구 안내를 짝짓는다.
 *
 * 한 자리에 모으는 이유는 "원인의 종류"를 **셀 수 있게** 하기 위해서다. 전에는 문구가 다섯
 * 파일에 흩어진 문자열 리터럴이라 안내 매핑이 어느 원인을 빠뜨렸는지 아무도 알 수 없었고, 실제로
 * 브리프의 정규식 목록은 `/Docker Desktop/`이 "docker를 찾지 못했어요. Docker Desktop을
 * 설치했는지…"까지 먼저 삼켜 그 원인에 틀린 안내("실행하세요")를 붙였다. 키가 여기 하나로
 * 정해지면 HINTS가 `Record<CauseId, …>`라 안내를 정하지 않은 원인은 타입 검사에서 걸리고,
 * 테스트는 손으로 적은 표가 아니라 이 객체를 돌며 매핑을 확인한다(tests/recovery-hint.test.ts).
 *
 * 문구에는 **원인만** 적는다. 고치는 방법은 HINTS에 있다 — 둘을 한 문장에 넣으면 상태 창과
 * 실패 화면이 같은 안내를 두 번 말한다.
 *
 * 키 순서가 곧 매칭 우선순위다. 구체적인 원인을 먼저, 감독자의 일반 문구를 나중에 둔다 —
 * 일반 문구("준비 확인이 실패했어요 — <예외>")의 꼬리에 구체적인 원인이 실려 올 수 있고,
 * 그때는 구체적인 쪽의 안내가 맞다.
 *
 * 여기 없는 것: 서브프로세스 stderr·compose 출력·예외 메시지를 그대로 옮기는 원인. 종류가
 * 아니라 원문이라 짝지을 안내가 없고, recoveryHint는 그런 원인에 undefined를 돌려준다.
 *
 * electron을 import하지 않는 순수 모듈이다.
 */

import { HF_GATED_MODEL_PAGE_URL } from "../config/token-store";

export interface Cause {
  /** detail 안에서 이 원인을 알아보는 모양. 다른 원인의 문구와 겹치면 안 된다(테스트가 본다). */
  match: RegExp;
  /** 원인 문구. 값이 끼는 원인은 함수다. */
  text: string | ((...args: never[]) => string);
  /**
   * 사람이 **아무것도 하지 않아도** 풀리는 원인인가. degraded 서비스의 안내가 이것으로 갈린다
   * (shell-hints.ts의 recoveryHint): true면 "자동으로 복구됩니다"(DEGRADED_HINT), false면 그 원인
   * 자신의 안내다.
   *
   * degraded라고 저절로 풀리는 것이 아니다. 감독자의 재프로브가 readiness의 실패를 그대로
   * degraded에 싣기도 한다 — ready였던 postgres가 재프로브에서 원인 모를 not-ready를 받으면
   * `notAnswering`으로 degraded가 되고, 왜 그런지 모르므로 스스로 풀린다고 약속할 근거가 없다.
   * 전에는 degraded면 원인을 보지 않고 "자동으로 복구됩니다"를 붙여 바로 그 판단을 지웠다
   * (Task 14 리뷰 I-1).
   *
   * 필수 필드라 원인을 더하면서 정하지 않으면 lint(tsc)가 걸린다. 모르면 false다 — 거짓 안심이
   * 침묵보다 나쁘다.
   */
  selfRecovers: boolean;
}

export const CAUSES = {
  // Phase 4가 지운 둘: `uvMissing`·`workerEnvMissing` (스펙 §8). 앱은 uv를 부르지 않고
  // (`process/python-launcher.ts`가 번들 python을 직접 띄운다) worker의 `.env`도 읽지 않는다
  // (`config/config.ts`가 자식 env를 전부 합성한다) — 두 원인은 어떤 어댑터도 더 이상 내지 않는다.
  // 남겨 두면 "고칠 수 없는 것을 고치라"는 안내가 화면에 남는다.

  /** api — 기동 로그의 미적용 마이그레이션 경고 (스펙 §6.7 게이트). */
  pendingMigrations: {
    match: /적용되지 않은 마이그레이션이/,
    text: (count: number, names: string) => `적용되지 않은 마이그레이션이 ${count}개 있어요 (${names}).`,
    selfRecovers: false,
  },
  /** worker — 외부 supervisor가 있어 앱이 자기 것을 띄우지 않았다 (stand-down, 스펙 §6.5). */
  externalWorker: {
    match: /외부 worker가 실행 중이에요/,
    text: (pids: readonly number[]) =>
      `외부 worker가 실행 중이에요 (pid ${pids.join(", ")}). 앱은 자기 worker를 띄우지 않습니다. ` +
      "그 worker의 STORAGE_ROOT가 앱과 다르면 앱으로 올린 파일이 처리되지 않아요.",
    selfRecovers: false,
  },
  /** embed — 그 주소의 서비스가 다른 모델·차원을 서빙한다 (스펙 §6.5 계약 프로브). */
  embedMismatch: {
    match: /을 서빙하고 있어요 \(앱은 /,
    text: (model: string, dimension: number, wantModel: string, wantDimension: number) =>
      `모델 ${model}·차원 ${dimension}을 서빙하고 있어요 (앱은 ${wantModel}·${wantDimension}이 필요해요)`,
    selfRecovers: false,
  },
  /**
   * dev 전용 (Phase 4 스펙 §6.3) — config.json의 REPO_ROOT도, 앱 폴더의 상위(`desktop/..`)도 저장소가 아니다.
   * packaged는 저장소를 쓰지 않으므로 이 원인이 나지 않는다. dev의 API·마이그레이션 러너·worker의
   * PYTHONPATH가 저장소를 요구하는 자리에서 path.join 전에 이것을 던진다.
   */
  repoRootMissing: {
    match: /저장소 폴더를 확인하지 못했어요/,
    text: "개발 실행인데 담화 저장소 폴더를 확인하지 못했어요.",
    selfRecovers: false,
  },
  /**
   * `safeStorage.isEncryptionAvailable()`이 false다 (스펙 2026-09-25 §5.1 — Phase 4 §6.4의 첫 실행
   * 게이트를 대체했다). **더는 기동을 막지 않는다** — `app/token-boot.ts`가 이 상태를 `unavailable`로
   * 읽고 토큰 없이 서비스를 띄운다. 평문으로 저장하는 폴백은 없다. 담화 화면의 토큰 다리
   * (`windows/token-bridge.ts`)가 그 화면에서 저장을 시도할 때만 이 문구를 쓴다.
   */
  safeStorageUnavailable: {
    match: /키체인을 쓸 수 없어 허깅페이스 토큰을/,
    text: "macOS 키체인을 쓸 수 없어 허깅페이스 토큰을 안전하게 보관할 수 없어요. 토큰 없이 실행 중이에요 — 화자 분리가 필요한 기능은 막혀 있어요.",
    selfRecovers: false,
  },
  /**
   * 기동 게이트 — 이전 실행이 남긴 고아를 찾는 `ps` 스캔이 실패했다 (Phase 4 스펙 §6.5·§8, P4-C22). 서비스를
   * 하나도 띄우지 않는다: 그대로 진행하면 고아 worker와 새 worker가 같은 job을 집는다. main.ts가 manual 실패로
   * 던진다(app/reap-on-start.ts) — 같은 ps가 3·8·20초 뒤에 달라질 근거가 없고, 메뉴의 "다시 시도"가 스캔을
   * 다시 돈다. 실패한 까닭(ps의 오류)은 supervisor.log에 있다.
   */
  orphanScanFailed: {
    match: /이전 실행이 남긴 프로세스를 확인하지 못해/,
    text: "이전 실행이 남긴 프로세스를 확인하지 못해 서비스를 띄우지 않았어요.",
    selfRecovers: false,
  },
  /** 토큰 검증 — HF가 401·403으로 거절했다 (스펙 §8 "토큰이 유효하지 않아요"). 담화 화면의 토큰 폼이 입력칸 아래에 사유와 함께 싣는다. */
  hfTokenInvalid: {
    match: /허깅페이스 토큰이 유효하지 않아요/,
    text: "허깅페이스 토큰이 유효하지 않아요.",
    selfRecovers: false,
  },
  /**
   * 모델 다운로드 403 — 토큰의 계정이 그 모델의 사용 조건에 동의하지 않았다 (스펙 §8). 조건 수락이 필요한 모델은
   * 화자 분리 하나라 그 수락 페이지를 싣는다. 이 원인의 소유는 Task 6이다 — 화면에 싣는 일(Task 11)은 이것을 쓴다.
   */
  hfGateNotAccepted: {
    match: /사용 조건 수락이 필요해요/,
    text: `이 모델은 사용 조건 수락이 필요해요 — ${HF_GATED_MODEL_PAGE_URL}`,
    selfRecovers: false,
  },
  /**
   * 모델 다운로드가 실패했다 (스펙 §6.9·§8). `app_setting.model_readiness`의 `failed` 항목에서
   * 온다 — 원문은 worker의 `errors.download_error`가 만든 `"<code>: <message>"`다.
   *
   * **401·403은 이 원인이 아니다.** 그 둘은 code(`hf_token_invalid`·`hf_gate_not_accepted`)로 갈려
   * 위의 `hfTokenInvalid`·`hfGateNotAccepted`로 간다(판정 R-11a). 여기 오는 것은 나머지 —
   * 네트워크·타임아웃·5xx·오프라인 캐시 미스, 그리고 code를 알아볼 수 없는 경우다.
   *
   * 층은 이 원인이 정하지 않는다. `errorKind`가 TRANSIENT면 1층(기다린다), 그 밖이면 2층(다시
   * 시작)이고, 그 판정은 화면(status-view.ts의 modelRows)에 있다 — 여기 문구는 **무엇이**
   * 실패했는지만 말한다.
   */
  modelDownloadFailed: {
    match: /모델을 받지 못했어요/,
    text: (key: string, reason: string) => `모델을 받지 못했어요 (${key}) — ${reason}`,
    selfRecovers: false,
  },
  /**
   * 받는 중이라고 적혀 있는데 진행이 멈췄다 (스펙 §6.9 — 읽는 쪽이 `updated_at`이 멈춘
   * `downloading`을 "중단됨"으로 보인다, §8 — "진행이 멈췄어요" + 서비스 다시 시작).
   *
   * writer가 정리해 주기를 기대하지 않는다: 프로세스가 크래시하면 그 `downloading`은 영원히 남는다.
   * 판정은 `services/model-readiness.ts`의 `STALL_MS` 하나를 쓴다 — 규칙의 사본을 두지 않는다.
   */
  modelDownloadStalled: {
    match: /진행이 멈췄어요/,
    text: (key: string) => `모델을 받는 중인데 진행이 멈췄어요 (${key}).`,
    selfRecovers: false,
  },
  /**
   * 디스크가 찼다 (스펙 §8 — "남은 용량과 필요한 용량"). 모델 한 벌이 수 GB라 받는 도중에 이것이
   * 난다.
   *
   * **내는 곳이 둘이다** (Phase 6a 스펙 §8):
   *   - worker의 `models/disk.py`가 다운로드 전에 재고 `DISK_FULL`(PERMANENT)로 던진다.
   *     job 경로면 회의 카드에, embed 기동이면 상태 창에 뜬다. LLM은 상태 창이 아니다 — 모델을
   *     요청 스레드에서 받으므로 `llm_server.py`의 `run_guarding_disk_full`이 그 job을 실패시키고
   *     (R16) 요약 카드에 뜬다. 렌즈 칸은 사유를 그리지 않는다(최종 리뷰 M3).
   *   - API의 `storage/disk-full.filter.ts`가 업로드 ENOSPC를 507 + `code: "DISK_FULL"`로 바꾼다.
   *     업로드 시점에는 "필요한 용량"을 모르므로 화면은 남은 용량만 말한다.
   *
   * 두 곳이 **같은 문구**에 닿는 것이 요점이다. worker 쪽 문자열은 아래 `match`가 알아본다 —
   * 그 둘이 어긋나면 사유가 로그에만 남고 화면은 벙어리가 된다. `causes.test.ts`가 그것을 고정한다.
   */
  diskFull: {
    match: /디스크 공간이 부족해요/,
    text: (free: string, needed: string) =>
      `디스크 공간이 부족해요 — 남은 용량 ${free}, 필요한 용량 ${needed}.`,
    selfRecovers: false,
  },
  /** postgres — 번들에 PG 실행 파일이 없다 (Phase 3 스펙 §6.8). */
  pgBundleMissing: {
    match: /내장 데이터베이스 실행 파일이 없어요/,
    text: (names: readonly string[]) => `내장 데이터베이스 실행 파일이 없어요 (${names.join(", ")}).`,
    selfRecovers: false,
  },
  /** postgres — macOS sun_path 한도 (스펙 §6.3). */
  pgSocketPathTooLong: {
    match: /데이터베이스 소켓 경로가 너무 길어요/,
    text: (socketPath: string, bytes: number) =>
      `데이터베이스 소켓 경로가 너무 길어요 (${bytes}바이트, 최대 103바이트): ${socketPath}`,
    selfRecovers: false,
  },
  /** postgres — 판정표 1·2의 거부 (스펙 §6.2). why는 어떤 행인지를 사람 말로 적는다. */
  pgPairingRefused: {
    match: /짝이 맞지 않아 데이터베이스를 열지 않았어요/,
    text: (why: string, pgdata: string, storage: string) =>
      `데이터와 파일 저장소의 짝이 맞지 않아 데이터베이스를 열지 않았어요 — ${why} (데이터베이스: ${pgdata}, 파일 저장소: ${storage})`,
    selfRecovers: false,
  },
  /** postgres — PG_VERSION이 번들 메이저와 다르다. 메이저 업그레이드는 Phase 6. */
  pgVersionMismatch: {
    match: /데이터 폴더의 PostgreSQL 버전\(/,
    text: (found: string, want: string) => `데이터 폴더의 PostgreSQL 버전(${found})이 앱의 버전(${want})과 달라요.`,
    selfRecovers: false,
  },
  /** postgres — pg_controldata가 클러스터를 읽지 못했다. */
  pgControldataFailed: {
    match: /데이터베이스 폴더를 읽지 못했어요/,
    text: (detail: string) => `데이터베이스 폴더를 읽지 못했어요 — ${detail}`,
    selfRecovers: false,
  },
  /** postgres — 락 파일의 pid가 누구인지 증명하지 못했다 (ps 실패). 지우지 않는다. */
  pgLockUnprovable: {
    match: /데이터베이스 잠금 파일의 주인/,
    text: (pid: number, file: string, why: string) =>
      `데이터베이스 잠금 파일의 주인(pid ${pid})을 확인하지 못했어요 (${file}) — ${why}`,
    selfRecovers: false,
  },
  /** postgres — 이전 실행의 고아 postmaster가 SIGINT·SIGQUIT에도 남았다. */
  pgOrphanStuck: {
    match: /이전 실행이 남긴 데이터베이스\(pid/,
    text: (pid: number) => `이전 실행이 남긴 데이터베이스(pid ${pid})가 종료되지 않아요.`,
    selfRecovers: false,
  },
  pgInitdbFailed: {
    match: /데이터베이스 클러스터를 만들지 못했어요/,
    text: (block: string) => `새 데이터베이스 클러스터를 만들지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  pgCreatedbFailed: {
    match: /데이터베이스\(damwha\)를 만들지 못했어요/,
    text: (block: string) => `데이터베이스(damwha)를 만들지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  /** postgres — 판정표 2의 psql 조회 자체가 실패했다. */
  pgQueryFailed: {
    match: /데이터베이스 상태를 확인하지 못했어요/,
    text: (block: string) => `데이터베이스 상태를 확인하지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  /** postgres 종료 — fast·immediate 유예 뒤에도 postmaster가 남았다. 앱은 SIGKILL하지 않는다. */
  pgStopLeaked: {
    match: /데이터베이스\(pid [^)]*\)가 종료되지 않았어요/,
    text: (pid: number | string) => `데이터베이스(pid ${pid})가 종료되지 않았어요.`,
    selfRecovers: false,
  },
  /** postgres degraded — postmaster.pid가 stopping이다. */
  pgStopping: {
    match: /데이터베이스가 종료되는 중이에요/,
    text: "데이터베이스가 종료되는 중이에요.",
    selfRecovers: false,
  },
  /** api 게이트 — 러너가 실패했거나 상태 줄을 내지 않았다. 무출력 exit 0도 여기다 (스펙 §10). */
  migrationStatusFailed: {
    match: /마이그레이션 상태를 확인하지 못했어요/,
    text: (block: string) => `마이그레이션 상태를 확인하지 못했어요.\n${block}`,
    selfRecovers: false,
  },
  /** api 게이트 — 번들에 없는 이름이 적용돼 있다. 옛 앱이 새 스키마를 열지 않는다 (스펙 §6.5-2). */
  migrationUnknown: {
    match: /더 새 버전의 앱이 이 데이터를 업데이트했어요/,
    text: (names: readonly string[]) => `더 새 버전의 앱이 이 데이터를 업데이트했어요 (${names.join(", ")}).`,
    selfRecovers: false,
  },
  /** api 게이트 — 적용 전 백업 실패. 적용하지 않았다. */
  backupFailed: {
    match: /백업을 만들지 못해 마이그레이션을 적용하지 않았어요/,
    text: (block: string) => `마이그레이션 전 백업을 만들지 못해 마이그레이션을 적용하지 않았어요.\n${block}`,
    selfRecovers: false,
  },
  /** api 게이트 — 러너가 실패했다. 백업이 있으면 그 경로를 싣는다. */
  migrationFailed: {
    match: /^마이그레이션을 적용하지 못했어요/m,
    text: (block: string, backup: string | null) =>
      `마이그레이션을 적용하지 못했어요.${backup === null ? "" : ` 적용 전 백업: ${backup}`}\n${block}`,
    selfRecovers: false,
  },
  /** api — 실행 게이트를 통과했는데 러너나 API가 미적용을 말한다. 두 트리가 어긋났다 (스펙 §6.5-5). */
  migrationsStillPending: {
    match: /마이그레이션을 실행했는데 \d+개가 여전히 적용되지 않았어요/,
    text: (count: number, names: string) => `마이그레이션을 실행했는데 ${count}개가 여전히 적용되지 않았어요 (${names}).`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 앞 실행의 앱 소유 Python이 회수 뒤에도 살아 있다 (Phase 6b-2 스펙 §5.2-2). 쓰는 중일 수 있어 스냅샷·교체를 하지 않는다. */
  writersAlive: {
    match: /이전 실행의 처리 프로세스가 아직 남아 있어요/,
    text: (pids: readonly number[]) => `이전 실행의 처리 프로세스가 아직 남아 있어요 (pid ${pids.join(", ")}).`,
    selfRecovers: false,
  },
  /** 데이터 가드 — packaged인데 빌드 식별자가 없다 (§4). 번들 결함이다. */
  buildInfoMissing: {
    match: /앱의 빌드 정보를 읽지 못했어요/,
    text: (file: string) => `앱의 빌드 정보를 읽지 못했어요 (${file}).`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 판올림 스냅샷 실패 (§5.4). 기동하지 않는다. */
  snapshotFailed: {
    match: /업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요/,
    text: (reason: string, dir: string) => `업데이트 전 스냅샷을 만들지 못해 시작하지 않았어요 (${dir}).\n${reason}`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 되돌리기 저널을 읽을 수 없다 (§6.3). 아무것도 옮기지 않았다. */
  restoreJournalUnreadable: {
    match: /되돌리기 기록을 읽을 수 없어요/,
    text: (file: string, why: string) => `되돌리기 기록을 읽을 수 없어요 (${file}): ${why}`,
    selfRecovers: false,
  },
  /** 데이터 가드 — 교체를 이어 갈 수 없다 (§6.3 "그 밖의 조합"·rename 실패·신원 불일치). */
  restoreIncomplete: {
    match: /업데이트 전 데이터로 되돌리는 작업을 마치지 못했어요/,
    text: (detail: string) => `업데이트 전 데이터로 되돌리는 작업을 마치지 못했어요.\n${detail}`,
    selfRecovers: false,
  },
  /**
   * 데이터 가드 — postgres preLaunch 훅(자동 재시작·상태 창 재시작)이 저널을 만났다 (§5.2). 앱이 떠 있는 동안에는 교체하지
   * 않는다 — 저널은 다음 첫 기동의 가드가 잇는다. 아무것도 옮기지 않았다.
   */
  restorePending: {
    match: /업데이트 전으로 되돌리는 작업이 기다리고 있어요/,
    text: () => "업데이트 전으로 되돌리는 작업이 기다리고 있어요.",
    selfRecovers: false,
  },
  /** 데이터 가드 — 되돌리기를 시작 전에 취소했다 (§6.3 requested 실패). 실패가 아니라 알림이다. */
  restoreAborted: {
    match: /되돌리기를 취소했어요/,
    text: (reason: string) => `되돌리기를 취소했어요. 지금 데이터는 그대로예요.\n${reason}`,
    selfRecovers: false,
  },
  /**
   * worker·embed — 번들 python(`ctx.bins.python`)이 그 자리에 없다. main.ts는 번들 경로를 만들 뿐
   * 존재를 확인하지 않는다(process/runtime-paths.ts). 이 문구는 **앱이 쓰지 않는다.** Node의
   * `spawn <경로> ENOENT`이고, launchPython이 싱크에 적는 `spawn failed: <e.message>`를 감독자가
   * 죽은 자식의 블록으로 올린다.
   *
   * 위 Phase 3 원인들(pgInitdbFailed·pgControldataFailed·pgCreatedbFailed·pgQueryFailed·
   * migrationStatusFailed·backupFailed·migrationFailed) **뒤**에 둔다. 그 원인들은 도구 실행
   * 자체가 spawn ENOENT로 실패한 경우를 describeToolFailure의 "실행하지 못했어요 (spawn … ENOENT)"로
   * 자기 block 안에 그대로 옮겨 담는데, 이 원인이 그 앞에 있으면 CAUSE_IDS.find가 여기서 먼저
   * 걸려 "마이그레이션 러너를 실행하지 못했어요" 같은 Phase 3 실패가 엉뚱하게 worker·embed의 안내를 받는다
   * (한 자리 리뷰). Phase 3 원인의 정규식은 모두 자기 문구의 맨 앞 한국어로 시작해 매칭되므로,
   * 순서만 뒤로 미뤄도 그쪽이 먼저 잡는다.
   */
  spawnNotFound: {
    match: /spawn \S+ ENOENT/,
    text: (bin: string) => `spawn failed: spawn ${bin} ENOENT`,
    selfRecovers: false,
  },
  /** postgres — DEBUG_EXTERNAL_DATABASE_URL로 붙었다. 실패가 아니라 상시 경고다 (스펙 §6.1). */
  externalDatabase: {
    match: /외부 DB\(디버깅\)/,
    text: "외부 DB(디버깅) — DEBUG_EXTERNAL_DATABASE_URL로 연결했어요. 앱은 이 데이터베이스를 띄우지도, 마이그레이션하지도 않아요.",
    selfRecovers: false,
  },
  /**
   * api degraded — 부팅 뒤 DB가 끊겼다 (스펙 §6.6). API는 살아 있고 DB가 돌아오면 스스로 다시 붙는다 —
   * 이 서비스에서 사람이 할 일은 없다. DB가 **왜** 안 돌아오는지(postgres가 재시작 중이거나 거부됐다)는
   * postgres 줄이 자기 원인과 안내로 말한다.
   */
  apiDbUnreachable: {
    match: /데이터베이스에 연결할 수 없어요/,
    text: "데이터베이스에 연결할 수 없어요.",
    selfRecovers: true,
  },
  /** worker degraded — ready 뒤 reconnect 실패 (스펙 §6.6). `_reconnect()` 백오프가 DB 복귀를 스스로 잡는다. */
  workerDbUnreachable: {
    match: /데이터베이스에 연결할 수 없어 작업을 집지 못하고/,
    text: "데이터베이스에 연결할 수 없어 작업을 집지 못하고 있어요.",
    selfRecovers: true,
  },
  /** api — EADDRINUSE. 다음 기동이 다른 포트를 고른다. */
  portInUse: {
    match: /포트가 이미 쓰이고 있어요/,
    text: "포트가 이미 쓰이고 있어요.",
    selfRecovers: false,
  },
  /** api — 후보 포트가 전부 막혔다. */
  noFreePort: {
    match: /번 시도했지만 쓸 수 있는 포트를 찾지 못했어요/,
    text: (attempts: number) => `${attempts}번 시도했지만 쓸 수 있는 포트를 찾지 못했어요.`,
    selfRecovers: false,
  },
  /** api·worker — readiness가 핸들 없는 결과를 받았다. 불변식 위반이라 사람이 할 일이 없다. */
  noHandle: {
    match: /핸들이 없어요/,
    text: "핸들이 없어요.",
    selfRecovers: false,
  },
  /** 감독자 — 자식이 죽었다. 뒤에 stderr 블록이 붙는다. */
  processExited: {
    match: /프로세스가 종료됐어요 \(코드 /,
    text: (code: number | string) => `프로세스가 종료됐어요 (코드 ${code}).`,
    selfRecovers: false,
  },
  /** 감독자 — 준비 유예를 넘겼다. */
  readyTimeout: {
    match: /준비 시간을 넘겼어요/,
    text: "준비 시간을 넘겼어요.",
    selfRecovers: false,
  },
  /** 감독자 — 준비 판정 자체가 던졌다. */
  readinessThrew: {
    match: /준비 확인이 실패했어요 — /,
    text: (reason: string) => `준비 확인이 실패했어요 — ${reason}`,
    selfRecovers: false,
  },
  /** 감독자 — ready 뒤 재프로브가 던졌다 (degraded). 왜인지 모르므로 스스로 풀린다고도 말하지 않는다. */
  healthProbeThrew: {
    match: /상태 확인이 실패했어요 — /,
    text: (reason: string) => `상태 확인이 실패했어요 — ${reason}`,
    selfRecovers: false,
  },
  /**
   * 감독자 — ready 뒤 재프로브가 not-ready를 돌려줬다 (degraded). 스스로 풀린다고 볼 근거가 없다:
   * ready였던 postgres가 재프로브에서 원인 모를 not-ready를 받는 경우가 이 모양이고(예:
   * postmaster.pid가 잠깐 "ready"도 "stopping"도 아닌 값을 보인다), 왜 그런지 모르므로
   * 사람이 확인하기 전에는 그대로다.
   */
  notAnswering: {
    match: /준비 상태로 답하지 않아요/,
    text: "준비 상태로 답하지 않아요.",
    selfRecovers: false,
  },
  /** 감독자 — detectExternal이 던졌다. */
  externalCheckFailed: {
    match: /외부 인스턴스 확인이 실패했어요 — /,
    text: (reason: string) => `외부 인스턴스 확인이 실패했어요 — ${reason}`,
    selfRecovers: false,
  },
  /**
   * 감독자 — "서비스 다시 시작"이 유예 안에 그 서비스를 내리지 못했다 (스펙 §6.10 2층).
   * 어댑터의 까닭이 있으면 이 문구 **뒤에** 함께 실린다.
   *
   * **"다시 시도해 주세요"라고 말하지 않는다.** 그 서비스에는 이미 종료 신호가 갔고, 두 번째
   * 신호는 worker에게 강제 종료다 — 처리 중이던 job이 requeue 없이 버려진다
   * (`be/worker/damwha_worker/__main__.py`의 누적 카운트, P2-C5). 그래서 감독자가 그 프로세스가
   * 끝날 때까지 재시작을 막고(`ServiceStatus.cleaningUp`), 화면도 기다리라고만 말한다.
   */
  restartStopFailed: {
    match: /를 내리는 중이에요/,
    text: (id: string) => `${id}를 내리는 중이에요. 아직 끝나지 않아 다시 띄우지 않았어요.`,
    selfRecovers: false,
  },
} as const satisfies Record<string, Cause>;

export type CauseId = keyof typeof CAUSES;

/** 매칭 우선순위대로 늘어놓은 키. 객체의 선언 순서다. */
export const CAUSE_IDS = Object.keys(CAUSES) as CauseId[];

/** detail에서 처음 맞는 원인. 모르는 원인이면 undefined다. */
export function causeIn(detail: string): CauseId | undefined {
  return CAUSE_IDS.find((id) => CAUSES[id].match.test(detail));
}
