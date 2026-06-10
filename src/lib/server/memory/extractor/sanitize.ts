/**
 * Post-extraction patch sanitization: strips proposed memory items that look
 * like secrets/credentials, and canonicalizes proposed entity keys against the
 * turn's initial packet so the model can't mint a near-duplicate entity (a bare
 * name vs a fuller name, a casing/alias variant). Shared by both the single-shot
 * and tool-calling extractors via their result path.
 */
import type { Diagnostic } from './types';
import type { MemoryPatchProposal, TurnMemoryPacket } from '../engine';
import { containsSensitiveText } from './utils';
export function sanitizePatch(
	patch: MemoryPatchProposal,
	initialPacket?: TurnMemoryPacket
): {
	patch: MemoryPatchProposal;
	diagnostics: Diagnostic[];
} {
	const diagnostics: Diagnostic[] = [];
	let removed = 0;
	const keep = <T>(items: T[] | undefined): T[] | undefined => {
		if (!items) return undefined;
		const filtered = items.filter((item) => {
			const safe = !containsSensitiveValue(item);
			if (!safe) removed++;
			return safe;
		});
		return filtered.length > 0 ? filtered : undefined;
	};
	const keepResolutions = (
		resolutions: MemoryPatchProposal['resolveOpenLoops']
	): MemoryPatchProposal['resolveOpenLoops'] => {
		if (!resolutions) return undefined;
		const cleaned = resolutions
			// An id that itself looks like a secret can't reference a real loop,
			// so drop it (and count it as removed); ids are otherwise opaque.
			.filter((resolution) => {
				const safe = !containsSensitiveValue(resolution.id);
				if (!safe) removed++;
				return safe;
			})
			// Keep the resolution (id + status) so the loop is still pruned, but
			// strip a reason that looks sensitive rather than dropping the whole
			// resolution.
			.map((resolution) => {
				if (resolution.reason && containsSensitiveValue(resolution.reason)) {
					removed++;
					return { id: resolution.id, status: resolution.status };
				}
				return resolution;
			});
		return cleaned.length > 0 ? cleaned : undefined;
	};
	const sanitized = canonicalizeEntityKeys(
		{
			entities: keep(patch.entities),
			events: keep(patch.events),
			facts: keep(patch.facts),
			openLoops: keep(patch.openLoops),
			forgetFacts: patch.forgetFacts
		},
		initialPacket
	);
	if (sanitized.remapped > 0) {
		diagnostics.push({
			severity: 'info',
			code: 'entity_keys_canonicalized',
			message: `${sanitized.remapped} proposed entity reference(s) were canonicalized to avoid duplicate entities.`
		});
	}
	if (sanitized.merged > 0) {
		diagnostics.push({
			severity: 'info',
			code: 'duplicate_entities_merged',
			message: `${sanitized.merged} duplicate proposed entity/entities were merged by type and display name.`
		});
	}
	const nextPatch: MemoryPatchProposal = {
		entities: sanitized.patch.entities,
		events: sanitized.patch.events,
		facts: sanitized.patch.facts,
		openLoops: sanitized.patch.openLoops,
		// Forget targets carry an opaque factId or an entityKey+predicate selector
		// (no free text to redact); pass them through with entityKeys already
		// canonicalized so a forget aimed at an alias still resolves the same fact.
		forgetFacts: sanitized.patch.forgetFacts,
		// Resolutions only reference an existing loop id plus a short free-text
		// reason. Don't drop the whole resolution if the reason trips the secret
		// filter — that would silently leave the loop open. Instead strip just
		// the offending reason (keeping id + status) so the loop is still pruned.
		resolveOpenLoops: keepResolutions(patch.resolveOpenLoops),
		// Keep-alive ids are opaque open-loop ids (no free text), so they carry
		// nothing to redact; pass them through so liveness sees the full touched
		// set. An id that itself looks like a secret can't reference a real loop.
		keepOpenLoops: patch.keepOpenLoops?.filter((id) => {
			const safe = !containsSensitiveValue(id);
			if (!safe) removed++;
			return safe;
		})
	};
	if (removed > 0) {
		diagnostics.push({
			severity: 'warning',
			code: 'sensitive_memory_items_removed',
			message: `${removed} proposed memory item(s) were removed because they looked like secrets or credentials.`
		});
	}
	return { patch: nextPatch, diagnostics };
}

function canonicalizeEntityKeys(
	patch: MemoryPatchProposal,
	initialPacket?: TurnMemoryPacket
): { patch: MemoryPatchProposal; remapped: number; merged: number } {
	const aliases = new Map<string, string>();
	const existingByTypedName = new Map<string, string>();
	const existingByName = new Map<string, string | null>();
	const existingByKeyTail = new Map<string, string | null>();
	const knownEntities = [
		...(initialPacket?.entities ?? []).map((entity) => ({
			entityKey: entity.entityKey,
			entityType: entity.entityType,
			displayName: entity.displayName
		})),
		...(initialPacket?.entityIndex ?? []).map((entry) => ({
			entityKey: entry.entityKey,
			entityType: entry.entityType,
			displayName: entry.displayName
		}))
	];
	for (const entity of knownEntities) {
		addAlias(aliases, entity.entityKey, entity.entityKey);
		const typedName = typedNameKey(entity.entityType, entity.displayName);
		if (typedName) existingByTypedName.set(typedName, entity.entityKey);
		setUniqueAlias(existingByName, entity.displayName, entity.entityKey);
		setUniqueAlias(
			existingByKeyTail,
			entity.entityKey.split(/[.:/_-]/).at(-1) ?? '',
			entity.entityKey
		);
	}
	for (const [alias, entityKey] of [...existingByName, ...existingByKeyTail]) {
		if (entityKey) aliases.set(alias, entityKey);
	}

	const proposedByTypedName = new Map<string, string>();
	const entityKeyMap = new Map<string, string>();
	let remapped = 0;
	let merged = 0;
	const canonicalKeyForEntity = (entity: NonNullable<MemoryPatchProposal['entities']>[number]) => {
		const existing =
			aliases.get(normalizedName(entity.entityKey)) ??
			existingByTypedName.get(typedNameKey(entity.entityType, entity.displayName)) ??
			existingByName.get(normalizedName(entity.displayName)) ??
			null;
		if (existing) return existing;
		const typedName = typedNameKey(entity.entityType, entity.displayName);
		if (typedName) {
			const proposed = proposedByTypedName.get(typedName);
			if (proposed) return proposed;
			proposedByTypedName.set(typedName, entity.entityKey);
		}
		return entity.entityKey;
	};

	const entities: NonNullable<MemoryPatchProposal['entities']> = [];
	const seenEntities = new Set<string>();
	for (const entity of patch.entities ?? []) {
		const canonicalKey = canonicalKeyForEntity(entity);
		entityKeyMap.set(entity.entityKey, canonicalKey);
		if (canonicalKey !== entity.entityKey) remapped++;
		if (seenEntities.has(canonicalKey)) {
			merged++;
			continue;
		}
		seenEntities.add(canonicalKey);
		entities.push({ ...entity, entityKey: canonicalKey });
	}

	const rewriteKey = (key: string | undefined): string | undefined => {
		if (!key) return undefined;
		const canonical = entityKeyMap.get(key) ?? aliases.get(normalizedName(key));
		if (canonical && canonical !== key) {
			remapped++;
			return canonical;
		}
		return canonical ?? key;
	};

	const next: MemoryPatchProposal = {
		events: patch.events?.map((event) => ({ ...event, entityKey: rewriteKey(event.entityKey) })),
		facts: patch.facts?.map((fact) => ({ ...fact, entityKey: rewriteKey(fact.entityKey) })),
		openLoops: patch.openLoops?.map((loop) => ({
			...loop,
			relatedEntityKeys: loop.relatedEntityKeys?.map((key) => rewriteKey(key) ?? key)
		})),
		forgetFacts: patch.forgetFacts?.map((target) => ({
			...target,
			entityKey: rewriteKey(target.entityKey)
		}))
	};
	next.entities = entities.length > 0 ? entities : undefined;
	return { patch: next, remapped, merged };
}

function addAlias(aliases: Map<string, string>, raw: string, entityKey: string): void {
	const alias = normalizedName(raw);
	if (alias) aliases.set(alias, entityKey);
}

function setUniqueAlias(aliases: Map<string, string | null>, raw: string, entityKey: string): void {
	const alias = normalizedName(raw);
	if (!alias) return;
	const prior = aliases.get(alias);
	aliases.set(alias, prior === undefined ? entityKey : prior === entityKey ? prior : null);
}

function typedNameKey(entityType: string, displayName: string): string {
	const type = normalizedName(entityType);
	const name = normalizedName(displayName);
	return type && name ? `${type}:${name}` : '';
}

function normalizedName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/['’]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function containsSensitiveValue(value: unknown): boolean {
	const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
	return containsSensitiveText(text);
}
