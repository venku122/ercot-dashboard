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
    series: [
      { label: "Capacity", metric: "ercot.Real_Time_Data.Total_System_Capacity" },
      { label: "Demand", metric: "ercot.Real_Time_Data.Actual_System_Demand", secondary: true },
    ],
  },
  {
    id: "unused_capacity",
    title: "Unused Capacity & Operating Reserves",
    type: "multi",
    unit: "MW",
    series: [
      {
        label: "Unused Capacity",
        fillBySign: true,
        compute: {
          op: "minus",
          left: { metric: "ercot.Real_Time_Data.Total_System_Capacity" },
          right: { metric: "ercot.Real_Time_Data.Actual_System_Demand" },
        },
      },
      { label: "Operating Reserves (PRC)", metric: "ercot_ancillary.prc", secondary: true },
    ],
  },
  {
    id: "frequency",
    title: "Grid Frequency",
    metric: "ercot.Frequency.Current_Frequency",
    unit: "Hz",
    severity: "frequency",
  },
  {
    id: "time_error_delta",
    title: "Time Error (Delta)",
    metric: "ercot.Frequency.Instantaneous_Time_Error",
    unit: "s",
  },
  {
    id: "time_error_late",
    title: "Time Error (Late Only)",
    unit: "s",
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
    series: [
      { label: "Wind", metric: "ercot.Real_Time_Data.Total_Wind_Output" },
      { label: "Solar (PVGR)", metric: "ercot.Real_Time_Data.Total_PVGR_Output", secondary: true },
    ],
  },
  {
    id: "inertia",
    title: "System Inertia (MW * sec)",
    metric: "ercot.Real_Time_Data.Current_System_Inertia",
    unit: "MW*s",
  },
  {
    id: "dc_ties",
    title: "Energy Flow with Other Grids",
    type: "multi",
    unit: "MW",
    series: [
      { label: "DC_E", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_E" },
      { label: "DC_N", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_N", secondary: true },
      { label: "DC_L", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_L", secondary: true },
      { label: "DC_R", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_R", secondary: true },
      { label: "DC_S", metric: "ercot.DC_Tie_Flows", tag: "ercot_dc_tie:DC_S", secondary: true },
    ],
  },

  { type: "header", title: "Big Honkin' Numbers" },
  {
    id: "big_capacity",
    title: "Generation Capacity",
    metric: "ercot.Real_Time_Data.Total_System_Capacity",
    unit: "MW",
    type: "single",
    emphasize: true,
  },
  {
    id: "big_frequency",
    title: "Grid Frequency",
    metric: "ercot.Frequency.Current_Frequency",
    unit: "Hz",
    type: "single",
    emphasize: true,
    severity: "frequency",
  },
  {
    id: "big_unused",
    title: "Unused System Capacity",
    unit: "MW",
    type: "single-compute",
    emphasize: true,
    severity: "unused_capacity",
    compute: {
      op: "latest_minus",
      left: { metric: "ercot.Real_Time_Data.Total_System_Capacity" },
      right: { metric: "ercot.Real_Time_Data.Actual_System_Demand" },
    },
  },
  {
    id: "big_dc_net",
    title: "Direct Current Flow (Net)",
    unit: "MW",
    type: "single-compute",
    emphasize: true,
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
    compute: {
      op: "latest_sum_all",
      source: { metric: "poweroutageus.outages" },
    },
  },

  { type: "header", title: "ERCOT Ancillary Real Time" },
  {
    id: "supply_regulation",
    title: "Supply Regulation (Controllable Gen Requests)",
    type: "multi",
    unit: "MW",
    series: [
      { label: "Reg Up Awards", metric: "ercot_ancillary.regUpAwd" },
      { label: "Reg Down Awards", metric: "ercot_ancillary.regDownAwd", secondary: true },
    ],
  },
  {
    id: "offline_minus_quickstart",
    title: "Offline Gen minus Quick Start",
    unit: "MW",
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
  },
  {
    id: "ancillary_reserve_offline",
    title: "On/Offline Reserve Capacity",
    type: "multi",
    unit: "MW",
    series: [
      { label: "Online", metric: "ercot_ancillary.rtReserveOnline" },
      { label: "Offline", metric: "ercot_ancillary.rtReserveOnOffline", secondary: true },
    ],
  },

  { type: "header", title: "Wholesale Electricity Pricing Market (15m)" },
  {
    id: "settlement_top",
    title: "Latest Settlement Point Price (Top)",
    type: "single-compute",
    unit: "$/MWh",
    severity: "price",
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
    id: "settlement_prices",
    title: "Settlement Point Prices (Hubs)",
    type: "multi",
    unit: "$/MWh",
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
    title: "Outage Reports (Total)",
    unit: "customers",
    severity: "outages",
    tone: "muted",
    compute: {
      op: "sum_all",
      source: { metric: "poweroutageus.outages" },
    },
  },
  {
    id: "outages_customers",
    title: "Outage Customers (Total)",
    unit: "customers",
    severity: "outages",
    tone: "muted",
    compute: {
      op: "sum_all",
      source: { metric: "poweroutageus.customers" },
    },
  },

  { type: "header", title: "Nearby Weather (METAR)" },
  {
    id: "metar_temp",
    title: "Temperature by Airport",
    type: "multi",
    unit: "C",
    tone: "muted",
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.temperature",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },
  {
    id: "metar_winds",
    title: "Wind Speed by Airport",
    type: "multi",
    unit: "MPH",
    tone: "muted",
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.winds.speed",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },
  {
    id: "metar_dewpoint",
    title: "Dewpoint by Airport",
    type: "multi",
    unit: "C",
    tone: "muted",
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
    series: METAR_STATIONS.map((code) => ({
      label: code,
      metric: "metar.pressure",
      tag: `metar_code:${code}`,
      secondary: true,
    })),
  },

  { type: "header", title: "System / Meta" },
  {
    id: "duty_cycle",
    title: "Metrics Scrapers – Duty Cycle (%)",
    type: "multi",
    unit: "%",
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
    unit: "level",
    type: "single",
    severity: "eea",
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

function formatValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const rounded = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return { value: rounded, unit: unit || "" };
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

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = config.metric || "derived";
  card.appendChild(meta);

  const value = document.createElement("div");
  value.className = "value";
  value.textContent = "—";
  card.appendChild(value);

  let canvas = null;
  let legend = null;
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

  return { card, canvas, value, legend };
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

function createChart(ctx, seriesList, unit, showXAxis) {
  const datasets = buildDatasets(seriesList);
  return new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          time: { tooltipFormat: "MMM d HH:mm" },
          ticks: { color: "#9fb3c8", display: showXAxis },
          grid: { color: "rgba(255,255,255,0.035)", display: showXAxis },
        },
        y: {
          ticks: {
            color: "#9fb3c8",
            callback: (value) => `${value}${unit ? " " + unit : ""}`,
          },
          grid: { color: "rgba(255,255,255,0.035)" },
        },
      },
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
            label: (ctx) => {
              const value = valueFromCtx(ctx);
              if (value === null) return `${ctx.dataset.label}`;
              return `${ctx.dataset.label}: ${value} ${unit || ""}`.trim();
            },
          },
        },
        htmlLegend: { container: null },
      },
    },
    plugins: [inlineLabelPlugin, crosshairPlugin, htmlLegendPlugin],
  });
}

function updateChart(chart, seriesList, unit, showXAxis) {
  chart.data.datasets = buildDatasets(seriesList);
  chart.options.scales.x.ticks.display = showXAxis;
  chart.options.scales.x.grid.display = showXAxis;
  chart.options.plugins.tooltip.callbacks.label = (ctx) => {
    const value = valueFromCtx(ctx);
    if (value === null) return `${ctx.dataset.label}`;
    return `${ctx.dataset.label}: ${value} ${unit || ""}`.trim();
  };
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
    const { card, canvas, value, legend } = createCard(config);
    cards.appendChild(card);
    cardsById.set(config.id, { card, canvas, value, legend });
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
    const { canvas, value, legend } = entry;

    try {
      if (config.type === "single" || config.type === "single-compute") {
        const latest = computeLatestFromMap(config, latestMap);
        const formatted = latest ? formatValue(latest.value, config.unit) : null;
        setValue(value, config, formatted);
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
          };
        });
      } else {
        const points = computeSeriesFromMap(config, since, seriesMap).map(([ts, val]) => ({
          x: ts * 1000,
          y: val,
        }));
        seriesList = [{ label: config.title, points }];
      }

      const lastSeries = seriesList.find((series) => series.points.length > 0);
      const lastPoint = lastSeries?.points[lastSeries.points.length - 1];
      const formatted = lastPoint ? formatValue(lastPoint.y, config.unit) : null;
      setValue(value, config, formatted);

      if (canvas) {
        const chartId = canvas.id || config.id;
        const existing = chartsById.get(chartId);
        if (existing) {
          updateChart(existing, seriesList, config.unit, config.showXAxis);
        } else {
          const chart = createChart(canvas.getContext("2d"), seriesList, config.unit, config.showXAxis);
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
