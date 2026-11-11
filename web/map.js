// The map of a drive (or several), its views, legend and readout, shared by the trip, outing, day
// and week pages; and how small amounts of fuel and money are written.

// Small amounts of fuel and money need more digits than big ones.
const gallons = (g) => (g < 0.1 ? g.toFixed(3) : g < 10 ? g.toFixed(2) : g.toFixed(1));
const money = (d) => (d < 10 ? "$" + d.toFixed(2) : "$" + Math.round(d).toLocaleString());
// Amounts compared with each other on a short trip: under a dollar, cents with a decimal ("23.6¢"),
// so "23.6¢ against 22.1¢" doesn't read as "$0.24 against $0.22, 7% more".
const smallMoney = (d) => (Math.abs(d) < 0.995 ? `${(d * 100).toFixed(1)}¢` : money(d));
// The score's own gallons (measured, gaps filled from its fit) against the headline's: the factor that
// puts the score's amounts on the headline's gallons. Left at 1 when they disagree by more than a little.
const coachScale = (shownGal, scoredGal) => {
  const k = shownGal > 0 && scoredGal > 0 ? shownGal / scoredGal : 1;
  return k > 0.85 && k < 1.18 ? k : 1;
};

// ---------- map, charts and controls (shared) ----------

function drawRoute(pts, sm, { withDay = false } = {}) {
  // `view` is the saved choice; none saved yet means Spend on drives with engine data, else Speed.
  // (A choice of the old default, Cost, saved before Spend existed moves to the new default once.)
  // `marks`: ticks across the route every minute ("min"), every so much gas ("gas"), or none ("off").
  let state = { view: null, labels: true, marks: "min" };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}");
    const old = saved.view === "cost" && !saved.spend;
    state = { view: Route.VIEWS[saved.view] && !old ? saved.view : null, labels: saved.labels ?? true, marks: ["min", "gas", "off"].includes(saved.marks) ? saved.marks : "min" };
  } catch {}
  // One drive's readout says how far into it a moment is; marks count on through every trip shown.
  const oneTrip = Route.tripRanges(pts).length === 1;
  let price = null;
  // The Spend view: gas split by cause (ribbon.js), drawn as a band beside the route; `ribbonOnly`
  // is the one cause shown alone (null: all).
  let ribbon = null, ribbonLayer = null, ribbonOnly = null, ribbonOpts = null, terrain = null;
  // Grades come from elevation tiles a moment later; the band is split again with them.
  const splitRibbon = () => { if (ribbonOpts) ribbon = Ribbon.decompose(pts, ribbonOpts); };

  // What's drawn: the chosen view, except engine views on a drive without engine data.
  let hasEngine = false;
  const shownState = {};
  const effective = () => {
    const want = state.view ?? (hasEngine ? "spend" : "speed");
    const view = Route.VIEWS[want].engine && !hasEngine ? "speed" : want;
    const marks = state.marks === "gas" && !hasEngine ? "min" : state.marks;
    return Object.assign(shownState, { view, color: Route.VIEWS[view].color, width: "none", labels: state.labels, marks });
  };
  effective();

  const readout = document.getElementById("readout");
  const fmt = (x, d, u) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d) + u);
  let views = [];
  const pick = (i) => {
    for (const v of views) v.highlight(i);
    if (i < 0) { readout.hidden = true; return; }
    const p = pts[i];
    readout.hidden = false;
    readout.innerHTML = `
      <div class="readout-time">${new Date(p.t).toLocaleString([], { weekday: withDay ? "short" : undefined, hour: "numeric", minute: "2-digit", second: "2-digit" })}${oneTrip ? ` · ${Math.floor((p.t - pts[0].t) / 60000)} min in` : ""}</div>
      <div class="readout-speed">${fmt(p.v != null ? p.v * Route.MPH : null, 0, "")}<small> mph</small></div>
      <dl>
        <dt>${p.a == null ? "Accel" : p.a < 0 ? "Braking" : "Speeding up"}</dt><dd>${fmt(p.a != null ? Math.abs(p.a) / Route.G : null, 2, " g")}</dd>
        <dt>Turning</dt><dd>${fmt(p.side != null ? Math.abs(p.side) / Route.G : null, 2, " g")}${p.side != null && Math.abs(p.side) / Route.G >= 0.03 ? (p.side > 0 ? " right" : " left") : ""}</dd>
        ${p.eng ? `<dt>Gas pedal</dt><dd>${fmt(p.eng.pedal, 0, "%")}</dd>
        <dt>Economy</dt><dd>${p.eng.mpg == null ? "–" : p.eng.mpg >= 99 ? "coasting" : fmt(p.eng.mpg, 0, " mpg")}</dd>
        ${p.eng.rel != null ? `<dt>Fuel/mi, 20 s</dt><dd>${esc(Route.METRICS.cost.fmt(p.eng.rel))}${Math.abs(p.eng.rel - 1) >= 0.005 ? " than usual" : ""}</dd>` : ""}
        <dt>Fuel</dt><dd>${p.eng.cut ? "cut off" : fmt(p.eng.gph, 2, " gal/h")}</dd>
        <dt>RPM</dt><dd>${fmt(p.eng.rpm, 0, "")}</dd>` : ""}
        ${ribbon && shownState.view === "spend" ? Ribbon.readoutHtml(ribbon, i, price) : ""}
      </dl>`;
  };

  const mapEl = document.getElementById("map");
  const view = Route.render(mapEl, pts, shownState, pick);
  const friction = Charts.frictionCircle(document.getElementById("friction"), pts, pick);
  views = [{ highlight: (i) => view.mark(i) }, friction];

  const pk = sm.peak;
  document.getElementById("peaks-sum").textContent = friction.count ? `${Math.max(Math.abs(pk.brake), pk.accel, pk.corner).toFixed(2)} g peak` : "";
  document.getElementById("peaks").innerHTML = friction.count
    ? `<div><span>Braking</span><b>${Math.abs(pk.brake).toFixed(2)} g</b></div><div><span>Speeding up</span><b>${pk.accel.toFixed(2)} g</b></div><div><span>Turning</span><b>${pk.corner.toFixed(2)} g</b></div>`
    : `<p class="muted">Not enough moving GPS fixes here.</p>`;

  // Ticks: a minute apart (wide on the highway, bunched in town, stacked at stops) or a few cents
  // of gas apart (wide where the car sips, bunched on climbs and hard starts). Every fifth is longer
  // and labeled.
  let gasStep = null;
  const drawMarks = () => {
    gasStep = null;
    if (shownState.marks === "min") {
      view.ticks(Route.minuteMarks(pts).map((m) => ({ ...m, major: m.n % 5 === 0, label: `${m.n}` })));
    } else if (shownState.marks === "gas") {
      const g = Route.gasMarks(pts, price);
      gasStep = g && { step: g.step, unit: g.unit };
      const lab = (v) => (g.unit === "$" ? (v < 1 ? `${Math.round(v * 100)}¢` : `$${Number.isInteger(+v.toFixed(2)) ? Math.round(v) : v.toFixed(2)}`) : `${+v.toFixed(3)} gal`);
      view.ticks(g ? g.marks.map((m) => ({ ...m, major: m.n % 5 === 0, label: lab(m.n * g.step) })) : []);
    } else view.ticks([]);
  };
  const stepName = (g) => (g.unit === "$" ? (g.step < 1 ? `${Math.round(g.step * 100)}¢` : "$1") : `${g.step} gal`);
  const marksSwitch = () => {
    const every = shownState.marks === "min" ? "Every minute" : gasStep ? `Every ${stepName(gasStep)} of gas` : "";
    const opts = [["min", "Minutes"], ...(hasEngine ? [["gas", "Gas"]] : []), ["off", "Off"]];
    return `<div class="marks-switch">${every ? `<span class="marks-key"><i></i>${esc(every)}</span>` : ""}<div class="seg marks" role="group" aria-label="Marks along the route">${opts.map(([k, l]) =>
      `<button type="button" data-marks="${k}" aria-pressed="${shownState.marks === k}">${l}</button>`).join("")}</div></div>`;
  };
  const legend = () => {
    document.getElementById("rt-legend").innerHTML =
      (shownState.view === "spend" && ribbon ? Ribbon.legendHtml(ribbon, price, ribbonOnly) : Route.legendHtml(shownState, pts)) + marksSwitch();
  };
  // The band shows only on the Spend view, over the plain route.
  const syncRibbon = () => {
    if (shownState.view === "spend" && ribbon) {
      if (!ribbonLayer) ribbonLayer = Ribbon.layer(ribbon);
      else ribbonLayer.setData(ribbon);
      if (!view.map.hasLayer(ribbonLayer)) ribbonLayer.addTo(view.map);
    } else if (ribbonLayer) ribbonLayer.remove();
  };
  document.getElementById("rt-legend").addEventListener("click", (e) => {
    const c = e.target.closest("[data-cause]");
    if (c) {
      ribbonOnly = ribbonOnly === c.dataset.cause ? null : c.dataset.cause;
      ribbonLayer?.only(ribbonOnly);
      legend();
      return;
    }
    const b = e.target.closest("[data-marks]");
    if (!b) return;
    state.marks = b.dataset.marks;
    effective(); drawMarks(); legend(); save();
  });
  const recolor = () => { effective(); view.redraw(); syncRibbon(); drawMarks(); legend(); };
  // Notable moments, labeled on the map (again with engine ones once that data is in).
  view.moments(momentsFor(pts, sm));
  const labels = document.getElementById("moments-toggle");
  const syncLabels = () => { labels.setAttribute("aria-pressed", String(!!state.labels)); view.showMoments(!!state.labels); };
  labels.onclick = () => { state.labels = !state.labels; syncLabels(); save(); };
  syncLabels();
  const save = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...state, spend: true })); } catch {} };
  const syncButtons = () => document.querySelectorAll(".map-controls .seg").forEach((g) =>
    g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(shownState[g.dataset.key] === b.dataset.v))));
  document.querySelectorAll(".map-controls .seg").forEach((g) => g.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[g.dataset.key] = b.dataset.v;
    recolor();
    syncButtons();
    save();
  }));
  syncButtons();
  recolor();
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", recolor);
  // The map's container changes size with the layout (e.g. rotating a phone).
  const ro = new ResizeObserver(() => view.map.invalidateSize());
  ro.observe(mapEl);
  onLeave(() => { mq.removeEventListener("change", recolor); ro.disconnect(); view.map.remove(); });

  // Engine data arrives with the route, or later for older drives read from raw chunks.
  function setEngine(rows, { partial = false, gas = null, vehicle = "", towing = false, trip = null } = {}) {
    if (!rows.length || !document.getElementById("map")) return;
    Engine.attach(pts, Engine.relCost(Engine.smoothMpg(rows)));
    hasEngine = true;
    price = gas?.price ?? null;
    ribbonOpts = { vehicle, towing };
    splitRibbon();
    terrain ||= Terrain.attach(pts).then((n) => {
      if (!n || !document.getElementById("map")) return;
      splitRibbon();
      syncRibbon();
      legend();
    }).catch(() => {});
    document.querySelectorAll("[data-engine]").forEach((b) => { b.hidden = false; });
    recolor();
    syncButtons();
    view.moments(momentsFor(pts, sm));
    // Coverage is against the whole drive: its GPS miles, and for one trip its door-to-door time.
    const scope = { tripMiles: sm.miles, tripMs: trip ? endOf(trip) - trip.startedWallMs : null };
    // Coaching and the score need `trip`: one recording, or several taken as one drive.
    const coach = trip ? { pts, focus: (i) => { view.map.setView([pts[i].lat, pts[i].lon], Math.max(view.map.getZoom(), 16)); pick(i); } } : null;
    sideEngine(sm, Engine.summary(rows, { vehicle, towing, ...scope }), { gas, partial, trip, vehicle, towing, coach });
  }

  return { ...view, setEngine, pick };
}
