/**
 * CLI는 앱 번들 안에 실려 앱과 같이 배포되므로 앱(desktop/package.json)의 버전을 쓴다. cli/package.json의 version은
 * 웹 배포 계열 번호라 사용자가 보는 앱 버전과 다르다. build.mjs와 vitest.config.ts가 빌드 시점에 값을 넣는다.
 */
declare const __DAMWHA_VERSION__: string;

export const VERSION: string = __DAMWHA_VERSION__;
