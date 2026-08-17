#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const args = new Set(argv);
const failureProbe = args.has("--failure-probe");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function parseConcurrency() {
  const equalsArg = argv.find((arg) => arg.startsWith("--concurrency="));
  const optionIndex = argv.indexOf("--concurrency");
  const raw =
    equalsArg?.slice("--concurrency=".length) ??
    (optionIndex >= 0 ? argv[optionIndex + 1] : "4");
  const concurrency = Number(raw);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error("[verify] --concurrency must be a positive integer");
    process.exit(2);
  }
  return concurrency;
}

const concurrency = args.has("--sequential") ? 1 : parseConcurrency();

const taskDefinitions = [
  { label: "lint", command: pnpm, args: ["lint"], dependsOn: [] },
  { label: "unit", command: pnpm, args: ["test"], dependsOn: [] },
  { label: "build", command: pnpm, args: ["build"], dependsOn: [] },
  { label: "check", command: pnpm, args: ["check"], dependsOn: ["build"] },
  {
    label: "e2e",
    command: pnpm,
    args: ["test:e2e:run"],
    dependsOn: ["build"],
    env: { E2E_ISOLATED: "1" },
  },
];

const tasks = failureProbe
  ? [
      {
        label: "failure-probe",
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        dependsOn: [],
      },
    ]
  : taskDefinitions;

function formatCommand(task) {
  return [task.command, ...task.args].join(" ");
}

function formatDuration(ms) {
  const seconds = ms / 1000;
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
    : `${seconds.toFixed(1)}s`;
}

function pipeWithPrefix(stream, label, write) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) write(`[${label}] ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) write(`[${label}] ${pending}\n`);
  });
}

function runTask(task) {
  return new Promise((resolve) => {
    const start = performance.now();
    console.log(`[verify] start ${task.label}: ${formatCommand(task)}`);
    const child = spawn(task.command, task.args, {
      cwd: process.cwd(),
      env: { ...process.env, ...task.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    pipeWithPrefix(child.stdout, task.label, (text) =>
      process.stdout.write(text),
    );
    pipeWithPrefix(child.stderr, task.label, (text) =>
      process.stderr.write(text),
    );

    child.on("error", (err) => {
      const durationMs = performance.now() - start;
      console.error(
        `[verify] ${task.label} spawn failed after ${formatDuration(durationMs)}: ${err.message}`,
      );
      resolve({ task, code: 1, durationMs });
    });
    child.on("close", (code, signal) => {
      const durationMs = performance.now() - start;
      const exitCode = code ?? 1;
      const status = signal ? `signal ${signal}` : `exit ${exitCode}`;
      const marker = exitCode === 0 ? "ok" : "failed";
      console.log(
        `[verify] ${marker} ${task.label}: ${status} after ${formatDuration(durationMs)}`,
      );
      resolve({ task, code: exitCode, durationMs });
    });
  });
}

async function runDag(tasksToRun, maxConcurrency) {
  const completed = new Set();
  const scheduled = new Set();
  const running = new Map();
  const failures = [];
  const allResults = [];

  function scheduleReadyTasks() {
    if (failures.length > 0) return;

    const readyTasks = tasksToRun
      .filter(
        (task) =>
          !scheduled.has(task.label) &&
          task.dependsOn.every((dependency) => completed.has(dependency)),
      )
      .slice(0, maxConcurrency - running.size);

    if (readyTasks.length > 1) {
      console.log(
        `[verify] parallel ready: ${readyTasks.map((task) => task.label).join(", ")}`,
      );
    }

    for (const task of readyTasks) {
      scheduled.add(task.label);
      const run = runTask(task).then((result) => {
        running.delete(task.label);
        return result;
      });
      running.set(task.label, run);
    }
  }

  while (allResults.length < tasksToRun.length) {
    scheduleReadyTasks();
    if (running.size === 0) break;

    const result = await Promise.race(running.values());
    allResults.push(result);
    completed.add(result.task.label);
    if (result.code !== 0) failures.push(result);
  }

  const skipped = tasksToRun.filter((task) => !scheduled.has(task.label));
  return { allResults, failures, skipped };
}

const startedAt = performance.now();

console.log(
  `[verify] mode: ${failureProbe ? "failure probe" : `concurrency ${concurrency}`}`,
);

const { allResults, failures, skipped } = await runDag(tasks, concurrency);

const totalMs = performance.now() - startedAt;
console.log("[verify] summary:");
const resultsByLabel = new Map(
  allResults.map((result) => [result.task.label, result]),
);
for (const task of tasks) {
  const result = resultsByLabel.get(task.label);
  if (result) {
    console.log(
      `[verify]   ${result.task.label.padEnd(13)} ${formatDuration(
        result.durationMs,
      ).padStart(8)} exit ${result.code}`,
    );
  } else if (skipped.includes(task)) {
    console.log(`[verify]   ${task.label.padEnd(13)} ${"skipped".padStart(8)}`);
  }
}
console.log(`[verify] total ${formatDuration(totalMs)}`);

if (failures.length > 0) {
  console.error(
    `[verify] failed: ${failures
      .map((result) => `${result.task.label} (exit ${result.code})`)
      .join(", ")}`,
  );
  process.exit(1);
}

if (skipped.length > 0) {
  console.error(
    `[verify] unsatisfied task dependencies: ${skipped.map((task) => task.label).join(", ")}`,
  );
  process.exit(1);
}
