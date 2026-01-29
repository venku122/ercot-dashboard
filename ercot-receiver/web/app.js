const chartsById = new Map();
const cardsById = new Map();
const seriesCache = new Map();
let dashboardBuilt = false;
let lastRangeSec = null;
const sharedHover = { ts: null, active: false };
const labelMode = { legend: true, inline: true };
let weatherToggleBound = false;

const PRICING_REGIONS = [
  "HB_BUSAVG",
  "HB_HOUSTON",
  "HB_HUBAVG",
  "HB_NORTH",
  "HB_PAN",
  "HB_SOUTH",
  "HB_WEST",
  "LZ_AEN",
  "LZ_CPS",
  "LZ_HOUSTON",
  "LZ_LCRA",
  "LZ_NORTH",
  "LZ_RAYBN",
  "LZ_SOUTH",
  "LZ_WEST",
];

const METAR_STATIONS = ["KDFW", "KAUS", "KHOU", "KIAH", "KSAT"];

const CHART_CONFIGS = [
  { type: "header", title: "Real-Time Grid Conditions (60s)" },
  {
    id: "capacity_demand",
    title: "Capacity & Demand",
    type: "multi",
    unit: "GW",
    unitScale: 0.001,
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Demand is ERCOT system load. Available capacity is currently available generation capacity. Unused capacity is capacity minus demand.",
    yLabel: "Power (GW)",
    ySuggestedMin: 0,
    ySuggestedMax: 120,
    valueSummary: { op: "pair", labels: ["Demand", "Capacity"] },
    tooltipTimestamp: true,
    tooltipFooter: (items) => {
      const demandItem = items.find((item) => item.dataset.label?.includes("Demand"));
      const capacityItem = items.find((item) => item.dataset.label?.includes("Capacity"));
      if (!demandItem || !capacityItem) return null;
      const demand = valueFromCtx(demandItem);
      const capacity = valueFromCtx(capacityItem);
      if (demand === null || capacity === null) return null;
      const unused = capacity - demand;
      return `Unused Capacity: ${formatDisplayValue(unused, { unit: "GW" })}`;
    },
    series: [
      { label: "Demand (GW)", metric: "ercot.Real_Time_Data.Actual_System_Demand" },
      { label: "Available Capacity (GW)", metric: "ercot.Real_Time_Data.Total_System_Capacity", secondary: true },
    ],
  },
  {
    id: "unused_capacity",
    title: "Unused Capacity & Operating Reserves",
    type: "multi",
    unit: "GW",
    unitScale: 0.001,
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Unused capacity is headroom between available capacity and demand. Operating reserves may differ depending on ERCOT definition.",
    yLabel: "Headroom (GW)",
    ySuggestedMin: 0,
    ySuggestedMax: 50,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    series: [
      {
        label: "Unused Capacity (GW)",
        fillBySign: true,
        compute: {
          op: "minus",
          left: { metric: "ercot.Real_Time_Data.Total_System_Capacity" },
          right: { metric: "ercot.Real_Time_Data.Actual_System_Demand" },
        },
      },
      { label: "Operating Reserves (GW)", metric: "ercot_ancillary.prc", secondary: true },
    ],
  },
  {
    id: "frequency",
    title: "Grid Frequency",
    metric: "ercot.Frequency.Current_Frequency",
    unit: "Hz",
    severity: "frequency",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description: "ERCOT grid frequency should hover near 60 Hz. Deviations reflect system imbalance.",
    yLabel: "Frequency (Hz)",
    yMin: 59.9,
    yMax: 60.1,
    band: { min: 59.975, max: 60.025, color: "rgba(46, 204, 113, 0.12)" },
    tooltipTimestamp: true,
    referenceLines: [{ value: 60, color: "rgba(255,255,255,0.4)" }],
  },
  {
    id: "time_error_delta",
    title: "Time \"Error\" / Offset from ideal 60Hz clock - DELTA",
    unit: "sec",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Change in instantaneous time error between 60-second samples.",
    yLabel: "Offset delta (sec)",
    yMin: -1,
    yMax: 1,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    compute: {
      op: "diff",
      source: { metric: "ercot.Frequency.Instantaneous_Time_Error" },
    },
  },
  {
    id: "time_error_late",
    title: "Time \"Error\" / Offset from ideal 60Hz clock - LATEST",
    metric: "ercot.Frequency.Instantaneous_Time_Error",
    unit: "sec",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Instantaneous time error at the latest sample.",
    yLabel: "Offset (sec)",
    yMin: -15,
    yMax: 0,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
  },
  {
    id: "wind_solar",
    title: "Wind & Solar Generation",
    type: "multi",
    unit: "GW",
    unitScale: 0.001,
    subtitle: "Real-time (60s) · Source: ERCOT",
    description: "Real-time generation output by fuel type (wind and solar).",
    yLabel: "Generation (GW)",
    ySuggestedMin: 0,
    ySuggestedMax: 50,
    valueSummary: { op: "sum" },
    tooltipTimestamp: true,
    series: [
      { label: "Wind (GW)", metric: "ercot.Real_Time_Data.Total_Wind_Output" },
      { label: "Solar (GW)", metric: "ercot.Real_Time_Data.Total_PVGR_Output", secondary: true },
    ],
  },
  {
    id: "inertia",
    title: "System Inertia",
    metric: "ercot.Real_Time_Data.Current_System_Inertia",
    unit: "GW·s",
    unitScale: 0.001,
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Inertia is a system stability proxy reflecting rotational energy available to resist frequency changes.",
    yLabel: "Inertia (GW·s)",
    ySuggestedMin: 0,
    ySuggestedMax: 600,
    tooltipTimestamp: true,
  },
  {
    id: "dc_ties",
    title: "Net Interchange",
    type: "multi",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description: "Net interchange across ERCOT ties. Positive = Imports into ERCOT; Negative = Exports.",
    yLabel: "Power Flow (MW)",
    yMin: -1000,
    yMax: 1000,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    series: [
      {
        label: "Total Net Flow (MW)",
        compute: {
          op: "sum",
          series: [
            { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_E" },
            { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_N" },
            { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_L" },
            { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_R" },
            { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_S" },
          ],
        },
      },
      { label: "DC_E (MW)", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_E" },
      { label: "DC_N (MW)", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_N" },
      { label: "DC_L (MW)", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_L" },
      { label: "DC_R (MW)", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_R" },
      { label: "DC_S (MW)", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_S" },
    ],
  },

  { type: "header", title: "Big Honkin' Numbers" },
  {
    id: "big_capacity",
    title: "Generation Capacity",
    metric: "ercot.Real_Time_Data.Total_System_Capacity",
    unit: "GW",
    unitScale: 0.001,
    format: "1dp",
    type: "single",
    emphasize: true,
    subtitle: "Real-time (60s) · Source: ERCOT",
  },
  {
    id: "big_frequency",
    title: "Grid Frequency",
    metric: "ercot.Frequency.Current_Frequency",
    unit: "Hz",
    format: "3dp",
    type: "single",
    emphasize: true,
    severity: "frequency",
    subtitle: "Real-time (60s) · Source: ERCOT",
  },
  {
    id: "big_unused",
    title: "Unused System Capacity",
    unit: "GW",
    unitScale: 0.001,
    format: "2dp",
    type: "single-compute",
    emphasize: true,
    severity: "unused_capacity",
    subtitle: "Real-time (60s) · Source: ERCOT",
    compute: {
      op: "latest_minus",
      left: { metric: "ercot.Real_Time_Data.Total_System_Capacity" },
      right: { metric: "ercot.Real_Time_Data.Actual_System_Demand" },
    },
  },
  {
    id: "big_dc_net",
    title: "DC Flow / Net Interchange",
    unit: "MW",
    type: "single-compute",
    emphasize: true,
    subtitle: "Real-time (60s) · Source: ERCOT",
    description: "Positive = Imports into ERCOT; Negative = Exports.",
    compute: {
      op: "latest_sum",
      series: [
        { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_E" },
        { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_N" },
        { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_L" },
        { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_R" },
        { metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_S" },
      ],
    },
  },
  {
    id: "big_price_high",
    title: "Highest Recent Settlement Price",
    unit: "$/MWh",
    type: "single-compute",
    emphasize: true,
    severity: "price",
    subtitle: "Updates every 15 minutes · Source: ERCOT SPP",
    compute: {
      op: "max_latest",
      series: PRICING_REGIONS.map((region) => ({
        metric: "ercot.pricing",
        tag: `ercot_region:${region}`,
        label: region,
      })),
    },
  },
  {
    id: "big_outages",
    title: "Outages (Total)",
    unit: "customers",
    type: "single-compute",
    emphasize: true,
    severity: "outages",
    subtitle: "Checked hourly · Source: poweroutage.us",
    compute: {
      op: "latest_sum_all",
      source: { metric: "poweroutageus.customers" },
    },
  },

  { type: "header", title: "ERCOT Ancillary Real Time" },
  {
    id: "supply_regulation",
    title: "Supply Regulation",
    type: "multi",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT Ancillary",
    description:
      'Reg-Up/Reg-Down awards (sum of all awards). See ERCOT definitions for <a href="http://www.ercot.com/content/cdr/html/as_capacity_monitor.html" target="_blank" rel="noopener noreferrer">Ancillary Service Capacity Monitor</a>.',
    yLabel: "Regulation (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 1000,
    tooltipTimestamp: true,
    series: [
      { label: "Reg-Up (MW)", metric: "ercot_ancillary.regUpAwd" },
      { label: "Reg-Down (MW)", metric: "ercot_ancillary.regDownAwd", secondary: true },
    ],
  },
  {
    id: "offline_minus_quickstart",
    title: "Offline Generation (Excluding Quick Start)",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT Ancillary",
    description: "Generation capacity currently offline, excluding quick-start resources (per ERCOT definition).",
    yLabel: "Offline Generation (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 2700,
    tooltipTimestamp: true,
    compute: {
      op: "minus",
      left: { metric: "ercot_ancillary.nsrCapOffGen" },
      right: { metric: "ercot_ancillary.ecrsCapQs" },
    },
  },
  {
    id: "online_reserve_capacity",
    title: "On-line Reserve Capacity",
    metric: "ercot_ancillary.rtReserveOnline",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT Ancillary",
    description: "Reserve capacity available from online resources (define which reserve product(s) are included).",
    yLabel: "Reserve Capacity (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 15000,
    tooltipTimestamp: true,
    hideIfEmpty: true,
    hideIfZero: true,
  },
  {
    id: "ancillary_reserve_offline",
    title: "On/Offline Reserve Capacity",
    type: "multi",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT Ancillary",
    tooltipTimestamp: true,
    hideIfEmpty: true,
    hideIfZero: true,
    series: [
      { label: "Online", metric: "ercot_ancillary.rtReserveOnline" },
      { label: "Offline", metric: "ercot_ancillary.rtReserveOnOffline", secondary: true },
    ],
  },

  { type: "header", title: "Wholesale Electricity Pricing Market (15m)" },
  {
    id: "settlement_top",
    title: "Latest Settlement Point Prices (Top)",
    type: "table",
    unit: "$/MWh",
    subtitle: "Updates every 15 minutes · Source: ERCOT SPP",
    description:
      "Top settlement points by latest price. Prices may be negative and may spike during scarcity events.",
    tableColumns: ["Settlement Point", "Price ($/MWh)"],
    topN: 10,
    series: PRICING_REGIONS.map((region) => ({
      metric: "ercot.pricing",
      tag: `ercot_region:${region}`,
      label: region,
    })),
  },
  {
    id: "settlement_prices",
    title: "Settlement Point Prices",
    type: "multi",
    unit: "$/MWh",
    subtitle: "Updates every 15 minutes · Source: ERCOT SPP",
    description: "Time series of settlement point prices. Use spike-aware scaling to preserve readability.",
    yLabel: "Price ($/MWh)",
    ySuggestedMin: -100,
    ySuggestedMax: 500,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    series: [
      { label: "HB_HOUSTON", metric: "ercot.pricing", tag: "ercot_region:HB_HOUSTON" },
      { label: "HB_NORTH", metric: "ercot.pricing", tag: "ercot_region:HB_NORTH", secondary: true },
      { label: "HB_SOUTH", metric: "ercot.pricing", tag: "ercot_region:HB_SOUTH", secondary: true },
      { label: "HB_WEST", metric: "ercot.pricing", tag: "ercot_region:HB_WEST", secondary: true },
      { label: "HB_HUBAVG", metric: "ercot.pricing", tag: "ercot_region:HB_HUBAVG", secondary: true },
    ],
  },

  { type: "header", title: "Outages" },
  {
    id: "outages_total",
    title: "Outage Reports",
    unit: "customers",
    severity: "outages",
    tone: "muted",
    subtitle: "Checked hourly · Source: poweroutage.us",
    description:
      "Outage estimates are third-party and may be incomplete. Values reflect reported customers without power.",
    yLabel: "Customers Out",
    ySuggestedMin: 0,
    ySuggestedMax: 2000000,
    tooltipTimestamp: true,
    hideIfEmpty: true,
    compute: {
      op: "sum_all",
      source: { metric: "poweroutageus.customers" },
    },
  },

  { type: "header", id: "weather_header", title: "Nearby Weather (METAR)", weatherToggle: true },
  {
    id: "metar_temp",
    title: "Temperature (by Airport)",
    type: "multi",
    weatherType: "temp",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Airport METAR observations near ERCOT load/generation centers.",
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.temperature",
      tag: `metar_code:${code}`,
      secondary: true,
      weatherType: "temp",
    })),
  },
  {
    id: "metar_winds",
    title: "Wind Speed (by Airport)",
    type: "multi",
    weatherType: "wind",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Observed sustained wind speed. Gusts may not be shown unless explicitly ingested.",
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.winds.speed",
      tag: `metar_code:${code}`,
      secondary: true,
      weatherType: "wind",
    })),
  },
  {
    id: "metar_dewpoint",
    title: "Dewpoint (by Airport)",
    type: "multi",
    weatherType: "dewpoint",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Dewpoint is a proxy for humidity and impacts load via comfort cooling demand.",
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.dewpoint",
      tag: `metar_code:${code}`,
      secondary: true,
      weatherType: "dewpoint",
    })),
  },
  {
    id: "metar_pressure",
    title: "Observed Air Pressure",
    type: "multi",
    weatherType: "pressure",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Barometric pressure observations from METAR stations.",
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.pressure",
      tag: `metar_code:${code}`,
      secondary: true,
      weatherType: "pressure",
    })),
  },
  {
    id: "metar_wind_temp_combined",
    title: "Wind Speed & Temperature",
    type: "multi",
    weatherCombined: true,
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Combined view to correlate weather and grid behavior. Dual-axis must be labeled to avoid misleading scaling.",
    tooltipTimestamp: true,
    series: [
      {
        label: "Temp",
        metric: "metar.temperature",
        tag: `metar_code:${METAR_STATIONS[0]}`,
        weatherType: "temp",
        yAxisID: "y",
      },
      {
        label: "Wind",
        metric: "metar.winds.speed",
        tag: `metar_code:${METAR_STATIONS[0]}`,
        weatherType: "wind",
        yAxisID: "y1",
        secondary: true,
      },
    ],
  },

  { type: "header", title: "System / Meta" },
  {
    id: "duty_cycle",
    title: "Metrics Scrapers — Duty Cycle",
    type: "multi",
    unit: "%",
    subtitle: "Real-time · Source: Internal",
    description: "Share of time the scraper is active. Sustained high values indicate backlog or under-provisioning.",
    yLabel: "Duty Cycle (%)",
    yMin: 0,
    yMax: 100,
    tooltipTimestamp: true,
    series: [
      { label: "ercot_realtime", metric: "ercot.app.duty_cycle", tag: "app:ercot_realtime" },
      { label: "ercot_ancillary", metric: "ercot.app.duty_cycle", tag: "app:ercot_ancillary", secondary: true },
      { label: "ercot_eea", metric: "ercot.app.duty_cycle", tag: "app:ercot_eea", secondary: true },
      { label: "ercot_pricing", metric: "ercot.app.duty_cycle", tag: "app:ercot_pricing", secondary: true },
      { label: "poweroutages_us", metric: "ercot.app.duty_cycle", tag: "app:poweroutages_us", secondary: true },
      { label: "metar", metric: "ercot.app.duty_cycle", tag: "app:metar", secondary: true },
    ],
  },
  {
    id: "eea_level",
    title: "EEA Level #",
    metric: "ercot.eea_level",
    unit: "",
    type: "single",
    severity: "eea",
    subtitle: "Real-time · Source: ERCOT",
    description: "Emergency Energy Alert (EEA) level indicator. Discrete state; not a continuous value.",
    yLabel: "EEA Level",
    yMin: 0,
    yMax: 3,
    stepSize: 1,
    format: "integer",
    tooltipTimestamp: true,
  },
];

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function applySectionXAxis(configs) {
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const last = current[current.length - 1];
    last.showXAxis = true;
    current = [];
  };
  for (const cfg of configs) {
    if (cfg.type === "header") {
      flush();
      continue;
    }
    const hasCanvas = !cfg.type || cfg.type === "multi" || cfg.type === undefined;
    if (hasCanvas) current.push(cfg);
  }
  flush();
}

applySectionXAxis(CHART_CONFIGS);

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) {
    throw new Error(`Request failed ${resp.status}`);
  }
  return resp.json();
}

function buildSeriesUrl(metric, since, tags) {
  const params = new URLSearchParams();
  params.set("metric", metric);
  if (since) params.set("since", String(since));
  (tags || []).forEach((tag) => params.append("tag", tag));
  return `/api/series?${params.toString()}`;
}

function buildLatestUrl(metric, tags) {
  const params = new URLSearchParams();
  params.set("metric", metric);
  (tags || []).forEach((tag) => params.append("tag", tag));
  return `/api/latest?${params.toString()}`;
}

function keyFor(metric, since, tags, until) {
  return JSON.stringify({ metric, since, until, tags: tags || [] });
}

function seriesKey(metric, tags) {
  return JSON.stringify({ metric, tags: tags || [] });
}

function maxPointsForRange(rangeSec) {
  if (rangeSec <= 21600) return null;
  const target = Math.floor(rangeSec / 60);
  return Math.max(300, Math.min(1200, target));
}

async function fetchSeriesBatch(queries) {
  return fetchJson("/api/series/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  });
}

async function fetchLatestBatch(queries) {
  return fetchJson("/api/latest/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  });
}

function alignSeriesList(seriesList) {
  const counts = new Map();
  const sums = new Map();
  for (const series of seriesList) {
    for (const [ts, value] of series) {
      const key = String(ts);
      sums.set(key, (sums.get(key) || 0) + value);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const aligned = [];
  for (const [key, sum] of sums.entries()) {
    if (counts.get(key) !== seriesList.length) continue;
    aligned.push([parseInt(key, 10), sum]);
  }
  aligned.sort((a, b) => a[0] - b[0]);
  return aligned;
}

function alignSeries(left, right) {
  const rightMap = new Map(right.map(([ts, value]) => [ts, value]));
  const merged = [];
  for (const [ts, value] of left) {
    if (!rightMap.has(ts)) continue;
    merged.push([ts, value - rightMap.get(ts)]);
  }
  return merged;
}

function formatNumber(value, format) {
  if (format === "integer") return Math.round(value).toFixed(0);
  if (format === "1dp") return value.toFixed(1);
  if (format === "2dp") return value.toFixed(2);
  if (format === "3dp") return value.toFixed(3);
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function applyUnitScale(value, config) {
  const scale = config?.unitScale ?? 1;
  return value * scale;
}

function formatValue(value, unit, config) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const rounded = formatNumber(value, config?.format);
  return { value: rounded, unit: unit || "" };
}

function formatDisplayValue(value, config) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = formatNumber(value, config?.format);
  if (config?.unit === "$/MWh") {
    return `$${rounded} /MWh`;
  }
  return `${rounded}${config?.unit ? ` ${config.unit}` : ""}`.trim();
}

function latestPointValue(series) {
  if (!series || !series.points || !series.points.length) return null;
  return series.points[series.points.length - 1].y;
}

function summaryValueForSeries(config, seriesList) {
  const summary = config?.valueSummary;
  if (!summary) return null;
  if (summary.op === "sum") {
    const values = seriesList.map((series) => latestPointValue(series)).filter((val) => val !== null);
    if (!values.length) return null;
    const total = values.reduce((acc, val) => acc + val, 0);
    return formatValue(total, config.unit, config);
  }
  if (summary.op === "pair") {
    const left = latestPointValue(seriesList[0]);
    const right = latestPointValue(seriesList[1]);
    if (left === null || right === null) return null;
    const leftText = formatNumber(left, config.format);
    const rightText = formatNumber(right, config.format);
    const labels = summary.labels || [];
    const leftLabel = labels.length >= 2 ? labels[0] : "Left";
    const rightLabel = labels.length >= 2 ? labels[1] : "Right";
    const unit = config.unit || "";
    const html = `
      <span class="value-pair">
        <span class="value-label">${leftLabel}</span>
        <span class="value-number">${leftText}</span>
        <span class="value-unit">${unit}</span>
        <span class="value-sep">/</span>
        <span class="value-label">${rightLabel}</span>
        <span class="value-number">${rightText}</span>
        <span class="value-unit">${unit}</span>
      </span>
    `;
    return { html, value: leftText, unit, numericValue: left };
  }
  return null;
}

function wrapText(text, maxLen) {
  if (!text || text.length <= maxLen) return [text];
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if ((line + " " + word).length > maxLen) {
      lines.push(line);
      line = word;
    } else {
      line += ` ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [text];
}

let tooltipTimezone = "local";
let weatherUnits = "imperial";

function formatTimestamp(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  return date.toLocaleString();
}

function formatTooltipTimestamp(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  const options = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  if (tooltipTimezone === "utc") {
    return `${date.toLocaleString(undefined, { ...options, timeZone: "UTC" })} UTC`;
  }
  return date.toLocaleString(undefined, options);
}

function weatherMeta(type) {
  const metric = {
    temp: { unit: "°C", yMin: -20, yMax: 45, label: "Temperature (°C)", convert: (v) => v },
    dewpoint: { unit: "°C", yMin: -30, yMax: 30, label: "Dewpoint (°C)", convert: (v) => v },
    wind: { unit: "km/h", yMin: 0, yMax: 130, label: "Wind Speed (km/h)", convert: (v) => v * 1.60934 },
    pressure: { unit: "hPa", yMin: 948, yMax: 1067, label: "Pressure (hPa)", convert: (v) => v * 33.8639 },
  };
  const imperial = {
    temp: { unit: "°F", yMin: -4, yMax: 113, label: "Temperature (°F)", convert: (v) => v * 9 / 5 + 32 },
    dewpoint: { unit: "°F", yMin: -22, yMax: 86, label: "Dewpoint (°F)", convert: (v) => v * 9 / 5 + 32 },
    wind: { unit: "mph", yMin: 0, yMax: 80, label: "Wind Speed (mph)", convert: (v) => v },
    pressure: { unit: "inHg", yMin: 28, yMax: 31.5, label: "Pressure (inHg)", convert: (v) => v },
  };
  return (weatherUnits === "metric" ? metric : imperial)[type];
}

function resolveWeatherConfig(config) {
  if (!config.weatherType && !config.weatherCombined) return config;
  const resolved = { ...config };
  if (config.weatherType) {
    const meta = weatherMeta(config.weatherType);
    resolved.unit = meta.unit;
    resolved.yLabel = meta.label;
    resolved.yMin = meta.yMin;
    resolved.yMax = meta.yMax;
  }
  if (config.weatherCombined) {
    const tempMeta = weatherMeta("temp");
    const windMeta = weatherMeta("wind");
    resolved.unit = tempMeta.unit;
    resolved.yLabel = tempMeta.label;
    resolved.yMin = tempMeta.yMin;
    resolved.yMax = tempMeta.yMax;
    resolved.scales = {
      y: {
        position: "left",
        title: { display: true, text: tempMeta.label },
        min: tempMeta.yMin,
        max: tempMeta.yMax,
        ticks: {
          color: "#9fb3c8",
          callback: (value) => `${value} ${tempMeta.unit}`,
        },
      },
      y1: {
        position: "right",
        title: { display: true, text: windMeta.label },
        min: windMeta.yMin,
        max: windMeta.yMax,
        grid: { drawOnChartArea: false },
        ticks: {
          color: "#9fb3c8",
          callback: (value) => `${value} ${windMeta.unit}`,
        },
      },
    };
  }
  return resolved;
}

function severityFor(config, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "muted";
  if (config.severity === "eea") {
    if (value <= 0) return "good";
    if (value === 1) return "warn";
    if (value === 2) return "stress";
    return "danger";
  }
  if (config.severity === "frequency") {
    if (value >= 59.95) return "good";
    if (value >= 59.9) return "warn";
    return "danger";
  }
  if (config.severity === "unused_capacity") {
    if (value < 0) return "danger";
    return "good";
  }
  if (config.severity === "price") {
    if (value >= 5000) return "danger";
    if (value >= 2000) return "stress";
    if (value >= 500) return "warn";
    return "good";
  }
  if (config.severity === "outages") {
    if (value === 0) return "good";
    if (value >= 10000) return "danger";
    if (value >= 1000) return "stress";
    return "warn";
  }
  return "neutral";
}

function applyValueState(el, config, value) {
  el.className = "value";
  const severity = severityFor(config, value);
  el.classList.add(`value-${severity}`);
}

function setValue(el, config, valueObj, emptyLabel) {
  if (!valueObj) {
    el.textContent = emptyLabel || "No data in window";
    el.className = "value value-muted";
    return;
  }
  const numeric = typeof valueObj.numericValue === "number" ? valueObj.numericValue : parseFloat(valueObj.value);
  if (Number.isNaN(numeric)) {
    el.className = "value value-neutral";
  } else {
    applyValueState(el, config, numeric);
  }
  if (valueObj.html) {
    el.innerHTML = valueObj.html;
    return;
  }
  el.innerHTML = `<span class="value-number">${valueObj.value}</span><span class="value-unit">${valueObj.unit}</span>`;
}

function createCard(config) {
  const card = document.createElement("div");
  card.className = "card";
  if (config.emphasize) card.classList.add("card-emphasis");
  if (config.tone === "muted") card.classList.add("card-muted");

  const header = document.createElement("div");
  header.className = "card-header";
  const title = document.createElement("h2");
  title.textContent = config.title;
  header.appendChild(title);
  card.appendChild(header);

  const pills = document.createElement("div");
  pills.className = "card-pills";
  if (config.subtitle) {
    config.subtitle
      .split("·")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const isSource = part.toLowerCase().startsWith("source:");
        if (isSource) {
          const pillLink = document.createElement("a");
          pillLink.className = "pill pill-link";
          pillLink.href = "https://gist.github.com/danopia/c0c4313b4809d565af7c7738bcdbeec7";
          pillLink.target = "_blank";
          pillLink.rel = "noopener noreferrer";
          pillLink.textContent = part;
          pills.appendChild(pillLink);
        } else {
          const pill = document.createElement("span");
          pill.className = "pill";
          pill.textContent = part;
          pills.appendChild(pill);
        }
      });
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = config.metric ? `Metric: ${config.metric}` : "Metric: derived";

  const value = document.createElement("div");
  value.className = "value";
  value.textContent = "—";
  card.appendChild(value);

  const updated = null;
  let help = null;
  if (config.description) {
    help = document.createElement("div");
    help.className = "help-text";
    help.innerHTML = config.description;
  }

  let canvas = null;
  let legend = null;
  let table = null;
  if (config.type === "table") {
    value.style.display = "none";
  }
  if (!config.type || config.type === "multi") {
    legend = document.createElement("div");
    legend.className = "chart-legend";
    if (config.id) legend.dataset.chartId = `chart-${config.id}`;
    card.appendChild(legend);

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "canvas-wrap";
    canvas = document.createElement("canvas");
    if (config.id) canvas.id = `chart-${config.id}`;
    canvasWrap.appendChild(canvas);
    card.appendChild(canvasWrap);
  }

  if (config.type === "table") {
    table = document.createElement("table");
    table.className = "data-table";
    if (config.id === "settlement_top") {
      table.classList.add("price-bar-table");
    }
    const header = document.createElement("thead");
    const headerRow = document.createElement("tr");
    (config.tableColumns || []).forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.appendChild(th);
    });
    header.appendChild(headerRow);
    table.appendChild(header);
    const body = document.createElement("tbody");
    table.appendChild(body);
    card.appendChild(table);
  }

  if (help) {
    card.appendChild(help);
  }

  const footer = document.createElement("div");
  footer.className = "card-footer";
  if (pills.childElementCount > 0) {
    footer.appendChild(pills);
  }
  footer.appendChild(meta);
  card.appendChild(footer);

  return { card, canvas, value, legend, table, updated };
}

function valueFromCtx(ctx) {
  if (ctx && ctx.parsed && typeof ctx.parsed.y === "number") return ctx.parsed.y;
  if (ctx && ctx.raw && typeof ctx.raw.y === "number") return ctx.raw.y;
  if (ctx && typeof ctx.raw === "number") return ctx.raw;
  return null;
}

function labelColor(value) {
  if (!value) return "#9fb3c8";
  return value;
}

function buildScales(config, unit, showXAxis) {
  const yTitle = config.yLabel || (unit ? `${unit}` : "");
  const yScale = {
    ticks: {
      color: "#9fb3c8",
      stepSize: config.stepSize,
      callback: (value) => {
        const numeric = Number(value);
        const formatted = Number.isNaN(numeric) ? value : formatNumber(numeric, config?.format);
        return `${formatted}${unit ? " " + unit : ""}`;
      },
    },
    grid: { color: "rgba(255,255,255,0.035)" },
    title: yTitle ? { display: true, text: yTitle, color: "#9fb3c8", font: { size: 11 } } : undefined,
    min: config.yMin,
    max: config.yMax,
    suggestedMin: config.ySuggestedMin,
    suggestedMax: config.ySuggestedMax,
  };
  const scales = {
    x: {
      type: "time",
      time: { tooltipFormat: "MMM d HH:mm" },
      ticks: { color: "#9fb3c8", display: showXAxis },
      grid: { color: "rgba(255,255,255,0.035)", display: showXAxis },
    },
    y: yScale,
  };
  if (config.scales) {
    return { x: scales.x, ...config.scales };
  }
  return scales;
}

function nearestIndexByTs(points, ts) {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].x < ts) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo === 0) return 0;
  const prev = points[lo - 1];
  const curr = points[lo];
  return Math.abs(prev.x - ts) <= Math.abs(curr.x - ts) ? lo - 1 : lo;
}

const referenceLinePlugin = {
  id: "referenceLines",
  afterDraw(chart, args, options) {
    const lines = options?.lines || [];
    if (!lines.length) return;
    const ctx = chart.ctx;
    ctx.save();
    lines.forEach((line) => {
      const scale = chart.scales[line.scaleId || "y"];
      if (!scale) return;
      const y = scale.getPixelForValue(line.value);
      if (Number.isNaN(y)) return;
      ctx.strokeStyle = line.color || "rgba(255,255,255,0.3)";
      ctx.lineWidth = line.width || 1;
      ctx.beginPath();
      ctx.moveTo(chart.chartArea.left, y);
      ctx.lineTo(chart.chartArea.right, y);
      ctx.stroke();
    });
    ctx.restore();
  },
};

const bandPlugin = {
  id: "band",
  beforeDatasetsDraw(chart, args, opts) {
    const band = opts?.band;
    if (!band) return;
    const scale = chart.scales.y;
    if (!scale) return;
    const top = scale.getPixelForValue(band.max);
    const bottom = scale.getPixelForValue(band.min);
    const { left, right } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = band.color || "rgba(46, 204, 113, 0.12)";
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.restore();
  },
};

function applySharedHover(ts) {
  sharedHover.ts = ts;
  sharedHover.active = ts !== null;
  for (const chart of chartsById.values()) {
    if (!chart) continue;
    const active = [];
    for (let di = 0; di < chart.data.datasets.length; di += 1) {
      const data = chart.data.datasets[di].data || [];
      if (!data.length) continue;
      const idx = nearestIndexByTs(data, ts);
      if (idx === null) continue;
      active.push({ datasetIndex: di, index: idx });
    }
    if (active.length) {
      const x = chart.scales.x.getPixelForValue(ts);
      chart.tooltip.setActiveElements(active, { x, y: chart.chartArea.top });
    } else {
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    }
    chart.draw();
  }
}

function clearSharedHover() {
  sharedHover.ts = null;
  sharedHover.active = false;
  for (const chart of chartsById.values()) {
    if (!chart) continue;
    chart.tooltip.setActiveElements([], { x: 0, y: 0 });
    chart.draw();
  }
}

const inlineLabelPlugin = {
  id: "inlineSeriesLabels",
  afterDatasetsDraw(chart) {
    if (!labelMode.inline) return;
    if (sharedHover.active && chart.tooltip && chart.tooltip.getActiveElements().length) return;
    const { ctx, chartArea } = chart;
    const { right, top, bottom } = chartArea;
    ctx.save();
    ctx.font = "600 11px 'IBM Plex Mono', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    chart.data.datasets.forEach((dataset, idx) => {
      const meta = chart.getDatasetMeta(idx);
      if (!meta || meta.hidden || !meta.data.length) return;
      const point = meta.data[meta.data.length - 1];
      if (!point) return;
      const x = Math.min(point.x + 8, right - 60);
      const y = Math.min(Math.max(point.y, top + 8), bottom - 8);
      ctx.fillStyle = labelColor(dataset.borderColor);
      ctx.fillText(dataset.label || "", x, y);
    });
    ctx.restore();
  },
};

const htmlLegendPlugin = {
  id: "htmlLegend",
  afterUpdate(chart, args, options) {
    const container = options && options.container;
    if (!container) return;
    if (!labelMode.legend) {
      container.style.display = "none";
      container.innerHTML = "";
      return;
    }
    container.style.display = "flex";
    container.innerHTML = "";
    const items = chart.options.plugins.legend.labels.generateLabels(chart);
    for (const item of items) {
      const label = document.createElement("div");
      label.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = item.strokeStyle;
      if (item.lineDash && item.lineDash.length) {
        swatch.style.borderStyle = "dashed";
      }
      const text = document.createElement("span");
      text.className = "legend-text";
      text.textContent = item.text;
      label.appendChild(swatch);
      label.appendChild(text);
      container.appendChild(label);
    }
  },
};

const crosshairPlugin = {
  id: "sharedCrosshair",
  afterDraw(chart) {
    if (!sharedHover.active || sharedHover.ts === null) return;
    const x = chart.scales.x.getPixelForValue(sharedHover.ts);
    if (Number.isNaN(x)) return;
    const { top, bottom } = chart.chartArea;
    if (x < chart.chartArea.left || x > chart.chartArea.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function attachHoverHandlers(canvas, chart) {
  if (canvas.dataset.hoverBound === "true") return;
  canvas.dataset.hoverBound = "true";
  canvas.addEventListener("mousemove", (event) => {
    const points = chart.getElementsAtEventForMode(event, "nearest", { intersect: false }, false);
    if (!points || !points.length) return;
    const { datasetIndex, index } = points[0];
    const data = chart.data.datasets[datasetIndex].data;
    const datum = data && data[index];
    if (!datum || typeof datum.x !== "number") return;
    applySharedHover(datum.x);
  });
  canvas.addEventListener("mouseleave", () => {
    clearSharedHover();
  });
}

function buildDatasets(seriesList) {
  const palette = ["#5de4c7", "#ffb347", "#ff6b6b", "#7f9cf5", "#f472b6"];
  return seriesList.map((series, idx) => {
    const primary = !series.secondary && idx === 0;
    const borderColor = series.color || palette[idx % palette.length];
    const dataset = {
      label: series.label,
      data: series.points,
      unit: series.unit,
      yAxisID: series.yAxisID,
      borderColor,
      backgroundColor: "rgba(93, 228, 199, 0.08)",
      fill: true,
      tension: 0.25,
      pointRadius: 0,
      pointHitRadius: 8,
      borderWidth: primary ? 2 : 1,
      borderDash: primary ? [] : [6, 4],
      parsing: false,
      normalized: true,
    };
    if (series.fillBySign) {
      dataset.backgroundColor = (ctx) => (valueFromCtx(ctx) >= 0 ? "rgba(93, 228, 199, 0.15)" : "rgba(255, 107, 107, 0.18)");
      dataset.borderColor = (ctx) => (valueFromCtx(ctx) >= 0 ? "#5de4c7" : "#ff6b6b");
    }
    return dataset;
  });
}

function createChart(ctx, seriesList, config) {
  const unit = config.unit;
  const datasets = buildDatasets(seriesList);
  return new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: buildScales(config, unit, config.showXAxis),
      plugins: {
        legend: { display: false, labels: { color: "#9fb3c8" } },
        decimation: {
          enabled: true,
          algorithm: "min-max",
        },
        tooltip: {
          position: "nearest",
          padding: 8,
          callbacks: {
            title: (items) => {
              if (!config.tooltipTimestamp || !items.length) return items[0]?.label || "";
              return "";
            },
            label: (ctx) => {
              const value = valueFromCtx(ctx);
              const label = ctx.dataset.label || "";
              const unitLabel = ctx.dataset.unit || unit || "";
              const labelValue = formatDisplayValue(value, { unit: unitLabel, format: config.format });
              const lines = wrapText(label, 28);
              lines.push(labelValue);
              return lines;
            },
            footer: (items) => {
              const lines = [];
              if (config.tooltipFooter) {
                const extra = config.tooltipFooter(items);
                if (Array.isArray(extra)) {
                  lines.push(...extra.filter(Boolean));
                } else if (extra) {
                  lines.push(extra);
                }
              }
              if (config.tooltipTimestamp && items.length) {
                const ts = items[0].parsed?.x;
                lines.push(formatTooltipTimestamp(ts));
              }
              return lines;
            },
          },
        },
        htmlLegend: { container: null },
        referenceLines: { lines: config.referenceLines || [] },
        band: { band: config.band || null },
      },
    },
    plugins: [inlineLabelPlugin, crosshairPlugin, htmlLegendPlugin, referenceLinePlugin, bandPlugin],
  });
}

function updateChart(chart, seriesList, config) {
  chart.data.datasets = buildDatasets(seriesList);
  chart.options.scales = buildScales(config, config.unit, config.showXAxis);
  chart.options.plugins.tooltip.callbacks.label = (ctx) => {
    const value = valueFromCtx(ctx);
    const label = ctx.dataset.label || "";
    const unitLabel = ctx.dataset.unit || config.unit || "";
    const labelValue = formatDisplayValue(value, { unit: unitLabel, format: config.format });
    const lines = wrapText(label, 28);
    lines.push(labelValue);
    return lines;
  };
  chart.options.plugins.tooltip.callbacks.title = (items) => {
    if (!config.tooltipTimestamp || !items.length) return items[0]?.label || "";
    return "";
  };
  chart.options.plugins.tooltip.callbacks.footer = (items) => {
    const lines = [];
    if (config.tooltipFooter) {
      const extra = config.tooltipFooter(items);
      if (Array.isArray(extra)) {
        lines.push(...extra.filter(Boolean));
      } else if (extra) {
        lines.push(extra);
      }
    }
    if (config.tooltipTimestamp && items.length) {
      const ts = items[0].parsed?.x;
      lines.push(formatTooltipTimestamp(ts));
    }
    return lines;
  };
  chart.options.plugins.referenceLines.lines = config.referenceLines || [];
  chart.options.plugins.band.band = config.band || null;
  chart.update("none");
}

function collectSeriesQueries(config, queries, labels, allowDownsample) {
  if (config.metric) {
    const tags = config.tag ? [config.tag] : [];
    const id = seriesKey(config.metric, tags);
    if (!queries.has(id)) {
      queries.set(id, { id, metric: config.metric, tags, allowDownsample });
    } else if (allowDownsample === false) {
      const existing = queries.get(id);
      existing.allowDownsample = false;
    }
    labels.set(id, config);
    return;
  }
  if (config.compute) {
    const op = config.compute.op;
    if (op === "minus") {
      collectSeriesQueries(config.compute.left, queries, labels, false);
      collectSeriesQueries(config.compute.right, queries, labels, false);
      return;
    }
    if (op === "sum") {
      config.compute.series.forEach((s) => collectSeriesQueries(s, queries, labels, false));
      return;
    }
    if (op === "clip_positive") {
      collectSeriesQueries(config.compute.source, queries, labels, false);
      return;
    }
    if (op === "diff") {
      collectSeriesQueries(config.compute.source, queries, labels, false);
      return;
    }
    if (op === "sum_all") {
      collectSeriesQueries(config.compute.source, queries, labels, false);
      return;
    }
  }
}

function collectLatestQueries(config, queries, labels) {
  if (config.metric) {
    const id = keyFor(config.metric, null, config.tag ? [config.tag] : []);
    if (!queries.has(id)) {
      queries.set(id, { id, metric: config.metric, tags: config.tag ? [config.tag] : [] });
    }
    labels.set(id, config);
    return;
  }
  if (config.compute) {
    const op = config.compute.op;
    if (op === "latest_minus") {
      collectLatestQueries(config.compute.left, queries, labels);
      collectLatestQueries(config.compute.right, queries, labels);
      return;
    }
    if (op === "latest_sum" || op === "max_latest") {
      config.compute.series.forEach((s) => collectLatestQueries(s, queries, labels));
      return;
    }
    if (op === "latest_sum_all") {
      collectLatestQueries(config.compute.source, queries, labels);
      return;
    }
  }
}

function computeSeriesFromMap(config, since, seriesMap) {
  if (config.metric) {
    const key = seriesKey(config.metric, config.tag ? [config.tag] : []);
    return seriesMap.get(key) || [];
  }
  if (config.compute) {
    const op = config.compute.op;
    if (op === "minus") {
      const left = computeSeriesFromMap(config.compute.left, since, seriesMap);
      const right = computeSeriesFromMap(config.compute.right, since, seriesMap);
      return alignSeries(left, right);
    }
    if (op === "sum") {
      const seriesList = config.compute.series.map((s) => computeSeriesFromMap(s, since, seriesMap));
      return alignSeriesList(seriesList);
    }
    if (op === "clip_positive") {
      const raw = computeSeriesFromMap(config.compute.source, since, seriesMap);
      return raw.map(([ts, value]) => [ts, Math.max(0, value)]);
    }
    if (op === "diff") {
      const raw = computeSeriesFromMap(config.compute.source, since, seriesMap);
      const output = [];
      for (let i = 1; i < raw.length; i += 1) {
        const [ts, value] = raw[i];
        const prev = raw[i - 1][1];
        output.push([ts, value - prev]);
      }
      return output;
    }
    if (op === "sum_all") {
      return computeSeriesFromMap(config.compute.source, since, seriesMap);
    }
  }
  return [];
}

function computeLatestFromMap(config, latestMap) {
  if (config.metric) {
    const key = keyFor(config.metric, null, config.tag ? [config.tag] : []);
    return latestMap.get(key) || null;
  }
  if (config.compute) {
    const op = config.compute.op;
    if (op === "latest_minus") {
      const left = computeLatestFromMap(config.compute.left, latestMap);
      const right = computeLatestFromMap(config.compute.right, latestMap);
      if (!left || !right) return null;
      return { ts: Math.max(left.ts, right.ts), value: left.value - right.value };
    }
    if (op === "latest_sum") {
      const points = config.compute.series.map((s) => computeLatestFromMap(s, latestMap)).filter(Boolean);
      if (!points.length) return null;
      return { ts: Math.max(...points.map((p) => p.ts)), value: points.reduce((sum, p) => sum + p.value, 0) };
    }
    if (op === "max_latest") {
      const points = config.compute.series.map((s) => computeLatestFromMap(s, latestMap)).filter(Boolean);
      if (!points.length) return null;
      return points.reduce((best, curr) => (curr.value > best.value ? curr : best));
    }
    if (op === "latest_sum_all") {
      const seriesKey = keyFor(config.compute.source.metric, nowSec() - 86400, []);
      const series = latestMap.get(seriesKey);
      if (!series) return null;
      return series;
    }
  }
  return null;
}

function buildDashboardSkeleton() {
  if (dashboardBuilt) return;
  const cards = document.getElementById("cards");
  cards.innerHTML = "";
  for (const config of CHART_CONFIGS) {
    if (config.type === "header") {
      const section = document.createElement("div");
      section.className = "section-card";
      const sectionId = config.id || config.title;
      if (sectionId) {
        section.id = `section-${sectionId}`;
      }
      if (config.weatherToggle) {
        const wrap = document.createElement("div");
        wrap.className = "section-header";
        const title = document.createElement("div");
        title.textContent = config.title;
        wrap.appendChild(title);
        const control = document.createElement("label");
        control.className = "section-toggle";
        control.textContent = "Units";
        const select = document.createElement("select");
        select.id = "weather-units";
        const optImp = document.createElement("option");
        optImp.value = "imperial";
        optImp.textContent = "Imperial";
        const optMet = document.createElement("option");
        optMet.value = "metric";
        optMet.textContent = "Metric";
        select.appendChild(optImp);
        select.appendChild(optMet);
        control.appendChild(select);
        wrap.appendChild(control);
        section.appendChild(wrap);
      } else {
        section.textContent = config.title;
      }
      cards.appendChild(section);
      continue;
    }
    const entry = createCard(config);
    cards.appendChild(entry.card);
    cardsById.set(config.id, entry);
  }
  dashboardBuilt = true;
}

async function renderDashboard() {
  const range = document.getElementById("range");
  const rangeSec = parseInt(range.value, 10);
  const since = nowSec() - rangeSec;
  if (lastRangeSec !== rangeSec) {
    seriesCache.clear();
    lastRangeSec = rangeSec;
  }
  buildDashboardSkeleton();
  bindWeatherToggle();

  const seriesQueries = new Map();
  const seriesLabels = new Map();
  const latestQueries = new Map();
  const latestLabels = new Map();

  const headerConfigs = new Map();
  for (const config of CHART_CONFIGS) {
    if (config.type === "header") continue;
    const resolvedConfig = resolveWeatherConfig(config);
    if (resolvedConfig.type === "single" || resolvedConfig.type === "single-compute") {
      collectLatestQueries(resolvedConfig, latestQueries, latestLabels);
    } else if (resolvedConfig.type === "table") {
      resolvedConfig.series.forEach((series) => collectLatestQueries(series, latestQueries, latestLabels));
    } else {
      if (resolvedConfig.type === "multi") {
        resolvedConfig.series.forEach((series) => collectSeriesQueries(series, seriesQueries, seriesLabels, true));
      } else {
        collectSeriesQueries(resolvedConfig, seriesQueries, seriesLabels, !resolvedConfig.compute);
      }
    }
  }

  const now = nowSec();
  const seriesRequestById = new Map();
  const seriesRequestList = [];
  for (const entry of seriesQueries.values()) {
    const maxPoints = entry.allowDownsample ? maxPointsForRange(rangeSec) : null;
    if (maxPoints) {
      const query = { id: entry.id, metric: entry.metric, since, until: now, tags: entry.tags, max_points: maxPoints };
      seriesRequestList.push(query);
      seriesRequestById.set(entry.id, { query, maxPoints, since });
      continue;
    }

    let fetchSince = since;
    const cached = seriesCache.get(entry.id);
    if (cached && cached.points.length) {
      const lastTs = cached.points[cached.points.length - 1][0];
      fetchSince = Math.max(lastTs + 1, since);
    }
    const query = { id: entry.id, metric: entry.metric, since: fetchSince, until: now, tags: entry.tags };
    seriesRequestList.push(query);
    seriesRequestById.set(entry.id, { query, maxPoints: null, since });
  }

  let seriesResponse = { series: [] };
  let latestResponse = { latest: [] };
  try {
    seriesResponse = await fetchSeriesBatch(seriesRequestList);
    latestResponse = await fetchLatestBatch([...latestQueries.values()]);
  } catch (err) {
    // Keep dashboard visible even if batch calls fail
    seriesResponse = { series: [] };
    latestResponse = { latest: [] };
  }

  const seriesMap = new Map();
  const responseById = new Map();
  for (const entry of seriesResponse.series || []) {
    responseById.set(entry.id, entry.points || []);
  }

  for (const [id, requestMeta] of seriesRequestById.entries()) {
    const points = responseById.get(id) || [];
    if (requestMeta && requestMeta.maxPoints) {
      seriesMap.set(id, points);
      continue;
    }

    const cached = seriesCache.get(id);
    let merged = points;
    if (cached && cached.points.length) {
      const fetchSince = requestMeta?.query?.since ?? since;
      if (fetchSince > since && points.length) {
        merged = cached.points.concat(points);
      } else if (!points.length) {
        merged = cached.points;
      }
    }
    const trimmed = merged.filter(([ts]) => ts >= since);
    seriesCache.set(id, { points: trimmed });
    seriesMap.set(id, trimmed);
  }

  const latestMap = new Map();
  for (const entry of latestResponse.latest || []) {
    latestMap.set(entry.id, entry.point);
  }

  let currentHeaderId = null;
  for (const config of CHART_CONFIGS) {
    if (config.type === "header") {
      currentHeaderId = config.id || config.title;
      if (currentHeaderId) {
        headerConfigs.set(currentHeaderId, { config, hasVisible: false });
      }
      continue;
    }
    if (config.type === "header") continue;
    const resolvedConfig = resolveWeatherConfig(config);
    const entry = cardsById.get(resolvedConfig.id);
    if (!entry) continue;
    if (currentHeaderId && headerConfigs.has(currentHeaderId)) {
      headerConfigs.get(currentHeaderId).lastEntry = entry;
    }
    const { canvas, value, legend, table } = entry;

    try {
      if (resolvedConfig.type === "single" || resolvedConfig.type === "single-compute") {
        const latest = computeLatestFromMap(resolvedConfig, latestMap);
        if (resolvedConfig.hideIfEmpty) {
          const hasData = Boolean(latest && typeof latest.value === "number");
          entry.card.style.display = hasData ? "" : "none";
          if (!hasData) continue;
        }
        if (resolvedConfig.hideIfZero) {
          const isZero = latest && typeof latest.value === "number" && latest.value === 0;
          entry.card.style.display = isZero ? "none" : "";
          if (isZero) continue;
        }
        if (currentHeaderId && headerConfigs.has(currentHeaderId)) {
          headerConfigs.get(currentHeaderId).hasVisible = true;
        }
        const scaled = latest ? applyUnitScale(latest.value, resolvedConfig) : null;
        const formatted = latest ? formatValue(scaled, resolvedConfig.unit, resolvedConfig) : null;
        setValue(value, resolvedConfig, formatted);
        continue;
      }

      if (resolvedConfig.type === "table" && table) {
        const zoneTooltips = {
          LZ_WEST: "ERCOT West Load Zone",
          HB_WEST: "ERCOT West (345 kV) Trading Hub",
          LZ_CPS: "CPS Energy load zone (San Antonio municipal utility area)",
          HB_SOUTH: "ERCOT South (345 kV) Trading Hub",
          LZ_LCRA: "LCRA (Lower Colorado River Authority) load zone (Central Texas region served by LCRA)",
          LZ_SOUTH: "ERCOT South Load Zone",
          LZ_AEN: "Austin Energy load zone",
          HB_HUBAVG: "ERCOT Hub Average = simple average of HB_NORTH, HB_SOUTH, HB_HOUSTON, HB_WEST",
          HB_HOUSTON: "ERCOT Houston (345 kV) Trading Hub",
          LZ_HOUSTON: "ERCOT Houston Load Zone",
        };
        const rows = resolvedConfig.series
          .map((series) => {
            const latest = computeLatestFromMap(series, latestMap);
            if (!latest) return null;
            return {
              label: series.label || series.tag || series.metric,
              value: latest.value,
              ts: latest.ts,
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.value - a.value)
          .slice(0, resolvedConfig.topN || 10);
        if (resolvedConfig.hideIfEmpty) {
          const hasData = rows.length > 0;
          entry.card.style.display = hasData ? "" : "none";
          if (!hasData) continue;
        }
        if (currentHeaderId && headerConfigs.has(currentHeaderId)) {
          headerConfigs.get(currentHeaderId).hasVisible = true;
        }
        const body = table.querySelector("tbody");
        body.innerHTML = "";
        if (resolvedConfig.id === "settlement_top") {
          const maxValue = rows.length ? Math.max(...rows.map((row) => Math.abs(row.value))) : 1;
          rows.forEach((row) => {
            const tr = document.createElement("tr");
            const tdLabel = document.createElement("td");
            tdLabel.className = "price-bar-label";
            tdLabel.textContent = row.label;
            const tooltip = zoneTooltips[row.label];
            if (tooltip) {
              tdLabel.classList.add("has-tooltip");
              tdLabel.dataset.tooltip = tooltip;
            }
            const tdValue = document.createElement("td");
            tdValue.className = "price-bar-cell";
            const wrap = document.createElement("div");
            wrap.className = "price-bar";
            const fill = document.createElement("div");
            fill.className = "price-bar-fill";
            const pct = maxValue > 0 ? Math.min(100, (Math.abs(row.value) / maxValue) * 100) : 0;
            fill.style.width = `${pct}%`;
            if (row.value < 0) fill.classList.add("negative");
            const value = document.createElement("span");
            value.className = "price-bar-value";
            value.textContent = formatDisplayValue(row.value, { unit: resolvedConfig.unit });
            wrap.appendChild(fill);
            wrap.appendChild(value);
            if (tooltip) {
              wrap.classList.add("has-tooltip");
              wrap.dataset.tooltip = tooltip;
            }
            tdValue.appendChild(wrap);
            tr.appendChild(tdLabel);
            tr.appendChild(tdValue);
            body.appendChild(tr);
          });
        } else {
          rows.forEach((row) => {
            const tr = document.createElement("tr");
            const tdLabel = document.createElement("td");
            tdLabel.textContent = row.label;
            const tdValue = document.createElement("td");
            tdValue.textContent = formatDisplayValue(row.value, { unit: resolvedConfig.unit });
            const tdTime = document.createElement("td");
            tdTime.textContent = formatTimestamp(row.ts * 1000);
            tr.appendChild(tdLabel);
            tr.appendChild(tdValue);
            tr.appendChild(tdTime);
            body.appendChild(tr);
          });
        }
        setValue(value, resolvedConfig, null, "");
        continue;
      }

      let seriesList = [];
      if (resolvedConfig.type === "multi") {
        seriesList = resolvedConfig.series.map((series) => {
          const scale = series.unitScale ?? resolvedConfig.unitScale ?? 1;
          const meta = series.weatherType ? weatherMeta(series.weatherType) : null;
          const points = computeSeriesFromMap(series, since, seriesMap).map(([ts, val]) => {
            const baseValue = val * scale;
            const converted = meta ? meta.convert(baseValue) : baseValue;
            return { x: ts * 1000, y: converted };
          });
          return {
            label: series.label || series.metric,
            points,
            secondary: series.secondary,
            fillBySign: series.fillBySign,
            unit: meta ? meta.unit : series.unit,
            yAxisID: series.yAxisID,
          };
        });
      } else {
        const scale = resolvedConfig.unitScale ?? 1;
        const meta = resolvedConfig.weatherType ? weatherMeta(resolvedConfig.weatherType) : null;
        const points = computeSeriesFromMap(resolvedConfig, since, seriesMap).map(([ts, val]) => ({
          x: ts * 1000,
          y: meta ? meta.convert(val * scale) : val * scale,
        }));
        seriesList = [{ label: resolvedConfig.seriesLabel || resolvedConfig.title, points, unit: meta ? meta.unit : resolvedConfig.unit }];
      }

      if (resolvedConfig.hideIfEmpty) {
        const hasData = seriesList.some((series) => series.points && series.points.length);
        entry.card.style.display = hasData ? "" : "none";
        if (!hasData) continue;
      }
      if (resolvedConfig.hideIfZero) {
        let anyNonZero = false;
        for (const series of seriesList) {
          for (const point of series.points || []) {
            if (point.y !== 0) {
              anyNonZero = true;
              break;
            }
          }
          if (anyNonZero) break;
        }
        entry.card.style.display = anyNonZero ? "" : "none";
        if (!anyNonZero) continue;
      }

      if (currentHeaderId && headerConfigs.has(currentHeaderId)) {
        headerConfigs.get(currentHeaderId).hasVisible = true;
      }
      const summary = summaryValueForSeries(resolvedConfig, seriesList);
      if (summary) {
        setValue(value, resolvedConfig, summary);
      } else {
        const lastSeries = seriesList.find((series) => series.points.length > 0);
        const lastPoint = lastSeries?.points[lastSeries.points.length - 1];
        const formatted = lastPoint ? formatValue(lastPoint.y, resolvedConfig.unit, resolvedConfig) : null;
        setValue(value, resolvedConfig, formatted);
      }

      if (canvas) {
        const chartId = canvas.id || resolvedConfig.id;
        const existing = chartsById.get(chartId);
        if (existing) {
          updateChart(existing, seriesList, resolvedConfig);
        } else {
          const chart = createChart(canvas.getContext("2d"), seriesList, resolvedConfig);
          if (legend) {
            chart.options.plugins.htmlLegend.container = legend;
          }
          chartsById.set(chartId, chart);
          attachHoverHandlers(canvas, chart);
        }
      }
    } catch (err) {
      value.textContent = "No data in window";
      value.className = "value value-muted";
    }
  }

  for (const entry of headerConfigs.values()) {
    const headerId = entry.config.id || entry.config.title;
    if (!headerId) continue;
    const headerEl = document.getElementById(`section-${headerId}`);
    if (!headerEl) continue;
    headerEl.style.display = entry.hasVisible ? "" : "none";
  }

}

const refreshButton = document.getElementById("refresh");
const rangeSelect = document.getElementById("range");
const timezoneSelect = document.getElementById("timezone");
const legendToggle = document.getElementById("toggle-legend");
const inlineToggle = document.getElementById("toggle-inline");

function syncLabelMode() {
  labelMode.legend = legendToggle ? legendToggle.checked : true;
  labelMode.inline = inlineToggle ? inlineToggle.checked : true;
  for (const chart of chartsById.values()) {
    if (!chart) continue;
    const container = chart.options.plugins.htmlLegend?.container;
    if (container) {
      container.style.display = labelMode.legend ? "flex" : "none";
    }
    chart.update("none");
  }
}

refreshButton.addEventListener("click", () => {
  renderDashboard();
});

rangeSelect.addEventListener("change", () => {
  renderDashboard();
});

if (legendToggle) {
  legendToggle.addEventListener("change", () => {
    syncLabelMode();
    renderDashboard();
  });
}

if (inlineToggle) {
  inlineToggle.addEventListener("change", () => {
    syncLabelMode();
    renderDashboard();
  });
}

if (timezoneSelect) {
  tooltipTimezone = timezoneSelect.value || "local";
  timezoneSelect.addEventListener("change", () => {
    tooltipTimezone = timezoneSelect.value || "local";
    for (const chart of chartsById.values()) {
      if (chart) chart.update("none");
    }
  });
}

function bindWeatherToggle() {
  if (weatherToggleBound) return;
  const weatherSelect = document.getElementById("weather-units");
  if (!weatherSelect) return;
  weatherUnits = weatherSelect.value || "imperial";
  weatherSelect.addEventListener("change", () => {
    weatherUnits = weatherSelect.value || "imperial";
    renderDashboard();
  });
  weatherToggleBound = true;
}

syncLabelMode();
renderDashboard();
setInterval(() => {
  renderDashboard();
}, 60000);
