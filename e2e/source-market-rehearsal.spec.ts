import { expect, test } from "@playwright/test";
import { recordSourceContainment } from "./source-containment-evidence";
import { installMobileApi } from "./mobile-fixtures";
import { readSourceCapture, replaySourceCapture, sourceDisplay } from "./source-capture-replay";

const capture = readSourceCapture();
test.skip(!capture, "Requires explicit captured-live responses from scripts/rehearse_sources.py");

for (const width of [390, 1440]) {
  test(`ERP-08 captured live regional and market publications match exact readouts at ${width}px`, async ({
    page,
  }, testInfo) => {
    if (!capture) return;
    await testInfo.attach("captured-live-provenance", {
      body: JSON.stringify({
        capturePath: capture.capturePath,
        sha256: capture.sha256,
        renewableSha256: capture.renewableSha256,
        mode: "CAPTURED_LIVE_REPLAY",
        production_delivery: false,
      }),
      contentType: "application/json",
    });
    await page.setViewportSize({ width, height: 1000 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    const requests = await replaySourceCapture(page, capture);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const regional = capture.responses["/api/v1/regional-geography"];
    for (const mode of ["wind", "solar"]) {
      const points = regional.current[mode].regions;
      expect(points.length).toBeGreaterThan(0);
      const point = points[0];
      const key = `regional.${mode}.${point.region}.hourly`;
      const day = Math.floor(capture.responses["/api/v1/market-geography"].as_of / 86400) * 86400;
      const link = regional.resources
        .filter((item: any) => item.series_key === key && item.tile_start <= day)
        .sort((a: any, b: any) => b.tile_start - a.tile_start)[0];
      const source = capture.responses[link.url];
      await page.goto(`/?view=generation&regionalLayer=${mode}&regionalRegion=${point.region}`);
      const panel = page.getByRole("region", { name: "Regional load and renewable outlook" });
      await panel.getByRole("button", { name: "Load regional details" }).click();
      const current = panel.locator(".regional-current-table");
      await expect(current.locator("tbody tr")).toHaveCount(points.length);
      for (let index = 0; index < points.length; index++) {
        const row = current.locator("tbody tr").nth(index);
        await expect(row.locator("th")).toHaveText(points[index].region);
        await expect(row.locator("td").nth(1)).toHaveText(sourceDisplay(points[index].current_mw));
        await expect(row.locator("td").nth(2)).toHaveText(
          sourceDisplay(points[index].share_percent, "%"),
        );
        await expect(row.locator("td").nth(3)).toHaveText(
          sourceDisplay(points[index].change_1h_mw),
        );
        await expect(row.locator("td").nth(4)).toContainText(
          sourceDisplay(points[index].next_24h_forecast_peak.forecast_mw),
        );
      }
      const history = panel.locator(".regional-history-table");
      await expect(history.locator("tbody tr")).toHaveCount(source.rows.length);
      await expect(history.locator("tbody tr td:nth-child(2)")).toHaveText(
        source.rows.map((row: any) => sourceDisplay(row.current_mw)),
      );
      await expect(history.locator("tbody tr td:nth-child(3)")).toHaveText(
        source.rows.map((row: any) => sourceDisplay(row.forecast_mw)),
      );
      await expect(history.locator("tbody tr td:nth-child(4)")).toHaveText(
        source.rows.map((row: any) => sourceDisplay(row.change_1h_mw)),
      );
      expect(requests).toContain(link.url);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `artifacts/post-release/source-${mode}-replay-${width}.png`,
        fullPage: true,
      });
    }
    const market = capture.responses["/api/v1/market-mechanics"];
    await page.goto("/?view=market");
    await page.getByRole("button", { name: /What changed with the price move/ }).click();
    const cards = page.locator(".market-mechanics-grid button");
    const readings = Object.values(market.current.readings) as any[];
    await expect(cards).toHaveCount(readings.length);
    const rendered = await cards.evaluateAll((buttons) =>
      buttons.map((button) => ({
        value: button.querySelector("strong")?.textContent,
        provenance: button.querySelector("small")?.textContent,
      })),
    );
    expect(rendered.map((row) => row.value).sort()).toEqual(
      readings.map((row) => sourceDisplay(row.value, row.unit)).sort(),
    );
    expect(rendered.map((row) => row.provenance?.split(" · ").at(-1)).sort()).toEqual(
      readings.map((row) => row.source.product_id).sort(),
    );
    for (const [key, reading] of Object.entries(market.current.readings) as Array<[string, any]>) {
      const labels: Record<string, string> = {
        "market.sced.system-lambda.capped": "Capped System Lambda",
        "market.sced.system-lambda.uncapped": "Uncapped System Lambda",
        "market.sced.price-adder.energy": "Energy reliability adder",
        "market.sced.price-adder.regup": "Reg-Up adder",
        "market.sced.price-adder.regdown": "Reg-Down adder",
        "market.sced.price-adder.rrs": "RRS adder",
        "market.sced.price-adder.ecrs": "ECRS adder",
        "market.sced.price-adder.nonspin": "Non-Spin adder",
        "market.sced.adder-input.rtdll": "RTDLL (source field; definition pending)",
        "market.sced.adder-input.rtblt-import": "RTBLT import (source field)",
        "market.sced.adder-input.rtblt-export": "RTBLT export (source field)",
      };
      const name =
        labels[key] ??
        (key.includes("as-mcpc")
          ? `${key.split(".").slice(3).join(" ")} MCPC`
          : key.split(".").at(-1)!.replaceAll("-", " "));
      const card = cards.filter({ has: page.getByText(name, { exact: true }) });
      await expect(card).toHaveCount(1);
      await expect(card.locator("strong")).toHaveText(sourceDisplay(reading.value, reading.unit));
      await expect(card.locator("small")).toContainText(reading.source.product_id);
    }
    await expect(page.getByText("Capped System Lambda", { exact: true })).toBeVisible();
    await expect(page.getByText("Uncapped System Lambda", { exact: true })).toBeVisible();
    await expect(page.getByText(/Lambda parity unavailable: NP6-323/)).toBeVisible();
    await page.screenshot({
      path: `artifacts/post-release/source-market-replay-${width}.png`,
      fullPage: true,
    });
    const geography = capture.responses["/api/v1/market-geography"];
    await page.getByRole("button", { name: /Where are prices diverging/ }).click();
    const prices = [
      ...geography.settlement_interval.rows,
      ...geography.settlement_interval.reference_prices,
    ];
    const exact = page.getByRole("region", { name: "Settlement price exact values", exact: true });
    await expect(exact.locator("tbody tr")).toHaveCount(prices.length);
    await expect(exact.locator("tbody tr td:nth-child(1)")).toHaveText(
      prices.map((row: any) => row.settlement_point),
    );
    await expect(exact.locator("tbody tr td:nth-child(3)")).toHaveText(
      prices.map((row: any) => sourceDisplay(row.value, row.unit)),
    );
    const priceLink = geography.resources
      .filter((item: any) => item.kind === "prices" && item.identity === "HB_HOUSTON--HU")
      .sort((a: any, b: any) => b.tile_start - a.tile_start)[0];
    const priceHistory = capture.responses[priceLink.url];
    const table = page.getByRole("region", {
      name: "Selected market geography exact history",
      exact: true,
    });
    await expect(table.locator("tbody tr")).toHaveCount(priceHistory.rows.length);
    await expect(table.locator("tbody tr td:nth-child(2)")).toHaveText(
      priceHistory.rows.map((row: any) => sourceDisplay(row.value, "$/MWh")),
    );
    await expect(table.locator("tbody tr td:nth-child(3)")).toHaveText(
      priceHistory.rows.map((row: any) => row.source?.document_id ?? "Not reported"),
    );
    expect(requests).toContain(priceLink.url);
    await page.getByRole("button", { name: "Coincident constraints", exact: true }).click();
    expect(geography.constraints.state).toBe("unavailable_no_exact_sced");
    await expect(
      page.getByText("No NP6-86 publication matches the current NP6-788 SCED exactly."),
    ).toBeVisible();
    const constraintLink = geography.resources
      .filter((item: any) => item.kind === "constraints")
      .sort((a: any, b: any) => b.tile_start - a.tile_start)[0];
    await page.goto(
      `/?view=market&marketLayer=constraints&marketConstraint=${constraintLink.identity}`,
    );
    await page.getByRole("button", { name: /Where are prices diverging/ }).click();
    const constraintHistory = capture.responses[constraintLink.url];
    const constraintTable = page.getByRole("region", {
      name: "Selected market geography exact history",
      exact: true,
    });
    await expect(constraintTable.locator("tbody tr")).toHaveCount(constraintHistory.rows.length);
    await expect(constraintTable.locator("tbody tr td:nth-child(2)")).toHaveText(
      constraintHistory.rows.map((row: any) => sourceDisplay(row.shadow_price, "$/MWh")),
    );
    expect(requests).toContain(constraintLink.url);
    await page.screenshot({
      path: `artifacts/post-release/source-geography-replay-${width}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [390, 1440]) {
  test(`ERP-08 captured live renewable publication quality tables at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !capture?.responses["/api/v1/forecast-quality"],
      "Requires SOURCE_RENEWABLE_CAPTURE from a bounded live renewables one-shot",
    );
    if (!capture) return;
    await page.setViewportSize({ width, height: 1000 });
    await installMobileApi(page, "normal", [], { nativeCadence: true });
    const requests = await replaySourceCapture(page, capture);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const quality = capture.responses["/api/v1/forecast-quality"];
    await page.goto("/?view=outlook");
    await page.getByRole("button", { name: "Load quality details", exact: true }).click();
    for (const [key, name] of [
      ["wind.stwpf", "Wind STWPF"],
      ["solar.stppf", "Solar STPPF"],
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      for (const [horizon, label] of [
        ["1h", "1-hour ahead"],
        ["6h", "6-hour ahead"],
        ["24h", "24-hour ahead"],
      ]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        const now = capture.responses["/api/v1/market-geography"].as_of;
        const links = quality.resources.filter(
          (item: any) =>
            item.series_key === key && item.horizon === horizon && item.day_start + 86400 <= now,
        );
        const link = links.at(-1);
        const source = capture.responses[link.url];
        const table = page.getByRole("table", {
          name: `${name} ${label} exact forecast quality`,
          exact: true,
        });
        await expect(table.locator("tbody tr")).toHaveCount(source.rows.length);
        for (const [index, field] of [
          "forecast_mw",
          "actual_mw",
          "error_mw",
          "absolute_error_mw",
          "revision_mw",
        ].entries()) {
          await expect(table.locator(`tbody tr td:nth-child(${index + 2})`)).toHaveText(
            source.rows.map((row: any) => sourceDisplay(row[field])),
          );
        }
        await expect(table.locator("tbody tr td:nth-child(7)")).toHaveText(
          source.rows.map((row: any) => row.model ?? row.missing_reason ?? "Unavailable"),
        );
        expect(requests).toContain(link.url);
        const summary = quality.summaries.find(
          (item: any) => item.series_key === key && item.horizon === horizon,
        ).summary;
        const values = page.locator('[aria-label="Forecast quality summary"] dd');
        await expect(values).toHaveText([
          sourceDisplay(summary.mae_mw),
          sourceDisplay(summary.bias_mw),
          sourceDisplay(summary.mape_percent, "%"),
          `${summary.sample_count}/${summary.expected_count} (${(summary.joint_coverage * 100).toFixed(1)}%)`,
        ]);
        if (summary.sample_count === 0)
          await expect(page.locator('[data-forecast-quality-state="no-pairs"]')).toBeVisible();
        else if (!summary.qualification.qualified)
          await expect(
            page.getByText(/Insufficient history for an empirical interval:/),
          ).toBeVisible();
        const scroll = page.getByRole("region", {
          name: `${name} ${label} scrollable quality evidence`,
          exact: true,
        });
        await expect(scroll).toHaveAttribute("tabindex", "0");
        expect(await scroll.evaluate((node) => getComputedStyle(node).overflowX)).toMatch(
          /auto|scroll/,
        );
        await scroll.focus();
        await expect(scroll).toBeFocused();
        await page.mouse.move(0, 0);
        for (const buttonName of [name, label]) {
          const button = page.getByRole("button", { name: buttonName, exact: true });
          await expect(button).toBeVisible();
          await expect(button).toHaveCSS("translate", "none");
          // DOMRect.height measures the layout target directly; protocol quads can
          // lose precision when subtracting large scrolled document coordinates.
          expect(
            await button.evaluate((node) => node.getBoundingClientRect().height),
          ).toBeGreaterThanOrEqual(44);
        }
        await recordSourceContainment(page, testInfo, "quality-source-containment");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
    await page.screenshot({
      path: `artifacts/post-release/source-renewables-replay-${width}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
