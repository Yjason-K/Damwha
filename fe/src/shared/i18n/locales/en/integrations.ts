import type { LocaleShape } from "../../locale-shape";
import type { integrations as ko } from "../ko/integrations";

export const integrations = {
  title: "CLI · MCP",
  description: "Use the damwha command in your terminal and let Claude Code and Codex call Damwha as a tool.",
  cli: {
    title: "damwha command",
    state: {
      absent: "Not installed · {{path}}",
      current: "Installed · {{path}}",
      other_damwha: "Points to a different Damwha app · {{target}}",
      foreign: "Something else is using this path · {{target}}",
    },
    install: "Install command",
    replace: "Point to this app",
    remove: "Remove command",
    pathHint: "{{dir}} is not on your PATH. Add the line below to your shell profile to use it from any terminal.",
  },
  client: {
    notInstalled: "{{name}} is not installed on this Mac.",
    none: "Not connected",
    ours: "Connected",
    other: "A different damwha registration exists · {{command}}",
    error: "Could not check the status · {{message}}",
    connect: "Connect",
    replace: "Replace",
    disconnect: "Disconnect",
  },
  replaceDialog: {
    title: "Replace the damwha registration in {{name}}?",
    description: "The registered command will be replaced by this app's MCP server. Current registration: {{command}}",
    cancel: "Cancel",
    confirm: "Replace",
  },
  manual: {
    summary: "Install manually",
    hint: "To run it yourself, copy a command below and paste it into your terminal.",
    link: "damwha command link",
    claudeCode: "Claude Code command",
    codex: "Codex command",
    genericJson: "Other MCP clients (JSON)",
    copy: "Copy {{label}}",
  },
  copyPath: "Copy PATH line",
  toast: {
    copied: "Copied.",
    copyFailed: "Could not copy.",
    done: "Done.",
    removed: "Removed.",
    failed: "Could not finish the action.",
    conflict: "{{target}} is used by something else, so it was left untouched.",
    previous: "{{message}} Previous registration: {{previous}}",
  },
  retry: "Retry",
  loadFailed: "Could not load the integration status.",
} satisfies LocaleShape<typeof ko>;
