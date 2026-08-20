import { describe, expect, it } from "vitest";

import {
  MARKET_DISPLAY_POINTS,
  MARKET_PRICE_POINTS,
  MARKET_REFERENCE_POINTS,
  parseMarketGeographyManifest,
  parseMarketGeographyResource,
  type MarketGeographyLink,
} from "./market-geography";

const DAY = Date.parse("2026-08-19T00:00:00Z") / 1_000;
const PRICE_TARGET = Date.parse("2026-08-20T17:15:00Z") / 1_000;
const SCED_TARGET = Date.parse("2026-08-20T17:40:18Z") / 1_000;
const VERSION = `mgr1-${"a".repeat(64)}`;

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

function priceRow([point, pointType]: (typeof MARKET_DISPLAY_POINTS)[number], index: number) {
  return {
    target_ts: PRICE_TARGET,
    raw_delivery_date: "08/20/2026",
    delivery_hour: 13,
    delivery_interval: 1,
    raw_dst_flag: "N",
    repeated_hour_flag: false,
    settlement_point: point,
    settlement_point_type: pointType,
    value: -20 + index * 25,
    unit: "$/MWh",
  };
}

function lmpRow([point]: (typeof MARKET_DISPLAY_POINTS)[number], index: number) {
  return {
    target_ts: SCED_TARGET,
    raw_sced_timestamp: "08/20/2026 12:40:18",
    repeated_hour_flag: false,
    settlement_point: point,
    value: -10 + index * 10,
    unit: "$/MWh",
  };
}

function constraint(index: number) {
  return {
    constraint_key: String(index + 1).padStart(24, "a"),
    constraint_id: String(100 + index),
    constraint_name: `Constraint ${index}`,
    contingency_name: `Contingency ${index}`,
    shadow_price: 50 - index * 10,
    max_shadow_price: 75 - index * 10,
    limit_mw: 1_000 + index,
    value_mw: 990 + index,
    violated_mw: index,
    from_station: `FROM ${index}`,
    to_station: `TO ${index}`,
    from_station_kv: 345,
    to_station_kv: 345,
    cct_status: index % 2 ? "NONCOMP" : "COMP",
    cct_status_label: index % 2 ? "non-competitive" : "competitive",
    raw_sced_timestamp: "08/20/2026 12:40:18",
    repeated_hour_flag: false,
    target_ts: SCED_TARGET,
  };
}

function link(
  kind: "prices" | "lmp" | "constraints" = "prices",
  identity = "HB_HOUSTON--HU",
): MarketGeographyLink {
  return {
    kind,
    identity,
    tile_start: DAY,
    content_version: VERSION,
    lod: "native",
    url: `/api/v2/market-geography/${kind}/${identity}/v1/${VERSION}/1d/${DAY}/native`,
  };
}

function manifest() {
  const prices = MARKET_DISPLAY_POINTS.map(priceRow);
  const lmps = MARKET_DISPLAY_POINTS.map(lmpRow);
  return {
    schema_version: 1,
    kind: "market_geography_manifest",
    methodology: "market-geography-v1",
    as_of: 1_777_000_100,
    visualization_policy: "settlement_price_matrix_not_geographic_boundaries",
    attribution_status: "unavailable_without_shift_factors",
    attribution_policy: "coincident_constraint_not_point_price_attribution",
    settlement_interval: {
      state: "available",
      target_ts: PRICE_TARGET,
      source: source("NP6-905-CD"),
      rows: prices.filter((row) =>
        MARKET_PRICE_POINTS.some(
          ([point, pointType]) =>
            row.settlement_point === point && row.settlement_point_type === pointType,
        ),
      ),
      reference_prices: prices.filter((row) =>
        MARKET_REFERENCE_POINTS.some(
          ([point, pointType]) =>
            row.settlement_point === point && row.settlement_point_type === pointType,
        ),
      ),
      missing: [] as string[],
      coherence: "single_np6_905_publication_interval",
    },
    lmp_snapshot: {
      state: "available",
      target_ts: SCED_TARGET,
      source: source("NP6-788-CD"),
      rows: lmps,
      missing: [],
      coherence: "single_np6_788_publication_sced",
    },
    constraints: {
      state: "available",
      target_ts: SCED_TARGET,
      source: source("NP6-86-CD"),
      rows: [constraint(0), constraint(1)],
      total_count: 2,
      truncated: false,
      alignment: "exact_same_sced_as_lmp_snapshot",
      attribution_status: "unavailable_without_shift_factors",
      attribution_policy: "coincident_constraint_not_point_price_attribution",
    },
    source_health: ["ercot_mis_np6_788", "ercot_mis_np6_86", "ercot_mis_np6_905"].map(
      (source_id) => ({
        source_id,
        state: "healthy",
        availability_status: "available",
        last_success_ts: 1_777_000_000,
        data_timestamp_ts: 1_777_000_000,
        data_age_seconds: 100,
        gap_count: 0,
        consecutive_failures: 0,
        last_error: null,
      }),
    ),
    materialization_health: {
      state: "healthy",
      last_attempt_ts: 1_777_000_000,
      last_success_ts: 1_777_000_000,
      consecutive_failures: 0,
      last_error: null,
    },
    resources: [link()],
    deferred: {
      nodal_map: "no_reviewed_node_geometry",
      constraint_lines: "no_reviewed_station_geometry",
    },
  };
}

describe("PR15 market geography independent wire acceptance", () => {
  it("accepts exactly 13 matrix cells, two references, 15 LMPs, and exact-SCED constraints", () => {
    const parsed = parseMarketGeographyManifest(manifest());
    expect(parsed.settlement_interval.rows).toHaveLength(13);
    expect(parsed.settlement_interval.reference_prices).toHaveLength(2);
    expect(parsed.lmp_snapshot.rows).toHaveLength(15);
    expect(parsed.constraints.rows).toHaveLength(2);
    expect(new Set(parsed.constraints.rows.map((row) => row.target_ts))).toEqual(
      new Set([parsed.lmp_snapshot.target_ts]),
    );
  });

  it("requires truthful missing identities and never accepts an independently older fill", () => {
    const value = manifest();
    const removed = value.settlement_interval.rows.pop()!;
    value.settlement_interval.state = "partial";
    value.settlement_interval.missing = [
      `${removed.settlement_point}--${removed.settlement_point_type}`,
    ];
    expect(parseMarketGeographyManifest(value).settlement_interval.state).toBe("partial");

    value.settlement_interval.rows.push({ ...removed, target_ts: PRICE_TARGET - 900 });
    value.settlement_interval.missing = [];
    expect(() => parseMarketGeographyManifest(value)).toThrow();
  });

  it("rejects invented causal fields", () => {
    const causal = manifest() as ReturnType<typeof manifest> & { caused_by?: string };
    causal.caused_by = causal.constraints.rows[0]!.constraint_key;
    expect(() => parseMarketGeographyManifest(causal)).toThrow();
  });

  it("rejects settlement raw-time/target disagreement", () => {
    const wrongPriceTarget = manifest();
    wrongPriceTarget.settlement_interval.target_ts += 60;
    wrongPriceTarget.settlement_interval.rows.forEach((row) => (row.target_ts += 60));
    wrongPriceTarget.settlement_interval.reference_prices.forEach((row) => (row.target_ts += 60));
    expect(() => parseMarketGeographyManifest(wrongPriceTarget)).toThrow();
  });

  it("rejects SCED raw-time/target disagreement", () => {
    const wrongScedTarget = manifest();
    wrongScedTarget.lmp_snapshot.target_ts += 60;
    wrongScedTarget.lmp_snapshot.rows.forEach((row) => (row.target_ts += 60));
    wrongScedTarget.constraints.target_ts += 60;
    wrongScedTarget.constraints.rows.forEach((row) => (row.target_ts += 60));
    expect(() => parseMarketGeographyManifest(wrongScedTarget)).toThrow();
  });

  it("requires valid-empty constraints to be empty and bounded current rows to be exact SCED", () => {
    const value = manifest();
    value.constraints.state = "valid_empty";
    expect(() => parseMarketGeographyManifest(value)).toThrow();
    value.constraints.rows = [];
    value.constraints.total_count = 0;
    expect(parseMarketGeographyManifest(value).constraints.state).toBe("valid_empty");
  });

  it("accepts canonical completed-day resources and rejects identity or ordering drift", () => {
    const resourceLink = link();
    const rows = [
      {
        target_ts: DAY + 3_600,
        raw_delivery_date: "08/18/2026",
        delivery_hour: 20,
        delivery_interval: 1,
        raw_dst_flag: "N",
        repeated_hour_flag: false,
        settlement_point: "HB_HOUSTON",
        settlement_point_type: "HU",
        value: 10,
        source: source("NP6-905-CD"),
      },
      {
        target_ts: DAY + 4_500,
        raw_delivery_date: "08/18/2026",
        delivery_hour: 20,
        delivery_interval: 2,
        raw_dst_flag: "N",
        repeated_hour_flag: false,
        settlement_point: "HB_HOUSTON",
        settlement_point_type: "HU",
        value: 20,
        source: source("NP6-905-CD"),
      },
    ];
    const resource = {
      schema_version: 1,
      kind: "prices",
      identity: "HB_HOUSTON--HU",
      methodology: "market-geography-v1",
      tile_span: "1d",
      tile_start: DAY,
      tile_end: DAY + 86_400,
      lod: "native",
      unit: "$/MWh",
      rows,
      content_version: VERSION,
    };
    expect(parseMarketGeographyResource(resource, resourceLink).rows).toHaveLength(2);
    expect(() =>
      parseMarketGeographyResource({ ...resource, rows: [rows[1], rows[0]] }, resourceLink),
    ).toThrow();
    expect(() =>
      parseMarketGeographyResource({ ...resource, identity: "HB_NORTH--HU" }, resourceLink),
    ).toThrow();
  });
});
