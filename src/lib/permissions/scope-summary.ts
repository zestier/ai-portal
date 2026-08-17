import {
  FS_DEFERRED_POSITIONALS_KINDS,
  type FsDeferredPositionalsKind,
  type GrantScope,
  type PositionalCountRule,
} from "./scope-types";

export type CapabilityScopeRuleKind =
  "tool" | "filesystem" | "shell" | "url" | "legacy" | "exact-invocation";

export function describeGrantScope(g: {
  scope: GrantScope | null;
  scopePattern: string | null;
}): string {
  const s = g.scope;
  if (s) {
    switch (s.kind) {
      case "any":
        return "*";
      case "shell":
        return describeShellRule(s.rule);
      case "url":
        return describeUrlRule(s.rule);
      case "fs": {
        const perms =
          s.perms && s.perms.length > 0 ? `[${s.perms.join("|")}] ` : "";
        return `${perms}${describeFsPathRule(s.rule)}`;
      }
    }
  }
  return g.scopePattern ?? "*";
}

export function capabilityRuleKindForScope(
  scope: GrantScope | null,
  argsHash?: string | null,
): CapabilityScopeRuleKind {
  if (argsHash) return "exact-invocation";
  if (!scope) return "legacy";
  switch (scope.kind) {
    case "any":
      return "tool";
    case "fs":
      return "filesystem";
    case "shell":
      return "shell";
    case "url":
      return "url";
  }
}

export function capabilityScopeSummary(scope: GrantScope): string {
  switch (scope.kind) {
    case "any":
      return "any request to this tool";
    case "shell":
      return capabilityShellRuleSummary(scope.rule);
    case "fs":
      return capabilityFsScopeSummary(scope);
    case "url":
      return capabilityUrlRuleSummary(scope.rule);
  }
}

function describeFsPathRule(
  rule: Extract<GrantScope, { kind: "fs" }>["rule"],
): string {
  const root =
    rule.root === "workspace"
      ? "<workspace>"
      : rule.root === "session-workspace"
        ? "<session workspace>"
        : "";
  if (rule.behavior === "any") return root;
  const sep = root && rule.value ? "/" : "";
  if (rule.behavior === "prefix") return `${root}${sep}${rule.value}/**`;
  return `${root}${sep}${rule.value}`;
}

function describeShellRule(
  rule: Extract<GrantScope, { kind: "shell" }>["rule"],
): string {
  const command = rule.command.map((step) => step.token).join(" ");
  const parts = [`command=${command}`];
  if (rule.positionals) {
    parts.push(`positionals=${rule.positionals.kind}`);
  }
  if (rule.positionalCount) {
    parts.push(
      `positional-count=${describePositionalCount(rule.positionalCount)}`,
    );
  }
  if (rule.pipeline) {
    parts.push(`pipeline=${rule.pipeline}`);
  }
  return parts.join("; ");
}

function describeUrlRule(
  rule: Extract<GrantScope, { kind: "url" }>["rule"],
): string {
  switch (rule.kind) {
    case "exact":
      return rule.url;
    case "host":
      return `host=${rule.host}`;
    case "host-suffix":
      return `*.${rule.suffix}`;
  }
}

function capabilityShellRuleSummary(
  rule: Extract<GrantScope, { kind: "shell" }>["rule"],
): string {
  const command = rule.command.map((step) => step.token).join(" ");
  const parts = [`shell command \`${command}\``];
  if (rule.positionals)
    parts.push(`positionals: ${describePositionalsKind(rule.positionals)}`);
  if (rule.positionalCount)
    parts.push(
      `positional count: ${describePositionalCount(rule.positionalCount)}`,
    );
  if (rule.pipeline) parts.push(`pipeline: ${rule.pipeline}`);
  return parts.join("; ");
}

/**
 * The grant-deferring positional kinds are opaque on their own — an agent
 * reading `positionals: readable-paths` can't tell what it covers. Spell out
 * that they resolve against the user's fs grants.
 */
function describePositionalsKind(rule: { kind: string }): string {
  const perm =
    FS_DEFERRED_POSITIONALS_KINDS[rule.kind as FsDeferredPositionalsKind];
  if (!perm) return rule.kind;
  return `${rule.kind} (every positional must be a path your \`${perm}\` grants permit)`;
}

function describePositionalCount(rule: PositionalCountRule): string {
  const { min, max } = rule;
  if (min !== undefined && max !== undefined)
    return min === max ? `${min}` : `${min}-${max}`;
  if (min !== undefined) return `${min}+`;
  return `up to ${max}`;
}

function capabilityFsScopeSummary(
  scope: Extract<GrantScope, { kind: "fs" }>,
): string {
  const perms = scope.perms?.length ? scope.perms.join("/") : "read/write/edit";
  const rule = scope.rule;
  if (rule.behavior === "any") return `${perms} anywhere under ${rule.root}`;
  if (rule.root === "absolute")
    return `${perms} for a specific absolute ${rule.behavior} rule`;
  return `${perms} for a ${rule.behavior} rule under ${rule.root}`;
}

function capabilityUrlRuleSummary(
  rule: Extract<GrantScope, { kind: "url" }>["rule"],
): string {
  switch (rule.kind) {
    case "exact":
      return "a specific URL";
    case "host":
      return `URLs on host ${rule.host}`;
    case "host-suffix":
      return `URLs on hosts ending in ${rule.suffix}`;
  }
}
