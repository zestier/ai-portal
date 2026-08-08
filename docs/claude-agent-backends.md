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
groups disabled on a conversation are omitted from that server, and built-in
coding tools pass through the same portal permission gateway as other providers.
Portal tools that duplicate an Agent SDK built-in coding tool (`shell_exec`,
`read_file`, `list_files`, `grep`, `create_file`, `replace_lines`,
`replace_text`) are omitted so the model sees one tool per job.
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