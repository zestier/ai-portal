// Facade for the pi SDK session path (T1).
//
// Exposes the seam the turn-runner branches on:
//   isPiMode()      — should this turn run on pi?
//   openPiSession() — a `ProviderSession` backed by a pi `AgentSession`.
//
// The `ModelRuntime` is a process-wide singleton (shared across pi sessions)
// so auth/catalog state is consistent; the stub model is registered on it
// once when `PI_STUB=1`.

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../config';
import type { ProviderOpenOptions, ProviderSession } from './session-contract';
import { createPiProviderSession, type PiPermissionResolver, type PiModel } from './session';
import { getStubModel, isPiStubMode } from './stub-server';

let runtimePromise: Promise<ModelRuntime> | null = null;

/** Process-wide pi `ModelRuntime` (env auth; no models.json — static snapshot). */
export function getModelRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
	return runtimePromise;
}

/** Whether this turn should run on the pi SDK path. T1 gates on the stub only. */
export function isPiMode(): boolean {
	return isPiStubMode();
}

/**
 * Open a pi-backed `ProviderSession` for the given turn options. In stub mode
 * the stub model is registered on the shared runtime first; otherwise the
 * `PI_MODEL` config id (`providerId/modelId`) selects the model.
 */
export async function openPiSession(opts: ProviderOpenOptions): Promise<ProviderSession> {
	const runtime = await getModelRuntime();
	const model = await resolvePiModel(runtime);
	return createPiProviderSession({
		cwd: opts.workingDirectory,
		model,
		providerLabel: `${model.provider}/${model.id}`,
		runtime,
		onPermission: piPermissionResolver,
		provider: opts.provider ?? 'pi',
		conversationId: opts.conversationId,
		providerSessionId: opts.providerSessionId ?? opts.conversationId,
		...(opts.onEvent ? { onEvent: opts.onEvent } : {})
	});
}

async function resolvePiModel(runtime: ModelRuntime): Promise<PiModel> {
	if (isPiStubMode()) {
		const stub = await getStubModel(runtime);
		if (stub) return stub;
		throw new Error('pi stub model unavailable');
	}
	const modelId = loadConfig().PI_MODEL;
	const slash = modelId.indexOf('/');
	if (slash <= 0) {
		throw new Error(`invalid PI_MODEL "${modelId}": expected "providerId/modelId"`);
	}
	const model = runtime.getModel(modelId.slice(0, slash), modelId.slice(slash + 1));
	if (!model) {
		throw new Error(`pi model not found: ${modelId} (check PI_MODEL / pi credentials)`);
	}
	return model;
}

// T1 resolver: no pi tools are enabled, so this never runs — but block
// everything if it ever does. The portal interactive-request gateway replaces
// it when tools are wired (T2).
const piPermissionResolver: PiPermissionResolver = async () => ({
	allow: false,
	reason: 'pi tools are not wired to the portal permission gateway yet'
});
