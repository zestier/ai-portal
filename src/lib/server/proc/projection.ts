import { projectShape } from "./shape";
import type { ProcOutputPolicy } from "./store";

export interface ProcProjection {
  projection?: unknown;
  projectionBytes: number;
  truncated: boolean;
}

export function projectProcValue(
  value: unknown,
  policy: ProcOutputPolicy,
): ProcProjection {
  if (policy.mode === "none") {
    return { projectionBytes: 0, truncated: false };
  }
  if (policy.maxBytes === undefined) {
    throw new Error(`${policy.mode} projection requires max_bytes.`);
  }
  if (policy.mode === "shape") {
    const shape = projectShape(value, policy.maxBytes);
    return {
      projection: shape.text,
      projectionBytes: shape.bytes,
      truncated: shape.truncated,
    };
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error(
      "Non-JSON result. Return string, finite number, boolean, null, array, or object.",
    );
  const bytes = Buffer.byteLength(encoded);
  if (bytes > policy.maxBytes) {
    throw new Error(
      `Result ${bytes}B; transport limit ${policy.maxBytes}B. Derive required fields or judgment evidence in JavaScript; never paginate through model context.`,
    );
  }
  return { projection: value, projectionBytes: bytes, truncated: false };
}
