// Background maintenance for workspace leases: idle reaping plus one-shot
// startup reconciliation.
//
// Leases outlive individual turns, so nothing in the request path would ever
// clean them up. Without this, every orchestrator run would leak checkouts
// until the disk filled. Dirty leases are deliberately exempt from reaping —
// uncommitted work is unrecoverable, so it is surfaced rather than collected.

import {
  appGlobalSymbols,
  clearGlobalSingletonValues,
  getGlobalSingletonValue,
  setGlobalSingletonValue,
} from "../global-singleton";
import { reapIdleLeases, reconcileLeases } from "../leases";
import { log } from "../log";

const LEASE_MAINTENANCE_KEYS = appGlobalSymbols("leases.maintenance");

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Reconcile persisted leases against the filesystem, then sweep idle ones on a
 * one-minute cadence (matching the session pool reaper).
 */
export function startLeaseMaintenance(): void {
  if (getGlobalSingletonValue<NodeJS.Timeout>(LEASE_MAINTENANCE_KEYS)) return;

  // Crash recovery: drop rows whose checkout no longer resolves. Fire and
  // forget so a slow git call never blocks boot.
  void reconcileLeases().catch((err) => {
    log.warn("lease.reconcile_failed", { err: String(err) });
  });

  const timer = setInterval(() => {
    void reapIdleLeases().catch((err) => {
      log.warn("lease.reap_sweep_failed", { err: String(err) });
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  setGlobalSingletonValue(LEASE_MAINTENANCE_KEYS, timer);
}

/** Stop the sweep (shutdown / test cleanup). */
export function stopLeaseMaintenance(): void {
  const timer = getGlobalSingletonValue<NodeJS.Timeout>(LEASE_MAINTENANCE_KEYS);
  if (timer) {
    clearInterval(timer);
    clearGlobalSingletonValues(LEASE_MAINTENANCE_KEYS);
  }
}
