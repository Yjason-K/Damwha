const pad2 = (n: number) => String(n).padStart(2, "0");

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/**
 * 회의 카드 메타 줄의 날짜 라벨(로컬 시각 기준). 오늘·어제는 시각까지, 그 밖은
 * 날짜만, 해가 다르면 연도를 붙인다(스펙 §2.7).
 */
export function meetingWhenLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay(d, now)) return `오늘 ${time}`;
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  );
  if (sameDay(d, yesterday)) return `어제 ${time}`;
  const md = `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return d.getFullYear() === now.getFullYear()
    ? md
    : `${d.getFullYear()}년 ${md}`;
}

/** `YYYY-MM-DD` 기한 → `M월 D일`. 시간대를 타지 않도록 Date로 파싱하지 않는다. */
export function dueDateLabel(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  if (!m || !d) return ymd;
  return `${m}월 ${d}일`;
}
