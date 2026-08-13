import { describe, it, expect } from 'vitest';
import {
	buildPortalSystemGuidance,
	PORTAL_SYSTEM_GUIDANCE
} from '../src/lib/server/runtime/system-guidance';

const ALL_TOOLS = [
	'bash',
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

	it('omits worktree guidance when worktree tools are absent', () => {
		const guidance = buildPortalSystemGuidance(['git_status', 'ticket_add']);
		expect(guidance).not.toContain('worktree_create');
	});

	it('includes the parallel-sub-agent worktree guidance when the tools are present', () => {
		const guidance = buildPortalSystemGuidance(['worktree_create']);
		expect(guidance).toContain('worktree_create');
		// The two instructions the Phase 0 spike showed actually matter: hand over
		// an absolute path, and never share one checkout between sub-agents.
		expect(guidance).toContain('ABSOLUTE path');
		expect(guidance).toContain('Never point');
		expect(guidance).toContain('already exists and is writable');
		// Merging back is the step that makes the fan-out worth anything, and
		// squashing is what keeps collecting several from shredding the history.
		expect(guidance).toContain('squash');
		expect(guidance).toContain('"from-source"');
	});

	it('produces only the base block when no optional tool groups are present', () => {
		const guidance = buildPortalSystemGuidance([]);
		expect(guidance).not.toContain('ticket_add');
		expect(guidance).not.toContain('git_status');
		expect(guidance).not.toContain('permission_capabilities');
		expect(guidance).not.toContain('worktree_create');
	});

	it('PORTAL_SYSTEM_GUIDANCE is the full guidance with every optional section', () => {
		expect(PORTAL_SYSTEM_GUIDANCE).toBe(buildPortalSystemGuidance(ALL_TOOLS));
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('ticket_add');
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('git_status');
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('permission_capabilities');
		expect(PORTAL_SYSTEM_GUIDANCE).toContain('bash');
	});
});
