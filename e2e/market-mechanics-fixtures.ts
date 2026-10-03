import type { Page } from "@playwright/test";

const DAY = 1_787_011_200;
const NOW = DAY + 64_800;
const VERSION = `mmr1-${"a".repeat(64)}`;

const MARKET_SERIES = {
  "market.sced.system-lambda": "$/MWh",
  "market.sced.price-adder.energy": "$/MWh",
  "market.sced.price-adder.regup": "$/MW",
  "market.sced.price-adder.regdown": "$/MW",
  "market.sced.price-adder.rrs": "$/MW",
  "market.sced.price-adder.ecrs": "$/MW",
  "market.sced.price-adder.nonspin": "$/MW",
  "market.sced.adder-input.ruc-ldl-relaxed": "MW",
  "market.sced.adder-input.rmr-ldl-relaxed": "MW",
  "market.sced.adder-input.deployed-load-resource": "MW",
  "market.sced.adder-input.deployed-ers": "MW",
  "market.sced.adder-input.dc-tie-import": "MW",
  "market.sced.adder-input.dc-tie-export": "MW",
  "market.sced.adder-input.rtblt-import": "MW",
  "market.sced.adder-input.rtblt-export": "MW",
  "market.sced.adder-input.online-lsl": "MW",
  "market.sced.adder-input.online-hsl": "MW",
  "market.sced.adder-input.rtdll": "MW",
  "market.sced.as-capability.regup": "MW",
  "market.sced.as-capability.regdown": "MW",
  "market.sced.as-capability.rrs": "MW",
  "market.sced.as-capability.ecrs": "MW",
  "market.sced.as-capability.nonspin": "MW",
  "market.sced.as-capability.regup-rrs": "MW",
  "market.sced.as-capability.regup-rrs-ecrs": "MW",
  "market.sced.as-capability.regup-rrs-ecrs-nonspin": "MW",
  "market.sced.as-mcpc.ecrs": "$/MW",
  "market.sced.as-mcpc.nonspin": "$/MW",
  "market.sced.as-mcpc.regdown": "$/MW",
  "market.sced.as-mcpc.regup": "$/MW",
  "market.sced.as-mcpc.rrs": "$/MW",
} as const;
type SeriesKey = keyof typeof MARKET_SERIES;

function productFor(key: SeriesKey): [string, string] {
  if (key === "market.sced.system-lambda") return ["ercot_mis_np6_322", "NP6-322-CD"];
  if (key.includes("price-adder") || key.includes("adder-input")) {
    return ["ercot_mis_np6_323", "NP6-323-CD"];
  }
  if (key.includes("as-capability")) return ["ercot_mis_np6_328", "NP6-328-CD"];
  return ["ercot_mis_np6_332", "NP6-332-CD"];
}

function chicagoTimestamp(target: number) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(target * 1000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts["month"]}/${parts["day"]}/${parts["year"]} ${parts["hour"]}:${parts["minute"]}:${parts["second"]}`;
}

function source(key: SeriesKey, target: number) {
  const [sourceId, productId] = productFor(key);
  const issuedAt = target + 2;
  const publish = new Date((issuedAt - 5 * 3600) * 1000).toISOString().replace("Z", "-05:00");
  return {
    source_id: sourceId,
    product_id: productId,
    vintage_key: `mm1-${"b".repeat(64)}`,
    document_id: "123456789",
    issued_at: issuedAt,
    raw_publish_datetime: publish,
    raw_sced_timestamp: chicagoTimestamp(target),
    repeated_hour_flag: false,
  };
}

function snapshot(offset: number) {
  const target = NOW - 62 + offset * 300;
  const readings = Object.fromEntries(
    (Object.keys(MARKET_SERIES) as SeriesKey[]).map((key, index) => [
      key,
      { value: index + 10 + offset, unit: MARKET_SERIES[key], source: source(key, target) },
    ]),
  );
  return {
    target_ts: target,
    alignment: "exact_same_sced_timestamp",
    readings,
    sources: {},
    lambda_parity: {
      state: "match",
      np6_322_value: 10 + offset,
      np6_323_value: 10 + offset,
      delta: 0,
      tolerance: 0.00005,
      unit: "$/MWh",
    },
  };
}

export async function installMarketMechanicsApi(page: Page, requests: string[]) {
  await page.route("**/api/v1/market-mechanics", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    const current = snapshot(0);
    const previous = snapshot(-1);
    return route.fulfill({
      json: {
        schema_version: 1,
        kind: "market_mechanics_manifest",
        methodology: "market-context-v1",
        explanation_policy: "time_adjacent_context_not_causal_decomposition",
        deferred_products: ["NP6-331-CD", "NP6-86-CD"],
        factors: {},
        current,
        previous,
        changes: Object.fromEntries(
          (Object.keys(MARKET_SERIES) as SeriesKey[]).map((key) => [
            key,
            { delta: 1, unit: MARKET_SERIES[key] },
          ]),
        ),
        elapsed_seconds: 300,
        source_health: [
          ["ercot_mis_np6_322", "healthy", NOW - 62],
          ["ercot_mis_np6_323", "stale", NOW - 662],
          ["ercot_mis_np6_328", "healthy", NOW - 62],
          ["ercot_mis_np6_332", "healthy", NOW - 62],
        ].map(([sourceId, state, observed]) => ({
          source_id: sourceId,
          state,
          data_timestamp_ts: observed,
          gap_count: 0,
          last_error: null,
        })),
        materialization_health: {
          state: "healthy",
          last_attempt_ts: NOW,
          last_success_ts: NOW,
          consecutive_failures: 0,
          last_error: null,
        },
        latest: {},
        resources: ["market.sced.price-adder.regup", "market.sced.system-lambda"].map(
          (seriesKey) => ({
            series_key: seriesKey,
            tile_start: DAY,
            content_version: VERSION,
            lod: "native",
            url: `/api/v2/market-mechanics/${seriesKey}/v1/${VERSION}/1d/${DAY}/native`,
          }),
        ),
      },
    });
  });

  await page.route("**/api/v2/market-mechanics/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    const match =
      /^\/api\/v2\/market-mechanics\/(.+)\/v1\/mmr1-[0-9a-f]{64}\/1d\/(\d+)\/native$/.exec(
        url.pathname,
      );
    if (!match) return route.fulfill({ status: 404, json: { error: "not_found" } });
    const seriesKey = match[1] as SeriesKey;
    return route.fulfill({
      json: {
        schema_version: 1,
        methodology: "market-context-v1",
        series_key: seriesKey,
        content_version: VERSION,
        tile_span: "1d",
        tile_start: DAY,
        tile_end: DAY + 86_400,
        lod: "native",
        unit: MARKET_SERIES[seriesKey],
        source: { product_id: productFor(seriesKey)[1], contributors: [] },
        rows: [60, 360, 1260, 1560].map((seconds, index) => ({
          target_ts: DAY + seconds,
          value: 10 + index,
          source: source(seriesKey, DAY + seconds),
        })),
      },
    });
  });
}
