export type TileLod = "native" | "5m" | "15m" | "1h";
export type TileSpan = "1h" | "1d";

export type TileCatalogSeries = {
  key: string;
  match: "exact" | "selector";
  metric: string;
  native_interval_seconds: number;
  rollup: null | "sum";
  source: string;
  statistic_policy: "gauge" | "power";
  supported_lods: TileLod[];
  tags: string[];
  unit: string;
};

export type TileCatalogDerivedResource =
  | {
      alignment: "utc_day";
      formula: "demand_mw - wind_mw - solar_mw";
      native_interval_seconds: 300;
      official_ercot_net_load: false;
      route_template: "/api/v2/net-load/{series_key}/v1/{content_version}/1d/{utc_day_start}/native";
      series_key: "net-load.actual";
      storage_policy: "context_only_not_in_formula";
      supported_lods: ["native"];
    }
  | {
      alignment: "utc_day";
      formula: "demand_mw - wind_mw - solar_mw";
      native_interval_seconds: 3600;
      official_ercot_net_load: false;
      route_template: "/api/v2/net-load/{series_key}/v1/{content_version}/1d/{utc_day_start}/native";
      selection_policy: "coherent_whole_curve_latest_capped_before_utc_day";
      series_key: `net-load.forecast.latest-capped-${"1h" | "6h" | "24h"}-before-utc-day`;
      snapshot_lead_seconds: 3600 | 21600 | 86400;
      supported_lods: ["native"];
    }
  | {
      alignment: "utc_day";
      diagnostic_error_formula: null | "actual_minus_forecast";
      native_interval_seconds: 3600;
      route_template: "/api/v2/regional/{series_key}/v1/{content_version}/1d/{utc_day_start}/native";
      selection_policy: "latest_actual_per_target" | "latest-capped-1h-before-utc-day";
      series_key: `regional.load.weather-zone.${string}.${"actual" | "forecast"}`;
      supported_lods: ["native"];
      taxonomy: "load_weather_zone";
    }
  | {
      alignment: "utc_day";
      current_measure: "GEN";
      forecast_basis: "HSL_potential";
      forecast_error_available: false;
      forecast_measure: "STWPF" | "STPPF";
      native_interval_seconds: 3600;
      route_template: "/api/v2/regional/{series_key}/v1/{content_version}/1d/{utc_day_start}/native";
      series_key: `regional.${"wind" | "solar"}.${string}.hourly`;
      supported_lods: ["native"];
      taxonomy: "wind_region" | "solar_region";
    };

export type TileCatalog = {
  boundary_policy: {
    coarse_partial_clipping: false;
    edge_lod: "native";
    rule: string;
  };
  derived_resources: TileCatalogDerivedResource[];
  lod_seconds: Record<TileLod, number | null>;
  schema: 2;
  series: TileCatalogSeries[];
  tile_spans: Record<TileSpan, number>;
};

export type TileRequest = {
  lod: TileLod;
  seriesKey: string;
  tileEnd: number;
  tileSpan: TileSpan;
  tileStart: number;
  url: string;
};

type ConfigSeriesIdentity = {
  metric: string;
  rollup?: "sum";
  statisticPolicy: "gauge" | "power";
  tags?: readonly string[];
  unit: string;
};

const HOUR = 3_600;
const DAY = 86_400;

function normalizedTags(tags: readonly string[] | undefined): string[] {
  return [...new Set(tags ?? [])].sort();
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

type DerivedResourceCandidate = {
  [key: string]: unknown;
  alignment?: unknown;
  current_measure?: unknown;
  diagnostic_error_formula?: unknown;
  forecast_basis?: unknown;
  forecast_error_available?: unknown;
  forecast_measure?: unknown;
  formula?: unknown;
  native_interval_seconds?: unknown;
  official_ercot_net_load?: unknown;
  route_template?: unknown;
  selection_policy?: unknown;
  series_key?: unknown;
  snapshot_lead_seconds?: unknown;
  storage_policy?: unknown;
  supported_lods?: unknown;
  taxonomy?: unknown;
};

function validDerivedResource(value: unknown): value is TileCatalogDerivedResource {
  if (!value || typeof value !== "object") return false;
  const entry = value as DerivedResourceCandidate;
  const common =
    entry.alignment === "utc_day" &&
    entry.supported_lods instanceof Array &&
    entry.supported_lods.length === 1 &&
    entry.supported_lods[0] === "native";
  if (!common) return false;
  if (entry.series_key === "net-load.actual") {
    return (
      exactKeys(entry, [
        "alignment",
        "formula",
        "native_interval_seconds",
        "official_ercot_net_load",
        "route_template",
        "series_key",
        "storage_policy",
        "supported_lods",
      ]) &&
      entry.route_template ===
        "/api/v2/net-load/{series_key}/v1/{content_version}/1d/{utc_day_start}/native" &&
      entry.native_interval_seconds === 300 &&
      entry.formula === "demand_mw - wind_mw - solar_mw" &&
      entry.storage_policy === "context_only_not_in_formula" &&
      entry.official_ercot_net_load === false
    );
  }
  if (typeof entry.series_key === "string" && entry.series_key.startsWith("net-load.forecast.")) {
    const leads = new Map([
      ["net-load.forecast.latest-capped-1h-before-utc-day", 3600],
      ["net-load.forecast.latest-capped-6h-before-utc-day", 21600],
      ["net-load.forecast.latest-capped-24h-before-utc-day", 86400],
    ]);
    return (
      exactKeys(entry, [
        "alignment",
        "formula",
        "native_interval_seconds",
        "official_ercot_net_load",
        "route_template",
        "selection_policy",
        "series_key",
        "snapshot_lead_seconds",
        "supported_lods",
      ]) &&
      entry.route_template ===
        "/api/v2/net-load/{series_key}/v1/{content_version}/1d/{utc_day_start}/native" &&
      entry.native_interval_seconds === 3600 &&
      entry.formula === "demand_mw - wind_mw - solar_mw" &&
      entry.selection_policy === "coherent_whole_curve_latest_capped_before_utc_day" &&
      entry.official_ercot_net_load === false &&
      leads.get(entry.series_key) === entry.snapshot_lead_seconds
    );
  }
  if (typeof entry.series_key !== "string" || !entry.series_key.startsWith("regional.")) {
    return false;
  }
  const regionalCommon =
    entry.route_template ===
      "/api/v2/regional/{series_key}/v1/{content_version}/1d/{utc_day_start}/native" &&
    entry.native_interval_seconds === 3600;
  if (entry.taxonomy === "load_weather_zone") {
    const match =
      /^regional\.load\.weather-zone\.(coast|east|far-west|north|north-central|south-central|southern|west)\.(actual|forecast)$/.exec(
        entry.series_key,
      );
    const kind = match?.[2];
    return (
      exactKeys(entry, [
        "alignment",
        "diagnostic_error_formula",
        "native_interval_seconds",
        "route_template",
        "selection_policy",
        "series_key",
        "supported_lods",
        "taxonomy",
      ]) &&
      regionalCommon &&
      ((kind === "actual" &&
        entry.selection_policy === "latest_actual_per_target" &&
        entry.diagnostic_error_formula === null) ||
        (kind === "forecast" &&
          entry.selection_policy === "latest-capped-1h-before-utc-day" &&
          entry.diagnostic_error_formula === "actual_minus_forecast"))
    );
  }
  const match = /^regional\.(wind|solar)\.([a-z-]+)\.hourly$/.exec(entry.series_key);
  const resource = match?.[1];
  const region = match?.[2];
  const validRegion =
    resource === "wind"
      ? ["panhandle", "coastal", "south", "west", "north"].includes(region ?? "")
      : resource === "solar" &&
        ["center-west", "north-west", "far-west", "far-east", "south-east", "center-east"].includes(
          region ?? "",
        );
  return (
    exactKeys(entry, [
      "alignment",
      "current_measure",
      "forecast_basis",
      "forecast_error_available",
      "forecast_measure",
      "native_interval_seconds",
      "route_template",
      "series_key",
      "supported_lods",
      "taxonomy",
    ]) &&
    regionalCommon &&
    validRegion &&
    entry.current_measure === "GEN" &&
    entry.forecast_basis === "HSL_potential" &&
    entry.forecast_error_available === false &&
    entry.taxonomy === `${resource}_region` &&
    entry.forecast_measure === (resource === "wind" ? "STWPF" : "STPPF")
  );
}

export function parseTileCatalog(value: unknown): TileCatalog {
  if (!value || typeof value !== "object") throw new Error("invalid_tile_catalog");
  const catalog = value as Partial<TileCatalog>;
  if (
    Object.keys(value).sort().join(",") !==
      "boundary_policy,derived_resources,lod_seconds,schema,series,tile_spans" ||
    catalog.schema !== 2 ||
    catalog.tile_spans?.["1h"] !== HOUR ||
    catalog.tile_spans?.["1d"] !== DAY ||
    catalog.lod_seconds?.native !== null ||
    catalog.lod_seconds?.["5m"] !== 300 ||
    catalog.lod_seconds?.["15m"] !== 900 ||
    catalog.lod_seconds?.["1h"] !== HOUR ||
    Object.keys(catalog.lod_seconds ?? {})
      .sort()
      .join(",") !== "15m,1h,5m,native" ||
    catalog.boundary_policy?.coarse_partial_clipping !== false ||
    catalog.boundary_policy.edge_lod !== "native" ||
    typeof catalog.boundary_policy.rule !== "string" ||
    Object.keys(catalog.boundary_policy).sort().join(",") !==
      "coarse_partial_clipping,edge_lod,rule" ||
    !Array.isArray(catalog.series) ||
    !Array.isArray(catalog.derived_resources)
  ) {
    throw new Error("invalid_tile_catalog");
  }
  const derivedKeys = new Set<string>();
  for (const resource of catalog.derived_resources) {
    if (!validDerivedResource(resource) || derivedKeys.has(resource.series_key)) {
      throw new Error("invalid_tile_catalog_derived_resource");
    }
    derivedKeys.add(resource.series_key);
  }
  const keys = new Set<string>();
  let priorKey = "";
  for (const entry of catalog.series) {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !==
        "key,match,metric,native_interval_seconds,rollup,source,statistic_policy,supported_lods,tags,unit" ||
      typeof entry.key !== "string" ||
      keys.has(entry.key) ||
      entry.key <= priorKey ||
      typeof entry.metric !== "string" ||
      !Number.isInteger(entry.native_interval_seconds) ||
      entry.native_interval_seconds <= 0 ||
      !Array.isArray(entry.tags) ||
      JSON.stringify(entry.tags) !== JSON.stringify(normalizedTags(entry.tags)) ||
      !Array.isArray(entry.supported_lods) ||
      !entry.supported_lods.includes("native") ||
      new Set(entry.supported_lods).size !== entry.supported_lods.length ||
      entry.supported_lods.some((lod) => !(lod in catalog.lod_seconds!)) ||
      !["exact", "selector"].includes(entry.match) ||
      !["gauge", "power"].includes(entry.statistic_policy) ||
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      typeof entry.unit !== "string" ||
      entry.unit.length === 0 ||
      (entry.match === "exact" && entry.rollup !== null) ||
      (entry.match === "selector" && (entry.rollup !== "sum" || entry.tags.length === 0)) ||
      entry.supported_lods.some((lod) => {
        const seconds =
          lod === "native" ? entry.native_interval_seconds : catalog.lod_seconds![lod];
        return (
          !Number.isInteger(seconds) ||
          seconds! < entry.native_interval_seconds ||
          HOUR % seconds! !== 0 ||
          DAY % seconds! !== 0
        );
      })
    ) {
      throw new Error("invalid_tile_catalog_series");
    }
    keys.add(entry.key);
    priorKey = entry.key;
  }
  return catalog as TileCatalog;
}

export function resolveTileSeries(
  catalog: TileCatalog,
  config: ConfigSeriesIdentity,
): TileCatalogSeries | null {
  const requiredTags = normalizedTags(config.tags);
  const candidates = catalog.series.filter((entry) => {
    const catalogTags = new Set(entry.tags);
    return (
      entry.metric === config.metric &&
      entry.rollup === (config.rollup ?? null) &&
      entry.unit === config.unit &&
      entry.statistic_policy === config.statisticPolicy &&
      requiredTags.every((tag) => catalogTags.has(tag))
    );
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export function selectTileLod(
  catalog: TileCatalog,
  entry: TileCatalogSeries,
  rangeSeconds: number,
  targetPoints = 1_200,
): TileLod {
  if (!Number.isFinite(rangeSeconds) || rangeSeconds <= 0 || targetPoints <= 0) {
    throw new Error("invalid_tile_lod_input");
  }
  const desiredSeconds = Math.ceil(rangeSeconds / targetPoints);
  const candidates = entry.supported_lods
    .map((lod) => ({
      lod,
      seconds: lod === "native" ? entry.native_interval_seconds : catalog.lod_seconds[lod],
    }))
    .filter((candidate): candidate is { lod: TileLod; seconds: number } =>
      Number.isInteger(candidate.seconds),
    )
    .sort(
      (left, right) =>
        left.seconds - right.seconds ||
        Number(right.lod === "native") - Number(left.lod === "native") ||
        left.lod.localeCompare(right.lod),
    );
  if (!candidates.length) throw new Error("invalid_tile_lod_catalog");
  return (candidates.find((candidate) => candidate.seconds >= desiredSeconds) ?? candidates.at(-1)!)
    .lod;
}

export function canonicalTileUrl(
  seriesKey: string,
  tileSpan: TileSpan,
  tileStart: number,
  lod: TileLod,
): string {
  if (!Number.isInteger(tileStart) || tileStart < 0) throw new Error("invalid_tile_start");
  const spanSeconds = tileSpan === "1d" ? DAY : HOUR;
  if (tileStart % spanSeconds !== 0) throw new Error("unaligned_tile_start");
  return `/api/v2/tiles/${encodeURIComponent(seriesKey)}/${tileSpan}/${tileStart}/${lod}`;
}

export function planTileRequests({
  catalog,
  correctionHorizonSeconds = DAY,
  end,
  entry,
  now,
  start,
  targetPoints = 1_200,
}: {
  catalog: TileCatalog;
  correctionHorizonSeconds?: number;
  end: number;
  entry: TileCatalogSeries;
  now: number;
  start: number;
  targetPoints?: number;
}): TileRequest[] {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    !Number.isInteger(now) ||
    !Number.isInteger(correctionHorizonSeconds) ||
    correctionHorizonSeconds < 0
  ) {
    throw new Error("invalid_tile_window");
  }
  const endExclusive = end + 1;
  const baseLod = selectTileLod(catalog, entry, end - start || 1, targetPoints);
  const baseLodSeconds =
    baseLod === "native" ? entry.native_interval_seconds : catalog.lod_seconds[baseLod];
  if (!Number.isInteger(baseLodSeconds) || baseLodSeconds! <= 0) {
    throw new Error("invalid_tile_lod_catalog");
  }
  const sealedBefore = now - correctionHorizonSeconds;
  const requests: TileRequest[] = [];
  let cursor = Math.floor(start / DAY) * DAY;
  while (cursor < endExclusive) {
    let tileSpan: TileSpan;
    let tileSeconds: number;
    if (cursor % DAY === 0 && cursor + DAY <= sealedBefore) {
      tileSpan = "1d";
      tileSeconds = DAY;
    } else {
      tileSpan = "1h";
      tileSeconds = HOUR;
      cursor = Math.floor(Math.max(cursor, start) / HOUR) * HOUR;
    }
    const tileEnd = cursor + tileSeconds;
    const overlapStart = Math.max(start, cursor);
    const overlapEnd = Math.min(endExclusive, tileEnd);
    const needsNativeEdge =
      baseLod !== "native" &&
      (overlapStart % baseLodSeconds! !== 0 || overlapEnd % baseLodSeconds! !== 0);
    const lod = needsNativeEdge ? "native" : baseLod;
    requests.push({
      lod,
      seriesKey: entry.key,
      tileEnd,
      tileSpan,
      tileStart: cursor,
      url: canonicalTileUrl(entry.key, tileSpan, cursor, lod),
    });
    cursor = tileEnd;
  }
  return requests;
}
