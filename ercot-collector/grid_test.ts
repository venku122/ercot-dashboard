import { parseGridMetrics, validateNetLoadQuartet } from "./grid.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(callback: () => unknown) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error("expected callback to throw");
}

const CAPTURED_AT = 1_800_000_123;
const HTML = `
<table>
  <tr><td class="headerValueClass">Real-Time Data</td></tr>
  <tr><td class="tdLeft">Actual System Demand</td><td class="labelClassCenter">80,000</td></tr>
  <tr><td class="tdLeft">Average Net Load</td><td class="labelClassCenter">60,000</td></tr>
  <tr><td class="tdLeft">Total Wind Output</td><td class="labelClassCenter">15,000</td></tr>
  <tr><td class="tdLeft">Total PVGR Output</td><td class="labelClassCenter">5,000</td></tr>
</table>`;

Deno.test("real-time quartet shares one explicit response capture timestamp", () => {
  const metrics = parseGridMetrics(HTML, CAPTURED_AT);
  assertEquals(
    metrics.map((metric) => metric.metric_name),
    [
      "ercot.Real_Time_Data.Actual_System_Demand",
      "ercot.Real_Time_Data.Average_Net_Load",
      "ercot.Real_Time_Data.Total_Wind_Output",
      "ercot.Real_Time_Data.Total_PVGR_Output",
    ],
  );
  assertEquals(
    metrics.map((metric) => metric.points[0]?.timestamp),
    [CAPTURED_AT, CAPTURED_AT, CAPTURED_AT, CAPTURED_AT],
  );
});

Deno.test("real-time parser rejects an invalid capture timestamp", () => {
  assertThrows(() => parseGridMetrics(HTML, Number.NaN));
});

Deno.test("real-time net-load contract fails closed on a missing quartet metric", () => {
  const metrics = parseGridMetrics(
    HTML.replace(
      '<tr><td class="tdLeft">Total PVGR Output</td><td class="labelClassCenter">5,000</td></tr>',
      "",
    ),
    CAPTURED_AT,
  );
  assertThrows(() => validateNetLoadQuartet(metrics));
});

Deno.test("real-time net-load contract fails closed on a duplicate quartet metric", () => {
  const duplicate =
    '<tr><td class="tdLeft">Actual System Demand</td><td class="labelClassCenter">80,001</td></tr>';
  const metrics = parseGridMetrics(HTML.replace("</table>", `${duplicate}</table>`), CAPTURED_AT);
  assertThrows(() => validateNetLoadQuartet(metrics));
});
