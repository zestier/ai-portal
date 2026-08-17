// Pure scope-key derivation. Shared between the server (matcher) and the
// client (dialog UI), so it lives outside $lib/server.

import {
  derivePermissionScopeKey,
  type PermissionScopeKeyRequest,
} from "./metadata";

/**
 * Derive a scope key from the SDK's permission-request payload. Returns
 * null if no meaningful scope can be extracted; the matcher will then
 * only fire for wildcard-pattern grants, and the dialog will gray out
 * the "Just this exact …" scope option.
 */
export function deriveScopeKey(
  permissionKind: string,
  req: PermissionScopeKeyRequest,
): string | null {
  return derivePermissionScopeKey(permissionKind, req);
}
