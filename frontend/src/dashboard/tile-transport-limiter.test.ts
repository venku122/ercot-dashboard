import { expect, it } from "vitest";
import { CanonicalUrlCache } from "./canonical-url-cache";
import { TileTransportLimiter } from "./tile-transport-limiter";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("removes aborted queued transports and reuses their eventual capacity", async () => {
  const limiter = new TileTransportLimiter(1),
    blocker = deferred();
  const active = limiter.run(new AbortController().signal, () => blocker.promise);
  const controller = new AbortController();
  let calls = 0;
  const cancelled = limiter
    .run(controller.signal, async () => {
      calls++;
    })
    .catch((error: DOMException) => error.name);
  controller.abort();
  expect(await cancelled).toBe("AbortError");
  const queued = limiter.run(new AbortController().signal, async () => {
    calls++;
    return "next";
  });
  blocker.release();
  await active;
  expect(await queued).toBe("next");
  expect(calls).toBe(1);
});

it("keeps a queued singleflight transport when one subscriber cancels", async () => {
  const limiter = new TileTransportLimiter(1),
    blocker = deferred();
  const active = limiter.run(new AbortController().signal, () => blocker.promise);
  const cache = new CanonicalUrlCache<string>(4),
    first = new AbortController(),
    second = new AbortController();
  let calls = 0;
  const loader = (signal: AbortSignal) =>
    limiter.run(signal, async () => {
      calls++;
      return "shared";
    });
  const cancelled = cache
    .get("/tile", loader, first.signal)
    .catch((error: DOMException) => error.name);
  const surviving = cache.get("/tile", loader, second.signal);
  first.abort();
  expect(await cancelled).toBe("AbortError");
  blocker.release();
  await active;
  expect(await surviving).toBe("shared");
  expect(calls).toBe(1);
});

it("releases transport permits after failures and prevents already aborted reads", async () => {
  const limiter = new TileTransportLimiter(1);
  await expect(
    limiter.run(new AbortController().signal, async () => {
      throw new Error("upstream");
    }),
  ).rejects.toThrow("upstream");
  expect(await limiter.run(new AbortController().signal, async () => "retry")).toBe("retry");
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  await expect(
    limiter.run(aborted.signal, async () => {
      calls++;
    }),
  ).rejects.toHaveProperty("name", "AbortError");
  expect(calls).toBe(0);
});
