import { error, json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import {
  conversationId as convCodec,
  messageId as msgCodec,
  toolCallId as toolCodec,
} from "$lib/ids";
import { authorizeConversation } from "$lib/server/conversation-auth";
import * as memoryRepo from "$lib/server/db/repos/memory";
import * as messages from "$lib/server/db/repos/messages";
import * as settings from "$lib/server/db/repos/settings";
import * as usage from "$lib/server/db/repos/usage";
import { loadConfig } from "$lib/server/config";
import { effectiveWorkdir } from "$lib/server/workdir";
import * as pool from "$lib/server/runtime/pool";
import { getTurn, startTurn } from "$lib/server/runtime/turn-runner";
import { parseBody } from "$lib/server/validate";
import { argsHash } from "$lib/server/tool-invocation";
import { isEnabled } from "$lib/server/memory/engine";

const Body = z
  .object({
    confirmed: z.boolean().optional().default(false),
  })
  .prefault({});

const APPROVAL_TTL_MS = 2 * 60_000;

export const POST: RequestHandler = async ({ params, locals, request }) => {
  const conv = authorizeConversation(params.id, locals.userId);
  const convId = convCodec.parse(conv.id);
  const body = await parseBody(request, Body, { allowEmpty: true });
  const toolCallId = toolCodec.tryParse(params.toolCallId);
  if (toolCallId === null) throw error(400, "missing tool call id");

  const current = getTurn(convId);
  if (current && current.status === "running") {
    throw error(409, "A turn is already in progress for this conversation.");
  }

  const original = messages.getToolCallForConversation(convId, toolCallId);
  if (!original || original.conversationUserId !== conv.userId)
    throw error(404);

  const eligibility = getRerunEligibility(original);
  if (!eligibility.eligible) throw error(400, eligibility.reason);
  if (eligibility.requiresConfirmation && !body.confirmed) {
    throw error(
      400,
      "This tool can have side effects; confirm the exact arguments before rerun.",
    );
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(original.argsJson);
  } catch {
    throw error(400, "Original tool arguments are not valid JSON.");
  }
  const hash = argsHash(parsedArgs);

  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  settings.pruneExpiredGrants();
  settings.addGrant({
    userId: conv.userId,
    conversationId: convId,
    tool: approvalToolFor(original.tool),
    permissionKind: null,
    scopePattern: null,
    scope: null,
    argsHash: hash,
    decision: "force-allow",
    expiresAt,
  });
  settings.recordDecision(
    convId,
    original.tool,
    `Manual rerun approval for ${original.id}`,
    "allow-once",
  );

  const allMessages = messages.listByConversation(convId);
  const originalMessageIdx = allMessages.findIndex(
    (message) => message.id === original.messageId,
  );
  if (originalMessageIdx < 0) throw error(404);
  memoryRepo.rewindSessionMemoryLogToMessagePrefix(convId, {
    messageIds: new Set(
      allMessages
        .slice(0, originalMessageIdx + 1)
        .map((message) => msgCodec.parse(message.id)),
    ),
    createdBefore: allMessages[originalMessageIdx + 1]?.createdAt,
  });
  messages.truncateAfterMessage(convId, msgCodec.parse(original.messageId));
  usage.remove(convId);
  // Drop the pooled session synchronously (map deletion before the first await
  // in `release`) so the rerun opens a fresh, independent one.
  void pool.release(convId);

  const cfg = loadConfig();
  const userSettings = settings.get(conv.userId) ?? settings.defaults();
  const prompt = buildRerunPrompt(original.tool, original.argsJson);
  const userMessage = messages.append(convId, {
    role: "user",
    content: `Manual tool rerun: rerun failed tool call ${original.id} (${original.tool}) with its exact stored arguments.`,
    status: "complete",
  });
  const turn = await startTurn({
    conversationId: convId,
    prompt,
    bridge: {
      conversationId: convId,
      userId: conv.userId,
      workingDirectory: effectiveWorkdir(conv.workdir),
      model: conv.model ?? cfg.DEFAULT_MODEL,
      policy: userSettings.defaultPolicy,
      mode: conv.mode,
      approvalMode: conv.approvalMode,
      disabledToolGroups: conv.disabledToolGroups,
      memoryMode: conv.memoryMode,
      globalMemoryEnabled: conv.globalMemoryEnabled,
    },
    memory: isEnabled(conv.memoryMode)
      ? {
          mode: conv.memoryMode,
          userMessageId: userMessage.id,
          userContent: userMessage.content,
          extractorModel: conv.memoryExtractorModel,
        }
      : undefined,
  });

  return json({ turnId: turn.id, grantExpiresAt: expiresAt });
};

function getRerunEligibility(
  t: messages.ToolCallWithConversation,
):
  | { eligible: true; requiresConfirmation: boolean }
  | { eligible: false; reason: string } {
  if (t.messageRole !== "assistant")
    return {
      eligible: false,
      reason: "Only assistant tool calls can be rerun.",
    };
  if (t.parentToolCallId) {
    return {
      eligible: false,
      reason: "Nested sub-agent tool calls cannot be rerun yet.",
    };
  }
  if (t.endedAt === null || t.status === "pending") {
    return {
      eligible: false,
      reason: "Only completed tool calls can be rerun.",
    };
  }
  if (t.status !== "denied" && t.status !== "error") {
    return { eligible: false, reason: "Only failed tool calls can be rerun." };
  }
  try {
    JSON.parse(t.argsJson);
  } catch {
    return {
      eligible: false,
      reason: "Original tool arguments are not valid JSON.",
    };
  }
  return {
    eligible: true,
    requiresConfirmation: requiresSideEffectConfirmation(t),
  };
}

function requiresSideEffectConfirmation(
  t: messages.ToolCallWithConversation,
): boolean {
  if (t.tool === "view" || t.tool === "git_show_file") return false;
  return true;
}

function approvalToolFor(tool: string): string {
  return tool === "bash" || tool === "shell" || tool === "run" ? "shell" : tool;
}

function buildRerunPrompt(tool: string, argsJson: string): string {
  return [
    "Manual tool rerun request.",
    "The user reviewed and approved rerunning one historical failed tool invocation.",
    "Invoke exactly the tool below with exactly the JSON arguments below. Do not call any other tool, do not change the arguments, and do not summarize or restate sensitive arguments in prose.",
    `Tool: ${tool}`,
    "Arguments JSON:",
    argsJson,
  ].join("\n\n");
}
