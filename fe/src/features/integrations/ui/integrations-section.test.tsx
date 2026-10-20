import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, apiClient } from "@/shared/api/client";
import { toast } from "@/shared/ui/use-toast";
import { ko } from "@/shared/i18n/locales/ko";
import { en } from "@/shared/i18n/locales/en";
import type { IntegrationsView } from "../api/integrations";
import { IntegrationsSection } from "./integrations-section";

vi.mock("@/shared/ui/use-toast", () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(toast).mockClear();
});

const view = (over: Partial<IntegrationsView> = {}): IntegrationsView => ({
  cli: { link: { kind: "absent" }, link_path: "/Users/me/.local/bin/damwha", on_path: true },
  clients: {
    "claude-code": { installed: true, registration: "none" },
    codex: { installed: true, registration: "none" },
  },
  manual: {
    link: "ln -s /A/damwha ~/.local/bin/damwha",
    claudeCode: "claude mcp add damwha -- /A/damwha mcp",
    codex: "codex mcp add damwha -- /A/damwha mcp",
    genericJson: '{"command":"/A/damwha"}',
  },
  ...over,
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <IntegrationsSection />
    </QueryClientProvider>,
  );

const mockGet = (v: IntegrationsView) => vi.spyOn(apiClient, "get").mockResolvedValue({ data: v } as never);

test("hidden when 404", async () => {
  const get = vi.spyOn(apiClient, "get").mockRejectedValue(new ApiError(404, "nf"));
  const { container } = renderIt();
  await waitFor(() => expect(get).toHaveBeenCalledWith("/integrations"));
  expect(container).toBeEmptyDOMElement();
});

test("shows other_damwha hint", async () => {
  mockGet(view({ cli: { link: { kind: "other_damwha", target: "/Old/Damwha.app/damwha" }, link_path: "/l", on_path: true } }));
  renderIt();
  expect(await screen.findByText(/다른 담화 앱/)).toHaveTextContent("/Old/Damwha.app/damwha");
});

test("replace asks confirmation before calling install with replace true", async () => {
  mockGet(view({ clients: { "claude-code": { installed: true, registration: { other: "node /x/server.js" } }, codex: { installed: true, registration: "ours" } } }));
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { installed: true, registration: "ours" } } as never);
  renderIt();
  const row = (await screen.findByText("Claude Code")).closest("li")!;
  expect(within(row).getByText(/node \/x\/server\.js/)).toBeInTheDocument();
  fireEvent.click(within(row).getByRole("button", { name: "바꾸기" }));
  expect(post).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "바꾸기" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/integrations/claude-code/install", { replace: true }));
});

test("install disabled when client not installed", async () => {
  mockGet(view({ clients: { "claude-code": { installed: false }, codex: { installed: true, registration: "none" } } }));
  renderIt();
  const row = (await screen.findByText("Claude Code")).closest("li")!;
  expect(within(row).getByRole("button", { name: "연결" })).toBeDisabled();
  expect(within(row).getByText(/설치돼 있지 않아요/)).toBeInTheDocument();
});

test("client install posts without replace and registration error keeps other rows usable", async () => {
  mockGet(view({ clients: { "claude-code": { installed: true, registration: { error: "boom" } }, codex: { installed: true, registration: "none" } } }));
  const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: { installed: true, registration: "ours" } } as never);
  renderIt();
  expect(await screen.findByText(/boom/)).toBeInTheDocument();
  const row = screen.getByText("Codex").closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "연결" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/integrations/codex/install", {}));
});

test("PATH hint only when on_path false", async () => {
  mockGet(view());
  const first = renderIt();
  await screen.findByText("Codex");
  expect(screen.queryByText('export PATH="$HOME/.local/bin:$PATH"')).toBeNull();
  first.unmount();
  mockGet(view({ cli: { link: { kind: "current" }, link_path: "/l", on_path: false } }));
  renderIt();
  expect(await screen.findByText('export PATH="$HOME/.local/bin:$PATH"')).toBeInTheDocument();
});

test("cli install and remove", async () => {
  mockGet(view({ cli: { link: { kind: "current" }, link_path: "/l", on_path: true } }));
  const del = vi.spyOn(apiClient, "delete").mockResolvedValue({ status: 204 } as never);
  renderIt();
  fireEvent.click(await screen.findByRole("button", { name: "명령 제거" }));
  await waitFor(() => expect(del).toHaveBeenCalledWith("/integrations/cli"));
});

test("manual commands copy", async () => {
  mockGet(view());
  const write = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: write } });
  renderIt();
  await screen.findByText("Codex");
  fireEvent.click(screen.getByText("수동으로 설치"));
  fireEvent.click(screen.getByRole("button", { name: "Codex 명령 복사" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("codex mcp add damwha -- /A/damwha mcp"));
});

test("409 conflict toast shows the target path", async () => {
  mockGet(view());
  vi.spyOn(apiClient, "post").mockRejectedValue(new ApiError(409, "occupied", "INTEGRATION_CONFLICT", { target: "/bin/damwha" }));
  renderIt();
  fireEvent.click(await screen.findByRole("button", { name: "명령 설치" }));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "error", description: expect.stringContaining("/bin/damwha") })),
  );
});

test("failed replace shows the previous registration", async () => {
  mockGet(view({ clients: { "claude-code": { installed: true, registration: { other: "old cmd" } }, codex: { installed: true, registration: "none" } } }));
  vi.spyOn(apiClient, "post").mockRejectedValue(new ApiError(500, "claude failed", "INTEGRATION_FAILED", { previous: "old cmd --flag" }));
  renderIt();
  const row = (await screen.findByText("Claude Code")).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "바꾸기" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "바꾸기" }));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("old cmd --flag") })),
  );
});

test("ko and en keys match", () => {
  const keys = (o: unknown, p = ""): string[] =>
    typeof o === "string" ? [p] : Object.entries(o as object).flatMap(([k, v]) => keys(v, p ? `${p}.${k}` : k));
  expect(keys(en.integrations).sort()).toEqual(keys(ko.integrations).sort());
});
