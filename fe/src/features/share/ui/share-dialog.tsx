import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_SHARE_DURATION_DAYS,
  SHARE_DURATION_DAYS,
  type ShareDurationDays,
} from "@damwha/contracts";
import { ShareDocument } from "@damwha/share-view";
import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { useUiLanguage } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { SegmentedControl } from "@/shared/ui/segmented-control";
import { Switch } from "@/shared/ui/switch";
import { toast } from "@/shared/ui/use-toast";
import type { Meeting } from "@/features/meeting/model/types";
import {
  shareErrorKey,
  useCreateShare,
  useSharePreview,
  useStopShare,
  type ShareScope,
  type ShareView,
} from "../api/share";
import { daysLeft, formatShareDate } from "../lib/dates";

type Props = {
  meeting: Meeting;
  current: ShareView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const CONTENT_KEYS = ["summary", "lenses", "transcript", "note"] as const;

/**
 * 공유 다이얼로그 (spec §2.6). 범위 → 미리보기 → 고지·확인이 한 화면이다. 미리보기는 be가 실제로 암호화할
 * 페이로드를 공유 뷰어와 같은 렌더러(share-view)로 그린다 — 근사치가 아니다.
 * 공유 중이면 관리 화면(복사·중지·새 링크)으로 열린다.
 */
export function ShareDialog({ meeting, current, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        {/* 닫히면 DialogContent가 내려가므로 본문의 상태는 열 때마다 current에서 새로 시작한다. */}
        <DialogBody
          meeting={meeting}
          current={current}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({
  meeting,
  current,
  onClose,
}: {
  meeting: Meeting;
  current: ShareView | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("share");
  const [view, setView] = React.useState<"manage" | "create">(
    current ? "manage" : "create",
  );
  const [shown, setShown] = React.useState<ShareView | null>(current);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {view === "manage"
            ? t("dialog.manageTitle")
            : t("dialog.createTitle")}
        </DialogTitle>
        <DialogDescription>{meeting.title}</DialogDescription>
      </DialogHeader>
      {view === "manage" && shown ? (
        <ManageView
          meetingId={meeting.id}
          share={shown}
          onShareChange={setShown}
          onNewLink={() => setView("create")}
        />
      ) : (
        <CreateView
          meeting={meeting}
          replacing={current?.status === "active" ? current : null}
          onCancel={onClose}
          onCreated={(s) => {
            setShown(s);
            setView("manage");
          }}
        />
      )}
    </>
  );
}

function CreateView({
  meeting,
  replacing,
  onCancel,
  onCreated,
}: {
  meeting: Meeting;
  replacing: ShareView | null;
  onCancel: () => void;
  onCreated: (s: ShareView) => void;
}) {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const summaryReady = meeting.summaryStatus === "done";
  const [scope, setScope] = React.useState<ShareScope>({
    summary: summaryReady,
    lenses: true,
    transcript: false,
    note: false,
    anonymize: false,
  });
  const [days, setDays] = React.useState<ShareDurationDays>(
    DEFAULT_SHARE_DURATION_DAYS,
  );
  const [consent, setConsent] = React.useState(false);
  const [ack, setAck] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const hasContent = CONTENT_KEYS.some((k) => scope[k]);
  const preview = useSharePreview(meeting.id, scope, lang, days, hasContent);
  const create = useCreateShare();
  // 쿼리 키에 범위·언어·기간이 들어 있어 값을 바꾸면 새 키가 pending이 된다 — 그동안 버튼은 꺼진다(spec selfhost-v2 §2.6).
  const previewReady = preview.isSuccess && !preview.isFetching;
  // 미리보기가 오기 전의 고지 날짜 — 렌더마다 시계를 읽지 않게 연 시각에 고정한다.
  const [openedAt] = React.useState(() => Date.now());
  const expiresEstimate =
    preview.data?.expiresAtEstimate ??
    new Date(openedAt + days * 86_400_000).toISOString();
  const canSubmit =
    hasContent &&
    consent &&
    (!scope.transcript || ack) &&
    previewReady &&
    !create.isPending;

  const toggle =
    (k: keyof ShareScope) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setScope((s) => ({ ...s, [k]: e.target.checked }));
      if (k === "transcript" && !e.target.checked) setAck(false);
    };

  const submit = () => {
    setError(null);
    create.mutate(
      {
        meetingId: meeting.id,
        scope,
        durationDays: days,
        transcriptAck: scope.transcript && ack,
        uiLanguage: lang,
      },
      {
        onSuccess: (s) => {
          toast({ variant: "success", title: t("dialog.created") });
          onCreated(s);
        },
        onError: (e) => {
          if (isDemoBlocked(e)) return;
          setError(t(shareErrorKey(e)));
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-[color:var(--text-secondary)]">
          {t("dialog.scopeLabel")}
        </legend>
        <Checkbox
          label={t("dialog.scope.summary")}
          checked={scope.summary}
          disabled={!summaryReady}
          onChange={toggle("summary")}
        />
        {!summaryReady && (
          <p className="pl-6 text-xs text-[color:var(--text-muted)]">
            {t("dialog.summaryUnavailable")}
          </p>
        )}
        <Checkbox
          label={t("dialog.scope.lenses")}
          checked={scope.lenses}
          onChange={toggle("lenses")}
        />
        <Checkbox
          label={t("dialog.scope.transcript")}
          checked={scope.transcript}
          onChange={toggle("transcript")}
        />
        <Checkbox
          label={t("dialog.scope.note")}
          checked={scope.note}
          onChange={toggle("note")}
        />
      </fieldset>

      <div className="flex flex-col gap-1">
        <Switch
          label={t("dialog.anonymize")}
          checked={scope.anonymize}
          onChange={toggle("anonymize")}
        />
        <p className="text-xs text-[color:var(--text-muted)]">
          {t("dialog.anonymizeHint")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-[color:var(--text-secondary)]">
          {t("dialog.durationLabel")}
        </span>
        <SegmentedControl
          options={SHARE_DURATION_DAYS.map((d) => ({
            value: String(d),
            label: t("dialog.days", { count: d }),
          }))}
          value={String(days)}
          onChange={(v) => setDays(Number(v) as ShareDurationDays)}
        />
      </div>

      <section
        aria-labelledby="share-preview-title"
        className="rounded-md border border-[color:var(--border-subtle)]"
      >
        <h3
          id="share-preview-title"
          className="px-4 pt-3 text-sm font-medium text-[color:var(--text-secondary)]"
        >
          {t("dialog.previewTitle")}
        </h3>
        <div className="max-h-[320px] overflow-y-auto">
          {!hasContent ? null : preview.isPending ? (
            <p
              role="status"
              className="p-4 text-sm text-[color:var(--text-muted)]"
            >
              {t("dialog.previewLoading")}
            </p>
          ) : preview.isError ? (
            <p className="p-4 text-sm text-[color:var(--text-muted)]">
              {t("dialog.previewFailed")}
            </p>
          ) : (
            <ShareDocument
              payload={preview.data.payload}
              lang={lang}
              expiresAt={preview.data.expiresAtEstimate}
            />
          )}
        </div>
      </section>

      <div className="flex flex-col gap-3 rounded-md bg-[var(--surface-sunken)] p-4 text-sm">
        <p>
          {t("dialog.notice", { date: formatShareDate(expiresEstimate, lang) })}
        </p>
        <Checkbox
          label={t("dialog.consent")}
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        {scope.transcript && (
          <>
            <p className="font-medium">{t("dialog.transcriptWarning")}</p>
            <Checkbox
              label={t("dialog.transcriptAck")}
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
          </>
        )}
        {replacing?.expires_at && (
          <p>
            {t("dialog.replaceWarning", {
              count: daysLeft(replacing.expires_at),
            })}
          </p>
        )}
      </div>

      {error && (
        <p
          role="alert"
          className="text-sm text-[color:var(--color-danger-text)]"
        >
          {error}
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t("dialog.cancel")}
        </Button>
        <Button
          onClick={submit}
          disabled={!canSubmit}
          loading={create.isPending}
        >
          {t("dialog.submit")}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ManageView({
  meetingId,
  share,
  onShareChange,
  onNewLink,
}: {
  meetingId: string;
  share: ShareView;
  onShareChange: (s: ShareView) => void;
  onNewLink: () => void;
}) {
  const { t } = useTranslation("share");
  const lang = useUiLanguage();
  const stop = useStopShare();
  const copy = async () => {
    if (!share.url) return;
    await navigator.clipboard.writeText(share.url);
    toast({ variant: "success", title: t("dialog.copied") });
  };
  const doStop = () =>
    stop.mutate(
      { meetingId },
      {
        onSuccess: (r) => {
          onShareChange(r.share);
          if (!r.pending)
            toast({ variant: "success", title: t("dialog.stopped") });
        },
        onError: (e) => {
          if (!isDemoBlocked(e))
            toast({ variant: "error", title: t("errors.generic") });
        },
      },
    );

  if (share.status === "revoke_pending") {
    // 대기 중인 링크는 이미 막혀 있다(키를 지웠다). 서버가 계속 안 닿아도 공유가 잠기지 않게 새 링크는 열어 둔다.
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">{t("dialog.pendingNotice")}</p>
        <DialogFooter>
          <Button onClick={onNewLink}>{t("dialog.newLink")}</Button>
        </DialogFooter>
      </div>
    );
  }
  if (share.status !== "active") {
    return (
      <DialogFooter>
        <Button onClick={onNewLink}>{t("dialog.newLink")}</Button>
      </DialogFooter>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Input
          readOnly
          aria-label={t("dialog.linkLabel")}
          value={share.url ?? ""}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          variant="secondary"
          onClick={() => void copy()}
          disabled={!share.url}
        >
          {t("dialog.copy")}
        </Button>
      </div>
      {share.expires_at && (
        <p className="text-sm text-[color:var(--text-muted)]">
          {t("dialog.expiresOn", {
            date: formatShareDate(share.expires_at, lang),
          })}
        </p>
      )}
      <DialogFooter>
        <Button variant="danger" onClick={doStop} loading={stop.isPending}>
          {t("dialog.stop")}
        </Button>
        <Button variant="secondary" onClick={onNewLink}>
          {t("dialog.newLink")}
        </Button>
      </DialogFooter>
    </div>
  );
}
