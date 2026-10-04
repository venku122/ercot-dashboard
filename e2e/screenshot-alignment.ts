import type { Locator } from "@playwright/test";

// Locator screenshots use CSS-pixel crops; fractional origins can shift text rasterization.
// Translate only during capture, retaining layout, content, and the assertion's tolerances.
export async function withCssPixelAlignment(
  target: Locator,
  capture: () => Promise<void>,
  alignment: "nearest" | "floor" = "nearest",
  positioning: "transform" | "layout" | "settled-layout" = "transform",
) {
  await target.scrollIntoViewIfNeeded();
  if (positioning === "layout" || positioning === "settled-layout") {
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
      // Lazy content and scroll anchoring can move the target while its blur layer
      // rebuilds. Align the settled box, then require two frames with an integer
      // crop origin and unchanged dimensions before recording source evidence.
      if (positioning === "settled-layout") {
        let settled = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const aligned = await target.evaluate((element, mode) => {
            const node = element as HTMLElement;
            const box = node.getBoundingClientRect();
            const align = mode === "floor" ? Math.floor : Math.round;
            node.style.setProperty(
              "left",
              `${(parseFloat(node.style.left) || 0) + align(box.x) - box.x}px`,
              "important",
            );
            node.style.setProperty(
              "top",
              `${(parseFloat(node.style.top) || 0) + align(box.y) - box.y}px`,
              "important",
            );
            const final = node.getBoundingClientRect();
            return { x: final.x, y: final.y, width: final.width, height: final.height };
          }, alignment);
          await target
            .page()
            .evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
            );
          settled = await target.evaluate((element, box) => {
            const final = element.getBoundingClientRect();
            return (
              Number.isInteger(final.x) &&
              Number.isInteger(final.y) &&
              final.x === box.x &&
              final.y === box.y &&
              final.width === box.width &&
              final.height === box.height
            );
          }, aligned);
          if (settled) break;
        }
        if (!settled)
          throw new Error("Screenshot target did not settle at an integer CSS-pixel origin");
      }
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
