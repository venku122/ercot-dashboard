import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./mobile-fixtures";
import { GRID_EVENT_URL, installGridEventTimelineApi } from "./grid-event-timeline-fixtures";

test("unified grid events stay contained and reachable on mobile @mobile-core", async ({
  page,
}) => {
  const requests: string[] = [];
  await installGridEventTimelineApi(page, requests);
  await page.goto(GRID_EVENT_URL);
  const panel = page.getByRole("region", { name: "Unified grid event timeline" });
  await expect(panel).toContainText("High Wind Warning for North Texas");
  await expect.poll(() => requests).toHaveLength(1);
  await expectNoHorizontalOverflow(page);

  for (const [name, target] of [
    ["evidence filter", panel.getByLabel("Filter unified timeline by evidence class")],
    ["permalink", panel.getByRole("link", { name: "Permalink to fixed event window" }).first()],
    [
      "replay link",
      panel.getByRole("link", { name: "Open synchronized storage-context window" }).first(),
    ],
    ["exact evidence summary", panel.locator("details.grid-event-exact > summary")],
  ]) {
    const box = await target.boundingBox();
    expect(box?.height ?? 0, `${name} height`).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, `${name} width`).toBeGreaterThanOrEqual(44);
  }

  await panel.locator("details.grid-event-exact").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  const exact = panel.getByRole("region", { name: "Unified grid event exact evidence" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  expect(await exact.evaluate((element) => getComputedStyle(element).overflowX)).toMatch(
    /auto|scroll/,
  );
  expect(await exact.evaluate((element) => element.scrollWidth)).toBeGreaterThan(
    await exact.evaluate((element) => element.clientWidth),
  );
  await expectNoHorizontalOverflow(page);
});

test("unified grid event evidence has stable mobile visuals @mobile-vri", async ({ page }) => {
  const requests: string[] = [];
  await installGridEventTimelineApi(page, requests);
  await page.goto(GRID_EVENT_URL);
  const panel = page.getByRole("region", { name: "Unified grid event timeline" });
  await expect(panel).toContainText("High Wind Warning for North Texas");
  await panel.locator(".grid-event-list > li").evaluateAll((elements) => {
    for (const element of elements) (element as HTMLElement).style.contentVisibility = "visible";
  });
  await page.locator(".mobile-section-nav").evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  await expect(panel).toHaveScreenshot("grid-event-timeline-mobile.png");
  await panel.locator("details.grid-event-exact").evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(
    panel.getByRole("region", { name: "Unified grid event exact evidence" }),
  ).toHaveScreenshot("grid-event-timeline-exact-mobile.png");
});
