import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import type {
	ApprovalMode,
	InteractivePermissionDecision,
	PermissionPolicy,
	PortalEvent
} from '../src/lib/types';
import type { AdversaryOutcome } from '../src/lib/server/permissions/adversary/client';

// Phase 0's whole safety story in one file: the adversary observes and records,
// and NOTHING it does — succeeding, failing, hanging, or babbling — may change
// what the permission path returns or what the human is shown.

const ADVERSARY_MODEL = 'reviewer-model';
const AGENT_MODEL = 'agent-model';
const AGENT_BACKEND = 'copilot' as const;

let convCounter = 0;

interface HarnessOptions {
	approvalMode?: ApprovalMode;
	policy?: PermissionPolicy;
	/** Adversary completion seam. Omit for a canned deny. */
	complete?: (system: string, user: string) => Promise<string>;
	/** Skip enabling the shadow, to test the default-off path. */
	disabled?: boolean;
	/** Make the adversary model equal the agent model. */
	sameModel?: boolean;
	/** Per-conversation override, which should beat the server default. */
	conversationModel?: string;
	/** Per-conversation reviewer backend override. */
	conversationBackend?: string;
	/** The backend serving the conversation's own agent. */
	agentBackend?: 'copilot' | 'openai-compatible' | 'lm-studio' | null;
	/** Route through the real provider registry instead of the test seam. */
	realDispatch?: boolean;
	/** Point the adapter at a conversation id that does not exist in the DB. */
	brokenConversationId?: boolean;
}

async function makeHarness(options: HarnessOptions = {}) {
	// A configured model IS the enablement — there is no separate on/off flag.
	if (options.disabled) {
		delete process.env.ADVERSARY_SHADOW_MODEL;
	} else {
		process.env.ADVERSARY_SHADOW_MODEL = options.sameModel ? AGENT_MODEL : ADVERSARY_MODEL;
	}
	// Deliberately NOT setting OPENAI_COMPATIBLE_BASE_URL: the shadow must run
	// on the conversation's own backend, which is the whole point of decoupling
	// the reviewer's model from the endpoint that serves it.
	await setupLocalEnv(`portal-shadow-test-`);

	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { createInteractiveCallbacks } =
		await import('../src/lib/server/copilot/interactive-adapter');
	const { createShadowRecorder } = await import('../src/lib/server/permissions/adversary/shadow');
	const shadowRepo = await import('../src/lib/server/db/repos/shadow-decisions');
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');

	const user = ensureLocalUser();
	const conversationId = `conv-shadow-${convCounter++}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'shadow test',
		workdir: '/tmp',
		model: AGENT_MODEL
	});

	let completeCalls = 0;
	const settled: AdversaryOutcome[] = [];
	let notifySettled: (() => void) | null = null;
	// Mutable so a test can simulate a worktree lease appearing mid-session.
	let workspaceRoots = ['/tmp'];

	const shadowRecorder = createShadowRecorder({
		getModel: () => options.conversationModel ?? null,
		getBackend: () => options.conversationBackend ?? null,
		// Matches how `createInteractiveCallbacks` wires it in production; the
		// backend needs it to resolve that user's credential.
		userId: user.id,
		// `realDispatch` exercises the actual provider lookup instead of the test
		// seam. It is the only way to catch a regression in that path, which is
		// resolved through a dynamic import to break a module cycle.
		...(options.realDispatch
			? {}
			: {
					complete: async (system: string, user: string) => {
						completeCalls++;
						return options.complete
							? await options.complete(system, user)
							: '{"verdict":"deny","denyProbability":0.8,"rationale":"Reaches outside the workspace."}';
					}
				}),
		onSettled: (outcome) => {
			settled.push(outcome);
			notifySettled?.();
		}
	});

	const events: PortalEvent[] = [];
	const { onPermissionRequest } = createInteractiveCallbacks({
		conversationId: options.brokenConversationId
			? 'conversation-that-does-not-exist'
			: conversationId,
		userId: user.id,
		workingDirectory: '/tmp',
		getWorkspaceRoots: () => workspaceRoots,
		policy: options.policy ?? 'prompt',
		emit: (ev) => events.push(ev),
		getApprovalMode: () => options.approvalMode ?? 'ask',
		getSessionWorkspacePath: () => null,
		getPermissionBehavior: () => 'normal',
		getAgentModel: () => AGENT_MODEL,
		getAgentBackend: () => options.agentBackend ?? AGENT_BACKEND,
		shadowRecorder
	});

	const waitForSettled = async (count = 1) => {
		const deadline = Date.now() + 2000;
		while (settled.length < count && Date.now() < deadline) {
			await new Promise<void>((r) => {
				notifySettled = r;
				setTimeout(r, 10);
			});
		}
		notifySettled = null;
	};

	return {
		interactive,
		shadowRepo,
		user,
		conversationId,
		onPermissionRequest,
		events,
		waitForSettled,
		rows: () => shadowRepo.listForConversation(conversationId),
		completeCalls: () => completeCalls,
		setWorkspaceRoots: (roots: string[]) => {
			workspaceRoots = roots;
		}
	};
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

const URL_REQUEST = {
	kind: 'url',
	toolName: 'web_fetch',
	url: 'https://example.com/docs',
	args: { url: 'https://example.com/docs' }
};

async function waitForPrompt(harness: Harness): Promise<{ requestId: string }> {
	for (let i = 0; i < 500; i++) {
		const pending = harness.interactive.listForConversation(harness.conversationId);
		if (pending.length > 0) return pending[0] as { requestId: string };
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error('no human prompt was raised');
}

async function driveAndResolve(
	harness: Harness,
	decision: InteractivePermissionDecision,
	req: Record<string, unknown> = URL_REQUEST
) {
	const resultPromise = harness.onPermissionRequest(req);
	const view = await waitForPrompt(harness);
	expect(
		harness.interactive.resolve(view.requestId, harness.user.id, { kind: 'permission', decision })
	).toBe(true);
	return await resultPromise;
}

describe('adversary shadow mode', () => {
	beforeEach(() => {
		delete process.env.ADVERSARY_SHADOW_MODEL;
		delete process.env.ADVERSARY_SHADOW_BACKEND;
		delete process.env.OPENAI_COMPATIBLE_BASE_URL;
		delete process.env.ADVERSARY_SHADOW_MAX_IN_FLIGHT;
	});

	it('records the adversary verdict alongside the human decision', async () => {
		const harness = await makeHarness();
		const result = await driveAndResolve(harness, 'allow-once');
		expect(result).toEqual({ kind: 'approve-once' });
		await harness.waitForSettled();

		const rows = harness.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status: 'verdict',
			verdict: 'deny',
			denyProbability: 0.8,
			rationale: 'Reaches outside the workspace.',
			humanDecision: 'allow-once',
			tool: 'web_fetch',
			permissionKind: 'url',
			scopeKey: 'https://example.com/docs',
			adversaryModel: ADVERSARY_MODEL,
			// No grant matched, so policy is what demanded the human. Recorded
			// so the sampled population can be characterized after the fact.
			resolutionSource: 'prompt-policy',
			memoized: false
		});
		expect(rows[0]?.promptVersion).toBeGreaterThanOrEqual(1);
		// Kept so a later analysis can spot rubber-stamping (a human answering
		// in milliseconds is a weak signal that the label is not considered).
		expect(rows[0]?.humanDecidedAt).toBeGreaterThanOrEqual(rows[0]!.createdAt);
	});

	it('records a human denial as the label', async () => {
		const harness = await makeHarness({
			complete: async () => '{"verdict":"deny","rationale":"Untrusted host."}'
		});
		const result = await driveAndResolve(harness, 'deny');
		expect(result).toMatchObject({ kind: 'reject' });
		await harness.waitForSettled();
		expect(harness.rows()[0]).toMatchObject({ verdict: 'deny', humanDecision: 'deny' });
	});

	// The critical Phase 0 safety test. Each of these adversary failure modes
	// must leave the permission decision path byte-identical.
	const failureModes: Array<[string, () => Promise<string>]> = [
		[
			'throws',
			async () => {
				throw new Error('ECONNREFUSED');
			}
		],
		['returns unparseable output', async () => 'Looks fine to me!'],
		['returns an unknown verdict', async () => '{"verdict":"maybe","rationale":"unsure"}']
	];

	for (const [label, complete] of failureModes) {
		it(`leaves the decision path unchanged when the adversary ${label}`, async () => {
			const harness = await makeHarness({ complete });
			const result = await driveAndResolve(harness, 'allow-once');
			expect(result).toEqual({ kind: 'approve-once' });
			await harness.waitForSettled();

			const rows = harness.rows();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ status: 'error', verdict: null });
			expect(rows[0]?.error).toBeTruthy();
			// The human label is still attached: the request itself was a
			// perfectly normal, fully-answered prompt.
			expect(rows[0]?.humanDecision).toBe('allow-once');
		});
	}

	it('never blocks the human dialog on the adversary', async () => {
		// The adversary hangs forever. The prompt must still be raised,
		// answered, and returned — the row simply stays `pending`.
		const harness = await makeHarness({ complete: () => new Promise<string>(() => {}) });
		const result = await driveAndResolve(harness, 'allow-always');
		expect(result).toEqual({ kind: 'approve-once' });
		expect(harness.rows()[0]).toMatchObject({
			status: 'pending',
			verdict: null,
			humanDecision: 'allow-always'
		});
	});

	it('leaves no human label when the prompt is cancelled', async () => {
		// A cancelled prompt is NOT a denial (the SDK is told
		// `user-not-available`), so it must not be scored as one. The row keeps
		// `humanDecision: null`, which the scorer excludes.
		const harness = await makeHarness();
		const resultPromise = harness.onPermissionRequest(URL_REQUEST);
		const view = await waitForPrompt(harness);
		harness.interactive.cancel(view.requestId, 'turn_aborted');
		expect(await resultPromise).toEqual({ kind: 'user-not-available' });
		await harness.waitForSettled();

		const rows = harness.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: 'verdict', humanDecision: null, humanDecidedAt: null });

		const { scoreShadowDecisions } =
			await import('../src/lib/server/permissions/adversary/scoring');
		expect(scoreShadowDecisions(rows)).toMatchObject({
			total: 1,
			scored: 0,
			excludedNoHumanLabel: 1,
			denyRecall: null
		});
	});

	it('memoizes identical requests to one provider call', async () => {
		const harness = await makeHarness();
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled(1);
		await driveAndResolve(harness, 'deny');
		await harness.waitForSettled(2);

		expect(harness.completeCalls()).toBe(1);
		const rows = harness.rows();
		expect(rows).toHaveLength(2);
		// Both rows carry the verdict; the second is flagged as reusing it, so
		// cost and coverage can be told apart in the readout.
		expect(rows.map((r) => r.verdict)).toEqual(['deny', 'deny']);
		expect(rows.map((r) => r.memoized)).toEqual([false, true]);
		expect(rows.map((r) => r.humanDecision)).toEqual(['allow-once', 'deny']);
	});

	it('does not replay a verdict when the facts changed underneath it', async () => {
		// Regression: the memo key used to be tool+kind+scopeKey+argsHash, which
		// omits `workspaceRoots` — the one fact the system prompt tells the
		// reviewer to judge against, and which changes mid-session as worktree
		// leases come and go. The identical request judged before and after a
		// lease exists is NOT the same question.
		const harness = await makeHarness();
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled(1);
		harness.setWorkspaceRoots(['/tmp', '/tmp/worktree-a']);
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled(2);

		expect(harness.completeCalls()).toBe(2);
		expect(harness.rows().map((r) => r.memoized)).toEqual([false, false]);
	});

	it('retries after an error instead of caching the failure', async () => {
		let call = 0;
		const harness = await makeHarness({
			complete: async () => {
				call++;
				if (call === 1) throw new Error('transient');
				return '{"verdict":"allow","rationale":"Fine."}';
			}
		});
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled(1);
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled(2);

		expect(harness.completeCalls()).toBe(2);
		expect(harness.rows().map((r) => r.status)).toEqual(['error', 'verdict']);
	});

	it('caps concurrent adversary calls and records the skips visibly', async () => {
		// In an `auto-approve` conversation no dialog paces the requests, so an
		// unbounded fan-out would open one completion per tool call. Over the
		// cap the row is written as an explicit skip rather than dropped: the
		// hole it leaves is not random (it lands on the busiest moments), so it
		// has to be visible in the data.
		process.env.ADVERSARY_SHADOW_MAX_IN_FLIGHT = '1';
		// A holder rather than a `let`: TypeScript narrows a `let` assigned only
		// inside a callback to `never` at the call site below.
		const gate = { release: () => {} };
		const harness = await makeHarness({
			approvalMode: 'auto-approve',
			complete: () =>
				new Promise<string>((resolve) => {
					gate.release = () =>
						resolve('{"verdict":"allow","denyProbability":0.1,"rationale":"ok"}');
				})
		});

		// First request occupies the only slot and stays in flight.
		expect(await harness.onPermissionRequest(URL_REQUEST)).toEqual({ kind: 'approve-once' });
		// Second request has different facts (so it cannot be memoized) and
		// finds the cap full.
		expect(
			await harness.onPermissionRequest({
				kind: 'url',
				toolName: 'web_fetch',
				url: 'https://example.com/other',
				args: { url: 'https://example.com/other' }
			})
		).toEqual({ kind: 'approve-once' });
		await harness.waitForSettled(1);

		const skipped = harness.rows().filter((r) => r.status === 'error');
		expect(skipped).toHaveLength(1);
		expect(skipped[0]?.error).toContain('skipped');
		// No call was made, so no latency — a zero would enter the readout's
		// percentiles and make the adversary look fastest exactly when it was
		// being throttled.
		expect(skipped[0]?.latencyMs).toBeNull();
		expect(harness.completeCalls()).toBe(1);

		// The in-flight call still settles normally and frees its slot.
		gate.release();
		await harness.waitForSettled(2);
		expect(harness.rows().filter((r) => r.status === 'verdict')).toHaveLength(1);
	});

	it('is inert unless a model is configured', async () => {
		const harness = await makeHarness({ disabled: true });
		expect(await driveAndResolve(harness, 'allow-once')).toEqual({ kind: 'approve-once' });
		expect(harness.rows()).toHaveLength(0);
		expect(harness.completeCalls()).toBe(0);
	});

	it('prefers the conversation model over the server default', async () => {
		// The precedence that makes this a setting rather than an env var:
		// conversation override -> user default (seeded onto the conversation at
		// creation) -> server default.
		const harness = await makeHarness({ conversationModel: 'per-conversation-reviewer' });
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled();
		expect(harness.rows()[0]?.adversaryModel).toBe('per-conversation-reviewer');
	});

	it('runs from a conversation model alone, with no server default set', async () => {
		// The case an env-only design could not express at all: an operator who
		// never configured a reviewer, and a user who chose one.
		const harness = await makeHarness({
			disabled: true,
			conversationModel: 'user-chosen-reviewer'
		});
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled();
		const rows = harness.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.adversaryModel).toBe('user-chosen-reviewer');
	});

	it('refuses to run when the adversary model equals the agent model', async () => {
		// Shared weights means shared blind spots: the run would measure
		// self-agreement, not oversight.
		const harness = await makeHarness({ sameModel: true });
		expect(await driveAndResolve(harness, 'allow-once')).toEqual({ kind: 'approve-once' });
		expect(harness.rows()).toHaveLength(0);
		expect(harness.completeCalls()).toBe(0);
	});

	it('runs on the conversation backend with no second endpoint configured', async () => {
		// The regression this whole decoupling exists to prevent. The shadow used
		// to hard-require OPENAI_COMPATIBLE_BASE_URL, which confined every
		// measurement to deployments that had stood up a second endpoint. The
		// harness deliberately leaves it unset.
		expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
		const harness = await makeHarness();
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled();
		const rows = harness.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.adversaryBackend).toBe(AGENT_BACKEND);
	});

	it('still runs when the model name matches but the backend differs', async () => {
		// The old guard compared bare model ids across two namespaces, so a
		// coincidental collision (a `gpt-5` on each side) silently disabled the
		// shadow even though the weights were unrelated.
		const harness = await makeHarness({
			sameModel: true,
			conversationBackend: 'openai-compatible'
		});
		await driveAndResolve(harness, 'allow-once');
		await harness.waitForSettled();
		const rows = harness.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.adversaryBackend).toBe('openai-compatible');
	});

	it('records the backend so rows from two backends cannot pool', async () => {
		// The same model NAME served by two backends is not the same experiment:
		// weights, system-prompt handling and structured-output support all
		// differ, so `experiment_key` has to separate them.
		const a = await makeHarness({ conversationBackend: 'copilot' });
		await driveAndResolve(a, 'allow-once');
		await a.waitForSettled();
		const b = await makeHarness({ conversationBackend: 'openai-compatible' });
		await driveAndResolve(b, 'allow-once');
		await b.waitForSettled();
		expect(a.rows()[0]?.experimentKey).not.toBe(b.rows()[0]?.experimentKey);
	});

	it('dispatches through the real provider registry when no seam is injected', async () => {
		// Guards the dynamic import in `completeVia`. A static import there
		// creates the cycle providers/index → copilot-provider →
		// interactive-adapter → shadow, which leaves the registry
		// half-initialized and makes `getProvider` return undefined — a failure
		// the injected test seam would hide completely.
		process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://reviewer.invalid/v1';
		const fetchMock = vi.fn(async () =>
			Response.json({
				choices: [{ message: { content: '{"verdict":"deny","rationale":"Reaches outside."}' } }]
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		try {
			const harness = await makeHarness({
				realDispatch: true,
				conversationBackend: 'openai-compatible'
			});
			await driveAndResolve(harness, 'allow-once');
			await harness.waitForSettled();
			const rows = harness.rows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe('verdict');
			expect(rows[0]?.verdict).toBe('deny');
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('forwards the per-user auth token to the reviewer backend', async () => {
		// `copilot-provider.getClient` caches one CopilotClient per user, first
		// caller wins, and applies `gitHubToken` only at construction. A
		// token-less side call that ran before the user's first Copilot
		// conversation would cache a client built from the machine's logged-in
		// identity, and every later REAL turn for that user would silently
		// inherit it — a no-authority experiment changing who real work runs as.
		// Reachable in normal use: an openai-compatible conversation whose
		// reviewer backend is copilot, which the settings picker offers.
		const tokens = await import('../src/lib/server/db/repos/tokens');
		const { getProvider } = await import('../src/lib/server/providers');
		// Token storage is encrypted at rest; `setupLocalEnv` does not provide a
		// key, so supply one before the harness resets cached config.
		process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
		const harness = await makeHarness({
			realDispatch: true,
			conversationBackend: 'copilot'
		});
		tokens.setGithubToken(harness.user.id, 'gho_side_call_token');

		const copilot = getProvider('copilot');
		const original = copilot.complete!;
		let seenToken: string | undefined | null = null;
		copilot.complete = async (req) => {
			seenToken = req.providerAuthToken;
			return '{"verdict":"allow","rationale":"ok"}';
		};
		try {
			await driveAndResolve(harness, 'allow-once');
			await harness.waitForSettled();
		} finally {
			copilot.complete = original;
		}
		expect(seenToken).toBe('gho_side_call_token');
	});

	it('refuses an explicitly configured backend that is not a known provider', async () => {
		// `normalizeBackendProvider` silently coerces an unknown id to the
		// default, which would mislabel every row with a backend nobody chose.
		const harness = await makeHarness({ conversationBackend: 'not-a-provider' });
		expect(await driveAndResolve(harness, 'allow-once')).toEqual({ kind: 'approve-once' });
		expect(harness.rows()).toHaveLength(0);
		expect(harness.completeCalls()).toBe(0);
	});

	it('survives a failing shadow insert without touching the decision path', async () => {
		// Foreign key violation: the conversation row does not exist.
		const harness = await makeHarness({ brokenConversationId: true });
		const resultPromise = harness.onPermissionRequest(URL_REQUEST);
		for (let i = 0; i < 500; i++) {
			const pending = harness.interactive.listForConversation('conversation-that-does-not-exist');
			if (pending.length > 0) {
				harness.interactive.resolve(
					(pending[0] as { requestId: string }).requestId,
					harness.user.id,
					{ kind: 'permission', decision: 'allow-once' }
				);
				break;
			}
			await new Promise((r) => setTimeout(r, 1));
		}
		expect(await resultPromise).toEqual({ kind: 'approve-once' });
		expect(harness.completeCalls()).toBe(0);
	});

	it('collects the auto-approve population, unlabelled and excluded from scoring', async () => {
		// These are the requests a future veto-over-auto-approve product would
		// gate. Nobody is asked, so there is no human label and the scorer
		// excludes them — they are collected anyway because the request cannot
		// be recovered after the fact, and can be adjudicated later.
		const harness = await makeHarness({ approvalMode: 'auto-approve' });
		expect(await harness.onPermissionRequest(URL_REQUEST)).toEqual({ kind: 'approve-once' });
		await harness.waitForSettled();

		const rows = harness.rows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			resolutionSource: 'auto-approve',
			status: 'verdict',
			verdict: 'deny',
			humanDecision: null
		});
		// The prompt actually sent is kept so these rows can be adjudicated
		// later — they are the only record of a request nobody was asked about.
		expect(rows[0]?.promptSent).toContain('PERMISSION REQUEST');

		const { scoreShadowDecisions } =
			await import('../src/lib/server/permissions/adversary/scoring');
		expect(scoreShadowDecisions(rows)).toMatchObject({
			total: 1,
			scored: 0,
			// Bucketed as "nobody was asked", not as an abandoned prompt, and
			// kept out of the coverage denominator.
			unlabellableByDesign: 1,
			excludedNoHumanLabel: 0,
			coverage: null
		});
	});

	it('records nothing in auto-deny conversations', async () => {
		// `auto-deny` rejects before the hook, so there is nothing to observe:
		// no human was asked and no action was permitted.
		const harness = await makeHarness({ approvalMode: 'auto-deny' });
		await harness.onPermissionRequest(URL_REQUEST);
		expect(harness.rows()).toHaveLength(0);
		expect(harness.completeCalls()).toBe(0);
	});

	it('does not shadow an auto-approve request that a grant already allowed', async () => {
		// Only the approval MODE's allow is the veto population. A request a
		// stored grant or the policy would have allowed anyway is not something
		// a veto product would be gating, and counting it would pad the sample.
		const harness = await makeHarness({ approvalMode: 'auto-approve', policy: 'allow-all' });
		expect(await harness.onPermissionRequest(URL_REQUEST)).toEqual({ kind: 'approve-once' });
		expect(harness.rows()).toHaveLength(0);
		expect(harness.completeCalls()).toBe(0);
	});

	it('round-trips through the repo into the numbers the readout prints', async () => {
		// Covers the exact data path `scripts/adversary-shadow-report.mjs` uses:
		// repo read -> scoring, including stratification by (model, prompt
		// version) and the memoized-row exclusion.
		const harness = await makeHarness();
		const { scoreShadowDecisions } =
			await import('../src/lib/server/permissions/adversary/scoring');
		const repo = harness.shadowRepo;

		const seed = (
			id: string,
			verdict: 'allow' | 'deny',
			human: 'allow-once' | 'deny' | null,
			opts: { memoized?: boolean } = {}
		) => {
			repo.insertPending({
				id,
				conversationId: harness.conversationId,
				tool: 'shell',
				permissionKind: 'shell',
				scopeKey: `cmd-${id}`,
				argsHash: null,
				adversaryModel: ADVERSARY_MODEL,
				adversaryBackend: 'openai-compatible',
				experimentKey: 'exp-1',
				promptVersion: 1,
				factsKey: `facts-${id}`,
				resolutionSource: 'prompt-policy'
			});
			repo.recordVerdict(id, verdict, 'because', {
				denyProbability: 0.7,
				memoized: opts.memoized ?? false,
				promptSent: 'PERMISSION REQUEST ...'
			});
			if (human) repo.recordHumanDecision(id, human);
		};

		seed('s1', 'deny', 'deny');
		seed('s2', 'deny', 'allow-once');
		seed('s3', 'allow', 'deny');
		seed('s4', 'allow', 'allow-once');
		seed('s5', 'deny', null); // cancelled: no label
		seed('s6', 'deny', 'deny', { memoized: true }); // correlated replay

		const rows = repo.listForUser(harness.user.id);
		expect(rows).toHaveLength(6);
		expect(rows.every((r) => r.denyProbability === 0.7)).toBe(true);
		expect(rows.every((r) => r.resolutionSource === 'prompt-policy')).toBe(true);
		// The evidence that makes a disagreement adjudicable later.
		expect(rows.every((r) => r.promptSent !== null && r.factsKey !== null)).toBe(true);

		const score = scoreShadowDecisions(rows);
		expect(score).toMatchObject({
			total: 6,
			scored: 4,
			excludedNoHumanLabel: 1,
			memoizedDuplicates: 1,
			truePositives: 1,
			falsePositives: 1,
			falseNegatives: 1,
			trueNegatives: 1
		});
		expect(score.denyPrecision).toBeCloseTo(0.5);
		expect(score.denyRecall).toBeCloseTo(0.5);
		// Memoized replays leave the denominator: excluding them is a choice of
		// estimand, not lost coverage.
		expect(score.coverage).toBeCloseTo(4 / 5);

		// The memoized replay only counts when explicitly asked for.
		expect(scoreShadowDecisions(rows, { includeMemoized: true }).truePositives).toBe(2);
	});
});
