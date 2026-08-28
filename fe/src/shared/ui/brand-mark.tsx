/**
 * BrandMark — the Damwha app icon (rounded square + speech bubble).
 * Same geometry as `public/favicon.svg`; keep the two in sync.
 *
 * Brand-fixed colors, not design tokens: the mark must read identically
 * wherever it is placed, so it does not follow surface/text semantics.
 * The hues are the Mintlify-tone family (deep forest -> mint), but they are
 * written out here on purpose — a token change must not silently repaint
 * the app icon.
 */
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
      <defs>
        <linearGradient id="brand-mark-bg" x1="0" y1="0" x2="0.294" y2="1.176">
          <stop offset="0" stopColor="#052620" />
          <stop offset="1" stopColor="#0A6E56" />
        </linearGradient>
        <linearGradient
          id="brand-mark-bar"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="27"
          x2="0"
          y2="89"
        >
          <stop offset="0" stopColor="#064A3A" />
          <stop offset="1" stopColor="#0A6E56" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="28" fill="url(#brand-mark-bg)" />
      <g fill="#7CEBCB">
        <rect x="52" y="46" width="43" height="44" rx="12" />
        <path d="M95 73v30L52 90z" />
      </g>
      <g fill="#fff">
        <rect x="23" y="27" width="64" height="62" rx="14" />
        <path d="M23 72v30l23-13z" />
      </g>
      <g fill="url(#brand-mark-bar)">
        <rect x="36" y="40.5" width="36" height="7" rx="3.5" />
        <rect x="36" y="54.5" width="36" height="7" rx="3.5" />
        <rect x="36" y="68.5" width="22" height="7" rx="3.5" />
      </g>
    </svg>
  );
}
