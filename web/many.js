// Several recordings shown as one drive: an outing, a day or a week on one map.

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
