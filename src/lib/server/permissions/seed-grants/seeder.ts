import { FS_PERMISSIONS } from "$lib/permissions/scope-types";
import {
  addGrant,
  listGrantsForUser,
  revokeGrant,
} from "../../db/repos/settings";
import {
  boundPositionals,
  PURE_UTILS,
  seedKey,
  shellCommand,
  shellDeny,
  shellGrant,
  shellPatternDeny,
  shellPrompt,
  deferredReader,
  type SeedSpec,
} from "./common";
import {
  GIT_STRUCTURED_SUBCOMMAND_DENIES,
  GIT_STRUCTURED_TOOLS,
  RISKY_GIT_GLOBAL_PATTERNS,
  SAFE_GIT_GLOBAL_OPTIONS,
  gitStructuredSubcommandFeedback,
  riskyGitGlobalOptionFeedback,
} from "./git";
import {
  CWD_MOVERS,
  FS_READ_TOOLS,
  PATH_SEARCH_TOOLS,
  PROMPT_SEEDS,
  STDIN_FILTER_PROMPT_REASON,
  STDIN_FILTER_TOOLS,
  WC_SHELL_DENY_FEEDBACK,
} from "./shell";

/**
 * Workspace ticket bookkeeping. Edges are wired through `ticket_update`'s
 * `blockedBy` / `blocks` fields, which replace whole edge sets declaratively.
 */
const TICKET_STRUCTURED_TOOLS = [
  "ticket_add",
  "ticket_list",
  "ticket_get",
  "ticket_update",
];
const PERMISSION_STRUCTURED_TOOLS = ["permission_capabilities"];

/**
 * Read-only worktree-lease inspection, seeded for the same reason as
 * `git_worktree_status`: an orchestrator polls these to find out which of its
 * parallel sub-agents have finished. Unseeded they require a prompt, which
 * under the `auto-deny` approval mode is an auto-deny — so an unattended
 * orchestrator could not even enumerate its own worktrees.
 *
 * The mutating tools (`worktree_create`, `_merge`, `_remove`) are deliberately
 * absent, matching `git_commit` / `git_worktree_merge`: they create or destroy
 * checkouts and branches, and `_merge`/`_remove` declare
 * `permissionBehavior: 'always-prompt'` so a grant could not auto-approve them
 * anyway. Absent from the DEFAULTS is not the same as unreachable: a user who
 * wants `worktree_create` to stop prompting can author the same
 * custom-tool grant by hand in Settings → Permissions.
 */
const WORKTREE_STRUCTURED_TOOLS = ["worktree_list", "worktree_status"];

export function defaultSeedGrants(): SeedSpec[] {
  const seeds: SeedSpec[] = [];

  for (const argv0 of PURE_UTILS) {
    seeds.push(shellGrant(shellCommand(argv0, { kind: "any" })));
  }
  // cwd-moving builtins (`cd`, `pushd`, `popd`, `chdir`): auto-allowed only
  // to a concrete target inside the workspace roots — workdir, worktree
  // leases, and their subdirectories — which is what this `workspace-paths`
  // seed expresses. The `min: 1` guard (as with the deferred readers) means
  // bare `cd` / `popd`, which would move to $HOME / the saved dir, do not
  // auto-approve on a rule that checked no path. Agents' reflexive
  // `cd /workspace` is always valid.
  for (const { token } of CWD_MOVERS) {
    seeds.push(
      shellGrant(
        deferredReader(shellCommand(token, { kind: "workspace-paths" })),
      ),
    );
  }
  // Anything else — out-of-workspace targets, bare `cd`, `popd` — gets a
  // prompt with a steer instead of silence.
  for (const { token } of CWD_MOVERS) {
    seeds.push(
      shellPrompt(
        shellCommand(token, { kind: "any" }),
        `\`${token}\` outside the workspace requires approval. \`cd\` is only useful inside the workspace (workdir, worktree leases, subdirectories); elsewhere it moves the shell somewhere the matcher cannot track, so relative paths in later commands resolve differently than checked. Prefer the tool's \`cwd\` argument.`,
      ),
    );
  }
  // Read-only shell tools get TWO allow seeds, and the pair is the whole
  // design:
  //
  //   * `workspace-paths` — the FLOOR. Exactly today's behavior, covering the
  //     conversation's workspace plus every worktree lease it holds. Keeping
  //     it is what makes this migration purely additive: nothing a user could
  //     do before stops working, including reading a sub-agent's lease files.
  //   * `readable-paths`  — the GROWTH. Whatever the user's `read` grants say,
  //     so a path they made readable for `view` is readable for `cat` too,
  //     without mirroring it into a shell grant.
  //
  // `session-workspace-paths` is deliberately NOT seeded any more: the
  // session-workspace fs read seed above already expresses that same set, and
  // `readable-paths` now honors it. A user who revokes that fs seed should
  // lose the shell reads with it — that was the divergence to begin with.
  //
  // The deferring seed carries `positionalCount: {min: 1}` so it can never
  // grant vacuously. Zero-positional invocations (`cat` reading stdin in a
  // pipe, bare `ls`) name no path to check, so they belong to the floor seed
  // and keep their existing behavior rather than being auto-approved by a rule
  // that checked nothing.
  for (const { token, options, maxPositionals } of FS_READ_TOOLS) {
    seeds.push(
      shellGrant(
        boundPositionals(
          shellCommand(token, { kind: "workspace-paths" }, options),
          maxPositionals,
        ),
      ),
    );
    seeds.push(
      shellGrant(
        deferredReader(
          boundPositionals(
            shellCommand(token, { kind: "readable-paths" }, options),
            maxPositionals,
          ),
        ),
      ),
    );
  }
  for (const tool of GIT_STRUCTURED_TOOLS) {
    seeds.push({ tool, permissionKind: "custom-tool", scope: { kind: "any" } });
  }
  for (const tool of TICKET_STRUCTURED_TOOLS) {
    seeds.push({ tool, permissionKind: "custom-tool", scope: { kind: "any" } });
  }
  for (const tool of WORKTREE_STRUCTURED_TOOLS) {
    seeds.push({ tool, permissionKind: "custom-tool", scope: { kind: "any" } });
  }
  for (const tool of PERMISSION_STRUCTURED_TOOLS) {
    seeds.push({ tool, permissionKind: "custom-tool", scope: { kind: "any" } });
  }
  for (const perm of FS_PERMISSIONS) {
    seeds.push({
      tool: perm,
      permissionKind: perm,
      scope: {
        kind: "fs",
        perms: [perm],
        rule: { kind: "path", root: "session-workspace", behavior: "any" },
      },
    });
  }

  seeds.push(
    shellPrompt(
      { command: [{ token: "git" }] },
      "Shell `git` requires a prompt. Use `permission_capabilities` to find allowed alternatives, then use an available structured Git tool instead.",
    ),
  );
  for (const { option, pattern } of RISKY_GIT_GLOBAL_PATTERNS) {
    seeds.push(shellPatternDeny(pattern, riskyGitGlobalOptionFeedback(option)));
  }
  for (const { subcommand, tools } of GIT_STRUCTURED_SUBCOMMAND_DENIES) {
    seeds.push(
      shellDeny(
        {
          command: [
            { token: "git", options: { allow: SAFE_GIT_GLOBAL_OPTIONS } },
            { token: subcommand },
          ],
          positionals: { kind: "any" },
        },
        gitStructuredSubcommandFeedback(subcommand, tools),
      ),
    );
  }

  // `wc` is denied (any args, in or out of workspace) and steered to the
  // structured grep tool for line counts. A bare-token rule with `any`
  // positionals also covers `cat foo | wc -l`, since the matcher checks
  // hard-denies across every pipeline segment first.
  seeds.push(
    shellDeny(
      { command: [{ token: "wc" }], positionals: { kind: "any" } },
      WC_SHELL_DENY_FEEDBACK,
    ),
  );

  // find: a read-only path-search tool, seeded on the same floor + growth pair
  // as the fs-read tools above. `workspace-paths` keeps today's behavior
  // (including bare `find`, whose implicit operand is the cwd); the
  // `readable-paths` seed adds whatever the user's `read` grants cover and,
  // via `min: 1`, never fires without a path it actually checked. Its
  // command-running options are denied in both.
  for (const { token, options, maxPositionals } of PATH_SEARCH_TOOLS) {
    seeds.push(
      shellGrant(
        boundPositionals(
          shellCommand(token, { kind: "workspace-paths" }, options),
          maxPositionals,
        ),
      ),
    );
    seeds.push(
      shellGrant(
        deferredReader(
          boundPositionals(
            shellCommand(token, { kind: "readable-paths" }, options),
            maxPositionals,
          ),
        ),
      ),
    );
  }

  // "Search anywhere" opt-in: a clearly-labeled prompt seed per path-search
  // tool. Because allow seeds outrank prompt seeds, searches within the
  // readable paths still auto-approve via the grants above; only searches that
  // reach past them land here and require an explicit human approval (or the
  // user can add their own read grant, which the allow seed then honors).
  for (const { token, options, maxPositionals } of PATH_SEARCH_TOOLS) {
    seeds.push(
      shellPrompt(
        boundPositionals(
          shellCommand(token, { kind: "any" }, options),
          maxPositionals,
        ),
        `\`${token}\` searching outside the paths your \`read\` grants permit requires approval (opt-in "search anywhere"). Readable paths are auto-approved; approve to search elsewhere this once, or add a \`read\` grant covering it to always allow it.`,
      ),
    );
  }

  // grep / rg: allowed only as a pipe filter over another command's
  // stdout, with no file operands. Anything else — including
  // `grep pattern file` and `grep pattern file | head`, where grep is the
  // pipeline's producer rather than its target — falls through to the
  // prompt seed and is steered to the structured `grep` tool.
  for (const { token, options } of STDIN_FILTER_TOOLS) {
    const rule = shellCommand(token, { kind: "any" }, options);
    rule.positionalCount = { max: 1 };
    rule.pipeline = "pipe-target";
    seeds.push(shellGrant(rule));
  }
  for (const { token } of STDIN_FILTER_TOOLS) {
    seeds.push(
      shellPrompt(
        shellCommand(token, { kind: "any" }),
        `Shell \`${token}\` ${STDIN_FILTER_PROMPT_REASON.replace("%TOKEN%", token)}`,
      ),
    );
  }

  // Prompt only when no allow seed also covers the command.
  for (const { argv0, reason } of PROMPT_SEEDS) {
    seeds.push(
      shellPrompt({ command: [{ token: argv0 }], pipeline: "forbid" }, reason),
    );
  }

  return seeds;
}

/**
 * Insert the default seed grants for `userId` iff they're not already
 * present. We key dedup on (tool, permission_kind, scope_json, decision)
 * — the structured representation uniquely identifies the seed, so a
 * user who has manually deleted one won't see it return on next login.
 *
 * Re-running this function is a no-op when the user already has all
 * seeds. To restore a deleted seed, the user re-adds it from the UI.
 */
export function ensureSeedGrantsForUser(userId: number): number {
  const existing = listGrantsForUser(userId);
  const haveKey = new Set<string>();
  for (const g of existing) {
    haveKey.add(
      seedKey(g.tool, g.permissionKind, g.scope, g.scopePattern, g.decision),
    );
  }

  let inserted = 0;
  for (const seed of defaultSeedGrants()) {
    const decision = seed.decision ?? "allow";
    const key = seedKey(
      seed.tool,
      seed.permissionKind,
      seed.scope ?? null,
      seed.scopePattern ?? null,
      decision,
    );
    if (haveKey.has(key)) continue;
    addGrant({
      userId,
      conversationId: null,
      tool: seed.tool,
      permissionKind: seed.permissionKind,
      scope: seed.scope ?? null,
      scopePattern: seed.scopePattern ?? null,
      decision,
      denyReason: seed.denyReason ?? null,
      source: "seed",
    });
    haveKey.add(key);
    inserted += 1;
  }
  return inserted;
}

/**
 * Replace every identifiable user-global default seed grant with the current
 * default set. This powers the Settings "Restore default seed grants" button:
 * unlike login-time seeding, it intentionally removes stale default rows first
 * so old seed shapes (for example hard-deny prompts that are now prompt rules) do not
 * keep winning by matcher precedence.
 */
export function restoreSeedGrantsForUser(userId: number): {
  removed: number;
  inserted: number;
} {
  const defaultKeys = restoreSeedKeys();
  let removed = 0;
  for (const grant of listGrantsForUser(userId)) {
    if (grant.conversationId !== null) continue;
    if (grant.argsHash) continue;
    // Checked-in `.zap/permissions.toml` rows are workspace policy the
    // human explicitly imported; "restore defaults" must never touch them,
    // even when a file grant happens to match a default seed's key.
    if (grant.source === "workspace-file") continue;
    if (grant.source !== "seed") {
      if (
        !defaultKeys.has(
          seedKey(
            grant.tool,
            grant.permissionKind,
            grant.scope,
            grant.scopePattern,
            grant.decision,
          ),
        )
      ) {
        continue;
      }
    }
    if (revokeGrant(userId, grant.id)) removed += 1;
  }
  return { removed, inserted: ensureSeedGrantsForUser(userId) };
}

function restoreSeedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const seed of defaultSeedGrants()) {
    const decision = seed.decision ?? "allow";
    keys.add(
      seedKey(
        seed.tool,
        seed.permissionKind,
        seed.scope ?? null,
        seed.scopePattern ?? null,
        decision,
      ),
    );
    if (decision === "prompt") {
      keys.add(
        seedKey(
          seed.tool,
          seed.permissionKind,
          seed.scope ?? null,
          seed.scopePattern ?? null,
          "deny",
        ),
      );
    }
  }
  return keys;
}
