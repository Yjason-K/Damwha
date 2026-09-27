import { DropdownMenu } from "radix-ui";

import { Icon, type IconName } from "@/features/meeting/ui/icons";
import { parsePreference, type ThemePreference } from "@/shared/lib/theme";
import { useTheme } from "@/shared/lib/use-theme";
import { IconButton } from "@/shared/ui/icon-button";

/**
 * 좌측 사이드바 하단의 화면 테마 선택(스펙 2026-09-25 다크 테마 §5).
 * 팝오버에 role을 손으로 다는 대신 Radix DropdownMenu의 RadioGroup을 쓴다 — menuitemradio·
 * aria-checked·화살표 키 이동·Esc 닫기를 그대로 받는다.
 */
const OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  short: string;
  icon: IconName;
}> = [
  {
    value: "system",
    label: "시스템 설정 따르기",
    short: "시스템",
    icon: "monitor",
  },
  { value: "light", label: "라이트", short: "라이트", icon: "sun" },
  { value: "dark", label: "다크", short: "다크", icon: "moon" },
];

export function ThemeMenu() {
  const { preference, setPreference } = useTheme();
  const current = OPTIONS.find((o) => o.value === preference) ?? OPTIONS[0];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton size="sm" label={`화면 테마: ${current.short}`}>
          <Icon name={current.icon} size={15} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-[110] min-w-[176px] rounded-md border border-border bg-popover p-1 text-popover-foreground outline-none [box-shadow:var(--shadow-md)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DropdownMenu.Label className="px-2 pt-1 pb-1.5 text-2xs font-medium text-[color:var(--text-muted)]">
            화면 테마
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={preference}
            onValueChange={(v) => setPreference(parsePreference(v))}
          >
            {OPTIONS.map((o) => (
              <DropdownMenu.RadioItem
                key={o.value}
                value={o.value}
                className="flex cursor-pointer select-none items-center gap-2 rounded-xs px-2 py-1.5 text-sm text-foreground outline-none transition-colors duration-[80ms] data-[highlighted]:bg-accent"
              >
                <Icon
                  name={o.icon}
                  size={15}
                  className="text-[color:var(--text-secondary)]"
                />
                <span className="flex-1">{o.label}</span>
                <DropdownMenu.ItemIndicator>
                  <Icon
                    name="check"
                    size={14}
                    className="text-[color:var(--accent-text)]"
                  />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
