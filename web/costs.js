// What driving costs, counting more than gas: your time, wear on the car, mileage-driven loss of
// value, and the carbon it emits. Every assumption is editable on the Costs page and saved on the
// server, so they're the same in any browser:
//   prefs "people"    { <user id>: { timePerHour } }: each person's own time
//   prefs "vehicles"  { <vehicle name>: { wearPerMile, valuePerMile, otherPerMile } }: each vehicle's
//                     per-mile costs (a truck wears faster and loses more value a mile than a sedan)
//   prefs "costs"     carbon (the same for everyone), and the starting values for anyone or any
//                     vehicle without their own (from before these were split)
// A trip is costed with its driver's time and its vehicle's per-mile costs (forTrip).
//
// Per trip:   fuel     gallons (from the engine: car-reported or an airflow estimate, see
//                      Engine.summary) × that week's regional average gas price
//             time     door-to-door minutes × your value of time
//             wear     miles × maintenance, repairs and tires per mile
//             value    miles × depreciation per mile (the part of a car's loss of value driving causes)
//             carbon   gallons × kg CO2 per gallon × social cost of carbon
//             other    miles × anything else per mile (pay-per-mile insurance, say)
// "Car costs" is fuel + wear + value + other: what the car costs you in money, sooner (gas) or later
// (repairs, a lower resale price). "All in" adds your time and carbon.

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
  const PERSON = ["timePerHour"];
  const VEHICLE = ["wearPerMile", "valuePerMile", "otherPerMile"];
  const SHARED = ["co2KgPerGal", "carbonPerTonne"];
  // A pickup's starting point (AAA "Your Driving Costs", half-ton pickups): more in tires, brakes and
  // repairs a mile, and more value lost to each mile, than a small sedan.
  const TRUCK = { wearPerMile: 0.13, valuePerMile: 0.11, otherPerMile: 0 };
  let settings = { ...DEFAULTS }; // the shared "costs" value, with defaults filled in
  let vehicles = {}, people = {};
  const get = () => settings;
  const ok = (x) => Number.isFinite(x) && x >= 0;
  function use(saved, savedVehicles = {}, savedPeople = {}) {
    settings = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (ok(saved?.[k])) settings[k] = saved[k];
    vehicles = savedVehicles && typeof savedVehicles === "object" ? savedVehicles : {};
    people = savedPeople && typeof savedPeople === "object" ? savedPeople : {};
  }
  const vehicleName = (r) => (r?.meta?.vehicle || "").trim();
  /** The per-mile costs for a vehicle: its own, else a truck's or the shared starting values. */
  function vehicleCosts(name) {
    const base = Engine.physics.isTruck(name) ? TRUCK : settings;
    const own = vehicles[name] || {};
    return Object.fromEntries(VEHICLE.map((k) => [k, ok(own[k]) ? own[k] : base[k]]));
  }
  /** A person's time: their own, else the shared starting value. */
  const personTime = (id) => (ok(people[id]?.timePerHour) ? people[id].timePerHour : settings.timePerHour);
  /** The settings one trip is costed with: its driver's time, its vehicle's per-mile costs, shared carbon. */
  const forTrip = (r) => ({ ...settings, timePerHour: personTime(r?.userId), ...vehicleCosts(vehicleName(r)) });

  /**
   * Cost of one trip. `gal` may be null (no engine data): fuel is then left out unless `mpgGuess`
   * (miles per gallon from other drives) is given, in which case it's guessed and marked.
   * `fuelSource` ("car" / "airflow") and `extrapolated` (part of `gal` was filled in at the drive's
   * own mpg) are carried into the note and the `estimated` flag.
   */
  function trip({ minutes, miles, gal, price, mpgGuess = null, fuelSource = "airflow", extrapolated = false }, s = settings) {
    let fuelGal = gal, guessed = false;
    if (fuelGal == null && mpgGuess > 0) { fuelGal = miles / mpgGuess; guessed = true; }
    const how = guessed ? "guessed at this trip's usual mpg" : `${fuelSource === "car" ? "car-reported" : "airflow estimate"}${extrapolated ? ", partly extrapolated" : ""}`;
    const items = [
      { key: "fuel", label: "Gas", amount: fuelGal != null && price != null ? fuelGal * price : null, note: fuelGal != null ? `${fmtGal(fuelGal)} gal (${how})${price != null ? ` at ${money(price)}, regional average` : ""}` : "no engine data" },
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
      car: sum(["fuel", "wear", "value", "other"]),
      perMile: miles > 0.05 ? total / miles : null,
      co2Kg: fuelGal != null ? fuelGal * s.co2KgPerGal : null,
      fuelKnown: fuelGal != null && price != null,
      guessed,
      estimated: guessed || extrapolated,
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
  // One trip's cost, for a folded section: the one-line summary, the breakdown, and the fine print.
  function tripParts({ trip: r, sm, e, gas }) {
    const end = r.driveEndWallMs ?? r.endedWallMs ?? r.updatedAtMs;
    const minutes = Math.max(0, (end - r.startedWallMs) / 60000);
    const c = trip({ minutes, miles: sm.miles, gal: e.galTrip ?? e.gal, price: gas?.price ?? null, fuelSource: e.fuelSource, extrapolated: e.extrapolated }, forTrip(r));
    return {
      summary: `${money(c.total)} all in`,
      body: `<p class="sec-meta">${money(c.car)} car costs, ${money(c.total)} with your time and carbon${c.perMile ? ` · ${money(c.perMile)}/mi` : ""}</p>
        ${breakdownHtml(c)}
        ${!c.fuelKnown ? `<p class="hint">Gas isn't counted yet: ${gas ? "no fuel readings" : "the gas price hasn't loaded"}.</p>` : ""}`,
      about: `<p>Time is door to door. <a href="#/costs">Change what time, wear and carbon are worth →</a></p>`,
    };
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

  // What a cold engine burns beyond the same kind of driving warm. Warm-engine fuel flow is averaged
  // per bin of 5 mph and accelerating / steady / slowing (0 mph is idling); each cold second is
  // compared with its bin. A cold start only counts when at least MIN_MATCHED of its warm-up seconds
  // have a bin backed by 30+ warm seconds: an unknown isn't reported as zero. It's still only a rough
  // association (same speed and acceleration, not the same road, grade or load).
  const MIN_MATCHED = 0.8;
  function coldStarts(trips) {
    const base = new Map();
    const bin = (r, prev) => {
      if (r.speed === 0) return "idle";
      const a = prev && prev.speed != null && r.t - prev.t <= 2500 ? (r.speed - prev.speed) / 3.6 / ((r.t - prev.t) / 1000) : 0;
      return `${Math.floor((r.speed * MPH) / 5)}|${a > 0.3 ? "up" : a < -0.3 ? "down" : "steady"}`;
    };
    for (const { rows } of trips) for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.coolant == null || r.coolant < 80 || r.fuelGs == null || r.speed == null || r.rpm < 300) continue;
      const k = bin(r, rows[i - 1]);
      const b = base.get(k) || base.set(k, [0, 0]).get(k);
      b[0] += r.fuelGs; b[1]++;
    }
    const cold = [];
    let unmatched = 0;
    for (const t of trips) {
      const rows = t.rows, first = rows.find((r) => r.coolant != null);
      if (!first || first.coolant >= 50) continue;
      let extraG = 0, warmAt = null, secs = 0, matched = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i], dt = (r.t - rows[i - 1].t) / 1000;
        if (r.coolant != null && r.coolant >= 80) { warmAt = r.t; break; }
        if (dt <= 0 || dt > 2.5 || r.fuelGs == null || r.speed == null) continue;
        secs += dt;
        const b = base.get(bin(r, rows[i - 1]));
        if (b && b[1] >= 30) { extraG += (r.fuelGs - b[0] / b[1]) * dt; matched += dt; }
      }
      if (!warmAt || !secs) continue;
      if (matched / secs < MIN_MATCHED) { unmatched++; continue; }
      // Scale the matched part up to the whole warm-up.
      cold.push({ t, extraGal: Math.max(0, galOf(extraG * (secs / matched))), warmMs: warmAt - rows[0].t, price: t.gas?.price, matched: matched / secs });
    }
    cold.unmatched = unmatched;
    return cold;
  }

  function median(xs) {
    const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : null;
  }

  /**
   * The Costs page. `trips`: [{ r, rows, gas }] (every drive with engine data); `durationOf(r)` gives
   * door-to-door ms; `save(key, change)` stores an edited pref ("people", "vehicles" or "costs"),
   * `change(current)` giving its new value; `me` is the signed-in person's id (their time is edited).
   */
  function page(host, trips, { durationOf, save, me = null, otherTrips = 0, onLeave = () => {} }) {
    const price = trips.findLast((t) => t.gas)?.gas.price ?? null;
    // Each vehicle in these drives gets its own per-mile costs; the one driven most leads.
    const counts = new Map();
    for (const t of trips) { const n = vehicleName(t.r); counts.set(n, (counts.get(n) || 0) + 1); }
    const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const mainR = trips.find((t) => vehicleName(t.r) === names[0])?.r ?? null;
    const fieldsOf = (keys) => FIELDS.filter(([k]) => keys.includes(k));
    const input = (name, value, label, unit, help) =>
      `<label><span>${esc(label)}</span><span class="cost-input"><input type="number" min="0" step="any" inputmode="decimal" name="${esc(name)}" value="${value}"><small>${esc(unit)}</small></span><small class="hint">${esc(help)}</small></label>`;
    const myTime = () => (me ? personTime(me) : settings.timePerHour);
    const summaries = trips.map((t) => ({ t, e: Engine.summary(t.rows, { vehicle: t.r.meta.vehicle, towing: !!t.r.towing, ...t.scope }) }));
    // The answer first; the assumptions behind it fold away under it.
    host.innerHTML = `
      <section class="ins-sec" id="cost-totals"></section>
      <section class="ins-sec">
        <details class="cost-assume" id="cost-assume">
          <summary><h2>What these count</h2><span class="hint" id="cost-assume-line"></span></summary>
          <p class="lede">Gas is from the engine (an airflow estimate on cars that don't report fuel use) at the regional average price for each week. Everything else is an assumption: set it to what it's worth to you. Your time is yours alone; each vehicle has its own per-mile costs; carbon is the same for everyone. Changes are saved for every browser.</p>
          <form class="cost-form" id="cost-form">
            <h3>Your time</h3>${fieldsOf(PERSON).map(([k, label, unit, help]) => input(`p:${k}`, myTime(), label, unit, help)).join("")}
            ${names.map((n, i) => `<h3>${esc(n || "Vehicle without a name")}</h3>${fieldsOf(VEHICLE).map(([k, label, unit, help]) => input(`v${i}:${k}`, vehicleCosts(n)[k], label, unit, k === "wearPerMile" && Engine.physics.isTruck(n) ? "Maintenance, repairs and tires. AAA's yearly estimate for a half-ton pickup is near 13¢ a mile." : help)).join("")}`).join("")}
            <h3>For everyone</h3>${fieldsOf(SHARED).map(([k, label, unit, help]) => input(`s:${k}`, settings[k], label, unit, help)).join("")}
            <div class="cost-actions"><button type="button" class="ghost" id="cost-reset">Back to defaults</button><span class="save-state" id="cost-save" role="status" aria-live="polite"></span></div>
          </form>
        </details>
      </section>
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

    // Speed and cold-start comparisons use the vehicle driven most, not towing: a trailer, or another
    // vehicle, burns differently at every speed.
    const plain = trips.filter((t) => !t.r.towing && vehicleName(t.r) === names[0]);
    const towedOut = trips.filter((t) => t.r.towing && vehicleName(t.r) === names[0]).length;
    const bins = steadyBins(plain);
    const gpm = galPerMileCurve(bins);
    const cold = coldStarts(plain);
    const idleRows = trips.flatMap((t) => t.rows.filter((r) => r.speed === 0 && r.rpm > 300 && r.coolant >= 75 && r.gph != null));
    const idleGph = median(idleRows.map((r) => r.gph));

    function render() {
      const sMain = forTrip(mainR);
      if (me) sMain.timePerHour = myTime();
      host.querySelector("#cost-assume-line").textContent = `Your time ${money(myTime())}/h · ${names.length > 1 ? `${names[0] || "vehicle"}: ` : ""}wear ${cents(sMain.wearPerMile)}/mi · lost value ${cents(sMain.valuePerMile)}/mi · carbon ${money(settings.carbonPerTonne)}/t. Change…`;
      // Totals over every drive with engine data.
      let sum = { minutes: 0, miles: 0 }, parts = {};
      for (const { t, e } of summaries) {
        const c = trip({ minutes: durationOf(t.r) / 60000, miles: e.miles, gal: e.galTrip ?? e.gal, price: t.gas?.price ?? price, fuelSource: e.fuelSource, extrapolated: e.extrapolated }, forTrip(t.r));
        sum.minutes += durationOf(t.r) / 60000;
        sum.miles += e.miles;
        for (const i of c.items) {
          const p = parts[i.key] || (parts[i.key] = { ...i, amount: 0 });
          if (i.amount != null) p.amount += i.amount;
        }
      }
      const items = Object.values(parts);
      const total = items.reduce((n, i) => n + i.amount, 0), carCost = items.filter((i) => ["fuel", "wear", "value", "other"].includes(i.key)).reduce((n, i) => n + i.amount, 0);
      const fromCar = summaries.every(({ e }) => e.fuelSource === "car"), extrap = summaries.filter(({ e }) => e.extrapolated).length;
      const noteFor = { fuel: `${fromCar ? "car-reported" : "airflow estimate"}${extrap ? `; ${extrap} drive${extrap === 1 ? "" : "s"} partly extrapolated` : ""}; regional average prices`, time: fmtMin(sum.minutes), wear: `${sum.miles.toFixed(0)} mi`, value: "", carbon: "", other: "" };
      items.forEach((i) => (i.note = noteFor[i.key] ?? ""));
      const fig = (v, l) => `<div class="fig"><b>${v}</b><span>${esc(l)}</span></div>`;
      host.querySelector("#cost-totals").innerHTML = `
        <h2>All your drives with engine data</h2>
        <p class="lede">${trips.length} drive${trips.length === 1 ? "" : "s"}${otherTrips ? `; ${otherTrips} without engine data aren't counted` : ""}.</p>
        <div class="figs">${fig(money(total), "all in")}${fig(money(carCost), "car costs: gas, wear, lost value")}${fig(sum.miles > 0 ? money(total / sum.miles) : "–", "per mile, all in")}${fig(sum.miles > 0 ? money(carCost / sum.miles) : "–", "per mile, car costs")}</div>
        ${breakdownHtml({ items })}`;

      // Cost per mile by steady speed.
      const note = host.querySelector("#cost-speed-note");
      if (gpm.length < 3 || price == null) {
        host.querySelector("#cost-speed").innerHTML = `<p class="hint">Not enough steady driving yet (at least a minute at each speed), or no gas price.</p>`;
        note.textContent = "";
      } else {
        const rows = gpm.map((g) => ({ mph: g.mph, ...perMileAt(g.mph, g.gpm, price, sMain) }));
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
        const whose = `${names.length > 1 ? ` For the ${names[0] || "vehicle driven most"}.` : ""}${towedOut ? ` Towing drives (${towedOut}) aren't counted here.` : ""}`;
        note.textContent = (sMain.timePerHour > 0
          ? `With your time at ${money(sMain.timePerHour)}/h, steady driving is cheapest ${where(best)}, ${cents(best.total)} a mile. Gas alone is cheapest ${where(bestFuel)}, ${cents(bestFuel.fuel)} a mile${top !== bestFuel ? `; at ${top.mph} mph it's ${cents(top.fuel)}` : ""}. Speed limits and traffic come first, of course: this is only what each choice costs.`
          : `Counting gas, wear and carbon only, steady driving is cheapest ${where(best)}, ${cents(best.total)} a mile.`) + whose;
      }

      // Idling.
      const idleTotal = summaries.reduce((n, { t, e }) => n + (e.fuelUse ? e.fuelUse.idle * (t.gas?.price ?? price ?? 0) : 0), 0);
      const idleMin = summaries.reduce((n, { e }) => n + e.idleMs / 60000, 0);
      host.querySelector("#cost-idle").innerHTML = `<h2>Idling</h2>
        ${idleGph != null && price != null ? `<p class="lede">Warmed up, the engine burns about ${idleGph.toFixed(2)} gal an hour at a standstill: ${cents((idleGph * price) / 60)} a minute in gas, ${money(idleGph * price)} an hour.
          You've idled ${fmtMin(idleMin)} in these drives, about ${money(idleTotal)} of gas. Counting your time too, a minute stopped costs ${cents((idleGph * price) / 60 + myTime() / 60)}.</p>
          <p class="hint">A rule of thumb from Argonne National Laboratory: switching the engine off for stops longer than about 10 seconds saves more fuel than the restart uses.</p>`
          : `<p class="lede">Not enough warm idling recorded yet.</p>`}`;

      // Cold starts.
      const c = host.querySelector("#cost-cold");
      if (cold.length) {
        const extra = median(cold.map((x) => x.extraGal)), warm = median(cold.map((x) => x.warmMs));
        const each = extra * (price ?? 0);
        c.innerHTML = `<h2>Cold starts</h2>
          <p class="lede">From a cold engine, warming up takes about ${fmtMin(warm / 60000)} and burns roughly ${extra.toFixed(3)} gal more than driving at the same speeds warm${price != null ? `: about ${cents(each)} each time` : ""} (median of ${cold.length} cold start${cold.length === 1 ? "" : "s"}).
          Errands chained into one outing pay this once; separate trips hours apart pay it each time.</p>
          <p class="hint">A rough comparison: warm driving is matched by speed and whether you were speeding up or slowing, not by road, hill or load.${cold.unmatched ? ` ${cold.unmatched} cold start${cold.unmatched === 1 ? "" : "s"} had too little comparable warm driving and ${cold.unmatched === 1 ? "isn't" : "aren't"} counted.` : ""}</p>`;
      } else c.innerHTML = `<h2>Cold starts</h2><p class="lede">${cold.unmatched ? `${plural(cold.unmatched, "cold start")} recorded, but not enough warm driving at the same speeds to compare against yet.` : "No cold starts with coolant readings yet."}</p>`;
    }
    render();

    // Saving: the numbers update at once; the save state says whether other browsers will see it.
    const form = host.querySelector("#cost-form"), stateEl = host.querySelector("#cost-save");
    let timer = 0;
    const setState = (text, cls = "") => { stateEl.className = `save-state ${cls}`; stateEl.innerHTML = text; };
    // Which prefs have edits not yet saved: "people" (your time), "vehicles", "costs" (shared).
    const dirty = new Set();
    const write = (key) => {
      if (key === "people") {
        const mine = people[me];
        return save("people", (cur) => {
          const next = { ...(cur || {}) };
          if (mine) next[me] = { ...mine }; else delete next[me];
          return next;
        });
      }
      if (key === "vehicles") {
        const shown = Object.fromEntries(names.filter((n) => n).map((n) => [n, vehicles[n]]));
        return save("vehicles", (cur) => {
          const next = { ...(cur || {}) };
          for (const [n, v] of Object.entries(shown)) if (v) next[n] = { ...v }; else delete next[n];
          return next;
        });
      }
      return save("costs", () => ({ ...settings }));
    };
    async function persist() {
      clearTimeout(timer);
      timer = 0;
      const keys = [...dirty];
      dirty.clear();
      setState("Saving…");
      try {
        await Promise.all(keys.map(write));
        if (!dirty.size && !timer) setState("Saved", "ok");
      } catch (e) {
        keys.forEach((k) => dirty.add(k));
        if (e.message === "unauthorized") return;
        setState(`Couldn't save (${esc(e.message)}). These numbers apply here only until it's saved. <button type="button" class="link" id="cost-retry">Try again</button>`, "bad");
        host.querySelector("#cost-retry").onclick = persist;
      }
    }
    // One field changed: it goes to your time, its vehicle, or the shared settings. Your time with
    // nobody signed in (the original token), and a vehicle without a name, change the shared values.
    form.addEventListener("input", (ev) => {
      const name = ev.target?.name || "";
      const v = parseFloat(ev.target.value);
      if (!name || !(Number.isFinite(v) && v >= 0)) return;
      const [group, k] = name.split(":");
      if (group === "p" && me) {
        people = { ...people, [me]: { timePerHour: v } };
        dirty.add("people");
      } else if (group.startsWith("v") && names[+group.slice(1)]) {
        const n = names[+group.slice(1)];
        vehicles = { ...vehicles, [n]: { ...vehicleCosts(n), [k]: v } };
        dirty.add("vehicles");
      } else {
        settings = { ...settings, [k]: v };
        dirty.add("costs");
      }
      render();
      setState("Not saved yet");
      clearTimeout(timer);
      timer = setTimeout(persist, 600);
    });
    host.querySelector("#cost-reset").onclick = () => {
      if (me) { people = { ...people }; delete people[me]; dirty.add("people"); }
      vehicles = { ...vehicles };
      for (const n of names) delete vehicles[n];
      settings = { ...DEFAULTS };
      dirty.add("vehicles").add("costs");
      for (const el of form.querySelectorAll("input[name]")) {
        const [group, k] = el.name.split(":");
        el.value = group === "p" ? myTime() : group.startsWith("v") ? vehicleCosts(names[+group.slice(1)])[k] : settings[k];
      }
      render();
      persist();
    };
    // Leaving with an edit still waiting: save it now rather than drop it.
    onLeave(() => { if (timer) { clearTimeout(timer); timer = 0; [...dirty].forEach((k) => write(k).catch(() => {})); dirty.clear(); } });
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return { DEFAULTS, FIELDS, get, use, forTrip, vehicleCosts, personTime, trip, perMileAt, breakdownHtml, tripParts, page, money, cents, steadyBins, galPerMileCurve, coldStarts };
})();
