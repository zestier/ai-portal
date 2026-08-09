import {
	createSdkMcpServer,
	tool,
	type SdkMcpToolDefinition
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ApprovalMode, PortalEvent, SessionMode } from '$lib/types';
import { ticketWorkspaceFromConversation } from '../ticket-workspace';
import { buildApplyPatchTools } from '../tools/apply-patch';
import { buildCreateDirectoryTools } from '../tools/create-directory';
import { buildEditFileTools } from '../tools/edit-file';
import { filterPortalToolGroups } from '../tools/filter-groups';
import { buildGitTools } from '../tools/git';
import { buildGrepTools } from '../tools/grep';
import { buildMemoryTools } from '../tools/memory';
import { buildMoveTools } from '../tools/move';
import { buildPermissionTools } from '../tools/permissions';
import { buildPromptTemplateTools } from '../tools/prompt-templates';
import { buildReadFileTools } from '../tools/read-file';
import { buildShellTools } from '../tools/shell';
import { buildTicketTools } from '../tools/tickets';
import { buildTrashTools } from '../tools/trash';
import { deriveToolResultViews, type PortalTool, type ToolStreamContext } from '../tools/types';
import { buildWorktreeTools } from '../tools/worktree';
import type { ProviderOpenOptions } from './provider';

// Portal tools that duplicate the Agent SDK's built-in coding tools
// (Read/Edit/Write/Glob/Grep/Bash). The SDK provides these natively, so the
// portal omits them rather than exposing two tools with the same job.
const SDK_BUILTIN_TOOL_DUPLICATES = new Set([
	'shell_exec',
	'read_file',
	'list_files',
	'create_file',
	'replace_lines',
	'replace_text'
]);

export function buildClaudePortalTools(args: {
	opts: ProviderOpenOptions;
	getMode(): SessionMode;
	getApprovalMode(): ApprovalMode;
	emit(event: PortalEvent): void;
	getSignal(): AbortSignal;
}): PortalTool[] {
	const { opts } = args;
	return filterPortalToolGroups(
		{
			shell: buildShellTools(opts.workingDirectory),
			git: buildGitTools(opts.workingDirectory, {
				userId: opts.userId,
				conversationId: opts.conversationId
			}),
			filesystem: [
				...buildCreateDirectoryTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildMoveTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildTrashTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildReadFileTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildApplyPatchTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildEditFileTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildGrepTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				})
			],
			worktree: buildWorktreeTools({
				userId: opts.userId,
				conversationId: opts.conversationId
			}),
			tickets: buildTicketTools({
				userId: opts.userId,
				workspaceKey: opts.workspaceKey ?? ticketWorkspaceFromConversation(opts.workingDirectory),
				conversationId: opts.conversationId
			}),
			permissions: buildPermissionTools({
				userId: opts.userId,
				conversationId: opts.conversationId,
				policy: opts.policy,
				getMode: args.getMode,
				getApprovalMode: args.getApprovalMode,
				emit: args.emit
			}),
			memory: buildMemoryTools({
				userId: opts.userId,
				conversationId: opts.conversationId,
				mode: opts.memoryMode ?? 'off',
				globalMemoryEnabled: opts.globalMemoryEnabled === true
			}),
			'prompt-templates': buildPromptTemplateTools({ userId: opts.userId })
		},
		opts.disabledToolGroups
	).filter((portalTool) => !SDK_BUILTIN_TOOL_DUPLICATES.has(portalTool.name));
}

export function createClaudePortalMcpServer(
	portalTools: PortalTool[],
	args: { emit(event: PortalEvent): void; getSignal(): AbortSignal }
) {
	return createSdkMcpServer({
		name: 'portal',
		version: '1.0.0',
		tools: portalTools.map((portalTool) => adaptClaudePortalTool(portalTool, args))
	});
}

export function adaptClaudePortalTool(
	portalTool: PortalTool,
	args: { getSignal(): AbortSignal }
): SdkMcpToolDefinition {
	return tool(
		portalTool.name,
		portalTool.description,
		objectShape(portalTool),
		async (toolArgs) => {
			const signal = args.getSignal();
			const stream: ToolStreamContext = {
				signal,
				partial() {},
				progress() {}
			};
			try {
				const result = await portalTool.handler(toolArgs, stream);
				const views = deriveToolResultViews(result);
				// Success results are passed through as the raw, structured envelope
				// JSON (with a short human-readable summary) rather than the
				// human-formatted `modelText`. The formatted projection re-renders
				// multi-line string fields with prefixes/indentation that don't match
				// the source file, which broke 1:1 `replace_text` matches; the raw
				// envelope preserves exact whitespace and metadata (e.g. `isComplete`,
				// byte counts) so `read_file` output can be reused verbatim. Errors
				// keep the concise `modelText` message for the model.
				return {
					content: [
						{
							type: 'text' as const,
							text: views.ok
								? JSON.stringify({ raw: result, summary: views.summary })
								: views.modelText
						}
					],
					isError: !views.ok
				};
			} catch (error) {
				return {
					content: [
						{
							type: 'text' as const,
							text: error instanceof Error ? error.message : String(error)
						}
					],
					isError: true
				};
			}
		},
		{
			annotations: {
				readOnlyHint: portalTool.permissionBehavior === 'never-prompt'
			}
		}
	);
}

function objectShape(portalTool: PortalTool): z.ZodRawShape {
	let schema = portalTool.argsSchema;
	while (
		schema instanceof z.ZodOptional ||
		schema instanceof z.ZodDefault ||
		schema instanceof z.ZodEffects
	) {
		schema = schema instanceof z.ZodEffects ? schema._def.schema : schema._def.innerType;
	}
	if (!(schema instanceof z.ZodObject)) {
		throw new Error(`Claude Agent SDK tool ${portalTool.name} requires a Zod object schema.`);
	}
	return schema.shape;
}
