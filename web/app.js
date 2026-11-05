// Fuelish web: the list of trips, one trip's route map and friction circle,
// and map views of several trips at once (a day, a week, or one outing of linked trips).
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

// Trips are one outing when the next starts within this long of the last one ending, near where it ended.
const OUTING_GAP_MS = 30 * 60000;
const OUTING_NEAR_M = 500;

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
async function allRecordings(user = Account.whoParam()) {
  let all = [], before = null;
  for (;;) {
    const q = [user ? `user=${encodeURIComponent(user)}` : "", before != null ? `before=${encodeURIComponent(before)}` : ""].filter(Boolean).join("&");
    const page = await api("/recordings" + (q ? "?" + q : ""));
    all = all.concat(page.recordings);
    if (page.next == null || !page.recordings.length) return { recordings: all };
    before = page.next;
  }
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
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// Settings saved on the server for every browser (place names, cost assumptions). Loaded once.
// Loading: one request shared by everyone waiting; a failure falls back to defaults for that page
// only and is retried on the next. Saving: writes go one at a time, and the stored value changes
// only once the server has it (a failed save throws, for the caller to show).
const Prefs = (() => {
  let data = null, loading = null, failed = false, queue = Promise.resolve();
  async function load() {
    if (data) return data;
    loading ||= api("/prefs").then((b) => { data = b.prefs || {}; failed = false; Costs.use(data.costs); return data; })
      .catch((e) => { if (e.message === "unauthorized") throw e; failed = true; Costs.use(null); return {}; })
      .finally(() => { loading = null; });
    return loading;
  }
  // `change(current)` runs when this save's turn comes, against the value the saves before it left,
  // so two quick edits to one setting (naming two places) both stick.
  function update(key, change) {
    const run = queue.then(async () => {
      const value = change(data?.[key]);
      await api(`/prefs/${key}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      (data ||= {})[key] = value;
    });
    queue = run.catch(() => {});
    return run;
  }
  const set = (key, value) => update(key, () => value);
  const clear = () => { data = null; loading = null; failed = false; };
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

function haversine([la1, lo1], [la2, lo2]) {
  const k = Math.PI / 180, dLa = (la2 - la1) * k, dLo = (lo2 - lo1) * k;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * k) * Math.cos(la2 * k) * Math.sin(dLo / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// Groups recordings into outings: runs of trips by the same phone where each starts soon after
// the previous one ended, close to where it ended (errands, a fuel stop). Oldest first within each.
function outings(recordings) {
  const asc = [...recordings].sort((a, b) => a.startedWallMs - b.startedWallMs);
  const open = new Map(); // device -> its latest outing
  const out = [];
  for (const r of asc) {
    const cur = open.get(r.deviceId), prev = cur?.at(-1);
    if (prev && linked(prev, r)) cur.push(r);
    else { const o = [r]; out.push(o); open.set(r.deviceId, o); }
  }
  return out;
}
function linked(a, b) {
  if (a.status === "recording") return false;
  const gap = b.startedWallMs - endOf(a);
  if (gap > OUTING_GAP_MS) return false;
  const end = a.trip?.path?.at(-1), start = b.trip?.path?.[0];
  return !end || !start || haversine(end, start) <= OUTING_NEAR_M;
}
// `b` carries on the drive `a` was recording when an app update ended it: the phone says so
// (meta.resumes, from 0.1.44), or, before that, `a` was cut off and `b` started within a minute.
function continues(a, b) {
  if (b.meta?.resumes) return b.meta.resumes === a.id;
  return a.status === "interrupted" && a.deviceId === b.deviceId && b.startedWallMs - endOf(a) <= 60000;
}
const outingOf = (all, id) => outings(all).find((o) => o.some((r) => r.id === id));

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
  const section = h.startsWith("#/routes") ? "routes" : h.startsWith("#/costs") ? "costs" : h.startsWith("#/insights") ? "insights" : h.startsWith("#/cvt") ? "cvt" : h.startsWith("#/account") ? "account" : "trips";
  const nav = document.getElementById("main-nav");
  nav.hidden = false;
  nav.querySelectorAll("a").forEach((a) => (a.dataset.section === section ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const trip = h.match(/^#\/r\/([A-Za-z0-9_-]+)(?:\/(\d+))?/);
  const insights = h.startsWith("#/insights");
  const routes = h.match(/^#\/routes(?:\/([A-Za-z0-9_.-]+))?/);
  const cvt = h.startsWith("#/cvt");
  const costs = h.startsWith("#/costs");
  const account = h.startsWith("#/account");
  const many = h.match(/^#\/(day|week)\/(\d{4}-\d{2}-\d{2})/) || h.match(/^#\/(outing)\/([A-Za-z0-9_-]+)/);
  document.body.classList.toggle("page-trip", !!(trip || many));
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
    else if (many) await showMany(many[1], many[2]);
    else await showList();
  } catch (e) {
    if (e.message !== "unauthorized" && live()) app.innerHTML = `<p class="bad loading">${esc(e.message)}</p>`;
  }
}

// ---------- trip list ----------

async function showList() {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  if (!recordings.length) {
    app.innerHTML = `<div class="empty"><h1>No trips yet</h1><p class="muted">Trips show up here once the phone uploads them (on Wi-Fi, or when you tap Upload now).</p></div>`;
    return;
  }
  const thisWeek = weekStart(Date.now());
  const wk = totals(recordings.filter((r) => r.startedWallMs >= +thisWeek));

  // Newest first: days, and the outings within each day (an outing belongs to the day it started).
  const groups = [];
  for (const o of outings(recordings).reverse()) {
    const label = dayLabel(o[0].startedWallMs);
    if (groups.at(-1)?.label !== label) groups.push({ label, key: ymd(dayStart(o[0].startedWallMs)), items: [] });
    groups.at(-1).items.push(o);
  }

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
      </div>
    </div>
    ${groups.map((g) => {
      const t = totals(g.items.flat());
      return `
      <section class="day">
        <div class="day-head">
          <h2>${esc(g.label)}</h2>
          ${t.trips ? `<span class="muted">${plural(t.trips, "trip")} · ${miles(t.meters)}</span>
          <a href="#/day/${g.key}">Map of the day →</a>` : ""}
        </div>
        <div class="cards">${g.items.map((o) => (o.length > 1 ? outingCard(o) : tripCard(o[0]))).join("")}</div>
      </section>`;
    }).join("")}`;
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
      <div class="thumb">${moved(r) ? Charts.thumbnail(t.path) : `<span class="muted">${noRouteLabel(r)}</span>`}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(timeRange(r))}</b>${statusPill(r)}</div>
        <div class="muted">${esc(tripName(r.startedWallMs))}${auto ? " · auto-started" : ""}</div>
        ${moved(r) ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          <span>top <b>${Math.round(t.maxMps * Route.MPH)}</b> mph</span>
          ${r.routeGaps ? `<span class="muted" title="Part of this trip's route isn't summarized for the list; the trip page has all of it">partial</span>` : ""}
        </div>` : ""}
        ${r.meta.note ? `<div class="note">${esc(r.meta.note)}</div>` : ""}
      </div>
    </a>`;
}

// Several linked trips in one card: a combined outline, totals, then each leg and the stops between them.
function outingCard(o) {
  const t = totals(o), first = o[0], last = o.at(-1);
  const href = `#/outing/${esc(first.id)}`;
  const legs = o.map((r, i) => {
    const gap = i ? `<li class="leg-stop">Stopped ${fmtDur(r.startedWallMs - endOf(o[i - 1]))}</li>` : "";
    return `${gap}<li><a href="#/r/${esc(r.id)}">
      <b>${esc(clock(r.startedWallMs))}</b>
      <span>${moved(r) ? `${miles(r.trip.meters)} · ${fmtDur(r.trip.movingMs)}` : noRouteLabel(r).toLowerCase()}</span>
      ${statusPill(r)}</a></li>`;
  }).join("");
  return `
    <div class="card trip-card outing-card">
      <a class="thumb" href="${href}" aria-label="Map of this outing">${Charts.thumbnail(o.filter(moved).map((r) => r.trip.path)) || `<span class="muted">No GPS yet</span>`}</a>
      <div class="trip-card-body">
        <a class="trip-card-title" href="${href}"><b>${esc(clock(first.startedWallMs))} – ${esc(clock(endOf(last)))}</b><span class="pill">${o.length} trips</span></a>
        <div class="muted">${esc(outingName(first.startedWallMs))}</div>
        ${t.trips ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          <span>top <b>${Math.round(t.maxMps * Route.MPH)}</b> mph</span>
          ${o.some((x) => x.routeGaps) ? `<span class="muted" title="Part of this outing's route isn't summarized for the list; each trip's page has all of it">partial</span>` : ""}
        </div>` : ""}
        <ol class="legs">${legs}</ol>
      </div>
    </div>`;
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
    return; // the page works without it
  }
  const box = document.getElementById("trip-context");
  if (!live() || !box) return;
  const id = r.id;
  const who = Account.whoFor(r.userId);
  // Does the picker's choice already include this trip? ("" is everyone; "me" is the signed-in person.)
  const p = Account.whoParam();
  const shown = p === "" || p === r.userId || (p === "me" && who === "me");
  const sw = shown ? "" : ` data-who="${esc(who)}"`;
  let html = "";
  const o = outingOf(recordings, id);
  if (o && o.length > 1) {
    const i = o.findIndex((x) => x.id === id);
    html += `<nav class="outing-nav">
      <span>Trip ${i + 1} of ${o.length} in this outing</span>
      ${i > 0 ? `<a href="#/r/${esc(o[i - 1].id)}">← Previous</a>` : ""}
      ${i < o.length - 1 ? `<a href="#/r/${esc(o[i + 1].id)}">Next →</a>` : ""}
      <a href="#/outing/${esc(o[0].id)}"${sw}>Whole outing</a>
    </nav>`;
  }
  // Driven before? Link to its leaderboard.
  const j = Repeats.journeyOf(Repeats.journeys(recordings, Prefs.get("places")).journeys, id);
  if (j) html += `<nav class="outing-nav"><span>One of ${j.trips.length} trips ${esc(j.loop ? `looping from ${j.from.name}` : `from ${j.from.name} to ${j.to.name}`)}</span><a href="#/routes/${esc(j.key)}"${sw}>Compare them →</a></nav>`;
  box.innerHTML = html;
  box.querySelectorAll("[data-who]").forEach((a) => (a.onclick = () => Account.setWho(a.dataset.who)));
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

// The side panel: headline numbers, then engine sections once its data is in, then the friction circle.
const sidePanel = (middle = "") => `
  <section class="side-sec">
    <div class="figs trip-figs" id="figs"></div>
    <p class="sub-line" id="sub-line"></p>
    <div class="gas-note" id="gas-note" hidden></div>
    <p class="hint" id="engine-status" hidden></p>
  </section>
  <section class="side-sec coach" id="coach" hidden></section>
  <section class="side-sec" id="split" hidden></section>
  <section class="side-sec" id="waste" hidden></section>
  <section class="side-sec" id="trip-cost" hidden></section>
  ${middle}
  <section class="side-sec" id="health" hidden></section>
  <section class="side-sec">
    <h2>Friction circle</h2>
    <p class="hint">Each dot is one second: how hard you were speeding up or braking (up and down), and turning (sideways). Smooth driving stays near the middle.</p>
    <div id="friction" class="chart-host"></div>
    <div id="peaks" class="peaks"></div>
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
  const bits = [
    trips > 1 ? plural(trips, "trip") : "",
    engine ? `${avg} mph average · ${top} top` : "",
    plural(sm.stops.length, "stop"),
    `${Math.abs(sm.peak.brake).toFixed(2)} g hardest brake`,
  ].filter(Boolean);
  document.getElementById("sub-line").textContent = bits.join(" · ");
}

// Where this drive could have been cheaper: what the driver controls, largest first, each with
// what it would have cost in minutes. Braking stops are buttons that show the stop on the map.
const COACH_KEY = "fuelish.coachTarget";
function coachCard(el, { pts, rows, e, vehicle, price, focus }) {
  if (!el) return;
  let target = 65;
  try { target = Number(localStorage.getItem(COACH_KEY)) || 65; } catch {}
  const amount = (gal) => (price != null ? money(gal * price) : `${gallons(gal)} gal`);
  const mins = (m) => (m < 1 ? `${Math.max(1, Math.round(m * 60))} s` : `${m.toFixed(m < 10 ? 1 : 0)} min`);
  const render = () => {
    const list = Coach.items({ pts, rows, e, vehicle, price, targetMph: target });
    el.hidden = false;
    if (!list.length) {
      el.innerHTML = `<h2>Where you could save</h2><p class="hint">Nothing stood out on this drive: no hard stops, long idles or fast cruising worth changing.</p>`;
      return;
    }
    const item = (it) => {
      const head = (title) => `<div class="coach-head"><b>${title}</b><span>${amount(it.gal)}</span></div>`;
      if (it.key === "braking") {
        return `<li>${head("Brake less, coast more")}
          <p>Slowing down threw away speed that took about ${amount(it.gal)} of gas to build${it.count > 1 ? `, over ${plural(it.count, "slow-down")}` : ""}. Some stops can't be helped, but lifting off sooner lets the car coast with the fuel cut off instead. The biggest:</p>
          <div class="coach-stops">${it.events.map((s) => `<button type="button" data-i="${s.peakI}">${Math.round(s.fromMph)}→${Math.round(s.toMph)} mph<small>${s.peakG.toFixed(2)} g · ${amount(s.galEq)}</small></button>`).join("")}</div></li>`;
      }
      if (it.key === "speed") {
        const perHour = price != null && it.minutes > 0.05 ? (it.gal * price) / (it.minutes / 60) : null;
        const options = [60, 65, 70].filter((v) => v < it.topMph);
        const saved = price != null ? it.gal * price >= 0.005 : it.gal >= 0.001;
        return `<li>${head(`Cruise at ${it.targetMph}`)}
          <p>You drove ${mins(it.aboveMin)} above ${it.targetMph} mph (top ${Math.round(it.topMph)}). Holding ${it.targetMph} there would have ${saved ? `used ${amount(it.gal)} less gas and taken ${mins(it.minutes)} longer${perHour != null ? `: like being paid ${money(perHour)} an hour for the extra time` : ""}` : `saved almost nothing and taken ${mins(it.minutes)} longer`}.</p>
          ${options.length > 1 ? `<div class="seg coach-target" role="group" aria-label="Cruising speed">${options.map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === it.targetMph}">${v} mph</button>`).join("")}</div>` : ""}
          <p class="hint">${it.source === "drive" ? "From your own fuel use at steady speeds on this drive." : "From air drag (this drive had too little steady cruising to measure it)."} Speed limits and traffic come first.</p></li>`;
      }
      if (it.key === "rich") {
        return `<li>${head("Ease into the gas")}
          <p>Pressing hard makes the engine run rich, spending fuel beyond what the air needs. A firm but not floored pedal keeps it lean.</p></li>`;
      }
      return `<li>${head("Switch off for long waits")}
        <p>The engine idled ${fmtDur(it.idleMs)} at a standstill. For waits over a minute (not traffic lights), switching off saves more than the restart uses.</p></li>`;
    };
    el.innerHTML = `<h2>Where you could save</h2><ul class="coach-list">${list.map(item).join("")}</ul>
      <details class="how"><summary>How these are estimated</summary>
        <p>Braking is the energy lost beyond what air and tires would have taken anyway (${Math.round(Engine.physics.massKg(vehicle))} kg, 25% engine efficiency), from GPS speed. It isn't measured fuel: it assumes a level road (going downhill reads as braking), and it can't tell the brakes from engine braking. Speed compares each second above the cruising speed with the same miles at that speed, using how fuel per mile grows with speed. Flooring it and idling are measured from the engine.</p>
      </details>`;
  };
  render();
  el.onclick = (ev) => {
    const stop = ev.target.closest("[data-i]");
    if (stop) { focus(Number(stop.dataset.i)); return; }
    const b = ev.target.closest(".coach-target button");
    if (b) {
      target = Number(b.dataset.v);
      try { localStorage.setItem(COACH_KEY, String(target)); } catch {}
      render();
    }
  };
}

// Highway vs town, where the fuel went, trip cost, car health: everything that needs the engine.
function sideEngine(sm, e, { gas = null, partial = false, trip = null, vehicle = trip?.meta?.vehicle ?? "", coach = null } = {}) {
  const figs = document.getElementById("figs");
  if (!figs) return;
  if (coach) coachCard(document.getElementById("coach"), { ...coach, e, vehicle, price: gas?.price ?? null });
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
  const about = [e.fromCar ? "Fuel as reported by the car." : "Fuel is estimated from airflow, the air-fuel target and the engine's fuel trims (this car doesn't report fuel use), not a pump reading."];
  if (epa) about.push(`EPA rates this car ${epa.city} city, ${epa.hwy} highway and ${epa.comb} combined.`);
  if (gas) about.push(`Gas at ${money(gas.price)}/gal, the ${gas.regionName} regional average for the week of ${new Date(gas.weekMs).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })} (U.S. EIA).`);
  const warn = [];
  if (thin && e.gal != null) warn.push(e.coverage < 0.5
    ? `Engine readings cover only ${Math.round(e.coverage * 100)}% of this drive's miles, so its mpg and gas are rough.`
    : `Engine readings cover ${Math.round(e.coverage * 100)}% of this drive's miles; mpg is for that part, and gas for the rest is filled in at the same mpg.`);
  if (partial) warn.push("Some of these trips have no engine data and aren't counted.");
  const short = [e.fromCar ? "Car-reported fuel" : "Estimated fuel", gas ? `gas ${money(gas.price)}/gal` : ""].filter(Boolean).join(" · ");
  note.hidden = false;
  note.innerHTML = `${warn.length ? `<p class="hint">${esc(warn.join(" "))}</p>` : ""}
    <details class="about"><summary>${esc(short)}</summary><p>${esc(about.join(" "))}</p></details>`;

  // Highway vs town: economy bars on one scale.
  const split = document.getElementById("split");
  const parts = [["Highway", `${Engine.HIGHWAY_MPH}+ mph`, e.highway, epa?.hwy], ["Town", `under ${Engine.HIGHWAY_MPH} mph`, e.town, epa?.city]].filter(([, , g]) => g.gal > 0.001);
  if (parts.length) {
    const max = Math.max(1, ...parts.map(([, , g]) => g.mpg ?? 0));
    split.hidden = false;
    split.innerHTML = `<h2>Highway vs town</h2>
      <div class="split">${parts.map(([name, note, g, rated]) => `
        <div class="split-row">
          <div class="split-name"><b>${name}</b><span>${note}</span>${rated ? `<span>EPA ${rated}</span>` : ""}</div>
          <div class="split-bar"><i style="width:${((g.mpg ?? 0) / max) * 100}%"></i></div>
          <div class="split-val"><b>${g.mpg != null ? g.mpg.toFixed(0) : "–"}<small>mpg</small></b><span>${g.miles.toFixed(g.miles < 10 ? 1 : 0)} mi · ${gallons(g.gal)} gal</span></div>
        </div>`).join("")}</div>`;
  }

  // Where the fuel went: one bar of the measured fuel, idling and enrichment marked. Braking is
  // energy, not fuel, and only an estimate, so it's listed under the bar, not inside it.
  const waste = document.getElementById("waste");
  if (e.fuelUse && e.gal) {
    const u = e.fuelUse;
    const kinds = [
      ["drive", "Driving", Math.max(0, e.gal - u.idle - u.rich), "moving at the ideal air-fuel ratio"],
      ["rich", "Enrichment", u.rich, "fuel beyond the ideal air-fuel ratio, mostly hard acceleration"],
      ["idle", "Idling", u.idle, `engine running at 0 mph for ${fmtDur(e.idleMs)} (counted where readings exist)`],
    ];
    const pct = (g) => Math.min(100, Math.max(0, (g / e.gal) * 100));
    waste.hidden = false;
    waste.innerHTML = `<h2>Where the fuel went</h2>
      <p class="sec-meta">${gallons(e.gal)} gal · ${esc(Engine.fuelLabel(e))}</p>
      <div class="waste-bar" role="img" aria-label="${esc(kinds.map(([, label, g]) => `${label} ${Math.round(pct(g))}%`).join(", "))}">${kinds.map(([k, , g]) => `<i class="w-${k}" style="flex-grow:${g}"></i>`).join("")}</div>
      <dl class="waste-list">${kinds.map(([k, label, g, why]) => `
        <div><dt><i class="sw w-${k}"></i>${label}<small>${why}</small></dt><dd>${gallons(g)} gal${cost(g) ? ` · ${cost(g)}` : ""} · ${Math.round(pct(g))}%</dd></div>`).join("")}
        ${e.cutMs >= 30000 ? `<div><dt><i class="sw w-cut"></i>Coasting, fuel off<small>the engine cut fuel entirely while you coasted</small></dt><dd>${fmtDur(e.cutMs)} · 0 gal</dd></div>` : ""}</dl>
      <details class="how"><summary>How these are estimated</summary>
        <p>${e.fromCar ? "Fuel use is as reported by the car." : `This car doesn't report fuel use, so it's estimated from the air flowing into the engine and the air-fuel ratio the engine asks for${e.perSample ? ", reading by reading" : ""}, corrected by the engine's fuel trims (how much fuel it adds or removes beyond what the airflow sensor implies).`}
        ${e.speedFactor !== 1 ? `Miles use the car's speed, which read ${Math.abs((1 - 1 / e.speedFactor) * 100).toFixed(1)}% ${e.speedFactor > 1 ? "low" : "high"} against GPS on this drive, corrected.` : "Miles use the car's own speed."}</p>
      </details>`;
  }

  // What this trip cost, counting more than gas.
  if (trip && typeof Costs !== "undefined") Costs.tripPanel(document.getElementById("trip-cost"), { trip, sm, e, gas });

  // Car health in one line; anything wrong comes first and stands out.
  const health = document.getElementById("health");
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
    health.hidden = false;
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    health.innerHTML = `<h2>Car health</h2><p class="health">${[...bad.map((x) => `<b class="bad">${esc(cap(x))}</b>`), ...ok.map((x, i) => esc(!bad.length && !i ? cap(x) : x))].join(" · ")}</p>`;
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
    const near = merged.find((x) => haversine([pts[x.i].lat, pts[x.i].lon], [pts[m.i].lat, pts[m.i].lon]) < 300);
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
        <div class="pills">${pills}${share ? "" : `<div class="share" id="share"></div>`}</div>
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
      <aside class="trip-side">${sidePanel()}</aside>
    </div>`;

  if (!share) shareControls(id);
  if (!share) tripContext(r, live); // not awaited: the route doesn't wait for it
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
  if (focusT != null) {
    // Opened at a moment (from Insights): zoom there and hold the cursor on it.
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.t - focusT) < Math.abs(pts[best].t - focusT)) best = i; });
    view.map.setView([pts[best].lat, pts[best].lon], 17);
    view.focusAt = best;
  }
  // Engine results don't wait for the gas price; the cost fills in when (if) it arrives.
  const engineOpts = { gas: null, vehicle: m.vehicle, trip: r };
  let engineRows = pts.engine;
  const showEngine = () => {
    if (!engineRows.length || !live()) return;
    view.setEngine(engineRows, engineOpts);
    if (view.focusAt != null) view.pick(view.focusAt); // again, now with engine values in the readout
  };
  if (view.focusAt != null) view.pick(view.focusAt);
  showEngine();
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
  const e = Engine.summary(rows, { vehicle: r.meta.vehicle, tripMs: endOf(r) - r.startedWallMs });
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
  document.getElementById("friction")?.closest("section")?.setAttribute("hidden", "");
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
  Insights.render(document.getElementById("ins"), trips);
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
  const engine = new Map(trips.map((t) => [t.r.id, { e: Engine.summary(t.rows, { vehicle: t.r.meta.vehicle, ...t.scope }), gas: t.gas }]));
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
    save: (v) => Prefs.set("costs", v),
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
const tripRowsCache = new Map(); // `${id}@${updatedAtMs}` -> rows (null: no engine data)
async function engineTrips(recordings, live, onStatus = () => {}, { gas = true } = {}) {
  const asc = [...recordings].sort((a, b) => a.startedWallMs - b.startedWallMs);
  const found = new Array(asc.length).fill(null), failed = [];
  let done = 0, next = 0;
  const status = () => onStatus(`Loading engine data… ${done} of ${asc.length} trips${failed.length ? ` (${failed.length} couldn't load)` : ""}`);
  status();
  await Promise.all(Array.from({ length: Math.min(4, asc.length) }, async () => {
    while (next < asc.length && live()) {
      const i = next++, r = asc[i], key = `${r.id}@${r.updatedAtMs}`;
      try {
        let rows = tripRowsCache.get(key);
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

// ---------- several trips: a day, a week, or an outing ----------

async function showMany(kind, key) {
  const live = current();
  const { recordings } = await allRecordings();
  if (!live()) return;
  let recs, title, sub, prev = null, next = null;
  if (kind === "outing") {
    recs = outingOf(recordings, key);
    if (!recs) throw new Error("That outing isn't in the trip list.");
    const day = new Date(recs[0].startedWallMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    title = outingName(recs[0].startedWallMs);
    sub = `${day} · ${clock(recs[0].startedWallMs)} – ${clock(endOf(recs.at(-1)))}`;
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
  const nav = prev || next ? `<nav class="period-nav">
      ${prev ? `<a href="${prev}">← Earlier</a>` : ""}${next ? `<a href="${next}">Later →</a>` : ""}</nav>` : "";

  // The trips, grouped into outings, with day headings in a week.
  // Trips whose route the list can't see (routeGaps) still go on the map: it loads full routes.
  const shown = recs.filter((r) => r.trip || r.routeGaps > 0);
  let rows = "", lastDay = "";
  outings(shown).forEach((o) => {
    o.forEach((r, i) => {
      const d = dayLabel(r.startedWallMs);
      if (kind === "week" && d !== lastDay) rows += `<li class="row-day">${esc(d)}</li>`;
      lastDay = d;
      if (i) rows += `<li class="leg-stop">Stopped ${fmtDur(r.startedWallMs - endOf(o[i - 1]))}</li>`;
      rows += `<li><a class="trip-row" href="#/r/${esc(r.id)}" data-id="${esc(r.id)}">
        <b>${esc(timeRange(r))}</b>
        <span>${moved(r) ? `${miles(r.trip.meters)} · ${fmtDur(r.trip.movingMs)} · top ${Math.round(r.trip.maxMps * Route.MPH)} mph${r.routeGaps ? " · partial" : ""}` : noRouteLabel(r).toLowerCase()}</span>
      </a></li>`;
    });
  });

  app.innerHTML = `
    <div class="trip trip-many">
      <header class="trip-head">
        <a href="#/" class="back">← Trips</a>
        <h1>${esc(title)}</h1>
        ${sub ? `<p class="muted">${esc(sub)}</p>` : ""}
        ${nav}
      </header>
      <section class="trip-map">
        <div id="map"></div>
        ${shown.length ? mapControls() : ""}
        <div class="readout" id="readout" hidden></div>
        <div class="map-status" id="rt-status">${shown.length ? "Loading trips…" : `No trips ${kind === "day" ? "this day" : "this week"}.`}</div>
      </section>
      <aside class="trip-side">
        ${shown.length ? sidePanel(`<section class="side-sec"><h2>${plural(shown.length, "trip")}</h2><ol class="legs trip-rows">${rows}</ol></section>`) : ""}
      </aside>
    </div>`;
  if (!shown.length) return;

  const status = document.getElementById("rt-status");
  let done = 0;
  const progress = () => { if (status) status.innerHTML = `Loading trips… <progress max="${shown.length}" value="${done}"></progress>`; };
  progress();
  // A few at a time; each trip's points are tagged with its index so the map keeps them apart.
  // One trip that can't load (e.g. a raw chunk missing) leaves just that trip off the map.
  // A recording an app update cut short and the one that carried the drive on are one drive on the
  // map (one line, ticks counting on): points of both get the first one's index.
  const drive = [];
  shown.forEach((r, i) => { drive[i] = i && continues(shown[i - 1], r) ? drive[i - 1] : i; });
  const lists = new Array(shown.length);
  const engines = new Array(shown.length).fill([]);
  const failed = [];
  let nextI = 0;
  await Promise.all(Array.from({ length: Math.min(4, shown.length) }, async () => {
    while (nextI < shown.length) {
      const i = nextI++;
      try {
        const tp = await tripPoints(shown[i].id);
        engines[i] = tp.engine; // summaries only: raw rebuilds of older drives are too slow for a week
        lists[i] = tp.map((p) => ({ ...p, trip: drive[i] }));
      } catch (e) {
        if (e.message === "unauthorized") throw e;
        lists[i] = [];
        failed.push(shown[i]);
      }
      done++;
      progress();
    }
  }));
  if (!live()) return;
  for (const r of failed) document.querySelector(`.trip-row[data-id="${CSS.escape(r.id)}"] span`)?.insertAdjacentText("beforeend", " · couldn't load the route");
  const pts = lists.flat();
  if (pts.length < 2) {
    status.textContent = "Not enough GPS fixes to draw a route.";
    return;
  }
  status.remove();
  const sm = Route.summary(pts);
  sideRoute(sm, { engine: engines.some((e) => e.length), trips: new Set(drive).size });
  const view = drawRoute(pts, sm, { withDay: kind === "week" });
  const engineRows = engines.flat();
  if (engineRows.length) {
    const gas = await withTimeout(Gas.forTrip(pts[0].lat, pts[0].lon, shown[0].startedWallMs), 8000);
    if (!live()) return;
    view.setEngine(engineRows, { partial: engines.some((e, i) => !e.length && lists[i].length), gas, vehicle: shown[0].meta.vehicle });
  }

  // Hovering a trip in the list brings it forward on the map.
  const index = new Map(shown.map((r, i) => [r.id, drive[i]]));
  document.querySelectorAll(".trip-row").forEach((a) => {
    const k = index.get(a.dataset.id);
    a.addEventListener("mouseenter", () => view.focus(k));
    a.addEventListener("focus", () => view.focus(k));
    a.addEventListener("mouseleave", () => view.focus(null));
    a.addEventListener("blur", () => view.focus(null));
  });
}

// Small amounts of fuel and money need more digits than big ones.
const gallons = (g) => (g < 0.1 ? g.toFixed(3) : g < 10 ? g.toFixed(2) : g.toFixed(1));
const money = (d) => (d < 10 ? "$" + d.toFixed(2) : "$" + Math.round(d).toLocaleString());

// ---------- map, charts and controls (shared) ----------

function drawRoute(pts, sm, { withDay = false } = {}) {
  // `view` is the saved choice; none saved yet means Cost on drives with engine data, else Speed.
  // `marks`: ticks across the route every minute ("min"), every so much gas ("gas"), or none ("off").
  let state = { view: null, labels: true, marks: "min" };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    state = { view: Route.VIEWS[saved.view] ? saved.view : null, labels: saved.labels ?? true, marks: ["min", "gas", "off"].includes(saved.marks) ? saved.marks : "min" };
  } catch {}
  // Marks are for one drive: on a day or a week map they'd pile up into noise.
  const oneTrip = Route.tripRanges(pts).length === 1;
  let price = null;

  // What's drawn: the chosen view, except engine views on a drive without engine data.
  let hasEngine = false;
  const shownState = {};
  const effective = () => {
    const want = state.view ?? (hasEngine ? "cost" : "speed");
    const view = Route.VIEWS[want].engine && !hasEngine ? "speed" : want;
    const marks = !oneTrip ? "off" : state.marks === "gas" && !hasEngine ? "min" : state.marks;
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
        <dt>${p.a != null && p.a < 0 ? "Braking" : "Speeding up"}</dt><dd>${fmt(p.a != null ? Math.abs(p.a) / Route.G : null, 2, " g")}</dd>
        <dt>Turning</dt><dd>${fmt(p.side != null ? Math.abs(p.side) / Route.G : null, 2, " g")}${p.side != null && Math.abs(p.side) / Route.G >= 0.03 ? (p.side > 0 ? " right" : " left") : ""}</dd>
        ${p.eng ? `<dt>Gas pedal</dt><dd>${fmt(p.eng.pedal, 0, "%")}</dd>
        <dt>Economy</dt><dd>${p.eng.mpg == null ? "–" : p.eng.mpg >= 99 ? "coasting" : fmt(p.eng.mpg, 0, " mpg")}</dd>
        ${p.eng.rel != null ? `<dt>Fuel/mi, 20 s</dt><dd>${esc(Route.METRICS.cost.fmt(p.eng.rel))}${Math.abs(p.eng.rel - 1) >= 0.005 ? " than usual" : ""}</dd>` : ""}
        <dt>Fuel</dt><dd>${p.eng.cut ? "cut off" : fmt(p.eng.gph, 2, " gal/h")}</dd>
        <dt>RPM</dt><dd>${fmt(p.eng.rpm, 0, "")}</dd>` : ""}
      </dl>`;
  };

  const mapEl = document.getElementById("map");
  const view = Route.render(mapEl, pts, shownState, pick);
  const friction = Charts.frictionCircle(document.getElementById("friction"), pts, pick);
  views = [{ highlight: (i) => view.mark(i) }, friction];

  const pk = sm.peak;
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
    if (!oneTrip) return "";
    const every = shownState.marks === "min" ? "Every minute" : gasStep ? `Every ${stepName(gasStep)} of gas` : "";
    const opts = [["min", "Minutes"], ...(hasEngine ? [["gas", "Gas"]] : []), ["off", "Off"]];
    return `<div class="marks-switch">${every ? `<span class="marks-key"><i></i>${esc(every)}</span>` : ""}<div class="seg marks" role="group" aria-label="Marks along the route">${opts.map(([k, l]) =>
      `<button type="button" data-marks="${k}" aria-pressed="${shownState.marks === k}">${l}</button>`).join("")}</div></div>`;
  };
  const legend = () => { document.getElementById("rt-legend").innerHTML = Route.legendHtml(shownState, pts) + marksSwitch(); };
  document.getElementById("rt-legend").addEventListener("click", (e) => {
    const b = e.target.closest("[data-marks]");
    if (!b) return;
    state.marks = b.dataset.marks;
    effective(); drawMarks(); legend(); save();
  });
  const recolor = () => { effective(); view.redraw(); drawMarks(); legend(); };
  // Notable moments, labeled on the map (again with engine ones once that data is in).
  view.moments(momentsFor(pts, sm));
  const labels = document.getElementById("moments-toggle");
  const syncLabels = () => { labels.setAttribute("aria-pressed", String(!!state.labels)); view.showMoments(!!state.labels); };
  labels.onclick = () => { state.labels = !state.labels; syncLabels(); save(); };
  syncLabels();
  const save = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(state)); } catch {} };
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
  function setEngine(rows, { partial = false, gas = null, vehicle = "", trip = null } = {}) {
    if (!rows.length || !document.getElementById("map")) return;
    Engine.attach(pts, Engine.relCost(Engine.smoothMpg(rows)));
    hasEngine = true;
    price = gas?.price ?? null;
    document.querySelectorAll("[data-engine]").forEach((b) => { b.hidden = false; });
    recolor();
    syncButtons();
    view.moments(momentsFor(pts, sm));
    // Coverage is against the whole drive: its GPS miles, and for one trip its door-to-door time.
    const scope = { tripMiles: sm.miles, tripMs: trip ? endOf(trip) - trip.startedWallMs : null };
    // Coaching is for one drive at a time: a day or a week mixes too much to say what to change.
    const coach = trip ? { pts, rows, focus: (i) => { view.map.setView([pts[i].lat, pts[i].lon], Math.max(view.map.getZoom(), 16)); pick(i); } } : null;
    sideEngine(sm, Engine.summary(rows, { vehicle, ...scope }), { gas, partial, trip, vehicle, coach });
  }

  return { ...view, setEngine, pick };
}

window.addEventListener("hashchange", route);
route();
