#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function outputPath(argv) {
  const index = argv.indexOf("--output");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("usage: pnpm release:pack -- --output <tarball.tgz>");
  }
  return resolve(argv[index + 1]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    ...options,
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

async function waitFor(url, child, logs) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `packaged server exited with code ${child.exitCode}\n${logs()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}\n${logs()}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => {
    child.once("exit", resolveExit);
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

const destination = outputPath(process.argv.slice(2));
const scratch = mkdtempSync(join(tmpdir(), "zap-release-pack-"));
const packDir = join(scratch, "pack");
const consumerDir = join(scratch, "consumer");
const dataDir = join(scratch, "data");
let child;

try {
  mkdirSync(packDir);
  mkdirSync(consumerDir);
  mkdirSync(dataDir);

  run(pnpm, ["run", "build"]);
  const packed = JSON.parse(
    run(npm, ["pack", "--json", "--pack-destination", packDir], {
      capture: true,
    }),
  );
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename) {
    throw new Error("npm pack returned an unexpected result");
  }

  const stagedTarball = join(packDir, packed[0].filename);
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) rmSync(destination);
  renameSync(stagedTarball, destination);

  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ private: true }, null, 2),
  );
  run(npm, ["install", "--omit=dev", "--no-audit", "--no-fund", destination], {
    cwd: consumerDir,
  });

  const packageRoot = join(consumerDir, "node_modules", "zap");
  const entrypoint = join(packageRoot, "build");
  const migrations = join(packageRoot, "src/lib/server/db/migrations");
  if (!existsSync(entrypoint) || !existsSync(migrations)) {
    throw new Error("tarball is missing the runtime build or DB migrations");
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  child = spawn(process.execPath, [entrypoint], {
    cwd: consumerDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      PROJECT_ROOT: consumerDir,
      I_KNOW_THIS_IS_LOCAL: "1",
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      PI_STUB: "1",
      LOG_LEVEL: "warn",
      ORIGIN: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-16_000);
  });
  child.stderr.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-16_000);
  });

  await waitFor(`${baseUrl}/api/health/liveness`, child, () => output);
  await waitFor(`${baseUrl}/api/health`, child, () => output);
  console.log(`[release:pack] verified ${destination}`);
} finally {
  if (child) await stop(child);
  rmSync(scratch, { recursive: true, force: true });
}
