import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import useSWR from "swr";

import { DataLifecycleMessage } from "../components/DataLifecycleMessage";
import {
  loadMarketGeographyManifest,
  loadMarketGeographyResource,
  MARKET_PRICE_POINTS,
  MARKET_REFERENCE_POINTS,
  type ConstraintRow,
  type MarketGeographyKind,
  type MarketGeographyLink,
  type PriceRow,
} from "./market-geography";
import { formatValue } from "./units";

type Layer = "prices" | "constraints";
const DEFAULT_POINT = "HB_HOUSTON--HU";
const DISPLAY_POINT_IDENTITIES = [...MARKET_PRICE_POINTS, ...MARKET_REFERENCE_POINTS].map(
  ([point, type]) => `${point}--${type}`,
);

function pointLabel(code: string) {
  return code
    .replace(/^HB_/, "")
    .replace(/^LZ_/, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/(^|\s)\w/g, (value) => value.toUpperCase());
}

function readUrlSelection() {
  const query = new URLSearchParams(window.location.search);
  const layer = query.get("marketLayer") === "constraints" ? "constraints" : "prices";
  const point = query.get("marketPoint") ?? DEFAULT_POINT;
  const constraint = query.get("marketConstraint");
  return { layer: layer as Layer, point, constraint };
}

function historySegments(rows: Array<Record<string, unknown>>) {
  const values = rows
    .map((row) => ({ target_ts: Number(row["target_ts"]), value: Number(row["value"]) }))
    .filter((row) => Number.isFinite(row.target_ts) && Number.isFinite(row.value));
  if (values.length < 2) return [];
  const first = values[0]!.target_ts;
  const elapsed = Math.max(1, values.at(-1)!.target_ts - first);
  const minimum = Math.min(...values.map((row) => row.value));
  const span = Math.max(1e-9, Math.max(...values.map((row) => row.value)) - minimum);
  const result: string[][] = [];
  let current: string[] = [];
  values.forEach((row, index) => {
    if (index && row.target_ts - values[index - 1]!.target_ts > 1_800) {
      if (current.length > 1) result.push(current);
      current = [];
    }
    current.push(
      `${((row.target_ts - first) / elapsed) * 100},${38 - ((row.value - minimum) / span) * 34}`,
    );
  });
  if (current.length > 1) result.push(current);
  return result;
}

function latestLink(
  links: MarketGeographyLink[] | undefined,
  kind: MarketGeographyKind,
  identity: string | null,
) {
  if (!identity) return null;
  return (
    (links ?? [])
      .filter((link) => link.kind === kind && link.identity === identity)
      .sort((left, right) => right.tile_start - left.tile_start)[0] ?? null
  );
}

export function MarketGeographyPanel({ enabled }: { enabled: boolean }) {
  const initial = useMemo(readUrlSelection, []);
  const [expanded, setExpanded] = useState(false);
  const [layer, setLayer] = useState<Layer>(initial.layer);
  const [selectedPoint, setSelectedPoint] = useState(initial.point);
  const [selectedConstraint, setSelectedConstraint] = useState<string | null>(initial.constraint);
  const restoring = useRef(false);

  const manifestController = useRef<AbortController | null>(null);
  const fetchManifest = useCallback(() => {
    manifestController.current?.abort();
    const controller = new AbortController();
    manifestController.current = controller;
    return loadMarketGeographyManifest(controller.signal).finally(() => {
      if (manifestController.current === controller) manifestController.current = null;
    });
  }, []);
  const manifest = useSWR(
    enabled && expanded ? ["market-geography", "manifest"] : null,
    fetchManifest,
    { keepPreviousData: false, refreshInterval: 300_000, revalidateOnFocus: true },
  );

  useEffect(() => {
    if (!manifest.data || DISPLAY_POINT_IDENTITIES.includes(selectedPoint)) return;
    setSelectedPoint(DEFAULT_POINT);
    const url = new URL(window.location.href);
    url.searchParams.set("marketPoint", DEFAULT_POINT);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [manifest.data, selectedPoint]);

  useEffect(() => {
    if (!enabled || !expanded) {
      manifestController.current?.abort();
      return;
    }
    return () => manifestController.current?.abort();
  }, [enabled, expanded]);

  useEffect(() => {
    const restore = () => {
      restoring.current = true;
      const next = readUrlSelection();
      setLayer(next.layer);
      setSelectedPoint(next.point);
      setSelectedConstraint(next.constraint);
      queueMicrotask(() => {
        restoring.current = false;
      });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const writeSelection = useCallback(
    (nextLayer: Layer, nextPoint: string, nextConstraint: string | null) => {
      if (restoring.current) return;
      const url = new URL(window.location.href);
      url.searchParams.set("marketLayer", nextLayer);
      url.searchParams.set("marketPoint", nextPoint);
      if (nextConstraint) url.searchParams.set("marketConstraint", nextConstraint);
      else url.searchParams.delete("marketConstraint");
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    },
    [],
  );

  useEffect(() => {
    const available = manifest.data?.constraints.rows ?? [];
    if (!available.length) return;
    if (
      !selectedConstraint ||
      !available.some((row) => row.constraint_key === selectedConstraint)
    ) {
      const next = available[0]!.constraint_key;
      setSelectedConstraint(next);
      if (layer === "constraints") writeSelection(layer, selectedPoint, next);
    }
  }, [layer, manifest.data, selectedConstraint, selectedPoint, writeSelection]);

  const historyLink = useMemo(
    () =>
      layer === "prices"
        ? latestLink(manifest.data?.resources, "prices", selectedPoint)
        : latestLink(manifest.data?.resources, "constraints", selectedConstraint),
    [layer, manifest.data, selectedConstraint, selectedPoint],
  );
  const historyController = useRef<AbortController | null>(null);
  const history = useSWR(
    enabled && expanded && historyLink ? ["market-geography", historyLink.url] : null,
    () => {
      historyController.current?.abort();
      const controller = new AbortController();
      historyController.current = controller;
      return loadMarketGeographyResource(historyLink!, controller.signal).finally(() => {
        if (historyController.current === controller) historyController.current = null;
      });
    },
    { keepPreviousData: false, revalidateOnFocus: false },
  );
  useEffect(() => {
    if (!enabled || !expanded) {
      historyController.current?.abort();
      return;
    }
    return () => historyController.current?.abort();
  }, [enabled, expanded]);

  const selectLayer = (next: Layer) => {
    setLayer(next);
    writeSelection(next, selectedPoint, selectedConstraint);
  };
  const selectPoint = (point: string) => {
    setSelectedPoint(point);
    writeSelection(layer, point, selectedConstraint);
  };
  const handlePointKey = (event: KeyboardEvent<HTMLButtonElement>, identity: string) => {
    const current = DISPLAY_POINT_IDENTITIES.indexOf(identity);
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = (current + 1) % DISPLAY_POINT_IDENTITIES.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = (current - 1 + DISPLAY_POINT_IDENTITIES.length) % DISPLAY_POINT_IDENTITIES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = DISPLAY_POINT_IDENTITIES.length - 1;
    else return;
    event.preventDefault();
    const selected = DISPLAY_POINT_IDENTITIES[next]!;
    selectPoint(selected);
    const buttons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
    queueMicrotask(() => buttons?.[next]?.focus());
  };
  const selectConstraint = (constraint: string) => {
    setSelectedConstraint(constraint);
    writeSelection(layer, selectedPoint, constraint);
  };

  const settlement = manifest.data?.settlement_interval;
  const constraints = manifest.data?.constraints;
  const allPrices = [...(settlement?.rows ?? []), ...(settlement?.reference_prices ?? [])];
  const values = allPrices.map((row) => row.value);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 0;
  const midpoint = Math.max(Math.abs(minimum), Math.abs(maximum), 1);
  const unhealthy = manifest.data?.source_health.some((source) => source.state !== "healthy");

  return (
    <section aria-labelledby="market-geography-title" className="market-geography-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Congestion and price geography</p>
          <h2 id="market-geography-title">Where are prices diverging?</h2>
          <p>
            A settlement-price matrix and coincident binding constraints. This is not a geographic
            boundary map or a causal price decomposition.
          </p>
        </div>
        <button
          aria-expanded={expanded}
          className="secondary-button"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Hide price-geography details" : "Load price-geography details"}
        </button>
      </div>
      {!expanded ? <p>Open to load one current evidence manifest and selected history.</p> : null}
      {expanded && manifest.isLoading ? <DataLifecycleMessage state="loading" /> : null}
      {expanded && manifest.error && !manifest.data ? (
        <DataLifecycleMessage state="unavailable" />
      ) : null}
      {expanded && manifest.error && manifest.data ? (
        <p role="status">Refresh failed; showing the last successful market-geography snapshot.</p>
      ) : null}
      {expanded && manifest.data ? (
        <>
          {unhealthy || manifest.data.materialization_health.state === "failed" ? (
            <p className="source-warning" role="status">
              One or more source or history pipelines are stale, unavailable, or failed. Source
              details appear below.
            </p>
          ) : null}
          <div aria-label="Market geography layer" className="market-geography-tabs" role="group">
            <button
              aria-pressed={layer === "prices"}
              onClick={() => selectLayer("prices")}
              type="button"
            >
              Settlement prices
            </button>
            <button
              aria-pressed={layer === "constraints"}
              onClick={() => selectLayer("constraints")}
              type="button"
            >
              Coincident constraints
            </button>
          </div>

          {layer === "prices" ? (
            <section aria-labelledby="settlement-matrix-title">
              <h3 id="settlement-matrix-title">15-minute settlement-price matrix</h3>
              <p>
                {settlement?.target_ts
                  ? `Interval ending ${new Date(settlement.target_ts * 1000).toLocaleString()}. `
                  : "No coherent settlement interval is available. "}
                Tiles are a schematic list, not Texas coordinates or boundaries.
              </p>
              {settlement?.state === "partial" ? (
                <p className="source-warning" role="status">
                  Partial publication: missing {settlement.missing.join(", ")}. Older values are not
                  borrowed.
                </p>
              ) : null}
              {allPrices.length ? (
                <>
                  <p className="market-heat-legend">
                    Fixed meaning: lower prices are blue, near-zero prices neutral, and higher
                    prices orange. Every tile also prints the exact signed value.
                  </p>
                  <div className="market-price-matrix">
                    {[...MARKET_PRICE_POINTS, ...MARKET_REFERENCE_POINTS].map(([point, type]) => {
                      const row = allPrices.find(
                        (item) =>
                          item.settlement_point === point && item.settlement_point_type === type,
                      );
                      const identity = `${point}--${type}`;
                      const normalized = row ? Math.max(-1, Math.min(1, row.value / midpoint)) : 0;
                      return (
                        <button
                          aria-label={`${pointLabel(point)} ${type}, ${row ? formatValue(row.value, "$/MWh") : "not reported"}`}
                          aria-pressed={selectedPoint === identity}
                          className={
                            normalized < -0.1
                              ? "is-lower"
                              : normalized > 0.1
                                ? "is-higher"
                                : "is-neutral"
                          }
                          key={identity}
                          onClick={() => selectPoint(identity)}
                          onKeyDown={(event) => handlePointKey(event, identity)}
                          tabIndex={selectedPoint === identity ? 0 : -1}
                          type="button"
                        >
                          <span>{pointLabel(point)}</span>
                          <small>
                            {type} · {point}
                          </small>
                          <strong>{row ? formatValue(row.value, "$/MWh") : "Not reported"}</strong>
                        </button>
                      );
                    })}
                  </div>
                  <div
                    aria-label="Settlement price exact values"
                    className="table-scroll"
                    role="region"
                    tabIndex={0}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Settlement point</th>
                          <th>Type</th>
                          <th>Price</th>
                          <th>Interval end</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allPrices.map((row) => (
                          <tr key={`${row.settlement_point}--${row.settlement_point_type}`}>
                            <td>{row.settlement_point}</td>
                            <td>{row.settlement_point_type}</td>
                            <td>{formatValue(row.value, row.unit)}</td>
                            <td>{new Date(row.target_ts * 1000).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <DataLifecycleMessage state="waiting" />
              )}
            </section>
          ) : (
            <section aria-labelledby="constraint-list-title">
              <h3 id="constraint-list-title">Constraints binding in the same SCED as LMP</h3>
              <p>
                A shadow price is the modeled marginal value of relaxing a constraint by 1 MW.
                Without settlement-point shift factors, these rows do not establish contribution to
                any displayed point price.
              </p>
              {constraints?.state === "unavailable_no_exact_sced" ? (
                <p>No NP6-86 publication matches the current NP6-788 SCED exactly.</p>
              ) : null}
              {constraints?.state === "valid_empty" ? (
                <p>The bounded exact-SCED source window returned no constraint rows.</p>
              ) : null}
              <div className="market-constraint-list">
                {(constraints?.rows ?? []).map((row) => (
                  <button
                    aria-pressed={selectedConstraint === row.constraint_key}
                    key={row.constraint_key}
                    onClick={() => selectConstraint(row.constraint_key)}
                    type="button"
                  >
                    <span>{row.constraint_name}</span>
                    <strong>{formatValue(row.shadow_price, "$/MWh")}</strong>
                    <small>
                      {row.from_station} {row.from_station_kv} kV → {row.to_station}{" "}
                      {row.to_station_kv} kV · {row.cct_status_label}
                    </small>
                  </button>
                ))}
              </div>
              {(constraints?.rows.length ?? 0) > 0 ? (
                <div
                  aria-label="Coincident binding constraint exact values"
                  className="table-scroll"
                  role="region"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Monitored element</th>
                        <th>Contingency</th>
                        <th>Path</th>
                        <th>Flow / limit</th>
                        <th>Shadow / max penalty</th>
                        <th>Competition</th>
                      </tr>
                    </thead>
                    <tbody>
                      {constraints!.rows.map((row) => (
                        <tr key={row.constraint_key}>
                          <td>{row.constraint_name}</td>
                          <td>{row.contingency_name}</td>
                          <td>
                            {row.from_station} {row.from_station_kv} kV → {row.to_station}{" "}
                            {row.to_station_kv} kV
                          </td>
                          <td>
                            {formatValue(row.value_mw, "MW")} / {formatValue(row.limit_mw, "MW")}
                            {row.limit_mw > 0
                              ? ` (${((row.value_mw / row.limit_mw) * 100).toFixed(1)}%)`
                              : " (percent unavailable)"}
                          </td>
                          <td>
                            {formatValue(row.shadow_price, "$/MWh")} /{" "}
                            {formatValue(row.max_shadow_price, "$/MWh")}
                          </td>
                          <td>{row.cct_status_label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          )}

          <section aria-labelledby="market-geography-history-title">
            <h3 id="market-geography-history-title">Selected completed-day history</h3>
            {!historyLink ? (
              <p>
                Completed-day immutable history is unavailable; collection begins at activation.
              </p>
            ) : null}
            {historyLink && history.isLoading ? <DataLifecycleMessage state="loading" /> : null}
            {history.error && !history.data ? <p>Selected history is unavailable.</p> : null}
            {history.error && history.data ? (
              <p role="status">History refresh failed; showing the last successful resource.</p>
            ) : null}
            {history.data ? (
              <>
                {layer === "prices" && history.data.rows.length > 1 ? (
                  <svg
                    aria-label="Selected settlement point completed-day profile"
                    className="market-geography-profile"
                    role="img"
                    viewBox="0 0 100 40"
                  >
                    {historySegments(history.data.rows).map((points) => (
                      <polyline
                        fill="none"
                        key={points[0]}
                        points={points.join(" ")}
                        stroke="currentColor"
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </svg>
                ) : null}
                <div
                  aria-label="Selected market geography exact history"
                  className="table-scroll"
                  role="region"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Observed</th>
                        <th>{layer === "prices" ? "Price" : "Shadow price"}</th>
                        <th>Source document</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.data.rows.map((raw, index) => {
                        const row = raw as unknown as PriceRow &
                          ConstraintRow & { source?: { document_id?: string } };
                        return (
                          <tr key={`${row.target_ts}-${index}`}>
                            <td>{new Date(row.target_ts * 1000).toLocaleString()}</td>
                            <td>
                              {formatValue(
                                layer === "prices" ? row.value : row.shadow_price,
                                "$/MWh",
                              )}
                            </td>
                            <td>{row.source?.document_id ?? "Not reported"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </section>
          <details>
            <summary>Source provenance and freshness</summary>
            <ul>
              {manifest.data.source_health.map((source) => (
                <li key={source.source_id}>
                  {source.source_id}: {source.state}; observed{" "}
                  {source.data_timestamp_ts == null
                    ? "unavailable"
                    : new Date(source.data_timestamp_ts * 1000).toLocaleString()}
                  {source.gap_count
                    ? `; ${source.gap_count} official document gap${source.gap_count === 1 ? "" : "s"} recorded`
                    : ""}
                </li>
              ))}
            </ul>
            <p>
              Settlement prices are 15-minute NP6-905 values. LMPs and constraints are per-SCED
              NP6-788 and NP6-86 values; cross-cadence arithmetic is not performed.
            </p>
          </details>
        </>
      ) : null}
    </section>
  );
}
