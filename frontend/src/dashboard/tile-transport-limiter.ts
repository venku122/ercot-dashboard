type Waiter = {
  signal: AbortSignal;
  grant: () => void;
  reject: (error: DOMException) => void;
  abort: () => void;
};

/** Permits belong to canonical-cache shared transports, never individual subscribers. */
export class TileTransportLimiter {
  #active = 0;
  readonly #queue: Waiter[] = [];
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("positive transport limit required");
  }

  async run<T>(signal: AbortSignal, transport: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      if (this.#active < this.limit) {
        this.#active++;
        resolve();
        return;
      }
      const waiter: Waiter = {
        signal,
        grant: resolve,
        reject,
        abort: () => {
          const index = this.#queue.indexOf(waiter);
          if (index < 0) return;
          this.#queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          reject(new DOMException("The operation was aborted", "AbortError"));
        },
      };
      this.#queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
    try {
      signal.throwIfAborted();
      return await transport();
    } finally {
      this.#active--;
      const next = this.#queue.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.abort);
        this.#active++;
        next.grant();
      }
    }
  }
}
