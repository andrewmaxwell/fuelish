// Route data and map: builds per-fix points from a recording, and draws the GPS track
// colored and sized by a chosen metric. Points come from chunk summaries (phone-computed,
// trackFormat 2) or, for older recordings, are rebuilt in the browser from the raw chunks.

const Route = (() => {
  const G = 9.80665;
  const MPH = 2.236936;

  // ---------- building points ----------

  // Point: { t: wall ms, lat, lon, v: m/s|null, acc: m|null, brg: deg|null, jolt: m/s²|null,
  //          a: forward accel m/s²|null, side: sideways accel m/s² (+ = turning right)|null }
  function fromChunks(chunks) {
    if (!chunks.length || chunks.some((c) => c.meta.trackFormat !== 2)) return null;
    const pts = chunks.flatMap((c) => c.meta.track || []).map((p) => ({
      t: p[0], lat: p[1], lon: p[2], v: p[3], acc: p[4], brg: p[5], jolt: p[6],
    }));
    return derive(pts);
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
  // (central differences; null across gaps, and sideways also below 3 m/s where bearing is noise).
  function derive(pts) {
    pts = pts.filter((p) => p.lat != null && p.lon != null).sort((a, b) => a.t - b.t);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const near = a && b && b.t - a.t <= 3500;
      const dt = near ? (b.t - a.t) / 1000 : 0;
      p.a = near && a.v != null && b.v != null ? (b.v - a.v) / dt : null;
      p.side = null;
      if (near && p.v != null && p.v > 3 && a.v > 2 && b.v > 2 && a.brg != null && b.brg != null) {
        const turn = ((((b.brg - a.brg) % 360) + 540) % 360) - 180; // degrees, -180..180
        const side = p.v * (turn * Math.PI / 180) / dt;
        if (Math.abs(side) < 1.5 * G) p.side = side;
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

  // Stops in the middle of a drive: at least 5 s below 1 mph, not counting each trip's start and end.
  function stops(pts) {
    const out = [];
    const slow = (p) => p.v != null && p.v < 0.45;
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

  function summary(pts) {
    let dist = 0, moving = 0, peak = { brake: 0, accel: 0, corner: 0 };
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (q.t - p.t > 5000 || q.trip !== p.trip) continue;
      dist += L.latLng(p.lat, p.lon).distanceTo([q.lat, q.lon]);
      if ((p.v ?? 0) > 0.45 || (q.v ?? 0) > 0.45) moving += q.t - p.t;
    }
    for (const p of pts) {
      if (p.a != null) { peak.brake = Math.min(peak.brake, p.a / G); peak.accel = Math.max(peak.accel, p.a / G); }
      if (p.side != null) peak.corner = Math.max(peak.corner, Math.abs(p.side) / G);
    }
    const mph = pts.filter((p) => p.v != null).map((p) => p.v * MPH);
    return {
      miles: dist / 1609.344,
      movingMs: moving,
      durMs: pts[pts.length - 1].t - pts[0].t,
      avgMph: moving > 0 ? (dist / (moving / 1000)) * MPH : null,
      maxMph: mph.length ? Math.max(...mph) : null,
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
  const RED = "#ef4444", ORANGE = "#f28c28", YELLOW = "#f2c94c", GREEN = "#3fc66b", BLUE = "#3b8ff6", PURPLE = "#b25cf6";
  const at = (xs, colors) => xs.map((x, i) => [x, colors[i]]);

  // Each metric: label, value for a segment (between points p → q), color stops, legend formatting.
  // Scales are fixed (not per drive) so colors compare across drives.
  const METRICS = {
    speed: {
      label: "Speed", unit: "mph", fmt: (x) => x.toFixed(0), note: "Red stopped, yellow slow, green cruising, blue fast, purple very fast",
      value: (p, q) => (p.v != null && q.v != null ? ((p.v + q.v) / 2) * MPH : null),
      stops: at([0, 8, 18, 35, 55, 75], [RED, ORANGE, YELLOW, GREEN, BLUE, PURPLE]),
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
      label: "Pedal", unit: "%", fmt: (x) => x.toFixed(0), engine: true, note: "Blue is foot off the pedal (the car reads about 20% at rest), red is floored",
      value: (p, q) => q.eng?.pedal ?? null,
      stops: at([21, 28, 45, 65, 85], [BLUE, GREEN, YELLOW, ORANGE, RED]),
      width: [21, 85],
    },
    mpg: {
      label: "MPG", unit: "mpg", fmt: (x) => x.toFixed(0), engine: true, note: "Miles per gallon over a few seconds. Red is thirsty, green efficient, blue coasting with fuel cut off",
      value: (p, q) => q.eng?.mpg ?? null,
      stops: at([5, 15, 25, 40, 60], [RED, ORANGE, YELLOW, GREEN, BLUE]),
    },
    fuel: {
      label: "Gal/h", unit: "gal/h", fmt: (x) => x.toFixed(1), engine: true, note: "Estimated fuel flow. Blue is coasting with fuel cut off",
      value: (p, q) => q.eng?.gph ?? null,
      stops: at([0, 0.3, 1, 2.5, 5], [BLUE, GREEN, YELLOW, ORANGE, RED]),
      width: [0, 5],
    },
  };

  const WIDTHS = { none: "Even", speed: "Speed", accel: "Accel", turn: "Turning", pedal: "Pedal", fuel: "Gal/h" };
  const stopsFor = (m) => m.stops;

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
    // Labels that would overlap one listed earlier are hidden until zooming in separates them.
    function declutter() {
      const placed = [];
      moments.eachLayer((mk) => {
        const el = mk.getTooltip()?.getElement();
        if (!el) return;
        el.style.visibility = "";
        const r = el.getBoundingClientRect();
        const hit = placed.some((q) => r.left < q.right + 4 && r.right + 4 > q.left && r.top < q.bottom + 2 && r.bottom + 2 > q.top);
        if (hit) el.style.visibility = "hidden"; else placed.push(r);
      });
    }
    map.on("zoomend resize", declutter);
    return {
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
        .bindTooltip(`Stopped ${Math.round(s.ms / 1000)} s`, { direction: "top" }).addTo(marks);
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

  return { fromChunks, fromRaw, render, tripRanges, legendHtml, summary, segmentColors, METRICS, WIDTHS, G, MPH };
})();
