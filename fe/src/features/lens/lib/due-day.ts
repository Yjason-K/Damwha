export type DueDay = { label: string; urgent: boolean };

/**
 * `YYYY-MM-DD` 기한 → `D-2 (4월 2일)` / `D-Day` / `D+3 (3월 28일)`. 날짜만 비교하도록
 * 로컬 자정끼리 뺀다(시간대를 타지 않게 문자열을 직접 쪼갠다). 오늘이거나 지났으면 급하다.
 */
export function dueDay(ymd: string, now: Date = new Date()): DueDay | null {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return null;
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return { label: "D-Day", urgent: true };
  const date = `${m}월 ${d}일`;
  return days > 0
    ? { label: `D-${days} (${date})`, urgent: false }
    : { label: `D+${-days} (${date})`, urgent: true };
}
