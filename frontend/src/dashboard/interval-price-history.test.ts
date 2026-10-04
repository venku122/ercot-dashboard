import { afterEach, expect, it, vi } from "vitest";
import * as market from "./market-geography";
afterEach(() => vi.unstubAllGlobals());
it("exact interval history rejects another point and does not borrow Houston", async () => {
  const api = market as unknown as {
    loadIntervalPriceHistory?: (
      identity: string,
      start: number,
      end: number,
      signal?: AbortSignal,
    ) => Promise<unknown>;
  };
  expect(api.loadIntervalPriceHistory).toBeTypeOf("function");
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          product_id: "NP6-905-CD",
          identity: "HB_HOUSTON--HU",
          interval_seconds: 900,
          rows: [],
        }),
      ),
  );
  await expect(api.loadIntervalPriceHistory!("HB_NORTH--HU", 100, 200)).rejects.toThrow();
});
