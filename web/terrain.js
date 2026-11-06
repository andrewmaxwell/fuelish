// Ground height along a route, from elevation tiles (Terrarium PNGs: AWS Open Data "Terrain Tiles",
// USGS 3DEP in the U.S., through /api/v1/terrain), and the road's grade from it. The cost ribbon uses
// the grade to tell climbing apart from everything else that burns extra fuel.
//
// It's the ground, not the road: a bridge over a valley reads as a dip and a cut through a hill as a
// bump. Heights are averaged over ±30 m and grades taken across ±60 m of road, and kept within ±15%,
// so those mostly blur into the road around them rather than show up as climbs.

const Terrain = (() => {
  const Z = 13; // about 15 m a pixel in the middle of the U.S.; a 30-mile drive needs 15-30 tiles
  const SIZE = 256;
  const tiles = new Map(); // "x/y" -> Promise<Uint8ClampedArray (RGBA) | null>

  // World pixel position at zoom Z (Web Mercator).
  function worldPx(lat, lon) {
    const n = SIZE * 2 ** Z, r = (lat * Math.PI) / 180;
    return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
  }

  function tile(x, y) {
    const key = `${x}/${y}`;
    if (!tiles.has(key)) {
      tiles.set(key, fetch(`/api/v1/terrain/${Z}/${x}/${y}.png`)
        .then((r) => (r.ok ? r.blob() : null))
        .then(async (blob) => {
          if (!blob) return null;
          // Exact pixel values matter (they are heights), so no color management or premultiplying.
          const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
          const c = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
          const ctx = c.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(bmp, 0, 0);
          return ctx.getImageData(0, 0, SIZE, SIZE).data;
        })
        .catch(() => null));
    }
    return tiles.get(key);
  }

  // Terrarium: height in meters = R × 256 + G + B / 256 − 32768.
  const at = (d, px, py) => {
    const i = (Math.min(SIZE - 1, Math.max(0, py)) * SIZE + Math.min(SIZE - 1, Math.max(0, px))) * 4;
    return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
  };

  /** Ground height (m) under each fix, NaN where no tile could be read. */
  async function heights(pts) {
    const pos = pts.map((p) => worldPx(p.lat, p.lon));
    const keys = new Set(pos.map(([x, y]) => `${Math.floor(x / SIZE)}/${Math.floor(y / SIZE)}`));
    const got = new Map(await Promise.all([...keys].map(async (k) => [k, await tile(...k.split("/").map(Number))])));
    return Float64Array.from(pos, ([x, y]) => {
      const tx = Math.floor(x / SIZE), ty = Math.floor(y / SIZE), d = got.get(`${tx}/${ty}`);
      if (!d) return NaN;
      // Bilinear within the tile (the last row and column repeat at its edge).
      const fx = x - tx * SIZE - 0.5, fy = y - ty * SIZE - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      return (at(d, x0, y0) * (1 - ax) + at(d, x0 + 1, y0) * ax) * (1 - ay) + (at(d, x0, y0 + 1) * (1 - ax) + at(d, x0 + 1, y0 + 1) * ax) * ay;
    });
  }

  const SMOOTH_M = 30, SPAN_M = 60, MAX_GRADE = 0.15;

  /**
   * Grade (rise over run; 0.05 is 5% uphill) at each fix from heights `h`, or null where there's too
   * little road or height around it. Trips on one page (p.trip) are kept apart.
   */
  function grades(pts, h) {
    const n = pts.length, s = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const p = pts[i - 1], q = pts[i];
      // A new trip starts far away along the road, so no window reaches across into another trip.
      s[i] = s[i - 1] + (q.trip === p.trip ? Route.haversine(p.lat, p.lon, q.lat, q.lon) : 1e7);
    }
    const same = (j, i) => pts[j].trip === pts[i].trip;
    // Heights averaged over ±30 m of road.
    const hs = new Float64Array(n).fill(NaN);
    for (let i = 0, lo = 0, hi = -1, sum = 0, k = 0; i < n; i++) {
      while (hi + 1 < n && s[hi + 1] <= s[i] + SMOOTH_M) { hi++; if (Number.isFinite(h[hi])) { sum += h[hi]; k++; } }
      while (s[lo] < s[i] - SMOOTH_M) { if (Number.isFinite(h[lo])) { sum -= h[lo]; k--; } lo++; }
      if (k > 0 && Number.isFinite(h[i])) hs[i] = sum / k;
    }
    const out = new Array(n).fill(null);
    for (let i = 0, a = 0, b = 0; i < n; i++) {
      while (s[a] < s[i] - SPAN_M || !same(a, i)) a++;
      if (b < i) b = i;
      while (b + 1 < n && s[b + 1] <= s[i] + SPAN_M && same(b + 1, i)) b++;
      const run = s[b] - s[a];
      if (run < SPAN_M * 0.66 || !Number.isFinite(hs[a]) || !Number.isFinite(hs[b])) continue;
      out[i] = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, (hs[b] - hs[a]) / run));
    }
    return out;
  }

  /** Sets p.elev (m) and p.grade on each fix; returns how many got a grade (0: no elevation here). */
  async function attach(pts) {
    if (!pts.length || typeof createImageBitmap !== "function") return 0;
    const h = await heights(pts);
    const g = grades(pts, h);
    let n = 0;
    pts.forEach((p, i) => {
      p.elev = Number.isFinite(h[i]) ? h[i] : null;
      p.grade = g[i];
      if (g[i] != null) n++;
    });
    return n;
  }

  return { attach, heights, grades };
})();
