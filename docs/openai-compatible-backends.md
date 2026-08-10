# OpenAI-compatible backends

The portal can run new conversations against any backend that exposes an
OpenAI-compatible `/v1` API with streaming chat completions, tool calls, and a
`/models` endpoint. This is useful for local or self-hosted model servers while
keeping the same portal conversation, tool permission, and audit UI.

## Start a compatible backend

Start your model server outside the portal and enable its OpenAI-compatible API.
The portal expects:

1. A base URL ending in `/v1`, for example `http://127.0.0.1:1234/v1`.
2. `GET /v1/models` returning available model ids.
3. `POST /v1/chat/completions` accepting `stream: true`, `tools`, and
   `tool_choice: "auto"`.
4. Optional bearer-token auth via `Authorization: Bearer <token>`.

Keep the backend reachable from the portal process. For Docker deployments, use
a host or service name that is valid from inside the container rather than a
desktop-only loopback address.

## Trust model and production egress

`OPENAI_COMPATIBLE_BASE_URL` is trusted operator configuration loaded from the
portal environment. It is not accepted from chat messages, model output, or
untrusted browser input, so the portal intentionally allows both hosted HTTPS
endpoints and local/private HTTP endpoints such as `http://127.0.0.1:1234/v1`,
Docker service names, or internal model gateways.

The portal does not impose scheme restrictions or private-network deny rules on
this URL because those would block the local and self-hosted deployments this
provider is designed for. Production deployments that need stricter egress
policy should enforce it outside the portal, for example with container network
policy, firewall rules, proxy allowlists, or secret-management controls over the
environment. The portal does bound outbound provider requests: model-discovery
requests time out after 10 seconds, and chat-completion requests must return
response headers within 120 seconds. Once a streaming chat response starts, it
may continue until the turn finishes or the user/server aborts it.

## Configure the portal

Set these environment variables and restart the portal:

```bash
DEFAULT_BACKEND_PROVIDER=openai-compatible
DEFAULT_MODEL=<model-id>
OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:1234/v1
# Optional, only when your backend requires bearer auth:
OPENAI_COMPATIBLE_API_KEY=<token>
# Optional cap for multi-step tool loops:
OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS=8
# Optional cap for persisted messages replayed into a fresh provider session:
OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES=20
# Optional context-window size (tokens). When set, the portal requests streamed
# token usage and shows the header context meter; leave unset to disable it:
# OPENAI_COMPATIBLE_CONTEXT_TOKEN_LIMIT=32768
# Optional sampling controls shared by OpenAI-compatible and LM Studio sessions.
# Leave unset to let the backend/model defaults apply:
# OPENAI_COMPATIBLE_TEMPERATURE=0.8
# OPENAI_COMPATIBLE_TOP_P=0.95
# OPENAI_COMPATIBLE_PRESENCE_PENALTY=0.1
# OPENAI_COMPATIBLE_FREQUENCY_PENALTY=0.2
```

You can also leave `DEFAULT_BACKEND_PROVIDER=copilot` and select
**OpenAI compatible** from **Settings -> General -> Default provider**. The
settings page shows whether the backend is configured, whether bearer auth is in
use, and whether model discovery returned model ids. If discovery succeeds, pick
a model from the list; if discovery is unavailable or the model is not listed,
enter the exact model id manually.

Existing conversations keep the provider and model selected when they were
created. Change settings before starting a new conversation.

Sampling values are not sent by default, so LM Studio and other backends can
apply their own model-specific defaults. Set the `OPENAI_COMPATIBLE_*` sampling
variables only when you want the portal to override those defaults; the same
values are used by the dedicated LM Studio provider.

If you are using LM Studio 0.4.0 or newer, prefer the dedicated **LM Studio**
provider (`DEFAULT_BACKEND_PROVIDER=lm-studio`). It uses LM Studio's
OpenAI-compatible `/v1/chat/completions` endpoint for stateless chats, while
still reading native `/api/v1/models` metadata for context-window limits.

## Multiple instances

A single deployment can run several `openai-compatible` (or `lm-studio`)
backends at once via `ZAP_PROVIDERS_JSON`, each with its own endpoint, key, and
model list:

```bash
ZAP_PROVIDERS_JSON='[
  { "id": "lm-local", "type": "openai-compatible", "label": "Local",
    "baseUrl": "http://127.0.0.1:1234/v1", "models": ["local-model"] },
  { "id": "gateway", "type": "openai-compatible", "label": "Gateway",
    "baseUrl": "https://gw.example/v1", "apiKey": "<token>" }
]'
```

Each entry is an instance: a unique `id` (not a built-in provider id such as
`openai-compatible`), `type`, optional `label`, `baseUrl`, `apiKey`, and
`models`. Explicit `models` win; otherwise the instance discovers them via its
`/models` endpoint, falling back to manual entry. Duplicate types are fine;
duplicate or reserved ids are rejected at startup with the offending field
named. Conversations store the instance id, so each conversation pins one
instance and its endpoint. The env-fed instances (`OPENAI_COMPATIBLE_*`,
`LMSTUDIO_*`) always exist as ids `openai-compatible` and `lm-studio` and
remain the default when `ZAP_PROVIDERS_JSON` is unset. `claude-agent` instances
share this variable; see
[claude-agent-backends.md](claude-agent-backends.md).

When a live OpenAI-compatible provider session is unavailable, the portal
restores continuity by replaying a bounded suffix of persisted complete messages
before the new user turn. The replay is capped by
`OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES` so small local models are not sent
the entire conversation history blindly.

## Feature differences from Copilot

OpenAI-compatible sessions use the portal's provider boundary, not the Copilot
SDK runtime. Core chat, portal-hosted tools, permission prompts, persisted
messages, file diffs, and workspace tickets remain available when the model emits
compatible tool calls.

Expected differences:

| Area | OpenAI-compatible behavior |
| ---- | -------------------------- |
| Runtime modes | Saved for portal permission semantics, but not sent as Copilot runtime mode hints. |
| Approve all | Enforced by the portal for portal-hosted tools; no separate provider-side approval cache is reset. |
| Context meter | Shown when `OPENAI_COMPATIBLE_CONTEXT_TOKEN_LIMIT` is set and the backend streams token usage; no Copilot compaction events are emitted. |
| Reasoning | Captured from `reasoning_content`/`thinking` fields (DeepSeek-R1, Qwen3/QwQ, Claude-via-proxy) and shown as thinking; no Copilot reasoning summaries. |
| Subagents | Copilot subagent/task lifecycle events are unavailable. |
| MCP info events | Copilot SDK sampling, OAuth, and external-tool informational events are unavailable. |
| Plan exit and elicitation | Copilot callback dialogs for plan-exit and elicitation are unavailable. |

Model quality, context size, tool-calling reliability, and supported message
formats depend on the selected backend and model. If a turn fails before any
tokens stream, check the settings status card, the backend server logs, and that
`OPENAI_COMPATIBLE_BASE_URL` points to the `/v1` endpoint.
