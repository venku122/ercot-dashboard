export const LONG_HORIZON_POLICY =
  "official_planning_snapshots_not_committed_capacity_or_realization_forecast";
export const LONG_HORIZON_PARSER_VERSION = "ercot-long-horizon-v1";

export type LongHorizonStream = "resource_capacity_trend" | "gis_aggregates";
export type GisAggregate = Readonly<{
  phase: string;
  fuel: string;
  count: number;
  capacity_mw: number;
}>;
export type CapacityRow = Readonly<{
  official_total_mw: number;
  operational_mw: number;
  ia_financial_security_posted_mw: number;
  ia_no_financial_security_mw: number;
  other_planned_mw: number | null;
  small_generator_mw: number;
}>;
export type CapacitySeries = Readonly<{
  series_id: string;
  annual: readonly (CapacityRow & { year: number })[];
  planned_monthly: readonly (CapacityRow & { month: string })[];
}>;

export type Cell = string | number;
export type Sheet = ReadonlyMap<number, ReadonlyMap<string, Cell>>;
export type Workbook = ReadonlyMap<string, Sheet>;

const GIS_SHEETS = Object.freeze([
  "Contents",
  "Disclaimer and References",
  "Acronyms",
  "Summary",
  "Project Details - Large Gen",
  "Project Details - Small Gen",
  "GIM Trends",
  "data_GIM Trends_1",
  "data_GIM Trends_2",
  "data_GIM Trends_3",
  "data_GIM Trends_4",
  "Commissioning Update",
  "Inactive Projects",
  "Cancellation Update",
]);
const TREND_SHEETS = Object.freeze([
  "Wind Chart",
  "Solar Chart",
  "Battery Chart",
  "Gas-Combined Cycle Chart",
  "Gas-Other Chart",
]);
const GIS_PHASES = new Map([
  ["SS Started, FIS Not Started, No IA", "ss_started_fis_not_started_no_ia"],
  ["SS Started, FIS Started, No IA", "ss_started_fis_started_no_ia"],
  ["SS Completed, FIS Not Started, No IA", "ss_completed_fis_not_started_no_ia"],
  ["SS Completed, FIS Started, No IA", "ss_completed_fis_started_no_ia"],
  ["SS Completed, FIS Completed, No IA", "ss_completed_fis_completed_no_ia"],
  ["SS Started, FIS Not Started, IA", "ss_started_fis_not_started_ia"],
  ["SS Started, FIS Started, IA", "ss_started_fis_started_ia"],
  ["SS Completed, FIS Not Started, IA", "ss_completed_fis_not_started_ia"],
  ["SS Completed, FIS Started, IA", "ss_completed_fis_started_ia"],
  ["SS Completed, FIS Completed, IA", "ss_completed_fis_completed_ia"],
]);
const GIS_FUELS = new Map([
  ["BIO", "biomass"],
  ["COA", "coal"],
  ["GAS", "gas"],
  ["GEO", "geothermal"],
  ["HYD", "hydrogen"],
  ["NUC", "nuclear"],
  ["OIL", "fuel_oil"],
  ["OTH", "other"],
  ["PET", "petcoke"],
  ["SOL", "solar"],
  ["WAT", "water"],
  ["WIN", "wind"],
]);
const TREND_FUELS = new Map([
  ["Wind Chart", "wind"],
  ["Solar Chart", "solar"],
  ["Battery Chart", "battery"],
  ["Gas-Combined Cycle Chart", "gas_combined_cycle"],
  ["Gas-Other Chart", "gas_other"],
]);
export const GIS_PHASE_REGISTRY = Object.freeze(
  [...GIS_PHASES]
    .map(([label, id]) => Object.freeze({ id, label }))
    .concat([Object.freeze({ id: "small_generator", label: "Small Generator" })]),
);
const GIS_FUEL_LABELS = new Map([
  ["BIO", "Biomass"],
  ["COA", "Coal"],
  ["GAS", "Gas"],
  ["GEO", "Geothermal"],
  ["HYD", "Hydrogen"],
  ["NUC", "Nuclear"],
  ["OIL", "Fuel Oil"],
  ["OTH", "Other"],
  ["PET", "Petcoke"],
  ["SOL", "Solar"],
  ["WAT", "Water"],
  ["WIN", "Wind"],
]);
export const GIS_FUEL_REGISTRY = Object.freeze(
  [...GIS_FUELS].map(([code, id]) =>
    Object.freeze({ code, id, label: GIS_FUEL_LABELS.get(code)! }),
  ),
);
export const CAPACITY_SERIES_LABELS = Object.freeze(
  new Map([
    ["wind", "Wind"],
    ["solar", "Solar"],
    ["battery", "Battery"],
    ["gas_combined_cycle", "Gas - Combined Cycle"],
    ["gas_other", "Gas - Other"],
  ]),
);
const MAX_XLSX_BYTES = 8 * 1024 * 1024;
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 128;

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function xmlText(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g, (match, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return (
      { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" } as Record<
        string,
        string
      >
    )[match]!;
  });
}

async function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
  if (!bytes.length || bytes.length > MAX_XLSX_BYTES) throw new Error("long_horizon_xlsx_size");
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("long_horizon_xlsx_zip");
  const count = u16(bytes, eocd + 10);
  if (!count || count > MAX_ENTRIES || u16(bytes, eocd + 8) !== count)
    throw new Error("long_horizon_xlsx_entries");
  let central = u32(bytes, eocd + 16);
  let total = 0;
  const result = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    if (u32(bytes, central) !== 0x02014b50) throw new Error("long_horizon_xlsx_zip");
    const flags = u16(bytes, central + 8),
      method = u16(bytes, central + 10);
    const expectedCrc = u32(bytes, central + 16),
      compressedSize = u32(bytes, central + 20);
    const plainSize = u32(bytes, central + 24),
      nameLength = u16(bytes, central + 28);
    const extraLength = u16(bytes, central + 30),
      commentLength = u16(bytes, central + 32);
    const local = u32(bytes, central + 42);
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      plainSize > MAX_XML_BYTES ||
      total + plainSize > MAX_XML_BYTES
    )
      throw new Error("long_horizon_xlsx_entry");
    const name = new TextDecoder().decode(bytes.slice(central + 46, central + 46 + nameLength));
    if (!/^[A-Za-z0-9_./[\]-]+$/.test(name) || name.includes("..") || result.has(name))
      throw new Error("long_horizon_xlsx_name");
    if (
      u32(bytes, local) !== 0x04034b50 ||
      u16(bytes, local + 6) !== flags ||
      u16(bytes, local + 8) !== method
    )
      throw new Error("long_horizon_xlsx_zip");
    const localNameLength = u16(bytes, local + 26),
      start = local + 30 + localNameLength + u16(bytes, local + 28);
    if (start + compressedSize > bytes.length) throw new Error("long_horizon_xlsx_zip");
    const compressed = bytes.slice(start, start + compressedSize);
    let plain = compressed;
    if (method === 8) {
      const stream = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      plain = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (plain.length !== plainSize || crc32(plain) !== expectedCrc)
      throw new Error("long_horizon_xlsx_integrity");
    total += plain.length;
    if (name.endsWith(".xml") || name.endsWith(".rels"))
      result.set(name, new TextDecoder("utf-8", { fatal: true }).decode(plain));
    central += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

function attr(tag: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name.replace(":", "(?::|\\\\:)")}="([^"]*)"`).exec(tag);
  if (!match) throw new Error("long_horizon_xlsx_schema");
  return xmlText(match[1]!);
}
function parseStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
      .map((part) => xmlText(part[1]!))
      .join(""),
  );
}
function parseSheet(xml: string, strings: readonly string[]): Sheet {
  const rows = new Map<number, ReadonlyMap<string, Cell>>();
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attr(rowMatch[1]!, "r"));
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 100_000 || rows.has(rowNumber))
      throw new Error("long_horizon_xlsx_row");
    const cells = new Map<string, Cell>();
    for (const cellMatch of rowMatch[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cellMatch[1]!, "r"),
        column = /^([A-Z]{1,3})\d+$/.exec(ref)?.[1];
      if (!column || cells.has(column)) throw new Error("long_horizon_xlsx_cell");
      const body = cellMatch[2] ?? "";
      const type = /(?:^|\s)t="([^"]+)"/.exec(cellMatch[1]!)?.[1];
      if (/<f(?:\s|>)/.test(body) && type && type !== "n")
        throw new Error("long_horizon_xlsx_cell");
      let value: Cell;
      if (type === "inlineStr")
        value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
          .map((x) => xmlText(x[1]!))
          .join("");
      else {
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (raw === undefined) continue;
        if (type === "s") {
          const i = Number(raw);
          if (!Number.isInteger(i) || strings[i] === undefined)
            throw new Error("long_horizon_xlsx_string");
          value = strings[i]!;
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n)) throw new Error("long_horizon_xlsx_number");
          value = Object.is(n, -0) ? 0 : n;
        }
      }
      cells.set(column, value);
    }
    rows.set(rowNumber, cells);
  }
  return rows;
}

export async function parseXlsx(bytes: Uint8Array): Promise<Workbook> {
  const files = await unzip(bytes),
    workbookXml = files.get("xl/workbook.xml"),
    relsXml = files.get("xl/_rels/workbook.xml.rels");
  if (!workbookXml || !relsXml) throw new Error("long_horizon_xlsx_schema");
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g))
    targets.set(attr(match[1]!, "Id"), attr(match[1]!, "Target").replace(/^\//, ""));
  const strings = parseStrings(files.get("xl/sharedStrings.xml")),
    result = new Map<string, Sheet>();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const name = attr(match[1]!, "name"),
      id = attr(match[1]!, "r:id");
    let target = targets.get(id);
    if (!target) throw new Error("long_horizon_xlsx_schema");
    if (!target.startsWith("xl/")) target = `xl/${target}`;
    const xml = files.get(target);
    if (!xml || result.has(name)) throw new Error("long_horizon_xlsx_schema");
    result.set(name, parseSheet(xml, strings));
  }
  return result;
}

function exactSheets(workbook: Workbook, expected: readonly string[]): void {
  if (JSON.stringify([...workbook.keys()]) !== JSON.stringify(expected))
    throw new Error("long_horizon_sheet_schema");
}
function text(row: ReadonlyMap<string, Cell> | undefined, column: string): string {
  const value = row?.get(column);
  if (typeof value !== "string" || value.trim() !== value || !value)
    throw new Error("long_horizon_text");
  return value;
}
function mw(row: ReadonlyMap<string, Cell>, column: string, allowNegative: boolean): number {
  const value = row.get(column);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1_000_000 ||
    (!allowNegative && value < 0)
  )
    throw new Error("long_horizon_capacity");
  return value;
}
function add(target: Map<string, { count: number; mw: number }>, key: string, value: number): void {
  const item = target.get(key) ?? { count: 0, mw: 0 };
  item.count++;
  item.mw += value;
  target.set(key, item);
}

export function aggregateGisWorkbook(workbook: Workbook, sourceMonth: string): GisAggregate[] {
  exactSheets(workbook, GIS_SHEETS);
  if (!/^\d{4}-\d{2}$/.test(sourceMonth)) throw new Error("long_horizon_source_month");
  const large = workbook.get("Project Details - Large Gen")!,
    small = workbook.get("Project Details - Small Gen")!;
  const lh = large.get(31),
    sh = small.get(15);
  for (const [col, expected] of [
    ["A", "INR"],
    ["C", "GIM Study Phase"],
    ["I", "Fuel"],
    ["K", "Capacity (MW)"],
  ] as const)
    if (text(lh, col) !== expected) throw new Error("long_horizon_gis_header");
  for (const [col, expected] of [
    ["A", "INR"],
    ["I", "Fuel"],
    ["K", "Capacity (MW)"],
  ] as const)
    if (text(sh, col) !== expected) throw new Error("long_horizon_gis_header");
  const aggregates = new Map<string, { count: number; mw: number }>();
  let rows = 0;
  for (const [number, row] of large) {
    if (number < 33 || row.get("A") === undefined) continue;
    const phaseKey = GIS_PHASES.get(text(row, "C")),
      fuelKey = GIS_FUELS.get(text(row, "I"));
    if (!phaseKey || !fuelKey) throw new Error("long_horizon_gis_enum");
    const capacity = mw(row, "K", true);
    add(aggregates, `${phaseKey}\0${fuelKey}`, capacity);
    rows++;
  }
  for (const [number, row] of small) {
    if (number < 18 || row.get("A") === undefined) continue;
    const fuelKey = GIS_FUELS.get(text(row, "I"));
    if (!fuelKey) throw new Error("long_horizon_gis_enum");
    const capacity = mw(row, "K", true);
    add(aggregates, `small_generator\0${fuelKey}`, capacity);
    rows++;
  }
  if (!rows || rows > 10_000) throw new Error("long_horizon_gis_rows");
  const phaseOrder = new Map(GIS_PHASE_REGISTRY.map((row, index) => [row.id, index]));
  const fuelOrder = new Map(GIS_FUEL_REGISTRY.map((row, index) => [row.id, index]));
  return [...aggregates]
    .map(([key, value]) => {
      const [phase, fuel] = key.split("\0") as [string, string];
      return { phase, fuel, count: value.count, capacity_mw: value.mw };
    })
    .sort(
      (a, b) =>
        phaseOrder.get(a.phase)! - phaseOrder.get(b.phase)! ||
        fuelOrder.get(a.fuel)! - fuelOrder.get(b.fuel)!,
    );
}

function excelMonth(value: Cell): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 25_000 || value > 80_000)
    throw new Error("long_horizon_trend_month");
  const date = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
  return date.toISOString().slice(0, 7);
}
type ParsedCapacityRow = Readonly<{ period: string | number; values: CapacityRow }>;
function parseCapacityWorkbook(
  workbook: Workbook,
  monthly: boolean,
): Map<string, ParsedCapacityRow[]> {
  exactSheets(workbook, TREND_SHEETS);
  const result = new Map<string, ParsedCapacityRow[]>();
  for (const sheetName of TREND_SHEETS) {
    const sheet = workbook.get(sheetName)!;
    if (sheet.size > 10_500) throw new Error("long_horizon_trend_rows");
    const projectHeader = sheet.get(1);
    const projectColumns = [
      ["I", "INR"],
      ["J", "Project Name"],
      ["K", "County"],
      ["L", "Projected COD"],
      ["M", "IA Signed"],
      ["N", "Fuel"],
      ["O", "Technology"],
      ["P", "Capacity (MW)"],
      ["Q", "Year"],
      ["R", "Financial Security"],
    ] as const;
    for (const [column, label] of projectColumns)
      if (projectHeader?.get(column) !== label)
        throw new Error("long_horizon_trend_project_header");
    let header = 0;
    for (const [number, row] of sheet)
      if (row.get("A") === (monthly ? "Month/Year" : "Year")) {
        if (header) throw new Error("long_horizon_trend_header");
        header = number;
      }
    if (!header) throw new Error("long_horizon_trend_header");
    const h = sheet.get(header)!;
    const expected: [string, string][] = [
      [
        "B",
        monthly
          ? "Cumulative operational, No FS, and FS Posted"
          : "Cumulative Operational, No FS, and FS Posted",
      ],
      ["C", monthly ? "Cumulative MW Operational " : "Cumulative MW Operational"],
      ["D", "IA Signed-Financial Security Posted"],
      ["E", "IA Signed-No Financial Security"],
    ];
    for (const [column, label] of expected)
      if (h.get(column) !== label) throw new Error("long_horizon_trend_header");
    const hasOther = h.get("F") === "Other Planned";
    if (
      (hasOther && h.get("G") !== "Small Generator") ||
      (!hasOther && h.get("F") !== "Small Generator") ||
      (!hasOther && h.has("G"))
    )
      throw new Error("long_horizon_trend_header");
    let previous = "";
    const rows: ParsedCapacityRow[] = [];
    for (let number = header + 1; number <= Math.max(...sheet.keys()); number++) {
      const row = sheet.get(number);
      if (!row?.has("A")) continue;
      const rawPeriod = row.get("A")!;
      const period = monthly ? excelMonth(rawPeriod) : rawPeriod;
      if (
        (!monthly &&
          (typeof period !== "number" ||
            !Number.isInteger(period) ||
            period < 1900 ||
            period > 2200)) ||
        (previous && String(period) <= previous)
      )
        throw new Error("long_horizon_trend_order");
      previous = String(period);
      const rollup = mw(row, "B", false),
        operational = mw(row, "C", false),
        financial = mw(row, "D", false),
        noFinancial = mw(row, "E", false);
      const other = hasOther ? mw(row, "F", false) : null,
        small = mw(row, hasOther ? "G" : "F", false);
      if (Math.abs(rollup - operational - financial - noFinancial - (other ?? 0) - small) > 1e-6)
        throw new Error("long_horizon_trend_rollup");
      rows.push({
        period,
        values: {
          official_total_mw: rollup,
          operational_mw: operational,
          ia_financial_security_posted_mw: financial,
          ia_no_financial_security_mw: noFinancial,
          other_planned_mw: other,
          small_generator_mw: small,
        },
      });
    }
    result.set(TREND_FUELS.get(sheetName)!, rows);
  }
  return result;
}
export function aggregateCapacityTrendWorkbooks(
  annual: Workbook,
  plannedMonthly: Workbook,
): CapacitySeries[] {
  const annualRows = parseCapacityWorkbook(annual, false),
    monthlyRows = parseCapacityWorkbook(plannedMonthly, true);
  return [...TREND_FUELS.values()].map((series_id) => ({
    series_id,
    annual: annualRows
      .get(series_id)!
      .map((row) => ({ year: row.period as number, ...row.values })),
    planned_monthly: monthlyRows
      .get(series_id)!
      .map((row) => ({ month: row.period as string, ...row.values })),
  }));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
