import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installMobileApi } from "./mobile-fixtures";

async function evidenceFile(name: string, value: unknown) {
  await mkdir("artifacts/post-release", { recursive: true });
  await writeFile(`artifacts/post-release/${name}.json`, JSON.stringify(value, null, 2));
}

async function overview(page: import("@playwright/test").Page) {
  await installMobileApi(page, "normal", [], { nativeCadence: true });
  await page.goto("/?view=overview&range=604800&live=1&legend=expanded");
  const card = page.locator('[data-chart-id="supply-demand"]');
  await expect(card.locator("canvas")).toHaveAttribute("data-chart-ready", "true");
  return card;
}

for (const width of [320, 390, 768, 1440, 1920]) {
  test(`ERP-09 text-only 200% keeps critical controls and readings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const card = await overview(page);
    await card.getByText("Accessible data table", { exact: true }).click();
    const before = await page
      .locator(".homepage-readings strong")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    await page.evaluate(() => {
      // Snapshot before applying overrides so inherited sizes are not multiplied twice.
      const sizes = [...document.querySelectorAll<HTMLElement>("html, body, body *")].map(
        (el) => [el, parseFloat(getComputedStyle(el).fontSize)] as const,
      );
      for (const [el, size] of sizes)
        el.style.setProperty("font-size", `${size * 2}px`, "important");
    });
    expect(
      await page
        .locator(".homepage-readings strong")
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBe(before * 2);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe("1");
    const geometry = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      readings: [
        ...document.querySelectorAll<HTMLElement>(
          ".homepage-readings > div > span, .homepage-readings > div > strong",
        ),
      ].map((el) => ({
        text: el.textContent,
        left: el.getBoundingClientRect().left,
        right: el.getBoundingClientRect().right,
        clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      })),
    }));
    expect(geometry.width, JSON.stringify(geometry)).toBeLessThanOrEqual(width);
    for (const reading of geometry.readings) {
      expect(reading.left, JSON.stringify(reading)).toBeGreaterThanOrEqual(0);
      expect(reading.right, JSON.stringify(reading)).toBeLessThanOrEqual(width + 1);
      expect(reading.clipped, JSON.stringify(reading)).toBe(false);
    }
    for (const control of [
      page.getByRole("combobox", { name: "Time range picker" }),
      page.getByRole("button", { name: "Time & compare", exact: true }),
      card.getByRole("button", { name: "Open Supply and demand inspect mode" }),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      const metrics = await control.evaluate((el) => ({
        text: el.getAttribute("aria-label") ?? el.textContent,
        tag: el.tagName,
        width: el.clientWidth,
        contentWidth: el.scrollWidth,
        height: el.clientHeight,
        contentHeight: el.scrollHeight,
      }));
      expect(
        metrics.contentWidth <= metrics.width + 1 && metrics.contentHeight <= metrics.height + 1,
        JSON.stringify(metrics),
      ).toBe(true);
    }
    const region = card.getByRole("region", { name: "Supply and demand displayed source data" });
    await region.focus();
    await expect(region).toBeFocused();
    await expect(region).toHaveAttribute("tabindex", "0");
    const scrolling = await region.evaluate((el) => ({
      overflow: getComputedStyle(el).overflowX,
      available: el.scrollWidth - el.clientWidth,
    }));
    expect(scrolling.overflow).toBe("auto");
    if (scrolling.available > 0) {
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
    await page.screenshot({ path: `artifacts/post-release/ERP-09-text-only-${width}.png` });
    await test.info().attach("text-only-layout", {
      body: JSON.stringify(geometry),
      contentType: "application/json",
    });
  });
}

// Decode the browser's own PNG in its canvas; no guessed solid background when
// gradients or translucent ancestors contribute to the rendered pixels.
async function pixels(page: import("@playwright/test").Page, png: Buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: image.width,
      data: [...context.getImageData(0, 0, image.width, image.height).data],
    };
  }, png.toString("base64"));
}
function luminance(rgb: number[]) {
  const linear = rgb.slice(0, 3).map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
function ratio(a: number[], b: number[]) {
  const values = [luminance(a), luminance(b)].sort((left, right) => left - right);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

for (const width of [390, 1440]) {
  test(`ERP-09 rendered primary text and keyboard focus contrast at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await overview(page);
    const evidence = [];
    for (const locator of [
      page.locator("h1").first(),
      page.locator(".homepage-readings > div > span").first(),
      page.locator(".homepage-readings strong").first(),
      page.locator(".freshness-state").first(),
      page.getByRole("region", { name: "Current ERCOT status" }).locator("strong").nth(0),
      page.getByRole("region", { name: "Current ERCOT status" }).locator("strong").nth(1),
    ]) {
      await locator.scrollIntoViewIfNeeded();
      const style = await locator.evaluate((el) => {
        let opacity = 1;
        for (let parent: Element | null = el; parent; parent = parent.parentElement)
          opacity *= Number(getComputedStyle(parent).opacity);
        const css = getComputedStyle(el);
        return { text: el.textContent, color: css.color, opacity };
      });
      expect(style.text?.trim()).toBeTruthy();
      const foreground = style.color.match(/[\d.]+/g)!.map(Number);
      // Hide only glyph paint, preserving foreground-dependent borders/backgrounds.
      await locator.evaluate((el) =>
        (el as HTMLElement).style.setProperty(
          "-webkit-text-fill-color",
          "transparent",
          "important",
        ),
      );
      const background = await pixels(page, await locator.screenshot());
      await locator.evaluate((el) =>
        (el as HTMLElement).style.removeProperty("-webkit-text-fill-color"),
      );
      const alpha = (foreground[3] ?? 1) * style.opacity;
      let minimum = Infinity;
      for (let i = 0; i < background.data.length; i += 4) {
        const bg = background.data.slice(i, i + 3);
        const painted = bg.map(
          (value, channel) => foreground[channel]! * alpha + value * (1 - alpha),
        );
        minimum = Math.min(minimum, ratio(painted, bg));
      }
      evidence.push({ ...style, minimumContrast: minimum });
      expect(minimum, JSON.stringify(style)).toBeGreaterThanOrEqual(4.5);
    }
    const control = page.getByRole("button", { name: "Time & compare", exact: true });
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    expect(await control.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    const focus = await control.evaluate((el) => ({
      color: getComputedStyle(el).outlineColor,
      width: parseFloat(getComputedStyle(el).outlineWidth),
      offset: parseFloat(getComputedStyle(el).outlineOffset),
    }));
    expect(focus.width).toBeGreaterThanOrEqual(2);
    const box = (await control.boundingBox())!;
    const padding = focus.width + focus.offset + 1;
    const clip = { x: box.x, y: box.y - padding, width: box.width, height: padding };
    const painted = await pixels(page, await page.screenshot({ clip }));
    await control.evaluate((el) =>
      (el as HTMLElement).style.setProperty("outline", "none", "important"),
    );
    const underlay = await pixels(page, await page.screenshot({ clip }));
    await control.evaluate((el) => (el as HTMLElement).style.removeProperty("outline"));
    const foreground = focus.color.match(/[\d.]+/g)!.map(Number);
    const indices = [];
    for (let i = 0; i < painted.data.length; i += 4)
      if (foreground.slice(0, 3).every((value, channel) => painted.data[i + channel] === value))
        indices.push(i);
    expect(indices.length, JSON.stringify(focus)).toBeGreaterThan(5);
    const index = indices[Math.floor(indices.length / 2)]!;
    const focusRatio = ratio(
      painted.data.slice(index, index + 3),
      underlay.data.slice(index, index + 3),
    );
    expect(focusRatio).toBeGreaterThanOrEqual(3);
    await evidenceFile(`ERP-09-rendered-contrast-${width}`, { evidence, focus, focusRatio });
    await test.info().attach("rendered-contrast", {
      body: JSON.stringify({ evidence, focus, focusRatio }),
      contentType: "application/json",
    });
  });
}

test("ERP-09 mobile native safe-area support and resolved-inset stress", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await overview(page);

  const evidence = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe);
    const values = getComputedStyle(probe);
    const insets = [
      values.paddingTop,
      values.paddingRight,
      values.paddingBottom,
      values.paddingLeft,
    ];
    probe.remove();
    const shell = getComputedStyle(document.querySelector(".dashboard-shell")!);
    return {
      insets,
      shell: [shell.paddingTop, shell.paddingRight, shell.paddingBottom, shell.paddingLeft],
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
    };
  });
  expect(evidence.insets).toEqual(["0px", "0px", "0px", "0px"]);
  expect(evidence.viewport).toContain("viewport-fit=cover");
  expect(evidence.shell).toEqual(["3px", "10px", "86px", "10px"]);
  const stressCss = await page.evaluate(() => {
    const declarations: string[] = [];
    function visit(rules: CSSRuleList) {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && matchMedia(rule.conditionText).matches)
          visit(rule.cssRules);
        else if (
          rule instanceof CSSStyleRule &&
          [
            ".dashboard-shell",
            ".dashboard-shell:has(.homepage-workspace)",
            ".mobile-section-nav",
            ".dashboard-shell:has(.homepage-workspace) .dashboard-view-nav",
          ].includes(rule.selectorText)
        )
          declarations.push(rule.cssText);
      }
    }
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    return declarations.join("\n");
  });
  for (const edge of ["top", "right", "bottom", "left"])
    expect(stressCss).toContain(`env(safe-area-inset-${edge})`);
  // Chromium here reports zero hardware insets. Exercise the shipped expressions
  // with explicit resolved values, without claiming device/notch emulation.
  const resolvedCss = stressCss.replace(
    /env\(safe-area-inset-(top|right|bottom|left)\)/g,
    (_match, edge: string) =>
      `${({ top: 24, right: 18, bottom: 34, left: 18 } as Record<string, number>)[edge]}px`,
  );
  await page.addStyleTag({ content: resolvedCss });
  const stressed = await page.locator(".dashboard-shell").evaluate((el) => {
    const css = getComputedStyle(el);
    return [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft];
  });
  expect(stressed).toEqual(["24px", "18px", "120px", "18px"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const nav = await page.locator(".mobile-section-nav").evaluate((el) => {
    const css = getComputedStyle(el);
    return [css.paddingRight, css.paddingBottom, css.paddingLeft];
  });
  expect(nav).toEqual(["18px", "34px", "18px"]);
  expect((await page.locator(".dashboard-header").boundingBox())!.y).toBeGreaterThanOrEqual(24);
  await page.goto("/?view=diagnostics");
  await expect(page.getByRole("region", { name: "System health details" })).toBeVisible();
  await page.addStyleTag({ content: resolvedCss });
  expect(
    await page.locator(".dashboard-shell").evaluate((el) => getComputedStyle(el).paddingTop),
  ).toBe("24px");
  await evidenceFile("ERP-09-safe-area", {
    native: evidence,
    resolvedInsetStress: stressed,
    navigation: nav,
    shippedExpressions: stressCss,
  });
  await test.info().attach("resolved-safe-area", {
    body: JSON.stringify({
      native: evidence,
      resolvedInsetStress: stressed,
      shippedExpressions: stressCss,
    }),
    contentType: "application/json",
  });
});

for (const scenario of ["delayed", "failed"] as const) {
  test(`ERP-09 ${scenario} source health remains explicit without color`, async ({ page }) => {
    await installMobileApi(page, scenario, [], { nativeCadence: true });
    await page.goto("/?view=diagnostics");
    const details = page.getByRole("region", { name: "System health details" });
    const source = details.locator("article").filter({ hasText: "ERCOT Energy Storage Resources" });
    await expect(source).toContainText(scenario === "failed" ? "failed" : "delayed");
    await expect(source).toContainText("data delayed");
    await expect(source).toContainText("Source observation");
    // A monochrome style removes hue as an available signal; status words and
    // observation age remain visible. This is not screen-reader certification.
    await page.addStyleTag({
      content:
        "body * { color: white !important; background-color: black !important; border-color: white !important; }",
    });
    await expect(source).toBeVisible();
    await expect(source).toContainText(
      scenario === "failed" ? "Collection failed" : "Collection healthy",
    );
    await test
      .info()
      .attach("non-color-status", { body: await source.innerText(), contentType: "text/plain" });
  });
}
