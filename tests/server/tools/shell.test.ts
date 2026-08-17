import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildShellTools } from "../../../src/lib/server/tools/shell";
import { deriveToolResultViews } from "../../../src/lib/server/tools/types";

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(join(tmpdir(), "portal-shell-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("bash", () => {
  it("does not expose portal configuration to commands", async () => {
    await withWorkspace(async (workspace) => {
      process.env.DATA_DIR = "/live/portal/data";
      process.env.DB_MIGRATIONS_DIR = "/live/portal/migrations";
      process.env.SESSION_SECRET = "portal-session-secret-that-must-not-leak";
      const result = await buildShellTools(workspace)[0].handler({
        command:
          'printf "%s|%s|%s" "${DATA_DIR-unset}" "${DB_MIGRATIONS_DIR-unset}" "${SESSION_SECRET-unset}"',
      });
      expect(result).toMatchObject({
        ok: true,
        result: { stdout: "unset|unset|unset" },
      });
    });
  });

  it("runs Bash in the workspace and returns structured output with SDK field names", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: 'printf "hello"',
        timeout: 5_000,
      });
      expect(result).toMatchObject({
        ok: true,
        result: {
          stdout: "hello",
          stderr: "",
          exitCode: 0,
          interrupted: false,
          timedOutAfterMs: undefined,
          truncated: false,
        },
      });
      expect(result).not.toMatchObject({
        ok: true,
        result: { timedOut: true, aborted: true },
      });
    });
  });

  it("accepts SDK BashInput fields (description, run_in_background:false, dangerouslyDisableSandbox:false)", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: 'printf "ok"',
        description: "Print ok",
        run_in_background: false,
        dangerouslyDisableSandbox: false,
      });
      expect(result).toMatchObject({
        ok: true,
        result: { exitCode: 0, stdout: "ok" },
      });
    });
  });

  it("rejects run_in_background with a clear error", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: "true",
        run_in_background: true,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("run_in_background") },
      });
    });
  });

  it("denies dangerouslyDisableSandbox", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: "true",
        dangerouslyDisableSandbox: true,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("dangerouslyDisableSandbox"),
        },
      });
    });
  });

  it("rejects a cwd that escapes the workspace", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: "pwd",
        cwd: "..",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "invalid_cwd" },
      });
    });
  });

  it("renders a non-zero exit as an error result with the exit-code text", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: "exit 3",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { message: "Exit code 3" },
      });
    });
  });

  it("spills oversized output to .zap/scratch/tool_results instead of killing the process", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: "seq 1 100000",
        maxOutputBytes: 1_024,
      });
      expect(result).toMatchObject({
        ok: true,
        result: { truncated: true },
      });
      if (!result.ok) throw new Error(result.error.message);
      const payload = result.result as {
        stdout: string;
        persistedOutputPath?: string;
        persistedOutputSize?: number;
      };
      expect(Buffer.byteLength(payload.stdout)).toBeLessThanOrEqual(1_024);
      expect(payload.persistedOutputPath).toBeTruthy();
      expect(payload.persistedOutputSize).toBeGreaterThan(1_024);
      // The spill file holds the FULL output (seq 1 100000 ≈ 575KB), not
      // just the overflow past the in-context cap.
      const full = await readFile(payload.persistedOutputPath!, "utf8");
      expect(full.startsWith("1\n2\n3\n")).toBe(true);
      expect(full.trimEnd().endsWith("100000")).toBe(true);
      expect(Buffer.byteLength(full)).toBeGreaterThan(100_000);
    });
  });

  it("uses a conservative default in-context cap", async () => {
    await withWorkspace(async (workspace) => {
      const result = await buildShellTools(workspace)[0].handler({
        command: 'printf "x%.0s" {1..40000}',
      });
      expect(result).toMatchObject({ ok: true, result: { truncated: true } });
      if (result.ok) {
        const payload = result.result as { stdout: string };
        expect(Buffer.byteLength(payload.stdout)).toBeLessThanOrEqual(
          32 * 1024,
        );
      }
    });
  });

  it("rejects a caller-selected output cap above the server limit", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        buildShellTools(workspace)[0].handler({
          command: "true",
          maxOutputBytes: 1_000_000,
        }),
      ).rejects.toThrow();
    });
  });

  it("terminates a command when the turn is aborted and marks it interrupted", async () => {
    await withWorkspace(async (workspace) => {
      const controller = new AbortController();
      const promise = buildShellTools(workspace)[0].handler(
        { command: "sleep 10", timeout: 120_000 },
        {
          partial: () => {},
          progress: () => {},
          signal: controller.signal,
        },
      );
      controller.abort();
      const result = await promise;
      expect(result).toMatchObject({ ok: true, result: { interrupted: true } });
      if (result.ok) {
        // Our own SIGTERM is not a genuine exit — the rendered text says
        // "Interrupted", not a misleading 128+signal "Exit code 143".
        const modelText = deriveToolResultViews(result).modelText;
        expect(modelText).toContain("Interrupted");
        expect(modelText).not.toContain("Exit code");
      }
    });
  });
});
