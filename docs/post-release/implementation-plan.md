# ERCOT post-release implementation plan

Spec: /tmp/ercot-post-release-2026-10/AGENT_DIRECTIVE.md (approved supplied directive).
Goal: all twelve scoped issues with actual implementation/evidence, draft stack and local review.
Architecture: existing React/Chart.js/SWR, Deno collectors, Python/SQLite canonical ephemeral tiles. Additive contracts only.
Constraints: no merges or production changes. Preserve dirty original checkout. Every evidence result names exact head/environment; unknown is not pass.
Review focus: mixed cadence disappearing lines; subtract-before-aggregate; vintage knowledge leakage; late range/point responses; harness output without numeric acceptance.

## Task 1: ERP-12

Branch: ercot-post-release/01-tracking-reconciliation; base: main.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 2: ERP-11

Branch: ercot-post-release/02-current-status; base: ercot-post-release/01-tracking-reconciliation.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 3: ERP-01

Branch: ercot-post-release/03-release-smoke; base: ercot-post-release/02-current-status.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 4: ERP-02

Branch: ercot-post-release/04-temporal-policies; base: ercot-post-release/03-release-smoke.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 5: ERP-08

Branch: ercot-post-release/05-source-audit; base: ercot-post-release/04-temporal-policies.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 6: ERP-03

Branch: ercot-post-release/06-paired-headroom; base: ercot-post-release/05-source-audit.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 7: ERP-04

Branch: ercot-post-release/07-forecast-semantics; base: ercot-post-release/06-paired-headroom.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 8: ERP-05

Branch: ercot-post-release/08-settlement-intervals; base: ercot-post-release/07-forecast-semantics.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 9: ERP-10

Branch: ercot-post-release/09-ui-primitives; base: ercot-post-release/08-settlement-intervals.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 10: ERP-07

Branch: ercot-post-release/10-inline-outlook; base: ercot-post-release/09-ui-primitives.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 11: ERP-06

Branch: ercot-post-release/11-homepage-performance; base: ercot-post-release/10-inline-outlook.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.

## Task 12: ERP-09

Branch: ercot-post-release/12-accessibility-final-evidence; base: ercot-post-release/11-homepage-performance.

- [ ] Read owning issue acceptance A–G and current consumers, map file/interface changes.
- [ ] Write and observe failing behavioral regression (admin/docs: consistency/readback).
- [ ] Implement narrow source/model/consumer changes; preserve compatibility.
- [ ] Focused tests then static/unit/build and affected browser/collector/API gates.
- [ ] Commit, validate exact head, independent review and remediation.
- [ ] Push campaign branch, create draft, attach/read back and update evidence.
