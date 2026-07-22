import {
  fetch,
  headers,
  payloadHash,
  runSourceLoop,
  type NormalizedEvent,
  type SourceAdapter,
  type SourceResult,
} from "./_lib.ts";

const SOURCE_ID = "operations_messages";
const URL = "https://www.ercot.com/services/comm/mkt_notices/opsmessages/index";

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

function centralOffsetSuffix(date: Date): string {
  const year = date.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const novemberFirst = new Date(Date.UTC(year, 10, 1));
  const secondSundayMarch = 8 + ((7 - marchFirst.getUTCDay()) % 7);
  const firstSundayNovember = 1 + ((7 - novemberFirst.getUTCDay()) % 7);
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const daylight =
    (month > 2 && month < 10) ||
    (month === 2 && (day > secondSundayMarch || (day === secondSundayMarch && hour >= 2))) ||
    (month === 10 && (day < firstSundayNovember || (day === firstSundayNovember && hour < 2)));
  return daylight ? "-0500" : "-0600";
}

export function parseOperationsTimestamp(value: string): number {
  const provisional = new Date(`${value} UTC`);
  if (!Number.isFinite(provisional.valueOf())) throw new Error("invalid_operations_timestamp");
  const parsed = Date.parse(`${value} GMT${centralOffsetSuffix(provisional)}`);
  if (!Number.isFinite(parsed)) throw new Error("invalid_operations_timestamp");
  return Math.floor(parsed / 1000);
}

export async function parseOperationsMessages(html: string): Promise<SourceResult> {
  const events: NormalizedEvent[] = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const [, row] of html.matchAll(rowPattern)) {
    const cells = [...row.matchAll(/<td\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/td>/gi)];
    const values = new Map(cells.map((cell) => [cell[1].trim(), decodeHtml(cell[2])]));
    const datetime = values.get("datetime");
    const summary = values.get("summary");
    const type = values.get("type");
    const status = values.get("priority");
    if (!datetime || !summary || !type) continue;
    const startsAt = parseOperationsTimestamp(datetime);
    const keyMaterial = `${datetime}|${summary}|${type}`;
    const key = (await payloadHash(keyMaterial)).slice(0, 32);
    events.push({
      dedupe_key: `${SOURCE_ID}:${key}`,
      external_key: key,
      source_id: SOURCE_ID,
      starts_at: startsAt,
      observed_at: startsAt,
      event_type: type,
      status: status ?? "Unknown",
      severity: /emergency|warning|watch/i.test(summary) ? "warning" : "info",
      title: summary.length > 180 ? `${summary.slice(0, 177)}...` : summary,
      body: summary,
      metadata: { source_url: URL, source_datetime: datetime },
    });
  }
  if (!events.length) throw new Error("operations_messages_zero_core_rows");
  const sourceTimestamp = Math.max(...events.map((event) => event.starts_at));
  return {
    metrics: [],
    events,
    sourceTimestamp,
    payloadHash: await payloadHash(html),
    diagnostics: { events: events.length },
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
