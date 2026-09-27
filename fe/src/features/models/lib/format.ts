const UNITS = ["KB", "MB", "GB", "TB"];

/**
 * 사람이 읽는 크기. **1000 기준**이다 — worker `disk.py`의 `format_bytes`와 같은
 * 규칙이고, Finder가 그렇게 보이므로 화면과 어긋나지 않는다.
 */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  let size = n;
  for (const unit of UNITS) {
    size /= 1000;
    if (size < 1000) return `${size.toFixed(1)} ${unit}`;
  }
  return `${size.toFixed(1)} TB`;
}
