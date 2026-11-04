// Repeated trips: drives between the same two places, grouped so they can be compared.
//
// Places are where trips start and end, clustered within PLACE_M (so "home" is one place however
// you park). A journey is every trip from one place to another (or a loop back to the same place).
// Within a journey, trips that followed the same roads are one route: two paths are the same when
// nearly all of each lies close to the other. Routes are lettered in the order you first drove them,
// so a name never changes as more trips come in. A loop (out and back to the same place) is only a
// repeated trip when its route repeats: two different errands from home aren't the same journey. Names for places are saved on the server (prefs
// "places": [{ lat, lon, name }]) and apply to whichever place is nearest, within PLACE_M.

const Repeats = (() => {
  const PLACE_M = 250;
  const SAME_ROAD_M = 250;
  const SAME_SHARE = 0.85;

  const R = 6371000, RAD = Math.PI / 180;
  const dist = ([la1, lo1], [la2, lo2]) => Route.haversine(la1, lo1, la2, lo2);
  const moved = (r) => r.trip && r.trip.meters >= 300 && r.trip.path?.length >= 2 && r.status !== "recording";

  /** Clusters trip ends into places: [{ id, lat, lon, visits, name }], most visited first. */
  function places(recs, named = []) {
    const cl = [];
    for (const r of recs.filter(moved)) {
      for (const p of [r.trip.path[0], r.trip.path.at(-1)]) {
        let best = null, bd = Infinity;
        for (const c of cl) { const d = dist(p, [c.lat, c.lon]); if (d < bd) { bd = d; best = c; } }
        if (best && bd <= PLACE_M) {
          best.n++;
          best.lat += (p[0] - best.lat) / best.n;
          best.lon += (p[1] - best.lon) / best.n;
        } else cl.push({ lat: p[0], lon: p[1], n: 1 });
      }
    }
    cl.sort((a, b) => b.n - a.n);
    return cl.map((c, i) => {
      const nm = nearestName(named, c);
      return { id: i, lat: c.lat, lon: c.lon, visits: c.n, name: nm ?? `Place ${i + 1}`, named: nm != null };
    });
  }
  function nearestName(named, c) {
    let best = null, bd = PLACE_M;
    for (const n of named || []) { const d = dist([n.lat, n.lon], [c.lat, c.lon]); if (d <= bd) { bd = d; best = n.name; } }
    return best;
  }
  const placeOf = (pl, p) => {
    let best = null, bd = Infinity;
    for (const c of pl) { const d = dist(p, [c.lat, c.lon]); if (d < bd) { bd = d; best = c; } }
    return bd <= PLACE_M * 1.5 ? best : null;
  };

  // Distance from a point to a polyline, in meters (flat-earth projection: fine at city scale).
  function toLine(p, line) {
    const k = Math.cos(p[0] * RAD) * R * RAD, m = R * RAD;
    const px = p[1] * k, py = p[0] * m;
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const ax = line[i - 1][1] * k, ay = line[i - 1][0] * m, bx = line[i][1] * k, by = line[i][0] * m;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) best = d;
    }
    return best;
  }
  const share = (a, b) => a.filter((p) => toLine(p, b) <= SAME_ROAD_M).length / a.length;
  const sameRoads = (a, b) => share(a, b) >= SAME_SHARE && share(b, a) >= SAME_SHARE;

  /**
   * Journeys with at least two trips: [{ key, from, to, trips (oldest first), routes: [{ n, trips,
   * path, miles }] }], most driven first. `key` is the id of the journey's first trip.
   */
  function journeys(recs, named = []) {
    const pl = places(recs, named);
    const by = new Map();
    for (const r of recs.filter(moved)) {
      const a = placeOf(pl, r.trip.path[0]), b = placeOf(pl, r.trip.path.at(-1));
      if (!a || !b) continue;
      const k = `${a.id}>${b.id}`;
      (by.get(k) || by.set(k, { from: a, to: b, trips: [] }).get(k)).trips.push(r);
    }
    const out = [];
    const finish = (j, routes) => {
      routes.forEach((v, i) => {
        v.n = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ""); // A, B, … by first drive
        v.miles = median(v.trips.map((r) => r.trip.meters / 1609.344));
      });
      out.push({ ...j, key: j.trips[0].id, routes, loop: j.from.id === j.to.id });
    };
    for (const j of by.values()) {
      if (j.trips.length < 2) continue;
      j.trips.sort((x, y) => x.startedWallMs - y.startedWallMs);
      const routes = [];
      for (const r of j.trips) {
        const v = routes.find((x) => sameRoads(x.path, r.trip.path));
        if (v) v.trips.push(r); else routes.push({ path: r.trip.path, trips: [r] });
      }
      if (j.from.id !== j.to.id) finish(j, routes);
      // Loops: each repeated route is its own journey; one-off loops aren't compared at all.
      else for (const v of routes) if (v.trips.length >= 2) finish({ ...j, trips: v.trips }, [v]);
    }
    return { places: pl, journeys: out.sort((x, y) => y.trips.length - x.trips.length) };
  }

  const journeyOf = (js, id) => js.find((j) => j.key === id || j.trips.some((r) => r.id === id));
  const routeOf = (j, id) => j.routes.find((v) => v.trips.some((r) => r.id === id));
  const title = (j) => (j.loop ? `Loop from ${j.from.name} (${j.routes[0].miles.toFixed(1)} mi)` : `${j.from.name} → ${j.to.name}`);

  function median(xs) {
    const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  }

  // ---------- scoring ----------

  const BOARDS = [
    { key: "gal", label: "Least gas", fmt: (v) => `${v < 0.1 ? v.toFixed(3) : v.toFixed(2)} gal`, better: "low" },
    { key: "minutes", label: "Quickest", fmt: (v) => fmtMin(v), better: "low" },
    { key: "total", label: "Cheapest all in", fmt: (v) => Costs.money(v), better: "low" },
    { key: "mpg", label: "Best mpg", fmt: (v) => `${v.toFixed(1)} mpg`, better: "high" },
  ];
  const fmtMin = (m) => (m < 60 ? `${m.toFixed(m < 10 ? 1 : 0)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);

  // A trip's gas, mpg and cost compete only when engine readings cover most of it; otherwise it's
  // listed apart with the reason. Time competes for every trip.
  const MIN_COVERAGE = 0.9;

  /** One scored row per trip. `engine`: Map id -> { e (Engine.summary), gas }. */
  function score(j, engine, endOf) {
    const rows = j.trips.map((r) => {
      const x = engine.get(r.id);
      const minutes = (endOf(r) - r.startedWallMs) / 60000;
      // The GPS distance of the whole drive, the same yardstick for every trip.
      const miles = r.trip.meters / 1609.344;
      const e = x?.e;
      return {
        r, route: routeOf(j, r.id), minutes, miles, e,
        gal: e ? e.galTrip ?? e.gal : null, mpg: e?.mpg ?? null, price: x?.gas?.price ?? null,
        cold: e?.coolant?.[0] != null && e.coolant[0] < 50, coverage: e?.coverage ?? null,
      };
    });
    // Trips without engine data get gas guessed at this journey's typical mpg, marked as such.
    const mpgGuess = median(rows.map((x) => x.mpg));
    const price = median(rows.map((x) => x.price));
    for (const x of rows) {
      const c = Costs.trip({ minutes: x.minutes, miles: x.miles, gal: x.gal, price: x.price ?? price, mpgGuess, fuelSource: x.e?.fuelSource, extrapolated: x.e?.extrapolated });
      x.total = c.fuelKnown ? c.total : null;
      x.cost = c;
      x.estimated = c.estimated;
      x.why = x.e == null ? "no engine data" : x.coverage < MIN_COVERAGE ? `engine readings cover ${Math.round(x.coverage * 100)}% of it` : null;
    }
    return rows;
  }

  // ---------- rendering ----------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (ms) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  /** The list of journeys and the place names. */
  function overview(host, { places: pl, journeys: js }, { endOf, rename }) {
    if (!js.length) {
      host.innerHTML = `<p class="lede">No repeated trips yet. Once you've driven between the same two places twice, they show up here to compare.</p>`;
      return;
    }
    const used = new Set(js.flatMap((j) => [j.from.id, j.to.id]));
    host.innerHTML = `
      <div class="cards">${js.map((j) => {
        const mins = median(j.trips.map((r) => (endOf(r) - r.startedWallMs) / 60000));
        const mi = median(j.trips.map((r) => r.trip.meters / 1609.344));
        return `<a class="card trip-card" href="#/routes/${esc(j.key)}">
          <div class="thumb">${Charts.thumbnail(j.routes.map((v) => v.path))}</div>
          <div class="trip-card-body">
            <div class="trip-card-title"><b>${esc(title(j))}</b><span class="pill">${j.trips.length} trips</span></div>
            <div class="muted">${j.routes.length > 1 ? `${j.routes.length} ways` : "one way"} · usually ${fmtMin(mins)}, ${mi.toFixed(1)} mi</div>
          </div></a>`;
      }).join("")}</div>
      <section class="ins-sec">
        <h2>Places</h2>
        <p class="lede">Where your repeated trips start and end. Name them so the comparisons read well; names are saved for every browser.</p>
        <div class="places">${pl.filter((p) => used.has(p.id)).map((p) => `
          <label class="place"><span class="muted">${p.visits} visits</span><input value="${esc(p.named ? p.name : "")}" placeholder="${esc(p.name)}" data-lat="${p.lat}" data-lon="${p.lon}" aria-label="Name for ${esc(p.name)}"></label>`).join("")}</div>
      </section>`;
    host.querySelectorAll(".place input").forEach((inp) => inp.addEventListener("change", () => rename(+inp.dataset.lat, +inp.dataset.lon, inp.value.trim(), inp)));
  }

  /** One journey: the leaderboard, and its routes compared. */
  function board(host, j, rows, { boardKey = "gal", onBoard }) {
    const b = BOARDS.find((x) => x.key === boardKey) || BOARDS[0];
    // Time ranks every trip; gas, mpg and cost only trips the engine covered.
    const fair = (x) => b.key === "minutes" || !x.why;
    const ranked = rows.filter((x) => x[b.key] != null && fair(x)).sort((u, v) => (b.better === "low" ? u[b.key] - v[b.key] : v[b.key] - u[b.key]));
    const unranked = rows.filter((x) => !ranked.includes(x));
    const best = ranked[0], typical = median(ranked.map((x) => x[b.key]));
    const vals = ranked.map((x) => x[b.key]).sort((u, v) => u - v);
    const spread = vals.length >= 4 ? `; middle half ${b.fmt(vals[Math.floor(vals.length / 4)])} to ${b.fmt(vals[Math.floor((vals.length * 3) / 4)])}` : "";
    const medal = (i) => (i < 3 ? `<span class="rank r${i + 1}">${i + 1}</span>` : `<span class="rank">${i + 1}</span>`);
    const routeTag = (x) => (j.routes.length > 1 ? `<span class="pill route-pill">Route ${x.route.n}</span>` : "");
    const flags = (x) => [x.cold ? "cold start" : "", x.e?.extrapolated ? "gas partly extrapolated" : "", x.estimated && !x.e ? "gas guessed" : ""].filter(Boolean).join(" · ");

    host.innerHTML = `
      <div class="seg board-tabs" role="group">${BOARDS.map((x) => `<button type="button" data-k="${x.key}" aria-pressed="${x.key === b.key}">${x.label}</button>`).join("")}</div>
      ${!best ? `<p class="lede">No trips to rank on this yet.</p>`
        : ranked.length === 1 ? `<p class="lede">One ranked run so far: <b>${b.fmt(best[b.key])}</b> on ${esc(when(best.r.startedWallMs))}.</p>`
        : `<p class="lede">Best: <b>${b.fmt(best[b.key])}</b> on ${esc(when(best.r.startedWallMs))}. Typical: ${b.fmt(typical)}${spread} (${ranked.length} runs).</p>`}
      <ol class="board">${ranked.map((x, i) => `
        <li><a href="#/r/${esc(x.r.id)}">
          ${medal(i)}
          <span class="board-when"><b>${esc(when(x.r.startedWallMs))}</b><small>${[routeTag(x), esc(flags(x))].filter(Boolean).join(" ")}</small></span>
          <span class="board-val"><b>${b.fmt(x[b.key])}</b><small>${[b.key !== "minutes" ? fmtMin(x.minutes) : "", b.key !== "gal" && x.gal != null ? `${x.gal.toFixed(2)} gal` : "", b.key !== "total" && x.total != null ? Costs.money(x.total) : ""].filter(Boolean).join(" · ")}</small></span>
        </a></li>`).join("")}
      </ol>
      ${unranked.length ? `<h3>Not ranked here</h3><ol class="board unranked">${unranked.map((x) => `<li><a href="#/r/${esc(x.r.id)}"><span class="rank">–</span><span class="board-when"><b>${esc(when(x.r.startedWallMs))}</b><small>${[routeTag(x), esc(x.why || "no value")].join(" ")}</small></span><span class="board-val"><b>${x[b.key] != null ? b.fmt(x[b.key]) : "–"}</b>${fmtMin(x.minutes) ? `<small>${fmtMin(x.minutes)}</small>` : ""}</span></a></li>`).join("")}</ol>
        <p class="hint">Gas, mpg and cost are only compared for trips the engine readings cover at least ${Math.round(MIN_COVERAGE * 100)}% of; anything less isn't a fair race.</p>` : ""}
      ${j.routes.length > 1 ? routesHtml(j, rows) : ""}
      <p class="hint">Gas and mpg come from the engine (an airflow estimate unless the car reports fuel use); cold starts are marked since they use more. Miles are the GPS distance. "All in" counts your time, wear and carbon at the rates on the <a href="#/costs">Costs</a> page.</p>`;
    host.querySelectorAll(".board-tabs button").forEach((btn) => btn.addEventListener("click", () => onBoard(btn.dataset.k)));
  }

  // The ways you've driven it, side by side: medians, so one bad day doesn't decide.
  function routesHtml(j, rows) {
    const stats = j.routes.map((v) => {
      const mine = rows.filter((x) => x.route === v), fair = mine.filter((x) => !x.why);
      return { v, n: mine.length, nFair: fair.length, minutes: median(mine.map((x) => x.minutes)), gal: median(fair.map((x) => x.gal)), total: median(fair.map((x) => x.total)), miles: v.miles };
    });
    // A winner needs at least two routes with numbers, and says so when it rests on single runs.
    const bestOf = (k) => {
      const ok = stats.filter((s) => s[k] != null);
      return ok.length > 1 ? ok.reduce((a, b) => (b[k] < a[k] ? b : a)) : null;
    };
    const thin = stats.some((s) => (s.nFair || s.n) < 2);
    const winners = { minutes: bestOf("minutes"), gal: bestOf("gal"), total: bestOf("total"), miles: bestOf("miles") };
    const cell = (s, k, fmt) => `<td class="${winners[k] === s ? "win" : ""}">${s[k] == null ? "–" : fmt(s[k])}</td>`;
    const usually = thin ? "has been" : "is usually";
    const verdict = winners.total ? `Counting everything, Route ${winners.total.v.n} ${usually} cheapest${winners.minutes && winners.minutes !== winners.total ? `; Route ${winners.minutes.v.n} ${usually} quickest` : ""}${winners.gal && winners.gal !== winners.total ? `; Route ${winners.gal.v.n} ${thin ? "has used" : "usually uses"} the least gas` : ""}.${thin ? " Some routes have only one run, so this could change." : ""}` : "";
    // Every route drawn at the same scale, so a short one looks short.
    const all = stats.flatMap((s) => s.v.path);
    return `<h3>The ways you've driven it</h3>
      <div class="route-thumbs">${stats.map((s) => `<figure><div class="thumb">${Charts.thumbnail(s.v.path, 200, 110, all)}</div><figcaption>Route ${s.v.n} · ${s.n} trip${s.n === 1 ? "" : "s"}</figcaption></figure>`).join("")}</div>
      <table class="route-table"><thead><tr><th></th><th>Trips</th><th>Miles</th><th>Time</th><th>Gas</th><th>All in</th></tr></thead><tbody>
        ${stats.map((s) => `<tr><th>Route ${s.v.n}</th><td>${s.n}</td>${cell(s, "miles", (v) => v.toFixed(1))}${cell(s, "minutes", fmtMin)}${cell(s, "gal", (v) => v.toFixed(2) + " gal")}${cell(s, "total", Costs.money)}</tr>`).join("")}
      </tbody></table>
      <p class="hint">Medians per route. ${verdict}</p>`;
  }

  return { places, journeys, journeyOf, routeOf, title, score, overview, board, BOARDS, sameRoads };
})();
