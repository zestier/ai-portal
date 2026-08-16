import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from '../../helpers/env';

type CapResult = {
	capabilities: Array<Record<string, unknown>>;
	escalation: Record<string, { supported: boolean; guidance: string }>;
	filters?: Record<string, string | null>;
};

function asCapResult(result: unknown): CapResult {
	return result as CapResult;
}

let userId: number;
const conversationId = 1;

beforeEach(async () => {
	await setupLocalEnv('portal-compact-caps-');
	const reUsers = await import('../../../src/lib/server/db/repos/users');
	userId = reUsers.ensureLocalUser().id;
});

function defaultOpts() {
	return {
		userId,
		conversationId,
		policy: 'prompt' as const,
		getMode: () => 'autopilot' as const,
		getApprovalMode: () => 'auto-approve' as const
	};
}

describe('permission_capabilities — compact by default, verbose on detail', () => {
	it('compact path (default) omits guidance, rule arrays, filters, verbose escalation per kind', async () => {
		const { buildCapabilitiesTool } =
			await import('../../../src/lib/server/tools/permissions/capabilities');
		const tool = buildCapabilitiesTool(defaultOpts());
		const res = await tool.handler({});
		if (!res.ok) throw new Error('expected ok');
		const out = asCapResult(res.result);
		expect(Array.isArray(out.capabilities)).toBe(true);
		for (const c of out.capabilities) {
			expect(c).toHaveProperty('permissionKind');
			expect(c).toHaveProperty('status');
			expect(['allowed', 'denied', 'prompt_required', 'partially_allowed']).toContain(c.status);
			expect('guidance' in c).toBe(false);
			expect('allowed' in c).toBe(false);
			expect('denied' in c).toBe(false);
			expect('promptRequired' in c).toBe(false);
		}
		// No filters block, no header echo.
		expect(out).not.toHaveProperty('filters');
		expect(out).not.toHaveProperty('mode');
		expect(out).not.toHaveProperty('policy');
		expect(out).not.toHaveProperty('approvalMode');
		// Compact escalation copy is terse.
		const esc = JSON.stringify(out.escalation);
		expect(esc).toContain('force_retry_tool(token)');
		expect(esc).toContain('request_permission_grant');
		expect(esc).not.toContain('saves nothing');
	});

	it('detail:true restores the current verbose shape', async () => {
		const { buildCapabilitiesTool } =
			await import('../../../src/lib/server/tools/permissions/capabilities');
		const tool = buildCapabilitiesTool(defaultOpts());
		const res = await tool.handler({ detail: true });
		if (!res.ok) throw new Error('expected ok');
		const out = asCapResult(res.result);
		expect(out).toHaveProperty('mode');
		expect(out).toHaveProperty('policy');
		expect(out).toHaveProperty('approvalMode');
		expect(out.filters).toMatchObject({ permissionKind: null, toolName: null, intent: null });
		for (const c of out.capabilities) {
			expect(typeof c.guidance).toBe('string');
		}
		expect(JSON.stringify(out.escalation)).toContain('saves nothing');
	});

	it('imported permissionCapabilities with verbose:false returns {permissionKind,status} per kind + escalation line', async () => {
		const { permissionCapabilities } =
			await import('../../../src/lib/server/tools/permissions/capabilities');
		const out = asCapResult(
			permissionCapabilities({
				userId,
				conversationId,
				mode: 'autopilot',
				approvalMode: 'auto-approve',
				policy: 'prompt',
				verbose: false
			})
		);
		expect(out.capabilities.length).toBeGreaterThan(0);
		for (const c of out.capabilities) {
			expect(c).toHaveProperty('permissionKind');
			expect(c).toHaveProperty('status');
		}
		expect(out.escalation.forceRetry.supported).toBe(true);
		expect(out.escalation.requestPermissionGrant.supported).toBe(true);
	});
});
