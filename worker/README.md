# signage-api Worker

This Worker is optional. It is separate from the existing ICS Worker
(`red-frost-1be1`), which it doesn't touch. It provides:

- `GET /weather`: current conditions from the school's WeatherLink station.
  The API secret stays in the Worker instead of the public page.
- `POST /heartbeat`: every screen checks in every 15 minutes.
- `GET /status?key=…`: a page listing each screen and when it last checked in.

Without it, the board still works. Current conditions come from the NWS
Tallahassee Airport observation, and there's no status page.

## Deploy (Cloudflare dashboard, no tools needed)

1. **Workers & Pages → Create → Worker**, name it `signage-api`, then **Deploy**.
2. **Edit code**: replace everything with `signage-api.js`, then **Deploy**.
3. **Storage & Databases → KV → Create namespace** named `signage-screens`.
   Then go to the Worker → **Settings → Bindings → Add → KV namespace**:
   variable name `SCREENS`, namespace `signage-screens`.
4. Worker → **Settings → Variables and Secrets**:
   - `WL_API_KEY` (Secret) and `WL_API_SECRET` (Secret): sign in to
     weatherlink.com with the account that **owns** the station, go to
     **Account** (weatherlink.com/account) and click **Generate v2 Key**. The
     secret is only shown once; clicking the button again replaces it. Free
     (Basic) accounts can use the API: they get the station's most recent
     15-minute record, with no history.
   - `WL_STATION_ID` (Text, optional): leave it out to use the first station on
     the account. You don't need the v1 API token.
   **Never put these keys in `config.js`.** It's published on GitHub Pages
   for anyone to read. Secrets set here are encrypted, and even you can't
   view them again in the dashboard.
   - `STATUS_KEY` (Secret): any long random string.
5. Check it: open `https://signage-api.<your-subdomain>.workers.dev/weather`.
   You should see `"ok":true` and `temp_f`. If not, `notes` says why, and
   `/weather?raw=1` shows exactly what WeatherLink returned. Errors include WeatherLink's own
   message, e.g. a 401 means the key or secret is wrong.
6. In `config.js`, set:
   ```js
   WEATHER: { ..., STATION_API_URL: "https://signage-api.<your-subdomain>.workers.dev/weather" },
   HEARTBEAT_URL: "https://signage-api.<your-subdomain>.workers.dev/heartbeat",
   ```
7. Bookmark `https://signage-api.<your-subdomain>.workers.dev/status?key=<STATUS_KEY>`.

## Notes

- If the station's reading is older than 30 minutes or has no temperature,
  `/weather` returns `"ok":false`. The board then uses WeatherSTEM HQ (if
  configured in `config.js`), then NWS Tallahassee Airport. The panel footer
  shows which source is in use.
- On Workers Free, KV allows 1,000 writes a day. At 15-minute heartbeats that's
  about 10 screens. For more, raise `HEARTBEAT_MINUTES` in `config.js`.
- The school station currently drops out overnight (probably the outdoor
  unit's backup battery). WeatherSTEM HQ covers those hours automatically.
