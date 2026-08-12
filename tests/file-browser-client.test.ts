import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchHeadStatus } from '../src/lib/client/file-browser';

describe('fetchHeadStatus', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns the parsed git status payload', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					status: {
						initialized: true,
						branch: 'main',
						sha: 'abc',
						shortSha: 'abc',
						detached: false,
						upstream: 'origin/main',
						ahead: 0,
						behind: 0,
						dirtyCount: 3
					}
				})
			})
		);

		await expect(fetchHeadStatus(123)).resolves.toMatchObject({
			initialized: true,
			dirtyCount: 3
		});
		expect(fetch).toHaveBeenCalledWith('/api/conversations/123/git/status');
	});

	it('throws the response body for non-ok responses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => 'boom'
			})
		);

		await expect(fetchHeadStatus(123)).rejects.toThrow('boom');
	});
});
