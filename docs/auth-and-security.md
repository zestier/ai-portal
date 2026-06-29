# 05 — Auth and security

This portal grants its users the ability to run arbitrary code on the host
(the Copilot agent can edit files and execute shell commands). Treat it
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
5. The GitHub access token is stored encrypted in SQLite (AES-256-GCM with
   `ENCRYPTION_KEY`) and is **separate** from the Copilot subscription
   token — see below.

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

## Copilot token handling

The Copilot subscription auth used by the SDK is distinct from the portal's
login token.

Two strategies, configurable per user:

1. **Pre-run `copilot auth login`** on the host — the SDK picks up the
   stored CLI credentials. Recommended for single-user home installs and
   the path that works out of the box.
2. **BYOK** — user pastes an OpenAI/Anthropic key in `/settings`; stored
   encrypted; forwarded as the appropriate env var. Limits model selection
   accordingly.

The portal stores **no** GitHub OAuth access token by default. With
`scope=read:user` (set in `src/lib/server/auth/github.ts`) the token has
no Copilot entitlement, so persisting it would just keep an
encrypted-but-useless credential at rest. The SDK falls back to whatever
the host's `copilot auth login` produced. If you've widened the OAuth
scope and want the OAuth token forwarded to the SDK, re-add a
`setGithubToken(user.id, token)` call in `src/routes/auth/callback/+server.ts`
— the read paths in the bridge plumbing still consume it. The
`getGithubToken`/`setGithubToken` helpers in `src/lib/server/db/repos/tokens.ts`
remain available for that, and for BYOK key storage which uses the same
table.

The fallback chain the SDK sees, in order, is:
`tokens.getGithubToken(userId)` → `COPILOT_GITHUB_TOKEN` env → undefined
(host CLI creds via `useLoggedInUser`).

Whatever token the SDK ends up using is never logged and never echoed
back to the client.

The portal keeps one Copilot SDK subprocess per portal user (see
`src/lib/server/copilot/copilot-provider.ts`). When `ALLOWED_GITHUB_LOGINS` lists
multiple users, each gets their own client so Copilot API calls are
attributed to the right GitHub identity instead of whoever logged in
first after process boot.

## Working-directory containment

- The authoritative workdir is the persisted `conversations.workdir`
  row. New conversations default to `PROJECT_ROOT` (env, defaulting to
  the server process's cwd), but can override it; the Copilot SDK and
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
- The Copilot CLI itself does additional containment within that
  directory; we don't try to second-guess it.

## Tool permissions

- Default policy: **prompt** for every tool call that mutates state or runs
  a shell command. Read-only tools (file reads, web fetches) can be set to
  auto-allow.
- "Allow always" decisions are scoped to a single conversation by default;
  promoting to "global allow" requires confirmation in settings.
- The full permission decision log is persisted (see
  [persistence.md](persistence.md)) and viewable in the conversation
  detail page.

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
