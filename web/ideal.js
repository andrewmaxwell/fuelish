// The driving score: this drive's gas against the cheapest way to drive the same trip, and what each
// difference from it cost. Same roads, same stops, never faster than you went at any point (so traffic, lights and
// speed limits you obeyed bind the ideal too); what changes is only what the driver controls:
//   rich    no fuel beyond what the air needed (pressing hard)
//   idle    the engine off in standstills of a minute or more, past their first 10 s
//   speed   cruising no faster than the cheapest steady speed (gas + your time), kept within 55-70 mph
//   smooth  slowing down early and gently (≤ 0.08 g) instead of late and hard
// Each step is applied on top of the ones before, so the lines add up exactly to actual − ideal.
//
// Fuel for a speed profile comes from the drive's own engine fit (Ribbon.decompose: fuel = b + k ×
// power while pulling, nothing while coasting with the fuel cut off), scaled so the fit reproduces the
// fuel actually measured on this drive. Model error then cancels between actual and ideal instead of
// landing on the score. A red light waits for you either way, so time an ideal leg loses (coasting up
// to a stop sooner) comes off the wait at the stop that ends it; it can't shorten the final arrival.

const Ideal = (() => {
  const G = 9.80665;
  const MPS_PER_MPH = 0.44704;
  const { CRR, AIR, body } = Engine.physics;
  const MOVING = 2; // m/s, as ribbon.js: slower is standing still
  const ROT = 1.05;
  const ACCEL = 0.2 * G; // the ideal speeds up no harder than this
  const DECEL = 0.08 * G; // and slows no harder: about a coast-down in gear (coach.js's "gentle")
  const LONG_IDLE_S = 60, RESTART_S = 10, ABSORB_MAX_S = 180;
  const MIN_CRUISE = 55, MAX_CRUISE = 70; // mph: the ideal's cruising speed stays in what's normal and legal
  const gGal = (g) => g / Engine.FUEL_G_PER_L / Engine.L_PER_GAL;

  // Fuel (g) over one stretch at average speed v̄ (m/s), going from u0 to u1 in dt seconds.
  function stepFuel(fit, mass, cda, u0, u1, dt, grade) {
    if (!(dt > 0)) return 0;
    const v = (u0 + u1) / 2, a = (u1 - u0) / dt;
    const p = (a > 0 ? ROT : 1) * mass * a * v + CRR * mass * G * v + 0.5 * AIR * cda * v * v * v + mass * G * v * (grade ?? 0);
    return p > 0 ? (fit.b + fit.k * p) * dt : 0;
  }

  // The cheapest steady speed on level road for this drive's fit: gas plus time, per mile.
  function cruiseMph(fit, mass, cda, scale, price, timePerHour) {
    let best = MIN_CRUISE, bestCost = Infinity;
    for (let mph = 40; mph <= 85; mph++) {
      const v = mph * MPS_PER_MPH, secPerMi = 1609.344 / v;
      const g = (fit.b + fit.k * (CRR * mass * G * v + 0.5 * AIR * cda * v * v * v)) * secPerMi * scale;
      const cost = (price ?? 1) * gGal(g) + (price != null ? timePerHour : 0) * (secPerMi / 3600);
      if (cost < bestCost) { bestCost = cost; best = mph; }
    }
    return { best, mph: Math.min(MAX_CRUISE, Math.max(MIN_CRUISE, best)) };
  }

  /**
   * `pts`: GPS fixes with v (m/s), t, trip, grade and eng (Engine.attach). `fit`: Ribbon.decompose's
   * { b, k, idleGs }. `richGal`: Engine.summary's fuelUse.rich. `price` ($/gal) may be null: costs are
   * then left out and the cruising speed is the one that uses least gas (kept to 55 mph or more).
   * Returns null when too little of the drive has fuel readings.
   */
  function plan(pts, fit, { vehicle = "", towing = false, richGal = 0, price = null, timePerHour = 0, minCoverage = 0.9 } = {}) {
    const n = pts.length;
    if (n < 3 || !fit) return null;
    const { mass, cda } = body(vehicle, towing);
    const v = pts.map((p) => (p.v != null && Number.isFinite(p.v) ? Math.max(0, p.v) : null));

    // Segments between consecutive fixes. `ds` is integrated from speed, so time and distance agree.
    const segs = [];
    for (let i = 0; i < n - 1; i++) {
      const p = pts[i], q = pts[i + 1], dt = (q.t - p.t) / 1000;
      const ok = q.trip === p.trip && dt > 0 && dt <= 5 && v[i] != null && v[i + 1] != null;
      const f = p.eng?.fuelGs;
      segs.push({
        i, ok, dt,
        standing: ok && v[i] < MOVING && v[i + 1] < MOVING,
        ds: ok ? ((v[i] + v[i + 1]) / 2) * dt : 0,
        grade: p.grade ?? 0,
        fuel: ok && f != null && Number.isFinite(f) ? Math.max(0, f) * dt : NaN,
      });
    }

    // Standstills: runs of standing segments. A standstill ends a leg (and can absorb that leg's lost
    // time) only when driving follows it in the same trip.
    const stops = [];
    for (let s = 0; s < segs.length; s++) {
      if (!segs[s].standing) continue;
      const st = { s0: s, s1: s, dur: 0, g: 0, gSecs: 0 };
      while (s < segs.length && segs[s].standing) {
        const x = segs[s];
        st.s1 = s; st.dur += x.dt;
        if (x.fuel >= 0) { st.g += x.fuel; st.gSecs += x.dt; }
        x.stop = st;
        s++;
      }
      // Idling is counted only over seconds the engine reported: a wait with the engine off (the
      // auto-stop's walk away from the car, a parked errand) burns nothing and saves nothing.
      st.rate = st.gSecs > 0 ? st.g / st.gSecs : 0; // g/s while standing here with the engine on
      // Only a wait about as long as a red light (under 3 min) is one you'd have sat through anyway.
      st.mid = s < segs.length && segs[s].ok && !segs[s].standing && st.dur < ABSORB_MAX_S;
      stops.push(st);
      s--;
    }

    // How well the fit reproduces this drive's measured fuel while moving, and how much is measured.
    let measured = 0, modeled = 0, movingSecs = 0, coveredSecs = 0;
    for (const x of segs) {
      if (!x.ok || x.standing) continue;
      movingSecs += x.dt;
      if (!(x.fuel >= 0)) continue;
      coveredSecs += x.dt;
      measured += x.fuel;
      modeled += stepFuel(fit, mass, cda, v[x.i], v[x.i + 1], x.dt, x.grade);
    }
    if (!movingSecs || coveredSecs / movingSecs < minCoverage || !(modeled > 0) || !(measured > 0)) return null;
    const scale = measured / modeled;
    let moving0 = 0;
    for (const x of segs) if (x.ok && !x.standing) moving0 += x.fuel >= 0 ? x.fuel : stepFuel(fit, mass, cda, v[x.i], v[x.i + 1], x.dt, x.grade) * scale;
    const richG = Math.min(moving0 * 0.5, Math.max(0, richGal) * Engine.FUEL_G_PER_L * Engine.L_PER_GAL);
    const lean = scale * (1 - richG / moving0); // the fit with no running rich

    // One speed profile (u at every fix) as gas (g) and seconds, with lost time taken off the next wait.
    function run(u, { engineOff = false } = {}) {
      let g = 0, secs = 0, lost = 0;
      for (let s = 0; s < segs.length; s++) {
        const x = segs[s];
        if (!x.ok) { lost = 0; continue; }
        if (x.standing) {
          const st = x.stop;
          if (s !== st.s0) continue;
          const cut = st.mid ? Math.min(lost, st.dur) : 0;
          const on = Math.max(0, st.gSecs - cut);
          g += st.rate * (engineOff && on >= LONG_IDLE_S ? RESTART_S : on);
          secs += st.dur - cut;
          lost = 0;
          continue;
        }
        const a = u[x.i], b = u[x.i + 1];
        const dt = a + b > 0.5 ? (2 * x.ds) / (a + b) : x.dt;
        lost += dt - x.dt;
        secs += dt;
        g += stepFuel(fit, mass, cda, a, b, dt, x.grade) * lean;
      }
      return { g, secs };
    }

    const actualSecs = segs.reduce((t, x) => t + (x.ok ? x.dt : 0), 0);
    const stopG = stops.reduce((t, st) => t + st.g, 0);
    const cruise = cruiseMph(fit, mass, cda, lean, price, timePerHour);
    const cap = cruise.mph * MPS_PER_MPH;

    // The capped profile, then the same smoothed: speeding up and slowing down within ACCEL and DECEL.
    const capped = v.map((x) => (x == null ? 0 : Math.min(x, cap)));
    const smooth = capped.slice();
    for (const x of segs) if (x.ok) smooth[x.i + 1] = Math.min(smooth[x.i + 1], Math.sqrt(smooth[x.i] ** 2 + 2 * ACCEL * x.ds));
    for (let s = segs.length - 1; s >= 0; s--) {
      const x = segs[s];
      if (x.ok) smooth[x.i] = Math.min(smooth[x.i], Math.sqrt(smooth[x.i + 1] ** 2 + 2 * DECEL * x.ds));
    }

    const steps = [
      { key: "actual", g: moving0 + stopG, secs: actualSecs },
      { key: "rich", g: moving0 - richG + stopG, secs: actualSecs },
      // The fit on the actual profile reproduces moving0 − richG exactly (that's what `lean` is), so
      // this step changes only the standstills.
      { key: "idle", ...run(v.map((x) => x ?? 0), { engineOff: true }) },
      { key: "speed", ...run(capped, { engineOff: true }) },
      { key: "smooth", ...run(smooth, { engineOff: true }) },
    ];

    // For the lines' explanations: time spent above the cruising speed, and the long idles.
    let aboveSecs = 0, top = 0;
    for (const x of segs) if (x.ok && !x.standing) { top = Math.max(top, v[x.i]); if ((v[x.i] + v[x.i + 1]) / 2 > cap) aboveSecs += x.dt; }
    const long = stops.filter((st) => st.gSecs >= LONG_IDLE_S);
    const stats = { aboveMin: aboveSecs / 60, topMph: top / MPS_PER_MPH, idleCount: long.length, idleSecs: long.reduce((t, st) => t + st.gSecs, 0) };

    const per = (g, secs) => (price != null ? gGal(g) * price + (secs / 3600) * timePerHour : null);
    const lines = [];
    for (let k = 1; k < steps.length; k++) {
      const gas = gGal(steps[k - 1].g - steps[k].g), secs = steps[k - 1].secs - steps[k].secs;
      lines.push({ key: steps[k].key, gal: gas, secs, cost: price != null ? gas * price + (secs / 3600) * timePerHour : null });
    }
    const actual = { gal: gGal(steps[0].g), secs: steps[0].secs, cost: per(steps[0].g, steps[0].secs) };
    const ideal = { gal: gGal(steps.at(-1).g), secs: steps.at(-1).secs, cost: per(steps.at(-1).g, steps.at(-1).secs) };
    return {
      actual, ideal, lines,
      ratio: ideal.gal > 0 ? actual.gal / ideal.gal : null,
      allInRatio: actual.cost != null && ideal.cost > 0 ? actual.cost / ideal.cost : null,
      score: ideal.gal > 0 ? Math.min(100, Math.round((100 * ideal.gal) / actual.gal)) : null,
      cruiseMph: cruise.mph, cheapestMph: cruise.best, price, timePerHour, ...stats,
      speedProfile: smooth, fitScale: scale,
    };
  }

  return { plan, cruiseMph, ACCEL, DECEL };
})();
