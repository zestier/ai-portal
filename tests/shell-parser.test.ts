import { describe, it, expect } from 'vitest';
import { parseShellCommand, detectShellMisuse } from '../src/lib/server/permissions/shell-parser';

function ok(cmd: string) {
	const r = parseShellCommand(cmd);
	if (r.kind !== 'parsed') throw new Error(`expected parsed, got unsafe: ${r.reason}`);
	return r.segments;
}

function unsafe(cmd: string) {
	const r = parseShellCommand(cmd);
	if (r.kind !== 'unsafe') throw new Error(`expected unsafe, got parsed`);
	return r.reason;
}

describe('parseShellCommand — happy path', () => {
	it('parses a single command into one segment', () => {
		expect(ok('ls')).toEqual([{ argv: ['ls'], followingOp: null }]);
		expect(ok('git status -s')).toEqual([{ argv: ['git', 'status', '-s'], followingOp: null }]);
	});

	it('honors quoted arguments', () => {
		expect(ok('echo "hello world"')).toEqual([
			{ argv: ['echo', 'hello world'], followingOp: null }
		]);
		expect(ok("echo 'a b'")).toEqual([{ argv: ['echo', 'a b'], followingOp: null }]);
	});

	it('splits on &&, ||, ;, |', () => {
		expect(ok('a && b')).toEqual([
			{ argv: ['a'], followingOp: '&&' },
			{ argv: ['b'], followingOp: null }
		]);
		expect(ok('a || b ; c | d')).toEqual([
			{ argv: ['a'], followingOp: '||' },
			{ argv: ['b'], followingOp: ';' },
			{ argv: ['c'], followingOp: '|' },
			{ argv: ['d'], followingOp: null }
		]);
	});

	it('keeps flags with equals sign intact', () => {
		expect(ok('ls --color=auto')).toEqual([{ argv: ['ls', '--color=auto'], followingOp: null }]);
	});
});

describe('parseShellCommand — fd-dup redirection carve-out', () => {
	it('elides `2>&1` so the command parses normally', () => {
		expect(ok('pnpm check 2>&1')).toEqual([{ argv: ['pnpm', 'check'], followingOp: null }]);
		expect(ok('pnpm check 2>&1 | tail -40')).toEqual([
			{ argv: ['pnpm', 'check'], followingOp: '|' },
			{ argv: ['tail', '-40'], followingOp: null }
		]);
	});

	it('elides `>&2` (default left fd) and `>&-` (close)', () => {
		expect(ok('echo hi >&2')).toEqual([{ argv: ['echo', 'hi'], followingOp: null }]);
		expect(ok('cmd 2>&-')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd >&-')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd 1>&2')).toEqual([{ argv: ['cmd'], followingOp: null }]);
	});

	it('elides multiple fd-dup redirects on the same command', () => {
		expect(ok('cmd 2>&1 >&2')).toEqual([{ argv: ['cmd'], followingOp: null }]);
	});

	it('preserves a digit that is space-separated from the redirect', () => {
		// `tail -n 2 >&1` — the `2` is an argument to `-n`; only `>&1` is elided.
		expect(ok('tail -n 2 >&1')).toEqual([{ argv: ['tail', '-n', '2'], followingOp: null }]);
	});

	it('does not elide fd-dup-looking text that lacks whitespace bounds', () => {
		// Tightly-quoted `"2>&1"` has no whitespace inside the quotes,
		// so our regex doesn't match. shell-quote treats the whole
		// `"2>&1"` as one string literal, so the argv arg is preserved
		// verbatim with no elision and no refusal.
		expect(ok('echo "2>&1"')).toEqual([{ argv: ['echo', '2>&1'], followingOp: null }]);
		expect(ok("echo '2>&1'")).toEqual([{ argv: ['echo', '2>&1'], followingOp: null }]);
	});

	it('rewrites in-quote occurrences that happen to be whitespace-bounded, but does not cause unsafe approval', () => {
		// Inside the quoted string, the `2>&1` IS surrounded by whitespace,
		// so the regex matches. The substitution is safe: the sentinel
		// contains no shell metacharacters, the quoted string remains a
		// single argv element, and the only observable difference is the
		// string's contents. The redirect is data inside a quote either
		// way — no FS effect.
		const segs = ok('echo "foo 2>&1 bar"');
		expect(segs).toHaveLength(1);
		expect(segs[0].argv[0]).toBe('echo');
		// The argv arg is a single string; its content is altered but
		// safety is preserved.
		expect(segs[0].argv).toHaveLength(2);
		expect(segs[0].argv[1]).not.toContain('>&');
	});

	it('does not drop a caller token that matches the old fixed sentinel literal', () => {
		// The elision marker is now a per-parse random nonce that is
		// guaranteed absent from the command, so a caller passing the old
		// fixed literal `__ZAP_SAFE_REDIR__` keeps it as a normal argv
		// token — the matched argv can never have a caller token silently
		// dropped.
		expect(ok('echo __ZAP_SAFE_REDIR__')).toEqual([
			{ argv: ['echo', '__ZAP_SAFE_REDIR__'], followingOp: null }
		]);
	});

	it('refuses multi-digit fds rather than mis-eliding them', () => {
		// `12>&1` — preceding char of `2>&1` is `1`, not whitespace. No
		// elision. The `>` op then surfaces → refused.
		expect(unsafe('cmd 12>&1')).toMatch(/redirection/);
		// `2>&12` — char after `1` is `2`, not whitespace/EOL. No
		// elision. Refused.
		expect(unsafe('cmd 2>&12')).toMatch(/redirection/);
	});

	it('refuses fd-dup glued to an adjacent command token', () => {
		// `cmd>&1` (no space) — preceding char is `d`, not whitespace.
		// Not elided. Refused.
		expect(unsafe('cmd>&1')).toMatch(/redirection/);
	});

	it('refuses fd-dup glued directly to a pipe (no whitespace before |)', () => {
		// `cmd 2>&1|tail` — char after `1` is `|`, not whitespace/EOL.
		// Not elided. Refused. (Conservative; users can add a space.)
		expect(unsafe('cmd 2>&1|tail')).toMatch(/redirection/);
	});

	it('elides /dev/null write redirects', () => {
		expect(ok('cmd >/dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd > /dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd 2>/dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd >>/dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd &>/dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
	});

	it('elides /dev/null input redirects', () => {
		expect(ok('cmd </dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd 0</dev/null')).toEqual([{ argv: ['cmd'], followingOp: null }]);
	});

	it('combines /dev/null and fd-dup in the common idiom', () => {
		expect(ok('cmd >/dev/null 2>&1')).toEqual([{ argv: ['cmd'], followingOp: null }]);
		expect(ok('cmd >/dev/null 2>&1 | tail')).toEqual([
			{ argv: ['cmd'], followingOp: '|' },
			{ argv: ['tail'], followingOp: null }
		]);
	});

	it('refuses redirects to paths that merely look like /dev/null', () => {
		// Trailing chars defeat the lookahead.
		expect(unsafe('cmd >/dev/nullx')).toMatch(/redirection/);
		expect(unsafe('cmd >/dev/null/extra')).toMatch(/redirection/);
		// A real file path is still refused.
		expect(unsafe('cmd >/tmp/out')).toMatch(/redirection/);
	});

	it('refuses file-target redirects (not the carve-out)', () => {
		expect(unsafe('cmd 2> err.log')).toMatch(/redirection/);
		expect(unsafe('cmd > out.log')).toMatch(/redirection/);
		expect(unsafe('cmd >> out.log')).toMatch(/redirection/);
		expect(unsafe('cmd < in.txt')).toMatch(/redirection/);
		expect(unsafe('cmd <&0')).toMatch(/redirection/);
	});

	it('refuses elision that would leave an empty pipeline segment', () => {
		// `cmd | 2>&1 | tail` — middle segment is just the redirect; after
		// elision the pipeline has an empty segment.
		expect(unsafe('cmd | 2>&1 | tail')).toMatch(/empty segment|trailing|operator/);
	});

	it('refuses command substitutions / heredocs that happen to contain fd-dup', () => {
		// Even though elision may fire inside the body, the surrounding
		// unsafe ops (`$`, `(`, `` ` ``, `<<`) still surface and force a
		// refusal.
		expect(unsafe('cmd $(echo hi 2>&1)')).toMatch(/substitution|subshell|variable/);
		expect(unsafe('cmd `echo hi 2>&1`')).toMatch(/backtick/);
	});
});

describe('parseShellCommand — unsafe inputs', () => {
	it('rejects empty / whitespace-only', () => {
		expect(unsafe('')).toMatch(/empty/);
		expect(unsafe('   ')).toMatch(/empty/);
	});

	it('rejects $(...) command substitution', () => {
		// shell-quote, when given an env callback, lumps $(...) into the
		// same variable-expansion code path. Either reason is fine — what
		// matters is we refuse to auto-approve it.
		expect(unsafe('cat $(echo a)')).toMatch(/substitution|subshell|variable/);
	});

	it('rejects backtick command substitution', () => {
		expect(unsafe('cat `echo a`')).toMatch(/backtick/);
	});

	it('rejects redirection', () => {
		expect(unsafe('echo hi > out.txt')).toMatch(/redirection/);
		expect(unsafe('cat < in.txt')).toMatch(/redirection/);
		expect(unsafe('echo hi >> out.txt')).toMatch(/redirection/);
		// File-target stderr redirect is NOT the carve-out.
		expect(unsafe('cmd 2> err.log')).toMatch(/redirection/);
		// `<&` (input fd dup) is not part of the carve-out.
		expect(unsafe('cmd <&0')).toMatch(/redirection/);
	});

	it('rejects unresolved variable references', () => {
		expect(unsafe('echo $HOME')).toMatch(/variable/);
		expect(unsafe('echo ${USER}foo')).toMatch(/variable/);
	});

	it('rejects unexpanded globs', () => {
		expect(unsafe('ls *.ts')).toMatch(/glob/);
		expect(unsafe('rm src/?.ts')).toMatch(/glob/);
	});

	it('rejects env-assignment prefix', () => {
		expect(unsafe('PATH=x ls')).toMatch(/env-assignment/);
	});

	it('rejects tilde expansion', () => {
		expect(unsafe('cat ~/secret')).toMatch(/tilde/);
		expect(unsafe('~bin/ls')).toMatch(/tilde/);
	});

	it('rejects path-qualified or relative-path commands', () => {
		expect(unsafe('/usr/bin/ls')).toMatch(/path/);
		expect(unsafe('./script.sh')).toMatch(/relative|path/);
		expect(unsafe('../tool')).toMatch(/relative|path/);
	});

	it('rejects background execution', () => {
		// shell-quote yields `{op: '&'}` for trailing `&`.
		const r = parseShellCommand('sleep 1 &');
		expect(r.kind).toBe('unsafe');
	});

	it('rejects empty segments around operators', () => {
		expect(unsafe('&& ls')).toMatch(/empty segment|operator/);
		expect(unsafe('ls &&')).toMatch(/trailing operator/);
	});

	it('rejects shell comments', () => {
		// shell-quote yields `{op: 'comment'}` for `# ...` tail.
		const r = parseShellCommand('ls # hidden command');
		expect(r.kind).toBe('unsafe');
	});
});

describe('detectShellMisuse — cat/head/tail write redirects', () => {
	it('flags `cat > file`', () => {
		const m = detectShellMisuse('cat > out.txt');
		expect(m?.code).toBe('cat-write-redirect');
		expect(m?.feedback).toMatch(/cat/);
		expect(m?.feedback).toMatch(/create.*edit|edit.*create/);
	});

	it('flags `cat >> file`', () => {
		expect(detectShellMisuse('cat >> out.txt')?.code).toBe('cat-write-redirect');
	});

	it('flags cat-heredoc-to-file (the canonical agent-misuse case)', () => {
		const m = detectShellMisuse("cat > src/foo.ts << 'EOF'\nbody\nEOF");
		expect(m?.code).toBe('cat-write-redirect');
	});

	it('flags head and tail write redirects too', () => {
		expect(detectShellMisuse('head -n 5 in.txt > out.txt')?.code).toBe('cat-write-redirect');
		expect(detectShellMisuse('tail -f log >> mirror.log')?.code).toBe('cat-write-redirect');
	});

	it('flags `1>file` (explicit stdout fd)', () => {
		expect(detectShellMisuse('cat 1> out.txt')?.code).toBe('cat-write-redirect');
	});

	it('does NOT flag pipelined cat (pipes are fine)', () => {
		expect(detectShellMisuse('git log | cat')).toBeNull();
		expect(detectShellMisuse('cat foo.txt | head -5')).toBeNull();
	});

	it('does NOT flag cat with input redirect or heredoc-only', () => {
		// `cat < foo` and `cat << EOF` are silly but not file-writing.
		// They get caught (or not) by the regular prompt-nudge seed.
		expect(detectShellMisuse('cat < input.txt')).toBeNull();
		expect(detectShellMisuse("cat << 'EOF'\nhi\nEOF")).toBeNull();
	});

	it('does NOT flag fd-dup (it is a no-op, not a file write)', () => {
		expect(detectShellMisuse('cat foo.txt 2>&1')).toBeNull();
		// Note: `cat foo > /dev/null` IS flagged. Technically a no-op
		// (output discarded), but the only reason to write that is to
		// suppress output, and the agent has no reason to invoke cat for
		// its side effects. Catching this false-positive is fine.
	});

	it('does NOT flag write redirects from other commands', () => {
		expect(detectShellMisuse('pnpm build > build.log')).toBeNull();
		expect(detectShellMisuse('git diff > patch.diff')).toBeNull();
	});

	it('does NOT flag substrings (cat must be the segment leader)', () => {
		expect(detectShellMisuse('concat-files > out.txt')).toBeNull();
		expect(detectShellMisuse('mycat > out.txt')).toBeNull();
	});

	it('only flags the offending segment in a chain', () => {
		// `git log && cat > foo` — cat-write is in the second segment.
		expect(detectShellMisuse('git log && cat > foo.txt')?.code).toBe('cat-write-redirect');
		// `cat > foo || true` — cat-write is in the first segment.
		expect(detectShellMisuse('cat > foo.txt || true')?.code).toBe('cat-write-redirect');
	});

	it('does NOT flag env-prefixed cat (acceptable miss — parser refuses anyway)', () => {
		// `FOO=1 cat > out` — first token is the env assignment, not
		// `cat`. We miss it here, but `parseShellCommand` refuses
		// env-prefixed commands AND the redirect, so the request falls
		// through to prompt without auto-approval. Documented as a
		// known limitation; the contrived case isn't worth the parser
		// dependency.
		expect(detectShellMisuse('FOO=1 cat > out.txt')).toBeNull();
	});
});
