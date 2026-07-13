import { Link } from "react-router";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { useCapabilities } from "@/features/settings/api/settings";
import { ProcessingSettingsForm } from "@/features/settings/ui/processing-settings-form";

function BackIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 3.5L5 8l4.5 4.5" />
    </svg>
  );
}

/** /settings — 처리 설정. 감지 스펙 카드 + 전역 처리 설정 폼. */
export function SettingsPage() {
  const { data: caps } = useCapabilities();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-4">
          <Button asChild variant="ghost" size="sm" className="self-start">
            <Link to="/app">
              <BackIcon />
              <span>회의로 돌아가기</span>
            </Link>
          </Button>
          <div className="flex flex-col gap-1">
            <h1 className="text-display font-bold">처리 설정</h1>
            <p className="text-base text-[color:var(--text-muted)]">
              이 머신 성능에 맞춰 회의 처리 방식(모델·GPU)을 고를 수 있어요.
            </p>
          </div>
        </header>

        <Card className="flex flex-col gap-1">
          <span className="text-sm font-medium text-[color:var(--text-secondary)]">
            내 머신
          </span>
          {caps ? (
            <>
              <span className="text-base text-foreground">
                {caps.chip ?? `${caps.platform} / ${caps.arch}`}
              </span>
              <span className="text-sm text-[color:var(--text-muted)]">
                메모리 {caps.memory_gb} GB
                {caps.recommended_preset
                  ? ` · 추천 프리셋: ${caps.recommended_preset}`
                  : ""}
              </span>
            </>
          ) : (
            <span
              role="status"
              className="text-sm text-[color:var(--text-muted)]"
            >
              스펙을 확인하는 중…
            </span>
          )}
        </Card>

        <ProcessingSettingsForm />
      </div>
    </main>
  );
}
