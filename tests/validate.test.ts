import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseBody } from '../src/lib/server/validate';

function req(body: string | null, contentType = 'application/json'): Request {
	return new Request('http://x/', {
		method: 'POST',
		...(body !== null ? { headers: { 'content-type': contentType }, body } : {})
	});
}

const Schema = z.object({
	title: z.string().min(1).max(10),
	count: z.number().int().optional()
});

describe('parseBody', () => {
	it('returns parsed data on a valid body', async () => {
		const data = await parseBody(req(JSON.stringify({ title: 'ok', count: 3 })), Schema);
		expect(data).toEqual({ title: 'ok', count: 3 });
	});

	it('throws 400 with a path-prefixed message on schema failure', async () => {
		await expect(parseBody(req(JSON.stringify({ title: '' })), Schema)).rejects.toMatchObject({
			status: 400,
			body: { message: expect.stringMatching(/^title:/) }
		});
	});

	it('throws 400 on bad JSON instead of letting it become a 500', async () => {
		await expect(parseBody(req('not-json'), Schema)).rejects.toMatchObject({ status: 400 });
	});

	it('normalizes missing body to {} so defaults can apply', async () => {
		const WithDefault = z.object({ title: z.string().default('hi') });
		const data = await parseBody(req(null), WithDefault);
		expect(data).toEqual({ title: 'hi' });
	});

	it('allowEmpty: empty body parses as {}', async () => {
		const Optional = z.object({ content: z.string().optional() });
		const data = await parseBody(req(''), Optional, { allowEmpty: true });
		expect(data).toEqual({});
	});

	it('allowEmpty: non-empty invalid JSON still 400s', async () => {
		const Optional = z.object({ content: z.string().optional() });
		await expect(parseBody(req('{not json'), Optional, { allowEmpty: true })).rejects.toMatchObject(
			{
				status: 400
			}
		);
	});
});
