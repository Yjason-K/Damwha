import { Card } from "@/shared/ui/card";
import { useCapabilities } from "@/features/settings/api/settings";
import { ProcessingSettingsForm } from "@/features/settings/ui/processing-settings-form";
import { HfTokenSettingsSection } from "@/features/hf-token/ui/hf-token-settings-section";
import { ModelsCard } from "@/features/models/ui/models-card";

/**
 * /settings — 처리 설정. 섹션 셋(처리 방식 · 모델 · 허깅페이스 토큰)은 같은 틀을 쓴다: 카드 한 장,
 * `h2` 제목(`text-h2`), 한 줄 설명. 내 머신은 프리셋을 고르는 근거라 처리 방식 섹션 안의 한 줄이다.
 */
export function SettingsPage() {
  return (
    <main
      data-tour="settings-page"
      className="col-start-2 h-full overflow-y-auto bg-background text-foreground"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-h1 font-semibold text-foreground">처리 설정</h1>
          <p className="text-base text-[color:var(--text-muted)]">
            회의를 처리하는 방식과 거기에 쓰는 모델을 관리해요.
          </p>
        </header>

        <section aria-labelledby="settings-processing">
          <Card className="flex flex-col gap-5">
            <header className="flex flex-col gap-1">
              <h2
                id="settings-processing"
                className="text-h2 font-semibold text-foreground"
              >
                처리 방식
              </h2>
              <p className="text-sm text-[color:var(--text-muted)]">
                이 Mac 성능에 맞춰 전사·요약 모델과 GPU 사용을 골라요.
              </p>
            </header>
            <MachineLine />
            <ProcessingSettingsForm />
          </Card>
        </section>
        <ModelsCard />
        <HfTokenSettingsSection />
      </div>
    </main>
  );
}

/** 처리 방식 섹션의 "내 머신" 한 줄. 추천 프리셋은 카드의 "권장" 배지가 말하므로 여기서 되풀이하지 않는다. */
function MachineLine() {
  const { data: caps } = useCapabilities();
  if (!caps) {
    return (
      <p role="status" className="text-sm text-[color:var(--text-muted)]">
        이 Mac의 사양을 확인하는 중…
      </p>
    );
  }
  return (
    <p className="text-sm text-[color:var(--text-secondary)]">
      내 머신{" "}
      <span className="text-foreground">
        {caps.chip ?? `${caps.platform} / ${caps.arch}`} · 메모리{" "}
        {caps.memory_gb} GB
      </span>
    </p>
  );
}
