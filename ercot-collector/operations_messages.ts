import {
  fetch,
  headers,
  type NormalizedEvent,
  payloadHash,
  runSourceLoop,
  type SourceAdapter,
  type SourceResult,
} from "./_lib.ts";
import {
  buildOperationsGridEvent,
  ERCOT_OPERATIONS_MESSAGES_URL,
  type OperationsMessageEvidence,
  parseCentralWallTime,
} from "./grid_events.ts";

const SOURCE_ID = "operations_messages";
const URL = ERCOT_OPERATIONS_MESSAGES_URL;

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function bounded(value: string, code: string, maximum: number) {
  if (!value || new TextEncoder().encode(value).length > maximum) {
    throw new Error(code);
  }
  return value;
}

function titleFor(summary: string) {
  if (new TextEncoder().encode(summary).length <= 500) return summary;
  let title = "";
  for (const character of summary) {
    if (new TextEncoder().encode(`${title}${character}...`).length > 500) break;
    title += character;
  }
  return `${title}...`;
}

export function parseOperationsTimestamp(value: string): number {
  const parsed = parseCentralWallTime(value);
  if (parsed.starts_at === null) {
    throw new Error("ambiguous_operations_timestamp");
  }
  return parsed.starts_at;
}

export async function parseOperationsMessages(
  html: string,
  retrievedAt = Math.floor(Date.now() / 1_000),
): Promise<SourceResult> {
  const events: NormalizedEvent[] = [];
  const gridEvents = [];
  const ambiguous = [];
  const sourceCandidates: number[] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const [, row] of html.matchAll(rowPattern)) {
    const cells = [...row.matchAll(/<td\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/td>/gi)];
    const values = new Map(cells.map((cell) => [cell[1].trim(), decodeHtml(cell[2])]));
    const datetime = values.get("datetime");
    const summary = values.get("summary");
    const type = values.get("type");
    const status = values.get("priority");
    if (!datetime || !summary || !type) continue;
    bounded(summary, "operations_message_summary_too_large", 10_000);
    bounded(type, "operations_message_type_too_large", 120);
    if (status) bounded(status, "operations_message_status_too_large", 80);
    const wallTime = parseCentralWallTime(datetime);
    sourceCandidates.push(...wallTime.candidates);
    const keyMaterial = `${datetime}|${summary}|${type}`;
    const key = (await payloadHash(keyMaterial)).slice(0, 32);
    const dedupeKey = `${SOURCE_ID}:${key}`;
    const evidence: OperationsMessageEvidence = {
      ...wallTime,
      body: summary,
      dedupe_key: dedupeKey,
      event_type: type,
      evidence_class: "official",
      source_id: "ercot_operations_messages",
      source_url: URL,
      status: status ?? "Unknown",
      title: titleFor(summary),
    };
    const gridEvent = buildOperationsGridEvent(evidence, retrievedAt);
    gridEvents.push(gridEvent);
    if (wallTime.starts_at === null) {
      ambiguous.push({
        candidates: wallTime.candidates,
        dedupe_key: dedupeKey,
        source_wall_time: wallTime.source_wall_time,
      });
      continue;
    }
    events.push({
      dedupe_key: dedupeKey,
      external_key: key,
      source_id: SOURCE_ID,
      starts_at: wallTime.starts_at,
      observed_at: retrievedAt,
      event_type: type,
      status: status ?? "Unknown",
      severity: /emergency|warning|watch/i.test(summary) ? "warning" : "info",
      title: titleFor(summary),
      body: summary,
      metadata: {
        source_url: URL,
        source_datetime: datetime,
        time_basis: wallTime.time_basis,
      },
    });
  }
  if (!events.length && !ambiguous.length) {
    throw new Error("operations_messages_zero_core_rows");
  }
  const sourceTimestamp = Math.max(...sourceCandidates);
  return {
    metrics: [],
    events,
    sourceTimestamp,
    payloadHash: await payloadHash(html),
    gridEvents,
    gridEventStream: "operations_messages",
    diagnostics: {
      ambiguous_wall_times: ambiguous,
      ambiguous_wall_time_count: ambiguous.length,
      events: events.length,
    },
  };
}

async function gather() {
  const html = await fetch(URL, headers("text/html")).then((response) => response.text());
  return parseOperationsMessages(html);
}

export const adapter: SourceAdapter = {
  sourceId: SOURCE_ID,
  displayName: "ERCOT Operations Messages",
  expectedIntervalSeconds: 180,
  publicationMode: "event",
  gather,
};

export async function start() {
  await runSourceLoop(adapter, 30);
}

if (import.meta.main) await start();
