import { describe, expect, it } from 'vitest';
import { buildRefinePromptSeed } from '../src/lib/prompt-templates';

describe('buildRefinePromptSeed', () => {
	it('names the template and embeds its id', () => {
		const seed = buildRefinePromptSeed({ id: 'tmpl-123', type: 'chat', title: 'Debug helper' });
		expect(seed).toContain('Debug helper');
		// The id must appear so the agent targets the right template.
		expect(seed).toContain('tmpl-123');
	});

	it('directs the agent to template_get then template_update', () => {
		const seed = buildRefinePromptSeed({ id: 'tmpl-1', type: 'chat', title: 'X' });
		expect(seed).toContain('template_get');
		expect(seed).toContain('template_update');
		// Read guidance should precede write guidance.
		expect(seed.indexOf('template_get')).toBeLessThan(seed.indexOf('template_update'));
	});

	it('labels chat templates and ticket actions distinctly', () => {
		const chat = buildRefinePromptSeed({ id: 'a', type: 'chat', title: 'A' });
		const action = buildRefinePromptSeed({ id: 'b', type: 'ticket-action', title: 'B' });
		expect(chat).toContain('chat template');
		expect(action).toContain('ticket action');
	});

	it('asks for proposal + agreement before applying changes', () => {
		const seed = buildRefinePromptSeed({ id: 'a', type: 'chat', title: 'A' });
		expect(seed.toLowerCase()).toContain('agree');
	});
});
