// Catalog service: the server-side operations behind the Models settings tab.
// Each mutation persists to the portal DB, rewrites DATA_DIR/models.json, and
// reloads it into the shared pi ModelRuntime via syncModelRuntime().

import * as providersRepo from '../db/repos/providers';
import * as modelsRepo from '../db/repos/models';
import { fetchProviderCatalog } from './fetch-catalog';
import { syncModelRuntime } from '../pi';
import type { ManagedModel, ManagedProvider } from '$lib/types';

export interface CatalogSnapshot {
	providers: ManagedProvider[];
	models: ManagedModel[];
}

export function getCatalog(): CatalogSnapshot {
	return { providers: providersRepo.list(), models: modelsRepo.list() };
}

/**
 * `providerId/modelId` strings for every enabled model on an enabled provider —
 * the option set offered by model pickers (chat header, prompt templates,
 * memory extractor / adversary selects). Portal-managed catalog only.
 */
export function listEnabledModelOptions(): string[] {
	const enabledProviders = new Set(
		providersRepo
			.list()
			.filter((p) => p.enabled)
			.map((p) => p.id)
	);
	return modelsRepo
		.list()
		.filter((m) => m.enabled && enabledProviders.has(m.providerId))
		.map((m) => `${m.providerId}/${m.id}`)
		.sort();
}

/** Upsert a provider and reload the runtime. */
export async function saveProvider(input: providersRepo.ProviderInput): Promise<ManagedProvider> {
	const p = providersRepo.upsert(input);
	await syncModelRuntime();
	return p;
}

/** Remove a provider (cascades its models) and reload the runtime. */
export async function deleteProvider(id: string): Promise<void> {
	providersRepo.remove(id);
	await syncModelRuntime();
}

/** Set or clear (empty string) a provider's API key, then reload the runtime. */
export async function saveProviderKey(id: string, apiKey: string): Promise<void> {
	if (!apiKey) providersRepo.clearApiKey(id);
	else {
		try {
			providersRepo.setApiKey(id, apiKey);
		} catch (e) {
			if (e instanceof Error && e.message.includes('ENCRYPTION_KEY')) {
				throw new Error(
					'Cannot store an API key: ENCRYPTION_KEY is not configured. Add ENCRYPTION_KEY ' +
						'to the server environment (e.g. `openssl rand -base64 32`).'
				);
			}
			throw e;
		}
	}
	await syncModelRuntime();
}

/** Upsert a model and reload the runtime. */
export async function saveModel(
	providerId: string,
	input: modelsRepo.ModelInput
): Promise<ManagedModel> {
	const m = modelsRepo.upsert(providerId, input);
	await syncModelRuntime();
	return m;
}

/** Delete a model and reload the runtime. */
export async function deleteModel(providerId: string, id: string): Promise<void> {
	modelsRepo.remove(providerId, id);
	await syncModelRuntime();
}

export interface FetchAndImportResult {
	source: string;
	imported: number;
	models: ManagedModel[];
}

/**
 * Query the provider's backend for its model list and upsert the results into
 * the portal catalog (annotations like purpose/enabled are preserved), then
 * reload the runtime.
 */
export async function fetchAndImportCatalog(providerId: string): Promise<FetchAndImportResult> {
	const provider = providersRepo.get(providerId);
	if (!provider) throw new Error(`Provider "${providerId}" not found.`);
	const { models, source } = await fetchProviderCatalog(provider);
	const imported = modelsRepo.upsertMany(
		providerId,
		models.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
			...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
			...(m.cost ? { cost: m.cost } : {})
		}))
	);
	await syncModelRuntime();
	return { source, imported, models: modelsRepo.list(providerId) };
}

/** Import the runtime's current (bundled) catalog for a built-in provider. */
export async function importFromPiCatalog(providerId: string): Promise<{ imported: number }> {
	const runtime = await import('../pi').then((m) => m.getModelRuntime());
	const piModels = runtime.getModels(providerId);
	const imported = modelsRepo.upsertMany(
		providerId,
		piModels.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning,
			input: m.input,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			cost: m.cost
		}))
	);
	await syncModelRuntime();
	return { imported };
}
