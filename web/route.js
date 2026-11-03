// Route view: draws a recording's GPS track colored and sized by a chosen metric.
// Points come from chunk summaries (phone-computed, trackFormat 2) or, for older
// recordings, are rebuilt in the browser from the raw chunks.

const Route = (() => {
  const G = 9.80665;
  const MPH = 2.236936;

  // ---------- building points ----------

  // Point: { t: wall ms, lat, lon, v: m/s|null, acc: m|null, brg, jolt: m/s²|null, a: m/s²|null }
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

  // Longitudinal acceleration from GPS speed (central difference; null across gaps).
  function derive(pts) {
    pts = pts.filter((p) => p.lat != null && p.lon != null).sort((a, b) => a.t - b.t);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      p.a = a && b && a.v != null && b.v != null && b.t - a.t <= 3500 ? (b.v - a.v) / ((b.t - a.t) / 1000) : null;
    }
    return pts;
  }

  // ---------- metrics ----------

  const ramp = (stops) => (x) => {
    if (x == null || !Number.isFinite(x)) return "#9aa0a6";
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

  // Each metric: label, value for a segment (between points p → q), color stops, legend formatting.
  const METRICS = {
    speed: {
      label: "Speed", unit: "mph",
      value: (p, q) => (p.v != null && q.v != null ? ((p.v + q.v) / 2) * MPH : null),
      // Fixed scale (not per drive) so colors compare across drives.
      stops: [[0, "#d73027"], [10, "#f46d43"], [20, "#fee08b"], [35, "#a6d96a"], [55, "#1a9850"]],
      width: [0, 70],
    },
    accel: {
      label: "Acceleration", unit: "g", note: "red = braking, green = speeding up",
      value: (p, q) => (p.a != null && q.a != null ? (p.a + q.a) / 2 / G : null),
      stops: [[-0.3, "#d73027"], [-0.1, "#fc8d59"], [0, "#7b8794"], [0.1, "#91cf60"], [0.3, "#1a9850"]],
      width: [0, 0.3], abs: true,
    },
    jolt: {
      label: "Bumpiness", unit: "g", note: "biggest jolt between GPS fixes (includes mount bounce)",
      value: (p, q) => (q.jolt != null ? q.jolt / G : null),
      stops: [[0, "#2c7bb6"], [0.15, "#abd9e9"], [0.3, "#ffffbf"], [0.5, "#fdae61"], [0.8, "#d7191c"]],
      width: [0, 0.8],
    },
    accuracy: {
      label: "GPS accuracy", unit: "m",
      value: (p, q) => (q.acc != null ? q.acc : null),
      stops: [[3, "#1a9850"], [8, "#fee08b"], [20, "#d73027"]],
      width: [0, 25],
    },
    time: {
      label: "Time", unit: "",
      value: null, // filled per route: 0..1 progress
      stops: [[0, "#440154"], [0.33, "#31688e"], [0.66, "#35b779"], [1, "#fde725"]],
    },
    none: { label: "Single color", stops: [[0, "#1f6feb"]] },
  };

  const WIDTHS = {
    none: "Constant",
    accel: "Acceleration (either direction)",
    jolt: "Bumpiness",
    speed: "Speed",
  };

  // ---------- rendering ----------

  function render(el, pts, state) {
    if (el._map) el._map.remove();
    const map = L.map(el, { preferCanvas: true });
    el._map = map;
    // Muted default so the colored route stands out; full street map and satellite on demand.
    const light = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors", className: "muted-tiles",
    });
    const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    });
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Imagery &copy; Esri",
    });
    const bases = { Light: light, Streets: streets, Satellite: satellite };
    (bases[state.base] || light).addTo(map);
    L.control.layers(bases, null, { collapsed: window.innerWidth < 700 }).addTo(map); // small button on phones
    map.on("baselayerchange", (e) => { state.base = e.name; });

    const layer = L.layerGroup().addTo(map);
    draw(layer, pts, state);
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon])), { padding: [20, 20] });

    // Tap anywhere on the route for the nearest point's details.
    map.on("click", (e) => {
      const at = map.latLngToContainerPoint(e.latlng);
      let best = null, bestD = Infinity;
      for (const p of pts) {
        const d = at.distanceTo(map.latLngToContainerPoint([p.lat, p.lon]));
        if (d < bestD) { bestD = d; best = p; }
      }
      if (!best || bestD > 30) return;
      const fmt = (x, d, u) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d) + u);
      L.popup().setLatLng([best.lat, best.lon]).setContent(
        `<b>${new Date(best.t).toLocaleTimeString()}</b><br>` +
        `Speed ${fmt(best.v != null ? best.v * MPH : null, 0, " mph")}<br>` +
        `Acceleration ${fmt(best.a != null ? best.a / G : null, 2, " g")}<br>` +
        `Bumpiness ${fmt(best.jolt != null ? best.jolt / G : null, 2, " g")}<br>` +
        `GPS accuracy ${fmt(best.acc, 0, " m")}`,
      ).openOn(map);
    });
    return { redraw: () => draw(layer, pts, state) };
  }

  function draw(layer, pts, state) {
    layer.clearLayers();
    const color = METRICS[state.color];
    const widthM = state.width === "none" ? null : METRICS[state.width];
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const colorOf = ramp(color.stops);
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      if (q.t - p.t > 5000) continue; // GPS gap: don't draw a straight line across it
      const cv = state.color === "time" ? (q.t - t0) / Math.max(1, t1 - t0) : color.value ? color.value(p, q) : 0;
      let w = 5;
      if (widthM) {
        let wv = widthM.value(p, q);
        if (wv != null && widthM.abs) wv = Math.abs(wv);
        const [lo, hi] = widthM.width;
        w = wv == null ? 3 : 2 + 12 * Math.min(1, Math.max(0, (wv - lo) / (hi - lo)));
      }
      segs.push([[[p.lat, p.lon], [q.lat, q.lon]], colorOf(cv), w]);
    }
    // Dark edge first, then the colors on top, so the route reads on any background.
    for (const [ll, , w] of segs) L.polyline(ll, { color: "#1b1f24", weight: w + 3, opacity: 0.55, lineCap: "round", interactive: false }).addTo(layer);
    for (const [ll, c, w] of segs) L.polyline(ll, { color: c, weight: w, opacity: 1, lineCap: "round", interactive: false }).addTo(layer);
    const first = pts[0], last = pts[pts.length - 1];
    L.circleMarker([first.lat, first.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#1a9850", fillOpacity: 1 }).bindTooltip("Start").addTo(layer);
    L.circleMarker([last.lat, last.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#111", fillOpacity: 1 }).bindTooltip("End").addTo(layer);
  }

  function legendHtml(state, pts) {
    const m = METRICS[state.color];
    if (state.color === "none") return "";
    const grad = m.stops.map(([x, c], i) => `${c} ${(i / (m.stops.length - 1)) * 100}%`).join(", ");
    let lo, hi;
    if (state.color === "time") {
      lo = new Date(pts[0].t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      hi = new Date(pts[pts.length - 1].t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } else {
      lo = `${m.stops[0][0]} ${m.unit}`;
      hi = `${m.stops[m.stops.length - 1][0]}+ ${m.unit}`;
    }
    return `<div class="legend"><span>${lo}</span><span class="bar" style="background:linear-gradient(90deg, ${grad})"></span><span>${hi}</span></div>` +
      (m.note ? `<p class="muted">${m.note}</p>` : "");
  }

  function summary(pts) {
    const mph = pts.filter((p) => p.v != null).map((p) => p.v * MPH);
    let dist = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t - pts[i - 1].t <= 5000) dist += L.latLng(pts[i - 1].lat, pts[i - 1].lon).distanceTo([pts[i].lat, pts[i].lon]);
    }
    const brakes = pts.filter((p) => p.a != null).map((p) => p.a / G);
    return {
      miles: dist / 1609.344,
      maxMph: mph.length ? Math.max(...mph) : null,
      hardestBrake: brakes.length ? Math.min(...brakes) : null,
      hardestAccel: brakes.length ? Math.max(...brakes) : null,
    };
  }

  return { fromChunks, fromRaw, render, legendHtml, summary, METRICS, WIDTHS };
})();
