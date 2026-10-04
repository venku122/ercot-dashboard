# Paired headroom catalog compatibility

The default `/api/v2/tile-catalog` retains the established schema and exact/selector entries so existing frontend tabs can still parse the complete core catalog. Reviewed paired headroom is exposed only through `/api/v2/tile-catalog?include=paired-headroom`; other catalog queries are rejected. The candidate opts in only for paired charts and uses a distinct canonical cache URL and fingerprint. Physical queries keep the default catalog. Each representation has its own content ETag.

A receiver regression validates every default entry against the previous strict key/match contract, checks equality after removing the opted-in paired entry, distinct ETags, conditional requests, and rejection of unknown/duplicate queries. Existing raw-pair and canonical lifecycle tests remain in force.
