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
    throw new Error("Proc result must be JSON-compatible.");
  const bytes = Buffer.byteLength(encoded);
  if (bytes > policy.maxBytes) {
    throw new Error(
      `Exact proc projection was ${bytes} bytes; declared maximum is ${policy.maxBytes} bytes. Return a smaller value or request shape.`,
    );
  }
  return { projection: value, projectionBytes: bytes, truncated: false };
}
