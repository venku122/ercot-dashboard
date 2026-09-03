import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const fixture = "frontend/test-fixtures/datadog-date-range-picker/screenshots";
const local = "e2e/datadog-picker-conformance.spec.ts-snapshots";
const output = "artifacts/datadog-picker-conformance";
const states = {
  closed: [`${fixture}/druids-presets.png`, `${local}/picker-closed-chromium-darwin.png`],
  presets: [`${fixture}/druids-presets.png`, `${local}/picker-presets-chromium-darwin.png`],
  more: [`${fixture}/druids-more.png`, `${local}/picker-more-chromium-darwin.png`],
  calendar: [`${fixture}/druids-calendar.png`, `${local}/picker-calendar-chromium-darwin.png`],
  editing: [`${fixture}/druids-presets.png`, `${local}/picker-editing-chromium-darwin.png`],
  invalid: [`${fixture}/druids-presets.png`, `${local}/picker-invalid-chromium-darwin.png`],
  fixed: [`${fixture}/druids-presets.png`, `${local}/picker-fixed-chromium-darwin.png`],
  live: [`${fixture}/druids-presets.png`, `${local}/picker-live-chromium-darwin.png`],
  paused: [`${fixture}/druids-presets.png`, `${local}/picker-paused-chromium-darwin.png`],
  mobile: [`${fixture}/druids-presets.png`, `${local}/picker-mobile-chromium-darwin.png`],
};

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  for (const [state, [referencePath, implementationPath]] of Object.entries(states)) {
    const [reference, implementation] = await Promise.all([
      readFile(referencePath, "base64"),
      readFile(implementationPath, "base64"),
    ]);
    const dataUrl = await page.evaluate(
      async ({ implementation, reference, state }) => {
        const load = (source) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = `data:image/png;base64,${source}`;
          });
        const [left, middle] = await Promise.all([load(reference), load(implementation)]);
        const width = Math.min(760, Math.max(left.width, middle.width));
        const height = Math.min(520, Math.max(left.height, middle.height));
        const normalize = (image) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = "#000";
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height);
          const source = new Uint8ClampedArray(pixels.data);
          for (let y = 0; y < height - 1; y += 1) {
            for (let x = 0; x < width - 1; x += 1) {
              const offset = (y * width + x) * 4;
              const right = offset + 4;
              const below = offset + width * 4;
              const luminance = (index) =>
                source[index] * 0.299 + source[index + 1] * 0.587 + source[index + 2] * 0.114;
              const edge =
                Math.abs(luminance(offset) - luminance(right)) +
                  Math.abs(luminance(offset) - luminance(below)) >
                38
                  ? 255
                  : 0;
              pixels.data[offset] = edge;
              pixels.data[offset + 1] = edge;
              pixels.data[offset + 2] = edge;
              pixels.data[offset + 3] = 255;
            }
          }
          context.putImageData(pixels, 0, 0);
          return canvas;
        };
        const leftEdges = normalize(left);
        const middleEdges = normalize(middle);
        const result = document.createElement("canvas");
        result.width = width * 3 + 32;
        result.height = height + 34;
        const context = result.getContext("2d");
        context.fillStyle = "#0b1220";
        context.fillRect(0, 0, result.width, result.height);
        context.drawImage(leftEdges, 0, 34);
        context.drawImage(middleEdges, width + 16, 34);
        const leftPixels = leftEdges.getContext("2d").getImageData(0, 0, width, height);
        const middlePixels = middleEdges.getContext("2d").getImageData(0, 0, width, height);
        const difference = new ImageData(width, height);
        for (let index = 0; index < difference.data.length; index += 4) {
          const changed = Math.abs(leftPixels.data[index] - middlePixels.data[index]);
          difference.data[index] = changed;
          difference.data[index + 1] = 0;
          difference.data[index + 2] = 0;
          difference.data[index + 3] = 255;
        }
        context.putImageData(difference, width * 2 + 32, 34);
        context.fillStyle = "#f8fafc";
        context.font = "14px sans-serif";
        context.fillText(`DRUIDS edges · ${state}`, 0, 21);
        context.fillText("ERCOT edges", width + 16, 21);
        context.fillText("normalized difference", width * 2 + 32, 21);
        return result.toDataURL("image/png");
      },
      { implementation, reference, state },
    );
    await writeFile(`${output}/${state}-overlay.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
  }
  console.log(`Datadog picker overlay evidence written to ${output}`);
} finally {
  await browser.close();
}
