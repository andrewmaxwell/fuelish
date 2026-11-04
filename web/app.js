// Fuelish web: the list of trips, one trip's route map, speed timeline and friction circle,
// and map views of several trips at once (a day, a week, or one outing of linked trips).
// Plain JS, no build step. The read token lives in localStorage on this browser only.

const app = document.getElementById("app");
const TOKEN_KEY = "fuelish.token";
const VIEW_KEY = "fuelish.routeView";
const routeCache = new Map(); // recording id -> points rebuilt from raw data

// Trips are one outing when the next starts within this long of the last one ending, near where it ended.
const OUTING_GAP_MS = 30 * 60000;
const OUTING_NEAR_M = 500;

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

async function api(path, opts = {}) {
  const res = await fetch("/api/v1" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + token(), ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin("That token didn't work."); throw new Error("unauthorized"); }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

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
    maxMps: Math.max(0, ...m.map((r) => r.trip.maxMps)),
  };
}

function showLogin(msg = "") {
  document.body.classList.remove("page-trip");
  document.getElementById("logout").hidden = true;
  app.innerHTML = `
    <form class="card login" id="login">
      <h1>Sign in</h1>
      <p class="muted">Paste the web token configured on the Worker as <code>WEB_TOKEN</code>. It stays in this browser.</p>
      <input type="password" id="tok" autocomplete="current-password" placeholder="Token" required>
      <button class="primary">Sign in</button>
      ${msg ? `<p class="bad">${esc(msg)}</p>` : ""}
    </form>`;
  document.getElementById("login").onsubmit = async (e) => {
    e.preventDefault();
    try { localStorage.setItem(TOKEN_KEY, document.getElementById("tok").value.trim()); } catch {}
    route();
  };
}

document.getElementById("logout").onclick = () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  showLogin();
};

async function route() {
  // A shared trip needs no sign-in.
  const share = location.hash.match(/^#\/s\/([A-Za-z0-9_-]+)/);
  if (share) {
    document.body.classList.add("page-trip");
    document.getElementById("logout").hidden = true;
    app.innerHTML = `<p class="muted loading">Loading…</p>`;
    try { await showTrip(null, share[1]); } catch (e) { app.innerHTML = `<p class="bad loading">${esc(e.message)}</p>`; }
    return;
  }
  if (!token()) return showLogin();
  document.getElementById("logout").hidden = false;
  const h = location.hash;
  const trip = h.match(/^#\/r\/([A-Za-z0-9_-]+)(?:\/(\d+))?/);
  const insights = h.startsWith("#/insights");
  const many = h.match(/^#\/(day|week)\/(\d{4}-\d{2}-\d{2})/) || h.match(/^#\/(outing)\/([A-Za-z0-9_-]+)/);
  document.body.classList.toggle("page-trip", !!(trip || many));
  window.scrollTo(0, 0);
  app.innerHTML = `<p class="muted loading">Loading…</p>`;
  try {
    if (trip) await showTrip(trip[1], null, trip[2] ? +trip[2] : null);
    else if (insights) await showInsights();
    else if (many) await showMany(many[1], many[2]);
    else await showList();
  } catch (e) {
    if (e.message !== "unauthorized") app.innerHTML = `<p class="bad loading">${esc(e.message)}</p>`;
  }
}

// ---------- trip list ----------

async function showList() {
  const { recordings } = await api("/recordings");
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
          <a class="see-map" href="#/insights">Insights →</a>
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

function tripCard(r) {
  const t = r.trip;
  const auto = r.meta.trigger?.startsWith("car_bluetooth");
  return `
    <a class="card trip-card" href="#/r/${esc(r.id)}">
      <div class="thumb">${moved(r) ? Charts.thumbnail(t.path) : `<span class="muted">${t ? "Didn't move" : "No GPS yet"}</span>`}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(timeRange(r))}</b>${statusPill(r)}</div>
        <div class="muted">${esc(tripName(r.startedWallMs))}${auto ? " · auto-started" : ""}</div>
        ${moved(r) ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          <span>top <b>${Math.round(t.maxMps * Route.MPH)}</b> mph</span>
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
      <span>${moved(r) ? `${miles(r.trip.meters)} · ${fmtDur(r.trip.movingMs)}` : r.trip ? "didn't move" : "no GPS yet"}</span>
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
        </div>` : ""}
        <ol class="legs">${legs}</ol>
      </div>
    </div>`;
}

// ---------- points for a trip ----------

// GPS points for one recording, cut off where the drive ended. `onProgress` reports a raw rebuild.
async function tripPoints(id, detail, onProgress, { shared = false } = {}) {
  const { recording: r, chunks } = detail || (await api(`/recordings/${id}`));
  let pts = Route.fromChunks(chunks) || routeCache.get(id);
  if (!pts && shared) throw new Error("This trip was recorded before routes were summarized, so it can't be shown on a shared link.");
  if (!pts) {
    // Recorded before the phone summarized every GPS fix: rebuild from the raw chunks once.
    const links = await api(`/recordings/${id}/links`, { method: "POST" });
    pts = await Route.fromRaw(chunks.map((c) => links.chunks[c.seq]), onProgress);
    routeCache.set(id, pts);
  }
  const end = r.driveEndWallMs;
  const out = end != null ? pts.filter((p) => p.t <= end) : pts;
  // Engine rows from the chunk summaries; `engineRaw` lists chunks whose engine data is only raw.
  out.engine = Engine.derive(Engine.fromChunks(chunks)).filter((e) => end == null || e.t <= end);
  out.engineRaw = shared ? [] : Engine.rawOnly(chunks); // shared links never get raw chunks
  out.end = end;
  return out;
}

// Older drives (before the phone summarized engine data): read it from the raw chunks once.
const engineCache = new Map();
async function rawEngine(id, pts, onProgress) {
  if (engineCache.has(id)) return engineCache.get(id);
  const links = await api(`/recordings/${id}/links`, { method: "POST" });
  const rows = Engine.derive(await Engine.fromRaw(pts.engineRaw, pts.engineRaw.map((c) => links.chunks[c.meta.seq]), onProgress))
    .filter((e) => pts.end == null || e.t <= pts.end);
  engineCache.set(id, rows);
  return rows;
}

const stat = (label, value, unit = "") => `<div class="stat"><span>${label}</span><b>${value}<small>${unit}</small></b></div>`;
// Engine-only options (RPM, pedal, fuel) stay hidden until the drive's engine data is in.
const seg = (key, options) => `<div class="seg" data-key="${key}" role="group">${Object.entries(options)
  .map(([k, v]) => `<button type="button" data-v="${k}"${Route.METRICS[k]?.engine ? " data-engine hidden" : ""}>${esc(typeof v === "string" ? v : v.label)}</button>`).join("")}</div>`;
const engineCard = () => `<div class="card" id="engine-card" hidden><h2>Engine</h2><div id="engine-body"></div></div>`;
const routeCard = () => `
  <div class="card">
    <h2>Route</h2>
    <div class="control"><span>Color</span>${seg("color", Route.METRICS)}</div>
    <div id="rt-legend"></div>
    <div class="control"><span>Line width</span>${seg("width", Route.WIDTHS)}</div>
  </div>`;
const frictionCard = (what) => `
  <div class="card">
    <h2>Friction circle</h2>
    <div id="friction" class="chart-host"></div>
    <div id="peaks" class="peaks"></div>
    <p class="hint">Each dot is one second of driving${what}: how hard you were speeding up or braking, and turning. Smooth driving stays near the middle.</p>
  </div>`;

// ---------- one trip ----------

// `share` is a share-link token: the trip is shown read-only, without anything that needs signing in.
async function showTrip(id, share = null, focusT = null) {
  // The list is only needed to find the other trips of this one's outing; the page works without it.
  const [detail, list] = share
    ? [await api(`/shared/${share}`), null]
    : await Promise.all([api(`/recordings/${id}`), api("/recordings").catch(() => null)]);
  const { recording: r } = detail;
  id = r.id;
  const m = r.meta;
  const auto = m.trigger?.startsWith("car_bluetooth");
  const pills = [share ? `<span class="pill">Shared trip</span>` : "", statusPill(r), auto ? `<span class="pill">Auto-started</span>` : "", m.vehicle ? `<span class="pill">${esc(m.vehicle)}</span>` : ""].join("");
  const day = new Date(r.startedWallMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const tail = r.endedWallMs != null && r.driveEndWallMs != null ? r.endedWallMs - r.driveEndWallMs : 0;

  const o = list && outingOf(list.recordings, id);
  let outing = "";
  if (o && o.length > 1) {
    const i = o.findIndex((x) => x.id === id);
    outing = `<nav class="outing-nav">
      <span>Trip ${i + 1} of ${o.length} in this outing</span>
      ${i > 0 ? `<a href="#/r/${esc(o[i - 1].id)}">← Previous</a>` : ""}
      ${i < o.length - 1 ? `<a href="#/r/${esc(o[i + 1].id)}">Next →</a>` : ""}
      <a href="#/outing/${esc(o[0].id)}">Whole outing</a>
    </nav>`;
  }

  app.innerHTML = `
    <div class="trip">
      <header class="trip-head">
        ${share ? "" : `<a href="#/" class="back">← Trips</a>`}
        <h1>${esc(tripName(r.startedWallMs))}</h1>
        <p class="muted">${esc(day)} · ${esc(timeRange(r))}</p>
        <div class="pills">${pills}</div>
        ${outing}
        ${share ? "" : `<div class="share" id="share"></div>`}
        ${r.status === "recording" ? `<p class="hint">Still recording; the route fills in as parts upload.</p>`
          : !r.complete ? `<p class="hint">${r.chunksReceived} of ${r.chunkCount ?? "?"} parts uploaded so far; the phone sends the rest on Wi-Fi.</p>` : ""}
        ${tail >= 30000 ? `<p class="hint">Ends when the car switched off. The ${fmtDur(tail)} the phone kept recording after that aren't counted.</p>` : ""}
        ${m.note ? `<p class="note">${esc(m.note)}</p>` : ""}
      </header>
      <section class="trip-map">
        <div id="map"></div>
        <div class="readout" id="readout" hidden></div>
        <div class="map-status" id="rt-status">Loading route…</div>
      </section>
      <section class="trip-time"><div id="timeline" class="chart-host"></div></section>
      <aside class="trip-side">
        <div class="stats" id="stats"></div>
        ${engineCard()}
        ${routeCard()}
        ${frictionCard("")}
      </aside>
    </div>`;

  if (!share) shareControls(id);
  const status = document.getElementById("rt-status");
  const pts = await tripPoints(id, detail, (i, n) => {
    if (status) status.innerHTML = `Building the detailed route… <progress max="${n}" value="${i}"></progress>`;
  }, { shared: !!share });
  if (!document.getElementById("map")) return; // navigated away meanwhile
  if (pts.length < 2) {
    status.textContent = "Not enough GPS fixes to draw a route.";
    return;
  }
  status.remove();
  const sm = Route.summary(pts);
  document.getElementById("stats").innerHTML =
    stat("Distance", sm.miles.toFixed(sm.miles < 10 ? 1 : 0), "mi") +
    stat("Moving time", fmtDur(sm.movingMs)) +
    stat("Average", sm.avgMph != null ? sm.avgMph.toFixed(0) : "–", "mph") +
    stat("Top speed", sm.maxMph != null ? sm.maxMph.toFixed(0) : "–", "mph") +
    stat("Stops", sm.stops.length) +
    stat("Hardest brake", Math.abs(sm.peak.brake).toFixed(2), "g");
  const view = drawRoute(pts, sm, { timeline: true });
  if (focusT != null) {
    // Opened at a moment (from Insights): zoom there and hold the cursor on it.
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.t - focusT) < Math.abs(pts[best].t - focusT)) best = i; });
    view.map.setView([pts[best].lat, pts[best].lon], 17);
    view.focusAt = best;
  }
  const gas = await Gas.forTrip(pts[0].lat, pts[0].lon, r.startedWallMs);
  const engineOpts = { gas, vehicle: m.vehicle };
  if (view.focusAt != null) view.pick(view.focusAt);
  if (pts.engine.length) {
    view.setEngine(pts.engine, engineOpts);
    if (view.focusAt != null) view.pick(view.focusAt); // again, now with engine values in the readout
  } else if (pts.engineRaw.length) {
    const card = document.getElementById("engine-card"), body = document.getElementById("engine-body");
    card.hidden = false;
    try {
      const rows = await rawEngine(id, pts, (i, n) => {
        body.innerHTML = `<p class="hint">Reading engine data from the raw recording… <progress max="${n}" value="${i}"></progress></p>`;
      });
      if (document.getElementById("engine-card") === card) {
        view.setEngine(rows, engineOpts);
        if (view.focusAt != null) view.pick(view.focusAt);
      }
    } catch (e) {
      if (e.message !== "unauthorized") body.innerHTML = `<p class="bad">Couldn't read the engine data: ${esc(e.message)}</p>`;
    }
  }
}

// Share link for one trip: create, copy, stop sharing.
async function shareControls(id) {
  const box = document.getElementById("share");
  const linkOf = (t) => `${location.origin}/#/s/${t}`;
  const render = (tok) => {
    if (!document.getElementById("share")) return;
    if (!tok) {
      box.innerHTML = `<button type="button" class="ghost share-btn" id="share-on">Share this trip…</button>`;
      box.querySelector("#share-on").onclick = async () => {
        try { render((await api(`/recordings/${id}/shares`, { method: "POST" })).token); }
        catch (e) { box.insertAdjacentHTML("beforeend", `<p class="bad">${esc(e.message)}</p>`); }
      };
      return;
    }
    box.innerHTML = `
      <div class="share-box">
        <div class="share-row"><input readonly value="${esc(linkOf(tok))}" aria-label="Share link"><button type="button" class="primary" id="share-copy">Copy</button></div>
        <p class="hint">Anyone with this link can see this trip without signing in: the route, including where it starts and ends, and its engine data.</p>
        <button type="button" class="ghost" id="share-off">Stop sharing</button>
      </div>`;
    const input = box.querySelector("input");
    input.onclick = () => input.select();
    box.querySelector("#share-copy").onclick = async (e) => {
      try { await navigator.clipboard.writeText(input.value); e.target.textContent = "Copied"; }
      catch { input.select(); }
    };
    box.querySelector("#share-off").onclick = async () => {
      await api(`/recordings/${id}/shares/${tok}`, { method: "DELETE" });
      render(null);
    };
  };
  try {
    const { shares } = await api(`/recordings/${id}/shares`);
    render(shares.at(-1)?.token ?? null);
  } catch {
    box.innerHTML = "";
  }
}

// ---------- insights across all drives ----------

async function showInsights() {
  const { recordings } = await api("/recordings");
  app.innerHTML = `
    <div class="insights">
      <a href="#/" class="back">← Trips</a>
      <h1>Insights</h1>
      <p class="muted" id="ins-sub">Loading engine data…</p>
      <div id="ins"></div>
    </div>`;
  const sub = document.getElementById("ins-sub");
  const trips = [];
  const asc = [...recordings].sort((a, b) => a.startedWallMs - b.startedWallMs);
  for (let i = 0; i < asc.length; i++) {
    const r = asc[i];
    if (sub) sub.textContent = `Loading engine data… ${i + 1} of ${asc.length} trips`;
    try {
      // Only engine data is needed here, not the route; the list's outline gives the start for gas prices.
      const { chunks } = await api(`/recordings/${r.id}`);
      if (!Engine.recorded(chunks)) continue;
      const end = r.driveEndWallMs;
      let rows = Engine.derive(Engine.fromChunks(chunks)).filter((e) => end == null || e.t <= end);
      if (!rows.length) {
        rows = await rawEngine(r.id, { engineRaw: Engine.rawOnly(chunks), end }, (k, n) => {
          if (sub) sub.textContent = `Reading engine data from an older drive's raw recording… ${k} of ${n}`;
        });
      }
      const start = r.trip?.path?.[0];
      if (rows.length) trips.push({ r, rows, gas: await Gas.forTrip(start?.[0], start?.[1], r.startedWallMs) });
    } catch (e) {
      if (e.message === "unauthorized") throw e;
    }
  }
  if (!document.getElementById("ins")) return;
  if (!trips.length) {
    sub.textContent = "No drives with engine data yet. They show up here once the phone records with the OBD adapter connected.";
    return;
  }
  const first = trips[0].r.startedWallMs, last = trips.at(-1).r.startedWallMs;
  const d = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  sub.textContent = `${plural(trips.length, "drive")} with engine data${first === last ? `, ${d(first)}` : `, ${d(first)} – ${d(last)}`}.`;
  Insights.render(document.getElementById("ins"), trips);
}

// ---------- several trips: a day, a week, or an outing ----------

async function showMany(kind, key) {
  const { recordings } = await api("/recordings");
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
  const shown = recs.filter((r) => r.trip);
  let rows = "", lastDay = "";
  outings(shown).forEach((o) => {
    o.forEach((r, i) => {
      const d = dayLabel(r.startedWallMs);
      if (kind === "week" && d !== lastDay) rows += `<li class="row-day">${esc(d)}</li>`;
      lastDay = d;
      if (i) rows += `<li class="leg-stop">Stopped ${fmtDur(r.startedWallMs - endOf(o[i - 1]))}</li>`;
      rows += `<li><a class="trip-row" href="#/r/${esc(r.id)}" data-id="${esc(r.id)}">
        <b>${esc(timeRange(r))}</b>
        <span>${moved(r) ? `${miles(r.trip.meters)} · ${fmtDur(r.trip.movingMs)} · top ${Math.round(r.trip.maxMps * Route.MPH)} mph` : "didn't move"}</span>
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
        <div class="readout" id="readout" hidden></div>
        <div class="map-status" id="rt-status">${shown.length ? "Loading trips…" : `No trips ${kind === "day" ? "this day" : "this week"}.`}</div>
      </section>
      <aside class="trip-side">
        <div class="stats" id="stats"></div>
        ${shown.length ? engineCard() : ""}
        ${shown.length ? `<div class="card"><h2>${plural(shown.length, "trip")}</h2><ol class="legs trip-rows">${rows}</ol></div>` : ""}
        ${shown.length ? routeCard() + frictionCard(" in these trips") : ""}
      </aside>
    </div>`;
  if (!shown.length) return;

  const status = document.getElementById("rt-status");
  let done = 0;
  const progress = () => { if (status) status.innerHTML = `Loading trips… <progress max="${shown.length}" value="${done}"></progress>`; };
  progress();
  // A few at a time; each trip's points are tagged with its index so the map keeps them apart.
  // One trip that can't load (e.g. a raw chunk missing) leaves just that trip off the map.
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
        lists[i] = tp.map((p) => ({ ...p, trip: i }));
      } catch (e) {
        if (e.message === "unauthorized") throw e;
        lists[i] = [];
        failed.push(shown[i]);
      }
      done++;
      progress();
    }
  }));
  if (!document.getElementById("map")) return;
  for (const r of failed) document.querySelector(`.trip-row[data-id="${CSS.escape(r.id)}"] span`)?.insertAdjacentText("beforeend", " · couldn't load the route");
  const pts = lists.flat();
  if (pts.length < 2) {
    status.textContent = "Not enough GPS fixes to draw a route.";
    return;
  }
  status.remove();
  const sm = Route.summary(pts);
  const t = totals(shown);
  document.getElementById("stats").innerHTML =
    stat("Trips", t.trips) +
    stat("Distance", sm.miles.toFixed(sm.miles < 10 ? 1 : 0), "mi") +
    stat("Moving time", fmtDur(sm.movingMs)) +
    stat("Average", sm.avgMph != null ? sm.avgMph.toFixed(0) : "–", "mph") +
    stat("Top speed", sm.maxMph != null ? sm.maxMph.toFixed(0) : "–", "mph") +
    stat("Hardest brake", Math.abs(sm.peak.brake).toFixed(2), "g");
  const view = drawRoute(pts, sm, { withDay: kind === "week" });
  const engineRows = engines.flat();
  if (engineRows.length) {
    const gas = await Gas.forTrip(pts[0].lat, pts[0].lon, shown[0].startedWallMs);
    view.setEngine(engineRows, { partial: engines.some((e, i) => !e.length && lists[i].length), gas, vehicle: shown[0].meta.vehicle });
  }

  // Hovering a trip in the list brings it forward on the map.
  const index = new Map(shown.map((r, i) => [r.id, i]));
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

function wasteHtml(e, gas) {
  if (!e.waste || !e.gal) return "";
  const w = e.waste, total = w.idle + w.braking + w.rich;
  const cost = (g) => (gas ? ` · ${money(g * gas.price)}` : "");
  const line = (label, g, note) => `<div><dt>${label}<small>${note}</small></dt><dd>${gallons(g)} gal${cost(g)}</dd></div>`;
  return `
    <h3 class="sub">Wasted fuel <span>${gallons(total)} gal${cost(total)} · ${Math.round((total / e.gal) * 100)}% of the fuel</span></h3>
    <dl class="engine-list waste-list">
      ${line("Braking", w.braking, "speed you built up, then braked away")}
      ${line("Idling", w.idle, "engine running at 0 mph")}
      ${line("Running rich", w.rich, "extra fuel at full throttle")}
    </dl>
    <p class="hint">Braking is an estimate: the energy your brakes turned into heat, beyond what air and tires would have taken anyway, as the fuel it took to build that speed (${Math.round(e.massKg)} kg, 25% engine efficiency).</p>`;
}

// ---------- map, charts and controls (shared) ----------

function drawRoute(pts, sm, { timeline: withTimeline = false, withDay = false } = {}) {
  let state = { color: "speed", width: "none" };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") }; } catch {}
  if (!Route.METRICS[state.color]) state.color = "speed";
  if (!Route.WIDTHS[state.width]) state.width = "none";

  // What's drawn: the saved choice, except engine colors on a drive without engine data.
  let hasEngine = false;
  const shownState = {};
  const effective = () => Object.assign(shownState, state, {
    color: Route.METRICS[state.color].engine && !hasEngine ? "speed" : state.color,
    width: Route.METRICS[state.width]?.engine && !hasEngine ? "none" : state.width,
  });
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
      <div class="readout-time">${new Date(p.t).toLocaleString([], { weekday: withDay ? "short" : undefined, hour: "numeric", minute: "2-digit", second: "2-digit" })}</div>
      <div class="readout-speed">${fmt(p.v != null ? p.v * Route.MPH : null, 0, "")}<small> mph</small></div>
      <dl>
        <dt>${p.a != null && p.a < 0 ? "Braking" : "Speeding up"}</dt><dd>${fmt(p.a != null ? Math.abs(p.a) / Route.G : null, 2, " g")}</dd>
        <dt>Turning</dt><dd>${fmt(p.side != null ? Math.abs(p.side) / Route.G : null, 2, " g")}${p.side != null && Math.abs(p.side) / Route.G >= 0.03 ? (p.side > 0 ? " right" : " left") : ""}</dd>
        <dt>Bumps</dt><dd>${fmt(p.jolt != null ? p.jolt / Route.G : null, 2, " g")}</dd>
        <dt>GPS error</dt><dd>${fmt(p.acc, 0, " m")}</dd>
        ${p.eng ? `<dt>RPM</dt><dd>${fmt(p.eng.rpm, 0, "")}</dd>
        <dt>Gas pedal</dt><dd>${fmt(p.eng.pedal, 0, "%")}</dd>
        <dt>Fuel</dt><dd>${p.eng.cut ? "cut off" : fmt(p.eng.gph, 2, " gal/h")}</dd>` : ""}
      </dl>`;
  };

  const mapEl = document.getElementById("map");
  const view = Route.render(mapEl, pts, shownState, pick);
  const timeline = withTimeline ? Charts.timeline(document.getElementById("timeline"), pts, pick) : null;
  const friction = Charts.frictionCircle(document.getElementById("friction"), pts, pick);
  views = [{ highlight: (i) => view.mark(i) }, friction, ...(timeline ? [timeline] : [])];

  const pk = sm.peak;
  document.getElementById("peaks").innerHTML = friction.count
    ? `<div><span>Braking</span><b>${Math.abs(pk.brake).toFixed(2)} g</b></div><div><span>Speeding up</span><b>${pk.accel.toFixed(2)} g</b></div><div><span>Turning</span><b>${pk.corner.toFixed(2)} g</b></div>`
    : `<p class="muted">Not enough moving GPS fixes here.</p>`;

  const legend = () => { document.getElementById("rt-legend").innerHTML = Route.legendHtml(shownState, pts); };
  const recolor = () => { effective(); view.redraw(); legend(); timeline?.recolor(Route.segmentColors(pts, shownState)); };
  const save = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(state)); } catch {} };
  const syncButtons = () => document.querySelectorAll(".seg").forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(shownState[g.dataset.key] === b.dataset.v))));
  document.querySelectorAll(".seg").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[g.dataset.key] = b.dataset.v;
    recolor();
    syncButtons();
    save();
  }));
  syncButtons();
  recolor();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (document.getElementById("map")) recolor(); });
  // The map's container changes size with the layout (e.g. rotating a phone).
  new ResizeObserver(() => view.map.invalidateSize()).observe(mapEl);

  // Engine data arrives with the route, or later for older drives read from raw chunks.
  function setEngine(rows, { partial = false, gas = null, vehicle = "" } = {}) {
    if (!rows.length || !document.getElementById("map")) return;
    Engine.attach(pts, rows);
    hasEngine = true;
    document.querySelectorAll("[data-engine]").forEach((b) => { b.hidden = false; });
    syncButtons();
    recolor();
    timeline?.setRows([
      { label: "RPM", unit: "", get: (p) => p.eng?.rpm ?? null, fmt: (v) => v.toFixed(0) + " rpm", min: 0, max: 3000 },
      { label: "Gas pedal", unit: "%", get: (p) => p.eng?.pedal ?? null, fmt: (v) => v.toFixed(0), min: 0, max: 100 },
      { label: "Fuel", unit: "gal/h", get: (p) => p.eng?.gph ?? null, fmt: (v) => v.toFixed(2), min: 0, max: 1 },
    ]);
    const card = document.getElementById("engine-card");
    if (!card) return;
    card.hidden = false;
    const e = Engine.summary(rows, { vehicle });
    const temp = (c) => (c == null ? "–" : Engine.cToF(c).toFixed(0));
    const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const light = e.mil == null ? "–" : `${e.mil ? "On" : "Off"}${e.dtcs != null ? `, ${e.dtcs ? plural(e.dtcs, "code") : "no codes"}` : ""}`;
    document.getElementById("engine-body").innerHTML = `
      <div class="stats engine-stats">
        ${stat("Fuel used", e.gal != null ? gallons(e.gal) : "–", "gal")}
        ${stat("Fuel economy", e.mpg != null ? e.mpg.toFixed(0) : "–", "mpg")}
        ${stat("Cost", e.gal != null && gas ? money(e.gal * gas.price) : "–")}
      </div>
      ${gas ? `<p class="hint gas-note">Gas at ${money(gas.price)}/gal: the ${esc(gas.regionName)} average for the week of ${new Date(gas.weekMs).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })} (U.S. EIA).</p>` : ""}
      ${wasteHtml(e, gas)}
      <dl class="engine-list">
        ${row("Top RPM", e.maxRpm ? Math.round(e.maxRpm).toLocaleString() : "–")}
        ${row("Idling", fmtDur(e.idleMs))}
        ${row("Coasting with fuel cut", fmtDur(e.cutMs))}
        ${row("Coolant", e.coolant[0] != null ? `${temp(e.coolant[0])} → ${temp(e.coolant[1])} °F` : "–")}
        ${row("Charging", Number.isFinite(e.volts[0]) ? `${e.volts[0].toFixed(1)}–${e.volts[1].toFixed(1)} V` : "–")}
        ${row("Fuel tank", e.fuelLevel != null ? e.fuelLevel.toFixed(0) + "%" : "–")}
        ${row("Check engine light", light)}
      </dl>
      <p class="hint">${e.fromCar ? "Fuel use as reported by the car." : "Fuel use is estimated from airflow and the air-fuel ratio the engine asks for; this car doesn't report it directly."}
        Economy uses the car's own speed.${partial ? " Some of these trips have no engine data and aren't counted." : ""}</p>`;
  }

  return { ...view, setEngine, pick };
}

window.addEventListener("hashchange", route);
route();
