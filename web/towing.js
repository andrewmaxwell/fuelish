// Towing, told apart without anyone having to say so. Pulling a camper, a truck burns far more fuel
// at any given speed than it does on its own (half again to double), much more than wind, hills or
// the air conditioner change. So each trip's fuel is compared with what the same vehicle usually
// burns in the same kind of driving.
//
// Input is each trip's fuel profile from the server (fuelprofile.ts): seconds and grams of fuel per
// bin of speed and acceleration. A trip's ratio is its fuel over the fuel the vehicle's baseline
// would burn in the same seconds of the same bins. The baseline is the vehicle's ordinary trips:
// it starts from the trips that burned least (so a vehicle that mostly tows still finds its
// unloaded trips), and is refined a few times, each trip judged against the others (never itself).
// A trip is towing when it burned TOWING_RATIO times the baseline or more.
//
// It can't tell when there's nothing to compare with (a vehicle's only trip, or one that always
// tows), and short trips are too noisy to judge on their own: those take the answer from a trip
// that ended just before them (a fuel stop on the way) or are counted as not towing. Anyone can
// correct a trip on its page; corrections are saved (prefs "towing": { id: true | false }).

const Towing = (() => {
  const MIN_SECS = 300; // comparable driving a trip needs to be judged (5 minutes)
  const MIN_BASE_SECS = 20; // a bin counts once the other trips have this much of it
  const SEED_RATIO = 1.25; // the starting baseline: trips within this of the lowest ones
  const TOWING_RATIO = 1.35;
  const STOP_GAP_MS = 30 * 60 * 1000; // a short trip this soon after a towing one is still towing

  const vehicleKey = (r) => (r.meta?.vehicle || "").trim().toLowerCase() || `phone:${r.deviceId}`;
  const usable = (r) => r.fuelProfile?.v === 1 && r.fuelProfile.b && r.status !== "recording";

  function pool(trips) {
    const b = new Map();
    for (const t of trips) {
      for (const [k, [s, g]] of Object.entries(t.fuelProfile.b)) {
        const x = b.get(k) || b.set(k, [0, 0]).get(k);
        x[0] += s; x[1] += g;
      }
    }
    return b;
  }

  // `inBase`: the trip is part of `base`, so take its own seconds out before comparing.
  function ratio(t, base, inBase) {
    let used = 0, total = 0, actual = 0, expected = 0;
    for (const [k, [s, g]] of Object.entries(t.fuelProfile.b)) {
      total += s;
      const p = base.get(k);
      if (!p) continue;
      const bs = p[0] - (inBase ? s : 0), bg = p[1] - (inBase ? g : 0);
      if (bs < MIN_BASE_SECS || bg <= 0) continue;
      expected += (s * bg) / bs;
      actual += g;
      used += s;
    }
    return used >= MIN_SECS && used >= 0.5 * total && expected > 0 ? actual / expected : null;
  }

  /** Map of recording id -> { towing: true | false | null (can't tell), ratio }. */
  function detect(recs) {
    const out = new Map();
    const groups = new Map();
    for (const r of recs) if (usable(r)) (groups.get(vehicleKey(r)) || groups.set(vehicleKey(r), []).get(vehicleKey(r))).push(r);
    for (const trips of groups.values()) {
      if (trips.length < 2) continue;
      // Against every trip at once: just to find the lowest ones to start from.
      const all = pool(trips);
      const first = trips.map((t) => [t, ratio(t, all, true)]).filter(([, x]) => x != null);
      if (first.length < 2) continue;
      const sorted = first.map(([, x]) => x).sort((a, b) => a - b);
      const low = sorted[Math.floor(0.2 * (sorted.length - 1))];
      let base = new Set(first.filter(([, x]) => x <= low * SEED_RATIO).map(([t]) => t));
      let ratios = new Map();
      for (let round = 0; round < 6 && base.size; round++) {
        const b = pool([...base]);
        ratios = new Map(trips.map((t) => [t, ratio(t, b, base.has(t))]));
        const next = new Set(trips.filter((t) => ratios.get(t) != null && ratios.get(t) < TOWING_RATIO));
        if (!next.size || (next.size === base.size && [...next].every((t) => base.has(t)))) break;
        base = next;
      }
      for (const t of trips) {
        const x = ratios.get(t);
        out.set(t.id, { towing: x == null ? null : x >= TOWING_RATIO, ratio: x });
      }
    }
    return out;
  }

  /**
   * Marks each recording: `towing` (true/false), `towingSource` ("you" for a correction, "detected",
   * "before" when it took the answer from the trip just before it, or null) and `towingRatio` (its
   * fuel against the vehicle's usual, when known).
   */
  function mark(recs, corrections = {}) {
    const found = detect(recs);
    const byTime = [...recs].sort((a, b) => a.startedWallMs - b.startedWallMs);
    let prev = new Map(); // vehicle -> last trip
    for (const r of byTime) {
      const d = found.get(r.id);
      const fix = corrections?.[r.id];
      r.towingRatio = d?.ratio ?? null;
      r.towingDetected = d?.towing ?? null;
      if (typeof fix === "boolean") { r.towing = fix; r.towingSource = "you"; }
      else if (d?.towing != null) { r.towing = d.towing; r.towingSource = "detected"; }
      else {
        const p = prev.get(vehicleKey(r));
        const end = p && (p.driveEndWallMs ?? p.endedWallMs ?? p.updatedAtMs);
        const follows = p?.towing && end != null && r.startedWallMs - end <= STOP_GAP_MS;
        r.towing = !!follows;
        r.towingSource = follows ? "before" : null;
      }
      prev.set(vehicleKey(r), r);
    }
    return recs;
  }

  return { detect, mark, ratio, vehicleKey, TOWING_RATIO };
})();
