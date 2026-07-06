import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import { LENS_KINDS, LENS_META } from "../model/data";
import type { LensKind } from "../model/types";
import { Icon } from "./icons";

/**
 * LensView — 전역(모든 회의) 렌즈 뷰. 요약·액션아이템 같은 렌즈의 자동 추출은
 * 백엔드 다음 단계에서 제공되므로, 지금은 렌즈 탭 구조만 유지한 채 "준비 중"
 * 빈 상태를 보여준다. 목 코퍼스 집계는 실데이터와 혼재를 피하려 제거했다.
 */

type LensViewProps = {
  lens: LensKind;
  onLens: (lens: LensKind) => void;
  done: Record<string, boolean>;
  onToggle: (id: string) => void;
  onJump: (mid: string) => void;
};

export function LensView({ lens, onLens }: LensViewProps) {
  const meta = LENS_META[lens];

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-app)]">
      <div className="shrink-0 border-b border-[color:var(--border-subtle)] bg-[var(--surface-card)] px-7 pt-[18px] pb-3.5">
        <div className="flex items-center gap-[9px]">
          <span className="inline-flex text-[color:var(--text-secondary)]">
            <Icon name={meta.icon} size={19} />
          </span>
          <h1 className="text-h2 font-semibold tracking-[-0.01em] text-foreground">
            내 {meta.label}
          </h1>
        </div>
        <div className="mt-3">
          <Tabs
            value={lens}
            onValueChange={(v) => onLens(v as LensKind)}
            className="gap-0"
          >
            <TabsList>
              {LENS_KINDS.map((k) => (
                <TabsTrigger key={k} value={k}>
                  {LENS_META[k].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-7">
        <div className="mx-auto flex min-h-full max-w-[760px] flex-col items-center justify-center gap-3 text-center">
          <span className="mb-1 inline-flex text-[color:var(--text-faint)]">
            <Icon name="sparkles" size={40} strokeWidth={1.5} />
          </span>
          <p className="text-h3 font-semibold text-foreground">
            렌즈 추출은 준비 중입니다
          </p>
          <p className="max-w-[420px] text-sm leading-relaxed text-[color:var(--text-muted)]">
            요약·액션아이템 자동 추출은 다음 단계에서 제공될 예정이에요.
          </p>
        </div>
      </div>
    </main>
  );
}
