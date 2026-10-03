import { describe, expect, it } from "vitest";

import {
  MARKET_SERIES,
  parseMarketManifest,
  parseMarketResource,
  type MarketManifest,
  type MarketResourceLink,
  type MarketSeriesKey,
} from "./market-mechanics";

const NOW = 1_787_076_000;
const DAY = 1_787_011_200;
const VERSION_A = `mmr1-${"a".repeat(64)}`;
const VERSION_B = `mmr1-${"b".repeat(64)}`;

function productFor(key: MarketSeriesKey): [string, string] {
  if (key === "market.sced.system-lambda") return ["ercot_mis_np6_322", "NP6-322-CD"];
  if (key.includes("price-adder") || key.includes("adder-input")) {
    return ["ercot_mis_np6_323", "NP6-323-CD"];
  }
  if (key.includes("as-capability")) return ["ercot_mis_np6_328", "NP6-328-CD"];
  return ["ercot_mis_np6_332", "NP6-332-CD"];
}

function source(key: MarketSeriesKey) {
  const [sourceId, productId] = productFor(key);
  return {
    source_id: sourceId,
    product_id: productId,
    vintage_key: `mm1-${"c".repeat(64)}`,
    document_id: "123456789",
    issued_at: NOW - 60,
    raw_publish_datetime: "2026-08-18T12:59:00-05:00",
    raw_sced_timestamp: "08/18/2026 12:58:58",
    repeated_hour_flag: false,
  };
}

function health(sourceId: string) {
  return {
    source_id: sourceId,
    state: "healthy",
    collection_state: "healthy",
    freshness_state: "fresh",
    availability_status: "available",
    expected_interval_seconds: 300,
    last_attempt_ts: NOW,
    last_success_ts: NOW,
    source_timestamp_ts: NOW - 60,
    data_timestamp_ts: NOW - 62,
    collection_age_seconds: 0,
    data_age_seconds: 62,
    consecutive_failures: 0,
    gap_count: 0,
    last_error: null,
  };
}

function link(key: MarketSeriesKey, version = VERSION_A): MarketResourceLink {
  return {
    series_key: key,
    tile_start: DAY,
    content_version: version,
    lod: "native",
    url: `/api/v2/market-mechanics/${key}/v1/${version}/1d/${DAY}/native`,
  };
}

function manifest(current = false) {
  const readings = Object.fromEntries(
    (Object.keys(MARKET_SERIES) as MarketSeriesKey[]).map((key, index) => [
      key,
      { value: index, unit: MARKET_SERIES[key], source: source(key) },
    ]),
  );
  return {
    schema_version: 1,
    kind: "market_mechanics_manifest",
    methodology: "market-context-v1",
    explanation_policy: "time_adjacent_context_not_causal_decomposition",
    current: current
      ? {
          target_ts: NOW - 62,
          alignment: "exact_same_sced_timestamp",
          readings,
          sources: {},
          lambda_parity: {
            state: "match",
            np6_322_value: 10,
            np6_323_value: 10,
            delta: 0,
            tolerance: 0.00005,
            unit: "$/MWh",
          },
        }
      : null,
    previous: null,
    changes: current
      ? Object.fromEntries(
          (Object.keys(MARKET_SERIES) as MarketSeriesKey[]).map((key) => [
            key,
            { delta: null, unit: MARKET_SERIES[key] },
          ]),
        )
      : {},
    elapsed_seconds: null,
    source_health: [
      health("ercot_mis_np6_322"),
      health("ercot_mis_np6_323"),
      health("ercot_mis_np6_328"),
      health("ercot_mis_np6_332"),
    ],
    materialization_health: {
      state: "healthy",
      last_attempt_ts: NOW,
      last_success_ts: NOW,
      consecutive_failures: 0,
      last_error: null,
    },
    resources: [] as Array<Record<string, unknown>>,
  };
}

describe("market mechanics independent wire acceptance", () => {
  it("accepts exact valid-empty and exact same-SCED current manifests", () => {
    expect(parseMarketManifest(manifest())).toMatchObject({ current: null, resources: [] });
    expect(Object.keys(parseMarketManifest(manifest(true)).current!.readings)).toHaveLength(31);
  });

  it("requires exact bounded deltas from the immediately prior coherent SCED snapshot", () => {
    const value = manifest(true) as unknown as {
      current: NonNullable<MarketManifest["current"]>;
      previous: MarketManifest["previous"];
      changes: MarketManifest["changes"];
      elapsed_seconds: number | null;
    };
    value.previous = structuredClone(value.current);
    value.previous!.target_ts -= 300;
    for (const key of Object.keys(MARKET_SERIES) as MarketSeriesKey[]) {
      value.previous!.readings[key]!.value -= 1;
      value.previous!.readings[key]!.source.raw_sced_timestamp = "08/18/2026 12:53:58";
      value.changes[key] = { delta: 1, unit: MARKET_SERIES[key] };
    }
    value.elapsed_seconds = 300;
    const parsed = parseMarketManifest(value);
    expect(parsed.elapsed_seconds).toBe(300);
    expect(parsed.changes["market.sced.system-lambda"]).toEqual({
      delta: 1,
      unit: "$/MWh",
    });

    value.changes["market.sced.system-lambda"]!.delta = 1.01;
    expect(() => parseMarketManifest(value)).toThrow();
    value.changes["market.sced.system-lambda"]!.delta = 1;
    value.elapsed_seconds = 301;
    expect(() => parseMarketManifest(value)).toThrow();
  });

  it("rejects wrong or duplicate source-health identities and malformed materialization health", () => {
    const wrong = manifest();
    wrong.source_health[0]!.source_id = "ercot_mis_np6_999";
    expect(() => parseMarketManifest(wrong)).toThrow();

    const duplicate = manifest();
    duplicate.source_health[1]!.source_id = "ercot_mis_np6_322";
    expect(() => parseMarketManifest(duplicate)).toThrow();

    const malformed = manifest();
    (
      malformed as unknown as { materialization_health: Record<string, unknown> }
    ).materialization_health = {
      state: "healthy",
      last_attempt_ts: NOW,
      last_success_ts: null,
      consecutive_failures: -1,
      last_error: "secret-shaped arbitrary error",
    };
    expect(() => parseMarketManifest(malformed)).toThrow();
  });

  it("binds every scalar reading to its exact official source and product", () => {
    for (const key of Object.keys(MARKET_SERIES) as MarketSeriesKey[]) {
      const wrong = manifest(true);
      const reading = (
        wrong.current!.readings as unknown as Record<string, { source: ReturnType<typeof source> }>
      )[key]!;
      reading.source = source("market.sced.system-lambda");
      if (key === "market.sced.system-lambda") {
        reading.source = source("market.sced.price-adder.energy");
      }
      expect(() => parseMarketManifest(wrong), key).toThrow();
    }
  });

  it("binds official PublishDate and raw Chicago SCED time to normalized epochs", () => {
    const wrongPublish = manifest(true);
    wrongPublish.current!.readings["market.sced.system-lambda"]!.source.issued_at += 1;
    expect(() => parseMarketManifest(wrongPublish)).toThrow("invalid_market_mechanics_source_time");

    const wrongTarget = manifest(true);
    wrongTarget.current!.readings["market.sced.system-lambda"]!.source.raw_sced_timestamp =
      "08/18/2026 12:58:57";
    expect(() => parseMarketManifest(wrongTarget)).toThrow("invalid_market_mechanics_source_time");

    const wrongFold = manifest(true);
    wrongFold.current!.readings["market.sced.system-lambda"]!.source.repeated_hour_flag = true;
    expect(() => parseMarketManifest(wrongFold)).toThrow("invalid_market_mechanics_source_time");
  });

  it("keeps the repeated Chicago SCED hour as two distinct UTC instants", () => {
    for (const [target, repeated, publish] of [
      [1_762_065_000, false, "2025-11-02T01:30:02-05:00"],
      [1_762_068_600, true, "2025-11-02T01:30:02-06:00"],
    ] as const) {
      const value = manifest(true);
      value.current!.target_ts = target;
      for (const key of Object.keys(MARKET_SERIES) as MarketSeriesKey[]) {
        const item = value.current!.readings[key]!.source;
        item.issued_at = target + 2;
        item.raw_publish_datetime = publish;
        item.raw_sced_timestamp = "11/02/2025 01:30:00";
        item.repeated_hour_flag = repeated;
      }
      expect(parseMarketManifest(value).current?.target_ts).toBe(target);
    }
  });

  it("rejects duplicate, noncanonical, and out-of-order resource links", () => {
    const first = link("market.sced.as-capability.ecrs");
    const second = link("market.sced.system-lambda", VERSION_B);

    const duplicate = manifest();
    duplicate.resources = [first, first];
    expect(() => parseMarketManifest(duplicate)).toThrow();

    const unordered = manifest();
    unordered.resources = [second, first];
    expect(() => parseMarketManifest(unordered)).toThrow();

    const query = manifest();
    query.resources = [{ ...first, url: `${first.url}?range=duplicate` }];
    expect(() => parseMarketManifest(query)).toThrow();
  });

  it("binds immutable resource provenance to its series family", () => {
    const resourceLink = link("market.sced.as-capability.ecrs");
    const payload = {
      schema_version: 1,
      methodology: "market-context-v1",
      series_key: resourceLink.series_key,
      content_version: resourceLink.content_version,
      tile_span: "1d",
      tile_start: DAY,
      tile_end: DAY + 86_400,
      lod: "native",
      unit: "MW",
      source: { product_id: "NP6-328-CD", contributors: [] },
      rows: [{ target_ts: NOW - 62, value: 10, source: source(resourceLink.series_key) }],
    };
    expect(parseMarketResource(payload, resourceLink).rows).toHaveLength(1);
    payload.rows[0]!.source = source("market.sced.system-lambda");
    expect(() => parseMarketResource(payload, resourceLink)).toThrow();
  });

  it("never exposes decomposition or causal fields even when ignored input fields are present", () => {
    for (const field of [
      "calculated_price",
      "explained_price",
      "caused_by",
      "contribution_percent",
    ]) {
      const value = manifest(true) as ReturnType<typeof manifest> & Record<string, unknown>;
      value[field] = 1;
      const parsed = parseMarketManifest(value) as unknown as Record<string, unknown>;
      expect(parsed[field], field).toBeUndefined();
      expect(parsed["explanation_policy"]).toBe("time_adjacent_context_not_causal_decomposition");
    }
  });
});
