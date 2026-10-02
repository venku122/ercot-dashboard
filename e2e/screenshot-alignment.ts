import type { Locator } from "@playwright/test";

// Locator screenshots use CSS-pixel crops; fractional origins can shift text rasterization.
// Translate only during capture, retaining layout, content, and the assertion's tolerances.
export async function withCssPixelAlignment(target: Locator, capture: () => Promise<void>) {
  await target.scrollIntoViewIfNeeded();
  const original = await target.evaluate((element) => {
    const node = element as HTMLElement;
    const previous = {
      value: node.style.getPropertyValue("transform"),
      priority: node.style.getPropertyPriority("transform"),
    };
    const box = node.getBoundingClientRect();
    const transform = getComputedStyle(node).transform;
    node.style.setProperty(
      "transform",
      `translate(${Math.round(box.x) - box.x}px, ${Math.round(box.y) - box.y}px)${transform === "none" ? "" : ` ${transform}`}`,
      "important",
    );
    return previous;
  });
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
