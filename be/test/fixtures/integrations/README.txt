Real `mcp get damwha` output captured 2026-10-20 on macOS in isolated dirs
(HOME=<tmp>, CODEX_HOME=<tmp>); never against the user's real config.
claude 2.1.304, codex 0.163.0. Home path rewritten to /Users/test.

state "none": exit code 1, stdout empty, message on stderr (*-none.stderr.txt) — both CLIs.
state "ours"/"other": exit code 0, stdout in *-ours.txt / *-other.txt.
Note claude's "Issue:" line and trailing "claude mcp remove" hint repeat the path / "mcp",
so a bare substring match on the whole output misjudges; parse the Command/Args lines.
