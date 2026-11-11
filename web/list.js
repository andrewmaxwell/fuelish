// The trip list: days of cards (a trip, or an outing of linked trips), each card's driving score
// and gas cost worked out as it scrolls into view, and the day's and week's totals.

// ---------- trip list ----------

async function showList() {
  const live = current();
  const who = Account.whoParam();
  const { recordings, olderMs, since } = await recentRecordings(who);
  if (!live()) return;
  if (!recordings.length) {
    // Someone new: say what happens next, where they are (in the app, or on the web).
    // In the app, say what actually starts a recording on this phone: auto-record might be off.
    let rec = {};
    try { rec = JSON.parse(window.FuelishApp?.recordMode?.() || "{}"); } catch {}
    const how = rec.mode === "auto"
      ? rec.car
        ? `Get in and drive: recording starts by itself when your phone connects to ${esc(rec.car)}, and stops shortly after you park.`
        : `Get in and drive: recording starts by itself a minute or two in, once your phone notices you're driving, and stops shortly after you park.`
      : rec.mode === "manual"
        ? `Before you set off, tap the bar at the bottom, then Start recording. When you get there, tap Stop recording.`
        : `First finish setting up the recorder: tap the bar at the bottom.`;
    app.innerHTML = Account.inApp()
      ? `<div class="empty"><h1>Your first drive goes here</h1><p class="muted">${how}</p><p class="muted">A few minutes after the recording stops, the trip shows up here with its route, cost and mpg. If it hasn't after a while, tap the bar at the bottom: it says what the upload is waiting for.</p></div>`
      : `<div class="empty"><h1>No trips yet</h1><p class="muted">Trips show up here after the Fuelish app on your Android phone records a drive and uploads it.</p>${/Android/i.test(navigator.userAgent) ? "" : `<p class="muted">No app yet? Open this page on your phone and get it from the Account page.</p>`}</div>`;
    return;
  }
  const thisWeek = weekStart(Date.now());
  const wk = totals(recordings.filter((r) => r.startedWallMs >= +thisWeek));

  // Newest first: days, and the outings within each day (an outing belongs to the day it started).
  const groups = [];
  for (const o of outings(recordings).reverse()) {
    const label = dayLabel(o[0].startedWallMs);
    if (groups.at(-1)?.label !== label) groups.push({ label, key: ymd(dayStart(o[0].startedWallMs)), thisWeek: o[0].startedWallMs >= +thisWeek, items: [], keys: [] });
    groups.at(-1).items.push(o);
  }
  // Cards first, so each day knows its cards' score keys for its total.
  for (const g of groups) g.cards = g.items.map((o) => { const l = legsOf(o); return l.length > 1 ? outingCard(o) : tripCard(l[0] ?? o[0]); }).join("");
  for (const g of groups) g.keys = [...g.cards.matchAll(/data-score="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

  app.innerHTML = `
    <div class="list-head">
      <div>
        <h1>Trips</h1>
        <div class="head-links">
          <a class="see-map" href="#/week/${ymd(thisWeek)}">This week on a map →</a>
        </div>
      </div>
      <div class="week">
        <div><b>${wk.trips}</b><span>trips this week</span></div>
        <div><b>${miles(wk.meters)}</b><span>driven</span></div>
        <div><b>${fmtDur(wk.movingMs)}</b><span>behind the wheel</span></div>
        <div data-total-of="${esc(groups.filter((g) => g.thisWeek).flatMap((g) => g.keys).join("|"))}" hidden><b></b><span>on gas</span></div>
      </div>
    </div>
    ${groups.map((g) => {
      const t = totals(g.items.flat());
      return `
      <section class="day"${g.thisWeek ? " data-this-week" : ""}>
        <div class="day-head">
          <h2>${esc(g.label)}</h2>
          ${t.trips ? `<span class="muted">${plural(t.trips, "trip")} · ${miles(t.meters)}<span data-total-of="${esc(g.keys.join("|"))}" hidden> · <b></b> gas</span></span>
          <a href="#/day/${g.key}">Map of the day →</a>` : ""}
        </div>
        <div class="cards">${g.cards}</div>
      </section>`;
    }).join("")}
    ${olderMs != null ? `<div class="list-more">
      <span class="muted">Trips since ${esc(new Date(since).toLocaleDateString(undefined, { month: "long", day: "numeric", ...(new Date(since).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }))}</span>
      <button type="button" class="more-btn" id="older-trips">Show older trips</button>
    </div>` : ""}`;
  document.getElementById("older-trips")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "Loading…";
    reachFurther(who, olderMs);
    // Drawn again in place: the trips above stay where they are on screen.
    leavePage();
    try { await showList(); } catch (e) {
      if (e.message === "unauthorized") return;
      btn.disabled = false;
      btn.textContent = `Couldn't load (${e.message}). Try again`;
    }
  });
  scoreCards(live);
}

// ---------- scores on the cards ----------

// Each card's score and gas cost are worked out from its engine data once the card scrolls into view
// (a few at a time), then remembered in this browser, keyed by the recordings, their last update, what the
// driver's time is worth and SCORE_VERSION (bump it when the score's method changes). Cards without enough engine
// data show no ring and no cost.
const SCORE_VERSION = 4;
const scoreJobs = new Map(); // slot key -> recordings
function slotKey(recs) {
  recs = recs.filter((r) => r.trip || r.routeGaps > 0); // what its page draws and scores
  if (!recs.some(moved)) return null;
  const key = recs.map((r) => `${r.id}@${r.updatedAtMs}${r.towing ? "+tow" : ""}`).join(",");
  scoreJobs.set(key, recs);
  return key;
}
function scoreSlot(recs) {
  const key = slotKey(recs);
  return key ? `<span class="card-score" data-score="${esc(key)}" hidden></span>` : "";
}
// Remembers a slot's figures, unless they'd change: still recording or uploading, or worked out
// without the gas price (it timed out), which leaves the score for gas alone.
function keepScore(key, n) {
  const recs = scoreJobs.get(key) || [];
  if (recs.every((r) => r.complete && r.status !== "recording") && (n == null || n.price != null)) { try { localStorage.setItem(scoreKey(key), JSON.stringify(n)); } catch {} }
}
// Each trip's figures (driveFigures), one trip at a time as its own page would score it: remembered
// ones straight away, the rest two at a time. `onScore(r, figures | null, left)`.
async function scoreEach(recs, live, onScore) {
  const queue = [];
  for (const r of recs) {
    const key = slotKey([r]);
    const known = key ? readScore(key) : null;
    if (known !== undefined) onScore(r, known, 0); else queue.push([r, key]);
  }
  let left = queue.length;
  onScore(null, null, left);
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (queue.length && live()) {
      const [r, key] = queue.shift();
      let n = null;
      try { n = await driveFigures([r]); keepScore(key, n); } catch (e) { if (e.message === "unauthorized") return; }
      left--;
      if (live()) onScore(r, n, left);
    }
  }));
}
// Figures for each card shown so far (null: no engine data), summed into the day and week totals.
const figuresFor = new Map();
// A day's or the week's gas, once every card in it has its figures: elements with data-total-of
// (the cards' score keys, joined by "|") get "$4.20 on gas".
function showTotals() {
  document.querySelectorAll("[data-total-of]").forEach((el) => {
    const keys = el.dataset.totalOf ? el.dataset.totalOf.split("|") : [];
    if (!keys.length || !keys.every((k) => figuresFor.has(k))) return;
    const f = keys.map((k) => figuresFor.get(k));
    const known = f.filter((x) => x?.cost != null);
    if (!known.length) return;
    const missing = f.length - known.length;
    el.hidden = false;
    el.querySelector("b").textContent = `${missing || known.some((x) => x.approx) ? "≈" : ""}${money(known.reduce((a, x) => a + x.cost, 0))}`;
    el.title = missing ? `${plural(missing, "trip")} without engine data ${missing === 1 ? "isn't" : "aren't"} counted` : "";
  });
}
const scoreKey = (key) => `fuelish.score.v${SCORE_VERSION}:${timeFor(scoreJobs.get(key)?.[0])}:${key}`;
function readScore(key) {
  try { const v = localStorage.getItem(scoreKey(key)); return v == null ? undefined : JSON.parse(v); } catch { return undefined; }
}
function showScore(el, f) {
  const n = f?.score;
  const card = el.closest(".trip-card");
  const cost = card?.querySelector(".card-cost"), mpg = card?.querySelector(".card-mpg");
  if (cost && f?.cost != null) {
    cost.hidden = false;
    cost.title = `${f.approx ? "About " : ""}${gallons(f.gal)} gal of gas at ${money(f.price)}/gal, the regional average that week`;
    cost.innerHTML = `<b>${f.approx ? "≈" : ""}${money(f.cost)}</b> gas`;
  }
  if (mpg && f?.mpg != null) {
    mpg.hidden = false;
    mpg.innerHTML = `<b>${f.approx ? "≈" : ""}${f.mpg.toFixed(0)}</b> mpg`;
  }
  figuresFor.set(el.dataset.score, f ?? null);
  showTotals();
  if (n == null) return;
  el.hidden = false;
  el.className = `card-score ${scoreTone(n)}`;
  el.title = `Driving score ${n}`;
  el.innerHTML = `<b>${n}</b><small>score</small>`;
}
function scoreCards(live) {
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < 2 && queue.length) {
      const el = queue.shift(), key = el.dataset.score, recs = scoreJobs.get(key);
      running++;
      driveFigures(recs).then((n) => {
        keepScore(key, n);
        if (live()) showScore(el, n);
      }).catch(() => {}).finally(() => { running--; if (live()) pump(); });
    }
  };
  // Watched through its thumbnail: the ring itself is hidden until there's a score, and a hidden
  // element never comes into view.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); queue.push(en.target.querySelector(".card-score")); }
    pump();
  }, { rootMargin: "300px" });
  // This week's cards are worked out straight away, for the week's total; older ones as they scroll in.
  document.querySelectorAll(".card-score[data-score]").forEach((el) => {
    const known = readScore(el.dataset.score);
    if (known !== undefined) showScore(el, known);
    else if (el.closest("[data-this-week]")) queue.push(el);
    else io.observe(el.parentElement);
  });
  pump();
  onLeave(() => io.disconnect());
}

// Why a trip has no outline: it didn't move, its route is only on the trip page (left out of the
// list's summary), or there's no GPS (yet).
function noRouteLabel(r) {
  if (r.trip) return "Didn't move";
  return r.routeGaps > 0 ? "Route on the trip page" : "No GPS yet";
}

function tripCard(r) {
  const t = r.trip;
  const auto = r.meta.trigger?.startsWith("car_bluetooth") || r.meta.trigger === "driving_detected";
  return `
    <a class="card trip-card" href="#/r/${esc(r.id)}">
      <div class="thumb">${moved(r) ? Charts.thumbnail(t.path, undefined, undefined, null, t.meters) : `<span class="muted">${noRouteLabel(r)}</span>`}${scoreSlot([r])}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(timeRange(r))}</b>${statusPill(r)}</div>
        <div class="muted">${esc(Places.label([r]) ?? tripName(r.startedWallMs))}${auto ? " · auto-started" : ""}</div>
        ${moved(r) ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          <span class="card-mpg" hidden></span>
          <span class="card-cost" hidden></span>
          ${r.routeGaps ? `<span class="muted" title="Part of this trip's route isn't summarized for the list; the trip page has all of it">partial</span>` : ""}
        </div>` : ""}
        ${r.meta.note ? `<div class="note">${esc(r.meta.note)}</div>` : ""}
      </div>
    </a>`;
}

// Several linked trips in one card: a combined outline (stops between them dotted) and totals, with
// the time spent between them, so an out-and-back visit doesn't read as hours of driving. Its page
// lists each trip.
function outingCard(o) {
  const t = totals(o), first = o[0], last = o.at(-1), parked = Outings.parkedMs(o);
  const pill = o.map(statusPill).find(Boolean) ?? "";
  return `
    <a class="card trip-card outing-card" href="#/outing/${esc(first.id)}">
      <div class="thumb">${Charts.thumbnail(o.filter(moved).map((r) => r.trip.path), undefined, undefined, null, o.filter(moved).map((r) => r.trip.meters)) || `<span class="muted">No GPS yet</span>`}${scoreSlot(o)}</div>
      <div class="trip-card-body">
        <div class="trip-card-title"><b>${esc(clock(first.startedWallMs))} – ${esc(clock(endOf(last)))}</b>${pill}</div>
        <div class="muted">${esc(Places.label(o) ?? `${outingName(first.startedWallMs)} · ${plural(legsOf(o).length - 1, "stop")}`)}</div>
        ${t.trips ? `<div class="trip-card-stats">
          <span><b>${miles(t.meters)}</b></span>
          <span><b>${fmtDur(t.movingMs)}</b> moving</span>
          ${parked >= 60000 ? `<span><b>${fmtDur(parked)}</b> parked</span>` : ""}
          <span class="card-mpg" hidden></span>
          <span class="card-cost" hidden></span>
          ${o.some((x) => x.routeGaps) ? `<span class="muted" title="Part of this outing's route isn't summarized for the list; each trip's page has all of it">partial</span>` : ""}
        </div>` : ""}
      </div>
    </a>`;
}

// The driving score and gas cost of recordings taken as one drive, worked out the same way as on
// their page: { score, gal, mpg, price, cost, approx } (approx: fuel readings don't cover all of it), or
// null without enough engine data.
async function driveFigures(recs) {
  const d = await loadDrive(recs);
  if (!d.rows.length || d.pts.length < 2) return null;
  const vehicle = recs[0].meta.vehicle ?? "", towing = recs.some((r) => r.towing);
  const e = Engine.summary(d.rows, { vehicle, towing, tripMiles: Route.summary(d.pts).miles, tripMs: d.drivingMs });
  const gal = e.galTrip ?? e.gal, start = recs.find((r) => r.trip?.path?.length)?.trip.path[0];
  const gas = gal != null ? await withTimeout(Gas.forTrip(start?.[0], start?.[1], recs[0].startedWallMs), 8000) : null;
  Engine.attach(d.pts, d.rows);
  const score = idealFor(d.pts, { e, vehicle, towing, price: gas?.price ?? null, timePerHour: gas ? timeFor(recs[0]) : 0 })?.score ?? null;
  return {
    score, gal, mpg: e.mpg ?? null, price: gas?.price ?? null,
    cost: gas ? gal * gas.price : null,
    approx: e.coverage < 0.95 || !!e.extrapolated,
  };
}

// The colored ring around a score: green from 90, amber from 75, red below.
const scoreTone = (n) => (n >= 90 ? "good" : n >= 75 ? "ok" : "low");
