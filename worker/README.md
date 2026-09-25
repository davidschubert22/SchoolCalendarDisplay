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
   - `WL_API_KEY` (Secret) and `WL_API_SECRET` (Secret): on weatherlink.com,
     go to **Account → Generate v2 Key**.
   - `WL_STATION_ID` (Text, optional): leave it out to use the first station on
     the account.
   - `STATUS_KEY` (Secret): any long random string.
5. Check it: open `https://signage-api.<your-subdomain>.workers.dev/weather`.
   You should see `"ok":true` with `temp_f`.
6. In `config.js`, set:
   ```js
   WEATHER: { ..., STATION_API_URL: "https://signage-api.<your-subdomain>.workers.dev/weather" },
   HEARTBEAT_URL: "https://signage-api.<your-subdomain>.workers.dev/heartbeat",
   ```
7. Bookmark `https://signage-api.<your-subdomain>.workers.dev/status?key=<STATUS_KEY>`.

## Notes

- If the station hasn't reported for 30 minutes, or temperature is missing,
  the board falls back to NWS observations automatically. The panel footer
  shows which source is in use.
- On Workers Free, KV allows 1,000 writes a day. At 15-minute heartbeats that's
  about 10 screens. For more, raise `HEARTBEAT_MINUTES` in `config.js`.
- On 2026-09-24 the WeatherLink widget showed high/low and barometer, but blank
  temperature, wind and humidity. The outdoor sensor suite may need attention
  (battery, or a lost connection to the console).
