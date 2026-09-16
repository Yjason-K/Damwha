/**
 * 앱이 띄운 자식 프로세스 하나. API·worker·embed·postmaster·Vite 런처가 모두 이 모양을 돌려주고, 감독자는 서비스
 * 종류를 모른 채 이것만 본다(services/types.ts의 ServiceHandle). Phase 1의 API 핸들에서 시작한 모양이라 아래 주석이
 * NestJS를 예로 든다.
 */
export interface ProcessHandle {
  readonly pid: number | undefined;
  alive(): boolean;
  /** 실패 화면에 올릴 stderr 꼬리. 사람이 읽을 마지막 줄이 여기서 나온다. */
  stderrTail(): string;
  /**
   * stdout 꼬리. NestJS 기본 ConsoleLogger는 `.error()`만 stderr로 보내고
   * `.log`/`.warn`/`.debug`/`.verbose`는 전부 stdout에 쓴다(2026-09-12 실측,
   * @nestjs/common의 console-logger.service.js). database.service.ts의 미적용
   * 마이그레이션 경고는 `.warn()`이라 stderrTail()로는 절대 보이지 않는다 — 그런
   * advisory 판정은 이 꼬리를 읽어야 한다.
   *
   * stderrTail과 절대 합치지 않는다. 합치면 평범한 stdout 로그 한 줄이
   * lastMeaningfulLine·isAddrInUse·`database unreachable` 판정(모두 "실패의 원인"을
   * stderr에서 찾는다는 전제로 쓰였다)을 오염시켜, 실패 화면이 엉뚱한 원인을 말하게 된다.
   */
  stdoutTail(): string;
  exitCode(): number | null;
  /**
   * 종료 알림. ready 뒤에 죽는 경우를 화면에 알리려면 이게 있어야 한다 (스펙 §8).
   * 이미 죽은 뒤에 등록해도 즉시 호출된다 — 등록과 종료의 경쟁을 없앤다.
   */
  onExit(listener: (code: number) => void): void;
  stop(graceMs: number): Promise<void>;
}
