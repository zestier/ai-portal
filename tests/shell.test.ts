import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShellTools } from '../src/lib/server/tools/shell';

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await mkdtemp(join(tmpdir(), 'portal-shell-test-'));
	try {
		await run(workspace);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

describe('shell_exec', () => {
	it('runs Bash in the workspace and returns structured output', async () => {
		await withWorkspace(async (workspace) => {
			const result = await buildShellTools(workspace)[0].handler({
				command: 'printf "hello"',
				timeoutMs: 5_000
			});
			expect(result).toMatchObject({
				ok: true,
				result: { stdout: 'hello', stderr: '', exitCode: 0, timedOut: false, aborted: false }
			});
		});
	});

	it('rejects a cwd that escapes the workspace', async () => {
		await withWorkspace(async (workspace) => {
			const result = await buildShellTools(workspace)[0].handler({ command: 'pwd', cwd: '..' });
			expect(result).toMatchObject({ ok: false, error: { code: 'invalid_cwd' } });
		});
	});

	it('caps combined output', async () => {
		await withWorkspace(async (workspace) => {
			const result = await buildShellTools(workspace)[0].handler({
				command: 'printf "%02000d" 0',
				maxOutputBytes: 1_024
			});
			expect(result).toMatchObject({ ok: true, result: { truncated: true } });
			if (result.ok) {
				const payload = result.result as { stdout: string };
				expect(Buffer.byteLength(payload.stdout)).toBeLessThanOrEqual(1_024);
			}
		});
	});

	it('terminates a command when the turn is aborted', async () => {
		await withWorkspace(async (workspace) => {
			const controller = new AbortController();
			const promise = buildShellTools(workspace)[0].handler(
				{ command: 'sleep 10', timeoutMs: 120_000 },
				{
					partial: () => {},
					progress: () => {},
					signal: controller.signal
				}
			);
			controller.abort();
			const result = await promise;
			expect(result).toMatchObject({ ok: true, result: { aborted: true } });
		});
	});
});
