// Loads MCP server definitions from a workspace `.mcp.json` so the Copilot SDK
// connects them for the session.
//
// Why this exists: the SDK's `enableConfigDiscovery` is documented to discover
// workspace `.mcp.json`, but for SDK-created (headless) sessions it does NOT
// actually load those servers — only the interactive CLI does. Empirically a
// session created with `enableConfigDiscovery: true` and a workdir containing a
// valid `.mcp.json` still sees zero workspace MCP servers. Passing them
// explicitly via `createSession({ mcpServers })` is the path that works, so we
// read the file ourselves and hand the servers to the SDK.
//
// The server entries are passed through verbatim — we don't inject defaults.
// A workspace that wants its servers to connect declares `tools` itself (e.g.
// `["*"]` for all tools); see this repo's own `.mcp.json`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPServerConfig } from '@github/copilot-sdk';
import { log } from '../log';

// The only workspace MCP config file we read. The SDK's interactive CLI also
// looks at `.vscode/mcp.json`, but the portal standardizes on `.mcp.json`.
const MCP_CONFIG_FILENAME = '.mcp.json';

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Read workspace MCP server definitions from `<workingDirectory>/.mcp.json`.
 * Returns a `mcpServers` map ready to pass to the SDK's `createSession`, with
 * each server entry passed through verbatim. Best-effort: a missing file is
 * normal and returns `{}`; a malformed file is logged and returns `{}` so a
 * broken config never blocks a session from opening.
 */
export function loadWorkspaceMcpServers(
	workingDirectory: string | null | undefined
): Record<string, MCPServerConfig> {
	if (!workingDirectory) return {};

	const path = join(workingDirectory, MCP_CONFIG_FILENAME);
	if (!existsSync(path)) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf-8'));
	} catch (e) {
		log.warn('copilot.workspace_mcp.parse_failed', { path, err: (e as Error).message });
		return {};
	}

	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		// A file with no `mcpServers` object isn't an error worth shouting about,
		// but it is worth a breadcrumb since the user clearly intended a config.
		log.warn('copilot.workspace_mcp.no_servers', { path });
		return {};
	}

	const result: Record<string, MCPServerConfig> = {};
	for (const [name, raw] of Object.entries(parsed.mcpServers)) {
		if (!isRecord(raw)) {
			log.warn('copilot.workspace_mcp.invalid_server', { path, server: name });
			continue;
		}
		result[name] = raw as unknown as MCPServerConfig;
	}
	return result;
}
