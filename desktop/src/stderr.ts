/**
 * API 자식 stderr에서 사람에게 보여줄 원인 한 줄을 뽑는다. electron을 import하지
 * 않는 순수 모듈이다 — shell-window.ts는 electron을 값으로 import해 vitest가 못
 * 불러오므로, 테스트 대상 로직을 여기로 뺐다 (Fix round 1, 스펙 §6.5/§8).
 */

// NestJS Logger는 stderr가 TTY가 아니어도 ANSI 색상 escape를 쓴다. textContent로
// 넣으면 그 제어문자가 글자 그대로 남아, 원인을 알려 주는 화면이 깨져 보인다.
// eslint-disable-next-line no-control-regex
export const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** be/src/main.ts의 fail-fast 계약: 부팅 실패는 항상 `startup failed: <message>` 한
 *  줄로 시작한다(main.ts의 bootstrap().catch). <message>가 zod 에러처럼 여러 줄
 *  (JSON.stringify pretty-print)이면 그 뒤로 원본 JSON이 그대로 이어지고 마지막
 *  줄은 닫는 대괄호 `]`뿐이다 — "마지막 줄"을 고르면 원인이 사라진다. */
const STARTUP_FAILED = "startup failed:";

/** 최소한 글자나 숫자 하나는 있어야 "의미 있는 줄"로 친다. zod pretty-print의 `]`,
 *  `},`, `[` 같은 순수 괄호/구두점 줄은 원인을 설명하지 못한다. 유니코드 인식이라
 *  한글도 "글자"로 잡는다. */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * API stderr에서 사람에게 보여줄 마지막 의미 있는 줄.
 *
 * 1순위: `startup failed:`를 담은 마지막 줄 — 우리 자신의 에러 계약이 찍는 줄이라
 *        가장 신뢰할 수 있다(한 줄짜리 원인이든, 여러 줄 메시지의 첫 줄이든).
 * 2순위: 그 줄이 없으면 괄호·구두점뿐인 줄을 건너뛰고 글자/숫자가 있는 마지막 줄.
 * 3순위: 그마저 없으면(입력이 비었거나 공백뿐이면) 빈 문자열.
 */
export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .replace(ANSI_SGR, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes(STARTUP_FAILED)) return lines[i];
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (HAS_CONTENT.test(lines[i])) return lines[i];
  }
  return "";
}

/** 원인 블록의 기본 상한. 화면이 감당할 수 있는 줄 수이고, 전문은 로그 파일에 있다. */
const BLOCK_LIMIT = 24;

/**
 * `startup failed:`부터 끝까지를 블록으로 돌려준다.
 *
 * lastMeaningfulLine은 한 줄만 고르므로 zod 검증 실패처럼 여러 줄인 원인이 화면에
 * `startup failed: [`까지만 보였다(Phase 1 결과의 남은 한계). 원인 문장은 로그에만 있었다.
 * 그 줄부터 끝까지를 상한 안에서 그대로 올린다.
 */
export function failureBlock(stderr: string, maxLines: number = BLOCK_LIMIT): string {
  const lines = stderr
    .replace(ANSI_SGR, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes("startup failed:")) {
      start = i;
      break;
    }
  }
  if (start < 0) return lastMeaningfulLine(stderr);
  return lines.slice(start, start + maxLines).join("\n");
}
