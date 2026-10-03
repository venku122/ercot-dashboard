import type { Page } from "@playwright/test";

const POLICY = "external_context_not_ercot_operational_authority_or_live_emissions_measurement";
const VERSION = `xc1-${"e".repeat(64)}`;
const RETRIEVED = 1_787_227_200;
const RESOURCE_URL = `/api/v2/external-context/epa_egrid/v1/${VERSION}`;

function disabledHealth(source_id: "eia930_erco" | "eia_henry_hub") {
  return {
    source_id,
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
      consecutive_failures: 0,
      last_error: null,
    },
  };
}

export function externalContextManifestFixture() {
  return {
    schema: 1,
    kind: "external_context",
    policy: POLICY,
    generated_at: RETRIEVED + 60,
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
        url: RESOURCE_URL,
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
    source_health: [
      disabledHealth("eia930_erco"),
      disabledHealth("eia_henry_hub"),
      {
        source_id: "epa_egrid_erct",
        state: "healthy",
        availability_status: "available",
        content_version: VERSION,
        last_attempt_ts: RETRIEVED,
        last_success_ts: RETRIEVED,
        source_updated_at: null,
        retrieved_at: RETRIEVED,
        cache_fresh_until: null,
        consecutive_failures: 0,
        last_error: null,
        materialization: {
          state: "healthy",
          last_success_ts: RETRIEVED,
          consecutive_failures: 0,
          last_error: null,
        },
      },
    ],
  };
}

export function externalContextEgridFixture() {
  const metrics = [
    ["co2", "CO₂", 812.4],
    ["ch4", "CH₄", 0.071],
    ["n2o", "N₂O", 0.012],
    ["co2e", "CO₂e", 818.7],
    ["annual_nox", "Annual NOₓ", 0.29],
    ["ozone_season_nox", "Ozone Season NOₓ", 0.25],
    ["so2", "SO₂", 0.41],
  ] as const;
  return {
    schema: 1,
    kind: "external_context_resource",
    policy: POLICY,
    stream: "epa_egrid",
    publication: {
      data_year: 2023,
      revision: 2,
      released_on: "2025-06-12",
      retrieved_at: RETRIEVED,
      source_page_url: "https://www.epa.gov/egrid/summary-data",
      artifact_url: "https://www.epa.gov/system/files/documents/2025-06/summary_tables_rev2.xlsx",
      workbook_sha256: `sha256:${"f".repeat(64)}`,
      table_title: "1. Subregion Output Emission Rates (eGRID2023)",
      production_model: "eGRID R production model 2023",
      production_version: "Produced on June 12, 2025",
    },
    subregion: "ERCT",
    subregion_name: "ERCOT All",
    rates: metrics.map(([metric_id, source_header, value]) => ({
      metric_id,
      source_header,
      value,
      unit: "lb_mwh",
    })),
  };
}

export async function installExternalContextApi(page: Page) {
  await page.route("**/api/v1/external-context", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(externalContextManifestFixture()),
    });
  });
  await page.route("**/api/v2/external-context/**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(externalContextEgridFixture()),
    });
  });
}
