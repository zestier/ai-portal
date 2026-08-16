# 05 — Auth and security

This portal grants its operator the ability to run arbitrary code on the host
(the agent can edit files and execute shell commands). Treat it accordingly:
**there is no security layer in the app itself**, and it must **not** be exposed
publicly as-is.

## Posture: no auth, by design

The portal has **no authentication**: no login, no sessions, no OAuth, no
per-user identities. There is exactly one shared local user, auto-created on
every request. This is a deliberate simplification for a self-hosted,
single-operator tool — the previous GitHub-OAuth / shared-secret / signed-cookie
machinery was more attack surface than it was worth for a one-user app, and it
created the false impression that "it has auth" meant "it is safe to expose on
the internet."

The real access control lives **outside the portal**:

- **Loops back (default).** Bind `HOST=127.0.0.1`; this is the safe default.
- **Remote access = put something better in front.** Install **Tailscale** on
  the host (or use any private VPN / authenticating reverse proxy), add the host
  to your tailnet, and reach the portal over the tailnet's private address. Only
  allow identities you would also trust with a terminal on the host and the
  selected `PROJECT_ROOT`.
- **Never bind `0.0.0.0` and publish to the public internet as-is.** Anyone with
  the port open can drive an agent that edits files and shells out on the host.
  There is no anonymous-read gating, no rate-limited login, no credential to
  steal — there is nothing preventing access at all.

The app still enforces an explicit acknowledgement before it will bind anything
other than loopback, so a mistaken `HOST=0.0.0.0` cannot silently expose it:

- `HOST=127.0.0.1` (loopback) requires `I_KNOW_THIS_IS_LOCAL=1`.
- `HOST=0.0.0.0` (every interface) requires `I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1`
  — the stronger assertion, standing on its own.

Any other `HOST` is rejected. Use `0.0.0.0` only when reachability is fenced
off some other way: a container with no published port, a private network, or
an authenticating proxy / Tailscale in front.

## Threat model

| Actor                     | Capability we must prevent                                              |
| ------------------------- | ---------------------------------------------------------------------- |
| Random internet stranger  | Any access — prevented by *not exposing the port publicly*.             |
| Someone on the same LAN   | Any access — keep it off hostile networks; use Tailscale if in doubt.   |
| Operator (you)            | Accidental action; not self-compromise by the trusted operator.         |
| Malicious tool output     | Cannot inject HTML/script into the chat UI (sanitize all assistant markdown). |
| XSS                       | Mitigated by strict CSP and no inline scripts in dev/prod.              |

## Trust model

ZAP is a self-hosted control surface for a trusted operator, not a
multi-tenant sandbox. Permission prompts are an operator-confirmation UX and
audit trail; they are **not** a security boundary between mutually distrusting
portal users. There is only one user, so there is no cross-user boundary at all.

Because there is no auth, the intended boundary is the network one above
(loopback / Tailscale). If you need isolation between repositories or
experiments, run separate portal instances with separate `DATA_DIR`s and
`PROJECT_ROOT`s (or use OS/container isolation outside the app).

What security work the portal *does* contain is request-hardening and safe
defaults that remain true without an auth layer — described below — not access
control.

## CSRF and origin checks (request hardening, not auth)

Mutating JSON API calls must be same-origin:

- A mutating `/api/*` request must carry an `Origin` (or `Referer`) matching
  the server's origin. SvelteKit's built-in check covers form actions; an
  explicit check in `src/hooks.server.ts` covers the JSON API.
- A **CSRF double-submit** token is pinned in a cookie and exposed to client JS
  only via the `<meta name="csrf-token">` tag; mutating requests must echo it
  in the `X-CSRF-Token` header. A cross-site attacker can neither read the
  token nor set a custom header on a forged request, so a match proves
  same-origin intent. This is defense-in-depth alongside the Origin check.

These stop a *cross-site* attacker from driving the API — they are not
authentication, and they do nothing against anyone who can reach the port
directly.

## Browser-hardening headers

Sent on every response (see `src/hooks.server.ts`):

- `Content-Security-Policy`: `default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; connect-src 'self';
  img-src 'self' data: https://avatars.githubusercontent.com;
  font-src 'self' data:; frame-ancestors 'none'; base-uri 'self';
  form-action 'self'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: same-origin`, and a restrictive `Permissions-Policy`
  (camera/mic/geolocation/usb/payment all `()`).
- `Strict-Transport-Security` over HTTPS.

## Content sanitization

- All markdown from the assistant is rendered client-side with `marked` →
  `DOMPurify` (see `src/lib/client/markdown.ts`). Assistant content is never
  injected into SSR HTML.
- SVG images are active content (script/handlers/external refs), so they are
  sanitized server-side with DOMPurify's SVG profile over a jsdom DOM
  (`src/lib/server/svg-sanitize.ts`) and rendered only via `<img>` under
  `nosniff` + `default-src 'none'; sandbox`.

## Working-directory containment

- The authoritative workdir is the persisted `conversations.workdir` row, which
  defaults to `PROJECT_ROOT`; the pi agent and the conversation-scoped
  file/git routes all resolve from that same row.
- A user-supplied workdir must resolve, after symlinks, inside one of the
  configured allowed roots (default: just `PROJECT_ROOT`). A single trusted
  operator who wants several project trees widens this with `ALLOWED_WORKDIRS`.
  This stops a workdir pointed at `/` from reading arbitrary host files
  (`/etc/passwd`, `/proc/self/environ`) through the file-browser / git
  endpoints.
- The read-only file browser and git endpoints constrain paths to the workspace
  root's realpath; symlinks that escape are rejected, and `git` runs with
  `shell: false`, hard timeouts, and output size caps.

## Tool permissions

- Default policy: **prompt** for every tool call that mutates state or runs a
  shell command. Read-only tools can be set to auto-allow.
- "Allow always" decisions default to one conversation; global allow requires
  confirmation in settings; grants can be authored directly in **Settings →
  Permissions**.
- A grant cannot defeat a tool that declares `permissionBehavior:
  'always-prompt'` (`git_commit`, `worktree_merge`, `worktree_remove`, …).
- The full permission decision log is persisted and viewable in the
  conversation detail page.

### Adversary shadow mode (experimental, off by default)

An exploration of whether a second LLM could review permission requests instead
of the human. **Phase 0 deliberately grants it no authority.** It is
fire-and-forget: whatever it records, nothing reads it back and the dialog never
waits on it. See the in-app Settings → Permissions docs and the source for the
full design (structured-facts-only prompts, no tools for the reviewer, a
different model from the agent, errors are errors). Read the results with
`pnpm run report:adversary-shadow`; `pnpm run probe:adversary` runs a fixed set
of hostile requests, `--dry-run` prints the prompts without calling anything.

## Stored-secret encryption

Provider and BYOK API keys are encrypted at rest with AES-256-GCM under the
`ENCRYPTION_KEY` env var (base64, 32 bytes) before being written to the DB. This
is for at-rest secrecy of credentials, not authentication. No model credential
is ever logged or echoed back to the client; the pi SDK resolves its own auth at
session open.

## Logging

- Structured JSON logs to stdout.
- Tokens and message bodies are never logged at default level; at
  `LOG_LEVEL=debug` message bodies are logged with `[REDACTED]` for anything
  token-shaped.

## Tailscale exposure (recommended for remote access)

To reach the portal from another device without exposing it publicly:

1. Install Tailscale on the host (`curl -fsSL https://tailscale.com/install.sh |
   sh`) and run `tailscale up` to join your tailnet.
2. Leave the portal bound to `127.0.0.1` and port-forward it to the tailnet —
   e.g. with `tailscale serve 3000` (Tailscale Serve) or by binding the portal
   to the tailnet interface. Tailscale Serve gives you a `https://<machine>`
   URL reachable only by your tailnet's ACLs.
3. Do not publish the port to the public internet. Tailscale's ACLs are your
   access control; the portal adds none.
