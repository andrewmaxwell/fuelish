// What would have made one drive cheaper, in gas and minutes, ranked by what it would have saved.
// Each item is something the driver controls: braking (anticipation), cruising speed, flooring it,
// idling. Nothing here is a bill: braking and speed are estimates, and each says how it's made.
//
// Input: GPS points (Route, with v and a), engine rows (Engine, aligned to GPS time, with speed km/h
// and fuelGs), the Engine.summary of those rows, and the vehicle name.

const Coach = (() => {
  const { J_PER_GAL, ENGINE_EFF, CRR, CDA, AIR, massKg } = Engine.physics;
  const G = 9.80665;
  const MPS_PER_MPH = 0.44704;
  const M_PER_MI = 1609.344;
  const galOf = Engine.galOf;

  // ---------- braking ----------

  // Stops and slow-downs from GPS speed: runs of seconds slowing faster than air and tires alone
  // would slow a coasting car. Each one's energy beyond coasting is turned into the gas it took to
  // build that speed (the same estimate as Engine.summary, on GPS so it can be placed on the map).
  // Returns { galEq, events: [{ i, peakI, fromMph, toMph, peakG, galEq }] } with events largest first.
  function braking(pts, vehicle = "") {
    const mass = massKg(vehicle);
    const events = [];
    let cur = null, calm = 0;
    const close = () => { if (cur && cur.j > 0) events.push(cur); cur = null; };
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1], q = pts[k], dt = (q.t - p.t) / 1000;
      if (q.trip !== p.trip || dt <= 0 || dt > 2.5 || p.v == null || q.v == null) { close(); continue; }
      const vm = (p.v + q.v) / 2, decel = (p.v - q.v) / dt;
      const coast = G * CRR + (0.5 * AIR * CDA * vm * vm) / mass;
      if (decel > coast) {
        if (!cur) cur = { i: k - 1, peakI: k, fromV: p.v, toV: q.v, peak: 0, j: 0 };
        cur.j += mass * (decel - coast) * vm * dt;
        cur.toV = q.v;
        const a = q.a != null ? -q.a : decel;
        if (a > cur.peak) { cur.peak = a; cur.peakI = k; }
        calm = 0;
      } else if (cur && ++calm >= 2) close(); // one easy second doesn't end a stop
    }
    close();
    const toGal = (j) => j / J_PER_GAL / ENGINE_EFF;
    const out = events
      .map((e) => ({ i: e.i, peakI: e.peakI, fromMph: e.fromV / MPS_PER_MPH, toMph: e.toV / MPS_PER_MPH, peakG: e.peak / G, galEq: toGal(e.j) }))
      .filter((e) => e.fromMph - e.toMph >= 5)
      .sort((a, b) => b.galEq - a.galEq);
    return { galEq: out.reduce((s, e) => s + e.galEq, 0), events: out };
  }

  // ---------- cruising speed ----------

  // How fuel per mile grows with speed, from this drive's own steady driving at highway speeds
  // (45 mph and up, where the choice is made): gal/mi = a + b·v² (v in m/s) fitted over 5 mph bins.
  // Slower steady seconds are mostly coasting into town and would bend the fit. Air drag is what grows with v², so b is the part that a
  // slower speed saves. Too little steady driving, or a fit that says faster is free (hills and
  // wind can do that on one drive), falls back to the drag physics with a 33% efficient engine at
  // highway load. Returns { b, source: "drive" | "physics" }.
  function speedCurve(rows) {
    const bins = new Map();
    for (let i = 2; i < rows.length - 2; i++) {
      const r = rows[i], a = rows[i - 2], c = rows[i + 2];
      if (r.speed == null || r.fuelGs == null || a.speed == null || c.speed == null) continue;
      if (c.t - a.t > 4500 || Math.abs(c.speed - a.speed) > 3) continue; // steady: within 3 km/h over 4 s
      const mph = r.speed * 0.621371;
      if (mph < 45) continue;
      const k = Math.floor(mph / 5);
      const b = bins.get(k) || bins.set(k, { secs: 0, mi: 0, gal: 0, v2: 0 }).get(k);
      const v = r.speed / 3.6;
      b.secs++; b.mi += v / M_PER_MI; b.gal += galOf(r.fuelGs); b.v2 += v * v;
    }
    const pts = [...bins.values()].filter((b) => b.secs >= 30).map((b) => ({ x: b.v2 / b.secs, y: b.gal / b.mi, w: b.secs }));
    const physics = { b: (0.5 * AIR * CDA * M_PER_MI) / (J_PER_GAL * 0.33), source: "physics" };
    if (pts.length < 3) return physics;
    const span = Math.sqrt(Math.max(...pts.map((p) => p.x))) - Math.sqrt(Math.min(...pts.map((p) => p.x)));
    if (span < 15 * MPS_PER_MPH) return physics;
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const { x, y, w } of pts) { sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; }
    const den = sw * sxx - sx * sx;
    const b = den > 0 ? (sw * sxy - sx * sy) / den : 0;
    return b > 0 ? { b, source: "drive" } : physics;
  }

  // Every second above `targetMph`, driven at the target instead: the gas saved and the minutes
  // added for the same miles. Returns null when the drive never went faster than the target.
  function slowerCruise(rows, targetMph, curve = speedCurve(rows)) {
    const T = targetMph * MPS_PER_MPH;
    let gal = 0, secs = 0, above = 0, top = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], r = rows[i], dt = (r.t - a.t) / 1000;
      if (dt <= 0 || dt > 2.5 || r.speed == null) continue;
      const v = r.speed / 3.6;
      if (v > top) top = v;
      if (v <= T) continue;
      const m = v * dt;
      gal += (m / M_PER_MI) * curve.b * (v * v - T * T);
      secs += m / T - dt;
      above += dt;
    }
    if (!above) return null;
    return { targetMph, gal, minutes: secs / 60, aboveMin: above / 60, topMph: top / MPS_PER_MPH, source: curve.source };
  }

  // ---------- the card ----------

  // Items worth showing, largest saving first. `price` ($/gal) may be null: amounts are then in gallons.
  function items({ pts, rows, e, vehicle = "", price = null, targetMph = 65 }) {
    const out = [];
    const worth = (gal) => (price != null ? gal * price >= 0.03 : gal >= 0.008);
    const br = braking(pts, vehicle);
    if (br.events.length && worth(br.galEq)) {
      out.push({ key: "braking", gal: br.galEq, events: br.events.slice(0, 3), count: br.events.length });
    }
    if (rows?.length) {
      // Whether it's worth a line is judged at the slowest choice (60), so picking a faster one
      // shows a smaller saving instead of hiding the item and its speed choices with it.
      const curve = speedCurve(rows);
      const floor = slowerCruise(rows, 60, curve);
      if (floor && floor.aboveMin >= 1 && worth(floor.gal)) {
        const sp = (targetMph < floor.topMph && slowerCruise(rows, targetMph, curve)) || floor;
        out.push({ key: "speed", gal: sp.gal, ...sp, curve });
      }
    }
    if (e?.fuelUse) {
      if (worth(e.fuelUse.rich)) out.push({ key: "rich", gal: e.fuelUse.rich });
      if (worth(e.fuelUse.idle) && e.idleMs >= 60000) out.push({ key: "idle", gal: e.fuelUse.idle, idleMs: e.idleMs });
    }
    return out.sort((a, b) => b.gal - a.gal);
  }

  return { braking, speedCurve, slowerCruise, items };
})();
