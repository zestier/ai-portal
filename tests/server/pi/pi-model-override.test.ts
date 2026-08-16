import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { setupLocalEnv } from '../../helpers/env';
import { makeTmpDir } from '../../helpers/tmp';
import type { ProviderOpenOptions } from '../../../src/lib/server/pi/session-contract';

// Non-stub model resolution: the per-conversation bridge model (what the
// chat-header Model field writes) must select which pi model the session runs,
// falling back to the PI_MODEL env default when the conversation never chose
// one (its stored model is the DEFAULT_MODEL default), and the PATCH /session
// route must reject ids that don't resolve. The stub e2e path is exercised
// unchanged by pi-stub-loop.test.ts.

async function registerTestProvider(): Promise<void> {
	const { getModelRuntime } = await import('../../../src/lib/server/pi');
	const runtime = await getModelRuntime();
	runtime.registerProvider('test-provider', {
		name: 'test provider',
		api: 'openai-completions',
		baseUrl: 'http://127.0.0.1:9/v1',
		apiKey: 'test-key',
		authHeader: true,
		models: [
			{
				id: 'default-model',
				name: 'Default',
				reasoning: false,
				input: ['text'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4096
			},
			{
				id: 'override-model',
				name: 'Override',
				reasoning: false,
				input: ['text'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4096
			}
		]
	});
}

describe('pi model override', () => {
	beforeAll(async () => {
		// Non-stub: the default PI_MODEL (anthropic/...) isn't registered in
		// tests, so point it at the throwaway provider.
		process.env.PI_MODEL = 'test-provider/default-model';
		delete process.env.PI_STUB;
		await setupLocalEnv('pi-model-override-');
		const { resetConfigForTests } = await import('../../../src/lib/server/config');
		resetConfigForTests();
		await registerTestProvider();
	});

	afterEach(async () => {
		// Drop pooled sessions so one test's live pi session can't leak into the
		// next / interfere with the PATCH route's pool.release.
		const { shutdown } = await import('../../../src/lib/server/runtime/pool');
		await shutdown();
	});

	async function open(wd: string, model: string) {
		const { openPiSession } = await import('../../../src/lib/server/pi');
		return openPiSession({
			conversationId: 1,
			userId: 1,
			workingDirectory: wd,
			model,
			policy: 'prompt'
		} satisfies ProviderOpenOptions);
	}

	it('runs the per-conversation override model instead of the PI_MODEL default', async () => {
		const session = await open(makeTmpDir('pi-override-wd-'), 'test-provider/override-model');
		expect(session.model).toBe('test-provider/override-model');
		await session.dispose();
	});

	it('falls back to the PI_MODEL default when the bridge model is the DEFAULT_MODEL default', async () => {
		const cfg = await import('../../../src/lib/server/config');
		const session = await open(makeTmpDir('pi-default-wd-'), cfg.loadConfig().DEFAULT_MODEL);
		expect(session.model).toBe('test-provider/default-model');
		await session.dispose();
	});

	it('falls back to the PI_MODEL default for an unprefixed bridge model (legacy/unset)', async () => {
		// The create route stores `DEFAULT_MODEL` (unprefixed) when the user
		// never chose a model, and legacy rows may hold other unprefixed ids —
		// neither is a real override, so both resolve to PI_MODEL.
		const session = await open(makeTmpDir('pi-unprefixed-wd-'), 'gpt-4');
		expect(session.model).toBe('test-provider/default-model');
		await session.dispose();
	});

	it('rejects a model id the runtime does not know', async () => {
		await expect(open(makeTmpDir('pi-unknown-wd-'), 'test-provider/nope')).rejects.toThrow(
			'pi model not found: test-provider/nope'
		);
	});

	it('validates the model id on PATCH /session, failing fast instead of storing a silent fallback', async () => {
		const users = await import('../../../src/lib/server/db/repos/users');
		const convs = await import('../../../src/lib/server/db/repos/conversations');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'model field', workdir: '/tmp', model: null });

		const callPatch = async (model: string) => {
			const { PATCH } = await import('../../../src/routes/api/conversations/[id]/session/+server');
			const req = new Request(`http://127.0.0.1/api/conversations/${conv.id}/session`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ model })
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			return (PATCH as any)({
				params: { id: String(conv.id) },
				locals: { userId: user.id },
				request: req
			});
		};
		const statusOf = async (p: Promise<Response>): Promise<number> => {
			try {
				return (await p).status;
			} catch (e) {
				return (e as { status?: number }).status ?? 500;
			}
		};

		// Valid selection persists; the conversation row now carries the override.
		expect(await statusOf(callPatch('test-provider/override-model'))).toBe(200);
		expect(convs.get(conv.id, user.id)!.model).toBe('test-provider/override-model');

		// Unknown provider/model is a 400, and nothing is stored.
		expect(await statusOf(callPatch('test-provider/nope'))).toBe(400);
		expect(convs.get(conv.id, user.id)!.model).toBe('test-provider/override-model');

		// Unparseable (no provider prefix) is a 400 too.
		expect(await statusOf(callPatch('gpt-4'))).toBe(400);
		expect(convs.get(conv.id, user.id)!.model).toBe('test-provider/override-model');
	});
});
