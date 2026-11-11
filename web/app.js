// Fuelish web: what every page shares (the server API, saved settings, dates and names, places) and
// the router. The pages are in list.js (trips), trip.js (one trip), many.js (an outing, a day, a
// week), pages.js (Insights, Compare, Costs, Transmission, Stops) and map.js (the map they draw on);
// this file loads last and starts the page.
// Plain JS, no build step: the files share one global scope. Signing in is with Google (account.js) and a session cookie; the original
// shared read token still works and lives in localStorage on this browser only.

const app = document.getElementById("app");
const TOKEN_KEY = "fuelish.token";
const VIEW_KEY = "fuelish.routeView";
const routeCache = new Map(); // `${id}@${raw chunk hashes}` -> points rebuilt from raw data

// Each navigation gets a number. Work that finishes after the user has moved on checks it and stops,
// so a slow page can't draw over the one they opened since. Maps, observers and listeners a page
// sets up are released when it's left.
let navGen = 0;
const cleanups = [];
const onLeave = (fn) => cleanups.push(fn);
const current = () => { const g = navGen; return () => g === navGen; };

function token() {
  try { return cleanToken(localStorage.getItem(TOKEN_KEY) || ""); } catch { return ""; }
}

// A pasted token can carry characters that aren't part of it: spaces and line breaks, invisible
// zero-width spaces or a byte-order mark (phone keyboards and password managers add these), or
// quotes copied from a config file. A token is plain ASCII, so these are dropped.
function cleanToken(s) {
  return s.replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF"'`\u2018\u2019\u201C\u201D]/g, "");
}

// What's still wrong with a cleaned token, if anything: fetch refuses header values outside Latin-1.
function tokenProblem(t) {
  const bad = [...t].find((c) => c < "!" || c > "~");
  return bad ? `That token contains a character a token can't have (U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}). Copy it again from where it's stored.` : "";
}

// Every recording, newest first (the server pages them).
// Whose: the header's "whose trips" choice.
// Fades the header links' edges where more links are scrolled out of sight, so it's clear there are more.
function navEdges() {
  const nav = document.getElementById("main-nav");
  if (!nav || nav.hidden) return;
  nav.classList.toggle("more-left", nav.scrollLeft > 2);
  nav.classList.toggle("more-right", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
}
document.getElementById("main-nav")?.addEventListener("scroll", navEdges, { passive: true });
window.addEventListener("resize", navEdges);

// Every trip in the person picker's choice (or `user`'s: an id, "" for everyone).
// Each comes marked towing or not (Towing.mark), from its vehicle's other trips and any correction.
async function allRecordings(user = Account.whoParam()) {
  const prefs = Prefs.load().catch(() => null);
  const { recordings } = await recordingPages(user);
  await prefs;
  Towing.mark(recordings, Prefs.get("towing"));
  rememberTowing(recordings);
  return { recordings };
}

// Towing is judged from all of a vehicle's trips, and the trip list loads only recent ones. So the
// marks from the last time every trip was loaded are kept in this browser, and the list uses them
// for the trips they cover; that keeps its scores the same as the trip page's.
const TOWING_SEEN = "fuelish.towingSeen";
const readSeen = () => { try { return JSON.parse(localStorage.getItem(TOWING_SEEN) || "{}") || {}; } catch { return {}; } };
function rememberTowing(recs) {
  // Merged in: the person picker may have loaded only some people's trips.
  const seen = readSeen();
  for (const r of recs) {
    if (r.towingSource === "you") delete seen[r.id];
    else seen[r.id] = [r.towing ? 1 : 0, r.towingSource, r.towingRatio, r.towingDetected];
  }
  try { localStorage.setItem(TOWING_SEEN, JSON.stringify(seen)); } catch {}
}
function recallTowing(recs) {
  const seen = readSeen();
  for (const r of recs) {
    const s = seen[r.id];
    if (!s || r.towingSource === "you") continue;
    [r.towing, r.towingSource, r.towingRatio, r.towingDetected] = [!!s[0], s[1], s[2], s[3]];
  }
}

// The server's pages of trips, newest first. With `since` (ms) only those that started then or later
// (before `before`, ms, if given), and `olderMs`: when the newest trip before `since` started, or null.
async function recordingPages(user, { since = null, before = null } = {}) {
  let all = [], olderMs;
  for (;;) {
    const q = [
      user ? `user=${encodeURIComponent(user)}` : "",
      since != null ? `since=${Math.floor(since)}` : "",
      before != null ? `before=${encodeURIComponent(before)}` : "",
    ].filter(Boolean).join("&");
    const page = await api("/recordings" + (q ? "?" + q : ""));
    all = all.concat(page.recordings);
    if (olderMs === undefined) olderMs = page.olderMs;
    if (page.next == null || !page.recordings.length) break;
    before = page.next;
  }
  return { recordings: all, olderMs: olderMs ?? null };
}

// The trip list starts with the last few weeks and reaches further back on request. How far it
// reaches is kept per person picked while the page is open, so coming back to the list keeps it.
const RECENT_WEEKS = 5, MORE_WEEKS = 8;
const listReach = new Map(); // whose -> { since: ms }
async function recentRecordings(user = Account.whoParam()) {
  const prefs = Prefs.load().catch(() => null);
  let since = listReach.get(user)?.since ?? +addDays(weekStart(Date.now()), -7 * (RECENT_WEEKS - 1));
  let { recordings, olderMs } = await recordingPages(user, { since });
  // Nothing lately (back from a long break): start from the latest drive instead.
  if (!recordings.length && olderMs != null) {
    since = +addDays(weekStart(olderMs), -7 * (RECENT_WEEKS - 1));
    ({ recordings, olderMs } = await recordingPages(user, { since }));
  }
  listReach.set(user, { since });
  await prefs;
  Towing.mark(recordings, Prefs.get("towing"));
  recallTowing(recordings);
  return { recordings, olderMs, since };
}
// Reach further back: at least MORE_WEEKS more, and always as far as the next older drive.
function reachFurther(user, olderMs) {
  const at = listReach.get(user)?.since ?? Date.now();
  listReach.set(user, { since: +weekStart(Math.min(olderMs, +addDays(new Date(at), -7 * MORE_WEEKS))) });
}

async function api(path, opts = {}) {
  const t = token();
  const problem = t ? tokenProblem(t) : "";
  if (problem) { showLogin(problem); throw new Error("unauthorized"); }
  const res = await fetch("/api/v1" + path, {
    ...opts,
    // The session cookie goes along by itself; X-Fuelish tells the server this page sent it.
    headers: { "X-Fuelish": "1", ...(t ? { Authorization: "Bearer " + t } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    showLogin(t ? "That token didn't work." : "You've been signed out. Sign in again.");
    throw new Error("unauthorized");
  }
  // Not JSON: an error page from in front of the server (it's down, or being deployed).
  const body = await res.json().catch(() => null);
  if (body == null) throw Object.assign(new Error(res.ok ? "The server's answer couldn't be read." : `The server isn't answering right now (${res.status}).`), { status: res.status });
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status, body });
  return body;
}

// Settings saved on the server for every browser (place names, cost assumptions). Loaded once.
// Loading: one request shared by everyone waiting; a failure falls back to defaults for that page
// only and is retried on the next. Saving: writes go one at a time, and the stored value changes
// only once the server has it (a failed save throws, for the caller to show).
const Prefs = (() => {
  let data = null, versions = {}, loading = null, failed = false, queue = Promise.resolve();
  async function load() {
    if (data) return data;
    loading ||= api("/prefs").then((b) => { data = b.prefs || {}; versions = b.versions || {}; failed = false; Costs.use(data.costs, data.vehicles, data.people); return data; })
      .catch((e) => { if (e.message === "unauthorized") throw e; failed = true; Costs.use(null); return {}; })
      .finally(() => { loading = null; });
    return loading;
  }
  // `change(current)` runs when this save's turn comes, against the value the saves before it left,
  // so two quick edits to one setting (naming two places) both stick. Each save says which version
  // it changed; if someone else saved in between, the server sends theirs and the change is made
  // again on top of it, so neither edit is lost.
  function update(key, change) {
    const run = queue.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const value = change(data?.[key]);
        try {
          const r = await api(`/prefs/${key}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Fuelish-Base": String(versions[key] ?? 0) },
            body: JSON.stringify(value),
          });
          (data ||= {})[key] = r.value ?? value;
          if (r.version != null) versions[key] = r.version;
          return;
        } catch (e) {
          if (e.status !== 409 || !e.body || !("version" in e.body) || attempt >= 3) throw e;
          (data ||= {})[key] = e.body.value ?? undefined;
          versions[key] = e.body.version;
          if (key === "costs" || key === "vehicles" || key === "people") Costs.use(data.costs, data.vehicles, data.people);
        }
      }
    });
    queue = run.catch(() => {});
    return run;
  }
  const set = (key, value) => update(key, () => value);
  const clear = () => { data = null; versions = {}; loading = null; failed = false; };
  return { load, set, update, clear, get: (k) => data?.[k], failed: () => failed };
})();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function fmtDur(ms) {
  if (ms == null || ms < 0) return "–";
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const miles = (m) => (m / 1609.344 < 10 ? (m / 1609.344).toFixed(1) : Math.round(m / 1609.344)) + " mi";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function partOfDay(ms) {
  const h = new Date(ms).getHours();
  return h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
}
// "Monday evening drive", for a trip's title.
const tripName = (ms) => `${new Date(ms).toLocaleDateString([], { weekday: "long" })} ${partOfDay(ms)} drive`;
const outingName = (ms) => `${new Date(ms).toLocaleDateString([], { weekday: "long" })} ${partOfDay(ms)} outing`;

function daysAgo(ms) {
  const today = new Date();
  return Math.round((new Date(today.toDateString()) - new Date(new Date(ms).toDateString())) / 86400000);
}
function dayLabel(ms) {
  const d = new Date(ms), days = daysAgo(ms);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

// Local calendar days and weeks (weeks start on Sunday), keyed "YYYY-MM-DD" in URLs.
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const weekStart = (ms) => { const d = dayStart(ms); return addDays(d, -d.getDay()); };

// When the drive ended. Automatic stops wait a couple of minutes after the car goes away;
// the server works out the drive's real end, and nothing after it is counted or drawn.
const endOf = (r) => r.driveEndWallMs ?? r.endedWallMs ?? r.updatedAtMs;
const timeRange = (r) => `${clock(r.startedWallMs)} – ${clock(endOf(r))}`;
const moved = (r) => r.trip && r.trip.meters >= 100;

// Named places (prefs "places": [{ lat, lon, name }], shared with Compare), and drives described by
// them: "Home → Aldi → Home". A drive's start and end match a name within END_M; a stop along the way
// (the list's trip summary has stops of 30 s or more) counts when it's within STOP_M of a name, and
// isn't within PARK_M of the trip's own start or end (shuffling into a parking space).
const Places = (() => {
  const END_M = 250, STOP_M = 150, STOP_MS = 30000, SAME_M = 150, PARK_M = 100;
  const away = (a, b) => (s) => Route.haversine(s.lat, s.lon, a[0], a[1]) > PARK_M && Route.haversine(s.lat, s.lon, b[0], b[1]) > PARK_M;
  const list = () => Prefs.get("places") || [];
  function nameAt(lat, lon, within = END_M) {
    let best = null, bd = within;
    for (const n of list()) { const d = Route.haversine(n.lat, n.lon, lat, lon); if (d <= bd) { bd = d; best = n.name; } }
    return best;
  }
  // Where recordings taken as one drive went, in order: its start, stops along the way, each trip's end.
  function visits(recs) {
    const out = [];
    recs.filter(moved).forEach((r, i) => {
      const p = r.trip.path;
      if (!i) out.push({ lat: p[0][0], lon: p[0][1], kind: "start" });
      const far = away(p[0], p.at(-1));
      for (const [lat, lon, ms] of r.trip.stops || []) if (ms >= STOP_MS && far({ lat, lon })) out.push({ lat, lon, ms, kind: "stop" });
      out.push({ lat: p.at(-1)[0], lon: p.at(-1)[1], kind: "end" });
    });
    return named(out);
  }
  // The same from detailed points, one trip or several (an outing, a day, a week): each drive's start,
  // stops along the way (Route.summary's) and end. Where the next drive starts where one ended, that's
  // one stop, as long as the time between. Each visit has `i`, the point it's at.
  function visitsOfPoints(pts, stops) {
    const mean = (a, b, k) => pts.slice(a, b + 1).reduce((n, p) => n + p[k], 0) / (b - a + 1);
    const out = [];
    // When a drive got where it ended: the first standstill once it was within PARK_M of the end for
    // good. A recording keeps going for a while after parking (and may shuffle about the lot), so
    // its last point is later than that.
    const arrival = (a, b) => {
      let j = b;
      while (j > a && Route.haversine(pts[j - 1].lat, pts[j - 1].lon, pts[b].lat, pts[b].lon) <= PARK_M) j--;
      // Not before it first moved (a short hop may never leave the circle).
      let m = a;
      while (m < b && !(pts[m].v > 1)) m++;
      for (let k = Math.max(j, m); k < b; k++) if (pts[k].v != null && pts[k].v < Route.STILL_MPS) return k;
      return b;
    };
    Route.tripRanges(pts).forEach(([a, b]) => {
      const s = pts[a], e = pts[b], prev = out.at(-1);
      // `leaves`: the drive (pts' trip index) that sets off from here.
      if (prev && Route.haversine(prev.lat, prev.lon, s.lat, s.lon) <= PARK_M) Object.assign(prev, { kind: "stop", ms: s.t - prev.t, leaves: s.trip });
      else out.push({ lat: s.lat, lon: s.lon, i: a, t: s.t, kind: "start", leaves: s.trip });
      const far = away([s.lat, s.lon], [e.lat, e.lon]);
      for (const x of stops) {
        if (x.i0 < a || x.i1 > b || x.ms < STOP_MS) continue;
        const v = { lat: mean(x.i0, x.i1, "lat"), lon: mean(x.i0, x.i1, "lon"), ms: x.ms, i: x.i0, t: pts[x.i0].t, kind: "stop", along: true };
        if (far(v)) out.push(v);
      }
      const k = arrival(a, b);
      out.push({ lat: e.lat, lon: e.lon, i: b, t: pts[k].t, kind: "end", arrives: e.trip });
    });
    return named(out);
  }
  function named(vs) {
    for (const v of vs) v.name = nameAt(v.lat, v.lon, v.kind === "stop" ? STOP_M : END_M);
    return vs;
  }
  /** "Home → Aldi → Home", "From Home", "To Aldi"; null when it went nowhere named. */
  const label = (recs) => labelOf(visits(recs));
  function labelOf(v) {
    const parts = v.map((x) => x.name).filter(Boolean).filter((x, i, a) => x !== a[i - 1]);
    if (!parts.length) return null;
    const first = v[0]?.name, last = v.at(-1)?.name;
    if (!first && !last) return `Via ${parts.join(", ")}`;
    if (!first) return `To ${parts.join(" → ")}`;
    if (!last) return `From ${parts.join(" → ")}`;
    if (parts.length === 1) return `Around ${parts[0]}`;
    return parts.join(" → ");
  }
  /** Names the place at lat, lon (an empty name removes it), replacing any name already within SAME_M. */
  function rename(lat, lon, name) {
    return Prefs.update("places", (places) => {
      const keep = (places || []).filter((p) => Route.haversine(p.lat, p.lon, lat, lon) >= SAME_M);
      if (name) keep.push({ lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, name: name.slice(0, 80) });
      return keep;
    });
  }
  return { nameAt, visits, visitsOfPoints, label, labelOf, rename };
})();

// Trips taken as one (back to back, or out and back the same day): outings.js.
const outings = Outings.group;
// `b` carries on the drive `a` was recording when an app update ended it: the phone says so
// (meta.resumes, from 0.1.44), or, before that, `a` was cut off and `b` started within a minute.
function continues(a, b) {
  if (b.meta?.resumes) return b.meta.resumes === a.id;
  return a.status === "interrupted" && a.deviceId === b.deviceId && b.startedWallMs - endOf(a) <= 60000;
}
const outingOf = (all, id) => outings(all).find((o) => o.some((r) => r.id === id));
// An outing's trips worth a button of their own: not recordings that never moved (the phone
// starting and stopping in the driveway). Those still count toward the whole outing.
const legsOf = (o) => o.filter((r) => !(r.trip && !moved(r)));

function statusPill(r) {
  if (r.status === "recording") return `<span class="pill live"><i></i>Recording</span>`;
  if (!r.complete) return `<span class="pill warn">Uploading ${r.chunksReceived}/${r.chunkCount ?? "?"}</span>`;
  return "";
}

function totals(recs) {
  const m = recs.filter(moved);
  return {
    trips: m.length,
    meters: m.reduce((n, r) => n + r.trip.meters, 0),
    movingMs: m.reduce((n, r) => n + r.trip.movingMs, 0),
    maxMps: Math.max(0, extent(m, (r) => r.trip.maxMps)[1]),
  };
}

function showLogin(msg = "") {
  // Whatever was loading belongs to the old session: stop it from drawing over the sign-in form.
  leavePage();
  Account.forget();
  document.getElementById("main-nav").hidden = true;
  document.body.classList.remove("page-trip");
  Account.renderHeader();
  routeCache.clear();
  engineCache.clear();
  tripRowsCache.clear();
  Kept.clear();
  Prefs.clear();
  Account.showLogin(msg);
}

// Ends the current page: later results from it are ignored, and what it set up is released.
function leavePage() {
  navGen++;
  while (cleanups.length) { try { cleanups.pop()(); } catch {} }
}

async function route() {
  leavePage();
  const live = current();
  // A shared trip needs no sign-in.
  const share = location.hash.match(/^#\/s\/([A-Za-z0-9_-]+)/);
  if (share) {
    document.body.classList.add("page-trip");
    app.innerHTML = `<p class="muted loading">Loading…</p>`;
    try { await showTrip(null, share[1]); } catch (e) { if (live()) app.innerHTML = `<p class="bad loading">${esc(e.message)}</p>`; }
    return;
  }
  // An invite opens before anyone is signed in.
  const invite = location.hash.match(/^#\/invite\/([A-Za-z0-9_-]+)/);
  if (invite) {
    document.body.classList.remove("page-trip");
    document.getElementById("main-nav").hidden = true;
    return Account.showInvite(invite[1]);
  }
  if (!(await Account.load())) return showLogin();
  if (!live()) return;
  Account.renderHeader();
  const h = location.hash;
  // The section links in the header, with the current one marked.
  const section = h.startsWith("#/routes") ? "routes" : h.startsWith("#/stops") ? "stops" : h.startsWith("#/costs") ? "costs" : h.startsWith("#/insights") ? "insights" : h.startsWith("#/cvt") ? "cvt" : h.startsWith("#/account") ? "account" : "trips";
  const nav = document.getElementById("main-nav");
  nav.hidden = false;
  nav.querySelectorAll("a").forEach((a) => (a.dataset.section === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const trip = h.match(/^#\/r\/([A-Za-z0-9_-]+)(?:\/(\d+))?/);
  const insights = h.startsWith("#/insights");
  const routes = h.match(/^#\/routes(?:\/([A-Za-z0-9_.-]+))?/);
  const cvt = h.startsWith("#/cvt");
  const costs = h.startsWith("#/costs");
  const account = h.startsWith("#/account");
  const stops = h.startsWith("#/stops");
  const many = h.match(/^#\/(day|week)\/(\d{4}-\d{2}-\d{2})/) || h.match(/^#\/(outing)\/([A-Za-z0-9_-]+)/);
  document.body.classList.toggle("page-trip", !!(trip || many || stops));
  // On a narrow screen the links scroll sideways: keep the current one in view. Measured after the
  // page class is set, since a trip page hides the header (and everything in it measures 0).
  const here = nav.querySelector("[aria-current]");
  if (here) nav.scrollLeft = Math.max(0, here.offsetLeft - nav.offsetLeft - (nav.clientWidth - here.offsetWidth) / 2);
  navEdges();
  window.scrollTo(0, 0);
  app.innerHTML = `<p class="muted loading">Loading…</p>`;
  try {
    await Prefs.load();
    if (!live()) return; // navigated again while settings loaded
    if (trip) await showTrip(trip[1], null, trip[2] ? +trip[2] : null);
    else if (insights) await showInsights();
    else if (routes) await showRoutes(routes[1] || null);
    else if (cvt) await showCvt();
    else if (costs) await showCosts();
    else if (account) await Account.showAccount();
    else if (stops) await showStops();
    else if (many) await showMany(many[1], many[2]);
    else await showList();
  } catch (e) {
    if (e.message !== "unauthorized" && live()) app.innerHTML = `<p class="bad loading">${esc(e.message)}</p>`;
  }
}

window.addEventListener("hashchange", route);
route();
