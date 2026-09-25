// === Configuration ===
window.CALENDAR_CONFIG = {
  TITLE: "Welcome to DeSoto Trail Elementary",

  // PREVIEWING: append ?date=YYYY-MM-DD (or ?date=YYYY-MM-DDTHH:MM) to the
  // page URL to see the board as it will look at that moment. A date alone
  // means 9:00 AM that day. The board keeps ticking forward from there.
  // DEV_DATE does the same from here; leave it commented out in production.
  //   DEV_DATE: "2026-11-23",

  // Your Cloudflare Worker that fetches the ICS (CORS-safe)
  ICS_URL: "https://red-frost-1be1.dtestechnology.workers.dev/",

  // All calendar math and display happen in this zone, whatever the PC's
  // own time zone is set to.
  TIME_ZONE: "America/New_York",

  WEEK_START_DAY: 0,          // 0 = Sunday, 1 = Monday (only affects which weekend days group with which week)
  SCHOOL_DAYS: [1, 2, 3, 4, 5], // columns always shown (0 = Sun … 6 = Sat); weekend columns appear only when they have events
  REFRESH_MINUTES: 15,        // calendar re-fetch interval
  SHOW_DESCRIPTION: false,    // show event descriptions on cards
  SHOW_NEXT_WEEK: true,
  NOW_INCLUDE_ALL_DAY: false, // "Happening Now" lists timed events in progress; true adds all-day ones too

  // Countdown chip in the header, e.g. "12 school days until Thanksgiving Break".
  // COUNTDOWN_MATCH picks which events get counted down to; NO_SCHOOL_MATCH
  // marks days that don't count as school days. Both are case-insensitive
  // regular expressions tested against event titles. Set COUNTDOWN_MAX_DAYS
  // to 0 to turn the countdown off.
  COUNTDOWN_MATCH: "no school|break|last day of school",
  NO_SCHOOL_MATCH: "no school|break",
  COUNTDOWN_MAX_DAYS: 30,

  // Background behind the theme graphic (bottom-right sidebar box).
  // "dark" matches the clock/header panels; "light" suits graphics with dark text/art.
  THEME_BOX_BG: "light",
  THEME_GRAPHIC: "assets/theme-graphic.png",

  // Frosted-glass blur behind the panels (improves readability over busy
  // backgrounds). If a kiosk PC's video stutters, set this to false; panels
  // then get darker instead.
  GLASS_BLUR: true,

  // When This Week + Next Week don't fit on screen together, the board
  // alternates between them. PAGE_SECONDS is how long each one stays up.
  // If a single week is still too tall, it scrolls slowly within its turn.
  PAGE_SECONDS: 20,
  SCROLL_PAUSE_MS: 8000,
  SCROLL_SPEED_PX_PER_SEC: 20,

  // Scheduled announcements, shown in a strip along the bottom.
  // See announcements.json for the format.
  ANNOUNCEMENTS_URL: "announcements.json",
  ANNOUNCEMENT_SECONDS: 10,

  // Weather panel. Forecast and alerts come from the National Weather Service
  // (free, no key). Current conditions come from, in order:
  //   1. the school's WeatherLink station, via the signage-api Worker, when
  //      STATION_API_URL is set (see worker/README.md)
  //   2. WeatherSTEM HQ (Shannon Lakes N), when WEATHERSTEM.API_KEY is set.
  //      This is an "API V2" key. It is meant to be public; WeatherSTEM only
  //      accepts it from the hostnames listed on the key.
  //   3. the Tallahassee airport (NWS)
  // A source is skipped when it isn't reporting (e.g. overnight).
  WEATHER: {
    LAT: 30.5395,
    LON: -84.2230,
    STATION_API_URL: "https://signage-api.dtestechnology.workers.dev/weather",
    STATION_LABEL: "DeSoto Trail station",
    WEATHERSTEM: {
      API_KEY: "7b5b4a32-ccdb-3b91-36e6-4858689b4217",
      STATION: "wxstemhq@leon.weatherstem.com",
      LABEL: "WeatherSTEM HQ"
    },
    NWS_STATION: "KTLH",
    NWS_STATION_LABEL: "Tallahassee Airport"
  },

  // Reliability
  UPDATE_CHECK_MINUTES: 5,   // reload automatically when the site's code/config changes on GitHub
  NIGHTLY_RELOAD: "03:00",   // full page reload once a day (24h, local to TIME_ZONE); "" to disable
  HEARTBEAT_URL: "https://signage-api.dtestechnology.workers.dev/heartbeat",
  HEARTBEAT_MINUTES: 15,

  // Background video (and matching poster image) by month. Pick videos that
  // read well under the dark, semi-transparent panels. If you replace a video,
  // give it a new filename so screens don't keep playing their cached copy.
  THEMES: {
    january:   { months: [1],  bg: "assets/01-january.mp4",   poster: "assets/posters/01-january.jpg" },
    february:  { months: [2],  bg: "assets/02-february.mp4",  poster: "assets/posters/02-february.jpg" },
    march:     { months: [3],  bg: "assets/03-march.mp4",     poster: "assets/posters/03-march.jpg" },
    april:     { months: [4],  bg: "assets/04-april.mp4",     poster: "assets/posters/04-april.jpg" },
    may:       { months: [5],  bg: "assets/05-may.mp4",       poster: "assets/posters/05-may.jpg" },
    june:      { months: [6],  bg: "assets/06-june.mp4",      poster: "assets/posters/06-june.jpg" },
    july:      { months: [7],  bg: "assets/07-july.mp4",      poster: "assets/posters/07-july.jpg" },
    august:    { months: [8],  bg: "assets/08-august.mp4",    poster: "assets/posters/08-august.jpg" },
    september: { months: [9],  bg: "assets/09-september.mp4", poster: "assets/posters/09-september.jpg" },
    october:   { months: [10], bg: "assets/10-october.mp4",   poster: "assets/posters/10-october.jpg" },
    november:  { months: [11], bg: "assets/11-november.mp4",  poster: "assets/posters/11-november.jpg" },
    december:  { months: [12], bg: "assets/12-december.mp4",  poster: "assets/posters/12-december.jpg" }
  }
};
