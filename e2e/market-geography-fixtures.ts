import type { Page } from "@playwright/test";

const DAY = Date.parse("2026-08-19T00:00:00Z") / 1_000;
const PRICE_TARGET = Date.parse("2026-08-20T17:15:00Z") / 1_000;
const SCED_TARGET = Date.parse("2026-08-20T17:40:18Z") / 1_000;
const VERSION = `mgr1-${"a".repeat(64)}`;
export const MARKET_GEOGRAPHY_CONSTRAINT = "a".repeat(24);

const POINTS = [
  ["HB_HOUSTON", "HU"],
  ["HB_NORTH", "HU"],
  ["HB_PAN", "HU"],
  ["HB_SOUTH", "HU"],
  ["HB_WEST", "HU"],
  ["LZ_AEN", "LZ"],
  ["LZ_CPS", "LZ"],
  ["LZ_HOUSTON", "LZ"],
  ["LZ_LCRA", "LZ"],
  ["LZ_NORTH", "LZ"],
  ["LZ_RAYBN", "LZ"],
  ["LZ_SOUTH", "LZ"],
  ["LZ_WEST", "LZ"],
  ["HB_BUSAVG", "SH"],
  ["HB_HUBAVG", "AH"],
] as const;

function source(product: "NP6-788-CD" | "NP6-905-CD" | "NP6-86-CD") {
  return {
    source_id: {
      "NP6-788-CD": "ercot_mis_np6_788",
      "NP6-905-CD": "ercot_mis_np6_905",
      "NP6-86-CD": "ercot_mis_np6_86",
    }[product],
    product_id: product,
    content_key: `mgp1-${"b".repeat(64)}`,
    document_id: "123456789",
    issued_at: 1_777_008_400,
    retrieved_at: 1_777_008_430,
    raw_publish_datetime: "2026-04-24T00:26:40-05:00",
  };
}

function priceRows() {
  return POINTS.map(([settlement_point, settlement_point_type], index) => ({
    target_ts: PRICE_TARGET,
    raw_delivery_date: "08/20/2026",
    delivery_hour: 13,
    delivery_interval: 1,
    raw_dst_flag: "N",
    repeated_hour_flag: false,
    settlement_point,
    settlement_point_type,
    value: [-42.16, 18, 35, 62, 145, 28, 31, 58, 44, 92, 38, 73, 225, 51, 64][index],
    unit: "$/MWh",
  }));
}

function constraintRow() {
  return {
    constraint_key: MARKET_GEOGRAPHY_CONSTRAINT,
    constraint_id: "101",
    constraint_name: "North transfer constraint",
    contingency_name: "Loss of parallel North line",
    shadow_price: 125,
    max_shadow_price: 200,
    limit_mw: 1_000,
    value_mw: 995,
    violated_mw: 0,
    from_station: "NORTH A",
    to_station: "NORTH B",
    from_station_kv: 345,
    to_station_kv: 345,
    cct_status: "COMP",
    cct_status_label: "competitive",
    raw_sced_timestamp: "08/20/2026 12:40:18",
    repeated_hour_flag: false,
    target_ts: SCED_TARGET,
  };
}

function chicagoRaw(target: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(target * 1_000));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${value("month")}/${value("day")}/${value("year")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function resourceLink(kind: "prices" | "constraints", identity: string) {
  return {
    kind,
    identity,
    tile_start: DAY,
    content_version: VERSION,
    lod: "native",
    url: `/api/v2/market-geography/${kind}/${identity}/v1/${VERSION}/1d/${DAY}/native`,
  };
}

export async function installMarketGeographyApi(
  page: Page,
  requests: string[],
  options: {
    gapCount?: number;
    historyError?: boolean;
    manifestError?: boolean;
    partial?: boolean;
    stale?: boolean;
  } = {},
) {
  await page.route("**/api/v1/market-geography", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    if (options.manifestError) {
      return route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    }
    const prices = priceRows();
    const visible = options.partial
      ? prices.filter(
          (row) => !(row.settlement_point === "LZ_WEST" && row.settlement_point_type === "LZ"),
        )
      : prices;
    return route.fulfill({
      json: {
        schema_version: 1,
        kind: "market_geography_manifest",
        methodology: "market-geography-v1",
        as_of: PRICE_TARGET + 60,
        visualization_policy: "settlement_price_matrix_not_geographic_boundaries",
        attribution_status: "unavailable_without_shift_factors",
        attribution_policy: "coincident_constraint_not_point_price_attribution",
        settlement_interval: {
          state: options.partial ? "partial" : "available",
          target_ts: PRICE_TARGET,
          source: source("NP6-905-CD"),
          rows: visible.filter((row) => !["SH", "AH"].includes(row.settlement_point_type)),
          reference_prices: visible.filter((row) =>
            ["SH", "AH"].includes(row.settlement_point_type),
          ),
          missing: options.partial ? ["LZ_WEST--LZ"] : [],
          coherence: "single_np6_905_publication_interval",
        },
        lmp_snapshot: {
          state: "available",
          target_ts: SCED_TARGET,
          source: source("NP6-788-CD"),
          rows: POINTS.map(([settlement_point], index) => ({
            target_ts: SCED_TARGET,
            raw_sced_timestamp: "08/20/2026 12:40:18",
            repeated_hour_flag: false,
            settlement_point,
            value: index,
            unit: "$/MWh",
          })),
          missing: [],
          coherence: "single_np6_788_publication_sced",
        },
        constraints: {
          state: "available",
          target_ts: SCED_TARGET,
          source: source("NP6-86-CD"),
          rows: [constraintRow()],
          total_count: 1,
          truncated: false,
          alignment: "exact_same_sced_as_lmp_snapshot",
          attribution_status: "unavailable_without_shift_factors",
          attribution_policy: "coincident_constraint_not_point_price_attribution",
        },
        source_health: ["ercot_mis_np6_788", "ercot_mis_np6_86", "ercot_mis_np6_905"].map(
          (source_id, index) => ({
            source_id,
            state:
              index === 2 && options.stale
                ? "stale"
                : index === 2 && options.gapCount
                  ? "delayed"
                  : "healthy",
            availability_status: "available",
            last_success_ts: PRICE_TARGET,
            data_timestamp_ts: PRICE_TARGET,
            data_age_seconds: options.stale && index === 2 ? 3_601 : 60,
            gap_count: index === 2 ? (options.gapCount ?? 0) : 0,
            consecutive_failures: 0,
            last_error: index === 2 && options.gapCount ? "document_gap" : null,
          }),
        ),
        materialization_health: {
          state: "healthy",
          last_attempt_ts: PRICE_TARGET,
          last_success_ts: PRICE_TARGET,
          consecutive_failures: 0,
          last_error: null,
        },
        resources: [
          resourceLink("constraints", MARKET_GEOGRAPHY_CONSTRAINT),
          resourceLink("prices", "HB_HOUSTON--HU"),
          resourceLink("prices", "LZ_WEST--LZ"),
        ],
        deferred: {
          nodal_map: "no_reviewed_node_geometry",
          constraint_lines: "no_reviewed_station_geometry",
        },
      },
    });
  });

  await page.route("**/api/v2/market-geography/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (options.historyError) {
      return route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    }
    const match =
      /^\/api\/v2\/market-geography\/(prices|constraints)\/([^/]+)\/v1\/mgr1-[0-9a-f]{64}\/1d\/(\d+)\/native$/.exec(
        url.pathname,
      );
    if (!match) return route.fulfill({ status: 404, json: { error: "not_found" } });
    const [, kind, identity] = match;
    const constraint = constraintRow();
    const intervals = [
      { seconds: 3_600, delivery_hour: 20, delivery_interval: 4 },
      { seconds: 4_500, delivery_hour: 21, delivery_interval: 1 },
      { seconds: 7_200, delivery_hour: 21, delivery_interval: 4 },
      { seconds: 8_100, delivery_hour: 22, delivery_interval: 1 },
    ];
    const rows = intervals.map(({ seconds, delivery_hour, delivery_interval }, index) =>
      kind === "prices"
        ? {
            target_ts: DAY + seconds,
            raw_delivery_date: "08/18/2026",
            delivery_hour,
            delivery_interval,
            raw_dst_flag: "N",
            repeated_hour_flag: false,
            settlement_point: identity!.split("--")[0],
            settlement_point_type: identity!.split("--")[1],
            value: index * 10 - 5,
            source: source("NP6-905-CD"),
          }
        : {
            ...constraint,
            target_ts: DAY + seconds,
            raw_sced_timestamp: chicagoRaw(DAY + seconds),
            source: source("NP6-86-CD"),
          },
    );
    return route.fulfill({
      json: {
        schema_version: 1,
        kind,
        identity,
        methodology: "market-geography-v1",
        tile_span: "1d",
        tile_start: DAY,
        tile_end: DAY + 86_400,
        lod: "native",
        unit: kind === "prices" ? "$/MWh" : "mixed_reviewed_fields",
        rows,
        ...(kind === "constraints"
          ? {
              attribution_status: "unavailable_without_shift_factors",
              attribution_policy: "coincident_constraint_not_point_price_attribution",
            }
          : {}),
        content_version: VERSION,
      },
    });
  });
}
