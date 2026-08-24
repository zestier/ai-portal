// Facade for the pi SDK session path (T1).
//
// Exposes the seam the turn-runner branches on:
//   isPiMode()      — should this turn run on pi?
//   openPiSession() — a `ProviderSession` backed by a pi `AgentSession`.
//
// The `ModelRuntime` is a process-wide singleton (shared across pi sessions)
// so auth/catalog state is consistent; the stub model is registered on it
// once when `PI_STUB=1`.

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import * as portalExtensions from "../extensions";
import { PortalCredentialStore } from "../models/credential-store";
import { modelsJsonPath, writeModelsJsonFile } from "../models/models-json";
import type { ProviderOpenOptions, ProviderSession } from "./session-contract";
import { createPiProviderSession, type PiModel } from "./session";
import { getStubModel, isPiStubMode } from "./stub-server";

let runtimePromise: Promise<ModelRuntime> | null = null;

/**
 * Process-wide pi `ModelRuntime` over the portal-managed catalog.
 *
 * Providers/models come from DATA_DIR/models.json (serialized from the portal
 * DB by `syncModelRuntime`); provider API keys are served from the encrypted
 * portal DB via PortalCredentialStore — no env keys required. In stub mode
 * the e2e stub model is additionally registered on this same runtime.
 */
export function getModelRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create({
    modelsPath: modelsJsonPath(loadConfig()),
    credentials: new PortalCredentialStore(),
    refreshOnCreate: false,
  });
  return runtimePromise;
}

/**
 * Persist the portal's current provider/model configuration to models.json and
 * reload it into the shared runtime (pi re-reads the file on `refresh()`), so
 * edits from the Models settings UI take effect without a restart. Idempotent;
 * call after any provider/model/key mutation.
 */
export async function syncModelRuntime(): Promise<void> {
  writeModelsJsonFile();
  const runtime = await getModelRuntime();
  await runtime.refresh({ allowNetwork: false });
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
export async function openPiSession(
  opts: ProviderOpenOptions,
): Promise<ProviderSession> {
  const runtime = await getModelRuntime();
  const model = await resolvePiModel(runtime, opts.model);
  // Compute the operator-managed extension set (paths/specs) and its
  // fingerprint in one pass over the same repo state, so the pool's acquire
  // re-match (which independently fingerprints) is consistent.
  const [extensionPaths, extensionFingerprint] = await Promise.all([
    portalExtensions.enabledExtensionPaths(opts.userId),
    portalExtensions.fingerprint(opts.userId),
  ]);
  return createPiProviderSession({
    cwd: opts.workingDirectory,
    model,
    providerLabel: `${model.provider}/${model.id}`,
    runtime,
    provider: opts.provider ?? "pi",
    conversationId: opts.conversationId,
    providerSessionId: opts.providerSessionId ?? String(opts.conversationId),
    userId: opts.userId,
    policy: opts.policy,
    ...(opts.agentArchitecture !== undefined
      ? { agentArchitecture: opts.agentArchitecture }
      : {}),
    ...(opts.semanticWorkerModel !== undefined
      ? { semanticWorkerModel: opts.semanticWorkerModel }
      : {}),
    additionalExtensionPaths: extensionPaths,
    extensionFingerprint,
    ...(opts.sessionFilePath !== undefined
      ? { sessionFilePath: opts.sessionFilePath }
      : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.approvalMode !== undefined
      ? { approvalMode: opts.approvalMode }
      : {}),
    ...(opts.disabledToolGroups !== undefined
      ? { disabledToolGroups: opts.disabledToolGroups }
      : {}),
    ...(opts.systemPrompt !== undefined
      ? { systemPrompt: opts.systemPrompt }
      : {}),
    ...(opts.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: opts.appendSystemPrompt }
      : {}),
    ...(opts.workspaceKey !== undefined
      ? { workspaceKey: opts.workspaceKey }
      : {}),
    ...(opts.memoryMode !== undefined ? { memoryMode: opts.memoryMode } : {}),
    ...(opts.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: opts.globalMemoryEnabled }
      : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}

/**
 * Resolve the pi model a turn runs, honoring override precedence:
 *   stub mode   → the registered `pi-stub` model (e2e only)
 *   conv model  → the per-conversation Model field (`opts.model`), when it is
 *                 a real selection
 *   PI_MODEL    → the env default, for conversations with no override
 *
 * The bridge always carries a model string (`turn-start` uses
 * `conv.model ?? DEFAULT_MODEL`, and the create route stores `DEFAULT_MODEL`
 * when the user picks none), so a request that is not a prefixed
 * `providerId/modelId` selection — or that equals the `DEFAULT_MODEL` default —
 * means "no per-conversation override" and falls back to `PI_MODEL`. Any other
 * value is a real override, resolved against the runtime.
 */
async function resolvePiModel(
  runtime: ModelRuntime,
  requested: string,
): Promise<PiModel> {
  if (isPiStubMode()) {
    const stub = await getStubModel(runtime);
    if (stub) return stub;
    throw new Error("pi stub model unavailable");
  }
  const cfg = loadConfig();
  const isOverride =
    requested && requested.indexOf("/") > 0 && requested !== cfg.DEFAULT_MODEL;
  const selection = isOverride ? requested : cfg.PI_MODEL;
  const slash = selection.indexOf("/");
  if (slash <= 0) {
    throw new Error(
      `invalid pi model "${selection}": expected "providerId/modelId"`,
    );
  }
  const model = runtime.getModel(
    selection.slice(0, slash),
    selection.slice(slash + 1),
  );
  if (!model) {
    throw new Error(`pi model not found: ${selection}`);
  }
  return model;
}
