export const PROGRAM_RESULT_OVERFLOWS = [
  "reject",
  "head",
  "tail",
  "truncate-middle",
  "structure",
] as const;

export type ProgramResultOverflow = (typeof PROGRAM_RESULT_OVERFLOWS)[number];

export const MIN_PROGRAM_RESULT_BYTES = 1024;
export const MAX_PROGRAM_RESULT_BYTES = 48 * 1024;

export type ProgramResultProjection =
  | { ok: true; text: string; originalBytes: number; lossy: boolean }
  | { ok: false; message: string; originalBytes: number };

export function projectProgramResult(
  value: unknown,
  operations: number,
  maxBytes: number,
  overflow: ProgramResultOverflow,
): ProgramResultProjection {
  const rendered = renderValue(value);
  const complete = withOperations(rendered, operations);
  const originalBytes = Buffer.byteLength(complete);
  if (originalBytes <= maxBytes) {
    return { ok: true, text: complete, originalBytes, lossy: false };
  }
  if (overflow === "reject") {
    return {
      ok: false,
      message: `Program result was ${originalBytes} bytes; declared maximum is ${maxBytes} bytes. Reduce or aggregate the returned value.`,
      originalBytes,
    };
  }

  const source =
    overflow === "structure"
      ? withOperations(renderStructure(value), operations)
      : complete;
  const label = overflow === "structure" ? "structural projection" : overflow;
  const marker = `\n... Program result limited to ${maxBytes} bytes using ${label}; original model output was ${originalBytes} bytes ...\n`;
  const text = truncateWithMarker(source, maxBytes, overflow, marker);
  return { ok: true, text, originalBytes, lossy: true };
}

function renderValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function withOperations(text: string, operations: number): string {
  return `${text}\n\nOperations: ${operations}`;
}

function truncateWithMarker(
  text: string,
  maxBytes: number,
  overflow: Exclude<ProgramResultOverflow, "reject">,
  marker: string,
): string {
  const markerBytes = Buffer.byteLength(marker);
  const contentBytes = Math.max(0, maxBytes - markerBytes);
  if (Buffer.byteLength(text) <= contentBytes) return text + marker;
  if (overflow === "head") {
    return takeHead(text, contentBytes) + marker;
  }
  if (overflow === "tail") {
    return marker + takeTail(text, contentBytes);
  }
  const headBytes = Math.ceil(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  return takeHead(text, headBytes) + marker + takeTail(text, tailBytes);
}

function takeHead(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function takeTail(text: string, maxBytes: number): string {
  let bytes = 0;
  const result: string[] = [];
  const chars = Array.from(text);
  for (let index = chars.length - 1; index >= 0; index--) {
    const charBytes = Buffer.byteLength(chars[index]);
    if (bytes + charBytes > maxBytes) break;
    result.push(chars[index]);
    bytes += charBytes;
  }
  return result.reverse().join("");
}

function renderStructure(value: unknown): string {
  const lines: string[] = [];
  appendStructure(value, "$", 0, lines);
  return lines.join("\n");
}

function appendStructure(
  value: unknown,
  label: string,
  depth: number,
  lines: string[],
): void {
  const indent = "  ".repeat(depth);
  if (value === null || typeof value !== "object") {
    lines.push(`${indent}${label}: ${scalarSummary(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    lines.push(`${indent}${label}: array(${value.length})`);
    if (depth >= 4) return;
    const shown = value.slice(0, 12);
    for (let index = 0; index < shown.length; index++) {
      appendStructure(shown[index], `[${index}]`, depth + 1, lines);
    }
    if (shown.length < value.length) {
      lines.push(
        `${"  ".repeat(depth + 1)}... ${value.length - shown.length} more item(s)`,
      );
    }
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  lines.push(`${indent}${label}: object(${entries.length} keys)`);
  if (depth >= 4) return;
  const shown = entries.slice(0, 20);
  for (const [key, child] of shown) {
    appendStructure(child, key, depth + 1, lines);
  }
  if (shown.length < entries.length) {
    lines.push(
      `${"  ".repeat(depth + 1)}... ${entries.length - shown.length} more key(s)`,
    );
  }
}

function scalarSummary(value: unknown): string {
  if (typeof value === "string") {
    const preview = Array.from(value).slice(0, 80).join("");
    const suffix = preview.length < value.length ? "..." : "";
    return `string(${Buffer.byteLength(value)} bytes) ${JSON.stringify(preview + suffix)}`;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}
