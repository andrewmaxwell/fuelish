// Stops and slow-downs found in GPS speed, for the driving score's card (ideal.js has the score
// itself): the sharpest ones are buttons that show the stop on the map.

const Coach = (() => {
  const { J_PER_GAL, ENGINE_EFF, CRR, AIR, body } = Engine.physics;
  const G = 9.80665;
  const MPS_PER_MPH = 0.44704;

  // ---------- braking ----------

  // Stops and slow-downs from GPS speed: runs of seconds slowing faster than air and tires alone
  // would slow a coasting car. Each one's energy beyond coasting is turned into the gas it took to
  // build that speed (the same estimate as Engine.summary, on GPS so it can be placed on the map).
  // Returns { galEq, events: [{ i, peakI, fromMph, toMph, peakG, galEq }] } with events largest first.
  function braking(pts, vehicle = "", towing = false) {
    const { mass, cda } = body(vehicle, towing);
    const events = [];
    let cur = null, calm = 0;
    const close = () => { if (cur && cur.j > 0) events.push(cur); cur = null; };
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1], q = pts[k], dt = (q.t - p.t) / 1000;
      if (q.trip !== p.trip || dt <= 0 || dt > 2.5 || p.v == null || q.v == null) { close(); continue; }
      const vm = (p.v + q.v) / 2, decel = (p.v - q.v) / dt;
      const coast = G * CRR + (0.5 * AIR * cda * vm * vm) / mass;
      if (decel > coast) {
        if (!cur) cur = { i: k - 1, peakI: k, fromV: p.v, toV: q.v, peak: 0, j: 0 };
        cur.j += mass * (decel - coast) * vm * dt;
        cur.toV = q.v;
        cur.endI = k;
        const a = q.a != null ? -q.a : decel;
        if (a > cur.peak) { cur.peak = a; cur.peakI = k; }
        calm = 0;
      } else if (cur && ++calm >= 2) close(); // one easy second doesn't end a stop
    }
    close();
    const toGal = (j) => j / J_PER_GAL / ENGINE_EFF;
    const out = events
      .map((e) => ({ i: e.i, peakI: e.peakI, endI: e.endI, avgG: (e.fromV - e.toV) / Math.max(1, (pts[e.endI].t - pts[e.i].t) / 1000) / G, fromMph: e.fromV / MPS_PER_MPH, toMph: e.toV / MPS_PER_MPH, peakG: e.peak / G, galEq: toGal(e.j) }))
      .filter((e) => e.fromMph - e.toMph >= 5)
      .sort((a, b) => b.galEq - a.galEq);
    return { galEq: out.reduce((s, e) => s + e.galEq, 0), events: out };
  }

  return { braking };
})();
