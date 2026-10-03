import type { Locator } from "@playwright/test";

// Locator screenshots use CSS-pixel crops; fractional origins can shift text rasterization.
// Translate only during capture, retaining layout, content, and the assertion's tolerances.
export async function withCssPixelAlignment(
  target: Locator,
  capture: () => Promise<void>,
  alignment: "nearest" | "floor" = "nearest",
  positioning: "transform" | "layout" = "transform",
) {
  await target.scrollIntoViewIfNeeded();
  if (positioning === "layout") {
    const original = await target.evaluate((element, mode) => {
      const node = element as HTMLElement;
      const computed = getComputedStyle(node);
      if (computed.position !== "static" && computed.position !== "relative") {
        throw new Error("Layout screenshot alignment requires a static or relative target");
      }
      const previous = ["position", "left", "top", "backdrop-filter"].map((property) => ({
        property,
        value: node.style.getPropertyValue(property),
        priority: node.style.getPropertyPriority(property),
      }));
      const box = node.getBoundingClientRect();
      const left = computed.position === "relative" ? parseFloat(computed.left) || 0 : 0;
      const top = computed.position === "relative" ? parseFloat(computed.top) || 0 : 0;
      const align = mode === "floor" ? Math.floor : Math.round;
      if (computed.position === "static")
        node.style.setProperty("position", "relative", "important");
      node.style.setProperty("left", `${left + align(box.x) - box.x}px`, "important");
      node.style.setProperty("top", `${top + align(box.y) - box.y}px`, "important");
      // Rebuild the blur layer at canonical paint coordinates, restoring blur before capture.
      node.style.setProperty("backdrop-filter", "none", "important");
      return previous;
    }, alignment);
    try {
      await target
        .page()
        .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      await target.evaluate((element, previous) => {
        const original = previous.find(({ property }) => property === "backdrop-filter")!;
        const style = (element as HTMLElement).style;
        if (original.value) style.setProperty(original.property, original.value, original.priority);
        else style.removeProperty(original.property);
      }, original);
      await target
        .page()
        .evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      await capture();
    } finally {
      await target.evaluate((element, previous) => {
        const style = (element as HTMLElement).style;
        for (const { property, value, priority } of previous) {
          if (value) style.setProperty(property, value, priority);
          else style.removeProperty(property);
        }
      }, original);
    }
    return;
  }
  const original = await target.evaluate((element, mode) => {
    const node = element as HTMLElement;
    const previous = {
      value: node.style.getPropertyValue("transform"),
      priority: node.style.getPropertyPriority("transform"),
    };
    const box = node.getBoundingClientRect();
    const transform = getComputedStyle(node).transform;
    // Floor keeps near-viewport-edge cards inside the viewport when their origin is normalized.
    const align = mode === "floor" ? Math.floor : Math.round;
    node.style.setProperty(
      "transform",
      `translate(${align(box.x) - box.x}px, ${align(box.y) - box.y}px)${transform === "none" ? "" : ` ${transform}`}`,
      "important",
    );
    return previous;
  }, alignment);
  try {
    await capture();
  } finally {
    await target.evaluate((element, previous) => {
      const style = (element as HTMLElement).style;
      if (previous.value) style.setProperty("transform", previous.value, previous.priority);
      else style.removeProperty("transform");
    }, original);
  }
}
