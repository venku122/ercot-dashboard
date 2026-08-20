import { expect, test } from "@playwright/test";

import {
  GRID_EVENT_FROM,
  GRID_EVENT_TO,
  GRID_EVENT_URL,
  installGridEventTimelineApi,
} from "./grid-event-timeline-fixtures";

test("grid event timeline is Reliability-only, strict, shareable, and noncausal", async ({
  page,
}) => {
  const requests: string[] = [];
  await installGridEventTimelineApi(page, requests);
  await page.goto("/?view=overview");
  await expect(page.getByRole("heading", { name: "ERCOT Grid Status" })).toBeVisible();
  expect(requests).toEqual([]);

  await page.goto(GRID_EVENT_URL);
  const panel = page.getByRole("region", { name: "Unified grid event timeline" });
  await expect(panel).toBeVisible();
  await expect.poll(() => requests).toHaveLength(1);
  expect(requests[0]).toContain(`from=${GRID_EVENT_FROM}`);
  expect(requests[0]).toContain(`to=${GRID_EVENT_TO}`);
  await expect(panel).toContainText("Official ERCOT event");
  await expect(panel).toContainText("Official NWS weather alert");
  await expect(panel).toContainText("Source observation");
  await expect(panel).toContainText("Dashboard derived annotation");
  await expect(panel).toContainText("Texas statewide, not ERCOT footprint");
  await expect(panel).toContainText("no events are synthesized");
  await expect(panel).toContainText("Temporal overlap does not establish attribution");
  await expect(panel).toContainText("this page is not presented as complete");
  await expect(panel).not.toContainText(/caused|drove|driver|triggered/i);
  await expect(panel.locator('[data-event-focused="true"]')).toContainText(
    "Official ERCOT operations message",
  );
  await panel.locator(".grid-event-list > li").evaluateAll((elements) => {
    for (const element of elements) (element as HTMLElement).style.contentVisibility = "visible";
  });

  const focused = panel.locator('[data-event-focused="true"]');
  const permalink = new URL(
    (await focused
      .getByRole("link", { name: "Permalink to fixed event window" })
      .getAttribute("href")) ?? "",
    page.url(),
  );
  expect(permalink.searchParams.get("event")).toBe("ops:exact");
  expect(permalink.searchParams.get("from")).toBe(String(GRID_EVENT_FROM));
  expect(permalink.searchParams.get("to")).toBe(String(GRID_EVENT_TO));
  const replay = new URL(
    (await focused
      .getByRole("link", { name: "Open synchronized storage-context window" })
      .getAttribute("href")) ?? "",
    page.url(),
  );
  expect(replay.searchParams.get("view")).toBe("generation");
  expect(replay.searchParams.get("inspect")).toBe("storage");
  expect(replay.searchParams.get("from")).toBe(String(GRID_EVENT_FROM));
  expect(replay.searchParams.get("to")).toBe(String(GRID_EVENT_TO));
  await expect(panel.getByText(/Replay needs one unambiguous UTC timestamp/)).toHaveCount(1);
  await expect(panel).toHaveScreenshot("grid-event-timeline.png");

  await panel.getByText("Exact event evidence").click();
  const exact = panel.getByRole("region", { name: "Unified grid event exact evidence" });
  await expect(exact).toHaveAttribute("tabindex", "0");
  await expect(exact.locator("tbody tr")).toHaveCount(5);
  await expect(exact).toContainText("source_snapshot_epoch_not_official_declaration_time");
  await expect(exact).toContainText("eea_transition_v1 v1");
  await expect(exact).toHaveScreenshot("grid-event-timeline-exact.png");

  await page.reload();
  await expect(panel.locator('[data-event-focused="true"]')).toContainText(
    "Official ERCOT operations message",
  );
  await page.goto("/?view=overview");
  await page.goBack();
  await expect(panel.locator('[data-event-focused="true"]')).toContainText(
    "Official ERCOT operations message",
  );
});

test("events-off Reliability state and other views make zero grid-event requests", async ({
  page,
}) => {
  const requests: string[] = [];
  await installGridEventTimelineApi(page, requests);
  await page.goto("/?view=reliability&events=0");
  await expect(page.getByText("Grid-event annotations are off")).toBeVisible();
  expect(requests).toEqual([]);
  await page.goto("/?view=generation&events=1");
  await expect(page.getByRole("heading", { name: "ERCOT Grid Status" })).toBeVisible();
  expect(requests).toEqual([]);
});
