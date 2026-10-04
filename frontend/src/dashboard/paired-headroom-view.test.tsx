// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewCharts } from "./OverviewCharts";
import type { LoadedSeries } from "./types";

describe("headroom observed coverage disclosure", () => {
  it("shows paired support and collection limitations beside the same Overview chart", () => {
    const headroom: LoadedSeries = {
      points: [[90000, -10]],
      compare: [],
      error: null,
      meta: {
        pairing: {
          policy: "supply-demand-observed-exact-epoch-v1",
          paired_count: 3,
          expected_count: 289,
          collection_history: "first_collection_time_not_recorded",
        },
      },
    };
    const html = renderToStaticMarkup(
      <OverviewCharts
        renderChart={(chart) => <span>{chart.title}</span>}
        seriesData={new Map([["overview-headroom:headroom", headroom]])}
        time={{ start: 86400, end: 172800, mode: "fixed", rangeSeconds: 86400, paused: true }}
      />,
    );
    expect(html).toContain("3 paired observations");
    expect(html).toContain("289 nominal sample slots");
    expect(html).toContain("Missing contributors remain gaps");
    expect(html).toContain("first collection time is unavailable");
  });
});
