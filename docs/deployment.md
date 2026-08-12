# 07 — Deployment

The portal is distributed as a multi-arch container image
(`linux/amd64` + `linux/arm64`) at
`ghcr.io/<owner>/zap:<tag>`. It's a long-running web server
that needs:

- A persistent volume for its encrypted SQLite database (`/data`).
- Persistent space for portal-owned linked worktrees (`/data/worktrees` by
  default, covered by the same volume).
- A bind mount of the project tree the agent should read and edit
  (`/workspace`).
- `git` available in `PATH` inside the container (already included in the
  image).

Two deployment topologies are supported:

- **A. Standalone** — single host, no devcontainer involvement.
  Recommended default.
- **B. Devcontainer coexistence** — the portal runs in its own container
  alongside a devcontainer that mounts the same workspace. Both
  containers must see the project tree at the same absolute path with
  matching UIDs.

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

### Managed worktrees

`WORKTREE_ROOT` defaults to `<DATA_DIR>/worktrees`; the Compose deployment pins
it to `/data/worktrees`. Git stores absolute paths for linked worktrees, so both
`PROJECT_ROOT` and `WORKTREE_ROOT` must keep the same in-container paths across
restarts and image upgrades. The portal user needs write access to both the
source repository's Git metadata and `WORKTREE_ROOT`.

`WORKTREE_CREATE_TIMEOUT_MS` bounds `git worktree` lifecycle commands and
defaults to 120 seconds. Managed worktrees require a repository with at least
one commit. Submodule initialization, Git LFS fetching, pushing, merging, and
branch deletion remain operator/user responsibilities.

Conversation deletion removes a clean managed checkout but retains its
`portal/<conversationId>` branch. Dirty deletion requires an explicit second
confirmation. Archive never removes files.

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

> **First boot:** if `./data` doesn't already exist, Docker pre-creates it
> `root:root`, which UID 1000 can't write — the portal then crashes opening the
> SQLite DB. Create it owned correctly before the first `up`:
> `mkdir -p data && sudo chown 1000:1000 data`. (Skipped automatically if your
> host user is already UID 1000.)

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
(editor, language servers, terminals); the portal runs agents against
the same files in the background.

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
2. Homepage URL: `https://zap.example.com` (your tunnel hostname).
3. Authorization callback URL: `https://zap.example.com/auth/callback`.
4. Copy client id / secret into `.env`.
5. *(Optional)* Require this app to be approved by your organization if
   you want an org approval gate on the GitHub identity.

## Cloudflare Tunnel

Use the `compose.tunnel.yaml` overlay:

```bash
docker compose -f compose.yaml -f compose.tunnel.yaml up -d
```

This wires both services onto a shared `appnet` bridge so `cloudflared`
reaches the portal at `http://portal:3000` — no host networking, so the
container's port namespace stays isolated (child processes binding ports
aren't exposed on host interfaces). The portal isn't published to the host;
public reachability comes solely from the tunnel. `cloudflared` is pinned and
waits for the portal's `service_healthy` state, so it won't forward traffic to
a not-yet-bound origin on cold boot.

Cloudflare side:

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create tunnel.
2. Install method: Docker → copy the `TUNNEL_TOKEN` into `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN`.
3. Public Hostname: `zap.example.com` → Service `http://portal:3000`.
4. *(Strongly recommended)* Zero Trust → Access → Applications →
   Self-hosted. Cover the same hostname; policy: "Emails are one of:
   you@example.com" with GitHub or Google identity provider.

With Access in front, the portal is doubly protected: CF gates at the
network edge, and the portal's own login still applies.

When fronted by a tunnel or reverse proxy, set SvelteKit's `ORIGIN` environment
variable to the public origin (for example, `https://zap.example.com`) so
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
   then runs check and Playwright e2e with phase-prefixed logs. Running the
   full gate (including e2e) is deliberate — it keeps a broken build from
   rolling over onto the live server. The e2e phase runs with `E2E_ISOLATED=1`
   so it never reuses/attaches to the live server, spinning up its own
   throwaway server + DB instead and leaving the running portal untouched. Disabled by default;
   set `ENABLE_REDEPLOY=1` to opt in. With `AUTH_MODE=github`, set
   `REDEPLOY_ADMIN_GITHUB_LOGINS` to the GitHub logins allowed to trigger
   redeploys when more than one login can sign in. Not used in the container
   image (the image ships only the built tree, not the source).
- Migrations run automatically on startup; DB schema is forward-only.
  Rolling back across a migration requires restoring a pre-update DB
  backup.

## Health and observability

- `GET /api/health/liveness` → `200 {"ok":true}`, DB-free. Answers "is the
  process serving HTTP?" This is what the container HEALTHCHECK polls, so a
  transient DB hiccup or a long startup migration can't restart the container
  mid-migration. The Dockerfile uses a generous `--start-period` to give
  first-boot migrations room to finish.
- `GET /api/health` → readiness. `200 {"ok":true}` if DB reachable and
  migrations current. `503 {"ok":false,"error":"…"}` on failure. Use it for
  traffic-routing / Cloudflare Tunnel origin checks — not as the restart
  trigger.
- Logs to stdout as structured JSON. `docker logs -f portal` is
  sufficient for personal use; pipe to Loki/Vector if you have one.
- Metrics out of scope for v1.

## Resource expectations

- Idle: ~150 MB RAM, negligible CPU.
- Active session: +200–400 MB while an agent session is live.
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
