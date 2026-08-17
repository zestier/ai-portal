// Append-only security audit trail.
//
// Distinct from the general structured logger (`log`): audit records are the
// post-incident forensic record of *who did what, from where, and whether it
// succeeded* for security-relevant actions — login, logout, redeploy triggers,
// and working-directory overrides. They are emitted through a *separable sink*
// so an operator can route them to their own destination (a file, syslog, a
// SIEM shipper) without entangling them with ordinary application logging.
//
// The default sink forwards each record to the structured logger under an
// `audit.<event_type>` message, so audit events are greppable out of the box
// (`msg` starts with `audit.`) yet can be peeled off into a dedicated sink by
// calling `setAuditSink`.

import { log } from "./log";

export type AuditOutcome = "success" | "failure" | "denied";

/**
 * The canonical forensic record. Field names are intentionally snake_case and
 * stable — this is a record format meant to be parsed by external tooling, not
 * a free-form log line.
 */
export interface AuditRecord {
  ts: string;
  event_type: string;
  actor_login: string | null;
  actor_ip: string | null;
  resource: string | null;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

export type AuditSink = (record: AuditRecord) => void;

const defaultSink: AuditSink = (record) => {
  log.info(`audit.${record.event_type}`, { ...record });
};

let sink: AuditSink = defaultSink;

/**
 * Swap the audit sink (e.g. to a file/syslog shipper). Passing `null` restores
 * the default structured-logger sink. Exposed for operators and tests.
 */
export function setAuditSink(next: AuditSink | null): void {
  sink = next ?? defaultSink;
}

export interface AuditInput {
  event_type: string;
  actor_login?: string | null;
  actor_ip?: string | null;
  resource?: string | null;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

/**
 * Record a single audit event. Never throws: a failing sink must not take down
 * the request it is auditing, so sink errors are downgraded to a warn line.
 */
export function audit(input: AuditInput): void {
  const record: AuditRecord = {
    ts: new Date().toISOString(),
    event_type: input.event_type,
    actor_login: input.actor_login ?? null,
    actor_ip: input.actor_ip ?? null,
    resource: input.resource ?? null,
    outcome: input.outcome,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  try {
    sink(record);
  } catch (e) {
    log.warn("audit.sink_error", {
      event_type: record.event_type,
      err: String(e),
    });
  }
}
