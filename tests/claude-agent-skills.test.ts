import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyClaudeAgentSkillArchive } from '../src/lib/server/providers/claude-agent-skills';

describe('verifyClaudeAgentSkillArchive', () => {
	it('accepts bytes matching the pinned SHA-256 digest', () => {
		const archive = Buffer.from('expected archive');
		const digest = createHash('sha256').update(archive).digest('hex');

		expect(() => verifyClaudeAgentSkillArchive('caveman', archive, digest)).not.toThrow();
	});

	it('rejects archive bytes that do not match the pinned digest', () => {
		expect(() =>
			verifyClaudeAgentSkillArchive('caveman', Buffer.from('tampered archive'), '0'.repeat(64))
		).toThrow('Downloaded caveman archive failed its SHA-256 integrity check.');
	});
});
