// Portal tools whose handlers raise their OWN interactive dialog (e.g. the
// grant approval prompt) rather than relying on the generic permission flow.
// The SDK still dispatches them as "external tools" and fires
// `external_tool.requested`, which would otherwise surface a redundant
// "Waiting for external tool ... to complete" info box alongside the tool's
// own dialog. Such tools are listed here so that generic waiting indicator can
// be suppressed for them.

export const GRANT_REQUEST_TOOL_NAME = 'request_permission_grant';

// Tool names that manage their own interactive UI; the generic external-tool
// "waiting" prompt should be skipped for these to avoid a duplicate box.
export const SELF_INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([GRANT_REQUEST_TOOL_NAME]);
