import { randomBytes } from "node:crypto";

/**
 * One-shot forced-retry escalation tokens.
 *
 * When a permission request is denied, the interactive adapter mints a token
 * bound to the exact denied request (tool, permission kind, scope key, and
 * args hash) and embeds it in the deny feedback the agent sees. The agent can
 * then call the `force_retry_tool` portal tool with that token; the tool
 * raises a fresh, approve-once human dialog showing the originally captured
 * tool + args. If the human approves, the token is marked approved and the
 * matching retry of the tool — same tool, same scope (command/path/url),
 * incidental args may differ — is auto-allowed by `consumeForcedRetryMatch`,
 * bypassing every guard the first request tripped.
 *
 * Tokens are one-shot, conversation-scoped, and expire after `TTL_MS`. The
 * store is deliberately in-memory: a forced retry is a same-session, same-turn
 * concern, and persisting approvals here would conflate them with the durable
 * grant store.
 */

const TTL_MS = 15 * 60 * 1000;

export interface ForcedRetryEntry {
  token: string;
  conversationId: number;
  tool: string;
  permissionKind: string;
  scopeKey: string | null;
  argsHash: string | null;
  summary: string;
  args: unknown;
  deniedFeedback: string | null;
  reason: string | null;
  createdAt: number;
  status: "pending" | "approved";
}

const store = new Map<string, ForcedRetryEntry>();

function prune(): void {
  const now = Date.now();
  for (const [token, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(token);
  }
}

export function mintForcedRetry(input: {
  conversationId: number;
  tool: string;
  permissionKind: string;
  scopeKey: string | null;
  argsHash: string | null;
  summary: string;
  args: unknown;
  deniedFeedback?: string | null;
}): string {
  prune();
  const token = randomBytes(12).toString("hex");
  store.set(token, {
    token,
    conversationId: input.conversationId,
    tool: input.tool,
    permissionKind: input.permissionKind,
    scopeKey: input.scopeKey,
    argsHash: input.argsHash,
    summary: input.summary,
    args: input.args,
    deniedFeedback: input.deniedFeedback ?? null,
    reason: null,
    createdAt: Date.now(),
    status: "pending",
  });
  return token;
}

export function getForcedRetry(token: string): ForcedRetryEntry | null {
  prune();
  const entry = store.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(token);
    return null;
  }
  return entry;
}

export function approveForcedRetry(token: string, reason: string): boolean {
  const entry = store.get(token);
  if (!entry || entry.status !== "pending") return false;
  entry.status = "approved";
  entry.reason = reason;
  return true;
}

export function revokeForcedRetry(token: string): void {
  store.delete(token);
}

/**
 * Atomically consume a pending token for DIRECT execution. Returns the entry
 * only if it was still pending, deleting it in the same synchronous step, so
 * exactly one concurrent escalation of the same token can execute the call.
 * The caller runs `entry.args` through the resolved tool's handler and returns
 * the result directly — there is no re-issued request for
 * `consumeForcedRetryMatch` to match.
 */
export function takeForcedRetry(token: string): ForcedRetryEntry | null {
  const entry = store.get(token);
  if (!entry || entry.status !== "pending") return null;
  store.delete(token);
  return entry;
}

/**
 * Find and consume a one-shot approved token matching a permission request.
 * Matching is exact on conversation, tool, permission kind, and scope key. The
 * args hash is compared ONLY when there is no scope key (custom-tool requests,
 * where the args are the only identity); for scope-keyed kinds the scope key IS
 * the operation identity — shell command, fs path, or url — so a retry whose
 * incidental args drifted (e.g. a re-rendered Bash `description` or Edit
 * `content`) still matches what the human approved. A retry with a different
 * scope key is denied again (and gets a fresh token). Returns the matched entry
 * so callers can audit the approval.
 */
export function consumeForcedRetryMatch(input: {
  conversationId: number;
  tool: string;
  permissionKind: string;
  scopeKey: string | null;
  argsHash: string | null;
}): ForcedRetryEntry | null {
  prune();
  for (const [token, entry] of store) {
    if (entry.status !== "approved") continue;
    if (entry.conversationId !== input.conversationId) continue;
    if (entry.tool !== input.tool) continue;
    if (entry.permissionKind !== input.permissionKind) continue;
    if (entry.scopeKey !== input.scopeKey) continue;
    if (input.scopeKey === null && entry.argsHash !== input.argsHash) continue;
    store.delete(token);
    return entry;
  }
  return null;
}

/** Append the escalation hint (with the one-shot token) to a deny message. */
export function withForceRetryHint(feedback: string, token: string): string {
  return (
    `${feedback}\n\nTo force this call, call \`force_retry_tool\` with \`token: "${token}"\` ` +
    "and a concise reason (>= 20 characters)."
  );
}
