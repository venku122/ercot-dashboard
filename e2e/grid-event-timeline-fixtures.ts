import type { Page } from "@playwright/test";

import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

const VERSION = `ge1-${"e".repeat(64)}`;

export const GRID_EVENT_FROM = FIXED_NOW_SECONDS - 7_200;
export const GRID_EVENT_TO = FIXED_NOW_SECONDS;
export const GRID_EVENT_URL = `/?view=reliability&events=1&live=0&from=${GRID_EVENT_FROM}&to=${GRID_EVENT_TO}&range=7200&event=ops:exact`;

function baseEvent(identity: string, startsAt: number) {
  return {
    identity,
    source_id: "ercot_operations_messages",
    source_type: "operations_messages",
    evidence_class: "official_ercot",
    event_type: "Operational Information",
    status: "Active",
    severity: "Information",
    title: "Official ERCOT operations message",
    body: "Official message body retained independently from weather context.",
    starts_at: startsAt,
    starts_at_candidates: [startsAt],
    ends_at: null,
    observed_at: startsAt + 30,
    source_updated_at: startsAt,
    time_basis: "utc_exact",
    source_url: "https://www.ercot.com/services/comm/mkt_notices/opsmessages/index",
    derivation: null,
    content_version: VERSION,
  };
}

export function gridEventTimelineFixture(from: number, to: number) {
  return {
    schema: 1,
    kind: "grid_event_timeline",
    policy: "multi_source_temporal_context_not_causal_attribution",
    generated_at: to,
    content_version: VERSION,
    window: { from, to, basis: "utc", semantics: "half_open" },
    coverage: {
      txans: "unavailable_unverified_source",
      eea: "collector_accumulated_source_observations",
      operations_messages: "collector_accumulated_official_messages",
      nws_alerts: "texas_statewide_not_ercot_footprint_collected_after_pr19",
    },
    gaps: [
      "txans_unavailable_unverified_source",
      "operations_messages_repeated_hour_ambiguous",
      "history_begins_at_collection",
    ],
    limits: {
      max_window_seconds: 2_678_400,
      max_page_size: 500,
      official_source_retention_seconds: 34_560_000,
      derived_retention_seconds: 7_776_000,
    },
    events: [
      {
        ...baseEvent("derived:eea:transition", from + 6_000),
        source_id: "dashboard_event_derivation",
        source_type: "derived_annotations",
        evidence_class: "derived_annotation",
        event_type: "eea_level_transition",
        title: "Dashboard observed an EEA source-state transition",
        time_basis: "derived_from_input_utc",
        source_url: null,
        derivation: {
          method: "eea_transition_v1",
          version: "v1",
          input_identities: ["eea:input:a", "eea:input:b"],
        },
      },
      {
        ...baseEvent("nws:alert:wind", from + 5_000),
        source_id: "nws_alerts_tx",
        source_type: "nws_alerts",
        evidence_class: "official_weather",
        event_type: "High Wind Warning",
        severity: "Severe",
        title: "High Wind Warning for North Texas",
        body: "Official Texas statewide weather alert context.",
        ends_at: from + 6_500,
        source_url: "https://api.weather.gov/alerts/urn:oid:grid-event-vri",
      },
      {
        ...baseEvent("eea:snapshot:2", from + 4_000),
        source_id: "ercot_daily_prc",
        source_type: "eea",
        evidence_class: "source_observation",
        event_type: "eea_source_snapshot",
        status: "2",
        severity: null,
        title: "EEA level 2 source snapshot",
        body: null,
        time_basis: "source_snapshot_epoch_not_official_declaration_time",
        source_url: "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json",
      },
      baseEvent("ops:exact", from + 3_000),
      {
        ...baseEvent("ops:ambiguous", from + 2_000),
        starts_at: null,
        starts_at_candidates: [from + 1_000, from + 2_000],
        title: "Repeated-hour operations message",
        time_basis: "america_chicago_wall_ambiguous",
      },
    ],
    next_cursor: "gec1-WzE3ODQ2Njc2MDAsMTc4NDY3NDgwMCwxNzg0NjcwNjAwLCJvcHM6ZXhhY3QiXQ",
  };
}

export async function installGridEventTimelineApi(page: Page, requests: string[]) {
  await installMobileApi(page, "normal");
  await page.route("**/api/v1/grid-events?**", (route) => {
    const url = new URL(route.request().url());
    requests.push(`${url.pathname}?${url.searchParams.toString()}`);
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    return route.fulfill({ json: gridEventTimelineFixture(from, to) });
  });
}
