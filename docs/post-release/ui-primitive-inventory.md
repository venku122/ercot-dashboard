# ERP-10 scoped UI primitive inventory

State/data remain owned by the original domain hooks and parents. Shared components
provide disclosure, button and contained-table geometry, with no fetch loop.

| Consumer                                                                  | Disposition                                             | Request/focus behavior                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Historical context and records                                            | Migrated to controlled DisclosureCard                   | Parent `enabled && expanded` gate preserved; stable associated hidden content exists when collapsed                                |
| Historical method/provenance                                              | EvidenceDisclosure composition                          | Already-loaded summary only; independent generated IDs and 44px keyboard control                                                   |
| Texas Grid source health                                                  | EvidenceDisclosure composition                          | Manifest already loaded; expanding starts no selected-resource request                                                             |
| Texas Grid family/series/scenario controls and exact tables               | Shared segmented Button and data-table classes          | Existing selected URL/resource identity and disabled/source states preserved; group semantics added to local series picker         |
| External Context health/eGRID provenance, family controls/tables          | EvidenceDisclosure, shared segmented Button/data tables | Existing no-key and source selection behavior unchanged; table minimum column widths remain feature-local                          |
| Outlook hourly values, day controls/tables                                | EvidenceDisclosure, shared segmented Button/data tables | Loaded domain result only; accessible labeled focused scroll region. Profile temporal rendering addressed separately in ERP-07     |
| Market Geography/Mechanics                                                | Already shared controlled DisclosureCard                | Existing lazy domain ownership retained; nested provenance disclosures are native specialized evidence                             |
| ChartCard Inspect/menu/legend/accessibility tables                        | Intentionally specialized                               | Preserves single chart instance, dialog focus contract and expanded-statistics geometry; not rewritten as disclosure shell         |
| Overview cursor evidence/engineering and App alert/health/formula details | Intentionally retained native details                   | Existing temporal subscriptions and optional engineering gating; scope/layout differ from specialist evidence cards                |
| Predictive Weather exact intervals/alerts/health                          | Intentionally retained native evidence                  | Retains source interval/alert layouts; domain eligibility and nested detail tables use existing controls                           |
| Grid Event gaps/exact evidence                                            | Intentionally retained native evidence                  | Event-bound temporal domain and exact event table retained                                                                         |
| Storage Operations/Replay exact provenance/annotations                    | Intentionally retained native evidence                  | Source-coherence/live-versus-replay layouts retained                                                                               |
| ui/card.tsx                                                               | Unused legacy export                                    | No call sites found; retained as compatibility surface, not counted as a migrated active consumer                                  |
| Remaining evidence cards such as Forecast Quality and Net Load            | Specialized product sections                            | Existing eligibility, loading/error/source states and source-specific tables retained; no unsupported whole-UI consolidation claim |

`EvidenceDisclosure` composes the existing primitive for already-loaded provenance.
Product expansion and request gates remain in the original parent. Headings use level
3 for nested evidence. Each disclosure owns generated content/title identity; no
interactive element is nested inside its trigger. Shared data-table CSS owns padding,
borders, containment and scrolling. Texas/External feature styles retain only minimum
column/table widths required by dense evidence. Dead historical toggle/header styles
and duplicated table/series-control styling are removed; ChartCard geometry stays intact.

The campaign retains existing native specialist disclosures deliberately instead of
rewriting every details element. This inventory describes scoped consolidation, not
completion of a new design system. Subsequent ERP-07 inline Outlook uses these same
surfaces. Manual assistive-technology/physical-device evidence belongs to ERP-09.
