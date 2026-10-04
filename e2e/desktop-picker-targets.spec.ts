import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

for (const width of [320, 390, 768, 1440, 1920]) {
  test(`picker preserves 44px input and visible focus at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-09-01T18:00:00-05:00"));
    await installMobileApi(page);
    await page.goto("/");
    const input = page.getByRole("combobox", { name: "Time range picker" });
    const shell = page
      .getByRole("group", { name: "Time range controls" })
      .locator(".time-range-picker__input-shell");
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.height).toBe(44);
    if (width > 700) {
      const shellBox = (await shell.boundingBox())!;
      expect(shellBox.height).toBe(44);
      expect(inputBox.y).toBe(shellBox.y);
      expect(inputBox.y + inputBox.height).toBe(shellBox.y + shellBox.height);
    }
    for (const name of width > 700 ? ["Step back", "Pause", "Step forward"] : []) {
      const box = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
      if (width > 700) {
        expect(box.height).toBe(44);
        expect(box.width).toBe(44);
      }
    }
    await input.focus();
    await expect(input).toBeFocused();
    await expect(shell).toHaveCSS("border-color", "rgb(56, 189, 248)");
    await expect(shell).toHaveCSS("box-shadow", "rgb(56, 189, 248) 0px 0px 0px 1px");
    if (width > 700)
      expect(await input.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
        "rgba(0, 0, 0, 0)",
      );
    const bounds = (await shell.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(1);
    expect(bounds.x + bounds.width + 1).toBeLessThanOrEqual(width);
    // Include the outside focus ring, rather than clipping the image to the shell.
    const screenshot = await page.screenshot({
      clip: {
        x: bounds.x - 2,
        y: bounds.y - 2,
        width: bounds.width + 4,
        height: bounds.height + 4,
      },
    });
    await mkdir("artifacts/post-release/desktop-picker-targets", { recursive: true });
    await writeFile(`artifacts/post-release/desktop-picker-targets/focus-${width}.png`, screenshot);
    await writeFile(
      `artifacts/post-release/desktop-picker-targets/bounds-${width}.json`,
      JSON.stringify({ width, input: inputBox, shell: bounds }, null, 2),
    );
    await testInfo.attach(`picker-focused-${width}`, {
      body: screenshot,
      contentType: "image/png",
    });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Time range", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(input).toBeFocused();
  });
}
