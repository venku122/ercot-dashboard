import { expect, test } from "@playwright/test";

import { expectNoHorizontalOverflow, installMobileApi } from "./mobile-fixtures";

test("mobile picker is an opaque focus-trapped sheet without overflow @mobile-core @responsive", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installMobileApi(page);
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Choose time range" });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Time range" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS("background-color", "rgb(15, 23, 42)");
  await expect(sheet.getByRole("button", { name: "Close time range picker" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  await expectNoHorizontalOverflow(page);
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
