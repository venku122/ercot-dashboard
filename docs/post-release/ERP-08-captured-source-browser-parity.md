# Captured live source browser parity

`e2e/source-market-rehearsal.spec.ts` replays public API responses saved after bounded one-shot collectors delivered to a new local tmpfs receiver. It checks 390px and 1440px accessible readouts against those exact response values, with an independent unit/presentation oracle. Synthetic shell data provides unrelated dashboard requests; the asserted source families exclusively use the captured GET responses, and any uncaptured request in these families fails.

Set `SOURCE_REHEARSAL_CAPTURE` to the all-family rehearsal `responses.json` (with sibling `source-rehearsals.json`), and `SOURCE_RENEWABLE_CAPTURE` to the additional renewables capture containing `/api/v1/forecast-quality` and selected immutable resources. The helper requires successful isolated live-source evidence, rejects captures larger than 8 MB, performs no outbound calls, records SHA-256 evidence, and freezes presentation time to the main capture's recorded `as_of`.

Run:

```sh
SOURCE_REHEARSAL_CAPTURE=/absolute/all-family/responses.json \
SOURCE_RENEWABLE_CAPTURE=/absolute/renewables/responses.json \
PLAYWRIGHT_PORT=3018 pnpm exec playwright test e2e/source-market-rehearsal.spec.ts --project=chromium
```

To produce the additional capture, run the existing reviewed rehearsal helper from the candidate checkout, extending only its read-only capture list at invocation:

```sh
python3 - <<'PY'
import sys
sys.path.insert(0, 'scripts')
import rehearse_sources
rehearse_sources.PATHS = ('source-health', 'forecast-quality', 'net-load')
sys.argv = ['rehearse_sources.py', '--family', 'renewables', '--port', '4328']
rehearse_sources.main()
PY
```

This uses public credential-free renewable sources, a uniquely named disposable receiver, a new tmpfs database, bounded collector execution, and cleanup of only created resources. Preserve the prior all-family capture separately before a new capture replaces the checkout's ignored `artifacts/post-release/source-rehearsal` directory.

Coverage: every current wind/solar region; selected native generation/forecast/change histories; every coherent market-mechanics reading with its identity, unit, and product provenance; all current settlement prices; exact selected settlement and constraint histories; six wind/solar quality series/horizon tables including missing values and diagnostic qualification. The current capture has no exact-SCED constraint match, and that explicit absence is asserted. Weather-zone load is absent from these live ingests. Market-mechanics completed-day resources are absent in this capture; no synthetic history is substituted. This is captured-live publication parity, not production freshness or live service availability.
