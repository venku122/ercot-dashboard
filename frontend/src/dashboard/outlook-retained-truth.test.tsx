import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FIXED_NOW_SECONDS, outlookFixture } from "../../../e2e/mobile-fixtures";
import { buildGridOutlook, parseOutlookResponse } from "./outlook";
import { OverviewOutlook } from "./OverviewOutlook";
import type { OutlookDataRequest } from "./data-hooks";
it("discloses latest valid-empty collection even when a retained publication still has targets", () => {
  const input = outlookFixture();
  input.forecast.source_health.availability_status = "empty";
  const data = parseOutlookResponse(input);
  const html = renderToStaticMarkup(
    <OverviewOutlook
      request={
        {
          data,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: async () => data,
        } as unknown as OutlookDataRequest
      }
      now={FIXED_NOW_SECONDS}
      historical
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("valid-empty-retained");
  expect(html).toContain("showing the retained publication");
  expect(html).toContain("<svg");
});
it("keeps specialist adequacy unavailable when the same publication capacity input is absent", () => {
  const input = outlookFixture();
  input.adequacy.rows.forEach((r) => (r.available_generation_mw = null as never));
  const result = buildGridOutlook(parseOutlookResponse(input), FIXED_NOW_SECONDS);
  expect(result.next24.projectedHeadroomMw).toBeNull();
  expect(result.tightestHeadroomMw).toBeNull();
  expect(result.cards.every((c) => c.projectedHeadroomMw === null)).toBe(true);
  expect(result.days.every((d) => d.hours.every((h) => h.projectedHeadroomMw === null))).toBe(true);
});

it("keeps forecast visible while disclosing latest valid-empty adequacy collection", () => {
  const input = outlookFixture();
  input.adequacy.source_health.availability_status = "empty";
  const data = parseOutlookResponse(input);
  const html = renderToStaticMarkup(
    <OverviewOutlook
      request={
        {
          data,
          error: undefined,
          isLoading: false,
          isValidating: false,
          mutate: async () => data,
        } as unknown as OutlookDataRequest
      }
      now={FIXED_NOW_SECONDS}
      historical
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("System adequacy: latest collection was valid-empty");
  expect(html).toContain("showing retained adequacy hours");
  expect(html).toContain("Forecast demand peak");
  expect(html).toContain("<svg");
});
it("applies publication eligibility to every specialist day and hour", () => {
  const input = outlookFixture();
  input.adequacy.publication.issued_at = FIXED_NOW_SECONDS + 1;
  let result = buildGridOutlook(parseOutlookResponse(input), FIXED_NOW_SECONDS);
  expect(result.next24.projectedHeadroomMw).toBeNull();
  expect(result.tightestHeadroomMw).toBeNull();
  expect(result.days.every((d) => d.hours.every((h) => h.projectedHeadroomMw === null))).toBe(true);
  input.forecast.publication.issued_at = FIXED_NOW_SECONDS + 1;
  result = buildGridOutlook(parseOutlookResponse(input), FIXED_NOW_SECONDS);
  expect(result.next24.rows).toEqual([]);
  expect(result.cards).toEqual([]);
  expect(result.days).toEqual([]);
  expect(result.projectedPeakMw).toBeNull();
});
