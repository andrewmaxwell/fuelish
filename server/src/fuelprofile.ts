// A chunk's fuel profile: how much fuel the engine burned in each kind of driving (by speed, and by
// whether the car was slowing, holding speed or speeding up), from the chunk's engine summary. The
// web app compares each trip's profile with the same vehicle's other trips to tell when it was
// working much harder than usual at the same speeds: towing (see web/towing.js).
//
// Stored on the chunk (meta "fuelProfile") when it's uploaded and summed per recording in the trip
// list, so towing can be told for every trip without loading anyone's engine data.
//
// { v: 1, b: { "<speed bin>|<accel bin>": [seconds, grams of fuel] } }
// Speed bins are 10 km/h wide (0: 8–10 km/h ... 14: 140+); accel bins 0: slowing (< -0.3 m/s²),
// 1: steady, 2: speeding up (0.3–0.9), 3: hard (> 0.9). Idling (under 8 km/h) and a cold engine
// (coolant under 70 °C: it burns extra while warming up whatever it's pulling) aren't counted.

export const FUEL_PROFILE_VERSION = 1;
const AFR = 14.08;
const FUEL_G_PER_L = 745;
const SLOW_CARRY_MS = 12_000;

export type FuelProfile = { v: number; b: Record<string, [number, number]> };

export function fuelProfile(meta: any): FuelProfile | null {
  if (meta?.engineFormat !== 1 || !Array.isArray(meta.engine) || !Array.isArray(meta.engineCols)) return null;
  const col = (name: string) => {
    const i = meta.engineCols.indexOf(name);
    return i < 0 ? -1 : i + 1;
  };
  const speedI = col("speed"), rateI = col("fuel_rate"), estI = col("fuel_est_gs"), mafI = col("maf"), lamI = col("commanded_lambda");
  const coolI = col("coolant_temp"), cutI = col("fuel_cut");
  if (speedI < 0 || (rateI < 0 && estI < 0 && mafI < 0)) return null;
  const num = (r: any[], i: number): number | null => (i > 0 && typeof r[i] === "number" && Number.isFinite(r[i]) ? r[i] : null);

  const b: Record<string, [number, number]> = {};
  let prev: { t: number; v: number } | null = null;
  let coolant: { c: number; t: number } | null = null;
  for (const r of meta.engine) {
    if (!Array.isArray(r) || typeof r[0] !== "number") continue;
    const t = r[0];
    const c = num(r, coolI);
    if (c != null) coolant = { c, t };
    const v = num(r, speedI);
    const p = prev;
    prev = v == null ? null : { t, v };
    if (v == null || !p) continue;
    const dt = (t - p.t) / 1000;
    if (dt <= 0 || dt > 1.5) continue;
    let gs: number | null = null;
    const rate = num(r, rateI), est = num(r, estI), maf = num(r, mafI);
    if (rate != null) gs = (rate * FUEL_G_PER_L) / 3600;
    else if (est != null) gs = est;
    else if (maf != null) {
      const lam = num(r, lamI) ?? 1, cut = num(r, cutI);
      gs = (cut != null ? cut >= 0.5 : lam >= 1.99) ? 0 : maf / (AFR * lam);
    }
    if (gs == null || gs < 0 || gs > 100) continue;
    if (coolant && t - coolant.t <= SLOW_CARRY_MS && coolant.c < 70) continue;
    if (v < 8) continue;
    const a = (v - p.v) / 3.6 / dt;
    const sb = Math.min(14, Math.floor(v / 10));
    const ab = a < -0.3 ? 0 : a <= 0.3 ? 1 : a <= 0.9 ? 2 : 3;
    const k = `${sb}|${ab}`;
    const cell = (b[k] ??= [0, 0]);
    cell[0] += dt;
    cell[1] += gs * dt;
  }
  const keys = Object.keys(b);
  if (!keys.length) return null;
  for (const k of keys) b[k] = [round1(b[k][0]), round1(b[k][1])];
  return { v: FUEL_PROFILE_VERSION, b };
}

/** One profile for a whole recording: its chunks' profiles added up (null when none have one). */
export function sumProfiles(list: (FuelProfile | null | undefined)[]): FuelProfile | null {
  let out: FuelProfile | null = null;
  for (const p of list) {
    if (!p || p.v !== FUEL_PROFILE_VERSION || !p.b || typeof p.b !== "object") continue;
    out ??= { v: FUEL_PROFILE_VERSION, b: {} };
    for (const [k, x] of Object.entries(p.b)) {
      if (!Array.isArray(x) || x.length !== 2 || !x.every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      const cell = (out.b[k] ??= [0, 0]);
      cell[0] = round1(cell[0] + x[0]);
      cell[1] = round1(cell[1] + x[1]);
    }
  }
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
