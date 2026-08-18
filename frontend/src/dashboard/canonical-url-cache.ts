type CacheEntry<T> = {
  controller: AbortController;
  expiresAt: number;
  promise: Promise<T>;
  settled: boolean;
  ttlMs: number;
  waiters: number;
};

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

export class CanonicalUrlCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();

  constructor(
    readonly maxEntries: number,
    readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get(
    url: string,
    loader: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    ttlMs = Number.POSITIVE_INFINITY,
  ): Promise<T> {
    if (!url.startsWith("/")) throw new TypeError("cache key must be a canonical relative URL");
    if (!(ttlMs > 0)) throw new RangeError("ttlMs must be positive");
    if (signal?.aborted) return Promise.reject(abortError());
    let entry = this.#entries.get(url);
    if (entry?.settled && entry.expiresAt <= this.now()) {
      this.#entries.delete(url);
      entry = undefined;
    }
    if (!entry) {
      this.#makeRoom();
      if (this.#entries.size >= this.maxEntries) {
        return Promise.reject(new Error("canonical_url_cache_capacity_exhausted"));
      }
      const controller = new AbortController();
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(loader(controller.signal));
      } catch (error) {
        promise = Promise.reject(error);
      }
      entry = {
        controller,
        expiresAt: Number.POSITIVE_INFINITY,
        promise,
        settled: false,
        ttlMs,
        waiters: 0,
      };
      this.#entries.set(url, entry);
      const ownedEntry = entry;
      void entry.promise.then(
        () => {
          ownedEntry.settled = true;
          ownedEntry.expiresAt = this.now() + ownedEntry.ttlMs;
          this.#trim();
        },
        () => {
          ownedEntry.settled = true;
          if (this.#entries.get(url) === ownedEntry) this.#entries.delete(url);
        },
      );
      this.#trim();
    } else {
      if (ttlMs > entry.ttlMs) {
        entry.ttlMs = ttlMs;
        if (entry.settled) entry.expiresAt = this.now() + ttlMs;
      }
      this.#entries.delete(url);
      this.#entries.set(url, entry);
    }
    entry.waiters += 1;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        entry!.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        reject(abortError());
        if (!entry!.settled && entry!.waiters === 0) {
          if (this.#entries.get(url) === entry) this.#entries.delete(url);
          entry!.controller.abort();
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void entry!.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  clear(): void {
    for (const entry of this.#entries.values()) {
      if (!entry.settled) entry.controller.abort();
    }
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #trim(): void {
    while (this.#entries.size > this.maxEntries) {
      if (!this.#evictOldestSettled()) return;
    }
  }

  #makeRoom(): void {
    while (this.#entries.size >= this.maxEntries && this.#evictOldestSettled()) {
      // Settled LRU entries are safe to evict; live shared promises are retained.
    }
  }

  #evictOldestSettled(): boolean {
    for (const [url, entry] of this.#entries) {
      if (!entry.settled) continue;
      this.#entries.delete(url);
      return true;
    }
    return false;
  }
}
