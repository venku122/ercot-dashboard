import { EvidenceDisclosure } from "./EvidenceDisclosure";
import type { GridOutlook } from "./outlook";
import { marketTime } from "./homepage-model";
import { formatValue } from "./units";

export function OutlookProfile({ outlook }: { outlook: GridOutlook }) {
  const window = outlook.next24;
  const values = window.rows.flatMap((row) => (row.demand_mw === null ? [] : [row.demand_mw]));
  if (values.length === 0)
    return <p className="outlook-empty">Next-24-hour profile is not available.</p>;
  const minimum = Math.min(...values),
    maximum = Math.max(...values);
  const spread = Math.max(1, maximum - minimum);
  const segments: string[][] = [];
  let prior: number | null = null,
    segment: string[] = [];
  for (const row of window.rows) {
    if (row.demand_mw === null || (prior !== null && row.target_ts - prior > 3600)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (row.demand_mw !== null) {
      const x = ((row.target_ts - window.from) / (window.to - window.from)) * 100;
      const y = 38 - ((row.demand_mw - minimum) / spread) * 34;
      segment.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    prior = row.target_ts;
  }
  if (segment.length) segments.push(segment);
  return (
    <figure className="outlook-profile">
      <svg
        aria-label={`Next 24 hour demand forecast from ${formatValue(minimum, "MW")} to ${formatValue(maximum, "MW")}. ${window.observedCount} of ${window.expectedCount} hourly values available; gaps are not interpolated.`}
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 100 42"
      >
        {segments.map((points, index) =>
          points.length > 1 ? (
            <polyline
              key={index}
              fill="none"
              points={points.join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          ) : (
            <circle
              key={index}
              cx={points[0]!.split(",")[0]}
              cy={points[0]!.split(",")[1]}
              r="0.8"
              fill="#22d3ee"
            />
          ),
        )}
      </svg>
      <figcaption>
        <span>{marketTime(window.from)}</span>
        <span>{marketTime(window.to)}</span>
      </figcaption>
      <EvidenceDisclosure title="Hourly forecast values">
        <div
          className="table-scroll ui-data-table"
          role="region"
          aria-label="Exact forecast evidence"
          tabIndex={0}
        >
          <table aria-label="Next 24 hour forecast values">
            <thead>
              <tr>
                <th scope="col">Interval ending · Chicago</th>
                <th scope="col">Forecast demand · MW</th>
              </tr>
            </thead>
            <tbody>
              {window.rows.map((row) => (
                <tr key={row.target_ts}>
                  <td>{marketTime(row.target_ts)}</td>
                  <td>
                    {row.demand_mw === null
                      ? "Missing"
                      : row.demand_mw.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          {window.observedCount} of {window.expectedCount} hourly values available. Missing whole
          intervals remain gaps.
        </p>
      </EvidenceDisclosure>
    </figure>
  );
}
