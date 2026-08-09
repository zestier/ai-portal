import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pollContextUsage } from '../src/lib/server/providers/claude-agent-context-usage';
import type { PortalEvent } from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';

type ContextUsageEvent = Extract<PortalEvent, { type: 'context.usage' }>;

async function pollUsage(raw: unknown): Promise<ContextUsageEvent | null> {
	const event = await pollContextUsage({
		getContextUsage: vi.fn(async () => raw)
	});
	return event as ContextUsageEvent | null;
}

beforeEach(async () => {
	await setupLocalEnv('portal-claude-agent-context-usage-');
});

function sdkResponse(overrides: Record<string, unknown> = {}) {
	return {
		categories: [
			{ name: 'System prompt', tokens: 8000, color: '#1f6feb' },
			{ name: 'Tools', tokens: 4000, color: '#8957e5' },
			{ name: 'Messages', tokens: 12000, color: '#238636' }
		],
		totalTokens: 24000,
		maxTokens: 200000,
		rawMaxTokens: 200000,
		percentage: 12,
		gridRows: [
			[
				{
					color: '#1f6feb',
					isFilled: true,
					categoryName: 'System prompt',
					tokens: 8000,
					percentage: 4,
					squareFullness: 1
				}
			]
		],
		model: 'deepseek-v4-pro',
		memoryFiles: [],
		...overrides
	};
}

describe('pollContextUsage', () => {
	it('normalizes the SDK response into a context.usage event', async () => {
		const event = await pollUsage(sdkResponse());

		expect(event).toMatchObject({
			type: 'context.usage',
			currentTokens: 24000,
			tokenLimit: 200000,
			messagesLength: 0,
			percentage: 12,
			systemTokens: 8000,
			toolDefinitionsTokens: 4000,
			conversationTokens: 12000,
			model: 'deepseek-v4-pro'
		});
		expect(event?.categories).toEqual([
			{ name: 'System prompt', tokens: 8000, color: '#1f6feb' },
			{ name: 'Tools', tokens: 4000, color: '#8957e5' },
			{ name: 'Messages', tokens: 12000, color: '#238636' }
		]);
		expect(event?.gridRows).toHaveLength(1);
		expect(event?.gridRows?.[0][0]).toMatchObject({ isFilled: true, squareFullness: 1 });
	});

	it('falls back to computing percentage when the SDK omits it', async () => {
		const event = await pollUsage(sdkResponse({ percentage: undefined }));
		expect(event?.percentage).toBeCloseTo(12);
	});

	it('returns null when the query exposes no getContextUsage', async () => {
		await expect(pollContextUsage({})).resolves.toBeNull();
	});

	it('returns null on a malformed response', async () => {
		await expect(pollUsage({ nope: true })).resolves.toBeNull();
	});

	it('returns null when getContextUsage rejects', async () => {
		await expect(
			pollContextUsage({
				getContextUsage: vi.fn(async () => {
					throw new Error('method renamed');
				})
			})
		).resolves.toBeNull();
	});
});
