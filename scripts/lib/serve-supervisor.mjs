// Pure decision helpers for the redeploy supervisor (scripts/serve.mjs), split
// out so they can be unit-tested without spawning a child process or touching
// the filesystem. Keep this module side-effect free.

/**
 * Decide whether a child's exit should trigger an auto-rollback to build.prev/.
 *
 * We roll back only on an *early* non-zero exit — the crash-loop signature of a
 * bad migration, missing env var, or partially-written build — and only when a
 * previous known-good tree exists. Clean exits (code 0, e.g. the redeploy
 * self-restart) and signal kills (code === null) never roll back.
 *
 * @param {object} args
 * @param {number|null|undefined} args.code  Child exit code (null when killed by signal).
 * @param {number} args.uptimeMs             How long the child ran before exiting.
 * @param {boolean} args.hasPrev             Whether build.prev/ is available to restore.
 * @param {number} args.thresholdMs          "Early" cutoff; faster than this ⇒ crash-loop.
 * @returns {boolean}
 */
export function shouldRollback({ code, uptimeMs, hasPrev, thresholdMs }) {
	if (!hasPrev) return false;
	if (code === 0) return false;
	if (code === null || code === undefined) return false;
	return uptimeMs < thresholdMs;
}

/**
 * Delay before respawning the child after it exits. A clean exit (the redeploy
 * rollover) restarts almost immediately; a crash backs off a little so a
 * persistent failure doesn't busy-loop.
 *
 * @param {number|null|undefined} code
 * @returns {number}
 */
export function restartDelayMs(code) {
	return code === 0 ? 250 : 2000;
}
