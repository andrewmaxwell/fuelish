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
  return vm.runInContext("({ Route, Engine, extent, ...(typeof Costs !== 'undefined' ? { Costs } : {}), ...(typeof Repeats !== 'undefined' ? { Repeats } : {}), ...(typeof Cvt !== 'undefined' ? { Cvt } : {}) })", ctx);
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
