import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "@/shared/api/client";
import { isDemoBlocked } from "@/shared/api/demo-read-only";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { toast } from "@/shared/ui/use-toast";
import {
  CLIENT_IDS,
  useInstallClient,
  useInstallCli,
  useIntegrations,
  useRemoveCli,
  useRemoveClient,
  type ClientId,
  type ClientState,
  type IntegrationsView,
} from "../api/integrations";

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
const CLIENT_NAMES: Record<ClientId, string> = { "claude-code": "Claude Code", codex: "Codex" };

function useCopy() {
  const { t } = useTranslation("integrations");
  return async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast({ variant: "error", title: t("toast.copyFailed") });
      return;
    }
    toast({ variant: "success", title: t("toast.copied") });
  };
}

/** 실패 토스트 — 409는 막은 경로를, 교체 중 실패한 500은 지워진 이전 등록을 보여 사용자가 되돌릴 수 있게 한다. */
function useReportError() {
  const { t } = useTranslation("integrations");
  return (e: unknown) => {
    if (isDemoBlocked(e)) return;
    const str = (k: string) => (isApiError(e) && typeof e.details?.[k] === "string" ? (e.details[k] as string) : undefined);
    if (isApiError(e) && e.code === "INTEGRATION_CONFLICT") {
      toast({
        variant: "error",
        title: t("toast.failed"),
        description: t("toast.conflict", { target: str("target") ?? e.message }),
      });
      return;
    }
    const previous = str("previous");
    const message = isApiError(e) ? e.message : t("toast.failed");
    toast({
      variant: "error",
      title: t("toast.failed"),
      description: previous ? t("toast.previous", { message, previous }) : message,
    });
  };
}

/** 설정 › CLI · MCP (spec §2.7). 연동 API가 꺼진 실행(Docker·데모·브라우저 개발)에서는 섹션이 없다. */
export function IntegrationsSection() {
  const { t } = useTranslation("integrations");
  const q = useIntegrations();
  const copy = useCopy();
  if (q.data === undefined || q.data === "disabled") return null;
  const view = q.data;

  return (
    <section aria-labelledby="settings-integrations">
      <Card className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h2 id="settings-integrations" className="text-h2 font-semibold text-foreground">
            {t("title")}
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">{t("description")}</p>
        </header>
        <ul className="flex flex-col divide-y divide-[color:var(--border-subtle)]">
          <CliRow view={view} />
          {CLIENT_IDS.map((id) => (
            <ClientRow key={id} id={id} state={view.clients[id]} />
          ))}
        </ul>
        {!view.cli.on_path && (
          <div className="flex flex-col gap-2 rounded-md bg-[var(--gray-2)] p-3">
            <p className="text-sm text-[color:var(--text-secondary)]">{t("cli.pathHint", { dir: "~/.local/bin" })}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
                {PATH_LINE}
              </code>
              <Button size="sm" variant="secondary" onClick={() => void copy(PATH_LINE)}>
                {t("copyPath")}
              </Button>
            </div>
          </div>
        )}
        <ManualInstall manual={view.manual} />
      </Card>
    </section>
  );
}

function Row({ name, status, children }: { name: string; status: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{name}</span>
        <span className="break-words text-xs text-[color:var(--text-muted)]">{status}</span>
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </li>
  );
}

function CliRow({ view }: { view: IntegrationsView }) {
  const { t } = useTranslation("integrations");
  const install = useInstallCli();
  const remove = useRemoveCli();
  const report = useReportError();
  const { link, link_path: path } = view.cli;
  const busy = install.isPending || remove.isPending;
  const status =
    link.kind === "absent" || link.kind === "current"
      ? t(`cli.state.${link.kind}`, { path })
      : t(`cli.state.${link.kind}`, { target: link.target });
  const run = (m: typeof install | typeof remove, doneKey: "toast.done" | "toast.removed") =>
    m.mutate(undefined, { onSuccess: () => toast({ variant: "success", title: t(doneKey) }), onError: report });

  return (
    <Row name={t("cli.title")} status={status}>
      {(link.kind === "absent" || link.kind === "other_damwha" || link.kind === "foreign") && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || link.kind === "foreign"}
          loading={install.isPending}
          onClick={() => run(install, "toast.done")}
        >
          {link.kind === "other_damwha" ? t("cli.replace") : t("cli.install")}
        </Button>
      )}
      {(link.kind === "current" || link.kind === "other_damwha") && (
        <Button size="sm" variant="ghost" disabled={busy} loading={remove.isPending} onClick={() => run(remove, "toast.removed")}>
          {t("cli.remove")}
        </Button>
      )}
    </Row>
  );
}

function ClientRow({ id, state }: { id: ClientId; state: ClientState }) {
  const { t } = useTranslation("integrations");
  const install = useInstallClient(id);
  const remove = useRemoveClient(id);
  const report = useReportError();
  const [confirming, setConfirming] = useState(false);
  const name = CLIENT_NAMES[id];
  const busy = install.isPending || remove.isPending;

  const connect = (replace: boolean) =>
    install.mutate(
      { replace },
      {
        onSuccess: () => toast({ variant: "success", title: t("toast.done") }),
        onError: report,
        onSettled: () => setConfirming(false),
      },
    );

  if (!state.installed) {
    return (
      <Row name={name} status={t("client.notInstalled", { name })}>
        <Button size="sm" variant="secondary" disabled>
          {t("client.connect")}
        </Button>
      </Row>
    );
  }
  const reg = state.registration;
  const other = typeof reg === "object" && "other" in reg ? reg.other : undefined;
  const error = typeof reg === "object" && "error" in reg ? reg.error : undefined;
  const status =
    other !== undefined
      ? t("client.other", { command: other })
      : error !== undefined
        ? t("client.error", { message: error })
        : t(reg === "ours" ? "client.ours" : "client.none");

  return (
    <Row name={name} status={status}>
      {reg === "ours" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () => toast({ variant: "success", title: t("toast.removed") }),
              onError: report,
            })
          }
        >
          {t("client.disconnect")}
        </Button>
      ) : other !== undefined ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
          {t("client.replace")}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" disabled={busy} loading={install.isPending} onClick={() => connect(false)}>
          {t("client.connect")}
        </Button>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("replaceDialog.title", { name })}</DialogTitle>
            <DialogDescription className="break-words">
              {t("replaceDialog.description", { command: other ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t("replaceDialog.cancel")}
            </Button>
            <Button loading={install.isPending} onClick={() => connect(true)}>
              {t("replaceDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Row>
  );
}

const MANUAL_KEYS = ["link", "claudeCode", "codex", "genericJson"] as const;

function ManualInstall({ manual }: { manual: IntegrationsView["manual"] }) {
  const { t } = useTranslation("integrations");
  const copy = useCopy();
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium text-[color:var(--text-secondary)] outline-none focus-visible:[box-shadow:var(--focus-ring)]">
        {t("manual.summary")}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className="text-xs text-[color:var(--text-muted)]">{t("manual.hint")}</p>
        {MANUAL_KEYS.map((key) => {
          const label = t(`manual.${key}`);
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[color:var(--text-secondary)]">{label}</span>
                <Button size="sm" variant="secondary" onClick={() => void copy(manual[key])}>
                  {t("manual.copy", { label })}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-[var(--gray-2)] p-2.5 font-mono text-xs text-foreground">
                {manual[key]}
              </pre>
            </div>
          );
        })}
      </div>
    </details>
  );
}
