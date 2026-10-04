import { expect, test } from "@playwright/test";
import { observeHistory } from "./performance-observations";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

const demand = "ercot.supply_demand.demand_mw";
const capacity = "ercot.supply_demand.available_capacity_mw";
test("native source tuples agree across batch, contributors, pairing and six overlapping windows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  const history = observeHistory(page);
  await page.goto("/");
  const hour = FIXED_NOW_SECONDS - 3600;
  const tiles = await page.evaluate(async (start) => {
    return Promise.all(
      ["demand", "available-capacity", "paired-headroom"].map(async (key) =>
        (await fetch(`/api/v2/tiles/supply-demand.${key}/1h/${start}/native`)).json(),
      ),
    );
  }, hour);
  const previous = new Map<number, [number, number]>();
  const summaries: unknown[] = [];
  for (const seconds of [21600, 86400, 604800, 2592000, 7776000, 31536000]) {
    const body = await page.evaluate(
      async ({ since, until, demand, capacity }) =>
        (
          await fetch("/api/series/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              queries: [demand, capacity].map((metric, i) => ({
                id: String(i),
                max_points: 0,
                aggregation: "minmax",
                metric,
                tags: ["source:supply_demand"],
                since,
                until,
              })),
            }),
          })
        ).json(),
      { since: FIXED_NOW_SECONDS - seconds, until: FIXED_NOW_SECONDS, demand, capacity },
    );
    const demandPoints = new Map<number, number>(body.series[0].points);
    const capacityPoints = new Map<number, number>(body.series[1].points);
    for (const bucket of tiles[0].buckets) {
      const epoch = bucket.state.first_ts;
      const d = demandPoints.get(epoch),
        c = capacityPoints.get(epoch);
      expect(d, `${seconds}s demand at ${epoch}`).toBe(bucket.state.first_value);
      expect(c, `${seconds}s capacity at ${epoch}`).toBe(
        tiles[1].buckets.find(
          (row: { state: { first_ts: number } }) => row.state.first_ts === epoch,
        ).state.first_value,
      );
      expect(c! - d!).toBe(
        tiles[2].buckets.find(
          (row: { state: { first_ts: number } }) => row.state.first_ts === epoch,
        ).state.first_value,
      );
    }
    const overlap = [...previous.keys()].map((epoch) => [
      epoch,
      [demandPoints.get(epoch), capacityPoints.get(epoch)],
    ]);
    expect(overlap, `${seconds}s every previously observed overlapping native tuple`).toEqual([
      ...previous,
    ]);
    for (const [epoch, value] of demandPoints)
      previous.set(epoch, [value, capacityPoints.get(epoch)!]);
    const projected = await page.evaluate(
      async ({ since, until, metric }) =>
        (
          await fetch("/api/series/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              queries: [
                {
                  id: "bounded",
                  metric,
                  tags: ["source:supply_demand"],
                  since,
                  until,
                  max_points: 1200,
                  aggregation: "minmax",
                },
              ],
            }),
          })
        ).json(),
      { since: FIXED_NOW_SECONDS - seconds, until: FIXED_NOW_SECONDS, metric: demand },
    );
    const bounded = projected.series[0];
    expect(bounded.points.length).toBeLessThanOrEqual(1200);
    expect(bounded.meta.stats.count).toBe(seconds / 300 + 1);
    expect(bounded.points, "every minmax vertex is a genuine raw source tuple").toEqual(
      bounded.points.map(([epoch]: [number, number]) => [epoch, demandPoints.get(epoch)]),
    );
    expect(Math.min(...bounded.points.map((point: number[]) => point[1]!))).toBe(
      body.series[0].meta.stats.minimum,
    );
    expect(Math.max(...bounded.points.map((point: number[]) => point[1]!))).toBe(
      body.series[0].meta.stats.maximum,
    );
    expect(bounded.meta.stats.latest).toBe(demandPoints.get(FIXED_NOW_SECONDS));
    summaries.push({
      seconds,
      rawCount: body.series[0].points.length,
      boundedVertexCount: bounded.points.length,
      bucketSeconds: bounded.meta.bucket_seconds,
      sourceStats: bounded.meta.stats,
      firstEpoch: body.series[0].points[0][0],
      endEpoch: body.series[0].points.at(-1)[0],
      overlappingEpochsVerified: previous.size,
    });
    // v1 uses inclusive requested bounds; these are actual 300-second source epochs.
    expect(body.series[0].points.length).toBe(seconds / 300 + 1);
    expect(body.series[0].points.at(-1)[0]).toBe(FIXED_NOW_SECONDS);
    expect(body.series[0].meta.stats.count).toBe(seconds / 300 + 1);
  }
  // The tile contract excludes its ending epoch, including the v1 end observation.
  expect(tiles[0].buckets).toHaveLength(12);
  expect(tiles[0].buckets.at(-1).state.last_ts).toBe(FIXED_NOW_SECONDS - 300);
  const nextTile = await page.evaluate(
    async (start) => (await fetch(`/api/v2/tiles/supply-demand.demand/1h/${start}/native`)).json(),
    FIXED_NOW_SECONDS,
  );
  expect(nextTile.buckets).toHaveLength(1);
  expect(nextTile.buckets[0].state.first_ts).toBe(FIXED_NOW_SECONDS);
  expect(nextTile.buckets[0].state.first_value).toBe(previous.get(FIXED_NOW_SECONDS)![0]);
  expect(
    history.requests.some(({ method, url }) => method === "GET" && url.includes("/api/v2/tiles/")),
  ).toBe(true);
  expect(
    history.requests.some(
      ({ method, url }) => method === "POST" && url.includes("/api/series/batch"),
    ),
  ).toBe(true);
  await history.settled();
  await test.info().attach("native-source-oracle-contract", {
    body: JSON.stringify(summaries, null, 2),
    contentType: "application/json",
  });
});
