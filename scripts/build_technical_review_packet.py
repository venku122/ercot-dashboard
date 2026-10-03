#!/usr/bin/env python3
"""Build the ERCOT Observatory technical human-review PDF."""

from __future__ import annotations

import json
from pathlib import Path

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "2026-08-27--ercot-observatory-technical-human-review.pdf"
EVIDENCE = ROOT / "docs" / "review-evidence"
PAGE = landscape(letter)
PAGE_W, PAGE_H = PAGE
NAVY = colors.HexColor("#0f172a")
BLUE = colors.HexColor("#0369a1")
CYAN = colors.HexColor("#0891b2")
SLATE = colors.HexColor("#475569")
LIGHT = colors.HexColor("#e2e8f0")
PALE = colors.HexColor("#f8fafc")
GREEN = colors.HexColor("#166534")
AMBER = colors.HexColor("#92400e")


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LIGHT)
    canvas.line(0.55 * inch, 0.42 * inch, PAGE_W - 0.55 * inch, 0.42 * inch)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(SLATE)
    canvas.drawString(0.55 * inch, 0.22 * inch, "ERCOT Grid Observatory - synthetic review evidence - 2026-08-27")
    canvas.drawRightString(PAGE_W - 0.55 * inch, 0.22 * inch, f"Page {doc.page}")
    canvas.restoreState()


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="PacketTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=27, leading=31, textColor=NAVY, alignment=TA_LEFT, spaceAfter=14))
styles.add(ParagraphStyle(name="PacketSub", parent=styles["Normal"], fontName="Helvetica", fontSize=13, leading=18, textColor=SLATE, spaceAfter=10))
styles.add(ParagraphStyle(name="Section", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=19, leading=23, textColor=NAVY, spaceAfter=10))
styles.add(ParagraphStyle(name="Subsection", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=BLUE, spaceBefore=6, spaceAfter=6))
styles.add(ParagraphStyle(name="BodyPacket", parent=styles["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13.2, textColor=NAVY, spaceAfter=7))
styles.add(ParagraphStyle(name="SmallPacket", parent=styles["BodyText"], fontName="Helvetica", fontSize=7.6, leading=10, textColor=SLATE))
styles.add(ParagraphStyle(name="FigureLabel", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=9.5, leading=12, textColor=NAVY, alignment=TA_CENTER, spaceAfter=5))
styles.add(ParagraphStyle(name="Status", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=GREEN, backColor=colors.HexColor("#dcfce7"), borderColor=colors.HexColor("#86efac"), borderWidth=1, borderPadding=9, spaceAfter=14))
styles.add(ParagraphStyle(name="Limit", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=AMBER, backColor=colors.HexColor("#fef3c7"), borderColor=colors.HexColor("#fcd34d"), borderWidth=1, borderPadding=8, spaceAfter=10))


def p(text: str, style: str = "BodyPacket") -> Paragraph:
    return Paragraph(text, styles[style])


def fit_image(path: Path, max_w: float, max_h: float) -> Image:
    width, height = ImageReader(str(path)).getSize()
    scale = min(max_w / width, max_h / height)
    return Image(str(path), width=width * scale, height=height * scale)


def page_title(title: str, subtitle: str | None = None):
    story.append(p(title, "Section"))
    if subtitle:
        story.append(Spacer(1, 0.03 * inch))
        story.append(p(subtitle, "SmallPacket"))
    story.append(Spacer(1, 0.08 * inch))


OUT.parent.mkdir(parents=True, exist_ok=True)
doc = SimpleDocTemplate(
    str(OUT),
    pagesize=PAGE,
    rightMargin=0.55 * inch,
    leftMargin=0.55 * inch,
    topMargin=0.48 * inch,
    bottomMargin=0.52 * inch,
    title="ERCOT Grid Observatory technical human-review packet",
    author="ERCOT Grid Observatory review campaign",
)
story = []

# Cover
story.append(Spacer(1, 0.65 * inch))
story.append(p("ERCOT Grid Observatory", "PacketTitle"))
story.append(p("Technical human-review packet", "PacketTitle"))
story.append(p("PR stack #33 through #55 | 2026-08-27", "PacketSub"))
story.append(Spacer(1, 0.18 * inch))
story.append(p("READY FOR DETAILED HUMAN REVIEW / CONDITIONAL MERGE CANDIDATE", "Status"))
story.append(p("This is not deployment approval. Nothing was merged or deployed during this remediation. Production, Portainer, production SQLite, collectors, Cloudflare, and DNS were not changed."))
story.append(p("Primary remediation: generated generic canonical tile bodies are memory-only. SQLite observations remain authoritative; receiver restart regenerates deterministic bytes and strong ETags. Corrections invalidate intersecting ranges only."))
story.append(p("All screenshots in this packet use deterministic synthetic fixtures. No production database, browser session, credential, or source row is embedded."))
story.append(Spacer(1, 0.15 * inch))
story.append(p("BLOCKED_EXTERNAL - ACCEPTED SCOPE LIMIT: current four-second ESR", "Limit"))
story.append(p("ERCOT discontinued the live feed after 2025-12-05. The reviewed product exposes truthful five-minute system-wide storage context and does not claim SOC, resource identity, high-resolution battery response, or causal attribution."))
story.append(PageBreak())

# Executive summary
page_title("1. Executive review summary")
summary_rows = [
    ["Area", "Disposition", "Review note"],
    ["Generic canonical tiles", "PASS", "No persistent bodies; bounded LRU + singleflight + HTTP/browser caches"],
    ["Restart behavior", "PASS", "Fresh process MISS; one generation; identical bytes/ETag; no artifacts"],
    ["Correction safety", "PASS", "Affected tile changes; unrelated tile remains byte-identical HIT"],
    ["Planner reuse", "PASS", "300 windows; 42.13x aggregate reference reuse; warm SQL = 0"],
    ["Desktop/mobile review", "PASS", "14 populated surfaces, each paired desktop + iPhone WebKit"],
    ["Four-second ESR", "ACCEPTED LIMIT", "Discontinued external source; no unsupported current claims"],
    ["Merge/deploy", "NOT EXECUTED", "Separate human approvals remain required"],
]
t = Table(summary_rows, colWidths=[1.65 * inch, 1.35 * inch, 6.7 * inch], repeatRows=1)
t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"), ("FONTNAME", (0, 1), (1, -1), "Helvetica-Bold"),
    ("FONTSIZE", (0, 0), (-1, -1), 8.4), ("LEADING", (0, 0), (-1, -1), 11),
    ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd5e1")),
    ("BACKGROUND", (0, 1), (-1, -1), PALE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
]))
story.append(t)
story.append(Spacer(1, 0.2 * inch))
story.append(p("Reviewers should start with PR #37 and the restart/correction tests, then validate the architecture diagrams, benchmark methodology, data-semantics table, visual pairs, exact-head CI, and stack topology. Review/comment counts are intentionally excluded as evidence."))
story.append(PageBreak())

# Architecture diagrams
diagram_pages = [
    ("2. System context", "01-system-context.png", "Official sources flow through strict collectors to the SQLite-backed receiver, shared HTTP caches, and lazy browser views."),
    ("3. Canonical tile request paths", "02-canonical-tile-request-paths.png", "Only observations persist. Generated generic tile bodies live in bounded process memory and downstream caches."),
    ("4. Restart and correction", "03-restart-and-correction.png", "Restart regeneration is deterministic; corrections invalidate only intersecting dependencies."),
    ("5. Frontend planner", "04-frontend-tile-planner.png", "The production planner combines exact native edges and canonical interior tiles without interpolation."),
    ("6. Provenance and semantics", "05-data-provenance-and-semantics.png", "Official, source-observation, and derived evidence classes stay distinct."),
    ("7. Deployment and rollback", "06-deployment-and-rollback.png", "Deployment remains separate and requires pinned images, complete Env preservation, opt-in rollout, and rollback proof."),
]
for title, filename, caption in diagram_pages:
    page_title(title, caption)
    story.append(fit_image(EVIDENCE / "diagrams" / filename, 9.7 * inch, 5.85 * inch))
    story.append(PageBreak())

# Performance
page_title("8. 300-window canonical tile benchmark", "Deterministic synthetic fixture; production TypeScript planner; no production mutation.")
data = json.loads((EVIDENCE / "2026-08-27--tile-reuse-benchmark.json").read_text())
labels = ["6h", "24h", "7d", "30d", "90d", "1y"]
hit_rates = [data["ranges"][key]["planner"]["application_cache_hit_ratio"] * 100 for key in labels]
drawing = Drawing(640, 235)
chart = VerticalBarChart()
chart.x = 60; chart.y = 40; chart.height = 150; chart.width = 535
chart.data = [hit_rates]
chart.categoryAxis.categoryNames = labels
chart.valueAxis.valueMin = 0; chart.valueAxis.valueMax = 100; chart.valueAxis.valueStep = 20
chart.bars[0].fillColor = CYAN
chart.barLabels.nudge = 7; chart.barLabels.fontName = "Helvetica-Bold"; chart.barLabels.fontSize = 8
chart.barLabelFormat = lambda value: f"{value:.1f}%"
drawing.add(chart)
drawing.add(String(210, 215, "Application canonical-URL cache hit ratio", fontName="Helvetica-Bold", fontSize=12, fillColor=NAVY))
story.append(drawing)
perf_rows = [["Range", "Refs", "Unique", "Reuse", "Cold p50/p95/p99 ms", "Warm p50/p95/p99 ms", "Warm SQL"]]
for key in labels:
    x = data["ranges"][key]; pl = x["planner"]; cold = x["receiver"]["cold"]["latency"]; warm = x["receiver"]["warm"]["latency"]
    perf_rows.append([key, f"{pl['v2_total_references']:,}", f"{pl['v2_unique_urls']:,}", f"{pl['reuse_factor']:.2f}x", f"{cold['p50_seconds']*1000:.3f} / {cold['p95_seconds']*1000:.3f} / {cold['p99_seconds']*1000:.3f}", f"{warm['p50_seconds']*1000:.3f} / {warm['p95_seconds']*1000:.3f} / {warm['p99_seconds']*1000:.3f}", "0"])
t = Table(perf_rows, colWidths=[0.55*inch,0.7*inch,0.7*inch,0.7*inch,2.25*inch,2.25*inch,0.65*inch], repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),NAVY),("TEXTCOLOR",(0,0),(-1,0),colors.white),("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("FONTSIZE",(0,0),(-1,-1),7.8),("GRID",(0,0),(-1,-1),0.35,LIGHT),("ALIGN",(1,1),(-1,-1),"RIGHT"),("BACKGROUND",(0,1),(-1,-1),PALE),("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4)]))
story.append(t)
story.append(Spacer(1, 0.12*inch))
story.append(p("Honest comparator result: v2 used 623 unique URLs versus 554 for v1, because unaligned windows require exact native edge tiles. The gain is reuse, not lower raw URL cardinality: 26,247 references coalesced to 623 URLs (42.13x), and all warm runs executed zero SQLite statements.", "SmallPacket"))
story.append(PageBreak())

# Data semantics
page_title("9. Data products and truth boundaries")
semantic_rows = [
    ["Surface", "Time/source basis", "Explicit boundary"],
    ["Forecast quality", "Matched official vintages", "Diagnostic pairing; not ERCOT performance declaration"],
    ["Net load", "Demand - wind - solar", "Dashboard-derived; no fill, join, or cause"],
    ["Market mechanics", "Exact coherent SCED publications", "Context only; no causal decomposition"],
    ["Congestion geography", "LMP/SPP + coincident constraints", "No point-price contribution claim"],
    ["Storage operations", "5-minute system-wide aggregate", "No SOC, resource identity, intent, or revenue"],
    ["Storage replay", "Shared multi-cadence UTC window", "Not high-resolution battery-response attribution"],
    ["Predictive weather", "Four NWS airport points + TX alerts", "Not ERCOT zones, statewide extrema, or grid alerts"],
    ["Unified events", "Official/source/derived evidence", "Provenance stays separate; TXANS gap visible"],
    ["Historical context", "Observed local-calendar peers", "Not official/all-time ERCOT records"],
    ["Texas Grid", "Official planning snapshots", "Studied/planned is not installed/committed"],
    ["External context", "Annual EPA eGRID bounded slice", "Not live emissions or operational authority"],
]
t = Table(semantic_rows, colWidths=[1.65*inch,3.2*inch,4.75*inch], repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),NAVY),("TEXTCOLOR",(0,0),(-1,0),colors.white),("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("FONTSIZE",(0,0),(-1,-1),8.2),("LEADING",(0,0),(-1,-1),10.5),("GRID",(0,0),(-1,-1),0.35,LIGHT),("BACKGROUND",(0,1),(-1,-1),PALE),("VALIGN",(0,0),(-1,-1),"TOP"),("TOPPADDING",(0,0),(-1,-1),4),("BOTTOMPADDING",(0,0),(-1,-1),4)]))
story.append(t)
story.append(PageBreak())

# Visual pages: paired desktop/mobile
visuals = [
    ("10. Overview", "01-overview"),
    ("11. Grid Outlook", "02-grid-outlook"),
    ("12. Forecast quality", "03-forecast-quality"),
    ("13. Net load and ramp", "04-net-load"),
    ("14. Regional geography", "05-regional-geography"),
    ("15. Market mechanics", "06-market-mechanics"),
    ("16. Congestion and price geography", "07-congestion-geography"),
    ("17. Storage operations", "08-storage-operations"),
    ("18. Multi-cadence storage context replay", "09-storage-replay"),
    ("19. Predictive weather", "10-predictive-weather"),
    ("20. Unified grid event timeline", "11-event-timeline"),
    ("21. Historical context", "12-historical-context"),
    ("22. Texas Grid long-horizon planning", "13-texas-grid"),
    ("23. External context", "14-external-context"),
]
for title, stem in visuals:
    page_title(title, "Deterministic synthetic review fixture - desktop Chromium and iPhone Pro Max WebKit")
    desktop = fit_image(EVIDENCE / "visuals" / f"{stem}-desktop.png", 6.65*inch, 5.72*inch)
    mobile = fit_image(EVIDENCE / "visuals" / f"{stem}-mobile.png", 2.75*inch, 5.72*inch)
    pair = Table([
        [p("Desktop Chromium", "FigureLabel"), p("iPhone WebKit", "FigureLabel")],
        [desktop, mobile],
    ], colWidths=[6.9*inch, 2.9*inch])
    pair.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),("ALIGN",(0,0),(-1,-1),"CENTER"),("BOX",(0,1),(-1,1),0.4,LIGHT),("LEFTPADDING",(0,0),(-1,-1),4),("RIGHTPADDING",(0,0),(-1,-1),4)]))
    story.append(pair)
    story.append(PageBreak())

# Checklist and deployment
page_title("24. Human review checklist")
checks = [
    "Confirm PR #37 has no generic tile body schema, file write, persistence helper, or exact child route.",
    "Confirm fresh-process restart returns the same bytes/ETag without a tile_resources table or artifact file.",
    "Confirm corrections change intersecting ranges only and unrelated tiles stay byte-identical.",
    "Review the benchmark method and the honestly reported increase in v2 unique URL cardinality.",
    "Review all 14 desktop/mobile pairs for containment, source labeling, degraded states, and exact-table access.",
    "Confirm official, source-observation, and dashboard-derived provenance remains distinct.",
    "Confirm unavailable or blocked source states are never represented as zero.",
    "Confirm four-second ESR is accepted as an external scope limit, not silently declared complete.",
    "Confirm exact-head CI, range-diff, PR stack topology, secret scan, builds, and Compose evidence.",
    "Approve merge separately from deployment; require a second explicit production approval.",
]
for item in checks:
    story.append(p(f"[ ] {item}"))
story.append(Spacer(1, 0.15*inch))
story.append(p("Final status", "Subsection"))
story.append(p("READY FOR DETAILED HUMAN REVIEW / CONDITIONAL MERGE CANDIDATE", "Status"))
story.append(p("Nothing was merged or deployed. Production, Portainer, production SQLite, collectors, Cloudflare, and DNS remain unchanged."))
story.append(PageBreak())

page_title("25. Deployment and rollback guide", "Execute only after separate merge and production approvals.")
deploy_rows = [
    ["Stage", "Required action", "Stop / rollback signal"],
    ["Prepare", "Record approved revision and matching image digests; export live stack and COMPLETE Env; preserve volumes/network/ports; take coherent DB backup.", "Missing rollback artifact or mutable image tag"],
    ["Initial rollout", "Use PullImage=true and Prune=false. Keep every new opt-in disabled. Verify containers, routes, auth, restart counts, freshness, and old behavior.", "Restart loop, auth regression, stale operational feeds"],
    ["Tile smoke", "First canonical request MISS; second HIT/304; warm SQLite generation zero. Receiver restart regenerates identical bytes/ETag and no artifacts.", "Unexpected persisted body, byte drift, or SQL on warm path"],
    ["Enable sources", "Enable one source at a time. Check collector logs, source timestamps, receiver health, selected pointer, and browser output.", "Failure hidden by last-good health or missing source timestamp"],
    ["Cloudflare", "Separate approval. Preserve rule order. Cache only reviewed /api/v2/tiles/* GETs and respect origin revalidation/ETag.", "Wrong rule match, cached errors/auth, or missing same-PoP proof"],
    ["Rollback", "Disable collectors first; restore collector then both previous pinned images and COMPLETE prior Env with Prune=false. Restore DB only if required.", "Unable to reproduce approved prior runtime"],
]
deploy_rows = [[p(cell, "SmallPacket") for cell in row] for row in deploy_rows]
t = Table(deploy_rows, colWidths=[0.9*inch,6.0*inch,2.7*inch], repeatRows=1)
t.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),NAVY),("TEXTCOLOR",(0,0),(-1,0),colors.white),("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"),("FONTNAME",(0,1),(0,-1),"Helvetica-Bold"),("FONTSIZE",(0,0),(-1,-1),8),("LEADING",(0,0),(-1,-1),10.5),("GRID",(0,0),(-1,-1),0.35,LIGHT),("BACKGROUND",(0,1),(-1,-1),PALE),("VALIGN",(0,0),(-1,-1),"TOP"),("TOPPADDING",(0,0),(-1,-1),5),("BOTTOMPADDING",(0,0),(-1,-1),5)]))
story.append(t)
story.append(Spacer(1, 0.16*inch))
story.append(p("Secret boundary: never place EIA/EPA keys, receiver ingest secrets, credentials, or complete live Env values in screenshots, logs, browser JSON, checkpoints, this packet, or Git. DEMO_KEY is not a production credential."))

doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
