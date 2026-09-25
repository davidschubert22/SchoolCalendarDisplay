// signage-api — Cloudflare Worker for the DTES signage board.
//
//   GET  /weather    Current conditions, normalized to a small JSON object and
//                    cached for 2 minutes. Tries the school's WeatherLink station
//                    first, then a nearby WeatherSTEM station; "source" says which.
//                    Add ?raw=1 to see what each service actually returned.
//   POST /heartbeat  Each screen checks in every 15 minutes (stored in KV).
//   GET  /status?key=STATUS_KEY
//                    Table of screens and when each last checked in.
//
// Settings (Worker → Settings → Variables and Secrets):
//   WL_API_KEY     (secret)  WeatherLink v2 API key
//   WL_API_SECRET  (secret)  WeatherLink v2 API secret
//   WL_STATION_ID  (text)    optional; the first station on the account is used if blank
//   WS_API_KEY     (secret)  WeatherSTEM API key (from your weatherstem.com account)
//   WS_STATION     (text)    optional; default "wctv@leon.weatherstem.com"
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
      if (url.pathname === '/weather' && request.method === 'GET') return await weather(env, ctx, url.searchParams.has('raw'));
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

const MAX_AGE_S = 30 * 60; // a reading older than this counts as "not reporting"

async function weather(env, ctx, raw) {
  const cache = caches.default;
  const cacheKey = new Request('https://signage-api.internal/weather-v3');
  const hit = !raw && await cache.match(cacheKey);
  if (hit) return hit;

  const sources = [];
  if (env.WL_API_KEY && env.WL_API_SECRET) sources.push(['weatherlink', weatherLink]);
  if (env.WS_API_KEY) sources.push(['weatherstem', weatherStem]);
  if (!sources.length) return json({ ok: false, error: 'No weather sources configured' }, 503);

  const notes = [], rawOut = {};
  let result = null;
  for (const [name, load] of sources) {
    try {
      const { normalized, data } = await load(env);
      if (raw) rawOut[name] = { normalized, raw: data };
      const age = Math.floor(Date.now() / 1000) - normalized.ts;
      if (!normalized.ok) notes.push(name + ': no outdoor temperature');
      else if (age > MAX_AGE_S) notes.push(name + ': last reading ' + Math.round(age / 60) + ' min old');
      else if (!result) result = Object.assign({ source: name }, normalized);
    } catch (err) {
      notes.push(name + ': ' + String(err && err.message || err));
    }
    if (result && !raw) break;
  }

  if (raw) return json({ chosen: result, notes, sources: rawOut });
  const body = result ? Object.assign(result, { notes }) : { ok: false, notes };
  const res = json(body, 200, { 'Cache-Control': 'public, max-age=120' });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function weatherLink(env) {
  const headers = { 'X-Api-Secret': env.WL_API_SECRET };
  const key = encodeURIComponent(env.WL_API_KEY);

  let stationId = env.WL_STATION_ID;
  if (!stationId) {
    const r = await fetch(`https://api.weatherlink.com/v2/stations?api-key=${key}`, { headers });
    if (!r.ok) throw new Error('stations HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const s = await r.json();
    stationId = s.stations && s.stations[0] && s.stations[0].station_id;
    if (!stationId) throw new Error('no stations on this account');
  }

  const r = await fetch(`https://api.weatherlink.com/v2/current/${stationId}?api-key=${key}`, { headers });
  if (!r.ok) throw new Error('current HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  return { normalized: normalize(data), data };
}

// ── WeatherSTEM ──
// Response: [{ station: {...}, record: { time, down_since, readings: [
//   { sensor_type: "Thermometer", value: "78.1", unit_symbol: "°F" }, ... ] } }]

async function weatherStem(env) {
  const station = env.WS_STATION || 'wctv@leon.weatherstem.com';
  const r = await fetch('https://api.weatherstem.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: env.WS_API_KEY, stations: [station] })
  });
  const text = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 200));
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('unexpected response: ' + text.slice(0, 200)); }
  if (data && data.error) throw new Error(data.error);
  return { normalized: normalizeStem(Array.isArray(data) ? data[0] : data), data };
}

function normalizeStem(entry) {
  const rec = (entry && entry.record) || {};
  const readings = rec.readings || [];
  const read = type => {
    const x = readings.find(v => String(v.sensor_type).toLowerCase() === type.toLowerCase());
    if (!x || x.value === '' || x.value == null) return null;
    const n = parseFloat(x.value);
    return isNaN(n) ? null : { n, unit: String(x.unit_symbol || x.unit || '').toLowerCase() };
  };
  const toF = v => v == null ? null : (/c/.test(v.unit) && !/f/.test(v.unit) ? v.n * 9 / 5 + 32 : v.n);
  const toMph = v => {
    if (v == null) return null;
    if (/km/.test(v.unit)) return v.n * 0.621371;
    if (/m\/s/.test(v.unit)) return v.n * 2.23694;
    if (/kt|knot/.test(v.unit)) return v.n * 1.15078;
    return v.n;
  };

  const temp = toF(read('Thermometer'));
  const heat = toF(read('Heat Index'));
  const chill = toF(read('Wind Chill'));
  let feels = temp;
  if (temp != null && heat != null && heat > temp) feels = heat;
  else if (temp != null && chill != null && chill < temp) feels = chill;
  const hum = read('Hygrometer');
  const dir = read('Wind Vane');
  const bar = read('Barometer');

  return {
    ok: temp != null && !rec.down_since,
    ts: parseStemTime(rec.time) || Math.floor(Date.now() / 1000),
    temp_f: temp,
    feels_f: feels,
    hum: hum && hum.n,
    dew_point_f: toF(read('Dewpoint')),
    wind_mph: toMph(read('Anemometer')),
    wind_dir_deg: dir && dir.n,
    gust_mph: toMph(read('10 Minute Wind Gust')),
    rain_day_in: null, // WeatherSTEM's rain gauge total isn't reliably "today"
    rain_rate_in: null,
    bar_in: bar && bar.n,
    bar_trend: null
  };
}

// WeatherSTEM times look like "2026-09-24 14:05:00" in the station's local
// (Eastern) time; ISO strings with an offset are accepted too.
function parseStemTime(v) {
  if (!v) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    const t = Date.parse(v);
    return isNaN(t) ? null : Math.floor(t / 1000);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  if (!m) return null;
  const asUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  // Offset of America/New_York at that moment, via Intl.
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(asUTC)).map(x => [x.type, +x.value]));
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - asUTC;
  return Math.floor((asUTC - offset) / 1000);
}

// WeatherLink returns one record per sensor, with field names that vary by
// hardware generation and by subscription (free "Basic" accounts get the
// latest 15-minute archive record, which uses names like temp_last / temp_avg).
// Prefer the outdoor record, i.e. the one carrying an outdoor temperature.
const TEMP_FIELDS = ['temp', 'temp_out', 'temp_last', 'temp_avg'];

function normalize(data) {
  const all = (data.sensors || []).flatMap(s => s.data || []).filter(Boolean);
  const outdoor = all.find(rec => TEMP_FIELDS.some(n => rec[n] != null));
  const records = outdoor ? [outdoor, ...all.filter(r => r !== outdoor)] : all;

  const pick = (...names) => {
    for (const rec of records) {
      for (const n of names) {
        if (rec[n] !== undefined && rec[n] !== null) return rec[n];
      }
    }
    return null;
  };

  const temp = pick(...TEMP_FIELDS);
  const heat = pick('heat_index', 'heat_index_out', 'heat_index_last');
  const chill = pick('wind_chill', 'wind_chill_last');
  let feels = null;
  if (temp != null) {
    if (heat != null && heat > temp) feels = heat;
    else if (chill != null && chill < temp) feels = chill;
    else feels = temp;
  }

  return {
    ok: temp != null,
    ts: (outdoor && outdoor.ts) || Math.floor(Date.now() / 1000),
    temp_f: temp,
    feels_f: feels,
    hum: pick('hum', 'hum_out', 'hum_last', 'hum_avg'),
    dew_point_f: pick('dew_point', 'dew_point_last'),
    wind_mph: pick('wind_speed_last', 'wind_speed_avg_last_1_min', 'wind_speed', 'wind_speed_avg'),
    wind_dir_deg: pick('wind_dir_last', 'wind_dir_scalar_avg_last_1_min', 'wind_dir', 'wind_dir_of_prevail'),
    gust_mph: pick('wind_speed_hi_last_10_min', 'wind_gust_10_min', 'wind_speed_hi'),
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
