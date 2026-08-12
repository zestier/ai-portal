import type { MemoryMode } from '$lib/types';
import { getDb } from '$lib/server/db';

export interface MemoryProfileDefinition {
	mode: MemoryMode;
	label: string;
	instructions: string;
	primitives: string[];
	validationFocus: string[];
}

export interface CustomMemoryProfile {
	id: number;
	userId: number;
	name: string;
	description: string;
	instructions: string;
	schema: unknown;
	status: 'open' | 'archived';
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
}

interface CustomProfileRow {
	id: number;
	user_id: number;
	name: string;
	description: string;
	instructions: string;
	schema_json: string;
	status: 'open' | 'archived';
	created_at: number;
	updated_at: number;
	archived_at: number | null;
}

const baseInstructions =
	'Use durable memory as explicit continuity state. Query memory tools when you need prior details that are absent from the packet, then always answer the user in the same turn — a recall call is never a substitute for responding. Treat unknown as unknown.';

const BUILT_IN_PROFILES: Record<MemoryMode, MemoryProfileDefinition> = {
	off: {
		mode: 'off',
		label: 'Off',
		instructions: 'Memory is disabled for this conversation.',
		primitives: [],
		validationFocus: []
	},
	lightweight: {
		mode: 'lightweight',
		label: 'Lightweight',
		instructions: baseInstructions,
		primitives: ['entity', 'attribute', 'directive', 'open_loop', 'event'],
		validationFocus: ['provenance', 'low_confidence', 'secret_filtering']
	},
	project: {
		mode: 'project',
		label: 'Project',
		instructions: `${baseInstructions} Repository and command memories are historical until revalidated against current files or tool output.`,
		primitives: ['entity', 'attribute', 'directive', 'open_loop', 'event'],
		validationFocus: ['historical_repository_truth', 'secret_filtering', 'stale_observations']
	},
	story: {
		mode: 'story',
		label: 'Story',
		instructions: `${baseInstructions} Preserve character, location, object, relationship, world-rule, and plot continuity.`,
		primitives: [
			'directive',
			'character',
			'location',
			'object',
			'world_rule',
			'open_loop',
			'event'
		],
		validationFocus: ['location_conflicts', 'object_continuity', 'relationship_continuity']
	},
	strict: {
		mode: 'strict',
		label: 'Strict',
		instructions: `${baseInstructions} Strictly validate timeline, clues, visibility, secrets, and per-character knowledge before making continuity-sensitive claims.`,
		primitives: [
			'directive',
			'timeline',
			'clue',
			'knowledge',
			'secret',
			'fact',
			'event',
			'open_loop'
		],
		validationFocus: ['timeline', 'clues', 'visibility', 'secrets', 'character_knowledge']
	}
};

export function getMemoryProfile(mode: MemoryMode): MemoryProfileDefinition {
	return BUILT_IN_PROFILES[mode];
}

export function listMemoryProfiles(): MemoryProfileDefinition[] {
	return Object.values(BUILT_IN_PROFILES);
}

export function listCustomProfiles(
	userId: number,
	opts: { status?: 'open' | 'archived' | 'all' } = {}
): CustomMemoryProfile[] {
	const status = opts.status ?? 'open';
	const rows =
		status === 'all'
			? (getDb()
					.prepare(
						`SELECT * FROM memory_custom_profiles
						  WHERE user_id = ?
						  ORDER BY status ASC, updated_at DESC`
					)
					.all(userId) as CustomProfileRow[])
			: (getDb()
					.prepare(
						`SELECT * FROM memory_custom_profiles
						  WHERE user_id = ? AND status = ?
						  ORDER BY updated_at DESC`
					)
					.all(userId, status) as CustomProfileRow[]);
	return rows.map(rowToCustomProfile);
}

export function createCustomProfile(
	userId: number,
	input: {
		name: string;
		description?: string;
		instructions: string;
		schema: unknown;
	}
): CustomMemoryProfile {
	const now = Date.now();
	const info = getDb()
		.prepare(
			`INSERT INTO memory_custom_profiles(
			   user_id, name, description, instructions, schema_json, status,
			   created_at, updated_at, archived_at
			 ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, NULL)`
		)
		.run(
			userId,
			input.name,
			input.description ?? '',
			input.instructions,
			safeJson(input.schema),
			now,
			now
		);
	const id = Number(info.lastInsertRowid);
	return rowToCustomProfile(
		getDb().prepare('SELECT * FROM memory_custom_profiles WHERE id = ?').get(id) as CustomProfileRow
	);
}

export function updateCustomProfile(
	id: number,
	userId: number,
	patch: {
		name: string;
		description?: string;
		instructions: string;
		schema: unknown;
	}
): CustomMemoryProfile | null {
	const result = getDb()
		.prepare(
			`UPDATE memory_custom_profiles
			    SET name = ?, description = ?, instructions = ?, schema_json = ?, status = 'open',
			        archived_at = NULL, updated_at = ?
			  WHERE id = ? AND user_id = ?`
		)
		.run(
			patch.name,
			patch.description ?? '',
			patch.instructions,
			safeJson(patch.schema),
			Date.now(),
			id,
			userId
		);
	if (result.changes === 0) return null;
	return rowToCustomProfile(
		getDb()
			.prepare('SELECT * FROM memory_custom_profiles WHERE id = ? AND user_id = ?')
			.get(id, userId) as CustomProfileRow
	);
}

export function archiveCustomProfile(id: number, userId: number): boolean {
	const now = Date.now();
	const result = getDb()
		.prepare(
			`UPDATE memory_custom_profiles
			    SET status = 'archived', archived_at = ?, updated_at = ?
			  WHERE id = ? AND user_id = ? AND status != 'archived'`
		)
		.run(now, now, id, userId);
	return result.changes > 0;
}

function rowToCustomProfile(row: CustomProfileRow): CustomMemoryProfile {
	return {
		id: row.id,
		userId: row.user_id,
		name: row.name,
		description: row.description,
		instructions: row.instructions,
		schema: parseJson(row.schema_json, {}),
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		archivedAt: row.archived_at
	};
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return JSON.stringify(String(value));
	}
}

function parseJson(raw: string, fallback: unknown): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}
