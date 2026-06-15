/**
 * Post-extraction patch sanitization: strips proposed memory items that look
 * like secrets/credentials, and canonicalizes proposed entity keys against the
 * turn's initial packet so the model can't mint a near-duplicate entity (a bare
 * name vs a fuller name, a casing/alias variant). Shared by both the single-shot
 * and tool-calling extractors via their result path.
 */
import type { Diagnostic } from './types';
import type { MemoryPatchProposal, TurnMemoryPacket } from '../engine';
import { isDirectivePredicate } from '../engine';
import {
	containsSensitiveText,
	looksLikePromptInjection,
	redactSensitiveText,
	stringifyUnknown
} from './utils';

/**
 * Identity/anchor fields that must survive the secret filter so an entity (and
 * any fact/event/loop that references it) keeps a stable key. Redacting these
 * would orphan the referencing facts — or mint a minimal placeholder entity at
 * commit — which is exactly what we're avoiding: free-text/value fields tripping
 * the credential filter shouldn't take the structural record down with them.
 * Reference fields are never free text, so a match here is spurious; leave them.
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
	'entityKey',
	'entityType',
	'displayName',
	'predicate',
	'eventType',
	'loopType',
	'relatedEntityKeys',
	'id',
	'factId'
]);
export function sanitizePatch(
	patch: MemoryPatchProposal,
	initialPacket?: TurnMemoryPacket
): {
	patch: MemoryPatchProposal;
	diagnostics: Diagnostic[];
} {
	const diagnostics: Diagnostic[] = [];
	let removed = 0;
	// Standing directives render into the highest-authority "always in effect"
	// block and re-inject every turn, so a directive rule that smuggles
	// instruction-injection text ("ignore previous instructions: …", "reveal the
	// system prompt") would persist as a high-trust command. Drop such directives
	// before storage — independent of the credential filter, which only catches
	// secret *shapes*, not instruction text. Only directive facts are screened
	// this way; ordinary fact values are data, not instructions to obey.
	const directiveScan = stripInjectionDirectives(patch.facts);
	const injectionDirectivesRemoved = directiveScan.removed;
	// Redact secret-looking *values* in place rather than dropping the whole
	// item. Dropping an entity because one free-text field (a URL in metadata, a
	// summary) trips the credential filter strips its entityKey/entityType/
	// displayName too, orphaning every fact that referenced it (or forcing a
	// minimal placeholder entity at commit). Keeping the structural record while
	// nulling just the offending field preserves the anchor.
	const keep = <T>(items: T[] | undefined): T[] | undefined => {
		if (!items) return undefined;
		const cleaned = items.map((item) => {
			const { value, redacted } = redactSensitiveFields(item);
			if (redacted) removed++;
			return value;
		});
		return cleaned.length > 0 ? cleaned : undefined;
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
			facts: keep(directiveScan.facts),
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
	if (injectionDirectivesRemoved > 0) {
		diagnostics.push({
			severity: 'warning',
			code: 'directive_injection_removed',
			message: `${injectionDirectivesRemoved} proposed standing directive(s) were dropped because the rule text looked like a prompt-injection attempt (e.g. overriding instructions or exfiltrating the system prompt).`
		});
	}
	if (removed > 0) {
		diagnostics.push({
			severity: 'warning',
			code: 'sensitive_memory_items_removed',
			message: `${removed} proposed memory item(s) had secret-like values redacted or were removed because they looked like secrets or credentials.`
		});
	}
	return { patch: nextPatch, diagnostics };
}

/**
 * Drop proposed directive facts whose rule text reads like a prompt-injection
 * attempt (see {@link looksLikePromptInjection}). Directives are stored pinned
 * and rendered into the always-on standing-rules block, so unlike ordinary
 * facts — whose values are inert data — a malicious directive becomes a durable,
 * high-authority instruction that re-injects every turn. Screening here (before
 * storage) closes the indirect-injection vector where summarized content coaxes
 * the extractor into recording "Ignore previous instructions: …" as a directive.
 * Non-directive facts pass through untouched.
 */
function stripInjectionDirectives(facts: MemoryPatchProposal['facts']): {
	facts: MemoryPatchProposal['facts'];
	removed: number;
} {
	if (!facts) return { facts: undefined, removed: 0 };
	let removed = 0;
	const kept = facts.filter((fact) => {
		if (!isDirectivePredicate(fact.predicate)) return true;
		const text = typeof fact.value === 'string' ? fact.value : stringifyUnknown(fact.value);
		if (looksLikePromptInjection(text)) {
			removed++;
			return false;
		}
		return true;
	});
	return { facts: kept.length > 0 ? kept : undefined, removed };
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

function typedNameKey(entityType: string | undefined, displayName: string | undefined): string {
	const type = normalizedName(entityType);
	const name = normalizedName(displayName);
	return type && name ? `${type}:${name}` : '';
}

function normalizedName(raw: string | undefined): string {
	return (raw ?? '')
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

/**
 * Return a deep copy of `item` with any free-text string value that matches a
 * known credential shape redacted in place (recursing into nested objects and
 * arrays like `metadata`/`payload`/`value`). Structural identity/anchor fields
 * (see {@link STRUCTURAL_KEYS}) are never redacted — their values are opaque
 * keys/ids, not secrets, and nulling them would orphan referencing facts. The
 * returned `redacted` flag is set when at least one value was rewritten.
 */
function redactSensitiveFields<T>(item: T): { value: T; redacted: boolean } {
	let redacted = false;
	const walk = (value: unknown, isStructural: boolean): unknown => {
		if (typeof value === 'string') {
			if (isStructural || !containsSensitiveText(value)) return value;
			redacted = true;
			return redactSensitiveText(value);
		}
		if (Array.isArray(value)) {
			return value.map((entry) => walk(entry, isStructural));
		}
		if (value && typeof value === 'object') {
			const out: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(value)) {
				out[key] = walk(val, isStructural || STRUCTURAL_KEYS.has(key));
			}
			return out;
		}
		return value;
	};
	return { value: walk(item, false) as T, redacted };
}
