// Reject a promise that never settles within `timeoutMs`. The underlying work
// keeps running (we don't get an interrupt for free), but the caller stops
// `await`-ing it — which is the point: a hung agent subprocess must not
// pin a request (or the per-user `starting` dedupe lock) open forever. A
// timeoutMs of 0 disables the guard.

export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new TimeoutError(label, timeoutMs)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}
