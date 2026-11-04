// Engine data from the OBD adapter: one row per second, from each chunk's `engine` summary
// (phone-computed, engineFormat 1) or, for drives recorded before that, rebuilt from raw chunks.
// Fuel use is estimated here from airflow and the commanded air-fuel ratio unless the car reports it.

const Engine = (() => {
  const AFR = 14.08; // stoichiometric air-fuel ratio of E10 pump gas
  const FUEL_G_PER_L = 745;
  const L_PER_GAL = 3.78541;
  const KMH_TO_MPH = 0.621371;
  // For the braking estimate: energy in a gallon of E10, a typical engine's efficiency turning it into
  // motion, and what slows a coasting car (tire rolling resistance, air drag).
  const J_PER_GAL = 32.9 * 3.6e6;
  const ENGINE_EFF = 0.25;
  const CRR = 0.012, CDA = 0.68, AIR = 1.2; // CdA ≈ 0.30 × 2.25 m² for a compact sedan
  /** Rough loaded weight (car, driver, fuel) by vehicle name; braking waste scales with it. */
  const massKg = (vehicle = "") => (/civic/i.test(vehicle) ? 1360 : /truck|f-?150|silverado|ram|tundra|sierra/i.test(vehicle) ? 2600 : 1500);
  const galOf = (g) => g / FUEL_G_PER_L / L_PER_GAL;
  // EPA window-sticker ratings (fueleconomy.gov) for the cars Fuelish knows, to put a drive's mpg
  // in context. Matched on the vehicle name; anything else gets no comparison.
  const EPA = [
    [/2016.*civic.*2\.0/i, { city: 31, hwy: 41, comb: 35 }], // 2.0L CVT sedan
  ];
  const epa = (vehicle = "") => EPA.find(([re]) => re.test(vehicle))?.[1] ?? null;
  const HIGHWAY_MPH = 45;

  // Row: { t: wall ms, rpm, speed (km/h), pedal %, load %, maf g/s, lambda, coolant °C, ... ,
  //        fuelGs: fuel g/s (estimated), gph: gallons/hour, cut: true during fuel cut }
  const NAMES = {
    rpm: "rpm", speed: "speed", accel_pedal_d: "pedal", rel_throttle: "relThrottle", throttle: "throttle",
    engine_load: "load", abs_load: "absLoad", maf: "maf", map: "map", commanded_lambda: "lambda",
    fuel_rate: "fuelRateLph", fuel_sys1: "fuelSys", stft_b1: "stft", ltft_b1: "ltft", timing_advance: "timing",
    coolant_temp: "coolant", iat: "iat", fuel_level: "fuelLevel", module_voltage: "volts", dtc_count: "dtcs", mil_on: "mil",
    // Computed on the phone per airflow sample (see EngineSummary): fuel g/s and the share of the second in fuel cut.
    fuel_est_gs: "fuelEstGs", fuel_cut: "cutFrac",
  };
  // Status values: the last reading counts, never an average.
  const LAST = new Set(["mil", "dtcs", "fuelSys"]);

  /** True when any chunk has engine data, summarized or only raw. */
  const recorded = (chunks) => chunks.some((c) => hasSummary(c) || hasRawObd(c));
  // A summary is used only when it's really there: a phone trimming an oversized sidecar used to
  // drop the rows but leave engineFormat behind.
  const hasSummary = (c) => c.meta.engineFormat === 1 && Array.isArray(c.meta.engine) && Array.isArray(c.meta.engineCols);
  // Recovered chunks from before late 2026 list no streams at all, so they may hold anything.
  const hasRawObd = (c) => (c.meta.recovered && !c.meta.streams) ||
    Object.keys(c.meta.streams || {}).some((k) => k.startsWith("obd:") && k !== "obd:adapter_v");
  /** Chunks whose engine data is only in the raw file. */
  const rawOnly = (chunks) => chunks.filter((c) => !hasSummary(c) && hasRawObd(c));

  /** Engine rows from two sources (summaries and a raw rebuild of other chunks), in time order, one per second. */
  function merge(a, b) {
    if (!b?.length) return a;
    if (!a?.length) return b;
    const out = [...a, ...b].sort((x, y) => x.t - y.t);
    return out.filter((r, i) => i === 0 || r.t !== out[i - 1].t);
  }

  function fromChunks(chunks) {
    const rows = [];
    for (const c of chunks) {
      if (!hasSummary(c)) continue;
      const cols = c.meta.engineCols.map((f) => NAMES[f] || f);
      for (const r of c.meta.engine) {
        // A second split across two chunks comes as two rows with the same time: average them.
        const prev = rows.at(-1), dup = prev && prev.t === r[0];
        const row = dup ? prev : { t: r[0] };
        cols.forEach((k, i) => {
          const v = r[i + 1];
          if (v == null) return;
          row[k] = dup && row[k] != null && !LAST.has(k) ? (row[k] + v) / 2 : v;
        });
        if (!dup) rows.push(row);
      }
    }
    return rows;
  }

  // GPS fix times and the phone's own clock (OBD replies, motion sensors) don't quite agree: on the
  // Civic recordings the GPS track runs about 2 s ahead of the pedal, rpm and accelerometer, which
  // all agree with each other. Matched by timestamp, every engine value would land ~2 s (50 m at
  // highway speed) down the road from where it happened. The offset is found per drive by sliding
  // the car's speed against GPS speed, and engine rows are moved onto GPS time. Returns the shift in
  // ms (0 when the drive has too little moving data to tell, or no clear best).
  function align(rows, pts) {
    const todo = rows.filter((r) => r.shiftMs == null);
    if (!todo.length) return rows.shiftMs ?? 0;
    const gps = pts.filter((p) => p.v != null);
    const at = (t) => {
      let lo = 0, hi = gps.length - 1;
      if (hi < 1 || t < gps[0].t || t > gps[hi].t) return null;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (gps[m].t <= t) lo = m; else hi = m; }
      const a = gps[lo], b = gps[hi];
      if (b.t - a.t > 2500) return null;
      return b.t === a.t ? a.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
    };
    const moving = todo.filter((r) => r.speed != null && r.speed > 5);
    const err = (lag) => {
      let s = 0, n = 0;
      for (const r of moving) {
        const g = at(r.t - lag);
        if (g == null) continue;
        s += Math.abs(r.speed / 3.6 - g);
        n++;
      }
      return n >= 120 ? s / n : null;
    };
    let best = 0, bestErr = err(0);
    if (bestErr != null) {
      for (let lag = -1000; lag <= 4000; lag += 250) {
        const e = err(lag);
        if (e != null && e < bestErr) { best = lag; bestErr = e; }
      }
      // Only a clear improvement counts: noise alone can nudge the minimum a step either way.
      if (best !== 0 && !(bestErr < 0.85 * err(0))) best = 0;
    } else best = 0;
    for (const r of todo) { r.t -= best; r.shiftMs = best; }
    rows.shiftMs = best;
    return best;
  }

  // The car's speed sensor is often a few percent off (tire size and wear). Where GPS is good and
  // the car is moving, compare the two; if they disagree consistently, scale the car's speed to GPS.
  // Rows keep the car's own reading as `speedCar`. Returns the factor applied (1 when none).
  // Engine rows are first moved onto GPS time (see align).
  function calibrate(rows, pts) {
    if (!rows.length || !pts?.length || rows.calibrated != null) return rows.calibrated ?? 1;
    align(rows, pts);
    const ratios = [];
    let j = 0;
    for (const p of pts) {
      if (p.v == null || p.v < 7 || p.acc == null || p.acc > 10) continue;
      while (j + 1 < rows.length && rows[j + 1].t <= p.t + 500) j++;
      const r = rows[j];
      if (Math.abs(r.t - p.t) <= 600 && r.speed > 25) ratios.push((p.v * 3.6) / r.speed);
    }
    let k = 1;
    if (ratios.length >= 60) {
      ratios.sort((a, b) => a - b);
      const med = ratios[ratios.length >> 1];
      if (med > 0.9 && med < 1.1 && Math.abs(med - 1) > 0.003) k = med;
    }
    // A row already scaled (merged in from an earlier calibration) keeps its scaling.
    if (k !== 1) for (const r of rows) if (r.speed != null && r.speedCar == null) { r.speedCar = r.speed; r.speed *= k; }
    rows.calibrated = k;
    return k;
  }

  // Same per-second values as the phone, from the raw `obd` records of the engine ECU, including
  // the per-sample fuel estimate (airflow over the air-fuel target read within the last second).
  async function fromRaw(chunks, urls, onProgress, { ecu: knownEcu = null } = {}) {
    const bins = new Map(); // second -> { key: [sum, n, last] }
    let ecu = knownEcu, lambda = null, lambdaT = -Infinity;
    const add = (sec, key, v) => {
      const b = bins.get(sec) || bins.set(sec, {}).get(sec);
      const acc = b[key] || (b[key] = [0, 0, 0]);
      acc[0] += v;
      acc[1]++;
      acc[2] = v;
    };
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(i, chunks.length);
      // Older recovered chunks don't carry their clock mapping; their first record does.
      const m = { ...chunks[i].meta };
      const res = await fetch(urls[i]);
      if (!res.ok) throw new Error(`chunk ${m.seq}: HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('{"k":"chunk"') && (m.firstNs == null || m.wallStartMs == null)) {
            const h = JSON.parse(line);
            m.firstNs = h.rx;
            m.wallStartMs = h.wall;
          } else if (!knownEcu && line.startsWith('{"k":"obd_discovery"')) {
            const d = JSON.parse(line).d, ecus = Object.keys(d.supportedByEcu || {});
            ecu = d.mainEcu || ecus.find((e) => e === "7E8" || e === "18DAF110") ||
              ecus.sort((a, b) => d.supportedByEcu[b].length - d.supportedByEcu[a].length)[0] || null;
          } else if (line.startsWith('{"k":"obd",')) {
            const r = JSON.parse(line);
            const key = NAMES[r.f];
            if (!key || r.val == null || (ecu && r.ecu !== ecu) || m.firstNs == null) continue;
            const ms = m.wallStartMs + (r.rx - m.firstNs) / 1e6, sec = Math.floor(ms / 1000);
            add(sec, key, r.val);
            if (key === "lambda") { lambda = r.val; lambdaT = ms; }
            else if (key === "maf" && lambda > 0 && ms - lambdaT >= 0 && ms - lambdaT <= 1000) {
              const cut = lambda >= 1.99;
              add(sec, "fuelEstGs", cut ? 0 : r.val / (AFR * lambda));
              add(sec, "cutFrac", cut ? 1 : 0);
            }
          }
        }
        if (done) break;
      }
    }
    onProgress?.(chunks.length, chunks.length);
    return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([sec, b]) => {
      const row = { t: sec * 1000 + 500 };
      for (const [k, [s, n, last]] of Object.entries(b)) row[k] = LAST.has(k) ? last : Math.round((s / n) * 1000) / 1000;
      return row;
    });
  }

  // Fuel flow for each row. The car's own fuel rate if it reports one; otherwise the phone's
  // per-sample estimate (airflow over the commanded air-fuel ratio, sample by sample); for drives
  // from before that, the same from the second's averages. Either estimate is corrected by the fuel
  // trims (short-term within 3 s, long-term carried forward), capped at ±25%. Commanded lambda at its maximum (2.0) is
  // fuel cut: no fuel.
  // Values the car is polled for only every few seconds (they change slowly) carry forward up to
  // 12 s, so per-second charts and comparisons don't miss most seconds.
  const SLOW = ["coolant", "iat", "volts", "fuelLevel", "dtcs", "mil", "fuelSys", "ltft"];

  function derive(rows) {
    const last = {};
    for (const r of rows) {
      for (const k of SLOW) {
        if (r[k] != null) last[k] = [r[k], r.t];
        else if (last[k] && r.t - last[k][1] <= 12000) r[k] = last[k][0];
      }
    }
    let stft = null, stftT = -Infinity;
    for (const r of rows) {
      r.cut = r.cutFrac != null ? r.cutFrac >= 0.5 : r.lambda != null && r.lambda >= 1.99;
      // Fuel trims are the engine's own correction for an airflow sensor that reads off: positive
      // trims mean it's adding fuel beyond what the airflow implies, so the estimate scales with them.
      if (r.stft != null) { stft = r.stft; stftT = r.t; }
      const trims = (r.ltft ?? 0) + (stft != null && r.t - stftT <= 3000 ? stft : 0);
      r.trimK = Math.min(1.25, Math.max(0.75, 1 + trims / 100));
      if (r.fuelRateLph != null) r.fuelGs = (r.fuelRateLph * FUEL_G_PER_L) / 3600;
      else if (r.fuelEstGs != null) r.fuelGs = r.fuelEstGs * r.trimK;
      else if (r.maf != null) r.fuelGs = r.cut ? 0 : (r.maf * r.trimK) / (AFR * (r.lambda ?? 1));
      else r.fuelGs = null;
      r.gph = r.fuelGs != null ? (r.fuelGs * 3600) / FUEL_G_PER_L / L_PER_GAL : null;
    }
    return rows;
  }

  // Totals for a set of rows.
  //
  // Fuel and distance are only counted together: miles per gallon, the highway/town split, idling
  // and enrichment all use just the seconds that have both a speed and a fuel reading (`gal`,
  // `fuelMiles`). A second with only one of them adds to neither, so a dropout of either signal
  // can't skew mpg.
  //
  // Coverage is measured against the whole drive, not just the seconds the adapter was answering:
  // the share of the drive's miles (GPS `tripMiles`, or at least what the car's speed covered) that
  // have fuel readings; for a drive that barely moved, the share of its duration (`tripMs`, else
  // the rows' own span).
  // An adapter outage or a late start therefore lowers coverage instead of vanishing.
  // `galTrip` is the whole drive's fuel: `gal` plus the uncovered miles at this drive's own mpg
  // (`extrapolated` says whether any was added).
  //
  // `fuelSource`: "car" (the car reports fuel rate) or "airflow" (estimated from airflow and the
  // commanded air-fuel ratio). Neither is a receipt.
  //
  // Braking is reported apart, as a rough energy estimate in gallons-equivalent: it isn't measured
  // fuel, it assumes level road, and it can't tell the brakes from engine braking.
  function summary(rows, { vehicle = "", tripMiles = null, tripMs = null } = {}) {
    const mass = massKg(vehicle);
    let fuelG = 0, meters = 0, fuelMeters = 0, idleMs = 0, cutMs = 0, bothSecs = 0, idleG = 0, richG = 0, brakeJ = 0;
    // Highway (45 mph and up) vs town (everything slower, idling included): miles and fuel each.
    const split = { highway: { meters: 0, fuelG: 0 }, town: { meters: 0, fuelG: 0 } };
    // A second without a value (a stalled poll) uses the last one seen, up to 3 s old.
    let fuel = null, fuelT = -Infinity, speed = null, speedT = -Infinity;
    let maxRpm = 0, vLo = Infinity, vHi = -Infinity;
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i];
      if (b.rpm != null && b.rpm > maxRpm) maxRpm = b.rpm;
      if (b.volts != null) { if (b.volts < vLo) vLo = b.volts; if (b.volts > vHi) vHi = b.volts; }
      if (b.fuelGs != null) { fuel = b.fuelGs; fuelT = b.t; }
      if (b.speed != null) { speed = b.speed; speedT = b.t; }
      if (i === 0) continue;
      const a = rows[i - 1], dt = (b.t - a.t) / 1000;
      if (dt <= 0 || dt > 2.5) continue; // a gap (adapter dropped, engine off): don't integrate across it
      const fuelOk = fuel != null && b.t - fuelT <= 3000, speedOk = speed != null && b.t - speedT <= 3000;
      if (speedOk) meters += (speed / 3.6) * dt;
      if (fuelOk && speedOk) {
        fuelG += fuel * dt;
        fuelMeters += (speed / 3.6) * dt;
        bothSecs += dt;
        const g = speed * KMH_TO_MPH >= HIGHWAY_MPH ? split.highway : split.town;
        g.meters += (speed / 3.6) * dt;
        g.fuelG += fuel * dt;
        if (speed === 0 && b.rpm > 300) idleG += fuel * dt;
        if (b.fuelRateLph == null && b.maf != null && b.lambda != null && !b.cut && b.lambda < 0.99) {
          richG += ((b.maf * (b.trimK ?? 1)) / AFR) * (1 / b.lambda - 1) * dt;
        }
      }
      if (a.speed != null && b.speed != null) {
        const v0 = a.speed / 3.6, v1 = b.speed / 3.6, vm = (v0 + v1) / 2;
        const decel = (v0 - v1) / dt, coast = 9.81 * CRR + (0.5 * AIR * CDA * vm * vm) / mass;
        if (decel > coast) brakeJ += mass * (decel - coast) * vm * dt;
      }
      if (b.speed === 0 && b.rpm > 300) idleMs += dt * 1000;
      // The phone's fuel-cut share is fractional; older rows only say cut or not.
      cutMs += (b.cutFrac ?? (b.cut ? 1 : 0)) * dt * 1000;
    }
    let first = {}, last = {};
    for (const r of rows) for (const k of ["coolant", "fuelLevel", "dtcs", "mil"]) if (r[k] != null) { if (first[k] == null) first[k] = r[k]; last[k] = r[k]; }
    const gal = galOf(fuelG);
    const fuelMiles = fuelMeters / 1609.344;
    const part = (g) => {
      const mi = g.meters / 1609.344, gl = galOf(g.fuelG);
      return { miles: mi, gal: gl, mpg: gl > 0 ? mi / gl : null };
    };
    // Warm-up: from a cold start (below 60 °C) until the coolant first reaches 80 °C.
    let warmMs = null;
    if (first.coolant != null && first.coolant < 60) {
      const w = rows.find((r) => r.coolant != null && r.coolant >= 80);
      if (w) warmMs = w.t - rows[0].t;
    }
    const mpg = bothSecs && gal > 0 && fuelMiles > 0 ? fuelMiles / gal : null;
    // The drive's distance: GPS when known, never less than what the car's own speed shows.
    const totalMiles = Math.max(tripMiles > 0 ? tripMiles : 0, meters / 1609.344, fuelMiles) || null;
    const spanS = (tripMs ?? (rows.length > 1 ? rows.at(-1).t - rows[0].t : 0)) / 1000;
    // By distance when the drive moved and its GPS distance is known; else by time.
    const coverage = !bothSecs ? 0
      : totalMiles != null && totalMiles >= 0.2 ? Math.min(1, fuelMiles / totalMiles)
      : spanS > 0 ? Math.min(1, bothSecs / spanS) : 1;
    const missingMiles = totalMiles != null ? Math.max(0, totalMiles - fuelMiles) : 0;
    const extrapolated = mpg != null && missingMiles > 0.02 * (totalMiles || 1);
    return {
      gal: bothSecs ? gal : null,
      mpg,
      miles: totalMiles ?? meters / 1609.344,
      fuelMiles,
      coverage,
      galTrip: !bothSecs ? null : extrapolated ? gal + missingMiles / mpg : gal,
      extrapolated,
      fuelSource: rows.some((r) => r.fuelRateLph != null) ? "car" : "airflow",
      idleMs,
      cutMs,
      maxRpm,
      coolant: [first.coolant, last.coolant],
      volts: [vLo, vHi],
      fuelLevel: last.fuelLevel,
      dtcs: last.dtcs,
      mil: last.mil,
      fromCar: rows.some((r) => r.fuelRateLph != null),
      perSample: rows.some((r) => r.fuelEstGs != null),
      fuelUse: bothSecs ? { idle: galOf(idleG), rich: galOf(richG) } : null,
      brakingGalEq: brakeJ / J_PER_GAL / ENGINE_EFF,
      massKg: mass,
      speedFactor: rows.calibrated ?? 1,
      highway: part(split.highway),
      town: part(split.town),
      warmMs,
    };
  }

  /** A short label for where a fuel figure comes from. */
  const fuelLabel = (e) => `${e.fuelSource === "car" ? "car-reported" : "airflow estimate"}${e.coverage < 0.995 ? ` · ${Math.round(e.coverage * 100)}% of the drive` : ""}`;

  // Economy over a short window around each second (instant mpg jumps too much to color a map):
  // miles over gallons within ±3 s, capped at 99 (fuel cut while moving reads as 99).
  function smoothMpg(rows) {
    for (let i = 0; i < rows.length; i++) {
      let mi = 0, gal = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) {
        const r = rows[j];
        if (Math.abs(r.t - rows[i].t) > 3500 || r.speed == null || r.fuelGs == null) continue;
        mi += r.speed / 3.6 / 1609.344;
        gal += galOf(r.fuelGs);
      }
      rows[i].mpg = gal > 0 ? Math.min(99, mi / gal) : mi > 0 ? 99 : null;
    }
    return rows;
  }

  // Each GPS point gets the engine row for its second (within 1.5 s), as p.eng.
  function attach(pts, rows) {
    let j = 0;
    for (const p of pts) {
      while (j + 1 < rows.length && Math.abs(rows[j + 1].t - p.t) <= Math.abs(rows[j].t - p.t)) j++;
      p.eng = rows.length && Math.abs(rows[j].t - p.t) <= 1500 ? rows[j] : null;
    }
  }

  const cToF = (c) => (c * 9) / 5 + 32;
  const mph = (kmh) => kmh * KMH_TO_MPH;

  const physics = { J_PER_GAL, ENGINE_EFF, CRR, CDA, AIR, massKg };

  return { physics, align, fuelLabel, epa, recorded, rawOnly, hasSummary, merge, fromChunks, fromRaw, derive, calibrate, summary, smoothMpg, HIGHWAY_MPH, attach, cToF, mph, galOf, FUEL_G_PER_L, L_PER_GAL };
})();

// Average regular gas price for a trip's week and region (U.S. EIA weekly survey, via /api/v1/gas-prices).
const Gas = (() => {
  let data = null;
  const load = () => (data ||= fetch("/api/v1/gas-prices").then((r) => (r.ok ? r.json() : null)).catch(() => null));

  // EIA's five regions (PADDs), roughly by where a trip starts. Outside the lower 48: the U.S. average.
  function region(lat, lon) {
    if (lat == null || lon == null || lat < 24 || lat > 50 || lon < -125 || lon > -66) return "us";
    if (lon < -114 || (lon < -109 && lat < 37)) return "west";
    if (lon < -102 && lat >= 37) return "rockies";
    if (lat < 33.5 && lon < -85 && lon > -107) return "gulf";
    if (lat < 36.5 && lon < -89.5 && lon > -94.5) return "gulf"; // Arkansas, Louisiana, Mississippi
    if (lon > -80.5 || (lon > -85 && lat < 34.5)) return "east";
    return "midwest";
  }

  /** { price, weekMs, regionName } for the week a trip started, or null when prices aren't available. */
  async function forTrip(lat, lon, ms) {
    const d = await load();
    const r = d?.regions[region(lat, lon)] || d?.regions.us;
    if (!r?.weeks.length) return null;
    let w = r.weeks[0];
    for (const x of r.weeks) if (x[0] <= ms) w = x;
    return { price: w[1], weekMs: w[0], regionName: r.name };
  }

  return { forTrip, region };
})();
