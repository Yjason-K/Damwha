import * as React from "react";

export function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-2.5 pt-4 pb-1.5 text-2xs font-semibold tracking-[var(--tracking-wide)] text-[color:var(--text-faint)] uppercase">
      <span>{children}</span>
      {action}
    </div>
  );
}
