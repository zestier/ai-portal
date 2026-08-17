// Periodic memory-store maintenance: trims the append-only memory_event_log /
// FTS index per conversation (retention) and reclaims freed pages (VACUUM).
//
// Mirrors the idle-reaper pattern in pool.ts: a single unref'd interval pinned
// on a global singleton so Vite HMR / repeated boots don't stack timers.

import { loadConfig } from "../config";
import {
  appGlobalSymbols,
  clearGlobalSingletonValues,
  getGlobalSingletonValue,
  setGlobalSingletonValue,
} from "../global-singleton";
import { log } from "../log";
import { runMemoryRetention, vacuumMemoryDatabase } from "../db/repos/memory";
import { checkpointWal } from "../db/index";

const TIMER_KEYS = appGlobalSymbols("memory.maintenance");

function getTimer(): NodeJS.Timeout | null {
  return getGlobalSingletonValue<NodeJS.Timeout>(TIMER_KEYS);
}
function setTimer(t: NodeJS.Timeout | null) {
  setGlobalSingletonValue(TIMER_KEYS, t);
}

// Run one maintenance pass: retention sweep, then vacuum only when something was
// actually trimmed (VACUUM rewrites the whole file, so skip it on no-op passes).
export function runMemoryMaintenance(): {
  conversations: number;
  trimmed: number;
} {
  const cfg = loadConfig();
  const maxEvents = cfg.MEMORY_LOG_RETENTION_MAX_EVENTS;
  if (maxEvents <= 0) return { conversations: 0, trimmed: 0 };
  const result = runMemoryRetention({ maxEvents });
  if (result.trimmed > 0) {
    log.info("memory.maintenance.retention", result);
    try {
      vacuumMemoryDatabase();
      log.info("memory.maintenance.vacuum", {});
    } catch (err) {
      log.warn("memory.maintenance.vacuum_failed", { err: String(err) });
    }
  }
  // Backstop the wal_autocheckpoint pragma: fold the WAL back into the main DB
  // every pass so a quiet-but-bursty workload can't leave a large WAL sitting
  // around indefinitely. PASSIVE never blocks concurrent connections.
  try {
    checkpointWal();
  } catch (err) {
    log.warn("memory.maintenance.checkpoint_failed", { err: String(err) });
  }
  return result;
}

export function startMemoryMaintenance() {
  if (getTimer()) return;
  const cfg = loadConfig();
  if (cfg.MEMORY_LOG_RETENTION_MAX_EVENTS <= 0) return;
  const intervalMs = cfg.MEMORY_MAINTENANCE_INTERVAL_MIN * 60_000;
  const timer = setInterval(() => {
    try {
      runMemoryMaintenance();
    } catch (err) {
      log.warn("memory.maintenance.failed", { err: String(err) });
    }
  }, intervalMs);
  timer.unref?.();
  setTimer(timer);
}

export function stopMemoryMaintenance() {
  const timer = getTimer();
  if (timer) {
    clearInterval(timer);
    clearGlobalSingletonValues(TIMER_KEYS);
  }
}
