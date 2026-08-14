# ponytail — Go port

A dependency-free Go port of ponytail's Node runtime. One binary replaces
`hooks/*.js`, `hooks/ponytail-statusline.{sh,ps1}`, `scripts/uninstall.js` and
`ponytail-mcp/`.

The skills and rule files (`skills/`, `AGENTS.md`, the per-host rule copies) are
markdown and are not ported — the Go binary reads the same `skills/ponytail/SKILL.md`
at runtime that the Node hooks do.

## Build

```sh
cd go && go build -o bin/ponytail ./cmd/ponytail
```

Go 1.24, standard library only.

## Commands

| Command | Replaces |
|---|---|
| `ponytail activate` | `hooks/ponytail-activate.js` (SessionStart) |
| `ponytail prompt` | `hooks/ponytail-mode-tracker.js` (UserPromptSubmit, reads stdin) |
| `ponytail subagent` | `hooks/ponytail-subagent.js` (SubagentStart) |
| `ponytail statusline` | `hooks/ponytail-statusline.sh` / `.ps1` |
| `ponytail uninstall` | `scripts/uninstall.js` |
| `ponytail mcp` | `ponytail-mcp/` (stdio MCP server) |
| `ponytail version` | reads `package.json` |

## Wiring it up

Claude Code / Codex hooks — same shape as `hooks/claude-codex-hooks.json`, with
the `node -e …` commands replaced:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact",
      "hooks": [{ "type": "command", "command": "/path/to/ponytail activate", "timeout": 5 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "/path/to/ponytail subagent", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/ponytail prompt", "timeout": 5 }] }]
  }
}
```

Statusline, in `~/.claude/settings.json` (`ponytail activate` offers to set this
up for you on first run):

```json
{ "statusLine": { "type": "command", "command": "\"/path/to/ponytail\" statusline" } }
```

MCP server, in your host's MCP config:

```json
{ "mcpServers": { "ponytail": { "command": "/path/to/ponytail", "args": ["mcp"] } } }
```

## Locating the ruleset

A compiled binary has no `__dirname`, so the checkout is resolved at runtime, in
order: `PONYTAIL_SKILL_PATH` (points straight at `SKILL.md`), `PONYTAIL_ROOT`,
`CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT` (only when `skills/ponytail/SKILL.md` is
actually there), then a walk up from the executable and from the working
directory. If nothing is found the binary serves the condensed ruleset, exactly
as the Node hooks do when the read throws — ponytail still works, it just loses
the intensity table and worked examples.

## Environment

Identical to the Node implementation: `PONYTAIL_DEFAULT_MODE`,
`PONYTAIL_HIDE_STATUS`, `PONYTAIL_QUIET_STARTUP`, `PONYTAIL_SUBAGENT_MATCHER`,
`CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `APPDATA`, plus the host markers
`COPILOT_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `QODER_SESSION_ID`.

## Tests

```sh
cd go && go test ./...
```

Alongside the unit tests, `cmd/ponytail/parity_test.go` and
`mcp_parity_test.go` are **differential** tests: they run the original Node
implementation and this port on the same inputs and require byte-identical
stdout and identical on-disk state, across every mode, every host (Claude,
Codex, Copilot, Qoder) and the malformed-input cases. They skip themselves if
`node` isn't installed.

One deliberate difference is excluded from the comparison: the statusline setup
nudge names `ponytail statusline` where Node named a shell script.

`internal/instructions/fallback_gen.go` is generated from
`hooks/ponytail-instructions.js` by `scripts/gen-go-fallback.js` (`go generate
./internal/instructions`), so the condensed ruleset cannot drift from the Node
source of truth. The generated file is committed; building needs no Node.
