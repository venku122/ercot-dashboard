import { parseStorage } from "./storage.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type StoragePayload = Parameters<typeof parseStorage>[0];

function localTimestamp(epochSeconds: number) {
  return `${new Date((epochSeconds - 5 * 3_600) * 1_000).toISOString().slice(0, 19).replace("T", " ")}-0500`;
}

function storageRow(
  epochSeconds: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const timestamp = localTimestamp(epochSeconds);
  return {
    dstFlag: "N",
    epoch: epochSeconds * 1_000,
    netOutput: -60,
    tagCLastTime: timestamp.slice(0, 19),
    timestamp,
    totalCharging: -80,
    totalDischarging: 20,
    ...overrides,
  };
}

function storagePayload(data: Array<Record<string, unknown>> = [storageRow(1_784_610_000)]) {
  return {
    currentDay: { data, dayDate: "2026-07-21 03:00:00-0500" },
    lastUpdated: "2026-07-21 05:11:00-0500",
    previousDay: { data: [], dayDate: "2026-07-20 03:00:00-0500" },
  };
}

async function assertRejected(payload: unknown, message: string) {
  let rejected = false;
  try {
    await parseStorage(payload as StoragePayload);
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

Deno.test("PR16 storage freshness follows the newest observation, not the envelope", async () => {
  const result = await parseStorage(
    storagePayload([
      storageRow(1_784_610_000, {
        netOutput: -749.355,
        totalCharging: -861.639,
        totalDischarging: 112.284,
      }),
      storageRow(1_784_610_300, {
        netOutput: -230.27,
        totalCharging: -501.03,
        totalDischarging: 270.76,
      }),
    ]) as StoragePayload,
  );
  assert(result.sourceTimestamp === 1_784_628_660, "envelope timestamp retained");
  assert(result.dataTimestamp === 1_784_610_300, "freshness uses newest observation epoch");
  assert(result.metrics.length === 3, "exact three aggregate series emitted");
  assert(
    result.metrics.every((metric) => metric.points.at(-1)?.timestamp === result.dataTimestamp),
    "all aggregate series end at the data timestamp",
  );
});

Deno.test("PR16 storage parser rejects incoherent source rows", async () => {
  const malformedRows = [
    [storageRow(1_784_610_000, { timestamp: "2026-07-21 00:05:00-0500" })],
    [storageRow(1_784_610_000), storageRow(1_784_610_000)],
    [storageRow(1_784_610_001)],
    [storageRow(1_784_610_000, { netOutput: -55 })],
  ];
  for (const data of malformedRows) {
    await assertRejected(
      storagePayload(data),
      "timestamp, duplicate, alignment, or source-balance violation rejected",
    );
  }
});

Deno.test("PR16 storage parser enforces exact payload, day, and row keys", async () => {
  const extraTop = { ...storagePayload(), unexpected: true };
  const missingTop = structuredClone(storagePayload()) as Record<string, unknown>;
  delete missingTop.previousDay;
  const extraDay = structuredClone(storagePayload());
  Object.assign(extraDay.currentDay, { unexpected: true });
  const missingDay = structuredClone(storagePayload());
  delete (missingDay.currentDay as { dayDate?: unknown }).dayDate;
  const extraRow = storagePayload([storageRow(1_784_610_000, { unexpected: true })]);
  const missingRow = storagePayload();
  delete missingRow.currentDay.data[0]!.tagCLastTime;

  for (const payload of [extraTop, missingTop, extraDay, missingDay, extraRow, missingRow]) {
    await assertRejected(payload, "exact source key allowlists are enforced at every level");
  }
});

Deno.test("PR16 storage parser requires 13-digit integer millisecond epochs", async () => {
  for (const epoch of ["1784610000000", 178_461_000_000, 1_784_610_000_000.5]) {
    await assertRejected(
      storagePayload([storageRow(1_784_610_000, { epoch })]),
      "malformed epoch rejected",
    );
  }
});

Deno.test("PR16 storage parser requires timestamps with explicit numeric offsets", async () => {
  for (const timestamp of ["2026-07-21 00:00:00", "2026-07-21T05:00:00Z"]) {
    await assertRejected(
      storagePayload([storageRow(1_784_610_000, { timestamp })]),
      "timestamp without source numeric offset rejected",
    );
  }
});

Deno.test("PR16 storage parser bounds the two-day payload", async () => {
  const data = Array.from({ length: 601 }, (_, index) => storageRow(1_784_610_000 + index * 300));
  await assertRejected(
    storagePayload(data),
    "payloads above the two-day 600-row bound are rejected",
  );
});
