import type { PortalTool } from "./git";

// Validates a PortalTool's args against its declared Zod schema and
// returns a structured feedback string (per-field issues plus the
// tool's JSON Schema) when validation fails. The portal's permission
// gateway calls this before opening any dialog so that misuse of a
// tool's argument schema rejects immediately with enough information
// for the agent to self-correct on the next turn.

export interface SchemaValidationFailure {
  ok: false;
  feedback: string;
}

export function validatePortalToolArgs(
  tool: PortalTool,
  args: unknown,
): { ok: true } | SchemaValidationFailure {
  if (!tool.argsSchema) return { ok: true };
  const result = tool.argsSchema.safeParse(args);
  if (result.success) return { ok: true };
  const issues = result.error.issues
    .map((i) => {
      const path = i.path.length ? i.path.join(".") : "(root)";
      return `  - ${path}: ${i.message}`;
    })
    .join("\n");
  const schema = JSON.stringify(tool.parameters, null, 2);
  const feedback = [
    `Invalid arguments for tool "${tool.name}":`,
    issues || "  - (no issue details)",
    "",
    `Expected JSON Schema for "${tool.name}" parameters:`,
    schema,
  ].join("\n");
  return { ok: false, feedback };
}

// Build a validator keyed by tool name, used by the SDK-path permission
// gateway to short-circuit invalid custom-tool calls before they reach
// the user. Returns null for unknown tool names so the gateway can
// proceed normally for non-portal tools.
export function buildToolArgsValidator(
  tools: PortalTool[],
): (toolName: string, args: unknown) => SchemaValidationFailure | null {
  const byName = new Map<string, PortalTool>();
  for (const t of tools) byName.set(t.name, t);
  return (toolName, args) => {
    const tool = byName.get(toolName);
    if (!tool) return null;
    const result = validatePortalToolArgs(tool, args);
    return result.ok ? null : result;
  };
}
