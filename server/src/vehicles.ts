// Names a car from its VIN, so a new phone's trips get the right vehicle without anyone typing it.
// The app reads the VIN over OBD on the first drive and asks here; NHTSA's free vPIC decoder knows
// every car sold in the US. The name is what the trip pages match on (weight, EPA rating).

export const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

export interface Vehicle {
  vin: string;
  name: string;
  year: number | null;
  make: string;
  model: string;
  displacementL: number | null;
  bodyClass: string;
}

// "HONDA" -> "Honda", "MERCEDES-BENZ" -> "Mercedes-Benz"; short makes stay as written ("BMW", "GMC", "RAM").
function makeName(make: string): string {
  return make
    .trim()
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w : w.toLowerCase().replace(/(^|-)([a-z])/g, (_, a, b) => a + b.toUpperCase())))
    .join(" ");
}

/** One vPIC DecodeVinValues result -> a vehicle, or null when the VIN didn't decode to a car. */
export function vehicleFromVpic(vin: string, r: Record<string, string> | undefined): Vehicle | null {
  if (!r) return null;
  const year = Number(r.ModelYear) || null;
  const make = makeName(r.Make ?? "");
  const model = (r.Model ?? "").trim();
  if (!year || !make || !model) return null;
  const disp = Number(r.DisplacementL);
  const displacementL = Number.isFinite(disp) && disp > 0 ? Math.round(disp * 10) / 10 : null;
  const name = [String(year), make, model, displacementL ? `${displacementL.toFixed(1)}L` : ""].filter(Boolean).join(" ");
  return { vin: vin.toUpperCase(), name, year, make, model, displacementL, bodyClass: (r.BodyClass ?? "").trim() };
}

export async function decodeVin(vin: string): Promise<Vehicle | null> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin.toUpperCase())}?format=json`;
  // A VIN always decodes the same way: let Cloudflare keep the answer for a month.
  const res = await fetch(url, { cf: { cacheTtl: 30 * 86400, cacheEverything: true } } as RequestInit);
  if (!res.ok) throw new Error(`vPIC answered HTTP ${res.status}`);
  const body: any = await res.json();
  return vehicleFromVpic(vin, body?.Results?.[0]);
}
