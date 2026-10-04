# Production chart investigation — October 3, 2026

## Findings

The inspected Chrome tabs initially loaded different releases: the current dashboard used `index-y_bim7KA.js`, while an older open tab used `index-BkZHKBCK.js` and the previous featured-chart layout. Reloading the older tab loaded the current asset. Both expanded-legend tabs then had 15 statistic rows. Another open overview tab had `legend=compact` and a different range. The reported disagreement after forcing a refresh on an identical URL was not reproduced; these observations establish loaded-version and URL-state differences, not a persistent caching defect. Production HTML returned `Cache-Control: no-cache` and `CF-Cache-Status: DYNAMIC`.

Production canonical chunk data for October 3 UTC showed 93 Houston Hub records: 91 consecutive intervals were 900 seconds, and one was 3600 seconds. Forecast demand had 24 records at 3600-second intervals. The display inserted NaN breaks after 600 seconds for either series. With zero point radius and `spanGaps: false`, the series had hover targets without visible connecting segments.

The reading values used normal whitespace within flex rows. Value/unit wrapping could change row height; compact legend items could also change width when cursor values changed. The timestamp strip could wrap or gain a pin button.

## Changes

- Use series-specific gap thresholds for fifteen-minute settlement prices and hourly demand forecasts, including comparison data and cursor legend lookup. Preserve real gaps and the existing coarse-bucket policy.
- Render expanded legends as semantic tables with Series, Value, Min, Max, Average, and optional Energy columns. Horizontal scrolling keeps narrow cards contained.
- Prevent cursor values from wrapping and reserve compact legend value width; keep expanded table columns stable.
- Remove the Window end/Cursor timestamp strip. Preserve timestamps in hover details, cursor evidence, and the accessible table. Retain Clear pin without affecting chart flow.

## Validation

- `pnpm run check`: typecheck, lint and format passed.
- `pnpm test`: 444 frontend, 267 receiver, and 27 contract tests passed. Receiver tests emitted SQLite ResourceWarnings but passed.
- Targeted homepage and responsive browser suite: 13 passed, covering 320–1440px, pin/clear behavior, Inspect lifecycle, and stable plot geometry during cursor movement.
- Cadence tests failed before the implementation and passed afterward; they retain breaks for missing intervals.
- Local browser preview against the public production API shows the Houston Hub line and hourly forecast line. A live hover changed all reading values while plot top (217.2109375px) and height (292px) remained identical.
- Screenshot: [live preview](live-preview.png).

Production has not been deployed or otherwise changed by this fix. The original dirty checkout was preserved. Preview: http://127.0.0.1:3107/?range=21600&live=1&legend=expanded&view=overview
