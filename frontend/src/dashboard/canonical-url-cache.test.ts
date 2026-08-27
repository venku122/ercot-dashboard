import { describe, expect, it, vi } from "vitest";

import { CanonicalUrlCache } from "./canonical-url-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("CanonicalUrlCache", () => {
  it("shares pending and resolved values for one canonical URL", async () => {
    const cache = new CanonicalUrlCache<number>(4);
    const pending = deferred<number>();
    const loader = vi.fn(() => pending.promise);
    const first = cache.get("/api/v2/tiles/a/1d/0/native", loader);
    const second = cache.get("/api/v2/tiles/a/1d/0/native", loader);
    pending.resolve(42);

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    await expect(cache.get("/api/v2/tiles/a/1d/0/native", loader)).resolves.toBe(42);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps shared work alive when only one subscriber cancels", async () => {
    const cache = new CanonicalUrlCache<number>(4);
    const pending = deferred<number>();
    const loader = vi.fn((_signal: AbortSignal) => pending.promise);
    const controller = new AbortController();
    const cancelled = cache.get("/shared", loader, controller.signal);
    const survivor = cache.get("/shared", loader);
    controller.abort();
    pending.resolve(7);

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(survivor).resolves.toBe(7);
    await expect(cache.get("/shared", loader)).resolves.toBe(7);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("aborts orphaned work and lets a later request retry cleanly", async () => {
    const cache = new CanonicalUrlCache<number>(4);
    const firstController = new AbortController();
    let underlyingAborted = false;
    const first = cache.get(
      "/retry",
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              underlyingAborted = true;
              reject(new DOMException("cancelled", "AbortError"));
            },
            { once: true },
          );
        }),
      firstController.signal,
    );
    firstController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingAborted).toBe(true);
    await expect(cache.get("/retry", async () => 9)).resolves.toBe(9);
  });

  it("waits for both subscribers to abort before cancelling shared work", async () => {
    const cache = new CanonicalUrlCache<number>(2);
    const firstController = new AbortController();
    const secondController = new AbortController();
    let underlyingAborts = 0;
    const loader = (signal: AbortSignal) =>
      new Promise<number>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            underlyingAborts += 1;
            reject(new DOMException("cancelled", "AbortError"));
          },
          { once: true },
        );
      });
    const first = cache.get("/both", loader, firstController.signal);
    const second = cache.get("/both", loader, secondController.signal);
    firstController.abort();
    expect(underlyingAborts).toBe(0);
    secondController.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(underlyingAborts).toBe(1);
    await expect(cache.get("/both", async () => 12)).resolves.toBe(12);
  });

  it("does not invoke a loader for an already-aborted subscriber", async () => {
    const cache = new CanonicalUrlCache<number>(2);
    const controller = new AbortController();
    const loader = vi.fn(async () => 1);
    controller.abort();

    await expect(cache.get("/already", loader, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loader).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it("removes rejected entries so transient failures are not cached", async () => {
    const cache = new CanonicalUrlCache<number>(4);
    const loader = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(5);

    await expect(cache.get("/failure", loader)).rejects.toThrow("transient");
    await expect(cache.get("/failure", loader)).resolves.toBe(5);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("bounds resolved entries with least-recently-used eviction", async () => {
    const cache = new CanonicalUrlCache<string>(2);
    const loader = vi.fn(async (_signal: AbortSignal) => "loaded");
    await cache.get("/one", async () => "one");
    await cache.get("/two", async () => "two");
    await cache.get("/one", loader);
    await cache.get("/three", async () => "three");

    expect(cache.size).toBe(2);
    await cache.get("/two", loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("expires mutable values without retaining the rejected or stale promise", async () => {
    let now = 1_000;
    const cache = new CanonicalUrlCache<number>(2, () => now);
    const loader = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await expect(cache.get("/recent", loader, undefined, 100)).resolves.toBe(1);
    now = 1_099;
    await expect(cache.get("/recent", loader, undefined, 100)).resolves.toBe(1);
    now = 1_100;
    await expect(cache.get("/recent", loader, undefined, 100)).resolves.toBe(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("reclassifies a formerly recent resolved URL with sealed retention", async () => {
    let now = 1_000;
    const cache = new CanonicalUrlCache<number>(2, () => now);
    const loader = vi.fn(async () => 1);
    await cache.get("/transition", loader, undefined, 100);
    now = 1_050;
    await cache.get("/transition", loader, undefined, 10_000);
    now = 5_000;
    await cache.get("/transition", loader, undefined, 10_000);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("retains live shared promises and rejects overflow instead of duplicating work", async () => {
    const cache = new CanonicalUrlCache<number>(1);
    const pending = deferred<number>();
    const first = cache.get("/pending", () => pending.promise);
    await expect(cache.get("/overflow", async () => 2)).rejects.toThrow("capacity_exhausted");
    expect(cache.size).toBe(1);
    pending.resolve(1);
    await expect(first).resolves.toBe(1);
  });

  it("rejects invalid capacity and noncanonical keys", async () => {
    expect(() => new CanonicalUrlCache(0)).toThrow("maxEntries");
    const cache = new CanonicalUrlCache<number>(1);
    expect(() => cache.get("https://example.test/value", async () => 1)).toThrow(
      "canonical relative URL",
    );
    expect(() => cache.get("/value", async () => 1, undefined, 0)).toThrow("ttlMs");
  });
});
