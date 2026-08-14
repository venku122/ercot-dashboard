# Page hierarchy, Market, and Reliability

Views with one configured chart group render the view heading and charts directly. Their internal
group remains part of routing, lazy loading, and diagnostics metadata, but no duplicate group heading
or collapse control is presented. Advanced retains its **Advanced grid** and **Ancillary services**
subgroups because those establish a real hierarchy.

Fixed-window state is already explicit in the time selector and URL, so the prominent “Viewing a
fixed analysis window” header label is removed. Live and paused modes retain concise freshness text.

Market uses a canonical settlement-point metadata layer for the ERCOT hub (`HB_*`) and load-zone
(`LZ_*`) codes published by the source. Human-readable labels are primary; point class and raw code
remain visible in the complete ranking. The default summary shows Houston Hub, high-low spread,
regional divergence context, observation age, and publication-cadence interpretation.

The collector reads ERCOT's Real-Time Settlement Point Prices display. ERCOT describes these SPPs
as 15-minute settlement intervals, distinct from the five-minute SCED LMP display. Market freshness
therefore treats up to two 15-minute publication intervals as normal instead of judging the source
like instantaneous telemetry.

Reliability continues to preserve authoritative source records while suppressing negative heartbeat
observations from the public timeline. PowerOutage.us is intentionally disabled and absent from both
the public view and health penalty calculation. The single Reliability group wrapper is removed, so
the view description, operations timeline, and charts form one hierarchy.
