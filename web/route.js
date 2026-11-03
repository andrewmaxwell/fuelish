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

  // Stops in the middle of a drive: at least 5 s below 1 mph, not counting the start and end.
  function stops(pts) {
    const out = [];
    let i0 = null;
    const slow = (p) => p.v != null && p.v < 0.45;
    for (let i = 0; i <= pts.length; i++) {
      if (i < pts.length && slow(pts[i])) { if (i0 == null) i0 = i; continue; }
      if (i0 != null && pts[i - 1].t - pts[i0].t >= 5000) out.push({ i0, i1: i - 1, ms: pts[i - 1].t - pts[i0].t });
      i0 = null;
    }
    if (out.length && out[0].i0 === 0) out.shift();
    if (out.length && out[out.length - 1].i1 === pts.length - 1) out.pop();
    return out;
  }

  function summary(pts) {
    let dist = 0, moving = 0, peak = { brake: 0, accel: 0, corner: 0 };
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (q.t - p.t > 5000) continue;
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

  const dark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

  const ramp = (stops) => (x) => {
    if (x == null || !Number.isFinite(x)) return dark() ? "#5f5e5a" : "#a3a29b";
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
  // Sequential ramps run toward more contrast with the map: darker on the light map, brighter on the dark
  // one. Each theme has its own steps; the low end stays clear of the map in both.
  const seq = (xs, light, dark) => ({ light: xs.map((x, i) => [x, light[i]]), dark: xs.map((x, i) => [x, dark[i]]) });
  const BLUE = [["#b7d3f6", "#6da7ec", "#2a78d6", "#1c5cab", "#0d366b"], ["#1f5fb0", "#3987e5", "#6da7ec", "#b7d3f6", "#f2f7fe"]];
  const ORANGE = [["#fbd8c7", "#f5a17d", "#eb6834", "#b84a1e", "#7a2e10"], ["#9c3c16", "#d95926", "#f5a17d", "#fbd8c7", "#fff4ee"]];
  const VIOLET = [["#d9d4f7", "#a99ef0", "#6250d6", "#3f30a3"], ["#4a3bb0", "#9085e9", "#c4bdf5", "#f1effd"]];

  // Each metric: label, value for a segment (between points p → q), color stops per theme, legend formatting.
  // Scales are fixed (not per drive) so colors compare across drives.
  const METRICS = {
    speed: {
      label: "Speed", unit: "mph", fmt: (x) => x.toFixed(0),
      value: (p, q) => (p.v != null && q.v != null ? ((p.v + q.v) / 2) * MPH : null),
      stops: seq([0, 10, 25, 40, 60], ...BLUE),
      width: [0, 70],
    },
    accel: {
      label: "Accel", unit: "g", fmt: (x) => x.toFixed(2), note: "Red is braking, blue is speeding up",
      value: (p, q) => (p.a != null && q.a != null ? (p.a + q.a) / 2 / G : null),
      // Diverging: two poles and a neutral gray middle.
      stops: {
        light: [[-0.3, "#a32323"], [-0.12, "#e34948"], [0, "#b8b6ae"], [0.12, "#2a78d6"], [0.3, "#104281"]],
        dark: [[-0.3, "#ff8a89"], [-0.12, "#e66767"], [0, "#6b6a65"], [0.12, "#3987e5"], [0.3, "#9ec5f4"]],
      },
      width: [0, 0.3], abs: true,
    },
    jolt: {
      label: "Bumps", unit: "g", fmt: (x) => x.toFixed(1), note: "Biggest jolt between GPS fixes (includes mount bounce)",
      value: (p, q) => (q.jolt != null ? q.jolt / G : null),
      stops: seq([0, 0.15, 0.3, 0.5, 0.8], ...ORANGE),
      width: [0, 0.8],
    },
    accuracy: {
      label: "GPS", unit: "m", fmt: (x) => x.toFixed(0), note: "Estimated GPS error",
      value: (p, q) => (q.acc != null ? q.acc : null),
      stops: seq([2, 5, 10, 20], ...VIOLET),
      width: [0, 25],
    },
    time: {
      label: "Time", unit: "",
      value: null, // filled per route: 0..1 progress
      stops: seq([0, 0.33, 0.66, 1], ...VIOLET),
    },
  };

  const WIDTHS = { none: "Even", speed: "Speed", accel: "Accel", jolt: "Bumps" };
  const BASES = { muted: "Map", streets: "Streets", satellite: "Satellite" };
  const stopsFor = (m) => m.stops[dark() ? "dark" : "light"];

  // ---------- rendering ----------

  function render(el, pts, state, onPick) {
    if (el._map) el._map.remove();
    const map = L.map(el, { preferCanvas: true, zoomControl: false, attributionControl: true });
    el._map = map;
    L.control.zoom({ position: "topright" }).addTo(map);
    const osm = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    const bases = {
      muted: L.tileLayer(osm, { maxZoom: 19, attribution: "&copy; OpenStreetMap", className: "tiles-muted" }),
      streets: L.tileLayer(osm, { maxZoom: 19, attribution: "&copy; OpenStreetMap" }),
      satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, attribution: "Imagery &copy; Esri",
      }),
    };
    let base = null;
    const setBase = (k) => {
      if (base) map.removeLayer(base);
      base = (bases[k] || bases.muted).addTo(map);
      base.bringToBack();
    };
    setBase(state.base);

    const layer = L.layerGroup().addTo(map);
    const marks = L.layerGroup().addTo(map);
    draw(layer, marks, pts, state);
    const fit = () => map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { padding: [36, 36] });
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
    return {
      map,
      fit,
      setBase,
      redraw: () => draw(layer, marks, pts, state),
      mark(i) {
        if (i < 0) { cursor.remove(); return; }
        cursor.setLatLng([pts[i].lat, pts[i].lon]).addTo(map);
      },
    };
  }

  function draw(layer, marks, pts, state) {
    layer.clearLayers();
    marks.clearLayers();
    const color = METRICS[state.color];
    const widthM = state.width === "none" ? null : METRICS[state.width];
    const colorOf = segmentColors(pts, state);
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (q.t - p.t > 5000) continue; // GPS gap: don't draw a straight line across it
      let w = 5;
      if (widthM) {
        let wv = widthM.value(p, q);
        if (wv != null && widthM.abs) wv = Math.abs(wv);
        const [lo, hi] = widthM.width;
        w = wv == null ? 3 : 2.5 + 11 * Math.min(1, Math.max(0, (wv - lo) / (hi - lo)));
      }
      segs.push([[[p.lat, p.lon], [q.lat, q.lon]], colorOf(i), w]);
    }
    // Dark casing first, then the colors on top, so the route reads on any background.
    for (const [ll, , w] of segs) L.polyline(ll, { color: "#0b0b0b", weight: w + 3, opacity: 0.6, lineCap: "round", interactive: false }).addTo(layer);
    for (const [ll, c, w] of segs) L.polyline(ll, { color: c, weight: w, opacity: 1, lineCap: "round", interactive: false }).addTo(layer);

    for (const s of stops(pts)) {
      const p = pts[s.i0];
      L.circleMarker([p.lat, p.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#52514e", fillOpacity: 1 })
        .bindTooltip(`Stopped ${Math.round(s.ms / 1000)} s`, { direction: "top" }).addTo(marks);
    }
    const first = pts[0], last = pts[pts.length - 1];
    L.circleMarker([first.lat, first.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#0ca30c", fillOpacity: 1 }).bindTooltip("Start").addTo(marks);
    L.marker([last.lat, last.lon], { icon: dotIcon("end-dot", 18), keyboard: false }).bindTooltip("End").addTo(marks);
  }

  function dotIcon(className, size) {
    return L.divIcon({ className, iconSize: [size, size], html: "" });
  }

  // Color for the segment ending at point i, under the current color metric.
  function segmentColors(pts, state) {
    const m = METRICS[state.color];
    const c = ramp(stopsFor(m));
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    return (i) => c(state.color === "time" ? (pts[i].t - t0) / Math.max(1, t1 - t0) : m.value(pts[Math.max(0, i - 1)], pts[i]));
  }

  function legendHtml(state, pts) {
    const m = METRICS[state.color];
    const s = stopsFor(m);
    const grad = s.map(([, c], i) => `${c} ${(i / (s.length - 1)) * 100}%`).join(", ");
    let lo, hi;
    if (state.color === "time") {
      const f = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      lo = f(pts[0].t);
      hi = f(pts[pts.length - 1].t);
    } else {
      lo = `${m.fmt(s[0][0])} ${m.unit}`;
      hi = `${m.fmt(s[s.length - 1][0])}+ ${m.unit}`;
    }
    return `<div class="legend"><span>${lo}</span><span class="bar" style="background:linear-gradient(90deg, ${grad})"></span><span>${hi}</span></div>` +
      (m.note ? `<p class="hint">${m.note}</p>` : "");
  }

  return { fromChunks, fromRaw, render, legendHtml, summary, segmentColors, METRICS, WIDTHS, BASES, G, MPH };
})();
