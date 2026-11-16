// The cost ribbon: a band drawn beside the route whose width is the gas spent per mile there, split
// into lanes by what that gas went to. Its area is the gas itself, so a wide stretch is where the
// money went, and the lane colors say why: the engine just running, the tires, the air, speeding
// up, climbing, or everything else. Gas burned standing still has no miles to spread over; it's a
// circle at the stop, drawn at the same ink per gallon as the band (at the current zoom).
//
// The split comes from physics checked against the engine's own fuel readings, second by second:
// the power to roll the tires (CRR·m·g·v), push the air (½ρ·CdA·v³), add speed (m·a·v, when speeding
// up) and climb (m·g·v·grade, with the grade from terrain.js), turned into fuel by a straight line
// fitted to this drive (fuel = running + k × power). Fitting per drive soaks up the engine's
// efficiency and how much it burns just to run. Going downhill the slope does some of the work, so
// every other lane shrinks alike there (what it saved is counted apart, as `totals.downhill`).
// Whatever the engine burned beyond what all that explains is "other": a cold engine, running rich, a
// load, the model being rough. Without grades (no elevation for this drive), climbs are in "other"
// too, and it's labeled "Hills & other". Seconds that burned less than predicted (fuel cut while
// coasting) shrink every lane alike, so the lanes always add up to the fuel actually burned.

const Ribbon = (() => {
  const G = 9.80665;
  const { J_PER_GAL, CRR, AIR, body } = Engine.physics;
  const J_PER_G = J_PER_GAL / (Engine.FUEL_G_PER_L * Engine.L_PER_GAL); // ≈ 42 kJ in a gram of E10
  const MOVING = 2; // m/s (4.5 mph). Slower, the gas is counted to the stop, not spread along the road.
  const ROT = 1.05; // speeding up the car also spins up its wheels and driveline
  const HALF_MS = 4000; // widths are averaged over the ±4 s around each fix: stretches, not single seconds
  const PX_PER_GPM = 400; // ribbon width in px per gallon per mile (40 mpg is 10 px)
  const MAX_W = 60; // px; wider (a hard start from a light) is capped, and the legend says so
  const FIT_HALF = 2; // the fuel line is fitted on ±2 s averages (see decompose)
  const GAP = 3; // px between the route's center line and the ribbon
  const SPREAD_PX = 14; // widths are spread along ±14 px of on-screen road (see _band)
  const DIR_PX = 10; // the band's direction comes from ±10 px of road

  // Lanes from the route outward: what you can't help nearest, what you can furthest out.
  const CAUSES = [
    { key: "base", label: "Engine on", color: "#8d8a83" },
    { key: "roll", label: "Tires", color: "#4d84d1" },
    { key: "air", label: "Air", color: "#5cc8d0" },
    { key: "climb", label: "Climbing", color: "#84c26a" },
    { key: "accel", label: "Speeding up", color: "#f2a33a" },
    { key: "other", label: "Other", color: "#e2557a" },
  ];
  // "Other" holds climbs too when the drive has no grades.
  const labelOf = (c, d) => (c.key === "other" && !d.hasGrades ? "Hills & other" : c.label);
  const IDLE = { key: "idle", label: "Standing still", color: "#a98bf0" };
  const ALL = [...CAUSES, IDLE];
  const gal = (g) => g / Engine.FUEL_G_PER_L / Engine.L_PER_GAL;

  // Fuel (g/s) = running + k × power (W), by least squares over moving seconds with fuel flowing.
  // Kept to what an engine can be: 12-40% efficient, running costs between half and four times idle.
  function fit(xs, ys, idleGs) {
    const kLo = 1 / (0.4 * J_PER_G), kHi = 1 / (0.12 * J_PER_G), kMid = 1 / (0.25 * J_PER_G);
    const bLo = idleGs * 0.5, bHi = idleGs * 4;
    const n = xs.length;
    if (n < 30) return { b: idleGs, k: kMid };
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const mx = sx / n, my = sy / n, vx = sxx / n - mx * mx;
    let k = vx > 0 ? (sxy / n - mx * my) / vx : kMid;
    k = Math.min(kHi, Math.max(kLo, k));
    let b = my - k * mx;
    if (b < bLo || b > bHi) {
      b = Math.min(bHi, Math.max(bLo, b));
      let num = 0;
      for (let i = 0; i < n; i++) num += xs[i] * (ys[i] - b);
      k = sxx > 0 ? Math.min(kHi, Math.max(kLo, num / sxx)) : kMid;
    }
    return { b, k };
  }

  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  };

  /**
   * Splits the gas along `pts` (fixes with engine rows attached as p.eng; see Engine.attach) by cause.
   * Returns { lanes: per fix [gal/mi per CAUSES lane] or null, perMile: per fix total gal/mi or null,
   * stops: [{ lat, lon, g, ms, i0, i1 }], totals: { key: grams }, fit: { b, k, eta } }.
   */
  function decompose(pts, { vehicle = "", towing = false } = {}) {
    const n = pts.length, { mass, cda } = body(vehicle, towing);
    const dts = new Float64Array(n), miles = new Float64Array(n), fuel = new Float64Array(n).fill(NaN);
    // Power (W) going into each cause. The slope's is signed: downhill it pushes, and every other
    // part shrinks alike by what it supplies (`saved`); `net` is what the engine had to give.
    const power = (v, a, grade) => {
      const w = {
        roll: CRR * mass * G * v,
        air: 0.5 * AIR * cda * v * v * v,
        accel: Math.max(0, ROT * mass * (a ?? 0) * v),
        climb: Math.max(0, mass * G * v * (grade ?? 0)),
      };
      const pos = w.roll + w.air + w.accel + w.climb;
      const push = Math.max(0, -mass * G * v * (grade ?? 0));
      const net = Math.max(0, pos - push), f = pos > 0 ? net / pos : 0;
      for (const key in w) w[key] *= f;
      return { ...w, net, saved: pos - net };
    };
    const idle = [];
    // Each moving second with fuel flowing: the power asked of the engine and the fuel it burned.
    const P = new Float64Array(n).fill(NaN), Fg = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[i + 1];
      const dt = q && q.trip === p.trip ? (q.t - p.t) / 1000 : 0;
      if (!(dt > 0) || dt > 5) continue;
      dts[i] = dt;
      const f = p.eng?.fuelGs;
      if (f != null && Number.isFinite(f)) fuel[i] = Math.max(0, f) * dt;
      const v = p.v ?? 0;
      if (v >= MOVING) {
        miles[i] = Route.haversine(p.lat, p.lon, q.lat, q.lon) / 1609.344;
        if (f > 0 && !p.eng.cut) { P[i] = power(v, p.a, p.grade).net; Fg[i] = f; }
      } else if (v < 0.5 && f > 0 && (p.eng.rpm ?? 0) > 300) idle.push(f);
    }
    const idleGs = Math.min(0.6, Math.max(0.05, median(idle) ?? 0.15));
    // Fitted on ±2 s averages of both, not single seconds: second by second, GPS acceleration is
    // noisy and the engine's fuel reading lags the push by a second or so, and both flatten the
    // fitted line (k too small, so an engine better than any real one, and running cost too high).
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) {
      if (!(P[i] >= 0)) continue;
      let sp = 0, sf = 0, m = 0;
      for (let j = Math.max(0, i - FIT_HALF); j <= Math.min(n - 1, i + FIT_HALF); j++) {
        if (P[j] >= 0 && pts[j].trip === pts[i].trip && Math.abs(pts[j].t - pts[i].t) <= FIT_HALF * 1000 + 500) { sp += P[j]; sf += Fg[j]; m++; }
      }
      if (m >= 3) { xs.push(sp / m); ys.push(sf / m); }
    }
    const { b, k } = fit(xs, ys, idleGs);

    // Grams of each cause in each fix's step.
    const parts = Object.fromEntries(ALL.map((c) => [c.key, new Float64Array(n)]));
    let downhill = 0; // grams the slope saved going downhill (not a lane: it wasn't burned)
    let movingS = 0, stillS = 0; // seconds with fuel readings, moving and standing still
    for (let i = 0; i < n; i++) {
      const F = fuel[i];
      if (!(F >= 0)) continue;
      const p = pts[i], dt = dts[i];
      if ((p.v ?? 0) < MOVING) { parts.idle[i] = F; stillS += dt; continue; }
      movingS += dt;
      const w = power(p.v, p.a, p.grade);
      const m = { base: b * dt, roll: k * w.roll * dt, air: k * w.air * dt, climb: k * w.climb * dt, accel: k * w.accel * dt };
      const M = m.base + m.roll + m.air + m.climb + m.accel;
      const s = F >= M ? 1 : M > 0 ? F / M : 0;
      for (const key in m) parts[key][i] = m[key] * s;
      parts.other[i] = Math.max(0, F - M);
      downhill += k * w.saved * dt;
    }

    // Per mile around each moving fix: the grams of each cause and the miles within ±4 s.
    const lanes = new Array(n).fill(null), perMile = new Array(n).fill(null);
    // Running sums over the fixes within ±4 s (moving, with fuel), slid along the drive.
    const sums = new Float64Array(CAUSES.length);
    let lo = 0, hi = -1, wMi = 0;
    const counts = (j) => (pts[j].v ?? 0) >= MOVING && fuel[j] >= 0;
    const inWin = (j, i) => pts[j].trip === pts[i].trip && counts(j);
    const slide = (j, sign) => {
      if (!counts(j)) return;
      wMi += sign * miles[j];
      CAUSES.forEach((c, x) => { sums[x] += sign * parts[c.key][j]; });
    };
    for (let i = 0; i < n; i++) {
      const t = pts[i].t;
      while (hi + 1 < n && pts[hi + 1].t <= t + HALF_MS) slide(++hi, 1);
      while (lo <= hi && pts[lo].t < t - HALF_MS) slide(lo++, -1);
      const p = pts[i];
      // A fix whose second has no fuel reading (the adapter skipped it, ~3% of seconds) takes its
      // width from the seconds around it, so the band doesn't break; only a dropout long enough to
      // leave the whole window without readings leaves a gap.
      if ((p.v ?? 0) < MOVING || !(wMi > 0.002)) continue;
      // A window reaching into the next trip (pages of several drives) isn't this stretch: skip it.
      if (pts[lo].trip !== p.trip || pts[hi].trip !== p.trip) {
        let mi = 0;
        const g = new Float64Array(CAUSES.length);
        for (let j = lo; j <= hi; j++) if (inWin(j, i)) { mi += miles[j]; CAUSES.forEach((c, x) => { g[x] += parts[c.key][j]; }); }
        if (!(mi > 0.002)) continue;
        lanes[i] = [...g].map((x) => Math.max(0, gal(x) / mi));
      } else lanes[i] = [...sums].map((x) => Math.max(0, gal(x) / wMi));
      perMile[i] = lanes[i].reduce((a, x) => a + x, 0);
    }

    // Standing still: runs of slow fixes, each a circle of the gas it burned.
    const stops = [];
    let run = null;
    const close = () => {
      if (run && run.g > 0) {
        const k = run.i1 - run.i0 + 1;
        let la = 0, lo2 = 0;
        for (let j = run.i0; j <= run.i1; j++) { la += pts[j].lat; lo2 += pts[j].lon; }
        stops.push({ lat: la / k, lon: lo2 / k, g: run.g, ms: pts[run.i1].t - pts[run.i0].t + dts[run.i1] * 1000, i0: run.i0, i1: run.i1 });
      }
      run = null;
    };
    for (let i = 0; i < n; i++) {
      const slow = (pts[i].v ?? 0) < MOVING && dts[i] > 0;
      if (!slow || (run && pts[i].trip !== pts[run.i1].trip)) close();
      if (!slow) continue;
      run ||= { i0: i, i1: i, g: 0 };
      run.i1 = i;
      run.g += parts.idle[i];
    }
    close();

    const totals = Object.fromEntries(ALL.map((c) => [c.key, parts[c.key].reduce((a, x) => a + x, 0)]));
    totals.downhill = downhill;
    const hasGrades = pts.some((p) => p.grade != null);
    return { pts, parts, lanes, perMile, stops, totals, hasGrades, mass, cda, movingS, stillS, fit: { b, k, eta: 1 / (k * J_PER_G), idleGs } };
  }

  // ---------- drawing ----------

  // Screen pixels per mile at a latitude and zoom (Web Mercator).
  const pxPerMile = (lat, zoom) => 1609.344 / ((40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom));

  /** A Leaflet layer drawing `d` (from decompose) on a canvas over the map; `only` shows one cause alone. */
  function layer(d) {
    const Layer = L.Layer.extend({
      onAdd(map) {
        this._c = L.DomUtil.create("canvas", "ribbon-canvas leaflet-zoom-hide");
        this._c.style.pointerEvents = "none";
        map.getPane("route").appendChild(this._c);
        map.on("moveend zoomend resize viewreset", this._draw, this);
        this._draw();
      },
      onRemove(map) {
        map.off("moveend zoomend resize viewreset", this._draw, this);
        this._c.remove();
      },
      setData(nd) { d = nd; if (this._map) this._draw(); },
      only(key) { this._only = key; if (this._map) this._draw(); },
      _alpha(key) { return this._only == null || this._only === key ? 0.92 : 0.12; },
      _draw() {
        const map = this._map, c = this._c, size = map.getSize(), dpr = window.devicePixelRatio || 1;
        c.width = size.x * dpr; c.height = size.y * dpr;
        c.style.width = `${size.x}px`; c.style.height = `${size.y}px`;
        L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
        const ctx = c.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.x, size.y);
        const pts = d.pts;
        let run = [], last = -1;
        const flush = () => { if (run.length >= 2) this._band(ctx, run); run = []; };
        for (let i = 0; i < pts.length; i++) {
          if (!d.lanes[i]) { flush(); last = -1; continue; }
          if (last >= 0 && (pts[i].trip !== pts[last].trip || pts[i].t - pts[last].t > 5000)) flush();
          last = i;
          const xy = map.latLngToContainerPoint([pts[i].lat, pts[i].lon]);
          // Every fix is kept (each carries its share of the band's ink); only ones on the same pixel are merged.
          if (run.length && xy.distanceTo(run[run.length - 1].xy) < 0.5) continue;
          run.push({ xy, i });
        }
        flush();
        // Circles for standing still, at the band's ink per gallon.
        const z = map.getZoom();
        ctx.globalAlpha = this._alpha("idle");
        for (const s of d.stops) {
          const xy = map.latLngToContainerPoint([s.lat, s.lon]);
          const r = Math.max(3, Math.sqrt((gal(s.g) * PX_PER_GPM * pxPerMile(s.lat, z)) / Math.PI));
          ctx.beginPath();
          ctx.arc(xy.x, xy.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = IDLE.color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(11, 11, 11, 0.8)";
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      },
      // One unbroken stretch: lanes stacked to the right of the direction of travel.
      //
      // Drawing it tidily without changing what it says:
      // - Widths are spread along the road over ±SPREAD_PX of screen distance (a normalized moving
      //   average by distance, which moves ink along the road but neither adds nor removes any), so a
      //   start from a stop shows as a swell, not a spike a few pixels long. In pixels, so zoomed out
      //   it smooths more and zoomed in it shows the detail.
      // - Direction comes from ±DIR_PX of road, so GPS wander at walking pace can't swing it around.
      // - On a turn toward the band's side, the band can't be wider than the turn's radius or its
      //   inner edge crosses itself and folds; there it's narrowed to fit (the one place ink is lost,
      //   and only where a fold would have drawn it twice).
      _band(ctx, run) {
        const m = run.length;
        const s = new Float64Array(m);
        for (let k = 1; k < m; k++) s[k] = s[k - 1] + Math.hypot(run[k].xy.x - run[k - 1].xy.x, run[k].xy.y - run[k - 1].xy.y);
        // Index ranges within ±r px of road around each point.
        const span = (r) => {
          const lo = new Int32Array(m), hi = new Int32Array(m);
          for (let k = 0, a = 0, b = 0; k < m; k++) {
            while (s[k] - s[a] > r) a++;
            if (b < k) b = k;
            while (b + 1 < m && s[b + 1] - s[k] <= r) b++;
            lo[k] = a; hi[k] = b;
          }
          return [lo, hi];
        };
        // Direction of travel over ±DIR_PX, then the normal to its right (screen y points down).
        const [dl, dh] = span(DIR_PX);
        let nx = new Float64Array(m), ny = new Float64Array(m);
        const ang = new Float64Array(m);
        for (let k = 0; k < m; k++) {
          const a = run[dl[k] === k && k > 0 ? k - 1 : dl[k]].xy, b = run[dh[k] === k && k < m - 1 ? k + 1 : dh[k]].xy;
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
          nx[k] = -dy / len; ny[k] = dx / len;
        }
        for (let pass = 0; pass < 2; pass++) {
          const sx = new Float64Array(m), sy = new Float64Array(m);
          for (let k = 0; k < m; k++) {
            const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1);
            const x = nx[a] + 2 * nx[k] + nx[b], y = ny[a] + 2 * ny[k] + ny[b], len = Math.hypot(x, y) || 1;
            sx[k] = x / len; sy[k] = y / len;
          }
          nx = sx; ny = sy;
        }
        for (let k = 0; k < m; k++) ang[k] = Math.atan2(-nx[k], ny[k]); // heading
        // Widths spread along the road: triangle-weighted by distance and by each point's share of road.
        const ds = (k) => ((k < m - 1 ? s[k + 1] - s[k] : 0) + (k > 0 ? s[k] - s[k - 1] : 0)) / 2 || 0.5;
        const raw = run.map(({ i }) => d.lanes[i].map((x) => x * PX_PER_GPM));
        const [wl, wh] = span(SPREAD_PX);
        const widths = raw.map((_, k) => {
          const out = new Array(CAUSES.length).fill(0);
          let wsum = 0;
          for (let j = wl[k]; j <= wh[k]; j++) {
            const wt = ds(j) * (1 - Math.abs(s[j] - s[k]) / (SPREAD_PX + 1));
            wsum += wt;
            for (let x = 0; x < out.length; x++) out[x] += raw[j][x] * wt;
          }
          return out.map((x) => x / (wsum || 1));
        });
        // Room on the inside of turns toward the band: the turn's radius, from how fast the heading
        // turns over ±DIR_PX of road; the tightest nearby point sets it, so the band narrows smoothly.
        const room = new Float64Array(m).fill(Infinity);
        for (let k = 0; k < m; k++) {
          const a = dl[k], b = dh[k];
          if (s[b] - s[a] < 1) continue;
          const turn = Math.atan2(Math.sin(ang[b] - ang[a]), Math.cos(ang[b] - ang[a])); // + is a right turn on screen
          if (turn > 0.05) room[k] = (0.9 * (s[b] - s[a])) / turn;
        }
        for (let k = 0; k < m; k++) {
          let r = room[k];
          for (let j = dl[k]; j <= dh[k]; j++) r = Math.min(r, room[j]);
          const tot = widths[k].reduce((a, x) => a + x, 0);
          const cap = Math.min(MAX_W, Math.max(0, r - GAP));
          if (tot > cap) widths[k] = widths[k].map((x) => (x * cap) / tot);
        }
        const inner = new Float64Array(m).fill(GAP);
        CAUSES.forEach((cause, j) => {
          ctx.beginPath();
          for (let k = 0; k < m; k++) {
            const o = inner[k] + widths[k][j], { x, y } = run[k].xy;
            if (k) ctx.lineTo(x + nx[k] * o, y + ny[k] * o); else ctx.moveTo(x + nx[k] * o, y + ny[k] * o);
          }
          for (let k = m - 1; k >= 0; k--) {
            const { x, y } = run[k].xy;
            ctx.lineTo(x + nx[k] * inner[k], y + ny[k] * inner[k]);
          }
          ctx.closePath();
          ctx.globalAlpha = this._alpha(cause.key);
          ctx.fillStyle = cause.color;
          ctx.fill();
          for (let k = 0; k < m; k++) inner[k] += widths[k][j];
        });
        // A dark edge on the outside, so the band reads against the streets.
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (let k = 0; k < m; k++) {
          const { x, y } = run[k].xy;
          if (k) ctx.lineTo(x + nx[k] * inner[k], y + ny[k] * inner[k]); else ctx.moveTo(x + nx[k] * inner[k], y + ny[k] * inner[k]);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#0b0b0b";
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    });
    return new Layer();
  }

  // ---------- words ----------

  // Money with a price ($/gal), else gallons.
  const money = (g, price) => {
    const gl = gal(g);
    if (price == null) return `${gl < 0.1 ? gl.toFixed(3) : gl.toFixed(2)} gal`;
    const usd = gl * price;
    return usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`;
  };
  const perMileText = (gpm, price) => (price != null ? `${(gpm * price * 100).toFixed(gpm * price * 100 < 10 ? 1 : 0)}¢/mi` : `${(gpm * 100).toFixed(1)} gal/100 mi`);
  const swatch = (c) => `<i class="rb-sw" style="background:${c.color}"></i>`;

  // What each cause is, why it costs gas, and how it was worked out, with this drive's own numbers
  // (the fitted engine and the car's assumed weight and shape). Shown under the legend for the cause
  // tapped (or hovered with a mouse).
  const MI = 1609.344, MPS_PER_MPH = 0.44704;
  const lb = (kg) => `${Math.round((kg * 2.20462) / 50) * 50} lb`;
    const perMi = (gpm, price) => perMileText(gal(gpm), price); // gpm: grams per mile
  function explainHtml(d, key, price) {
    const { b, k, eta, idleGs } = d.fit, total = ALL.reduce((a, c) => a + d.totals[c.key], 0);
    const v = (mph) => mph * MPS_PER_MPH;
    const share = (key) => (total > 0 ? Math.round((d.totals[key] / total) * 100) : 0);
    const mins = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
    const c = ALL.find((x) => x.key === key);
    const head = `<b>${swatch(c)} ${labelOf(c, d)}</b> · ${money(d.totals[key], price)}, ${share(key)}% of this drive's gas. `;
    let body;
    switch (key) {
      case "base": {
        const gph = gal(b * 3600);
        body = `What the engine burns just to keep turning while you're moving: its own internal friction, pumps, the alternator, A/C. It's paid per minute, not per mile, so slow miles cost more of it: about ${perMi((b * MI) / v(25), price)} at 25 mph but ${perMi((b * MI) / v(60), price)} at 60. ` +
          `Worked out from this drive's engine readings as the fuel it burns at zero load: about ${gph.toFixed(2)} gal/hour. ${d.movingS ? `${mins(d.movingS)} moving.` : ""}`;
        break;
      }
      case "roll":
        body = `Tires flatten a little where they meet the road and spring back as they roll, and that flexing turns some of the engine's work into heat. The force is about ${CRR} × the car's weight (${lb(d.mass)} assumed), whatever the speed, so it's a steady ${perMi(k * CRR * d.mass * G * MI, price)} on every mile. Underinflated tires flex more and raise it.`;
        break;
      case "air":
        body = `Pushing air out of the way. The force grows with the square of speed (½ × air density × drag area ${d.cda.toFixed(2)} m² × speed²), so each mile costs ${perMi(k * 0.5 * AIR * d.cda * v(35) ** 2 * MI, price)} at 35 mph, ${perMi(k * 0.5 * AIR * d.cda * v(55) ** 2 * MI, price)} at 55 and ${perMi(k * 0.5 * AIR * d.cda * v(75) ** 2 * MI, price)} at 75. Small around town; the biggest lane on the highway.`;
        break;
      case "climb": {
        const src = d.pts.gradeSource === "barometer" ? "the phone's barometer" : "USGS ground heights";
        body = `Lifting the car uphill: weight × gravity × height gained. Climbing 100 ft costs about ${money(k * d.mass * G * 30.48, price)} in this car. Grades come from ${src}. ` +
          (d.totals.downhill > 0 ? `Going back down, the slope pushes and every other lane shrinks there; downhills on this drive saved about ${money(d.totals.downhill, price)}.` : "");
        break;
      }
      case "accel":
        body = `Adding speed: the energy of the car's motion (½ × mass × speed², plus a little to spin up the wheels), worked out from how fast the GPS speed rose. Getting up to 45 mph once costs about ${money(k * ROT * 0.5 * d.mass * v(45) ** 2, price)}; braking turns that energy into heat, so every stop-and-go pays it again. A hard start puts about the same energy here (the extra gas it burns shows up in Other); what shrinks this lane is braking less, by coasting up to lights and keeping a steady speed.`;
        break;
      case "other":
        body = `Whatever the engine's own fuel readings show beyond what the lanes above explain: a cold engine running rich while it warms up, the A/C or a heavy load, wind, rough roads, ${d.hasGrades ? "" : "climbs (this drive has no elevation data, so hills land here too), "}and the model's own roughness. It's measured, not guessed: the fuel actually burned minus what the physics accounts for. Seconds that burned less than predicted (coasting with the fuel cut off) shrink every lane alike instead, so the lanes add up to the gas burned.`;
        break;
      case "idle": {
        const n = d.stops.length;
        body = `Gas burned while crawling under 4.5 mph or stopped: lights, stop signs, traffic, warming up. There are no miles to spread it over, so it's drawn as circles at the stops, sized at the same scale as the band. Read straight from the engine's fuel rate${n ? `: ${n} stop${n === 1 ? "" : "s"}, ${mins(d.stillS)} in all, about ${gal(idleGs * 3600).toFixed(2)} gal/hour at idle` : ""}.`;
        break;
      }
    }
    return head + body;
  }
  const howHtml = (d) => `Tap${globalThis.matchMedia?.("(hover: hover)").matches ? " or hover" : ""} a cause to see what it is; tap again to show everything.
    <details class="rb-how"><summary>How is the gas split?</summary>Each second, speed, acceleration and grade give the power going to the tires, air, speeding up and climbing. A line, fuel = running cost + k × power, is fitted to this drive's own engine fuel readings (each extra bit of push took fuel at about ${Math.round(d.fit.eta * 100)}% efficiency, on top of the running cost), and each second's fuel is shared out by it.</details>`;

  /** The legend: each cause with its share of the drive's gas; a button shows it alone and explains it. */
  function legendHtml(d, price, only = null) {
    const total = ALL.reduce((a, c) => a + d.totals[c.key], 0);
    if (!(total > 0)) return `<p class="hint">No fuel readings on this drive to split.</p>`;
    const rows = ALL.filter((c) => c.key !== "climb" || d.hasGrades).map((c) => {
      const t = d.totals[c.key], pct = Math.round((t / total) * 100);
      return `<button type="button" class="rb-cause" data-cause="${c.key}" aria-pressed="${only === c.key}">${swatch(c)}<span>${labelOf(c, d)}</span><b>${money(t, price)}</b><small>${pct}%</small></button>`;
    }).join("");
    const ref = 0.025; // gal/mi: 10 px
    const src = d.pts.gradeSource === "barometer" ? "the phone's barometer" : "USGS ground heights";
    const down = d.hasGrades ? ` Hills from ${src}${d.totals.downhill > 0.02 * total ? `; downhills saved about ${money(d.totals.downhill, price)}` : ""}.` : "";
    return `<div class="rb-legend">${rows}</div>
      <div class="rb-explain" id="rb-explain">${only ? explainHtml(d, only, price) : howHtml(d)}</div>
      <p class="hint">Band width is gas per mile (<span class="rb-scale"></span> ${perMileText(ref, price)}); circles are gas burned standing still, at the same scale.${down}</p>`;
  }

  /** Readout lines for fix i: gas per mile here and what it went to. */
  function readoutHtml(d, i, price) {
    const l = d.lanes[i];
    if (!l) {
      const s = d.stops.find((x) => i >= x.i0 && i <= x.i1);
      return s ? `<dt>${swatch(IDLE)} Standing still</dt><dd>${money(s.g, price)}</dd>` : "";
    }
    const tot = l.reduce((a, x) => a + x, 0);
    const parts = CAUSES.map((c, j) => [c, l[j]]).filter(([, x]) => tot > 0 && x / tot >= 0.08).sort((a, b) => b[1] - a[1]);
    const g = d.pts[i].grade;
    return `<dt>Gas here</dt><dd>${tot > 0 ? perMileText(tot, price) : "coasting"}</dd>` +
      (g != null ? `<dt>Grade</dt><dd>${g >= 0.005 ? "+" : ""}${(g * 100).toFixed(1)}%</dd>` : "") +
      parts.map(([c, x]) => `<dt>${swatch(c)} ${labelOf(c, d)}</dt><dd>${Math.round((x / tot) * 100)}%</dd>`).join("");
  }

  return { decompose, layer, legendHtml, explainHtml, howHtml, readoutHtml, CAUSES, IDLE, PX_PER_GPM, pxPerMile };
})();
