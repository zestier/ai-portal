import { describe, expect, it } from 'vitest';
import {
	extractPlaceholders,
	findUnknownPlaceholders,
	interpolatePrompt,
	placeholdersForType,
	ticketPlaceholderValues,
	unknownPlaceholderMessage,
	TICKET_ACTION_DEFAULTS
} from '../src/lib/prompt-templates';

describe('placeholder registry', () => {
	it('exposes no placeholders for chat templates', () => {
		expect(placeholdersForType('chat')).toEqual([]);
	});

	it('exposes ticket.* placeholders for ticket-action templates', () => {
		expect(placeholdersForType('ticket-action')).toEqual([
			'ticket.title',
			'ticket.id',
			'ticket.body',
			'ticket.plan'
		]);
	});

	it('extracts distinct placeholder names in first-seen order', () => {
		expect(extractPlaceholders('{{ticket.title}} {{ ticket.id }} {{ticket.title}}')).toEqual([
			'ticket.title',
			'ticket.id'
		]);
	});

	it('flags unknown placeholders per type', () => {
		expect(findUnknownPlaceholders('{{ticket.body}}', 'ticket-action')).toEqual([]);
		expect(findUnknownPlaceholders('{{ticket.plan}}', 'ticket-action')).toEqual([]);
		expect(findUnknownPlaceholders('{{ticket.body}}', 'chat')).toEqual(['ticket.body']);
		expect(findUnknownPlaceholders('{{ticket.nope}}', 'ticket-action')).toEqual(['ticket.nope']);
	});

	it('builds type-aware unknown-placeholder messages', () => {
		expect(unknownPlaceholderMessage('chat', ['ticket.title'])).toMatch(
			/chat templates don't support placeholders/i
		);
		const ticketMsg = unknownPlaceholderMessage('ticket-action', ['ticket.nope']);
		expect(ticketMsg).toMatch(/unknown placeholder/i);
		expect(ticketMsg).toContain('{{ticket.title}}');
	});
});

describe('interpolatePrompt', () => {
	const values = ticketPlaceholderValues({
		id: 1,
		title: 'Fix it',
		body: 'Some details.',
		plan: 'Step 1. Step 2.'
	});

	it('substitutes known placeholders', () => {
		expect(
			interpolatePrompt(
				'Do this: {{ticket.title}} ({{ticket.id}})\n\n{{ticket.body}}\n\n{{ticket.plan}}',
				values
			)
		).toBe('Do this: Fix it (1)\n\nSome details.\n\nStep 1. Step 2.');
	});

	it('drops unknown placeholders and trims dangling blanks for an empty body', () => {
		const empty = ticketPlaceholderValues({
			id: 1,
			title: 'Fix it',
			body: '   ',
			plan: ''
		});
		expect(
			interpolatePrompt(
				'Do this: {{ticket.title}}\n\nTicket ID: {{ticket.id}}\n\n{{ticket.body}}',
				empty
			)
		).toBe('Do this: Fix it\n\nTicket ID: 1');
	});

	it('renders an empty plan as (none) and trims a non-empty plan', () => {
		expect(
			ticketPlaceholderValues({ id: 1, title: 'x', body: 'b', plan: '   ' })['ticket.plan']
		).toBe('(none)');
		expect(
			ticketPlaceholderValues({ id: 1, title: 'x', body: 'b', plan: '  Step 1.  ' })['ticket.plan']
		).toBe('Step 1.');
	});

	it('includes the plan under a Plan heading when present', () => {
		expect(
			interpolatePrompt(
				'{{ticket.body}}\n\nPlan:\n{{ticket.plan}}',
				ticketPlaceholderValues({ id: 1, title: 'x', body: 'Body.', plan: 'Step 1. Step 2.' })
			)
		).toBe('Body.\n\nPlan:\nStep 1. Step 2.');
	});

	it('shows Plan:\\n(none) for an empty plan', () => {
		expect(
			interpolatePrompt(
				'{{ticket.body}}\n\nPlan:\n{{ticket.plan}}',
				ticketPlaceholderValues({ id: 1, title: 'x', body: 'Body.', plan: '' })
			)
		).toBe('Body.\n\nPlan:\n(none)');
	});

	it('collapses runs of blank lines created by empty substitutions', () => {
		expect(interpolatePrompt('a\n\n{{ticket.body}}\n\nb', { 'ticket.body': '' })).toBe('a\n\nb');
	});
});

describe('ticket action defaults', () => {
	it('seeds Do, Draft, and Refine', () => {
		expect(TICKET_ACTION_DEFAULTS.map((d) => d.key)).toEqual(['do', 'draft', 'refine']);
	});

	it('forces interactive mode only for refine', () => {
		const byKey = Object.fromEntries(TICKET_ACTION_DEFAULTS.map((d) => [d.key, d]));
		expect(byKey.do.conversationMode).toBeNull();
		expect(byKey.draft.launchBehavior).toBe('draft');
		expect(byKey.refine.conversationMode).toBe('interactive');
	});

	it('uses only allowed placeholders in default prompts', () => {
		for (const def of TICKET_ACTION_DEFAULTS) {
			expect(findUnknownPlaceholders(def.prompt, 'ticket-action')).toEqual([]);
		}
	});
});
