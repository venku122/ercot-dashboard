# Retained history during a pending selection

The source-complete plot keeps its completed time axis while a new warm batch is pending. Requested selection bounds now travel separately into ChartCard, so retained measurements, statistics, and comparison labels explicitly identify their previous selection before the replacement batch commits. Ordinary overlapping live refreshes retain their existing selection identity.

The complete Chromium matrix produced genuine RED failures for range and disjoint-clock changes after cold-only priority restored warm batching. The unchanged original warm-context tests now pass for range, comparison, disjoint clock and ordinary rolling refresh; the cold core-priority test also passes (five tests, zero skips). No request ceiling, source fixture, data values or assertion was changed.
