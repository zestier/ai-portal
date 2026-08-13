// Portal-managed models: CRUD scoped to a provider. Rows mirror the pi
// models.json model fields (see models-json.ts) plus portal-only annotations
// (purpose, enabled, sort_order).

import { getDb } from '../index';
import type { ManagedModel, ModelCost } from '$lib/types';

interface ModelRow {
	provider_id: string;
	id: string;
	name: string;
	purpose: string | null;
	enabled: number;
	cost_json: string;
	context_window: number | null;
	max_tokens: number | null;
	reasoning: number;
	input_json: string;
	thinking_map_json: string | null;
	compat_json: string | null;
	sampling_json: string | null;
	sort_order: number;
}

function parseJson(raw: string | null): unknown {
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
	const v = parseJson(raw);
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseCost(raw: string): ModelCost {
	const v = parseJson(raw);
	const o = (v && typeof v === 'object' ? v : {}) as Partial<ModelCost>;
	return {
		input: typeof o.input === 'number' ? o.input : 0,
		output: typeof o.output === 'number' ? o.output : 0,
		cacheRead: typeof o.cacheRead === 'number' ? o.cacheRead : 0,
		cacheWrite: typeof o.cacheWrite === 'number' ? o.cacheWrite : 0,
		...(Array.isArray(o.tiers) ? { tiers: o.tiers } : {})
	};
}

function parseInput(raw: string): ('text' | 'image')[] {
	const v = parseJson(raw);
	if (!Array.isArray(v)) return ['text'];
	const out: ('text' | 'image')[] = [];
	for (const entry of v) {
		if (entry === 'text' || entry === 'image') out.push(entry);
	}
	return out.length > 0 ? out : ['text'];
}

function rowToModel(r: ModelRow): ManagedModel {
	return {
		providerId: r.provider_id,
		id: r.id,
		name: r.name,
		purpose: r.purpose,
		enabled: r.enabled === 1,
		cost: parseCost(r.cost_json),
		contextWindow: r.context_window,
		maxTokens: r.max_tokens,
		reasoning: r.reasoning === 1,
		input: parseInput(r.input_json),
		thinkingLevelMap: parseJsonRecord(r.thinking_map_json) as Record<string, string | null> | null,
		compat: parseJsonRecord(r.compat_json),
		samplingParams: parseJsonRecord(r.sampling_json),
		sortOrder: r.sort_order
	};
}

export function list(providerId?: string): ManagedModel[] {
	const rows = (
		providerId
			? getDb()
					.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY sort_order ASC, id ASC')
					.all(providerId)
			: getDb().prepare('SELECT * FROM models ORDER BY sort_order ASC, id ASC').all()
	) as ModelRow[];
	return rows.map(rowToModel);
}

export function get(providerId: string, id: string): ManagedModel | null {
	const r = getDb()
		.prepare('SELECT * FROM models WHERE provider_id = ? AND id = ?')
		.get(providerId, id) as ModelRow | undefined;
	return r ? rowToModel(r) : null;
}

export interface ModelInput {
	id: string;
	name: string;
	purpose?: string | null;
	enabled?: boolean;
	cost?: Partial<ModelCost>;
	contextWindow?: number | null;
	maxTokens?: number | null;
	reasoning?: boolean;
	input?: ('text' | 'image')[];
	thinkingLevelMap?: Record<string, string | null> | null;
	compat?: Record<string, unknown> | null;
	samplingParams?: Record<string, unknown> | null;
	sortOrder?: number;
}

/**
 * Insert or replace a model row, preserving any portal-only fields (purpose,
 * enabled, sort_order) that the caller did not supply. This makes "fetch
 * catalog then upsert" safe: refreshed metadata never clobbers the operator's
 * annotations. Uses plain locals instead of a typed ModelInput so `undefined`
 * never lands on an optional property (exactOptionalPropertyTypes).
 */
export function upsert(providerId: string, input: ModelInput): ManagedModel {
	const existing = get(providerId, input.id);
	const purpose = input.purpose !== undefined ? input.purpose : (existing?.purpose ?? null);
	const enabled = input.enabled ?? existing?.enabled ?? true;
	const costIn = input.cost ?? existing?.cost;
	const contextWindow =
		input.contextWindow !== undefined ? input.contextWindow : (existing?.contextWindow ?? null);
	const maxTokens = input.maxTokens !== undefined ? input.maxTokens : (existing?.maxTokens ?? null);
	const reasoning = input.reasoning ?? existing?.reasoning ?? false;
	const inputTypes = input.input ?? existing?.input ?? ['text'];
	const thinkingMap =
		input.thinkingLevelMap !== undefined
			? input.thinkingLevelMap
			: (existing?.thinkingLevelMap ?? null);
	const compat = input.compat !== undefined ? input.compat : (existing?.compat ?? null);
	const sampling =
		input.samplingParams !== undefined ? input.samplingParams : (existing?.samplingParams ?? null);
	const sortOrder = input.sortOrder ?? existing?.sortOrder ?? 0;
	const full: ModelCost = {
		input: costIn?.input ?? 0,
		output: costIn?.output ?? 0,
		cacheRead: costIn?.cacheRead ?? 0,
		cacheWrite: costIn?.cacheWrite ?? 0,
		...(costIn?.tiers ? { tiers: costIn.tiers } : {})
	};
	getDb()
		.prepare(
			`INSERT INTO models(
			   provider_id, id, name, purpose, enabled, cost_json, context_window, max_tokens,
			   reasoning, input_json, thinking_map_json, compat_json, sampling_json, sort_order
			 )
			 VALUES (@providerId, @id, @name, @purpose, @enabled, @costJson, @contextWindow, @maxTokens,
			         @reasoning, @inputJson, @thinkingMapJson, @compatJson, @samplingJson, @sortOrder)
			 ON CONFLICT(provider_id, id) DO UPDATE SET
			   name = excluded.name,
			   purpose = excluded.purpose,
			   enabled = excluded.enabled,
			   cost_json = excluded.cost_json,
			   context_window = excluded.context_window,
			   max_tokens = excluded.max_tokens,
			   reasoning = excluded.reasoning,
			   input_json = excluded.input_json,
			   thinking_map_json = excluded.thinking_map_json,
			   compat_json = excluded.compat_json,
			   sampling_json = excluded.sampling_json,
			   sort_order = excluded.sort_order`
		)
		.run({
			providerId,
			id: input.id,
			name: input.name,
			purpose,
			enabled: enabled ? 1 : 0,
			costJson: JSON.stringify(full),
			contextWindow,
			maxTokens,
			reasoning: reasoning ? 1 : 0,
			inputJson: JSON.stringify(inputTypes),
			thinkingMapJson: thinkingMap ? JSON.stringify(thinkingMap) : null,
			compatJson: compat ? JSON.stringify(compat) : null,
			samplingJson: sampling ? JSON.stringify(sampling) : null,
			sortOrder
		});
	const m = get(providerId, input.id);
	if (!m) throw new Error(`model upsert failed: ${providerId}/${input.id}`);
	return m;
}

export function setEnabled(providerId: string, id: string, enabled: boolean): void {
	getDb()
		.prepare('UPDATE models SET enabled = ? WHERE provider_id = ? AND id = ?')
		.run(enabled ? 1 : 0, providerId, id);
}

export function remove(providerId: string, id: string): void {
	getDb().prepare('DELETE FROM models WHERE provider_id = ? AND id = ?').run(providerId, id);
}

/** Upsert many models at once (catalog fetch / pi catalog import). */
export function upsertMany(providerId: string, inputs: ModelInput[]): number {
	const tx = getDb().transaction(() => {
		for (const input of inputs) upsert(providerId, input);
	});
	tx();
	return inputs.length;
}
