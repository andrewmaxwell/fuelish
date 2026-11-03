// Fuelish web: the list of trips and, for each trip, its route map, speed timeline and friction circle.
// Plain JS, no build step. The read token lives in localStorage on this browser only.

const app = document.getElementById("app");
const TOKEN_KEY = "fuelish.token";
const VIEW_KEY = "fuelish.routeView";
const routeCache = new Map(); // recording id -> points rebuilt from raw data

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

// "Monday evening", for a trip's title.
function tripName(ms) {
  const d = new Date(ms), h = d.getHours();
  const part = h < 5 ? "night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";
  return `${d.toLocaleDateString([], { weekday: "long" })} ${part} drive`;
}
function dayLabel(ms) {
  const d = new Date(ms), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const timeRange = (r) => `${clock(r.startedWallMs)} – ${clock(r.endedWallMs ?? r.updatedAtMs)}`;

function statusPill(r) {
  if (r.status === "recording") return `<span class="pill live"><i></i>Recording</span>`;
  if (!r.complete) return `<span class="pill warn">Uploading ${r.chunksReceived}/${r.chunkCount ?? "?"}</span>`;
  return "";
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
  if (!token()) return showLogin();
  document.getElementById("logout").hidden = false;
  const m = location.hash.match(/^#\/r\/([A-Za-z0-9_-]+)/);
  document.body.classList.toggle("page-trip", !!m);
  window.scrollTo(0, 0);
  app.innerHTML = `<p class="muted loading">Loading…</p>`;
  try {
    if (m) await showTrip(m[1]);
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
  const weekAgo = Date.now() - 7 * 86400000;
  const week = recordings.filter((r) => r.startedWallMs >= weekAgo && r.trip?.meters >= 100);
  const weekMeters = week.reduce((n, r) => n + r.trip.meters, 0);
  const weekMs = week.reduce((n, r) => n + r.trip.movingMs, 0);

  const groups = [];
  for (const r of recordings) {
    const label = dayLabel(r.startedWallMs);
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(r);
  }

  app.innerHTML = `
    <div class="list-head">
      <h1>Trips</h1>
      <div class="week">
        <div><b>${week.length}</b><span>trips this week</span></div>
        <div><b>${miles(weekMeters)}</b><span>driven</span></div>
        <div><b>${fmtDur(weekMs)}</b><span>behind the wheel</span></div>
      </div>
    </div>
    ${groups.map((g) => `
      <section class="day">
        <h2>${esc(g.label)}</h2>
        <div class="cards">${g.items.map(tripCard).join("")}</div>
      </section>`).join("")}`;
}

function tripCard(r) {
  const t = r.trip;
  const moved = t && t.meters >= 100;
  const auto = r.meta.trigger?.startsWith("car_bluetooth");
  return `
    <a class="card trip-card" href="#/r/${esc(r.id)}">
      <div class="thumb">${moved ? Charts.thumbnail(t.path) : `<span class="muted">${t ? "Didn't move" : "No GPS yet"}</span>`}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(timeRange(r))}</b>${statusPill(r)}</div>
        <div class="muted">${esc(tripName(r.startedWallMs))}${auto ? " · auto-started" : ""}</div>
        ${moved ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          <span>top <b>${Math.round(t.maxMps * Route.MPH)}</b> mph</span>
        </div>` : ""}
        ${r.meta.note ? `<div class="note">${esc(r.meta.note)}</div>` : ""}
      </div>
    </a>`;
}

// ---------- one trip ----------

async function showTrip(id) {
  const { recording: r, chunks } = await api(`/recordings/${id}`);
  const m = r.meta;
  const auto = m.trigger?.startsWith("car_bluetooth");
  const pills = [statusPill(r), auto ? `<span class="pill">Auto-started</span>` : "", m.vehicle ? `<span class="pill">${esc(m.vehicle)}</span>` : ""].join("");
  const day = new Date(r.startedWallMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const seg = (key, options) => `<div class="seg" data-key="${key}" role="group">${Object.entries(options)
    .map(([k, v]) => `<button type="button" data-v="${k}">${esc(typeof v === "string" ? v : v.label)}</button>`).join("")}</div>`;

  app.innerHTML = `
    <div class="trip">
      <header class="trip-head">
        <a href="#/" class="back">← Trips</a>
        <h1>${esc(tripName(r.startedWallMs))}</h1>
        <p class="muted">${esc(day)} · ${esc(timeRange(r))}</p>
        <div class="pills">${pills}</div>
        ${r.status === "recording" ? `<p class="hint">Still recording; the route fills in as parts upload.</p>`
          : !r.complete ? `<p class="hint">${r.chunksReceived} of ${r.chunkCount ?? "?"} parts uploaded so far; the phone sends the rest on Wi-Fi.</p>` : ""}
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
        <div class="card">
          <h2>Route</h2>
          <div class="control"><span>Color</span>${seg("color", Route.METRICS)}</div>
          <div id="rt-legend"></div>
          <div class="control"><span>Line width</span>${seg("width", Route.WIDTHS)}</div>
          <div class="control"><span>Map</span>${seg("base", Route.BASES)}</div>
        </div>
        <div class="card">
          <h2>Friction circle</h2>
          <div id="friction" class="chart-host"></div>
          <div id="peaks" class="peaks"></div>
          <p class="hint">Each dot is one second of driving: how hard you were speeding up or braking, and turning. Smooth driving stays near the middle.</p>
        </div>
      </aside>
    </div>`;

  const status = document.getElementById("rt-status");
  let pts = Route.fromChunks(chunks) || routeCache.get(id);
  if (!pts) {
    // Recorded before the phone summarized every GPS fix: rebuild from the raw chunks once.
    const links = await api(`/recordings/${id}/links`, { method: "POST" });
    pts = await Route.fromRaw(chunks.map((c) => links.chunks[c.seq]), (i, n) => {
      if (status) status.innerHTML = `Building the detailed route… <progress max="${n}" value="${i}"></progress>`;
    });
    routeCache.set(id, pts);
  }
  if (!document.getElementById("map")) return; // navigated away meanwhile
  if (pts.length < 2) {
    status.textContent = "Not enough GPS fixes to draw a route.";
    return;
  }
  status.remove();
  drawTrip(pts);
}

function drawTrip(pts) {
  const sm = Route.summary(pts);
  const stat = (label, value, unit = "") => `<div class="stat"><span>${label}</span><b>${value}<small>${unit}</small></b></div>`;
  document.getElementById("stats").innerHTML =
    stat("Distance", sm.miles.toFixed(sm.miles < 10 ? 1 : 0), "mi") +
    stat("Moving time", fmtDur(sm.movingMs)) +
    stat("Average", sm.avgMph != null ? sm.avgMph.toFixed(0) : "–", "mph") +
    stat("Top speed", sm.maxMph != null ? sm.maxMph.toFixed(0) : "–", "mph") +
    stat("Stops", sm.stops.length) +
    stat("Hardest brake", Math.abs(sm.peak.brake).toFixed(2), "g");

  let state = { color: "speed", width: "none", base: "muted" };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") }; } catch {}
  if (!Route.METRICS[state.color]) state.color = "speed";
  if (!Route.WIDTHS[state.width]) state.width = "none";
  if (!Route.BASES[state.base]) state.base = "muted";

  const readout = document.getElementById("readout");
  const fmt = (x, d, u) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d) + u);
  let views = [];
  const pick = (i) => {
    for (const v of views) v.highlight(i);
    if (i < 0) { readout.hidden = true; return; }
    const p = pts[i];
    readout.hidden = false;
    readout.innerHTML = `
      <div class="readout-time">${new Date(p.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</div>
      <div class="readout-speed">${fmt(p.v != null ? p.v * Route.MPH : null, 0, "")}<small> mph</small></div>
      <dl>
        <dt>${p.a != null && p.a < 0 ? "Braking" : "Speeding up"}</dt><dd>${fmt(p.a != null ? Math.abs(p.a) / Route.G : null, 2, " g")}</dd>
        <dt>Turning</dt><dd>${fmt(p.side != null ? Math.abs(p.side) / Route.G : null, 2, " g")}${p.side != null && Math.abs(p.side) / Route.G >= 0.03 ? (p.side > 0 ? " right" : " left") : ""}</dd>
        <dt>Bumps</dt><dd>${fmt(p.jolt != null ? p.jolt / Route.G : null, 2, " g")}</dd>
        <dt>GPS error</dt><dd>${fmt(p.acc, 0, " m")}</dd>
      </dl>`;
  };

  const mapEl = document.getElementById("map");
  const view = Route.render(mapEl, pts, state, pick);
  const timeline = Charts.timeline(document.getElementById("timeline"), pts, pick);
  const friction = Charts.frictionCircle(document.getElementById("friction"), pts, pick);
  views = [{ highlight: (i) => view.mark(i) }, timeline, friction];

  const pk = sm.peak;
  document.getElementById("peaks").innerHTML = friction.count
    ? `<div><span>Braking</span><b>${Math.abs(pk.brake).toFixed(2)} g</b></div><div><span>Speeding up</span><b>${pk.accel.toFixed(2)} g</b></div><div><span>Turning</span><b>${pk.corner.toFixed(2)} g</b></div>`
    : `<p class="muted">Not enough moving GPS fixes for this one.</p>`;

  const legend = () => { document.getElementById("rt-legend").innerHTML = Route.legendHtml(state, pts); };
  const recolor = () => { view.redraw(); legend(); timeline.recolor(Route.segmentColors(pts, state)); };
  const save = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(state)); } catch {} };
  const syncButtons = () => document.querySelectorAll(".seg").forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(state[g.dataset.key] === b.dataset.v))));
  document.querySelectorAll(".seg").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[g.dataset.key] = b.dataset.v;
    if (g.dataset.key === "base") view.setBase(state.base);
    else recolor();
    syncButtons();
    save();
  }));
  syncButtons();
  recolor();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (document.getElementById("map")) recolor(); });
  // The map's container changes size with the layout (e.g. rotating a phone).
  new ResizeObserver(() => view.map.invalidateSize()).observe(mapEl);
}

window.addEventListener("hashchange", route);
route();
