// Trip charts drawn as plain SVG: the friction circle and trip thumbnails.
// The friction circle calls onPick(index) on hover and highlights a point when told to, so it stays linked to the map.

const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

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

  // Small route outline for the trip list: one route ([[lat, lon], ...]) or several (an outing:
  // [[[lat, lon], ...], ...]). The line changes color every mile, so a drive around the block and a
  // drive across the county don't look alike. `meters` (optional, one per route): each route's
  // measured length; the outline is thinned, so its own length runs short, and is stretched to match.
  // `frame` (optional [lat, lon] points): fit to these instead, so several thumbnails share a scale.
  function thumbnail(paths, w = 320, h = 132, frame = null, meters = null) {
    if (paths?.[0]?.[0] != null && typeof paths[0][0] === "number") { paths = [paths]; if (meters != null && !Array.isArray(meters)) meters = [meters]; }
    const keep = (paths || []).map((p, i) => [p, meters?.[i]]).filter(([p]) => p && p.length >= 2);
    if (!keep.length) return "";
    paths = keep.map(([p]) => p);
    const path = paths.flat();
    const k = Math.cos((path[0][0] * Math.PI) / 180);
    const xs = path.map((p) => p[1] * k), ys = path.map((p) => -p[0]);
    const fit = frame?.length ? frame : path;
    const [[x0, x1], [y0, y1]] = [extent(fit, (p) => p[1] * k), extent(fit, (p) => -p[0])];
    const pad = 18, span = Math.max(x1 - x0, y1 - y0, 1e-6);
    const s = Math.min((w - 2 * pad) / Math.max(x1 - x0, span * 0.05), (h - 2 * pad) / Math.max(y1 - y0, span * 0.05));
    const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
    const P = path.map((_, i) => [ox + (xs[i] - x0) * s, oy + (ys[i] - y0) * s]);
    const f = ([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`;
    // Cut each route at every mile (counting on across an outing's routes) into alternating pieces.
    const MILE = 1609.344;
    let n = 0, d = "", mile = 0, into = 0; // the mile we're in, and meters into it
    const odd = [], even = [], ends = [];
    paths.forEach((p, pi) => {
      const seg = P.slice(n, n + p.length), geo = path.slice(n, n + p.length);
      n += p.length;
      d += "M" + seg.map(f).join("L");
      ends.push(seg[seg.length - 1]);
      const steps = geo.slice(1).map((q, i) => Route.haversine(geo[i][0], geo[i][1], q[0], q[1]));
      const own = steps.reduce((a, b) => a + b, 0);
      const stretch = keep[pi][1] > 0 && own > 0 ? keep[pi][1] / own : 1;
      let piece = [seg[0]];
      const flush = () => { if (piece.length > 1) (mile % 2 ? odd : even).push("M" + piece.map(f).join("L")); };
      steps.forEach((m, i) => {
        m *= stretch;
        let used = 0;
        while (m > 0 && into + (m - used) >= MILE) {
          used += MILE - into;
          const t = used / m, [ax, ay] = seg[i], [bx, by] = seg[i + 1];
          const mark = [ax + (bx - ax) * t, ay + (by - ay) * t];
          piece.push(mark);
          flush();
          mile++, into = 0, piece = [mark];
        }
        into += m - used;
        piece.push(seg[i + 1]);
      });
      flush();
    });
    const [sx, sy] = P[0], [ex, ey] = P[P.length - 1];
    // Where an outing stopped between trips: small dots.
    const mid = ends.slice(0, -1).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.5" class="thumb-stop"/>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path d="${d}" class="thumb-casing"/><path d="${even.join("")}" class="thumb-line"/><path d="${odd.join("")}" class="thumb-line alt"/>${mid}
      <circle cx="${sx}" cy="${sy}" r="5" class="thumb-start"/><circle cx="${ex}" cy="${ey}" r="5" class="thumb-end"/></svg>`;
  }

  return { frictionCircle, thumbnail };
})();
