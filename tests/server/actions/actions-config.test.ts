import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseActionsConfig, loadActionsConfig } from '../../../src/lib/server/actions/config';
import { makeTmpDir } from '../../helpers/tmp';

const validConfig = {
	version: 1,
	actions: [
		{
			id: 'preview-deploy',
			label: 'Deploy preview build',
			description: 'Build and deploy a preview',
			permission: 'user',
			env: ['VERCEL_TOKEN'],
			steps: [
				{ label: 'build', command: 'pnpm', args: ['run', 'build:preview'] },
				{ label: 'deploy', command: 'pnpm', args: ['run', 'deploy:preview'] }
			]
		}
	]
};

describe('parseActionsConfig — valid', () => {
	it('accepts a well-formed config and applies defaults', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'lint', label: 'Lint', steps: [{ command: 'pnpm', args: ['lint'] }] }]
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.actions).toHaveLength(1);
		expect(res.actions[0].permission).toBe('user'); // default
		expect(res.actions[0].env).toEqual([]); // default
		expect(res.actions[0].steps[0].args).toEqual(['lint']);
	});

	it('accepts admin permission', () => {
		const res = parseActionsConfig(validConfig);
		expect(res.ok).toBe(true);
	});
});

describe('parseActionsConfig — fail closed', () => {
	it('rejects a missing/!==1 version', () => {
		expect(parseActionsConfig({ actions: [] }).ok).toBe(false);
		expect(parseActionsConfig({ version: 2, actions: [] }).ok).toBe(false);
	});

	it('rejects unknown top-level keys', () => {
		const res = parseActionsConfig({ version: 1, actions: [], extra: true });
		expect(res.ok).toBe(false);
	});

	it('rejects unknown action keys', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', steps: [{ command: 'ls' }], surprise: 1 }]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects a cwd field with a message naming the reserved capability', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', steps: [{ command: 'ls', cwd: '/etc' }] }]
		});
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error).toContain('cwd');
		expect(res.error).toContain('reserved');
	});

	it('rejects a rollover/restarting field (built-in-only)', () => {
		for (const key of ['rollover', 'restarting', 'restart', 'inheritEnv']) {
			const res = parseActionsConfig({
				version: 1,
				actions: [{ id: 'x', label: 'X', [key]: true, steps: [{ command: 'ls' }] }]
			});
			expect(res.ok, `${key} should be rejected`).toBe(false);
			if (!res.ok) expect(res.error).toContain(key);
		}
	});

	it('rejects env entries that look like values rather than NAMEs', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', env: ['VERCEL_TOKEN=secret'], steps: [{ command: 'ls' }] }]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects an env entry that names one of the portal\u2019s own secrets', () => {
		for (const name of [
			'SESSION_SECRET',
			'ENCRYPTION_KEY',
			'GITHUB_CLIENT_SECRET',
			'SHARED_SECRET'
		]) {
			const res = parseActionsConfig({
				version: 1,
				actions: [{ id: 'x', label: 'X', env: [name], steps: [{ command: 'ls' }] }]
			});
			expect(res.ok, `${name} should be rejected`).toBe(false);
			if (!res.ok) {
				expect(res.error).toContain(name);
				expect(res.error).toContain('reserved portal secret');
			}
		}
	});

	it('still allows an operator-provisioned project secret name', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', env: ['VERCEL_TOKEN'], steps: [{ command: 'ls' }] }]
		});
		expect(res.ok).toBe(true);
	});

	it('rejects lowercase / malformed env names', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', env: ['vercel'], steps: [{ command: 'ls' }] }]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects an action with no steps', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', steps: [] }]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects an empty command', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', steps: [{ command: '' }] }]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects an invalid (non-slug) id', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'Bad Id', label: 'X', steps: [{ command: 'ls' }] }]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects duplicate ids', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{ id: 'dup', label: 'A', steps: [{ command: 'ls' }] },
				{ id: 'dup', label: 'B', steps: [{ command: 'ls' }] }
			]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('duplicate');
	});
});

describe('parseActionsConfig — typed inputs', () => {
	it('accepts declared inputs and applies defaults', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{
					id: 'deploy',
					label: 'Deploy',
					inputs: [
						{ name: 'env', label: 'Environment', type: 'enum', options: ['staging', 'prod'] },
						{ name: 'note', label: 'Note', required: false }
					],
					steps: [{ command: 'pnpm', args: ['run', 'deploy', '--env={{env}}', '--note={{note}}'] }]
				}
			]
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.actions[0].inputs[0].type).toBe('enum');
		expect(res.actions[0].inputs[1].required).toBe(false); // explicit
		expect(res.actions[0].inputs[0].required).toBe(true); // default
	});

	it('rejects an enum input with no options', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{
					id: 'x',
					label: 'X',
					inputs: [{ name: 'env', label: 'Env', type: 'enum' }],
					steps: [{ command: 'ls' }]
				}
			]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('options');
	});

	it('rejects an enum default that is not one of its options', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{
					id: 'x',
					label: 'X',
					inputs: [{ name: 'env', label: 'Env', type: 'enum', options: ['a', 'b'], default: 'c' }],
					steps: [{ command: 'ls' }]
				}
			]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('options');
	});

	it('rejects options on a non-enum input', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{
					id: 'x',
					label: 'X',
					inputs: [{ name: 'env', label: 'Env', type: 'string', options: ['a'] }],
					steps: [{ command: 'ls' }]
				}
			]
		});
		expect(res.ok).toBe(false);
	});

	it('rejects a step arg referencing an undeclared input token', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', steps: [{ command: 'echo', args: ['{{ghost}}'] }] }]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('unknown input');
	});

	it('rejects an input token in the command itself', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{
					id: 'x',
					label: 'X',
					inputs: [{ name: 'bin', label: 'Bin' }],
					steps: [{ command: '{{bin}}', args: [] }]
				}
			]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('command');
	});

	it('rejects duplicate input names', () => {
		const res = parseActionsConfig({
			version: 1,
			actions: [
				{
					id: 'x',
					label: 'X',
					inputs: [
						{ name: 'a', label: 'A' },
						{ name: 'a', label: 'A2' }
					],
					steps: [{ command: 'echo', args: ['{{a}}'] }]
				}
			]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('duplicate input');
	});
});

describe('parseActionsConfig — array bounds', () => {
	it('rejects more than the maximum number of actions', () => {
		const actions = Array.from({ length: 101 }, (_, i) => ({
			id: `a${i}`,
			label: 'A',
			steps: [{ command: 'ls' }]
		}));
		const res = parseActionsConfig({ version: 1, actions });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('at most');
	});

	it('rejects an action with too many steps', () => {
		const steps = Array.from({ length: 51 }, () => ({ command: 'ls' }));
		const res = parseActionsConfig({ version: 1, actions: [{ id: 'x', label: 'X', steps }] });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('at most');
	});

	it('rejects a step with too many args', () => {
		const args = Array.from({ length: 201 }, () => 'x');
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', steps: [{ command: 'echo', args }] }]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('at most');
	});

	it('rejects an action with too many inputs', () => {
		const inputs = Array.from({ length: 51 }, (_, i) => ({ name: `i${i}`, label: 'I' }));
		const res = parseActionsConfig({
			version: 1,
			actions: [{ id: 'x', label: 'X', inputs, steps: [{ command: 'ls' }] }]
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('at most');
	});
});

describe('loadActionsConfig — file IO', () => {
	it('returns empty actions when the file is absent', async () => {
		const dir = makeTmpDir('portal-actions-');
		const res = await loadActionsConfig(dir);
		expect(res).toEqual({ ok: true, actions: [] });
	});

	it('reads and validates a real .zap/actions.json', async () => {
		const dir = makeTmpDir('portal-actions-');
		mkdirSync(join(dir, '.zap'), { recursive: true });
		writeFileSync(join(dir, '.zap', 'actions.json'), JSON.stringify(validConfig));
		const res = await loadActionsConfig(dir);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.actions[0].id).toBe('preview-deploy');
	});

	it('surfaces invalid JSON as a config error', async () => {
		const dir = makeTmpDir('portal-actions-');
		mkdirSync(join(dir, '.zap'), { recursive: true });
		writeFileSync(join(dir, '.zap', 'actions.json'), '{ not json');
		const res = await loadActionsConfig(dir);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('invalid');
	});

	it('surfaces a validation failure as a config error', async () => {
		const dir = makeTmpDir('portal-actions-');
		mkdirSync(join(dir, '.zap'), { recursive: true });
		writeFileSync(join(dir, '.zap', 'actions.json'), JSON.stringify({ version: 9, actions: [] }));
		const res = await loadActionsConfig(dir);
		expect(res.ok).toBe(false);
	});
});
