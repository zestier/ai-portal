import { describe, it, expect } from 'vitest';
import { gitCommitPreview, summarizeGitCommitPermission } from '../src/lib/permissions/git-commit';

describe('gitCommitPreview', () => {
	it('treats the primitive string "all" as the all-changes sentinel', () => {
		const preview = gitCommitPreview({ subject: 'wip', paths: 'all' });
		expect(preview).not.toBeNull();
		expect(preview?.paths).toBeNull();
		expect(preview?.targetSummary).toBe(
			'All tracked, staged, unstaged, deleted, and untracked workspace changes'
		);
	});

	it('treats ["all"] as an explicit single-path list, not the sentinel', () => {
		const preview = gitCommitPreview({ subject: 'wip', paths: ['all'] });
		expect(preview?.paths).toEqual(['all']);
		expect(preview?.targetSummary).toBe('1 selected path');
	});

	it('does not treat coercible objects as the all-changes sentinel', () => {
		const preview = gitCommitPreview({
			subject: 'wip',
			paths: { toString: () => 'all' }
		});
		expect(preview?.paths).toBeNull();
		expect(preview?.targetSummary).toBe('Selected paths');
	});

	it('summarizes a non-"all" path list by count', () => {
		const preview = gitCommitPreview({
			subject: 'wip',
			paths: ['src/a.ts', 'src/b.ts']
		});
		expect(preview?.paths).toEqual(['src/a.ts', 'src/b.ts']);
		expect(preview?.targetSummary).toBe('2 selected paths');
	});

	it('returns null for non-object payloads', () => {
		expect(gitCommitPreview('all')).toBeNull();
		expect(gitCommitPreview(['all'])).toBeNull();
	});
});

describe('summarizeGitCommitPermission', () => {
	it('uses targetSummary for the all-changes sentinel', () => {
		const summary = summarizeGitCommitPermission({ subject: 'wip', paths: 'all' });
		expect(summary).toContain(
			'Target: All tracked, staged, unstaged, deleted, and untracked workspace changes'
		);
	});

	it('lists explicit paths, including ["all"]', () => {
		const summary = summarizeGitCommitPermission({ subject: 'wip', paths: ['all'] });
		expect(summary).toContain('Target: 1 selected path');
		expect(summary).toContain('- all');
	});

	it('lists a multi-path selection', () => {
		const summary = summarizeGitCommitPermission({
			subject: 'wip',
			paths: ['src/a.ts', 'src/b.ts']
		});
		expect(summary).toContain('Target: 2 selected paths');
		expect(summary).toContain('- src/a.ts');
		expect(summary).toContain('- src/b.ts');
	});
});
