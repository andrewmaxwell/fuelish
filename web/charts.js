// Trip charts drawn as plain SVG: the speed timeline under the map and the friction circle.
// Both call onPick(index) on hover and highlight a point when told to, so they stay linked to the map.

const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // Speed over time, with a strip below it in the route's current colors, then optional extra rows
  // on the same time axis (engine data): { label, unit, get(p) -> number|null, fmt(x), min?, max? }.
  function timeline(host, pts, onPick, extraRows = []) {
    const SPEED_H = 64, ROW_H = 54, top = 12, stripH = 6, bottom = 22, left = 34, right = 12;
    const svg = el("svg", { class: "timeline", role: "img", "aria-label": "Speed over time" }, host);
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    host.appendChild(tip);
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const vmax = Math.max(30, ...pts.map((p) => (p.v ?? 0) * Route.MPH));
    const ymax = Math.ceil(vmax / 20) * 20;
    let W = 0, H = 0, x = () => 0, colors = () => "#888", hover = -1, rows = extraRows, cross = null, dot = null;
    const plotB = top + SPEED_H - 6;
    const y = (mph) => top + (1 - mph / ymax) * (plotB - top);
    const rowTop = (k) => plotB + stripH + 14 + k * ROW_H;

    // A line with a soft area under it, broken at gaps.
    function series(get, yOf, base) {
      let d = "", area = "", run = [];
      const flush = () => {
        if (run.length > 1) {
          const pts2 = run.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join("L");
          d += "M" + pts2;
          area += `M${run[0][0].toFixed(1)},${base}L${pts2}L${run[run.length - 1][0].toFixed(1)},${base}Z`;
        }
        run = [];
      };
      // A missing value or two (a stalled poll) is bridged; more than 5 s without one breaks the line.
      let lastT = -Infinity;
      for (const p of pts) {
        const v = get(p);
        if (v == null || !Number.isFinite(v)) continue;
        if (p.t - lastT > 5000) flush();
        run.push([x(p.t), yOf(v)]);
        lastT = p.t;
      }
      flush();
      return { d, area };
    }
    const compact = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "k" : String(+v.toFixed(1)));

    function draw() {
      W = Math.max(280, host.clientWidth);
      H = rowTop(rows.length) - (rows.length ? 14 : 0) + bottom + (rows.length ? 8 : 0);
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.replaceChildren();
      x = (t) => left + ((t - t0) / Math.max(1, t1 - t0)) * (W - left - right);
      for (let v = 0; v <= ymax; v += ymax > 60 ? 40 : 20) {
        el("line", { x1: left, x2: W - right, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }, svg);
        el("text", { x: left - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, svg).textContent = v;
      }
      // Time ticks: roughly every 100 px, on whole minutes.
      const spanMin = (t1 - t0) / 60000;
      const every = [1, 2, 5, 10, 15, 30, 60, 120].find((m) => (W - left - right) / (spanMin / m) >= 90) || 240;
      const first = Math.ceil(t0 / (every * 60000)) * every * 60000;
      for (let t = first; t <= t1; t += every * 60000) {
        el("text", { x: x(t), y: H - 6, class: "tick", "text-anchor": "middle" }, svg).textContent = clock(t);
      }
      const sp = series((p) => (p.v != null ? p.v * Route.MPH : null), y, y(0));
      el("path", { d: sp.area, class: "speed-area" }, svg);
      el("path", { d: sp.d, class: "speed-line" }, svg);
      const strip = el("g", {}, svg);
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].t - pts[i - 1].t > 5000) continue;
        const x0 = x(pts[i - 1].t), x1 = x(pts[i].t);
        el("rect", { x: x0, y: plotB + 6, width: Math.max(0.5, x1 - x0 + 0.5), height: stripH, fill: colors(i) }, strip);
      }
      // Extra rows: each scaled to its own range, labelled inside the plot.
      rows.forEach((r, k) => {
        const rt = rowTop(k), rb = rt + ROW_H - 12;
        const vs = pts.map(r.get).filter((v) => v != null && Number.isFinite(v));
        const lo = r.min ?? 0, hi = Math.max(r.max ?? 0, ...vs, lo + 1e-9);
        r._y = (v) => rb - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (rb - rt);
        el("line", { x1: left, x2: W - right, y1: rb, y2: rb, class: "axis" }, svg);
        el("line", { x1: left, x2: W - right, y1: rt, y2: rt, class: "grid" }, svg);
        el("text", { x: left - 6, y: rt + 4, class: "tick", "text-anchor": "end" }, svg).textContent = compact(hi);
        el("text", { x: left + 6, y: rt + 12, class: "row-label" }, svg).textContent = `${r.label}${r.unit ? " · " + r.unit : ""}`;
        const s = series(r.get, r._y, rb);
        el("path", { d: s.area, class: "row-area" }, svg);
        el("path", { d: s.d, class: "row-line" }, svg);
        r._dot = el("circle", { class: "cursor-dot", r: 3.5, cx: -10, cy: -10 }, svg);
      });
      const bottomY = rows.length ? rowTop(rows.length - 1) + ROW_H - 12 : plotB + 6 + stripH;
      cross = el("line", { class: "crosshair", y1: top, y2: bottomY, x1: -10, x2: -10 }, svg);
      dot = el("circle", { class: "cursor-dot", r: 4.5, cx: -10, cy: -10 }, svg);
      el("rect", { x: left, y: 0, width: W - left - right, height: H, fill: "transparent", class: "hit" }, svg);
      highlight(hover);
    }

    function indexAt(clientX) {
      const r = svg.getBoundingClientRect();
      const t = t0 + ((clientX - r.left - left) / (W - left - right)) * (t1 - t0);
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; (pts[mid].t < t ? (lo = mid) : (hi = mid)); }
      return Math.abs(pts[lo].t - t) < Math.abs(pts[hi].t - t) ? lo : hi;
    }
    svg.addEventListener("pointermove", (e) => onPick(indexAt(e.clientX), "timeline"));
    svg.addEventListener("pointerdown", (e) => onPick(indexAt(e.clientX), "timeline"));
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") onPick(-1, "timeline"); });

    function highlight(i) {
      hover = i;
      if (!cross) return;
      const hide = () => { for (const r of rows) r._dot?.setAttribute("cx", -10); };
      if (i < 0) { cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); dot.setAttribute("cx", -10); hide(); tip.hidden = true; return; }
      const p = pts[i], px = x(p.t);
      cross.setAttribute("x1", px);
      cross.setAttribute("x2", px);
      dot.setAttribute("cx", px);
      dot.setAttribute("cy", p.v != null ? y(p.v * Route.MPH) : -10);
      const extra = rows.map((r) => {
        const v = r.get(p);
        r._dot.setAttribute("cx", v != null ? px : -10);
        r._dot.setAttribute("cy", v != null ? r._y(v) : -10);
        return v != null ? ` · ${r.fmt(v)}${r.unit ? " " + r.unit : ""}` : "";
      }).join("");
      tip.hidden = false;
      tip.innerHTML = `<b>${p.v != null ? (p.v * Route.MPH).toFixed(0) : "–"} mph</b>${extra} <span>${new Date(p.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>`;
      const w = tip.offsetWidth;
      tip.style.left = Math.min(W - w - 4, Math.max(4, px - w / 2)) + "px";
    }

    new ResizeObserver(() => { if (host.clientWidth && Math.abs(host.clientWidth - W) > 1) draw(); }).observe(host);
    draw();
    return {
      highlight,
      recolor(fn) { colors = fn; draw(); },
      setRows(r) { rows = r; draw(); },
    };
  }

  // Friction circle: every fix plotted by sideways (x) and forward (y) acceleration, in g.
  function frictionCircle(host, pts, onPick) {
    const S = 280, c = S / 2, R = 116, gMax = 0.5;
    const scale = R / gMax;
    const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, class: "friction", role: "img", "aria-label": "Friction circle" }, host);
    const ring = (g, label) => {
      el("circle", { cx: c, cy: c, r: g * scale, class: g === gMax ? "axis" : "grid", fill: "none" }, svg);
      if (label) el("text", { x: c + 3, y: c - g * scale - 3, class: "tick" }, svg).textContent = `${g} g`;
    };
    [0.1, 0.2, 0.3, 0.4, 0.5].forEach((g) => ring(g, g === 0.2 || g === 0.4));
    el("line", { x1: c - R, x2: c + R, y1: c, y2: c, class: "grid" }, svg);
    el("line", { x1: c, x2: c, y1: c - R, y2: c + R, class: "grid" }, svg);
    const lab = (x, y, t, anchor = "middle") => (el("text", { x, y, class: "axis-label", "text-anchor": anchor }, svg).textContent = t);
    lab(c, 12, "Speeding up");
    lab(c, S - 4, "Braking");
    lab(4, c - 6, "Left", "start");
    lab(S - 4, c - 6, "Right", "end");

    const usable = [];
    const dots = el("g", { class: "dots" }, svg);
    pts.forEach((p, i) => {
      if (p.a == null || p.side == null) return;
      const gx = Math.max(-gMax, Math.min(gMax, p.side / Route.G)), gy = Math.max(-gMax, Math.min(gMax, p.a / Route.G));
      const px = c + gx * scale, py = c - gy * scale;
      usable.push([i, px, py]);
      el("circle", { cx: px, cy: py, r: 3 }, dots);
    });
    const cursor = el("circle", { class: "cursor-ring", r: 7, cx: -20, cy: -20 }, svg);

    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * S, my = ((e.clientY - r.top) / r.height) * S;
      let best = -1, bd = 14 * 14;
      for (const [i, px, py] of usable) {
        const d = (px - mx) ** 2 + (py - my) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      onPick(best, "friction");
    });
    svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") onPick(-1, "friction"); });

    const byIndex = new Map(usable.map(([i, px, py]) => [i, [px, py]]));
    return {
      count: usable.length,
      highlight(i) {
        const at = byIndex.get(i);
        cursor.setAttribute("cx", at ? at[0] : -20);
        cursor.setAttribute("cy", at ? at[1] : -20);
      },
    };
  }

  // Small route outline for the trip list, from [[lat, lon], ...].
  // One route outline ([[lat, lon], ...]) or several (an outing: [[[lat, lon], ...], ...]).
  function thumbnail(paths, w = 320, h = 132) {
    if (paths?.[0]?.[0] != null && typeof paths[0][0] === "number") paths = [paths];
    paths = (paths || []).filter((p) => p && p.length >= 2);
    if (!paths.length) return "";
    const path = paths.flat();
    const k = Math.cos((path[0][0] * Math.PI) / 180);
    const xs = path.map((p) => p[1] * k), ys = path.map((p) => -p[0]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 18, span = Math.max(x1 - x0, y1 - y0, 1e-6);
    const s = Math.min((w - 2 * pad) / Math.max(x1 - x0, span * 0.05), (h - 2 * pad) / Math.max(y1 - y0, span * 0.05));
    const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
    const P = path.map((_, i) => [ox + (xs[i] - x0) * s, oy + (ys[i] - y0) * s]);
    let n = 0, d = "";
    const ends = [];
    for (const p of paths) {
      const seg = P.slice(n, n + p.length);
      n += p.length;
      d += "M" + seg.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join("L");
      ends.push(seg[seg.length - 1]);
    }
    const [sx, sy] = P[0], [ex, ey] = P[P.length - 1];
    // Where an outing stopped between trips: small dots.
    const mid = ends.slice(0, -1).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.5" class="thumb-stop"/>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path d="${d}" class="thumb-casing"/><path d="${d}" class="thumb-line"/>${mid}
      <circle cx="${sx}" cy="${sy}" r="5" class="thumb-start"/><circle cx="${ex}" cy="${ey}" r="5" class="thumb-end"/></svg>`;
  }

  return { timeline, frictionCircle, thumbnail };
})();
