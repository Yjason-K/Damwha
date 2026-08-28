/**
 * BrandMark — the Damwha app icon (rounded square + speech bubble).
 * Same geometry as `public/favicon.svg`; keep the two in sync.
 *
 * Brand-fixed colors, not design tokens: the mark must read identically
 * wherever it is placed, so it does not follow surface/text semantics —
 * a token change must not silently repaint the app icon. Flat fills, no
 * gradients: the mark has to survive being drawn at 16px.
 */
const INK = "#0F161E";
const MINT = "#1DDCA5";

export function BrandMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      aria-hidden="true"
      className={className}
    >
      <rect width="128" height="128" rx="30" fill={INK} />
      <g fill={MINT}>
        <rect x="52" y="46" width="51" height="48" rx="12" />
        <path d="M103 75v33L58 94z" />
      </g>
      <g fill="#fff">
        <rect x="27" y="26" width="65" height="68" rx="14" />
        <path d="M27 80v30L52 95z" />
      </g>
      <g fill={INK}>
        <rect x="40" y="43" width="37" height="6.5" rx="3.25" />
        <rect x="40" y="56.5" width="37" height="6.5" rx="3.25" />
        <rect x="40" y="70" width="23" height="6.5" rx="3.25" />
      </g>
    </svg>
  );
}
