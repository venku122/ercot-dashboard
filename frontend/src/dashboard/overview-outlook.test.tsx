import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXED_NOW_SECONDS, outlookFixture } from "../../../e2e/mobile-fixtures";
import { OverviewOutlook } from "./OverviewOutlook";
import { parseOutlookResponse } from "./outlook";
import type { OutlookDataRequest } from "./data-hooks";

function render(data?: ReturnType<typeof parseOutlookResponse>, error?: Error) {
  const request = {
    data,
    error,
    isLoading: !data && !error,
    isValidating: false,
    mutate: async () => data,
  } as unknown as OutlookDataRequest;
  return renderToStaticMarkup(
    <OverviewOutlook request={request} now={FIXED_NOW_SECONDS} historical onOpen={() => {}} />,
  );
}
describe("compact current Outlook evidence states", () => {
  it("labels partial coverage and a peak confined to24 hours", () => {
    const html = render(parseOutlookResponse(outlookFixture()));
    expect(html).toContain('data-outlook-state="partial"');
    expect(html).toContain("70.4 GW");
    expect(html).toContain("2 of 24 hourly values");
    expect(html).toContain("independent of the selected historical period");
    expect(html).toContain("its own forecast/capacity basis");
  });
  it("retains the publication and provenance on a failed refresh", () => {
    const html = render(parseOutlookResponse(outlookFixture()), new Error("outlook_http_503"));
    expect(html).toContain('data-outlook-state="refresh-failed-retained"');
    expect(html).toContain("70.4 GW");
    expect(html).toContain("original issue time");
  });
  it("distinguishes stale retained values from actual observations", () => {
    const html = render(parseOutlookResponse(outlookFixture(true)));
    expect(html).toContain('data-outlook-state="stale"');
    expect(html).toContain("not current observations");
  });
  it("distinguishes valid-empty collection from unknown source availability", () => {
    const input = outlookFixture();
    input.forecast.publication = null as never;
    input.forecast.revision_reference = null as never;
    input.forecast.rows = [];
    input.forecast.source_health.availability_status = "empty";
    const empty = render(parseOutlookResponse(input));
    expect(empty).toContain('data-outlook-state="valid-empty"');
    expect(empty).toContain("valid-empty");
    expect(empty).not.toContain("<svg");
    input.forecast.source_health = null as never;
    const unknown = render(parseOutlookResponse(input));
    expect(unknown).toContain('data-outlook-state="availability-unknown"');
    expect(unknown).toContain("source eligibility is unknown");
    expect(unknown).not.toContain("<svg");
  });
  it("keeps a collected incomplete publication separate from unknown eligibility", () => {
    const input = outlookFixture();
    input.forecast.rows.forEach((row) => {
      row.demand_mw = null as never;
    });
    const html = render(parseOutlookResponse(input));
    expect(html).toContain('data-outlook-state="incomplete"');
    expect(html).toContain("no usable forecast values in the next 24 hours");
    expect(html).not.toContain("<svg");
  });
  it("keeps optional loading and initial failures compact without an empty plot", () => {
    expect(render()).toContain('data-outlook-state="loading"');
    const unavailable = render(undefined, new Error("outlook_http_503"));
    expect(unavailable).toContain("publication unavailable");
    expect(unavailable).not.toContain("<svg");
  });
});
