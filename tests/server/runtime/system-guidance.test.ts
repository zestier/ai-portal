import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	buildPortalGlobalGuidance,
	PORTAL_SYSTEM_GUIDANCE
} from '../../../src/lib/server/runtime/system-guidance';

describe('buildPortalGlobalGuidance', () => {
	it('is the same text as the exported PORTAL_SYSTEM_GUIDANCE constant', () => {
		expect(PORTAL_SYSTEM_GUIDANCE).toBe(buildPortalGlobalGuidance());
	});

	it('always includes the portal-gateway framing and structured-tool preference', () => {
		const guidance = buildPortalGlobalGuidance();
		expect(guidance).toContain('permission gateway');
		expect(guidance).toContain('Prefer structured tools');
	});

	it('includes the smart-caveman response-style directive', () => {
		const guidance = buildPortalGlobalGuidance();
		expect(guidance).toContain('Respond like smart caveman');
		expect(guidance).toContain('Cut all filler, keep technical substance');
		expect(guidance).toContain('[thing] [action] [reason]');
	});

	it('contains no tool-group prose — per-tool guidance lives on the tools themselves', () => {
		const guidance = buildPortalGlobalGuidance();
		// The old blob duplicated per-tool caveats here; it must not come back.
		expect(guidance).not.toContain('ticket_add');
		expect(guidance).not.toContain('worktree_create');
		expect(guidance).not.toContain('permission_capabilities');
		expect(guidance).not.toContain('git_status');
	});
});

// The loader-wiring test below must capture the options `createPiSession`
// passes to the SDK's `DefaultResourceLoader`. `vi.hoisted` is required because
// the `vi.mock` factory is hoisted above any top-level `let` declaration.
const loaderOptions = vi.hoisted(() => ({
	value: null as { appendSystemPrompt?: string[] } | null
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
	getAgentDir: () => '/tmp/agent-dir',
	DefaultResourceLoader: class {
		constructor(options: { appendSystemPrompt?: string[] }) {
			loaderOptions.value = options;
		}
		async reload() {
			// no-op: the real loader reads resources from disk.
		}
	},
	SessionManager: {
		inMemory: () => ({})
	},
	SettingsManager: {
		inMemory: () => ({})
	},
	createAgentSession: async () => ({ session: {} })
}));

describe('createPiSession loader wiring', () => {
	beforeEach(() => {
		loaderOptions.value = null;
	});

	it('passes the global guidance through the loader appendSystemPrompt channel', async () => {
		const { createPiSession } = await import('../../../src/lib/server/pi/session');
		await createPiSession({
			cwd: '/tmp/workspace',
			model: {} as never,
			runtime: {} as never,
			customTools: [],
			portalToolsByName: new Map(),
			permissionResolver: async () => ({ allow: true })
		});
		expect(loaderOptions.value?.appendSystemPrompt).toEqual([PORTAL_SYSTEM_GUIDANCE]);
		expect(loaderOptions.value?.appendSystemPrompt?.[0]).toContain('Respond like smart caveman');
	});
});
