// Multi-root containment: the security boundary that lets an agent write inside
// a worktree lease without prompting, WITHOUT widening what "inside the
// workspace" means for any individual root.
//
// The Phase 0 spike (see "Worktree leases" in docs/architecture.md) showed why
// this matters in practice: when a lease path is not an allowed root, an
// out-of-root write is auto-denied under best-effort/autopilot, and the
// observed sub-agent fallback was a STRAY WRITE into the shared workspace —
// exactly the collision leases exist to prevent. Hence the stray-write
// regression at the bottom of this file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPathInAnyWorkspace, isPathInWorkspace } from '../src/lib/server/permissions/workspace';
import { decideByPolicy } from '../src/lib/server/runtime/interactive-requests';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('isPathInAnyWorkspace', () => {
	let base: string;
	let primary: string;
	let lease: string;
	let sibling: string;
	let outside: string;

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-multiroot-')));
		primary = join(base, 'primary');
		lease = join(base, 'leases', '01LEASE');
		// Shares a textual prefix with `lease` — the classic containment bug.
		sibling = join(base, 'leases', '01LEASEEXTRA');
		outside = join(base, 'elsewhere');
		for (const dir of [primary, lease, sibling, outside]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(join(primary, 'a.ts'), 'x');
		writeFileSync(join(lease, 'b.ts'), 'x');
		writeFileSync(join(sibling, 'c.ts'), 'x');
		writeFileSync(join(outside, 'secret.txt'), 'x');
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it('accepts a path inside any supplied root', () => {
		const roots = [primary, lease];
		expect(isPathInAnyWorkspace(join(primary, 'a.ts'), roots)).toBe(true);
		expect(isPathInAnyWorkspace(join(lease, 'b.ts'), roots)).toBe(true);
	});

	it('rejects a path outside every supplied root', () => {
		expect(isPathInAnyWorkspace(join(outside, 'secret.txt'), [primary, lease])).toBe(false);
	});

	it('fails closed on an empty or missing root set', () => {
		// A conversation whose roots could not be resolved must not gain blanket
		// write access — it must fall through to a prompt.
		expect(isPathInAnyWorkspace(join(primary, 'a.ts'), [])).toBe(false);
		expect(isPathInAnyWorkspace(join(primary, 'a.ts'), null)).toBe(false);
		expect(isPathInAnyWorkspace(join(primary, 'a.ts'), undefined)).toBe(false);
	});

	it('does not treat a prefix-sharing sibling root as contained', () => {
		// `/…/leases/01LEASEEXTRA` must not match a root of `/…/leases/01LEASE`.
		expect(isPathInAnyWorkspace(join(sibling, 'c.ts'), [lease])).toBe(false);
		// …and is accepted only when it is genuinely one of the roots.
		expect(isPathInAnyWorkspace(join(sibling, 'c.ts'), [lease, sibling])).toBe(true);
	});

	it('does not let a symlink inside one root escape to a non-root', () => {
		symlinkSync(outside, join(lease, 'escape'));
		expect(isPathInAnyWorkspace(join(lease, 'escape', 'secret.txt'), [primary, lease])).toBe(false);
	});

	it('widening the set never loosens any individual root', () => {
		// Whatever a path's verdict is against one root alone, adding unrelated
		// roots must not change it from false to true for that root's sake.
		const target = join(outside, 'secret.txt');
		expect(isPathInWorkspace(target, primary)).toBe(false);
		expect(isPathInWorkspace(target, lease)).toBe(false);
		expect(isPathInAnyWorkspace(target, [primary, lease])).toBe(false);
	});

	it('tolerates unresolvable entries without discarding the usable ones', () => {
		const roots = [join(base, 'does-not-exist'), lease];
		expect(isPathInAnyWorkspace(join(lease, 'b.ts'), roots)).toBe(true);
	});
});

describe('decideByPolicy multi-root auto-approval', () => {
	let base: string;
	let primary: string;
	let lease: string;
	let outside: string;

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-policy-roots-')));
		primary = join(base, 'primary');
		lease = join(base, 'leases', '01LEASE');
		outside = join(base, 'elsewhere');
		for (const dir of [primary, lease, outside]) mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it('auto-approves a write inside the primary workspace', () => {
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				scopeKey: join(primary, 'new.ts'),
				workspaceRoots: [primary, lease]
			})
		).toBe('approved');
	});

	it('auto-approves a write inside a held lease', () => {
		// The whole point of Phase 2: an agent working in a lease must not be
		// forced through a prompt for every file it touches.
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				scopeKey: join(lease, 'new.ts'),
				workspaceRoots: [primary, lease]
			})
		).toBe('approved');
	});

	it('still prompts for a write outside every root', () => {
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				scopeKey: join(outside, 'new.ts'),
				workspaceRoots: [primary, lease]
			})
		).toBe('ask');
	});

	it('prompts when no roots could be resolved', () => {
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				scopeKey: join(primary, 'new.ts'),
				workspaceRoots: []
			})
		).toBe('ask');
	});

	it('regression: a lease is not writable until it is actually a root', () => {
		// This is the Phase 0 stray-write failure mode. Before the lease is in the
		// root set, a write there is NOT auto-approved — which under best-effort
		// becomes an auto-deny, and the observed agent fallback was to write into
		// the shared workspace instead. Adding the lease to the set is what makes
		// leases usable at all.
		const target = join(lease, 'work.ts');
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				scopeKey: target,
				workspaceRoots: [primary]
			})
		).toBe('ask');
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				scopeKey: target,
				workspaceRoots: [primary, lease]
			})
		).toBe('approved');
	});
});
