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

  // Row: { t: wall ms, rpm, speed (km/h), pedal %, load %, maf g/s, lambda, coolant °C, ... ,
  //        fuelGs: fuel g/s (estimated), gph: gallons/hour, cut: true during fuel cut }
  const NAMES = {
    rpm: "rpm", speed: "speed", accel_pedal_d: "pedal", rel_throttle: "relThrottle", throttle: "throttle",
    engine_load: "load", abs_load: "absLoad", maf: "maf", map: "map", commanded_lambda: "lambda",
    fuel_rate: "fuelRateLph", fuel_sys1: "fuelSys", stft_b1: "stft", ltft_b1: "ltft", timing_advance: "timing",
    coolant_temp: "coolant", iat: "iat", fuel_level: "fuelLevel", module_voltage: "volts", dtc_count: "dtcs", mil_on: "mil",
  };

  /** True when any chunk has engine data, summarized or only raw. */
  const recorded = (chunks) => chunks.some((c) => c.meta.engineFormat === 1 || hasRawObd(c));
  const hasRawObd = (c) => Object.keys(c.meta.streams || {}).some((k) => k.startsWith("obd:") && k !== "obd:adapter_v");
  /** Chunks whose engine data is only in the raw file. */
  const rawOnly = (chunks) => chunks.filter((c) => c.meta.engineFormat !== 1 && hasRawObd(c));

  function fromChunks(chunks) {
    const rows = [];
    for (const c of chunks) {
      if (c.meta.engineFormat !== 1) continue;
      const cols = c.meta.engineCols.map((f) => NAMES[f] || f);
      for (const r of c.meta.engine) {
        const row = { t: r[0] };
        cols.forEach((k, i) => { if (r[i + 1] != null) row[k] = r[i + 1]; });
        rows.push(row);
      }
    }
    return rows;
  }

  // Same per-second means as the phone, from the raw `obd` records of the engine ECU.
  async function fromRaw(chunks, urls, onProgress) {
    const bins = new Map(); // second -> { key: [sum, n] }
    let ecu = null;
    for (let i = 0; i < chunks.length; i++) {
      onProgress?.(i, chunks.length);
      const m = chunks[i].meta;
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
          if (line.startsWith('{"k":"obd_discovery"')) {
            const d = JSON.parse(line).d, ecus = Object.keys(d.supportedByEcu || {});
            ecu = d.mainEcu || ecus.find((e) => e === "7E8" || e === "18DAF110") ||
              ecus.sort((a, b) => d.supportedByEcu[b].length - d.supportedByEcu[a].length)[0] || null;
          } else if (line.startsWith('{"k":"obd",')) {
            const r = JSON.parse(line);
            const key = NAMES[r.f];
            if (!key || r.val == null || (ecu && r.ecu !== ecu)) continue;
            const sec = Math.floor((m.wallStartMs + (r.rx - m.firstNs) / 1e6) / 1000);
            const b = bins.get(sec) || bins.set(sec, {}).get(sec);
            const acc = b[key] || (b[key] = [0, 0]);
            acc[0] += r.val;
            acc[1]++;
          }
        }
        if (done) break;
      }
    }
    onProgress?.(chunks.length, chunks.length);
    return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([sec, b]) => {
      const row = { t: sec * 1000 + 500 };
      for (const [k, [s, n]] of Object.entries(b)) row[k] = Math.round((s / n) * 100) / 100;
      return row;
    });
  }

  // Fuel flow for each row. The car's own fuel rate if it reports one; otherwise airflow divided by
  // the air-fuel ratio it's commanding. Commanded lambda at its maximum (2.0) is fuel cut: no fuel.
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
    for (const r of rows) {
      r.cut = r.lambda != null && r.lambda >= 1.99;
      if (r.fuelRateLph != null) r.fuelGs = (r.fuelRateLph * FUEL_G_PER_L) / 3600;
      else if (r.maf != null) r.fuelGs = r.cut ? 0 : r.maf / (AFR * (r.lambda ?? 1));
      else r.fuelGs = null;
      r.gph = r.fuelGs != null ? (r.fuelGs * 3600) / FUEL_G_PER_L / L_PER_GAL : null;
    }
    return rows;
  }

  // Totals for a set of rows. Wasted fuel has three parts, each measured or estimated per second:
  // idling (fuel burned at 0 mph), braking (speed built up then braked away beyond what drag would
  // take anyway, as the fuel it took to build), and running rich (fuel beyond the ideal ratio).
  function summary(rows, { vehicle = "" } = {}) {
    const mass = massKg(vehicle);
    let fuelG = 0, meters = 0, idleMs = 0, cutMs = 0, fuelSecs = 0, idleG = 0, richG = 0, brakeJ = 0;
    // A second without a value (a stalled poll) uses the last one seen, up to 3 s old.
    let fuel = null, fuelT = -Infinity, speed = null, speedT = -Infinity;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i], dt = (b.t - a.t) / 1000;
      if (b.fuelGs != null) { fuel = b.fuelGs; fuelT = b.t; }
      if (b.speed != null) { speed = b.speed; speedT = b.t; }
      if (dt > 2.5) continue; // a gap (adapter dropped, engine off): don't integrate across it
      if (fuel != null && b.t - fuelT <= 3000) { fuelG += fuel * dt; fuelSecs += dt; }
      if (speed != null && b.t - speedT <= 3000) meters += (speed / 3.6) * dt;
      if (fuel != null && b.t - fuelT <= 3000 && b.speed === 0 && b.rpm > 300) idleG += fuel * dt;
      if (b.fuelRateLph == null && b.maf != null && b.lambda != null && !b.cut && b.lambda < 0.99) {
        richG += (b.maf / AFR) * (1 / b.lambda - 1) * dt;
      }
      if (a.speed != null && b.speed != null) {
        const v0 = a.speed / 3.6, v1 = b.speed / 3.6, vm = (v0 + v1) / 2;
        const decel = (v0 - v1) / dt, coast = 9.81 * CRR + (0.5 * AIR * CDA * vm * vm) / mass;
        if (decel > coast) brakeJ += mass * (decel - coast) * vm * dt;
      }
      if (b.speed === 0 && b.rpm > 300) idleMs += dt * 1000;
      if (b.cut) cutMs += dt * 1000;
    }
    const vals = (k) => rows.map((r) => r[k]).filter((v) => v != null);
    const first = (k) => vals(k)[0], last = (k) => vals(k).at(-1);
    const gal = fuelG / FUEL_G_PER_L / L_PER_GAL;
    const miles = meters / 1609.344;
    return {
      gal: fuelSecs ? gal : null,
      mpg: fuelSecs && gal > 0 ? miles / gal : null,
      miles,
      idleMs,
      cutMs,
      maxRpm: Math.max(0, ...vals("rpm")),
      coolant: [first("coolant"), last("coolant")],
      volts: [Math.min(...vals("volts")), Math.max(...vals("volts"))],
      fuelLevel: last("fuelLevel"),
      dtcs: last("dtcs"),
      mil: last("mil"),
      fromCar: rows.some((r) => r.fuelRateLph != null),
      waste: fuelSecs ? { idle: galOf(idleG), braking: brakeJ / J_PER_GAL / ENGINE_EFF, rich: galOf(richG) } : null,
      massKg: mass,
    };
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

  return { recorded, rawOnly, fromChunks, fromRaw, derive, summary, attach, cToF, mph };
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
