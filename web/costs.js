// What driving costs, counting more than gas: your time, wear on the car, mileage-driven loss of
// value, and the carbon it emits. Every assumption is editable on the Costs page and saved on the
// server (prefs "costs"), so they're the same in any browser.
//
// Per trip:   fuel     gallons (measured, see Engine.summary) × that week's regional gas price
//             time     door-to-door minutes × your value of time
//             wear     miles × maintenance, repairs and tires per mile
//             value    miles × depreciation per mile (the part of a car's loss of value driving causes)
//             carbon   gallons × kg CO2 per gallon × social cost of carbon
//             other    miles × anything else per mile (pay-per-mile insurance, say)
// "Out of pocket" is fuel + wear + value + other: what the car costs you in money.

const Costs = (() => {
  const DEFAULTS = {
    timePerHour: 20, // $ per hour of your time: a personal choice; 0 leaves time out
    wearPerMile: 0.1, // maintenance, repairs and tires (AAA "Your Driving Costs" puts small sedans near 10¢/mi)
    valuePerMile: 0.08, // depreciation from miles driven, beyond what age alone costs
    co2KgPerGal: 8.89, // EPA: CO2 from burning a gallon of gasoline
    carbonPerTonne: 190, // EPA 2023 social cost of carbon, $/t CO2
    otherPerMile: 0,
  };
  const FIELDS = [
    ["timePerHour", "Your time", "$ per hour", "What an hour behind the wheel is worth to you. Set 0 to leave time out."],
    ["wearPerMile", "Wear and repairs", "$ per mile", "Maintenance, repairs and tires. AAA's yearly estimate for a small sedan is near 10¢ a mile."],
    ["valuePerMile", "Lost resale value", "$ per mile", "How much each mile lowers what the car is worth, beyond what its age does anyway."],
    ["co2KgPerGal", "CO₂ per gallon", "kg", "EPA: 8.89 kg of CO₂ for each gallon of gasoline burned."],
    ["carbonPerTonne", "Cost of carbon", "$ per tonne CO₂", "The harm a tonne of CO₂ does, in dollars. EPA's 2023 estimate is $190. Set 0 to leave it out."],
    ["otherPerMile", "Anything else", "$ per mile", "Pay-per-mile insurance, tolls you always pay, and so on."],
  ];
  let settings = { ...DEFAULTS };
  const get = () => settings;
  function use(saved) {
    settings = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(saved?.[k]) && saved[k] >= 0) settings[k] = saved[k];
  }

  /**
   * Cost of one trip. `gal` may be null (no engine data): fuel is then left out unless `mpgGuess`
   * (miles per gallon from other drives) is given, in which case it's estimated and marked.
   */
  function trip({ minutes, miles, gal, price, mpgGuess = null }, s = settings) {
    let fuelGal = gal, estimated = false;
    if (fuelGal == null && mpgGuess > 0) { fuelGal = miles / mpgGuess; estimated = true; }
    const items = [
      { key: "fuel", label: "Gas", amount: fuelGal != null && price != null ? fuelGal * price : null, note: fuelGal != null ? `${fmtGal(fuelGal)} gal${price != null ? ` at ${money(price)}` : ""}${estimated ? ", estimated" : ""}` : "no engine data" },
      { key: "time", label: "Your time", amount: (minutes / 60) * s.timePerHour, note: `${fmtMin(minutes)} at ${money(s.timePerHour)}/h` },
      { key: "wear", label: "Wear and repairs", amount: miles * s.wearPerMile, note: `${miles.toFixed(1)} mi at ${cents(s.wearPerMile)}/mi` },
      { key: "value", label: "Lost resale value", amount: miles * s.valuePerMile, note: `${cents(s.valuePerMile)}/mi` },
      { key: "carbon", label: "Carbon", amount: fuelGal != null ? (fuelGal * s.co2KgPerGal / 1000) * s.carbonPerTonne : null, note: fuelGal != null ? `${(fuelGal * s.co2KgPerGal).toFixed(1)} kg CO₂` : "" },
      { key: "other", label: "Other", amount: miles * s.otherPerMile, note: `${cents(s.otherPerMile)}/mi` },
    ].filter((i) => i.key !== "other" || s.otherPerMile > 0);
    const sum = (keys) => items.filter((i) => keys.includes(i.key) && i.amount != null).reduce((n, i) => n + i.amount, 0);
    const total = sum(["fuel", "time", "wear", "value", "carbon", "other"]);
    return {
      items,
      total,
      pocket: sum(["fuel", "wear", "value", "other"]),
      perMile: miles > 0.05 ? total / miles : null,
      co2Kg: fuelGal != null ? fuelGal * s.co2KgPerGal : null,
      fuelKnown: fuelGal != null && price != null,
      estimated,
    };
  }

  /** Cost per mile of steady driving at `mph` that uses `galPerMile`, at gas `price`. */
  function perMileAt(mph, galPerMile, price, s = settings) {
    const fuel = galPerMile * price;
    const time = s.timePerHour / mph;
    const car = s.wearPerMile + s.valuePerMile + s.otherPerMile;
    const carbon = galPerMile * s.co2KgPerGal / 1000 * s.carbonPerTonne;
    return { fuel, time, car, carbon, total: fuel + time + car + carbon };
  }

  const money = (d) => (d == null ? "–" : Math.abs(d) < 10 ? "$" + d.toFixed(2) : "$" + Math.round(d).toLocaleString());
  const cents = (d) => (d < 1 ? `${+(d * 100).toFixed(1)}¢` : money(d));
  const fmtGal = (g) => (g < 0.1 ? g.toFixed(3) : g < 10 ? g.toFixed(2) : g.toFixed(1));
  const fmtMin = (m) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // A stacked bar of the parts and a list, for a trip's side panel or a total.
  function breakdownHtml(c) {
    const parts = c.items.filter((i) => i.amount > 0);
    const total = parts.reduce((n, i) => n + i.amount, 0) || 1;
    return `<div class="cost-bar" role="img" aria-label="What the trip cost, by part">${parts.map((i) => `<i class="c-${i.key}" style="width:${(i.amount / total) * 100}%"></i>`).join("")}</div>
      <dl class="waste-list cost-list">${c.items.map((i) => `
        <div><dt><i class="sw c-${i.key}"></i>${esc(i.label)}<small>${esc(i.note)}</small></dt><dd>${i.amount == null ? "–" : money(i.amount)}</dd></div>`).join("")}</dl>`;
  }

  /** The trip page's cost section. */
  function tripPanel(host, { trip: r, sm, e, gas }) {
    if (!host) return;
    const end = r.driveEndWallMs ?? r.endedWallMs ?? r.updatedAtMs;
    const minutes = Math.max(0, (end - r.startedWallMs) / 60000);
    const c = trip({ minutes, miles: sm.miles, gal: e.galTrip ?? e.gal, price: gas?.price ?? null });
    host.hidden = false;
    host.innerHTML = `<h2>What it cost <span>${money(c.total)} all in · ${money(c.pocket)} out of pocket${c.perMile ? ` · ${money(c.perMile)}/mi` : ""}</span></h2>
      ${breakdownHtml(c)}
      ${!c.fuelKnown ? `<p class="hint">Gas isn't counted yet: ${gas ? "no fuel readings" : "the gas price hasn't loaded"}.</p>` : ""}
      <p class="hint">Time is door to door. <a href="#/costs">Change what time, wear and carbon are worth →</a></p>`;
  }

  // ---------- the Costs page: totals, the cheapest steady speed, idling, cold starts ----------

  const MPH = 0.621371;
  // Match the .c-* swatches in style.css.
  const COLORS = { fuel: "#2a78d6", time: "#e8b931", wear: "#8f8d86", carbon: "#0ca30c" };
  const galOf = (g) => g / 745 / 3.78541;

  // Seconds of steady driving (speed changing under ~0.015 g, at least 10 mph), binned by speed:
  // miles, gallons and seconds in each 1-mph bin.
  function steadyBins(trips) {
    const bins = new Map();
    for (const { rows } of trips) {
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i], dt = (b.t - a.t) / 1000;
        if (dt <= 0 || dt > 1.5 || a.speed == null || b.speed == null || b.fuelGs == null) continue;
        const mph = b.speed * MPH;
        if (mph < 10 || Math.abs(b.speed - a.speed) / 3.6 / dt > 0.15) continue;
        const k = Math.round(mph);
        const x = bins.get(k) || bins.set(k, { mph: k, miles: 0, gal: 0, secs: 0 }).get(k);
        x.miles += (b.speed / 3.6) * dt / 1609.344;
        x.gal += galOf(b.fuelGs * dt);
        x.secs += dt;
      }
    }
    return [...bins.values()].sort((u, v) => u.mph - v.mph);
  }

  // Gallons per mile at each speed, smoothed over ±3 mph; only where at least a minute backs it.
  function galPerMileCurve(bins) {
    if (!bins.length) return [];
    const out = [];
    for (let v = bins[0].mph; v <= bins.at(-1).mph; v++) {
      let m = 0, g = 0, n = 0;
      for (const b of bins) {
        const d = (b.mph - v) / 3;
        if (Math.abs(d) > 2.5) continue;
        const w = Math.exp(-0.5 * d * d);
        m += w * b.miles; g += w * b.gal;
        if (Math.abs(b.mph - v) <= 3) n += b.secs;
      }
      if (m > 0 && g > 0 && n >= 60) out.push({ mph: v, gpm: g / m, secs: n });
    }
    return out;
  }

  // Warm-engine fuel flow by 5-mph speed bin (0 = idling), to measure what a cold engine burns extra.
  function coldStarts(trips) {
    const base = new Map();
    const bin = (r) => (r.speed === 0 ? 0 : 1 + Math.floor((r.speed * MPH) / 5));
    for (const { rows } of trips) for (const r of rows) {
      if (r.coolant == null || r.coolant < 80 || r.fuelGs == null || r.speed == null || r.rpm < 300) continue;
      const b = base.get(bin(r)) || base.set(bin(r), [0, 0]).get(bin(r));
      b[0] += r.fuelGs; b[1]++;
    }
    const cold = [];
    for (const t of trips) {
      const rows = t.rows, first = rows.find((r) => r.coolant != null);
      if (!first || first.coolant >= 50) continue;
      let extraG = 0, warmAt = null;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i], dt = (r.t - rows[i - 1].t) / 1000;
        if (r.coolant != null && r.coolant >= 80) { warmAt = r.t; break; }
        if (dt <= 0 || dt > 2.5 || r.fuelGs == null || r.speed == null) continue;
        const b = base.get(bin(r));
        if (b && b[1] >= 30) extraG += (r.fuelGs - b[0] / b[1]) * dt;
      }
      if (warmAt) cold.push({ t, extraGal: Math.max(0, galOf(extraG)), warmMs: warmAt - rows[0].t, price: t.gas?.price });
    }
    return cold;
  }

  function median(xs) {
    const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : null;
  }

  /**
   * The Costs page. `trips`: [{ r, rows, gas }] (every drive with engine data); `durationOf(r)` gives
   * door-to-door ms; `save(settings)` stores edited assumptions.
   */
  function page(host, trips, { durationOf, save, otherTrips = 0 }) {
    const price = trips.findLast((t) => t.gas)?.gas.price ?? null;
    const summaries = trips.map((t) => ({ t, e: Engine.summary(t.rows, { vehicle: t.r.meta.vehicle }) }));
    host.innerHTML = `
      <section class="ins-sec">
        <h2>What you count</h2>
        <p class="lede">Gas comes from the engine and that week's prices. Everything else is an assumption: set it to what it's worth to you. It's saved for every browser.</p>
        <form class="cost-form" id="cost-form">${FIELDS.map(([k, label, unit, help]) => `
          <label><span>${esc(label)}</span><span class="cost-input"><input type="number" min="0" step="any" inputmode="decimal" name="${k}" value="${settings[k]}"><small>${esc(unit)}</small></span><small class="hint">${esc(help)}</small></label>`).join("")}
          <button type="button" class="ghost" id="cost-reset">Back to defaults</button>
        </form>
      </section>
      <section class="ins-sec" id="cost-totals"></section>
      <section class="ins-sec">
        <h2>The cheapest steady speed</h2>
        <p class="lede">Cost of each mile of steady driving at each speed, from your own fuel use while holding a speed. Faster costs more gas per mile but less of your time; wear and lost value are the same per mile at any speed.</p>
        <div id="cost-speed" class="chart-host"></div>
        <p class="hint" id="cost-speed-note"></p>
      </section>
      <section class="ins-sec" id="cost-idle"></section>
      <section class="ins-sec" id="cost-cold"></section>
      <section class="ins-sec">
        <h2>Which way to go</h2>
        <p class="lede">For trips you make again and again, <a href="#/routes">Repeated trips</a> ranks every run, and compares the different ways you've driven them by gas, time and total cost.</p>
      </section>`;

    const bins = steadyBins(trips);
    const gpm = galPerMileCurve(bins);
    const cold = coldStarts(trips);
    const idleRows = trips.flatMap((t) => t.rows.filter((r) => r.speed === 0 && r.rpm > 300 && r.coolant >= 75 && r.gph != null));
    const idleGph = median(idleRows.map((r) => r.gph));

    function render() {
      // Totals over every drive with engine data.
      let sum = { minutes: 0, miles: 0 }, parts = {};
      for (const { t, e } of summaries) {
        const c = trip({ minutes: durationOf(t.r) / 60000, miles: e.miles, gal: e.galTrip ?? e.gal, price: t.gas?.price ?? price });
        sum.minutes += durationOf(t.r) / 60000;
        sum.miles += e.miles;
        for (const i of c.items) {
          const p = parts[i.key] || (parts[i.key] = { ...i, amount: 0 });
          if (i.amount != null) p.amount += i.amount;
        }
      }
      const items = Object.values(parts);
      const total = items.reduce((n, i) => n + i.amount, 0), pocket = items.filter((i) => ["fuel", "wear", "value", "other"].includes(i.key)).reduce((n, i) => n + i.amount, 0);
      const noteFor = { fuel: "measured", time: fmtMin(sum.minutes), wear: `${sum.miles.toFixed(0)} mi`, value: "", carbon: "", other: "" };
      items.forEach((i) => (i.note = noteFor[i.key] ?? ""));
      const fig = (v, l) => `<div class="fig"><b>${v}</b><span>${esc(l)}</span></div>`;
      host.querySelector("#cost-totals").innerHTML = `
        <h2>All your drives with engine data</h2>
        <p class="lede">${trips.length} drive${trips.length === 1 ? "" : "s"}${otherTrips ? `; ${otherTrips} without engine data aren't counted` : ""}.</p>
        <div class="figs">${fig(money(total), "all in")}${fig(money(pocket), "out of pocket")}${fig(sum.miles > 0 ? money(total / sum.miles) : "–", "per mile, all in")}${fig(sum.miles > 0 ? money(pocket / sum.miles) : "–", "per mile, out of pocket")}</div>
        ${breakdownHtml({ items })}`;

      // Cost per mile by steady speed.
      const note = host.querySelector("#cost-speed-note");
      if (gpm.length < 3 || price == null) {
        host.querySelector("#cost-speed").innerHTML = `<p class="hint">Not enough steady driving yet (at least a minute at each speed), or no gas price.</p>`;
        note.textContent = "";
      } else {
        const rows = gpm.map((g) => ({ mph: g.mph, ...perMileAt(g.mph, g.gpm, price) }));
        const best = rows.reduce((a, b) => (b.total < a.total ? b : a));
        const bestFuel = rows.reduce((a, b) => (b.fuel < a.fuel ? b : a));
        // Same colors as the cost bar above; the total in the text color, heavier.
        const s = (k, label, color, extra = {}) => ({ label, cls: "s4", color, pts: rows.map((r) => [r.mph, r[k]]), ...extra });
        Plot.lines(host.querySelector("#cost-speed"), [
          s("total", "Total", "var(--text)", { width: 3 }), s("fuel", "Gas", COLORS.fuel), s("time", "Your time", COLORS.time), s("car", "Wear and value", COLORS.wear), s("carbon", "Carbon", COLORS.carbon),
        ], {
          xUnit: " mph", yUnit: " $/mi", yFmt: (v) => (v < 1 ? `${Math.round(v * 100)}¢` : "$" + v.toFixed(2)), aria: "Cost per mile by steady speed",
          marks: [{ x: best.mph, y: best.total, label: `cheapest overall ${best.mph} mph` }, ...(bestFuel.mph !== best.mph ? [{ x: bestFuel.mph, y: bestFuel.fuel, label: `least gas ${bestFuel.mph} mph`, row: 1, cls: "s2" }] : [])],
        });
        const top = rows.at(-1), low = rows[0];
        // At the edge of the data the real minimum may lie beyond it: say so rather than call it the best.
        const where = (r) => (r === top ? `at ${r.mph} mph or faster (the fastest you've held steady long enough to measure)` : r === low ? `at ${r.mph} mph or slower (the slowest measured)` : `around ${r.mph} mph`);
        note.textContent = settings.timePerHour > 0
          ? `With your time at ${money(settings.timePerHour)}/h, steady driving is cheapest ${where(best)}, ${cents(best.total)} a mile. Gas alone is cheapest ${where(bestFuel)}, ${cents(bestFuel.fuel)} a mile${top !== bestFuel ? `; at ${top.mph} mph it's ${cents(top.fuel)}` : ""}. Speed limits and traffic come first, of course: this is only what each choice costs.`
          : `Counting gas, wear and carbon only, steady driving is cheapest ${where(best)}, ${cents(best.total)} a mile.`;
      }

      // Idling.
      const idleTotal = summaries.reduce((n, { t, e }) => n + (e.fuelUse ? e.fuelUse.idle * (t.gas?.price ?? price ?? 0) : 0), 0);
      const idleMin = summaries.reduce((n, { e }) => n + e.idleMs / 60000, 0);
      host.querySelector("#cost-idle").innerHTML = `<h2>Idling</h2>
        ${idleGph != null && price != null ? `<p class="lede">Warmed up, the engine burns about ${idleGph.toFixed(2)} gal an hour at a standstill: ${cents((idleGph * price) / 60)} a minute in gas, ${money(idleGph * price)} an hour.
          You've idled ${fmtMin(idleMin)} in these drives, about ${money(idleTotal)} of gas. Counting your time too, a minute stopped costs ${cents((idleGph * price) / 60 + settings.timePerHour / 60)}.</p>
          <p class="hint">A rule of thumb from Argonne National Laboratory: switching the engine off for stops longer than about 10 seconds saves more fuel than the restart uses.</p>`
          : `<p class="lede">Not enough warm idling recorded yet.</p>`}`;

      // Cold starts.
      const c = host.querySelector("#cost-cold");
      if (cold.length) {
        const extra = median(cold.map((x) => x.extraGal)), warm = median(cold.map((x) => x.warmMs));
        const each = extra * (price ?? 0);
        c.innerHTML = `<h2>Cold starts</h2>
          <p class="lede">From a cold engine, warming up takes about ${fmtMin(warm / 60000)} and burns about ${extra.toFixed(3)} gal more than the same driving warm${price != null ? `: ${cents(each)} each time` : ""} (median of ${cold.length} cold start${cold.length === 1 ? "" : "s"}).
          Errands chained into one outing pay this once; separate trips hours apart pay it each time.</p>`;
      } else c.innerHTML = `<h2>Cold starts</h2><p class="lede">No cold starts with coolant readings yet.</p>`;
    }
    render();

    const form = host.querySelector("#cost-form");
    let timer = 0;
    form.addEventListener("input", () => {
      const next = { ...settings };
      for (const [k] of FIELDS) {
        const v = parseFloat(form.elements[k].value);
        if (Number.isFinite(v) && v >= 0) next[k] = v;
      }
      use(next);
      render();
      clearTimeout(timer);
      timer = setTimeout(() => save(settings), 600);
    });
    host.querySelector("#cost-reset").onclick = () => {
      use({});
      for (const [k] of FIELDS) form.elements[k].value = settings[k];
      render();
      save(settings);
    };
  }

  return { DEFAULTS, FIELDS, get, use, trip, perMileAt, breakdownHtml, tripPanel, page, money, cents, steadyBins, galPerMileCurve, coldStarts };
})();
