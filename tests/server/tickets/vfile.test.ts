import { describe, it, expect } from "vitest";
import {
  serializeTicketFile,
  parseTicketFile,
  ticketFileDiff,
  type TicketVFile,
} from "$lib/tickets/vfile";

const ticket: TicketVFile = {
  id: "T10",
  title: "Fix the auth race",
  plan: "step one\nstep two",
  body: "The guard is racy.\n\nMore context here.",
  status: "open",
  priority: "P2",
};

describe("serializeTicketFile", () => {
  it("round-trips through parse", () => {
    const text = serializeTicketFile(ticket);
    const parsed = parseTicketFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(ticket);
  });

  it("produces TOML frontmatter with body below", () => {
    const text = serializeTicketFile(ticket);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain('status = "open"');
    expect(text).toContain('priority = "P2"');
    // body is markdown, not escaped into TOML
    const split = text.split("\n---\n\n");
    expect(split.length).toBe(2);
    expect(split[1]).toBe(ticket.body);
  });
});

describe("parseTicketFile", () => {
  it("parses an edited body without touching frontmatter", () => {
    const text = serializeTicketFile(ticket);
    const edited = text.replace("guard is racy", "guard is fine");
    const parsed = parseTicketFile(edited);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe(ticket.body.replace("racy", "fine"));
    expect(parsed.value.title).toBe(ticket.title);
    expect(parsed.value.status).toBe("open");
  });

  it("parses an edited plan", () => {
    const text = serializeTicketFile(ticket);
    const edited = text.replace("step two", "step three");
    const parsed = parseTicketFile(edited);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.plan).toBe("step one\nstep three");
  });

  it("recovers body only when frontmatter is malformed", () => {
    // Chop a line out of the frontmatter so TOML parse fails.
    const text = serializeTicketFile(ticket);
    const broken = text.replace('status = "open"\n', "");
    const parsed = parseTicketFile(broken);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe(ticket.body);
  });

  it("treats a trailing fence as body when none closes", () => {
    const text = "just a body, no frontmatter";
    const parsed = parseTicketFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe(text);
  });

  it("rejects an invalid ticket id", () => {
    const text = serializeTicketFile({ ...ticket, id: "nope" });
    const parsed = parseTicketFile(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("invalid ticket id");
  });

  it("rejects an empty title", () => {
    const text = serializeTicketFile({ ...ticket, title: "   " });
    const parsed = parseTicketFile(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("title cannot be empty");
  });
});

describe("ticketFileDiff", () => {
  it("returns an empty patch when nothing changed", () => {
    expect(ticketFileDiff(ticket, ticket)).toEqual({});
  });

  it("returns only the changed field for an edit", () => {
    const edited = { ...ticket, body: ticket.body.replace("racy", "fine") };
    expect(ticketFileDiff(ticket, edited)).toEqual({ body: edited.body });
  });

  it("routes a status change through", () => {
    const edited = { ...ticket, status: "done" as const };
    expect(ticketFileDiff(ticket, edited)).toEqual({ status: "done" });
  });
});
