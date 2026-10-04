import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { withCssPixelAlignment } from "./screenshot-alignment";

test("layout screenshot alignment normalizes paint coordinates without a transform layer", async ({
  page,
}) => {
  await page.setContent(
    '<div id="target" style="position:relative;left:10.75px;top:20.75px;width:100.5px;height:50.5px;backdrop-filter:blur(12px)!important">Evidence</div>',
  );
  const target = page.locator("#target");
  const before = await target.boundingBox();
  const styles = await target.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return ["position", "left", "top", "backdrop-filter"].map((property) => [
      style.getPropertyValue(property),
      style.getPropertyPriority(property),
    ]);
  });
  await withCssPixelAlignment(
    target,
    async () => {
      expect(await target.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
      expect(await target.evaluate((element) => getComputedStyle(element).backdropFilter)).toBe(
        "blur(12px)",
      );
      const box = await target.boundingBox();
      expect(box?.x).toBe(18);
      expect(box?.y).toBe(28);
      expect(box?.width).toBe(before?.width);
      expect(box?.height).toBe(before?.height);
    },
    "floor",
    "layout",
  );
  expect(await target.boundingBox()).toEqual(before);
  expect(
    await target.evaluate((element) => {
      const style = (element as HTMLElement).style;
      return ["position", "left", "top", "backdrop-filter"].map((property) => [
        style.getPropertyValue(property),
        style.getPropertyPriority(property),
      ]);
    }),
  ).toEqual(styles);
});

test("floor screenshot alignment does not round a viewport-edge target out of view", async ({
  page,
}) => {
  await page.setContent(
    '<div id="edge" style="position:absolute;left:10.75px;top:20.75px;width:100.5px;height:50.5px">Evidence</div>',
  );
  const target = page.locator("#edge");
  const before = await target.boundingBox();
  await withCssPixelAlignment(
    target,
    async () => {
      const box = await target.boundingBox();
      expect(box?.x).toBe(10);
      expect(box?.y).toBe(20);
      expect(box?.width).toBe(before?.width);
      expect(box?.height).toBe(before?.height);
    },
    "floor",
  );
  expect(await target.boundingBox()).toEqual(before);
});

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

test("layout screenshot alignment settles late fractional layout and restores styles", async ({
  page,
}) => {
  await page.setContent(
    '<div id="spacer" style="height:100px"></div><section style="margin-left:0.390625px;backdrop-filter:blur(2px)">Source values unchanged</section>',
  );
  const target = page.locator("section");
  await target.evaluate((element) => {
    const shiftAfterAlignment = () => {
      if ((element as HTMLElement).style.getPropertyValue("backdrop-filter") === "none") {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>("#spacer")!.style.height = "100.796875px";
        });
      } else requestAnimationFrame(shiftAfterAlignment);
    };
    requestAnimationFrame(shiftAfterAlignment);
  });
  await withCssPixelAlignment(
    target,
    async () => {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBe(Math.round(box!.x));
      expect(box!.y).toBe(Math.round(box!.y));
      await expect(target).toHaveText("Source values unchanged");
    },
    "floor",
    "settled-layout",
  );
  expect(await target.getAttribute("style")).toBe(
    "margin-left: 0.390625px; backdrop-filter: blur(2px);",
  );
});
