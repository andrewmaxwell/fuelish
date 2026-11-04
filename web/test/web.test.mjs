// Checks for the browser modules (no build step, so they're loaded as plain scripts into a VM).
// Run: node --test web/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const dir = new URL("..", import.meta.url);
export function load(...files) {
  const ctx = vm.createContext({ console, fetch: async () => ({ ok: false }), setTimeout, Promise, Map, Set, Math, Date, JSON });
  for (const f of files) vm.runInContext(readFileSync(new URL(f, dir), "utf8") + "\n;globalThis.__last = 1;", ctx, { filename: f });
  // Top-level const declarations aren't properties of the context; expose them.
  return vm.runInContext("({ Route, Engine, extent, ...(typeof Costs !== 'undefined' ? { Costs } : {}), ...(typeof Repeats !== 'undefined' ? { Repeats } : {}), ...(typeof Cvt !== 'undefined' ? { Cvt } : {}), ...(typeof Coach !== 'undefined' ? { Coach } : {}) })", ctx);
}
const { Engine, Route, extent } = load("route.js", "engine.js");

// 100 s at 72 km/h, steady fuel 1.2 g/s.
const drive = (fuelUntil = Infinity) =>
  Array.from({ length: 101 }, (_, i) => ({ t: i * 1000, speed: 72, rpm: 1800, ...(i * 1000 <= fuelUntil ? { fuelGs: 1.2 } : {}) }));

test("mpg uses only miles that have fuel readings", () => {
  const full = Engine.summary(drive());
  const half = Engine.summary(drive(50000));
  assert.ok(Math.abs(full.mpg - half.mpg) / full.mpg < 0.05, `${full.mpg} vs ${half.mpg}`);
  assert.ok(half.coverage > 0.45 && half.coverage < 0.6);
  assert.ok(Math.abs(half.galTrip - full.gal) / full.gal < 0.05); // whole-drive gas estimated at the same mpg
  assert.equal(Math.round(half.miles * 1000), Math.round(full.miles * 1000));
});

test("a trimmed engine summary isn't trusted", () => {
  const chunks = [{ meta: { engineFormat: 1, streams: { "obd:rpm": { n: 5 } } } }];
  assert.deepEqual([...Engine.fromChunks(chunks)], []);
  assert.equal(Engine.rawOnly(chunks).length, 1);
});

test("a trimmed track falls back to raw for that chunk only", () => {
  const chunks = [
    { seq: 0, meta: { trackFormat: 2, track: [[1000, 38, -90, 5, 3], [2000, 38.0001, -90, 5, 3]] } },
    { seq: 1, meta: { trackFormat: 2, summaryOmitted: ["track"] } },
  ];
  assert.equal(Route.fromChunks(chunks).length, 2);
  assert.deepEqual(Route.rawChunks(chunks).map((c) => c.seq), [1]);
});

test("summarized and raw engine rows merge in time order without duplicates", () => {
  const m = Engine.merge([{ t: 500, rpm: 1 }, { t: 2500, rpm: 3 }], [{ t: 1500, rpm: 2 }, { t: 2500, rpm: 9 }]);
  assert.deepEqual([...m.map((r) => r.rpm)], [1, 2, 3]);
});

test("a long history doesn't overflow the call stack", () => {
  const rows = Array.from({ length: 200000 }, (_, i) => ({ t: i * 1000, speed: 50, rpm: 2000 + (i % 7), volts: 14, fuelGs: 1 }));
  const e = Engine.summary(rows);
  assert.equal(e.maxRpm, 2006);
  assert.deepEqual([...extent(rows, (r) => r.rpm)], [2000, 2006]);
});

test("parked GPS wander isn't distance", () => {
  const pts = Array.from({ length: 61 }, (_, i) => ({ t: i * 1000, lat: 38 + (i % 2) * 0.0001, lon: -90, v: 0, acc: 100 }));
  assert.equal(Route.summary(pts).miles, 0);
});

test("the phone's per-sample fuel estimate is used, and its fuel-cut share decides cut", () => {
  const [r] = Engine.derive([{ t: 0, maf: 14.08, lambda: 1.5, fuelEstGs: 0.5, cutFrac: 0.5 }]);
  assert.equal(r.fuelGs, 0.5);
  assert.equal(r.cut, true);
});

test("an airflow estimate is corrected by the fuel trims; a car-reported rate isn't", () => {
  const [a, b, c] = Engine.derive([
    { t: 0, maf: 14.08, lambda: 1, stft: 4, ltft: 6 },
    { t: 1000, fuelEstGs: 1, ltft: -40 }, // trims are capped at 25%
    { t: 2000, fuelRateLph: 3.6, stft: 10 },
  ]);
  assert.ok(Math.abs(a.fuelGs - 1.1) < 1e-9);
  assert.ok(Math.abs(b.fuelGs - 0.75) < 1e-9); // stft 4 from 1 s ago still applies: 1 - 40% + 4% → capped
  assert.ok(Math.abs(c.fuelGs - 0.745) < 1e-9);
});

test("braking is reported apart from measured fuel", () => {
  const rows = [{ t: 0, speed: 100, fuelGs: 0.01 }, { t: 1000, speed: 0, fuelGs: 0.01 }];
  const e = Engine.summary(rows);
  assert.ok(e.brakingGalEq > e.gal); // big hard stop with almost no fuel: it can be, so it's not a share of fuel
  assert.equal(e.fuelUse.idle + e.fuelUse.rich <= e.gal, true);
});

const all = load("route.js", "engine.js", "costs.js", "repeats.js", "plot.js", "cvt.js");

test("trip cost adds up its parts and leaves out what's unknown", () => {
  const c = all.Costs.trip({ minutes: 30, miles: 10, gal: 0.3, price: 4 });
  const sum = c.items.reduce((n, i) => n + (i.amount ?? 0), 0);
  assert.ok(Math.abs(c.total - sum) < 1e-9);
  assert.ok(Math.abs(c.items.find((i) => i.key === "fuel").amount - 1.2) < 1e-9);
  assert.ok(Math.abs(c.items.find((i) => i.key === "time").amount - 10) < 1e-9); // half an hour at $20/h
  const none = all.Costs.trip({ minutes: 30, miles: 10, gal: null, price: 4 });
  assert.equal(none.fuelKnown, false);
  const guessed = all.Costs.trip({ minutes: 30, miles: 10, gal: null, price: 4, mpgGuess: 40 });
  assert.equal(guessed.estimated, true);
});

test("the cheapest steady speed moves up when time is worth more", () => {
  const gpm = (mph) => 1 / (45 - Math.abs(mph - 45) * 0.6); // best mpg at 45
  const best = (s) => [...Array(60).keys()].map((i) => i + 15).reduce((a, v) => (all.Costs.perMileAt(v, gpm(v), 4, s).total < all.Costs.perMileAt(a, gpm(a), 4, s).total ? v : a));
  const s0 = { ...all.Costs.DEFAULTS, timePerHour: 0 }, s1 = { ...all.Costs.DEFAULTS, timePerHour: 30 };
  assert.equal(best(s0), 45);
  assert.ok(best(s1) > 45);
});

const path = (lat0, lon0, lat1, lon1, via = 0) => Array.from({ length: 20 }, (_, i) => {
  const f = i / 19;
  return [lat0 + (lat1 - lat0) * f + via * Math.sin(f * Math.PI), lon0 + (lon1 - lon0) * f];
});
const rec = (id, t, p) => ({ id, deviceId: "d", status: "stopped", startedWallMs: t, driveEndWallMs: t + 900000, meta: {}, trip: { meters: 8000, movingMs: 800000, path: p } });

test("repeated trips group by places, and split different roads into routes", () => {
  const home = [38.6, -90.3], work = [38.65, -90.2];
  const recs = [
    rec("a", 1, path(...home, ...work)),
    rec("b", 2, path(home[0] + 0.0005, home[1], ...work)), // parked ~50 m away: same place
    rec("c", 3, path(...home, ...work, 0.02)), // a detour ~2 km off: another route
    rec("d", 4, path(...work, ...home)), // the other direction: another journey
  ];
  const { journeys } = all.Repeats.journeys(recs, [{ lat: home[0], lon: home[1], name: "Home" }]);
  assert.equal(journeys.length, 1);
  const j = journeys[0];
  assert.equal(j.from.name, "Home");
  assert.deepEqual([...j.trips.map((r) => r.id)], ["a", "b", "c"]);
  assert.equal(j.routes.length, 2);
  assert.deepEqual([...j.routes[0].trips.map((r) => r.id)], ["a", "b"]);
  assert.equal(all.Repeats.journeyOf(journeys, "c"), j);
});

test("leaderboard rows rank by gas and estimate gas for trips without engine data", () => {
  const home = [38.6, -90.3], work = [38.65, -90.2];
  const recs = [rec("a", 1, path(...home, ...work)), rec("b", 2, path(...home, ...work)), rec("c", 3, path(...home, ...work))];
  const { journeys } = all.Repeats.journeys(recs);
  const e = (gal) => ({ e: { miles: 5, gal, galTrip: gal, mpg: 5 / gal, coverage: 1, coolant: [85, 90] }, gas: { price: 4 } });
  const rows = all.Repeats.score(journeys[0], new Map([["a", e(0.2)], ["b", e(0.15)]]), (r) => r.driveEndWallMs);
  assert.equal(rows.find((x) => x.r.id === "c").estimated, true);
  assert.equal(rows.find((x) => x.r.id === "b").gal, 0.15);
});

test("cvt: pedal presses are found and measured from a steady pedal", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const pressed = i >= 10;
    rows.push({ t: i * 1000, speed: 50 + (pressed ? (i - 10) * 2 : 0), rpm: pressed ? Math.min(3500, 1500 + (i - 9) * 600) : 1500, pedal: pressed ? 50 : 25, coolant: 85 });
  }
  const trips = [{ r: { id: "x" }, rows }];
  const { rest } = all.Cvt.seconds(trips);
  const ev = all.Cvt.presses(trips, rest);
  assert.equal(ev.length, 1);
  assert.ok(Math.max(...ev[0].trace.map((p) => p.drpm)) >= 1900);
});

test("an adapter outage lowers coverage against the drive's GPS miles", () => {
  // 100 s at 72 km/h (1.24 mi), but no engine rows at all from 30 s to 92 s.
  const rows = drive().filter((r) => r.t < 30000 || r.t > 92000);
  const e = Engine.summary(rows, { tripMiles: 1.2427 });
  assert.ok(e.coverage < 0.45, `coverage ${e.coverage}`);
  assert.equal(e.extrapolated, true);
  const full = Engine.summary(drive());
  assert.ok(Math.abs(e.galTrip - full.gal) / full.gal < 0.08, `${e.galTrip} vs ${full.gal}`);
  assert.ok(Math.abs(e.mpg - full.mpg) / full.mpg < 0.05);
});

test("seconds with fuel but no speed don't drag mpg down", () => {
  const full = Engine.summary(drive());
  const rows = drive().map((r) => (r.t > 50000 ? { ...r, speed: null } : r));
  const e = Engine.summary(rows, { tripMiles: full.miles });
  assert.ok(Math.abs(e.mpg - full.mpg) / full.mpg < 0.05, `${e.mpg} vs ${full.mpg}`);
  assert.ok(e.coverage < 0.6);
});

test("extrapolated fuel is flagged as an estimate in the cost", () => {
  const c = all.Costs.trip({ minutes: 2, miles: 1.24, gal: 0.035, price: 4, extrapolated: true });
  assert.equal(c.estimated, true);
  assert.match(c.items[0].note, /extrapolated/);
});

test("a cold start without a comparable warm baseline is unknown, not zero", () => {
  const cold = { r: { id: "c" }, rows: Array.from({ length: 60 }, (_, i) => ({ t: i * 1000, coolant: i < 50 ? 20 + i : 85, speed: 40, rpm: 1500, fuelGs: 1 })) };
  const warmFew = { r: { id: "w" }, rows: [{ t: 0, coolant: 85, speed: 40, rpm: 1500, fuelGs: 0.8 }, { t: 1000, coolant: 85, speed: 40, rpm: 1500, fuelGs: 0.8 }] };
  const res = all.Costs.coldStarts([cold, warmFew]);
  assert.equal(res.length, 0);
  assert.equal(res.unmatched, 1);
});

test("unrelated loops from home aren't one leaderboard; a repeated loop is", () => {
  const home = [38.6, -90.3];
  const loop = (id, t, bend, far) => rec(id, t, Array.from({ length: 20 }, (_, i) => {
    const f = Math.sin((i / 19) * Math.PI);
    return [home[0] + far * f, home[1] + bend * f];
  }));
  const { journeys } = all.Repeats.journeys([loop("a", 1, 0.01, 0.01), loop("b", 2, -0.2, 0.3), loop("c", 3, 0.01, 0.01)]);
  assert.equal(journeys.length, 1);
  assert.deepEqual([...journeys[0].trips.map((r) => r.id)], ["a", "c"]);
  assert.equal(journeys[0].routes[0].n, "A");
});

test("cvt: a press is timed from the second that shows it", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const pressed = i >= 10;
    rows.push({ t: i * 1000, speed: 50 + (pressed ? (i - 10) * 2 : 0), rpm: pressed ? 2500 : 1500, pedal: pressed ? 50 : 25 });
  }
  const trips = [{ r: { id: "x" }, rows }];
  const ev = all.Cvt.presses(trips, all.Cvt.seconds(trips).rest);
  assert.equal(ev[0].t, 10000);
  assert.equal(ev[0].trace.find((p) => p.dt === 0).drpm, 1000);
  assert.equal(ev[0].trace.find((p) => p.dt === -1).drpm, 0);
});

// A drive that speeds up and slows down, as GPS points (m/s) and engine rows (km/h) shifted by `lagMs`.
function wavy(lagMs) {
  const v = (t) => 15 + 10 * Math.sin(t / 20000);
  const pts = Array.from({ length: 600 }, (_, i) => ({ t: i * 1000, lat: 38 + i * 1e-4, lon: -90, v: v(i * 1000), acc: 4, brg: 0 }));
  const rows = Array.from({ length: 600 }, (_, i) => ({ t: i * 1000 + 500, speed: v(i * 1000 + 500 - lagMs) * 3.6 }));
  return { pts, rows };
}

test("engine rows are moved onto GPS time by the measured lag", () => {
  const { Engine } = load("route.js", "engine.js");
  const { pts, rows } = wavy(2000);
  Engine.calibrate(rows, pts);
  assert.equal(rows.shiftMs, 2000);
  assert.equal(rows[0].t, -1500);
  const { pts: p2, rows: r2 } = wavy(0);
  Engine.calibrate(r2, p2);
  assert.equal(r2.shiftMs, 0);
});

test("merged rows aren't shifted or scaled twice", () => {
  const { Engine } = load("route.js", "engine.js");
  const { pts, rows } = wavy(2000);
  for (const r of rows) r.speed *= 0.98;
  Engine.calibrate(rows, pts);
  const t0 = rows[0].t, s0 = rows[0].speed;
  const merged = Engine.merge(rows.slice(0, 300), rows.slice(300));
  Engine.calibrate(merged, pts);
  assert.equal(merged[0].t, t0);
  assert.equal(merged[0].speed, s0);
});

test("a half-turn bearing flip at walking pace isn't a corner", () => {
  const { Route } = load("route.js", "engine.js");
  const pts = Route.fromChunks([{ meta: { trackFormat: 2, track: [
    [0, 38, -90, 1, 3, 39], [1000, 38.00001, -90, 2.2, 3, 39], [2000, 38.00003, -90, 4.5, 3, 215], [3000, 38.00008, -90, 6, 3, 214],
  ] } }]);
  assert.ok(pts.every((p) => p.side == null), JSON.stringify(pts.map((p) => p.side)));
});

test("coach: a hard stop from speed is the biggest braking event, and slower cruising saves gas but costs time", () => {
  const { Coach } = load("route.js", "engine.js", "coach.js");
  // 60 s at 25 m/s, a stop at 4 m/s² to 0, then 30 s stopped.
  const pts = [];
  let v = 25, t = 0;
  for (let i = 0; i < 60; i++) pts.push({ t: (t += 1000), v });
  while (v > 0) { v = Math.max(0, v - 4); pts.push({ t: (t += 1000), v }); }
  for (let i = 0; i < 30; i++) pts.push({ t: (t += 1000), v: 0 });
  const br = Coach.braking(pts, "2016 Honda Civic LX 2.0L");
  assert.equal(br.events.length, 1);
  assert.ok(br.events[0].fromMph > 50 && br.events[0].toMph < 1);
  // ½mv² = 425 kJ; / (118 MJ/gal × 25%) = 0.0144 gal, less a little for drag and rolling.
  assert.ok(br.galEq > 0.012 && br.galEq < 0.0145, String(br.galEq));

  const rows = Array.from({ length: 600 }, (_, i) => ({ t: i * 1000, speed: 120, fuelGs: 2 }));
  const sp = Coach.slowerCruise(rows, 65);
  assert.equal(sp.source, "physics"); // one steady speed can't show how fuel grows with speed
  assert.ok(sp.gal > 0 && sp.minutes > 0);
  assert.ok(Math.abs(sp.aboveMin - 599 / 60) < 0.01);
  assert.equal(Coach.slowerCruise(rows, 80), null);
});

test("cost view: a thirsty stretch reads above usual for its speed, coasting below", () => {
  const { Engine } = load("route.js", "engine.js");
  // 120 s at 96 km/h on 1.5 g/s, then 30 s at 3 g/s (a climb), then 30 s coasting with the fuel cut.
  const rows = Array.from({ length: 180 }, (_, i) => ({ t: i * 1000, speed: 96, fuelGs: i >= 120 && i < 150 ? 3 : i >= 150 ? 0 : 1.5 }));
  Engine.relCost(Engine.smoothMpg(rows));
  assert.ok(Math.abs(rows[50].rel - 1) < 0.15, String(rows[50].rel)); // the usual
  assert.ok(rows[135].rel > 1.6, String(rows[135].rel));
  assert.ok(rows[165].rel < 0.1, String(rows[165].rel));
  // A 5 s burst is averaged into its stretch instead of painting its own spot.
  const burst = Array.from({ length: 120 }, (_, i) => ({ t: i * 1000, speed: 96, fuelGs: i >= 60 && i < 65 ? 3 : 1.5 }));
  Engine.relCost(Engine.smoothMpg(burst));
  assert.ok(burst[62].rel < 1.3, String(burst[62].rel));
  const slow = [{ t: 0, speed: 2, fuelGs: 0.3 }, { t: 1000, speed: 2, fuelGs: 0.3 }];
  Engine.relCost(Engine.smoothMpg(slow));
  assert.equal(slow[1].rel, null);
});

test("minute marks fall where each minute ends, spaced by speed; gas marks by fuel used", () => {
  const { Route } = load("route.js", "engine.js");
  // 3 min heading east: the first at 10 m/s, then 30 m/s. One fix a second.
  const pts = [];
  let lon = -90;
  for (let i = 0; i <= 180; i++) {
    const v = i <= 60 ? 10 : 30;
    if (i) lon += v / (111320 * Math.cos((38 * Math.PI) / 180));
    pts.push({ t: i * 1000, lat: 38, lon, v, eng: { fuelGs: i <= 60 ? 1 : 3 } });
  }
  const m = Route.minuteMarks(pts);
  assert.equal(m.map((x) => x.n).join(), "1,2,3");
  const gap = (a, b) => Route.haversine(a.lat, a.lon, b.lat, b.lon);
  assert.ok(Math.abs(gap(pts[0], m[0]) - 600) < 3, String(gap(pts[0], m[0]))); // within the test's rough degrees-to-meters
  assert.ok(Math.abs(gap(m[0], m[1]) - 1800) < 5);
  assert.ok(Math.abs(m[0].brg - 90) < 1); // heading east, from the route itself
  // Gas: 60 g, then 360 g over two minutes: 420 g ≈ 0.149 gal ≈ $0.45 at $3: 5¢ marks, 8 of them.
  const g = Route.gasMarks(pts, 3);
  assert.equal(g.unit, "$");
  assert.equal(g.step, 0.05);
  assert.equal(g.marks.length, 8);
  assert.equal(Route.gasMarks(pts.map((p) => ({ ...p, eng: null })), 3), null);
});
