import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir } from './helpers/tmp';
import { loadWorkspaceMcpServers } from '../src/lib/server/copilot/workspace-mcp';

function writeMcp(dir: string, contents: string, name = '.mcp.json'): void {
	writeFileSync(join(dir, name), contents);
}

describe('loadWorkspaceMcpServers', () => {
	it('returns {} when no working directory is given', () => {
		expect(loadWorkspaceMcpServers(undefined)).toEqual({});
		expect(loadWorkspaceMcpServers(null)).toEqual({});
		expect(loadWorkspaceMcpServers('')).toEqual({});
	});

	it('returns {} when the workdir has no .mcp.json', () => {
		const dir = makeTmpDir('mcp-none-');
		expect(loadWorkspaceMcpServers(dir)).toEqual({});
	});

	it('loads servers verbatim without injecting tools', () => {
		const dir = makeTmpDir('mcp-load-');
		writeMcp(
			dir,
			JSON.stringify({
				mcpServers: { playwright: { command: 'pnpm', args: ['exec', 'playwright-mcp'] } }
			})
		);
		// Entries are passed through unchanged — the workspace declares `tools`
		// itself if it wants the server to connect.
		expect(loadWorkspaceMcpServers(dir)).toEqual({
			playwright: { command: 'pnpm', args: ['exec', 'playwright-mcp'] }
		});
	});

	it('preserves an explicit tools list (including an empty one)', () => {
		const dir = makeTmpDir('mcp-tools-');
		writeMcp(
			dir,
			JSON.stringify({
				mcpServers: {
					a: { command: 'x', tools: ['read_only'] },
					b: { command: 'y', tools: [] }
				}
			})
		);
		const out = loadWorkspaceMcpServers(dir);
		expect(out.a).toEqual({ command: 'x', tools: ['read_only'] });
		expect(out.b).toEqual({ command: 'y', tools: [] });
	});

	it('passes through extra fields like type and env untouched', () => {
		const dir = makeTmpDir('mcp-extra-');
		writeMcp(
			dir,
			JSON.stringify({
				mcpServers: {
					s: { type: 'local', command: 'c', args: ['a'], env: { K: 'v' }, tools: ['*'] }
				}
			})
		);
		expect(loadWorkspaceMcpServers(dir).s).toEqual({
			type: 'local',
			command: 'c',
			args: ['a'],
			env: { K: 'v' },
			tools: ['*']
		});
	});

	it('returns {} for malformed JSON rather than throwing', () => {
		const dir = makeTmpDir('mcp-bad-');
		writeMcp(dir, '{ this is not json ');
		expect(loadWorkspaceMcpServers(dir)).toEqual({});
	});

	it('returns {} when the file lacks an mcpServers object', () => {
		const dir = makeTmpDir('mcp-empty-');
		writeMcp(dir, JSON.stringify({ somethingElse: true }));
		expect(loadWorkspaceMcpServers(dir)).toEqual({});
	});

	it('skips non-object server entries but keeps valid siblings', () => {
		const dir = makeTmpDir('mcp-mixed-');
		writeMcp(
			dir,
			JSON.stringify({ mcpServers: { good: { command: 'c', tools: ['*'] }, bad: 'nope' } })
		);
		expect(loadWorkspaceMcpServers(dir)).toEqual({ good: { command: 'c', tools: ['*'] } });
	});
});
