# 05 — Auth and security

This portal grants its users the ability to run arbitrary code on the host
(the agent can edit files and execute shell commands). Treat it
accordingly: it is **never** safe to expose unauthenticated.

## Threat model

| Actor                     | Capability we must prevent                                      |
| ------------------------- | ---------------------------------------------------------------- |
| Random internet stranger  | Any access (no anonymous reads, no chat).                       |
| Someone with the URL      | Same — URL knowledge is not auth.                               |
| Logged-in user (you)      | Accidental action; not host compromise by an already-trusted user. |
| Malicious tool output     | Cannot inject HTML/script into the chat UI (sanitize all assistant markdown). |
| XSS on `vscode.dev`-style | Mitigated by strict CSP and no inline scripts in dev/prod.      |

## Trust model

Zestier's AI Portal (ZAP) is a self-hosted control surface for a trusted operator, not a
multi-tenant sandbox. Anyone who can use a conversation can ask an agent to read
and edit the configured workdir, request shell commands, mutate git state, start
long-running processes, and trigger whatever external side effects the host
allows. Permission prompts are an operator-confirmation UX and audit trail; they
are not a security boundary between mutually distrusting portal users.

The intended boundary is therefore **outside the portal**:

- Bind locally, or put the app behind an authenticating proxy/tunnel such as
  Cloudflare Access.
- Only allow identities that you would also trust with a terminal on the host
  and the selected `PROJECT_ROOT`.
- Treat features such as redeploy, global permission grants, and same-workdir
   concurrent conversations as capabilities of that trusted operator model, not
   as isolation guarantees. Workdir selection is allowlisted (see
   "Working-directory containment"): it defaults to `PROJECT_ROOT`, and in
   multi-user GitHub mode it is clamped to `PROJECT_ROOT` so it can't be used to
   reach another operator's files.
- When `ENABLE_REDEPLOY=1` with GitHub auth, use
  `REDEPLOY_ADMIN_GITHUB_LOGINS` to restrict the update/restart endpoint to a
  subset of allowed operators. Single-user GitHub installs default that one
  login to redeploy admin; shared-secret and local modes have no per-user
  identity to split.
- If you need isolation between users, repositories, or experiments, run
  separate portal instances with separate `DATA_DIR`s and `PROJECT_ROOT`s (or
  use OS/container isolation outside the app).

Security work inside the portal focuses on preventing unauthenticated access,
cross-user credential attribution mistakes, path traversal in read-only browser
routes, XSS, CSRF, and accidental permission broadening. It does **not** try to
defend the host from a logged-in trusted user.

## Auth modes

Selected via `AUTH_MODE` env var.

### `github` (default; recommended)

Standard GitHub OAuth App, web flow.

1. User hits any page → `hooks.server.ts` sees no session cookie →
   redirects to `/login`.
2. `/login` redirects to `https://github.com/login/oauth/authorize?...`
   with `state=<csrf>` and `scope=read:user`.
3. `/auth/callback` exchanges code → access token → fetches `/user`.
4. If `login` is in `ALLOWED_GITHUB_LOGINS`, mint a signed session cookie
   (JWT, 30-day expiry, `HttpOnly; Secure; SameSite=Lax`); else 403.
5. The GitHub access token is used only to fetch `/user` and is **not**
   persisted — see [Model credentials](#model-credentials) below.

### `shared-secret`

Single password (the `SHARED_SECRET`) entered on `/login`. Useful for
tunneling demos where you don't want to set up an OAuth app. Still issues
a session cookie. Put nginx, Cloudflare Access, or another edge control in
front if you need rate limiting.

### `none`

Disables auth. Refuses to start unless the bind address carries its
matching acknowledgement:

- `HOST=127.0.0.1` (loopback, the safe default) requires `I_KNOW_THIS_IS_LOCAL=1`.
- `HOST=0.0.0.0` (every interface) requires `I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1`.
  This is the stronger acknowledgement and stands on its own — you do **not**
  also set `I_KNOW_THIS_IS_LOCAL`.

Any other `HOST` is rejected. Use `0.0.0.0` only when reachability is fenced
off some other way — e.g. a container with no published port, a private
network, or an authenticating reverse proxy / tunnel (Cloudflare Access) in
front.

## Session cookies

- HMAC-SHA256-signed compact payload: `base64url(JSON({sub, iat, exp})).base64url(sig)`.
  Resembles a JWT but is not one (no header, no algorithm negotiation —
  see `src/lib/server/auth/session.ts`). The signing key is `SESSION_SECRET`.
- Stored as `__Host-portal_session` (forces `Secure`, `Path=/`, no
  `Domain=`).
- Rotated on each successful auth.

## CSRF

- The OAuth `state` cookie is `__Host-oauth_state` (dev: `oauth_state` over
  http), so a sibling subdomain cannot inject `Domain=.example.com` state and
  force a known value (login CSRF / state fixation).

- By default, mutating endpoints require a same-origin `Origin`/`Referer`
  header (SvelteKit's built-in check + an explicit check for the JSON API).
- The session cookie is `SameSite=Lax`, which blocks cross-site `POST` from
  classic forms and cross-site credentialed `fetch`.

## Model credentials

The portal stores **no** model credential. The pi SDK resolves its
own auth when a session opens — env-provided keys for the configured
`PI_MODEL`'s provider, or whatever credential the SDK reads from the host.
The GitHub OAuth access token is not persisted: with `scope=read:user` (set
in `src/lib/server/auth/github.ts`) it grants no model access, and it is
discarded after login.

The `tokens` table (`getGithubToken`/`setGithubToken` in
`src/lib/server/db/repos/tokens.ts`) remains as a generic encrypted key
store, but nothing writes to it in the current code.

Whatever credential the SDK ends up using is never logged and never echoed
back to the client.

## Working-directory containment

- The authoritative workdir is the persisted `conversations.workdir`
  row. New conversations default to `PROJECT_ROOT` (env, defaulting to
  the server process's cwd), but can override it; the pi agent and
  the conversation-scoped file/git routes both resolve from that same
  row. Legacy stored paths under `DATA_DIR/workspaces/<id>/` still fold
  back to `PROJECT_ROOT` via `src/lib/server/workdir.ts`.
- The workdir is not a per-conversation sandbox. Any conversations that point
  at the same path share the same files, git state, running services, caches,
  and external side effects; permission prompts and snapshots do not make that
  state transactional.
- No allowlist is enforced by default beyond `PROJECT_ROOT`. A user-supplied
  workdir (at conversation create or via the per-user default in settings)
  must resolve, after symlinks, inside one of the configured allowed roots —
  by default just `PROJECT_ROOT`. A single trusted operator who wants to point
  conversations at several project trees widens this with `ALLOWED_WORKDIRS`
  (comma-separated absolute paths). This is what stops an authenticated user
  from setting `workdir` to `/` and then reading arbitrary host files (e.g.
  `/etc/passwd`, `/proc/self/environ`) through the conversation-scoped
  file-browser / git endpoints.
- **Multi-user GitHub mode is hardened further.** When `AUTH_MODE=github` and
  more than one login is in `ALLOWED_GITHUB_LOGINS`, the effective allowed
  roots are *clamped* to `PROJECT_ROOT`: any `ALLOWED_WORKDIRS` entry outside
  it is dropped. So no matter how the allowlist is configured, one operator can
  never select a workdir outside `PROJECT_ROOT` and read another operator's
  data — or the server's own secrets — through the file/git endpoints. Single
  trusted-operator installs (local mode, shared-secret, or a one-login GitHub
  install) retain the original "any allowlisted directory" flexibility.
- The read-only file browser and git endpoints (`/api/conversations/[id]/fs/*`,
  `/api/conversations/[id]/git/*`) constrain paths to the workspace
  root's realpath; symlinks that resolve outside it are rejected, and
  `git` is spawned with `shell: false`, hard timeouts, and output
  size caps.
- The agent session itself does additional containment within that
  directory; we don't try to second-guess it.

## Tool permissions

- Default policy: **prompt** for every tool call that mutates state or runs
  a shell command. Read-only tools (file reads, web fetches) can be set to
  auto-allow.
- "Allow always" decisions are scoped to a single conversation by default;
  promoting to "global allow" requires confirmation in settings.
- Grants can also be authored directly in **Settings → Permissions**. The
  "Tool" selector offers the five scoped permission kinds (`shell`, `read`,
  `write`, `edit`, `url`), each with a structured scope editor, plus
  **custom-tool**: a grant naming a portal tool (`worktree_create`,
  `git_status`, an MCP tool, …). A portal tool has no finer scope than itself,
  so a custom-tool grant is stored as `tool = <the tool name>`,
  `permission_kind = 'custom-tool'`, `scope = {kind:'any'}` — the same shape
  `defaultSeedGrants()` writes. This is what lets a user opt into a tool the
  default seed set deliberately withholds (the mutating worktree tools), rather
  than only being able to reach it through a live "Allow always" prompt.
- A grant cannot defeat a tool that declares
  `permissionBehavior: 'always-prompt'` (`git_commit`, `worktree_merge`,
  `worktree_remove`, …): the always-prompt branch is evaluated *before* grant
  matching. The form warns when the named tool is in that category, or is
  already never-prompt, or is permission-checked as a filesystem write instead
  — cases where the saved row would never fire.
- The full permission decision log is persisted (see
  [persistence.md](persistence.md)) and viewable in the conversation
  detail page.

### Adversary shadow mode (experimental, off by default)

An exploration of whether a second LLM could review permission requests instead
of the human. **Phase 0 deliberately grants it no authority.**

Configure it like any other model-backed background feature: set an **Adversary
review model** in Settings (or `ADVERSARY_SHADOW_BACKEND` as the server default,
or per conversation). A configured model selection is what turns it on — there
is no separate switch, so nothing can disagree about whether it is running.
Unset everywhere, which is the default, means it never runs.

The reviewer runs on the pi provider named in the selection (`providerId/modelId`).
The provider-qualified selection string is the reviewer's only identity: the
same model served by two providers is two selections, and each is reviewed and
recorded independently. (An earlier design kept a separate
`ADVERSARY_SHADOW_MODEL` plus an independent backend axis, which let the model
and its serving endpoint disagree about what "the same reviewer" meant; folding
the backend into the model selection removed that ambiguity.)

Model precedence is conversation → server default (`ADVERSARY_SHADOW_BACKEND`),
matching the memory extractor. The user setting is **seed-only**: it is copied
onto each newly created conversation and never re-read, so changing it does not
retroactively alter existing conversations, and clearing a conversation's model
genuinely stops reviewing that conversation rather than silently re-inheriting
the default. That last property matters — the reviewer is sent tool arguments,
so opting one sensitive conversation out has to work even for a user who set a
default.

It is per-conversation rather than global because the reviewer is skipped when
it matches the conversation's own model selection (shared weights mean shared
blind spots) — with one global value that guard would silently disable the
shadow for anyone whose conversation happened to use the same model, with no way
to resolve it.

When it is on, each request that reaches a human dialog in an `ask`
conversation is also shown to the reviewer, whose verdict is recorded next to
the human's actual click. Requests that `auto-approve` waved through are
recorded too — they are the population a veto product would gate — but carry no
human label and are excluded from scoring. Nothing reads any of these rows
back; the call is fire-and-forget and the dialog never waits on it.

The reason for measuring before building: an LLM approving an LLM's dangerous
action gives the *feeling* of oversight with none of the accountability, and
prompt injection that fools the agent plausibly fools the reviewer too — it
reads the same attacker-influenced tool arguments. If the reviewer can't
reproduce the human's denials in shadow, the mode is theater.

Constraints that hold even in shadow:

- **Structured facts only.** The reviewer is given the tool, permission kind,
  scope key, parsed shell segments, commit target, workspace roots — never
  agent narration. `intention`, `toolDescription`, and the dialog's `summary`
  are excluded (the summary matters: it falls back to `toolDescription`).
  Every scalar is JSON-quoted, because `scopeKey` and friends are themselves
  model-controlled (`fullCommandText`, `path`) and a multi-line value would
  otherwise inject lines into the section labelled trustworthy. Agent-authored
  argument values go in an explicitly-labelled untrusted block whose delimiters
  are stripped from both blocks, so they cannot be forged from inside.
- **No tools for the reviewer**, or the permission problem recurses. The
  reviewer runs as a side completion with no portal tools, and its results are
  recorded for adjudication only — never surfaced to the agent.
- **A different model from the agent.** Shared weights mean shared blind spots;
  the shadow refuses to run when the reviewer is the same model on the same
  provider. The comparison is provider-qualified because a bare model id is only
  meaningful inside one provider's namespace.
- **Errors are errors.** Unparseable output is never coerced into a verdict.

Read the results with `pnpm run report:adversary-shadow`. Two limitations are
baked into what that report can tell you, and both are printed with it:

- **The human's click is a label, not ground truth.** The human defines the
  labels, so human recall is 1 by construction and this cannot show the reviewer
  "beating" a human — a low number is decisive against the mode, a high number
  is necessary but not sufficient for it. A rubber-stamped approval also turns a
  correct denial into a "false positive"; median human answer latency is
  reported as a weak proxy, and deciding who was right needs independent review
  of the disagreements (which `prompt_sent` preserves the evidence for).
- **The labelled and unlabelled populations are different.** Only `ask` requests
  carry a human label; the `auto-approve` rows that a veto product would gate
  carry none. Neither is a random sample of the other.

`pnpm run probe:adversary` runs a fixed set of hostile requests, several of
which argue for their own approval, against the configured reviewer;
`--dry-run` prints the prompts without calling anything.

Note that enabling this ships tool arguments — which can include file contents —
to whichever provider serves the reviewer, and stores the same (already-truncated)
prompt locally in `prompt_sent` for later adjudication, so the copy at rest is
never larger than what was sent. On the default (the conversation's own provider)
that is a party which already sees every tool call, so it adds no new
destination; routing the reviewer elsewhere does, which is the trade-off that
setting makes explicit. A user turning it on only exposes their own
conversations.

Cost is one provider roundtrip per shadowed request, deduplicated per identical
request and bounded by `ADVERSARY_SHADOW_MAX_IN_FLIGHT` (default 4). In `ask`
conversations that is roughly one call per permission dialog. In `auto-approve`
conversations there are no dialogs to pace it, so every request the approval
mode itself permitted is shadowed — a much higher rate, for rows that can never
be scored, only adjudicated later. Requests over the concurrency cap are
recorded as explicit skips rather than dropped, so the resulting gap in the
sample is visible in the readout instead of being mistaken for representative.

## Content sanitization

- All markdown from the assistant is rendered client-side with `marked` →
  `DOMPurify` (see `src/lib/client/markdown.ts`). Assistant content is
  never injected into SSR HTML; the chat transcript is hydrated and
  rendered in the browser, where DOMPurify uses the real DOM.
- SVG images are active content (script/handlers/external refs), so they
  are sanitized server-side with DOMPurify's SVG profile over a jsdom DOM
  (`src/lib/server/svg-sanitize.ts`) — ticket attachments at upload, file
  browser / view-tool SVGs on serve — and rendered only via `<img>` under
  `nosniff` + `default-src 'none'; sandbox`, so a directly-opened SVG is
  also inert.
- A strict default CSP is sent. Inline-script-emitting pages use
  SvelteKit's hash-mode CSP integration (`kit.csp.directives` in
  `svelte.config.js`) so we can omit `'unsafe-inline'` from `script-src`;
  a matching CSP for non-HTML responses (API JSON, SSE) is set in
  `src/hooks.server.ts`:
  - `default-src 'self'`
  - `script-src 'self'` (hashes for inline hydration scripts auto-injected
    by SvelteKit; the pre-hydrate bootstrap lives at `/prehydrate.js`)
  - `style-src 'self' 'unsafe-inline'` (Svelte component styles)
  - `connect-src 'self'`
  - `img-src 'self' data: https://avatars.githubusercontent.com`
  - `frame-ancestors 'none'`

## Rate limiting

In-process token bucket per IP for unauthenticated endpoints (`/login`,
OAuth callback) and per session for authenticated endpoints. Defaults:

- `/login` POST: 5 / 15 min.
- Authenticated message send: 60 / minute.

## Logging

- Structured JSON logs to stdout.
- Auth tokens and message bodies are **never** logged at default level.
  At `LOG_LEVEL=debug`, message bodies are logged with a `[REDACTED]`
  placeholder for anything that matches a token-shaped regex.

## Cloudflare Tunnel considerations

When fronting with `cloudflared`:

- Run with Cloudflare Access in front (Zero Trust → Application policy
  restricting to your Google/GitHub identity). The portal then sees CF
  identity headers and *can* trust them (`CF-Access-Authenticated-User-Email`)
  — but we still require the portal's own session for defense in depth.
- Bind the SvelteKit listener to `127.0.0.1` so it's only reachable via the
  tunnel sidecar.
