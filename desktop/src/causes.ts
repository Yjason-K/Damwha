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

export interface Cause {
  /** detail 안에서 이 원인을 알아보는 모양. 다른 원인의 문구와 겹치면 안 된다(테스트가 본다). */
  match: RegExp;
  /** 원인 문구. 값이 끼는 원인은 함수다. */
  text: string | ((...args: never[]) => string);
}

export const CAUSES = {
  /** postgres — docker CLI가 데몬에 못 붙었다 (postgres.ts의 DAEMON_DOWN). */
  dockerDaemonDown: {
    match: /Docker Desktop이 실행 중이 아니에요/,
    text: "Docker Desktop이 실행 중이 아니에요.",
  },
  /** main.ts — config.json에도 탐색 목록에도 docker가 없다. */
  dockerMissing: {
    match: /docker를 찾지 못했어요/,
    text: "docker를 찾지 못했어요.",
  },
  /** worker·embed — config.json에도 탐색 목록에도 uv가 없다. */
  uvMissing: {
    match: /uv를 찾지 못했어요/,
    text: "uv를 찾지 못했어요.",
  },
  /**
   * 경로는 있었는데 그 자리에 실행 파일이 없다 — config.json의 UV_BIN·DOCKER_BIN이 틀린 경우다
   * (탐색은 존재하는 파일만 돌려준다). 이 문구는 **앱이 쓰지 않는다.** Node의 `spawn <경로> ENOENT`
   * 이고, 두 길로 올라온다: launchWithUv가 싱크에 적는 `spawn failed: <e.message>`를 감독자가 죽은
   * 자식의 블록으로(worker·embed), main.ts의 dockerRun이 `Error: <e.message>`를 compose stderr
   * 자리로(postgres).
   */
  spawnNotFound: {
    match: /spawn \S+ ENOENT/,
    text: (bin: string) => `spawn failed: spawn ${bin} ENOENT`,
  },
  /** worker — be/worker/.env가 없다. */
  workerEnvMissing: {
    match: /\.env가 없어요/,
    text: "be/worker/.env가 없어요.",
  },
  /** api — 기동 로그의 미적용 마이그레이션 경고 (스펙 §6.7 게이트). */
  pendingMigrations: {
    match: /적용되지 않은 마이그레이션이/,
    text: (count: number, names: string) => `적용되지 않은 마이그레이션이 ${count}개 있어요 (${names}).`,
  },
  /** worker — 외부 supervisor가 있어 앱이 자기 것을 띄우지 않았다 (stand-down, 스펙 §6.5). */
  externalWorker: {
    match: /외부 worker가 실행 중이에요/,
    text: (pids: readonly number[]) =>
      `외부 worker가 실행 중이에요 (pid ${pids.join(", ")}). 앱은 자기 worker를 띄우지 않습니다. ` +
      "그 worker의 STORAGE_ROOT가 앱과 다르면 앱으로 올린 파일이 처리되지 않아요.",
  },
  /** embed — 그 주소의 서비스가 다른 모델·차원을 서빙한다 (스펙 §6.5 계약 프로브). */
  embedMismatch: {
    match: /을 서빙하고 있어요 \(앱은 /,
    text: (model: string, dimension: number, wantModel: string, wantDimension: number) =>
      `모델 ${model}·차원 ${dimension}을 서빙하고 있어요 (앱은 ${wantModel}·${wantDimension}이 필요해요)`,
  },
  /** main.ts — 설정된 REPO_ROOT가 저장소가 아니고, 고른 폴더도 아니었다. */
  repoRootMissing: {
    match: /저장소 폴더를 확인하지 못했어요/,
    text: "저장소 폴더를 확인하지 못했어요.",
  },
  /** api degraded — 부팅 뒤 DB가 끊겼다 (스펙 §6.6). */
  apiDbUnreachable: {
    match: /데이터베이스에 연결할 수 없어요/,
    text: "데이터베이스에 연결할 수 없어요.",
  },
  /** worker degraded — ready 뒤 reconnect 실패 (스펙 §6.6). */
  workerDbUnreachable: {
    match: /데이터베이스에 연결할 수 없어 작업을 집지 못하고/,
    text: "데이터베이스에 연결할 수 없어 작업을 집지 못하고 있어요.",
  },
  /** api — EADDRINUSE. 다음 기동이 다른 포트를 고른다. */
  portInUse: {
    match: /포트가 이미 쓰이고 있어요/,
    text: "포트가 이미 쓰이고 있어요.",
  },
  /** api — 후보 포트가 전부 막혔다. */
  noFreePort: {
    match: /번 시도했지만 쓸 수 있는 포트를 찾지 못했어요/,
    text: (attempts: number) => `${attempts}번 시도했지만 쓸 수 있는 포트를 찾지 못했어요.`,
  },
  /** api·worker — readiness가 핸들 없는 결과를 받았다. 불변식 위반이라 사람이 할 일이 없다. */
  noHandle: {
    match: /핸들이 없어요/,
    text: "핸들이 없어요.",
  },
  /** 감독자 — 자식이 죽었다. 뒤에 stderr 블록이 붙는다. */
  processExited: {
    match: /프로세스가 종료됐어요 \(코드 /,
    text: (code: number | string) => `프로세스가 종료됐어요 (코드 ${code}).`,
  },
  /** 감독자 — 준비 유예를 넘겼다. */
  readyTimeout: {
    match: /준비 시간을 넘겼어요/,
    text: "준비 시간을 넘겼어요.",
  },
  /** 감독자 — 준비 판정 자체가 던졌다. */
  readinessThrew: {
    match: /준비 확인이 실패했어요 — /,
    text: (reason: string) => `준비 확인이 실패했어요 — ${reason}`,
  },
  /** 감독자 — ready 뒤 재프로브가 던졌다 (degraded). */
  healthProbeThrew: {
    match: /상태 확인이 실패했어요 — /,
    text: (reason: string) => `상태 확인이 실패했어요 — ${reason}`,
  },
  /** 감독자 — ready 뒤 재프로브가 not-ready를 돌려줬다 (degraded). */
  notAnswering: {
    match: /준비 상태로 답하지 않아요/,
    text: "준비 상태로 답하지 않아요.",
  },
  /** 감독자 — detectExternal이 던졌다. */
  externalCheckFailed: {
    match: /외부 인스턴스 확인이 실패했어요 — /,
    text: (reason: string) => `외부 인스턴스 확인이 실패했어요 — ${reason}`,
  },
} as const satisfies Record<string, Cause>;

export type CauseId = keyof typeof CAUSES;

/** 매칭 우선순위대로 늘어놓은 키. 객체의 선언 순서다. */
export const CAUSE_IDS = Object.keys(CAUSES) as CauseId[];

/** detail에서 처음 맞는 원인. 모르는 원인이면 undefined다. */
export function causeIn(detail: string): CauseId | undefined {
  return CAUSE_IDS.find((id) => CAUSES[id].match.test(detail));
}
