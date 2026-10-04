import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

const capturePath = process.env["SOURCE_REHEARSAL_CAPTURE"];
const allowed =
  /^\/api\/(?:v1|v2)\/(?:regional-geography|regional|market-mechanics|market-geography|forecast-quality)(?:\/|$)/;

export function readSourceCapture() {
  if (!capturePath) return null;
  if (statSync(capturePath).size > 8_000_000) throw new Error("bounded_capture_required");
  const bytes = readFileSync(capturePath);
  const responses = JSON.parse(bytes.toString()) as Record<string, any>;
  const records = JSON.parse(
    readFileSync(join(dirname(capturePath), "source-rehearsals.json"), "utf8"),
  ) as Array<{ family: string; exit_code: number; mode: string; production_delivery: boolean }>;
  for (const family of ["renewables", "regional", "market", "geography"]) {
    if (
      !records.some(
        (record) =>
          record.family === family &&
          record.exit_code === 0 &&
          record.mode === "ISOLATED_LOCAL_LIVE_SOURCE" &&
          record.production_delivery === false,
      )
    )
      throw new Error(`missing_live_source_evidence:${family}`);
  }
  for (const family of ["regional-geography", "market-mechanics", "market-geography"])
    if (!responses[`/api/v1/${family}`]) throw new Error(`missing_capture:${family}`);
  const renewablePath = process.env["SOURCE_RENEWABLE_CAPTURE"];
  let renewableSha256: string | null = null;
  if (renewablePath) {
    if (statSync(renewablePath).size > 8_000_000) throw new Error("bounded_capture_required");
    const renewableBytes = readFileSync(renewablePath);
    const renewable = JSON.parse(renewableBytes.toString()) as Record<string, any>;
    const evidence = JSON.parse(
      readFileSync(join(dirname(renewablePath), "source-rehearsals.json"), "utf8"),
    ) as typeof records;
    if (
      !evidence.some(
        (record) =>
          record.family === "renewables" &&
          record.exit_code === 0 &&
          record.mode === "ISOLATED_LOCAL_LIVE_SOURCE" &&
          record.production_delivery === false,
      )
    )
      throw new Error("missing_renewable_live_evidence");
    for (const [path, value] of Object.entries(renewable))
      if (/^\/api\/(v1|v2)\/forecast-quality(?:\/|$)/.test(path)) responses[path] = value;
    renewableSha256 = createHash("sha256").update(renewableBytes).digest("hex");
  }
  return {
    responses,
    renewablePath,
    renewableSha256,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    capturePath,
  };
}

export async function replaySourceCapture(
  page: Page,
  capture: NonNullable<ReturnType<typeof readSourceCapture>>,
) {
  const requests: string[] = [];
  await page.clock.setFixedTime(
    new Date(capture.responses["/api/v1/market-geography"].as_of * 1000),
  );
  await page.route(
    (url) => allowed.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (
        route.request().method() !== "GET" ||
        url.search ||
        !Object.hasOwn(capture.responses, path)
      )
        throw new Error(`uncaptured_read:${path}`);
      requests.push(path);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(capture.responses[path]),
      });
    },
  );
  return requests;
}

// Independent presentation oracle: source MW is displayed in GW at >=1000;
// source prices retain two decimal $/MWh, and MCPC retains its frozen $/MW unit.
export function sourceDisplay(value: number | null | undefined, unit = "MW") {
  if (value === null || value === undefined) return "Unavailable";
  if (unit === "$/MWh")
    return `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/MWh`;
  if (unit === "%") return `${value.toFixed(1)}%`;
  const scale = unit === "MW" && Math.abs(value) >= 1000 ? 1000 : 1;
  const precision = unit === "MW" ? 1 : 0;
  return `${(value / scale).toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: 1 })} ${scale === 1000 ? "GW" : unit}`;
}
