import { describe, expect, it } from "vitest";

import {
  EGRID_METRICS,
  EXTERNAL_CONTEXT_POLICY,
  parseExternalContextManifest,
  parseExternalContextResource,
} from "./external-context";

const VERSION = `xc1-${"a".repeat(64)}`;
const RETRIEVED = 1_787_227_200;
const GENERATED = RETRIEVED + 60;
const EGRID_URL = `/api/v2/external-context/epa_egrid/v1/${VERSION}`;

function disabledHealth(sourceId: "eia930_erco" | "eia_henry_hub") {
  return {
    source_id: sourceId,
    state: "disabled",
    availability_status: "disabled",
    content_version: null,
    last_attempt_ts: null,
    last_success_ts: null,
    source_updated_at: null,
    retrieved_at: null,
    cache_fresh_until: null,
    consecutive_failures: 0,
    last_error: null,
    materialization: {
      state: "unavailable",
      last_success_ts: null,
      consecutive_failures: null,
      last_error: null,
    },
  };
}

function egridHealth() {
  return {
    source_id: "epa_egrid_erct",
    state: "healthy",
    availability_status: "available",
    content_version: VERSION,
    last_attempt_ts: RETRIEVED,
    last_success_ts: RETRIEVED,
    source_updated_at: null,
    retrieved_at: RETRIEVED,
    cache_fresh_until: RETRIEVED + 604_800,
    consecutive_failures: 0,
    last_error: null,
    materialization: {
      state: "healthy",
      last_success_ts: RETRIEVED,
      consecutive_failures: 0,
      last_error: null,
    },
  };
}

export function externalContextManifestFixture() {
  return {
    schema: 1,
    kind: "external_context",
    policy: EXTERNAL_CONTEXT_POLICY,
    generated_at: GENERATED,
    eia_930: {
      state: "disabled",
      reason: "eia_api_key_not_configured",
      freshness: null,
      selected: null,
    },
    natural_gas: {
      state: "disabled",
      reason: "eia_api_key_not_configured",
      freshness: null,
      selected: null,
    },
    epa_egrid: {
      state: "available",
      reason: null,
      freshness: "not_applicable",
      selected: {
        content_version: VERSION,
        url: EGRID_URL,
        data_year: 2023,
        revision: 2,
        released_on: "2025-06-12",
        retrieved_at: RETRIEVED,
        subregion: "ERCT",
        subregion_name: "ERCOT All",
        source_page_url: "https://www.epa.gov/egrid/summary-data",
        artifact_url: "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx",
      },
    },
    epa_camd: {
      state: "unavailable",
      reason: "ercot_footprint_and_coverage_methodology_not_frozen",
    },
    source_health: [disabledHealth("eia930_erco"), disabledHealth("eia_henry_hub"), egridHealth()],
  };
}

export function externalContextEgridFixture() {
  return {
    schema: 1,
    kind: "external_context_resource",
    policy: EXTERNAL_CONTEXT_POLICY,
    stream: "epa_egrid",
    publication: {
      data_year: 2023,
      revision: 2,
      released_on: "2025-06-12",
      retrieved_at: RETRIEVED,
      source_page_url: "https://www.epa.gov/egrid/summary-data",
      artifact_url: "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx",
      workbook_sha256: `sha256:${"b".repeat(64)}`,
      table_title: "1. Subregion Output Emission Rates (eGRID2023)",
      production_model: "eGRID R production model 2023",
      production_version: "Produced on June 12, 2025",
    },
    subregion: "ERCT",
    subregion_name: "ERCOT All",
    rates: EGRID_METRICS.map(([metric_id, source_header], index) => ({
      metric_id,
      source_header,
      value: index + 0.125,
      unit: "lb_mwh",
    })),
  };
}

describe("PR22 strict external-context frontend contract", () => {
  it("accepts the honest no-key manifest and exact seven-rate eGRID resource", () => {
    const manifest = parseExternalContextManifest(externalContextManifestFixture());
    expect(manifest.eia_930).toMatchObject({ state: "disabled", selected: null });
    expect(manifest.natural_gas).toMatchObject({ state: "disabled", selected: null });
    expect(manifest.epa_camd.state).toBe("unavailable");
    const resource = parseExternalContextResource(
      externalContextEgridFixture(),
      "epa_egrid",
      manifest.epa_egrid.selected!,
    );
    expect(resource.stream).toBe("epa_egrid");
    if (resource.stream !== "epa_egrid") throw new Error("unexpected_stream");
    expect(resource.rates.map((row) => row.metric_id)).toEqual(EGRID_METRICS.map(([id]) => id));
  });

  it("rejects unknown manifest keys, poisoned links, and invented CAMD availability", () => {
    expect(() =>
      parseExternalContextManifest({ ...externalContextManifestFixture(), credential: "secret" }),
    ).toThrow("invalid_external_context_manifest");
    const poisoned = externalContextManifestFixture();
    poisoned.epa_egrid.selected.url = `${EGRID_URL}?api_key=secret`;
    expect(() => parseExternalContextManifest(poisoned)).toThrow(
      "invalid_external_context_selected",
    );
    const camd = externalContextManifestFixture();
    camd.epa_camd.state = "available";
    expect(() => parseExternalContextManifest(camd)).toThrow("invalid_external_context_manifest");
  });

  it("preserves signed EIA total interchange on exact hour-ending UTC intervals", () => {
    const contentVersion = `xc1-${"c".repeat(64)}`;
    const selected = {
      content_version: contentVersion,
      url: `/api/v2/external-context/eia930_demand/v1/${contentVersion}`,
      retrieved_at: RETRIEVED,
      latest_demand_interval_end: 1_787_216_400,
      latest_interchange_interval_end: 1_787_216_400,
      source_url: "https://api.eia.gov/v2/electricity/rto/region-data/data/",
    };
    const resource = parseExternalContextResource(
      {
        schema: 1,
        kind: "external_context_resource",
        policy: EXTERNAL_CONTEXT_POLICY,
        stream: "eia930_demand",
        publication: { retrieved_at: RETRIEVED, source_url: selected.source_url },
        interval_basis: "hour_ending_utc_half_open",
        rows: [
          {
            period: "2026-08-20T09",
            interval_start: 1_787_212_800,
            interval_end: 1_787_216_400,
            type: "D",
            type_name: "Demand",
            value_decimal: "75000.25",
            value_mwh: 75_000.25,
          },
          {
            period: "2026-08-20T09",
            interval_start: 1_787_212_800,
            interval_end: 1_787_216_400,
            type: "TI",
            type_name: "Total Interchange",
            value_decimal: "-125.5",
            value_mwh: -125.5,
          },
        ],
      },
      "eia930_demand",
      selected,
    );
    expect(resource.stream).toBe("eia930_demand");
    if (resource.stream !== "eia930_demand") throw new Error("unexpected_stream");
    expect(resource.rows[1]?.value_mwh).toBe(-125.5);
  });

  it("keeps Henry Hub on a civil-date axis and accepts a negative finite price", () => {
    const contentVersion = `xc1-${"d".repeat(64)}`;
    const selected = {
      content_version: contentVersion,
      url: `/api/v2/external-context/henry_hub_daily/v1/${contentVersion}`,
      retrieved_at: RETRIEVED,
      latest_market_date: "2026-08-19",
      source_url: "https://api.eia.gov/v2/seriesid/NG.RNGWHHD.D",
    };
    const resource = parseExternalContextResource(
      {
        schema: 1,
        kind: "external_context_resource",
        policy: EXTERNAL_CONTEXT_POLICY,
        stream: "henry_hub_daily",
        publication: {
          retrieved_at: RETRIEVED,
          series_id: "NG.RNGWHHD.D",
          source_url: selected.source_url,
          source_page_url: "https://www.eia.gov/dnav/ng/hist/rngwhhdd.htm",
          source_unit: "dollars per million Btu",
        },
        unit: "usd_per_mmbtu",
        date_basis: "source_market_date_no_timezone",
        rows: [{ market_date: "2026-08-19", value_decimal: "-0.25", price: -0.25 }],
      },
      "henry_hub_daily",
      selected,
    );
    expect(resource.stream).toBe("henry_hub_daily");
    if (resource.stream !== "henry_hub_daily") throw new Error("unexpected_stream");
    expect(resource.rows).toEqual([
      { market_date: "2026-08-19", value_decimal: "-0.25", price: -0.25 },
    ]);
  });

  it("rejects changed eGRID metric order, live multiplication fields, and bad disabled health clocks", () => {
    const manifest = parseExternalContextManifest(externalContextManifestFixture());
    const reordered = externalContextEgridFixture();
    reordered.rates.reverse();
    expect(() =>
      parseExternalContextResource(reordered, "epa_egrid", manifest.epa_egrid.selected!),
    ).toThrow("invalid_external_context_resource");
    const derived = { ...externalContextEgridFixture(), live_mass_emissions: 10 };
    expect(() =>
      parseExternalContextResource(derived, "epa_egrid", manifest.epa_egrid.selected!),
    ).toThrow("invalid_external_context_resource");
    const clocked = externalContextManifestFixture();
    clocked.source_health[0]!.last_attempt_ts = RETRIEVED;
    expect(() => parseExternalContextManifest(clocked)).toThrow(
      "invalid_external_context_source_health",
    );
  });
});
