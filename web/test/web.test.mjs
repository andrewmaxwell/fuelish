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
