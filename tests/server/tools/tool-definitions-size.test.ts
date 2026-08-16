import { describe, it, expect, beforeAll } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
	assemblePiTools,
	type AssemblePiToolsOptions
} from '../../../src/lib/server/tools/assemble';
import { setupLocalEnv } from '../../helpers/env';

// Regression guard for per-turn token cost (T31): every portal tool's
// `description` + per-parameter descriptions are re-serialized and sent to the
// provider on EVERY turn of EVERY conversation, so prose in tool definitions is
// a constant term in the input-token budget. This test measures the serialized
// size of the default-active assembled tool set (all groups enabled, memory off
// — the portal default) and fails if it ever creeps back above the budget.
//
// Baseline (before T31 trims): 40,978 bytes across 38 tools.
// After T31 trims:            23,497 bytes (-42.7%).
//
// The budget is set below the 40%-reduction line (40,978 × 0.6 = 24,586) with a
// little headroom, so the test keeps the ≥40% cut locked in while tolerating
// small, deliberate prose tweaks. The before/after delta and the sizing
// rationale for the tool_schema / skills-lazy-activation follow-ups are
// recorded in ticket T31.

// Budget (bytes) for the serialized tool definitions of the default-active set.
// 24_000 → 24_400 to admit the new `interaction`/`ask_user` tool (T58), which is
// inherently additive to the per-turn cost (the pre-T58 default set already sat
// within ~69 bytes of 24_000, so a new tool can't be trimmed into the old
// headroom). Bumped only far enough to cover the leanest ask_user definition.
const TOOL_DEFINITIONS_BYTES_BUDGET = 24_400;

// A representative options object matching a real conversation: no disabled
// groups, memory off (the default — buildMemoryTools returns [] for 'off').
function defaultOptions(cwd: string): AssemblePiToolsOptions {
	return {
		cwd,
		userId: 1,
		conversationId: 1,
		workspaceKey: 'tool-defs-size',
		policy: 'prompt',
		getMode: () => 'interactive',
		getApprovalMode: () => 'ask',
		emit: () => {}
	};
}

// The provider-facing tool JSON: name + description + parameters schema.
// `execute` is a function (not serialized); `label` mirrors `name`;
// `promptSnippet`/`promptGuidelines` live in the system prompt, not in the
// tool-definition JSON the provider re-reads each turn.
function toolDefinitionsBytes(tools: ToolDefinition[]): number {
	const encoder = new TextEncoder();
	let total = 0;
	for (const tool of tools) {
		total += encoder.encode(
			JSON.stringify({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters
			})
		).length;
	}
	return total;
}

describe('portal tool-definition size', () => {
	beforeAll(async () => {
		await setupLocalEnv('tool-defs-size-');
	});

	it('keeps the default-active tool set under the token-cost budget', () => {
		const { customTools } = assemblePiTools(defaultOptions('/'));
		const bytes = toolDefinitionsBytes(customTools);
		expect(customTools.length).toBeGreaterThan(20);
		expect(bytes).toBeLessThanOrEqual(TOOL_DEFINITIONS_BYTES_BUDGET);
	});
});
