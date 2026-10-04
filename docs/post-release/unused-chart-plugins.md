# Remove unused chart registrations

The final cumulative a2b2a33 strict run failed the 2500 ms cold median budget at 2549.982 ms; all five runs are retained separately. The profile showed 91,746 transferred bytes for ChartCard. All chart axes use time and linear scales, and every canvas legend is disabled in favor of the existing accessible DOM legend. Remove the unused CategoryScale and Legend imports and registration; keep Tooltip, Filler, zoom and all source/cursor logic.

The scoped production build reduces ChartCard to 87.15 kB gzip (265.05 kB uncompressed). Actual populated smoke, Outlook and shared disclosure browser cases pass 26/26, including 320/390/768/1440 and 6h/24h/7d. This scoped result does not certify final numeric acceptance: the complete stack must rerun the unchanged strict five-run measurement after integration.
