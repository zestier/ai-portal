// Buffered async iterator queue. Producers push events; one consumer iterates.
// Supports backpressure-less producers (events buffered in memory) plus
// abort, error, and clean completion.

export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<{
    resolve: (v: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown = null;

  push(value: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value, done: false });
    else this.buffer.push(value);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters
        .shift()!
        .resolve({ value: undefined as unknown as T, done: true });
    }
  }

  fail(err: unknown) {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!.reject(err);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.error) throw this.error;
        return;
      }
      try {
        const value = await new Promise<T>((resolve, reject) => {
          this.waiters.push({
            resolve: (r) => {
              if (r.done) reject(new _Done());
              else resolve(r.value);
            },
            reject,
          });
        });
        yield value;
      } catch (e) {
        if (e instanceof _Done) return;
        throw e;
      }
      continue;
    }
  }
}

class _Done extends Error {}
