import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

/** Avatar — ported from Timbre `core/Avatar`. Pass `speaker` (1–8) to tint. */
const avatarVariants = cva(
  "box-border inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold leading-none",
  {
    variants: {
      size: {
        xs: "size-[18px] text-[8px]",
        sm: "size-[22px] text-[9.5px]",
        md: "size-7 text-[11px]",
        lg: "size-9 text-[14px]",
        xl: "size-12 text-[18px]",
      },
    },
    defaultVariants: { size: "md" },
  },
);

function speakerVars(speaker?: number): React.CSSProperties {
  if (speaker == null) return {};
  const k = ((Number(speaker) - 1) % 8) + 1;
  return {
    "--_solid": `var(--spk-${k}-solid)`,
    "--_bg": `var(--spk-${k}-bg)`,
    "--_text": `var(--spk-${k}-text)`,
  } as React.CSSProperties;
}

function initials(name = ""): string {
  const t = name.trim();
  if (!t) return "?";
  // Korean names: take up to the last two syllables; latin: word initials.
  if (/^[ㄱ-힝]+/.test(t)) return t.slice(-2);
  const parts = t.split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

type AvatarProps = Omit<React.ComponentProps<"span">, "children"> &
  VariantProps<typeof avatarVariants> & {
    name?: string;
    speaker?: number;
    src?: string;
    unconfirmed?: boolean;
  };

function Avatar({
  className,
  size,
  name,
  speaker,
  src,
  unconfirmed = false,
  style,
  ...props
}: AvatarProps) {
  const tone = unconfirmed
    ? "border-[1.5px] border-dashed border-[color:var(--_solid,var(--gray-6))] bg-[var(--_bg,var(--gray-2))] text-[color:var(--_text,var(--text-secondary))]"
    : "bg-[var(--_solid,var(--gray-7))] text-white";

  return (
    <span
      data-slot="avatar"
      role="img"
      aria-label={name || undefined}
      title={name}
      className={cn(avatarVariants({ size }), tone, className)}
      style={{ ...speakerVars(speaker), ...style }}
      {...props}
    >
      {src ? (
        <img src={src} alt="" className="block size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

export { Avatar };
