import { describe, it, expect } from 'vitest';
import {
	templatePermissionPreview,
	summarizeTemplatePermission
} from '../src/lib/permissions/prompt-template';

describe('templatePermissionPreview', () => {
	it('returns null for non-template tools', () => {
		expect(templatePermissionPreview('git_commit', { title: 'x' })).toBeNull();
		expect(templatePermissionPreview('ticket_add', { title: 'x' })).toBeNull();
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
