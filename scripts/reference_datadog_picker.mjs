import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const SOURCE_URL = "https://druids.datadoghq.com/components/time/DateRangePicker";
const stamp = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = `artifacts/datadog-picker-reference/${stamp}`;
const viewports = {
  desktop: { deviceScaleFactor: 1, height: 960, width: 1280 },
  mobile: { deviceScaleFactor: 1, height: 844, width: 390 },
};

async function loadExample(page) {
  await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const input = page.getByRole("textbox", { name: "Time range picker" }).first();
  await input.waitFor({ state: "visible", timeout: 60_000 });
  return input;
}

async function captureViewport(browser, name, viewport) {
  const context = await browser.newContext({
    colorScheme: "dark",
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: "en-US",
    viewport: { height: viewport.height, width: viewport.width },
  });
  const page = await context.newPage();
  const trace = [];
  let input = await loadExample(page);
  await page.screenshot({ path: `${outputDirectory}/${name}-closed.png` });
  const closed = await input.boundingBox();
  const inputStyle = await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
    };
  });

  await input.click();
  trace.push("activate Time range picker", "preset list visible");
  const calendar = page.getByRole("button", { name: "Select from calendar…" }).first();
  await calendar.waitFor({ state: "visible" });
  const more = page.getByRole("button", { name: /More$/ }).first();
  const menu = await calendar
    .locator("xpath=ancestor::*[self::div or self::section][1]")
    .boundingBox();
  const rawOptionLabels = await page.getByRole("button").allTextContents();
  const optionLabels = rawOptionLabels.flatMap((label) => {
    const match = /(Past .+|Select from calendar…|More)$/.exec(
      label.trim().replaceAll(/\s+/g, " "),
    );
    return match ? [match[1]] : [];
  });
  const controls = [
    { name: "Time range picker", role: "textbox" },
    ...["Step back", "Play", "Step forward"].map((controlName) => ({
      name: controlName,
      role: "button",
    })),
    ...optionLabels.map((optionName) => ({ name: optionName, role: "button" })),
  ];
  const menuRow = await calendar.boundingBox();
  await page.screenshot({ path: `${outputDirectory}/${name}-presets.png` });

  await more.click();
  trace.push("activate More", "syntax sidecar visible");
  await page.getByText("Type custom times like:", { exact: true }).first().waitFor();
  const moreText = await page
    .getByText("Type custom times like:", { exact: true })
    .first()
    .locator("xpath=..")
    .innerText();
  await page.screenshot({ path: `${outputDirectory}/${name}-more.png` });

  input = await loadExample(page);
  await input.click();
  await page.getByRole("button", { name: "Select from calendar…" }).first().click();
  trace.push("activate Select from calendar", "single-month calendar visible");
  await page.screenshot({ path: `${outputDirectory}/${name}-calendar.png` });
  const calendarLabels = await page
    .getByRole("button", { name: /^[A-Z][a-z]+ \d{1,2}, \d{4}$/ })
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") || ""));
  const body = await page.locator("body").innerText();
  await context.close();
  return {
    accessibility: { controls },
    calendarLabels,
    contentHash: createHash("sha256").update(body).digest("hex"),
    geometry: { closed, menu, menuRow },
    interactionTrace: trace,
    moreText,
    optionLabels,
    typography: inputStyle,
    viewport: { ...viewport, actual: page.viewportSize() },
  };
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const captures = {};
  for (const [name, viewport] of Object.entries(viewports)) {
    captures[name] = await captureViewport(browser, name, viewport);
  }
  const artifact = {
    schemaVersion: 1,
    source: { capturedAt: new Date().toISOString(), url: SOURCE_URL },
    captures,
  };
  await writeFile(`${outputDirectory}/reference.json`, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`DRUIDS reference captured at ${outputDirectory}`);
  const contract = JSON.parse(
    await readFile("frontend/test-fixtures/datadog-date-range-picker/contract.json", "utf8"),
  );
  const desktop = captures.desktop;
  const drift = [];
  if (desktop.contentHash !== contract.source.pageContentHash) drift.push("page content hash");
  if (
    Math.abs(desktop.geometry.closed.height - contract.geometry.desktopControlHeight) >
    contract.geometry.toleranceCssPx
  )
    drift.push("closed control height");
  if (
    Math.abs(desktop.geometry.menu.width - contract.geometry.menuWidth) >
    contract.geometry.toleranceCssPx
  )
    drift.push("menu width");
  if (Number.parseFloat(desktop.typography.fontSize) !== contract.typography.inputFontSize)
    drift.push("input font size");
  if (JSON.stringify(desktop.optionLabels) !== JSON.stringify(contract.presetOrder))
    drift.push("preset order");
  if (
    Math.abs(desktop.geometry.menuRow.height - contract.geometry.menuRowHeight) >
    contract.geometry.toleranceCssPx
  )
    drift.push("menu row height");
  if (drift.length > 0) {
    console.error(`DRUIDS upstream drift requires contract review: ${drift.join(", ")}`);
    process.exitCode = 2;
  } else {
    console.log("No DRUIDS upstream drift detected against the pinned contract.");
  }
} finally {
  await browser.close();
}
