import { access, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const fixturePath = new URL(
  "../frontend/test-fixtures/datadog-date-range-picker/contract.json",
  import.meta.url,
);
const cssPath = new URL("../frontend/src/time-range/styles/time-range-picker.css", import.meta.url);
const contract = JSON.parse(await readFile(fixturePath, "utf8"));
const css = await readFile(cssPath, "utf8");

assert.equal(contract.schemaVersion, 1);
assert.equal(contract.geometry.toleranceCssPx, 2);
assert.equal(contract.typography.inputFontSize, 13);
assert.equal(contract.typography.inputFontWeight, 400);
assert.equal(contract.typography.inputLineHeight, 19);
assert.equal(contract.geometry.controlWidth, 375);
assert.equal(contract.geometry.desktopControlHeight, 28);
assert.equal(contract.geometry.desktopIconButtonSize, 28);
assert.equal(contract.geometry.durationPillHeight, 22);
assert.equal(contract.geometry.menuRowHeight, 28);
assert.equal(contract.geometry.menuWidth, 375);
assert.equal(contract.geometry.sidecarWidth, 332);
assert.ok(contract.states.includes("more") && contract.states.includes("calendar"));
assert.deepEqual(contract.controlOrder, [
  "Time range picker",
  "Step back",
  "Play or Pause",
  "Step forward",
]);
assert.deepEqual(contract.presetOrder, [
  "Past 5 Minutes",
  "Past 15 Minutes",
  "Past 30 Minutes",
  "Past 1 Hour",
  "Past 4 Hours",
  "Past 1 Day",
  "Past 2 Days",
  "Past 1 Week",
  "Past 1 Month",
  "Select from calendar…",
  "More",
]);
assert.deepEqual(Object.keys(contract.exampleGroups), [
  "Relative",
  "Fixed",
  "Growing",
  "Unix timestamps",
]);
for (const token of [
  "--trp-control-height",
  "--trp-menu-width",
  "--trp-sidecar-width",
  "--trp-font-size",
  "--trp-line-height",
  "--trp-pill-height",
]) {
  assert.ok(css.includes(token), `missing theme/conformance token ${token}`);
}
for (const reference of contract.visualReferences) {
  const path = new URL(
    `../frontend/test-fixtures/datadog-date-range-picker/${reference}`,
    import.meta.url,
  );
  await access(path);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  assert.equal(
    digest,
    contract.visualReferenceHashes[reference],
    `reference hash drift: ${reference}`,
  );
}
console.log("Datadog picker offline contract is structurally valid.");
