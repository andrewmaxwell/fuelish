// One trip's page: its points, the side panel (headline numbers, the score and what to change, the
// folded details), the places it went, and sharing.

// ---------- points for a trip ----------

// GPS points for one recording, cut off where the drive ended. `onProgress` reports a raw rebuild.
async function tripPoints(id, detail, onProgress, { shared = false } = {}) {
  const { recording: r, chunks } = detail || (await api(`/recordings/${id}`));
  // Summarized chunks give their fixes directly; any without a summary (recorded before the phone
  // made them, recovered after a crash, or trimmed for size) are rebuilt from raw data once.
  let pts = Route.fromChunks(chunks);
  const raw = Route.rawChunks(chunks);
  if (raw.length && !shared) {
    // Keyed by which raw chunks went in, so parts uploaded later get read too.
    const key = `${id}@${raw.map((c) => c.sha256 ?? c.seq).join(",")}`;
    let extra = routeCache.get(key);
    if (!extra) {
      const links = await api(`/recordings/${id}/links`, { method: "POST" });
      extra = await Route.fromRaw(raw.map((c) => links.chunks[c.seq]).filter(Boolean), onProgress);
      routeCache.set(key, extra);
    }
    pts = Route.merge(pts, extra);
  }
  if (!pts.length && shared && raw.length) throw new Error("This trip was recorded before routes were summarized, so it can't be shown on a shared link.");
  const end = r.driveEndWallMs;
  const out = end != null ? pts.filter((p) => p.t <= end) : pts;
  // Engine rows from the chunk summaries; `engineRaw` lists chunks whose engine data is only raw.
  out.engine = Engine.derive(Engine.fromChunks(chunks)).filter((e) => end == null || e.t <= end);
  Engine.calibrate(out.engine, out);
  out.engineRaw = shared ? [] : Engine.rawOnly(chunks); // shared links never get raw chunks
  out.end = end;
  out.ecu = mainEcuOf(r);
  return out;
}

// The trip's outing and repeated journey, found among its owner's trips (all of them, whoever the
// person picker shows). Links that lead to a list switch the picker to that person, so the outing or
// comparison they open has the trip in it.
async function tripContext(r, live) {
  let recordings;
  try {
    ({ recordings } = await allRecordings(r.userId ?? ""));
  } catch (e) {
    if (e.message === "unauthorized") throw e;
    return null; // the page works without it
  }
  const box = document.getElementById("trip-context");
  const rec = recordings.find((x) => x.id === r.id) ?? null;
  if (!live() || !box) return rec;
  const id = r.id;
  const who = Account.whoFor(r.userId);
  // Does the picker's choice already include this trip? ("" is everyone; "me" is the signed-in person.)
  const p = Account.whoParam();
  const shown = p === "" || p === r.userId || (p === "me" && who === "me");
  const sw = shown ? "" : ` data-who="${esc(who)}"`;
  let html = "";
  const o = outingOf(recordings, id);
  if (o && legsOf(o).length > 1) html += stretchNav(o, id, sw);
  // Driven before? Link to its leaderboard.
  const j = Repeats.journeyOf(Repeats.journeys(recordings, Prefs.get("places")).journeys, id);
  if (j) html += `<nav class="outing-nav"><span>One of ${j.trips.length} ${j.towing ? "towing " : ""}trips ${esc(j.loop ? `looping from ${j.from.name}` : `from ${j.from.name} to ${j.to.name}`)}</span><a href="#/routes/${esc(j.key)}"${sw}>Compare them →</a></nav>`;
  if (rec) html += towingNav(rec);
  box.innerHTML = html;
  box.querySelectorAll("[data-who]").forEach((a) => (a.onclick = () => Account.setWho(a.dataset.who)));
  box.querySelectorAll("[data-tow]").forEach((b) => (b.onclick = () => setTowing(rec, b.dataset.tow === "1", b)));
  return rec;
}

// Whether the trip was towing, why Fuelish thinks so, and a way to correct it. Shown for trucks, and
// for any trip marked towing.
function towingNav(r) {
  if (!r.towing && !Engine.physics.isTruck(r.meta?.vehicle) && r.towingSource !== "you") return "";
  const pct = r.towingRatio != null ? Math.round((r.towingRatio - 1) * 100) : null;
  const what = esc(r.meta?.vehicle || "vehicle");
  const why = {
    you: "you marked it",
    detected: r.towing && pct != null ? `it burned about ${pct}% more fuel than this ${what} usually does at the same speeds` : "fuel use was normal for this vehicle",
    before: "it came right after a towing trip",
  }[r.towingSource] ?? "too little to compare with yet";
  return `<nav class="outing-nav towing-nav"><span><b>${r.towing ? "Towing" : "Not towing"}</b> · ${why}. Towing trips are compared only with other towing trips.</span>
    <button type="button" class="link" data-tow="${r.towing ? "0" : "1"}">${r.towing ? "Wasn't towing?" : "Was towing?"}</button></nav>`;
}

// Saves a correction. Agreeing with the detection again removes the correction instead.
async function setTowing(r, towing, btn) {
  btn.disabled = true;
  try {
    await Prefs.update("towing", (cur) => {
      const next = { ...(cur || {}) };
      if (r.towingDetected === towing) delete next[r.id]; else next[r.id] = towing;
      return next;
    });
    route();
  } catch (e) {
    if (e.message === "unauthorized") return;
    btn.disabled = false;
    btn.textContent = `Couldn't save (${e.message}). Try again`;
  }
}

// An outing's page and its trips' pages are one page: this row across the top switches between the
// whole outing and each trip in it. `at` is the trip shown, or null for the whole outing; `sw` switches
// the person picker so the outing found has this trip in it.
function stretchNav(o, at, sw = "") {
  const t = totals(o), legs = legsOf(o);
  const item = (href, label, small, on, extra = "") =>
    `<a href="${href}"${on ? ` aria-current="page"` : ""}${extra}><b>${label}</b><small>${small}</small></a>`;
  return `<nav class="stretches" aria-label="This outing">
    ${item(`#/outing/${esc(o[0].id)}`, "Whole outing", `${plural(legs.length, "trip")}${t.trips ? ` · ${miles(t.meters)}` : ""}`, at == null, sw)}
    ${legs.map((r) => item(`#/r/${esc(r.id)}`, esc(clock(r.startedWallMs)), moved(r) ? miles(r.trip.meters) : esc(noRouteLabel(r).toLowerCase()), at === r.id, ` data-id="${esc(r.id)}"`)).join("")}
  </nav>`;
}

// A trip still recording or uploading: checks for new parts every 30 s while the page is visible
// (and right away on coming back to it), and offers them with a button rather than redrawing the
// map under someone looking at it.
function watchForParts(r, live) {
  const sig = (x) => `${x.status}|${x.chunksReceived}|${x.chunkCount}|${x.updatedAtMs}`;
  const was = sig(r);
  const state = () => document.getElementById("upd-state");
  const show = (html) => { const el = state(); if (el) el.innerHTML = html; };
  const refresh = `<button type="button" class="link" id="upd-go">Refresh</button>`;
  let timer = null, busy = false;
  const check = async () => {
    if (busy || document.hidden || !live()) return;
    busy = true;
    try {
      const { recording: now } = await api(`/recordings/${r.id}`);
      if (!live()) return;
      if (sig(now) !== was) {
        const n = now.chunksReceived - r.chunksReceived;
        show(`<b>${n > 0 ? `${plural(n, "new part")} uploaded` : now.status !== r.status ? "Recording finished" : "Updated"}.</b> ${refresh}`);
        stop(); // nothing more to learn until it's shown
      } else {
        show(`Checked ${esc(clock(Date.now()))}. ${refresh}`);
      }
    } catch (e) {
      if (live() && e.message !== "unauthorized") show(`Couldn't check for new parts. ${refresh}`);
    } finally {
      busy = false;
    }
  };
  const onVisible = () => { if (!document.hidden) check(); };
  const stop = () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  timer = setInterval(check, 30_000);
  document.addEventListener("visibilitychange", onVisible);
  const onClick = (e) => { if (e.target.id === "upd-go") route(); };
  document.addEventListener("click", onClick);
  show(refresh);
  onLeave(() => { stop(); document.removeEventListener("click", onClick); });
}

// Older drives (before the phone summarized engine data): read it from the raw chunks once.
const engineCache = new Map();
async function rawEngine(id, pts, onProgress) {
  if (!pts.engineRaw.length) return [];
  const key = `${id}@${pts.engineRaw.map((c) => c.sha256 ?? c.meta.seq).join(",")}`; // new parts: read again
  if (engineCache.has(key)) return engineCache.get(key);
  const links = await api(`/recordings/${id}/links`, { method: "POST" });
  // The engine ECU, from the recording's discovery: the chunk holding the discovery record may not
  // be among the raw ones read here.
  const rows = Engine.derive(await Engine.fromRaw(pts.engineRaw, pts.engineRaw.map((c) => links.chunks[c.meta.seq]), onProgress, { ecu: pts.ecu }))
    .filter((e) => pts.end == null || e.t <= pts.end);
  Engine.calibrate(rows, pts.length ? pts : Route.fromChunks(pts.chunks || []) || []);
  engineCache.set(key, rows);
  return rows;
}

// Engine-only options (pedal, mpg, gal/h) stay hidden until the drive's engine data is in.
const seg = (key, options) => `<div class="seg" data-key="${key}" role="group">${Object.entries(options)
  .map(([k, v]) => `<button type="button" data-v="${k}"${(v.engine ?? Route.METRICS[k]?.engine) ? " data-engine hidden" : ""}>${esc(typeof v === "string" ? v : v.label)}</button>`).join("")}</div>`;
const fig = (value, label, unit = "") => `<div class="fig"><b>${value}<small>${unit}</small></b><span>${label}</span></div>`;

// Over the map: which view colors the line, whether notable moments are labeled, and the legend.
const mapControls = () => `
  <div class="map-controls">
    <div class="ctl">${seg("view", Route.VIEWS)}<button type="button" class="chip" id="moments-toggle">Labels</button></div>
  </div>
  <div class="map-legend" id="rt-legend"></div>`;

// The side panel: headline numbers, the score and what to change, then the details folded to one
// line each (filled in once engine data is in), then the fine print.
const sidePanel = (middle = "") => `
  <section class="side-sec above-map">
    <div class="figs trip-figs" id="figs"></div>
    <p class="sub-line" id="sub-line"></p>
    <div class="gas-note" id="gas-note" hidden></div>
    <p class="hint" id="engine-status" hidden></p>
  </section>
  <section class="side-sec coach above-map" id="coach" hidden></section>
  ${middle}
  <section class="side-sec folds">
    <details class="fold" id="health" hidden></details>
    <details class="fold" id="split" hidden></details>
    <details class="fold" id="waste" hidden></details>
    <details class="fold" id="trip-cost" hidden></details>
    <details class="fold" id="friction-sec">
      <summary><h2>Friction circle</h2><span id="peaks-sum"></span></summary>
      <div class="fold-body">
        <p class="hint">Each dot is one second: how hard you were speeding up or braking (up and down), and turning (sideways). Smooth driving stays near the middle.</p>
        <div id="friction" class="chart-host"></div>
        <div id="peaks" class="peaks"></div>
      </div>
    </details>
  </section>
  <section class="side-sec about-sec" id="about" hidden>
    <details class="fold">
      <summary><h2>About these numbers</h2></summary>
      <div class="fold-body">${["fuel", "score", "waste", "cost"].map((k) => `<div data-about="${k}"></div>`).join("")}</div>
    </details>
  </section>`;

// Door-to-door time when it's known (one trip), with the moving part under it.
const timeFig = (sm) => (sm.durMs != null && sm.durMs - sm.movingMs >= 60000
  ? fig(fmtDur(sm.durMs), `${fmtDur(sm.movingMs)} moving`) : fig(fmtDur(sm.movingMs), "moving"));

// Headline numbers from the route; mpg and cost fill in when engine data arrives.
function sideRoute(sm, { engine = false, trips = 0 } = {}) {
  const mi = sm.miles.toFixed(sm.miles < 10 ? 1 : 0);
  const avg = sm.avgMph != null ? sm.avgMph.toFixed(0) : "–", top = sm.maxMph != null ? sm.maxMph.toFixed(0) : "–";
  document.getElementById("figs").innerHTML = fig(mi, "miles") + timeFig(sm) +
    (engine ? fig("–", "mpg") + fig("–", "gas") : fig(avg, "mph average") + fig(top, "mph top"));
  document.getElementById("sub-line").textContent = ""; // the map labels top speed and the hardest brake
}

// The driving score's ideal drive (ideal.js) for a drive's fixes with engine rows attached, or null
// without enough engine data. Grades are left out, so the trip list (which doesn't load elevation)
// and the trip page always agree; the drive and its ideal take the same hills, so they mostly cancel.
function idealFor(pts, { e, vehicle = "", towing = false, price = null, timePerHour = 0 }) {
  if (!(e?.coverage >= 0.9)) return null;
  const flat = pts.map((p) => (p.grade == null ? p : { ...p, grade: null }));
  const fit = Ribbon.decompose(flat, { vehicle, towing }).fit;
  return Ideal.plan(flat, fit, { vehicle, towing, richGal: e.fuelUse?.rich ?? 0, price, timePerHour });
}

// The score and what to change, as one list: the score ring (the cheapest way to drive this trip ÷
// what it took, ideal.js), then one line per difference (name, amount, a bar on one scale). The lines
// add up exactly to the gap. A line opens to say what happened and how to change it; the sharpest
// stops are buttons that show the stop on the map.
function coachCard(el, { pts, e, vehicle, towing = false, price, timePerHour = 0, focus }) {
  if (!el) return;
  const r = idealFor(pts, { e, vehicle, towing, price, timePerHour });
  if (!r) { el.hidden = true; return; }
  el.hidden = false;
  // Amounts are shown on the headline's gallons (which fill in the few miles without fuel readings),
  // so "what it took" here is the gas figure at the top of the page, and the lines still add up.
  const k = coachScale(e.galTrip ?? e.gal, r.actual.gal);
  const amount = (gal) => (price != null ? smallMoney(gal * k * price) : `${gallons(gal * k)} gal`);
  const dur = (s) => (Math.abs(s) < 60 ? `${Math.max(1, Math.round(Math.abs(s)))} s` : `${(Math.abs(s) / 60).toFixed(Math.abs(s) < 600 ? 1 : 0)} min`);
  const worth = (l) => (price != null ? Math.abs(l.gal) * k * price >= 0.005 : Math.abs(l.gal) >= 0.0015);
  const lines = r.lines.filter(worth).sort((a, b) => b.gal - a.gal);
  const rest = r.lines.filter((l) => !worth(l)).reduce((s, l) => s + l.gal, 0);
  const max = Math.max(...lines.map((l) => Math.abs(l.gal)), 1e-9);
  const stops = Coach.braking(pts, vehicle, towing).events.filter((s) => s.avgG > Ideal.DECEL / 9.80665).slice(0, 3);
  const later = (l) => (l.secs <= -1 ? ` The cheaper way takes ${dur(l.secs)} longer${price != null && timePerHour > 0 ? ` (${money((-l.secs / 3600) * timePerHour)} of your time at ${money(timePerHour)}/h)` : ""}.` : "");
  const body = (l) => ({
    rich: `<p>Pressing hard makes the engine run rich, spending fuel beyond what the air needs. A firm but not floored pedal keeps it lean.</p>`,
    idle: `<p>The engine idled ${fmtDur(r.idleSecs * 1000)} in ${plural(r.idleCount, "standstill")} of a minute or more. For waits like that (not traffic lights), switching off after 10 s saves more than the restart uses.</p>`,
    speed: `<p>You drove ${dur(r.aboveMin * 60)} above ${r.cruiseMph} mph (top ${Math.round(r.topMph)}). Holding ${r.cruiseMph} would have used ${amount(l.gal)} less gas.${later(l)} Speed limits and traffic come first.</p>`,
    smooth: `<p>Braking turns speed the engine paid for into heat. Lifting off sooner lets the car coast most of the way with the fuel cut off; slowing no harder than ${(Ideal.DECEL / 9.80665).toFixed(2)} g would have used ${amount(l.gal)} less gas.${later(l)}${stops.length ? " The firmest:" : ""}</p>
      ${stops.length ? `<div class="coach-stops">${stops.map((s) => `<button type="button" data-i="${s.peakI}">${Math.round(s.fromMph)}→${Math.round(s.toMph)} mph<small>${s.avgG.toFixed(2)} g</small></button>`).join("")}</div>` : ""}`,
  })[l.key];
  const title = { rich: "Pressing hard", idle: "Long idles", speed: `Above ${r.cruiseMph} mph`, smooth: "Braking, not coasting" };
  const opened = new Set([...el.querySelectorAll("details[data-k]")].filter((d) => d.open).map((d) => d.dataset.k));
  const more = Math.round((r.ratio - 1) * 100);
  el.innerHTML = `<div class="drive-score ${scoreTone(r.score)}">
      <div class="drive-score-num"><b>${r.score}</b><small>driving score</small></div>
      <p>${more < 1 ? `About as little gas as this trip could take: ${amount(r.actual.gal)}.` : `This drive used ${more}% more gas than the cheapest way to drive it: ${amount(r.actual.gal)} against ${amount(r.ideal.gal)}${lines.length ? ". The difference:" : "."}`}</p>
    </div>
    ${lines.length ? `<ul class="coach-list">${lines.map((l) => `<li><details data-k="${l.key}"${opened.has(l.key) ? " open" : ""}>
        <summary><span class="coach-name">${title[l.key]}</span><i class="coach-bar"><i style="width:${Math.max(2, (Math.abs(l.gal) / max) * 100)}%"></i></i><b>${l.gal < 0 ? "−" : ""}${amount(Math.abs(l.gal))}</b></summary>
        <div class="coach-body">${body(l)}</div></details></li>`).join("")}
      ${Math.abs(rest) >= 0.0001 && (price == null || Math.abs(rest) * price >= 0.005) ? `<li class="coach-rest"><span>Smaller things</span><b>${amount(rest)}</b></li>` : ""}</ul>`
      : `<p class="hint">Nothing stood out on this drive: no braking that coasting would have saved, long idles or fast cruising worth changing.</p>`}`;
  about("score", "The driving score", `<p>The score is the gas the cheapest way to drive this trip would take, divided by the gas it took: 100 means it couldn't have been done on less. The cheapest way drives the same roads with the same stops and is never faster than you were at any point, so traffic, lights and limits you kept to hold it back too. It differs only in what you control: no fuel beyond what the air needed, the engine off after 10 s of standstills over a minute, cruising no faster than ${r.cruiseMph} mph (${r.cheapestMph > r.cruiseMph ? `counting your time, faster would be cheaper still, up to ${r.cheapestMph} mph, but the ideal keeps to 70` : r.cheapestMph < r.cruiseMph ? `the least gas would be at ${r.cheapestMph} mph, but the ideal keeps to 55 or more` : "the cheapest steady speed counting your time"}), and slowing early and gently (${(Ideal.DECEL / 9.80665).toFixed(2)} g at most). Its gas comes from this drive's own fit of fuel against the power to roll, push the air and speed up, scaled to the fuel the engine reported, so errors in the fit mostly cancel. Time it loses before a short stop comes off the wait there: a red light waits either way. The lines are worked out in order, each on top of the one before, so they add up to the difference. The route itself isn't judged.</p>`);
  el.onclick = (ev) => {
    const stop = ev.target.closest("[data-i]");
    if (!stop) return;
    focus(Number(stop.dataset.i));
    // On a phone the map is below this card: bring it into view.
    document.getElementById("map")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
}

// The side panel's detail sections are folded to one line each: the title and its key number.
// Re-filling one (when the gas price arrives) keeps it open or closed as the person left it.
function setFold(id, title, summary, body, openAtFirst = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.dataset.filled ? el.open : openAtFirst;
  el.dataset.filled = "1";
  el.hidden = false;
  el.innerHTML = `<summary><h2>${title}</h2><span>${summary}</span></summary><div class="fold-body">${body}</div>`;
  el.open = open;
}

// The fine print, gathered at the bottom of the side panel: one paragraph per topic, in a fixed order.
function about(key, title, html) {
  const slot = document.querySelector(`#about [data-about="${key}"]`);
  if (!slot) return;
  slot.innerHTML = `<h3>${esc(title)}</h3>${html}`;
  document.getElementById("about").hidden = false;
}

// Highway vs town, where the fuel went, trip cost, car health: everything that needs the engine.
function sideEngine(sm, e, { gas = null, partial = false, trip = null, vehicle = trip?.meta?.vehicle ?? "", towing = !!trip?.towing, coach = null } = {}) {
  const figs = document.getElementById("figs");
  if (!figs) return;
  if (coach) coachCard(document.getElementById("coach"), { ...coach, e, vehicle, towing, price: gas?.price ?? null, timePerHour: gas ? timeFor(trip) : 0 });
  const cost = (g) => (gas ? money(g * gas.price) : null);
  const mi = sm.miles.toFixed(sm.miles < 10 ? 1 : 0);
  // With fuel readings over less of the drive, mpg is only for the part they cover, and gas for the
  // whole drive is that part plus the rest at the same mpg (marked ≈).
  const thin = e.coverage < 0.95 || e.extrapolated;
  const galShown = e.galTrip ?? e.gal;
  const epa = Engine.epa(vehicle);
  figs.innerHTML = fig(mi, "miles") + timeFig(sm) +
    fig(e.mpg != null ? (thin ? "≈" : "") + e.mpg.toFixed(0) : "–", epa ? `mpg · EPA ${epa.comb}` : "mpg") +
    fig(galShown != null && gas ? (thin ? "≈" : "") + cost(galShown) : "–", galShown != null ? `for ${gallons(galShown)} gal` : "gas");
  // Where the numbers come from, folded away behind one short line; warnings about missing data stay out.
  const note = document.getElementById("gas-note");
  const aboutFuel = [e.fromCar ? "Fuel as reported by the car." : "Fuel is estimated from airflow, the air-fuel target and the engine's fuel trims (this car doesn't report fuel use), not a pump reading."];
  if (epa) aboutFuel.push(`EPA rates this car ${epa.city} city, ${epa.hwy} highway and ${epa.comb} combined.`);
  if (gas) aboutFuel.push(`Gas at ${money(gas.price)}/gal, the ${gas.regionName} regional average for the week of ${new Date(gas.weekMs).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })} (U.S. EIA).`);
  const warn = [];
  if (thin && e.gal != null) warn.push(e.coverage < 0.5
    ? `Engine readings cover only ${Math.round(e.coverage * 100)}% of this drive's miles, so its mpg and gas are rough.`
    : `Engine readings cover ${Math.round(e.coverage * 100)}% of this drive's miles; mpg is for that part, and gas for the rest is filled in at the same mpg.`);
  if (partial) warn.push("Some of these trips have no engine data and aren't counted.");
  note.hidden = !warn.length;
  note.innerHTML = warn.length ? `<p class="hint">${esc(warn.join(" "))}</p>` : "";
  about("fuel", "Fuel and gas price", `<p>${esc(aboutFuel.join(" "))}</p>`);

  // Highway vs town: economy bars on one scale.
  const parts = [["Highway", `${Engine.HIGHWAY_MPH}+ mph`, e.highway, epa?.hwy], ["Town", `under ${Engine.HIGHWAY_MPH} mph`, e.town, epa?.city]].filter(([, , g]) => g.gal > 0.001);
  if (parts.length) {
    const max = Math.max(1, ...parts.map(([, , g]) => g.mpg ?? 0));
    setFold("split", "Highway vs town", (parts.length === 1 ? parts[0][0].toLowerCase() + " " : "") + parts.map(([, , g]) => (g.mpg != null ? g.mpg.toFixed(0) : "–")).join(" / ") + " mpg", `
      <div class="split">${parts.map(([name, note, g, rated]) => `
        <div class="split-row">
          <div class="split-name"><b>${name}</b><span>${note}</span>${rated ? `<span>EPA ${rated}</span>` : ""}</div>
          <div class="split-bar"><i style="width:${((g.mpg ?? 0) / max) * 100}%"></i></div>
          <div class="split-val"><b>${g.mpg != null ? g.mpg.toFixed(0) : "–"}<small>mpg</small></b><span>${g.miles.toFixed(g.miles < 10 ? 1 : 0)} mi · ${gallons(g.gal)} gal</span></div>
        </div>`).join("")}</div>`);
  }

  // Where the fuel went: one bar of the measured fuel, idling and enrichment marked. Braking is
  // energy, not fuel, and only an estimate, so it's listed under the bar, not inside it.
  if (e.fuelUse && e.gal) {
    const u = e.fuelUse;
    const kinds = [
      ["drive", "Driving", Math.max(0, e.gal - u.idle - u.rich), "moving at the ideal air-fuel ratio"],
      ["rich", "Enrichment", u.rich, "fuel beyond the ideal air-fuel ratio, mostly hard acceleration"],
      ["idle", "Idling", u.idle, `engine running at 0 mph for ${fmtDur(e.idleMs)} (counted where readings exist)`],
    ];
    const pct = (g) => Math.min(100, Math.max(0, (g / e.gal) * 100));
    const top2 = kinds.filter(([, , g]) => pct(g) >= 1).sort((x, y) => y[2] - x[2]).slice(0, 2);
    setFold("waste", "Where the fuel went", top2.map(([, label, g]) => `${Math.round(pct(g))}% ${label.toLowerCase()}`).join(" · "), `
      <p class="sec-meta">${gallons(e.gal)} gal · ${esc(Engine.fuelLabel(e))}</p>
      <div class="waste-bar" role="img" aria-label="${esc(kinds.map(([, label, g]) => `${label} ${Math.round(pct(g))}%`).join(", "))}">${kinds.map(([k, , g]) => `<i class="w-${k}" style="flex-grow:${g}"></i>`).join("")}</div>
      <dl class="waste-list">${kinds.map(([k, label, g, why]) => `
        <div><dt><i class="sw w-${k}"></i>${label}<small>${why}</small></dt><dd>${gallons(g)} gal${cost(g) ? ` · ${cost(g)}` : ""} · ${Math.round(pct(g))}%</dd></div>`).join("")}
        ${e.cutMs >= 30000 ? `<div><dt><i class="sw w-cut"></i>Coasting, fuel off<small>the engine cut fuel entirely while you coasted</small></dt><dd>${fmtDur(e.cutMs)} · 0 gal</dd></div>` : ""}</dl>`);
    about("waste", "Where the fuel went", `
        <p>${e.fromCar ? "Fuel use is as reported by the car." : `This car doesn't report fuel use, so it's estimated from the air flowing into the engine and the air-fuel ratio the engine asks for${e.perSample ? ", reading by reading" : ""}, corrected by the engine's fuel trims (how much fuel it adds or removes beyond what the airflow sensor implies).`}
        ${e.speedFactor !== 1 ? `Miles use the car's speed, which read ${Math.abs((1 - 1 / e.speedFactor) * 100).toFixed(1)}% ${e.speedFactor > 1 ? "low" : "high"} against GPS on this drive, corrected.` : "Miles use the car's own speed."}</p>`);
  }

  // What this trip cost, counting more than gas.
  if (trip && typeof Costs !== "undefined") {
    const c = Costs.tripParts({ trip, sm, e, gas });
    setFold("trip-cost", "What it cost", c.summary, c.body);
    about("cost", "What it cost", c.about);
  }

  // Car health in one line; anything wrong comes first and stands out.
  const bad = [], ok = [];
  if (e.mil != null) (e.mil || e.dtcs ? bad : ok).push(e.mil ? `Check engine light on${e.dtcs ? `, ${plural(e.dtcs, "code")}` : ""}` : e.dtcs ? `${plural(e.dtcs, "stored code")}` : "Check engine light off");
  if (Number.isFinite(e.volts[0]) && Number.isFinite(e.volts[1])) {
    const v = `charging ${e.volts[0].toFixed(1)}–${e.volts[1].toFixed(1)} V`;
    (e.volts[0] < 12.8 || e.volts[1] > 15.2 ? bad : ok).push(v);
  }
  if (e.warmMs != null) ok.push(`warmed up in ${fmtDur(e.warmMs)}`);
  else if (e.coolant[1] != null) ok.push(`coolant ${Engine.cToF(e.coolant[1]).toFixed(0)} °F`);
  if (e.fuelLevel != null) ok.push(`tank ${e.fuelLevel.toFixed(0)}%`);
  if (e.maxRpm) ok.push(`top ${Math.round(e.maxRpm).toLocaleString()} rpm`);
  if (bad.length || ok.length) {
    const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    setFold("health", "Car health", bad.length ? `<b class="bad">${esc(cap(bad[0]))}</b>` : "All good",
      `<p class="health">${[...bad.map((x) => `<b class="bad">${esc(cap(x))}</b>`), ...ok.map((x, i) => esc(!bad.length && !i ? cap(x) : x))].join(" · ")}</p>`, bad.length > 0);
  }
}

// Labels for the map: the moments most worth a look. Engine ones (best and thirstiest minute) need p.eng.
function momentsFor(pts, sm) {
  const out = [];
  const arg = (f) => { let b = -1, bv = -Infinity; pts.forEach((p, i) => { const v = f(p); if (v != null && v > bv) { bv = v; b = i; } }); return [b, bv]; };
  const [ib, brake] = arg((p) => (p.a != null ? -p.a / Route.G : null));
  if (brake >= 0.15) out.push({ i: ib, text: `Hardest brake ${brake.toFixed(2)} g` });
  const [ia, acc] = arg((p) => (p.a != null ? p.a / Route.G : null));
  if (acc >= 0.15) out.push({ i: ia, text: `Hardest acceleration ${acc.toFixed(2)} g` });
  const [it, turn] = arg((p) => (p.side != null ? Math.abs(p.side) / Route.G : null));
  if (turn >= 0.2) out.push({ i: it, text: `Sharpest turn ${turn.toFixed(2)} g ${pts[it].side > 0 ? "right" : "left"}` });
  const [iv, top] = arg((p) => (p.v != null ? p.v * Route.MPH : null));
  if (top > 5) out.push({ i: iv, text: `Top speed ${top.toFixed(0)} mph` });
  const longest = [...sm.stops].sort((a, b) => b.ms - a.ms)[0];
  if (longest && longest.ms >= 20000) out.push({ i: longest.i0, text: `Stopped ${fmtDur(longest.ms)}` });
  // Rolling one-minute economy while moving (at least 0.2 mi in the minute).
  let best = null, worst = null, j = 0, mi = 0, gal = 0;
  const step = (p, q) => (q.t - p.t <= 3000 && p.trip === q.trip && q.eng?.speed != null && q.eng.fuelGs != null
    ? [(q.eng.speed / 3.6) * ((q.t - p.t) / 1000) / 1609.344, (q.eng.fuelGs * (q.t - p.t)) / 1000 / 745 / 3.78541] : null);
  for (let i = 1; i < pts.length; i++) {
    const d = step(pts[i - 1], pts[i]);
    if (!d) { j = i; mi = gal = 0; continue; }
    mi += d[0]; gal += d[1];
    while (pts[i].t - pts[j].t > 60000) {
      const o = step(pts[j], pts[j + 1]);
      if (o) { mi -= o[0]; gal -= o[1]; }
      j++;
    }
    if (pts[i].t - pts[j].t < 55000 || mi < 0.2 || gal <= 0) continue;
    const mpg = mi / gal, mid = (i + j) >> 1;
    if (!best || mpg > best.mpg) best = { i: mid, mpg };
    if (!worst || mpg < worst.mpg) worst = { i: mid, mpg };
  }
  // Only the thirstiest: the best minute is nearly always a long downhill coast, which says nothing
  // about the driving.
  if (best && worst && best.mpg - worst.mpg > 5) out.push({ i: worst.i, text: `Thirstiest minute ${worst.mpg.toFixed(0)} mpg` });
  // Moments within about 300 m of each other share one label.
  const merged = [];
  for (const m of out) {
    const near = merged.find((x) => Route.haversine(pts[x.i].lat, pts[x.i].lon, pts[m.i].lat, pts[m.i].lon) < 300);
    if (near) near.text += "<br>" + m.text; else merged.push({ ...m });
  }
  return merged;
}

// ---------- one trip ----------

// `share` is a share-link token: the trip is shown read-only, without anything that needs signing in.
async function showTrip(id, share = null, focusT = null) {
  const live = current();
  const detail = await api(share ? `/shared/${share}` : `/recordings/${id}`);
  if (!live()) return;
  const { recording: r } = detail;
  id = r.id;
  const m = r.meta;
  const pills = [share ? `<span class="pill">Shared trip</span>` : "", statusPill(r), m.vehicle ? `<span class="pill">${esc(m.vehicle)}</span>` : ""].join("");
  const day = new Date(r.startedWallMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });


  app.innerHTML = `
    <div class="trip">
      <header class="trip-head">
        ${share ? "" : `<a href="#/" class="back">← Trips</a>`}
        <h1>${esc(tripName(r.startedWallMs))}</h1>
        <p class="muted">${esc(day)} · ${esc(timeRange(r))}</p>
        <div class="pills">${pills}${!share && Account.canShare(r) ? `<div class="share" id="share"></div><button type="button" class="pill del-btn" id="del-trip">Delete…</button>` : ""}</div>
        <div id="trip-context"></div>
        ${r.status === "recording" ? `<p class="hint" id="upd">Still recording; the route fills in as parts upload. <span id="upd-state"></span></p>`
          : !r.complete ? `<p class="hint" id="upd">${r.chunksReceived} of ${r.chunkCount ?? "?"} parts uploaded so far; the phone sends the rest when it's next online. <span id="upd-state"></span></p>` : ""}
        ${m.note ? `<p class="note">${esc(m.note)}</p>` : ""}
      </header>
      <section class="trip-map">
        <div id="map"></div>
        ${mapControls()}
        <div class="readout" id="readout" hidden></div>
        <div class="map-status" id="rt-status">Loading route…</div>
      </section>
      <aside class="trip-side">${sidePanel(share ? "" : `<section class="side-sec places-sec" id="places-sec" hidden></section>`)}</aside>
    </div>`;

  if (!share && Account.canShare(r)) {
    shareControls(id);
    const del = document.getElementById("del-trip");
    del.onclick = async () => {
      if (!confirm("Delete this trip? Its route, engine data and share links come off the server for good. If the phone still has a copy, it lets it go too.")) return;
      del.disabled = true;
      try {
        await api(`/recordings/${id}`, { method: "DELETE" });
        location.hash = "#/";
      } catch (e) {
        del.disabled = false;
        if (e.message !== "unauthorized") alert(`Couldn't delete it: ${e.message}`);
      }
    };
  }
  // Not awaited: the route doesn't wait for it. It also says whether the trip was towing, which the
  // engine figures then take into account.
  const context = share ? Promise.resolve(null) : tripContext(r, live);
  if (!share && (r.status === "recording" || !r.complete)) watchForParts(r, live);
  const status = document.getElementById("rt-status");
  const pts = await tripPoints(id, detail, (i, n) => {
    if (status) status.innerHTML = `Building the detailed route… <progress max="${n}" value="${i}"></progress>`;
  }, { shared: !!share });
  if (!live()) return; // navigated away meanwhile
  if (pts.length < 2) return engineOnly(r, pts, status, live);
  status.remove();
  const sm = Route.summary(pts);
  sm.durMs = endOf(r) - r.startedWallMs;
  sideRoute(sm, { engine: pts.engine.length > 0 || pts.engineRaw.length > 0 });
  const view = drawRoute(pts, sm);
  if (!share) placesSection(pts, sm, view, live, { retitle: (l) => { document.querySelector(".trip-head h1").textContent = l ?? tripName(r.startedWallMs); } });
  if (focusT != null) {
    // Opened at a moment (from Insights): zoom there and hold the cursor on it.
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.t - focusT) < Math.abs(pts[best].t - focusT)) best = i; });
    view.map.setView([pts[best].lat, pts[best].lon], 17);
    view.focusAt = best;
  }
  // Engine results don't wait for the gas price; the cost fills in when (if) it arrives.
  const engineOpts = { gas: null, vehicle: m.vehicle, towing: false, trip: r };
  let engineRows = pts.engine;
  const showEngine = () => {
    if (!engineRows.length || !live()) return;
    view.setEngine(engineRows, engineOpts);
    if (view.focusAt != null) view.pick(view.focusAt); // again, now with engine values in the readout
  };
  if (view.focusAt != null) view.pick(view.focusAt);
  showEngine();
  context.then((rec) => {
    if (rec?.towing && live()) { r.towing = true; engineOpts.towing = true; showEngine(); }
  });
  withTimeout(Gas.forTrip(pts[0].lat, pts[0].lon, r.startedWallMs), 8000).then((gas) => {
    if (gas && live()) { engineOpts.gas = gas; showEngine(); }
  });
  if (pts.engineRaw.length) {
    // Chunks whose engine data is only raw (older drives, recovered or trimmed chunks): read them
    // once and merge with whatever the summaries gave.
    const st = document.getElementById("engine-status");
    st.hidden = false;
    try {
      const rows = await rawEngine(id, pts, (i, n) => {
        st.innerHTML = `Reading engine data from the raw recording… <progress max="${n}" value="${i}"></progress>`;
      });
      if (!live()) return;
      st.hidden = true;
      engineRows = Engine.merge(pts.engine, rows);
      Engine.calibrate(engineRows, pts);
      showEngine();
    } catch (e) {
      if (e.message !== "unauthorized" && live()) st.innerHTML = `<span class="bad">Couldn't read the engine data: ${esc(e.message)}</span>`;
    }
  }
}

// Where the drive (one trip, an outing, a day or a week) started, stopped and ended, each with a
// name to type. Named places are labeled on the map, and the place whose name is being edited is
// ringed there. The names are shared with Compare and describe trips in the list ("Home → Aldi");
// `retitle(label)` (optional) puts the description in the page title.
//
// On a page of several drives, `drives` (Map: pts' trip index -> its recordings) puts each drive in the
// list too, after the place it set off from: a link to its page that brings it forward on the map.
function placesSection(pts, sm, view, live, { retitle = null, withDay = false, drives = null, failed = [] } = {}) {
  const host = document.getElementById("places-sec");
  if (!host) return;
  const when = (t) => clock(t); // a week's list has day headings
  const what = { start: "Started", stop: "Stopped", end: "Ended" };
  const draw = (focusI = null) => {
    const vs = Places.visitsOfPoints(pts, sm.stops);
    retitle?.(Places.labelOf(vs));
    view.places(vs);
    view.highlightPlace(null);
    host.hidden = false;
    // A week's list gets a heading where the day changes: at a place, or at a drive setting off.
    let lastDay = "";
    const heading = (t) => {
      const day = withDay ? dayLabel(t) : "";
      if (!day || day === lastDay) return "";
      lastDay = day;
      return `<div class="row-day">${esc(day)}</div>`;
    };
    const rows = vs.map((v, i) => {
      const head = heading(v.t);
      const recs = drives && v.leaves != null ? drives.get(v.leaves) || [] : [];
      const drive = recs.length ? heading(recs[0].startedWallMs) + driveRow(recs, vs.find((x) => x.arrives === v.leaves)?.t) : "";
      return `${head}
        <label class="place-row${drives && v.along ? " along" : ""}"><span>${what[v.kind]} <small>${esc(when(v.t))}${v.ms ? ` · ${fmtDur(v.ms)}` : ""}</small></span>
          <input value="${esc(v.name ?? "")}" placeholder="Name this place" data-i="${i}" maxlength="80"></label>${drive}`;
    }).join("");
    host.innerHTML = `<h2>${drives ? `${plural([...drives.values()].filter((x) => x.length).length, "trip")} · places` : "Places"}</h2>
      <div class="place-rows">${rows}</div>
      ${failed.length ? `<p class="hint bad">${plural(failed.length, "trip")} (${failed.map((r) => esc(clock(r.startedWallMs))).join(", ")}) couldn't load; reload to try again.</p>` : ""}
      <p class="hint" id="places-note">Names are shared with Compare and every browser.</p>`;
    host.querySelectorAll("input").forEach((inp) => {
      const k = +inp.dataset.i;
      inp.addEventListener("focus", () => view.highlightPlace(k));
      inp.addEventListener("blur", () => view.highlightPlace(null));
      inp.closest(".place-row").addEventListener("mouseenter", () => view.highlightPlace(k));
      inp.closest(".place-row").addEventListener("mouseleave", () => { if (document.activeElement !== inp) view.highlightPlace(null); });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
      inp.addEventListener("change", async () => {
        const v = vs[k];
        // Where focus went (Tab to the next field), to put it back after redrawing.
        const next = () => [...host.querySelectorAll("input")].indexOf(document.activeElement);
        inp.disabled = true;
        try {
          await Places.rename(v.lat, v.lon, inp.value.trim());
        } catch (e) {
          if (e.message === "unauthorized" || !live()) return;
          inp.disabled = false;
          document.getElementById("places-note").innerHTML = `<span class="bad">Couldn't save: ${esc(e.message)}</span>`;
          return;
        }
        if (!live()) return;
        const go = next();
        draw();
        if (go >= 0) host.querySelectorAll("input")[go]?.focus();
      });
    });
  };
  draw();
}

// One drive in the places list: when, how far, how long. Several recordings carried on as one drive
// (an app update in the middle) are one row, linked to the first. It ends when the drive arrived.
function driveRow(recs, arrivedT = null) {
  const m = recs.filter(moved), r = recs[0], last = recs.at(-1);
  const t = totals(recs);
  return `<a class="trip-row drive-row" href="#/r/${esc(r.id)}" data-id="${esc(r.id)}">
    <b>${esc(clock(r.startedWallMs))} – ${esc(clock(arrivedT ?? endOf(last)))}</b>
    <span>${m.length ? `${miles(t.meters)} · ${fmtDur(t.movingMs)}${recs.some((x) => x.routeGaps) ? " · partial" : ""}` : noRouteLabel(r).toLowerCase()}</span></a>`;
}

// A recording without a usable GPS track (parked warm-up, garage start, location off) can still
// have engine data: show that instead of an empty page.
async function engineOnly(r, pts, status, live) {
  let rows = pts.engine;
  if (pts.engineRaw.length) {
    try { rows = Engine.merge(rows, await rawEngine(r.id, pts, (i, n) => { status.innerHTML = `Reading engine data from the raw recording… <progress max="${n}" value="${i}"></progress>`; })); }
    catch (e) { if (e.message === "unauthorized") throw e; }
    if (!live()) return;
  }
  if (!rows.length) {
    status.textContent = "No location and no engine data were recorded on this drive.";
    return;
  }
  status.textContent = "Location wasn't recorded on this drive. Its engine data is beside the map.";
  document.querySelectorAll(".map-controls, #rt-legend").forEach((el) => { el.style.display = "none"; });
  const e = Engine.summary(rows, { vehicle: r.meta.vehicle, towing: !!r.towing, tripMs: endOf(r) - r.startedWallMs });
  let movingMs = 0, maxKmh = null;
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt <= 2500 && rows[i].speed > 1) movingMs += dt;
    if (rows[i].speed != null && (maxKmh == null || rows[i].speed > maxKmh)) maxKmh = rows[i].speed;
  }
  const sm = { miles: e.miles, movingMs, stops: [], peak: { brake: 0, accel: 0, corner: 0 }, avgMph: null, maxMph: maxKmh != null ? Engine.mph(maxKmh) : null };
  const gas = await withTimeout(Gas.forTrip(null, null, r.startedWallMs), 8000);
  if (!live()) return;
  sideEngine(sm, e, { gas, trip: r });
  document.getElementById("sub-line").textContent = `${fmtDur(endOf(r) - r.startedWallMs)} recorded · miles from the car's speedometer${sm.maxMph != null ? ` · top ${sm.maxMph.toFixed(0)} mph` : ""}`;
  document.getElementById("friction-sec")?.setAttribute("hidden", "");
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]).catch(() => null);

// Share link for one trip: a small button by the pills that opens a panel to create, copy or stop it.
async function shareControls(id) {
  const box = document.getElementById("share");
  const linkOf = (t) => `${location.origin}/#/s/${t}`;
  const who = "Anyone with the link can see this trip without signing in: the route, including where it starts and ends, and its engine data.";
  const render = (tok, open = false) => {
    if (!document.getElementById("share")) return;
    const wrap = (label, body) => `<details class="share-pop"${open ? " open" : ""}><summary class="pill share-btn${tok ? " on" : ""}">${label}</summary><div class="share-box">${body}</div></details>`;
    if (!tok) {
      box.innerHTML = wrap("Share…", `<p class="hint">${who}</p><button type="button" class="primary" id="share-on">Create link</button>`);
      box.querySelector("#share-on").onclick = async () => {
        try { render((await api(`/recordings/${id}/shares`, { method: "POST" })).token, true); }
        catch (e) { box.querySelector(".share-box").insertAdjacentHTML("beforeend", `<p class="bad">${esc(e.message)}</p>`); }
      };
      return;
    }
    box.innerHTML = wrap("Shared", `
        <div class="share-row"><input readonly value="${esc(linkOf(tok))}" aria-label="Share link"><button type="button" class="primary" id="share-copy">Copy</button></div>
        <p class="hint">${who}</p>
        <button type="button" class="ghost" id="share-off">Stop sharing</button>`);
    const input = box.querySelector("input");
    input.onclick = () => input.select();
    box.querySelector("#share-copy").onclick = async (e) => {
      try { await navigator.clipboard.writeText(input.value); e.target.textContent = "Copied"; }
      catch { input.select(); }
    };
    box.querySelector("#share-off").onclick = async () => {
      try {
        await api(`/recordings/${id}/shares/${tok}`, { method: "DELETE" });
        render(null, true);
      } catch (e) {
        if (e.message !== "unauthorized") box.querySelector(".share-box")?.insertAdjacentHTML("beforeend", `<p class="bad">Still shared: ${esc(e.message)}</p>`);
      }
    };
  };
  const close = (e) => {
    const pop = box.querySelector(".share-pop[open]");
    if (pop && (e.key === "Escape" || (e.type === "pointerdown" && !pop.contains(e.target)))) pop.open = false;
  };
  document.addEventListener("pointerdown", close);
  document.addEventListener("keydown", close);
  onLeave(() => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); });
  try {
    const { shares } = await api(`/recordings/${id}/shares`);
    render(shares.at(-1)?.token ?? null);
  } catch {
    box.innerHTML = "";
  }
}
