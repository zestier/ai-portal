import {
  newAsyncContext,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";
import { createHash } from "node:crypto";
import type {
  PortalTool,
  ToolPermissionRequest,
  ToolResult,
} from "$lib/server/tools/types";
import { normalizeProgramToolArgs, suggestionsFor } from "./contracts";

const MAX_OPERATIONS_BY_CATEGORY = {
  mutation: 500,
  command: 20,
} as const;
const MAX_CAPABILITY_RESULT_BYTES = 64 * 1024;
const MAX_PROGRAM_RESULT_BYTES = 5 * 1024 * 1024;
const MAX_RUNTIME_MS = 120_000;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_STACK_BYTES = 512 * 1024;

function normalizeProgramErrorLocation(error: unknown): void {
  if (!(error instanceof Error)) return;
  const located = error as Error & {
    fileName?: string;
    lineNumber?: number;
  };
  if (
    located.fileName === "program.js" &&
    typeof located.lineNumber === "number"
  ) {
    located.lineNumber = Math.max(1, located.lineNumber - 1);
  }
  if (located.stack) {
    located.stack = located.stack.replace(
      /^(\s+at (?:(?:.* \()?program\.js:))(\d+)(:\d+\)?\s*)$/gm,
      (_match, prefix: string, line: string, suffix: string) =>
        `${prefix}${Math.max(1, Number(line) - 1)}${suffix}`,
    );
  }
}

export interface ProgramRunOptions {
  source: string;
  capabilities: ReadonlyMap<string, PortalTool>;
  facadeCapabilities?: ReadonlyMap<string, PortalTool>;
  state?: { get(id: string): unknown | undefined };
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

type OperationCategory = keyof typeof MAX_OPERATIONS_BY_CATEGORY;

export async function runProgram(
  opts: ProgramRunOptions,
): Promise<ProgramRunResult> {
  // Asyncify lets guest code call async host capabilities synchronously. Each
  // program needs its own WASM module because one module may only suspend for
  // one host operation at a time.
  const vm = await newAsyncContext();
  const runtime = vm.runtime;
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const deadline = Date.now() + MAX_RUNTIME_MS;
  const deadlineInterrupt = shouldInterruptAfterDeadline(deadline);
  runtime.setInterruptHandler(
    (activeRuntime) => opts.signal.aborted || deadlineInterrupt(activeRuntime),
  );
  const startedAt = Date.now();
  const calls: ProgramRunResult["trace"]["calls"] = [];
  let operations = 0;
  const categoryOperations: Record<OperationCategory, number> = {
    mutation: 0,
    command: 0,
  };

  function installBridge(
    bridgeName: string,
    allowed: ReadonlyMap<string, PortalTool>,
  ): void {
    const callHandle = vm.newAsyncifiedFunction(
      bridgeName,
      async (nameHandle, argsHandle) => {
        const name = vm.getString(nameHandle);
        const args = argsHandle ? vm.dump(argsHandle) : {};
        const value = await execute(name, args, allowed);
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) > MAX_CAPABILITY_RESULT_BYTES) {
          throw new Error(
            `Capability ${name} returned more than 64 KiB. Narrow or batch the call.`,
          );
        }
        return vm.newString(encoded);
      },
    );
    vm.setProp(vm.global, bridgeName, callHandle);
    callHandle.dispose();
  }

  installBridge("__callCapability", opts.capabilities);
  installBridge("__callFacadeCapability", opts.facadeCapabilities ?? new Map());
  const fetchStateHandle = vm.newAsyncifiedFunction(
    "__ptc_fetch_state",
    async (idHandle) => {
      const id = vm.getString(idHandle);
      const value = opts.state?.get(id);
      if (value === undefined) {
        throw new Error(`Unknown checkpoint: ${id}`);
      }
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new Error(`Checkpoint ${id} is not JSON-compatible.`);
      }
      if (Buffer.byteLength(encoded) > MAX_PROGRAM_RESULT_BYTES) {
        throw new Error(`Checkpoint ${id} exceeds the 5 MiB state limit.`);
      }
      return vm.newString(encoded);
    },
  );
  vm.setProp(vm.global, "__ptc_fetch_state", fetchStateHandle);
  fetchStateHandle.dispose();

  const setup = `(() => {
    {
    function unwrapCall(call, name, args) {
      const result = JSON.parse(call(name, args));
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }
    function deepFreeze(value) {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
      }
      return value;
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
    const fsMethods = {
      readFile(path, encoding) {
        const normalizedEncoding = typeof encoding === "string"
          ? encoding
          : encoding?.encoding;
        if (normalizedEncoding !== "utf8" && normalizedEncoding !== "utf-8") {
          throw new Error('fs.readFile supports only "utf8" and "utf-8".');
        }
        const result = unwrapCall(__callFacadeCapability, "read", {
          file_path: path,
          mode: "content"
        });
        if (result?.type !== "text") {
          throw new Error("fs.readFile supports only text files.");
        }
        return result.file.content;
      },
      writeFile(path, data, options) {
        const encoding = typeof options === "string"
          ? options
          : options?.encoding ?? "utf8";
        if (encoding !== "utf8" && encoding !== "utf-8") {
          throw new Error('fs.writeFile supports only "utf8" and "utf-8".');
        }
        if (typeof data !== "string") {
          throw new Error("fs.writeFile supports only string data.");
        }
        unwrapCall(__callFacadeCapability, "write", { file_path: path, content: data });
      },
      readdir(path, options) {
        if (options?.withFileTypes === true) {
          throw new Error("fs.readdir does not yet support withFileTypes: true.");
        }
        return unwrapCall(__callFacadeCapability, "__ptc_fs_readdir", { path });
      },
      stat(path) {
        const value = unwrapCall(__callFacadeCapability, "__ptc_fs_stat", { path });
        return Object.freeze({
          size: value.size,
          mtimeMs: value.mtimeMs,
          isFile: () => value.file,
          isDirectory: () => value.directory,
          isSymbolicLink: () => value.symbolicLink
        });
      },
      mkdir(path) {
        unwrapCall(__callFacadeCapability, "create_directory", { path });
      },
      rename(oldPath, newPath) {
        unwrapCall(__callFacadeCapability, "move", {
          source: oldPath,
          destination: newPath,
          overwrite: true
        });
      }
    };
    const fsApi = Object.freeze({
      ...fsMethods,
      readFileSync: fsMethods.readFile,
      writeFileSync: fsMethods.writeFile,
      readdirSync: fsMethods.readdir,
      statSync: fsMethods.stat,
      mkdirSync: fsMethods.mkdir,
      renameSync: fsMethods.rename
    });
    function runCommand(executableOrArgv, argsOrOptions = [], maybeOptions = {}) {
        const argvForm = Array.isArray(executableOrArgv);
        const executable = argvForm ? executableOrArgv[0] : executableOrArgv;
        const secondIsArgs = Array.isArray(argsOrOptions);
        const args = argvForm
          ? executableOrArgv.slice(1)
          : secondIsArgs
            ? argsOrOptions
            : [];
        const options = argvForm
          ? argsOrOptions ?? {}
          : secondIsArgs
            ? maybeOptions
            : argsOrOptions ?? {};
        if (typeof executable !== "string" || executable.length === 0) {
          throw new Error("command.run requires an executable string or a non-empty argv array.");
        }
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
          throw new Error("command.run args must be an array of strings.");
        }
        if (options === null || typeof options !== "object" || Array.isArray(options)) {
          throw new Error("command.run options must be an object.");
        }
        return unwrapCall(__callFacadeCapability, "__ptc_command_run", {
          ...(!argvForm && !secondIsArgs
            ? { command: executable }
            : { executable, args }),
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        });
    }
    Object.defineProperty(runCommand, "run", { value: runCommand });
    const commandApi = Object.freeze(runCommand);
    const toolsApi = new Proxy(Object.create(null), {
      get(_target, name) {
        if (typeof name !== "string" || name === "then") return undefined;
        return (args = {}) => unwrapCall(__callCapability, name, args);
      }
    });
    const stateCache = new Map();
    function getState(resultId) {
      if (typeof resultId !== "string" || resultId.length === 0) {
        throw new TypeError("getState requires a non-empty result id string.");
      }
      if (!stateCache.has(resultId)) {
        stateCache.set(
          resultId,
          deepFreeze(JSON.parse(__ptc_fetch_state(resultId)))
        );
      }
      return stateCache.get(resultId);
    }
    const unavailableModule = (name) => {
      throw new Error(
        "Module loading is unavailable. Use the predeclared fs, path, command, tools, and getState globals. Requested: " + String(name)
      );
    };
    const unavailableConsole = () => {
      throw new Error(
        "Console output is unavailable. Return the value directly; do not JSON.stringify it."
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
      getState: { value: getState, writable: false, configurable: false },
      require: { value: unavailableModule, writable: false, configurable: false },
      console: { value: consoleApi, writable: false, configurable: false }
    });
    }
  })()`;

  try {
    const setupEvaluation = await vm.evalCodeAsync(setup, "sandbox.js");
    vm.unwrapResult(setupEvaluation).dispose();

    const shiftedSource = `\n${opts.source}`;
    const compiled = await vm.evalCodeAsync(shiftedSource, "program.js", {
      compileOnly: true,
    });
    const scriptCompatible = "value" in compiled;
    if ("value" in compiled) compiled.value.dispose();
    else compiled.error.dispose();

    const executable = scriptCompatible
      ? shiftedSource
      : `(() => {${shiftedSource}\n})()`;
    const evaluation = await vm.evalCodeAsync(executable, "program.js");
    let valueHandle;
    try {
      valueHandle = vm.unwrapResult(evaluation);
    } catch (error) {
      normalizeProgramErrorLocation(error);
      throw error;
    }
    try {
      const value = vm.dump(valueHandle);
      if (value === undefined) {
        throw new Error(
          "Execution returned undefined. Return a JSON-compatible value, for example return { results }.",
        );
      }
      const encoded = JSON.stringify(value ?? null);
      if (Buffer.byteLength(encoded) > MAX_PROGRAM_RESULT_BYTES) {
        throw new Error("Execution result exceeds the 5 MiB limit.");
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
    vm.dispose();
  }

  async function execute(
    name: string,
    args: unknown,
    allowed: ReadonlyMap<string, PortalTool>,
  ): Promise<unknown> {
    operations++;
    if (opts.signal.aborted) throw new Error("Execution aborted.");
    if (Date.now() > deadline) {
      throw new Error("Execution exceeded the 120 second limit.");
    }
    const tool = allowed.get(name);
    if (!tool) {
      const suggestions = suggestionsFor(name, [...allowed.keys()]);
      const related = suggestions.length
        ? ` Available related tools: ${suggestions.join(", ")}.`
        : "";
      const failure = {
        ok: false,
        error: {
          message: `Unknown program tool "${name}".${related} Use a contract from environment.tools.`,
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
    // Normalize compatibility forms once, before the operation category and
    // dispatch, so every downstream step (which parses the canonical form
    // with Zod) sees canonical args. Previously the category ran on the raw
    // guest args: a program tool whose `derivePermissionRequest` parses them
    // threw on an unnormalized alias and failed the call before any tool.call
    // was emitted (opts.execute normalized too late).
    const effective = normalizeProgramToolArgs(tool, args);
    const category = operationCategory(name, effective, allowed);
    if (category !== null) {
      categoryOperations[category]++;
      const categoryLimit = MAX_OPERATIONS_BY_CATEGORY[category];
      if (categoryOperations[category] > categoryLimit) {
        throw new Error(
          `Execution exceeded the ${category} operation limit (${categoryLimit}).`,
        );
      }
    }
    const result = await opts.execute(name, effective, opts.signal);
    calls.push({
      name,
      kind: allowed === opts.capabilities ? "tool" : "facade",
      argsHash: hash(effective),
      ok: result.ok,
    });
    return result.ok
      ? { ok: true, value: result.result }
      : { ok: false, error: result.error };
  }
}

function operationCategory(
  name: string,
  args: unknown,
  allowed: ReadonlyMap<string, PortalTool>,
): OperationCategory | null {
  if (name === "__ptc_command_run") return "command";
  const tool = allowed.get(name);
  // Classification must never crash the program: a guessed arg form that a
  // tool's `derivePermissionRequest` can't parse should fall through to the
  // static program category (a failed argument guess is dispatched and fails
  // validation normally — see executeDelegatedTool), not abort the run.
  let permission: ToolPermissionRequest | null | undefined;
  try {
    permission = tool?.derivePermissionRequest?.(args);
  } catch {
    permission = null;
  }
  if (permission?.permissionKind === "read") return null;
  if (tool?.program?.operationCategory === "read") return null;
  return "mutation";
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
}
