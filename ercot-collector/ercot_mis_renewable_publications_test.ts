import {
  buildRenewablePublicationPayload,
  collectRenewablePublications,
  extractSingleCsvZip,
  parseMisDocumentList,
  parseRenewableCsv,
  RENEWABLE_PRODUCTS,
  renewableSchemaFingerprint,
  type MisDocument,
  type RenewableProductId,
} from "./ercot_mis_renewable_publications.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    assert(
      error instanceof Error && error.message === expected,
      `expected ${expected}, got ${error}`,
    );
    return;
  }
  throw new Error(`expected ${expected}`);
}

async function assertRejects(fn: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof Error && error.message === expected,
      `expected ${expected}, got ${error}`,
    );
    return;
  }
  throw new Error(`expected ${expected}`);
}

function fixtureCsv(productId: RenewableProductId, rows = 216): string {
  const config = RENEWABLE_PRODUCTS[productId];
  const output = [config.headers.join(",")];
  for (let index = 0; index < rows; index++) {
    const day = 10 + Math.floor(index / 24);
    const hour = (index % 24) + 1;
    const values = Object.fromEntries(config.headers.map((header) => [header, "1"]));
    values.DELIVERY_DATE = `2026-01-${String(day).padStart(2, "0")}`;
    values.HOUR_ENDING = String(hour);
    values.DSTFlag = "N";
    values.SYSTEM_WIDE_GEN = index < 48 ? "777" : "";
    values.SYSTEM_WIDE_HSL = index < 48 ? String(500 + index) : "";
    for (const header of config.headers) {
      if (header.startsWith("GEN_LZ_")) values[header] = index < 48 ? "700" : "";
    }
    values[config.forecastField] = String(1_000 + index);
    output.push(config.headers.map((header) => values[header]).join(","));
  }
  return `${output.join("\n")}\n`;
}

function set16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function set32(bytes: Uint8Array, offset: number, value: number): void {
  set16(bytes, offset, value);
  set16(bytes, offset + 2, value >>> 16);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(text: string, name = "synthetic.csv"): Uint8Array {
  const data = new TextEncoder().encode(text);
  const filename = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + filename.length + data.length);
  set32(local, 0, 0x04034b50);
  set16(local, 4, 20);
  set16(local, 8, 0);
  set32(local, 14, crc32(data));
  set32(local, 18, data.length);
  set32(local, 22, data.length);
  set16(local, 26, filename.length);
  local.set(filename, 30);
  local.set(data, 30 + filename.length);

  const central = new Uint8Array(46 + filename.length);
  set32(central, 0, 0x02014b50);
  set16(central, 4, 20);
  set16(central, 6, 20);
  set16(central, 10, 0);
  set32(central, 16, crc32(data));
  set32(central, 20, data.length);
  set32(central, 24, data.length);
  set16(central, 28, filename.length);
  central.set(filename, 46);

  const eocd = new Uint8Array(22);
  set32(eocd, 0, 0x06054b50);
  set16(eocd, 8, 1);
  set16(eocd, 10, 1);
  set32(eocd, 12, central.length);
  set32(eocd, 16, local.length);
  const result = new Uint8Array(local.length + central.length + eocd.length);
  result.set(local);
  result.set(central, local.length);
  result.set(eocd, local.length + central.length);
  return result;
}

function document(
  docId: string,
  bytes: Uint8Array,
  time = "2026-08-18T10:00:00-05:00",
): MisDocument {
  return {
    docId,
    publishDate: time,
    issuedAt: Date.parse(time) / 1_000,
    constructedName: `synthetic_${docId}_csv.zip`,
    contentSize: bytes.length,
  };
}

Deno.test("sanitized IceDoc fixture selects only the public CSV ZIP", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL("./fixtures/ercot_mis_renewables/document_list.sample.json", import.meta.url),
    ),
  );
  const documents = parseMisDocumentList(fixture);
  assert(documents.length === 1);
  assert(documents[0]!.docId === "900001");
  assert(documents[0]!.issuedAt === 1_787_065_200);
});

Deno.test("strict renewable CSV contracts normalize forecast and HSL but never GEN", () => {
  for (const productId of ["NP4-732-CD", "NP4-737-CD"] as const) {
    const rows = parseRenewableCsv(productId, fixtureCsv(productId));
    assert(rows.length === 216);
    assert(rows[0]!.actual_hsl_mw === 500);
    assert(rows[0]!.raw_delivery_date === "2026-01-10");
    assert(rows[47]!.actual_hsl_mw === 547);
    assert(rows[48]!.actual_hsl_mw === null);
    assert(rows[215]!.forecast_mw === 1_215);
    assert(!("SYSTEM_WIDE_GEN" in rows[0]!));
    assert(rows[0]!.target_ts === Date.parse("2026-01-10T07:00:00Z") / 1_000);
  }
});

Deno.test("current 216 row split is evidence, not a parser invariant", () => {
  const rows = parseRenewableCsv("NP4-737-CD", fixtureCsv("NP4-737-CD", 24));
  assert(rows.length === 24);
  assert(rows.every((row) => row.actual_hsl_mw !== null));
});

Deno.test("schema drift, row width, invalid number and unsafe row count fail closed", () => {
  const valid = fixtureCsv("NP4-737-CD", 2);
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", valid.replace("PVGRPP_SYSTEM_WIDE", "PVGRPP_RENAMED")),
    "ercot_mis_schema_mismatch",
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", valid.replace(",N\n", "\n")),
    "ercot_mis_row_width_invalid",
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", valid.replace("1000", "NaN")),
    "ercot_mis_numeric_invalid",
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", valid.replace(",777,1,1000,1,", ",777,NaN,1000,1,")),
    "ercot_mis_numeric_invalid",
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", fixtureCsv("NP4-737-CD", 513)),
    "ercot_mis_row_count_invalid",
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", valid.replaceAll("2026-01-10", "2026-02-30")),
    "ercot_mis_delivery_date_invalid",
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", valid.replace("1000", "-1")),
    "ercot_mis_numeric_invalid",
  );
  const lines = valid.trimEnd().split("\n");
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", `${lines[0]}\n${lines[1]}\n${lines[1]}\n`),
    "ercot_mis_target_order_invalid",
  );
});

Deno.test("fall repeated HE2 and spring missing HE2 derive exact UTC interval ends", () => {
  const config = RENEWABLE_PRODUCTS["NP4-737-CD"];
  const make = (date: string, hour: string, flag: string) => {
    const values = Object.fromEntries(config.headers.map((header) => [header, "1"]));
    Object.assign(values, {
      DELIVERY_DATE: date,
      HOUR_ENDING: hour,
      DSTFlag: flag,
      SYSTEM_WIDE_HSL: "",
    });
    return `${config.headers.join(",")}\n${config.headers.map((header) => values[header]).join(",")}\n`;
  };
  assert(
    parseRenewableCsv("NP4-737-CD", make("2025-11-02", "2", "N"))[0]!.target_ts === 1_762_066_800,
  );
  assert(
    parseRenewableCsv("NP4-737-CD", make("2025-11-02", "2", "Y"))[0]!.target_ts === 1_762_070_400,
  );
  assertThrows(
    () => parseRenewableCsv("NP4-737-CD", make("2026-03-08", "2", "N")),
    "ercot_public_load_target_timestamp_invalid",
  );
});

Deno.test("schema fingerprint is stable ordered-header SHA-256", async () => {
  assert((await renewableSchemaFingerprint("NP4-732-CD")).length === 64);
  assert(
    (await renewableSchemaFingerprint("NP4-732-CD")) !==
      (await renewableSchemaFingerprint("NP4-737-CD")),
  );
});

Deno.test("bounded single-entry ZIP extracts exact CSV and rejects path or multiple entries", async () => {
  const csv = fixtureCsv("NP4-737-CD", 2);
  assert((await extractSingleCsvZip(storedZip(csv))) === csv);
  await assertRejects(
    () => extractSingleCsvZip(storedZip(csv, "../escape.csv")),
    "ercot_mis_zip_name_invalid",
  );
  const two = storedZip(csv);
  set16(two, two.length - 14, 2);
  set16(two, two.length - 12, 2);
  await assertRejects(() => extractSingleCsvZip(two), "ercot_mis_zip_entries_invalid");
});

Deno.test("publication identity is official document metadata and rows exclude raw source extras", async () => {
  const csv = fixtureCsv("NP4-732-CD", 2);
  const bytes = storedZip(csv);
  const doc = document("900101", bytes);
  const payload = await buildRenewablePublicationPayload(
    "NP4-732-CD",
    doc,
    parseRenewableCsv("NP4-732-CD", csv),
    1_787_065_800,
  );
  assert(payload.publication.publication_key === "900101");
  assert(payload.publication.issued_at === 1_787_065_200);
  assert(payload.publication.declared_unit === "MW");
  assert(
    Object.keys(payload.rows[0]!).sort().join(",") ===
      "actual_hsl_mw,delivery_date,dst_flag,forecast_mw,hour_ending,raw_delivery_date,raw_dst_flag,raw_hour_ending,target_ts",
  );
});

Deno.test("collector processes documents oldest-first, skips overlap and stops before unsafe accumulation", async () => {
  const windZip = storedZip(fixtureCsv("NP4-732-CD", 2));
  const solarZip = storedZip(fixtureCsv("NP4-737-CD", 2));
  const documents = new Map([
    ["11", document("11", solarZip, "2026-08-18T11:00:00-05:00")],
    ["10", document("10", windZip, "2026-08-18T10:00:00-05:00")],
  ]);
  const ingested: string[] = [];
  const result = await collectRenewablePublications(
    {
      list(reportTypeId) {
        const doc = reportTypeId === 13028 ? documents.get("10")! : documents.get("11")!;
        return Promise.resolve({
          docs: [
            {
              DocID: doc.docId,
              PublishDate: doc.publishDate,
              ConstructedName: doc.constructedName,
              ContentSize: doc.contentSize,
              SecurityStatus: "P",
              Extension: "zip",
              FriendlyName: `${doc.constructedName.slice(0, -4)}`,
            },
          ],
        });
      },
      download(doc) {
        return Promise.resolve(doc.docId === "10" ? windZip : solarZip);
      },
      ingest(payload) {
        ingested.push(payload.publication.document_id);
        return Promise.resolve();
      },
    },
    {
      checkpoint: {
        overlapDocIds: ["11"],
        highWater: {
          "NP4-732-CD": { issuedAt: 0, docId: "0" },
          "NP4-737-CD": documents.get("11")!,
        },
      },
      retrievedAt: 1_787_070_000,
    },
  );
  assert(ingested.join(",") === "10,11");
  assert(result.processed.join(",") === "10,11");
  assert(result.rowCount === 4);
  assert(result.products["NP4-732-CD"].rowCount === 2);
  assert(result.products["NP4-737-CD"].rowCount === 2);

  await assertRejects(
    () =>
      collectRenewablePublications(
        {
          list(reportTypeId) {
            return Promise.resolve({
              docs: [1, 2].map((n) => ({
                DocID: `${reportTypeId}${n}`,
                PublishDate: `2026-08-18T1${n}:00:00-05:00`,
                ConstructedName: `x_${reportTypeId}_${n}_csv.zip`,
                ContentSize: 10,
                SecurityStatus: "P",
                Extension: "zip",
                FriendlyName: `x_${n}_csv`,
              })),
            });
          },
          download() {
            throw new Error("must fail before download");
          },
          ingest() {
            throw new Error("must fail before ingest");
          },
        },
        { retrievedAt: 1_787_070_000, maximumDocuments: 3 },
      ),
    "must fail before download",
  );
});

Deno.test("fresh documents outrank overlap replay and numeric DocIDs advance high-water", async () => {
  const windZip = storedZip(fixtureCsv("NP4-732-CD", 2));
  const solarZip = storedZip(fixtureCsv("NP4-737-CD", 2));
  let generation = 0;
  const ingested: string[] = [];
  const transport = {
    list(reportTypeId: number) {
      const ids =
        reportTypeId === 13028
          ? generation === 0
            ? ["9"]
            : ["9", "10"]
          : generation === 0
            ? ["19"]
            : ["19", "20"];
      return Promise.resolve({
        docs: ids.map((id) => ({
          DocID: id,
          PublishDate: "2026-08-18T10:00:00-05:00",
          ConstructedName: `x_${id}_csv.zip`,
          ContentSize: reportTypeId === 13028 ? windZip.length : solarZip.length,
          SecurityStatus: "P",
          Extension: "zip",
          FriendlyName: `x_${id}_csv`,
          ReportTypeID: reportTypeId,
        })),
      });
    },
    download(doc: MisDocument) {
      return Promise.resolve(["9", "10"].includes(doc.docId) ? windZip : solarZip);
    },
    ingest(payload: { publication: { document_id: string } }) {
      ingested.push(payload.publication.document_id);
      return Promise.resolve();
    },
  };
  const first = await collectRenewablePublications(transport, {
    retrievedAt: 1_787_066_000,
    maximumDocuments: 2,
  });
  assert(first.processed.join(",") === "9,19");
  generation = 1;
  ingested.length = 0;
  const second = await collectRenewablePublications(transport, {
    checkpoint: first.checkpoint,
    retrievedAt: 1_787_070_000,
    maximumDocuments: 2,
  });
  assert(second.processed.join(",") === "10,20");
  assert(ingested.join(",") === "10,20");
  assert(second.backlogCount === 0);
  assert(second.products["NP4-732-CD"].processedDocuments === 1);
  assert(second.products["NP4-737-CD"].processedDocuments === 1);
  assert(second.checkpoint.highWater?.["NP4-732-CD"]?.docId === "10");
});
