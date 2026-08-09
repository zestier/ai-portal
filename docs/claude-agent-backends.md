# Claude Agent SDK backends

The `claude-agent` provider runs the Claude Agent SDK coding runtime while
keeping the portal's existing provider contract. It is intended as a practical
non-Copilot runtime for Anthropic and Anthropic-compatible APIs, including
DeepSeek's Anthropic endpoint.

## Configure Anthropic

Set the credential, choose the provider and model, then restart the portal:

```bash
DEFAULT_BACKEND_PROVIDER=claude-agent
DEFAULT_MODEL=claude-sonnet-4-6
CLAUDE_AGENT_API_KEY=<anthropic-api-key>
CLAUDE_AGENT_MAX_TURNS=50
```

Leave `CLAUDE_AGENT_BASE_URL` unset to use the Agent SDK's Anthropic default.

## Configure DeepSeek

DeepSeek exposes an Anthropic-compatible endpoint specifically for Claude Code
and the Agent SDK:

```bash
DEFAULT_BACKEND_PROVIDER=claude-agent
DEFAULT_MODEL=deepseek-chat
CLAUDE_AGENT_BASE_URL=https://api.deepseek.com/anthropic
CLAUDE_AGENT_API_KEY=<deepseek-api-key>
CLAUDE_AGENT_MAX_TURNS=50
```

The portal passes these values to each Agent SDK subprocess as
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; it does not mutate the portal
process environment. Model availability and model identifiers are controlled by
the configured endpoint.

Existing conversations retain their selected provider. Set the default before
creating a conversation, or select **Claude Agent SDK** and enter the model id
in the conversation settings.

## Runtime ownership

The Agent SDK owns the model loop, context compaction, built-in coding tools,
session resume, and subagent execution. The portal remains authoritative for
conversation persistence, permission policy and audit, tickets, durable memory,
worktrees, and UI event rendering.

Portal tools are exposed to the runtime through an in-process MCP server. Tool
groups disabled on a conversation are omitted from that server.

Every tool call — SDK built-ins (`Bash`, `Read`, `Edit`, ...), portal MCP
tools, and subagent inner tool calls — is gated by a single `PreToolUse` hook
that routes through the same portal permission gateway as other providers
(grants, policy, approval mode, audit). The hook's allow/deny is terminal, so
the portal stays authoritative even for read-only tools and allowlisted shell
commands that the SDK would otherwise auto-approve. `canUseTool` is not used.
Built-in requests carry the CLI tool name (`Bash`, `Read`) while saved grants
are keyed by the canonical permission vocabulary (`shell`, `read`, `write`,
`edit`, `url`); the gateway matches either form, so seed and settings-form
grants apply to SDK built-in calls.

Portal tools that duplicate an Agent SDK built-in coding tool (`read_file`,
`list_files`, `replace_lines`, `replace_text`) are omitted so the model sees
one tool per job. `read`, `grep`, `glob`, `write`, `edit`, and `shell_exec` are
the exceptions: their SDK counterparts (`Read`, `Grep`, `Glob`, `Write`, `Edit`,
`Bash`) are rerouted to the portal implementations via `toolAliases`, so the
portal tools are exposed rather than omitted. The rerouted `Bash` spills
oversized output to `.zap/scratch/tool_results/` and returns the persisted path
so the model can read the full output, instead of killing the command.
Agent SDK session ids are persisted separately from portal conversation ids so
sessions can resume after a process restart.

## Current differences

The provider streams text and reasoning, normalizes tool calls and results,
reports compaction boundaries and tool progress, and attributes forwarded
subagent output to its parent call. Interactive Agent SDK elicitation and plan
exit callbacks, context-window usage in the header, and binary MCP tool results
are not yet mapped to portal-specific UI events.

For endpoints that only implement OpenAI chat completions, use the
`openai-compatible` provider described in
[openai-compatible-backends.md](openai-compatible-backends.md). That provider
uses the portal's own bounded tool loop rather than the Agent SDK runtime.