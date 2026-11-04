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

  // Distance, fuel and time per bin, from consecutive seconds (fuel economy is total miles over
  // total gallons in the bin, not an average of instant readings, which blow up near zero).
  function binned(trips, keyOf, binOf) {
    const bins = new Map();
    for (const { rows } of trips) {
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i], dt = (b.t - a.t) / 1000;
        if (dt > 2.5 || b.fuelGs == null || b.speed == null) continue;
        const k = keyOf(b);
        if (k == null) continue;
        const bin = binOf(k);
        const acc = bins.get(bin) || bins.set(bin, { miles: 0, gal: 0, secs: 0 }).get(bin);
        acc.miles += (b.speed / 3.6) * dt / 1609.344;
        acc.gal += (b.fuelGs * dt) / 745 / 3.78541;
        acc.secs += dt;
      }
    }
    return [...bins.entries()].sort((x, y) => x[0] - y[0]).map(([bin, v]) => ({ bin, ...v, mpg: v.gal > 0 ? v.miles / v.gal : null }));
  }

  // ---------- bar chart: one series, one axis, hover tooltip ----------

  function bars(host, items, { unit, fmt, aria, faded = () => false, tip }) {
    host.replaceChildren();
    const svg = svgEl("svg", { class: "ins-chart", role: "img", "aria-label": aria }, host);
    const tipEl = document.createElement("div");
    tipEl.className = "chart-tip";
    tipEl.hidden = true;
    host.appendChild(tipEl);
    const H = 190, top = 14, bottom = 26, left = 40, right = 8;
    // Scale to the bars with enough data; a thin one (a few seconds coasting at 100+ mpg) is clipped
    // at the top instead of flattening everything else. Its tooltip still has the real value.
    const solid = items.filter((d) => d.value != null && !faded(d)).map((d) => d.value);
    const vals = solid.length ? solid : items.map((d) => d.value).filter((v) => v != null);
    const max = Math.max(1e-9, ...vals);
    const step = niceStep(max / 4);
    const ymax = Math.ceil(max / step) * step;
    function draw() {
      const W = Math.max(280, host.clientWidth);
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);
      svg.replaceChildren();
      const y = (v) => top + (1 - v / ymax) * (H - top - bottom);
      for (let v = 0; v <= ymax + 1e-9; v += step) {
        svgEl("line", { x1: left, x2: W - right, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }, svg);
        svgEl("text", { x: left - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, svg).textContent = fmt(v);
      }
      const slot = (W - left - right) / Math.max(1, items.length);
      const bw = Math.max(3, Math.min(36, slot - 4));
      const every = Math.ceil(28 / slot);
      items.forEach((d, i) => {
        const cx = left + slot * (i + 0.5);
        if (i % every === 0) svgEl("text", { x: cx, y: H - 8, class: "tick", "text-anchor": "middle" }, svg).textContent = d.label;
        if (d.value == null) return;
        const h = Math.max(1, y(0) - y(Math.min(d.value, ymax)));
        const r = Math.min(4, bw / 2, h);
        // Rounded top, square base on the axis.
        const x0 = cx - bw / 2, x1 = cx + bw / 2, y0 = y(0) - h;
        const path = `M${x0},${y(0)}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x1 - r}Q${x1},${y0} ${x1},${y0 + r}V${y(0)}Z`;
        svgEl("path", { d: path, class: faded(d) ? "bar bar-faded" : "bar" }, svg);
        const hit = svgEl("rect", { x: cx - slot / 2, y: top, width: slot, height: H - top - bottom, fill: "transparent" }, svg);
        hit.addEventListener("pointerenter", () => {
          tipEl.hidden = false;
          tipEl.innerHTML = tip(d);
          const w = tipEl.offsetWidth;
          tipEl.style.left = Math.min(W - w - 4, Math.max(4, cx - w / 2)) + "px";
        });
        hit.addEventListener("pointerleave", () => { tipEl.hidden = true; });
      });
    }
    draw();
    new ResizeObserver(() => draw()).observe(host);
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
      return v.length >= 30 && Math.max(...v) - Math.min(...v) > 1e-9;
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
    const W = labelW + cell * (n - 1) + 4, H = cell * (n - 1) + 4;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    // Lower triangle: row i against columns j < i. Row labels on the left; a column's name is in its tooltip.
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
      <h3 class="sub">${esc(p.a.label)} × ${esc(p.b.label)} <span>r = ${p.r.toFixed(2)} · ${strength} · ${idx.length.toLocaleString()} seconds</span></h3>
      ${derived ? `<p class="hint">Fuel flow is ${derived}, so a strong link with those is expected.</p>` : ""}
      <div class="scatter-host chart-host"></div>
      <h3 class="sub">Where they disagree most</h3>
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
    const ext = (k) => { const v = pts.map((q) => q[k]); return [Math.min(...v), Math.max(...v)]; };
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
    let miles = 0, gal = 0, cost = 0, waste = 0, wasteCost = 0, priced = true;
    for (const t of trips) {
      const e = Engine.summary(t.rows, { vehicle: t.r.meta.vehicle });
      miles += e.miles;
      if (e.gal != null) {
        gal += e.gal;
        if (t.gas) cost += e.gal * t.gas.price; else priced = false;
      }
      if (e.waste) {
        const w = e.waste.idle + e.waste.braking + e.waste.rich;
        waste += w;
        if (t.gas) wasteCost += w * t.gas.price;
      }
    }
    const tile = (label, value, unit = "") => `<div class="stat"><span>${label}</span><b>${value}<small>${unit}</small></b></div>`;
    const bySpeed = binned(trips, (b) => b.speed * MPH, (mph) => Math.floor(mph / 5) * 5);
    const moving = bySpeed.filter((d) => d.bin > 0);
    const byTempMoving = binned(trips, (b) => (b.speed * MPH > 3 && b.coolant != null ? Engine.cToF(b.coolant) : null), (f) => Math.floor(f / 10) * 10);
    const byTempIdle = binned(trips, (b) => (b.speed === 0 && b.rpm > 300 && b.coolant != null ? Engine.cToF(b.coolant) : null), (f) => Math.floor(f / 10) * 10);
    const thin = (d) => d.secs < 20;
    const mins = (s) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`);

    host.innerHTML = `
      <div class="stats ins-tiles">
        ${tile("Drives", trips.length)}
        ${tile("Distance", miles.toFixed(miles < 10 ? 1 : 0), "mi")}
        ${tile("Fuel economy", gal ? (miles / gal).toFixed(0) : "–", "mpg")}
        ${tile("Fuel used", gallons(gal), "gal")}
        ${tile("Spent", cost && priced ? money(cost) : "–")}
        ${tile("Wasted", gal ? Math.round((waste / gal) * 100) + "%" : "–", wasteCost ? " · " + money(wasteCost) : "")}
      </div>
      <section class="card ins-card">
        <h2>Fuel economy by speed</h2>
        <div id="ins-speed" class="chart-host"></div>
        <h3 class="sub">Time spent at each speed</h3>
        <div id="ins-speed-time" class="chart-host"></div>
        <p class="hint">Miles divided by gallons for every second spent in each 5 mph band, across all drives. Pale bars have under 20 seconds of data.</p>
      </section>
      <section class="card ins-card">
        <h2>Fuel economy by engine temperature</h2>
        <div id="ins-temp" class="chart-host"></div>
        <h3 class="sub">Fuel burned idling, by engine temperature</h3>
        <div id="ins-temp-idle" class="chart-host"></div>
        <p class="hint">A cold engine runs richer and fights thicker oil. The idle chart shows that most cleanly, since speed doesn't vary. While driving, cold minutes are often also slow neighborhood minutes, so part of that gap is speed, not temperature.</p>
      </section>
      <section class="card ins-card">
        <h2>How the signals move together</h2>
        <p class="hint ins-lead">Each square compares two engine signals, second by second: blue rises together, red moves opposite, gray is unrelated. Click a square to see the two side by side and when they part ways.</p>
        <div id="ins-corr"></div>
        <div id="ins-same"></div>
        <div id="ins-pair"></div>
      </section>`;

    bars(host.querySelector("#ins-speed"), moving.map((d) => ({ ...d, label: `${d.bin}`, value: d.mpg })), {
      unit: "mpg", fmt: (v) => v.toFixed(0), aria: "Fuel economy by speed", faded: thin,
      tip: (d) => `<b>${d.bin}–${d.bin + 5} mph: ${d.mpg != null ? d.mpg.toFixed(1) + " mpg" : "–"}</b> <span>${mins(d.secs)}</span>`,
    });
    bars(host.querySelector("#ins-speed-time"), bySpeed.map((d) => ({ ...d, label: d.bin === 0 ? "0" : `${d.bin}`, value: d.secs / 60 })), {
      unit: "min", fmt: (v) => v.toFixed(v < 10 ? 1 : 0), aria: "Time spent at each speed",
      tip: (d) => `<b>${d.bin === 0 ? "Under 5 mph" : `${d.bin}–${d.bin + 5} mph`}: ${mins(d.secs)}</b>`,
    });
    bars(host.querySelector("#ins-temp"), byTempMoving.map((d) => ({ ...d, label: `${d.bin}°`, value: d.mpg })), {
      unit: "mpg", fmt: (v) => v.toFixed(0), aria: "Fuel economy by coolant temperature", faded: thin,
      tip: (d) => `<b>${d.bin}–${d.bin + 10} °F: ${d.mpg != null ? d.mpg.toFixed(1) + " mpg" : "–"}</b> <span>${mins(d.secs)} driving</span>`,
    });
    bars(host.querySelector("#ins-temp-idle"), byTempIdle.map((d) => ({ ...d, label: `${d.bin}°`, value: d.secs ? (d.gal / d.secs) * 3600 : null })), {
      unit: "gal/h", fmt: (v) => v.toFixed(2), aria: "Idle fuel flow by coolant temperature", faded: thin,
      tip: (d) => `<b>${d.bin}–${d.bin + 10} °F: ${((d.gal / d.secs) * 3600).toFixed(2)} gal/h</b> <span>${mins(d.secs)} idling</span>`,
    });

    const pairHost = host.querySelector("#ins-pair");
    const pick = (p) => {
      pairDetail(pairHost, p, secs);
      host.querySelectorAll(".same-pair").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === p.a.key + "|" + p.b.key)));
    };
    const pairs = correlations(host.querySelector("#ins-corr"), secs, pick);
    const same = pairs.filter((p) => Math.abs(p.r) >= 0.9).sort((u, v) => Math.abs(v.r) - Math.abs(u.r));
    host.querySelector("#ins-same").innerHTML = same.length
      ? `<h3 class="sub">Nearly the same signal <span>|r| ≥ 0.9: showing both adds little, except where they part ways</span></h3>
         <div class="same-list">${same.map((p) => `<button type="button" class="same-pair" data-k="${p.a.key}|${p.b.key}">${esc(p.a.label)} & ${esc(p.b.label)} <b>${p.r.toFixed(2)}</b></button>`).join("")}</div>`
      : `<p class="hint">No two signals track each other closely (|r| ≥ 0.9) yet.</p>`;
    host.querySelectorAll(".same-pair").forEach((b) => b.addEventListener("click", () => pick(same.find((p) => p.a.key + "|" + p.b.key === b.dataset.k))));
    // Start on the strongest pair that isn't related by construction.
    const first = same.find((p) => !DERIVED[p.a.key] && !DERIVED[p.b.key]) || pairs.sort((u, v) => Math.abs(v.r) - Math.abs(u.r))[0];
    if (first) pick(first);
  }

  return { render };
})();
