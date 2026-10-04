import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { FIXED_NOW_SECONDS, installMobileApi } from "./mobile-fixtures";

test("paired native day transport retains all selected 24h source tuples, coverage and CSV", async ({
  page,
}) => {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/tiles/supply-demand.paired-headroom/"))
      requests.push(new URL(request.url()).pathname);
  });
  await page.goto("/?range=86400&live=1");
  const card = page.locator('[data-chart-id="overview-headroom"]');
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  await expect(card.locator("canvas")).toHaveAttribute("aria-label", /[1-9]\d* observations/);
  await expect(
    page.getByText("289 paired observations of 289 nominal sample slots", { exact: false }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests.every((url) => /\/1d\/\d+\/native$/.test(url))).toBe(true);
  await card.getByLabel(/chart menu/).click();
  const download = page.waitForEvent("download");
  await card.getByRole("menuitem", { name: "Download CSV", exact: true }).click();
  const csv = readFileSync((await (await download).path())!, "utf8");
  const rows = csv
    .split("\n")
    .filter((row) => row.startsWith('"Derived headroom"'))
    .map((row) => {
      const fields = row.split(",");
      return [Number(fields[2]), Number(fields[3])];
    });
  const expected = [];
  for (let ts = FIXED_NOW_SECONDS - 86400; ts <= FIXED_NOW_SECONDS; ts += 300) {
    const index = 63 + (ts - Math.floor((FIXED_NOW_SECONDS - 30) / 300) * 300) / 300;
    expected.push([ts, 88500 + Math.sin(index / 5) * 1800 - (68200 + Math.sin(index / 5) * 3200)]);
  }
  expect(rows).toEqual(expected);
  expect(rows).toHaveLength(289);
  await test.info().attach("paired-selected-native-source-proof", {
    body: JSON.stringify(
      {
        requests,
        selectedRows: rows.length,
        first: rows[0],
        last: rows.at(-1),
        minimum: Math.min(...rows.map((p) => p[1]!)),
        maximum: Math.max(...rows.map((p) => p[1]!)),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});
