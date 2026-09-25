// ICS parsing and time-zone math for the signage board.
//
// Everything here works in one IANA time zone (config TIME_ZONE) instead of
// the PC's own clock setting, so a kiosk with the wrong Windows time zone
// still files events under the right day and time.
//
// Days are handled as 'YYYY-MM-DD' keys (they sort and compare as strings);
// instants are plain Date objects.
//
// Loaded in the browser as window.SignageICS, and in Node (tests) via require.
(function (root) {
  'use strict';

  // ── Time-zone helpers ─────────────────────────────────────────────────────

  const partsFmtCache = {};
  function partsFmt(tz) {
    return partsFmtCache[tz] || (partsFmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
  }

  function zonedParts(date, tz) {
    const o = {};
    for (const p of partsFmt(tz).formatToParts(date)) {
      if (p.type !== 'literal') o[p.type] = +p.value;
    }
    return o; // { year, month, day, hour, minute, second }
  }

  // Milliseconds the zone is ahead of UTC at the given instant.
  function tzOffset(date, tz) {
    const p = zonedParts(date, tz);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUTC - (date.getTime() - date.getMilliseconds());
  }

  // Wall-clock time in `tz` → instant. Two passes settle the DST offset.
  function zonedToDate(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    let t = guess - tzOffset(new Date(guess), tz);
    t = guess - tzOffset(new Date(t), tz);
    return new Date(t);
  }

  function key(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function keyParts(k) { return k.split('-').map(Number); }

  function dayKey(date, tz) {
    const p = zonedParts(date, tz);
    return key(p.year, p.month, p.day);
  }

  function keyToUTC(k) {
    const [y, m, d] = keyParts(k);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function addDays(k, n) {
    const t = keyToUTC(k);
    t.setUTCDate(t.getUTCDate() + n);
    return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  function diffDays(a, b) { return Math.round((keyToUTC(b) - keyToUTC(a)) / 86400000); }

  function weekday(k) { return keyToUTC(k).getUTCDay(); } // 0 = Sunday

  function startOfDay(k, tz) {
    const [y, m, d] = keyParts(k);
    return zonedToDate(y, m, d, 0, 0, 0, tz);
  }

  // A Date that formats as the given day when used with timeZone: 'UTC'.
  function keyToLabelDate(k) {
    const [y, m, d] = keyParts(k);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }

  // ── Line-level parsing ────────────────────────────────────────────────────

  const WINDOWS_TZ = {
    'Eastern Standard Time': 'America/New_York',
    'US Eastern Standard Time': 'America/Indianapolis',
    'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver',
    'US Mountain Standard Time': 'America/Phoenix',
    'Pacific Standard Time': 'America/Los_Angeles',
    'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu'
  };

  function resolveTz(tzid, fallback) {
    if (!tzid) return fallback;
    const id = tzid.replace(/^"|"$/g, '');
    if (WINDOWS_TZ[id]) return WINDOWS_TZ[id];
    try { new Intl.DateTimeFormat('en-US', { timeZone: id }); return id; }
    catch (e) { return fallback; }
  }

  // "NAME;PARAM=X;PARAM="a:b":value" → { name, params, value }
  function parseLine(line) {
    let i = 0, quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (c === ':' && !quoted) break;
    }
    if (i >= line.length) return null;
    const segs = line.slice(0, i).split(';');
    const params = {};
    for (const s of segs.slice(1)) {
      const j = s.indexOf('=');
      if (j > 0) params[s.slice(0, j).toUpperCase()] = s.slice(j + 1);
    }
    return { name: segs[0].toUpperCase(), params, value: line.slice(i + 1) };
  }

  function unescapeText(v) {
    return v.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N') ? '\n' : c).trim();
  }

  // → { allDay: true, key } or { allDay: false, date, tz, wall: [h, m, s] }
  function parseDateValue(value, params, defaultTz) {
    const v = value.trim();
    let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (m || params.VALUE === 'DATE') {
      m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
      return m ? { allDay: true, key: key(+m[1], +m[2], +m[3]) } : null;
    }
    m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
    if (!m) return null;
    const [, y, mo, d, h, mi, s = '0', z] = m;
    if (z) {
      const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
      const p = zonedParts(date, defaultTz);
      return { allDay: false, date, tz: defaultTz, wall: [p.hour, p.minute, p.second] };
    }
    const tz = resolveTz(params.TZID, defaultTz);
    return { allDay: false, date: zonedToDate(+y, +mo, +d, +h, +mi, +s, tz), tz, wall: [+h, +mi, +s] };
  }

  // ISO 8601 duration (P1D, PT1H30M, P1W) → { ms, days }
  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
    if (!m) return null;
    const days = (+m[2] || 0) * 7 + (+m[3] || 0);
    const ms = days * 86400000 + ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return m[1] === '-' ? null : { ms, days };
  }

  // ── Recurrence (RRULE) ────────────────────────────────────────────────────
  // Covers the rules calendar apps actually produce: DAILY / WEEKLY / MONTHLY /
  // YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (incl. 2TU / -1FR), BYMONTHDAY
  // and BYMONTH. BYSETPOS and sub-daily frequencies are ignored.

  const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  function parseRRule(v) {
    const r = {};
    for (const part of v.split(';')) {
      const [k, val] = part.split('=');
      if (k && val !== undefined) r[k.toUpperCase()] = val;
    }
    return {
      freq: r.FREQ,
      interval: Math.max(1, +r.INTERVAL || 1),
      count: r.COUNT ? +r.COUNT : null,
      until: r.UNTIL || null,
      byDay: r.BYDAY ? r.BYDAY.split(',').map(s => {
        const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(s.trim().toUpperCase());
        return m ? { n: m[1] ? +m[1] : 0, wd: DAY_CODES[m[2]] } : null;
      }).filter(Boolean) : null,
      byMonthDay: r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null,
      byMonth: r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null,
      wkst: DAY_CODES[(r.WKST || 'MO').toUpperCase()] ?? 1
    };
  }

  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  // Candidate day keys for one month, per BYMONTHDAY / BYDAY / fallback day.
  function monthCandidates(y, m, rule, startDay) {
    const dim = daysInMonth(y, m);
    const out = [];
    if (rule.byMonthDay) {
      for (const d of rule.byMonthDay) {
        const day = d > 0 ? d : dim + d + 1;
        if (day >= 1 && day <= dim) out.push(key(y, m, day));
      }
    } else if (rule.byDay) {
      for (const { n, wd } of rule.byDay) {
        const hits = [];
        for (let d = 1; d <= dim; d++) {
          if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) hits.push(d);
        }
        if (n === 0) hits.forEach(d => out.push(key(y, m, d)));
        else {
          const d = n > 0 ? hits[n - 1] : hits[hits.length + n];
          if (d) out.push(key(y, m, d));
        }
      }
    } else if (startDay <= dim) {
      out.push(key(y, m, startDay));
    }
    return out.sort();
  }

  // Yields occurrence start-day keys in order, from the series start.
  function* rruleDays(rule, startKey) {
    const [sy, sm, sd] = keyParts(startKey);
    const sWd = weekday(startKey);
    for (let period = 0; period < 5000; period++) {
      let cands = [];
      if (rule.freq === 'DAILY') {
        cands = [addDays(startKey, period * rule.interval)];
        if (rule.byDay) cands = cands.filter(k => rule.byDay.some(b => b.wd === weekday(k)));
      } else if (rule.freq === 'WEEKLY') {
        const weekStart = addDays(startKey, -((sWd - rule.wkst + 7) % 7) + period * 7 * rule.interval);
        const wds = rule.byDay ? rule.byDay.map(b => b.wd) : [sWd];
        for (let i = 0; i < 7; i++) {
          const k = addDays(weekStart, i);
          if (wds.includes(weekday(k))) cands.push(k);
        }
      } else if (rule.freq === 'MONTHLY') {
        const t = new Date(Date.UTC(sy, sm - 1 + period * rule.interval, 1));
        cands = monthCandidates(t.getUTCFullYear(), t.getUTCMonth() + 1, rule, sd);
      } else if (rule.freq === 'YEARLY') {
        const y = sy + period * rule.interval;
        const months = rule.byMonth || [sm];
        const r = (rule.byDay || rule.byMonthDay) ? rule : Object.assign({}, rule, { byMonthDay: [sd] });
        for (const m of months) cands.push(...monthCandidates(y, m, r, sd));
        cands.sort();
      } else {
        return; // unsupported frequency: only the first occurrence is shown
      }
      if (rule.byMonth && rule.freq !== 'YEARLY') {
        cands = cands.filter(k => rule.byMonth.includes(keyParts(k)[1]));
      }
      for (const k of cands) if (k >= startKey) yield k;
    }
  }

  // ── Event assembly ────────────────────────────────────────────────────────

  function makeEvent(raw, start, tz, spanDays, durationMs) {
    const base = {
      uid: raw.uid,
      title: raw.summary || 'Untitled event',
      location: raw.location || '',
      description: raw.description || ''
    };
    if (start.allDay) {
      const endKey = addDays(start.key, Math.max(1, spanDays) - 1);
      return Object.assign(base, {
        allDay: true,
        startKey: start.key,
        endKey,
        start: startOfDay(start.key, tz),
        end: startOfDay(addDays(endKey, 1), tz)
      });
    }
    const s = start.date;
    const e = new Date(s.getTime() + Math.max(0, durationMs));
    return Object.assign(base, {
      allDay: false,
      startKey: dayKey(s, tz),
      endKey: e > s ? dayKey(new Date(e.getTime() - 1), tz) : dayKey(s, tz),
      start: s,
      end: e
    });
  }

  // Length of the master event, reused for every recurrence.
  function eventLength(raw) {
    const s = raw.dtstart, e = raw.dtend;
    if (s.allDay) {
      // DTEND is exclusive. Many feeds (yours included) write DTEND == DTSTART
      // for single-day events, which would otherwise be zero-length.
      let days = 1;
      if (e && e.allDay) days = Math.max(1, diffDays(s.key, e.key));
      else if (raw.duration) days = Math.max(1, raw.duration.days);
      return { spanDays: days, durationMs: 0 };
    }
    let ms = 0;
    if (e && !e.allDay) ms = e.date - s.date;
    else if (raw.duration) ms = raw.duration.ms;
    return { spanDays: 1, durationMs: Math.max(0, ms) };
  }

  // Parse an ICS document.
  //   opts.tz            display/calendar zone (IANA name)
  //   opts.windowEndKey  recurring events are expanded up to this day
  function parse(text, opts) {
    const tz = opts.tz;
    const windowEndKey = opts.windowEndKey || '9999-12-31';

    const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const raws = [];
    let cur = null, depth = 0;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; depth = 0; continue; }
      if (!cur) continue;
      if (line === 'END:VEVENT') { raws.push(cur); cur = null; continue; }
      // Skip nested components (VALARM etc.)
      if (line.startsWith('BEGIN:')) { depth++; continue; }
      if (line.startsWith('END:')) { depth--; continue; }
      if (depth > 0) continue;

      const p = parseLine(line);
      if (!p) continue;
      switch (p.name) {
        case 'DTSTART': cur.dtstart = parseDateValue(p.value, p.params, tz); break;
        case 'DTEND': cur.dtend = parseDateValue(p.value, p.params, tz); break;
        case 'DURATION': cur.duration = parseDuration(p.value); break;
        case 'SUMMARY': cur.summary = unescapeText(p.value); break;
        case 'LOCATION': cur.location = unescapeText(p.value); break;
        case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
        case 'UID': cur.uid = p.value.trim(); break;
        case 'STATUS': cur.status = p.value.trim().toUpperCase(); break;
        case 'RRULE': cur.rrule = parseRRule(p.value); break;
        case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(p.value, p.params, tz); break;
        case 'EXDATE':
          for (const v of p.value.split(',')) {
            const d = parseDateValue(v, p.params, tz);
            if (d) cur.exdates.push(d);
          }
          break;
      }
    }

    // RECURRENCE-ID overrides replace (or, if cancelled, remove) one occurrence.
    const overridden = new Set();
    const occKey = (uid, d) => uid + '|' + (d.allDay ? d.key : dayKey(d.date, tz));
    for (const r of raws) {
      if (r.recurrenceId && r.uid) overridden.add(occKey(r.uid, r.recurrenceId));
    }

    const events = [];
    for (const raw of raws) {
      if (!raw.dtstart) continue;
      if (raw.status === 'CANCELLED') continue;
      const { spanDays, durationMs } = eventLength(raw);

      if (!raw.rrule || raw.recurrenceId) {
        events.push(makeEvent(raw, raw.dtstart, tz, spanDays, durationMs));
        continue;
      }

      const rule = raw.rrule;
      const s = raw.dtstart;
      const startKey = s.allDay ? s.key : dayKey(s.date, tz);
      const untilDate = rule.until ? parseDateValue(rule.until, {}, tz) : null;
      const exKeys = new Set(raw.exdates.map(d => d.allDay ? d.key : dayKey(d.date, tz)));
      let n = 0;

      for (const k of rruleDays(rule, startKey)) {
        if (k > windowEndKey) break;
        if (rule.count && n >= rule.count) break;
        let occ;
        if (s.allDay) {
          occ = { allDay: true, key: k };
        } else {
          const [y, m, d] = keyParts(k);
          occ = { allDay: false, date: zonedToDate(y, m, d, s.wall[0], s.wall[1], s.wall[2], s.tz) };
        }
        if (untilDate) {
          const past = untilDate.allDay
            ? k > untilDate.key
            : (occ.allDay ? startOfDay(k, tz) : occ.date) > untilDate.date;
          if (past) break;
        }
        n++;
        if (exKeys.has(k)) continue;
        if (raw.uid && overridden.has(occKey(raw.uid, occ))) continue;
        events.push(makeEvent(raw, occ, tz, spanDays, durationMs));
      }
    }

    return events.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  const api = {
    parse, zonedParts, zonedToDate, dayKey, addDays, diffDays, weekday,
    startOfDay, keyToLabelDate, keyParts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SignageICS = api;
})(this);
