import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../src/lib/server/runtime/with-timeout';

describe('withTimeout', () => {
	it('resolves when the promise settles before the deadline', async () => {
		await expect(withTimeout(Promise.resolve(42), 1000, 'fast')).resolves.toBe(42);
	});

	it('rejects with TimeoutError when the promise hangs past the deadline', async () => {
		const hang = new Promise<never>(() => {});
		await expect(withTimeout(hang, 10, 'hung call')).rejects.toBeInstanceOf(TimeoutError);
		await expect(withTimeout(hang, 10, 'hung call')).rejects.toThrow(
			/hung call timed out after 10ms/
		);
	});

	it('propagates the original rejection', async () => {
		const err = new Error('boom');
		await expect(withTimeout(Promise.reject(err), 1000, 'x')).rejects.toBe(err);
	});

	it('disables the guard when timeoutMs is 0', async () => {
		await expect(withTimeout(Promise.resolve('ok'), 0, 'x')).resolves.toBe('ok');
	});
});
