// Commit-message argument schemas shared by everything that writes a commit
// message: `git_commit`, the two merge tools' `squash` option, and the merge
// API routes behind them. Kept in one place so a subject accepted by one is
// accepted by all of them, and so the model sees a single message shape.

import { z } from 'zod';

function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export const TrailerToken = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid trailer token');

export const CommitSubject = z
	.string()
	.min(1)
	.max(200)
	.refine((s) => !hasControlCharacter(s), {
		message: 'subject must be a single line without control characters'
	});

export const CommitBody = z.string().max(100_000).optional();

export const CommitTrailers = z
	.array(
		z
			.object({
				token: TrailerToken,
				value: z
					.string()
					.max(1000)
					.refine((s) => !hasControlCharacter(s), {
						message: 'trailer value must be a single line without control characters'
					})
			})
			.strict()
	)
	.max(50)
	.optional();

/**
 * Message for the squash commit a `to-source` merge can make first. Identical
 * to `git_commit`'s message fields, so an agent that can commit already knows
 * how to squash.
 */
export const SquashArg = z
	.object({ subject: CommitSubject, body: CommitBody, trailers: CommitTrailers })
	.strict()
	.optional();

/** JSON-schema counterpart of {@link SquashArg}, for the tool declarations. */
export const SQUASH_PARAM = {
	type: 'object',
	description:
		"to-source only. Collapse this worktree's commits into ONE commit before merging. Forces a fast-forward.",
	properties: {
		subject: {
			type: 'string',
			description: 'Required single-line subject.'
		},
		body: { type: 'string', description: 'Optional body.' },
		trailers: {
			type: 'array',
			items: {
				type: 'object',
				properties: { token: { type: 'string' }, value: { type: 'string' } },
				required: ['token', 'value'],
				additionalProperties: false
			},
			description: 'Optional structured trailers.'
		}
	},
	required: ['subject'],
	additionalProperties: false
} as const;
