export interface ShapeProjection {
  text: string;
  bytes: number;
  truncated: boolean;
}

type ScalarKind = "null" | "boolean" | "string" | "integer" | "number";

type Shape =
  | { kind: ScalarKind }
  | { kind: "array"; minLength: number; maxLength: number; item?: Shape }
  | { kind: "object"; fields: Map<string, ShapeField> }
  | { kind: "union"; variants: Shape[] };

interface ShapeField {
  shape: Shape;
  optional: boolean;
}

interface InferredShape {
  shape: Shape;
  truncated: boolean;
}

const MAX_INFER_DEPTH = 32;
const MAX_UNION_VARIANTS = 8;
const MAX_RENDER_DEPTH = 12;

export function projectShape(
  value: unknown,
  maxBytes: number,
): ShapeProjection {
  if (!Number.isInteger(maxBytes) || maxBytes < 32) {
    throw new Error("Shape maxBytes must be an integer of at least 32.");
  }
  assertJsonValue(value);
  const inferred = inferShape(value, 0);
  for (let depth = MAX_RENDER_DEPTH; depth >= 0; depth--) {
    const text = renderShape(inferred.shape, depth);
    const bytes = Buffer.byteLength(text);
    if (bytes <= maxBytes) {
      return {
        text,
        bytes,
        truncated: inferred.truncated || depth < MAX_RENDER_DEPTH,
      };
    }
  }
  const text = truncateUtf8(renderShape(inferred.shape, 0), maxBytes);
  return { text, bytes: Buffer.byteLength(text), truncated: true };
}

function inferShape(value: unknown, depth: number): InferredShape {
  if (depth >= MAX_INFER_DEPTH) {
    return { shape: { kind: "object", fields: new Map() }, truncated: true };
  }
  if (value === null) return { shape: { kind: "null" }, truncated: false };
  if (typeof value === "boolean")
    return { shape: { kind: "boolean" }, truncated: false };
  if (typeof value === "string")
    return { shape: { kind: "string" }, truncated: false };
  if (typeof value === "number") {
    return {
      shape: { kind: Number.isInteger(value) ? "integer" : "number" },
      truncated: false,
    };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return {
        shape: { kind: "array", minLength: 0, maxLength: 0 },
        truncated: false,
      };
    }
    let item: Shape | undefined;
    let truncated = false;
    for (const entry of value) {
      const inferred = inferShape(entry, depth + 1);
      item = item ? mergeShapes(item, inferred.shape) : inferred.shape;
      truncated ||= inferred.truncated;
    }
    const compacted = compactUnion(item!);
    return {
      shape: {
        kind: "array",
        minLength: value.length,
        maxLength: value.length,
        item: compacted.shape,
      },
      truncated: truncated || compacted.truncated,
    };
  }
  const fields = new Map<string, ShapeField>();
  let truncated = false;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const inferred = inferShape(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
    fields.set(key, { shape: inferred.shape, optional: false });
    truncated ||= inferred.truncated;
  }
  return { shape: { kind: "object", fields }, truncated };
}

function mergeShapes(left: Shape, right: Shape): Shape {
  if (left.kind === "integer" && right.kind === "number") return right;
  if (left.kind === "number" && right.kind === "integer") return left;
  if (left.kind !== right.kind) return unionOf(left, right);
  if (isScalar(left) && isScalar(right)) return left;
  if (left.kind === "array" && right.kind === "array") {
    return {
      kind: "array",
      minLength: Math.min(left.minLength, right.minLength),
      maxLength: Math.max(left.maxLength, right.maxLength),
      ...(left.item && right.item
        ? { item: mergeShapes(left.item, right.item) }
        : left.item
          ? { item: left.item }
          : right.item
            ? { item: right.item }
            : {}),
    };
  }
  if (left.kind === "object" && right.kind === "object") {
    const fields = new Map<string, ShapeField>();
    const keys = new Set([...left.fields.keys(), ...right.fields.keys()]);
    for (const key of [...keys].sort()) {
      const leftField = left.fields.get(key);
      const rightField = right.fields.get(key);
      if (leftField && rightField) {
        fields.set(key, {
          shape: mergeShapes(leftField.shape, rightField.shape),
          optional: leftField.optional || rightField.optional,
        });
      } else {
        const field = leftField ?? rightField!;
        fields.set(key, { shape: field.shape, optional: true });
      }
    }
    return { kind: "object", fields };
  }
  if (left.kind === "union" && right.kind === "union") {
    return unionOf(...left.variants, ...right.variants);
  }
  return unionOf(left, right);
}

function unionOf(...input: Shape[]): Shape {
  const flattened = input.flatMap((shape) =>
    shape.kind === "union" ? shape.variants : [shape],
  );
  const byKey = new Map<string, Shape>();
  for (const shape of flattened) byKey.set(shapeKey(shape), shape);
  const variants = [...byKey.values()].sort((a, b) =>
    shapeKey(a).localeCompare(shapeKey(b)),
  );
  return variants.length === 1 ? variants[0] : { kind: "union", variants };
}

function compactUnion(shape: Shape): { shape: Shape; truncated: boolean } {
  if (shape.kind !== "union" || shape.variants.length <= MAX_UNION_VARIANTS) {
    return { shape, truncated: false };
  }
  return {
    shape: {
      kind: "union",
      variants: shape.variants.slice(0, MAX_UNION_VARIANTS),
    },
    truncated: true,
  };
}

function renderShape(shape: Shape, depth: number): string {
  if (isScalar(shape)) return shape.kind;
  if (shape.kind === "array") {
    const length =
      shape.minLength === shape.maxLength
        ? String(shape.minLength)
        : `${shape.minLength}..${shape.maxLength}`;
    if (!shape.item || shape.maxLength === 0) return `array(${length})`;
    return depth <= 0
      ? `array(${length}) of …`
      : `array(${length}) of ${renderShape(shape.item, depth - 1)}`;
  }
  if (shape.kind === "object") {
    if (shape.fields.size === 0) return "object {}";
    if (depth <= 0) return `object { … ${shape.fields.size} fields }`;
    const fields = [...shape.fields.entries()].map(
      ([key, field]) =>
        `${renderKey(key)}${field.optional ? "?" : ""}: ${renderShape(field.shape, depth - 1)}`,
    );
    return `object { ${fields.join(", ")} }`;
  }
  if (depth <= 0) return `union(${shape.variants.length})`;
  return shape.variants
    .map((variant) => renderShape(variant, depth - 1))
    .join(" | ");
}

function shapeKey(shape: Shape): string {
  return renderShape(shape, MAX_RENDER_DEPTH);
}

function renderKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function isScalar(shape: Shape): shape is { kind: ScalarKind } {
  return (
    shape.kind === "null" ||
    shape.kind === "boolean" ||
    shape.kind === "string" ||
    shape.kind === "integer" ||
    shape.kind === "number"
  );
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Proc state must contain finite JSON numbers.");
    return;
  }
  if (typeof value !== "object") {
    throw new Error("Proc state must be JSON-compatible.");
  }
  if (seen.has(value)) throw new Error("Proc state must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, seen);
  } else {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, seen);
    }
  }
  seen.delete(value);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const marker = "…";
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) return "";
  let used = 0;
  let result = "";
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (used + bytes + markerBytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result + marker;
}
