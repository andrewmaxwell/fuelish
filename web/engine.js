// Engine data from the OBD adapter: one row per second, from each chunk's `engine` summary
// (phone-computed, engineFormat 1) or, for drives recorded before that, rebuilt from raw chunks.
// Fuel use is estimated here from airflow and the commanded air-fuel ratio unless the car reports it.

const Engine = (() => {
  const AFR = 14.08; // stoichiometric air-fuel ratio of E10 pump gas
  const FUEL_G_PER_L = 745;
  const L_PER_GAL = 3.78541;
  const KMH_TO_MPH = 0.621371;

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
  function derive(rows) {
    for (const r of rows) {
      r.cut = r.lambda != null && r.lambda >= 1.99;
      if (r.fuelRateLph != null) r.fuelGs = (r.fuelRateLph * FUEL_G_PER_L) / 3600;
      else if (r.maf != null) r.fuelGs = r.cut ? 0 : r.maf / (AFR * (r.lambda ?? 1));
      else r.fuelGs = null;
      r.gph = r.fuelGs != null ? (r.fuelGs * 3600) / FUEL_G_PER_L / L_PER_GAL : null;
    }
    return rows;
  }

  function summary(rows) {
    let fuelG = 0, meters = 0, idleMs = 0, cutMs = 0, fuelSecs = 0;
    // A second without a value (a stalled poll) uses the last one seen, up to 3 s old.
    let fuel = null, fuelT = -Infinity, speed = null, speedT = -Infinity;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i], dt = (b.t - a.t) / 1000;
      if (b.fuelGs != null) { fuel = b.fuelGs; fuelT = b.t; }
      if (b.speed != null) { speed = b.speed; speedT = b.t; }
      if (dt > 2.5) continue; // a gap (adapter dropped, engine off): don't integrate across it
      if (fuel != null && b.t - fuelT <= 3000) { fuelG += fuel * dt; fuelSecs += dt; }
      if (speed != null && b.t - speedT <= 3000) meters += (speed / 3.6) * dt;
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
