import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { withCssPixelAlignment } from "./screenshot-alignment";

test("screenshot alignment preserves fractional layout and restores inline transforms", async ({
  page,
}) => {
  await page.setContent(
    '<div id="target" style="position:absolute;left:10.25px;top:20.75px;width:100.5px;height:50.5px;transform:translateX(2px)!important">Evidence</div>',
  );
  const target = page.locator("#target");
  const before = await target.boundingBox();
  const capture = async () => {
    const box = await target.boundingBox();
    expect(box?.x).toBe(12);
    expect(box?.y).toBe(21);
    expect(box?.width).toBe(before?.width);
    expect(box?.height).toBe(before?.height);
    await expect(target).toHaveText("Evidence");
  };
  await withCssPixelAlignment(target, capture);
  await expect(
    withCssPixelAlignment(target, async () => {
      throw new Error("capture failed");
    }),
  ).rejects.toThrow("capture failed");
  expect(await target.boundingBox()).toEqual(before);
  expect(
    await target.evaluate((el) => (el as HTMLElement).style.getPropertyPriority("transform")),
  ).toBe("important");
});

test("screenshot alignment makes fractional scroll-equivalent crops pixel-identical", async ({
  page,
}) => {
  await page.setContent(
    '<section style="position:absolute;left:29px;top:140.046875px;width:382px;font:16px sans-serif"><div id="target" style="padding:12px;border:1px solid #222">Exact coherent observation<br>Houston -$42.16/MWh</div></section>',
  );
  const target = page.locator("#target");
  const hashes: string[] = [];
  for (const offset of [0, 0.25, 0.5, 0.75]) {
    await target.locator("..").evaluate((element, y) => {
      (element as HTMLElement).style.translate = `0 ${y}px`;
    }, offset);
    await withCssPixelAlignment(target, async () => {
      hashes.push(
        createHash("sha256")
          .update(await target.screenshot())
          .digest("hex"),
      );
    });
  }
  expect(new Set(hashes).size).toBe(1);
});
