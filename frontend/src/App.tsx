import { useEffect } from "react";

import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Separator } from "./components/ui/separator";

declare global {
  interface Window {
    __ercotLegacyBooted?: boolean;
  }
}

export function App() {
  useEffect(() => {
    if (window.__ercotLegacyBooted) {
      return;
    }
    window.__ercotLegacyBooted = true;
    void import("./legacy/app.js");
  }, []);

  return (
    <div className="min-h-screen bg-[radial-gradient(1200px_600px_at_20%_0%,rgba(31,47,59,1)_0%,transparent_60%),radial-gradient(900px_400px_at_80%_10%,rgba(34,48,66,1)_0%,transparent_55%),linear-gradient(160deg,#0f1418_0%,#13202b_100%)] text-slate-100">
      <header className="mx-auto flex w-full max-w-[1680px] flex-col gap-5 px-6 py-7 xl:flex-row xl:items-start xl:justify-between xl:px-8">
        <div className="space-y-2">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.28em] text-emerald-300/80">
            Texas Grid Monitor
          </p>
          <h1 className="text-3xl font-semibold tracking-[0.01em] text-slate-50">
            ERCOT Local Dashboard
          </h1>
          <p className="max-w-3xl text-sm text-slate-300">
            Live metrics from the local receiver, migrated onto a React and TypeScript frontend
            while keeping the existing ERCOT APIs and deployment model intact.
          </p>
        </div>

        <Card className="w-full max-w-4xl p-4 xl:p-5">
          <CardHeader className="mb-4">
            <CardTitle>Dashboard Controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="controls flex flex-wrap items-center gap-3 text-sm text-slate-300">
              <label className="flex min-w-[11rem] flex-col gap-1.5">
                <span className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Range
                </span>
                <select id="range" defaultValue="21600">
                  <option value="3600">Last 1 hour</option>
                  <option value="21600">Last 6 hours</option>
                  <option value="43200">Last 12 hours</option>
                  <option value="86400">Last 24 hours</option>
                  <option value="259200">Last 3 days</option>
                  <option value="604800">Last 7 days</option>
                  <option value="2592000">Last 30 days</option>
                  <option value="15552000">Last 6 months</option>
                  <option value="31536000">Last 12 months</option>
                </select>
              </label>

              <label className="flex min-w-[9rem] flex-col gap-1.5">
                <span className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Timezone
                </span>
                <select id="timezone" defaultValue="local">
                  <option value="local">Local</option>
                  <option value="utc">UTC</option>
                </select>
              </label>

              <div className="toggle-group mt-[1.25rem] flex items-center gap-3">
                <label className="toggle inline-flex items-center gap-2">
                  <input defaultChecked id="toggle-legend" type="checkbox" />
                  <span>Legend</span>
                </label>
                <label className="toggle inline-flex items-center gap-2">
                  <input defaultChecked id="toggle-inline" type="checkbox" />
                  <span>Inline labels</span>
                </label>
              </div>

              <div className="mt-[1.25rem]">
                <Button id="refresh" type="button">
                  Refresh
                </Button>
              </div>
            </div>
            <Separator />
            <p className="text-xs leading-6 text-slate-400">
              The seasonal selector remains hidden for now. The legacy metrics rendering engine is
              bridged into this React shell to preserve current dashboard behavior while the
              frontend stack moves to Vite, TypeScript, and modern tooling.
            </p>
          </CardContent>
        </Card>
      </header>

      <main className="mx-auto w-full max-w-[1680px] px-6 pb-10 xl:px-8">
        <section className="grid" id="cards" />
      </main>

      <footer className="mx-auto w-full max-w-[1680px] px-6 pb-10 xl:px-8">
        <div className="attribution rounded-2xl border border-white/10 bg-white/5 px-5 py-5">
          <span className="label">Attribution</span>
          <p className="attribution-copy">
            Hello, I am a Texas resident and the health and status of the Texas power grid is of
            immense importance to me and my family. This project was originally created by @danopia
            and visualized in Datadog. This is a fork of that with self-hosted data collection and
            dashboards. Ironically, this site is hosted in Texas and if the Texas power grid goes
            down, so will this site!
          </p>
          <div className="attribution-links">
            <a
              href="https://p.datadoghq.com/sb/5c2fc00be-393be929c9c55c3b80b557d08c30787a"
              rel="noopener noreferrer"
              target="_blank"
            >
              Original Datadog dashboard
            </a>
            <a
              href="https://github.com/venku122/ercot-dashboard"
              rel="noopener noreferrer"
              target="_blank"
            >
              Source code
            </a>
            <a
              href="http://www.ercot.com/content/cdr/html/real_time_system_conditions.html"
              rel="noopener noreferrer"
              target="_blank"
            >
              Grid metrics
            </a>
            <a
              href="http://www.ercot.com/content/cdr/html/as_capacity_monitor.html"
              rel="noopener noreferrer"
              target="_blank"
            >
              Ancillary services
            </a>
            <a
              href="http://www.ercot.com/content/cdr/html/real_time_spp"
              rel="noopener noreferrer"
              target="_blank"
            >
              Pricing metrics
            </a>
            <a
              href="http://www.ercot.com/content/alerts/conservation_state.js"
              rel="noopener noreferrer"
              target="_blank"
            >
              EEA level
            </a>
            <a
              href="https://www.aviationweather.gov/metar/data"
              rel="noopener noreferrer"
              target="_blank"
            >
              Weather (METAR)
            </a>
            <a href="https://poweroutage.us" rel="noopener noreferrer" target="_blank">
              Outage reports
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
