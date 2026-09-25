# signage-api Worker

This Worker is optional. It is separate from the existing ICS Worker
(`red-frost-1be1`), which it doesn't touch. It provides:

- `GET /weather`: current conditions from the school's WeatherLink station,
  or the WeatherSTEM headquarters station on Shannon Lakes N when the school's isn't
  reporting. The API keys stay in the Worker instead of the public page.
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
   - `WS_API_KEY` (Secret): a WeatherSTEM API key. This uses WeatherSTEM's
     v1 (JSON) API; their newer "API V2" is a browser widget library that a
     Worker can't use. Try a key from the **My API V2 Keys** tab at
     weatherstem.com/apiv2_docs first. If `/weather?raw=1` reports "You do not
     have access to this feature", email api@weatherstem.com and ask for v1
     API access for a school's digital signage. Leave it out to skip
     WeatherSTEM.
   - `WS_STATION` (Text, optional): defaults to `wxstemhq@leon.weatherstem.com`.

   **Never put these keys in `config.js`.** It's published on GitHub Pages
   for anyone to read. Secrets set here are encrypted, and even you can't
   view them again in the dashboard.
   - `STATUS_KEY` (Secret): any long random string.
5. Check it: open `https://signage-api.<your-subdomain>.workers.dev/weather`.
   You should see `"ok":true`, `temp_f`, and `"source"` (weatherlink or
   weatherstem). `notes` explains any source that was skipped. If something
   is wrong, open `/weather?raw=1` to see exactly what each service returned. Errors include WeatherLink's own
   message, e.g. a 401 means the key or secret is wrong.
6. In `config.js`, set:
   ```js
   WEATHER: { ..., STATION_API_URL: "https://signage-api.<your-subdomain>.workers.dev/weather" },
   HEARTBEAT_URL: "https://signage-api.<your-subdomain>.workers.dev/heartbeat",
   ```
7. Bookmark `https://signage-api.<your-subdomain>.workers.dev/status?key=<STATUS_KEY>`.

## Notes

- Fallback order: WeatherLink, then WeatherSTEM, then NWS Tallahassee
  Airport (which the board fetches itself if the Worker has nothing). A source
  is skipped if its reading is older than 30 minutes or has no temperature.
  The panel footer shows which source is in use.
- On Workers Free, KV allows 1,000 writes a day. At 15-minute heartbeats that's
  about 10 screens. For more, raise `HEARTBEAT_MINUTES` in `config.js`.
- The school station currently drops out overnight (probably the outdoor
  unit's backup battery). The WeatherSTEM station covers those hours automatically.
