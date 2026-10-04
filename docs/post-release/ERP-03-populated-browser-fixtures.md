# Populated paired headroom browser fixtures

The shared `paired-headroom-fixtures.ts` generator serves both observed contributor resources and derived headroom from identical source-owned 300-second epochs. It subtracts capacity minus demand before computing bucket extrema, counts, sums and timestamps. The derived resource is a gauge, has zero energy integral, and reports native pairing coverage without inventing a first collection time. Catalog and tile representations have stable content ETags and support conditional requests. Empty and unavailable scenarios remain explicit.

Both mobile and dashboard fixture installers use this generator. The embedded seven-day aggregate fixture now also includes the opted-in paired entry and uses genuine constant native contributors for its observed resources. Default catalogs retain only the previous exact/selector contract; the candidate explicitly requests `?include=paired-headroom`.

For performance comparisons, copy the same fixture files to both baseline and candidate. The default catalog's physical contributor population and native timestamps are identical in both, while the candidate additionally consumes the opted-in headroom resource. This avoids making the old frontend reject the complete catalog. Legacy live batch population is retained. First-useful predicates, screenshots, tolerances and product code are unchanged by the fixture commit.

Focused proof covers native-before-aggregation raw oracles, native pairing counts, gauge/no-energy semantics, an actual populated headroom chart, old/new catalog representations and distinct ETags, and the existing canonical seven-day browser test.
