import { z } from "zod";
import type { WorkspaceTicket } from "$lib/types";
import * as tickets from "$lib/server/db/repos/tickets";
import type { UpdateInput } from "$lib/server/db/repos/tickets";
import { err, ok, type PortalTool } from "$lib/server/tools/types";

const TicketId = z.string().regex(/^T[1-9][0-9]*$/);
const Status = z.enum(["open", "done", "archived"]);
const Priority = z.enum(["P0", "P1", "P2", "P3"]);
const EdgeIds = z.array(TicketId).max(100);
const TicketContent = {
  title: z.string().trim().min(1).max(200),
  body: z.string().max(8000),
  plan: z.string().max(100000),
  status: Status,
  priority: Priority,
  blockedBy: EdgeIds,
  blocks: EdgeIds,
};
const CreateArgs = z
  .object({
    title: TicketContent.title,
    body: TicketContent.body.optional(),
    plan: TicketContent.plan.optional(),
    priority: TicketContent.priority.optional(),
    blockedBy: TicketContent.blockedBy.optional(),
    blocks: TicketContent.blocks.optional(),
  })
  .strict();
const GetArgs = z.object({ id: TicketId }).strict();
const UpdateArgs = z
  .object({
    id: TicketId,
    patch: z
      .object({
        title: TicketContent.title.optional(),
        body: TicketContent.body.optional(),
        plan: TicketContent.plan.optional(),
        status: TicketContent.status.optional(),
        priority: TicketContent.priority.optional(),
        blockedBy: TicketContent.blockedBy.optional(),
        blocks: TicketContent.blocks.optional(),
      })
      .strict()
      .refine((patch) => Object.keys(patch).length > 0, "patch is empty"),
  })
  .strict();
const ListArgs = z
  .object({ status: z.enum(["open", "done", "archived", "all"]).optional() })
  .strict();

const TicketResult = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    plan: { type: "string" },
    status: { type: "string", enum: ["open", "done", "archived"] },
    priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    blockedBy: { type: "array", items: { type: "string" } },
    blocks: { type: "array", items: { type: "string" } },
  },
  required: [
    "id",
    "title",
    "body",
    "plan",
    "status",
    "priority",
    "blockedBy",
    "blocks",
  ],
  additionalProperties: false,
} as const;

export function buildProcTicketTools(opts: {
  userId: number;
  workspaceKey: string;
  conversationId: number;
}): PortalTool[] {
  const create: PortalTool = {
    name: "ticket_add",
    description: "Create workspace ticket.",
    parameters: parameters(CreateArgs),
    argsSchema: CreateArgs,
    program: {
      catalogDescription: "create durable workspace ticket",
      operationCategory: "mutation",
      resultSchema: { type: "string", description: "Assigned ticket id." },
      example: 'tools.ticket_add({ title: "Follow-up", body: "Details" })',
      contractVersion: "1",
    },
    async handler(raw) {
      const args = CreateArgs.parse(raw);
      try {
        const ticket = tickets.create(opts.userId, {
          workspaceKey: opts.workspaceKey,
          title: args.title,
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(args.plan !== undefined ? { plan: args.plan } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.blockedBy !== undefined
            ? { blockedBy: args.blockedBy.map(tickets.ticketInt) }
            : {}),
          ...(args.blocks !== undefined
            ? { blocks: args.blocks.map(tickets.ticketInt) }
            : {}),
          sourceConversationId: opts.conversationId,
        });
        return ok(ticket.id);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const get: PortalTool = {
    name: "ticket_get",
    description: "Get workspace ticket.",
    parameters: parameters(GetArgs),
    argsSchema: GetArgs,
    program: {
      catalogDescription: "read complete workspace ticket",
      operationCategory: "read",
      resultSchema: TicketResult,
      example: 'tools.ticket_get({ id: "T12" })',
      contractVersion: "1",
    },
    async handler(raw) {
      const { id } = GetArgs.parse(raw);
      const ticket = tickets.get(id, opts.userId);
      return ticket?.workspaceKey === opts.workspaceKey
        ? ok(ticketView(ticket))
        : err(`Ticket not found: ${id}`);
    },
  };

  const update: PortalTool = {
    name: "ticket_update",
    description: "Patch workspace ticket.",
    parameters: parameters(UpdateArgs),
    argsSchema: UpdateArgs,
    program: {
      catalogDescription:
        "patch ticket; blockedBy and blocks replace complete arrays",
      operationCategory: "mutation",
      resultSchema: TicketResult,
      example: 'tools.ticket_update({ id: "T12", patch: { status: "done" } })',
      contractVersion: "1",
    },
    async handler(raw) {
      const { id, patch } = UpdateArgs.parse(raw);
      const current = tickets.get(id, opts.userId);
      if (!current || current.workspaceKey !== opts.workspaceKey) {
        return err(`Ticket not found: ${id}`);
      }
      try {
        const updateInput: UpdateInput = {};
        if (patch.title !== undefined) updateInput.title = patch.title;
        if (patch.body !== undefined) updateInput.body = patch.body;
        if (patch.plan !== undefined) updateInput.plan = patch.plan;
        if (patch.status !== undefined) updateInput.status = patch.status;
        if (patch.priority !== undefined) updateInput.priority = patch.priority;
        if (patch.blockedBy !== undefined) {
          updateInput.blockedBy = patch.blockedBy.map(tickets.ticketInt);
        }
        if (patch.blocks !== undefined) {
          updateInput.blocks = patch.blocks.map(tickets.ticketInt);
        }
        const updated = tickets.update(id, opts.userId, updateInput);
        return updated
          ? ok(ticketView(updated))
          : err(`Ticket not found: ${id}`);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const list: PortalTool = {
    name: "ticket_list",
    description: "List workspace tickets.",
    parameters: parameters(ListArgs),
    argsSchema: ListArgs,
    program: {
      catalogDescription: "list complete tickets; default open",
      operationCategory: "read",
      resultSchema: { type: "array", items: TicketResult },
      example: 'tools.ticket_list({ status: "open" })',
      contractVersion: "1",
    },
    async handler(raw) {
      const { status = "open" } = ListArgs.parse(raw);
      return ok(
        tickets
          .list(opts.userId, opts.workspaceKey, { status })
          .map(ticketView),
      );
    },
  };

  return [create, get, update, list];
}

function ticketView(ticket: WorkspaceTicket) {
  return {
    id: ticket.id,
    title: ticket.title,
    body: ticket.body,
    plan: ticket.plan,
    status: ticket.status,
    priority: ticket.priority,
    blockedBy: tickets.listDependencies(ticket.id),
    blocks: tickets.listDependents(ticket.id),
  };
}

function parameters(schema: z.ZodType): Record<string, unknown> {
  const value = z.toJSONSchema(schema, { io: "input" });
  delete value.$schema;
  return value;
}
