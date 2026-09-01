import { describe, expect, test } from "vitest";
import { render } from "svelte/server";
import Chat from "../../src/lib/components/Chat.svelte";
import Composer from "../../src/lib/components/Composer.svelte";
import DiffView from "../../src/lib/components/DiffView.svelte";
import FileBrowser from "../../src/lib/components/FileBrowser.svelte";
import GitToolResult from "../../src/lib/components/tool/GitToolResult.svelte";
import InteractiveRequestDialog from "../../src/lib/components/InteractiveRequestDialog.svelte";
import LaunchReviewDialog from "../../src/lib/components/LaunchReviewDialog.svelte";
import ProcCall from "../../src/lib/components/ProcCall.svelte";
import PromptTemplateLauncher from "../../src/lib/components/PromptTemplateLauncher.svelte";
import ToolCall from "../../src/lib/components/ToolCall.svelte";
import PromptsSettings from "../../src/routes/settings/PromptsSettings.svelte";
import TicketPage from "../../src/routes/tickets/[id]/+page.svelte";
import TicketsIndexPage from "../../src/routes/tickets/+page.svelte";
import { MAX_RENDERABLE_DIFF_CHARS } from "../../src/lib/client/diff-parser";
import { listBuiltInPromptTemplates } from "../../src/lib/prompt-templates";
import type { Conversation, InteractiveRequestView } from "../../src/lib/types";

const conversation: Conversation = {
  id: "C1",
  userId: 1,
  title: "Regression chat",
  workdir: "/workspaces/zap",
  model: "gpt-5.5",
  agentArchitecture: "standard",
  semanticWorkerModel: null,
  sessionFile: null,
  mode: "autopilot",
  memoryMode: "off",
  memoryExtractorModel: null,
  adversaryModel: null,
  globalMemoryEnabled: false,
  approvalMode: "auto-deny",
  disabledToolGroups: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  archivedAt: null,
  forkedFromConversationId: null,
  forkedFromMessageId: null,
  draftPrompt: null,
  workspaceKind: "shared",
  workspaceKey: "/workspaces/zap",
  worktreeBranch: null,
  worktreeBaseSha: null,
};

function textOf(body: string): string {
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("Svelte component regression coverage", () => {
  test("DiffView splits multi-file diffs and preserves per-file stats", () => {
    const body = render(DiffView, {
      props: {
        path: "fallback.patch",
        collapsible: true,
        diff: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-old a",
          "+new a",
          "diff --git a/src/b.ts b/src/b.ts",
          "--- a/src/b.ts",
          "+++ b/src/b.ts",
          "@@ -1,0 +1 @@",
          "+new b",
        ].join("\n"),
      },
    }).body;

    expect(body).toContain('aria-label="Collapse src/a.ts"');
    expect(body).toContain('aria-label="Collapse src/b.ts"');
    expect(body).toMatch(/<code class="path [^"]+">src\/a\.ts<\/code>/);
    expect(body).toMatch(/<code class="path [^"]+">src\/b\.ts<\/code>/);
    expect(body).toMatch(/<span class="added [^"]+">\+1<\/span>/);
    expect(body).toMatch(/<span class="removed [^"]+">−1<\/span>/);
    expect(body).toContain('role="table"');
  });

  test("DiffView refuses oversized diffs instead of parsing them", () => {
    const body = render(DiffView, {
      props: {
        path: "huge.patch",
        diff: "+".repeat(MAX_RENDERABLE_DIFF_CHARS + 1),
      },
    }).body;

    expect(body).toContain("Diff is too large to render safely");
    expect(body).toContain((MAX_RENDERABLE_DIFF_CHARS + 1).toLocaleString());
    expect(body).not.toContain('role="table"');
  });

  test("ProcCall renders execution audit fields", () => {
    const body = render(ProcCall, {
      props: {
        conversationId: "C1",
        toolCall: {
          id: "10",
          messageId: "20",
          tool: "proc",
          argsJson: JSON.stringify({
            summary: "Inspect files",
            procedure: "Read the relevant files",
            result_requirements: "Paths and contents",
          }),
          resultJson: JSON.stringify({
            status: "completed",
            projection: ["src/lib/components/ProcCall.svelte"],
          }),
          status: "ok",
          startedAt: 1,
          endedAt: 2,
          textOffset: 0,
          parentToolCallId: null,
        },
        childTools: [
          {
            id: "11",
            messageId: "20",
            tool: "execute",
            argsJson: JSON.stringify({
              needed_for: "Find the owning component",
              javascript:
                "return fs.readFile('src/lib/components/ProcCall.svelte', 'utf8');",
              worker_view: "value",
            }),
            resultJson: JSON.stringify({
              worker_view_kind: "value",
              value: "component source",
              worker_view_bytes: 16,
            }),
            status: "ok",
            startedAt: 1,
            endedAt: 2,
            textOffset: null,
            parentToolCallId: "10",
          },
        ],
      },
    }).body;

    expect(body).toContain("Find the owning component");
    expect(body).toContain("return fs.readFile");
    expect(body).toContain("Raw input payload");
    expect(body).toContain("Exact text sent to worker");
    expect(body).toContain("Raw output payload");
    expect(body).toContain("component source");
  });

  test("InteractiveRequestDialog renders narrow filesystem grant choices and raw args", () => {
    const request: InteractiveRequestView = {
      requestId: "perm-1",
      kind: "permission",
      tool: "view",
      permissionKind: "read",
      summary: "/tmp/secrets.env",
      args: { path: "/tmp/secrets.env", forceReadLargeFiles: true },
      userPolicy: "prompt",
    };
    const body = render(InteractiveRequestDialog, {
      props: { request, onRespond: () => undefined },
    }).body;

    expect(body).toContain('role="alertdialog"');
    expect(body).toContain(
      'aria-labelledby="permission-request-heading-perm-1"',
    );
    expect(body).toContain('id="permission-request-heading-perm-1"');
    expect(body).toContain('aria-describedby="permission-request-body-perm-1"');
    expect(body).toContain('id="permission-request-body-perm-1"');
    expect(body).toContain("Just this exact read");
    expect(body).toContain("Anywhere under `/tmp/`");
    expect(body).toContain('"forceReadLargeFiles": true');
    expect(body).toContain("Allow always");
  });

  test("InteractiveRequestDialog renders default deny feedback for prompt-required grants", () => {
    const request: InteractiveRequestView = {
      requestId: "perm-default-feedback",
      kind: "permission",
      tool: "bash",
      permissionKind: "shell",
      summary: "node scripts/check.js",
      args: { command: "node scripts/check.js" },
      userPolicy: "prompt",
      canPersistDecision: false,
      defaultDenyFeedback: "Node scripts require human approval.",
    };
    const body = render(InteractiveRequestDialog, {
      props: { request, onRespond: () => undefined },
    }).body;

    expect(body).toContain("Node scripts require human approval.");
    expect(body).toContain("36/500 characters");
  });

  test("InteractiveRequestDialog requires explicit shell scopes before persistent allow", () => {
    const request: InteractiveRequestView = {
      requestId: "perm-2",
      kind: "permission",
      tool: "bash",
      permissionKind: "shell",
      summary: "git status | grep src",
      args: { command: "git status | grep src" },
      userPolicy: "prompt",
      shellAnalysis: {
        kind: "parsed",
        segments: [
          { argv: ["git", "status"], followingOp: "|" },
          { argv: ["grep", "src"], followingOp: null },
        ],
      },
    };
    const body = render(InteractiveRequestDialog, {
      props: { request, onRespond: () => undefined },
    }).body;
    const text = textOf(body);

    expect(text).toContain("Pipeline (2 commands)");
    expect(body).toContain("Any `git` command (any subcommand, any args)");
    expect(body).toContain("Any `git status` command (any args)");
    expect(body).toContain("Any `grep` command (any subcommand, any args)");
    expect(body).toContain(
      "Check at least one scope above to remember this allow.",
    );
    expect(body).toMatch(/<button[^>]+class="btn primary"[^>]+disabled/);
  });

  test("InteractiveRequestDialog renders a grant request with proposed scope and save action", () => {
    const request: InteractiveRequestView = {
      requestId: "grant-1",
      kind: "permission",
      tool: "shell",
      permissionKind: "shell",
      summary: "Grant request: shell (run a command) — shell command `pnpm`",
      args: {
        reason: "Scaffolding needs pnpm to install dependencies.",
        scope: { kind: "shell", rule: { command: [{ token: "pnpm" }] } },
      },
      userPolicy: "prompt",
      canPersistDecision: true,
      grantRequest: {
        reason: "Scaffolding needs pnpm to install dependencies.",
        permissionKind: "shell",
        scope: {
          kind: "shell",
          rule: {
            command: [{ token: "pnpm" }],
            positionals: { kind: "workspace-paths" },
          },
        },
      },
    };
    const body = render(InteractiveRequestDialog, {
      props: { request, onRespond: () => undefined },
    }).body;
    const text = textOf(body);

    expect(body).toContain("Permission grant requested");
    expect(body).toContain('aria-labelledby="grant-request-heading-grant-1"');
    expect(body).toContain('id="grant-request-heading-grant-1"');
    expect(body).toContain('aria-describedby="grant-request-body-grant-1"');
    expect(body).toContain('id="grant-request-body-grant-1"');
    expect(text).toContain("Scaffolding needs pnpm to install dependencies.");
    expect(body).toContain("Save grant");
    expect(body).toContain("Every conversation (global)");
    // The proposed scope seeds the editable grant form (shared with settings),
    // so the argv0 field is pre-filled with the agent's requested command.
    expect(body).toContain('value="pnpm"');
    expect(body).toContain("argv0 (the bare command name)");
    // It must NOT fall back to the ordinary permission scope picker.
    expect(body).not.toContain("Allow once");
  });

  test("InteractiveRequestDialog disables Save grant for a deny-all policy", () => {
    const request: InteractiveRequestView = {
      requestId: "grant-2",
      kind: "permission",
      tool: "write",
      permissionKind: "write",
      summary: "Grant request",
      args: {},
      userPolicy: "deny-all",
      canPersistDecision: true,
      grantRequest: {
        reason: "Need to write generated scaffolding files into the workspace.",
        permissionKind: "write",
        scope: {
          kind: "fs",
          perms: ["write"],
          rule: { kind: "path", root: "workspace", behavior: "any" },
        },
      },
    };
    const body = render(InteractiveRequestDialog, {
      props: { request, onRespond: () => undefined },
    }).body;
    expect(body).toMatch(/<button[^>]+class="btn primary"[^>]+disabled/);
    expect(body).toContain("Deny all");
  });

  test("InteractiveRequestDialog renders non-permission request families through focused children", () => {
    const requests: Array<[InteractiveRequestView, string[]]> = [
      [
        {
          requestId: "auto-1",
          kind: "auto_mode_switch",
          errorCode: "rate_limit",
          retryAfterSeconds: 30,
        },
        ["Switch to auto mode?", "rate_limit", "Yes, once"],
      ],
      [
        {
          requestId: "input-1",
          kind: "user_input",
          questions: [{ question: "Choose a branch", choices: ["develop"] }],
          allowFreeform: true,
        },
        ["The agent has a question", "Choose a branch", "develop"],
      ],
      [
        {
          requestId: "elicitation-1",
          kind: "elicitation",
          message: "Provide deploy target",
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {
              target: { type: "string", title: "Target", default: "staging" },
            },
          },
        },
        ["Agent needs information", "Provide deploy target", "Target"],
      ],
      [
        {
          requestId: "sampling-1",
          kind: "sampling",
          summary: "Sampling requested",
        },
        ["MCP sampling request", "Sampling requested", "Dismiss"],
      ],
      [
        {
          requestId: "oauth-1",
          kind: "mcp_oauth",
          summary: "OAuth required",
          authorizationUrl: "https://example.com/auth",
        },
        [
          "MCP server authentication",
          "OAuth required",
          "Open authorization URL",
        ],
      ],
      [
        {
          requestId: "external-1",
          kind: "external_tool",
          toolName: "deploy",
          summary: "External deploy requested",
        },
        ["External tool: deploy", "External deploy requested", "Dismiss"],
      ],
    ];

    for (const [request, expected] of requests) {
      const body = render(InteractiveRequestDialog, {
        props: { request, onRespond: () => undefined },
      }).body;
      for (const text of expected) {
        expect(body).toContain(text);
      }
    }
  });

  test("Chat composes pending interactive prompts into the initial transcript", () => {
    const pending: InteractiveRequestView = {
      requestId: "perm-chat",
      kind: "permission",
      tool: "bash",
      permissionKind: "shell",
      summary: "pnpm test",
      args: { command: "pnpm test" },
      userPolicy: "prompt",
      canPersistDecision: false,
    };
    const body = render(Chat, {
      props: {
        conversation,
        initialTranscript: { tail: [], index: [], hasMoreOlder: false },
        initialPendingInteractive: [pending],
        effectiveModel: "claude-sonnet-4.5",
        chatPlaceholder: "Ask the agent",
      },
    }).body;

    expect(body).toMatch(/<h2 class="[^"]+">Regression chat<\/h2>/);
    expect(body).toContain("Permission required");
    expect(body).not.toContain("Allow always");
    expect(body).toContain('placeholder="Ask the agent"');
    // Streamed/optimistic content lives in a polite live region so screen
    // readers announce assistant tokens and new messages.
    expect(body).toContain('role="log"');
    expect(body).toContain('aria-live="polite"');
    // The "new messages" pill lives in a persistent status live region so
    // its appearance is announced even though the button is toggled.
    expect(body).toContain('role="status"');
  });

  test("Composer exposes a programmatic label matching its placeholder", () => {
    const body = render(Composer, {
      props: {
        value: "",
        placeholder: "Message the agent…",
        onSend: () => undefined,
        onStop: () => undefined,
      },
    }).body;

    // A placeholder is not a programmatic label (WCAG 1.3.1) and vanishes
    // once typing starts, so the textarea carries a real aria-label.
    expect(body).toContain('aria-label="Message the agent…"');
  });

  test("Composer keeps Send visible while streaming and shows an armed state", () => {
    const streamingBody = render(Composer, {
      props: {
        value: "follow-up draft",
        streaming: true,
        armed: false,
        onSend: () => undefined,
        onStop: () => undefined,
      },
    }).body;

    // Send stays available mid-turn (no longer hidden) alongside Stop.
    expect(streamingBody).toContain('aria-label="Send message"');
    expect(streamingBody).toContain('aria-label="Stop generating"');

    const armedBody = render(Composer, {
      props: {
        value: "follow-up draft",
        streaming: true,
        armed: true,
        onSend: () => undefined,
        onStop: () => undefined,
      },
    }).body;

    expect(armedBody).toContain(
      'aria-label="Send when current response finishes"',
    );
    expect(armedBody).toContain('aria-pressed="true"');
    expect(armedBody).toMatch(/class="icon-btn send[^"]*\barmed\b/);
    // Stop remains the primary mid-turn control even when armed.
    expect(armedBody).toContain('aria-label="Stop generating"');
  });

  test("GitToolResult renders the followUpHint as a muted note on a commit card", () => {
    const base = {
      kind: "commit-created" as const,
      sha: "abcdef123456",
      shortSha: "abcdef12",
      subject: "commit all",
      body: "",
      trailers: [],
      files: [],
      fileStats: [],
      diffStat: { filesChanged: 1, added: 1, removed: 0 },
      remainingDirtyFiles: [],
      mergeCommit: false,
      resolvedConflicts: [],
    };
    const withHint = render(GitToolResult, {
      props: { result: { ...base, followUpHint: "reconcile your tickets" } },
    }).body;
    expect(withHint).toContain("reconcile your tickets");

    const withoutHint = render(GitToolResult, { props: { result: base } }).body;
    expect(withoutHint).not.toContain("reconcile your tickets");
    // A merge commit says so, and names what it resolved — the file list on
    // the card is only the first-parent diff, so the label is what explains it.
    expect(withoutHint).not.toContain("Merge commit");
    const merge = render(GitToolResult, {
      props: {
        result: { ...base, mergeCommit: true, resolvedConflicts: ["a.txt"] },
      },
    }).body;
    expect(merge).toContain("Merge commit");
    expect(merge).toContain("a.txt");
  });

  test("ToolCall surfaces a generic followUpHint for non-git tools", () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "ticket_add",
      argsJson: "{}",
      resultJson: JSON.stringify({
        ok: true,
        summary: "Added ticket t1",
        followUpHint: "remember to reconcile your tickets",
      }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const withHint = render(ToolCall, { props: { toolCall } }).body;
    expect(withHint).toContain("remember to reconcile your tickets");

    const withoutHint = render(ToolCall, {
      props: {
        toolCall: {
          ...toolCall,
          resultJson: JSON.stringify({ ok: true, summary: "Added ticket t1" }),
        },
      },
    }).body;
    expect(withoutHint).not.toContain("remember to reconcile your tickets");
  });

  test("ToolCall opens failures and surfaces their diagnostic", () => {
    const body = render(ToolCall, {
      props: {
        toolCall: {
          id: "X1",
          messageId: "M1",
          tool: "execute",
          argsJson: JSON.stringify({ summary: "Run pnpm check" }),
          resultJson: JSON.stringify("'command' is not a function"),
          status: "error" as const,
          startedAt: 0,
          endedAt: 1,
          textOffset: null,
          parentToolCallId: "X0",
        },
      },
    }).body;

    expect(body).toMatch(/<details[^>]* open=""/);
    expect(body).toContain('role="alert"');
    expect(body).toContain("'command' is not a function");
  });

  test("ProcCall surfaces a failed execution's diagnostic", () => {
    const body = render(ProcCall, {
      props: {
        toolCall: {
          id: "P1",
          messageId: "M1",
          tool: "proc",
          argsJson: JSON.stringify({
            summary: "Inspect settings",
            procedure: "Extract the relevant regions.",
            result_requirements: "Source excerpts",
          }),
          resultJson: null,
          status: "pending" as const,
          startedAt: 0,
          endedAt: null,
          textOffset: null,
          parentToolCallId: null,
        },
        childTools: [
          {
            id: "E1",
            messageId: "M1",
            tool: "execute",
            argsJson: JSON.stringify({
              needed_for: "Returning the requested ModelsSettings regions",
              javascript: "return content;",
              save_as: null,
              view: "shape",
            }),
            resultJson: JSON.stringify(
              JSON.stringify({
                ok: false,
                error: "readFile is not defined",
                retry_safe: true,
              }),
            ),
            status: "error" as const,
            startedAt: 0,
            endedAt: 1,
            textOffset: null,
            parentToolCallId: "P1",
          },
        ],
      },
    }).body;

    expect(body).toMatch(/<details class="stage[^"]*"[^>]*open=""/);
    expect(body).toContain("readFile is not defined");
    expect(body).toContain('data-automatically-open="true"');
  });

  test("ProcCall shows exact view feedback sent to the worker", () => {
    const body = render(ProcCall, {
      props: {
        toolCall: {
          id: "P1",
          messageId: "M1",
          tool: "proc",
          argsJson: JSON.stringify({
            summary: "Inspect contributing guidance",
            procedure: "Read the contributing guide.",
            result_requirements: "Relevant guidance",
          }),
          resultJson: null,
          status: "pending" as const,
          startedAt: 0,
          endedAt: null,
          textOffset: null,
          parentToolCallId: null,
        },
        childTools: [
          {
            id: "E1",
            messageId: "M1",
            tool: "view",
            argsJson: JSON.stringify({
              javascript: "return fs.readFile('CONTRIBUTING.md', 'utf8');",
              max_bytes: 32,
            }),
            resultJson: JSON.stringify(
              JSON.stringify({
                value: "Contributing guidance",
                view_bytes: 23,
                max_bytes: 32,
                operations: 1,
              }),
            ),
            status: "ok" as const,
            startedAt: 0,
            endedAt: 1,
            textOffset: null,
            parentToolCallId: "P1",
          },
        ],
      },
    }).body;

    expect(body).toContain("value view");
    expect(body).toMatch(/class="stage-title[^>]*>View<\/span>/);
    expect(body).toMatch(/data-kind="view"[^>]*open=""/);
    expect(body).toContain("Worker view");
    expect(body).toContain("value");
    expect(body).toContain("Execution details");
    expect(body).toContain("32 B");
    expect(body).toContain("return fs.readFile('CONTRIBUTING.md', 'utf8');");
    expect(body).toContain("Raw input payload");
    expect(body).toContain("View budget");
    expect(body).toContain("Exact text sent to worker");
    expect(body).toContain("Raw output payload");
    expect(body).toContain("Contributing guidance");
    expect(body).toContain("view_bytes");
    expect(body).not.toContain("not stored");
    expect(body).not.toContain("Store id");
  });

  test("ProcCall labels mutable store writes and their revision", () => {
    const body = render(ProcCall, {
      props: {
        toolCall: {
          id: "P1",
          messageId: "M1",
          tool: "proc",
          argsJson: JSON.stringify({
            summary: "Collect candidates",
            procedure: "Collect candidate files.",
            result_requirements: "Candidate paths",
          }),
          resultJson: null,
          status: "pending" as const,
          startedAt: 0,
          endedAt: null,
          textOffset: null,
          parentToolCallId: null,
        },
        childTools: [
          {
            id: "E12",
            messageId: "M1",
            tool: "execute",
            argsJson: JSON.stringify({
              needed_for: "Candidates for later filtering",
              javascript: "store.candidates = search.glob('**/*.ts');",
            }),
            resultJson: JSON.stringify(
              JSON.stringify({
                store_revision: "E12",
                store_writes: [
                  {
                    name: "candidates",
                    version: "E12",
                    result_id: "RES_1",
                    value_bytes: 24,
                    shape: "array(2) of string",
                  },
                ],
                store_snapshot: {
                  candidates: { toolCallId: 12, resultId: "RES_1" },
                },
                operations: 1,
              }),
            ),
            status: "ok" as const,
            startedAt: 0,
            endedAt: 1,
            textOffset: null,
            parentToolCallId: "P1",
          },
        ],
      },
    }).body;

    expect(body).toContain("stored: candidates");
    expect(body).toContain("Store revision");
    expect(body).toContain("E12");
    expect(body).not.toContain("not stored");
  });

  test("ToolCall renders a read text envelope via its tool-provided view, not JSON", () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "read",
      argsJson: "{}",
      resultJson: JSON.stringify({
        ok: true,
        result: {
          type: "text",
          file: { path: "a.ts", startLine: 1, numLines: 2, size: 4 },
        },
        views: [
          { type: "text", text: "alpha\nbeta\n(file has 2 total lines)" },
        ],
      }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    expect(body).toContain("alpha");
    expect(body).toContain("beta");
    expect(body).not.toContain('"content"');
  });

  test("ToolCall renders a read image envelope as a zoomable img, not JSON", () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "read",
      argsJson: "{}",
      resultJson: JSON.stringify({
        ok: true,
        result: {
          type: "image",
          file: { base64: "aGk=", type: "image/png", originalSize: 3 },
        },
        views: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    expect(body).toContain("<img");
    expect(body).toContain("data:image/png;base64,aGk=");
  });

  test("ToolCall renders a bash envelope via its tool-provided view text", () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "bash",
      argsJson: "{}",
      resultJson: JSON.stringify({
        ok: true,
        result: { command: "echo hi", exitCode: 0 },
        views: [{ type: "text", text: "hi\n" }],
      }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    expect(body).toContain("hi");
    expect(body).not.toContain('"stdout"');
  });

  test("ToolCall still renders JSON for a structured envelope without views", () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "read",
      argsJson: "{}",
      resultJson: JSON.stringify({
        ok: true,
        result: { type: "text", content: "hello", file: { path: "a.ts" } },
      }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    expect(body).toContain('"content"');
  });

  test('ToolCall surfaces a "Sent to model" disclosure for an envelope result', () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "git_log",
      argsJson: "{}",
      resultJson: JSON.stringify({
        ok: true,
        result: { commits: [{ sha: "a1", subject: "first" }] },
      }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    expect(body).toContain("Sent to model");
    expect(body).toContain("sha: a1");
  });

  test('ToolCall hides "Sent to model" for a non-envelope result', () => {
    const toolCall = {
      id: "X1",
      messageId: "M1",
      tool: "bash",
      argsJson: "{}",
      resultJson: JSON.stringify({ content: "x", detailedContent: "y" }),
      status: "ok" as const,
      startedAt: 0,
      endedAt: 1,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    expect(body).not.toContain("Sent to model");
  });

  test("ToolCall injects <wbr> break points after slashes in a long path summary", () => {
    const toolCall = {
      id: "X2",
      messageId: "M1",
      tool: "view",
      argsJson: JSON.stringify({
        path: "/workspaces/zap/src/routes/api/conversations/[id]/messages/[messageId]/edit/+server.ts",
      }),
      resultJson: null,
      status: "pending" as const,
      startedAt: 0,
      endedAt: null,
      textOffset: null,
      parentToolCallId: null,
    };
    const body = render(ToolCall, { props: { toolCall } }).body;
    const cleaned = body.replace(/<!--.*?-->/g, "");
    // Wrapping prefers '/' boundaries: a break opportunity is emitted after
    // each separator rather than letting the path overflow its container.
    expect(cleaned).toMatch(/messages\/<wbr[^>]*>/);
    expect(cleaned).toMatch(/\[messageId\]\/<wbr[^>]*>/);
    expect(cleaned).toMatch(/edit\/<wbr[^>]*>/);
    // No stray break opportunity mid-segment.
    expect(cleaned).not.toMatch(/zap-<wbr/);
  });

  test("FileBrowser renders safe empty states without client fetch data", () => {
    const body = render(FileBrowser, {
      props: { conversationId: "C1", pane: "changes" },
    }).body;

    expect(body).toContain('aria-label="Git status"');
    expect(body).toContain("Working tree clean.");
    expect(body).toContain("Select a file or commit to view it.");
  });

  test("PromptTemplateLauncher preserves blank chat and exposes template entry points", () => {
    const home = render(PromptTemplateLauncher, {
      props: { variant: "home" },
    }).body;
    const rail = render(PromptTemplateLauncher, {
      props: { variant: "rail" },
    }).body;

    expect(home).toContain("New shared chat");
    expect(home).toContain("New worktree chat");
    expect(home).toContain("Use template");
    expect(rail).toContain('aria-label="New blank chat"');
    expect(rail).toContain('aria-label="New chat from template"');
  });

  test("Ticket detail page renders plan and dependency relationships", () => {
    const base = {
      id: "t-ui",
      userId: "u1",
      workspaceKey: "/ws",
      title: "Build the UI",
      body: "Wire up the sidebar.",
      plan: "1. scaffold\n2. style",
      priority: "P2" as const,
      status: "open" as const,
      sourceConversationId: null,
      sourceMessageId: null,
      createdAt: 1,
      updatedAt: 2,
      closedAt: null,
    };
    const blocked = render(TicketPage, {
      props: {
        data: {
          ticket: base,
          dependsOn: [
            { id: "t-api", title: "Build the API", status: "open" as const },
          ],
          dependents: [
            { id: "t-ship", title: "Ship release", status: "open" as const },
          ],
        },
      },
    } as never).body;
    expect(blocked).toContain("Build the UI");
    expect(blocked).toContain("1. scaffold");
    expect(blocked).toContain("Wire up the sidebar.");
    expect(blocked).toContain('href="/tickets/t-api"');
    expect(blocked).toContain('href="/tickets/t-ship"');
    // An open prerequisite flags the ticket as blocked (via a status pill).
    expect(blocked).toContain("Blocked");

    const ready = render(TicketPage, {
      props: {
        data: {
          ticket: { ...base, plan: "" },
          dependsOn: [
            { id: "t-api", title: "Build the API", status: "done" as const },
          ],
          dependents: [],
        },
      },
    } as never).body;
    // All prerequisites satisfied -> ready; empty plan shows a placeholder.
    expect(ready).toContain("Ready to start");
    expect(ready).toContain("No plan recorded.");
  });

  test("Tickets index renders rows, status tabs, and a load-more affordance", () => {
    const row = (
      id: string,
      title: string,
      status: "open" | "done" | "archived",
    ) => ({
      id,
      userId: "u1",
      workspaceKey: "/ws",
      title,
      body: "",
      plan: "",
      priority: "P2" as const,
      status,
      sourceConversationId: null,
      sourceMessageId: null,
      createdAt: 1,
      updatedAt: 2,
      closedAt: null,
    });
    const body = render(TicketsIndexPage, {
      props: {
        data: {
          ticketWorkspace: "/ws",
          pageSize: 20,
          initialStatus: "open" as const,
          initialTickets: [
            row("t-1", "First ticket", "open"),
            row("t-2", "Second ticket", "open"),
          ],
          initialHasMore: true,
        },
      },
    } as never).body;
    expect(body).toContain("First ticket");
    expect(body).toContain('href="/tickets/t-1"');
    // Status tabs are present.
    expect(body).toContain("Open");
    expect(body).toContain("Archived");
    // A full first page surfaces the Load more control.
    expect(body).toContain("Load more");
  });

  test("Tickets index degrades gracefully with no current workspace", () => {
    const body = render(TicketsIndexPage, {
      props: {
        data: {
          ticketWorkspace: null,
          pageSize: 20,
          initialStatus: "open" as const,
          initialTickets: [],
          initialHasMore: false,
        },
      },
    } as never).body;
    expect(body).toContain("No active workspace");
    expect(body).not.toContain("Load more");
  });

  test("Tickets index shows a per-filter empty state", () => {
    const body = render(TicketsIndexPage, {
      props: {
        data: {
          ticketWorkspace: "/ws",
          pageSize: 20,
          initialStatus: "open" as const,
          initialTickets: [],
          initialHasMore: false,
        },
      },
    } as never).body;
    expect(body).toContain("No open tickets.");
  });

  test("Tickets index shows a priority-filtered empty state", () => {
    const body = render(TicketsIndexPage, {
      props: {
        data: {
          ticketWorkspace: "/ws",
          pageSize: 20,
          initialStatus: "open" as const,
          initialSort: "recency" as const,
          initialPriority: "P1" as const,
          initialTickets: [],
          initialHasMore: false,
        },
      },
    } as never).body;
    expect(body).toContain("No tickets match this priority.");
  });

  test("Prompts settings lists built-ins and user-managed templates", () => {
    const body = render(PromptsSettings, {
      props: {
        settings: {
          defaultModel: null,
          defaultWorkdir: null,
          defaultConversationMode: "interactive",
          defaultApprovalMode: "ask",
          defaultPolicy: "prompt",
          theme: "system",
          accent: "default",
          defaultPromptTemplateId: null,
        },
        builtInTemplates: listBuiltInPromptTemplates(),
        promptTemplates: [
          {
            id: "PT1",
            userId: 1,
            type: "chat",
            title: "Weekly review",
            description: "Summarize changes",
            prompt: "Review this week of work.",
            launchBehavior: "draft",
            conversationMode: null,
            approvalMode: null,
            model: null,
            disabledToolGroups: [],
            workspaceMode: null,
            status: "open",
            pinned: true,
            orderIndex: 1,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
          },
          {
            id: "PT2",
            userId: 1,
            type: "ticket-action",
            title: "Do",
            description: "Implement the ticket",
            prompt: "Do this workspace ticket: {{ticket.title}}",
            launchBehavior: "send",
            conversationMode: null,
            approvalMode: null,
            model: null,
            disabledToolGroups: [],
            workspaceMode: null,
            status: "open",
            pinned: true,
            orderIndex: 10,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
          },
        ],
        form: null,
      },
    }).body;

    expect(body).toContain("Create a chat template");
    expect(body).toContain("Built-in templates");
    expect(body).toContain("Code review");
    expect(body).toContain("Weekly review");
    expect(body).toContain("Ticket actions");
    expect(body).toContain("Restore default actions");
    expect(body).toContain("Archive");
    // Both template types expose the same launch-behavior + Git-workspace
    // controls, including the review option.
    expect(body).toContain("Review before sending");
    expect(body).toContain("New isolated worktree");
    expect(body).not.toContain("Ask me at launch");
  });

  test("Launch review dialog seeds the prompt and options from the template", () => {
    const body = render(LaunchReviewDialog, {
      props: {
        open: true,
        templateTitle: "Weekly review",
        defaults: {
          prompt: "Review this week of work.",
          workspace: "worktree",
          conversationMode: "autopilot",
          approvalMode: "auto-deny",
          model: "gpt-5.5",
          disabledToolGroups: [],
          modelOptions: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
        },
        onLaunch: () => {},
        onCancel: () => {},
      },
    }).body;

    expect(body).toContain("Review before sending");
    expect(body).toContain("Launching “Weekly review”");
    expect(body).toContain("Review this week of work.");
    expect(body).toContain("Git workspace");
    expect(body).toContain("New isolated worktree");
    expect(body).toContain("Launch chat");
    // A stale/unlisted model override still shows up as the selected option.
    expect(body).toContain("gpt-5.5");
    // The fetched catalog populates the model picker's option list.
    expect(body).toContain("openai/gpt-4o");
    expect(body).toContain("anthropic/claude-3-5-sonnet");
  });
});
