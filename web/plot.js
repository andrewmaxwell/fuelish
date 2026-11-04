// Small charts shared by the cost and transmission pages: several lines on one set of axes, and a
// heatmap. SVG for lines (crisp, few points), canvas for heatmaps (many cells). Colors come from CSS
// (.s1–.s5 series classes, --accent etc.), so both themes work without any code here.

const Plot = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  function niceStep(x) {
    if (!(x > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(x)), f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /**
   * Lines on shared axes.
   * series: [{ label, pts: [[x, y], ...] (null y breaks the line), cls: "s1".."s5", color?, dash?, width? }]
   *   (`color`, any CSS color, overrides the class's color: for charts that match another legend)
   * marks: [{ x, y?, label, cls? }]  vertical marker lines with a label (and a dot at y)
   * opts: { xFmt, yFmt, xUnit, yUnit, height, yMin, yMax, aria, band?: { lo: [[x,y]], hi: [[x,y]], cls } }
   * Hover shows every series' value at the nearest x.
   */
  function lines(host, series, { xFmt = (v) => v.toFixed(0), yFmt = (v) => v.toFixed(1), xUnit = "", yUnit = "", height = 240, yMin, yMax, aria = "Chart", marks = [], bands = [] } = {}) {
    host.replaceChildren();
    const all = series.flatMap((s) => s.pts.filter((p) => p[1] != null && Number.isFinite(p[1])));
    if (!all.length) { host.innerHTML = `<p class="hint">Not enough data yet.</p>`; return; }
    const [x0, x1] = extent(all, (p) => p[0]);
    const [lo, hi] = extent([...all, ...bands.flatMap((b) => [...b.lo, ...b.hi]).filter((p) => p[1] != null)], (p) => p[1]);
    const y0 = yMin ?? Math.min(0, lo);
    const peak = yMax ?? hi;
    const step = niceStep((peak - y0) / 4 || 1), ymax = yMax ?? Math.ceil((peak + (peak - y0) * 0.06) / step) * step;
    const svg = el("svg", { class: "ins-chart", role: "img", "aria-label": aria }, host);
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    host.appendChild(tip);
    const legend = document.createElement("div");
    legend.className = "plot-legend";
    const swatch = (s) => `<i class="${s.cls || ""}"${s.color ? ` style="background:${s.color}"` : ""}></i>`;
    legend.innerHTML = series.filter((s) => s.label).map((s) => `<span>${swatch(s)}${escHtml(s.label)}</span>`).join("");
    if (series.some((s) => s.label)) host.appendChild(legend);
    const H = height, top = 22, bottom = 26, left = 48, right = 12;
    let W = 0, X = () => 0;
    const Y = (v) => top + (1 - (Math.min(ymax, Math.max(y0, v)) - y0) / (ymax - y0 || 1)) * (H - top - bottom);
    let cross, dots = [];
    function path(pts) {
      let d = "", pen = false;
      for (const [x, y] of pts) {
        if (y == null || !Number.isFinite(y)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`;
        pen = true;
      }
      return d;
    }
    function draw() {
      W = Math.max(280, host.clientWidth || 560);
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.replaceChildren();
      X = (v) => left + ((v - x0) / (x1 - x0 || 1)) * (W - left - right);
      for (let v = Math.ceil(y0 / step) * step; v <= ymax + 1e-9; v += step) {
        el("line", { x1: left, x2: W - right, y1: Y(v), y2: Y(v), class: Math.abs(v) < 1e-9 ? "axis" : "grid" }, svg);
        el("text", { x: left - 8, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, svg).textContent = yFmt(v);
      }
      el("text", { x: left - 8, y: 10, class: "tick axis-unit", "text-anchor": "end" }, svg).textContent = yUnit.trim();
      const xStep = niceStep((x1 - x0) / Math.max(3, Math.floor((W - left - right) / 70)));
      for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) {
        const last = v + xStep > x1 + 1e-9;
        el("text", { x: X(v), y: H - 6, class: "tick", "text-anchor": last ? "end" : "middle" }, svg).textContent = xFmt(v) + (last ? xUnit : "");
      }
      for (const b of bands) {
        const up = b.hi.filter((p) => p[1] != null), dn = b.lo.filter((p) => p[1] != null);
        if (up.length < 2 || dn.length < 2) continue;
        const d = "M" + up.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L") + "L" +
          [...dn].reverse().map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join("L") + "Z";
        el("path", { d, class: `band ${b.cls || "s1"}` }, svg);
      }
      for (const s of series) el("path", { d: path(s.pts), class: `line ${s.cls || "s1"}${s.dash ? " dash" : ""}`, ...(s.width ? { "stroke-width": s.width } : {}), ...(s.color ? { style: `stroke:${s.color}` } : {}) }, svg);
      for (const m of marks) {
        el("line", { x1: X(m.x), x2: X(m.x), y1: top, y2: H - bottom, class: `mark ${m.cls || ""}` }, svg);
        if (m.y != null) el("circle", { cx: X(m.x), cy: Y(m.y), r: 4.5, class: `mark-dot ${m.cls || ""}` }, svg);
        const right = X(m.x) > W - 120;
        el("text", { x: X(m.x) + (right ? -6 : 6), y: top + 10 + (m.row || 0) * 14, class: "tick mark-label", "text-anchor": right ? "end" : "start" }, svg).textContent = m.label;
      }
      cross = el("line", { class: "crosshair", y1: top, y2: H - bottom, x1: -10, x2: -10 }, svg);
      dots = series.map((s) => el("circle", { class: `cursor-dot ${s.cls || "s1"}`, r: 4, cx: -10, cy: -10, ...(s.color ? { style: `fill:${s.color}` } : {}) }, svg));
      el("rect", { x: left, y: 0, width: Math.max(0, W - left - right), height: H, fill: "transparent" }, svg);
    }
    // Nearest point of each series to an x, for the hover readout.
    const at = (s, x) => {
      let best = null;
      for (const p of s.pts) if (p[1] != null && (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x))) best = p;
      return best;
    };
    svg.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect(), mx = ((e.clientX - r.left) / r.width) * W;
      const x = x0 + ((mx - left) / (W - left - right)) * (x1 - x0);
      const vals = series.map((s) => at(s, x));
      const ref = vals.find(Boolean);
      if (!ref) return;
      cross.setAttribute("x1", X(ref[0]));
      cross.setAttribute("x2", X(ref[0]));
      vals.forEach((p, i) => { dots[i].setAttribute("cx", p ? X(p[0]) : -10); dots[i].setAttribute("cy", p ? Y(p[1]) : -10); });
      tip.hidden = false;
      tip.innerHTML = `<b>${xFmt(ref[0])}${xUnit}</b> ` + series.map((s, i) => vals[i] ? `<span>${swatch(s)}${escHtml(s.label || "")} ${yFmt(vals[i][1])}${yUnit}</span>` : "").join(" ");
      tip.style.left = Math.min(W - tip.offsetWidth - 4, Math.max(4, X(ref[0]) - tip.offsetWidth / 2)) + "px";
    });
    svg.addEventListener("pointerleave", () => { cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); dots.forEach((d) => d.setAttribute("cx", -10)); tip.hidden = true; });
    draw();
    const ro = new ResizeObserver(() => { if (Math.abs((host.clientWidth || 0) - W) > 1) draw(); });
    ro.observe(host);
    return { redraw: draw };
  }

  /**
   * Heatmap on a canvas: cells [{ x, y, n, v }] on a regular grid (dx, dy). Color is `v` on a
   * blue→yellow→red ramp over [vLo, vHi]; opacity grows with n (how much time is in the cell).
   * Hover reads the cell out with `tipText(cell)`.
   */
  function heatmap(host, cells, { dx, dy, xLo, xHi, yLo, yHi, vLo, vHi, xFmt = (v) => v.toFixed(0), yFmt = (v) => v.toFixed(0), xUnit = "", yUnit = "", height = 300, aria = "Heatmap", tipText = () => "", legend = "" } = {}) {
    host.replaceChildren();
    if (!cells.length) { host.innerHTML = `<p class="hint">Not enough data yet.</p>`; return; }
    const wrap = document.createElement("div");
    wrap.className = "heat-canvas";
    const cv = document.createElement("canvas");
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", aria);
    wrap.appendChild(cv);
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;
    wrap.appendChild(tip);
    host.appendChild(wrap);
    if (legend) {
      const lg = document.createElement("div");
      lg.className = "legend";
      lg.innerHTML = `<span>${escHtml(legend[0])}</span><span class="bar" style="background:linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c})`).join(", ")})"></span><span>${escHtml(legend[1])}</span>`;
      host.appendChild(lg);
    }
    const H = height, top = 22, bottom = 26, left = 48, right = 12;
    const nMax = Math.max(1, extent(cells, (c) => c.n)[1]);
    let W = 0, X, Y;
    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
    function draw() {
      W = Math.max(280, host.clientWidth || 560);
      const dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr;
      cv.height = H * dpr;
      cv.style.width = W + "px";
      cv.style.height = H + "px";
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      X = (v) => left + ((v - xLo) / (xHi - xLo)) * (W - left - right);
      Y = (v) => top + (1 - (v - yLo) / (yHi - yLo)) * (H - top - bottom);
      g.font = "11px system-ui, sans-serif";
      g.fillStyle = css("--muted");
      g.strokeStyle = css("--grid");
      const ys = niceStep((yHi - yLo) / 5);
      g.textAlign = "right";
      for (let v = Math.ceil(yLo / ys) * ys; v <= yHi + 1e-9; v += ys) {
        g.beginPath(); g.moveTo(left, Y(v)); g.lineTo(W - right, Y(v)); g.stroke();
        g.fillText(yFmt(v), left - 8, Y(v) + 4);
      }
      g.fillText(yUnit.trim(), left - 8, 10);
      const xs = niceStep((xHi - xLo) / Math.max(3, Math.floor((W - left - right) / 70)));
      g.textAlign = "center";
      for (let v = Math.ceil(xLo / xs) * xs; v <= xHi + 1e-9; v += xs) {
        const last = v + xs > xHi + 1e-9;
        g.textAlign = last ? "right" : "center";
        g.fillText(xFmt(v) + (last ? xUnit : ""), X(v), H - 6);
      }
      const cw = Math.max(1, X(xLo + dx) - X(xLo)), ch = Math.max(1, Y(yLo) - Y(yLo + dy));
      for (const c of cells) {
        const f = Math.min(1, Math.max(0, (c.v - vLo) / (vHi - vLo || 1)));
        g.fillStyle = `rgba(${ramp(f)}, ${0.25 + 0.75 * Math.sqrt(c.n / nMax)})`;
        g.fillRect(X(c.x), Y(c.y + dy), cw + 0.5, ch + 0.5);
      }
    }
    cv.addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const x = xLo + ((mx - left) / (W - left - right)) * (xHi - xLo), y = yLo + (1 - (my - top) / (H - top - bottom)) * (yHi - yLo);
      const c = cells.find((q) => x >= q.x && x < q.x + dx && y >= q.y && y < q.y + dy);
      if (!c) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.innerHTML = tipText(c);
      tip.style.left = Math.min(W - tip.offsetWidth - 4, Math.max(4, mx - tip.offsetWidth / 2)) + "px";
      tip.style.top = Math.max(0, my - 44) + "px";
    });
    cv.addEventListener("pointerleave", () => { tip.hidden = true; });
    draw();
    const ro = new ResizeObserver(() => { if (Math.abs((host.clientWidth || 0) - W) > 1) draw(); });
    ro.observe(host);
  }
  // Perceptual-ish ramp: blue (low) → teal → yellow → orange → red (high). Readable on both themes.
  const RAMP = ["59,130,246", "20,184,166", "234,179,8", "249,115,22", "220,38,38"];
  function ramp(f) {
    const i = Math.min(RAMP.length - 2, Math.floor(f * (RAMP.length - 1))), t = f * (RAMP.length - 1) - i;
    const a = RAMP[i].split(",").map(Number), b = RAMP[i + 1].split(",").map(Number);
    return a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(",");
  }

  /** Quantile of a sorted numeric array (linear between neighbours). */
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  return { lines, heatmap, niceStep, quantile };
})();
