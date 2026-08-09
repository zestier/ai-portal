import { renderGrepModelText } from '../src/lib/server/tools/grep';

/**
 * Registry for golden-tool conformance implementations.
 *
 * The reroute tickets (Read, Edit, Write, Glob, Grep, Bash portal
 * implementations) register their renderer here once it can emit the
 * model-facing tool_result text. Each registration binds a built-in tool name
 * to a render function that takes the canonical args plus the fixture
 * workspace and returns the text a model would see for that tool call.
 * tests/golden-conformance.test.ts then compares that text byte-for-byte
 * against the captured goldens under tests/fixtures/golden/.
 *
 * Example (from a future reroute ticket):
 *   import { registerGoldenToolImplementation } from './golden-conformance-impls';
 *   import { renderReadToolResult } from '../src/lib/server/tools/read';
 *   registerGoldenToolImplementation('Read', {
 *     render(name, args, ctx) {
 *       return renderReadToolResult(name, args, ctx);
 *     }
 *   });
 */
export interface GoldenToolContext {
	/** The fixture workspace the tool call runs against (matches the capture fixture). */
	cwd: string;
}

export interface GoldenToolImplementation {
	render(
		name: string,
		args: Record<string, unknown>,
		ctx: GoldenToolContext
	): Promise<string> | string;
}

const implementations = new Map<string, GoldenToolImplementation>();

export function registerGoldenToolImplementation(
	tool: string,
	impl: GoldenToolImplementation
): void {
	implementations.set(tool, impl);
}

export function goldenToolImplementations(): ReadonlyMap<string, GoldenToolImplementation> {
	return implementations;
}

registerGoldenToolImplementation('Grep', {
	render(_name, args, ctx) {
		return renderGrepModelText(args, ctx.cwd);
	}
});
