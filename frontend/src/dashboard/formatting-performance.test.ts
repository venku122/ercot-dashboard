import { afterEach, expect, it, vi } from "vitest";
import { formatValue } from "./units";
import { marketTime } from "./homepage-model";
afterEach(() => vi.restoreAllMocks());
it("ERP06 repeated same-precision readouts reuse number formatters and retain signs", () => {
  const Original = Intl.NumberFormat;
  const calls = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locale, options) {
    return new Original(locale, options);
  });
  for (let i = 0; i < 100; i++) expect(formatValue(-1, "$/MWh")).toBe("-$1.00/MWh");
  expect(calls.mock.calls.length).toBeLessThanOrEqual(1);
});
it("ERP06 repeated market labels reuse Chicago date formatter", () => {
  const Original = Intl.DateTimeFormat;
  const calls = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale, options) {
    return new Original(locale, options);
  });
  for (let i = 0; i < 100; i++) expect(marketTime(1793516400)).toContain("CST");
  expect(calls.mock.calls.length).toBeLessThanOrEqual(1);
});
