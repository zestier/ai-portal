// Portal tools whose handlers raise their OWN interactive dialog (e.g. the
// grant approval prompt) rather than relying on the generic permission flow.
// The SDK still dispatches them as "external tools" and fires
// `external_tool.requested`, which would otherwise surface a redundant
// "Waiting for external tool ... to complete" info box alongside the tool's
// own dialog. Such tools are listed here so that generic waiting indicator can
// be suppressed for them.

export const GRANT_REQUEST_TOOL_NAME = 'request_permission_grant';

// Raises its own human dialog for a previously denied tool call (see
// runtime/forced-retry.ts); like `request_permission_grant` it must not show
// the generic external-tool waiting box on top of its own prompt.
export const FORCE_RETRY_TOOL_NAME = 'force_retry_tool';

// Raises its own `user_input` dialog for a question the agent asks the human
// mid-turn (see ask-user.ts); it must not show the generic external-tool
// waiting box on top of its own prompt.
export const ASK_USER_TOOL_NAME = 'ask_user';

// Tool names that manage their own interactive UI; the generic external-tool
// "waiting" prompt should be skipped for these to avoid a duplicate box.
export const SELF_INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
	GRANT_REQUEST_TOOL_NAME,
	FORCE_RETRY_TOOL_NAME,
	ASK_USER_TOOL_NAME
]);
