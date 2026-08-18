import { ErcotApiClient, ErcotApiError, publicReportArtifactLinks } from "./ercot_api.ts";

const REQUIRED_PUBLIC_PRODUCTS = [
  "NP3-565-CD",
  "NP3-566-CD",
  "NP3-763-CD",
  "NP6-345-CD",
  "NP6-346-CD",
] as const;

const EXPECTED_ESR_FIELDS = [
  "AGCExecTime",
  "DSTFlag",
  "AGCExecTimeUTC",
  "systemDemand",
  "ESRChargingMW",
] as const;

type ProcessLike = {
  argv?: string[];
  env?: Record<string, string | undefined>;
  exit?: (code: number) => never;
};

function processRuntime(): ProcessLike | undefined {
  return (globalThis as unknown as { process?: ProcessLike }).process;
}

function requiredEnvironment(name: string): string {
  const value = typeof Deno === "undefined" ? processRuntime()?.env?.[name] : Deno.env.get(name);
  if (!value) {
    throw new ErcotApiError(`ercot_missing_environment_${name.toLowerCase()}`);
  }
  return value;
}

function texasLocalTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value(
    "minute",
  )}:${value("second")}`;
}

const nodeEntry = processRuntime()?.argv?.[1];
const isMain = import.meta.main || nodeEntry?.endsWith("ercot_api_live.ts");

if (isMain) {
  try {
    const client = new ErcotApiClient({
      credentials: {
        username: requiredEnvironment("ERCOT_API_USERNAME"),
        password: requiredEnvironment("ERCOT_API_PASSWORD"),
        publicSubscriptionKey: requiredEnvironment("ERCOT_PUBLIC_API_SUBSCRIPTION_KEY"),
        esrSubscriptionKey: requiredEnvironment("ERCOT_ESR_API_SUBSCRIPTION_KEY"),
      },
    });

    const inventory = await client.publicReports();
    if (inventory.reports.length === 0) {
      throw new ErcotApiError("ercot_public_inventory_empty");
    }
    const active = inventory.reports.filter((report) => report.status === "Active").length;
    const artifacts = inventory.reports.reduce(
      (count, report) => count + publicReportArtifactLinks(report).length,
      0,
    );
    if (active === 0 || artifacts === 0) {
      throw new ErcotApiError("ercot_public_inventory_semantically_empty");
    }
    const discoveredIds = new Set(
      inventory.reports.map((report) => report.emilId).filter((value) => typeof value === "string"),
    );
    const requiredFound = REQUIRED_PUBLIC_PRODUCTS.filter((id) => discoveredIds.has(id)).length;
    if (requiredFound !== REQUIRED_PUBLIC_PRODUCTS.length) {
      throw new ErcotApiError("ercot_required_public_products_missing");
    }
    console.log("AUTH: PASS");
    console.log("PUBLIC API: PASS");
    console.log(
      `PUBLIC PRODUCTS: ${inventory.reports.length} total, ${active} active, ${artifacts} artifacts`,
    );
    console.log(`REQUIRED PRODUCTS FOUND: ${requiredFound}/${REQUIRED_PUBLIC_PRODUCTS.length}`);

    const end = new Date(Date.now() - 10 * 60_000);
    const start = new Date(end.getTime() - 30_000);
    const from = texasLocalTimestamp(start);
    const to = texasLocalTimestamp(end);
    const esr = await client.esrCharging({
      AGCExecTimeFrom: from,
      AGCExecTimeTo: to,
    });
    const esrFieldNames = new Set(esr.fields.map((field) => field.name));
    if (
      esrFieldNames.size !== EXPECTED_ESR_FIELDS.length ||
      EXPECTED_ESR_FIELDS.some((name) => !esrFieldNames.has(name))
    ) {
      throw new ErcotApiError("ercot_esr_live_schema_unexpected");
    }
    console.log("ESR API: PASS");
    console.log(`ESR FIELD DEFINITIONS: ${esr.fields.length}`);
    console.log(`ESR ROWS IN TEST WINDOW: ${esr.data.length}`);
    console.log(`ESR WINDOW: ${from} to ${to} America/Chicago`);
  } catch (error) {
    if (error instanceof ErcotApiError) {
      console.error(
        `ERCOT API LIVE: FAIL code=${error.code}${
          error.status === undefined ? "" : ` status=${error.status}`
        }`,
      );
    } else {
      console.error("ERCOT API LIVE: FAIL code=ercot_unexpected_error");
    }
    if (typeof Deno === "undefined") {
      processRuntime()?.exit?.(1);
    } else {
      Deno.exit(1);
    }
  }
}
