import * as React from "react";
import { useTranslation } from "react-i18next";
import { env } from "@/shared/config/env";
import { useUiLanguage } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Icon } from "@/features/meeting/ui/icons";
import type { Meeting } from "@/features/meeting/model/types";
import { useMeetingShare } from "../api/share";
import { formatShareDate } from "../lib/dates";
import { ShareDialog } from "./share-dialog";

/**
 * 회의 헤더의 공유 진입점. 데모 빌드·공유가 꺼진 실행(404)·처리가 안 끝난 회의에서는 그리지 않는다.
 * 공유 중이면 "공유 중 · 날짜까지", 철회 대기면 "중지 대기 중"이 버튼 자체다 — 지금 공유 중인지가 바로 보인다.
 */
export function ShareButton({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const [open, setOpen] = React.useState(false);
  const enabled = !env.demoMode && meeting.status === "done";
  const q = useMeetingShare(enabled ? meeting.id : undefined);
  if (!enabled || q.data === undefined || q.data === "disabled") return null;
  const current = q.data;

  return (
    <>
      {current?.status === "active" && current.expires_at ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t("status.active", {
            date: formatShareDate(current.expires_at, lang),
          })}
        </Button>
      ) : current?.status === "revoke_pending" ? (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          {t("status.pending")}
        </Button>
      ) : (
        <IconButton label={t("button")} size="sm" onClick={() => setOpen(true)}>
          <Icon name="link" size={16} />
        </IconButton>
      )}
      <ShareDialog
        meeting={meeting}
        current={current}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
