import { afterEach, expect, it, vi } from "vitest";
import captured from "../../../e2e/fixtures/np6-905-captured-display-subset.json";
import history from "../../../e2e/fixtures/np6-905-captured-history.json";
import { loadIntervalPriceHistory } from "./market-geography";
const native = captured.rows.find((r) => r.settlement_point === "HB_HOUSTON")!;
const target = native.target_ts;
const row = history.rows[0]!;
afterEach(() => vi.unstubAllGlobals());
function transport() {
  const fetch = vi.fn(async (path: string) => {
    const q = new URL(path, "http://localhost");
    const start = Number(q.searchParams.get("start")),
      end = Number(q.searchParams.get("end"));
    return new Response(
      JSON.stringify({
        product_id: "NP6-905-CD",
        identity: "HB_HOUSTON--HU",
        interval_seconds: 900,
        policy: "latest_published_corrections_not_as_known",
        rows: [row].filter((r) => r.target_ts >= start && r.target_ts < end),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it.each([0, 0.4, 0.6])(
  "retains captured published interval crossing fractional right edge %s",
  async (fraction) => {
    const fetch = transport();
    const start = target - 900 + fraction,
      end = target - 300 + fraction;
    const rows = await loadIntervalPriceHistory("HB_HOUSTON--HU", start, end);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target_ts: target,
      interval_start: target - 900,
      interval_end: target,
      value: native.settlement_point_price,
      publication: { document_id: captured.publication.document_id },
    });
    expect(new URL(fetch.mock.calls[0]![0], "http://localhost").searchParams.get("end")).toBe(
      String(target + 1),
    );
  },
);
it("filters left touching delivery support and retains aligned ending support", async () => {
  transport();
  expect(await loadIntervalPriceHistory("HB_HOUSTON--HU", target, target + 600)).toEqual([]);
  expect(await loadIntervalPriceHistory("HB_HOUSTON--HU", target - 900, target)).toHaveLength(1);
});
it.each([0, 0.4, 0.6])("bounds exact 35 day fractional request %s", async (fraction) => {
  const fetch = transport();
  await loadIntervalPriceHistory(
    "HB_HOUSTON--HU",
    target - 300 - 35 * 86400 + fraction,
    target - 300 + fraction,
  );
  const q = new URL(fetch.mock.calls[0]![0], "http://localhost");
  const start = Number(q.searchParams.get("start")),
    end = Number(q.searchParams.get("end"));
  expect(end - start).toBeLessThanOrEqual(35 * 86400 + 900);
  expect(Math.floor((end - 1) / 900) - Math.ceil(start / 900) + 1).toBe(3361);
});
it("does not invent an unpublished pending interval", async () => {
  transport();
  expect(await loadIntervalPriceHistory("HB_HOUSTON--HU", target + 1, target + 600)).toEqual([]);
});
it.each(["duplicate", "wrong point", "outside query"])(
  "rejects %s canonical rows",
  async (kind) => {
    const rows =
      kind === "duplicate"
        ? [row, row]
        : kind === "wrong point"
          ? [{ ...row, settlement_point: "HB_NORTH" }]
          : [row];
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ...history, rows })));
    await expect(
      loadIntervalPriceHistory(
        "HB_HOUSTON--HU",
        kind === "outside query" ? target + 901 : target - 900,
        target + 1200,
      ),
    ).rejects.toThrow("Invalid interval price history rows");
  },
);
it.each([NaN, Infinity])(
  "rejects nonfinite selected bounds %s before transport",
  async (invalid) => {
    const fetch = transport();
    await expect(loadIntervalPriceHistory("HB_HOUSTON--HU", target - 900, invalid)).rejects.toThrow(
      "Unsupported",
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);
