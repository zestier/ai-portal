import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { constants } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isolatedChildEnv } from '../child-env';
import { ulid } from '../db/ids';
import { isPathInWorkspace, resolveWithParentFallback } from '../permissions/workspace';
import { ensureZapGitignore, scratchSubdir } from './zap-dir';
import { err, ok, type PortalTool, type ToolResult, type ToolStreamContext } from './types';

// In-context output cap: the model sees up to this much verbatim; anything past
// it is spilled to `.zap/scratch/tool_results/` and the persisted path returned
// so the model can Read the full output. Mirrors the SDK's own persisted-output
// behavior instead of killing the process and discarding output.
const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_SHELL_OUTPUT_BYTES = 32 * 1024;
// Disk cap for the spill file. Past this the remainder is dropped — the
// in-context preview still gives the model a usable (bounded) view.
const MAX_PERSISTED_OUTPUT_BYTES = 5 * 1024 * 1024;
// Preview length in the persisted-output block. The SDK labels it "first 2KB"
// but uses decimal KB (2000 bytes).
const PERSISTED_PREVIEW_BYTES = 2_000;

// Mirrors the Agent SDK's BashInput (sdk-tools.d.ts) so the portal shell tool
// keeps the SDK's field names (`description`, `run_in_background`,
// `dangerouslyDisableSandbox`) verbatim. `cwd` and `maxOutputBytes` are portal
// extensions — harmless additions to the contract.
const ShellArgs = z
	.object({
		command: z.string().trim().min(1).max(20_000),
		timeout: z.number().int().min(100).max(600_000).optional().default(120_000),
		// Accepted for SDK compatibility and ignored: the description is a
		// no-op for a tool that renders its own output.
		description: z.string().max(4_000).optional(),
		// Not supported: the portal always runs commands in the foreground.
		run_in_background: z.boolean().optional(),
		// Not supported: the portal never disables the sandbox.
		dangerouslyDisableSandbox: z.boolean().optional(),
		cwd: z.string().trim().min(1).max(4_096).optional(),
		maxOutputBytes: z
			.number()
			.int()
			.min(1_024)
			.max(MAX_SHELL_OUTPUT_BYTES)
			.optional()
			.default(DEFAULT_SHELL_OUTPUT_BYTES)
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

// Signal name → number, for turning a signal-killed `close` (code null) into a
// conventional 128+signal exit code.
const SIGNAL_NUMBERS = Object.fromEntries(
	Object.entries(constants.signals).map(([name, num]) => [name, num as number])
);

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number | null {
	if (code !== null) return code;
	if (signal !== null) {
		const num = SIGNAL_NUMBERS[signal];
		if (typeof num === 'number') return 128 + num;
	}
	return null;
}

// The model-facing rendering of a Bash run. Non-zero exits render the output
// (if any) plus an `Exit code N` note; empty successful output renders the
// SDK's `(Bash completed with no output)`; oversized output renders the
// persisted block with a size label and a 2KB preview.
function renderBashText(opts: {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	timedOutAfterMs: number | undefined;
	aborted: boolean;
	interrupted: boolean;
	persisted: { path: string; size: number; preview: string } | null;
}): string {
	const combined = [opts.stdout.trimEnd(), opts.stderr.trimEnd()]
		.filter((part) => part.length > 0)
		.join('\n');
	// A process we killed (timeout/abort) or one killed by an interrupt
	// signal is not a genuine exit — its 128+signal code would be noise next
	// to the real note, so it is not rendered as an `Exit code`.
	const genuineExit = !opts.timedOut && !opts.aborted && !opts.interrupted;
	const note = opts.timedOut
		? `\n\nTimed out after ${opts.timedOutAfterMs}ms`
		: opts.aborted || opts.interrupted
			? '\n\nInterrupted'
			: '';
	let body: string;
	if (opts.persisted) {
		body = persistedOutputBlock(opts.persisted);
		if (genuineExit && opts.exitCode !== 0) body += `\n\nExit code ${opts.exitCode}`;
	} else if (genuineExit && opts.exitCode !== 0) {
		body = combined ? `${combined}\n\nExit code ${opts.exitCode}` : `Exit code ${opts.exitCode}`;
	} else {
		body = combined || (note ? '' : '(Bash completed with no output)');
	}
	return body + note;
}

// The `<persisted-output>` block the SDK renders when a Bash run overflows the
// inline budget: size label, saved path, and a preview of the first 2KB (cut to
// a complete line).
function persistedOutputBlock(p: { path: string; size: number; preview: string }): string {
	const size = `${(p.size / 1024).toFixed(1)}KB`;
	const lastNewline = p.preview.lastIndexOf('\n');
	const previewLines =
		p.preview.length === 0
			? ''
			: p.preview.endsWith('\n')
				? p.preview.slice(0, -1)
				: lastNewline > 0
					? p.preview.slice(0, lastNewline)
					: p.preview;
	return `<persisted-output>\nOutput too large (${size}). Full output saved to: ${p.path}\n\nPreview (first 2KB):\n${previewLines}\n...\n</persisted-output>`;
}

function runShell(
	workspaceRoot: string,
	command: string,
	cwd: string,
	timeoutMs: number,
	maxOutputBytes: number,
	ctx?: ToolStreamContext
): Promise<ToolResult> {
	return new Promise((resolveResult) => {
		const child = spawn('/bin/bash', ['-lc', command], {
			cwd,
			env: isolatedChildEnv(),
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
		// First PERSISTED_PREVIEW_BYTES of the full output, captured as it
		// arrives (before any cap applies) for the persisted preview.
		let previewPrefix = '';
		// Non-null once the in-context cap is hit: the spill file holds the FULL
		// output (the buffered prefix plus every subsequent chunk).
		let spill: {
			stream: ReturnType<typeof createWriteStream>;
			path: string;
			bytes: number;
		} | null = null;
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			ctx?.progress(`Command timed out after ${timeoutMs}ms.`);
			killProcessTree(child.pid!, 'SIGTERM');
			setTimeout(() => killProcessTree(child.pid!, 'SIGKILL'), 250).unref();
		}, timeoutMs);

		const combinedText = () => `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;

		const writeToSpill = (chunk: Buffer) => {
			if (!spill || spill.bytes >= MAX_PERSISTED_OUTPUT_BYTES) return;
			const allowed = MAX_PERSISTED_OUTPUT_BYTES - spill.bytes;
			const toWrite = chunk.subarray(0, allowed);
			spill.bytes += toWrite.length;
			spill.stream.write(toWrite);
		};

		const beginSpill = (overflow: Buffer) => {
			if (spill) return;
			// `.zap/.gitignore` covers the whole scratch tree, so the spill file
			// is already ignored; ensure the ignore exists for fresh workspaces.
			void ensureZapGitignore(workspaceRoot).catch(() => {});
			const dir = join(workspaceRoot, scratchSubdir('tool_results'));
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${ulid()}.txt`);
			const stream = createWriteStream(path);
			stream.on('error', () => {
				// Best-effort spill; a failed persist must not fail the command.
			});
			spill = { stream, path, bytes: 0 };
			writeToSpill(Buffer.from(stdout + stderr, 'utf8'));
			writeToSpill(overflow);
		};

		const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
			if (previewPrefix.length < PERSISTED_PREVIEW_BYTES) {
				const remaining = PERSISTED_PREVIEW_BYTES - previewPrefix.length;
				previewPrefix += chunk.subarray(0, remaining).toString('utf8');
			}
			if (spill) {
				writeToSpill(chunk);
				return;
			}
			const remaining = maxOutputBytes - outputBytes;
			if (remaining <= 0) {
				truncated = true;
				beginSpill(chunk);
				return;
			}
			const text = chunk.subarray(0, remaining).toString('utf8');
			const consumed = Buffer.byteLength(text);
			outputBytes += consumed;
			if (target === 'stdout') stdout += text;
			else stderr += text;
			if (consumed < chunk.length) {
				truncated = true;
				beginSpill(chunk.subarray(consumed));
			}
			ctx?.partial(combinedText());
		};

		const finish = async (result: ToolResult) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			ctx?.partial(combinedText());
			if (spill) {
				await new Promise<void>((resolveFlush) => spill!.stream.end(resolveFlush));
			}
			resolveResult(result);
		};

		child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
		child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
		child.on('error', (error) => void finish(err(error.message, { code: 'shell_spawn_failed' })));
		child.on('close', (code, signal) => {
			const exitCode = exitCodeFor(code, signal);
			const interrupted = aborted || (code === null && signal !== null && !timedOut);
			const payload = {
				command,
				cwd,
				stdout,
				stderr,
				exitCode,
				signal,
				interrupted,
				timedOutAfterMs: timedOut ? timeoutMs : undefined,
				truncated,
				...(spill && spill.bytes > 0
					? { persistedOutputPath: spill.path, persistedOutputSize: spill.bytes }
					: {}),
				...(exitCode === 127 ? { returnCodeInterpretation: 'Command not found' } : {}),
				...(exitCode === 126
					? { returnCodeInterpretation: 'Permission denied or command is not executable' }
					: {})
			};
			const rendered = renderBashText({
				stdout,
				stderr,
				exitCode,
				timedOut,
				timedOutAfterMs: timedOut ? timeoutMs : undefined,
				aborted,
				interrupted,
				persisted:
					spill && spill.bytes > 0
						? { path: spill.path, size: spill.bytes, preview: previewPrefix }
						: null
			});
			// A genuine non-zero exit (not caused by our own timeout/abort kill,
			// and not an interrupt signal) is an error result — the SDK renders
			// `Exit code N` with isError true. Timeouts/aborts/interrupts keep a
			// successful envelope with their flag fields set.
			const genuineFailure = !timedOut && !aborted && !interrupted && exitCode !== 0;
			const result: ToolResult = genuineFailure
				? err(rendered)
				: ok(
						payload,
						exitCode === 0 && !timedOut && !aborted
							? 'Command completed.'
							: 'Command did not complete successfully.',
						{ views: [{ type: 'text', text: rendered }] }
					);
			void finish(result);
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
			name: 'bash',
			description:
				'Run a non-interactive Bash command in the current workspace (pipelines and shell syntax OK). `timeout` is ms (default 120000, max 600000); `cwd` is a workspace-relative working directory (portal extension) that cannot escape the workspace. Output past the in-context cap is spilled to `.zap/scratch/tool_results/` and the path returned for the model to read. `run_in_background` and `dangerouslyDisableSandbox` are not supported.',
			argsSchema: ShellArgs,
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Bash command to run.' },
					timeout: {
						type: 'number',
						description: 'Milliseconds, 100-600000 (default 120000).'
					},
					description: {
						type: 'string',
						description: 'Accepted for SDK compatibility and ignored.'
					},
					run_in_background: {
						type: 'boolean',
						description: 'Not supported: commands always run in the foreground.'
					},
					dangerouslyDisableSandbox: {
						type: 'boolean',
						description: 'Not supported: the portal never disables the sandbox.'
					},
					cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
					maxOutputBytes: {
						type: 'number',
						description:
							'In-context output cap in bytes (1024-65536, default 32768); overflow spills to disk.'
					}
				},
				required: ['command'],
				additionalProperties: false
			},
			async handler(args, ctx) {
				const parsed = ShellArgs.parse(args);
				if (parsed.run_in_background === true) {
					return err(
						'run_in_background is not supported: the portal shell tool runs commands in the foreground. Re-run without run_in_background.'
					);
				}
				if (parsed.dangerouslyDisableSandbox === true) {
					return err(
						'dangerouslyDisableSandbox is not supported: the portal never disables the sandbox. Re-run without dangerouslyDisableSandbox.'
					);
				}
				const cwd = resolveCwd(workspaceRoot, parsed.cwd);
				if (cwd === null)
					return err('cwd must resolve to a directory inside the workspace.', {
						code: 'invalid_cwd'
					});
				return runShell(
					workspaceRoot,
					parsed.command,
					cwd,
					parsed.timeout,
					parsed.maxOutputBytes,
					ctx
				);
			}
		}
	];
}
