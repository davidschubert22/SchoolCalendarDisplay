// signage-api — Cloudflare Worker for the DTES signage board.
//
//   GET  /weather    Current conditions from the school's WeatherLink station,
//                    normalized to a small JSON object. Cached for 2 minutes.
//   POST /heartbeat  Each screen checks in every 15 minutes (stored in KV).
//   GET  /status?key=STATUS_KEY
//                    Table of screens and when each last checked in.
//
// Settings (Worker → Settings → Variables and Secrets):
//   WL_API_KEY     (secret)  WeatherLink v2 API key
//   WL_API_SECRET  (secret)  WeatherLink v2 API secret
//   WL_STATION_ID  (text)    optional; the first station on the account is used if blank
//   STATUS_KEY     (secret)  any password-like string, required to view /status
// Bindings:
//   SCREENS        KV namespace (for /heartbeat and /status)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (url.pathname === '/weather' && request.method === 'GET') return await weather(env, ctx);
      if (url.pathname === '/heartbeat' && request.method === 'POST') return await heartbeat(request, env);
      if (url.pathname === '/status' && request.method === 'GET') return await status(url, env);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message || err) }, 502);
    }
    return json({ ok: false, error: 'Not found' }, 404);
  }
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra)
  });
}

// ── Weather ─────────────────────────────────────────────────────────────────

async function weather(env, ctx) {
  if (!env.WL_API_KEY || !env.WL_API_SECRET) return json({ ok: false, error: 'WeatherLink keys not configured' }, 503);

  const cache = caches.default;
  const cacheKey = new Request('https://signage-api.internal/weather-v1');
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const headers = { 'X-Api-Secret': env.WL_API_SECRET };
  const key = encodeURIComponent(env.WL_API_KEY);

  let stationId = env.WL_STATION_ID;
  if (!stationId) {
    const r = await fetch(`https://api.weatherlink.com/v2/stations?api-key=${key}`, { headers });
    if (!r.ok) throw new Error('WeatherLink stations: HTTP ' + r.status);
    const s = await r.json();
    stationId = s.stations && s.stations[0] && s.stations[0].station_id;
    if (!stationId) throw new Error('No stations on this WeatherLink account');
  }

  const r = await fetch(`https://api.weatherlink.com/v2/current/${stationId}?api-key=${key}`, { headers });
  if (!r.ok) throw new Error('WeatherLink current: HTTP ' + r.status);
  const body = normalize(await r.json());

  const res = json(body, 200, { 'Cache-Control': 'public, max-age=120' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// WeatherLink returns one record per sensor, with field names that vary by
// hardware generation. Take the first outdoor value found for each field.
function normalize(data) {
  const records = (data.sensors || [])
    .flatMap(s => (s.data || []).map(d => d))
    .filter(Boolean);

  const pick = (...names) => {
    for (const rec of records) {
      for (const n of names) {
        if (rec[n] !== undefined && rec[n] !== null) return rec[n];
      }
    }
    return null;
  };

  const temp = pick('temp', 'temp_out');
  const heat = pick('heat_index', 'heat_index_out');
  const chill = pick('wind_chill');
  let feels = null;
  if (temp != null) {
    if (heat != null && heat > temp) feels = heat;
    else if (chill != null && chill < temp) feels = chill;
    else feels = temp;
  }

  return {
    ok: temp != null,
    ts: pick('ts') || Math.floor(Date.now() / 1000),
    temp_f: temp,
    feels_f: feels,
    hum: pick('hum', 'hum_out'),
    dew_point_f: pick('dew_point'),
    wind_mph: pick('wind_speed_last', 'wind_speed_avg_last_1_min', 'wind_speed'),
    wind_dir_deg: pick('wind_dir_last', 'wind_dir_scalar_avg_last_1_min', 'wind_dir'),
    gust_mph: pick('wind_speed_hi_last_10_min', 'wind_gust_10_min'),
    rain_day_in: pick('rainfall_daily_in', 'rain_day_in'),
    rain_rate_in: pick('rain_rate_last_in', 'rain_rate_in'),
    bar_in: pick('bar_sea_level', 'bar'),
    bar_trend: pick('bar_trend')
  };
}

// ── Heartbeat / status ──────────────────────────────────────────────────────

async function heartbeat(request, env) {
  if (!env.SCREENS) return json({ ok: false, error: 'SCREENS KV not bound' }, 503);
  let body = {};
  try { body = JSON.parse(await request.text()); } catch (e) { /* keep empty */ }
  const screen = String(body.screen || 'unnamed').slice(0, 60);
  const record = {
    screen,
    seen: Date.now(),
    ip: request.headers.get('CF-Connecting-IP') || '',
    build: body.build || null,
    calendarAt: body.calendarAt || null,
    calendarError: body.calendarError || null,
    weather: body.weather || null,
    screenSize: body.screenSize || '',
    userAgent: String(body.userAgent || '').slice(0, 300)
  };
  // Free KV allows 1,000 writes/day: 15-minute heartbeats cover ~10 screens.
  await env.SCREENS.put('screen:' + screen, JSON.stringify(record));
  return json({ ok: true });
}

async function status(url, env) {
  if (!env.STATUS_KEY || url.searchParams.get('key') !== env.STATUS_KEY) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!env.SCREENS) return new Response('SCREENS KV not bound', { status: 503 });

  const list = await env.SCREENS.list({ prefix: 'screen:' });
  const rows = (await Promise.all(list.keys.map(k => env.SCREENS.get(k.name, 'json')))).filter(Boolean)
    .sort((a, b) => a.screen.localeCompare(b.screen));

  const ago = ms => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 60) return m + ' min ago';
    if (m < 2880) return Math.round(m / 60) + ' h ago';
    return Math.round(m / 1440) + ' days ago';
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const body = rows.map(r => {
    const late = Date.now() - r.seen > 35 * 60000;
    return `<tr class="${late ? 'late' : ''}">
      <td>${esc(r.screen)}</td>
      <td>${ago(r.seen)}</td>
      <td>${r.calendarAt ? ago(r.calendarAt) : '—'}${r.calendarError ? ' <span class="err">' + esc(r.calendarError) + '</span>' : ''}</td>
      <td>${esc(r.weather && r.weather.source)}</td>
      <td><code>${esc(r.build)}</code></td>
      <td>${esc(r.screenSize)}</td>
      <td>${esc(r.ip)}</td>
    </tr>`;
  }).join('');

  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Signage status</title>
<style>
  body{font:15px system-ui,sans-serif;margin:24px;color:#0f172a;background:#f8fafc}
  table{border-collapse:collapse;width:100%;background:#fff}
  th,td{padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:left}
  th{background:#f1f5f9} tr.late td{background:#fef2f2} .err{color:#b91c1c}
  code{font-size:13px}
</style>
<h1>Signage screens</h1>
<p>Rows turn red when a screen hasn't checked in for 35 minutes. Page refreshes every minute.</p>
<table><tr><th>Screen</th><th>Last check-in</th><th>Calendar data</th><th>Weather source</th><th>Build</th><th>Display</th><th>IP</th></tr>
${body || '<tr><td colspan="7">No screens have checked in yet.</td></tr>'}</table>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
