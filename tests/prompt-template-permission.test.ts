import { describe, it, expect } from 'vitest';
import {
	templatePermissionPreview,
	templateBeforeSnapshot,
	summarizeTemplatePermission
} from '../src/lib/permissions/prompt-template';

describe('templatePermissionPreview', () => {
	it('returns null for non-template tools', () => {
		expect(templatePermissionPreview('git_commit', { title: 'x' })).toBeNull();
		expect(templatePermissionPreview('ticket_add', { title: 'x' })).toBeNull();
	});

	it('surfaces an approval-mode change so it cannot ride along invisibly', () => {
		// `approvalMode` is the one template field that can switch off (or
		// blanket-reject) the permission dialogs of every conversation the
		// template launches, so an otherwise-innocuous edit must not hide it.
		const preview = templatePermissionPreview(
			'template_update',
			{ id: 'tmpl-1', description: 'Tweaked copy', approvalMode: 'auto-approve' },
			templateBeforeSnapshot({
				title: 'Weekly review',
				type: 'chat',
				description: 'Old copy',
				approvalMode: 'ask',
				prompt: 'body'
			})
		);
		expect(preview?.approvalMode).toBe('auto-approve');
		expect(preview?.fields).toContainEqual({ label: 'Approvals', value: 'auto-approve' });
		// The merged before→after view reports it as a real change, and does so
		// for a `chat` template too — the field is persisted for both types.
		expect(preview?.merged?.fields).toContainEqual({
			label: 'Approvals',
			before: 'ask',
			after: 'auto-approve',
			changed: true
		});
		expect(
			summarizeTemplatePermission('template_update', {
				id: 'tmpl-1',
				approvalMode: 'auto-approve'
			})
		).toContain('Approvals: auto-approve');
	});

	it('returns null for non-record args', () => {
		expect(templatePermissionPreview('template_create', null)).toBeNull();
		expect(templatePermissionPreview('template_create', 'nope')).toBeNull();
		expect(templatePermissionPreview('template_create', ['a'])).toBeNull();
	});

	it('builds a create preview with default type and metadata fields', () => {
		const preview = templatePermissionPreview('template_create', {
			title: 'My template',
			prompt: 'line one\nline two\nline three',
			description: 'A handy preset',
			launchBehavior: 'draft',
			conversationMode: 'plan',
			model: 'claude',
			pinned: true,
			type: 'ticket-action'
		});
		expect(preview).not.toBeNull();
		expect(preview?.action).toBe('create');
		expect(preview?.id).toBeNull();
		expect(preview?.title).toBe('My template');
		expect(preview?.type).toBe('ticket-action');
		expect(preview?.prompt).toBe('line one\nline two\nline three');
		expect(preview?.promptLineCount).toBe(3);
		const labels = preview?.fields.map((f) => f.label);
		expect(labels).toEqual([
			'Type',
			'Description',
			'Launch behavior',
			'Conversation mode',
			'Model',
			'Pinned'
		]);
		expect(preview?.fields.find((f) => f.label === 'Pinned')?.value).toBe('yes');
	});

	it('defaults create type to chat when absent', () => {
		const preview = templatePermissionPreview('template_create', {
			title: 'T',
			prompt: 'p'
		});
		expect(preview?.type).toBe('chat');
		expect(preview?.fields.map((f) => f.label)).toEqual(['Type']);
	});

	it('omits empty / whitespace-only optional fields', () => {
		const preview = templatePermissionPreview('template_create', {
			title: 'T',
			prompt: 'p',
			description: '   ',
			model: ''
		});
		const labels = preview?.fields.map((f) => f.label);
		expect(labels).not.toContain('Description');
		expect(labels).not.toContain('Model');
	});

	it('treats whitespace-only prompt as absent', () => {
		const preview = templatePermissionPreview('template_create', {
			title: 'T',
			prompt: '   \n  '
		});
		expect(preview?.prompt).toBeNull();
		expect(preview?.promptLineCount).toBe(0);
	});

	it('builds an update PATCH preview showing only present fields', () => {
		const preview = templatePermissionPreview('template_update', {
			id: 'tpl_123',
			status: 'archived'
		});
		expect(preview?.action).toBe('update');
		expect(preview?.id).toBe('tpl_123');
		expect(preview?.title).toBeNull();
		expect(preview?.type).toBeNull();
		expect(preview?.prompt).toBeNull();
		expect(preview?.fields.map((f) => f.label)).toEqual(['Status']);
	});

	it('does not surface an id for create previews', () => {
		const preview = templatePermissionPreview('template_create', {
			id: 'should-be-ignored',
			title: 'T',
			prompt: 'p'
		});
		expect(preview?.id).toBeNull();
	});

	it('renders pinned:false as "no"', () => {
		const preview = templatePermissionPreview('template_update', {
			id: 'x',
			pinned: false
		});
		expect(preview?.pinned).toBe(false);
		expect(preview?.fields.find((f) => f.label === 'Pinned')?.value).toBe('no');
	});

	it('has a null merged view for create and for update without a before snapshot', () => {
		expect(
			templatePermissionPreview('template_create', { title: 'T', prompt: 'p' })?.merged
		).toBeNull();
		expect(
			templatePermissionPreview('template_update', { id: 'x', title: 'New' })?.merged
		).toBeNull();
		// Explicit null before behaves like a missing snapshot (patch fallback).
		expect(
			templatePermissionPreview('template_update', { id: 'x', title: 'New' }, null)?.merged
		).toBeNull();
	});
});

const BEFORE = {
	title: 'Old title',
	type: 'ticket-action',
	description: 'Old description',
	launchBehavior: 'send',
	conversationMode: 'interactive',
	approvalMode: 'ask',
	model: 'old-model',
	pinned: false,
	status: 'open',
	prompt: 'old line one\nold line two'
};

describe('templatePermissionPreview merged before→after view', () => {
	it('marks changed fields and resolves unchanged ones to current values', () => {
		const preview = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', title: 'New title', status: 'archived' },
			BEFORE
		);
		const merged = preview?.merged;
		expect(merged).not.toBeNull();

		expect(merged?.title).toEqual({
			label: 'Title',
			before: 'Old title',
			after: 'New title',
			changed: true
		});

		const status = merged?.fields.find((f) => f.label === 'Status');
		expect(status).toEqual({ label: 'Status', before: 'open', after: 'archived', changed: true });

		// Untouched fields resolve to the current value and are not changed.
		const desc = merged?.fields.find((f) => f.label === 'Description');
		expect(desc).toEqual({
			label: 'Description',
			before: 'Old description',
			after: 'Old description',
			changed: false
		});
		const model = merged?.fields.find((f) => f.label === 'Model');
		expect(model?.changed).toBe(false);
		expect(model?.after).toBe('old-model');
	});

	it('surfaces the (non-editable) type as a resolved, unchanged row', () => {
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', type: 'chat' },
			BEFORE
		)?.merged;
		const type = merged?.fields.find((f) => f.label === 'Type');
		expect(type).toEqual({
			label: 'Type',
			before: 'ticket-action',
			after: 'ticket-action',
			changed: false
		});
	});

	it('keeps the current value for fields the repo can never clear (null arg, no phantom clear)', () => {
		// title/description/status persist as `patch.x ?? current.x`, so a null arg
		// keeps the current value — the preview must not show them as cleared.
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', title: null, description: null, status: null },
			BEFORE
		)?.merged;
		expect(merged?.title).toEqual({
			label: 'Title',
			before: 'Old title',
			after: 'Old title',
			changed: false
		});
		const desc = merged?.fields.find((f) => f.label === 'Description');
		expect(desc?.after).toBe('Old description');
		expect(desc?.changed).toBe(false);
		const status = merged?.fields.find((f) => f.label === 'Status');
		expect(status?.after).toBe('open');
		expect(status?.changed).toBe(false);
	});

	it('keeps the current title when an empty/whitespace title is supplied (repo rejects empty)', () => {
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', title: '   ' },
			BEFORE
		)?.merged;
		expect(merged?.title).toEqual({
			label: 'Title',
			before: 'Old title',
			after: 'Old title',
			changed: false
		});
	});

	it('treats an explicit null arg as clearing the field', () => {
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', model: null },
			BEFORE
		)?.merged;
		const model = merged?.fields.find((f) => f.label === 'Model');
		expect(model).toEqual({ label: 'Model', before: 'old-model', after: null, changed: true });
	});

	it('ignores ticket-action-only fields for a chat template (matches repo type-gating)', () => {
		const chatBefore = {
			...BEFORE,
			type: 'chat',
			launchBehavior: null,
			conversationMode: null,
			model: null
		};
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', model: 'gpt-5', launchBehavior: 'draft', conversationMode: 'plan' },
			chatBefore
		)?.merged;
		const labels = merged?.fields.map((f) => f.label);
		// The update repo forces these to null on chat templates, so the preview
		// must not claim they change (they resolve to unset and are omitted).
		expect(labels).not.toContain('Model');
		expect(labels).not.toContain('Launch behavior');
		expect(labels).not.toContain('Conversation mode');
	});

	it('detects a pinned toggle and renders yes/no', () => {
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', pinned: true },
			BEFORE
		)?.merged;
		const pinned = merged?.fields.find((f) => f.label === 'Pinned');
		expect(pinned).toEqual({ label: 'Pinned', before: 'no', after: 'yes', changed: true });
	});

	it('builds a changed prompt diff with both line counts', () => {
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', prompt: 'brand new prompt' },
			BEFORE
		)?.merged;
		expect(merged?.prompt).toEqual({
			before: 'old line one\nold line two',
			after: 'brand new prompt',
			beforeLineCount: 2,
			afterLineCount: 1,
			changed: true
		});
	});

	it('keeps the current prompt (unchanged) when prompt is absent', () => {
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', title: 'x' },
			BEFORE
		)?.merged;
		expect(merged?.prompt.changed).toBe(false);
		expect(merged?.prompt.after).toBe('old line one\nold line two');
	});

	it('omits fields that are unset both before and after', () => {
		const before = { ...BEFORE, model: null, description: null };
		const merged = templatePermissionPreview(
			'template_update',
			{ id: 'tpl_1', title: 'x' },
			before
		)?.merged;
		const labels = merged?.fields.map((f) => f.label);
		expect(labels).not.toContain('Model');
		expect(labels).not.toContain('Description');
	});
});

describe('summarizeTemplatePermission', () => {
	it('returns null for non-template tools / non-records', () => {
		expect(summarizeTemplatePermission('git_commit', { title: 'x' })).toBeNull();
		expect(summarizeTemplatePermission('template_create', null)).toBeNull();
	});

	it('summarizes a create with title, type and prompt line count', () => {
		const summary = summarizeTemplatePermission('template_create', {
			title: 'My template',
			type: 'chat',
			prompt: 'a\nb'
		});
		expect(summary).toContain('Create prompt template');
		expect(summary).toContain('Title: My template');
		expect(summary).toContain('Type: chat');
		expect(summary).toContain('Prompt: 2 lines');
		expect(summary).toContain('Approval: one-time only');
	});

	it('summarizes an update with the target id and present fields', () => {
		const summary = summarizeTemplatePermission('template_update', {
			id: 'tpl_9',
			status: 'open'
		});
		expect(summary).toContain('Update prompt template');
		expect(summary).toContain('Template: tpl_9');
		expect(summary).toContain('Status: open');
	});

	it('uses singular "line" for a one-line prompt', () => {
		const summary = summarizeTemplatePermission('template_create', {
			title: 'T',
			prompt: 'single'
		});
		expect(summary).toContain('Prompt: 1 line');
	});
});

describe('templateBeforeSnapshot', () => {
	it('normalizes a template record into a snapshot', () => {
		const snap = templateBeforeSnapshot({
			title: '  My template  ',
			type: 'ticket-action',
			description: '',
			launchBehavior: 'draft',
			conversationMode: null,
			model: '  ',
			pinned: true,
			status: 'open',
			prompt: 'hello'
		});
		expect(snap).toEqual({
			title: 'My template',
			type: 'ticket-action',
			description: null,
			launchBehavior: 'draft',
			conversationMode: null,
			approvalMode: null,
			model: null,
			pinned: true,
			status: 'open',
			prompt: 'hello'
		});
	});
});
