# First useful Overview plots and the existing visibility queue

The controlled integrated candidate e7b2336c18f12fa28a19ecafc8eb319275867236 failed the unchanged cold median gate at2532.326ms (all five runs2760.130/2513.871/2532.326/2580.464/2514.458). Pointerp95=34ms,200 genuine changed readouts,zero actual history GET/POST requests; all six populated bounded-range checks passed. Identical-fixture baseline main1dc9906 failed at2664.916ms. The approximate5% improvement does not fulfill2500ms.

The captured median profile places the initial mixed physical history response (94373bytes) at1907ms, paired tiles2080–2250ms, and another visible-card batch around2460ms. The first data commit waits for the entire mixed history batch, including full selected-window frequency. The separate current snapshot is not an acceptable replacement for selected-window frequency.

The existing serialized visibility queue now prioritizes supply/demand, independent PRC and native paired headroom when any of those charts is pending. Only those selected batch keys are marked attempted. Frequency remains forced and all other eligible visible charts remain queued; they load immediately through the same next-batch revision. Time-aligned frequency stays honestly unavailable while its own history is pending, then receives its real selected-window data. No points, source families, cursor/statistics/export evidence, first-useful readiness, eight-permit limit, cache policy or numeric thresholds are removed.

The meaningful actual-browser regression holds the frequency history response. Before repair, the first supply canvas cannot become ready; the original failure/trace is preserved in campaign artifacts. After repair, both first plots and populated GW legends render while frequency is held. Releasing it yields the real frequency chart and Hz readout, while the first plots remain ready. The paired last-point/cursor/table/CSV regression also passes unchanged. Generation, abort and obsolete-response guards remain the existing controls.

Final numeric acceptance must be measured after this change and all accessibility repairs; this document does not claim that pending measurement passes.
