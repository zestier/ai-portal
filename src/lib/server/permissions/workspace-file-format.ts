// Parser + validator for the checked-in workspace permissions file
// (`.zap/permissions.toml`). Pure and dependency-light so the gate, the
// settings UI, and the tests all share one source of truth.
//
// The file is a human-authored TOML document with one section per grant
// kind. Each entry maps 1:1 onto the SAME structured grant shape the
// settings form authors — we build a `GrantInputSchema` payload from each
// TOML table and validate it through that schema, so anything the file
// accepts is exactly something a user could type in Settings, and anything
// the form rejects is rejected here too. That keeps the two authoring
// surfaces in lockstep with no second schema to drift.
//
// Format:
//
//   [[shell]]
//   decision = "allow"                 # allow | deny | prompt (default allow)
//   command = ["git", "status"]        # full argv; first token = argv0
//   positionals = "any"                # optional: any | none | workspace-paths
//                                      #   | session-workspace-paths
//                                      #   | readable-paths | writable-paths
//   positional_min = 0                 # optional non-negative ints
//   positional_max = 1
//   pipeline = "forbid"                # optional: must | forbid | pipe-target
//
//     [[shell.options]]                # one table per command token (indexed)
//     allow = ["--paginate"]           # flags or --opt=any / --opt=workspace-path
//     deny = ["-C"]
//
//   [[path]]
//   decision = "deny"
//   permission = "write"               # read | write | edit (required)
//   root = "absolute"                  # workspace | session-workspace | absolute
//   behavior = "prefix"                # any | exact | prefix | glob
//   value = "/tmp/scratch"             # required unless behavior = "any"
//
//   [[url]]
//   decision = "allow"
//   rule = "host"                      # exact | host | host-suffix
//   value = "example.com"
//
//   [[tool]]
//   decision = "deny"
//   name = "git_commit"                # a portal tool name
//   deny_reason = "..."                # optional; only meaningful on deny/prompt
//
// `deny_reason` is accepted anywhere a deny/prompt entry would show it to the
// agent; the shared schema rejects it on allow entries (same as the form).

import { parse, TomlError } from "smol-toml";
import {
  GrantInputSchema,
  permissionKindForTool,
  persistedGrantTool,
} from "$lib/permissions/scope-schema";
import { parseShellOptionSpecs } from "$lib/permissions/grant-form";
import type { ShellOptionSpec } from "$lib/permissions/scope-types";
import type { GrantScope } from "$lib/permissions/scope-types";

export interface WorkspaceFileGrant {
  tool: string;
  permissionKind: string | null;
  scope: GrantScope | { kind: "any" };
  scopePattern: string | null;
  decision: "allow" | "deny" | "prompt";
  denyReason: string | null;
}

export type ParseWorkspaceGrantFileResult =
  { ok: true; grants: WorkspaceFileGrant[] } | { ok: false; error: string };

const KNOWN_SECTIONS = new Set(["shell", "path", "url", "tool"]);
const DECISIONS = new Set(["allow", "deny", "prompt"]);

export function parseWorkspaceGrantFile(
  text: string,
): ParseWorkspaceGrantFileResult {
  let root: unknown;
  try {
    root = parse(text);
  } catch (e) {
    const err = e instanceof TomlError ? e : new Error(String(e));
    return { ok: false, error: `invalid TOML: ${err.message}` };
  }

  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    return {
      ok: false,
      error:
        "invalid TOML: expected a document with [[shell]]/[[path]]/[[url]]/[[tool]] sections",
    };
  }
  const table = root as Record<string, unknown>;

  for (const key of Object.keys(table)) {
    if (!KNOWN_SECTIONS.has(key)) {
      return {
        ok: false,
        error: `unsupported section "${key}"; expected only [[shell]], [[path]], [[url]], [[tool]]`,
      };
    }
  }

  const grants: WorkspaceFileGrant[] = [];
  for (const kind of ["shell", "path", "url", "tool"] as const) {
    const raw = table[kind];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      return {
        ok: false,
        error: `section [${kind}] must be an array of tables (use [[${kind}]])`,
      };
    }
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: `[[${kind}]] entry ${i} is not a table` };
      }
      const parsed = parseSection(kind, entry as Record<string, unknown>, i);
      if (!parsed.ok) return parsed;
      grants.push(parsed.grant);
    }
  }
  return { ok: true, grants };
}

type SectionResult =
  { ok: true; grant: WorkspaceFileGrant } | { ok: false; error: string };

function parseSection(
  kind: "shell" | "path" | "url" | "tool",
  e: Record<string, unknown>,
  index: number,
): SectionResult {
  const decisionRaw = strField(e, "decision");
  if (decisionRaw === null) {
    if (e["decision"] !== undefined)
      return fail(index, "decision must be a string");
  } else if (!DECISIONS.has(decisionRaw)) {
    return fail(
      index,
      `decision must be one of allow | deny | prompt, got "${decisionRaw}"`,
    );
  }
  const decision = decisionRaw ?? "allow";
  const denyReason = strField(e, "deny_reason");

  switch (kind) {
    case "shell":
      return parseShell(e, decision, denyReason, index);
    case "path":
      return parsePath(e, decision, denyReason, index);
    case "url":
      return parseUrl(e, decision, denyReason, index);
    case "tool":
      return parseTool(e, decision, denyReason, index);
  }
}

function parseShell(
  e: Record<string, unknown>,
  decision: string,
  denyReason: string | null,
  index: number,
): SectionResult {
  const commandRaw = e["command"];
  if (
    !Array.isArray(commandRaw) ||
    commandRaw.length === 0 ||
    commandRaw.some((t) => typeof t !== "string" || t === "")
  ) {
    return fail(
      index,
      'shell.command must be a non-empty array of strings (full argv, e.g. ["git", "status"])',
    );
  }
  const command = commandRaw as string[];

  const scopeRule: Record<string, unknown> = {
    command: command.map((token) => ({ token })),
  };

  // A present-but-wrong-typed optional string must fail, not silently drop the
  // constraint: `positionals = 123` was meant as a restriction, and dropping it
  // would widen the grant to accept any args.
  const positionals = strField(e, "positionals");
  if (positionals === null && e["positionals"] !== undefined) {
    return fail(index, "shell.positionals must be a string");
  }
  if (positionals !== null) scopeRule.positionals = { kind: positionals };

  const hasMin = e["positional_min"] !== undefined;
  const hasMax = e["positional_max"] !== undefined;
  if (hasMin || hasMax) {
    const count: Record<string, number> = {};
    if (hasMin) {
      if (
        typeof e["positional_min"] !== "number" ||
        !Number.isInteger(e["positional_min"])
      ) {
        return fail(
          index,
          "shell.positional_min must be a non-negative integer",
        );
      }
      count.min = e["positional_min"] as number;
    }
    if (hasMax) {
      if (
        typeof e["positional_max"] !== "number" ||
        !Number.isInteger(e["positional_max"])
      ) {
        return fail(
          index,
          "shell.positional_max must be a non-negative integer",
        );
      }
      count.max = e["positional_max"] as number;
    }
    scopeRule.positionalCount = count;
  }

  const pipeline = strField(e, "pipeline");
  if (pipeline === null && e["pipeline"] !== undefined) {
    return fail(index, "shell.pipeline must be a string");
  }
  if (pipeline !== null) scopeRule.pipeline = pipeline;

  const optionsRaw = e["options"];
  if (optionsRaw !== undefined) {
    if (!Array.isArray(optionsRaw)) {
      return fail(
        index,
        "shell.options must be an array of tables (one [[shell.options]] per command token)",
      );
    }
    if (optionsRaw.length !== command.length) {
      return fail(
        index,
        `shell.options has ${optionsRaw.length} entries but command has ${command.length} tokens; provide one per token`,
      );
    }
    for (let i = 0; i < optionsRaw.length; i++) {
      const o = optionsRaw[i];
      if (o === null || typeof o !== "object" || Array.isArray(o)) {
        return fail(index, `shell.options[${i}] must be a table`);
      }
      const ot = o as Record<string, unknown>;
      const rule: Record<string, unknown> = {};

      const allowRaw = ot["allow"];
      if (allowRaw !== undefined) {
        if (
          !Array.isArray(allowRaw) ||
          allowRaw.some((s) => typeof s !== "string")
        ) {
          return fail(
            index,
            `shell.options[${i}].allow must be an array of strings`,
          );
        }
        const specs: ShellOptionSpec[] = [];
        for (const s of allowRaw as string[]) {
          try {
            specs.push(...parseShellOptionSpecs(s));
          } catch (err) {
            return fail(
              index,
              `shell.options[${i}].allow entry "${s}": ${(err as Error).message}`,
            );
          }
        }
        if (specs.length > 0) rule.allow = specs;
      }

      const denyRaw = ot["deny"];
      if (denyRaw !== undefined) {
        if (
          !Array.isArray(denyRaw) ||
          denyRaw.some((s) => typeof s !== "string")
        ) {
          return fail(
            index,
            `shell.options[${i}].deny must be an array of strings`,
          );
        }
        if ((denyRaw as string[]).length > 0) rule.deny = denyRaw as string[];
      }

      if (rule.allow === undefined && rule.deny === undefined) {
        return fail(
          index,
          `shell.options[${i}] must set at least one of allow/deny`,
        );
      }
      (scopeRule.command as Array<Record<string, unknown>>)[i].options = rule;
    }
  }

  return validateInput(index, {
    tool: "shell",
    decision,
    denyReason: denyReason ?? undefined,
    scope: { kind: "shell", rule: scopeRule },
  });
}

function parsePath(
  e: Record<string, unknown>,
  decision: string,
  denyReason: string | null,
  index: number,
): SectionResult {
  const permission = strField(e, "permission");
  if (permission === null) {
    return fail(index, "path.permission is required (read, write, or edit)");
  }
  const root = strField(e, "root");
  if (root === null) {
    return fail(
      index,
      "path.root is required (workspace, session-workspace, or absolute)",
    );
  }
  const behavior = strField(e, "behavior");
  if (behavior === null) {
    return fail(
      index,
      "path.behavior is required (any, exact, prefix, or glob)",
    );
  }
  const rule: Record<string, unknown> = { kind: "path", root, behavior };
  if (behavior !== "any") {
    const value = strField(e, "value");
    if (value === null) {
      return fail(index, 'path.value is required unless behavior = "any"');
    }
    rule.value = value;
  }
  return validateInput(index, {
    tool: permission,
    decision,
    denyReason: denyReason ?? undefined,
    scope: { kind: "fs", perms: [permission], rule },
  });
}

function parseUrl(
  e: Record<string, unknown>,
  decision: string,
  denyReason: string | null,
  index: number,
): SectionResult {
  const ruleKind = strField(e, "rule");
  if (ruleKind === null) {
    return fail(index, "url.rule is required (exact, host, or host-suffix)");
  }
  // Fail on an unrecognized rule kind instead of guessing: a typo like
  // `rule = "hostt"` would otherwise be silently accepted as a broader
  // host-suffix grant than the file literally authorizes.
  if (
    ruleKind !== "exact" &&
    ruleKind !== "host" &&
    ruleKind !== "host-suffix"
  ) {
    return fail(
      index,
      `url.rule must be one of exact | host | host-suffix, got "${ruleKind}"`,
    );
  }
  const value = strField(e, "value");
  if (value === null) {
    return fail(index, "url.value is required");
  }
  const rule =
    ruleKind === "exact"
      ? { kind: "exact", url: value }
      : ruleKind === "host"
        ? { kind: "host", host: value }
        : { kind: "host-suffix", suffix: value };
  return validateInput(index, {
    tool: "url",
    decision,
    denyReason: denyReason ?? undefined,
    scope: { kind: "url", rule },
  });
}

function parseTool(
  e: Record<string, unknown>,
  decision: string,
  denyReason: string | null,
  index: number,
): SectionResult {
  const name = strField(e, "name");
  if (name === null) {
    return fail(
      index,
      'tool.name is required (the portal tool name, e.g. "git_commit")',
    );
  }
  return validateInput(index, {
    tool: "custom-tool",
    toolName: name,
    decision,
    denyReason: denyReason ?? undefined,
    scope: { kind: "any" },
  });
}

function validateInput(index: number, input: unknown): SectionResult {
  const parsed = GrantInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
    return fail(index, `${issue?.message ?? "invalid grant"}${where}`);
  }
  const v = parsed.data;
  return {
    ok: true,
    grant: {
      tool: persistedGrantTool(v),
      permissionKind: permissionKindForTool(v.tool),
      scope: v.scope,
      scopePattern: null,
      decision: v.decision,
      denyReason: v.denyReason,
    },
  };
}

function strField(e: Record<string, unknown>, key: string): string | null {
  const v = e[key];
  return typeof v === "string" ? v : null;
}

function fail(index: number, message: string): { ok: false; error: string } {
  return { ok: false, error: `entry ${index}: ${message}` };
}
