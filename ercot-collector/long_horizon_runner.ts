import { fixedInterval } from "./deps.ts";
import {
  aggregateCapacityTrendWorkbooks,
  aggregateGisWorkbook,
  CAPACITY_SERIES_LABELS,
  GIS_FUEL_REGISTRY,
  GIS_PHASE_REGISTRY,
  parseXlsx,
  sha256Hex,
} from "./long_horizon.ts";

const GIS_LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId=15933";
const GIS_PAGE = "https://www.ercot.com/mp/data-products/data-product-details?id=pg7-200-er";
const TREND_PAGE = "https://www.ercot.com/gridinfo/resource";
const MONTHS = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

type Json = Record<string, unknown>;
function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error("long_horizon_download_failed");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    throw new Error("long_horizon_download_size");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximum) throw new Error("long_horizon_download_size");
  return bytes;
}
async function get(url: string, accept: string, maximum: number): Promise<Uint8Array> {
  return await bounded(
    await fetch(url, {
      headers: { Accept: accept },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }),
    maximum,
  );
}
export function sourcePeriod(month: string, year: string): string {
  const index = MONTHS.findIndex(
    (candidate) => candidate === month || candidate.slice(0, 3) === month,
  );
  const numericYear = Number(year);
  if (index < 0 || !Number.isInteger(numericYear) || numericYear < 1900 || numericYear > 2200)
    throw new Error("long_horizon_source_period");
  return `${numericYear}-${String(index + 1).padStart(2, "0")}`;
}
function documents(value: unknown, depth = 0): Json[] {
  if (depth > 12) throw new Error("long_horizon_list_depth");
  if (Array.isArray(value)) return value.flatMap((item) => documents(item, depth + 1));
  if (!object(value)) return [];
  const result = "DocID" in value ? [value] : [];
  for (const child of Object.values(value)) result.push(...documents(child, depth + 1));
  return result;
}
async function gisPayload(retrievedAt: number): Promise<Json> {
  const raw = await get(GIS_LIST, "application/json", 1024 * 1024);
  const listing = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const candidates = documents(listing).filter(
    (item) =>
      item.ReportTypeID === "15933" &&
      item.Extension === "xlsx" &&
      typeof item.FriendlyName === "string" &&
      item.FriendlyName.startsWith("GIS_Report_") &&
      typeof item.DocID === "string" &&
      /^\d+$/.test(item.DocID) &&
      typeof item.PublishDate === "string",
  );
  candidates.sort((a, b) => String(a.PublishDate).localeCompare(String(b.PublishDate)));
  const selected = candidates.at(-1);
  if (!selected) throw new Error("long_horizon_gis_unavailable");
  const name = /^GIS_Report_([A-Z][a-z]+)(\d{4})$/.exec(String(selected.FriendlyName));
  if (!name) throw new Error("long_horizon_gis_name");
  const publishedAt = Math.floor(Date.parse(String(selected.PublishDate)) / 1000);
  if (!Number.isInteger(publishedAt) || publishedAt <= 0 || publishedAt > retrievedAt)
    throw new Error("long_horizon_gis_clock");
  const workbook = await get(
    `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=${selected.DocID}`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    8 * 1024 * 1024,
  );
  const resolvedSourcePeriod = sourcePeriod(name[1]!, name[2]!);
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    stream: "gis",
    publication: {
      source_period: resolvedSourcePeriod,
      published_at: publishedAt,
      retrieved_at: retrievedAt,
      source_page_url: GIS_PAGE,
      workbooks: [{ kind: "gis", source_url: null, sha256: `sha256:${await sha256Hex(workbook)}` }],
    },
    resource: {
      unit: "MW",
      statistic: "project_count_and_source_capacity_sum",
      phases: GIS_PHASE_REGISTRY,
      fuels: GIS_FUEL_REGISTRY.map(({ code, label }) => ({ code, label })),
      aggregates: aggregateGisWorkbook(await parseXlsx(workbook), resolvedSourcePeriod),
      limits: { max_aggregates: 132 },
    },
  };
}
async function trendPayload(retrievedAt: number): Promise<Json> {
  const html = new TextDecoder("utf-8", { fatal: true }).decode(
    await get(TREND_PAGE, "text/html", 2 * 1024 * 1024),
  );
  const urls = [
    ...html.matchAll(
      /https:\/\/www\.ercot\.com\/files\/docs\/(\d{4})\/(\d{2})\/(\d{2})\/Capacity-Changes-by-Fuel-Type-Charts_([A-Z][a-z]+)_(\d{4})(_PlannedMonthly)?\.xlsx/g,
    ),
  ];
  const pairs = new Map<string, { annual?: string; monthly?: string; published?: number }>();
  for (const match of urls) {
    const resolvedSourcePeriod = sourcePeriod(match[4]!, match[5]!);
    const item = pairs.get(resolvedSourcePeriod) ?? {};
    const url = match[0];
    if (match[6]) item.monthly = url;
    else item.annual = url;
    item.published = Math.floor(Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) / 1000);
    pairs.set(resolvedSourcePeriod, item);
  }
  const selected = [...pairs]
    .filter(([, item]) => item.annual && item.monthly)
    .sort(([a], [b]) => a.localeCompare(b))
    .at(-1);
  if (!selected) throw new Error("long_horizon_trend_unavailable");
  const [selectedPeriod, links] = selected;
  if (!links.published || links.published > retrievedAt)
    throw new Error("long_horizon_trend_clock");
  const [annual, monthly] = await Promise.all([
    get(
      links.annual!,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      2 * 1024 * 1024,
    ),
    get(
      links.monthly!,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      2 * 1024 * 1024,
    ),
  ]);
  const series = aggregateCapacityTrendWorkbooks(
    await parseXlsx(annual),
    await parseXlsx(monthly),
  ).map((item) => ({ ...item, label: CAPACITY_SERIES_LABELS.get(item.series_id)! }));
  return {
    schema: 1,
    kind: "texas_grid_long_horizon",
    stream: "resource_capacity_trend",
    publication: {
      source_period: selectedPeriod,
      published_at: links.published,
      retrieved_at: retrievedAt,
      source_page_url: TREND_PAGE,
      workbooks: [
        { kind: "annual", source_url: links.annual, sha256: `sha256:${await sha256Hex(annual)}` },
        {
          kind: "planned_monthly",
          source_url: links.monthly,
          sha256: `sha256:${await sha256Hex(monthly)}`,
        },
      ],
    },
    resource: {
      unit: "MW",
      series,
      limits: { max_annual_rows_per_series: 100, max_planned_monthly_rows_per_series: 120 },
    },
  };
}
async function ingest(endpoint: string, apiKey: string, payload: Json): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = JSON.parse(new TextDecoder().decode(await bounded(response, 64 * 1024)));
  if (
    !object(result) ||
    !["inserted", "unchanged", "ignored_older"].includes(String(result.status)) ||
    !/^tg1-[0-9a-f]{64}$/.test(String(result.content_version))
  )
    throw new Error("long_horizon_receiver_response");
}
async function reportFailure(
  endpoint: string,
  apiKey: string,
  stream: "gis" | "resource_capacity_trend",
  attemptedAt: number,
): Promise<void> {
  const url = new URL(endpoint);
  url.pathname = "/api/texas-grid/source-attempt";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({
      schema: 1,
      stream,
      status: "failed",
      attempted_at: attemptedAt,
      error: "official_source_fetch_or_parse_failed",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const result = JSON.parse(new TextDecoder().decode(await bounded(response, 64 * 1024)));
  if (
    !object(result) ||
    !["recorded", "ignored_older", "unchanged"].includes(String(result.status)) ||
    result.stream !== stream
  )
    throw new Error("long_horizon_attempt_response");
}
export type LongHorizonCycleDependencies = Readonly<{
  collectGis: () => Promise<Json>;
  collectTrend: () => Promise<Json>;
  ingest: (payload: Json) => Promise<void>;
  reportFailure: (stream: "gis" | "resource_capacity_trend") => Promise<void>;
}>;
export async function runLongHorizonProducts(
  dependencies: LongHorizonCycleDependencies,
): Promise<void> {
  const results = await Promise.allSettled([
    dependencies.collectGis(),
    dependencies.collectTrend(),
  ]);
  const failures: unknown[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    if (result.status === "fulfilled") {
      try {
        await dependencies.ingest(result.value);
      } catch (error) {
        const stream = index === 0 ? "gis" : "resource_capacity_trend";
        try {
          await dependencies.reportFailure(stream);
        } catch (reportError) {
          failures.push(reportError);
        }
        failures.push(error);
      }
    } else {
      const stream = index === 0 ? "gis" : "resource_capacity_trend";
      try {
        await dependencies.reportFailure(stream);
      } catch (error) {
        failures.push(error);
      }
      failures.push(result.reason);
    }
  }
  if (failures.length) throw failures[0];
}
export async function runLongHorizonCycle(
  endpoint: string,
  apiKey: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!apiKey) throw new Error("long_horizon_api_key");
  const url = new URL(endpoint);
  const localHttpHosts = new Set(["receiver", "localhost", "127.0.0.1", "[::1]"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (url.protocol === "http:" && !localHttpHosts.has(url.hostname)) ||
    url.username ||
    url.password ||
    url.pathname !== "/api/texas-grid/ingest" ||
    url.search ||
    url.hash
  )
    throw new Error("long_horizon_endpoint");
  await runLongHorizonProducts({
    collectGis: () => gisPayload(now),
    collectTrend: () => trendPayload(now),
    ingest: (payload) => ingest(endpoint, apiKey, payload),
    reportFailure: (stream) => reportFailure(endpoint, apiKey, stream, now),
  });
}
export async function startLongHorizon(): Promise<never> {
  if (Deno.env.get("ERCOT_LONG_HORIZON_INGEST_ENABLED") !== "true")
    return await new Promise<never>(() => {});
  const endpoint =
    Deno.env.get("ERCOT_LONG_HORIZON_ENDPOINT") ?? "http://receiver:8080/api/texas-grid/ingest";
  const apiKey = Deno.env.get("METRICS_API_KEY") ?? "";
  for await (const _ of fixedInterval(6 * 60 * 60 * 1000)) {
    try {
      await runLongHorizonCycle(endpoint, apiKey);
    } catch (error) {
      console.error(
        "long_horizon_cycle_failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
  }
  throw new Error("unreachable");
}
