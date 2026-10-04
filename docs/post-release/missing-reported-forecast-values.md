# Archived forecasts with missing reported values

The NP3-565 contract permits a selected publication row whose `systemTotal` is null. Normal ingest and the historical API preserve that source-reported missing value and its coverage. Such a row is not zero and is not an invalid delivery interval or failed request.

The frontend validates source units, hourly delivery bounds and issue/as-of policy for nullable rows, then builds plot/cursor/table observations only from numeric rows. A valid selection with missing values says “Archived pre-delivery forecast has missing reported values”; a selection with no eligible vintage keeps its separate explanation. Neither promotes otherwise readable observed demand/capacity to a request-failure overlay. Malformed rows and actual comparison transport failures still do.

The authored synthetic fixture in `frontend/test-fixtures/forecast/valid-missing-hour.json` is reproduced through normal NP3-565 ingest, SQLite and real loopback HTTP. It preserves null, publication clocks and available/selected/missing coverage. It is neither a production capture nor proof that the system knew the publication at the official issue time. Its padded API read includes the left-touching ending-hour slot; frontend delivery overlap remains half-open.
