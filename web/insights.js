// Insights across every drive with engine data: totals, fuel economy by speed and by engine
// temperature, and how each engine signal moves with the others (and when they part ways).
// Input: [{ r: recording, rows: Engine rows (derived), gas: { price, ... } | null }].

const Insights = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  };
  const isDark = () => document.documentElement.dataset.theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const MPH = 0.621371;

  // Each second of every drive, with its trip and the change in speed since the previous second.
  function seconds(trips) {
    const out = [];
    for (const { r, rows } of trips) {
      let prev = null;
      for (const row of rows) {
        const s = { ...row, trip: r.id };
        if (prev && row.t - prev.t <= 2500 && prev.speed != null && row.speed != null) {
          s.accelG = ((row.speed - prev.speed) / 3.6 / ((row.t - prev.t) / 1000)) / 9.80665;
        }
        out.push(s);
        prev = row;
      }
    }
    return out;
  }

  // One sample per second of driving: x (speed, temperature, ...) with the miles, gallons and seconds in it.
  function samples(trips, xOf) {
    const out = [];
    for (const { rows } of trips) {
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i], dt = (b.t - a.t) / 1000;
        if (dt > 2.5 || b.fuelGs == null || b.speed == null) continue;
        const x = xOf(b);
        if (x == null || !Number.isFinite(x)) continue;
        out.push({ x, miles: ((b.speed / 3.6) * dt) / 1609.344, gal: (b.fuelGs * dt) / 745 / 3.78541, secs: dt, gph: b.gph, mph: b.speed * MPH, cut: b.cut });
      }
    }
    return out;
  }

  // A smooth curve over a fine grid: at each x, a Gaussian-weighted sum of nearby seconds. Economy is
  // weighted miles over weighted gallons (an average of instant mpg would blow up near zero fuel).
  // `secs` at each point is how much data backs it, in seconds within about one bandwidth.
  function kernel(smp, { lo, hi, step, bw }) {
    const fine = new Map(); // pre-bin at step/2 so long histories stay fast
    const fw = step / 2;
    for (const s of smp) {
      const k = Math.round(s.x / fw);
      const b = fine.get(k) || fine.set(k, { x: k * fw, miles: 0, gal: 0, secs: 0, gphSecs: 0 }).get(k);
      b.miles += s.miles; b.gal += s.gal; b.secs += s.secs; b.gphSecs += (s.gph ?? 0) * s.secs;
    }
    const bins = [...fine.values()];
    const out = [];
    for (let x = lo; x <= hi + 1e-9; x += step) {
      let m = 0, g = 0, sec = 0, gs = 0, near = 0;
      for (const b of bins) {
        const d = (b.x - x) / bw;
        if (Math.abs(d) > 3) continue;
        const w = Math.exp(-0.5 * d * d);
        m += w * b.miles; g += w * b.gal; sec += w * b.secs; gs += w * b.gphSecs;
        if (Math.abs(d) <= 1) near += b.secs;
      }
      out.push({ x, mpg: g > 0 ? m / g : null, gph: sec > 0 ? gs / sec : null, density: sec / (bw * Math.sqrt(2 * Math.PI)), near });
    }
    return out;
  }

  // ---------- curve chart: one series, one axis, raw seconds as faint dots, hover readout ----------

  function curveChart(host, { curve, y, dots = [], xFmt, yFmt, xUnit, yUnit, aria, minNear = 20, height = 220, area = false, yMax }) {
    host.replaceChildren();
    const svg = svgEl("svg", { class: "ins-chart", role: "img", "aria-label": aria }, host);
    const tipEl = document.createElement("div");
    tipEl.className = "chart-tip";
    tipEl.hidden = true;
    host.appendChild(tipEl);
    const H = height, top = 22, bottom = 26, left = 44, right = 10;
    const pts = curve.filter((c) => c[y] != null && c.near > 0);
    if (!pts.length) { host.innerHTML = `<p class="hint">Not enough data yet.</p>`; return; }
    const x0 = curve[0].x, x1 = curve[curve.length - 1].x;
    // Scale to the well-supported part of the curve; sparse ends and stray dots are clipped.
    const solid = pts.filter((c) => c.near >= minNear).map((c) => c[y]);
    const peak = yMax ?? Math.max(1e-9, extent(solid.length ? solid : pts.map((c) => c[y]))[1]);
    const step = niceStep(peak / 4), ymax = Math.ceil((peak * 1.08) / step) * step;
    let W = 0, X = () => 0;
    const Y = (v) => top + (1 - Math.min(v, ymax) / ymax) * (H - top - bottom);
    function draw() {
      W = Math.max(280, host.clientWidth);
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.replaceChildren();
      X = (v) => left + ((v - x0) / (x1 - x0 || 1)) * (W - left - right);
      for (let v = 0; v <= ymax + 1e-9; v += step) {
        svgEl("line", { x1: left, x2: W - right, y1: Y(v), y2: Y(v), class: v ? "grid" : "axis" }, svg);
        svgEl("text", { x: left - 8, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, svg).textContent = yFmt(v);
      }
      const xStep = niceStep((x1 - x0) / Math.max(3, Math.floor((W - left - right) / 70)));
      // Units: the y unit above its axis, the x unit on the last tick.
      svgEl("text", { x: left - 8, y: 10, class: "tick axis-unit", "text-anchor": "end" }, svg).textContent = yUnit.trim();
      for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) {
        const last = v + xStep > x1 + 1e-9;
        svgEl("text", { x: X(v), y: H - 6, class: "tick", "text-anchor": last ? "end" : "middle" }, svg).textContent = xFmt(v) + (last ? xUnit : "");
      }
      const dg = svgEl("g", { class: "raw-dots" }, svg);
      for (const [dx, dy] of dots) if (dy <= ymax) svgEl("circle", { cx: X(dx), cy: Y(dy), r: 1.6 }, dg);
      // The curve: solid where enough seconds back it, dashed where they're thin.
      // A stretch with no data at all breaks the line instead of bridging it.
      const runs = [];
      const gridStep = curve.length > 1 ? curve[1].x - curve[0].x : 1;
      for (const c of pts) {
        const ok = c.near >= minNear, prev = runs.at(-1)?.cs.at(-1);
        const gap = prev && c.x - prev.x > gridStep * 1.5;
        if (!runs.length || gap) runs.push({ ok, cs: [] });
        else if (runs.at(-1).ok !== ok) runs.push({ ok, cs: [prev] });
        runs.at(-1).cs.push(c);
      }
      for (const r of runs) {
        const d = "M" + r.cs.map((c) => `${X(c.x).toFixed(1)},${Y(c[y]).toFixed(1)}`).join("L");
        if (area && r.ok) svgEl("path", { d: `${d}L${X(r.cs.at(-1).x)},${Y(0)}L${X(r.cs[0].x)},${Y(0)}Z`, class: "curve-area" }, svg);
        svgEl("path", { d, class: r.ok ? "curve" : "curve curve-thin" }, svg);
      }
      cross = svgEl("line", { class: "crosshair", y1: top, y2: H - bottom, x1: -10, x2: -10 }, svg);
      dot = svgEl("circle", { class: "cursor-dot", r: 4.5, cx: -10, cy: -10 }, svg);
      svgEl("rect", { x: left, y: 0, width: W - left - right, height: H, fill: "transparent" }, svg);
    }
    let cross, dot;
    svg.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect(), mx = ((e.clientX - rect.left) / rect.width) * W;
      let best = null;
      for (const c of pts) if (!best || Math.abs(X(c.x) - mx) < Math.abs(X(best.x) - mx)) best = c;
      if (!best) return;
      cross.setAttribute("x1", X(best.x));
      cross.setAttribute("x2", X(best.x));
      dot.setAttribute("cx", X(best.x));
      dot.setAttribute("cy", Y(best[y]));
      tipEl.hidden = false;
      const backing = best.near < 60 ? `${Math.round(best.near)} s` : `${(best.near / 60).toFixed(best.near < 600 ? 1 : 0)} min`;
      tipEl.innerHTML = `<b>${xFmt(best.x)}${xUnit}: ${yFmt(best[y])}${yUnit}</b> <span>${backing} of data nearby${best.near < minNear ? ", thin" : ""}</span>`;
      tipEl.style.left = Math.min(W - tipEl.offsetWidth - 4, Math.max(4, X(best.x) - tipEl.offsetWidth / 2)) + "px";
    });
    svg.addEventListener("pointerleave", () => { cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); dot.setAttribute("cx", -10); tipEl.hidden = true; });
    draw();
    new ResizeObserver(() => { if (Math.abs(host.clientWidth - W) > 1) draw(); }).observe(host);
  }

  function niceStep(x) {
    const p = 10 ** Math.floor(Math.log10(x)), f = x / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  // ---------- correlations ----------

  const SIGNALS = [
    ["speed", "Speed", "mph", (r) => (r.speed != null ? r.speed * MPH : null)],
    ["accelG", "Acceleration", "g", (r) => r.accelG],
    ["rpm", "RPM", "rpm", (r) => r.rpm],
    ["pedal", "Gas pedal", "%", (r) => r.pedal],
    ["throttle", "Throttle", "%", (r) => r.throttle],
    ["load", "Engine load", "%", (r) => r.load],
    ["absLoad", "Absolute load", "%", (r) => r.absLoad],
    ["maf", "Airflow", "g/s", (r) => r.maf],
    ["map", "Manifold pressure", "kPa", (r) => r.map],
    ["timing", "Timing advance", "°", (r) => r.timing],
    ["lambda", "Air-fuel target", "λ", (r) => r.lambda],
    ["stft", "Short-term fuel trim", "%", (r) => r.stft],
    ["ltft", "Long-term fuel trim", "%", (r) => r.ltft],
    ["coolant", "Coolant", "°F", (r) => (r.coolant != null ? Engine.cToF(r.coolant) : null)],
    ["iat", "Intake air", "°F", (r) => (r.iat != null ? Engine.cToF(r.iat) : null)],
    ["volts", "Voltage", "V", (r) => r.volts],
    ["gph", "Fuel flow", "gal/h", (r) => r.gph],
  ].map(([key, label, unit, get]) => ({ key, label, unit, get }));
  // Fuel flow is computed here from airflow and the air-fuel target, so it tracks airflow by construction.
  const DERIVED = { gph: "computed from airflow and the air-fuel target" };

  function pearson(xs, ys) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i];
      if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (n < 30) return { r: null, n };
    const cov = sxy - (sx * sy) / n, vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
    if (vx <= 1e-12 || vy <= 1e-12) return { r: null, n };
    const slope = cov / vx, icept = (sy - slope * sx) / n;
    return { r: cov / Math.sqrt(vx * vy), n, slope, icept, sd: Math.sqrt(Math.max(0, (vy - slope * cov) / (n - 2))) };
  }

  function cellColor(r) {
    const neutral = isDark() ? [58, 58, 56] : [225, 224, 217];
    const pole = r >= 0 ? [59, 143, 246] : [239, 68, 68];
    const f = Math.min(1, Math.abs(r));
    return `rgb(${neutral.map((v, i) => Math.round(v + (pole[i] - v) * f)).join(",")})`;
  }

  function correlations(host, secs, onPick) {
    const cols = SIGNALS.map((s) => ({ ...s, vals: secs.map(s.get) }));
    const usable = cols.filter((c) => {
      const v = c.vals.filter((x) => x != null);
      const [lo, hi] = extent(v);
      return v.length >= 30 && hi - lo > 1e-9;
    });
    const skipped = cols.filter((c) => !usable.includes(c));
    const pairs = [];
    for (let i = 0; i < usable.length; i++) {
      for (let j = 0; j < i; j++) pairs.push({ a: usable[j], b: usable[i], ...pearson(usable[j].vals, usable[i].vals) });
    }
    const at = (i, j) => pairs.find((p) => p.a === usable[Math.min(i, j)] && p.b === usable[Math.max(i, j)]);

    host.innerHTML = `
      <div class="heat-wrap"><svg class="heat" role="img" aria-label="Correlation between engine signals"></svg><div class="chart-tip" hidden></div></div>
      <div class="legend heat-legend"><span>−1 opposite</span><span class="bar" style="background:linear-gradient(90deg, ${cellColor(-1)}, ${cellColor(0)}, ${cellColor(1)})"></span><span>+1 together</span></div>
      ${skipped.length ? `<p class="hint">Not enough variation to compare: ${skipped.map((c) => c.label).join(", ")}.</p>` : ""}`;
    const svg = host.querySelector(".heat"), tipEl = host.querySelector(".chart-tip");
    const n = usable.length, labelW = 136, cell = Math.max(14, Math.min(30, Math.floor((Math.min(640, host.clientWidth || 640) - labelW) / Math.max(1, n - 1))));
    const colLabelH = 104; // column names, angled, under the grid
    const W = labelW + cell * (n - 1) + 4 + 96, H = cell * (n - 1) + 4 + colLabelH;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    // Lower triangle: row i against columns j < i. Row labels on the left; a column's name is in its tooltip.
    for (let j = 0; j < n - 1; j++) {
      const x = labelW + j * cell + cell / 2, y = cell * (n - 1) + 10;
      svgEl("text", { x, y, class: "tick heat-label", "text-anchor": "start", transform: `rotate(45 ${x} ${y})` }, svg).textContent = usable[j].label;
    }
    for (let i = 1; i < n; i++) {
      svgEl("text", { x: labelW - 6, y: (i - 1) * cell + cell / 2 + 4, class: "tick heat-label", "text-anchor": "end" }, svg).textContent = usable[i].label;
      for (let j = 0; j < i; j++) {
        const p = at(i, j);
        const rect = svgEl("rect", {
          x: labelW + j * cell + 1, y: (i - 1) * cell + 1, width: cell - 2, height: cell - 2, rx: 3,
          fill: p.r == null ? "transparent" : cellColor(p.r), class: "heat-cell",
          stroke: p.r == null ? "var(--border)" : "none",
        }, svg);
        rect.addEventListener("pointerenter", () => {
          tipEl.hidden = false;
          tipEl.innerHTML = `<b>${p.a.label} × ${p.b.label}</b> ${p.r == null ? "not enough data" : `r = ${p.r.toFixed(2)}`}`;
          tipEl.style.left = Math.min(W - tipEl.offsetWidth - 4, Math.max(0, labelW + j * cell - 40)) + "px";
          tipEl.style.top = Math.max(0, (i - 1) * cell - 30) + "px";
        });
        rect.addEventListener("pointerleave", () => { tipEl.hidden = true; });
        rect.addEventListener("click", () => p.r != null && onPick(p));
      }
    }
    return pairs.filter((p) => p.r != null);
  }

  // Scatter of one pair with its straight-line fit, and the seconds farthest off that line.
  function pairDetail(host, p, secs, tripName) {
    const xs = p.a.vals, ys = p.b.vals;
    const idx = [];
    for (let i = 0; i < xs.length; i++) if (xs[i] != null && ys[i] != null) idx.push(i);
    const resid = idx.map((i) => ({ i, z: (ys[i] - (p.icept + p.slope * xs[i])) / (p.sd || 1) }));
    // Biggest disagreements, at least 30 s apart so one event isn't listed five times.
    const picks = [];
    for (const d of [...resid].sort((u, v) => Math.abs(v.z) - Math.abs(u.z))) {
      if (Math.abs(d.z) < 2.5 || picks.length >= 8) break;
      const s = secs[d.i];
      if (picks.some((q) => secs[q.i].trip === s.trip && Math.abs(secs[q.i].t - s.t) < 30000)) continue;
      picks.push(d);
    }
    const fmt = (sig, v) => `${Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)}${sig.unit && sig.unit !== "rpm" ? " " + sig.unit : sig.unit === "rpm" ? " rpm" : ""}`;
    const strength = Math.abs(p.r) >= 0.9 ? "nearly the same signal" : Math.abs(p.r) >= 0.7 ? "strongly related" : Math.abs(p.r) >= 0.4 ? "loosely related" : "mostly independent";
    const derived = DERIVED[p.a.key] || DERIVED[p.b.key];
    host.innerHTML = `
      <h3>${esc(p.a.label)} × ${esc(p.b.label)} <span>r = ${p.r.toFixed(2)} · ${strength} · ${idx.length.toLocaleString()} seconds</span></h3>
      ${derived ? `<p class="hint">Fuel flow is ${derived}, so a strong link with those is expected.</p>` : ""}
      <div class="scatter-host chart-host"></div>
      <h3>Where they disagree most</h3>
      ${picks.length ? `<ol class="legs diverge">${picks.map((d) => {
        const s = secs[d.i];
        const expect = p.icept + p.slope * xs[d.i];
        return `<li><a href="#/r/${esc(s.trip)}/${Math.round(s.t)}">
          <b>${esc(new Date(s.t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit", second: "2-digit" }))}</b>
          <span>${esc(p.a.label)} ${fmt(p.a, xs[d.i])}: ${esc(p.b.label)} ${fmt(p.b, ys[d.i])}, the line says ${fmt(p.b, expect)}</span>
        </a></li>`;
      }).join("")}</ol><p class="hint">Each opens that moment on its trip's map, to see what was happening.</p>`
        : `<p class="hint">Nothing stands far off the line: these two don't diverge in this data.</p>`}`;
    scatter(host.querySelector(".scatter-host"), idx.map((i) => [xs[i], ys[i], i]), p, (i) => { location.hash = `#/r/${secs[i].trip}/${Math.round(secs[i].t)}`; });
  }

  function scatter(host, pts, p, onOpen) {
    const H = 260, top = 10, bottom = 34, left = 48, right = 10;
    const svg = svgEl("svg", { class: "ins-chart", role: "img", "aria-label": `${p.b.label} against ${p.a.label}` }, host);
    const tipEl = document.createElement("div");
    tipEl.className = "chart-tip";
    tipEl.hidden = true;
    host.appendChild(tipEl);
    const stride = Math.max(1, Math.ceil(pts.length / 2500));
    const shown = pts.filter((_, k) => k % stride === 0);
    const ext = (k) => extent(pts, (q) => q[k]);
    const [x0, x1] = ext(0), [y0, y1] = ext(1);
    const W = Math.max(280, host.clientWidth || 560);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    const X = (v) => left + ((v - x0) / (x1 - x0 || 1)) * (W - left - right);
    const Y = (v) => top + (1 - (v - y0) / (y1 - y0 || 1)) * (H - top - bottom);
    for (const [v, axis] of [[x0, "x"], [x1, "x"], [y0, "y"], [y1, "y"]]) {
      if (axis === "x") svgEl("text", { x: X(v), y: H - 18, class: "tick", "text-anchor": v === x0 ? "start" : "end" }, svg).textContent = +v.toFixed(2);
      else svgEl("text", { x: left - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, svg).textContent = +v.toFixed(2);
    }
    svgEl("line", { x1: left, x2: W - right, y1: H - bottom, y2: H - bottom, class: "axis" }, svg);
    svgEl("line", { x1: left, x2: left, y1: top, y2: H - bottom, class: "axis" }, svg);
    svgEl("text", { x: (left + W - right) / 2, y: H - 2, class: "axis-label", "text-anchor": "middle" }, svg).textContent = `${p.a.label} (${p.a.unit})`;
    svgEl("text", { x: 12, y: top + (H - top - bottom) / 2, class: "axis-label", "text-anchor": "middle", transform: `rotate(-90 12 ${top + (H - top - bottom) / 2})` }, svg).textContent = `${p.b.label} (${p.b.unit})`;
    const g = svgEl("g", { class: "dots" }, svg);
    for (const [x, y] of shown) svgEl("circle", { cx: X(x), cy: Y(y), r: 2.5 }, g);
    svgEl("line", { x1: X(x0), y1: Y(p.icept + p.slope * x0), x2: X(x1), y2: Y(p.icept + p.slope * x1), class: "fit-line" }, svg);
    const ring = svgEl("circle", { class: "cursor-ring", r: 6, cx: -20, cy: -20 }, svg);
    let near = null;
    svg.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect(), mx = ((e.clientX - rect.left) / rect.width) * W, my = ((e.clientY - rect.top) / rect.height) * H;
      let best = null, bd = 12 * 12;
      for (const q of shown) { const d = (X(q[0]) - mx) ** 2 + (Y(q[1]) - my) ** 2; if (d < bd) { bd = d; best = q; } }
      near = best;
      if (!best) { ring.setAttribute("cx", -20); tipEl.hidden = true; return; }
      ring.setAttribute("cx", X(best[0]));
      ring.setAttribute("cy", Y(best[1]));
      tipEl.hidden = false;
      tipEl.innerHTML = `${esc(p.a.label)} ${+best[0].toFixed(2)} · ${esc(p.b.label)} ${+best[1].toFixed(2)} <span>click to open</span>`;
      tipEl.style.left = Math.min(W - tipEl.offsetWidth - 4, Math.max(4, X(best[0]) - tipEl.offsetWidth / 2)) + "px";
    });
    svg.addEventListener("pointerleave", () => { ring.setAttribute("cx", -20); tipEl.hidden = true; });
    svg.addEventListener("click", () => near && onOpen(near[2]));
  }

  // ---------- page ----------

  function render(host, trips) {
    const secs = seconds(trips);
    // mpg counts only miles that have fuel readings (fuelMiles); gas and cost are whole-drive.
    let miles = 0, fuelMiles = 0, gal = 0, galTrip = 0, cost = 0, idle = 0, idleCost = 0, priced = true;
    for (const t of trips) {
      const e = Engine.summary(t.rows, { vehicle: t.r.meta.vehicle, ...t.scope });
      miles += e.miles;
      if (e.gal != null) {
        gal += e.gal;
        fuelMiles += e.fuelMiles;
        galTrip += e.galTrip ?? e.gal;
        if (t.gas) cost += (e.galTrip ?? e.gal) * t.gas.price; else priced = false;
      }
      if (e.fuelUse) {
        idle += e.fuelUse.idle;
        if (t.gas) idleCost += e.fuelUse.idle * t.gas.price;
      }
    }
    const fig = (value, label, unit = "") => `<div class="fig"><b>${value}<small>${unit}</small></b><span>${label}</span></div>`;

    // Speed: 0.5 mph steps, smoothed over about 2 mph. Temperature: 1 °F steps over about 4 °F.
    const bySpeed = samples(trips, (b) => b.speed * MPH);
    const maxMph = Math.max(30, extent(bySpeed, (s) => s.x)[1]);
    const speedHi = Math.ceil(maxMph / 5) * 5;
    const speedCurve = kernel(bySpeed.filter((s) => s.x >= 1), { lo: 1, hi: speedHi, step: 0.5, bw: 2 });
    const timeCurve = kernel(bySpeed, { lo: 0, hi: speedHi, step: 0.5, bw: 1.5 });
    const instantMpg = (s) => (s.gph > 0 && !s.cut && s.mph > 1 ? s.mph / s.gph : null);
    const temp = (b) => (b.coolant != null ? Engine.cToF(b.coolant) : null);
    const movingTemp = samples(trips, (b) => (b.speed * MPH > 3 ? temp(b) : null));
    const idleTemp = samples(trips, (b) => (b.speed === 0 && b.rpm > 300 ? temp(b) : null));
    const tLo = (smp) => Math.floor(extent(smp, (s) => s.x)[0] / 10) * 10, tHi = (smp) => Math.ceil(extent(smp, (s) => s.x)[1] / 10) * 10;
    const tempCurve = movingTemp.length ? kernel(movingTemp, { lo: tLo(movingTemp), hi: tHi(movingTemp), step: 1, bw: 4 }) : [];
    const idleCurve = idleTemp.length ? kernel(idleTemp, { lo: tLo(idleTemp), hi: tHi(idleTemp), step: 1, bw: 4 }) : [];

    host.innerHTML = `
      <div class="figs">
        ${fig(miles.toFixed(miles < 10 ? 1 : 0), "miles", "")}
        ${fig(gal ? (fuelMiles / gal).toFixed(0) : "–", "miles per gallon")}
        ${fig(gallons(galTrip), "gallons")}
        ${fig(cost && priced ? money(cost) : "–", "spent on gas")}
        ${fig(gal ? Math.round((idle / gal) * 100) + "%" : "–", `burned idling${idleCost ? ` (${money(idleCost)})` : ""}`)}
      </div>

      <section class="ins-sec">
        <h2>Fuel economy by speed</h2>
        <p class="lede">Where your car is most efficient. Each faint dot is one second of driving; the line is the average around each speed (total miles over total gallons), dashed where there's little data.</p>
        <div id="ins-speed" class="chart-host"></div>
        <h3>Time spent at each speed</h3>
        <div id="ins-speed-time" class="chart-host"></div>
      </section>

      <section class="ins-sec">
        <h2>Fuel economy by engine temperature</h2>
        <p class="lede">A cold engine runs richer and fights thicker oil until it reaches about 180 °F. While driving, cold minutes are often also slow neighborhood minutes, so part of this is speed.</p>
        <div id="ins-temp" class="chart-host"></div>
        <h3>Fuel burned idling, by engine temperature</h3>
        <p class="lede">The cleanest view of the warm-up cost, since speed doesn't change.</p>
        <div id="ins-temp-idle" class="chart-host"></div>
      </section>

      <section class="ins-sec">
        <h2>How the signals move together</h2>
        <p class="lede">Each square compares two engine signals second by second: blue rises together, red moves opposite, gray is unrelated. Pick one to see the pair side by side and the moments they part ways.</p>
        <div id="ins-corr"></div>
        <div id="ins-same"></div>
        <div id="ins-pair"></div>
      </section>`;

    curveChart(host.querySelector("#ins-speed"), {
      curve: speedCurve, y: "mpg", dots: bySpeed.map((s) => [s.x, instantMpg(s)]).filter((d) => d[1] != null),
      xFmt: (v) => v.toFixed(0), yFmt: (v) => v.toFixed(0), xUnit: " mph", yUnit: " mpg", aria: "Fuel economy by speed",
    });
    curveChart(host.querySelector("#ins-speed-time"), {
      curve: timeCurve.map((c) => ({ ...c, perMph: c.density / 60 })), y: "perMph", minNear: 0, height: 120, area: true,
      xFmt: (v) => v.toFixed(0), yFmt: (v) => v.toFixed(v < 1 ? 2 : 1), xUnit: " mph", yUnit: " min per mph", aria: "Time spent at each speed",
    });
    curveChart(host.querySelector("#ins-temp"), {
      curve: tempCurve, y: "mpg", dots: movingTemp.map((s) => [s.x, instantMpg(s)]).filter((d) => d[1] != null),
      xFmt: (v) => v.toFixed(0), yFmt: (v) => v.toFixed(0), xUnit: " °F", yUnit: " mpg", aria: "Fuel economy by coolant temperature",
    });
    curveChart(host.querySelector("#ins-temp-idle"), {
      curve: idleCurve, y: "gph", dots: idleTemp.map((s) => [s.x, s.gph]).filter((d) => d[1] != null), minNear: 15, height: 170,
      xFmt: (v) => v.toFixed(0), yFmt: (v) => v.toFixed(2), xUnit: " °F", yUnit: " gal/h", aria: "Idle fuel flow by coolant temperature",
    });

    const pairHost = host.querySelector("#ins-pair");
    const pick = (p) => {
      pairDetail(pairHost, p, secs);
      host.querySelectorAll(".same-pair").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === p.a.key + "|" + p.b.key)));
    };
    const pairs = correlations(host.querySelector("#ins-corr"), secs, pick);
    const same = pairs.filter((p) => Math.abs(p.r) >= 0.9).sort((u, v) => Math.abs(v.r) - Math.abs(u.r));
    host.querySelector("#ins-same").innerHTML = same.length
      ? `<h3>Nearly the same signal <span>|r| ≥ 0.9: showing both adds little, except where they part ways</span></h3>
         <div class="same-list">${same.map((p) => `<button type="button" class="same-pair" data-k="${p.a.key}|${p.b.key}">${esc(p.a.label)} & ${esc(p.b.label)} <b>${p.r.toFixed(2)}</b></button>`).join("")}</div>`
      : `<p class="hint">No two signals track each other closely (|r| ≥ 0.9) yet.</p>`;
    host.querySelectorAll(".same-pair").forEach((b) => b.addEventListener("click", () => pick(same.find((p) => p.a.key + "|" + p.b.key === b.dataset.k))));
    // Start on the strongest pair that isn't related by construction.
    const first = same.find((p) => !DERIVED[p.a.key] && !DERIVED[p.b.key]) || [...pairs].sort((u, v) => Math.abs(v.r) - Math.abs(u.r))[0];
    if (first) pick(first);
  }

  return { render };
})();
