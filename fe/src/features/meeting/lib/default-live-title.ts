const pad2 = (n: number) => String(n).padStart(2, "0");

/** "녹음 YYYY-MM-DD HH:mm" — 로컬 시각. */
export function defaultLiveTitle(now: Date = new Date()): string {
  return `녹음 ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}
