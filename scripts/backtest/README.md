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
