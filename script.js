(function () {
  const cfg = window.CALENDAR_CONFIG || {};
  const tz = cfg.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Returns the current date, or a fixed override when DEV_DATE is set.
  // Clock always uses real time regardless.
  function now() {
    return cfg.DEV_DATE ? new Date(cfg.DEV_DATE) : new Date();
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

  function applyTheme() {
    const month = now().getMonth() + 1;
    const themes = cfg.THEMES || {};
    let chosen = null;
    for (const t of Object.values(themes)) {
      if (t.months && t.months.includes(month)) { chosen = t; break; }
    }

    const elVideo = document.getElementById('background-video');
    if (chosen?.bg) {
      elVideo.src = chosen.bg;
      elVideo.load();
    }
    elVideo.addEventListener('error', () => {
      elVideo.style.display = 'none';
    }, { once: true });
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

    // Next week
    if (cfg.SHOW_NEXT_WEEK) {
      const ns = addDays(s, 7);
      const ne = addDays(e, 7);
      const nextSection = document.getElementById('next-week');
      nextDaysWrap.innerHTML = '';
      let any = false;
      eventsByDay(filterRange(events, ns, ne), ns).forEach(day => {
        const el = renderDayCard(day, current);
        if (el) { nextDaysWrap.appendChild(el); any = true; }
      });
      nextSection.classList.toggle('hidden', !any);
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
