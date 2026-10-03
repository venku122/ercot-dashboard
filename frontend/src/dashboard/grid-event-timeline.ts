import type { TimeState } from "./types";

export const GRID_EVENT_POLICY = "multi_source_temporal_context_not_causal_attribution" as const;
export const GRID_EVENT_MAX_WINDOW_SECONDS = 2_678_400;
export const GRID_EVENT_PAGE_SIZE = 500;
export const GRID_EVENT_REPLAY_MAX_WINDOW_SECONDS = 86_400;

export type GridEventEvidenceClass =
  | "official_ercot"
  | "official_weather"
  | "source_observation"
  | "derived_annotation";
export type GridEventSourceType =
  | "operations_messages"
  | "eea"
  | "nws_alerts"
  | "derived_annotations";
export type GridEventTimeBasis =
  | "utc_exact"
  | "america_chicago_wall_ambiguous"
  | "source_snapshot_epoch_not_official_declaration_time"
  | "derived_from_input_utc";

export type GridEventDerivation = {
  method: string;
  version: string;
  input_identities: string[];
};

export type GridEvent = {
  identity: string;
  source_id: string;
  source_type: GridEventSourceType;
  evidence_class: GridEventEvidenceClass;
  event_type: string;
  status: string | null;
  severity: string | null;
  title: string;
  body: string | null;
  starts_at: number | null;
  starts_at_candidates: number[];
  ends_at: number | null;
  observed_at: number;
  source_updated_at: number;
  time_basis: GridEventTimeBasis;
  source_url: string | null;
  derivation: GridEventDerivation | null;
  content_version: string;
};

export type GridEventTimeline = {
  schema: 1;
  kind: "grid_event_timeline";
  policy: typeof GRID_EVENT_POLICY;
  generated_at: number;
  content_version: string;
  window: { from: number; to: number; basis: "utc"; semantics: "half_open" };
  coverage: {
    txans: "unavailable_unverified_source";
    eea: "collector_accumulated_source_observations";
    operations_messages: "collector_accumulated_official_messages";
    nws_alerts: "texas_statewide_not_ercot_footprint_collected_after_pr19";
  };
  gaps: Array<
    | "txans_unavailable_unverified_source"
    | "operations_messages_repeated_hour_ambiguous"
    | "history_begins_at_collection"
  >;
  limits: {
    max_window_seconds: 2_678_400;
    max_page_size: 500;
    official_source_retention_seconds: 34_560_000;
    derived_retention_seconds: 7_776_000;
  };
  events: GridEvent[];
  next_cursor: string | null;
};

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._~/-]{0,511}$/;
const VERSION = /^ge1-[0-9a-f]{64}$/;
const METHOD = /^[a-z][a-z0-9_]{0,119}$/;
const CURSOR = /^gec1-[A-Za-z0-9_-]+$/;
const GAP_VALUES = [
  "txans_unavailable_unverified_source",
  "operations_messages_repeated_hour_ambiguous",
  "history_begins_at_collection",
] as const;
const EVIDENCE = new Set<GridEventEvidenceClass>([
  "official_ercot",
  "official_weather",
  "source_observation",
  "derived_annotation",
]);
const SOURCES = new Set<GridEventSourceType>([
  "operations_messages",
  "eea",
  "nws_alerts",
  "derived_annotations",
]);
const TIME_BASES = new Set<GridEventTimeBasis>([
  "utc_exact",
  "america_chicago_wall_ambiguous",
  "source_snapshot_epoch_not_official_declaration_time",
  "derived_from_input_utc",
]);

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error(code);
}

function integer(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

function nullableInteger(value: unknown, code: string): number | null {
  return value === null ? null : integer(value, code);
}

function text(value: unknown, code: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > maximum
  ) {
    throw new Error(code);
  }
  return value;
}

function nullableText(value: unknown, code: string, maximum: number): string | null {
  return value === null ? null : text(value, code, maximum);
}

function identity(value: unknown, code = "invalid_grid_event_identity"): string {
  const result = text(value, code, 512);
  if (!IDENTITY.test(result)) throw new Error(code);
  return result;
}

function version(value: unknown, code = "invalid_grid_event_content_version"): string {
  const result = text(value, code, 68);
  if (!VERSION.test(result)) throw new Error(code);
  return result;
}

function parseDerivation(value: unknown): GridEventDerivation | null {
  if (value === null) return null;
  const item = object(value, "invalid_grid_event_derivation");
  exact(item, ["method", "version", "input_identities"], "invalid_grid_event_derivation");
  const method = text(item["method"], "invalid_grid_event_derivation", 120);
  const methodologyVersion = text(item["version"], "invalid_grid_event_derivation", 64);
  if (!METHOD.test(method) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(methodologyVersion)) {
    throw new Error("invalid_grid_event_derivation");
  }
  if (
    !Array.isArray(item["input_identities"]) ||
    item["input_identities"].length < 1 ||
    item["input_identities"].length > 32
  ) {
    throw new Error("invalid_grid_event_derivation");
  }
  const inputs = item["input_identities"].map((value) => identity(value));
  if (
    new Set(inputs).size !== inputs.length ||
    inputs.some((value, index) => index > 0 && inputs[index - 1]! >= value)
  ) {
    throw new Error("invalid_grid_event_derivation");
  }
  return { method, version: methodologyVersion, input_identities: inputs };
}

function parseSourceUrl(value: unknown, sourceType: GridEventSourceType): string | null {
  if (value === null) return null;
  const result = text(value, "invalid_grid_event_source_url", 1_024);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error("invalid_grid_event_source_url");
  }
  const expectedHost = sourceType === "nws_alerts" ? "api.weather.gov" : "www.ercot.com";
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== expectedHost ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("invalid_grid_event_source_url");
  }
  return result;
}

function parseEvent(value: unknown): GridEvent {
  const item = object(value, "invalid_grid_event");
  exact(
    item,
    [
      "identity",
      "source_id",
      "source_type",
      "evidence_class",
      "event_type",
      "status",
      "severity",
      "title",
      "body",
      "starts_at",
      "starts_at_candidates",
      "ends_at",
      "observed_at",
      "source_updated_at",
      "time_basis",
      "source_url",
      "derivation",
      "content_version",
    ],
    "invalid_grid_event",
  );
  if (!SOURCES.has(item["source_type"] as GridEventSourceType))
    throw new Error("invalid_grid_event_source");
  if (!EVIDENCE.has(item["evidence_class"] as GridEventEvidenceClass))
    throw new Error("invalid_grid_event_evidence");
  if (!TIME_BASES.has(item["time_basis"] as GridEventTimeBasis))
    throw new Error("invalid_grid_event_time_basis");
  const sourceType = item["source_type"] as GridEventSourceType;
  const evidenceClass = item["evidence_class"] as GridEventEvidenceClass;
  const timeBasis = item["time_basis"] as GridEventTimeBasis;
  const startsAt = nullableInteger(item["starts_at"], "invalid_grid_event_time");
  if (!Array.isArray(item["starts_at_candidates"])) throw new Error("invalid_grid_event_time");
  const candidates = item["starts_at_candidates"].map((candidate) =>
    integer(candidate, "invalid_grid_event_time"),
  );
  const ambiguous = timeBasis === "america_chicago_wall_ambiguous";
  if (
    (ambiguous &&
      (startsAt !== null || candidates.length !== 2 || candidates[0]! >= candidates[1]!)) ||
    (!ambiguous && (startsAt === null || candidates.length !== 1 || candidates[0] !== startsAt))
  ) {
    throw new Error("invalid_grid_event_time");
  }
  const endsAt = nullableInteger(item["ends_at"], "invalid_grid_event_time");
  if (endsAt !== null && endsAt <= candidates[0]!) throw new Error("invalid_grid_event_time");
  const derivation = parseDerivation(item["derivation"]);
  const sourceUrl = parseSourceUrl(item["source_url"], sourceType);
  const allowedPair =
    (sourceType === "operations_messages" &&
      evidenceClass === "official_ercot" &&
      (timeBasis === "utc_exact" || ambiguous)) ||
    (sourceType === "nws_alerts" &&
      evidenceClass === "official_weather" &&
      timeBasis === "utc_exact") ||
    (sourceType === "eea" &&
      evidenceClass === "source_observation" &&
      timeBasis === "source_snapshot_epoch_not_official_declaration_time") ||
    (sourceType === "derived_annotations" &&
      evidenceClass === "derived_annotation" &&
      timeBasis === "derived_from_input_utc");
  if (!allowedPair) throw new Error("invalid_grid_event_provenance");
  if ((evidenceClass === "derived_annotation") !== (derivation !== null)) {
    throw new Error("invalid_grid_event_provenance");
  }
  if (evidenceClass === "derived_annotation" && sourceUrl !== null) {
    throw new Error("invalid_grid_event_provenance");
  }
  return {
    identity: identity(item["identity"]),
    source_id: text(item["source_id"], "invalid_grid_event_source", 120),
    source_type: sourceType,
    evidence_class: evidenceClass,
    event_type: text(item["event_type"], "invalid_grid_event", 120),
    status: nullableText(item["status"], "invalid_grid_event", 80),
    severity: nullableText(item["severity"], "invalid_grid_event", 80),
    title: text(item["title"], "invalid_grid_event", 500),
    body: nullableText(item["body"], "invalid_grid_event", 10_000),
    starts_at: startsAt,
    starts_at_candidates: candidates,
    ends_at: endsAt,
    observed_at: integer(item["observed_at"], "invalid_grid_event_time"),
    source_updated_at: integer(item["source_updated_at"], "invalid_grid_event_time"),
    time_basis: timeBasis,
    source_url: sourceUrl,
    derivation,
    content_version: version(item["content_version"]),
  };
}

export function parseGridEventTimeline(value: unknown): GridEventTimeline {
  const root = object(value, "invalid_grid_event_timeline");
  exact(
    root,
    [
      "schema",
      "kind",
      "policy",
      "generated_at",
      "content_version",
      "window",
      "coverage",
      "gaps",
      "limits",
      "events",
      "next_cursor",
    ],
    "invalid_grid_event_timeline",
  );
  if (
    root["schema"] !== 1 ||
    root["kind"] !== "grid_event_timeline" ||
    root["policy"] !== GRID_EVENT_POLICY
  ) {
    throw new Error("invalid_grid_event_timeline");
  }
  const window = object(root["window"], "invalid_grid_event_window");
  exact(window, ["from", "to", "basis", "semantics"], "invalid_grid_event_window");
  const from = integer(window["from"], "invalid_grid_event_window");
  const to = integer(window["to"], "invalid_grid_event_window");
  if (
    window["basis"] !== "utc" ||
    window["semantics"] !== "half_open" ||
    to <= from ||
    to - from > GRID_EVENT_MAX_WINDOW_SECONDS
  ) {
    throw new Error("invalid_grid_event_window");
  }
  const coverage = object(root["coverage"], "invalid_grid_event_coverage");
  exact(
    coverage,
    ["txans", "eea", "operations_messages", "nws_alerts"],
    "invalid_grid_event_coverage",
  );
  if (
    coverage["txans"] !== "unavailable_unverified_source" ||
    coverage["eea"] !== "collector_accumulated_source_observations" ||
    coverage["operations_messages"] !== "collector_accumulated_official_messages" ||
    coverage["nws_alerts"] !== "texas_statewide_not_ercot_footprint_collected_after_pr19"
  )
    throw new Error("invalid_grid_event_coverage");
  if (!Array.isArray(root["gaps"])) throw new Error("invalid_grid_event_gaps");
  const gaps = root["gaps"].map((gap) => {
    if (!GAP_VALUES.includes(gap as (typeof GAP_VALUES)[number]))
      throw new Error("invalid_grid_event_gaps");
    return gap as (typeof GAP_VALUES)[number];
  });
  if (new Set(gaps).size !== gaps.length) throw new Error("invalid_grid_event_gaps");
  const limits = object(root["limits"], "invalid_grid_event_limits");
  exact(
    limits,
    [
      "max_window_seconds",
      "max_page_size",
      "official_source_retention_seconds",
      "derived_retention_seconds",
    ],
    "invalid_grid_event_limits",
  );
  if (
    limits["max_window_seconds"] !== 2_678_400 ||
    limits["max_page_size"] !== 500 ||
    limits["official_source_retention_seconds"] !== 34_560_000 ||
    limits["derived_retention_seconds"] !== 7_776_000
  ) {
    throw new Error("invalid_grid_event_limits");
  }
  if (!Array.isArray(root["events"]) || root["events"].length > GRID_EVENT_PAGE_SIZE)
    throw new Error("invalid_grid_events");
  const events = root["events"].map(parseEvent);
  if (new Set(events.map((event) => event.identity)).size !== events.length)
    throw new Error("duplicate_grid_event");
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const sortAt = event.starts_at ?? event.starts_at_candidates.at(-1)!;
    const overlaps = event.starts_at_candidates.some(
      (candidate) =>
        candidate < to && (event.ends_at === null ? candidate >= from : event.ends_at > from),
    );
    if (!overlaps) throw new Error("grid_event_outside_window");
    const prior = events[index - 1];
    if (prior) {
      const priorSort = prior.starts_at ?? prior.starts_at_candidates.at(-1)!;
      if (priorSort < sortAt || (priorSort === sortAt && prior.identity >= event.identity))
        throw new Error("invalid_grid_event_order");
    }
  }
  const nextCursor =
    root["next_cursor"] === null
      ? null
      : text(root["next_cursor"], "invalid_grid_event_cursor", 2_048);
  if (nextCursor !== null && !CURSOR.test(nextCursor)) throw new Error("invalid_grid_event_cursor");
  return {
    schema: 1,
    kind: "grid_event_timeline",
    policy: GRID_EVENT_POLICY,
    generated_at: integer(root["generated_at"], "invalid_grid_event_timeline"),
    content_version: version(root["content_version"]),
    window: { from, to, basis: "utc", semantics: "half_open" },
    coverage: {
      txans: "unavailable_unverified_source",
      eea: "collector_accumulated_source_observations",
      operations_messages: "collector_accumulated_official_messages",
      nws_alerts: "texas_statewide_not_ercot_footprint_collected_after_pr19",
    },
    gaps,
    limits: {
      max_window_seconds: 2_678_400,
      max_page_size: 500,
      official_source_retention_seconds: 34_560_000,
      derived_retention_seconds: 7_776_000,
    },
    events,
    next_cursor: nextCursor,
  };
}

export function gridEventIdentityFromUrl(url: URL): string | null {
  const value = url.searchParams.get("event");
  return value !== null && IDENTITY.test(value) ? value : null;
}

export function gridEventRequestUrl(from: number, to: number, cursor?: string | null): string {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to <= from ||
    to - from > GRID_EVENT_MAX_WINDOW_SECONDS
  ) {
    throw new Error("invalid_grid_event_window");
  }
  const params = new URLSearchParams({
    from: String(from),
    to: String(to),
    limit: String(GRID_EVENT_PAGE_SIZE),
  });
  if (cursor) {
    if (!CURSOR.test(cursor)) throw new Error("invalid_grid_event_cursor");
    params.set("cursor", cursor);
  }
  return `/api/v1/grid-events?${params.toString()}`;
}

export function gridEventPermalink(identityValue: string, time: TimeState, base: URL): URL {
  const eventIdentity = identity(identityValue);
  const from = Math.round(time.start);
  const to = Math.round(time.end);
  const url = new URL(base);
  url.searchParams.set("view", "reliability");
  url.searchParams.set("live", "0");
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("range", String(to - from));
  url.searchParams.set("events", "1");
  url.searchParams.set("event", eventIdentity);
  url.searchParams.delete("inspect");
  url.searchParams.delete("cursor");
  return url;
}

export function gridEventReplayUrl(event: GridEvent, time: TimeState, base: URL): URL | null {
  const from = Math.round(time.start);
  const to = Math.round(time.end);
  if (
    event.starts_at === null ||
    from < 0 ||
    to <= from ||
    to - from > GRID_EVENT_REPLAY_MAX_WINDOW_SECONDS
  ) {
    return null;
  }
  const url = new URL(base);
  url.searchParams.set("view", "generation");
  url.searchParams.set("live", "0");
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("range", String(to - from));
  url.searchParams.set("events", "1");
  url.searchParams.set("inspect", "storage");
  url.searchParams.set("event", event.identity);
  url.searchParams.delete("cursor");
  return url;
}
