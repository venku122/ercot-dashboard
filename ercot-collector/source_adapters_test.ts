import { incrementalMetrics, metricBatches, payloadHash } from "./_lib.ts";
import { parseFuelMix } from "./fuel_mix.ts";
import { parseGenerationOutages } from "./generation_outages.ts";
import { parseOperationsMessages, parseOperationsTimestamp } from "./operations_messages.ts";
import { parseStorage } from "./storage.ts";
import { parseSupplyDemand } from "./supply_demand.ts";
import { adapter as windSolarAdapter, parseWindSolar } from "./wind_solar.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);

async function jsonFixture(name: string) {
  return JSON.parse(await Deno.readTextFile(fixture(name)));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(callback: () => Promise<unknown>, expected: string) {
  try {
    await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `expected ${expected}, received ${message}`);
    return;
  }
  throw new Error(`expected rejection containing ${expected}`);
}

Deno.test("fuel mix success fixture normalizes generation and seasonal capacity", async () => {
  const result = await parseFuelMix(await jsonFixture("fuel_mix.success.json"));
  assert(
    result.metrics.some((entry) => entry.metric_name.endsWith("generation_mw")),
    "generation",
  );
  assert(
    result.metrics.some((entry) => entry.metric_name.endsWith("seasonal_capacity_mw")),
    "capacity",
  );
  assert(result.sourceTimestamp === 1784628660, "source timestamp");
});

Deno.test("storage success and repeated DST hour retain distinct epochs", async () => {
  const result = await parseStorage(await jsonFixture("storage.success.json"));
  assert(result.metrics.length === 3, "three storage metrics");
  const dst = await parseStorage(await jsonFixture("storage.dst.json"));
  const timestamps = dst.metrics[2].points.map((point) => point.timestamp);
  assert(timestamps.length === 2, "two DST points");
  assert(timestamps[1]! - timestamps[0]! === 3600, "repeated hour is distinct");
});

Deno.test("supply and demand fixture includes actual and forecast series", async () => {
  const result = await parseSupplyDemand(await jsonFixture("supply_demand.success.json"));
  const names = new Set(result.metrics.map((entry) => entry.metric_name));
  assert(names.has("ercot.supply_demand.demand_mw"), "actual demand");
  assert(names.has("ercot.supply_demand.forecast_demand_mw"), "forecast demand");
  assert(names.has("ercot.supply_demand.committed_capacity_mw"), "committed capacity");
  assert(result.dataTimestamp === 1784610000, "actual data timestamp");
});

Deno.test("supply and demand actual series exclude future forecast rows", async () => {
  const result = await parseSupplyDemand({
    lastUpdated: "2026-07-28 22:55:00-0500",
    data: [
      {
        capacity: 94_000,
        available: 93_000,
        demand: 73_000,
        epoch: 1_785_297_000_000,
        forecast: 0,
      },
      {
        capacity: 97_000,
        available: 96_000,
        demand: 71_000,
        epoch: 1_785_301_200_000,
        forecast: 1,
      },
    ],
    forecast: [
      {
        availCapGen: 100_000,
        forecastedDemand: 72_000,
        epoch: 1_785_304_800_000,
      },
    ],
  });
  const actual = result.metrics.find(
    (entry) => entry.metric_name === "ercot.supply_demand.demand_mw",
  );

  assert(actual?.points.length === 1, "one observed demand point");
  assert(actual.points[0]!.timestamp === 1_785_297_000, "observed timestamp");
  assert(result.dataTimestamp === 1_785_297_000, "freshness follows actual data");
});

Deno.test("generation outage fixture preserves bounded category tags", async () => {
  const result = await parseGenerationOutages(await jsonFixture("generation_outages.success.json"));
  assert(result.metrics.length === 10, "nine category series and total compatibility series");
  assert(
    result.metrics.every((entry) => (entry.tags ?? []).every((tag) => !tag.includes("178461"))),
    "no ephemeral tags",
  );
});

Deno.test("wind and solar live schema remains useful", async () => {
  const result = await parseWindSolar(await jsonFixture("wind_solar.success.json"));
  assert(
    result.metrics.some((entry) => entry.metric_name.endsWith("actual_mw")),
    "actual",
  );
  assert(
    result.metrics.some((entry) => entry.metric_name.endsWith("forecast_mw")),
    "forecast",
  );
  assert(
    result.metrics.some((entry) => entry.metric_name.endsWith("hsl_mw")),
    "hsl",
  );
  const latestActual = Math.max(
    ...result.metrics
      .filter((entry) => entry.metric_name === "ercot.renewables.actual_mw")
      .flatMap((entry) => entry.points.map((point) => point.timestamp ?? 0)),
  );
  assert(result.dataTimestamp === latestActual, "freshness follows renewable actuals");
  assert(windSolarAdapter.publicationIntervalSeconds === 3600, "hourly publication");
});

Deno.test("operations message HTML becomes stable structured events", async () => {
  const html = await Deno.readTextFile(fixture("operations_messages.success.html"));
  const first = await parseOperationsMessages(html);
  const second = await parseOperationsMessages(html);
  assert(first.events.length === 2, "two events");
  assert(first.events[0].dedupe_key === second.events[0].dedupe_key, "stable dedupe key");
  assert(first.events[1].status === "Cancelled", "status");
  const dstHtml = await Deno.readTextFile(fixture("operations_messages.dst.html"));
  const dst = await parseOperationsMessages(dstHtml);
  assert(dst.events[1]!.starts_at - dst.events[0]!.starts_at === 7200, "fall transition offsets");
  assert(
    parseOperationsTimestamp("Mar 8, 2026 1:30:00 AM") ===
      Date.parse("Mar 8, 2026 1:30:00 AM GMT-0600") / 1000,
    "spring standard-time side",
  );
  assert(
    parseOperationsTimestamp("Mar 8, 2026 3:30:00 AM") ===
      Date.parse("Mar 8, 2026 3:30:00 AM GMT-0500") / 1000,
    "spring daylight-time side",
  );
});

Deno.test("invalid, zero-core, and unchanged payload behavior is deterministic", async () => {
  await assertRejects(
    async () => JSON.parse(await Deno.readTextFile(fixture("invalid.json"))),
    "JSON",
  );
  const zero = await jsonFixture("zero.json");
  await assertRejects(() => parseFuelMix(zero), "fuel_mix");
  await assertRejects(() => parseStorage(zero), "zero_core");
  await assertRejects(() => parseSupplyDemand(zero), "zero_core");
  await assertRejects(() => parseGenerationOutages(zero), "zero_core");
  await assertRejects(() => parseWindSolar(zero), "zero_core");
  await assertRejects(() => parseOperationsMessages("<html></html>"), "zero_core");
  assert(
    (await payloadHash({ b: 2, a: 1 })) === (await payloadHash({ a: 1, b: 2 })),
    "stable unchanged payload hash",
  );
});

Deno.test("large historical payloads are split below the receiver body bound", () => {
  const points = Array.from({ length: 20_000 }, (_, index) => ({
    timestamp: 1_700_000_000 + index * 300,
    value: index,
    dedupe_key: `fixture:${index}`,
  }));
  const batches = metricBatches(
    [{ metric_name: "ercot.fixture", points, metric_type: "gauge" }],
    100_000,
  );
  assert(batches.length > 1, "split batches");
  assert(
    batches.every((batch) => new TextEncoder().encode(JSON.stringify(batch)).byteLength <= 100_000),
    "bounded batch bytes",
  );
});

Deno.test("rolling ingestion resumes from a persisted checkpoint and submits only changes", () => {
  const initial = [
    {
      metric_name: "ercot.actual",
      points: [
        { timestamp: 100, value: 10, dedupe_key: "actual:100" },
        { timestamp: 200, value: 20, dedupe_key: "actual:200" },
      ],
    },
    {
      metric_name: "ercot.forecast",
      points: [
        { timestamp: 10_000, value: 30, dedupe_key: "forecast:10000" },
        { timestamp: 20_000, value: 40, dedupe_key: "forecast:20000" },
      ],
    },
  ];
  const first = incrementalMetrics(initial, null, ["ercot.forecast"], 120);
  assert(first.metrics.flatMap((entry) => entry.points).length === 4, "initial full submit");
  assert(first.checkpoint.version === 2, "series-aware checkpoint");
  assert(
    Object.keys(first.checkpoint.high_water_ts_by_series).length === 2,
    "one watermark per series",
  );

  const restartedCheckpoint = JSON.parse(JSON.stringify(first.checkpoint));
  const revised = structuredClone(initial);
  revised[0]!.points.push({ timestamp: 300, value: 25, dedupe_key: "actual:300" });
  revised[1]!.points[0]!.value = 31;
  const second = incrementalMetrics(revised, restartedCheckpoint, ["ercot.forecast"], 120);
  const submitted = second.metrics.flatMap((entry) => entry.points);

  assert(submitted.length === 2, "only new actual and revised forecast");
  assert(
    submitted.some((point) => point.dedupe_key === "actual:300"),
    "new actual",
  );
  assert(
    submitted.some((point) => point.dedupe_key === "forecast:10000"),
    "forecast revision",
  );

  const unchanged = incrementalMetrics(revised, second.checkpoint, ["ercot.forecast"], 120);
  assert(unchanged.metrics.length === 0, "steady-state identical replay is empty");
});

Deno.test("legacy global checkpoint replays suppressed actuals during v2 migration", () => {
  const legacy = {
    version: 1 as const,
    high_water_ts: 20_000,
    values: { "forecast:20000": 40 },
  };
  const recovered = incrementalMetrics(
    [
      {
        metric_name: "ercot.actual",
        points: [
          { timestamp: 100, value: 10, dedupe_key: "actual:100" },
          { timestamp: 200, value: 20, dedupe_key: "actual:200" },
          { timestamp: 300, value: 25, dedupe_key: "actual:300" },
        ],
      },
      {
        metric_name: "ercot.forecast",
        points: [{ timestamp: 20_000, value: 40, dedupe_key: "forecast:20000" }],
      },
    ],
    legacy,
    ["ercot.forecast"],
    120,
  );
  const submitted = recovered.metrics.flatMap((entry) => entry.points);

  assert(recovered.checkpoint.version === 2, "checkpoint upgraded");
  assert(submitted.length === 3, "actual history replayed through receiver dedupe");
  assert(
    submitted.some((point) => point.dedupe_key === "actual:300"),
    "latest actual recovered",
  );
  assert(
    !submitted.some((point) => point.dedupe_key === "forecast:20000"),
    "unchanged forecast omitted",
  );
});

Deno.test("series watermarks distinguish tags on the same metric", () => {
  const initial = incrementalMetrics(
    [
      {
        metric_name: "ercot.renewables.actual_mw",
        tags: ["source:wind_solar", "resource:wind"],
        points: [{ timestamp: 100, value: 10, dedupe_key: "wind:100" }],
      },
      {
        metric_name: "ercot.renewables.actual_mw",
        tags: ["resource:solar", "source:wind_solar"],
        points: [{ timestamp: 200, value: 20, dedupe_key: "solar:200" }],
      },
    ],
    null,
  );
  assert(initial.checkpoint.version === 2, "series-aware checkpoint");
  assert(
    Object.keys(initial.checkpoint.high_water_ts_by_series).length === 2,
    "tagged series have independent watermarks",
  );

  const updated = incrementalMetrics(
    [
      {
        metric_name: "ercot.renewables.actual_mw",
        tags: ["resource:wind", "source:wind_solar"],
        points: [
          { timestamp: 100, value: 10, dedupe_key: "wind:100" },
          { timestamp: 150, value: 15, dedupe_key: "wind:150" },
        ],
      },
      {
        metric_name: "ercot.renewables.actual_mw",
        tags: ["source:wind_solar", "resource:solar"],
        points: [
          { timestamp: 200, value: 20, dedupe_key: "solar:200" },
          { timestamp: 250, value: 25, dedupe_key: "solar:250" },
        ],
      },
    ],
    initial.checkpoint,
  );
  const submitted = updated.metrics.flatMap((entry) => entry.points);
  assert(submitted.length === 2, "one new point from each tagged series");
  assert(
    submitted.some((point) => point.dedupe_key === "wind:150"),
    "new wind point",
  );
  assert(
    submitted.some((point) => point.dedupe_key === "solar:250"),
    "new solar point",
  );
});
