const chartsById = new Map();
const cardsById = new Map();
const seriesCache = new Map();
let dashboardBuilt = false;
let lastRangeSec = null;
const sharedHover = { ts: null, active: false };
const labelMode = { legend: true, inline: true };

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
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Demand is ERCOT system load. Available capacity is currently available generation capacity. Unused capacity is capacity minus demand.",
    yLabel: "Power (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 120000,
    tooltipTimestamp: true,
    tooltipFooter: (items) => {
      const demandItem = items.find((item) => item.dataset.label?.includes("Demand"));
      const capacityItem = items.find((item) => item.dataset.label?.includes("Capacity"));
      if (!demandItem || !capacityItem) return null;
      const demand = valueFromCtx(demandItem);
      const capacity = valueFromCtx(capacityItem);
      if (demand === null || capacity === null) return null;
      const unused = capacity - demand;
      return `Unused Capacity: ${formatDisplayValue(unused, { unit: "MW" })}`;
    },
    series: [
      { label: "Demand (MW)", metric: "ercot.Real_Time_Data.Actual_System_Demand" },
      { label: "Available Capacity (MW)", metric: "ercot.Real_Time_Data.Total_System_Capacity", secondary: true },
    ],
  },
  {
    id: "unused_capacity",
    title: "Unused Capacity & Operating Reserves",
    type: "multi",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Unused capacity is headroom between available capacity and demand. Operating reserves may differ depending on ERCOT definition.",
    yLabel: "Headroom (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 50000,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    series: [
      {
        label: "Unused Capacity (MW)",
        fillBySign: true,
        compute: {
          op: "minus",
          left: { metric: "ercot.Real_Time_Data.Total_System_Capacity" },
          right: { metric: "ercot.Real_Time_Data.Actual_System_Demand" },
        },
      },
      { label: "Operating Reserves (MW)", metric: "ercot_ancillary.prc", secondary: true },
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
    tooltipTimestamp: true,
    referenceLines: [{ value: 60, color: "rgba(255,255,255,0.4)" }],
  },
  {
    id: "time_error_delta",
    title: "Time Error (Raw)",
    metric: "ercot.Frequency.Instantaneous_Time_Error",
    unit: "sec",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Cumulative offset from ideal 60 Hz over time. This is an integrated measure of frequency deviation.",
    yLabel: "Time Error (sec)",
    yMin: -60,
    yMax: 60,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
  },
  {
    id: "time_error_late",
    title: "Time Error (Filtered)",
    unit: "sec",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Filtered view highlighting late-only deviations. This is derived from instantaneous time error.",
    yLabel: "Time Error (sec)",
    yMin: 0,
    yMax: 60,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    compute: {
      op: "clip_positive",
      source: { metric: "ercot.Frequency.Instantaneous_Time_Error" },
    },
  },
  {
    id: "wind_solar",
    title: "Wind & Solar Generation",
    type: "multi",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description: "Real-time generation output by fuel type (wind and solar).",
    yLabel: "Generation (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 80000,
    tooltipTimestamp: true,
    series: [
      { label: "Wind (MW)", metric: "ercot.Real_Time_Data.Total_Wind_Output" },
      { label: "Solar (MW)", metric: "ercot.Real_Time_Data.Total_PVGR_Output", secondary: true },
    ],
  },
  {
    id: "inertia",
    title: "System Inertia",
    metric: "ercot.Real_Time_Data.Current_System_Inertia",
    unit: "MW·s",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description:
      "Inertia is a system stability proxy reflecting rotational energy available to resist frequency changes.",
    yLabel: "Inertia (MW·s)",
    ySuggestedMin: 0,
    ySuggestedMax: 600000,
    tooltipTimestamp: true,
  },
  {
    id: "dc_ties",
    title: "Net Interchange",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT",
    description: "Net interchange across ERCOT ties. Positive = Imports into ERCOT; Negative = Exports.",
    yLabel: "Power Flow (MW)",
    yMin: -10000,
    yMax: 10000,
    tooltipTimestamp: true,
    referenceLines: [{ value: 0, color: "rgba(255,255,255,0.35)" }],
    seriesLabel: "Net Flow (MW)",
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

  { type: "header", title: "Big Honkin' Numbers" },
  {
    id: "big_capacity",
    title: "Generation Capacity",
    metric: "ercot.Real_Time_Data.Total_System_Capacity",
    unit: "MW",
    type: "single",
    emphasize: true,
    subtitle: "Real-time (60s) · Source: ERCOT",
  },
  {
    id: "big_frequency",
    title: "Grid Frequency",
    metric: "ercot.Frequency.Current_Frequency",
    unit: "Hz",
    type: "single",
    emphasize: true,
    severity: "frequency",
    subtitle: "Real-time (60s) · Source: ERCOT",
  },
  {
    id: "big_unused",
    title: "Unused System Capacity",
    unit: "MW",
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
      "Regulation services balance short-term frequency deviations. Specify whether the metric is requirement, procurement, supply, or deployment.",
    yLabel: "Regulation (MW)",
    ySuggestedMin: 0,
    ySuggestedMax: 3000,
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
    ySuggestedMax: 80000,
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
  },
  {
    id: "ancillary_reserve_offline",
    title: "On/Offline Reserve Capacity",
    type: "multi",
    unit: "MW",
    subtitle: "Real-time (60s) · Source: ERCOT Ancillary",
    tooltipTimestamp: true,
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
    tableColumns: ["Settlement Point", "Price ($/MWh)", "Timestamp"],
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
    compute: {
      op: "sum_all",
      source: { metric: "poweroutageus.customers" },
    },
  },

  { type: "header", title: "Nearby Weather (METAR)" },
  {
    id: "metar_temp",
    title: "Temperature (by Airport)",
    type: "multi",
    unit: "°C",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Airport METAR observations near ERCOT load/generation centers.",
    yLabel: "Temperature (°C)",
    yMin: -20,
    yMax: 45,
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.temperature",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },
  {
    id: "metar_winds",
    title: "Wind Speed (by Airport)",
    type: "multi",
    unit: "mph",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Observed sustained wind speed. Gusts may not be shown unless explicitly ingested.",
    yLabel: "Wind Speed (mph)",
    yMin: 0,
    yMax: 80,
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.winds.speed",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },
  {
    id: "metar_dewpoint",
    title: "Dewpoint (by Airport)",
    type: "multi",
    unit: "°C",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Dewpoint is a proxy for humidity and impacts load via comfort cooling demand.",
    yLabel: "Dewpoint (°C)",
    yMin: -30,
    yMax: 30,
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.dewpoint",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },
  {
    id: "metar_pressure",
    title: "Observed Air Pressure",
    type: "multi",
    unit: "inHg",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Barometric pressure observations from METAR stations.",
    yLabel: "Pressure (inHg)",
    yMin: 28,
    yMax: 31.5,
    tooltipTimestamp: true,
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.pressure",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },
  {
    id: "metar_wind_temp_combined",
    title: "Wind Speed & Temperature",
    type: "multi",
    unit: "°C",
    tone: "muted",
    subtitle: "Updates ~hourly · Source: METAR",
    description: "Combined view to correlate weather and grid behavior. Dual-axis must be labeled to avoid misleading scaling.",
    yLabel: "Temperature (°C)",
    yMin: -20,
    yMax: 45,
    tooltipTimestamp: true,
    scales: {
      y: {
        position: "left",
        title: { display: true, text: "Temperature (°C)" },
        min: -20,
        max: 45,
        ticks: {
          color: "#9fb3c8",
          callback: (value) => `${value} °C`,
        },
      },
      y1: {
        position: "right",
        title: { display: true, text: "Wind Speed (mph)" },
        min: 0,
        max: 80,
        grid: { drawOnChartArea: false },
        ticks: {
          color: "#9fb3c8",
          callback: (value) => `${value} mph`,
        },
      },
    },
    series: [
      {
        label: "Temp (°C)",
        metric: "metar.temperature",
        tag: `metar_code:${METAR_STATIONS[0]}`,
        unit: "°C",
        yAxisID: "y",
      },
      {
        label: "Wind (mph)",
        metric: "metar.winds.speed",
        tag: `metar_code:${METAR_STATIONS[0]}`,
        unit: "mph",
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

function formatValue(value, unit, config) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const rounded = config?.format === "integer" ? Math.round(value).toFixed(0) : Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return { value: rounded, unit: unit || "" };
}

function formatDisplayValue(value, config) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const rounded = config?.format === "integer" ? Math.round(value).toFixed(0) : Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  if (config?.unit === "$/MWh") {
    return `$${rounded} /MWh`;
  }
  return `${rounded}${config?.unit ? ` ${config.unit}` : ""}`.trim();
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  const date = new Date(ts);
  return date.toLocaleString();
}

function formatTimestampUtc(ts) {
  if (!ts) return "—";
  return new Date(ts).toUTCString();
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
  applyValueState(el, config, parseFloat(valueObj.value));
  el.innerHTML = `<span class="value-number">${valueObj.value}</span><span class="value-unit">${valueObj.unit}</span>`;
}

function createCard(config) {
  const card = document.createElement("div");
  card.className = "card";
  if (config.emphasize) card.classList.add("card-emphasis");
  if (config.tone === "muted") card.classList.add("card-muted");

  const title = document.createElement("h2");
  title.textContent = config.title;
  card.appendChild(title);

  const subtitle = document.createElement("div");
  subtitle.className = "card-subtitle";
  subtitle.textContent = config.subtitle || "";
  if (!config.subtitle) {
    subtitle.style.display = "none";
  }
  card.appendChild(subtitle);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = config.metric ? `Metric: ${config.metric}` : "Metric: derived";
  card.appendChild(meta);

  const value = document.createElement("div");
  value.className = "value";
  value.textContent = "—";
  card.appendChild(value);

  const updated = document.createElement("div");
  updated.className = "updated";
  updated.textContent = "Last updated: —";
  card.appendChild(updated);

  if (config.description) {
    const help = document.createElement("div");
    help.className = "help-text";
    help.textContent = config.description;
    card.appendChild(help);
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
      callback: (value) => `${value}${unit ? " " + unit : ""}`,
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
              const ts = items[0].parsed?.x;
              return [`Local: ${formatTimestamp(ts)}`, `UTC: ${formatTimestampUtc(ts)}`];
            },
            label: (ctx) => {
              const value = valueFromCtx(ctx);
              if (value === null) return `${ctx.dataset.label}`;
              const unitLabel = ctx.dataset.unit || unit || "";
              const labelValue = formatDisplayValue(value, { unit: unitLabel, format: config.format });
              return `${ctx.dataset.label}: ${labelValue}`.trim();
            },
            footer: (items) => {
              if (!config.tooltipFooter) return "";
              return config.tooltipFooter(items) || "";
            },
          },
        },
        htmlLegend: { container: null },
        referenceLines: { lines: config.referenceLines || [] },
      },
    },
    plugins: [inlineLabelPlugin, crosshairPlugin, htmlLegendPlugin, referenceLinePlugin],
  });
}

function updateChart(chart, seriesList, config) {
  chart.data.datasets = buildDatasets(seriesList);
  chart.options.scales = buildScales(config, config.unit, config.showXAxis);
  chart.options.plugins.tooltip.callbacks.label = (ctx) => {
    const value = valueFromCtx(ctx);
    if (value === null) return `${ctx.dataset.label}`;
    const unitLabel = ctx.dataset.unit || config.unit || "";
    const labelValue = formatDisplayValue(value, { unit: unitLabel, format: config.format });
    return `${ctx.dataset.label}: ${labelValue}`.trim();
  };
  chart.options.plugins.tooltip.callbacks.title = (items) => {
    if (!config.tooltipTimestamp || !items.length) return items[0]?.label || "";
    const ts = items[0].parsed?.x;
    return [`Local: ${formatTimestamp(ts)}`, `UTC: ${formatTimestampUtc(ts)}`];
  };
  chart.options.plugins.tooltip.callbacks.footer = (items) => {
    if (!config.tooltipFooter) return "";
    return config.tooltipFooter(items) || "";
  };
  chart.options.plugins.referenceLines.lines = config.referenceLines || [];
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
      section.textContent = config.title;
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

  const seriesQueries = new Map();
  const seriesLabels = new Map();
  const latestQueries = new Map();
  const latestLabels = new Map();

  for (const config of CHART_CONFIGS) {
    if (config.type === "header") continue;
    if (config.type === "single" || config.type === "single-compute") {
      collectLatestQueries(config, latestQueries, latestLabels);
    } else if (config.type === "table") {
      config.series.forEach((series) => collectLatestQueries(series, latestQueries, latestLabels));
    } else {
      if (config.type === "multi") {
        config.series.forEach((series) => collectSeriesQueries(series, seriesQueries, seriesLabels, true));
      } else {
        collectSeriesQueries(config, seriesQueries, seriesLabels, !config.compute);
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

  for (const config of CHART_CONFIGS) {
    if (config.type === "header") continue;
    const entry = cardsById.get(config.id);
    if (!entry) continue;
    const { canvas, value, legend, table, updated } = entry;

    try {
      if (config.type === "single" || config.type === "single-compute") {
        const latest = computeLatestFromMap(config, latestMap);
        const formatted = latest ? formatValue(latest.value, config.unit, config) : null;
        setValue(value, config, formatted);
        if (updated) {
          updated.textContent = latest ? `Last updated: ${formatTimestamp(latest.ts * 1000)}` : "Last updated: —";
        }
        continue;
      }

      if (config.type === "table" && table) {
        const rows = config.series
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
          .slice(0, config.topN || 10);
        const body = table.querySelector("tbody");
        body.innerHTML = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          const tdLabel = document.createElement("td");
          tdLabel.textContent = row.label;
          const tdValue = document.createElement("td");
          tdValue.textContent = formatDisplayValue(row.value, { unit: config.unit });
          const tdTime = document.createElement("td");
          tdTime.textContent = formatTimestamp(row.ts * 1000);
          tr.appendChild(tdLabel);
          tr.appendChild(tdValue);
          tr.appendChild(tdTime);
          body.appendChild(tr);
        });
        if (updated) {
          const latestTs = rows.length ? Math.max(...rows.map((row) => row.ts)) : null;
          updated.textContent = latestTs ? `Last updated: ${formatTimestamp(latestTs * 1000)}` : "Last updated: —";
        }
        setValue(value, config, null, "");
        continue;
      }

      let seriesList = [];
      if (config.type === "multi") {
        seriesList = config.series.map((series) => {
          const points = computeSeriesFromMap(series, since, seriesMap).map(([ts, val]) => ({
            x: ts * 1000,
            y: val,
          }));
          return {
            label: series.label || series.metric,
            points,
            secondary: series.secondary,
            fillBySign: series.fillBySign,
            unit: series.unit,
            yAxisID: series.yAxisID,
          };
        });
      } else {
        const points = computeSeriesFromMap(config, since, seriesMap).map(([ts, val]) => ({
          x: ts * 1000,
          y: val,
        }));
        seriesList = [{ label: config.seriesLabel || config.title, points, unit: config.unit }];
      }

      const lastSeries = seriesList.find((series) => series.points.length > 0);
      const lastPoint = lastSeries?.points[lastSeries.points.length - 1];
      const formatted = lastPoint ? formatValue(lastPoint.y, config.unit, config) : null;
      setValue(value, config, formatted);
      if (updated) {
        updated.textContent = lastPoint ? `Last updated: ${formatTimestamp(lastPoint.x)}` : "Last updated: —";
      }

      if (canvas) {
        const chartId = canvas.id || config.id;
        const existing = chartsById.get(chartId);
        if (existing) {
          updateChart(existing, seriesList, config);
        } else {
          const chart = createChart(canvas.getContext("2d"), seriesList, config);
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
}

const refreshButton = document.getElementById("refresh");
const rangeSelect = document.getElementById("range");
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

syncLabelMode();
renderDashboard();
setInterval(() => {
  renderDashboard();
}, 60000);
