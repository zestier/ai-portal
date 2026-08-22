import { z } from "zod";
import type { InteractiveResponse, PortalEvent } from "$lib/types";
import { ASK_USER_TOOL_NAME } from "./self-interactive";
import {
  isInteractivePromptCancelledError,
  newRequestId,
  register as registerInteractive,
} from "../runtime/interactive-requests";
import { err, ok, type PortalTool } from "./types";

const AskQuestionItem = z.object({
  question: z
    .string()
    .trim()
    .min(1, "question must not be empty")
    .max(2000, "question must be at most 2000 characters"),
  choices: z.array(z.string().trim().min(1)).max(20).optional(),
});

export const AskUserArgs = z.object({
  questions: z.array(AskQuestionItem).min(1, "at least one question").max(10),
});

export interface AskUserToolOpts {
  userId: number;
  conversationId: number;
  emit: (ev: PortalEvent) => void;
}

// Build the `ask_user` tool. It is `never-prompt` (asking carries no side
// effect, nothing to gate at the call site). Its handler ALWAYS raises a
// `user_input` dialog and waits for the human's answer regardless of approval
// mode — the whole point is human input, and auto-answering is impossible.
// Like the grant tools this behaves as a forced prompt under any mode.
export function buildAskUserTool(opts: AskUserToolOpts): PortalTool {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      "Ask the human one or more questions mid-turn; returns their answers.",
    promptGuidelines: [
      "You can pass up to 10 questions in one call; they all appear in ONE dialog and the human answers them together.",
      "Add `choices` on a question only when a fixed set fits; free-form typing always works.",
    ],
    argsSchema: AskUserArgs,
    permissionBehavior: "never-prompt",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              choices: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["question"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    async handler(args) {
      const parsed = AskUserArgs.parse(args);
      const requestId = newRequestId();
      const view = {
        requestId,
        kind: "user_input",
        questions: parsed.questions.map((q) => ({
          question: q.question,
          choices: q.choices,
        })),
        allowFreeform: true,
      } as const;

      let response: InteractiveResponse;
      try {
        response = await new Promise<InteractiveResponse>((resolve, reject) => {
          registerInteractive({
            requestId,
            conversationId: opts.conversationId,
            userId: opts.userId,
            kind: "user_input",
            view,
            resolve,
            reject,
            emit: opts.emit,
          });
          opts.emit({ type: "interactive.request", request: view });
        });
      } catch (e) {
        if (isInteractivePromptCancelledError(e)) {
          return err(
            "The question was dismissed before the human answered (turn aborted, timed out, or disconnected). This is not a decline — re-ask if the answer is still needed.",
            { code: "question_cancelled" },
          );
        }
        throw e;
      }

      if (response.kind !== "user_input") {
        return err("Unexpected response.");
      }

      const pairs = parsed.questions.map((q, i) => ({
        question: q.question,
        answer: response.answers[i],
      }));

      return ok(
        { answers: pairs, wasFreeform: response.wasFreeform ?? false },
        `The human answered:\n${pairs
          .map((p, i) => `${i + 1}. ${p.question} ${p.answer}`)
          .join("\n")}`,
      );
    },
  };
}
