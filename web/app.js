// Fuelish web: the list of trips, one drive's page (a whole outing of linked trips, or one trip in
// it, switched by a row across the top) and map views of a day or a week.
// Plain JS, no build step. Signing in is with Google (account.js) and a session cookie; the original
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
  const body = await res.json();
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

// ---------- trip list ----------

async function showList() {
  const live = current();
  const who = Account.whoParam();
  const { recordings, olderMs, since } = await recentRecordings(who);
  if (!live()) return;
  if (!recordings.length) {
    // Someone new: say what happens next, where they are (in the app, or on the web).
    // In the app, say what actually starts a recording on this phone: auto-record might be off.
    let rec = {};
    try { rec = JSON.parse(window.FuelishApp?.recordMode?.() || "{}"); } catch {}
    const how = rec.mode === "auto"
      ? `Get in and drive: recording starts by itself when your phone connects to ${esc(rec.car || "the car")}, and stops shortly after you park.`
      : rec.mode === "manual"
        ? `Before you set off, tap the bar at the bottom, then Start recording. When you get there, tap Stop recording.`
        : `First finish setting up the recorder: tap the bar at the bottom.`;
    app.innerHTML = Account.inApp()
      ? `<div class="empty"><h1>Your first drive goes here</h1><p class="muted">${how}</p><p class="muted">A few minutes after the recording stops, the trip shows up here with its route, cost and mpg. It uploads on Wi-Fi. To send it sooner, tap the bar at the bottom, then Upload now.</p></div>`
      : `<div class="empty"><h1>No trips yet</h1><p class="muted">Trips show up here after the Fuelish app on your Android phone records a drive and uploads it.</p>${/Android/i.test(navigator.userAgent) ? "" : `<p class="muted">No app yet? Open this page on your phone and get it from the Account page.</p>`}</div>`;
    return;
  }
  const thisWeek = weekStart(Date.now());
  const wk = totals(recordings.filter((r) => r.startedWallMs >= +thisWeek));

  // Newest first: days, and the outings within each day (an outing belongs to the day it started).
  const groups = [];
  for (const o of outings(recordings).reverse()) {
    const label = dayLabel(o[0].startedWallMs);
    if (groups.at(-1)?.label !== label) groups.push({ label, key: ymd(dayStart(o[0].startedWallMs)), thisWeek: o[0].startedWallMs >= +thisWeek, items: [], keys: [] });
    groups.at(-1).items.push(o);
  }
  // Cards first, so each day knows its cards' score keys for its total.
  for (const g of groups) g.cards = g.items.map((o) => { const l = legsOf(o); return l.length > 1 ? outingCard(o) : tripCard(l[0] ?? o[0]); }).join("");
  for (const g of groups) g.keys = [...g.cards.matchAll(/data-score="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

  app.innerHTML = `
    <div class="list-head">
      <div>
        <h1>Trips</h1>
        <div class="head-links">
          <a class="see-map" href="#/week/${ymd(thisWeek)}">This week on a map →</a>
        </div>
      </div>
      <div class="week">
        <div><b>${wk.trips}</b><span>trips this week</span></div>
        <div><b>${miles(wk.meters)}</b><span>driven</span></div>
        <div><b>${fmtDur(wk.movingMs)}</b><span>behind the wheel</span></div>
        <div data-total-of="${esc(groups.filter((g) => g.thisWeek).flatMap((g) => g.keys).join("|"))}" hidden><b></b><span>on gas</span></div>
      </div>
    </div>
    ${groups.map((g) => {
      const t = totals(g.items.flat());
      return `
      <section class="day"${g.thisWeek ? " data-this-week" : ""}>
        <div class="day-head">
          <h2>${esc(g.label)}</h2>
          ${t.trips ? `<span class="muted">${plural(t.trips, "trip")} · ${miles(t.meters)}<span data-total-of="${esc(g.keys.join("|"))}" hidden> · <b></b> gas</span></span>
          <a href="#/day/${g.key}">Map of the day →</a>` : ""}
        </div>
        <div class="cards">${g.cards}</div>
      </section>`;
    }).join("")}
    ${olderMs != null ? `<div class="list-more">
      <span class="muted">Trips since ${esc(new Date(since).toLocaleDateString(undefined, { month: "long", day: "numeric", ...(new Date(since).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }))}</span>
      <button type="button" class="more-btn" id="older-trips">Show older trips</button>
    </div>` : ""}`;
  document.getElementById("older-trips")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "Loading…";
    reachFurther(who, olderMs);
    // Drawn again in place: the trips above stay where they are on screen.
    leavePage();
    try { await showList(); } catch (e) {
      if (e.message === "unauthorized") return;
      btn.disabled = false;
      btn.textContent = `Couldn't load (${e.message}). Try again`;
    }
  });
  scoreCards(live);
}

// ---------- scores on the cards ----------

// Each card's score and gas cost are worked out from its engine data once the card scrolls into view
// (a few at a time), then remembered in this browser, keyed by the recordings, their last update, what the
// driver's time is worth and SCORE_VERSION (bump it when the score's method changes). Cards without enough engine
// data show no ring and no cost.
const SCORE_VERSION = 4;
const scoreJobs = new Map(); // slot key -> recordings
function scoreSlot(recs) {
  recs = recs.filter((r) => r.trip || r.routeGaps > 0); // what its page draws and scores
  if (!recs.some(moved)) return "";
  const key = recs.map((r) => `${r.id}@${r.updatedAtMs}${r.towing ? "+tow" : ""}`).join(",");
  scoreJobs.set(key, recs);
  return `<span class="card-score" data-score="${esc(key)}" hidden></span>`;
}
// Figures for each card shown so far (null: no engine data), summed into the day and week totals.
const figuresFor = new Map();
// A day's or the week's gas, once every card in it has its figures: elements with data-total-of
// (the cards' score keys, joined by "|") get "$4.20 on gas".
function showTotals() {
  document.querySelectorAll("[data-total-of]").forEach((el) => {
    const keys = el.dataset.totalOf ? el.dataset.totalOf.split("|") : [];
    if (!keys.length || !keys.every((k) => figuresFor.has(k))) return;
    const f = keys.map((k) => figuresFor.get(k));
    const known = f.filter((x) => x?.cost != null);
    if (!known.length) return;
    const missing = f.length - known.length;
    el.hidden = false;
    el.querySelector("b").textContent = `${missing || known.some((x) => x.approx) ? "≈" : ""}${money(known.reduce((a, x) => a + x.cost, 0))}`;
    el.title = missing ? `${plural(missing, "trip")} without engine data ${missing === 1 ? "isn't" : "aren't"} counted` : "";
  });
}
const scoreKey = (key) => `fuelish.score.v${SCORE_VERSION}:${timeFor(scoreJobs.get(key)?.[0])}:${key}`;
function readScore(key) {
  try { const v = localStorage.getItem(scoreKey(key)); return v == null ? undefined : JSON.parse(v); } catch { return undefined; }
}
function showScore(el, f) {
  const n = f?.score;
  const card = el.closest(".trip-card");
  const cost = card?.querySelector(".card-cost"), mpg = card?.querySelector(".card-mpg");
  if (cost && f?.cost != null) {
    cost.hidden = false;
    cost.title = `${f.approx ? "About " : ""}${gallons(f.gal)} gal of gas at ${money(f.price)}/gal, the regional average that week`;
    cost.innerHTML = `<b>${f.approx ? "≈" : ""}${money(f.cost)}</b> gas`;
  }
  if (mpg && f?.mpg != null) {
    mpg.hidden = false;
    mpg.innerHTML = `<b>${f.approx ? "≈" : ""}${f.mpg.toFixed(0)}</b> mpg`;
  }
  figuresFor.set(el.dataset.score, f ?? null);
  showTotals();
  if (n == null) return;
  el.hidden = false;
  el.className = `card-score ${scoreTone(n)}`;
  el.title = `Driving score ${n}`;
  el.innerHTML = `<b>${n}</b><small>score</small>`;
}
function scoreCards(live) {
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < 2 && queue.length) {
      const el = queue.shift(), key = el.dataset.score, recs = scoreJobs.get(key);
      running++;
      driveFigures(recs).then((n) => {
        // Still recording or uploading: show it, but work it out again next time.
        // Without the gas price (it timed out) the score is for gas alone: work it out again next time too.
        if (recs.every((r) => r.complete && r.status !== "recording") && (n == null || n.price != null)) { try { localStorage.setItem(scoreKey(key), JSON.stringify(n)); } catch {} }
        if (live()) showScore(el, n);
      }).catch(() => {}).finally(() => { running--; if (live()) pump(); });
    }
  };
  // Watched through its thumbnail: the ring itself is hidden until there's a score, and a hidden
  // element never comes into view.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); queue.push(en.target.querySelector(".card-score")); }
    pump();
  }, { rootMargin: "300px" });
  // This week's cards are worked out straight away, for the week's total; older ones as they scroll in.
  document.querySelectorAll(".card-score[data-score]").forEach((el) => {
    const known = readScore(el.dataset.score);
    if (known !== undefined) showScore(el, known);
    else if (el.closest("[data-this-week]")) queue.push(el);
    else io.observe(el.parentElement);
  });
  pump();
  onLeave(() => io.disconnect());
}

// Why a trip has no outline: it didn't move, its route is only on the trip page (left out of the
// list's summary), or there's no GPS (yet).
function noRouteLabel(r) {
  if (r.trip) return "Didn't move";
  return r.routeGaps > 0 ? "Route on the trip page" : "No GPS yet";
}

function tripCard(r) {
  const t = r.trip;
  const auto = r.meta.trigger?.startsWith("car_bluetooth");
  return `
    <a class="card trip-card" href="#/r/${esc(r.id)}">
      <div class="thumb">${moved(r) ? Charts.thumbnail(t.path, undefined, undefined, null, t.meters) : `<span class="muted">${noRouteLabel(r)}</span>`}${scoreSlot([r])}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(timeRange(r))}</b>${statusPill(r)}</div>
        <div class="muted">${esc(Places.label([r]) ?? tripName(r.startedWallMs))}${auto ? " · auto-started" : ""}</div>
        ${moved(r) ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          <span class="card-mpg" hidden></span>
          <span class="card-cost" hidden></span>
          ${r.routeGaps ? `<span class="muted" title="Part of this trip's route isn't summarized for the list; the trip page has all of it">partial</span>` : ""}
        </div>` : ""}
        ${r.meta.note ? `<div class="note">${esc(r.meta.note)}</div>` : ""}
      </div>
    </a>`;
}

// Several linked trips in one card: a combined outline (stops between them dotted) and totals, with
// the time spent between them, so an out-and-back visit doesn't read as hours of driving. Its page
// lists each trip.
function outingCard(o) {
  const t = totals(o), first = o[0], last = o.at(-1), parked = Outings.parkedMs(o);
  const pill = o.map(statusPill).find(Boolean) ?? "";
  return `
    <a class="card trip-card outing-card" href="#/outing/${esc(first.id)}">
      <div class="thumb">${Charts.thumbnail(o.filter(moved).map((r) => r.trip.path), undefined, undefined, null, o.filter(moved).map((r) => r.trip.meters)) || `<span class="muted">No GPS yet</span>`}${scoreSlot(o)}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(clock(first.startedWallMs))} – ${esc(clock(endOf(last)))}</b>${pill}</div>
        <div class="muted">${esc(Places.label(o) ?? `${outingName(first.startedWallMs)} · ${plural(legsOf(o).length - 1, "stop")}`)}</div>
        ${t.trips ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          ${parked >= 60000 ? `<span><b>${fmtDur(parked)}</b> parked</span>` : ""}
          <span class="card-mpg" hidden></span>
          <span class="card-cost" hidden></span>
          ${o.some((x) => x.routeGaps) ? `<span class="muted" title="Part of this outing's route isn't summarized for the list; each trip's page has all of it">partial</span>` : ""}
        </div>` : ""}
      </div>
    </a>`;
}

// ---------- points for a trip ----------

// GPS points for one recording, cut off where the drive ended. `onProgress` reports a raw rebuild.
async function tripPoints(id, detail, onProgress, { shared = false } = {}) {
  const { recording: r, chunks } = detail || (await api(`/recordings/${id}`));
  // Summarized chunks give their fixes directly; any without a summary (recorded before the phone
  // made them, recovered after a crash, or trimmed for size) are rebuilt from raw data once.
  let pts = Route.fromChunks(chunks);
  const raw = Route.rawChunks(chunks);
  if (raw.length && !shared) {
    // Keyed by which raw chunks went in, so parts uploaded later get read too.
    const key = `${id}@${raw.map((c) => c.sha256 ?? c.seq).join(",")}`;
    let extra = routeCache.get(key);
    if (!extra) {
      const links = await api(`/recordings/${id}/links`, { method: "POST" });
      extra = await Route.fromRaw(raw.map((c) => links.chunks[c.seq]).filter(Boolean), onProgress);
      routeCache.set(key, extra);
    }
    pts = Route.merge(pts, extra);
  }
  if (!pts.length && shared && raw.length) throw new Error("This trip was recorded before routes were summarized, so it can't be shown on a shared link.");
  const end = r.driveEndWallMs;
  const out = end != null ? pts.filter((p) => p.t <= end) : pts;
  // Engine rows from the chunk summaries; `engineRaw` lists chunks whose engine data is only raw.
  out.engine = Engine.derive(Engine.fromChunks(chunks)).filter((e) => end == null || e.t <= end);
  Engine.calibrate(out.engine, out);
  out.engineRaw = shared ? [] : Engine.rawOnly(chunks); // shared links never get raw chunks
  out.end = end;
  out.ecu = mainEcuOf(r);
  return out;
}

// The trip's outing and repeated journey, found among its owner's trips (all of them, whoever the
// person picker shows). Links that lead to a list switch the picker to that person, so the outing or
// comparison they open has the trip in it.
async function tripContext(r, live) {
  let recordings;
  try {
    ({ recordings } = await allRecordings(r.userId ?? ""));
  } catch (e) {
    if (e.message === "unauthorized") throw e;
    return null; // the page works without it
  }
  const box = document.getElementById("trip-context");
  const rec = recordings.find((x) => x.id === r.id) ?? null;
  if (!live() || !box) return rec;
  const id = r.id;
  const who = Account.whoFor(r.userId);
  // Does the picker's choice already include this trip? ("" is everyone; "me" is the signed-in person.)
  const p = Account.whoParam();
  const shown = p === "" || p === r.userId || (p === "me" && who === "me");
  const sw = shown ? "" : ` data-who="${esc(who)}"`;
  let html = "";
  const o = outingOf(recordings, id);
  if (o && legsOf(o).length > 1) html += stretchNav(o, id, sw);
  // Driven before? Link to its leaderboard.
  const j = Repeats.journeyOf(Repeats.journeys(recordings, Prefs.get("places")).journeys, id);
  if (j) html += `<nav class="outing-nav"><span>One of ${j.trips.length} ${j.towing ? "towing " : ""}trips ${esc(j.loop ? `looping from ${j.from.name}` : `from ${j.from.name} to ${j.to.name}`)}</span><a href="#/routes/${esc(j.key)}"${sw}>Compare them →</a></nav>`;
  if (rec) html += towingNav(rec);
  box.innerHTML = html;
  box.querySelectorAll("[data-who]").forEach((a) => (a.onclick = () => Account.setWho(a.dataset.who)));
  box.querySelectorAll("[data-tow]").forEach((b) => (b.onclick = () => setTowing(rec, b.dataset.tow === "1", b)));
  return rec;
}

// Whether the trip was towing, why Fuelish thinks so, and a way to correct it. Shown for trucks, and
// for any trip marked towing.
function towingNav(r) {
  if (!r.towing && !Engine.physics.isTruck(r.meta?.vehicle) && r.towingSource !== "you") return "";
  const pct = r.towingRatio != null ? Math.round((r.towingRatio - 1) * 100) : null;
  const what = esc(r.meta?.vehicle || "vehicle");
  const why = {
    you: "you marked it",
    detected: r.towing && pct != null ? `it burned about ${pct}% more fuel than this ${what} usually does at the same speeds` : "fuel use was normal for this vehicle",
    before: "it came right after a towing trip",
  }[r.towingSource] ?? "too little to compare with yet";
  return `<nav class="outing-nav towing-nav"><span><b>${r.towing ? "Towing" : "Not towing"}</b> · ${why}. Towing trips are compared only with other towing trips.</span>
    <button type="button" class="link" data-tow="${r.towing ? "0" : "1"}">${r.towing ? "Wasn't towing?" : "Was towing?"}</button></nav>`;
}

// Saves a correction. Agreeing with the detection again removes the correction instead.
async function setTowing(r, towing, btn) {
  btn.disabled = true;
  try {
    await Prefs.update("towing", (cur) => {
      const next = { ...(cur || {}) };
      if (r.towingDetected === towing) delete next[r.id]; else next[r.id] = towing;
      return next;
    });
    route();
  } catch (e) {
    if (e.message === "unauthorized") return;
    btn.disabled = false;
    btn.textContent = `Couldn't save (${e.message}). Try again`;
  }
}

// An outing's page and its trips' pages are one page: this row across the top switches between the
// whole outing and each trip in it. `at` is the trip shown, or null for the whole outing; `sw` switches
// the person picker so the outing found has this trip in it.
function stretchNav(o, at, sw = "") {
  const t = totals(o), legs = legsOf(o);
  const item = (href, label, small, on, extra = "") =>
    `<a href="${href}"${on ? ` aria-current="page"` : ""}${extra}><b>${label}</b><small>${small}</small></a>`;
  return `<nav class="stretches" aria-label="This outing">
    ${item(`#/outing/${esc(o[0].id)}`, "Whole outing", `${plural(legs.length, "trip")}${t.trips ? ` · ${miles(t.meters)}` : ""}`, at == null, sw)}
    ${legs.map((r) => item(`#/r/${esc(r.id)}`, esc(clock(r.startedWallMs)), moved(r) ? miles(r.trip.meters) : esc(noRouteLabel(r).toLowerCase()), at === r.id, ` data-id="${esc(r.id)}"`)).join("")}
  </nav>`;
}

// A trip still recording or uploading: checks for new parts every 30 s while the page is visible
// (and right away on coming back to it), and offers them with a button rather than redrawing the
// map under someone looking at it.
function watchForParts(r, live) {
  const sig = (x) => `${x.status}|${x.chunksReceived}|${x.chunkCount}|${x.updatedAtMs}`;
  const was = sig(r);
  const state = () => document.getElementById("upd-state");
  const show = (html) => { const el = state(); if (el) el.innerHTML = html; };
  const refresh = `<button type="button" class="link" id="upd-go">Refresh</button>`;
  let timer = null, busy = false;
  const check = async () => {
    if (busy || document.hidden || !live()) return;
    busy = true;
    try {
      const { recording: now } = await api(`/recordings/${r.id}`);
      if (!live()) return;
      if (sig(now) !== was) {
        const n = now.chunksReceived - r.chunksReceived;
        show(`<b>${n > 0 ? `${plural(n, "new part")} uploaded` : now.status !== r.status ? "Recording finished" : "Updated"}.</b> ${refresh}`);
        stop(); // nothing more to learn until it's shown
      } else {
        show(`Checked ${esc(clock(Date.now()))}. ${refresh}`);
      }
    } catch (e) {
      if (live() && e.message !== "unauthorized") show(`Couldn't check for new parts. ${refresh}`);
    } finally {
      busy = false;
    }
  };
  const onVisible = () => { if (!document.hidden) check(); };
  const stop = () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  timer = setInterval(check, 30_000);
  document.addEventListener("visibilitychange", onVisible);
  const onClick = (e) => { if (e.target.id === "upd-go") route(); };
  document.addEventListener("click", onClick);
  show(refresh);
  onLeave(() => { stop(); document.removeEventListener("click", onClick); });
}

// Older drives (before the phone summarized engine data): read it from the raw chunks once.
const engineCache = new Map();
async function rawEngine(id, pts, onProgress) {
  if (!pts.engineRaw.length) return [];
  const key = `${id}@${pts.engineRaw.map((c) => c.sha256 ?? c.meta.seq).join(",")}`; // new parts: read again
  if (engineCache.has(key)) return engineCache.get(key);
  const links = await api(`/recordings/${id}/links`, { method: "POST" });
  // The engine ECU, from the recording's discovery: the chunk holding the discovery record may not
  // be among the raw ones read here.
  const rows = Engine.derive(await Engine.fromRaw(pts.engineRaw, pts.engineRaw.map((c) => links.chunks[c.meta.seq]), onProgress, { ecu: pts.ecu }))
    .filter((e) => pts.end == null || e.t <= pts.end);
  Engine.calibrate(rows, pts.length ? pts : Route.fromChunks(pts.chunks || []) || []);
  engineCache.set(key, rows);
  return rows;
}

// Engine-only options (pedal, mpg, gal/h) stay hidden until the drive's engine data is in.
const seg = (key, options) => `<div class="seg" data-key="${key}" role="group">${Object.entries(options)
  .map(([k, v]) => `<button type="button" data-v="${k}"${(v.engine ?? Route.METRICS[k]?.engine) ? " data-engine hidden" : ""}>${esc(typeof v === "string" ? v : v.label)}</button>`).join("")}</div>`;
const fig = (value, label, unit = "") => `<div class="fig"><b>${value}<small>${unit}</small></b><span>${label}</span></div>`;

// Over the map: which view colors the line, whether notable moments are labeled, and the legend.
const mapControls = () => `
  <div class="map-controls">
    <div class="ctl">${seg("view", Route.VIEWS)}<button type="button" class="chip" id="moments-toggle">Labels</button></div>
  </div>
  <div class="map-legend" id="rt-legend"></div>`;

// The side panel: headline numbers, the score and what to change, then the details folded to one
// line each (filled in once engine data is in), then the fine print.
const sidePanel = (middle = "") => `
  <section class="side-sec">
    <div class="figs trip-figs" id="figs"></div>
    <p class="sub-line" id="sub-line"></p>
    <div class="gas-note" id="gas-note" hidden></div>
    <p class="hint" id="engine-status" hidden></p>
  </section>
  <section class="side-sec coach" id="coach" hidden></section>
  ${middle}
  <section class="side-sec folds">
    <details class="fold" id="health" hidden></details>
    <details class="fold" id="split" hidden></details>
    <details class="fold" id="waste" hidden></details>
    <details class="fold" id="trip-cost" hidden></details>
    <details class="fold" id="friction-sec">
      <summary><h2>Friction circle</h2><span id="peaks-sum"></span></summary>
      <div class="fold-body">
        <p class="hint">Each dot is one second: how hard you were speeding up or braking (up and down), and turning (sideways). Smooth driving stays near the middle.</p>
        <div id="friction" class="chart-host"></div>
        <div id="peaks" class="peaks"></div>
      </div>
    </details>
  </section>
  <section class="side-sec about-sec" id="about" hidden>
    <details class="fold">
      <summary><h2>About these numbers</h2></summary>
      <div class="fold-body">${["fuel", "score", "waste", "cost"].map((k) => `<div data-about="${k}"></div>`).join("")}</div>
    </details>
  </section>`;

// Door-to-door time when it's known (one trip), with the moving part under it.
const timeFig = (sm) => (sm.durMs != null && sm.durMs - sm.movingMs >= 60000
  ? fig(fmtDur(sm.durMs), `${fmtDur(sm.movingMs)} moving`) : fig(fmtDur(sm.movingMs), "moving"));

// Headline numbers from the route; mpg and cost fill in when engine data arrives.
function sideRoute(sm, { engine = false, trips = 0 } = {}) {
  const mi = sm.miles.toFixed(sm.miles < 10 ? 1 : 0);
  const avg = sm.avgMph != null ? sm.avgMph.toFixed(0) : "–", top = sm.maxMph != null ? sm.maxMph.toFixed(0) : "–";
  document.getElementById("figs").innerHTML = fig(mi, "miles") + timeFig(sm) +
    (engine ? fig("–", "mpg") + fig("–", "gas") : fig(avg, "mph average") + fig(top, "mph top"));
  document.getElementById("sub-line").textContent = ""; // the map labels top speed and the hardest brake
}

// The driving score's ideal drive (ideal.js) for a drive's fixes with engine rows attached, or null
// without enough engine data. Grades are left out, so the trip list (which doesn't load elevation)
// and the trip page always agree; the drive and its ideal take the same hills, so they mostly cancel.
function idealFor(pts, { e, vehicle = "", towing = false, price = null, timePerHour = 0 }) {
  if (!(e?.coverage >= 0.9)) return null;
  const flat = pts.map((p) => (p.grade == null ? p : { ...p, grade: null }));
  const fit = Ribbon.decompose(flat, { vehicle, towing }).fit;
  return Ideal.plan(flat, fit, { vehicle, towing, richGal: e.fuelUse?.rich ?? 0, price, timePerHour });
}

// The score and what to change, as one list: the score ring (the cheapest way to drive this trip ÷
// what it took, ideal.js), then one line per difference (name, amount, a bar on one scale). The lines
// add up exactly to the gap. A line opens to say what happened and how to change it; the sharpest
// stops are buttons that show the stop on the map.
function coachCard(el, { pts, e, vehicle, towing = false, price, timePerHour = 0, focus }) {
  if (!el) return;
  const r = idealFor(pts, { e, vehicle, towing, price, timePerHour });
  if (!r) { el.hidden = true; return; }
  el.hidden = false;
  const amount = (gal) => (price != null ? money(gal * price) : `${gallons(gal)} gal`);
  const dur = (s) => (Math.abs(s) < 60 ? `${Math.max(1, Math.round(Math.abs(s)))} s` : `${(Math.abs(s) / 60).toFixed(Math.abs(s) < 600 ? 1 : 0)} min`);
  const worth = (l) => (price != null ? Math.abs(l.gal) * price >= 0.005 : Math.abs(l.gal) >= 0.0015);
  const lines = r.lines.filter(worth).sort((a, b) => b.gal - a.gal);
  const rest = r.lines.filter((l) => !worth(l)).reduce((s, l) => s + l.gal, 0);
  const max = Math.max(...lines.map((l) => Math.abs(l.gal)), 1e-9);
  const stops = Coach.braking(pts, vehicle, towing).events.filter((s) => s.avgG > Ideal.DECEL / 9.80665).slice(0, 3);
  const later = (l) => (l.secs <= -1 ? ` The cheaper way takes ${dur(l.secs)} longer${price != null && timePerHour > 0 ? ` (${money((-l.secs / 3600) * timePerHour)} of your time at ${money(timePerHour)}/h)` : ""}.` : "");
  const body = (l) => ({
    rich: `<p>Pressing hard makes the engine run rich, spending fuel beyond what the air needs. A firm but not floored pedal keeps it lean.</p>`,
    idle: `<p>The engine idled ${fmtDur(r.idleSecs * 1000)} in ${plural(r.idleCount, "standstill")} of a minute or more. For waits like that (not traffic lights), switching off after 10 s saves more than the restart uses.</p>`,
    speed: `<p>You drove ${dur(r.aboveMin * 60)} above ${r.cruiseMph} mph (top ${Math.round(r.topMph)}). Holding ${r.cruiseMph} would have used ${amount(l.gal)} less gas.${later(l)} Speed limits and traffic come first.</p>`,
    smooth: `<p>Slowing down late and hard throws away speed the engine paid for. Lifting off sooner lets the car coast most of the way with the fuel cut off; slowing no harder than ${(Ideal.DECEL / 9.80665).toFixed(2)} g would have used ${amount(l.gal)} less gas.${later(l)}${stops.length ? " The sharpest:" : ""}</p>
      ${stops.length ? `<div class="coach-stops">${stops.map((s) => `<button type="button" data-i="${s.peakI}">${Math.round(s.fromMph)}→${Math.round(s.toMph)} mph<small>${s.avgG.toFixed(2)} g</small></button>`).join("")}</div>` : ""}`,
  })[l.key];
  const title = { rich: "Pressing hard", idle: "Long idles", speed: `Above ${r.cruiseMph} mph`, smooth: "Late, hard slowing" };
  const opened = new Set([...el.querySelectorAll("details[data-k]")].filter((d) => d.open).map((d) => d.dataset.k));
  const more = Math.round((r.ratio - 1) * 100);
  el.innerHTML = `<div class="drive-score ${scoreTone(r.score)}">
      <div class="drive-score-num"><b>${r.score}</b><small>driving score</small></div>
      <p>${more < 1 ? `About as little gas as this trip could take: ${amount(r.actual.gal)}.` : `This drive used ${more}% more gas than the cheapest way to drive it: ${amount(r.actual.gal)} against ${amount(r.ideal.gal)}${lines.length ? ". The difference:" : "."}`}</p>
    </div>
    ${lines.length ? `<ul class="coach-list">${lines.map((l) => `<li><details data-k="${l.key}"${opened.has(l.key) ? " open" : ""}>
        <summary><span class="coach-name">${title[l.key]}</span><i class="coach-bar"><i style="width:${Math.max(2, (Math.abs(l.gal) / max) * 100)}%"></i></i><b>${l.gal < 0 ? "−" : ""}${amount(Math.abs(l.gal))}</b></summary>
        <div class="coach-body">${body(l)}</div></details></li>`).join("")}
      ${Math.abs(rest) >= 0.0001 && (price == null || Math.abs(rest) * price >= 0.005) ? `<li class="coach-rest"><span>Smaller things</span><b>${amount(rest)}</b></li>` : ""}</ul>`
      : `<p class="hint">Nothing stood out on this drive: no hard slowing, long idles or fast cruising worth changing.</p>`}`;
  about("score", "The driving score", `<p>The score is the gas the cheapest way to drive this trip would take, divided by the gas it took: 100 means it couldn't have been done on less. The cheapest way drives the same roads with the same stops and is never faster than you were at any point, so traffic, lights and limits you kept to hold it back too. It differs only in what you control: no fuel beyond what the air needed, the engine off after 10 s of standstills over a minute, cruising no faster than ${r.cruiseMph} mph (${r.cheapestMph > r.cruiseMph ? `counting your time, faster would be cheaper still, up to ${r.cheapestMph} mph, but the ideal keeps to 70` : r.cheapestMph < r.cruiseMph ? `the least gas would be at ${r.cheapestMph} mph, but the ideal keeps to 55 or more` : "the cheapest steady speed counting your time"}), and slowing early and gently (${(Ideal.DECEL / 9.80665).toFixed(2)} g at most). Its gas comes from this drive's own fit of fuel against the power to roll, push the air and speed up, scaled to the fuel the engine reported, so errors in the fit mostly cancel. Time it loses before a short stop comes off the wait there: a red light waits either way. The lines are worked out in order, each on top of the one before, so they add up to the difference. The route itself isn't judged.</p>`);
  el.onclick = (ev) => {
    const stop = ev.target.closest("[data-i]");
    if (stop) focus(Number(stop.dataset.i));
  };
}

// The side panel's detail sections are folded to one line each: the title and its key number.
// Re-filling one (when the gas price arrives) keeps it open or closed as the person left it.
function setFold(id, title, summary, body, openAtFirst = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.dataset.filled ? el.open : openAtFirst;
  el.dataset.filled = "1";
  el.hidden = false;
  el.innerHTML = `<summary><h2>${title}</h2><span>${summary}</span></summary><div class="fold-body">${body}</div>`;
  el.open = open;
}

// The fine print, gathered at the bottom of the side panel: one paragraph per topic, in a fixed order.
function about(key, title, html) {
  const slot = document.querySelector(`#about [data-about="${key}"]`);
  if (!slot) return;
  slot.innerHTML = `<h3>${esc(title)}</h3>${html}`;
  document.getElementById("about").hidden = false;
}

// Highway vs town, where the fuel went, trip cost, car health: everything that needs the engine.
function sideEngine(sm, e, { gas = null, partial = false, trip = null, vehicle = trip?.meta?.vehicle ?? "", towing = !!trip?.towing, coach = null } = {}) {
  const figs = document.getElementById("figs");
  if (!figs) return;
  if (coach) coachCard(document.getElementById("coach"), { ...coach, e, vehicle, towing, price: gas?.price ?? null, timePerHour: gas ? timeFor(trip) : 0 });
  const cost = (g) => (gas ? money(g * gas.price) : null);
  const mi = sm.miles.toFixed(sm.miles < 10 ? 1 : 0);
  // With fuel readings over less of the drive, mpg is only for the part they cover, and gas for the
  // whole drive is that part plus the rest at the same mpg (marked ≈).
  const thin = e.coverage < 0.95 || e.extrapolated;
  const galShown = e.galTrip ?? e.gal;
  const epa = Engine.epa(vehicle);
  figs.innerHTML = fig(mi, "miles") + timeFig(sm) +
    fig(e.mpg != null ? (thin ? "≈" : "") + e.mpg.toFixed(0) : "–", epa ? `mpg · EPA ${epa.comb}` : "mpg") +
    fig(galShown != null && gas ? (thin ? "≈" : "") + cost(galShown) : "–", galShown != null ? `for ${gallons(galShown)} gal` : "gas");
  // Where the numbers come from, folded away behind one short line; warnings about missing data stay out.
  const note = document.getElementById("gas-note");
  const aboutFuel = [e.fromCar ? "Fuel as reported by the car." : "Fuel is estimated from airflow, the air-fuel target and the engine's fuel trims (this car doesn't report fuel use), not a pump reading."];
  if (epa) aboutFuel.push(`EPA rates this car ${epa.city} city, ${epa.hwy} highway and ${epa.comb} combined.`);
  if (gas) aboutFuel.push(`Gas at ${money(gas.price)}/gal, the ${gas.regionName} regional average for the week of ${new Date(gas.weekMs).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })} (U.S. EIA).`);
  const warn = [];
  if (thin && e.gal != null) warn.push(e.coverage < 0.5
    ? `Engine readings cover only ${Math.round(e.coverage * 100)}% of this drive's miles, so its mpg and gas are rough.`
    : `Engine readings cover ${Math.round(e.coverage * 100)}% of this drive's miles; mpg is for that part, and gas for the rest is filled in at the same mpg.`);
  if (partial) warn.push("Some of these trips have no engine data and aren't counted.");
  note.hidden = !warn.length;
  note.innerHTML = warn.length ? `<p class="hint">${esc(warn.join(" "))}</p>` : "";
  about("fuel", "Fuel and gas price", `<p>${esc(aboutFuel.join(" "))}</p>`);

  // Highway vs town: economy bars on one scale.
  const parts = [["Highway", `${Engine.HIGHWAY_MPH}+ mph`, e.highway, epa?.hwy], ["Town", `under ${Engine.HIGHWAY_MPH} mph`, e.town, epa?.city]].filter(([, , g]) => g.gal > 0.001);
  if (parts.length) {
    const max = Math.max(1, ...parts.map(([, , g]) => g.mpg ?? 0));
    setFold("split", "Highway vs town", (parts.length === 1 ? parts[0][0].toLowerCase() + " " : "") + parts.map(([, , g]) => (g.mpg != null ? g.mpg.toFixed(0) : "–")).join(" / ") + " mpg", `
      <div class="split">${parts.map(([name, note, g, rated]) => `
        <div class="split-row">
          <div class="split-name"><b>${name}</b><span>${note}</span>${rated ? `<span>EPA ${rated}</span>` : ""}</div>
          <div class="split-bar"><i style="width:${((g.mpg ?? 0) / max) * 100}%"></i></div>
          <div class="split-val"><b>${g.mpg != null ? g.mpg.toFixed(0) : "–"}<small>mpg</small></b><span>${g.miles.toFixed(g.miles < 10 ? 1 : 0)} mi · ${gallons(g.gal)} gal</span></div>
        </div>`).join("")}</div>`);
  }

  // Where the fuel went: one bar of the measured fuel, idling and enrichment marked. Braking is
  // energy, not fuel, and only an estimate, so it's listed under the bar, not inside it.
  if (e.fuelUse && e.gal) {
    const u = e.fuelUse;
    const kinds = [
      ["drive", "Driving", Math.max(0, e.gal - u.idle - u.rich), "moving at the ideal air-fuel ratio"],
      ["rich", "Enrichment", u.rich, "fuel beyond the ideal air-fuel ratio, mostly hard acceleration"],
      ["idle", "Idling", u.idle, `engine running at 0 mph for ${fmtDur(e.idleMs)} (counted where readings exist)`],
    ];
    const pct = (g) => Math.min(100, Math.max(0, (g / e.gal) * 100));
    const top2 = kinds.filter(([, , g]) => pct(g) >= 1).sort((x, y) => y[2] - x[2]).slice(0, 2);
    setFold("waste", "Where the fuel went", top2.map(([, label, g]) => `${Math.round(pct(g))}% ${label.toLowerCase()}`).join(" · "), `
      <p class="sec-meta">${gallons(e.gal)} gal · ${esc(Engine.fuelLabel(e))}</p>
      <div class="waste-bar" role="img" aria-label="${esc(kinds.map(([, label, g]) => `${label} ${Math.round(pct(g))}%`).join(", "))}">${kinds.map(([k, , g]) => `<i class="w-${k}" style="flex-grow:${g}"></i>`).join("")}</div>
      <dl class="waste-list">${kinds.map(([k, label, g, why]) => `
        <div><dt><i class="sw w-${k}"></i>${label}<small>${why}</small></dt><dd>${gallons(g)} gal${cost(g) ? ` · ${cost(g)}` : ""} · ${Math.round(pct(g))}%</dd></div>`).join("")}
        ${e.cutMs >= 30000 ? `<div><dt><i class="sw w-cut"></i>Coasting, fuel off<small>the engine cut fuel entirely while you coasted</small></dt><dd>${fmtDur(e.cutMs)} · 0 gal</dd></div>` : ""}</dl>`);
    about("waste", "Where the fuel went", `
        <p>${e.fromCar ? "Fuel use is as reported by the car." : `This car doesn't report fuel use, so it's estimated from the air flowing into the engine and the air-fuel ratio the engine asks for${e.perSample ? ", reading by reading" : ""}, corrected by the engine's fuel trims (how much fuel it adds or removes beyond what the airflow sensor implies).`}
        ${e.speedFactor !== 1 ? `Miles use the car's speed, which read ${Math.abs((1 - 1 / e.speedFactor) * 100).toFixed(1)}% ${e.speedFactor > 1 ? "low" : "high"} against GPS on this drive, corrected.` : "Miles use the car's own speed."}</p>`);
  }

  // What this trip cost, counting more than gas.
  if (trip && typeof Costs !== "undefined") {
    const c = Costs.tripParts({ trip, sm, e, gas });
    setFold("trip-cost", "What it cost", c.summary, c.body);
    about("cost", "What it cost", c.about);
  }

  // Car health in one line; anything wrong comes first and stands out.
  const bad = [], ok = [];
  if (e.mil != null) (e.mil || e.dtcs ? bad : ok).push(e.mil ? `Check engine light on${e.dtcs ? `, ${plural(e.dtcs, "code")}` : ""}` : e.dtcs ? `${plural(e.dtcs, "stored code")}` : "Check engine light off");
  if (Number.isFinite(e.volts[0]) && Number.isFinite(e.volts[1])) {
    const v = `charging ${e.volts[0].toFixed(1)}–${e.volts[1].toFixed(1)} V`;
    (e.volts[0] < 12.8 || e.volts[1] > 15.2 ? bad : ok).push(v);
  }
  if (e.warmMs != null) ok.push(`warmed up in ${fmtDur(e.warmMs)}`);
  else if (e.coolant[1] != null) ok.push(`coolant ${Engine.cToF(e.coolant[1]).toFixed(0)} °F`);
  if (e.fuelLevel != null) ok.push(`tank ${e.fuelLevel.toFixed(0)}%`);
  if (e.maxRpm) ok.push(`top ${Math.round(e.maxRpm).toLocaleString()} rpm`);
  if (bad.length || ok.length) {
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    setFold("health", "Car health", bad.length ? `<b class="bad">${esc(cap(bad[0]))}</b>` : "All good",
      `<p class="health">${[...bad.map((x) => `<b class="bad">${esc(cap(x))}</b>`), ...ok.map((x, i) => esc(!bad.length && !i ? cap(x) : x))].join(" · ")}</p>`, bad.length > 0);
  }
}

// Labels for the map: the moments most worth a look. Engine ones (best and thirstiest minute) need p.eng.
function momentsFor(pts, sm) {
  const out = [];
  const arg = (f) => { let b = -1, bv = -Infinity; pts.forEach((p, i) => { const v = f(p); if (v != null && v > bv) { bv = v; b = i; } }); return [b, bv]; };
  const [ib, brake] = arg((p) => (p.a != null ? -p.a / Route.G : null));
  if (brake >= 0.15) out.push({ i: ib, text: `Hardest brake ${brake.toFixed(2)} g` });
  const [ia, acc] = arg((p) => (p.a != null ? p.a / Route.G : null));
  if (acc >= 0.15) out.push({ i: ia, text: `Hardest acceleration ${acc.toFixed(2)} g` });
  const [it, turn] = arg((p) => (p.side != null ? Math.abs(p.side) / Route.G : null));
  if (turn >= 0.2) out.push({ i: it, text: `Sharpest turn ${turn.toFixed(2)} g ${pts[it].side > 0 ? "right" : "left"}` });
  const [iv, top] = arg((p) => (p.v != null ? p.v * Route.MPH : null));
  if (top > 5) out.push({ i: iv, text: `Top speed ${top.toFixed(0)} mph` });
  const longest = [...sm.stops].sort((a, b) => b.ms - a.ms)[0];
  if (longest && longest.ms >= 20000) out.push({ i: longest.i0, text: `Stopped ${fmtDur(longest.ms)}` });
  // Rolling one-minute economy while moving (at least 0.2 mi in the minute).
  let best = null, worst = null, j = 0, mi = 0, gal = 0;
  const step = (p, q) => (q.t - p.t <= 3000 && p.trip === q.trip && q.eng?.speed != null && q.eng.fuelGs != null
    ? [(q.eng.speed / 3.6) * ((q.t - p.t) / 1000) / 1609.344, (q.eng.fuelGs * (q.t - p.t)) / 1000 / 745 / 3.78541] : null);
  for (let i = 1; i < pts.length; i++) {
    const d = step(pts[i - 1], pts[i]);
    if (!d) { j = i; mi = gal = 0; continue; }
    mi += d[0]; gal += d[1];
    while (pts[i].t - pts[j].t > 60000) {
      const o = step(pts[j], pts[j + 1]);
      if (o) { mi -= o[0]; gal -= o[1]; }
      j++;
    }
    if (pts[i].t - pts[j].t < 55000 || mi < 0.2 || gal <= 0) continue;
    const mpg = mi / gal, mid = (i + j) >> 1;
    if (!best || mpg > best.mpg) best = { i: mid, mpg };
    if (!worst || mpg < worst.mpg) worst = { i: mid, mpg };
  }
  // Only the thirstiest: the best minute is nearly always a long downhill coast, which says nothing
  // about the driving.
  if (best && worst && best.mpg - worst.mpg > 5) out.push({ i: worst.i, text: `Thirstiest minute ${worst.mpg.toFixed(0)} mpg` });
  // Moments within about 300 m of each other share one label.
  const merged = [];
  for (const m of out) {
    const near = merged.find((x) => Route.haversine(pts[x.i].lat, pts[x.i].lon, pts[m.i].lat, pts[m.i].lon) < 300);
    if (near) near.text += "<br>" + m.text; else merged.push({ ...m });
  }
  return merged;
}

// ---------- one trip ----------

// `share` is a share-link token: the trip is shown read-only, without anything that needs signing in.
async function showTrip(id, share = null, focusT = null) {
  const live = current();
  const detail = await api(share ? `/shared/${share}` : `/recordings/${id}`);
  if (!live()) return;
  const { recording: r } = detail;
  id = r.id;
  const m = r.meta;
  const pills = [share ? `<span class="pill">Shared trip</span>` : "", statusPill(r), m.vehicle ? `<span class="pill">${esc(m.vehicle)}</span>` : ""].join("");
  const day = new Date(r.startedWallMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });


  app.innerHTML = `
    <div class="trip">
      <header class="trip-head">
        ${share ? "" : `<a href="#/" class="back">← Trips</a>`}
        <h1>${esc(tripName(r.startedWallMs))}</h1>
        <p class="muted">${esc(day)} · ${esc(timeRange(r))}</p>
        <div class="pills">${pills}${!share && Account.canShare(r) ? `<div class="share" id="share"></div><button type="button" class="pill del-btn" id="del-trip">Delete…</button>` : ""}</div>
        <div id="trip-context"></div>
        ${r.status === "recording" ? `<p class="hint" id="upd">Still recording; the route fills in as parts upload. <span id="upd-state"></span></p>`
          : !r.complete ? `<p class="hint" id="upd">${r.chunksReceived} of ${r.chunkCount ?? "?"} parts uploaded so far; the phone sends the rest on Wi-Fi. <span id="upd-state"></span></p>` : ""}
        ${m.note ? `<p class="note">${esc(m.note)}</p>` : ""}
      </header>
      <section class="trip-map">
        <div id="map"></div>
        ${mapControls()}
        <div class="readout" id="readout" hidden></div>
        <div class="map-status" id="rt-status">Loading route…</div>
      </section>
      <aside class="trip-side">${sidePanel(share ? "" : `<section class="side-sec places-sec" id="places-sec" hidden></section>`)}</aside>
    </div>`;

  if (!share && Account.canShare(r)) {
    shareControls(id);
    const del = document.getElementById("del-trip");
    del.onclick = async () => {
      if (!confirm("Delete this trip? Its route, engine data and share links come off the server for good. If the phone still has a copy, it lets it go too.")) return;
      del.disabled = true;
      try {
        await api(`/recordings/${id}`, { method: "DELETE" });
        location.hash = "#/";
      } catch (e) {
        del.disabled = false;
        if (e.message !== "unauthorized") alert(`Couldn't delete it: ${e.message}`);
      }
    };
  }
  // Not awaited: the route doesn't wait for it. It also says whether the trip was towing, which the
  // engine figures then take into account.
  const context = share ? Promise.resolve(null) : tripContext(r, live);
  if (!share && (r.status === "recording" || !r.complete)) watchForParts(r, live);
  const status = document.getElementById("rt-status");
  const pts = await tripPoints(id, detail, (i, n) => {
    if (status) status.innerHTML = `Building the detailed route… <progress max="${n}" value="${i}"></progress>`;
  }, { shared: !!share });
  if (!live()) return; // navigated away meanwhile
  if (pts.length < 2) return engineOnly(r, pts, status, live);
  status.remove();
  const sm = Route.summary(pts);
  sm.durMs = endOf(r) - r.startedWallMs;
  sideRoute(sm, { engine: pts.engine.length > 0 || pts.engineRaw.length > 0 });
  const view = drawRoute(pts, sm);
  if (!share) placesSection(pts, sm, view, live, { retitle: (l) => { document.querySelector(".trip-head h1").textContent = l ?? tripName(r.startedWallMs); } });
  if (focusT != null) {
    // Opened at a moment (from Insights): zoom there and hold the cursor on it.
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.t - focusT) < Math.abs(pts[best].t - focusT)) best = i; });
    view.map.setView([pts[best].lat, pts[best].lon], 17);
    view.focusAt = best;
  }
  // Engine results don't wait for the gas price; the cost fills in when (if) it arrives.
  const engineOpts = { gas: null, vehicle: m.vehicle, towing: false, trip: r };
  let engineRows = pts.engine;
  const showEngine = () => {
    if (!engineRows.length || !live()) return;
    view.setEngine(engineRows, engineOpts);
    if (view.focusAt != null) view.pick(view.focusAt); // again, now with engine values in the readout
  };
  if (view.focusAt != null) view.pick(view.focusAt);
  showEngine();
  context.then((rec) => {
    if (rec?.towing && live()) { r.towing = true; engineOpts.towing = true; showEngine(); }
  });
  withTimeout(Gas.forTrip(pts[0].lat, pts[0].lon, r.startedWallMs), 8000).then((gas) => {
    if (gas && live()) { engineOpts.gas = gas; showEngine(); }
  });
  if (pts.engineRaw.length) {
    // Chunks whose engine data is only raw (older drives, recovered or trimmed chunks): read them
    // once and merge with whatever the summaries gave.
    const st = document.getElementById("engine-status");
    st.hidden = false;
    try {
      const rows = await rawEngine(id, pts, (i, n) => {
        st.innerHTML = `Reading engine data from the raw recording… <progress max="${n}" value="${i}"></progress>`;
      });
      if (!live()) return;
      st.hidden = true;
      engineRows = Engine.merge(pts.engine, rows);
      Engine.calibrate(engineRows, pts);
      showEngine();
    } catch (e) {
      if (e.message !== "unauthorized" && live()) st.innerHTML = `<span class="bad">Couldn't read the engine data: ${esc(e.message)}</span>`;
    }
  }
}

// Where the drive (one trip, an outing, a day or a week) started, stopped and ended, each with a
// name to type. Named places are labeled on the map, and the place whose name is being edited is
// ringed there. The names are shared with Compare and describe trips in the list ("Home → Aldi");
// `retitle(label)` (optional) puts the description in the page title.
//
// On a page of several drives, `drives` (Map: pts' trip index -> its recordings) puts each drive in the
// list too, after the place it set off from: a link to its page that brings it forward on the map.
function placesSection(pts, sm, view, live, { retitle = null, withDay = false, drives = null, failed = [] } = {}) {
  const host = document.getElementById("places-sec");
  if (!host) return;
  const when = (t) => clock(t); // a week's list has day headings
  const what = { start: "Started", stop: "Stopped", end: "Ended" };
  const draw = (focusI = null) => {
    const vs = Places.visitsOfPoints(pts, sm.stops);
    retitle?.(Places.labelOf(vs));
    view.places(vs);
    view.highlightPlace(null);
    host.hidden = false;
    // A week's list gets a heading where the day changes: at a place, or at a drive setting off.
    let lastDay = "";
    const heading = (t) => {
      const day = withDay ? dayLabel(t) : "";
      if (!day || day === lastDay) return "";
      lastDay = day;
      return `<div class="row-day">${esc(day)}</div>`;
    };
    const rows = vs.map((v, i) => {
      const head = heading(v.t);
      const recs = drives && v.leaves != null ? drives.get(v.leaves) || [] : [];
      const drive = recs.length ? heading(recs[0].startedWallMs) + driveRow(recs, vs.find((x) => x.arrives === v.leaves)?.t) : "";
      return `${head}
        <label class="place-row${drives && v.along ? " along" : ""}"><span>${what[v.kind]} <small>${esc(when(v.t))}${v.ms ? ` · ${fmtDur(v.ms)}` : ""}</small></span>
          <input value="${esc(v.name ?? "")}" placeholder="Name this place" data-i="${i}" maxlength="80"></label>${drive}`;
    }).join("");
    host.innerHTML = `<h2>${drives ? `${plural([...drives.values()].filter((x) => x.length).length, "trip")} · places` : "Places"}</h2>
      <div class="place-rows">${rows}</div>
      ${failed.length ? `<p class="hint bad">${plural(failed.length, "trip")} (${failed.map((r) => esc(clock(r.startedWallMs))).join(", ")}) couldn't load; reload to try again.</p>` : ""}
      <p class="hint" id="places-note">Names are shared with Compare and every browser.</p>`;
    host.querySelectorAll("input").forEach((inp) => {
      const k = +inp.dataset.i;
      inp.addEventListener("focus", () => view.highlightPlace(k));
      inp.addEventListener("blur", () => view.highlightPlace(null));
      inp.closest(".place-row").addEventListener("mouseenter", () => view.highlightPlace(k));
      inp.closest(".place-row").addEventListener("mouseleave", () => { if (document.activeElement !== inp) view.highlightPlace(null); });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
      inp.addEventListener("change", async () => {
        const v = vs[k];
        // Where focus went (Tab to the next field), to put it back after redrawing.
        const next = () => [...host.querySelectorAll("input")].indexOf(document.activeElement);
        inp.disabled = true;
        try {
          await Places.rename(v.lat, v.lon, inp.value.trim());
        } catch (e) {
          if (e.message === "unauthorized" || !live()) return;
          inp.disabled = false;
          document.getElementById("places-note").innerHTML = `<span class="bad">Couldn't save: ${esc(e.message)}</span>`;
          return;
        }
        if (!live()) return;
        const go = next();
        draw();
        if (go >= 0) host.querySelectorAll("input")[go]?.focus();
      });
    });
  };
  draw();
}

// One drive in the places list: when, how far, how long. Several recordings carried on as one drive
// (an app update in the middle) are one row, linked to the first. It ends when the drive arrived.
function driveRow(recs, arrivedT = null) {
  const m = recs.filter(moved), r = recs[0], last = recs.at(-1);
  const t = totals(recs);
  return `<a class="trip-row drive-row" href="#/r/${esc(r.id)}" data-id="${esc(r.id)}">
    <b>${esc(clock(r.startedWallMs))} – ${esc(clock(arrivedT ?? endOf(last)))}</b>
    <span>${m.length ? `${miles(t.meters)} · ${fmtDur(t.movingMs)}${recs.some((x) => x.routeGaps) ? " · partial" : ""}` : noRouteLabel(r).toLowerCase()}</span></a>`;
}

// A recording without a usable GPS track (parked warm-up, garage start, location off) can still
// have engine data: show that instead of an empty page.
async function engineOnly(r, pts, status, live) {
  let rows = pts.engine;
  if (pts.engineRaw.length) {
    try { rows = Engine.merge(rows, await rawEngine(r.id, pts, (i, n) => { status.innerHTML = `Reading engine data from the raw recording… <progress max="${n}" value="${i}"></progress>`; })); }
    catch (e) { if (e.message === "unauthorized") throw e; }
    if (!live()) return;
  }
  if (!rows.length) {
    status.textContent = "No location and no engine data were recorded on this drive.";
    return;
  }
  status.textContent = "Location wasn't recorded on this drive. Its engine data is beside the map.";
  document.querySelectorAll(".map-controls, #rt-legend").forEach((el) => { el.style.display = "none"; });
  const e = Engine.summary(rows, { vehicle: r.meta.vehicle, towing: !!r.towing, tripMs: endOf(r) - r.startedWallMs });
  let movingMs = 0, maxKmh = null;
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt <= 2500 && rows[i].speed > 1) movingMs += dt;
    if (rows[i].speed != null && (maxKmh == null || rows[i].speed > maxKmh)) maxKmh = rows[i].speed;
  }
  const sm = { miles: e.miles, movingMs, stops: [], peak: { brake: 0, accel: 0, corner: 0 }, avgMph: null, maxMph: maxKmh != null ? Engine.mph(maxKmh) : null };
  const gas = await withTimeout(Gas.forTrip(null, null, r.startedWallMs), 8000);
  if (!live()) return;
  sideEngine(sm, e, { gas, trip: r });
  document.getElementById("sub-line").textContent = `${fmtDur(endOf(r) - r.startedWallMs)} recorded · miles from the car's speedometer${sm.maxMph != null ? ` · top ${sm.maxMph.toFixed(0)} mph` : ""}`;
  document.getElementById("friction-sec")?.setAttribute("hidden", "");
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]).catch(() => null);

// Share link for one trip: a small button by the pills that opens a panel to create, copy or stop it.
async function shareControls(id) {
  const box = document.getElementById("share");
  const linkOf = (t) => `${location.origin}/#/s/${t}`;
  const who = "Anyone with the link can see this trip without signing in: the route, including where it starts and ends, and its engine data.";
  const render = (tok, open = false) => {
    if (!document.getElementById("share")) return;
    const wrap = (label, body) => `<details class="share-pop"${open ? " open" : ""}><summary class="pill share-btn${tok ? " on" : ""}">${label}</summary><div class="share-box">${body}</div></details>`;
    if (!tok) {
      box.innerHTML = wrap("Share…", `<p class="hint">${who}</p><button type="button" class="primary" id="share-on">Create link</button>`);
      box.querySelector("#share-on").onclick = async () => {
        try { render((await api(`/recordings/${id}/shares`, { method: "POST" })).token, true); }
        catch (e) { box.querySelector(".share-box").insertAdjacentHTML("beforeend", `<p class="bad">${esc(e.message)}</p>`); }
      };
      return;
    }
    box.innerHTML = wrap("Shared", `
        <div class="share-row"><input readonly value="${esc(linkOf(tok))}" aria-label="Share link"><button type="button" class="primary" id="share-copy">Copy</button></div>
        <p class="hint">${who}</p>
        <button type="button" class="ghost" id="share-off">Stop sharing</button>`);
    const input = box.querySelector("input");
    input.onclick = () => input.select();
    box.querySelector("#share-copy").onclick = async (e) => {
      try { await navigator.clipboard.writeText(input.value); e.target.textContent = "Copied"; }
      catch { input.select(); }
    };
    box.querySelector("#share-off").onclick = async () => {
      await api(`/recordings/${id}/shares/${tok}`, { method: "DELETE" });
      render(null, true);
    };
  };
  const close = (e) => {
    const pop = box.querySelector(".share-pop[open]");
    if (pop && (e.key === "Escape" || (e.type === "pointerdown" && !pop.contains(e.target)))) pop.open = false;
  };
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", close);
  onLeave(() => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); });
  try {
    const { shares } = await api(`/recordings/${id}/shares`);
    render(shares.at(-1)?.token ?? null);
  } catch {
    box.innerHTML = "";
  }
}

// ---------- insights across all drives ----------

async function showInsights() {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  app.innerHTML = `
    <div class="insights">
      <a href="#/" class="back">← Trips</a>
      <h1>Insights</h1>
      <p class="muted" id="ins-sub">Loading engine data…</p>
      <div id="ins"></div>
    </div>`;
  const sub = document.getElementById("ins-sub");
  const trips = await engineTrips(recordings, live, (msg) => { if (sub) sub.textContent = msg; });
  if (!live()) return;
  if (!trips.length) {
    sub.textContent = "No drives with engine data yet. They show up here once the phone records with the OBD adapter connected.";
    return;
  }
  const first = trips[0].r.startedWallMs, last = trips.at(-1).r.startedWallMs;
  const d = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  sub.textContent = `${plural(trips.length, "drive")} with engine data${first === last ? `, ${d(first)}` : `, ${d(first)} – ${d(last)}`}.${failedNote(trips)}`;
  // Towing and unloaded driving each get their own curves: mixed, neither would describe either.
  const towed = trips.filter((t) => t.r.towing);
  if (!towed.length || towed.length === trips.length) {
    if (towed.length) sub.textContent += " All of them towing.";
    Insights.render(document.getElementById("ins"), trips);
    return;
  }
  const host = document.getElementById("ins");
  host.insertAdjacentHTML("beforebegin", `<div class="seg ins-tow" role="group"><button type="button" data-tow="0" aria-pressed="true">Not towing (${trips.length - towed.length})</button><button type="button" data-tow="1" aria-pressed="false">Towing (${towed.length})</button></div>`);
  const pick = (tow) => {
    document.querySelectorAll(".ins-tow button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tow === (tow ? "1" : "0"))));
    Insights.render(host, trips.filter((t) => !!t.r.towing === tow));
  };
  document.querySelectorAll(".ins-tow button").forEach((b) => (b.onclick = () => pick(b.dataset.tow === "1")));
  pick(false);
}

// ---------- repeated trips, costs, transmission ----------

async function showRoutes(key) {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  const data = Repeats.journeys(recordings, Prefs.get("places"));
  if (!key) {
    app.innerHTML = `<div class="insights"><a href="#/" class="back">← Trips</a><h1>Repeated trips</h1>
      <p class="muted">Drives between the same two places, to see which went best and which way is cheaper.</p><div id="rep"></div></div>`;
    const draw = (d) => Repeats.overview(document.getElementById("rep"), d, {
      endOf,
      rename: async (lat, lon, name, input) => {
        const near = (p) => Route.haversine(p.lat, p.lon, lat, lon) < 250;
        input.closest(".place").dataset.state = "saving";
        try {
          await Prefs.update("places", (places) => {
            const list = (places || []).filter((p) => !near(p));
            if (name) list.push({ lat, lon, name: name.slice(0, 80) });
            return list;
          });
        } catch (e) {
          if (e.message === "unauthorized" || !live()) return;
          input.closest(".place").dataset.state = "failed";
          input.title = `Couldn't save: ${e.message}. Edit it again to retry.`;
          return;
        }
        // Redraw in place, keeping the scroll position, focus, and any name still being typed elsewhere.
        if (!live()) return;
        const inputs = () => [...document.querySelectorAll(".place input")];
        const key = (el) => `${el.dataset.lat},${el.dataset.lon}`;
        const typing = new Map(inputs().filter((el) => el !== input && el.value !== el.defaultValue).map((el) => [key(el), el.value]));
        const focused = inputs().indexOf(document.activeElement);
        draw(Repeats.journeys(recordings, Prefs.get("places")));
        for (const el of inputs()) if (typing.has(key(el))) el.value = typing.get(key(el));
        if (focused >= 0) inputs()[focused]?.focus({ preventScroll: true });
      },
    });
    draw(data);
    return;
  }
  const j = Repeats.journeyOf(data.journeys, key);
  if (!j) throw new Error("That trip isn't part of a repeated journey (yet).");
  app.innerHTML = `<div class="insights"><a href="#/routes" class="back">← Repeated trips</a><h1>${esc(Repeats.title(j))}</h1>
    <p class="muted" id="rep-sub">${plural(j.trips.length, "trip")} · loading engine data…</p><div id="rep"></div></div>`;
  const sub = document.getElementById("rep-sub");
  const trips = await engineTrips(j.trips, live, (msg) => { if (sub) sub.textContent = `${plural(j.trips.length, "trip")} · ${msg.toLowerCase()}`; });
  if (!live()) return;
  sub.textContent = `${plural(j.trips.length, "trip")}, ${new Date(j.trips[0].startedWallMs).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(j.trips.at(-1).startedWallMs).toLocaleDateString([], { month: "short", day: "numeric" })}`;
  const engine = new Map(trips.map((t) => [t.r.id, { e: Engine.summary(t.rows, { vehicle: t.r.meta.vehicle, towing: !!t.r.towing, ...t.scope }), gas: t.gas }]));
  const rows = Repeats.score(j, engine, endOf);
  let boardKey = "gal";
  try { boardKey = localStorage.getItem("fuelish.board") || "gal"; } catch {}
  const draw = () => Repeats.board(document.getElementById("rep"), j, rows, {
    boardKey,
    onBoard: (k) => { boardKey = k; try { localStorage.setItem("fuelish.board", k); } catch {} draw(); },
  });
  draw();
}

async function showCosts() {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  app.innerHTML = `<div class="insights"><a href="#/" class="back">← Trips</a><h1>Costs</h1>
    <p class="muted" id="cost-sub">Loading engine data…</p><div id="costs"></div></div>`;
  const sub = document.getElementById("cost-sub");
  const done = recordings.filter((r) => r.status !== "recording");
  const trips = await engineTrips(done, live, (msg) => { if (sub) sub.textContent = msg; });
  if (!live()) return;
  sub.textContent = `What driving costs you, counting more than gas, and where you can spend less.${failedNote(trips)}`;
  // Count the drives left out directly; subtracting totals went negative when a recording that
  // never moved still had engine data (it's in `trips` but not in the moved count).
  const counted = new Set([...trips.map((t) => t.r.id), ...trips.failed.map((r) => r.id)]);
  Costs.page(document.getElementById("costs"), trips, {
    durationOf: (r) => endOf(r) - r.startedWallMs,
    otherTrips: done.filter((r) => moved(r) && !counted.has(r.id)).length,
    me: Account.meId(),
    save: (key, change) => Prefs.update(key, change),
    onLeave,
  });
}

async function showCvt() {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  app.innerHTML = `<div class="insights"><a href="#/" class="back">← Trips</a><h1>Transmission</h1>
    <p class="muted" id="cvt-sub">Loading engine data…</p><div id="cvt"></div></div>`;
  const sub = document.getElementById("cvt-sub");
  const trips = await engineTrips(recordings.filter((r) => r.status !== "recording"), live, (msg) => { if (sub) sub.textContent = msg; }, { gas: false });
  if (!live()) return;
  sub.textContent = `How the CVT picks engine speed, from the engine's own readings.${failedNote(trips)}`;
  Cvt.render(document.getElementById("cvt"), trips);
}

// Every drive with engine data, oldest first: [{ r, rows, gas, scope }], plus `.failed` (recordings
// whose data couldn't be loaded, so they aren't mistaken for drives without engine data). Rows come
// from the summaries, merged with a raw rebuild of chunks that only have raw engine data. Loaded a
// few at a time and kept for this session, so Insights, Costs, Transmission and Repeated trips share
// them. Gas prices are fetched once, waited for once, and only when `gas` is asked for.
const tripRowsCache = new Map(); // `${id}@${updatedAtMs}@${chunksReceived}` -> rows (null: no engine data)

// Results worked out from a trip's data, kept in this browser between visits (IndexedDB), so pages
// that cover every trip read each one from the server once. A stored copy counts only if the scripts
// that made it are the ones running now (a digest of their text), so changing them redoes them all.
// Anything going wrong here just means working it out again. Cleared on sign-out.
const Kept = (() => {
  const STORES = ["engineRows", "stops"];
  let dbP = null;
  const open = () => dbP ||= new Promise((res) => {
    try {
      const req = indexedDB.open("fuelish", 2);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => res(req.result);
      req.onerror = req.onblocked = () => res(null);
    } catch { res(null); }
  });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const digest = (files) => Promise.all(files.map((f) => fetch(f).then((r) => (r.ok ? r.text() : Promise.reject(new Error(f))))))
    .then(async (texts) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texts.join("\0"))))].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(""))
    .catch(() => null);
  // Arrays can carry properties of their own (engine rows: calibrated, shiftMs) that storing would drop.
  const extras = (v) => (Array.isArray(v) ? Object.fromEntries(Object.keys(v).filter((k) => !/^\d+$/.test(k)).map((k) => [k, v[k]])) : null);
  /** A store whose entries are good while `files` are unchanged. */
  function store(name, files) {
    let verP = null;
    const version = () => verP ||= digest(files);
    return {
      async get(key) {
        try {
          const [db, v] = await Promise.all([open(), version()]);
          if (!db || !v) return undefined;
          const hit = await req(db.transaction(name).objectStore(name).get(key));
          if (!hit || hit.v !== v) return undefined;
          return hit.value && hit.extras ? Object.assign(hit.value, hit.extras) : hit.value;
        } catch { return undefined; }
      },
      async put(key, value) {
        try {
          const [db, v] = await Promise.all([open(), version()]);
          if (db && v) await req(db.transaction(name, "readwrite").objectStore(name).put({ v, value, extras: extras(value) }, key));
        } catch {}
      },
    };
  }
  async function clear() {
    try {
      const db = await open();
      if (db) for (const s of STORES) await req(db.transaction(s, "readwrite").objectStore(s).clear());
    } catch {}
  }
  return { store, clear };
})();
const RowStore = Kept.store("engineRows", ["engine.js", "route.js"]);

async function engineTrips(recordings, live, onStatus = () => {}, { gas = true } = {}) {
  const asc = [...recordings].sort((a, b) => a.startedWallMs - b.startedWallMs);
  const found = new Array(asc.length).fill(null), failed = [];
  let done = 0, next = 0;
  const status = () => onStatus(`Loading engine data… ${done} of ${asc.length} trips${failed.length ? ` (${failed.length} couldn't load)` : ""}`);
  status();
  await Promise.all(Array.from({ length: Math.min(4, asc.length) }, async () => {
    while (next < asc.length && live()) {
      const i = next++, r = asc[i], key = `${r.id}@${r.updatedAtMs}@${r.chunksReceived}`;
      try {
        let rows = tripRowsCache.get(key);
        if (rows === undefined) {
          rows = await RowStore.get(key);
          if (rows !== undefined) tripRowsCache.set(key, rows);
        }
        if (rows === undefined) {
          // Only engine data is needed here, not the route.
          const { recording, chunks } = await api(`/recordings/${r.id}`);
          rows = null;
          if (Engine.recorded(chunks)) {
            const end = r.driveEndWallMs;
            rows = Engine.derive(Engine.fromChunks(chunks)).filter((e) => end == null || e.t <= end);
            const raw = Engine.rawOnly(chunks);
            if (raw.length) {
              const more = await rawEngine(r.id, { engineRaw: raw, end, chunks, ecu: mainEcuOf(recording) }, (k, n) => onStatus(`Reading engine data from a raw recording… ${k} of ${n}`));
              rows = Engine.merge(rows, more);
            }
            if (rows.length) Engine.calibrate(rows, Route.fromChunks(chunks));
            else rows = null;
          }
          tripRowsCache.set(key, rows);
          // A trip still uploading changes again soon: keep it for this visit only.
          if (r.complete && r.status !== "recording") RowStore.put(key, rows);
        }
        if (rows) found[i] = { r, rows, gas: null, scope: { tripMiles: r.trip ? r.trip.meters / 1609.344 : null, tripMs: endOf(r) - r.startedWallMs } };
      } catch (e) {
        if (e.message === "unauthorized") throw e;
        failed.push(r);
      }
      done++;
      status();
    }
  }));
  const trips = found.filter(Boolean);
  if (gas && trips.length) {
    // One wait for the shared price table; after that each lookup is immediate.
    const ok = await withTimeout(Gas.forTrip(null, null, Date.now()), 8000);
    if (ok) for (const t of trips) {
      const start = t.r.trip?.path?.[0];
      t.gas = await Gas.forTrip(start?.[0], start?.[1], t.r.startedWallMs);
    }
  }
  trips.failed = failed;
  return trips;
}
const mainEcuOf = (r) => r?.meta?.summary?.obd?.discovery?.mainEcu || null;
const failedNote = (trips) => (trips.failed?.length ? ` ${plural(trips.failed.length, "trip")} couldn't be loaded and ${trips.failed.length === 1 ? "isn't" : "aren't"} counted; reload to try again.` : "");

// ---------- several recordings as one drive ----------

// Points and engine rows for recordings shown together (an outing, a day, a week), oldest first. Each
// recording's points are tagged with its index so the map and the braking estimate keep them apart;
// a recording an app update cut short and the one that carried the drive on share the first one's
// index (one line, ticks counting on). Engine data comes from the summaries and, for older drives,
// the raw recording, as on one trip's page. A recording that can't load is listed in `failed` and
// left out. `drivingMs` is door-to-door time summed over the recordings, without the stops between.
async function loadDrive(recs, { onProgress = () => {}, live = () => true } = {}) {
  const drive = [];
  recs.forEach((r, i) => { drive[i] = i && continues(recs[i - 1], r) ? drive[i - 1] : i; });
  const lists = new Array(recs.length).fill([]), engines = new Array(recs.length).fill([]), failed = [];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(4, recs.length) }, async () => {
    while (next < recs.length && live()) {
      const i = next++;
      try {
        const tp = await tripPoints(recs[i].id);
        let rows = tp.engine;
        if (tp.engineRaw.length) {
          try {
            rows = Engine.merge(rows, await rawEngine(recs[i].id, tp));
            Engine.calibrate(rows, tp);
          } catch (e) { if (e.message === "unauthorized") throw e; }
        }
        engines[i] = rows;
        lists[i] = tp.map((p) => ({ ...p, trip: drive[i] }));
      } catch (e) {
        if (e.message === "unauthorized") throw e;
        failed.push(recs[i]);
      }
      onProgress(++done, recs.length);
    }
  }));
  return {
    drive, lists, engines, failed,
    pts: lists.flat(), rows: engines.flat(),
    drivingMs: recs.reduce((n, r) => n + (endOf(r) - r.startedWallMs), 0),
  };
}

// ---------- stops ----------

// Each trip's stops (Stops.events), kept in this browser like engine rows; null: no engine data.
const StopStore = Kept.store("stops", ["engine.js", "route.js", "ribbon.js", "stops.js"]);
async function tripStops(r) {
  const key = `${r.id}@${r.updatedAtMs}@${r.chunksReceived}`;
  const kept = await StopStore.get(key);
  if (kept !== undefined) return kept;
  const d = await loadDrive([r]);
  if (d.failed.length) throw new Error("couldn't load");
  let evs = null;
  if (d.rows.length && d.pts.length > 1) {
    Engine.attach(d.pts, d.rows);
    evs = Stops.events(d.pts, Ribbon.decompose(d.pts, { vehicle: r.meta.vehicle ?? "", towing: !!r.towing }));
  }
  if (r.complete && r.status !== "recording") StopStore.put(key, evs);
  return evs;
}

// Where stopping costs the most, over every drive with engine data (whose trips: the header picker).
async function showStops() {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  const recs = recordings.filter((r) => r.trip && moved(r)).sort((a, b) => a.startedWallMs - b.startedWallMs);
  app.innerHTML = `
    <div class="trip trip-many stops-page">
      <header class="trip-head">
        <a href="#/" class="back">← Trips</a>
        <h1>Stops</h1>
        <p class="muted" id="stops-sub">Where stopping costs you the most: gas burned waiting and getting back up to speed, and time lost against driving straight through.</p>
      </header>
      <section class="trip-map">
        <div id="map"></div>
        <div class="map-legend">${Stops.legendHtml()}</div>
        <div class="map-status" id="rt-status">${recs.length ? "Loading trips…" : "No trips yet."}</div>
      </section>
      <aside class="trip-side"><section class="side-sec" id="stops-list"></section></aside>
    </div>`;
  if (!recs.length) return;
  const status = document.getElementById("rt-status");
  let done = 0, next = 0;
  const all = [], failed = [];
  let engineTrips = 0;
  await Promise.all(Array.from({ length: Math.min(4, recs.length) }, async () => {
    while (next < recs.length && live()) {
      const r = recs[next++];
      try {
        const evs = await tripStops(r);
        if (evs) {
          engineTrips++;
          const start = r.trip?.path?.[0];
          const gas = await withTimeout(Gas.forTrip(start?.[0], start?.[1], r.startedWallMs), 8000);
          const perHour = Costs.personTime(r.userId);
          for (const e of evs) all.push({ ...e, trip: r.id, price: gas?.price ?? null, perHour });
        }
      } catch (e) {
        if (e.message === "unauthorized") throw e;
        failed.push(r);
      }
      done++;
      if (status) status.innerHTML = `Loading trips… <progress max="${recs.length}" value="${done}"></progress>`;
    }
  }));
  if (!live()) return;
  const groups = Stops.places(all);
  if (!groups.length) {
    status.textContent = engineTrips ? "No stops along the way yet (starts, ends and errands don't count)." : "No trips with engine data yet.";
    return;
  }
  status.remove();
  // A stop at a named place is called by it; elsewhere, how far and which way from the nearest one.
  const named = Prefs.get("places") || [];
  const name = (g) => {
    let best = null, bd = 5000;
    for (const p of named) { const d = Route.haversine(p.lat, p.lon, g.lat, g.lon); if (d < bd) { bd = d; best = p; } }
    if (!best) return null;
    if (bd <= 60) return best.name;
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const y = g.lat - best.lat, x = (g.lon - best.lon) * Math.cos((g.lat * Math.PI) / 180);
    const dir = dirs[Math.round(((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 / 45) % 8];
    const mi = bd / 1609.344;
    return `${mi < 0.1 ? `${Math.round(bd / 0.3048 / 10) * 10} ft` : `${mi.toFixed(1)} mi`} ${dir} of ${best.name}`;
  };
  const minutes = (ms) => (ms >= 60000 ? fmtDur(ms) : `${Math.round(ms / 1000)} s`);
  const costOf = (g) => (g.priced ? Costs.money(g.dollars) : `${Engine.galOf(g.g).toFixed(3)} gal`);
  const label = (g, k) => `${esc(name(g) ?? `Stop ${k + 1}`)}<br>${plural(g.n, "stop")} · ${esc(costOf(g))} gas · ${esc(minutes(g.lostMs))} lost<br>usually ${esc(minutes(Stops.median(g.waits)))} waiting`;
  const view = Stops.map(document.getElementById("map"), groups, label);
  onLeave(() => view.map.remove());
  const ro = new ResizeObserver(() => view.map.invalidateSize());
  ro.observe(document.getElementById("map"));
  onLeave(() => ro.disconnect());

  const totalGas = groups.reduce((a, g) => a + g.dollars, 0), totalTime = groups.reduce((a, g) => a + g.lostMs, 0), n = groups.reduce((a, g) => a + g.n, 0);
  const anyTime = groups.some((g) => g.timeDollars > 0);
  document.getElementById("stops-sub").textContent =
    `${plural(n, "stop")} at ${plural(groups.length, "place")} over ${plural(engineTrips, "trip")}: ${groups.every((g) => g.priced) ? Costs.money(totalGas) : "some"} in gas and ${fmtDur(totalTime)} lost.` +
    (failed.length ? ` ${plural(failed.length, "trip")} couldn't load; reload to try again.` : "");
  const top = groups.slice(0, 25);
  document.getElementById("stops-list").innerHTML = `<h2>Costliest places to stop</h2>
    <ol class="stops-rows">${top.map((g, k) => `<li><button type="button" class="stop-row" data-k="${k}">
      <span class="stop-name"><b>${esc(name(g) ?? `Stop ${k + 1}`)}</b><small class="muted">${plural(g.n, "stop")}${g.trips.size > 1 ? ` on ${plural(g.trips.size, "trip")}` : ""} · usually ${esc(minutes(Stops.median(g.waits)))}</small></span>
      <span class="stop-cost"><b>${esc(anyTime && g.priced ? Costs.money(g.dollars + g.timeDollars) : costOf(g))}</b><small class="muted">${anyTime && g.priced ? `${esc(Costs.money(g.dollars))} gas + ${esc(Costs.money(g.timeDollars))} time` : "gas"} · ${esc(minutes(g.lostMs))}</small></span>
    </button></li>`).join("")}</ol>
    <p class="hint">Gas is what burned waiting plus what it took to get back up to speed. Time is what each stop lost against carrying on at the speed you had${anyTime ? ", valued at what your time is worth on the Costs page" : ""}. Name a place on any trip page and it's named here too.</p>`;
  document.getElementById("stops-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (b) view.focus(+b.dataset.k);
  });
}

// What an hour of the driver's time is worth ($), from the Costs page: it sets the ideal's cruising speed.
const timeFor = (r) => (r && typeof Costs !== "undefined" ? Costs.forTrip(r).timePerHour : 0);

// The driving score and gas cost of recordings taken as one drive, worked out the same way as on
// their page: { score, gal, mpg, price, cost, approx } (approx: fuel readings don't cover all of it), or
// null without enough engine data.
async function driveFigures(recs) {
  const d = await loadDrive(recs);
  if (!d.rows.length || d.pts.length < 2) return null;
  const vehicle = recs[0].meta.vehicle ?? "", towing = recs.some((r) => r.towing);
  const e = Engine.summary(d.rows, { vehicle, towing, tripMiles: Route.summary(d.pts).miles, tripMs: d.drivingMs });
  const gal = e.galTrip ?? e.gal, start = recs.find((r) => r.trip?.path?.length)?.trip.path[0];
  const gas = gal != null ? await withTimeout(Gas.forTrip(start?.[0], start?.[1], recs[0].startedWallMs), 8000) : null;
  Engine.attach(d.pts, d.rows);
  const score = idealFor(d.pts, { e, vehicle, towing, price: gas?.price ?? null, timePerHour: gas ? timeFor(recs[0]) : 0 })?.score ?? null;
  return {
    score, gal, mpg: e.mpg ?? null, price: gas?.price ?? null,
    cost: gas ? gal * gas.price : null,
    approx: e.coverage < 0.95 || !!e.extrapolated,
  };
}

// The colored ring around a score: green from 90, amber from 75, red below.
const scoreTone = (n) => (n >= 90 ? "good" : n >= 75 ? "ok" : "low");

// ---------- several trips: a day, a week, or an outing ----------

async function showMany(kind, key) {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  let recs, title, sub, prev = null, next = null;
  const outing = kind === "outing";
  if (outing) {
    recs = outingOf(recordings, key);
    if (!recs) throw new Error("That outing isn't in the trip list.");
    // One trip is an outing of one: its own page is the whole of it.
    if (legsOf(recs).length <= 1) { location.replace(`#/r/${(legsOf(recs)[0] ?? recs[0]).id}`); return; }
    const day = new Date(recs[0].startedWallMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    title = Places.label(recs) ?? outingName(recs[0].startedWallMs);
    const parked = Outings.parkedMs(recs);
    sub = `${day} · ${clock(recs[0].startedWallMs)} – ${clock(endOf(recs.at(-1)))}${parked >= 60000 ? ` · ${fmtDur(parked)} parked` : ""}`;
  } else {
    const from = kind === "day" ? parseYmd(key) : weekStart(+parseYmd(key));
    const to = addDays(from, kind === "day" ? 1 : 7);
    recs = recordings.filter((r) => r.startedWallMs >= +from && r.startedWallMs < +to).sort((a, b) => a.startedWallMs - b.startedWallMs);
    const step = kind === "day" ? 1 : 7;
    prev = `#/${kind}/${ymd(addDays(from, -step))}`;
    if (+to <= Date.now()) next = `#/${kind}/${ymd(to)}`;
    if (kind === "day") {
      title = dayLabel(+from);
      sub = daysAgo(+from) <= 1 ? from.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) : "";
    } else {
      const f = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
      title = +from === +weekStart(Date.now()) ? "This week" : `Week of ${f(from)}`;
      sub = `${f(from)} – ${f(addDays(to, -1))}`;
    }
  }
  const placesHost = `<section class="side-sec places-sec" id="places-sec" hidden></section>`;
  const nav = prev || next ? `<nav class="period-nav">
      ${prev ? `<a href="${prev}">← Earlier</a>` : ""}${next ? `<a href="${next}">Later →</a>` : ""}</nav>` : "";

  // The trips are listed with the places, once the route is in (see placesSection). Trips whose route
  // the list can't see (routeGaps) still go on the map: it loads full routes.
  const shown = recs.filter((r) => r.trip || r.routeGaps > 0);

  app.innerHTML = `
    <div class="trip trip-many">
      <header class="trip-head">
        <a href="#/" class="back">← Trips</a>
        <h1>${esc(title)}</h1>
        ${sub ? `<p class="muted">${esc(sub)}</p>` : ""}
        ${outing && recs[0].meta.vehicle ? `<div class="pills"><span class="pill">${esc(recs[0].meta.vehicle)}</span></div>` : ""}
        ${outing ? stretchNav(recs, null) : nav}
      </header>
      <section class="trip-map">
        <div id="map"></div>
        ${shown.length ? mapControls() : ""}
        <div class="readout" id="readout" hidden></div>
        <div class="map-status" id="rt-status">${shown.length ? "Loading trips…" : `No trips ${kind === "day" ? "this day" : "this week"}.`}</div>
      </section>
      <aside class="trip-side">
        ${shown.length ? sidePanel(placesHost) : ""}
      </aside>
    </div>`;
  if (!shown.length) return;

  const status = document.getElementById("rt-status");
  const progress = (done) => { if (status) status.innerHTML = `Loading trips… <progress max="${shown.length}" value="${done}"></progress>`; };
  progress(0);
  const d = await loadDrive(shown, { onProgress: progress, live });
  if (!live()) return;
  const { drive, lists, engines, pts } = d;
  for (const r of d.failed) document.querySelector(`.stretches [data-id="${CSS.escape(r.id)}"] small`)?.insertAdjacentText("beforeend", " · couldn't load the route");
  if (pts.length < 2) {
    status.textContent = "Not enough GPS fixes to draw a route.";
    return;
  }
  status.remove();
  const sm = Route.summary(pts);
  // Time is driving time, door to door for each trip; the stops between them aren't driving.
  sm.durMs = d.drivingMs;
  sideRoute(sm, { engine: engines.some((e) => e.length), trips: new Set(drive).size });
  const view = drawRoute(pts, sm, { withDay: kind === "week" });
  // Each drive's recordings, for its row in the list; ones that never moved aren't listed.
  const drives = new Map();
  shown.forEach((r, i) => { if (!(r.trip && !moved(r))) (drives.get(drive[i]) || drives.set(drive[i], []).get(drive[i])).push(r); });
  placesSection(pts, sm, view, live, {
    withDay: kind === "week", drives, failed: d.failed,
    retitle: outing ? (l) => { document.querySelector(".trip-head h1").textContent = l ?? outingName(recs[0].startedWallMs); } : null,
  });
  if (d.rows.length) {
    const gas = await withTimeout(Gas.forTrip(pts[0].lat, pts[0].lon, shown[0].startedWallMs), 8000);
    if (!live()) return;
    // Scored and costed as one drive: the trips back to back, without the stops.
    const whole = { ...shown[0], startedWallMs: 0, driveEndWallMs: d.drivingMs };
    view.setEngine(d.rows, { partial: engines.some((e, i) => !e.length && lists[i].length), gas, vehicle: shown[0].meta.vehicle, towing: shown.some((r) => r.towing), trip: whole });
  }

  // Hovering a trip in the list (or an outing's trip in the row up top) brings it forward on the map.
  // Listened for on the page, since the list is redrawn when a place is named.
  const index = new Map(shown.map((r, i) => [r.id, drive[i]]));
  const rowOf = (e) => e.target.closest?.(".trip-row, .stretches [data-id]");
  const page = document.querySelector(".trip-many");
  for (const [on, off] of [["mouseover", "mouseout"], ["focusin", "focusout"]]) {
    page.addEventListener(on, (e) => { const a = rowOf(e); if (a) view.focus(index.get(a.dataset.id)); });
    page.addEventListener(off, (e) => { const a = rowOf(e); if (a && !a.contains(e.relatedTarget)) view.focus(null); });
  }
}

// Small amounts of fuel and money need more digits than big ones.
const gallons = (g) => (g < 0.1 ? g.toFixed(3) : g < 10 ? g.toFixed(2) : g.toFixed(1));
const money = (d) => (d < 10 ? "$" + d.toFixed(2) : "$" + Math.round(d).toLocaleString());

// ---------- map, charts and controls (shared) ----------

function drawRoute(pts, sm, { withDay = false } = {}) {
  // `view` is the saved choice; none saved yet means Spend on drives with engine data, else Speed.
  // (A choice of the old default, Cost, saved before Spend existed moves to the new default once.)
  // `marks`: ticks across the route every minute ("min"), every so much gas ("gas"), or none ("off").
  let state = { view: null, labels: true, marks: "min" };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    const old = saved.view === "cost" && !saved.spend;
    state = { view: Route.VIEWS[saved.view] && !old ? saved.view : null, labels: saved.labels ?? true, marks: ["min", "gas", "off"].includes(saved.marks) ? saved.marks : "min" };
  } catch {}
  // One drive's readout says how far into it a moment is; marks count on through every trip shown.
  const oneTrip = Route.tripRanges(pts).length === 1;
  let price = null;
  // The Spend view: gas split by cause (ribbon.js), drawn as a band beside the route; `ribbonOnly`
  // is the one cause shown alone (null: all).
  let ribbon = null, ribbonLayer = null, ribbonOnly = null, ribbonOpts = null, terrain = null;
  // Grades come from elevation tiles a moment later; the band is split again with them.
  const splitRibbon = () => { if (ribbonOpts) ribbon = Ribbon.decompose(pts, ribbonOpts); };

  // What's drawn: the chosen view, except engine views on a drive without engine data.
  let hasEngine = false;
  const shownState = {};
  const effective = () => {
    const want = state.view ?? (hasEngine ? "spend" : "speed");
    const view = Route.VIEWS[want].engine && !hasEngine ? "speed" : want;
    const marks = state.marks === "gas" && !hasEngine ? "min" : state.marks;
    return Object.assign(shownState, { view, color: Route.VIEWS[view].color, width: "none", labels: state.labels, marks });
  };
  effective();

  const readout = document.getElementById("readout");
  const fmt = (x, d, u) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d) + u);
  let views = [];
  const pick = (i) => {
    for (const v of views) v.highlight(i);
    if (i < 0) { readout.hidden = true; return; }
    const p = pts[i];
    readout.hidden = false;
    readout.innerHTML = `
      <div class="readout-time">${new Date(p.t).toLocaleString([], { weekday: withDay ? "short" : undefined, hour: "numeric", minute: "2-digit", second: "2-digit" })}${oneTrip ? ` · ${Math.floor((p.t - pts[0].t) / 60000)} min in` : ""}</div>
      <div class="readout-speed">${fmt(p.v != null ? p.v * Route.MPH : null, 0, "")}<small> mph</small></div>
      <dl>
        <dt>${p.a == null ? "Accel" : p.a < 0 ? "Braking" : "Speeding up"}</dt><dd>${fmt(p.a != null ? Math.abs(p.a) / Route.G : null, 2, " g")}</dd>
        <dt>Turning</dt><dd>${fmt(p.side != null ? Math.abs(p.side) / Route.G : null, 2, " g")}${p.side != null && Math.abs(p.side) / Route.G >= 0.03 ? (p.side > 0 ? " right" : " left") : ""}</dd>
        ${p.eng ? `<dt>Gas pedal</dt><dd>${fmt(p.eng.pedal, 0, "%")}</dd>
        <dt>Economy</dt><dd>${p.eng.mpg == null ? "–" : p.eng.mpg >= 99 ? "coasting" : fmt(p.eng.mpg, 0, " mpg")}</dd>
        ${p.eng.rel != null ? `<dt>Fuel/mi, 20 s</dt><dd>${esc(Route.METRICS.cost.fmt(p.eng.rel))}${Math.abs(p.eng.rel - 1) >= 0.005 ? " than usual" : ""}</dd>` : ""}
        <dt>Fuel</dt><dd>${p.eng.cut ? "cut off" : fmt(p.eng.gph, 2, " gal/h")}</dd>
        <dt>RPM</dt><dd>${fmt(p.eng.rpm, 0, "")}</dd>` : ""}
        ${ribbon && shownState.view === "spend" ? Ribbon.readoutHtml(ribbon, i, price) : ""}
      </dl>`;
  };

  const mapEl = document.getElementById("map");
  const view = Route.render(mapEl, pts, shownState, pick);
  const friction = Charts.frictionCircle(document.getElementById("friction"), pts, pick);
  views = [{ highlight: (i) => view.mark(i) }, friction];

  const pk = sm.peak;
  document.getElementById("peaks-sum").textContent = friction.count ? `${Math.max(Math.abs(pk.brake), pk.accel, pk.corner).toFixed(2)} g peak` : "";
  document.getElementById("peaks").innerHTML = friction.count
    ? `<div><span>Braking</span><b>${Math.abs(pk.brake).toFixed(2)} g</b></div><div><span>Speeding up</span><b>${pk.accel.toFixed(2)} g</b></div><div><span>Turning</span><b>${pk.corner.toFixed(2)} g</b></div>`
    : `<p class="muted">Not enough moving GPS fixes here.</p>`;

  // Ticks: a minute apart (wide on the highway, bunched in town, stacked at stops) or a few cents
  // of gas apart (wide where the car sips, bunched on climbs and hard starts). Every fifth is longer
  // and labeled.
  let gasStep = null;
  const drawMarks = () => {
    gasStep = null;
    if (shownState.marks === "min") {
      view.ticks(Route.minuteMarks(pts).map((m) => ({ ...m, major: m.n % 5 === 0, label: `${m.n}` })));
    } else if (shownState.marks === "gas") {
      const g = Route.gasMarks(pts, price);
      gasStep = g && { step: g.step, unit: g.unit };
      const lab = (v) => (g.unit === "$" ? (v < 1 ? `${Math.round(v * 100)}¢` : `$${Number.isInteger(+v.toFixed(2)) ? Math.round(v) : v.toFixed(2)}`) : `${+v.toFixed(3)} gal`);
      view.ticks(g ? g.marks.map((m) => ({ ...m, major: m.n % 5 === 0, label: lab(m.n * g.step) })) : []);
    } else view.ticks([]);
  };
  const stepName = (g) => (g.unit === "$" ? (g.step < 1 ? `${Math.round(g.step * 100)}¢` : "$1") : `${g.step} gal`);
  const marksSwitch = () => {
    const every = shownState.marks === "min" ? "Every minute" : gasStep ? `Every ${stepName(gasStep)} of gas` : "";
    const opts = [["min", "Minutes"], ...(hasEngine ? [["gas", "Gas"]] : []), ["off", "Off"]];
    return `<div class="marks-switch">${every ? `<span class="marks-key"><i></i>${esc(every)}</span>` : ""}<div class="seg marks" role="group" aria-label="Marks along the route">${opts.map(([k, l]) =>
      `<button type="button" data-marks="${k}" aria-pressed="${shownState.marks === k}">${l}</button>`).join("")}</div></div>`;
  };
  const legend = () => {
    document.getElementById("rt-legend").innerHTML =
      (shownState.view === "spend" && ribbon ? Ribbon.legendHtml(ribbon, price, ribbonOnly) : Route.legendHtml(shownState, pts)) + marksSwitch();
  };
  // The band shows only on the Spend view, over the plain route.
  const syncRibbon = () => {
    if (shownState.view === "spend" && ribbon) {
      if (!ribbonLayer) ribbonLayer = Ribbon.layer(ribbon);
      else ribbonLayer.setData(ribbon);
      if (!view.map.hasLayer(ribbonLayer)) ribbonLayer.addTo(view.map);
    } else if (ribbonLayer) ribbonLayer.remove();
  };
  document.getElementById("rt-legend").addEventListener("click", (e) => {
    const c = e.target.closest("[data-cause]");
    if (c) {
      ribbonOnly = ribbonOnly === c.dataset.cause ? null : c.dataset.cause;
      ribbonLayer?.only(ribbonOnly);
      legend();
      return;
    }
    const b = e.target.closest("[data-marks]");
    if (!b) return;
    state.marks = b.dataset.marks;
    effective(); drawMarks(); legend(); save();
  });
  const recolor = () => { effective(); view.redraw(); syncRibbon(); drawMarks(); legend(); };
  // Notable moments, labeled on the map (again with engine ones once that data is in).
  view.moments(momentsFor(pts, sm));
  const labels = document.getElementById("moments-toggle");
  const syncLabels = () => { labels.setAttribute("aria-pressed", String(!!state.labels)); view.showMoments(!!state.labels); };
  labels.onclick = () => { state.labels = !state.labels; syncLabels(); save(); };
  syncLabels();
  const save = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...state, spend: true })); } catch {} };
  const syncButtons = () => document.querySelectorAll(".map-controls .seg").forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(shownState[g.dataset.key] === b.dataset.v))));
  document.querySelectorAll(".map-controls .seg").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[g.dataset.key] = b.dataset.v;
    recolor();
    syncButtons();
    save();
  }));
  syncButtons();
  recolor();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", recolor);
  // The map's container changes size with the layout (e.g. rotating a phone).
  const ro = new ResizeObserver(() => view.map.invalidateSize());
  ro.observe(mapEl);
  onLeave(() => { mq.removeEventListener("change", recolor); ro.disconnect(); view.map.remove(); });

  // Engine data arrives with the route, or later for older drives read from raw chunks.
  function setEngine(rows, { partial = false, gas = null, vehicle = "", towing = false, trip = null } = {}) {
    if (!rows.length || !document.getElementById("map")) return;
    Engine.attach(pts, Engine.relCost(Engine.smoothMpg(rows)));
    hasEngine = true;
    price = gas?.price ?? null;
    ribbonOpts = { vehicle, towing };
    splitRibbon();
    terrain ||= Terrain.attach(pts).then((n) => {
      if (!n || !document.getElementById("map")) return;
      splitRibbon();
      syncRibbon();
      legend();
    }).catch(() => {});
    document.querySelectorAll("[data-engine]").forEach((b) => { b.hidden = false; });
    recolor();
    syncButtons();
    view.moments(momentsFor(pts, sm));
    // Coverage is against the whole drive: its GPS miles, and for one trip its door-to-door time.
    const scope = { tripMiles: sm.miles, tripMs: trip ? endOf(trip) - trip.startedWallMs : null };
    // Coaching and the score need `trip`: one recording, or several taken as one drive.
    const coach = trip ? { pts, focus: (i) => { view.map.setView([pts[i].lat, pts[i].lon], Math.max(view.map.getZoom(), 16)); pick(i); } } : null;
    sideEngine(sm, Engine.summary(rows, { vehicle, towing, ...scope }), { gas, partial, trip, vehicle, towing, coach });
  }

  return { ...view, setEngine, pick };
}

window.addEventListener("hashchange", route);
route();
