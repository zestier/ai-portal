import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { err, ok, type PortalTool, type ToolStreamContext } from './types';

const ShellArgs = z
	.object({
		command: z.string().trim().min(1).max(20_000),
		cwd: z.string().trim().min(1).max(4_096).optional(),
		timeoutMs: z.number().int().min(100).max(120_000).optional().default(30_000),
		maxOutputBytes: z.number().int().min(1_024).max(1_000_000).optional().default(200_000)
	})
	.strict();

function resolveCwd(workspaceRoot: string, requested: string | undefined): string | null {
	const root = resolveWithParentFallback(resolve(workspaceRoot));
	if (root === null) return null;
	const cwd = resolveWithParentFallback(resolve(root, requested ?? '.'));
	if (cwd === null || !isPathInWorkspace(cwd, root)) return null;
	return cwd;
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process may have exited between output and cleanup.
		}
	}
}

function runShell(
	command: string,
	cwd: string,
	timeoutMs: number,
	maxOutputBytes: number,
	ctx?: ToolStreamContext
): Promise<ReturnType<typeof ok>> {
	return new Promise((resolveResult) => {
		const child = spawn('/bin/bash', ['-lc', command], {
			cwd,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let outputBytes = 0;
		let truncated = false;
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			ctx?.progress(`Command timed out after ${timeoutMs}ms.`);
			killProcessTree(child.pid!, 'SIGTERM');
			setTimeout(() => killProcessTree(child.pid!, 'SIGKILL'), 250).unref();
		}, timeoutMs);

		const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
			if (outputBytes >= maxOutputBytes) {
				truncated = true;
				return;
			}
			const remaining = maxOutputBytes - outputBytes;
			const text = chunk.subarray(0, remaining).toString('utf8');
			outputBytes += Buffer.byteLength(text);
			if (text.length < chunk.length) truncated = true;
			if (target === 'stdout') stdout += text;
			else stderr += text;
			ctx?.partial(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`);
		};

		const finish = (result: ReturnType<typeof ok>) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			ctx?.partial(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`);
			resolveResult(result);
		};

		child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
		child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
		child.on(
			'error',
			(error) => finish(err(error.message, { code: 'shell_spawn_failed' })) as never
		);
		child.on('close', (code, signal) => {
			const result = {
				command,
				cwd,
				stdout,
				stderr,
				exitCode: code,
				signal,
				timedOut,
				aborted,
				truncated
			};
			finish(
				ok(
					result,
					code === 0 && !timedOut && !aborted
						? 'Command completed.'
						: 'Command did not complete successfully.'
				)
			);
		});

		const onAbort = () => {
			aborted = true;
			ctx?.progress('Command cancelled.');
			killProcessTree(child.pid!, 'SIGTERM');
		};
		if (ctx) {
			if (ctx.signal.aborted) onAbort();
			else ctx.signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

export function buildShellTools(workspaceRoot: string): PortalTool[] {
	return [
		{
			name: 'shell_exec',
			description:
				'Run a non-interactive Bash command in the current workspace. The command may use pipelines and shell syntax. `cwd` is workspace-relative and cannot escape the workspace. Output is capped and long-running commands are terminated at the timeout.',
			argsSchema: ShellArgs,
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Bash command to run.' },
					cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
					timeoutMs: {
						type: 'number',
						description: 'Timeout in milliseconds, from 100 to 120000.'
					},
					maxOutputBytes: {
						type: 'number',
						description: 'Maximum combined stdout/stderr bytes, from 1024 to 1000000.'
					}
				},
				required: ['command'],
				additionalProperties: false
			},
			async handler(args, ctx) {
				const parsed = ShellArgs.parse(args);
				const cwd = resolveCwd(workspaceRoot, parsed.cwd);
				if (cwd === null)
					return err('cwd must resolve to a directory inside the workspace.', {
						code: 'invalid_cwd'
					});
				return runShell(parsed.command, cwd, parsed.timeoutMs, parsed.maxOutputBytes, ctx);
			}
		}
	];
}
