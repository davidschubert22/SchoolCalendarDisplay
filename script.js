(function () {
  const cfg = window.CALENDAR_CONFIG || {};
  const tz = cfg.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // A ?date=YYYY-MM-DD param in the URL previews that date without touching
  // config.js; falls back to DEV_DATE, then the real date.
  function urlDateOverride() {
    const raw = new URLSearchParams(window.location.search).get('date');
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d) ? null : d;
  }

  const dateOverride = urlDateOverride() || (cfg.DEV_DATE ? new Date(cfg.DEV_DATE) : null);

  // Returns the current date, or a fixed override when previewing.
  // Clock always uses real time regardless.
  function now() {
    return dateOverride || new Date();
  }

  const elTitle    = document.getElementById('board-title');
  const elDateRange = document.getElementById('date-range');
  const elClock    = document.getElementById('clock');
  const elNow      = document.getElementById('now');
  const elNowWrap  = document.getElementById('now-wrap');
  const daysWrap   = document.getElementById('days');
  const nextDaysWrap = document.getElementById('next-days');
  const elScrollViewport = document.getElementById('scroll-viewport');
  const elScrollTrack    = document.getElementById('scroll-track');

  // TEMPORARY: on-screen diagnostics for the Fire Stick/Fully Kiosk
  // "video background is absent" issue. Remove this block (and the
  // #video-debug div/CSS) once that's resolved. Catches uncaught JS
  // errors too, since there's no remote dev-tools access to this device.
  const elDebug = document.getElementById('video-debug');
  const debugState = { video: '', canvas: '', jsErrors: [] };
  function renderDebug() {
    if (!elDebug) return;
    const lines = [debugState.video, debugState.canvas];
    if (debugState.jsErrors.length) lines.push('errors:\n' + debugState.jsErrors.join('\n'));
    elDebug.textContent = lines.filter(Boolean).join('\n');
  }
  function logDebugError(msg) {
    debugState.jsErrors.push(msg);
    if (debugState.jsErrors.length > 5) debugState.jsErrors.shift();
    renderDebug();
  }
  window.addEventListener('error', e => {
    logDebugError(`JS: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    logDebugError(`Promise: ${r && r.message ? r.message : r}`);
  });

  // ── Viewport scaling ──────────────────────────────────────────────────────
  // Scales the fixed 1920×1080 canvas to fill any screen, centered (letterbox
  // or pillarbox for non-16:9 screens). Works both up (4K) and down (<1080p).

  function applyScaling() {
    const W = 1920, H = 1080;
    const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    const offsetX = (window.innerWidth - W * scale) / 2;
    const wrapper = document.getElementById('ui-scale-wrapper');
    wrapper.style.transform = `translate(${offsetX}px, 0px) scale(${scale})`;
  }

  // ── Theme (background video) ────────────────────────────────────────────────

  // Paints the <video>'s current frame onto a same-sized <canvas> every
  // frame, emulating object-fit: cover. See the comment above
  // #background-video in styles.css for why this exists.
  function startVideoCanvasLoop(elVideo, elCanvas) {
    const ctx = elCanvas.getContext('2d');

    function resize() {
      elCanvas.width = window.innerWidth;
      elCanvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // TEMPORARY: surfaces whether real frame pixels are actually landing in
    // the canvas (vs. blank/black), and whether drawImage(video) itself
    // throws on this device. See the diagnostics block above.
    function sampleCanvas() {
      try {
        const cw = elCanvas.width, ch = elCanvas.height;
        if (!cw || !ch) {
          debugState.canvas = `canvas: zero size (${cw}x${ch})`;
        } else {
          const d = ctx.getImageData((cw / 2) | 0, (ch / 2) | 0, 1, 1).data;
          debugState.canvas = `canvas: ${cw}x${ch}  center px rgba(${d[0]},${d[1]},${d[2]},${d[3]})`;
        }
      } catch (e) {
        debugState.canvas = `canvas: getImageData threw ${e.name}: ${e.message}`;
      }
      renderDebug();
    }

    function draw() {
      const vw = elVideo.videoWidth, vh = elVideo.videoHeight;
      if (elVideo.readyState >= elVideo.HAVE_CURRENT_DATA && vw && vh) {
        try {
          const cw = elCanvas.width, ch = elCanvas.height;
          const scale = Math.max(cw / vw, ch / vh);
          const dw = vw * scale, dh = vh * scale;
          ctx.drawImage(elVideo, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
        } catch (e) {
          debugState.canvas = `canvas: drawImage threw ${e.name}: ${e.message}`;
          renderDebug();
        }
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    setInterval(sampleCanvas, 1000);
  }

  function applyTheme() {
    const month = now().getMonth() + 1;
    const themes = cfg.THEMES || {};
    let chosen = null;
    for (const t of Object.values(themes)) {
      if (t.months && t.months.includes(month)) { chosen = t; break; }
    }

    const elVideo = document.getElementById('background-video');
    const elCanvas = document.getElementById('background-canvas');

    startVideoCanvasLoop(elVideo, elCanvas);

    const READY = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
    const NETWORK = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];
    const MEDIA_ERR = ['', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED'];
    let playRejection = '';
    function logVideoDebug() {
      const err = elVideo.error;
      debugState.video = [
        `src: ${elVideo.currentSrc || '(none)'}`,
        `readyState: ${READY[elVideo.readyState] ?? elVideo.readyState}`,
        `networkState: ${NETWORK[elVideo.networkState] ?? elVideo.networkState}`,
        `videoWidth x videoHeight: ${elVideo.videoWidth}x${elVideo.videoHeight}`,
        `paused: ${elVideo.paused}  muted: ${elVideo.muted}`,
        `error: ${err ? `${MEDIA_ERR[err.code] || err.code} - ${err.message || ''}` : 'none'}`,
        `canPlayType h264: ${elVideo.canPlayType('video/mp4; codecs="avc1.640028"') || '(empty = no)'}`,
        playRejection ? `play() rejected: ${playRejection}` : null,
      ].filter(Boolean).join(' | ');
      renderDebug();
    }

    if (chosen?.bg) {
      elVideo.src = chosen.bg + '?v=' + Date.now();
      elVideo.load();
      const playPromise = elVideo.play();
      if (playPromise?.catch) {
        playPromise.catch(e => {
          playRejection = `${e.name}: ${e.message}`;
          logVideoDebug();
        });
      }
    }
    ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'stalled', 'suspend', 'abort', 'emptied', 'error']
      .forEach(evt => elVideo.addEventListener(evt, logVideoDebug));
    setInterval(logVideoDebug, 1000);
    logVideoDebug();
  }

  // ── Clock ─────────────────────────────────────────────────────────────────

  function tickClock() {
    elClock.textContent = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, hour: 'numeric', minute: '2-digit'
    }).format(new Date());
  }

  // ── Date helpers ──────────────────────────────────────────────────────────

  function startOfWeek(d) {
    const diff = (d.getDay() - (cfg.WEEK_START_DAY || 0) + 7) % 7;
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() - diff);
    return s;
  }

  function endOfWeek(d) {
    const e = new Date(startOfWeek(d));
    e.setDate(e.getDate() + 6);
    e.setHours(23, 59, 59, 999);
    return e;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function fmtTime(dt) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz, hour: 'numeric', minute: '2-digit'
    }).format(dt);
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth()    === b.getMonth()
        && a.getDate()     === b.getDate();
  }

  // ── ICS parsing ───────────────────────────────────────────────────────────

  function parseICS(text) {
    const unfolded = text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n[ \t]/g, '');

    const events = [];
    let cur = null;

    for (const raw of unfolded.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      if (line === 'BEGIN:VEVENT') {
        cur = {};
      } else if (line === 'END:VEVENT') {
        if (cur) { events.push(cur); cur = null; }
      } else if (cur) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const key = line.slice(0, idx);
        const val = line.slice(idx + 1);

        if (key.startsWith('DTSTART')) {
          cur.dtstart  = parseICSTime(val);
          cur.isAllDay = /^\d{8}$/.test(val);
        } else if (key.startsWith('DTEND')) {
          cur.dtend    = parseICSTime(val);
          cur.isAllDay = cur.isAllDay || /^\d{8}$/.test(val);
        } else if (key === 'SUMMARY')     { cur.summary     = decode(val); }
          else if (key === 'LOCATION')    { cur.location    = decode(val); }
          else if (key === 'DESCRIPTION') { cur.description = decode(val); }
          else if (key === 'UID')         { cur.uid         = val; }
          else if (key === 'RRULE')       { cur.rrule       = val; }
      }
    }
    return events.filter(e => e.dtstart);
  }

  function decode(v) {
    return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
  }

  function parseICSTime(v) {
    if (/^\d{8}$/.test(v)) {
      return new Date(+v.slice(0,4), +v.slice(4,6)-1, +v.slice(6,8));
    }
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
    if (m) {
      const [,y,mo,d,hh,mm,ss,z] = m;
      return z === 'Z'
        ? new Date(Date.UTC(+y,+mo-1,+d,+hh,+mm,+ss))
        : new Date(+y,+mo-1,+d,+hh,+mm,+ss);
    }
    const dt = new Date(v);
    return isNaN(dt) ? null : dt;
  }

  // ── Event filtering / grouping ────────────────────────────────────────────

  function filterRange(events, s, e) {
    return events
      .filter(ev => ev.dtstart && ev.dtstart >= s && ev.dtstart <= e)
      .sort((a, b) => a.dtstart - b.dtstart);
  }

  function happeningNow(events, now) {
    return events.filter(ev => {
      const end = ev.dtend || (ev.isAllDay ? addDays(ev.dtstart, 1) : ev.dtstart);
      return ev.dtstart <= now && now < end;
    });
  }

  function eventsByDay(list, rangeStart) {
    const map = Array.from({ length: 7 }, (_, i) => ({
      date: addDays(rangeStart, i),
      events: []
    }));
    list.forEach(ev => {
      for (let i = 0; i < 7; i++) {
        if (sameDay(ev.dtstart, map[i].date)) { map[i].events.push(ev); break; }
      }
    });
    return map;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function formatEventRange(ev) {
    let s = fmtTime(ev.dtstart);
    if (ev.dtend) {
      s += sameDay(ev.dtstart, ev.dtend)
        ? '–' + fmtTime(ev.dtend)
        : ' → ' + new Intl.DateTimeFormat(undefined, {
            timeZone: tz, month: 'short', day: 'numeric'
          }).format(ev.dtend) + ' ' + fmtTime(ev.dtend);
    }
    return s;
  }

  function renderDayCard(dayObj, today) {
    if (!dayObj.events.length) return null;

    const dayEl = document.createElement('section');
    dayEl.className = 'day-card' + (sameDay(dayObj.date, today) ? ' today' : '');

    const head = document.createElement('div');
    head.className = 'day-header';

    const h = document.createElement('h3');
    h.className = 'day-name';
    h.textContent = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: 'long'
    }).format(dayObj.date);

    const sub = document.createElement('p');
    sub.className = 'day-date';
    sub.textContent = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, month: 'long', day: 'numeric'
    }).format(dayObj.date);

    head.appendChild(h);
    head.appendChild(sub);
    dayEl.appendChild(head);

    dayObj.events.forEach(ev => {
      const art = document.createElement('article');
      art.className = 'event';

      const hdr = document.createElement('div');
      hdr.className = 'event-header';

      const dot = document.createElement('span');
      dot.className = 'dot';

      const t = document.createElement('h4');
      t.className = 'event-title';
      t.textContent = ev.summary || 'Untitled event';

      hdr.appendChild(dot);
      hdr.appendChild(t);
      art.appendChild(hdr);

      if (!ev.isAllDay) {
        const time = document.createElement('p');
        time.className = 'event-time';
        time.textContent = formatEventRange(ev);
        art.appendChild(time);
      }

      if (ev.location) {
        const loc = document.createElement('p');
        loc.className = 'event-loc';
        loc.textContent = ev.location;
        art.appendChild(loc);
      }

      if (cfg.SHOW_DESCRIPTION && ev.description) {
        const desc = document.createElement('p');
        desc.className = 'event-desc';
        desc.textContent = ev.description;
        art.appendChild(desc);
      }

      dayEl.appendChild(art);
    });

    return dayEl;
  }

  function renderEmptyWeek(container) {
    const p = document.createElement('p');
    p.className = 'empty-week';
    p.textContent = 'No events have been added to the calendar yet.';
    container.appendChild(p);
  }

  function renderNow(list) {
    elNowWrap.innerHTML = '';
    if (!list.length) { elNow.classList.add('hidden'); return; }

    list.forEach(ev => {
      const card = document.createElement('div');
      card.className = 'now-card';

      const title = document.createElement('h3');
      title.className = 'now-title';
      title.textContent = ev.summary || 'Untitled event';
      card.appendChild(title);

      if (!ev.isAllDay) {
        const when = document.createElement('p');
        when.className = 'now-time';
        when.textContent = formatEventRange(ev);
        card.appendChild(when);
      }

      elNowWrap.appendChild(card);
    });

    elNow.classList.remove('hidden');
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async function fetchICS(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }

  async function load() {
    const text   = await fetchICS(cfg.ICS_URL);
    const events = parseICS(text);
    const current = now();
    const s      = startOfWeek(current);
    const e      = endOfWeek(current);

    elDateRange.textContent = new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    }).format(current);

    // "Happening now" searches all events, not just this week, so multi-day
    // events that started earlier in the week are correctly included.
    renderNow(happeningNow(events, current));

    // This week
    daysWrap.innerHTML = '';
    eventsByDay(filterRange(events, s, e), s).forEach(day => {
      const el = renderDayCard(day, current);
      if (el) daysWrap.appendChild(el);
    });
    if (!daysWrap.children.length) renderEmptyWeek(daysWrap);

    // Next week
    if (cfg.SHOW_NEXT_WEEK) {
      const ns = addDays(s, 7);
      const ne = addDays(e, 7);
      const nextSection = document.getElementById('next-week');
      nextDaysWrap.innerHTML = '';
      eventsByDay(filterRange(events, ns, ne), ns).forEach(day => {
        const el = renderDayCard(day, current);
        if (el) nextDaysWrap.appendChild(el);
      });
      if (!nextDaysWrap.children.length) renderEmptyWeek(nextDaysWrap);
      nextSection.classList.remove('hidden');
    }
  }

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  // Cycles the content below the header: pause at top, slowly scroll to
  // reveal the bottom, pause, scroll back, repeat. Distance is whatever
  // overflows the visible viewport, so a light week doesn't move at all.

  let scrollTimer = null;

  function setupAutoScroll() {
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
    if (!elScrollViewport || !elScrollTrack) return;

    // Snap back to the top instantly before measuring, so a mid-cycle
    // refresh doesn't measure against a partially-scrolled position.
    elScrollTrack.style.transition = 'none';
    elScrollTrack.style.transform = 'translateY(0)';
    void elScrollTrack.offsetHeight; // force layout before reading scrollHeight

    const overflow = Math.max(0, elScrollTrack.scrollHeight - elScrollViewport.clientHeight);
    if (overflow <= 0) return; // everything fits; stay put

    const pause = cfg.SCROLL_PAUSE_MS || 10000;
    const speed = cfg.SCROLL_SPEED_PX_PER_SEC || 30;
    const duration = (overflow / speed) * 1000;

    elScrollTrack.style.transition = `transform ${duration}ms linear`;

    function pauseAtTop() {
      elScrollTrack.style.transform = 'translateY(0)';
      scrollTimer = setTimeout(scrollToBottom, pause);
    }
    function scrollToBottom() {
      elScrollTrack.style.transform = `translateY(-${overflow}px)`;
      scrollTimer = setTimeout(pauseAtBottom, duration);
    }
    function pauseAtBottom() {
      scrollTimer = setTimeout(scrollToTop, pause);
    }
    function scrollToTop() {
      elScrollTrack.style.transform = 'translateY(0)';
      scrollTimer = setTimeout(pauseAtTop, duration);
    }

    scrollTimer = setTimeout(scrollToBottom, pause);
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function init() {
    applyScaling();
    window.addEventListener('resize', applyScaling);

    applyTheme();

    elTitle.textContent = cfg.TITLE || "This Week's Events";

    document.querySelector('.theme-box')
      ?.classList.toggle('light-bg', cfg.THEME_BOX_BG === 'light');

    const w = document.querySelector('iframe.weather');
    if (cfg.WEATHER_IFRAME_SRC) w.src = cfg.WEATHER_IFRAME_SRC;

    tickClock();
    setInterval(tickClock, 1000);

    load().then(setupAutoScroll).catch(err => console.error('Calendar load failed:', err));

    const mins = cfg.REFRESH_MINUTES || 15;
    if (mins > 0) {
      setInterval(() => {
        load().then(setupAutoScroll).catch(err => console.error('Calendar refresh failed:', err));
      }, mins * 60 * 1000);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
