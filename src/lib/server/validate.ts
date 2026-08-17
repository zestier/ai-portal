import { z } from "zod";
import { apiError } from "$lib/server/http";

/**
 * Parse a request body against a Zod schema, turning validation failures
 * into a 400 instead of letting the generic error handler produce a 500.
 *
 * The request body is decoded with `request.json()`; an empty/invalid body
 * is normalized to `{}` so schemas relying on `.default(...)` still work.
 * Pass `{ allowEmpty: true }` to also normalize to `{}` for endpoints that
 * accept an entirely missing body (e.g. retry-from-assistant fork).
 */
export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  opts: { allowEmpty?: boolean } = {},
): Promise<z.infer<T>> {
  let raw: unknown;
  if (opts.allowEmpty) {
    const text = await request.text();
    if (!text) {
      raw = {};
    } else {
      try {
        raw = JSON.parse(text);
      } catch {
        apiError(400, "bad_request", "Invalid JSON body");
      }
    }
  } else {
    raw = await request.json().catch(() => ({}));
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    apiError(400, "bad_request", formatZodError(result.error));
  }
  return result.data;
}

function formatZodError(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return "Invalid request body";
  const path = first.path.join(".");
  return path ? `${path}: ${first.message}` : first.message;
}
