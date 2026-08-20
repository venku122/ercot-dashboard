import { parseEeaPayload } from "./eea.ts";
import { incrementalGridEvents, sourceResultAvailability } from "./_lib.ts";
import { GRID_EVENTS_POLICY, parseCentralWallTime, parseEeaState } from "./grid_events.ts";
import { parseOperationsMessages } from "./operations_messages.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function fixture(name: string) {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  const value = await Deno.readTextFile(url);
  return name.endsWith(".json") ? JSON.parse(value) : value;
}

Deno.test("Central wall times preserve exact, ambiguous, and nonexistent DST states", () => {
  equal(parseCentralWallTime("Mar 8, 2026 1:30:00 AM"), {
    candidates: [Date.parse("2026-03-08T01:30:00-06:00") / 1_000],
    source_wall_time: "Mar 8, 2026 1:30:00 AM",
    starts_at: Date.parse("2026-03-08T01:30:00-06:00") / 1_000,
    time_basis: "america_chicago_exact",
  });
  const ambiguous = parseCentralWallTime("Nov 1, 2026 1:30:00 AM");
  equal(ambiguous.starts_at, null);
  equal(ambiguous.time_basis, "america_chicago_wall_time_ambiguous");
  equal(ambiguous.candidates, [
    Date.parse("2026-11-01T01:30:00-05:00") / 1_000,
    Date.parse("2026-11-01T01:30:00-06:00") / 1_000,
  ]);
  let failed = false;
  try {
    parseCentralWallTime("Mar 8, 2026 2:30:00 AM");
  } catch (error) {
    failed = error instanceof Error && error.message === "nonexistent_operations_timestamp";
  }
  equal(failed, true);
});

Deno.test("operations publications retain official rows and explicit ambiguous candidates", async () => {
  const parsed = await parseOperationsMessages(
    await fixture("operations_messages.dst.html"),
    1_793_600_000,
  );
  equal(parsed.events.length, 1);
  equal(parsed.gridEvents?.length, 2);
  equal(parsed.gridEventStream, "operations_messages");
  equal(parsed.gridEvents?.[0]?.time_basis, "america_chicago_wall_ambiguous");
  equal(parsed.gridEvents?.[0]?.starts_at, null);
  equal(parsed.gridEvents?.[0]?.starts_at_candidates.length, 2);
  equal(parsed.gridEvents?.[0]?.source_updated_at, 1_793_600_000);
  equal(parsed.diagnostics?.ambiguous_wall_time_count, 1);
  equal(sourceResultAvailability(parsed).availability, "available");
});

Deno.test("operations status correction keeps identity and advances collector revision clock", async () => {
  const html = await fixture("operations_messages.success.html");
  const first = await parseOperationsMessages(html, 1_790_000_000);
  const corrected = await parseOperationsMessages(
    html.replace('<td class="priority">Active</td>', '<td class="priority">Cancelled</td>'),
    1_790_000_180,
  );
  equal(corrected.gridEvents?.[0]?.identity, first.gridEvents?.[0]?.identity);
  equal(first.gridEvents?.[0]?.status, "Active");
  equal(corrected.gridEvents?.[0]?.status, "Cancelled");
  equal(corrected.gridEvents?.[0]?.source_updated_at, 1_790_000_180);
  const initial = incrementalGridEvents("operations_messages", first.gridEvents ?? [], {
    events: {},
    high_water_ts: 0,
    high_water_ts_by_series: {},
    values: {},
    version: 2,
  });
  const repeated = incrementalGridEvents(
    "operations_messages",
    (await parseOperationsMessages(html, 1_790_000_180)).gridEvents ?? [],
    initial.checkpoint,
  );
  equal(repeated.events.length, 0);
  const revision = incrementalGridEvents(
    "operations_messages",
    corrected.gridEvents ?? [],
    repeated.checkpoint,
  );
  equal(revision.events.length, 1);
  equal(
    Object.keys(revision.checkpoint.events ?? {}).filter((key) =>
      key.startsWith("grid:operations_messages:"),
    ).length,
    corrected.gridEvents?.length,
  );
});

Deno.test("EEA snapshot preserves exact source fields without declaration-time attribution", async () => {
  const source = await fixture("eea.success.json");
  equal(GRID_EVENTS_POLICY, "multi_source_temporal_context_not_causal_attribution");
  equal(parseEeaState(source), {
    condition_note: "There is enough power for current demand.",
    eea_level: 0,
    evidence_class: "source_observation",
    source_epoch: 1_787_218_726,
    source_id: "ercot_daily_prc",
    source_url: "https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json",
    state: "normal",
    time_basis: "source_snapshot_epoch_not_official_declaration_time",
    title: "Normal Conditions",
  });
  const result = await parseEeaPayload(source, 1_787_218_800);
  equal(result.metrics[0]?.points[0]?.timestamp, 1_787_218_726);
  equal(result.gridEventStream, "eea");
  equal(result.gridEvents?.[0]?.time_basis, "source_snapshot_epoch_not_official_declaration_time");
  equal(result.gridEvents?.[0]?.starts_at_candidates, [1_787_218_726]);
  equal(result.gridEvents?.[0]?.event_type, "eea_level_0_source_observation");
  equal(result.provenance?.condition_note, "There is enough power for current demand.");
  const levelOne = structuredClone(source);
  levelOne.current_condition.datetime += 600;
  levelOne.current_condition.eea_level = 1;
  levelOne.current_condition.state = "eea1";
  levelOne.current_condition.title = "Energy Emergency Alert Level 1";
  levelOne.current_condition.condition_note = "Fixture EEA 1 source state.";
  const backToZero = structuredClone(source);
  backToZero.current_condition.datetime += 1_200;
  const sequence = await Promise.all([
    parseEeaPayload(source, 1_787_218_800),
    parseEeaPayload(levelOne, 1_787_219_400),
    parseEeaPayload(backToZero, 1_787_220_000),
  ]);
  equal(new Set(sequence.map((item) => item.gridEvents?.[0]?.identity)).size, 3);
  equal(
    sequence.map((item) => item.gridEvents?.[0]?.status),
    ["normal", "eea1", "normal"],
  );
  for (const level of [0, 1, 2, 3] as const) {
    const payload = structuredClone(source);
    payload.current_condition.datetime += level * 600;
    payload.current_condition.eea_level = level;
    const parsed = await parseEeaPayload(payload, 1_787_218_800 + level * 600);
    equal(parsed.gridEvents?.[0]?.event_type, `eea_level_${level}_source_observation`);
    equal(parsed.gridEvents?.[0]?.title, payload.current_condition.title);
    equal(parsed.gridEvents?.[0]?.body, payload.current_condition.condition_note);
  }
  for (const invalidLevel of [-1, 4, 1.5]) {
    const payload = structuredClone(source);
    payload.current_condition.eea_level = invalidLevel;
    let rejected = false;
    try {
      parseEeaState(payload);
    } catch (error) {
      rejected = error instanceof Error && error.message === "invalid_eea_level";
    }
    equal(rejected, true);
  }
});
