export const GRID_EVENTS_SCHEMA = 1 as const;
export const GRID_EVENTS_POLICY = "multi_source_temporal_context_not_causal_attribution" as const;

export const ERCOT_OPERATIONS_MESSAGES_URL =
  "https://www.ercot.com/services/comm/mkt_notices/opsmessages/index";
export const ERCOT_DAILY_PRC_URL =
  "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json";

const months = new Map([
  ["Jan", 0],
  ["Feb", 1],
  ["Mar", 2],
  ["Apr", 3],
  ["May", 4],
  ["Jun", 5],
  ["Jul", 6],
  ["Aug", 7],
  ["Sep", 8],
  ["Oct", 9],
  ["Nov", 10],
  ["Dec", 11],
]);

function text(value: unknown, code: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > maximum
  )
    throw new Error(code);
  return value;
}

function transitionSunday(year: number, month: number, ordinal: 1 | 2) {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstWeekday) % 7);
  return firstSunday + (ordinal - 1) * 7;
}

export type CentralWallTime = {
  candidates: number[];
  source_wall_time: string;
  starts_at: number | null;
  time_basis: "america_chicago_exact" | "america_chicago_wall_time_ambiguous";
};

export function parseCentralWallTime(value: unknown): CentralWallTime {
  const source = text(value, "invalid_operations_timestamp", 64);
  const match =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(
      source,
    );
  if (!match) throw new Error("invalid_operations_timestamp");
  const month = months.get(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month === undefined ||
    year < 2000 ||
    year > 2100 ||
    day < 1 ||
    day > 31 ||
    hour < 1 ||
    hour > 12 ||
    minute > 59 ||
    second > 59
  )
    throw new Error("invalid_operations_timestamp");
  hour = (hour % 12) + (match[7] === "PM" ? 12 : 0);
  const wall = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day
  )
    throw new Error("invalid_operations_timestamp");
  const spring = transitionSunday(year, 2, 2);
  const fall = transitionSunday(year, 10, 1);
  if (month === 2 && day === spring && hour === 2) {
    throw new Error("nonexistent_operations_timestamp");
  }
  if (month === 10 && day === fall && hour === 1) {
    return {
      candidates: [wall + 5 * 3_600_000, wall + 6 * 3_600_000].map((item) => item / 1_000),
      source_wall_time: source,
      starts_at: null,
      time_basis: "america_chicago_wall_time_ambiguous",
    };
  }
  const daylight =
    (month > 2 && month < 10) ||
    (month === 2 && (day > spring || (day === spring && hour >= 3))) ||
    (month === 10 && (day < fall || (day === fall && hour < 1)));
  const startsAt = (wall + (daylight ? 5 : 6) * 3_600_000) / 1_000;
  return {
    candidates: [startsAt],
    source_wall_time: source,
    starts_at: startsAt,
    time_basis: "america_chicago_exact",
  };
}

export type OperationsMessageEvidence = CentralWallTime & {
  body: string;
  dedupe_key: string;
  event_type: string;
  evidence_class: "official";
  source_id: "ercot_operations_messages";
  source_url: typeof ERCOT_OPERATIONS_MESSAGES_URL;
  status: string;
  title: string;
};

export type EeaStateEvidence = {
  condition_note: string;
  eea_level: 0 | 1 | 2 | 3;
  evidence_class: "source_observation";
  source_epoch: number;
  source_id: "ercot_daily_prc";
  source_url: typeof ERCOT_DAILY_PRC_URL;
  state: string;
  time_basis: "source_snapshot_epoch_not_official_declaration_time";
  title: string;
};

export type GridEventStream = "derived_annotations" | "eea" | "operations_messages";
export type GridEventIngestEvent = {
  body: string | null;
  derivation: null | {
    input_identities: string[];
    method: string;
    version: string;
  };
  ends_at: number | null;
  event_type: string;
  identity: string;
  observed_at: number;
  severity: string | null;
  source_updated_at: number;
  source_url: string;
  starts_at: number | null;
  starts_at_candidates: number[];
  status: string | null;
  title: string;
  time_basis:
    | "america_chicago_wall_ambiguous"
    | "derived_from_input_utc"
    | "source_snapshot_epoch_not_official_declaration_time"
    | "utc_exact";
};
export type GridEventPublication = {
  events: GridEventIngestEvent[];
  schema: typeof GRID_EVENTS_SCHEMA;
  stream: GridEventStream;
};

export function buildOperationsGridEvent(
  evidence: OperationsMessageEvidence,
  retrievedAt: number,
): GridEventIngestEvent {
  return {
    body: evidence.body === evidence.title ? null : evidence.body,
    derivation: null,
    ends_at: null,
    event_type: evidence.event_type,
    identity: evidence.dedupe_key,
    observed_at: retrievedAt,
    severity: null,
    source_updated_at: retrievedAt,
    source_url: evidence.source_url,
    starts_at: evidence.starts_at,
    starts_at_candidates: evidence.candidates,
    status: evidence.status,
    title: evidence.title,
    time_basis: evidence.starts_at === null ? "america_chicago_wall_ambiguous" : "utc_exact",
  };
}

async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildEeaGridEvent(
  state: EeaStateEvidence,
  retrievedAt: number,
): Promise<GridEventIngestEvent> {
  const identityHash = await digest([
    state.source_epoch,
    state.eea_level,
    state.state,
    state.title,
    state.condition_note,
  ]);
  return {
    body: state.condition_note,
    derivation: null,
    ends_at: null,
    event_type: `eea_level_${state.eea_level}_source_observation`,
    identity: `ercot_eea:state:${identityHash.slice(0, 32)}`,
    observed_at: retrievedAt,
    severity: null,
    source_updated_at: state.source_epoch,
    source_url: state.source_url,
    starts_at: state.source_epoch,
    starts_at_candidates: [state.source_epoch],
    status: state.state,
    title: state.title,
    time_basis: "source_snapshot_epoch_not_official_declaration_time",
  };
}

type Json = Record<string, unknown>;
function object(value: unknown, code: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Json;
}

export function parseEeaState(value: unknown): EeaStateEvidence {
  const current = object(
    object(value, "invalid_eea_payload").current_condition,
    "invalid_eea_state",
  );
  const level = current.eea_level;
  const epoch = current.datetime;
  if (!Number.isInteger(level) || Number(level) < 0 || Number(level) > 3) {
    throw new Error("invalid_eea_level");
  }
  if (!Number.isInteger(epoch) || Number(epoch) <= 0) {
    throw new Error("invalid_eea_epoch");
  }
  return {
    condition_note: text(current.condition_note, "invalid_eea_condition_note", 4_096),
    eea_level: Number(level) as 0 | 1 | 2 | 3,
    evidence_class: "source_observation",
    source_epoch: Number(epoch),
    source_id: "ercot_daily_prc",
    source_url: ERCOT_DAILY_PRC_URL,
    state: text(current.state, "invalid_eea_state", 80),
    time_basis: "source_snapshot_epoch_not_official_declaration_time",
    title: text(current.title, "invalid_eea_title", 500),
  };
}
