// Outings: trips taken as one on the trips page, with one card and one page that lists each trip.
//
// Two ways trips join up, both only for the same phone:
//   - Back to back: the next trip starts within GAP_MS of the last one ending, within NEAR_M of where
//     it ended (errands, a fuel stop, the phone reconnecting).
//   - A round trip: trips that go out and come back to where they started, on the same day, however
//     long you stayed (Home → Grandma's → Home). Each trip has to start where the one before it
//     ended, and the outing closes the first time you're back, so two separate errands from home
//     stay two outings. A trip that never moved (the phone starting in the driveway) doesn't break
//     the chain. If you don't get back that day, the trips stay apart.

const Outings = (() => {
  const GAP_MS = 30 * 60000;
  const NEAR_M = 500;
  const MOVED_M = 100;

  const endOf = (r) => r.driveEndWallMs ?? r.endedWallMs ?? r.updatedAtMs;
  const near = (a, b) => Route.haversine(a[0], a[1], b[0], b[1]) <= NEAR_M;
  const recording = (o) => o.some((r) => r.status === "recording");
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  function linked(a, b) {
    if (a.status === "recording") return false;
    if (b.startedWallMs - endOf(a) > GAP_MS) return false;
    const end = a.trip?.path?.at(-1), start = b.trip?.path?.[0];
    return !end || !start || near(end, start);
  }

  // Where a run of trips set off from and finished, by the ones that moved; null if none did.
  function ends(o) {
    const legs = o.filter((r) => r.trip?.path?.length && r.trip.meters >= MOVED_M);
    return legs.length ? { start: legs[0].trip.path[0], end: legs.at(-1).trip.path.at(-1) } : null;
  }

  // Joins one phone's back-to-back runs (oldest first) into round trips.
  function roundTrips(runs) {
    const out = [];
    for (let i = 0; i < runs.length; ) {
      const home = ends(runs[i]);
      let close = -1;
      if (home && !recording(runs[i]) && !near(home.start, home.end)) {
        let at = home.end;
        for (let j = i + 1; j < runs.length; j++) {
          const r = runs[j], e = ends(r);
          if (!sameDay(runs[i][0].startedWallMs, r[0].startedWallMs)) break;
          if (!e) { if (recording(r)) break; continue; }
          if (!near(at, e.start)) break;
          if (near(e.end, home.start)) { close = j; break; }
          if (recording(r)) break;
          at = e.end;
        }
      }
      if (close < 0) { out.push(runs[i]); i++; }
      else { out.push(runs.slice(i, close + 1).flat()); i = close + 1; }
    }
    return out;
  }

  /** Recordings grouped into outings, oldest first, each oldest first. */
  function group(recordings) {
    const asc = [...recordings].sort((a, b) => a.startedWallMs - b.startedWallMs);
    const byDevice = new Map(); // device -> its runs of back-to-back trips
    for (const r of asc) {
      const runs = byDevice.get(r.deviceId) || byDevice.set(r.deviceId, []).get(r.deviceId);
      const cur = runs.at(-1);
      if (cur && linked(cur.at(-1), r)) cur.push(r);
      else runs.push([r]);
    }
    return [...byDevice.values()].flatMap(roundTrips).sort((a, b) => a[0].startedWallMs - b[0].startedWallMs);
  }

  /** Time spent between the trips of an outing (parked, or in a shop). */
  const parkedMs = (o) => o.slice(1).reduce((n, r, i) => n + Math.max(0, r.startedWallMs - endOf(o[i])), 0);

  return { group, parkedMs, GAP_MS, NEAR_M };
})();
