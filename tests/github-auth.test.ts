import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchProfile } from '../src/lib/server/auth/github';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('github fetchProfile', () => {
	it('normalizes login to lowercase while preserving display name casing', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				id: 7,
				login: 'OctoCat',
				name: 'The Octocat',
				avatar_url: 'https://example.test/a.png'
			})
		});
		vi.stubGlobal('fetch', fetchMock);

		const profile = await fetchProfile('token');
		expect(profile.login).toBe('octocat');
		expect(profile.name).toBe('The Octocat');
		expect(profile.id).toBe(7);
		expect(profile.avatar_url).toBe('https://example.test/a.png');
	});
});
