import type { InteractiveKind, InteractiveRequestView, InteractiveResponse } from '$lib/types';

const interactiveKindDescriptors = {
	permission: () => ({ kind: 'permission', decision: 'deny' }),
	auto_mode_switch: () => ({ kind: 'auto_mode_switch', decision: 'no' }),
	user_input: () => ({ kind: 'user_input', answer: '', wasFreeform: true }),
	elicitation: () => ({ kind: 'elicitation', action: 'cancel' }),
	exit_plan_mode: () => ({ kind: 'exit_plan_mode', approved: false }),
	sampling: () => ({ kind: 'sampling', action: 'ack' }),
	mcp_oauth: () => ({ kind: 'mcp_oauth', action: 'ack' }),
	external_tool: () => ({ kind: 'external_tool', action: 'ack' }),
	folder_trust: () => ({ kind: 'folder_trust', trust: false })
} satisfies {
	[K in InteractiveKind]: () => Extract<InteractiveResponse, { kind: K }>;
};

export function defaultInteractiveResponse(kind: InteractiveKind): InteractiveResponse {
	return interactiveKindDescriptors[kind]();
}

/**
 * Interactive kinds that genuinely block on the user: the turn cannot
 * proceed until the user answers. These are the kinds that should surface
 * an "awaiting input" signal (e.g. the sidebar indicator). The remaining
 * "info" kinds (`sampling`, `mcp_oauth`, `external_tool`) are auto-resolved
 * by the SDK and never wait on the user, so they are deliberately excluded.
 *
 * Centralized here so a future new {@link InteractiveKind} cannot silently
 * fall out of sync between the registry, the layout load, and the UI/tests.
 */
export const BLOCKING_INTERACTIVE_KINDS = new Set<InteractiveKind>([
	'permission',
	'user_input',
	'auto_mode_switch',
	'exit_plan_mode',
	'elicitation',
	'folder_trust'
]);

/** True if `kind` blocks on the user (see {@link BLOCKING_INTERACTIVE_KINDS}). */
export function isBlockingKind(kind: InteractiveKind): boolean {
	return BLOCKING_INTERACTIVE_KINDS.has(kind);
}

export type InformationalInteractiveKind = 'sampling' | 'mcp_oauth' | 'external_tool';
export type InformationalInteractiveRequest = Extract<
	InteractiveRequestView,
	{ kind: InformationalInteractiveKind }
>;

interface InformationalRequestDescriptor<K extends InformationalInteractiveKind> {
	heading(request: Extract<InformationalInteractiveRequest, { kind: K }>): string;
	actionLabel: string;
	response(): Extract<InteractiveResponse, { kind: K }>;
}

const informationalRequestDescriptors = {
	sampling: {
		heading: (request) => {
			void request;
			return 'MCP sampling request';
		},
		actionLabel: 'Dismiss',
		response: () => ({ kind: 'sampling', action: 'ack' })
	},
	mcp_oauth: {
		heading: (request) => {
			void request;
			return 'MCP server authentication';
		},
		actionLabel: 'Dismiss',
		response: () => ({ kind: 'mcp_oauth', action: 'ack' })
	},
	external_tool: {
		heading: (request) => `External tool: ${request.toolName}`,
		actionLabel: 'Dismiss',
		response: () => ({ kind: 'external_tool', action: 'ack' })
	}
} satisfies {
	[K in InformationalInteractiveKind]: InformationalRequestDescriptor<K>;
};

export function isInformationalInteractiveRequest(
	request: InteractiveRequestView
): request is InformationalInteractiveRequest {
	return (
		request.kind === 'sampling' || request.kind === 'mcp_oauth' || request.kind === 'external_tool'
	);
}

export function informationalHeading(request: InformationalInteractiveRequest): string {
	switch (request.kind) {
		case 'sampling':
			return informationalRequestDescriptors.sampling.heading(request);
		case 'mcp_oauth':
			return informationalRequestDescriptors.mcp_oauth.heading(request);
		case 'external_tool':
			return informationalRequestDescriptors.external_tool.heading(request);
	}
}

export function informationalActionLabel(request: InformationalInteractiveRequest): string {
	return informationalRequestDescriptors[request.kind].actionLabel;
}

export function informationalResponse(
	request: InformationalInteractiveRequest
): Extract<InteractiveResponse, { kind: InformationalInteractiveKind }> {
	switch (request.kind) {
		case 'sampling':
			return informationalRequestDescriptors.sampling.response();
		case 'mcp_oauth':
			return informationalRequestDescriptors.mcp_oauth.response();
		case 'external_tool':
			return informationalRequestDescriptors.external_tool.response();
	}
}
