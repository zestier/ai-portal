// Opaque prefixed id handles — the single wire format for entity ids outside
// the storage layer.
//
// Every entity a repo hands back carries an id like `T10`, not `10`; only the
// DB repos treat ids as integers (params stay int, rows are encoded at the
// repo boundary). This kills the string/number mismatch bug class (a handle is
// self-describing, greppable in logs, and fails fast on parse) without a
// two-phase REST/tools split: one cutover, one format everywhere.
//
// Prefix table (final — attachments were removed, so there are no attachment
// prefixes):
//   T   ticket
//   C   conversation
//   M   message
//   X   tool call
//   L   lease
//   PT  prompt template
//   E   memory entity
//   F   memory fact
//   PC  memory patch item
//
// Deliberate exceptions that stay raw ints:
//   - `userId` never crosses the wire as anything but an int.
//   - `fields/[kind]/[recordId]` (and other kind-scoped record refs) stays int:
//     kind-scoped, server-minted, echoed verbatim.
//   - SSE event ids, turn ids, agent ids, action slugs are already opaque.
//
// A codec's regex is ANCHORED to its own prefix, so prefixes may nest safely:
// `factId.parse('FE7')` rejects (the numeric part must be digits) even though
// 'F' is a prefix of a hypothetical 'FE' file-edit id.
//
// Handles are NEVER sorted or compared lexically — parse them and compare the
// numeric part (or sort by created_at). Leading zeros are rejected so a handle
// has exactly one textual form.

export interface IdCodec {
  readonly prefix: string;
  readonly label: string;
  /** Anchored, case-insensitive; the numeric part is `[1-9][0-9]*`. */
  readonly regex: RegExp;
  /** `10` -> `'T10'`. Throws unless `id` is a positive safe integer. */
  encode(id: number): string;
  /** `'T10'` -> `10`. Throws with a precise message on any invalid input. */
  parse(handle: string): number;
  /** `'T10'` -> true; `10`, `'10'`, `'T007'`, junk -> false. */
  is(value: unknown): value is string;
  /** The failure message `parse` throws, e.g. "not a ticket id: 10 — expected T<number>". */
  error(input: unknown): string;
  /** `parse` without throwing: null when `value` isn't a valid handle. */
  tryParse(value: unknown): number | null;
}

export function makeId(spec: { prefix: string; label: string }): IdCodec {
  const { prefix, label } = spec;
  if (!/^[A-Z]+$/.test(prefix)) {
    throw new Error(
      `id prefix must be uppercase ASCII letters, got ${JSON.stringify(prefix)}`,
    );
  }
  // Anchored: `^` .. `$`. Case-insensitive so `t10` and `T10` are the same
  // handle. The numeric part starts at 1-9 (no leading zeros, no zero/negative).
  const regex = new RegExp(`^${prefix}([1-9][0-9]*)$`, "i");

  function error(input: unknown): string {
    const shown = typeof input === "string" ? input : String(input);
    return `not a ${label} id: ${shown} — expected ${prefix}<number>`;
  }

  return {
    prefix,
    label,
    regex,
    encode(id: number): string {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(
          `cannot encode ${label} id: ${String(id)} — expected a positive safe integer`,
        );
      }
      return `${prefix}${id}`;
    },
    parse(handle: string): number {
      if (typeof handle !== "string" || !regex.test(handle))
        throw new Error(error(handle));
      const id = Number(handle.slice(prefix.length));
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(error(handle));
      return id;
    },
    is(value: unknown): value is string {
      return typeof value === "string" && regex.test(value);
    },
    error,
    tryParse(value: unknown): number | null {
      if (typeof value !== "string" || !regex.test(value)) return null;
      const id = Number(value.slice(prefix.length));
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },
  };
}

export const ticketId = makeId({ prefix: "T", label: "ticket" });
export const conversationId = makeId({ prefix: "C", label: "conversation" });
export const messageId = makeId({ prefix: "M", label: "message" });
export const toolCallId = makeId({ prefix: "X", label: "tool call" });
export const leaseId = makeId({ prefix: "L", label: "lease" });
export const promptTemplateId = makeId({
  prefix: "PT",
  label: "prompt template",
});
export const extensionId = makeId({ prefix: "EX", label: "extension" });
export const memoryEntityId = makeId({ prefix: "E", label: "memory entity" });
export const memoryFactId = makeId({ prefix: "F", label: "memory fact" });
export const memoryPatchItemId = makeId({
  prefix: "PC",
  label: "memory patch item",
});
