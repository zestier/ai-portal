// Tiny structured logger. Outputs JSON lines to stdout.

import { loadConfig } from "./config";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Keys whose values are authoritative and must never be shadowed by caller fields.
// A caller field that collides (e.g. a GitHub login stored under `msg`) is
// prefixed with `_` so the original value is preserved in the log record rather
// than silently dropped. If a caller also supplies the prefixed name (e.g. both
// `msg` and `_msg`), the prefixed reserved value wins — an accepted edge case.
const RESERVED_LOG_KEYS = new Set(["ts", "level", "msg"]);

function currentLevel(): Level {
  try {
    return loadConfig().LOG_LEVEL;
  } catch {
    return "info";
  }
}

function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[RESERVED_LOG_KEYS.has(k) ? `_${k}` : k] = v;
  }
  return out;
}

/** @internal Exposed for unit tests only. */
export { safeFields as _safeFieldsForTest };

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const line = {
    ...(fields ? safeFields(fields) : {}),
    ts: new Date().toISOString(),
    level,
    msg,
  };
  const out =
    level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
