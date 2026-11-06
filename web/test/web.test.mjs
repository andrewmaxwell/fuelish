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
  return vm.runInContext("({ Route, Engine, extent, ...(typeof Costs !== 'undefined' ? { Costs } : {}), ...(typeof Repeats !== 'undefined' ? { Repeats } : {}), ...(typeof Cvt !== 'undefined' ? { Cvt } : {}), ...(typeof Coach !== 'undefined' ? { Coach } : {}), ...(typeof Towing !== 'undefined' ? { Towing } : {}), ...(typeof Ribbon !== 'undefined' ? { Ribbon } : {}), ...(typeof Terrain !== 'undefined' ? { Terrain } : {}), ...(typeof Stops !== 'undefined' ? { Stops } : {}) })", ctx);
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

test("driving score: gentle stops cost nothing, abrupt ones and long idles count, thin data gets no score", () => {
  const { Coach, Engine } = load("route.js", "engine.js", "coach.js");
  const civic = "2016 Honda Civic LX 2.0L";
  // 120 s at 20 m/s (45 mph), a stop slowing `decel` m/s², then `idleS` seconds stopped engine running.
  const drive = (decel, idleS) => {
    const pts = [], rows = [];
    let v = 20, t = 0;
    const add = () => { t += 1000; pts.push({ t, v }); rows.push({ t, speed: v * 3.6, rpm: 750, fuelGs: v > 0 ? 1.5 : 0.25 }); };
    for (let i = 0; i < 120; i++) add();
    while (v > 0) { v = Math.max(0, v - decel); add(); }
    for (let i = 0; i < idleS; i++) add();
    return { pts, rows, e: Engine.summary(rows, { vehicle: civic }) };
  };
  const gentle = Coach.score({ ...drive(0.6, 20), vehicle: civic }); // ~0.06 g
  const abrupt = Coach.score({ ...drive(3.5, 20), vehicle: civic }); // ~0.36 g
  assert.equal(gentle.parts.braking, 0);
  assert.ok(abrupt.parts.braking > 0.005, String(abrupt.parts.braking));
  assert.ok(abrupt.score < gentle.score, `${abrupt.score} vs ${gentle.score}`);
  assert.equal(gentle.parts.idle, 0); // a 20 s light isn't a long idle
  const idler = Coach.score({ ...drive(0.6, 180), vehicle: civic });
  // 170 s past the first 10 at 0.25 g/s.
  assert.ok(Math.abs(idler.parts.idle - Engine.galOf(0.25 * 170)) < 0.001, String(idler.parts.idle));
  assert.ok(idler.score < gentle.score && idler.score >= 0 && idler.score <= 100);
  const d = drive(0.6, 20);
  assert.equal(Coach.score({ ...d, e: { ...d.e, coverage: 0.5 } }), null);
  // The card's lines are the score's parts: what the card shows adds up to what the score counts.
  const both = drive(3.5, 180);
  const sc = Coach.score({ ...both, vehicle: civic });
  const lines = Coach.items({ ...both, vehicle: civic });
  for (const it of lines) assert.ok(Math.abs(it.gal - sc.parts[it.key]) < 1e-9, it.key);
  assert.equal(lines.map((it) => it.key).sort().join(), "braking,idle");
});

test("minute marks count on through several trips in order", () => {
  // Two trips of 90 s each, an hour apart: marks at 1, 2 and 3 minutes of driving, not 1 and 1.
  const leg = (trip, t0) => Array.from({ length: 91 }, (_, i) => ({ t: t0 + i * 1000, lat: 38 + (t0 + i) * 1e-6, lon: -90, v: 10, trip }));
  const marks = Route.minuteMarks([...leg(0, 0), ...leg(1, 3600000)]);
  assert.equal(marks.map((m) => m.n).join(), "1,2,3");
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

test("weighs trucks named by the VIN decoder as trucks", () => {
  for (const v of ["2019 RAM 1500 5.7L", "2021 Ford F-150 3.5L", "2018 Toyota Tacoma 3.5L", "Dad's truck"]) assert.equal(Engine.physics.massKg(v), 2600, v);
  assert.equal(Engine.physics.massKg("2016 Honda Civic 2.0L"), 1360);
  assert.equal(Engine.physics.massKg("2020 Toyota Camry 2.5L"), 1500);
  assert.equal(Engine.physics.massKg("2022 Hyundai Tramonto"), 1500); // "ram" inside a word isn't a Ram
});

// A trip's fuel profile: `secs` in each of a few highway and town bins, burning `rate` g/s.
const profile = (rate, secs = 200) => ({ v: 1, b: { "9|1": [secs, rate * secs], "5|1": [secs, rate * 0.8 * secs], "5|2": [secs / 2, rate * 1.5 * (secs / 2)] } });
const truckTrip = (id, rate, start, extra = {}) => ({ id, deviceId: "d", status: "stopped", startedWallMs: start, endedWallMs: start + 600000, meta: { vehicle: "2018 RAM 1500" }, fuelProfile: profile(rate), ...extra });

test("towing is told apart from the same truck's ordinary trips", () => {
  const { Towing } = load("route.js", "engine.js", "towing.js");
  const day = 86400000;
  const recs = [
    truckTrip("a", 2.0, 1 * day), truckTrip("b", 2.1, 2 * day), truckTrip("c", 1.9, 3 * day),
    truckTrip("tow1", 3.4, 4 * day), truckTrip("tow2", 3.2, 5 * day),
    // A short stop for fuel right after towing: too short to judge, so it follows the trip before.
    truckTrip("fuel", 3.0, 5 * day + 700000, { fuelProfile: profile(3.0, 20) }),
  ];
  Towing.mark(recs, {});
  assert.deepEqual(recs.map((r) => [r.id, r.towing]), [["a", false], ["b", false], ["c", false], ["tow1", true], ["tow2", true], ["fuel", true]]);
  assert.equal(recs.find((r) => r.id === "tow1").towingSource, "detected");
  assert.equal(recs.find((r) => r.id === "fuel").towingSource, "before");
  // A correction wins.
  Towing.mark(recs, { tow2: false });
  assert.equal(recs.find((r) => r.id === "tow2").towing, false);
  assert.equal(recs.find((r) => r.id === "tow2").towingSource, "you");
});

test("a truck that mostly tows still finds its unloaded trips", () => {
  const { Towing } = load("route.js", "engine.js", "towing.js");
  const recs = [1, 2, 3, 4].map((i) => truckTrip(`t${i}`, 3.3 + i * 0.05, i * 1e8)).concat([truckTrip("u1", 2.0, 9e8), truckTrip("u2", 2.1, 10e8)]);
  Towing.mark(recs, {});
  assert.deepEqual(recs.filter((r) => r.towing).map((r) => r.id).sort(), ["t1", "t2", "t3", "t4"]);
});

test("nothing to compare with, or no engine data: not towing", () => {
  const { Towing } = load("route.js", "engine.js", "towing.js");
  const recs = [truckTrip("only", 3.0, 1), { id: "civic", deviceId: "d2", status: "stopped", startedWallMs: 5, meta: { vehicle: "2016 Honda Civic" } }];
  Towing.mark(recs, {});
  assert.deepEqual(recs.map((r) => r.towing), [false, false]);
});

test("each trip is costed with its driver's time and its vehicle's per-mile costs", () => {
  const { Costs } = load("route.js", "engine.js", "costs.js");
  Costs.use({ timePerHour: 20, wearPerMile: 0.09 }, { "2016 Honda Civic": { wearPerMile: 0.08 } }, { dad: { timePerHour: 40 } });
  const civic = Costs.forTrip({ userId: "me", meta: { vehicle: "2016 Honda Civic" } });
  const truck = Costs.forTrip({ userId: "dad", meta: { vehicle: "2018 RAM 1500" } });
  assert.equal(civic.wearPerMile, 0.08);
  assert.equal(civic.timePerHour, 20); // no time of their own: the shared starting value
  assert.equal(truck.timePerHour, 40);
  assert.equal(truck.wearPerMile, 0.13); // a pickup's own starting point, not the sedan's
  assert.ok(Costs.trip({ minutes: 60, miles: 50, gal: 2, price: 3 }, truck).total > Costs.trip({ minutes: 60, miles: 50, gal: 2, price: 3 }, civic).total);
});

test("the cost ribbon splits every gram of a drive's gas by cause", () => {
  const { Ribbon } = load("route.js", "engine.js", "ribbon.js");
  // 30 s standing at idle, 15 s speeding up to 20 m/s, 90 s cruising, then coasting with fuel cut.
  const pts = [];
  let lat = 38.6, v = 0;
  for (let s = 0; s < 150; s++) {
    const a = s >= 30 && s < 45 ? 20 / 15 : s >= 135 ? -0.5 : 0;
    const fuel = s < 30 ? 0.15 : s < 45 ? 0.6 + 0.004 * 1500 * a * v / 100 : s < 135 ? 0.3 + 0.0006 * v * v : 0;
    pts.push({ t: s * 1000, lat, lon: -90.3, v, a, eng: { fuelGs: fuel, rpm: 900, cut: s >= 135 } });
    v = Math.max(0, v + a);
    lat += v / 111320;
  }
  const d = Ribbon.decompose(pts, { vehicle: "2016 Honda Civic 2.0L" });
  const burned = pts.slice(0, -1).reduce((g, p) => g + p.eng.fuelGs, 0);
  const split = Object.values(d.totals).reduce((g, x) => g + x, 0);
  assert.ok(Math.abs(split - burned) < 1e-9, `${split} vs ${burned}`);
  // Standing still includes pulling away below 4.5 mph: that gas belongs to the stop, not the road.
  const slow = pts.slice(0, -1).filter((p) => p.v < 2).reduce((g, p) => g + p.eng.fuelGs, 0);
  assert.ok(Math.abs(d.totals.idle - slow) < 1e-9, `idle ${d.totals.idle} vs ${slow}`);
  assert.equal(d.stops.length, 1);
  assert.ok(d.totals.accel > 0 && d.totals.air > 0 && d.totals.roll > 0);
  // Cruising has a band; standing still and coasting with fuel cut have no gas per mile.
  assert.ok(d.perMile[100] > 0);
  assert.equal(d.lanes[10], null);
  assert.ok(d.perMile[145] < 1e-9);
  // Speeding up is a bigger share of the band while speeding up than while cruising.
  const accel = Ribbon.CAUSES.findIndex((c) => c.key === "accel");
  const share = (i) => d.lanes[i][accel] / d.perMile[i];
  assert.ok(share(40) > share(100) + 0.1, `${share(40)} vs ${share(100)}`);
});

test("grades come from the ground's height along the road, one trip at a time", () => {
  const { Terrain } = load("route.js", "engine.js", "terrain.js");
  // 1 km due north, a fix every 10 m: flat for 300 m, 5% up for 400 m, flat again. Then a second trip
  // starting 100 m higher, which mustn't read as a cliff.
  const pts = [], h = [];
  for (let i = 0; i <= 100; i++) {
    pts.push({ t: i * 1000, lat: 38.6 + (i * 10) / 111195, lon: -90.3 });
    h.push(150 + 0.05 * Math.min(400, Math.max(0, i * 10 - 300)));
  }
  for (let i = 0; i <= 20; i++) {
    pts.push({ t: 200000 + i * 1000, lat: 38.7 + (i * 10) / 111195, lon: -90.3, trip: 1 });
    h.push(300);
  }
  const g = Terrain.grades(pts, Float64Array.from(h));
  assert.ok(Math.abs(g[50] - 0.05) < 0.005, `mid-climb ${g[50]}`);
  assert.ok(Math.abs(g[15]) < 0.005 && Math.abs(g[90]) < 0.005, `flat ${g[15]} ${g[90]}`);
  assert.ok(Math.abs(g[0]) < 0.005); // one-sided at the start of a trip
  assert.ok(g.slice(101).every((x) => x == null || Math.abs(x) < 0.005), "the second trip is flat");
});

test("with grades, climbing gets its own lane and downhills count as saved", () => {
  const { Ribbon } = load("route.js", "engine.js", "terrain.js", "ribbon.js");
  // 20 m/s throughout: 60 s up a 4% grade (fuel up with it), then 60 s down 4% (fuel cut).
  const pts = [];
  let lat = 38.6;
  for (let s = 0; s < 120; s++) {
    const up = s < 60;
    pts.push({ t: s * 1000, lat, lon: -90.3, v: 20, a: 0, grade: up ? 0.04 : -0.04, eng: { fuelGs: up ? 2.2 : 0, rpm: 1800, cut: !up } });
    lat += 20 / 111195;
  }
  const d = Ribbon.decompose(pts, { vehicle: "2016 Honda Civic 2.0L" });
  assert.ok(d.hasGrades);
  assert.ok(d.totals.climb > d.totals.other, `climb ${d.totals.climb} vs other ${d.totals.other}`);
  assert.ok(d.totals.downhill > 0);
  const burned = pts.slice(0, -1).reduce((g, p) => g + p.eng.fuelGs, 0);
  const split = ["base", "roll", "air", "climb", "accel", "other", "idle"].reduce((g, k) => g + d.totals[k], 0);
  assert.ok(Math.abs(split - burned) < 1e-9);
  assert.ok(Ribbon.legendHtml(d, 3).includes("Climbing"));
  // Without grades, climbs are in "Hills & other" and there's no Climbing row.
  for (const p of pts) p.grade = null;
  const flat = Ribbon.decompose(pts, { vehicle: "2016 Honda Civic 2.0L" });
  assert.equal(flat.totals.climb, 0);
  assert.ok(!Ribbon.legendHtml(flat, 3).includes("Climbing") && Ribbon.legendHtml(flat, 3).includes("Hills & other"));
});

test("a stop costs its wait, the gas to get going again, and the time lost against carrying on", () => {
  const { Ribbon, Stops } = load("route.js", "engine.js", "ribbon.js", "stops.js");
  // Idle 10 s at the start, cruise 15 m/s for 40 s, brake to a stop over 5 s, wait 20 s, speed back
  // up over 10 s, cruise 40 s, then park and idle 10 s at the end.
  const plan = [[10, 0], [40, 15], [5, -3], [20, 0], [10, 1.5], [40, 15], [5, -3], [10, 0]];
  const pts = [];
  let lat = 38.6, v = 0, t = 0;
  for (const [n, x] of plan) {
    for (let k = 0; k < n; k++) {
      const a = Math.abs(x) < 4 ? x : 0;
      if (Math.abs(x) >= 4) v = x;
      pts.push({ t: t * 1000, lat, lon: -90.3, v, a, eng: { fuelGs: a > 0 ? 2.5 : v > 0 ? 1 : 0.15, rpm: 900, cut: false } });
      v = Math.max(0, v + a);
      lat += v / 111195;
      t++;
    }
  }
  const evs = Stops.events(pts, Ribbon.decompose(pts, { vehicle: "2016 Honda Civic 2.0L" }));
  assert.equal(evs.length, 1); // the start and the end aren't stops
  const [e] = evs;
  assert.ok(e.waitMs >= 20000 && e.waitMs < 26000, `wait ${e.waitMs}`);
  assert.ok(e.lostMs > e.waitMs, `lost ${e.lostMs} vs wait ${e.waitMs}`); // slowing and speeding up lose time too
  assert.ok(e.goG > 0 && e.idleG > 0 && Math.abs(e.g - e.goG - e.idleG) < 1e-9);
  // Two stops a car length apart are one place; one 200 m away is another.
  const places = Stops.places([
    { ...e, trip: "a", price: 3 },
    { ...e, lat: e.lat + 0.00005, trip: "b", price: 3 },
    { ...e, lat: e.lat + 0.002, trip: "b", price: 3 },
  ]);
  assert.equal(places.length, 2);
  assert.equal(places[0].n, 2);
  assert.equal(places[0].trips.size, 2);
});

test("barometer heights follow the road, drop cabin pressure jumps, and take their drift from the ground", () => {
  const { Terrain } = load("route.js", "engine.js", "terrain.js");
  // 2 km north at 20 m/s, one fix a second: the road climbs 30 m over the middle kilometer. The
  // barometer drifts (weather) and jumps 0.4 hPa (about 3.5 m) once when the fan comes on.
  const pts = [], dem = [];
  const roadAt = (m) => 100 + 30 * Math.min(1, Math.max(0, (m - 500) / 1000));
  const hPaAt = (alt) => 1013.25 * (1 - alt / 44330) ** 5.255;
  for (let s = 0; s <= 100; s++) {
    const m = s * 20, alt = roadAt(m);
    pts.push({ t: s * 1000, lat: 38.6 + m / 111195, lon: -90.3, baro: hPaAt(alt) + 0.002 * s + (s >= 40 ? -0.4 : 0) });
    dem.push(alt + (s === 50 ? -12 : 0)); // the ground under a bridge at s = 50
  }
  const h = Terrain.baroHeights(pts, Float64Array.from(dem));
  for (const s of [0, 30, 45, 50, 70, 100]) assert.ok(Math.abs(h[s] - roadAt(s * 20)) < 1.5, `at ${s}: ${h[s]} vs ${roadAt(s * 20)}`);
  // Uncorrected, the jump would have read as a 3.5 m step at s = 40.
  const g = Terrain.grades(pts, h);
  assert.ok(Math.abs(g[60] - 0.03) < 0.006, `climb ${g[60]}`);
  assert.ok(Math.abs(g[10]) < 0.006, `flat ${g[10]}`);
});

test("a second without a fuel reading doesn't break the band; a long dropout does", () => {
  const { Ribbon } = load("route.js", "engine.js", "ribbon.js");
  const pts = [];
  let lat = 38.6;
  for (let s = 0; s < 60; s++) {
    const missing = s === 20 || (s >= 35 && s < 50); // one second, then 15 s without fuel
    pts.push({ t: s * 1000, lat, lon: -90.3, v: 15, a: 0, eng: { fuelGs: missing ? null : 1, rpm: 1800, cut: false } });
    lat += 15 / 111195;
  }
  const d = Ribbon.decompose(pts, { vehicle: "2016 Honda Civic 2.0L" });
  assert.ok(d.lanes[20] && Math.abs(d.perMile[20] - d.perMile[15]) / d.perMile[15] < 0.05, "filled from its neighbors");
  assert.equal(d.lanes[42], null); // nothing within ±4 s: no width
});
