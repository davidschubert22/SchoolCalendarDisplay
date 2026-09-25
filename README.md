# DTES Weekly Events Display

Digital signage for DeSoto Trail Elementary: this week's and next week's
calendar, a school-day countdown, scheduled announcements, weather, and the
monthly background video. Hosted on GitHub Pages; runs in Edge kiosk mode on
Windows 11 PCs on the guest network.

Live: https://davidschubert22.github.io/SchoolCalendarDisplay/

## Files

| File | What it does |
| --- | --- |
| `config.js` | All settings: title, calendar URL, countdown rules, weather location, timings, monthly videos |
| `announcements.json` | Scheduled announcements (see below) |
| `index.html`, `styles.css` | Layout (fixed 1920×1080 canvas, scaled to the screen) |
| `script.js` | Calendar board, paging, countdown, announcements, self-update |
| `ics.js` | ICS parsing and time-zone math (independent of the PC's time zone) |
| `weather.js` | Weather panel (NWS forecast/alerts; school station via the Worker) |
| `sw.js` | Service worker: offline cache for the page and the background video |
| `worker/signage-api.js` | Cloudflare Worker: WeatherLink proxy, screen heartbeat, status page |
| `kiosk/Setup-SignageKiosk.ps1` | One-time setup script for each kiosk PC |

## Updating the board

Commit and push (or edit on github.com). Every screen notices the change within
about 5–15 minutes and reloads itself: it checks the page's code files every 5
minutes, and GitHub Pages caches files for up to 10. Nobody has to touch the
PCs. Screens also reload once a night at 3:00 AM.

- **Replacing a background video:** use a new filename (e.g. `09-september-v2.mp4`)
  and update `config.js`. Screens keep a cached copy of each video, keyed by
  filename. Delete the old file.
- **Theme graphic:** replace `assets/theme-graphic.png` (about 1200 px wide is
  plenty). The box sizes itself to the image, and the weather panel gets
  whatever height is left.

## Previewing a date

Add `?date=YYYY-MM-DD` (9:00 AM that day) or `?date=YYYY-MM-DDTHH:MM` to the
URL, e.g. `…/SchoolCalendarDisplay/?date=2026-11-23`. The status line shows
`PREVIEW`. Weather is always live.

## Announcements

Edit `announcements.json` on github.com (pencil icon → Commit changes). Changes
appear within about 5–15 minutes. Each entry:

```json
[
  {
    "title": "Picture Day",
    "text": "Fall picture retakes are Thursday, November 5.",
    "start": "2026-11-01",
    "end": "2026-11-05"
  },
  {
    "text": "Car rider line opens at 7:15 AM.",
    "start": "2026-11-02T06:00",
    "end": "2026-11-20T09:00",
    "days": ["Mon", "Tue", "Wed", "Thu", "Fri"]
  }
]
```

- `text` is required; `title` is optional (shown in gold before the text).
- `start` / `end` are optional. A date alone means the whole day (so `end`
  includes that date). Times are Eastern.
- `days` is optional and limits it to certain weekdays.
- With several active announcements, the strip rotates every 10 seconds. With
  none, the strip disappears and the calendar gets the space.
- A typo that breaks the JSON is ignored: screens keep the last good list, and
  github.com shows the syntax error when you view the file.

## Calendar behavior

- **Weekends** look ahead: on Saturday and Sunday the board shows the coming
  week ("Coming Up") and the one after.
- **Multi-day events** (Book Fair, breaks) are bars across the days they cover.
  A dashed end means the event continues into the neighboring week.
- **Countdown** targets the next event within 30 days whose title matches
  `COUNTDOWN_MATCH` ("no school", "break", "last day of school"). It counts
  school days left, including today, and skips weekends and days covered by
  `NO_SCHOOL_MATCH` events.
- **This Week + Next Week** share the screen when they fit. Otherwise the board
  alternates between them every 20 seconds, scrolling slowly if a single week
  is still too tall.
- **Offline:** screens keep showing the last calendar they fetched. The status
  line (bottom-left) turns amber and says when the data is from.

## Hosting pieces

- **GitHub Pages** hosts the board.
- **`red-frost-1be1` Worker** (existing) fetches the ICS calendar, which gets
  around CORS.
- **`signage-api` Worker** (optional, new) handles the school WeatherLink
  station, heartbeat and status page. See [`worker/README.md`](worker/README.md).

## Kiosk PCs

See [`kiosk/README.md`](kiosk/README.md).
