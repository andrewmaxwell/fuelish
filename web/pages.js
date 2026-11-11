// The pages across every drive (Insights, Compare, Costs, Transmission, Stops) and the engine data
// they share, kept in this browser between visits.

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
  // The weekly driving scores: each trip in the weeks shown, scored as on its own page (remembered
  // from the trip list where it's been seen there), newest first, filled in as they arrive.
  const host = document.getElementById("ins");
  const figures = new Map();
  const from = +addDays(weekStart(last), -7 * (Insights.WEEKS_SHOWN - 1));
  const scoring = () => scoreEach(trips.map((t) => t.r).filter((r) => r.startedWallMs >= from).reverse(), live, (r, f, left) => {
    if (r) figures.set(r.id, f);
    Insights.fillScores(host, figures, left);
  }).catch(() => {});
  // Towing and unloaded driving each get their own curves: mixed, neither would describe either.
  const towed = trips.filter((t) => t.r.towing);
  if (!towed.length || towed.length === trips.length) {
    if (towed.length) sub.textContent += " All of them towing.";
    Insights.render(host, trips, { figures });
    scoring();
    return;
  }
  host.insertAdjacentHTML("beforebegin", `<div class="seg ins-tow" role="group"><button type="button" data-tow="0" aria-pressed="true">Not towing (${trips.length - towed.length})</button><button type="button" data-tow="1" aria-pressed="false">Towing (${towed.length})</button></div>`);
  const pick = (tow) => {
    document.querySelectorAll(".ins-tow button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tow === (tow ? "1" : "0"))));
    Insights.render(host, trips.filter((t) => !!t.r.towing === tow), { figures });
  };
  document.querySelectorAll(".ins-tow button").forEach((b) => (b.onclick = () => pick(b.dataset.tow === "1")));
  pick(false);
  scoring();
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
