// Weather panel: current conditions, today's high/low, a few days of
// forecast, and any active NWS alerts. Sized by CSS to whatever height the
// sidebar leaves it; forecast rows that don't fit are dropped.
//
// Sources
//   Forecast + alerts: api.weather.gov (NWS, free, no key, CORS-enabled)
//   Current:           the signage-api Worker when WEATHER.STATION_API_URL is set
//                      (school WeatherLink station, else WCTV WeatherSTEM),
//                      otherwise the latest NWS observation from WEATHER.NWS_STATION.
(function () {
  'use strict';

  const cfg = window.CALENDAR_CONFIG || {};
  const W = cfg.WEATHER || {};
  const tz = cfg.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const NWS = 'https://api.weather.gov';

  const state = {
    root: null,
    points: null,       // { forecast, forecastHourly }
    forecast: null,     // { periods, at }
    hourly: null,       // { periods, at }
    alerts: [],         // [{ event, severity, ends }]
    current: null,      // normalized current conditions
    lastOk: 0
  };

  // ── Utilities ─────────────────────────────────────────────────────────────

  function store(k, v) { try { localStorage.setItem('signage.wx.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function recall(k) { try { return JSON.parse(localStorage.getItem('signage.wx.' + k)); } catch (e) { return null; } }

  async function getJSON(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers: { Accept: 'application/geo+json, application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  const fmtTime = d => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  const fmtDay = d => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
  const cToF = c => c == null ? null : c * 9 / 5 + 32;
  const round = v => v == null || isNaN(v) ? null : Math.round(v);
  // Weather is always real-time, even when the board is previewing another date.
  const now = () => new Date();

  function compass(deg) {
    if (deg == null || isNaN(deg)) return '';
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── Icons ─────────────────────────────────────────────────────────────────

  const SUN = '<circle cx="12" cy="12" r="4.2" fill="#FFD166" stroke="none"/><g stroke="#FFD166"><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g>';
  const MOON = '<path d="M15.5 3.5a8.5 8.5 0 1 0 5 13.8A7 7 0 0 1 15.5 3.5z" fill="#E2E8F0" stroke="none"/>';
  const CLOUD = '<path d="M7 19h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6-1.2A4.6 4.6 0 0 0 7 19z" fill="#E2E8F0" stroke="none"/>';
  const SMALL_CLOUD = '<path d="M9 20h9a3.4 3.4 0 0 0 .3-6.8 4.7 4.7 0 0 0-9-1A3.9 3.9 0 0 0 9 20z" fill="#E2E8F0" stroke="rgba(0,0,0,.25)" stroke-width=".6"/>';
  const RAIN = '<g stroke="#7DD3FC"><path d="M8.5 20.5l-1 2M12.5 20.5l-1 2M16.5 20.5l-1 2"/></g>';
  const RAIN_CLOUD = '<path d="M7 17h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6-1.2A4.6 4.6 0 0 0 7 17z" fill="#CBD5E1" stroke="none"/>';
  const BOLT = '<path d="M12.5 15l-2.5 4.5h2.5l-1.5 4 4.5-5.5h-2.5l1.5-3z" fill="#FFD166" stroke="none"/>';
  const SNOW = '<g fill="#F8FAFC" stroke="none"><circle cx="8.5" cy="21" r="1"/><circle cx="12.5" cy="22.2" r="1"/><circle cx="16.5" cy="21" r="1"/></g>';
  const FOG = '<g stroke="#CBD5E1"><path d="M4 9h16M3 13h18M5 17h14"/></g>';
  const WIND = '<g stroke="#E2E8F0"><path d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a3 3 0 1 1-3 3M3 17h7"/></g>';

  const ICONS = {
    'clear-day': SUN,
    'clear-night': MOON,
    'partly-day': '<g transform="translate(-3 -3) scale(.85)">' + SUN + '</g>' + SMALL_CLOUD,
    'partly-night': '<g transform="translate(-2 -3) scale(.8)">' + MOON + '</g>' + SMALL_CLOUD,
    cloudy: CLOUD,
    rain: RAIN_CLOUD + RAIN,
    thunder: RAIN_CLOUD + BOLT,
    snow: RAIN_CLOUD + SNOW,
    fog: FOG,
    wind: WIND
  };

  function iconKey(text, isDay) {
    const s = (text || '').toLowerCase();
    if (/thunder|t-storm|tstorm/.test(s)) return 'thunder';
    if (/snow|flurr|sleet|ice|freezing/.test(s)) return 'snow';
    if (/rain|shower|drizzle/.test(s)) return 'rain';
    if (/fog|haze|smoke|mist/.test(s)) return 'fog';
    if (/partly|mostly sunny|mostly clear|few clouds|scattered clouds/.test(s)) return isDay ? 'partly-day' : 'partly-night';
    if (/cloud|overcast/.test(s)) return 'cloudy';
    if (/wind|breez|blust/.test(s)) return 'wind';
    if (/sunny|clear|fair/.test(s)) return isDay ? 'clear-day' : 'clear-night';
    return isDay ? 'partly-day' : 'partly-night';
  }

  function icon(text, isDay, cls) {
    const wrap = el('div', 'wx-icon ' + (cls || ''));
    wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      ICONS[iconKey(text, isDay)] + '</svg>';
    return wrap;
  }

  function isDaytime(t) {
    // Good enough without an astronomy library: use the hourly forecast's
    // isDaytime flag when we have it, otherwise 7 AM – 7 PM.
    const h = state.hourly && state.hourly.periods.find(p => new Date(p.startTime) <= t && t < new Date(p.endTime));
    if (h) return h.isDaytime;
    const hour = +new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t);
    return hour >= 7 && hour < 19;
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async function loadPoints() {
    const k = W.LAT + ',' + W.LON;
    const cached = recall('points');
    if (cached && cached.k === k) { state.points = cached; return; }
    const j = await getJSON(`${NWS}/points/${W.LAT},${W.LON}`);
    state.points = { k, forecast: j.properties.forecast, forecastHourly: j.properties.forecastHourly };
    store('points', state.points);
  }

  async function loadForecast() {
    try {
      if (!state.points) await loadPoints();
      const [f, h] = await Promise.all([
        getJSON(state.points.forecast),
        getJSON(state.points.forecastHourly)
      ]);
      state.forecast = { periods: f.properties.periods, at: Date.now() };
      state.hourly = { periods: h.properties.periods.slice(0, 48), at: Date.now() };
      store('forecast', state.forecast);
      store('hourly', state.hourly);
      state.lastOk = Date.now();
    } catch (err) {
      console.error('Forecast load failed:', err);
      // A bad cached grid URL is the usual cause of a persistent failure.
      if (/HTTP 404/.test(String(err))) { state.points = null; store('points', null); }
    }
    render();
  }

  async function loadAlerts() {
    try {
      const j = await getJSON(`${NWS}/alerts/active?point=${W.LAT},${W.LON}`);
      state.alerts = (j.features || []).map(f => f.properties)
        .filter(p => p.status === 'Actual' && p.messageType !== 'Cancel')
        .map(p => ({ event: p.event, severity: p.severity, ends: p.ends || p.expires }))
        .filter((a, i, all) => all.findIndex(b => b.event === a.event) === i);
    } catch (err) {
      console.error('Alerts load failed:', err);
    }
    render();
  }

  async function loadStation() {
    if (!W.STATION_API_URL) return null;
    const j = await getJSON(W.STATION_API_URL);
    if (!j || !j.ok || j.temp_f == null) return null;
    if (Date.now() - j.ts * 1000 > 30 * 60000) return null; // station hasn't reported recently
    return {
      source: (W.SOURCE_LABELS || {})[j.source] || j.source || 'Station',
      at: new Date(j.ts * 1000),
      temp: j.temp_f,
      feels: j.feels_f,
      humidity: j.hum,
      wind: j.wind_mph,
      gust: j.gust_mph,
      windDir: j.wind_dir_deg,
      rainToday: j.rain_day_in,
      text: null
    };
  }

  async function loadNwsObservation() {
    const j = await getJSON(`${NWS}/stations/${W.NWS_STATION || 'KTLH'}/observations/latest`);
    const p = j.properties;
    const temp = cToF(p.temperature.value);
    if (temp == null) return null;
    const feelsC = p.heatIndex.value != null ? p.heatIndex.value : p.windChill.value;
    return {
      source: W.NWS_STATION_LABEL || W.NWS_STATION,
      at: new Date(p.timestamp),
      temp,
      feels: cToF(feelsC),
      humidity: p.relativeHumidity.value,
      wind: p.windSpeed.value == null ? null : p.windSpeed.value * 0.621371,
      gust: p.windGust.value == null ? null : p.windGust.value * 0.621371,
      windDir: p.windDirection.value,
      rainToday: null,
      text: p.textDescription || null
    };
  }

  async function loadCurrent() {
    let cur = null;
    try { cur = await loadStation(); } catch (err) { console.warn('Station weather unavailable:', err); }
    if (!cur) {
      try { cur = await loadNwsObservation(); } catch (err) { console.error('NWS observation failed:', err); }
    }
    if (cur) {
      state.current = cur;
      state.lastOk = Date.now();
      store('current', cur);
    }
    render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  // Pair NWS 12-hour periods into days: { name, high, low, text, pop, isDay }
  function forecastDays() {
    if (!state.forecast) return [];
    const periods = state.forecast.periods.filter(p => new Date(p.endTime) > now());
    const days = [];
    for (let i = 0; i < periods.length; i++) {
      const p = periods[i];
      if (p.isDaytime) {
        const night = periods[i + 1] && !periods[i + 1].isDaytime ? periods[i + 1] : null;
        days.push({
          name: days.length === 0 && i === 0 ? 'Today' : fmtDay(new Date(p.startTime)),
          high: p.temperature, low: night ? night.temperature : null,
          text: p.shortForecast, pop: p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value,
          isDay: true
        });
        if (night) i++;
      } else {
        days.push({
          name: i === 0 ? 'Tonight' : fmtDay(new Date(p.startTime)) + ' night',
          high: null, low: p.temperature,
          text: p.shortForecast, pop: p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value,
          isDay: false
        });
      }
    }
    return days;
  }

  function currentText(t) {
    if (state.current && state.current.text) return state.current.text;
    const h = state.hourly && state.hourly.periods.find(p => new Date(p.startTime) <= t && t < new Date(p.endTime));
    return h ? h.shortForecast : '';
  }

  function render() {
    const root = state.root;
    if (!root) return;
    const t = now();
    const cur = state.current && (Date.now() - new Date(state.current.at).getTime() < 3 * 3600000) ? state.current : null;
    const days = forecastDays();
    root.innerHTML = '';

    if (!cur && !days.length) {
      root.appendChild(el('p', 'wx-empty', 'Weather unavailable'));
      return;
    }

    for (const a of state.alerts.slice(0, 2)) {
      const bar = el('div', 'wx-alert sev-' + String(a.severity || '').toLowerCase());
      bar.appendChild(el('span', 'wx-alert-event', a.event));
      if (a.ends) bar.appendChild(el('span', 'wx-alert-until', 'until ' + fmtDay(new Date(a.ends)) + ' ' + fmtTime(new Date(a.ends))));
      root.appendChild(bar);
    }

    const isDay = isDaytime(t);
    const text = currentText(t);
    const nowBox = el('div', 'wx-now');
    nowBox.appendChild(icon(text, isDay, 'big'));
    const tempCol = el('div', 'wx-now-main');
    tempCol.appendChild(el('div', 'wx-temp', cur ? round(cur.temp) + '°' : '--'));
    if (text) tempCol.appendChild(el('div', 'wx-cond', text));
    nowBox.appendChild(tempCol);
    root.appendChild(nowBox);

    const facts = el('div', 'wx-facts');
    const today = days[0];
    const hiLo = [];
    if (today && today.high != null) hiLo.push('High ' + today.high + '°');
    if (today && today.low != null) hiLo.push((today.high == null ? 'Low tonight ' : 'Low ') + today.low + '°');
    if (hiLo.length) facts.appendChild(el('div', 'wx-hilo', hiLo.join('  ·  ')));
    if (cur && cur.feels != null && Math.abs(cur.feels - cur.temp) >= 3) {
      facts.appendChild(el('div', 'wx-feels', 'Feels like ' + round(cur.feels) + '°'));
    }
    root.appendChild(facts);

    if (cur) {
      const stats = el('div', 'wx-stats');
      const stat = (label, value) => {
        const s = el('div', 'wx-stat');
        s.appendChild(el('span', 'wx-stat-label', label));
        s.appendChild(el('span', 'wx-stat-value', value));
        stats.appendChild(s);
      };
      if (cur.wind != null) {
        const w = round(cur.wind);
        stat('Wind', w === 0 ? 'Calm' : `${compass(cur.windDir)} ${w} mph`);
      }
      if (cur.humidity != null) stat('Humidity', round(cur.humidity) + '%');
      if (cur.rainToday != null) stat('Rain today', cur.rainToday.toFixed(2) + '"');
      else if (today && today.pop != null) stat('Rain chance', today.pop + '%');
      root.appendChild(stats);
    }

    const list = el('div', 'wx-forecast');
    days.slice(1, 8).forEach(d => {
      const row = el('div', 'wx-day');
      row.appendChild(el('span', 'wx-day-name', d.name));
      row.appendChild(icon(d.text, d.isDay, 'small'));
      row.appendChild(el('span', 'wx-day-pop', d.pop ? d.pop + '%' : ''));
      const temps = el('span', 'wx-day-temps');
      temps.appendChild(el('span', 'hi', d.high != null ? d.high + '°' : ''));
      temps.appendChild(el('span', 'lo', d.low != null ? d.low + '°' : ''));
      row.appendChild(temps);
      list.appendChild(row);
    });
    root.appendChild(list);

    if (cur) root.appendChild(el('div', 'wx-foot', cur.source + ' · ' + fmtTime(new Date(cur.at))));

    // Drop forecast rows from the bottom until everything fits.
    while (list.lastChild && root.scrollHeight > root.clientHeight + 1) list.removeChild(list.lastChild);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function start(root) {
    state.root = root;
    state.points = recall('points');
    state.forecast = recall('forecast');
    state.hourly = recall('hourly');
    state.current = recall('current');
    render();

    loadForecast();
    loadAlerts();
    loadCurrent();
    setInterval(loadForecast, 30 * 60000);
    setInterval(loadAlerts, 5 * 60000);
    setInterval(loadCurrent, 5 * 60000);
    setInterval(render, 60000);
  }

  function info() {
    return {
      source: state.current && state.current.source,
      currentAt: state.current && state.current.at,
      forecastAt: state.forecast && state.forecast.at
    };
  }

  // Short status for the board's footer line; only speaks up when stale.
  function status() {
    if (!state.lastOk && !state.current && !state.forecast) return 'Weather offline';
    const at = state.current && new Date(state.current.at).getTime();
    if (!at || Date.now() - at > 2 * 3600000) return 'Weather data stale';
    return '';
  }

  window.SignageWeather = { start, info, status };
})();
