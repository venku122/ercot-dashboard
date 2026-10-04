# Native fixture statistics

The populated native mobile fixture retains every observation when computing statistics. Extrema now use bounded reductions instead of passing an entire 90-day or one-year frequency history as JavaScript function arguments. Plot projection remains bounded independently.

Two browser regressions reproduced `RangeError: Maximum call stack size exceeded` before the repair. They independently enumerate the epoch-anchored waveform and verify all 129,601/525,601 minute-frequency observations and 25,921/105,121 five-minute charging observations, extrema, average, latest, and signed trapezoidal energy. Frequency remains a gauge without MWh. Both regressions and the seven existing routing checks pass on native Chromium. Full commit validation also passes; this is synthetic fixture evidence, not production history.
