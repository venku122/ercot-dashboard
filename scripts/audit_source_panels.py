"""Print a sanitized source capability inventory; never access deployment secrets.

Configured production enablement and liveness require separate observed evidence.
Environment checks emit presence booleans only. No source requests or writes occur.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINDINGS = {
    "ercot_realtime": ("grid.ts", "Frequency, PRC", "Hz / MW; collection-time legacy history"),
    "ercot_ancillary": ("ancillary.ts", "Ancillary services", "MW; collection-time legacy history"),
    "ercot_eea": ("eea.ts", "EEA and timeline", "discrete official status"),
    "metar": ("metar.ts", "Weather observations and Outlook context", "degrees C; observed airport weather"),
    "ercot_pricing": ("prices.ts", "Legacy pricing", "USD/MWh; collection-time snapshot"),
    "fuel_mix": ("fuel_mix.ts", "Generation mix and Overview", "MW; observed generation"),
    "energy_storage": ("storage.ts", "Storage and Overview", "MW; aggregate charge/discharge, no resource SOC"),
    "supply_demand": ("supply_demand.ts", "Supply/demand and paired headroom", "MW; compatible source-observation pairs"),
    "generation_outages": ("generation_outages.ts", "Outages", "MW; reported outage snapshot"),
    "operations_messages": ("operations_messages.ts", "Operations and timeline", "official event text; not complete TXANS history"),
    "wind_solar": ("wind_solar.ts", "Legacy renewable forecasts", "MW; latest forecast publication"),
    "forecast_publications": ("ercot_public_load_collector.ts", "Outlook, historical forecast, Forecast Quality", "MW; issue/target/retrieval separately; real pair coverage required"),
    "renewable_publications": ("ercot_mis_renewable_runner.ts", "Renewable publications", "MW; hourly immutable publication"),
    "regional_renewable_publications": ("ercot_mis_regional_runner.ts", "Regional renewables", "MW; hourly regional publication"),
    "market_mechanics": ("ercot_mis_market_runner.ts", "Market Mechanics", "product-specific MW / USD/MW (frozen PR14 scalar contract); not energy price"),
    "market_geography": ("ercot_public_market_geography_runner.ts", "Market Geography and settlement Overview", "USD/MWh; authoritative settlement intervals"),
    "nws_weather": ("nws_weather_runner.ts", "Predictive Weather", "NWS alerts and representative airport grid forecasts"),
    "long_horizon": ("long_horizon_runner.ts", "Texas Grid planning", "MW; planning snapshots, not committed capacity"),
    "external_context": ("external_context_runner.ts", "External Context", "annual eGRID ERCT retrospective rates; EIA hourly/daily context"),
}
CREDENTIALS = (
    "ERCOT_API_USERNAME", "ERCOT_API_PASSWORD",
    "ERCOT_PUBLIC_API_SUBSCRIPTION_KEY", "ERCOT_ESR_API_SUBSCRIPTION_KEY", "EIA_API_KEY",
)


REHEARSAL_BINDINGS = {
    "nws_weather": ("nws", "predictive-weather"),
    "long_horizon": ("planning", "texas-grid"),
    "external_context": ("egrid", "external-context"),
    "renewable_publications": ("renewables", "net-load"),
    "regional_renewable_publications": ("regional", "regional-geography"),
    "market_mechanics": ("market", "market-mechanics"),
    "market_geography": ("geography", "market-geography"),
}


def summarize(value):
    """Keep identities, clocks, health and coverage; leave raw rows in local evidence."""
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            if key in ("rows", "items", "history") and isinstance(child, list):
                clocks = [row[field] for row in child if isinstance(row, dict)
                          for field in ("target_ts", "valid_start", "valid_end", "observed_at")
                          if isinstance(row.get(field), (int, float))]
                result[key + "_coverage"] = {"row_count": len(child),
                                              "first_target_or_observation": min(clocks) if clocks else None,
                                              "last_target_or_observation": max(clocks) if clocks else None}
            else:
                result[key] = summarize(child)
        return result
    if isinstance(value, list):
        return [summarize(child) for child in value]
    return value


def inventory(rehearsal=None):
    text = (ROOT / "ercot-collector/mod.ts").read_text()
    runners = re.findall(
        r'superviseCollectorRunner\(\s*"([^"]+)",\s*(true|Deno\.env\.get\("([^"]+)"\) === "true"),\s*([\d_]+)',
        text,
    )
    if {row[0] for row in runners} != set(BINDINGS) or len(runners) != len(BINDINGS):
        raise ValueError("source_inventory_requires_review")
    rows = []
    for family, enabled, flag, cadence in runners:
        adapter, consumer, basis = BINDINGS[family]
        rows.append({
            "family": family, "adapter": "ercot-collector/" + adapter,
            "schema_reference": "ercot-collector/" + adapter,
            "consumer": consumer, "units_and_basis": basis,
            "code_capability": "supported", "feature_flag": flag or None,
            "default_enablement": enabled == "true",
            "poll_supervisor_seconds": int(cadence.replace("_", "")),
            "publication_cadence": "product-specific; poll cadence is not publication cadence",
            "configured_production_enablement": "unknown",
            "production_collector_liveness": "unknown",
            "production_receiver_destination": "unknown",
            "production_last_attempt": None, "production_last_success": None,
            "production_upstream_result": "not_observed",
            "production_receiver_delivery": "not_observed",
            "production_publication": None, "production_coverage": None,
            "production_rendered_values": "separate browser observation; not proof of this collector",
            "validation_mode": "static_inventory",
        })
    if rehearsal:
        responses = json.loads((rehearsal / "responses.json").read_text())
        records = json.loads((rehearsal / "source-rehearsals.json").read_text())
        for row in rows:
            binding = REHEARSAL_BINDINGS.get(row["family"])
            if binding:
                family, manifest = binding
                row["local_rehearsal"] = next((item for item in records if item["family"] == family), None)
                row["local_manifest_evidence"] = summarize(responses.get("/api/v1/" + manifest))
                row["validation_mode"] = "isolated_live_source" if row["local_rehearsal"] else "static_inventory"
            else:
                row["local_rehearsal"] = "not_started_by_this_audit"
    return {
        "schema": 1, "observed_at_utc": datetime.datetime.now(datetime.UTC).isoformat(),
        "candidate_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "environment": "isolated local review; no production environment access",
        "credential_presence_only": {name: bool(os.environ.get(name)) for name in CREDENTIALS},
        "families": rows,
        "excluded_capabilities": ["resource SOC", "current high-resolution ESR without source gate", "complete TXANS history", "unreviewed CAMD/retirement attribution", "paid PowerOutage.us feed"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rehearsal", type=Path, help="Sanitized disposable-receiver evidence directory")
    print(json.dumps(inventory(parser.parse_args().rehearsal), indent=2))
