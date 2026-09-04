import { Card } from "@/shared/ui/card";
import { useCapabilities } from "@/features/settings/api/settings";
import { PRESET_META } from "@/features/settings/lib/presets";
import { ProcessingSettingsForm } from "@/features/settings/ui/processing-settings-form";

/** /settings — 처리 설정. 감지 스펙 카드 + 전역 처리 설정 폼. */
export function SettingsPage() {
  const { data: caps } = useCapabilities();

  return (
    <main
      data-tour="settings-page"
      className="col-start-2 h-full overflow-y-auto bg-background text-foreground"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-display font-bold">처리 설정</h1>
          <p className="text-base text-[color:var(--text-muted)]">
            이 머신 성능에 맞춰 회의 처리 방식(모델·GPU)을 고를 수 있어요.
          </p>
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
                  ? ` · 추천 프리셋: ${PRESET_META[caps.recommended_preset].label}`
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
