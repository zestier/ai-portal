# 07 — Deployment

The portal is distributed as a multi-arch container image
(`linux/amd64` + `linux/arm64`) at
`ghcr.io/<owner>/zap:<tag>`. It's a long-running web server
that needs:

- A persistent volume for its encrypted SQLite database (`/data`).
- A bind mount of the project tree the agent should read and edit
  (`/workspace`).
- `git` available in `PATH` inside the container (already included in the
  image).

Three deployment topologies are supported:

- **A. Standalone** — single host, no devcontainer involvement.
  Recommended default.
- **B. Devcontainer coexistence** — the portal runs in its own container
  alongside a devcontainer that mounts the same workspace. Both
  containers must see the project tree at the same absolute path with
  matching UIDs.
- **C. Remote CLI** — the Copilot CLI runs as a long-lived headless
  JSON-RPC server, and the portal
  connects to it over TCP via the SDK's `cliUrl` option.

## Topology A — Standalone

```yaml
# compose.yaml is committed; just supply a .env file.
services:
  portal:
    image: ghcr.io/<owner>/zap:latest
    # ...
    volumes:
      - ./data:/data
      - ${PROJECT_DIR:?required}:/workspace
    ports: ["127.0.0.1:3000:3000"]
```

`.env`:

```bash
PROJECT_DIR=/home/me/projects/foo
SESSION_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)
AUTH_MODE=github
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_LOGINS=you
```

Start:

```bash
docker compose up -d
```

The portal is now reachable on `http://127.0.0.1:3000`. For public
access, see "Cloudflare Tunnel" below.

### UID / permissions

The image runs as the built-in `node` user (UID 1000). Files written to
`./data` and `/workspace` will be owned by UID 1000 on the host. If your
host user is also UID 1000 (the default on most Linux desktops), nothing
special is needed. Otherwise either:

- Run the container as your UID:
  ```yaml
  services:
    portal:
      user: "${UID}:${GID}"
  ```
- Or `chown` the bind-mounted directories to UID 1000 once.

**Podman, rootless mode:** add `--userns=keep-id` (or set
`userns_mode: keep-id` in the compose file) so that container UID 1000
maps to your host UID instead of a subuid. Without this, snapshots fail
to write into the workspace.

**SELinux hosts (Fedora, RHEL):** suffix bind mounts with `:Z` for
private relabeling:

```yaml
volumes:
  - ./data:/data:Z
  - ${PROJECT_DIR}:/workspace:Z
```

## Topology B — Devcontainer coexistence

The portal and your devcontainer both bind-mount the same host
directory, at the same absolute path inside each container. The portal
does not need to talk to the devcontainer; both processes operate on the same
shared tree. Portal snapshots are point-in-time git refs captured around turns,
not a concurrency control mechanism, so avoid running portal turns and manual
devcontainer edits that touch the same files at the same time.

```
host:
  ~/projects/foo                          <-- the project tree

portal container:
  /workspace                              <-- bind of ~/projects/foo

devcontainer:
  /workspaces/foo                         <-- bind of ~/projects/foo
```

Constraints (all enforced or assumed by the codebase):

1. **Workspace bind mount, not a managed volume.** Some devcontainer
   templates use a named Docker volume for the workspace; the portal
   cannot reach inside that. Switch the devcontainer's `workspaceMount`
   to a host bind mount of the same directory you give to
   `PROJECT_DIR`.
2. **Same absolute path is preferred.** The diff/file-tree APIs reject
   paths outside the portal's `PROJECT_ROOT`. They still work if the
   paths differ between containers, but error messages and any tool
   output that quotes paths will look inconsistent across the two UIs.
   Easiest fix: mount at `/workspaces/<repo>` in both containers (the
   devcontainer convention).
3. **UID parity.** Devcontainer images commonly run as a `vscode` user
   at UID 1000, matching this image's `node` user. If your devcontainer
   uses a different UID, override the portal's user to match (see
   "UID / permissions" above).

The devcontainer remains responsible for *interactive* development
(editor, language servers, terminals); the portal runs Copilot agents
against the same files in the background.

## Topology C — Remote CLI

The portal can connect to an externally-managed `copilot` process
instead of spawning the bundled one. The Copilot CLI exposes a hidden
headless JSON-RPC server mode that the SDK's `cliUrl` option talks to.

This is the right topology when:

- The agent's shell tool should run inside a devcontainer (or another
  host) with its own toolchain, while the portal stays on the host.
- You want a single long-lived agent process whose state survives portal
  restarts and redeploys.
- You want the human and the portal sharing one Copilot auth — the
  remote CLI owns its own `~/.copilot/accounts.json`; the portal does
  not need `COPILOT_GITHUB_TOKEN` in this mode.

### 1. Start the headless CLI

Inside the devcontainer (or wherever you want the agent to run):

```bash
copilot login              # one-time, populates ~/.copilot/accounts.json
copilot --headless --port 9000
```

`--headless` (alias `--server`) is undocumented in `copilot --help` but
is the supported pairing for the SDK's `cliUrl`. It runs the CLI as a
long-lived JSON-RPC server with no TUI. Bind to `127.0.0.1` only unless
the portal is on a different host; the JSON-RPC server has no
authentication of its own.

Other flags that may be useful on the headless side:

- `-C <directory>` — change cwd before doing anything else.
- `--add-dir <directory>` — additional directories the CLI is allowed
  to touch.
- `--log-dir /some/path` — surface CLI logs somewhere you can tail.

### 2. Point the portal at it

Set `COPILOT_CLI_URL` to the headless server's address. Accepted forms
(see `CopilotClient.parseCliUrl`): bare port `"9000"`, `"host:9000"`,
or `"http://host:9000"`.

```bash
# .env
COPILOT_CLI_URL=host.docker.internal:9000   # portal in Docker, CLI on host
# or, when portal and CLI are on the same host network:
# COPILOT_CLI_URL=127.0.0.1:9000
```

When `COPILOT_CLI_URL` is set, `copilot-provider.ts` constructs the SDK client
with `{ cliUrl, autoStart: false }` and does NOT pass `gitHubToken` or
`useLoggedInUser` — those are mutually exclusive with `cliUrl`, and the
remote CLI manages its own auth. If `COPILOT_CONNECTION_TOKEN` is set (see
below) it is forwarded as the SDK's `tcpConnectionToken`.

### Caveats

- **Optional auth on the JSON-RPC port.** Without a token the CLI prints
  this warning at startup:

  > Warning: No COPILOT_CONNECTION_TOKEN was set, so connections will
  > be accepted from any client

  Setting `COPILOT_CONNECTION_TOKEN` on the CLI side makes it require
  clients to include a matching token in the handshake. Set the **same**
  value as `COPILOT_CONNECTION_TOKEN` on the portal side — the portal
  forwards it to the SDK as `tcpConnectionToken` so the connect handshake
  authenticates:

  ```bash
  # CLI side
  COPILOT_CONNECTION_TOKEN=<shared-secret> copilot --headless --port 9000
  # portal side (.env)
  COPILOT_CONNECTION_TOKEN=<shared-secret>
  ```

  > Note: `@github/copilot-sdk@1.0.0-beta.4` only reads the token from the
  > explicit `tcpConnectionToken` option for `cliUrl` connections — it does
  > NOT fall back to the `COPILOT_CONNECTION_TOKEN` environment variable the
  > way earlier SDK builds did. The portal bridges that gap by reading the
  > env var and passing it through; if you omit it on the portal side, a
  > token-protected CLI rejects the connection.

  If you leave the token unset on both sides, keep the headless port bound
  to loopback (or an otherwise-trusted private network). Anything that can
  reach the port can drive the agent, including running shell commands.
- **Per-conversation working directories don't transfer.** The portal
  passes `workingDirectory` to `createSession`, but the remote CLI
  must already have file access to that path (start it with `-C` and
  `--add-dir` covering everything you want the agent to touch).
- **Restart coupling.** If the headless CLI dies, the portal's cached
  `CopilotClient` is now pointing at nothing — restart the portal too
  (or implement a reconnect; not done yet).

## Secrets

```bash
export SESSION_SECRET=$(openssl rand -base64 48)
export ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Both are required for any non-trivial auth mode. `ENCRYPTION_KEY` must
decode to exactly 32 raw bytes (the default `openssl rand -base64 32`
produces this). `compose.yaml` reads them via `${VAR:?required}` so the
stack refuses to start if either is missing.

## GitHub OAuth App setup

1. Create an OAuth app at <https://github.com/settings/developers>.
2. Homepage URL: `https://copilot.example.com` (your tunnel hostname).
3. Authorization callback URL: `https://copilot.example.com/auth/callback`.
4. Copy client id / secret into `.env`.
5. *(Optional)* Require this app to be approved by your organization if
   you want org-scoped Copilot entitlement to flow through.

## Cloudflare Tunnel

Use the `compose.tunnel.yaml` overlay:

```bash
docker compose -f compose.yaml -f compose.tunnel.yaml up -d
```

This switches both services to `network_mode: host` so `cloudflared`
can reach the portal on `127.0.0.1:3000` without a shared bridge. The
portal binds to `127.0.0.1`; public reachability comes from the tunnel.

Cloudflare side:

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create tunnel.
2. Install method: Docker → copy the `TUNNEL_TOKEN` into `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN`.
3. Public Hostname: `copilot.example.com` → Service `http://127.0.0.1:3000`.
4. *(Strongly recommended)* Zero Trust → Access → Applications →
   Self-hosted. Cover the same hostname; policy: "Emails are one of:
   you@example.com" with GitHub or Google identity provider.

With Access in front, the portal is doubly protected: CF gates at the
network edge, and the portal's own login still applies.

When fronted by a tunnel or reverse proxy, set SvelteKit's `ORIGIN` environment
variable to the public origin (for example, `https://copilot.example.com`) so
same-origin checks compare against the browser-visible URL.

## Local development

```bash
cp .env.example .env             # fill in dev OAuth app values
pnpm install
pnpm run dev                     # SvelteKit dev server on :5173
```

For dev, use a separate GitHub OAuth app pointing at
`http://127.0.0.1:5173/auth/callback`. Set `AUTH_MODE=shared-secret` or
`AUTH_MODE=none` (loopback dev: `HOST=127.0.0.1` + `I_KNOW_THIS_IS_LOCAL=1`)
for faster iteration.

For agent-driven exploratory testing, use `pnpm run dev:isolated` so
the local DB isn't polluted. See [`AGENTS.md`](../AGENTS.md).

## Updates

- **Containerized deployment:** `docker compose pull && docker compose up -d`.
- **Bare metal under `pnpm run serve` (the supervisor):** the in-app
   redeploy button runs `git pull && pnpm install && pnpm run verify`
   and exits; the supervisor relaunches on the new code. `verify`
   schedules a small DAG that overlaps independent lint/unit/build phases,
   then runs check and Playwright e2e with phase-prefixed logs. Disabled by default;
   set `ENABLE_REDEPLOY=1` to opt in. With `AUTH_MODE=github`, set
   `REDEPLOY_ADMIN_GITHUB_LOGINS` to the GitHub logins allowed to trigger
   redeploys when more than one login can sign in. Not used in the container
   image (the image ships only the built tree, not the source).
- Migrations run automatically on startup; DB schema is forward-only.
  Rolling back across a migration requires restoring a pre-update DB
  backup.

## Health and observability

- `GET /api/health` → `200 {"ok":true}` if DB reachable and migrations
  current. `503 {"ok":false,"error":"…"}` on failure. Used by the
  compose healthcheck and Cloudflare Tunnel origin checks.
- Logs to stdout as structured JSON. `docker logs -f portal` is
  sufficient for personal use; pipe to Loki/Vector if you have one.
- Metrics out of scope for v1.

## Resource expectations

- Idle: ~150 MB RAM, negligible CPU.
- Active session: +200–400 MB while the Copilot CLI subprocess is running.
- Per `MAX_CONCURRENT_SESSIONS=4` (default), budget ~1.5 GB peak RAM.
- Disk: DB grows with conversation history; expect tens of MB even
  after heavy use.

## Building the image locally

```bash
docker build -t zap:dev .
```

For a multi-arch build matching the released image:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t zap:dev .
```

Requires `docker buildx` with QEMU set up
(`docker run --privileged --rm tonistiigi/binfmt --install all`). The
release workflow at [`.github/workflows/release.yml`](../.github/workflows/release.yml)
publishes images automatically on tag push (`v*`).
