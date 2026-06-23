
// === Configuration ===
window.CALENDAR_CONFIG = {
  TITLE: "Welcome to DeSoto Trail Elementary",

  // DEV ONLY: override the current date for theme/calendar previewing.
  // Set to any date string recognised by new Date(), e.g. "2025-10-15".
  // Comment out or set to null to use the real date.
  // Tip: to preview a date without editing/deploying this file, append
  // ?date=YYYY-MM-DD to the page URL instead — it takes priority over this.
  //   DEV_DATE: "2026-05-14",

  // Your Cloudflare Worker that fetches the ICS (CORS-safe)
  ICS_URL: "https://red-frost-1be1.dtestechnology.workers.dev/",

  // Force all date/time rendering to Eastern
  TIME_ZONE: "America/New_York",

  WEEK_START_DAY: 0,       // 0 = Sunday, 1 = Monday
  REFRESH_MINUTES: 15,     // auto-refresh ICS fetch
  SHOW_DESCRIPTION: false, // toggle if you want long text shown on cards
  MAX_EVENTS: 30,
  SHOW_NEXT_WEEK: true,

  // Background behind the theme graphic (bottom-right sidebar box).
  // "dark" (default) matches the clock/header panels. Switch to "light" if
  // theme-graphic.png has dark text/art that needs a light backdrop instead.
  THEME_BOX_BG: "light",

  // Auto-scroll for the area below the header (Happening Now / This Week /
  // Next Week). Only kicks in when that content is taller than the visible
  // space. How long it sits still at the top/bottom of each pass, and how
  // fast it scrolls between them (the on-screen duration adapts to however
  // much content needs to be revealed, always at this same speed).
  SCROLL_PAUSE_MS: 20000,
  SCROLL_SPEED_PX_PER_SEC: 20,

  // WeatherLink embed (unchanged)
  WEATHER_IFRAME_SRC:
    "https://www.weatherlink.com/embeddablePage/show/70d6629b55214481b526a8159850212d/slim",

  // Background video by month. Panel/text colors are fixed (see styles.css
  // :root) rather than auto-adapting, so pick videos that read well with a
  // dark, semi-transparent overlay.
THEMES: {
  january: {
    months: [1],
    bg: "assets/01-january.mp4"
  },
  february: {
    months: [2],
    bg: "assets/02-february.mp4"
  },
  march: {
    months: [3],
    bg: "assets/03-march.mp4"
  },
  april: {
    months: [4],
    bg: "assets/04-april.mp4"
  },
  may: {
    months: [5],
    bg: "assets/05-may.mp4"
  },
  june: {
    months: [6],
    bg: "assets/06-june.mp4"
  },
  july: {
    months: [7],
    bg: "assets/07-july.mp4"
  },
  august: {
    months: [8],
    bg: "assets/08-august.mp4"
  },
  september: {
    months: [9],
    bg: "assets/09-september.mp4"
  },
  october: {
    months: [10],
    bg: "assets/10-october.mp4"
  },
  november: {
    months: [11],
    bg: "assets/11-november.mp4"
  },
  december: {
    months: [12],
    bg: "assets/12-december.mp4"
  }
}

};
