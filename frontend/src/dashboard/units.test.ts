import { describe, expect, it } from "vitest";

import { formatSignedValue, formatValue, normalizeUnit } from "./units";

describe("human-friendly operational units", () => {
  it("normalizes large megawatt values to gigawatts at the threshold", () => {
    expect(formatValue(999.9, "MW")).toBe("999.9 MW");
    expect(formatValue(1000, "MW")).toBe("1.0 GW");
    expect(formatValue(71_800, "MW")).toBe("71.8 GW");
    expect(formatValue(-1250, "MW")).toBe("-1.3 GW");
  });

  it("normalizes system inertia from gigawatt-seconds to terawatt-seconds", () => {
    expect(formatValue(999.9, "GW·s")).toBe("999.9 GW·s");
    expect(formatValue(1200, "GW·s")).toBe("1.2 TW·s");
    expect(normalizeUnit(-2500, "GW·s")).toMatchObject({ unit: "TW·s", value: -2.5 });
  });

  it("uses stable precision and grouping for operational values", () => {
    expect(formatValue(60, "Hz")).toBe("60.000 Hz");
    expect(formatValue(60.0014, "Hz")).toBe("60.001 Hz");
    expect(formatValue(1234.56, "customers")).toBe("1,235 customers");
    expect(formatValue(0, "%")).toBe("0.0%");
  });

  it("centralizes signed deltas without duplicating currency or unit rules", () => {
    expect(formatSignedValue(1400, "MW")).toBe("+1.4 GW");
    expect(formatSignedValue(-7.5, "$/MWh")).toBe("−$7.50/MWh");
    expect(formatSignedValue(0, "%")).toBe("0.0%");
    expect(formatSignedValue(null, "%")).toBe("—");
  });

  it("places the currency sign and negative sign naturally", () => {
    expect(formatValue(43.2, "$/MWh")).toBe("$43.20/MWh");
    expect(formatValue(-1234.5, "$/MWh")).toBe("-$1,234.50/MWh");
  });

  it("uses an em dash for missing or invalid observations", () => {
    expect(formatValue(null, "MW")).toBe("—");
    expect(formatValue(Number.NaN, "MW")).toBe("—");
  });
});
