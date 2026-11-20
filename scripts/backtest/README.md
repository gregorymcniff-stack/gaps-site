# SFI backtest

Tests whether GAPS inputs give warning of real US disruptions: new FAA ground
stops and ground delay programs in the next 3 and 6 hours.

```
node fetch-faa.mjs 2026-07-16 2026-11-12 faa-adv.json      # FAA ATCSCC Advisory Database (fly.faa.gov)
node fetch-weather.mjs 2026-07-16 2026-11-12 wx.json       # Open-Meteo historical-forecast API
node analyze.mjs faa-adv.json wx.json ../../public/data/backtest-results.json
```

- First 2/3 of the period: fitting (time-of-day baseline, combined model, thresholds).
- Last 1/3: scoring only. AUC 0.5 = coin flip, 1.0 = perfect.
- Traffic is not tested: no free historical aircraft counts exist.
- Weather uses Open-Meteo model data, not METAR reports (the METAR archive
  throttled requests); the live site blends both.

## Per-airport outlooks

```
node analyze-airports.mjs faa-adv.json wx.json ../../public/data   # writes airport-model.json and airport-backtest.json
```

Target: a new ground stop or ground delay program at the airport in the next
3 hours. One pooled model for 15 US hubs; same train/test split and 30-day
re-centring as the national index.

## Leading-signal test (Nov 2026)

```
node test-leading-signals.mjs faa-adv.json wx.json leading.json
```

Tests whether FAA "proposed ground delay program" advisories and airport
delay advisories add warning on top of the current model. Result: proposals
are followed by the real program 592 times out of 595, but a median of only
13 minutes later. Added to the model they change the held-out AUC by +0.002
(95% range −0.001 to +0.004), so they are not used. `faa-adv.json` can be
rebuilt from `public/data/faa-advisories.csv`.

## Two-year refit (Nov 2026)

```
gunzip -c data/faa-adv-2024-11-15_2026-11-18.json.gz > faa-2y.json   # or: node fetch-faa.mjs 2024-11-15 2026-11-18 faa-2y.json
node fetch-weather-2y.mjs 2024-11-15 2026-11-18 wx-2y.json
SPLIT=weeks node analyze.mjs faa-2y.json wx-2y.json ../../public/data/backtest-results.json
node export-faa-csv.mjs faa-2y.json ../../public/data/faa-advisories.csv
```

`SPLIT=weeks` holds out every third calendar week, so the test covers every
season. Days the FAA archive returns empty (2025-08-24, 2025-08-25,
2026-02-09) are treated as missing. `test-2y.mjs` compares the forecast input
with real airport reports (METARs from the Iowa Environmental Mesonet) and
"programs so far today"; its results are in `results/`. The published
backtest-results.json also carries the 4-month results for inputs that were
not re-tested (world weather, jet stream, FAA proposals), marked `testedOn`.
The per-airport models (`analyze-airports.mjs`) are still fitted on the
4-month data.
