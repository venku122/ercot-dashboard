import type { Locator } from "@playwright/test";

// Locator screenshots use CSS-pixel crops; fractional origins can shift text rasterization.
// Translate only during capture, retaining layout, content, and the assertion's tolerances.
export async function withCssPixelAlignment(
  target: Locator,
  capture: () => Promise<void>,
  alignment: "nearest" | "floor" = "nearest",
) {
  await target.scrollIntoViewIfNeeded();
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
