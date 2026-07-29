import { describe, it, expect } from 'vitest';
import {
	buildPortalSystemGuidance,
	PORTAL_SYSTEM_GUIDANCE
} from '../src/lib/server/runtime/system-guidance';

const ALL_TOOLS = [
	'git_status',
	'ticket_add',
	'permission_capabilities',
	'request_permission_grant',
	'worktree_create'
];

describe('buildPortalSystemGuidance', () => {
	it('always includes the base permission-gateway and structured-tool guidance', () => {
		const guidance = buildPortalSystemGuidance([]);
		expect(guidance).toContain('permission gateway');
		expect(guidance).toContain('Prefer structured tools');
	});

	it('omits the ticket workflow paragraph when ticket tools are absent', () => {
		const guidance = buildPortalSystemGuidance(['git_status', 'permission_capabilities']);
		expect(guidance).not.toContain('ticket_add');
		expect(guidance).not.toContain('ticket_list');
	});

	it('includes the ticket workflow paragraph when ticket tools are present', () => {
		const guidance = buildPortalSystemGuidance(['ticket_add']);
		expect(guidance).toContain('ticket_add/ticket_list/ticket_update');
		// Softened framing: ticketing is a convenience for durable work, not a
		// blanket mandate applied to every task.
		expect(guidance).toContain('not a blanket requirement');
	});

	it('omits git-tool guidance when git tools are absent', () => {
		const guidance = buildPortalSystemGuidance(['ticket_add']);
		expect(guidance).not.toContain('git_status/git_diff');
	});

	it('omits permission-tool guidance when permission tools are absent', () => {
		const guidance = buildPortalSystemGuidance(['git_status']);
		expect(guidance).not.toContain('permission_capabilities');
		expect(guidance).not.toContain('request_permission_grant');
	});

	it('produces only the base block when no optional tool groups are present', () => {
		const guidance = buildPortalSystemGuidance([]);
		expect(guidance).not.toContain('ticket_add');
		expect(guidance).not.toContain('git_status');
		expect(guidance).not.toContain('permission_capabilities');
	});

	it('PORTAL_SYSTEM_GUIDANCE is the full guidance with every optional section', () => {
		expect(PORTAL_SYSTEM_GUIDANCE).toBe(buildPortalSystemGuidance(ALL_TOOLS));
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('ticket_add');
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('git_status');
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('permission_capabilities');
	});
});
