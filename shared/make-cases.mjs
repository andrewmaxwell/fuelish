// Writes shared/cases.json: inputs with the answers the web code gives today. The web, server and
// Android suites each check their own copy of the rule against it, so a change to one copy that the
// others don't get fails a test. Run after changing a rule on purpose: node shared/make-cases.mjs
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({ console, fetch: async () => ({ ok: false }), Math, Date, JSON, Map, Set, Promise });
for (const f of ["route.js", "engine.js"]) vm.runInContext(readFileSync(new URL(`../web/${f}`, import.meta.url), "utf8"), ctx);
const { Route, Engine, Gas } = vm.runInContext("({ Route, Engine, Gas })", ctx);
const round = (x, n = 6) => Math.round(x * 10 ** n) / 10 ** n;

// Where a drive starts -> the EIA region whose gas price it gets (web/engine.js Gas.region, GasPrice.kt).
const places = [
  [39.74, -104.99], [34.05, -118.24], [47.61, -122.33], [33.45, -112.07], [36.17, -115.14], [40.76, -111.89],
  [46.87, -113.99], [35.08, -106.65], [29.76, -95.37], [32.78, -96.8], [30.33, -81.66], [33.75, -84.39],
  [34.75, -92.29], [35.15, -90.05], [36.16, -86.78], [41.88, -87.63], [44.98, -93.27], [39.1, -84.51],
  [40.44, -79.99], [42.36, -71.06], [40.71, -74.01], [25.76, -80.19], [38.9, -77.04], [35.47, -97.52], [33.52, -86.8], [31.76, -106.49], [34.0, -85.3],
  [61.22, -149.9], [21.31, -157.86], [51.05, -114.07], [19.43, -99.13],
];
const gasRegion = places.map(([lat, lon]) => [lat, lon, Gas.region(lat, lon)]);

// Great-circle metres between two points (Route.haversine, the server's haversine, DriveTally.distanceM).
const haversine = [
  [40, -105, 40.0101, -105], [40, -105, 40, -104.99], [39.7392, -104.9903, 39.7555, -105.2211],
  [0, 0, 0, 1], [61.2, -149.9, 61.3, -149.7], [-33.87, 151.21, -33.9, 151.18], [40, -105, 40, -105],
].map((c) => [...c, round(Route.haversine(...c), 3)]);

// Whether a step between two fixes counts toward distance: [dtMs, metres, v0, v1, acc0, acc1] -> metres counted
// (Route.segmentMeters, the server's segmentMeters).
const segmentMeters = [
  [1000, 20, 20, 20, 5, 5], [1000, 3, 0.2, 0.3, 5, 5], [1000, 3, 0.2, 0.6, 5, 5], [31000, 400, 15, 15, 5, 5],
  [30000, 400, 15, 15, 5, 5], [1000, 95, 30, 30, 5, 5], [0, 10, 5, 5, 5, 5], [2000, 8, null, null, 5, 5],
  [2000, 12, null, null, 5, 5], [2000, 12, null, null, 25, 5], [2000, 30, null, 4, null, null],
].map((c) => [...c, Route.segmentMeters(...c)]);

// Grams of fuel a second from what the engine reports, no fuel trims (Engine.derive, DriveTally.fuelGs).
const fuelGs = [
  { fuel_rate: 1 }, { fuel_rate: 6.4, maf: 20, commanded_lambda: 1 }, { maf: 14.08, commanded_lambda: 1 }, { maf: 3.2 },
  { maf: 40, commanded_lambda: 0.85 }, { maf: 5, commanded_lambda: 1.999 }, { maf: 2.5, commanded_lambda: 1.02 }, { rpm: 800 },
].map((v) => {
  const row = { t: 0, ...(v.fuel_rate != null ? { fuelRateLph: v.fuel_rate } : {}), ...(v.maf != null ? { maf: v.maf } : {}), ...(v.commanded_lambda != null ? { lambda: v.commanded_lambda } : {}) };
  const gs = Engine.derive([row])[0].fuelGs;
  return [v, gs == null ? null : round(gs, 9)];
});

writeFileSync(new URL("cases.json", import.meta.url), JSON.stringify({ gasRegion, haversine, segmentMeters, fuelGs }, null, 1).replace(/\n {2,}/g, " ").replace(/\n \]/g, " ]") + "\n");
