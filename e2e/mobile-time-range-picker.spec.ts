import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";

test("mobile picker is an opaque focus-trapped sheet without overflow @mobile-core @responsive", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMobileApi(page);
  await page.goto("/");
  const trigger = page.locator(".time-range-picker__cluster .time-range-picker__input");
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Time range" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS("background-color", "rgb(15, 23, 42)");
  await expect(sheet.getByRole("combobox", { name: "Time range picker" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.getByRole("option", { name: "More" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(sheet.getByRole("combobox", { name: "Time range picker" })).toBeFocused();
  for (const control of [trigger, ...(await sheet.locator("button, input, select").all())]) {
    const box = await control.boundingBox();
    const identity = await control.evaluate(
      (element) =>
        `${element.tagName}:${element.getAttribute("aria-label") ?? element.textContent}`,
    );
    expect(box?.height ?? 0, identity).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0, identity).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
});
