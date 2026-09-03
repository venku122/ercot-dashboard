import { expect, test, type Locator, type Page } from "@playwright/test";

import contract from "../frontend/test-fixtures/datadog-date-range-picker/contract.json" with { type: "json" };
import { installMobileApi } from "./mobile-fixtures";

const editor = (page: Page) => page.getByRole("combobox", { name: "Time range picker" });
async function expectGeometry(locator: Locator, width: number | null, height: number | null) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (height !== null)
    expect(
      box!.height,
      `height should be ${height}±${contract.geometry.toleranceCssPx}px`,
    ).toBeGreaterThanOrEqual(height - contract.geometry.toleranceCssPx);
  if (height !== null)
    expect(
      box!.height,
      `height should be ${height}±${contract.geometry.toleranceCssPx}px`,
    ).toBeLessThanOrEqual(height + contract.geometry.toleranceCssPx);
  if (width !== null)
    expect(
      box!.width,
      `width should be ${width}±${contract.geometry.toleranceCssPx}px`,
    ).toBeGreaterThanOrEqual(width - contract.geometry.toleranceCssPx);
  if (width !== null)
    expect(
      box!.width,
      `width should be ${width}±${contract.geometry.toleranceCssPx}px`,
    ).toBeLessThanOrEqual(width + contract.geometry.toleranceCssPx);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-01T18:00:00-05:00"));
  await installMobileApi(page);
  await page.goto("/");
});

test("desktop geometry, typography, states and screenshots match the frozen contract", async ({
  page,
}) => {
  const cluster = page.getByRole("group", { name: "Time range controls" });
  const shell = cluster.locator(".time-range-picker__input-shell");
  await expectGeometry(
    shell,
    contract.geometry.controlWidth,
    contract.geometry.desktopControlHeight,
  );
  const shellBox = await shell.boundingBox();
  expect(shellBox!.width).toBeGreaterThanOrEqual(contract.geometry.controlMinWidth);
  await expect(shell).toHaveCSS("border-width", `${contract.geometry.borderWidth}px`);
  await expect(shell).toHaveCSS("border-radius", `${contract.geometry.radius}px`);
  for (const name of ["Step back", "Pause", "Step forward"]) {
    await expectGeometry(
      page.getByRole("button", { name }),
      contract.geometry.desktopIconButtonSize,
      contract.geometry.desktopIconButtonSize,
    );
  }
  await expect(shell.locator(".time-range-picker__pill")).toHaveCSS(
    "height",
    `${contract.geometry.durationPillHeight}px`,
  );
  await expect(editor(page)).toHaveCSS("font-size", `${contract.typography.inputFontSize}px`);
  await expect(editor(page)).toHaveCSS("font-weight", String(contract.typography.inputFontWeight));
  await expect(editor(page)).toHaveCSS("line-height", `${contract.typography.inputLineHeight}px`);
  await expect(cluster).toHaveScreenshot("picker-closed.png");

  await editor(page).click();
  let surface = page.getByRole("dialog", { name: "Time range" });
  const menu = surface.locator(".time-range-picker__menu");
  await expectGeometry(menu, contract.geometry.menuWidth, null);
  const firstOption = surface.getByRole("option").first();
  await expectGeometry(firstOption, null, contract.geometry.menuRowHeight);
  await expect(firstOption).toHaveCSS("font-size", `${contract.typography.optionFontSize}px`);
  await expect(firstOption).toHaveCSS("line-height", `${contract.typography.optionLineHeight}px`);
  const menuBox = await menu.boundingBox();
  expect(Math.abs(menuBox!.x - shellBox!.x)).toBeLessThanOrEqual(contract.geometry.toleranceCssPx);
  expect(Math.abs(menuBox!.y - (shellBox!.y + shellBox!.height))).toBeLessThanOrEqual(
    contract.geometry.toleranceCssPx,
  );
  await expect(surface).toHaveScreenshot("picker-presets.png");

  await surface.getByRole("option", { name: "More" }).click();
  await expectGeometry(
    surface.getByRole("complementary", { name: "Custom time examples" }),
    contract.geometry.sidecarWidth,
    null,
  );
  const sidecarBox = await surface
    .getByRole("complementary", { name: "Custom time examples" })
    .boundingBox();
  expect(Math.abs(sidecarBox!.x - (menuBox!.x + menuBox!.width))).toBeLessThanOrEqual(
    contract.geometry.toleranceCssPx,
  );
  await expect(surface).toHaveScreenshot("picker-more.png");

  await surface.getByRole("option", { name: "More" }).click();
  await surface.getByRole("option", { name: /Select from calendar/ }).click();
  await expectGeometry(surface.getByLabel("Calendar range"), contract.geometry.menuWidth, null);
  await expect(surface).toHaveScreenshot("picker-calendar.png");
  await page.keyboard.press("Escape");

  await editor(page).click();
  await editor(page).fill("Sep 1, 2026, 8:00 am - Sep 1, 2026, 10:13 am");
  await expect(page.getByRole("dialog", { name: "Time range" })).toHaveScreenshot(
    "picker-editing.png",
  );
  await editor(page).fill("not a time");
  await editor(page).press("Enter");
  await expect(page.getByRole("dialog", { name: "Time range" })).toHaveScreenshot(
    "picker-invalid.png",
  );

  await editor(page).fill("Sep 1, 2026, 8:00 am - Sep 1, 2026, 10:13 am");
  await editor(page).press("Enter");
  await expect(cluster).toHaveScreenshot("picker-fixed.png");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(cluster).toHaveScreenshot("picker-live.png");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(cluster).toHaveScreenshot("picker-paused.png");
});

test("mobile sheet is deterministic and fits the pinned viewport", async ({ page }) => {
  await page.setViewportSize({
    width: contract.viewports.mobile.width,
    height: contract.viewports.mobile.height,
  });
  await page.reload();
  await editor(page).click();
  const surface = page.getByRole("dialog", { name: "Time range" });
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(contract.viewports.mobile.width);
  await expect(surface).toHaveScreenshot("picker-mobile.png");
});
