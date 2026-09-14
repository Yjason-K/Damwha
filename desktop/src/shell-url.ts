import { pathToFileURL } from "url";

/**
 * 지금 창이 보여주는 file:// URL이 다음에 그리려는 셸 페이지(file, query)와 같은가.
 *
 * showStatus는 loadFile이라 부를 때마다 페이지가 통째로 다시 로드된다. 값이 하나도 안 바뀌었는데
 * 불러도 화면은 깜빡인다 — pg-service.ts의 건강 검사(PG_HEALTH_INTERVAL_MS = 10초)가 상태가
 * 그대로여도 매번 emit하고, supervisor.ts의 set()은 그 emit을 그대로 흘린다. 이 판정이 "같은
 * 페이지"라고 답하면 showStatus는 loadFile을 건너뛰어 깜빡임을 없앤다.
 *
 * 의심스러우면 항상 false(=다시 그린다)다 — 창/webContents가 파괴됐거나 getURL()이 실패하는
 * 경우는 호출자(shell-window.ts의 showStatus)가 이 함수를 부르기 전에 걸러 loadFile로 곧장
 * 간다. 여기서는 URL 두 개를 비교할 뿐, 의심스럽다고 "같다"고 답해서는 안 된다.
 */
export function isSameShellPage(currentUrl: string, file: string, query: Record<string, string>): boolean {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentUrl);
    target = pathToFileURL(file);
  } catch {
    return false;
  }
  if (current.protocol !== "file:") return false;
  if (current.pathname !== target.pathname) return false;

  const wantedKeys = Object.keys(query);
  // 개수가 같고 원하는 키가 전부 정확한 값으로 있으면 나머지도(집합 크기가 같으므로) 정확히
  // 같은 키 집합이다 — 그래서 "extra key"도, retryInSeconds 같은 값 하나가 바뀐 경우도 이
  // 두 조건만으로 걸러진다 (카운트다운이 바뀌어도 반드시 다시 그려야 한다).
  if (new Set(current.searchParams.keys()).size !== wantedKeys.length) return false;
  return wantedKeys.every((key) => current.searchParams.get(key) === query[key]);
}
