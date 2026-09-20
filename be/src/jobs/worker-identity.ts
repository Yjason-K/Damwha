/**
 * 앱(Electron)이 띄운 worker의 신분 접두사. `desktop/src/config/config.ts`의 `RUN_WORKER_ID`가
 * `desktop-<uuid>`를 만들고, 앱은 그 값을 모든 자식 env(`WORKER_ID`)에 얹는다.
 *
 * 회수가 이 접두사로 경계를 긋는 이유: 터미널 `pnpm worker`(`worker-1`)와 웹 배포판의 job을
 * 앱이 뺏지 않기 위해서다 (Phase 2의 "외부 서비스와 앱 소유를 구분한다").
 */
export const APP_WORKER_PREFIX = 'desktop-';

/** 이 신분이 앱이 띄운 worker의 것인가. */
export function isAppWorkerId(workerId: string): boolean {
  return workerId.startsWith(APP_WORKER_PREFIX);
}
