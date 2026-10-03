import { describe, expect, it } from "vitest";

import {
  gridEventIdentityFromUrl,
  gridEventPermalink,
  gridEventReplayUrl,
  parseGridEventTimeline,
  type GridEvent,
  type GridEventTimeline,
} from "./grid-event-timeline";

const START = 1_800_000_000;
const VERSION = `ge1-${"a".repeat(64)}`;

function event(identity: string, start: number, overrides: Partial<GridEvent> = {}): GridEvent {
  return {
    identity,
    source_id: "ercot_operations_messages",
    source_type: "operations_messages",
    evidence_class: "official_ercot",
    event_type: "Operational Information",
    status: "Active",
    severity: "Information",
    title: `Official event ${identity}`,
    body: null,
    starts_at: start,
    starts_at_candidates: [start],
    ends_at: null,
    observed_at: start + 30,
    source_updated_at: start,
    time_basis: "utc_exact",
    source_url: "https://www.ercot.com/services/comm/mkt_notices/opsmessages/index",
    derivation: null,
    content_version: VERSION,
    ...overrides,
  };
}

function events(): GridEvent[] {
  return [
    event("derived:eea:transition", START + 8_000, {
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
    }),
    event("nws:alert:wind", START + 7_000, {
      source_id: "nws_alerts_tx",
      source_type: "nws_alerts",
      evidence_class: "official_weather",
      event_type: "High Wind Warning",
      severity: "Severe",
      title: "High Wind Warning for North Texas",
      source_url: "https://api.weather.gov/alerts/urn:oid:wind",
    }),
    event("eea:source:2", START + 6_000, {
      source_id: "ercot_daily_prc",
      source_type: "eea",
      evidence_class: "source_observation",
      event_type: "eea_source_snapshot",
      title: "EEA level 2 source snapshot",
      time_basis: "source_snapshot_epoch_not_official_declaration_time",
      source_url: "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json",
    }),
    event("ops:exact", START + 5_000),
    event("ops:ambiguous", START + 4_600, {
      starts_at: null,
      starts_at_candidates: [START + 1_000, START + 4_600],
      observed_at: START + 4_700,
      source_updated_at: START + 4_600,
      time_basis: "america_chicago_wall_ambiguous",
      title: "Repeated-hour operations message",
    }),
  ];
}

export function gridEventTimelineFixture(
  overrides: Partial<GridEventTimeline> = {},
): GridEventTimeline {
  return {
    schema: 1,
    kind: "grid_event_timeline",
    policy: "multi_source_temporal_context_not_causal_attribution",
    generated_at: START + 9_000,
    content_version: VERSION,
    window: { from: START, to: START + 9_000, basis: "utc", semantics: "half_open" },
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
    events: events(),
    next_cursor: null,
    ...overrides,
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(gridEventTimelineFixture()) as unknown as Record<string, unknown>;
}

describe("PR19 grid event timeline parser", () => {
  it("preserves official, weather, source, and derived evidence without cross-source merging", () => {
    const timeline = parseGridEventTimeline(gridEventTimelineFixture());
    expect(timeline.events.map((item) => item.evidence_class)).toEqual([
      "derived_annotation",
      "official_weather",
      "source_observation",
      "official_ercot",
      "official_ercot",
    ]);
    expect(new Set(timeline.events.map((item) => item.identity)).size).toBe(5);
    expect(timeline.coverage.nws_alerts).toContain("texas_statewide_not_ercot_footprint");
    expect(timeline.coverage.txans).toBe("unavailable_unverified_source");
  });

  it("accepts either repeated-hour fold narrowly but orders ambiguous events by the later candidate", () => {
    const ambiguous = events().at(-1)!;
    for (const window of [
      { from: START, to: START + 2_000 },
      { from: START + 4_000, to: START + 5_000 },
    ]) {
      expect(
        parseGridEventTimeline(
          gridEventTimelineFixture({
            window: { ...window, basis: "utc", semantics: "half_open" },
            events: [ambiguous],
          }),
        ).events,
      ).toHaveLength(1);
    }
    const wrongOrder = gridEventTimelineFixture({
      events: [event("ops:earlier-than-late-fold", START + 4_500), ambiguous],
    });
    expect(() => parseGridEventTimeline(wrongOrder)).toThrow("invalid_grid_event_order");
  });

  it("uses half-open overlap semantics including an event that begins before the window", () => {
    const overlap = event("ops:overlap", START - 100, { ends_at: START + 1 });
    expect(
      parseGridEventTimeline(gridEventTimelineFixture({ events: [overlap] })).events,
    ).toHaveLength(1);
    expect(() =>
      parseGridEventTimeline(
        gridEventTimelineFixture({ events: [event("ops:end-boundary", START + 9_000)] }),
      ),
    ).toThrow("grid_event_outside_window");
  });

  it("rejects extra keys, invalid provenance pairs, malformed candidates, and unsorted inputs", () => {
    const extra = clone();
    extra["unexpected"] = true;
    const provenance = clone();
    (provenance["events"] as Array<Record<string, unknown>>)[1]!["evidence_class"] =
      "official_ercot";
    const candidates = clone();
    (candidates["events"] as Array<Record<string, unknown>>)[4]!["starts_at_candidates"] = [
      START + 4_600,
      START + 1_000,
    ];
    const inputs = clone();
    (
      (inputs["events"] as Array<Record<string, unknown>>)[0]!["derivation"] as Record<
        string,
        unknown
      >
    )["input_identities"] = ["eea:input:b", "eea:input:a"];
    for (const value of [extra, provenance, candidates, inputs]) {
      expect(() => parseGridEventTimeline(value)).toThrow();
    }
  });

  it("enforces receiver UTF-8 byte limits rather than JavaScript character counts", () => {
    for (const [field, value] of [
      ["event_type", "é".repeat(61)],
      ["status", "é".repeat(41)],
      ["severity", "é".repeat(41)],
      ["title", "é".repeat(251)],
      ["body", "é".repeat(5_001)],
    ]) {
      const oversized = clone();
      (oversized["events"] as Array<Record<string, unknown>>)[0]![field] = value;
      expect(() => parseGridEventTimeline(oversized)).toThrow("invalid_grid_event");
    }
  });

  it("accepts nullable official source URLs but preserves derived provenance rules", () => {
    const withoutUrl = clone();
    (withoutUrl["events"] as Array<Record<string, unknown>>)[1]!["source_url"] = null;
    expect(parseGridEventTimeline(withoutUrl).events[1]!.source_url).toBeNull();

    const derivedUrl = clone();
    (derivedUrl["events"] as Array<Record<string, unknown>>)[0]!["source_url"] =
      "https://www.ercot.com/services";
    expect(() => parseGridEventTimeline(derivedUrl)).toThrow("invalid_grid_event_provenance");

    const unsafeVersion = clone();
    (
      (unsafeVersion["events"] as Array<Record<string, unknown>>)[0]!["derivation"] as Record<
        string,
        unknown
      >
    )["version"] = "derived~v1";
    expect(() => parseGridEventTimeline(unsafeVersion)).toThrow("invalid_grid_event_derivation");
  });

  it("builds canonical focus and storage-context URLs without a causal join", () => {
    const timeline = parseGridEventTimeline(gridEventTimelineFixture());
    const time = {
      mode: "fixed",
      paused: false,
      start: START,
      end: START + 9_000,
      rangeSeconds: 9_000,
    } as const;
    const permalink = gridEventPermalink(
      timeline.events[0]!.identity,
      time,
      new URL("https://example.test/?compare=day"),
    );
    expect(gridEventIdentityFromUrl(permalink)).toBe("derived:eea:transition");
    expect(permalink.searchParams.get("view")).toBe("reliability");
    expect(permalink.searchParams.get("from")).toBe(String(START));
    const replay = gridEventReplayUrl(
      timeline.events[1]!,
      time,
      new URL("https://example.test/?compare=day"),
    );
    expect(replay?.searchParams.get("view")).toBe("generation");
    expect(replay?.searchParams.get("inspect")).toBe("storage");
    expect(replay?.searchParams.get("event")).toBe("nws:alert:wind");
    expect(replay?.searchParams.get("from")).toBe(String(time.start));
    expect(replay?.searchParams.get("to")).toBe(String(time.end));
    expect(replay?.searchParams.get("range")).toBe(String(time.rangeSeconds));
    expect(replay?.toString()).not.toMatch(/cause|join|attribution/);
    expect(gridEventReplayUrl(timeline.events.at(-1)!, time, permalink)).toBeNull();
    expect(
      gridEventReplayUrl(
        timeline.events[1]!,
        { ...time, end: time.start + 86_401, rangeSeconds: 86_401 },
        permalink,
      ),
    ).toBeNull();
  });
});
