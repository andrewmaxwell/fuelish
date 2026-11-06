// What stopping costs: every stop along every drive (a light, a stop sign, traffic), what it took in
// gas and time, and the places you stop most expensively, added up over all your drives.
//
// A stop's gas is what burned standing still plus the gas spent speeding back up afterwards (the
// cost ribbon's "speeding up" lane, ribbon.js, until the car is back to the speed it had before).
// Its time is what it lost against carrying on at that speed: slowing down, waiting, and pulling
// away again. A trip's start and end aren't stops, and neither is anything over 5 minutes (an
// errand or dropping someone off, not traffic).

const Stops = (() => {
  const LOOK_BACK_MS = 30000; // the speed you had: the fastest in the 30 s before stopping
  const RECOVER_MS = 40000; // back up to speed within this, or it's counted as back anyway
  const BACK = 0.9; // "back up to speed": 90% of it
  const MAX_STOP_MS = 5 * 60000;
  const SAME_M = 35; // stops this close are the same place (both sides of a light, a few car lengths)

  /**
   * The stops of one drive, from its fixes and the ribbon's split (Ribbon.decompose):
   * [{ lat, lon, t, waitMs, lostMs, g, idleG, goG }] (grams of gas: total, standing, speeding back up).
   */
  function events(pts, d) {
    const out = [];
    const ranges = Route.tripRanges(pts);
    const rangeOf = (i) => ranges.find(([a, b]) => i >= a && i <= b);
    for (const s of d.stops) {
      const [a, b] = rangeOf(s.i0) ?? [0, pts.length - 1];
      // Starting off and parking aren't stops.
      if (s.i0 <= a + 1 || s.i1 >= b - 1 || s.ms > MAX_STOP_MS) continue;
      const t0 = pts[s.i0].t;
      let vBefore = 0, i = s.i0;
      for (let j = s.i0 - 1; j >= a && pts[j].t >= t0 - LOOK_BACK_MS; j--) vBefore = Math.max(vBefore, pts[j].v ?? 0);
      if (!(vBefore > 2)) continue; // already crawling (a queue): counted with the stop before it
      const target = vBefore * BACK;
      // Slowing down: back from the stop to where it was last at speed.
      while (i > a && (pts[i - 1].v ?? 0) < target && pts[i - 1].t >= t0 - LOOK_BACK_MS) i--;
      const from = i;
      // Speeding back up: on from the stop until it's at speed again.
      let k = s.i1;
      while (k < b && (pts[k].v ?? 0) < target && pts[k].t - pts[s.i1].t <= RECOVER_MS) k++;
      let lostMs = 0, goG = 0;
      for (let j = from; j < k; j++) {
        const dt = pts[j + 1].t - pts[j].t;
        if (dt > 0 && dt <= 5000) lostMs += dt * Math.max(0, 1 - (pts[j].v ?? 0) / vBefore);
        if (j > s.i1) goG += d.parts.accel[j];
      }
      out.push({ lat: s.lat, lon: s.lon, t: t0, waitMs: s.ms, lostMs, idleG: s.g, goG, g: s.g + goG, vBefore });
    }
    return out;
  }

  /**
   * Stops from many drives grouped by place: [{ lat, lon, n, g, dollars, lostMs, timeDollars, waits,
   * trips: Set }], most expensive first. Each event may carry `price` ($/gal) and `perHour` ($ an hour
   * of the driver's time).
   */
  function places(evs) {
    const cells = new Map(), groups = [];
    const cell = (lat, lon) => `${Math.round(lat / 0.0004)}:${Math.round(lon / 0.0005)}`;
    const nearby = (lat, lon) => {
      const [y, x] = cell(lat, lon).split(":").map(Number), found = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) found.push(...(cells.get(`${y + dy}:${x + dx}`) || []));
      return found;
    };
    for (const e of [...evs].sort((x, y) => x.t - y.t)) {
      let g = null, best = SAME_M;
      for (const c of nearby(e.lat, e.lon)) {
        const dist = Route.haversine(c.lat, c.lon, e.lat, e.lon);
        if (dist <= best) { best = dist; g = c; }
      }
      if (!g) {
        g = { lat: e.lat, lon: e.lon, n: 0, g: 0, dollars: 0, lostMs: 0, timeDollars: 0, waits: [], trips: new Set(), priced: true };
        groups.push(g);
        const k = cell(e.lat, e.lon);
        (cells.get(k) || cells.set(k, []).get(k)).push(g);
      } else {
        // The place drifts to the middle of its stops (kept in the cell it started in).
        g.lat = (g.lat * g.n + e.lat) / (g.n + 1);
        g.lon = (g.lon * g.n + e.lon) / (g.n + 1);
      }
      g.n++;
      g.g += e.g;
      g.lostMs += e.lostMs;
      g.waits.push(e.waitMs);
      if (e.trip) g.trips.add(e.trip);
      if (e.price != null) g.dollars += Engine.galOf(e.g) * e.price;
      else g.priced = false;
      if (e.perHour) g.timeDollars += (e.lostMs / 3600000) * e.perHour;
    }
    return groups.sort((x, y) => (y.dollars + y.timeDollars) - (x.dollars + x.timeDollars) || y.g - x.g);
  }

  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  };

  // ---------- the map ----------

  // Circles: area for what the place cost (gas and time), color for the usual wait there.
  const WAIT = [[0, "#6c4fd6"], [15000, "#a23fb8"], [30000, "#d8487f"], [60000, "#f2774e"], [120000, "#f9b23a"]];
  const waitColor = (ms) => {
    let c = WAIT[0][1];
    for (const [at, col] of WAIT) if (ms >= at) c = col;
    return c;
  };

  /** Draws `groups` on a map in `el`; returns { map, focus(k) } (focus opens place k's label). */
  function map(el, groups, label) {
    if (el._map) el._map.remove();
    const m = L.map(el, { zoomControl: false, attributionControl: true });
    el._map = m;
    L.control.zoom({ position: "bottomright" }).addTo(m);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors", className: "tiles-dark" }).addTo(m);
    const top = Math.max(...groups.map((g) => g.dollars + g.timeDollars), 1e-9);
    const marks = groups.map((g, k) => {
      const v = g.dollars + g.timeDollars;
      const r = 4 + 26 * Math.sqrt(v / top);
      const mk = L.circleMarker([g.lat, g.lon], { radius: r, color: "#0b0b0b", weight: 1.5, fillColor: waitColor(median(g.waits)), fillOpacity: 0.85 })
        .bindTooltip(label(g, k), { direction: "top", className: "moment" })
        .addTo(m);
      return mk;
    });
    if (groups.length) m.fitBounds(L.latLngBounds(groups.map((g) => [g.lat, g.lon])).pad(0.15));
    return {
      map: m,
      focus(k) {
        const g = groups[k];
        if (!g) return;
        m.setView([g.lat, g.lon], Math.max(m.getZoom(), 16));
        marks[k].openTooltip();
      },
    };
  }

  const legendHtml = () => `<div class="stops-legend"><span>Usual wait</span>${WAIT.map(([at, c], i) =>
    `<span><i class="rb-sw" style="background:${c}"></i>${i === WAIT.length - 1 ? `${at / 60000}+ min` : at < 60000 ? `${at / 1000}+ s` : `${at / 60000}+ min`}</span>`).join("")}</div>
    <p class="hint">Bigger circles cost more, in gas and your time. Tap a place in the list to go to it.</p>`;

  return { events, places, map, legendHtml, median, MAX_STOP_MS };
})();
