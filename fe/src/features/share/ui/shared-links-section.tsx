import { useTranslation } from "react-i18next";
import { useUiLanguage } from "@/shared/i18n";
import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { toast } from "@/shared/ui/use-toast";
import { useShares, useStopShare } from "../api/share";
import { formatShareDate } from "../lib/dates";

/** 설정 › 공유한 링크 (spec §2.9). 공유가 꺼진 실행·데모에서는 섹션이 없다. */
export function SharedLinksSection() {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const q = useShares();
  const stop = useStopShare();
  if (q.data === undefined || q.data === "disabled") return null;

  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    toast({ variant: "success", title: t("dialog.copied") });
  };

  return (
    <section aria-labelledby="settings-shares">
      <Card className="flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 id="settings-shares" className="text-h2 font-semibold text-foreground">
            {t("settings.title")}
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">{t("settings.description")}</p>
        </header>
        {q.data.length === 0 ? (
          <p className="text-sm text-[color:var(--text-muted)]">{t("settings.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[color:var(--border-subtle)]">
            {q.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {s.meeting_title ?? t("settings.deletedMeeting")}
                </span>
                <span className="text-xs text-[color:var(--text-muted)]">
                  {s.status === "revoke_pending"
                    ? t("settings.pending")
                    : s.expires_at && t("settings.until", { date: formatShareDate(s.expires_at, lang) })}
                </span>
                {s.status === "active" && s.url && (
                  <Button size="sm" variant="secondary" onClick={() => void copy(s.url!)}>
                    {t("dialog.copy")}
                  </Button>
                )}
                {s.status === "active" && s.meeting_id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      stop.mutate(
                        { meetingId: s.meeting_id! },
                        {
                          onError: (e) => {
                            if (!isDemoBlocked(e)) toast({ variant: "error", title: t("errors.generic") });
                          },
                        },
                      )
                    }
                  >
                    {t("dialog.stop")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
