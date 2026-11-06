// Route data and map: builds per-fix points from a recording, and draws the GPS track
// colored and sized by a chosen metric. Points come from chunk summaries (phone-computed,
// trackFormat 2) or, for older recordings, are rebuilt in the browser from the raw chunks.

// Extremes of a long list without spreading it into arguments (engines cap argument counts, and a
// long history of one-second rows passes that).
function extent(list, f = (x) => x) {
  let lo = Infinity, hi = -Infinity;
  for (const x of list) {
    const v = f(x);
    if (v == null || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

const Route = (() => {
  const G = 9.80665;
  const MPH = 2.236936;

  // ---------- building points ----------

  // Point: { t: wall ms, lat, lon, v: m/s|null, acc: m|null, brg: deg|null, jolt: m/s²|null,
  //          a: forward accel m/s²|null, side: sideways accel m/s² (+ = turning right)|null }
  // A chunk's summarized track is used only when it's really there (an oversized sidecar can have
  // had it dropped on the phone); the rest are rebuilt from their raw data (see rawChunks).
  const hasTrack = (c) => c.meta.trackFormat === 2 && Array.isArray(c.meta.track);
  /** Chunks whose GPS fixes are only in the raw file. */
  const rawChunks = (chunks) => chunks.filter((c) => !hasTrack(c));

  function fromChunks(chunks) {
    const pts = chunks.filter(hasTrack).flatMap((c) => c.meta.track).map((p) => ({
      t: p[0], lat: p[1], lon: p[2], v: p[3], acc: p[4], brg: p[5], jolt: p[6],
    }));
    return derive(pts);
  }

  /** Points from summaries and from a raw rebuild of other chunks, in time order. */
  function merge(a, b) {
    if (!b?.length) return a;
    const seen = new Set(a.map((p) => p.t));
    return derive([...a, ...b.filter((p) => !seen.has(p.t))]);
  }

  // Older recordings only kept a 5 s preview, so read the raw chunks once in the browser.
  async function fromRaw(chunkUrls, onProgress) {
    const fixes = [];
    const accTs = [], accDev = [];
    for (let i = 0; i < chunkUrls.length; i++) {
      onProgress?.(i, chunkUrls.length);
      const res = await fetch(chunkUrls[i]);
      if (!res.ok) throw new Error(`chunk ${i}: HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('{"k":"s","s":"acc"')) {
            const r = JSON.parse(line);
            accTs.push(r.ts);
            accDev.push(Math.abs(Math.hypot(r.v[0], r.v[1], r.v[2]) - G));
          } else if (line.startsWith('{"k":"loc","p":"gps"')) {
            const r = JSON.parse(line);
            fixes.push({ et: r.et, t: r.time, lat: r.lat, lon: r.lon, v: r.speed ?? null, acc: r.hAcc ?? null, brg: r.bearing ?? null });
          }
        }
        if (done) break;
      }
    }
    onProgress?.(chunkUrls.length, chunkUrls.length);
    // Jolt for a fix = largest accelerometer deviation since the previous fix (same as the phone computes).
    const order = accTs.map((_, i) => i).sort((a, b) => accTs[a] - accTs[b]);
    fixes.sort((a, b) => a.et - b.et);
    let j = 0, prev = -Infinity;
    for (const f of fixes) {
      let m = null;
      while (j < order.length && accTs[order[j]] <= f.et) {
        if (accTs[order[j]] > prev) m = Math.max(m ?? 0, accDev[order[j]]);
        j++;
      }
      f.jolt = m;
      prev = f.et;
    }
    return derive(fixes);
  }

  // Forward acceleration from GPS speed, sideways acceleration from speed × turn rate
  // (central differences; null across gaps). Sideways needs all three fixes above 4 m/s (9 mph):
  // slower than that, GPS bearing can flip half a turn between fixes. A heading swinging faster
  // than 45°/s at that speed is a bearing glitch, not a corner.
  function derive(pts) {
    pts = pts.filter((p) => p.lat != null && p.lon != null).sort((a, b) => a.t - b.t);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const near = a && b && b.t - a.t <= 3500;
      const dt = near ? (b.t - a.t) / 1000 : 0;
      p.a = near && a.v != null && b.v != null ? (b.v - a.v) / dt : null;
      p.side = null;
      if (near && p.v > 4 && a.v > 4 && b.v > 4 && a.brg != null && b.brg != null) {
        const turn = ((((b.brg - a.brg) % 360) + 540) % 360) - 180; // degrees, -180..180
        const side = p.v * (turn * Math.PI / 180) / dt;
        if (Math.abs(turn / dt) <= 45 && Math.abs(side) < 1.5 * G) p.side = side;
      }
    }
    return pts;
  }

  // Several trips can share one points array (day, week and outing views): each point then
  // carries `trip`, its trip's index. Returns [first, last] index ranges, one per trip.
  function tripRanges(pts) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === 0 || pts[i].trip !== pts[i - 1].trip) out.push([i, i]);
      else out[out.length - 1][1] = i;
    }
    return out;
  }

  // Standing still: GPS speed under this (about 1 mph). The same line as the server's trip list, for
  // distance, moving time and stops alike, so the list and the trip page agree.
  const STILL_MPS = 0.5;

  // Stops in the middle of a drive: at least 5 s standing still, not counting each trip's start and end.
  function stops(pts) {
    const out = [];
    const slow = (p) => p.v != null && p.v < STILL_MPS;
    for (const [a, b] of tripRanges(pts)) {
      const mine = [];
      let i0 = null;
      for (let i = a; i <= b + 1; i++) {
        if (i <= b && slow(pts[i])) { if (i0 == null) i0 = i; continue; }
        if (i0 != null && pts[i - 1].t - pts[i0].t >= 5000) mine.push({ i0, i1: i - 1, ms: pts[i - 1].t - pts[i0].t });
        i0 = null;
      }
      if (mine.length && mine[0].i0 === a) mine.shift();
      if (mine.length && mine[mine.length - 1].i1 === b) mine.pop();
      out.push(...mine);
    }
    return out;
  }

  // Distance policy, the same as the server's list (server/src/index.ts, segmentMeters): a step
  // counts unless it bridges a gap, the car stood still (GPS speed under 0.5 m/s at both ends:
  // position wander while parked), or it's an impossible jump. Without speeds, only steps longer
  // than the fixes' own uncertainty count.
  const MAX_GAP_MS = 30000;
  function segmentMeters(dtMs, d, v0, v1, acc0, acc1) {
    if (dtMs <= 0 || dtMs > MAX_GAP_MS) return 0;
    if (d / (dtMs / 1000) > 90) return 0;
    if (v0 != null && v1 != null) return v0 > STILL_MPS || v1 > STILL_MPS ? d : 0;
    return d > Math.max(acc0 ?? 0, acc1 ?? 0, 10) ? d : 0;
  }
  function haversine(la1, lo1, la2, lo2) {
    const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }

  function summary(pts) {
    let dist = 0, moving = 0, peak = { brake: 0, accel: 0, corner: 0 }, maxV = null;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (q.trip !== p.trip) continue;
      dist += segmentMeters(q.t - p.t, haversine(p.lat, p.lon, q.lat, q.lon), p.v, q.v, p.acc, q.acc);
      if (q.t - p.t <= MAX_GAP_MS && ((p.v ?? 0) > STILL_MPS || (q.v ?? 0) > STILL_MPS)) moving += q.t - p.t;
    }
    for (const p of pts) {
      if (p.a != null) { peak.brake = Math.min(peak.brake, p.a / G); peak.accel = Math.max(peak.accel, p.a / G); }
      if (p.side != null) peak.corner = Math.max(peak.corner, Math.abs(p.side) / G);
      if (p.v != null && (maxV == null || p.v > maxV)) maxV = p.v;
    }
    return {
      miles: dist / 1609.344,
      movingMs: moving,
      durMs: pts[pts.length - 1].t - pts[0].t,
      avgMph: moving > 0 ? (dist / (moving / 1000)) * MPH : null,
      maxMph: maxV != null ? maxV * MPH : null,
      stops: stops(pts),
      peak,
    };
  }

  // ---------- metrics ----------

  // The map is always the dark one, so route colors are tuned for it alone.
  const ramp = (stops) => (x) => {
    if (x == null || !Number.isFinite(x)) return "#6b6a65";
    if (x <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) {
        const [x0, c0] = stops[i - 1], [x1, c1] = stops[i];
        return mix(c0, c1, (x - x0) / (x1 - x0));
      }
    }
    return stops[stops.length - 1][1];
  };
  function mix(a, b, f) {
    const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const [x, y] = [p(a), p(b)];
    return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * f).toString(16).padStart(2, "0")).join("");
  }
  // One sequential ramp for every one-directional metric, getting steadily brighter from violet to
  // yellow (a plasma-like scale, its dark end lifted so low values still show on the dark map).
  // Brighter always means "more": faster, more pedal, more fuel. No rainbow, so no invented bands,
  // and it still reads with red-green color blindness.
  const SEQ = ["#6c4fd6", "#a23fb8", "#d8487f", "#f2774e", "#f9b23a", "#f4e65c"];
  const at = (xs, colors) => xs.map((x, i) => [x, colors[i]]);

  // Each metric: label, value for a segment (between points p → q), color stops, legend formatting.
  // Scales are fixed (not per drive) so colors compare across drives.
  const METRICS = {
    speed: {
      label: "Speed", unit: "mph", fmt: (x) => x.toFixed(0),
      value: (p, q) => (p.v != null && q.v != null ? ((p.v + q.v) / 2) * MPH : null),
      stops: at([0, 20, 35, 50, 65, 80], SEQ),
      width: [0, 75],
    },
    accel: {
      label: "Accel", unit: "g", fmt: (x) => x.toFixed(2), note: "Red is braking, blue is speeding up, gray is steady",
      value: (p, q) => (p.a != null && q.a != null ? (p.a + q.a) / 2 / G : null),
      // Diverging: two poles and a neutral gray middle.
      stops: [[-0.3, "#ff6b6b"], [-0.1, "#c94a4a"], [0, "#6b6a65"], [0.1, "#3577c9"], [0.3, "#7fb6ff"]],
      width: [0, 0.3], abs: true,
    },
    turn: {
      label: "Turning", unit: "", note: "Gray is straight; bluer the harder you turn left, redder the harder you turn right",
      fmt: (x) => `${Math.abs(x).toFixed(2)} g${x < 0 ? " left" : x > 0 ? " right" : ""}`,
      value: (p, q) => (p.side != null && q.side != null ? (p.side + q.side) / 2 / G : null),
      stops: [[-0.35, "#8fc0ff"], [-0.15, "#3b82e0"], [-0.03, "#6b6a65"], [0.03, "#6b6a65"], [0.15, "#e04848"], [0.35, "#ff8a8a"]],
      width: [0, 0.35], abs: true,
    },
    // From the OBD adapter (p.eng, see engine.js); offered only on drives that have it.
    pedal: {
      label: "Pedal", unit: "%", fmt: (x) => x.toFixed(0), engine: true, note: "The car reads about 20% with your foot off",
      value: (p, q) => q.eng?.pedal ?? null,
      stops: at([21, 30, 40, 52, 66, 85], SEQ),
      width: [21, 85],
    },
    // Fuel per mile here against this drive's average at the same speed (engine.js relCost): where
    // the drive cost more than it had to. Hills, hard acceleration and stop-and-go show up red.
    cost: {
      label: "Cost", unit: "", engine: true,
      fmt: (x) => (Math.abs(x - 1) < 0.005 ? "usual" : x < 1 ? `${Math.round((1 - x) * 100)}% less` : `${Math.round((x - 1) * 100)}% more`),
      note: "Fuel per mile against this drive's average at the same speed. Red cost more, blue less (coasting is bluest)",
      value: (p, q) => q.eng?.rel ?? null,
      stops: [[0.4, "#7fb6ff"], [0.7, "#3577c9"], [0.88, "#6b6a65"], [1.15, "#6b6a65"], [1.5, "#e0703a"], [2, "#ff5a5a"]],
    },
    mpg: {
      label: "MPG", unit: "mpg", fmt: (x) => x.toFixed(0), engine: true, note: "Over a few seconds. Brighter is thirstier; coasting with fuel cut off is darkest",
      value: (p, q) => q.eng?.mpg ?? null,
      stops: at([5, 12, 20, 30, 45, 60], [...SEQ].reverse()),
    },
    fuel: {
      label: "Gal/h", unit: "gal/h", fmt: (x) => x.toFixed(1), engine: true, note: "Estimated fuel flow",
      value: (p, q) => q.eng?.gph ?? null,
      stops: at([0, 0.5, 1, 2, 3.5, 5], SEQ),
      width: [0, 5],
    },
  };

  const WIDTHS = { none: "Even", speed: "Speed", accel: "Accel", turn: "Turning", pedal: "Pedal", fuel: "Gal/h" };
  // What the map offers: four views, each one color at an even width. Cost and pedal need engine data.
  const VIEWS = {
    cost: { label: "Cost", color: "cost", engine: true },
    speed: { label: "Speed", color: "speed" },
    smooth: { label: "Smooth", color: "accel" },
    pedal: { label: "Pedal", color: "pedal", engine: true },
  };
  const stopsFor = (m) => m.stops;

  // ---------- marks along the route ----------

  // Compass bearing from a to b in degrees. Web Mercator keeps angles, so it's also the on-screen angle.
  const bearingOf = (a, b) => {
    const r = Math.PI / 180, y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  };

  // Where a running total along each trip passes each multiple of `step`: [{ lat, lon, brg, n, i }],
  // n counting from 1 in each trip, i the fix just after. `amount(p, q)` is what the step from p to
  // q adds (ms for time; dollars or gallons for gas). Positions are interpolated between the fixes.
  // Across a GPS gap the total still counts, but no mark is placed: there's no route to put it on.
  function marksAlong(pts, step, amount) {
    // The count carries on from one trip to the next, so marks number the trips in order.
    const out = [];
    let total = 0;
    for (const [a, b] of tripRanges(pts)) {
      let brg = null;
      for (let i = a + 1; i <= b; i++) {
        const p = pts[i - 1], q = pts[i];
        const add = amount(p, q);
        if (!(add > 0)) continue;
        // Heading from the route itself (GPS bearing wanders when slow), kept through stops.
        if (haversine(p.lat, p.lon, q.lat, q.lon) > 3) brg = bearingOf(p, q);
        let left = add;
        for (;;) {
          const next = (Math.floor(total / step + 1e-9) + 1) * step;
          if (total + left < next - 1e-9) break;
          left -= next - total;
          total = next;
          const f = 1 - left / add;
          if (q.t - p.t <= 5000) out.push({ lat: p.lat + (q.lat - p.lat) * f, lon: p.lon + (q.lon - p.lon) * f, brg: brg ?? 0, n: Math.round(next / step), i });
        }
        total += left;
      }
    }
    return out;
  }

  // A mark every minute of driving time.
  const minuteMarks = (pts) => marksAlong(pts, 60000, (p, q) => q.t - p.t);

  // A mark every so much gas, from the engine rows attached to the fixes (p.eng). With a price, in
  // cents: the smallest of 5, 10, 25, 50 or 100¢ that leaves at most 60 marks; without one, gallons.
  // Returns { marks, step, unit: "$" | "gal" }, or null without fuel readings.
  function gasMarks(pts, price = null) {
    const amount = (p, q) => {
      const dt = (q.t - p.t) / 1000;
      if (dt <= 0 || dt > 5 || q.eng?.fuelGs == null) return 0;
      const gal = (q.eng.fuelGs * dt) / 745 / 3.78541;
      return price != null ? gal * price : gal;
    };
    let total = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i].trip === pts[i - 1].trip) total += amount(pts[i - 1], pts[i]);
    if (!(total > 0)) return null;
    const steps = price != null ? [0.05, 0.1, 0.25, 0.5, 1] : [0.01, 0.025, 0.05, 0.1, 0.25];
    const step = steps.find((s) => total / s <= 60) ?? steps[steps.length - 1];
    return { marks: marksAlong(pts, step, amount), step, unit: price != null ? "$" : "gal" };
  }

  // ---------- rendering ----------

  function render(el, pts, state, onPick) {
    if (el._map) el._map.remove();
    const map = L.map(el, { preferCanvas: true, zoomControl: false, attributionControl: true });
    el._map = map;
    L.control.zoom({ position: "bottomright" }).addTo(map);
    // Always the dark map: OpenStreetMap tiles, grayscaled and inverted (see .tiles-dark).
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap", className: "tiles-dark" }).addTo(map);
    // The route sits in its own pane drawn slightly see-through as a whole, so street names show
    // through it without the overlapping segment ends adding up to darker beads.
    map.createPane("route").style.opacity = "0.78";

    const layer = L.layerGroup().addTo(map);
    const marks = L.layerGroup().addTo(map);
    const ticks = L.layerGroup().addTo(map);
    let tickLabels = [];
    // Tick labels that would overlap one placed earlier stay hidden until zooming in separates them.
    function declutterTicks() {
      const placed = [];
      for (const mk of tickLabels) {
        const el = mk.getElement();
        if (!el) continue;
        el.style.visibility = "";
        const r = el.firstChild.getBoundingClientRect();
        if (placed.some((q) => r.left < q.right + 3 && r.right + 3 > q.left && r.top < q.bottom + 1 && r.bottom + 1 > q.top)) el.style.visibility = "hidden";
        else placed.push(r);
      }
    }
    let focus = null; // trip index to bring forward, or null for all
    draw(layer, marks, pts, state, focus);
    // Room for the controls over the top of the map and the legend along the bottom.
    const fit = () => map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { paddingTopLeft: [30, 100], paddingBottomRight: [30, 70] });
    fit();

    // Hover (mouse) or tap anywhere near the route picks the nearest fix.
    const nearest = (latlng) => {
      const at = map.latLngToContainerPoint(latlng);
      let best = -1, bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = at.distanceTo(map.latLngToContainerPoint([pts[i].lat, pts[i].lon]));
        if (d < bestD) { bestD = d; best = i; }
      }
      return bestD <= 28 ? best : -1;
    };
    let frame = 0;
    map.on("mousemove", (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => onPick(nearest(e.latlng), "map"));
    });
    map.on("mouseout", () => onPick(-1, "map"));
    map.on("click", (e) => onPick(nearest(e.latlng), "map"));

    const cursor = L.marker([0, 0], { icon: dotIcon("end-dot ring", 18), interactive: false, keyboard: false });
    const moments = L.layerGroup().addTo(map);
    const placeLayer = L.layerGroup().addTo(map);
    // Labels that would overlap one listed earlier are hidden until zooming in separates them.
    // Named places go first, so they win over moments.
    function declutter() {
      const placed = [];
      for (const layer of [placeLayer, moments]) layer.eachLayer((mk) => {
        const el = mk.getTooltip()?.getElement();
        if (!el) return;
        el.style.visibility = "";
        const r = el.getBoundingClientRect();
        const hit = placed.some((q) => r.left < q.right + 4 && r.right + 4 > q.left && r.top < q.bottom + 2 && r.bottom + 2 > q.top);
        if (hit) el.style.visibility = "hidden"; else placed.push(r);
      });
    }
    map.on("zoomend resize", () => { declutter(); declutterTicks(); });

    // Named places along the drive, labeled where the drive was there; and a ring for one place
    // (named or not) while its name is being edited.
    // Over the route and its markers (its own pane, drawn as SVG so the canvas route can't cover it).
    map.createPane("place-ring").style.zIndex = "650";
    const ring = L.circleMarker([0, 0], { radius: 18, color: "#f0b429", weight: 3, fillColor: "#f0b429", fillOpacity: 0.18, interactive: false, pane: "place-ring", renderer: L.svg({ pane: "place-ring" }) });
    let placeList = [];
    return {
      // [{ lat, lon, name }]: each named place labeled once.
      places(list) {
        placeList = list;
        placeLayer.clearLayers();
        const done = [];
        for (const v of list) {
          if (!v.name || done.some((d) => d.name === v.name && haversine(d.lat, d.lon, v.lat, v.lon) < 300)) continue;
          done.push(v);
          L.circleMarker([v.lat, v.lon], { radius: 4, color: "#0b0b0b", weight: 2, fillColor: "#f0b429", fillOpacity: 1, interactive: false })
            .bindTooltip(v.name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), { permanent: true, direction: "right", offset: [6, 0], className: "place-label" })
            .addTo(placeLayer);
        }
        declutter();
      },
      // Ring place k of the list (null: none), panning to it if it's off screen.
      highlightPlace(k) {
        const v = placeList[k];
        if (!v) { ring.remove(); return; }
        ring.setLatLng([v.lat, v.lon]).addTo(map);
        if (!map.getBounds().pad(-0.1).contains([v.lat, v.lon])) map.panTo([v.lat, v.lon]);
      },
      // Labels pinned to the map at notable moments: [{ i: point index, text, dir? }]. Hover or tap shows that moment.
      moments(list) {
        moments.clearLayers();
        for (const m of list) {
          const p = pts[m.i];
          const mk = L.circleMarker([p.lat, p.lon], { radius: 4, color: "#fff", weight: 2, fillColor: "#0b0b0b", fillOpacity: 1 })
            .bindTooltip(m.text, { permanent: true, direction: m.dir || "top", offset: [0, m.dir === "bottom" ? 6 : -6], className: "moment" })
            .addTo(moments);
          mk.on("mouseover click", () => onPick(m.i, "moment"));
        }
        declutter();
      },
      // Ruler ticks across the route: [{ lat, lon, brg, major, label }]. A major tick is longer and
      // carries a small label beside it, on the left of the direction of travel.
      ticks(list) {
        ticks.clearLayers();
        tickLabels = [];
        for (const t of list) {
          const len = t.major ? 16 : 9;
          L.marker([t.lat, t.lon], {
            icon: L.divIcon({ className: "tick" + (t.major ? " major" : ""), iconSize: [len, len], html: `<i style="height:${len}px;transform:rotate(${(t.brg + 90).toFixed(0)}deg)"></i>` }),
            interactive: false, keyboard: false, pane: "markerPane",
          }).addTo(ticks);
          if (t.major && t.label) {
            const a = ((t.brg - 90) * Math.PI) / 180, d = 15; // to the left of travel
            const dx = Math.sin(a) * d, dy = -Math.cos(a) * d;
            tickLabels.push(L.marker([t.lat, t.lon], {
              icon: L.divIcon({ className: "tick-label", iconSize: [0, 0], iconAnchor: [-dx, -dy], html: `<span>${t.label}</span>` }),
              interactive: false, keyboard: false,
            }).addTo(ticks));
          }
        }
        declutterTicks();
      },
      showMoments(on) { if (on) { moments.addTo(map); declutter(); } else moments.remove(); },
      map,
      fit,
      redraw: () => draw(layer, marks, pts, state, focus),
      // Fade every trip but one (null shows them all evenly).
      focus(k) {
        if (k === focus) return;
        focus = k;
        draw(layer, marks, pts, state, focus);
      },
      mark(i) {
        if (i < 0) { cursor.remove(); return; }
        cursor.setLatLng([pts[i].lat, pts[i].lon]).addTo(map);
      },
    };
  }

  function draw(layer, marks, pts, state, focus = null) {
    layer.clearLayers();
    marks.clearLayers();
    const color = METRICS[state.color];
    const widthM = state.width === "none" ? null : METRICS[state.width];
    const colorOf = segmentColors(pts, state);
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (q.t - p.t > 5000) continue; // GPS gap: don't draw a straight line across it
      let w = 6;
      if (widthM) {
        let wv = widthM.value(p, q);
        if (wv != null && widthM.abs) wv = Math.abs(wv);
        const [lo, hi] = widthM.width;
        w = wv == null ? 3 : 2.5 + 19 * Math.min(1, Math.max(0, (wv - lo) / (hi - lo)));
      }
      if (q.trip !== p.trip) continue; // never join one trip's end to the next one's start
      segs.push([[[p.lat, p.lon], [q.lat, q.lon]], colorOf(i), w, focus == null || q.trip === focus]);
    }
    // Dark casing first, then the colors on top, so the route reads on any background.
    // The focused trip (if any) is drawn last, over the faded others.
    segs.sort((x, y) => x[3] - y[3]);
    // Faded trips are solid gray, not see-through: overlapping round caps would show as beads.
    const faded = "#4a4946";
    const line = { lineCap: "round", lineJoin: "round", interactive: false, pane: "route" };
    for (const [ll, , w, on] of segs) if (on) L.polyline(ll, { ...line, color: "#0b0b0b", weight: w + 3, opacity: 0.55 }).addTo(layer);
    for (const [ll, c, w, on] of segs) L.polyline(ll, { ...line, color: on ? c : faded, weight: on ? w : Math.min(w, 4), opacity: 1 }).addTo(layer);

    const shown = (p) => focus == null || p.trip === focus;
    for (const s of stops(pts)) {
      const p = pts[s.i0];
      if (!shown(p)) continue;
      L.circleMarker([p.lat, p.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#52514e", fillOpacity: 1 })
        .bindTooltip(`Stopped ${stopLength(s.ms)}`, { direction: "top" }).addTo(marks);
    }
    const ranges = tripRanges(pts);
    const at = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    for (const [a, b] of ranges) {
      const first = pts[a], last = pts[b];
      if (!shown(first)) continue;
      const many = ranges.length > 1;
      L.circleMarker([first.lat, first.lon], { radius: many ? 6 : 8, color: "#fff", weight: many ? 2 : 3, fillColor: "#0ca30c", fillOpacity: 1 })
        .bindTooltip(many ? `Start ${at(first.t)}` : "Start").addTo(marks);
      L.marker([last.lat, last.lon], { icon: dotIcon("end-dot", many ? 14 : 18), keyboard: false })
        .bindTooltip(many ? `End ${at(last.t)}` : "End").addTo(marks);
    }
  }

  // "45 s", "2 min 5 s", "12 min".
  function stopLength(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60), r = s % 60;
    return m >= 10 || !r ? `${m} min` : `${m} min ${r} s`;
  }

  function dotIcon(className, size) {
    return L.divIcon({ className, iconSize: [size, size], html: "" });
  }

  // Color for the segment ending at point i, under the current color metric.
  function segmentColors(pts, state) {
    const m = METRICS[state.color];
    const c = ramp(stopsFor(m));
    return (i) => c(m.value(pts[Math.max(0, i - 1)], pts[i]));
  }

  function legendHtml(state, pts) {
    const m = METRICS[state.color];
    const s = stopsFor(m);
    const grad = s.map(([, c], i) => `${c} ${(i / (s.length - 1)) * 100}%`).join(", ");
    const lo = `${m.fmt(s[0][0])} ${m.unit}`;
    const hi = m.unit ? `${m.fmt(s[s.length - 1][0])}+ ${m.unit}` : m.fmt(s[s.length - 1][0]);
    return `<div class="legend"><span>${lo}</span><span class="bar" style="background:linear-gradient(90deg, ${grad})"></span><span>${hi}</span></div>` +
      (m.note ? `<p class="hint">${m.note}</p>` : "");
  }

  return { fromChunks, rawChunks, merge, segmentMeters, haversine, fromRaw, render, tripRanges, legendHtml, summary, segmentColors, minuteMarks, gasMarks, STILL_MPS, METRICS, WIDTHS, VIEWS, G, MPH };
})();
