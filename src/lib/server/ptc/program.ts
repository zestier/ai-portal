import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSDeferredPromise } from "quickjs-emscripten";
import { createHash } from "node:crypto";
import type { PortalTool, ToolResult } from "$lib/server/tools/types";
import { suggestionsFor } from "./contracts";

const MAX_OPERATIONS = 50;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RUNTIME_MS = 120_000;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_STACK_BYTES = 512 * 1024;

export interface ProgramRunOptions {
  source: string;
  capabilities: ReadonlyMap<string, PortalTool>;
  facadeCapabilities?: ReadonlyMap<string, PortalTool>;
  execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  signal: AbortSignal;
}

export interface ProgramRunResult {
  value: unknown;
  operations: number;
  trace: {
    sourceHash: string;
    calls: Array<{
      name: string;
      kind: "tool" | "facade";
      argsHash: string;
      ok: boolean;
    }>;
    durationMs: number;
  };
}

export async function runProgram(
  opts: ProgramRunOptions,
): Promise<ProgramRunResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const deadline = Date.now() + MAX_RUNTIME_MS;
  const deadlineInterrupt = shouldInterruptAfterDeadline(deadline);
  runtime.setInterruptHandler(
    (activeRuntime) => opts.signal.aborted || deadlineInterrupt(activeRuntime),
  );
  const vm = runtime.newContext();
  const pending = new Set<Promise<unknown>>();
  const deferreds = new Set<QuickJSDeferredPromise>();
  const startedAt = Date.now();
  const calls: ProgramRunResult["trace"]["calls"] = [];
  let operations = 0;

  function installBridge(
    bridgeName: string,
    allowed: ReadonlyMap<string, PortalTool>,
  ): void {
    const callHandle = vm.newFunction(bridgeName, (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      const args = argsHandle ? vm.dump(argsHandle) : {};
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      const operation = execute(name, args, allowed)
        .then((value) => {
          const encoded = JSON.stringify(value);
          if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) {
            throw new Error(
              `Capability ${name} result exceeded the size budget.`,
            );
          }
          const handle = vm.newString(encoded);
          deferred.resolve(handle);
          handle.dispose();
        })
        .catch((error) => {
          const handle = vm.newError(
            error instanceof Error ? error.message : String(error),
          );
          deferred.reject(handle);
          handle.dispose();
        })
        .finally(() => {
          pending.delete(operation);
          void runtime.executePendingJobs();
        });
      pending.add(operation);
      return deferred.handle;
    });
    vm.setProp(vm.global, bridgeName, callHandle);
    callHandle.dispose();
  }

  installBridge("__callCapability", opts.capabilities);
  installBridge("__callFacadeCapability", opts.facadeCapabilities ?? new Map());

  const wrapped = `(async () => {
    {
    async function unwrapCall(call, name, args) {
      const result = JSON.parse(await call(name, args));
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    function normalizePath(value) {
      if (typeof value !== "string") throw new TypeError("Path must be a string.");
      const absolute = value.startsWith("/");
      const parts = [];
      for (const part of value.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
          if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
          else if (!absolute) parts.push("..");
        } else {
          parts.push(part);
        }
      }
      const joined = parts.join("/");
      return absolute ? "/" + joined : joined || ".";
    }
    function basenamePath(value, suffix) {
      const normalized = normalizePath(value);
      let base = normalized === "/" ? "" : normalized.slice(normalized.lastIndexOf("/") + 1);
      if (typeof suffix === "string" && suffix && base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length);
      }
      return base;
    }
    const pathApi = Object.freeze({
      join(...parts) {
        if (parts.some((part) => typeof part !== "string")) {
          throw new TypeError("Path must be a string.");
        }
        return normalizePath(parts.filter(Boolean).join("/"));
      },
      dirname(value) {
        const normalized = normalizePath(value);
        if (normalized === "/" || normalized === ".") return normalized;
        const index = normalized.lastIndexOf("/");
        return index < 0 ? "." : index === 0 ? "/" : normalized.slice(0, index);
      },
      basename: basenamePath,
      extname(value) {
        const base = basenamePath(value);
        const index = base.lastIndexOf(".");
        return index <= 0 ? "" : base.slice(index);
      },
      normalize: normalizePath,
      relative(from, to) {
        const fromParts = normalizePath(from).split("/").filter((part) => part && part !== ".");
        const toParts = normalizePath(to).split("/").filter((part) => part && part !== ".");
        let shared = 0;
        while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared++;
        return [...fromParts.slice(shared).map(() => ".."), ...toParts.slice(shared)].join("/") || "";
      },
      isAbsolute(value) {
        if (typeof value !== "string") throw new TypeError("Path must be a string.");
        return value.startsWith("/");
      }
    });
    const fsApi = Object.freeze({
      async readFile(path, encoding) {
        const normalizedEncoding = typeof encoding === "string"
          ? encoding
          : encoding?.encoding;
        if (normalizedEncoding !== "utf8" && normalizedEncoding !== "utf-8") {
          throw new Error('fs.readFile supports only "utf8" and "utf-8".');
        }
        const result = await unwrapCall(__callFacadeCapability, "read", {
          file_path: path,
          mode: "content"
        });
        if (result?.type !== "text") {
          throw new Error("fs.readFile supports only text files.");
        }
        return result.file.content;
      },
      async writeFile(path, data, options) {
        const encoding = typeof options === "string"
          ? options
          : options?.encoding ?? "utf8";
        if (encoding !== "utf8" && encoding !== "utf-8") {
          throw new Error('fs.writeFile supports only "utf8" and "utf-8".');
        }
        if (typeof data !== "string") {
          throw new Error("fs.writeFile supports only string data.");
        }
        await unwrapCall(__callFacadeCapability, "write", { file_path: path, content: data });
      },
      async readdir(path, options) {
        if (options?.withFileTypes === true) {
          throw new Error("fs.readdir does not yet support withFileTypes: true.");
        }
        return await unwrapCall(__callFacadeCapability, "__ptc_fs_readdir", { path });
      },
      async stat(path) {
        const value = await unwrapCall(__callFacadeCapability, "__ptc_fs_stat", { path });
        return Object.freeze({
          size: value.size,
          mtimeMs: value.mtimeMs,
          isFile: () => value.file,
          isDirectory: () => value.directory,
          isSymbolicLink: () => value.symbolicLink
        });
      },
      async mkdir(path) {
        await unwrapCall(__callFacadeCapability, "create_directory", { path });
      },
      async rename(oldPath, newPath) {
        await unwrapCall(__callFacadeCapability, "move", {
          source: oldPath,
          destination: newPath,
          overwrite: true
        });
      }
    });
    const commandApi = Object.freeze({
      async run(executable, args = [], options = {}) {
        if (typeof executable !== "string" || executable.length === 0) {
          throw new Error("command.run requires an executable string.");
        }
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
          throw new Error("command.run args must be an array of strings.");
        }
        return await unwrapCall(__callFacadeCapability, "__ptc_command_run", {
          executable,
          args,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        });
      }
    });
    const toolsApi = new Proxy(Object.create(null), {
      get(_target, name) {
        if (typeof name !== "string" || name === "then") return undefined;
        return async (args = {}) => unwrapCall(__callCapability, name, args);
      }
    });
    const unavailableModule = (name) => {
      throw new Error(
        "Module loading is unavailable in program. fs, path, command, and tools are predeclared globals; use them directly instead of require or import. Requested: " + String(name)
      );
    };
    const unavailableConsole = () => {
      throw new Error(
        "Console output is unavailable in program. Return the final value directly instead; do not JSON.stringify it."
      );
    };
    const consoleApi = Object.freeze({
      log: unavailableConsole,
      info: unavailableConsole,
      warn: unavailableConsole,
      error: unavailableConsole,
      debug: unavailableConsole
    });
    Object.defineProperties(globalThis, {
      fs: { value: fsApi, writable: false, configurable: false },
      path: { value: pathApi, writable: false, configurable: false },
      command: { value: commandApi, writable: false, configurable: false },
      tools: { value: toolsApi, writable: false, configurable: false },
      require: { value: unavailableModule, writable: false, configurable: false },
      console: { value: consoleApi, writable: false, configurable: false }
    });
    }
    ${opts.source}
  })()`;

  try {
    const evaluation = vm.evalCode(wrapped, "program.js");
    const promiseHandle = vm.unwrapResult(evaluation);
    try {
      runtime.executePendingJobs();
      const state = vm.getPromiseState(promiseHandle);
      const valueHandle =
        state.type === "fulfilled"
          ? state.value
          : state.type === "rejected"
            ? (() => {
                const message = dumpedErrorMessage(vm.dump(state.error));
                state.error.dispose();
                throw new Error(message);
              })()
            : vm.unwrapResult(await vm.resolvePromise(promiseHandle));
      try {
        const value = vm.dump(valueHandle);
        if (value === undefined) {
          throw new Error(
            "Program returned undefined. Return the final value directly, for example return { results }.",
          );
        }
        const encoded = JSON.stringify(value ?? null);
        if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) {
          throw new Error("Program result exceeded its size budget.");
        }
        return {
          value,
          operations,
          trace: {
            sourceHash: hash(opts.source),
            calls,
            durationMs: Date.now() - startedAt,
          },
        };
      } finally {
        valueHandle.dispose();
      }
    } finally {
      promiseHandle.dispose();
    }
  } finally {
    await Promise.allSettled(pending);
    for (const deferred of deferreds) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }

  async function execute(
    name: string,
    args: unknown,
    allowed: ReadonlyMap<string, PortalTool>,
  ): Promise<unknown> {
    operations++;
    if (operations > MAX_OPERATIONS) {
      throw new Error("Program exceeded its operation budget.");
    }
    if (opts.signal.aborted) throw new Error("Program aborted.");
    if (Date.now() > deadline) {
      throw new Error("Program exceeded its runtime budget.");
    }
    if (!allowed.has(name)) {
      const suggestions = suggestionsFor(name, [...allowed.keys()]);
      const related = suggestions.length
        ? ` Available related tools: ${suggestions.join(", ")}.`
        : "";
      const failure = {
        ok: false,
        error: {
          message: `Unknown program tool "${name}".${related} Call get_program_tool_schemas for exact contracts.`,
          details: { validTools: [...allowed.keys()].sort() },
        },
      };
      calls.push({
        name,
        kind: allowed === opts.capabilities ? "tool" : "facade",
        argsHash: hash(args),
        ok: false,
      });
      return failure;
    }
    const result = await opts.execute(name, args, opts.signal);
    calls.push({
      name,
      kind: allowed === opts.capabilities ? "tool" : "facade",
      argsHash: hash(args),
      ok: result.ok,
    });
    return result.ok
      ? { ok: true, value: result.result }
      : { ok: false, error: result.error };
  }
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}

function dumpedErrorMessage(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return String(value);
}
