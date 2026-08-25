import {
  newAsyncContext,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten";
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
        if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) {
          throw new Error(
            `Capability ${name} result exceeded the size budget.`,
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

  const wrapped = `(() => {
    {
    function unwrapCall(call, name, args) {
      const result = JSON.parse(call(name, args));
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
    const commandApi = Object.freeze({
      run(executableOrArgv, argsOrOptions = [], maybeOptions = {}) {
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
    });
    const toolsApi = new Proxy(Object.create(null), {
      get(_target, name) {
        if (typeof name !== "string" || name === "then") return undefined;
        return (args = {}) => unwrapCall(__callCapability, name, args);
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
    const evaluation = await vm.evalCodeAsync(wrapped, "program.js");
    const valueHandle = vm.unwrapResult(evaluation);
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
    vm.dispose();
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
