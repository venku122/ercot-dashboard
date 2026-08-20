import {
  aggregateCapacityTrendWorkbooks,
  aggregateGisWorkbook,
  GIS_FUEL_REGISTRY,
  GIS_PHASE_REGISTRY,
  LONG_HORIZON_POLICY,
  type Sheet,
  type Workbook,
} from "./long_horizon.ts";
import {
  runLongHorizonCycle,
  runLongHorizonProducts,
  sourcePeriod,
} from "./long_horizon_runner.ts";

function assert(condition: unknown, message = "assertion_failed"): asserts condition {
  if (!condition) throw new Error(message);
}
const GIS_SHEETS = [
  "Contents",
  "Disclaimer and References",
  "Acronyms",
  "Summary",
  "Project Details - Large Gen",
  "Project Details - Small Gen",
  "GIM Trends",
  "data_GIM Trends_1",
  "data_GIM Trends_2",
  "data_GIM Trends_3",
  "data_GIM Trends_4",
  "Commissioning Update",
  "Inactive Projects",
  "Cancellation Update",
];
const TREND_SHEETS = [
  "Wind Chart",
  "Solar Chart",
  "Battery Chart",
  "Gas-Combined Cycle Chart",
  "Gas-Other Chart",
];
const row = (value: Record<string, string | number>) => new Map(Object.entries(value));

Deno.test("GIS reduction is signed, registry ordered, and aggregate only", () => {
  const workbook = new Map<string, Sheet>(GIS_SHEETS.map((name) => [name, new Map()]));
  workbook.set(
    "Project Details - Large Gen",
    new Map([
      [31, row({ A: "INR", C: "GIM Study Phase", I: "Fuel", K: "Capacity (MW)" })],
      [
        33,
        row({
          A: "not-retained",
          B: "not-retained-name",
          C: "SS Started, FIS Not Started, No IA",
          F: "not-retained-county",
          I: "BIO",
          K: -7.2,
        }),
      ],
      [34, row({ A: "not-retained-2", C: "SS Started, FIS Not Started, No IA", I: "BIO", K: 10 })],
    ]),
  );
  workbook.set(
    "Project Details - Small Gen",
    new Map([
      [15, row({ A: "INR", I: "Fuel", K: "Capacity (MW)" })],
      [18, row({ A: "not-retained-3", I: "WIN", K: 9 })],
    ]),
  );
  const result = aggregateGisWorkbook(workbook, "2026-07");
  assert(
    JSON.stringify(result) ===
      JSON.stringify([
        {
          phase: GIS_PHASE_REGISTRY[0]!.id,
          fuel: GIS_FUEL_REGISTRY[0]!.id,
          count: 2,
          capacity_mw: 2.8,
        },
        { phase: "small_generator", fuel: "wind", count: 1, capacity_mw: 9 },
      ]),
  );
  assert(!JSON.stringify(result).includes("not-retained"));
  assert(
    LONG_HORIZON_POLICY ===
      "official_planning_snapshots_not_committed_capacity_or_realization_forecast",
  );
});

function trendWorkbook(monthly: boolean): Workbook {
  const workbook = new Map<string, Sheet>();
  for (const name of TREND_SHEETS) {
    const hasOther = !monthly || name === "Gas-Other Chart";
    const header: Record<string, string> = {
      A: monthly ? "Month/Year" : "Year",
      B: monthly
        ? "Cumulative operational, No FS, and FS Posted"
        : "Cumulative Operational, No FS, and FS Posted",
      C: monthly ? "Cumulative MW Operational " : "Cumulative MW Operational",
      D: "IA Signed-Financial Security Posted",
      E: "IA Signed-No Financial Security",
      F: hasOther ? "Other Planned" : "Small Generator",
    };
    if (hasOther) header.G = "Small Generator";
    const values: Record<string, string | number> = {
      A: monthly ? 46223 : 2026,
      B: 15,
      C: 10,
      D: 2,
      E: 1,
      F: hasOther ? 1 : 2,
    };
    if (hasOther) values.G = 1;
    const projectHeader = row({
      I: "INR",
      J: "Project Name",
      K: "County",
      L: "Projected COD",
      M: "IA Signed",
      N: "Fuel",
      O: "Technology",
      P: "Capacity (MW)",
      Q: "Year",
      R: "Financial Security",
    });
    workbook.set(
      name,
      new Map([
        [1, projectHeader],
        [2, row(header)],
        [3, row(values)],
      ]),
    );
  }
  return workbook;
}

Deno.test("capacity trend preserves official total and absent-vs-zero columns", () => {
  const result = aggregateCapacityTrendWorkbooks(trendWorkbook(false), trendWorkbook(true));
  assert(result.length === 5);
  assert(result[0]!.annual[0]!.official_total_mw === 15);
  assert(result[0]!.annual[0]!.other_planned_mw === 1);
  assert(result[0]!.planned_monthly[0]!.other_planned_mw === null);
  assert(result[4]!.planned_monthly[0]!.other_planned_mw === 1);
  assert(result[0]!.planned_monthly[0]!.month === "2026-07");
});

Deno.test("one source failure is reported while the other still ingests", async () => {
  const ingested: string[] = [];
  const failed: string[] = [];
  let thrown = false;
  try {
    await runLongHorizonProducts({
      collectGis: () => Promise.reject(new Error("fetch_failed")),
      collectTrend: () => Promise.resolve({ stream: "resource_capacity_trend" }),
      ingest: (payload) => {
        ingested.push(String(payload.stream));
        return Promise.resolve();
      },
      reportFailure: (stream) => {
        failed.push(stream);
        return Promise.resolve();
      },
    });
  } catch {
    thrown = true;
  }
  assert(thrown);
  assert(JSON.stringify(ingested) === JSON.stringify(["resource_capacity_trend"]));
  assert(JSON.stringify(failed) === JSON.stringify(["gis"]));
});

Deno.test("one receiver ingest failure does not suppress peer ingest", async () => {
  const attempts: string[] = [];
  const failures: string[] = [];
  try {
    await runLongHorizonProducts({
      collectGis: () => Promise.resolve({ stream: "gis" }),
      collectTrend: () => Promise.resolve({ stream: "resource_capacity_trend" }),
      ingest: (payload) => {
        attempts.push(String(payload.stream));
        return payload.stream === "gis"
          ? Promise.reject(new Error("receiver_down"))
          : Promise.resolve();
      },
      reportFailure: (stream) => {
        failures.push(stream);
        return Promise.resolve();
      },
    });
  } catch {
    // The cycle still reports failure after attempting every stream.
  }
  assert(JSON.stringify(attempts) === JSON.stringify(["gis", "resource_capacity_trend"]));
  assert(JSON.stringify(failures) === JSON.stringify(["gis"]));
});

Deno.test("receiver secret cannot be sent to arbitrary plaintext HTTP", async () => {
  let error = "";
  try {
    await runLongHorizonCycle("http://evil.example/api/texas-grid/ingest", "secret", 1_787_200_000);
  } catch (value) {
    error = value instanceof Error ? value.message : "unknown";
  }
  assert(error === "long_horizon_endpoint");
});

Deno.test("official full and abbreviated English source months normalize exactly", () => {
  assert(sourcePeriod("June", "2026") === "2026-06");
  assert(sourcePeriod("Jun", "2026") === "2026-06");
  let rejected = false;
  try {
    sourcePeriod("Jne", "2026");
  } catch {
    rejected = true;
  }
  assert(rejected);
});
