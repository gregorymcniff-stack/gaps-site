# GAPS — Global Airline Pressure System

Live aviation dashboard at https://dashboardrunway.live (Netlify, publishes `main`).

## How live data works

- `netlify/functions/collect.mjs` runs every 10 minutes on the published site. It fetches every
  public feed **on the server** and saves one snapshot (plus a compact history row) to Netlify Blobs.
- `netlify/functions/live.mjs` serves that snapshot at `/api/live`. If the snapshot is missing or
  older than 12 minutes (e.g. on deploy previews, where schedules don't run), it fetches fresh data.
  The CDN caches the response for 60 s, so all visitors share one copy.
- `netlify/functions/track-update.mjs` runs hourly: it compares the stored outlooks with the FAA
  advisory database (one cached blob per day) and saves the live track record, served at
  `/api/track-record` and shown on `track.html`. Same target as the backtest (`netlify/lib/track.mjs`).
- `public/index.html` reads only `/api/live`. Every panel shows the time of its data. A feed that is
  down shows "No live data"; there are no stand-in numbers.

| Feed | Source | Notes |
|---|---|---|
| Aircraft positions | OpenSky Network | Optional free account: set `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` in Netlify env vars for 10× the request allowance |
| US ground stops / delay programs | FAA NAS Status | |
| Airport weather (23 airports) | AviationWeather.gov METAR | |
| Hazards | AviationWeather.gov SIGMETs (international + US) | |
| Weather model, 250 hPa winds | Open-Meteo | Browser fetches directly if the server copy is missing |
| Space weather | NOAA SWPC Kp | |
| Emergency squawks, aircraft near hubs | adsb.lol | Community receivers |
| Europe flow regulations | EUROCONTROL | Not connected: needs an approved B2B account |

## Tests

```
npm install
npm test
```
