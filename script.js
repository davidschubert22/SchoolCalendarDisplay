(function () {
  'use strict';

  const cfg = window.CALENDAR_CONFIG || {};
  const ICS = window.SignageICS;
  const tz = cfg.TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const params = new URLSearchParams(window.location.search);
  const SCREEN_ID = params.get('screen') || '';
  const SCHOOL_DAYS = cfg.SCHOOL_DAYS || [1, 2, 3, 4, 5];

  const $ = id => document.getElementById(id);
  const elViewport = $('scroll-viewport');

  // ── Clock / preview override ──────────────────────────────────────────────
  // ?date=YYYY-MM-DD[THH:MM] (or DEV_DATE) shifts the whole board to that
  // moment and keeps ticking from there. A bare date means 9:00 AM.

  const timeShift = (function () {
    const raw = params.get('date') || cfg.DEV_DATE;
    if (!raw) return 0;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(String(raw).trim());
    if (!m) return 0;
    const target = ICS.zonedToDate(+m[1], +m[2], +m[3], m[4] ? +m[4] : 9, m[5] ? +m[5] : 0, 0, tz);
    return target.getTime() - Date.now();
  })();

  function now() { return new Date(Date.now() + timeShift); }

  // ── Formatting ────────────────────────────────────────────────────────────

  const fmtCache = {};
  function fmt(opts, date, zone) {
    const k = JSON.stringify(opts) + (zone || tz);
    const f = fmtCache[k] || (fmtCache[k] = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: zone || tz }, opts)));
    return f.format(date);
  }
  const fmtTime = d => fmt({ hour: 'numeric', minute: '2-digit' }, d);
  const fmtKey = (k, opts) => fmt(opts, ICS.keyToLabelDate(k), 'UTC');

  function fmtKeyRange(a, b) {
    const [ay, am] = ICS.keyParts(a), [by, bm] = ICS.keyParts(b);
    if (a === b) return fmtKey(a, { month: 'short', day: 'numeric' });
    if (ay === by && am === bm) return fmtKey(a, { month: 'short', day: 'numeric' }) + ' – ' + fmtKey(b, { day: 'numeric' });
    return fmtKey(a, { month: 'short', day: 'numeric' }) + ' – ' + fmtKey(b, { month: 'short', day: 'numeric' });
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── Storage (best-effort; the board works without it) ─────────────────────

  function store(k, v) { try { localStorage.setItem('signage.' + k, v); } catch (e) { /* ignore */ } }
  function recall(k) { try { return localStorage.getItem('signage.' + k); } catch (e) { return null; } }

  async function fetchText(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  // ── Viewport scaling ──────────────────────────────────────────────────────
  // The UI is laid out on a fixed 1920×1080 canvas and scaled to fit, centered.

  function applyScaling() {
    const W = 1920, H = 1080;
    const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    const x = (window.innerWidth - W * scale) / 2;
    const y = (window.innerHeight - H * scale) / 2;
    $('ui-scale-wrapper').style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  // ── Background video / theme graphic ──────────────────────────────────────

  let themeMonth = null;
  function applyTheme() {
    const month = +ICS.dayKey(now(), tz).slice(5, 7);
    if (month === themeMonth) return;
    themeMonth = month;
    const chosen = Object.values(cfg.THEMES || {}).find(t => t.months && t.months.includes(month));
    const video = $('background-video');
    if (chosen && chosen.poster) {
      video.poster = chosen.poster;
      // Also paint it behind the video, so a stalled or failed video still shows the scene.
      video.style.backgroundImage = `url("${chosen.poster}")`;
    }
    if (chosen && chosen.bg) {
      video.src = chosen.bg;
      video.load();
      video.play().catch(() => { /* retried by the watchdog */ });
    }
  }

  // Browsers sometimes pause background video (power saving, a decode hiccup,
  // a network blip). On a sign nobody is there to press play, so keep nudging.
  function videoWatchdog() {
    const video = $('background-video');
    const resume = () => { if (video.paused && video.src) video.play().catch(() => {}); };
    video.addEventListener('pause', () => setTimeout(resume, 2000));
    video.addEventListener('error', () => setTimeout(() => { video.load(); resume(); }, 60000));
    setInterval(resume, 30000);
  }

  function setupThemeGraphic() {
    const box = $('theme-box'), img = $('theme-image');
    box.classList.toggle('light-bg', cfg.THEME_BOX_BG === 'light');
    if (!cfg.THEME_GRAPHIC) { box.classList.add('hidden'); return; }
    img.addEventListener('error', () => box.classList.add('hidden'));
    img.src = cfg.THEME_GRAPHIC;
  }

  // ── Calendar data ─────────────────────────────────────────────────────────

  const cal = {
    text: null,          // last good ICS text
    fetchedAt: 0,        // when that text was fetched (ms)
    parsedFor: null,     // day key the parse was done on (recurrences expand relative to it)
    events: [],
    lastError: null,
    retryMs: 15000
  };

  function ingest(text, fetchedAt) {
    cal.text = text;
    cal.fetchedAt = fetchedAt;
    cal.parsedFor = null;
  }

  function ensureParsed(todayKey) {
    if (!cal.text || cal.parsedFor === todayKey) return;
    cal.events = ICS.parse(cal.text, { tz, windowEndKey: ICS.addDays(todayKey, 400) });
    cal.parsedFor = todayKey;
  }

  let calTimer = null;
  async function loadCalendar() {
    clearTimeout(calTimer);
    try {
      const text = await fetchText(cfg.ICS_URL, 20000);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('Response is not an ICS calendar');
      ingest(text, Date.now());
      store('ics', text);
      store('icsAt', String(cal.fetchedAt));
      cal.lastError = null;
      cal.retryMs = 15000;
      calTimer = setTimeout(loadCalendar, (cfg.REFRESH_MINUTES || 15) * 60000);
    } catch (err) {
      console.error('Calendar load failed:', err);
      cal.lastError = String(err.message || err);
      // Retry quickly at first (the network is often not up yet at boot),
      // backing off to the normal refresh interval.
      calTimer = setTimeout(loadCalendar, cal.retryMs);
      cal.retryMs = Math.min(cal.retryMs * 2, (cfg.REFRESH_MINUTES || 15) * 60000);
    }
    render();
  }

  // ── Board model ───────────────────────────────────────────────────────────

  const isSchoolDay = k => SCHOOL_DAYS.includes(ICS.weekday(k));
  const covers = (e, k) => e.startKey <= k && e.endKey >= k;

  function weekStart(k) {
    const diff = (ICS.weekday(k) - (cfg.WEEK_START_DAY || 0) + 7) % 7;
    return ICS.addDays(k, -diff);
  }

  // Today, or the next school day when today isn't one (weekends look ahead).
  function anchorDay(todayKey) {
    let k = todayKey;
    for (let i = 0; i < 7 && !isSchoolDay(k); i++) k = ICS.addDays(k, 1);
    return k;
  }

  function eventSort(a, b) {
    return (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title);
  }

  function buildWeek(startKey, t, todayKey) {
    const days = Array.from({ length: 7 }, (_, i) => ICS.addDays(startKey, i));
    const endKey = days[6];
    const evs = cal.events.filter(e => e.startKey <= endKey && e.endKey >= startKey);
    const multi = evs.filter(e => e.endKey > e.startKey);
    const single = evs.filter(e => e.endKey === e.startKey);

    // School days always get a column; other days only when something happens
    // on them that isn't already visible on a school-day column.
    const visible = new Set(days.filter(isSchoolDay));
    for (const e of single) visible.add(e.startKey);
    for (const e of multi) {
      if (!days.some(k => visible.has(k) && covers(e, k))) days.filter(k => covers(e, k)).forEach(k => visible.add(k));
    }
    const cols = days.filter(k => visible.has(k));

    // Multi-day events become bars across columns, packed into lanes.
    const lanes = [];
    const spans = [];
    for (const e of multi.sort(eventSort)) {
      const idx = cols.map((k, i) => covers(e, k) ? i : -1).filter(i => i >= 0);
      if (!idx.length) continue;
      const a = idx[0], b = idx[idx.length - 1];
      let lane = lanes.findIndex(used => used.every(([x, y]) => b < x || a > y));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      lanes[lane].push([a, b]);
      spans.push({
        ev: e, a, b, lane,
        before: e.startKey < cols[a],
        after: e.endKey > cols[b],
        past: e.end <= t
      });
    }

    const columns = cols.map(k => ({
      key: k,
      isToday: k === todayKey,
      isPast: k < todayKey,
      events: single.filter(e => e.startKey === k).sort(eventSort)
        .map(e => ({ ev: e, past: !e.allDay && (e.end > e.start ? e.end : e.start) <= t }))
    }));

    return { startKey, endKey, cols: columns, spans, laneCount: lanes.length, empty: evs.length === 0 };
  }

  // Timed events in progress. All-day events are already highlighted in
  // today's column, so they're left out unless NOW_INCLUDE_ALL_DAY is set.
  function happeningNow(t) {
    return cal.events.filter(e => {
      if (e.allDay && !cfg.NOW_INCLUDE_ALL_DAY) return false;
      const end = e.end > e.start ? e.end : e.start;
      return e.start <= t && t < end;
    }).sort(eventSort);
  }

  function countdown(todayKey) {
    const max = cfg.COUNTDOWN_MAX_DAYS ?? 30;
    if (!max || !cfg.COUNTDOWN_MATCH) return null;
    const target = new RegExp(cfg.COUNTDOWN_MATCH, 'i');
    const noSchoolRe = new RegExp(cfg.NO_SCHOOL_MATCH || 'no school|break', 'i');
    const next = cal.events
      .filter(e => target.test(e.title) && e.startKey > todayKey && ICS.diffDays(todayKey, e.startKey) <= max)
      .sort((a, b) => a.start - b.start)[0];
    if (!next) return null;

    const offDays = cal.events.filter(e => noSchoolRe.test(e.title));
    // School days left before it, counting today if it's a school day.
    let n = 0;
    for (let k = todayKey; k < next.startKey; k = ICS.addDays(k, 1)) {
      if (isSchoolDay(k) && !offDays.some(e => covers(e, k))) n++;
    }
    const label = next.title.replace(/\s*[-–—:]\s*no school\s*$/i, '').trim() || next.title;
    const daysAway = ICS.diffDays(todayKey, next.startKey);
    return { n, label, noSchool: noSchoolRe.test(next.title) && label !== next.title, daysAway, key: next.startKey };
  }

  function sectionTitles(weeks, todayKey) {
    const first = weeks[0].startKey <= todayKey && todayKey <= weeks[0].endKey;
    return first ? ['This Week', 'Next Week'] : ['Coming Up', 'The Week After'];
  }

  function buildModel() {
    const t = now();
    const todayKey = ICS.dayKey(t, tz);
    ensureParsed(todayKey);

    const w1 = weekStart(anchorDay(todayKey));
    const weeks = [buildWeek(w1, t, todayKey)];
    if (cfg.SHOW_NEXT_WEEK) weeks.push(buildWeek(ICS.addDays(w1, 7), t, todayKey));

    let nextUp = null;
    if (weeks.every(w => w.empty)) {
      const after = weeks[weeks.length - 1].endKey;
      const e = cal.events.find(ev => ev.startKey > after);
      if (e) nextUp = e;
    }

    return {
      todayKey,
      hasData: !!cal.text,
      now: happeningNow(t),
      weeks,
      titles: sectionTitles(weeks, todayKey),
      countdown: countdown(todayKey),
      nextUp
    };
  }

  // Signature of what's on screen, so the per-minute tick only rebuilds (and
  // restarts paging/scrolling) when something visible actually changed.
  function signature(m) {
    return JSON.stringify(m, (k, v) => {
      if (k === 'ev') return v.uid + v.title + v.start.getTime() + v.end.getTime() + v.location;
      return v;
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function timeRange(e) {
    if (e.allDay) return '';
    if (e.end <= e.start) return fmtTime(e.start);
    if (e.startKey === e.endKey) return fmtTime(e.start) + ' – ' + fmtTime(e.end);
    return fmtKey(e.startKey, { weekday: 'short' }) + ' ' + fmtTime(e.start) + ' – ' +
           fmtKey(e.endKey, { weekday: 'short' }) + ' ' + fmtTime(e.end);
  }

  function renderEvent(item) {
    const e = item.ev;
    const art = el('article', 'event' + (item.past ? ' past' : '') + (e.allDay ? ' all-day' : ''));
    art.appendChild(el('h4', 'event-title', e.title));
    const when = e.allDay ? 'All day' : timeRange(e);
    art.appendChild(el('p', 'event-time', when));
    if (e.location) art.appendChild(el('p', 'event-loc', e.location));
    if (cfg.SHOW_DESCRIPTION && e.description) art.appendChild(el('p', 'event-desc', e.description));
    return art;
  }

  function renderSpan(s, week) {
    const e = s.ev;
    const bar = el('div', 'span-bar' + (s.past ? ' past' : '') + (s.before ? ' cont-before' : '') + (s.after ? ' cont-after' : ''));
    bar.style.gridColumn = (s.a + 1) + ' / ' + (s.b + 2);
    bar.style.gridRow = String(2 + s.lane);
    bar.appendChild(el('span', 'span-title', e.title));
    let sub = '';
    if (!e.allDay) sub = timeRange(e);
    else if (s.before || s.after) sub = fmtKeyRange(e.startKey, e.endKey);
    if (sub) bar.appendChild(el('span', 'span-sub', sub));
    return bar;
  }

  function renderWeek(week, title) {
    const sec = el('section', 'week');
    const head = el('div', 'section-title-box');
    head.appendChild(el('h2', 'section-title', title));
    const lastCol = week.cols[week.cols.length - 1].key;
    head.appendChild(el('span', 'section-range', fmtKeyRange(week.cols[0].key, lastCol)));
    sec.appendChild(head);

    const grid = el('div', 'week-grid');
    const n = week.cols.length;
    grid.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = 'auto ' + 'auto '.repeat(week.laneCount) + '1fr';
    const lastRow = week.laneCount + 3;

    week.cols.forEach((c, i) => {
      const col = String(i + 1);
      const state = (c.isToday ? ' today' : '') + (c.isPast ? ' past' : '');

      const bg = el('div', 'day-bg' + state);
      bg.style.gridColumn = col;
      bg.style.gridRow = '1 / ' + lastRow;
      grid.appendChild(bg);

      const dh = el('div', 'day-header' + state);
      dh.style.gridColumn = col;
      dh.style.gridRow = '1';
      dh.appendChild(el('h3', 'day-name', c.isToday ? 'Today' : fmtKey(c.key, { weekday: 'long' })));
      dh.appendChild(el('p', 'day-date', fmtKey(c.key, { weekday: c.isToday ? 'long' : undefined, month: 'long', day: 'numeric' })));
      grid.appendChild(dh);

      const list = el('div', 'day-events' + state);
      list.style.gridColumn = col;
      list.style.gridRow = String(week.laneCount + 2);
      c.events.forEach(item => list.appendChild(renderEvent(item)));
      grid.appendChild(list);
    });

    week.spans.forEach(s => grid.appendChild(renderSpan(s, week)));
    sec.appendChild(grid);

    if (week.empty) {
      const note = el('p', 'empty-week', 'No events scheduled');
      sec.appendChild(note);
    }
    return sec;
  }

  function renderNow(list) {
    if (!list.length) return null;
    const sec = el('section', 'now');
    const head = el('div', 'section-title-box');
    head.appendChild(el('h2', 'section-title', 'Happening Now'));
    sec.appendChild(head);
    const wrap = el('div', 'now-wrap');
    list.forEach(e => {
      const card = el('div', 'now-card');
      card.appendChild(el('h3', 'now-title', e.title));
      let when;
      if (e.allDay) when = e.endKey > e.startKey ? 'Through ' + fmtKey(e.endKey, { weekday: 'long', month: 'short', day: 'numeric' }) : 'All day';
      else when = e.startKey === e.endKey ? 'Until ' + fmtTime(e.end) : timeRange(e);
      card.appendChild(el('p', 'now-time', when));
      if (e.location) card.appendChild(el('p', 'now-loc', e.location));
      wrap.appendChild(card);
    });
    sec.appendChild(wrap);
    return sec;
  }

  function renderNextUp(e) {
    const sec = el('section', 'next-up');
    sec.appendChild(el('p', 'next-up-label', 'Next on the calendar'));
    sec.appendChild(el('p', 'next-up-title', e.title));
    sec.appendChild(el('p', 'next-up-date', fmtKey(e.startKey, { weekday: 'long', month: 'long', day: 'numeric' }) +
      (e.allDay ? '' : ' · ' + fmtTime(e.start))));
    return sec;
  }

  function renderCountdown(c) {
    const box = $('countdown');
    box.innerHTML = '';
    if (!c) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (c.n > 0) {
      box.appendChild(el('div', 'countdown-num', String(c.n)));
      const txt = el('div', 'countdown-text');
      txt.appendChild(el('div', 'countdown-lead', c.n === 1 ? 'school day until' : 'school days until'));
      txt.appendChild(el('div', 'countdown-label', c.label));
      box.appendChild(txt);
    } else {
      const txt = el('div', 'countdown-text');
      txt.appendChild(el('div', 'countdown-lead', c.daysAway === 1 ? 'Tomorrow' : fmtKey(c.key, { weekday: 'long' })));
      txt.appendChild(el('div', 'countdown-label', c.label));
      box.appendChild(txt);
    }
  }

  let lastSig = null;
  function render(force) {
    const m = buildModel();

    $('date-range').textContent = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, now());
    renderStatus();

    const sig = signature(m);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    renderCountdown(m.countdown);

    const sections = [];
    const nowSec = renderNow(m.now);
    if (!m.hasData) {
      const p = el('p', 'empty-week loading', cal.lastError ? 'Waiting for the calendar…' : 'Loading calendar…');
      sections.push([p]);
    } else {
      const first = [nowSec, renderWeek(m.weeks[0], m.titles[0])].filter(Boolean);
      sections.push(first);
      if (m.weeks[1]) sections.push([renderWeek(m.weeks[1], m.titles[1])]);
      if (m.nextUp) sections[sections.length - 1].push(renderNextUp(m.nextUp));
    }
    layoutPages(sections);
  }

  // ── Paging / auto-scroll ──────────────────────────────────────────────────
  // All sections share one page when they fit. Otherwise each group becomes
  // its own page and the board cross-fades between them; a page that is
  // still too tall scrolls slowly during its turn.

  let cycleTimer = null;
  let pages = [];

  function makePage(nodes) {
    const page = el('div', 'page');
    const track = el('div', 'page-track');
    nodes.forEach(n => track.appendChild(n));
    page.appendChild(track);
    return page;
  }

  function overflowOf(page) {
    const track = page.firstChild;
    return Math.max(0, Math.ceil(track.scrollHeight - page.clientHeight));
  }

  function layoutPages(groups) {
    clearTimeout(cycleTimer);
    elViewport.innerHTML = '';
    const all = makePage(groups.flat());
    all.classList.add('active');
    elViewport.appendChild(all);
    pages = [all];

    if (groups.length > 1 && overflowOf(all) > 0) {
      elViewport.innerHTML = '';
      pages = groups.map(g => makePage(g));
      pages.forEach(p => elViewport.appendChild(p));
    }
    showPage(0);
  }

  function showPage(i) {
    clearTimeout(cycleTimer);
    const page = pages[i];
    if (!page) return;
    pages.forEach((p, j) => p.classList.toggle('active', j === i));
    const track = page.firstChild;
    track.style.transition = 'none';
    track.style.transform = 'translateY(0)';
    void track.offsetHeight;

    const overflow = overflowOf(page);
    const multi = pages.length > 1;
    const next = () => showPage((i + 1) % pages.length);
    const pause = cfg.SCROLL_PAUSE_MS || 8000;
    const dwell = (cfg.PAGE_SECONDS || 20) * 1000;

    if (overflow <= 0) {
      if (multi) cycleTimer = setTimeout(next, dwell);
      return;
    }

    const duration = overflow / (cfg.SCROLL_SPEED_PX_PER_SEC || 20) * 1000;
    const scrollTo = (y, then) => {
      track.style.transition = `transform ${duration}ms linear`;
      track.style.transform = `translateY(${y}px)`;
      cycleTimer = setTimeout(then, duration);
    };
    cycleTimer = setTimeout(() => scrollTo(-overflow, () => {
      cycleTimer = setTimeout(multi ? next : () => scrollTo(0, () => showPage(i)), pause);
    }), pause);
  }

  // ── Announcements ─────────────────────────────────────────────────────────
  // announcements.json: [{ "text": "...", "start": "2026-10-01", "end": "2026-10-05" }, ...]
  // start/end are optional; dates without a time mean the whole day, in TIME_ZONE.

  const ann = { list: [], active: [], index: 0, timer: null, sig: '' };

  function parseWhen(v, endOfDay) {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?$/.exec(String(v).trim());
    if (!m) return null;
    if (m[4] != null) return ICS.zonedToDate(+m[1], +m[2], +m[3], +m[4], +m[5], 0, tz);
    const k = ICS.addDays(m[1] + '-' + m[2] + '-' + m[3], endOfDay ? 1 : 0);
    return ICS.startOfDay(k, tz);
  }

  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function activeAnnouncements() {
    const t = now();
    const wd = ICS.weekday(ICS.dayKey(t, tz));
    return ann.list.filter(a => {
      if (!a || !a.text) return false;
      const s = parseWhen(a.start, false), e = parseWhen(a.end, true);
      if (s && t < s) return false;
      if (e && t >= e) return false;
      if (Array.isArray(a.days) && a.days.length &&
          !a.days.some(d => String(d).slice(0, 3).toLowerCase() === DAY_NAMES[wd])) return false;
      return true;
    });
  }

  async function loadAnnouncements() {
    if (!cfg.ANNOUNCEMENTS_URL) return;
    try {
      const text = await fetchText(cfg.ANNOUNCEMENTS_URL, 15000);
      const list = JSON.parse(text);
      if (!Array.isArray(list)) throw new Error('announcements.json must be a list');
      ann.list = list;
      store('announcements', text);
    } catch (err) {
      console.error('Announcements load failed:', err);
    }
    refreshAnnouncements();
  }

  function refreshAnnouncements() {
    const active = activeAnnouncements();
    const sig = JSON.stringify(active);
    if (sig === ann.sig) return;
    ann.sig = sig;
    ann.active = active;
    ann.index = 0;
    const box = $('announce');
    const wasHidden = box.classList.contains('hidden');
    box.classList.toggle('hidden', !active.length);
    showAnnouncement();
    // The strip changes the space available to the board; re-measure pages.
    if (wasHidden === !!active.length) render(true);
  }

  function showAnnouncement() {
    clearTimeout(ann.timer);
    const list = ann.active;
    if (!list.length) return;
    const a = list[ann.index % list.length];
    const body = $('announce-body');
    body.classList.remove('show');
    setTimeout(() => {
      body.innerHTML = '';
      if (a.title) body.appendChild(el('strong', 'announce-title', a.title));
      body.appendChild(el('span', 'announce-text', a.text));
      body.classList.add('show');
    }, list.length > 1 ? 400 : 0);

    const dots = $('announce-dots');
    dots.innerHTML = '';
    if (list.length > 1) list.forEach((_, i) => dots.appendChild(el('span', 'dot' + (i === ann.index % list.length ? ' on' : ''))));

    if (list.length > 1) {
      ann.timer = setTimeout(() => { ann.index++; showAnnouncement(); }, (cfg.ANNOUNCEMENT_SECONDS || 10) * 1000);
    }
  }

  // ── Status line ───────────────────────────────────────────────────────────

  function renderStatus() {
    const s = $('status');
    const refreshMs = (cfg.REFRESH_MINUTES || 15) * 60000;
    const parts = [];
    let warn = false;
    if (cal.fetchedAt) {
      const stale = Date.now() - cal.fetchedAt > refreshMs * 2 + 60000;
      warn = stale;
      parts.push((stale ? 'Calendar offline · last updated ' : 'Calendar updated ') + fmtTime(new Date(cal.fetchedAt + timeShift)));
    } else if (cal.lastError) {
      warn = true;
      parts.push('Calendar unavailable (' + cal.lastError + ')');
    }
    const wx = window.SignageWeather && window.SignageWeather.status();
    if (wx) parts.push(wx);
    if (SCREEN_ID) parts.push(SCREEN_ID);
    if (timeShift) parts.push('PREVIEW');
    s.textContent = parts.join('  ·  ');
    s.classList.toggle('warn', warn);
  }

  // ── Self-update, nightly reload, heartbeat ────────────────────────────────

  const SHELL_FILES = ['index.html', 'styles.css', 'config.js', 'ics.js', 'weather.js', 'script.js', 'sw.js'];
  let buildHash = null;

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  async function checkForUpdate() {
    try {
      const texts = await Promise.all(SHELL_FILES.map(f => fetchText(f, 20000)));
      const h = hashString(texts.join('\u0000'));
      if (buildHash && h !== buildHash) {
        console.log('New version published; reloading.');
        window.location.reload();
        return;
      }
      buildHash = h;
    } catch (err) {
      // Offline or GitHub hiccup: try again next time.
    }
  }

  function scheduleNightlyReload() {
    const m = /^(\d{1,2}):(\d{2})$/.exec(cfg.NIGHTLY_RELOAD || '');
    if (!m) return;
    const real = new Date();
    let k = ICS.dayKey(real, tz);
    let at = ICS.zonedToDate(...ICS.keyParts(k), +m[1], +m[2], 0, tz);
    if (at <= real) {
      k = ICS.addDays(k, 1);
      at = ICS.zonedToDate(...ICS.keyParts(k), +m[1], +m[2], 0, tz);
    }
    setTimeout(() => window.location.reload(), at - real);
  }

  function sendHeartbeat() {
    if (!cfg.HEARTBEAT_URL) return;
    const wx = window.SignageWeather && window.SignageWeather.info();
    const body = JSON.stringify({
      screen: SCREEN_ID || 'unnamed',
      build: buildHash,
      calendarAt: cal.fetchedAt || null,
      calendarError: cal.lastError,
      weather: wx,
      screenSize: window.screen.width + 'x' + window.screen.height,
      userAgent: navigator.userAgent
    });
    // text/plain keeps this a "simple" request (no CORS preflight).
    fetch(cfg.HEARTBEAT_URL, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true })
      .catch(() => { /* next one will try again */ });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function tickClock() {
    $('clock').textContent = fmtTime(now());
  }

  function init() {
    applyScaling();
    window.addEventListener('resize', () => { applyScaling(); });

    $('board-title').textContent = cfg.TITLE || "This Week's Events";
    applyTheme();
    videoWatchdog();
    setupThemeGraphic();

    tickClock();
    setInterval(tickClock, 1000);

    // Show the last good copies immediately, then refresh from the network.
    const cachedIcs = recall('ics');
    if (cachedIcs) ingest(cachedIcs, +recall('icsAt') || 0);
    try { ann.list = JSON.parse(recall('announcements') || '[]'); } catch (e) { ann.list = []; }

    render(true);
    refreshAnnouncements();
    loadCalendar();
    loadAnnouncements();

    // Once a minute: roll "now", past/today states, countdown, theme month.
    setInterval(() => { applyTheme(); render(); refreshAnnouncements(); }, 60000);
    setInterval(loadAnnouncements, 5 * 60000);

    if (window.SignageWeather) window.SignageWeather.start($('weather'));

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker registration failed:', err));
    }

    const upd = cfg.UPDATE_CHECK_MINUTES ?? 5;
    if (upd > 0) {
      checkForUpdate();
      setInterval(checkForUpdate, upd * 60000);
    }
    scheduleNightlyReload();

    if (cfg.HEARTBEAT_URL) {
      setTimeout(sendHeartbeat, 30000);
      setInterval(sendHeartbeat, (cfg.HEARTBEAT_MINUTES || 15) * 60000);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
