import { conversationId } from "$lib/ids";
import {
  normalizeApprovalMode,
  normalizeSessionMode,
  normalizeThemeAccent,
  type UserSettings,
  type PermissionPolicy,
} from "$lib/types";
import { decodeScope } from "$lib/permissions/scope-codec";
import type { GrantDecision, GrantRow } from "../../../permissions/matcher";

export interface SettingsRow {
  user_id: number;
  default_model: string | null;
  default_workdir: string | null;
  default_mode: string | null;
  default_approval_mode: string | null;
  default_policy: string;
  theme: string;
  accent: string;
  default_prompt_template_id: string | null;
  updated_at: number;
}

export function rowToSettings(r: SettingsRow): UserSettings {
  const raw = r.default_policy;
  // Migration 008 rewrites 'allow-readonly' → 'prompt', but be defensive
  // against any straggler rows (e.g., a connection that opened before the
  // migration ran in dev HMR).
  const policy: PermissionPolicy =
    raw === "allow-all" || raw === "deny-all" ? raw : "prompt";
  return {
    defaultModel: r.default_model,
    defaultWorkdir: r.default_workdir,
    defaultConversationMode: normalizeSessionMode(r.default_mode),
    defaultApprovalMode: normalizeApprovalMode(r.default_approval_mode),
    defaultPolicy: policy,
    theme:
      r.theme === "light" ? "light" : r.theme === "system" ? "system" : "dark",
    accent: normalizeThemeAccent(r.accent),
    defaultPromptTemplateId: r.default_prompt_template_id,
  };
}

export type GrantSource =
  "seed" | "prompt" | "settings" | "legacy" | "workspace-file";

export interface GrantDbRow {
  user_id: number;
  conversation_id: number | null;
  tool: string;
  permission_kind: string | null;
  scope_pattern: string | null;
  scope_json: string | null;
  decision: string;
  expires_at: number | null;
  granted_at: number;
  deny_reason: string | null;
  args_hash: string | null;
  source: string | null;
  workspace_root: string | null;
}

export function dbRowToGrant(r: GrantDbRow): GrantRow {
  const scope = decodeScope(r.scope_json);
  return {
    tool: r.tool,
    permissionKind: r.permission_kind,
    // A non-null structured scope that fails to decode must fail closed;
    // only true legacy rows with scope_json=NULL may fall back to scope_pattern.
    scopePattern:
      r.scope_json === null ? r.scope_pattern : scope ? r.scope_pattern : "\0",
    scope,
    decision: normalizeGrantDecision(r.decision),
    expiresAt: r.expires_at,
    denyReason: r.deny_reason,
    conversationId: r.conversation_id,
    argsHash: r.args_hash,
  };
}

export function normalizeGrantDecision(decision: string): GrantDecision {
  if (
    decision === "allow" ||
    decision === "force-allow" ||
    decision === "deny" ||
    decision === "prompt"
  ) {
    return decision;
  }
  return "deny";
}

export function normalizeGrantSource(source: string | null): GrantSource {
  if (
    source === "seed" ||
    source === "prompt" ||
    source === "settings" ||
    source === "legacy" ||
    source === "workspace-file"
  ) {
    return source;
  }
  return "legacy";
}

export function normalizeGrantDenyReason(
  decision: GrantDecision,
  denyReason: string | null | undefined,
): string | null {
  if (decision !== "deny" && decision !== "prompt") return null;
  const trimmed = denyReason?.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

export function convInt(id: string | number | null): number | null {
  return id === null
    ? null
    : typeof id === "number"
      ? id
      : conversationId.parse(id);
}
