// Fuelish web: list recordings, inspect collection quality, download raw data.
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
  if (res.status === 401) { showLogin("Token rejected."); throw new Error("unauthorized"); }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtBytes = (n) => n == null ? "–" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString() : "–";
function fmtDur(ms) {
  if (ms == null || ms < 0) return "–";
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
const num = (x, d = 1) => x == null || !Number.isFinite(x) ? "–" : x.toFixed(d);

function showLogin(msg = "") {
  document.getElementById("logout").hidden = true;
  app.innerHTML = `
    <form class="panel login" id="login">
      <h2>Sign in</h2>
      <p class="muted">Paste the web (read) token configured on the Worker as <code>WEB_TOKEN</code>.</p>
      <input type="password" id="tok" autocomplete="current-password" placeholder="Token" required>
      <div class="row"><button class="primary">Sign in</button><span class="bad">${esc(msg)}</span></div>
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
  app.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    if (m) await showRecording(m[1]);
    else await showList();
  } catch (e) {
    if (e.message !== "unauthorized") app.innerHTML = `<p class="bad">${esc(e.message)}</p>`;
  }
}

function statusCell(r) {
  if (r.status === "recording") return `<span class="warn">recording</span>`;
  if (r.complete) return `<span class="ok">complete</span>`;
  return `<span class="bad">${esc(r.status)} · ${r.chunksReceived}/${r.chunkCount ?? "?"} chunks</span>`;
}

async function showList() {
  const { recordings } = await api("/recordings");
  if (!recordings.length) {
    app.innerHTML = `<div class="panel"><h2>No recordings yet</h2><p class="muted">Recordings appear here once the phone uploads its first chunk.</p></div>`;
    return;
  }
  app.innerHTML = `
    <div class="panel scroll"><h2>Recordings</h2><table>
      <thead><tr><th>Started</th><th>Duration</th><th>Status</th><th class="num">Size</th><th>OBD</th><th>Note</th></tr></thead>
      <tbody>${recordings.map((r) => {
        const s = r.meta.summary || {};
        return `<tr>
          <td><a href="#/r/${esc(r.id)}">${esc(fmtTime(r.startedWallMs))}</a></td>
          <td>${fmtDur((r.endedWallMs ?? r.updatedAtMs) - r.startedWallMs)}</td>
          <td>${statusCell(r)}</td>
          <td class="num">${fmtBytes(r.bytes)}</td>
          <td>${s.obd?.connected ? esc(s.obd.protocol || "yes") : `<span class="muted">none</span>`}</td>
          <td>${esc(r.meta.note || "")}</td></tr>`;
      }).join("")}</tbody></table></div>`;
}

// Merge per-chunk stream stats into whole-recording stats.
function aggregateStreams(chunks) {
  const out = {};
  for (const c of chunks) {
    for (const [k, s] of Object.entries(c.meta.streams || {})) {
      const a = (out[k] ||= { n: 0, firstNs: s.firstNs, lastNs: s.lastNs, minDtNs: Infinity, maxDtNs: 0, longGaps: 0 });
      a.n += s.n;
      a.firstNs = Math.min(a.firstNs, s.firstNs);
      a.lastNs = Math.max(a.lastNs, s.lastNs);
      if (s.minDtNs != null) a.minDtNs = Math.min(a.minDtNs, s.minDtNs);
      if (s.maxDtNs != null) a.maxDtNs = Math.max(a.maxDtNs, s.maxDtNs);
      a.longGaps += s.longGaps || 0;
    }
  }
  return Object.entries(out).sort(([a], [b]) => a.localeCompare(b));
}

async function showRecording(id) {
  const { recording: r, chunks, missing } = await api(`/recordings/${id}`);
  const m = r.meta, s = m.summary || {};
  const durMs = (r.endedWallMs ?? r.updatedAtMs) - r.startedWallMs;
  const records = chunks.reduce((n, c) => n + (c.meta.records || 0), 0);
  const raw = chunks.reduce((n, c) => n + (c.meta.rawBytes || 0), 0);
  const drops = chunks.reduce((n, c) => n + (c.meta.drops || 0), 0);
  const hours = durMs / 3600000;
  const streams = aggregateStreams(chunks);
  const hasTrack = chunks.some((c) => (c.meta.track || []).length);
  const batt = s.battery || {};

  const stat = (label, value, cls = "") => `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
  app.innerHTML = `
    <p><a href="#/">← All recordings</a></p>
    <div class="panel">
      <h2>${esc(fmtTime(r.startedWallMs))} <span class="muted">${esc(r.id)}</span></h2>
      <div class="grid">
        ${stat("Status", statusCell(r))}
        ${stat("Duration", fmtDur(durMs))}
        ${stat("Chunks", `${chunks.length}${r.chunkCount != null ? " / " + r.chunkCount : ""}`, missing.length ? "bad" : "")}
        ${stat("Records", records.toLocaleString())}
        ${stat("Dropped records", drops.toLocaleString(), drops ? "bad" : "ok")}
        ${stat("Compressed", fmtBytes(r.bytes))}
        ${stat("Raw", fmtBytes(raw))}
        ${stat("Compressed / hour", hours > 0.01 ? fmtBytes(r.bytes / hours) : "–")}
        ${stat("Battery", batt.startPct != null ? `${batt.startPct}% → ${batt.endPct ?? "?"}%` : "–")}
        ${stat("Battery / hour", batt.pctPerHour != null ? num(batt.pctPerHour) + "%" : "–")}
        ${stat("Charging", batt.pluggedFraction != null ? Math.round(batt.pluggedFraction * 100) + "% of time" : "–")}
      </div>
      ${missing.length ? `<p class="bad">Missing chunks: ${missing.join(", ")}</p>` : ""}
      ${m.note ? `<p>Note: ${esc(m.note)}</p>` : ""}
    </div>

    ${hasTrack ? `<div class="panel"><h2>Route</h2>
      <div class="row controls">
        <label>Color by <select id="rt-color">${Object.entries(Route.METRICS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></label>
        <label>Line width by <select id="rt-width">${Object.entries(Route.WIDTHS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
      </div>
      <div id="rt-legend"></div>
      <div id="map"><p class="muted" id="rt-status">Loading route…</p></div>
      <div id="rt-summary" class="muted"></div>
      <p class="muted">Tap the route for details at that point.</p></div>` : ""}

    <div class="panel"><h2>Downloads</h2>
      <div class="row"><button class="primary" id="dl-all">Download whole recording (.ndjson.gz)</button>
      <button id="dl-meta">Download metadata (.json)</button></div>
      <p class="muted">Chunks are concatenated gzip members; <code>gunzip</code>, <code>zcat</code> and Python's <code>gzip</code> read the whole file.</p>
      <details><summary>Individual chunks</summary><div id="chunk-links" class="row"></div></details>
    </div>

    <div class="panel scroll"><h2>Streams (actual sampling)</h2><table>
      <thead><tr><th>Stream</th><th class="num">Samples</th><th class="num">Mean rate (Hz)</th>
      <th class="num">Min interval (ms)</th><th class="num">Mean interval (ms)</th><th class="num">Max interval (ms)</th><th class="num">Gaps &gt;1s</th></tr></thead>
      <tbody>${streams.map(([k, a]) => {
        const span = (a.lastNs - a.firstNs) / 1e9;
        const meanMs = a.n > 1 ? (a.lastNs - a.firstNs) / (a.n - 1) / 1e6 : null;
        return `<tr><td>${esc(k)}</td><td class="num">${a.n.toLocaleString()}</td>
          <td class="num">${a.n > 1 && span > 0 ? num((a.n - 1) / span) : "–"}</td>
          <td class="num">${Number.isFinite(a.minDtNs) ? num(a.minDtNs / 1e6, 2) : "–"}</td>
          <td class="num">${num(meanMs, 2)}</td>
          <td class="num">${a.maxDtNs ? num(a.maxDtNs / 1e6, 0) : "–"}</td>
          <td class="num ${a.longGaps && meanMs != null && meanMs < 500 ? "warn" : ""}">${a.longGaps}</td></tr>`;
      }).join("")}</tbody></table>
      <p class="muted">Stream rates combine all chunks and include pauses (e.g. OBD reconnects); see the gap columns.</p></div>

    ${s.obd ? `<div class="panel"><h2>OBD adapter</h2><pre>${esc(JSON.stringify(s.obd, null, 2))}</pre></div>` : ""}
    <div class="panel"><h2>Recording metadata</h2><pre>${esc(JSON.stringify(m, null, 2))}</pre></div>`;

  document.getElementById("dl-meta").onclick = () => {
    const blob = new Blob([JSON.stringify({ recording: r, chunks, missing }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${id}.json`;
    a.click();
  };
  const links = await api(`/recordings/${id}/links`, { method: "POST" });
  document.getElementById("dl-all").onclick = () => { location.href = links.all; };
  document.getElementById("chunk-links").innerHTML = Object.entries(links.chunks)
    .map(([seq, url]) => `<a href="${esc(url)}">#${esc(seq)}</a>`).join(" ");

  if (hasTrack && window.L) await showRoute(id, chunks, links);
}

async function showRoute(id, chunks, links) {
  const status = document.getElementById("rt-status");
  let pts = Route.fromChunks(chunks) || routeCache.get(id);
  if (!pts) {
    // Recorded before the phone summarized every GPS fix: rebuild from the raw chunks once.
    const urls = chunks.map((c) => links.chunks[c.seq]);
    pts = await Route.fromRaw(urls, (i, n) => {
      if (status) status.textContent = `Building the detailed route from raw data… ${i}/${n} chunks`;
    });
    routeCache.set(id, pts);
  }
  if (!document.getElementById("map")) return; // navigated away meanwhile
  if (pts.length < 2) {
    status.textContent = "Not enough GPS fixes to draw a route.";
    return;
  }
  let state = { color: "speed", width: "none", base: "Light" };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") }; } catch {}
  if (!Route.METRICS[state.color]) state.color = "speed";
  if (!Route.WIDTHS[state.width]) state.width = "none";
  const colorSel = document.getElementById("rt-color"), widthSel = document.getElementById("rt-width");
  colorSel.value = state.color;
  widthSel.value = state.width;
  const mapEl = document.getElementById("map");
  mapEl.innerHTML = "";
  const view = Route.render(mapEl, pts, state);
  const legend = () => { document.getElementById("rt-legend").innerHTML = Route.legendHtml(state, pts); };
  const save = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(state)); } catch {} };
  legend();
  colorSel.onchange = () => { state.color = colorSel.value; view.redraw(); legend(); save(); };
  widthSel.onchange = () => { state.width = widthSel.value; view.redraw(); save(); };
  mapEl._map.on("baselayerchange", save);
  const sm = Route.summary(pts);
  document.getElementById("rt-summary").textContent =
    `${sm.miles.toFixed(2)} mi · top speed ${sm.maxMph != null ? sm.maxMph.toFixed(0) + " mph" : "–"}` +
    (sm.hardestBrake != null ? ` · hardest braking ${Math.abs(sm.hardestBrake).toFixed(2)} g · hardest acceleration ${sm.hardestAccel.toFixed(2)} g` : "") +
    ` · ${pts.length.toLocaleString()} GPS fixes`;
}

window.addEventListener("hashchange", route);
route();
