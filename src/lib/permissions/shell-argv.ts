import type { ShellOptionSpec } from './scope-types';

export interface MatchedShellOption {
	spec: ShellOptionSpec;
	index: number;
	value?: string | undefined;
	valueIndex?: number | undefined;
}

export function looksLikeShellOptionToken(tok: string | undefined): boolean {
	return typeof tok === 'string' && tok.startsWith('-') && tok !== '-';
}

/**
 * Resolves the index of the first positional (subcommand) token in `argv`,
 * skipping over recognized leading options.
 *
 * UI/DISPLAY ONLY — DO NOT USE FOR SECURITY OR PERMISSION DECISIONS.
 *
 * This helper treats `--` as a hard terminator: on encountering `--` it stops
 * and returns `subcommandIndex: null`, reporting that no subcommand was found.
 *
 * This DIFFERS intentionally from `commandPathMatches` in
 * `src/lib/server/permissions/predicates/shell.ts`, which treats `--` as the
 * conventional "end of options" marker: it sets `afterDoubleDash = true` and
 * CONTINUES consuming the remaining tokens as positionals.
 *
 * Because the two functions disagree on `--` semantics, using
 * `resolveSubcommandIndex` to pre-screen or reason about commands for security
 * purposes would draw conclusions that diverge from the actual permission
 * predicate (`commandPathMatches`). Keep this function confined to UI/display
 * concerns; route all security-relevant matching through `commandPathMatches`.
 */
export function resolveSubcommandIndex(
	argv: string[],
	allowedOptions: readonly ShellOptionSpec[]
): { subcommandIndex: number | null; matchedOptions: MatchedShellOption[] } {
	const matchedOptions: MatchedShellOption[] = [];
	for (let i = 1; i < argv.length; ) {
		const tok = argv[i];
		if (tok === '--') return { subcommandIndex: null, matchedOptions };
		if (!looksLikeShellOptionToken(tok)) {
			return { subcommandIndex: i, matchedOptions };
		}
		const matched = matchShellOptionToken(tok, argv[i + 1], allowedOptions);
		if (!matched) return { subcommandIndex: null, matchedOptions };
		matchedOptions.push({
			spec: matched.spec,
			index: i,
			value: matched.value,
			valueIndex: matched.consumedNextToken ? i + 1 : undefined
		});
		i += matched.consumedNextToken ? 2 : 1;
	}
	return { subcommandIndex: null, matchedOptions };
}

export function matchShellOptionToken(
	tok: string,
	nextTok: string | undefined,
	specs: readonly ShellOptionSpec[]
): { spec: ShellOptionSpec; value?: string; consumedNextToken: boolean } | null {
	for (const spec of specs) {
		if (spec.kind === 'flag') {
			if (tok === spec.name) return { spec, consumedNextToken: false };
			continue;
		}

		if (tok === spec.name) {
			if (nextTok === undefined) return null;
			return { spec, value: nextTok, consumedNextToken: true };
		}
		if (tok.startsWith(spec.name + '=')) {
			return {
				spec,
				value: tok.slice(spec.name.length + 1),
				consumedNextToken: false
			};
		}
	}
	return null;
}
