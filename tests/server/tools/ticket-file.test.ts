import { describe, expect, it } from "vitest";
import {
  parseTicketPath,
  ticketFileContent,
} from "$lib/server/tools/ticket-file";
import {
  parseTicketFile,
  ticketFileDiff,
  type TicketVFile,
} from "$lib/tickets/vfile";

describe("parseTicketPath", () => {
  it("returns null for non-ticket paths", () => {
    expect(parseTicketPath("src/main.ts")).toBeNull();
    expect(parseTicketPath("ticket")).toBeNull();
    expect(parseTicketPath("")).toBeNull();
  });

  it("parses ticket:T5 as single", () => {
    const result = parseTicketPath("ticket:T5");
    expect(result).toEqual({ kind: "single", ticketId: "T5" });
  });

  it("parses ticket:open/T5 as scoped", () => {
    const result = parseTicketPath("ticket:open/T5");
    expect(result).toEqual({ kind: "scoped", ticketId: "T5" });
  });

  it("parses ticket:open as folder", () => {
    const result = parseTicketPath("ticket:open");
    expect(result).toEqual({ kind: "folder" });
  });

  it("parses ticket:open/ with no id as folder", () => {
    const result = parseTicketPath("ticket:open/");
    expect(result).toEqual({ kind: "folder" });
  });
});

describe("ticketFileContent", () => {
  const ticket: TicketVFile = {
    id: "T5",
    title: "Fix the auth race",
    plan: "step one",
    body: "The guard is racy.",
    status: "open",
    priority: "P2",
  };

  it("serializes a ticket to TOML frontmatter + markdown body", () => {
    const content = ticketFileContent(ticket);
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain('id = "T5"');
    expect(content).toContain('title = "Fix the auth race"');
    expect(content).toContain('status = "open"');
    expect(content).toContain('priority = "P2"');
    expect(content).toContain("The guard is racy.");
  });

  it("round-trips through parseTicketFile", () => {
    const content = ticketFileContent(ticket);
    const parsed = parseTicketFile(content);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe(ticket.id);
    expect(parsed.value.title).toBe(ticket.title);
    expect(parsed.value.body).toBe(ticket.body);
    expect(parsed.value.status).toBe(ticket.status);
    expect(parsed.value.priority).toBe(ticket.priority);
  });
});

describe("ticketFileDiff integration", () => {
  it("detects a title change from edited virtual file", () => {
    const current: TicketVFile = {
      id: "T5",
      title: "Old title",
      plan: "",
      body: "Body text.",
      status: "open",
      priority: "P2",
    };
    const edited: TicketVFile = { ...current, title: "New title" };
    const patch = ticketFileDiff(current, edited);
    expect(patch).toEqual({ title: "New title" });
  });

  it("detects a status change from edited virtual file", () => {
    const current: TicketVFile = {
      id: "T5",
      title: "Title",
      plan: "",
      body: "Body text.",
      status: "open",
      priority: "P2",
    };
    const edited: TicketVFile = { ...current, status: "done" };
    const patch = ticketFileDiff(current, edited);
    expect(patch).toEqual({ status: "done" });
  });
});
