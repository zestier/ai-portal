import { describe, it, expect } from 'vitest';
import {
	isSubagentToolCall,
	selectSubagentChildren,
	MAX_SUBAGENT_NESTING_DEPTH,
	SUBAGENT_TOOL
} from '../src/lib/client/subagent-display';
import type { ToolCallRecord, ReasoningBlockRecord, FileEditRecord } from '../src/lib/types';

function tool(id: string, parentToolCallId: string | null, name = 'bash'): ToolCallRecord {
	return {
		id,
		messageId: 'm1',
		tool: name,
		argsJson: '{}',
		resultJson: null,
		status: 'ok',
		startedAt: 0,
		endedAt: 1,
		textOffset: null,
		parentToolCallId
	};
}

function reasoning(id: string, parentToolCallId: string | null): ReasoningBlockRecord {
	return {
		id,
		messageId: 'm1',
		segmentIndex: 0,
		text: 'thinking',
		kind: 'reasoning',
		textOffset: null,
		startedAt: 0,
		durationMs: 1,
		parentToolCallId
	};
}

function edit(id: string, parentToolCallId: string | null): FileEditRecord {
	return {
		id,
		messageId: 'm1',
		path: 'a.ts',
		diff: '',
		createdAt: 0,
		textOffset: null,
		parentToolCallId
	};
}

describe('isSubagentToolCall', () => {
	it('identifies task calls, which render as sub-agent cards', () => {
		expect(isSubagentToolCall(tool('t1', null, SUBAGENT_TOOL))).toBe(true);
	});

	it('rejects ordinary tool calls', () => {
		expect(isSubagentToolCall(tool('t1', null, 'bash'))).toBe(false);
		// Near-miss names must not be treated as sub-agents.
		expect(isSubagentToolCall(tool('t2', null, 'tasks'))).toBe(false);
	});
});

describe('selectSubagentChildren', () => {
	it('selects only direct children across all three pools', () => {
		const pools = {
			tools: [tool('a', 'outer'), tool('b', 'other'), tool('c', null)],
			reasoning: [reasoning('r1', 'outer'), reasoning('r2', null)],
			edits: [edit('e1', 'outer'), edit('e2', 'other')]
		};
		const children = selectSubagentChildren(pools, 'outer');
		expect(children.tools.map((t) => t.id)).toEqual(['a']);
		expect(children.reasoning.map((r) => r.id)).toEqual(['r1']);
		expect(children.edits.map((e) => e.id)).toEqual(['e1']);
	});

	it('excludes grandchildren, which belong to the nested task call instead', () => {
		// outer -> inner(task) -> grandchild
		const pools = {
			tools: [
				tool('inner', 'outer', SUBAGENT_TOOL),
				tool('grandchild', 'inner'),
				tool('sibling', 'outer')
			]
		};
		const outer = selectSubagentChildren(pools, 'outer');
		expect(outer.tools.map((t) => t.id)).toEqual(['inner', 'sibling']);

		// The grandchild is reachable one level down — the regression this
		// guards is it being dropped from the UI entirely.
		const inner = selectSubagentChildren(pools, 'inner');
		expect(inner.tools.map((t) => t.id)).toEqual(['grandchild']);
	});

	it('drops a self-referential row so a card cannot contain itself', () => {
		const pools = { tools: [tool('loop', 'loop')] };
		expect(selectSubagentChildren(pools, 'loop').tools).toEqual([]);
	});

	it('treats missing pools as empty rather than throwing', () => {
		expect(selectSubagentChildren({}, 'outer')).toEqual({ tools: [], reasoning: [], edits: [] });
	});

	it('returns nothing for an id with no children', () => {
		const pools = { tools: [tool('a', 'outer')] };
		expect(selectSubagentChildren(pools, 'nobody').tools).toEqual([]);
	});
});

describe('MAX_SUBAGENT_NESTING_DEPTH', () => {
	it('allows real nesting while still terminating a cyclic parent chain', () => {
		// Must exceed 1 or the recursion this cap guards would never happen;
		// kept small so a pathological chain cannot hang the tab.
		expect(MAX_SUBAGENT_NESTING_DEPTH).toBeGreaterThan(1);
		expect(MAX_SUBAGENT_NESTING_DEPTH).toBeLessThanOrEqual(8);
	});
});
