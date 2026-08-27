import * as React from "react";

import { cn } from "@/shared/lib/utils";

/**
 * Meeting-shell icon set — ported from the Damwha Design System UI kit
 * (Lucide-style line glyphs: 24 viewBox, 1.75 stroke, round caps). The
 * geometry matches `lucide-react`; swap for the real package if it lands
 * as a dependency.
 */
const PATHS = {
  search: "M11 11a5 5 0 1 0-7.07-7.07A5 5 0 0 0 11 11zM20 20l-4.5-4.5",
  command:
    "M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v3m0 6v3a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3v-3m0-6h6v6H9z",
  folder:
    "M4 5a2 2 0 0 1 2-2h3.5l2 2.5H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  file: "M14 3v4a1 1 0 0 0 1 1h4M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z",
  mic: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  play: "M6 4.5v15l13-7.5z",
  pause: "M9 4.5v15M15 4.5v15",
  chevDown: "M6 9l6 6 6-6",
  chevsUpDown: "M8 9l4-4 4 4M8 15l4 4 4-4",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l5 5 9-10",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2",
  users:
    "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15 4.2a3.5 3.5 0 0 1 0 6.6",
  listChecks:
    "M11 6h9M11 12h9M11 18h9M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17",
  hash: "M4 9h16M4 15h16M10 4L8 20M16 4l-2 16",
  scale:
    "M12 4v16M7 20h10M5 8l-2.5 6a3 3 0 0 0 5 0L5 8zm0 0l7-1.5M19 8l-2.5 6a3 3 0 0 0 5 0L19 8zm0 0l-7 1.5",
  handshake:
    "M8 13l2.5 2.5a1.5 1.5 0 0 0 2.1 0l.4-.4 2 2 2-2-5-5-2 1.5a2 2 0 0 1-2.4-.1L9 7M3 12l3 3M21 12l-3 3M6 9l3-3 3 1",
  sparkles:
    "M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6zM18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  jump: "M8 6h10v10M18 6L7 17",
  settings:
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.2 6.3l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  star: "M12 4l2.3 5.2 5.7.5-4.3 3.8 1.3 5.5L12 16.6 7 19.5l1.3-5.5L4 10.2l5.7-.5z",
  calendar:
    "M7 3v3M17 3v3M4 8h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  waveform: "M4 12h2M9 6v12M14 3v18M19 9v6M22 12h-1",
  inbox:
    "M4 13h4l1.5 2.5h5L16 13h4M4 13l2.5-7h11L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  bookmark: "M6 4h12v16l-6-4-6 4z",
  quote:
    "M7 7H5a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V6.5C8 5 6.8 4 5.5 4M17 7h-2a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V6.5C18 5 16.8 4 15.5 4",
  pencil: "M14 5l5 5M4 20l1-4L16 5l3 3L8 19z",
  expand:
    "M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3M16 20h3a1 1 0 0 0 1-1v-3",
  rotateCcw: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5",
  rotateCw: "M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5",
  chevUp: "M6 15l6-6 6 6",
  skipBack: "M19 5v14L9 12zM5 5v14",
  skipForward: "M5 5v14l10-7zM19 5v14",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  x: "M6 6l12 12M18 6L6 18",
} as const;

export type IconName = keyof typeof PATHS;

type IconProps = Omit<React.ComponentProps<"svg">, "children"> & {
  name: IconName;
  size?: number;
  strokeWidth?: number;
};

function Icon({
  name,
  size = 18,
  strokeWidth = 1.75,
  className,
  ...rest
}: IconProps) {
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("block shrink-0", className)}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export { Icon };
