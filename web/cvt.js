// How the transmission behaves, from what the engine reports: engine speed against road speed, how
// many revs each mph takes at light and heavy pedal, how revs answer a press of the pedal, cold vs
// warm, and coasting. Nothing here comes from the transmission itself: the Civic's standard OBD data
// has no CVT ratio or temperature, so the "ratio" is engine rpm over road speed. That number includes
// the final drive and tire size and moves with the torque converter, so it shows behavior, not belt
// slip or wear.
//
// The pedal reading never goes to zero (the Civic reads about 20% foot-off), so pedal is shown as
// points above its resting value: 0 is foot off.

const Cvt = (() => {
  const MPH = 0.621371;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const q = (xs, p) => Plot.quantile([...xs].sort((a, b) => a - b), p);

  // Every second with rpm and speed, with pedal above rest, acceleration and steadiness.
  function seconds(trips) {
    const pedals = [];
    for (const { rows } of trips) for (const r of rows) if (r.pedal != null) pedals.push(r.pedal);
    const rest = pedals.length ? q(pedals, 0.02) : 0;
    const out = [];
    for (const { r: rec, rows } of trips) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.rpm == null || r.speed == null) continue;
        const prev = rows[i - 1], next = rows[i + 1];
        let accel = null;
        if (prev && next && next.t - prev.t <= 2500 && prev.speed != null && next.speed != null) accel = (next.speed - prev.speed) / 3.6 / ((next.t - prev.t) / 1000);
        out.push({
          t: r.t, trip: rec.id, mph: r.speed * MPH, rpm: r.rpm, pedal: r.pedal != null ? Math.max(0, r.pedal - rest) : null,
          coolant: r.coolant, cut: r.cut, accel, load: r.load,
        });
      }
    }
    return { secs: out, rest };
  }

  const band = (s) => (s.pedal == null ? null : s.pedal <= 1 ? "coast" : s.pedal < 8 ? "light" : s.pedal < 20 ? "moderate" : "heavy");

  // Median of `val` per x-bin, for points passing `keep`; [[x, median, p25, p75, n]].
  function binned(secs, { x, val, keep = () => true, step = 2, lo = 0, hi = 90, minN = 20 }) {
    const bins = new Map();
    for (const s of secs) {
      if (!keep(s)) continue;
      const xv = x(s), v = val(s);
      if (xv == null || v == null || !Number.isFinite(v) || xv < lo || xv > hi) continue;
      const k = Math.floor(xv / step);
      (bins.get(k) || bins.set(k, []).get(k)).push(v);
    }
    const out = [];
    for (const [k, vs] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
      if (vs.length < minN) continue;
      vs.sort((a, b) => a - b);
      out.push([k * step + step / 2, Plot.quantile(vs, 0.5), Plot.quantile(vs, 0.25), Plot.quantile(vs, 0.75), vs.length]);
    }
    return out;
  }

  // Presses of the pedal: from a steady pedal (within 3 points for 2 s), up at least 15 points within
  // 1.5 s, while moving. Returns rpm and mph changes from the moment of the press, -2..+10 s.
  function presses(trips, rest) {
    const ev = [];
    for (const { r: rec, rows } of trips) {
      const byT = rows;
      let lastAt = -Infinity;
      for (let i = 3; i < byT.length - 10; i++) {
        const r = byT[i];
        if (r.pedal == null || r.rpm == null || r.speed == null || r.speed * MPH < 5 || r.t - lastAt < 15000) continue;
        const before = byT.slice(i - 3, i).filter((x) => x.pedal != null && r.t - x.t <= 3500);
        if (before.length < 2 || Math.max(...before.map((x) => x.pedal)) - Math.min(...before.map((x) => x.pedal)) > 3) continue;
        const p0 = before.at(-1).pedal;
        const jump = byT.slice(i, i + 3).find((x) => x.pedal != null && x.t - r.t <= 1500 && x.pedal - p0 >= 15);
        if (!jump) continue;
        const t0 = r.t, rpm0 = before.at(-1).rpm, v0 = before.at(-1).speed;
        if (rpm0 == null || v0 == null) continue;
        const trace = [];
        for (let k = i - 3; k < Math.min(byT.length, i + 12); k++) {
          const x = byT[k], dt = Math.round((x.t - t0) / 1000);
          if (dt < -2 || dt > 10 || x.rpm == null || x.speed == null) continue;
          trace.push({ dt, drpm: x.rpm - rpm0, dmph: (x.speed - v0) * MPH });
        }
        ev.push({ trip: rec.id, t: t0, pedal: Math.max(0, jump.pedal - rest), from: Math.max(0, p0 - rest), mph: v0 * MPH, rpm0, trace });
        lastAt = t0;
      }
    }
    return ev;
  }

  function render(host, trips) {
    const { secs, rest } = seconds(trips);
    if (secs.length < 120) {
      host.innerHTML = `<p class="lede">Not enough engine data yet: this needs RPM and speed from the OBD adapter, a few minutes at least.</p>`;
      return;
    }
    const moving = secs.filter((s) => s.mph >= 3);
    const steady = (s) => s.accel != null && Math.abs(s.accel) < 0.15;
    const cruiseAt = (mph) => {
      const vs = moving.filter((s) => steady(s) && Math.abs(s.mph - mph) <= 2 && band(s) !== "coast" && band(s) !== "heavy").map((s) => s.rpm);
      return vs.length >= 20 ? q(vs, 0.5) : null;
    };
    const fig = (v, l) => `<div class="fig"><b>${v}</b><span>${esc(l)}</span></div>`;
    const rpmFmt = (v) => (v == null ? "–" : Math.round(v).toLocaleString());
    const hours = secs.length / 3600;

    host.innerHTML = `
      <div class="figs">
        ${fig(rpmFmt(cruiseAt(30)), "rpm cruising at 30 mph")}
        ${fig(rpmFmt(cruiseAt(45)), "rpm at 45 mph")}
        ${fig(rpmFmt(cruiseAt(65)), "rpm at 65 mph")}
        ${fig(`${rpmFmt(q(moving.map((s) => s.rpm), 0.05))}–${rpmFmt(q(moving.map((s) => s.rpm), 0.95))}`, "rpm range while moving (most of the time)")}
        ${fig(hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`, `of engine data, ${trips.length} drive${trips.length === 1 ? "" : "s"}`)}
      </div>

      <section class="ins-sec">
        <h2>Engine speed and road speed</h2>
        <p class="lede">Every second of driving, by road speed and engine speed. Color is how far the gas pedal was pressed; fainter squares are rarer. A stepped gearbox draws a fan of straight lines here; a CVT fills in a band, keeping revs low at light pedal and letting them rise with the pedal instead of the speed.</p>
        <div id="cvt-heat" class="chart-host"></div>
      </section>

      <section class="ins-sec">
        <h2>Revs per mph</h2>
        <p class="lede">Engine rpm divided by road speed, its effective gear ratio, at each speed (median of steady and gently changing seconds). Lower is a taller gear. Light pedal is where it settles when you cruise; heavy pedal shows how far it shifts down when asked for power.</p>
        <div id="cvt-ratio" class="chart-host"></div>
        <p class="hint">This includes the final drive and tire size and changes slightly with the torque converter; it isn't a reading from the transmission, so it can't show belt slip or wear by itself. A lasting change at the same speed, pedal and temperature would be worth a look.</p>
      </section>

      <section class="ins-sec">
        <h2>How revs answer the pedal</h2>
        <p class="lede">At a given road speed, engine rpm against how far the pedal is pressed (median). A CVT answers the pedal mostly with revs, so these lines climb steeply; the speed comes after.</p>
        <div id="cvt-pedal" class="chart-host"></div>
      </section>

      <section class="ins-sec">
        <h2>Pressing the pedal</h2>
        <p class="lede" id="cvt-press-lede"></p>
        <div id="cvt-press" class="chart-host"></div>
        <ol class="legs diverge" id="cvt-press-list"></ol>
      </section>

      <section class="ins-sec">
        <h2>Cold and warm</h2>
        <p class="lede">Revs per mph at light pedal with the engine cold (coolant under 160 °F) and warm (over 175 °F). Many CVTs hold revs up while cold to warm the engine and transmission fluid faster.</p>
        <div id="cvt-cold" class="chart-host"></div>
      </section>

      <section class="ins-sec">
        <h2>Coasting</h2>
        <p class="lede" id="cvt-coast-lede"></p>
        <div id="cvt-coast" class="chart-host"></div>
      </section>`;

    // Heatmap: 2 mph × 100 rpm cells, color = median pedal above rest.
    const maxMph = Math.ceil(Math.min(100, q(moving.map((s) => s.mph), 0.995) + 2) / 5) * 5;
    const maxRpm = Math.ceil(Math.min(7000, q(secs.map((s) => s.rpm), 0.995) + 100) / 500) * 500;
    const cells = new Map();
    for (const s of secs) {
      if (s.mph > maxMph || s.rpm > maxRpm) continue;
      const k = `${Math.floor(s.mph / 2)}|${Math.floor(s.rpm / 100)}`;
      const c = cells.get(k) || cells.set(k, { x: Math.floor(s.mph / 2) * 2, y: Math.floor(s.rpm / 100) * 100, n: 0, ps: [] }).get(k);
      c.n++;
      if (s.pedal != null) c.ps.push(s.pedal);
    }
    const cellList = [...cells.values()].map((c) => ({ ...c, v: c.ps.length ? q(c.ps, 0.5) : 0 }));
    const pedalHi = Math.max(10, q(secs.filter((s) => s.pedal != null).map((s) => s.pedal), 0.98) ?? 30);
    Plot.heatmap(host.querySelector("#cvt-heat"), cellList, {
      dx: 2, dy: 100, xLo: 0, xHi: maxMph, yLo: 0, yHi: maxRpm, vLo: 0, vHi: pedalHi,
      xUnit: " mph", yUnit: "rpm", yFmt: (v) => (v >= 1000 ? `${v / 1000}k` : String(v)), aria: "Engine rpm against road speed, colored by pedal",
      legend: ["foot off", `pedal +${Math.round(pedalHi)}`],
      tipText: (c) => `<b>${c.x}–${c.x + 2} mph, ${c.y.toLocaleString()}–${(c.y + 100).toLocaleString()} rpm</b> <span>${c.n < 60 ? `${c.n} s` : `${(c.n / 60).toFixed(1)} min`} · pedal +${c.v.toFixed(0)}</span>`,
    });

    // Revs per mph by speed, per pedal band.
    const gentle = (s) => s.accel == null || Math.abs(s.accel) < 1.2;
    const ratio = (keep) => binned(moving, { x: (s) => s.mph, val: (s) => (s.mph >= 8 ? s.rpm / s.mph : null), keep: (s) => gentle(s) && keep(s), lo: 8, hi: maxMph, minN: 15 });
    const light = ratio((s) => band(s) === "light"), mod = ratio((s) => band(s) === "moderate"), heavy = ratio((s) => band(s) === "heavy");
    Plot.lines(host.querySelector("#cvt-ratio"), [
      { label: "Light pedal (under +8)", cls: "s1", pts: light.map((b) => [b[0], b[1]]), width: 2.5 },
      { label: "Moderate (+8 to +20)", cls: "s2", pts: mod.map((b) => [b[0], b[1]]) },
      { label: "Heavy (over +20)", cls: "s5", pts: heavy.map((b) => [b[0], b[1]]) },
    ], { xUnit: " mph", yUnit: " rpm/mph", yFmt: (v) => v.toFixed(0), aria: "Engine rpm per mph by speed", bands: [{ lo: light.map((b) => [b[0], b[2]]), hi: light.map((b) => [b[0], b[3]]), cls: "s1" }] });

    // RPM against pedal, at three speed bands.
    const at = (lo, hi) => binned(moving, { x: (s) => s.pedal, val: (s) => s.rpm, keep: (s) => s.mph >= lo && s.mph < hi && s.pedal != null && s.pedal > 1, step: 2, lo: 0, hi: 80, minN: 10 });
    const sp = [[20, 30, "s1"], [35, 45, "s2"], [55, 70, "s5"]].map(([lo, hi, cls]) => ({ label: `${lo}–${hi} mph`, cls, pts: at(lo, hi).map((b) => [b[0], b[1]]) })).filter((s) => s.pts.length >= 2);
    Plot.lines(host.querySelector("#cvt-pedal"), sp, { xUnit: "", xFmt: (v) => `+${v.toFixed(0)}`, yUnit: " rpm", yFmt: (v) => Math.round(v).toLocaleString(), aria: "Engine rpm against pedal at three speeds", yMin: 0 });

    // Pedal presses: median rpm rise and speed gain over the following seconds.
    const ev = presses(trips, rest);
    const lede = host.querySelector("#cvt-press-lede");
    if (ev.length < 3) {
      lede.textContent = "Moments where you pressed the pedal firmly from a steady cruise show how quickly revs and speed answer. There aren't enough of them yet.";
      host.querySelector("#cvt-press").innerHTML = "";
    } else {
      const series = (k) => {
        const by = new Map();
        for (const e of ev) for (const p of e.trace) (by.get(p.dt) || by.set(p.dt, []).get(p.dt)).push(p[k]);
        return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([dt, vs]) => [dt, q(vs, 0.5), q(vs, 0.25), q(vs, 0.75)]);
      };
      const rpm = series("drpm"), mph = series("dmph");
      const peak = Math.max(...rpm.map((p) => p[1]));
      const t90 = rpm.find((p) => p[0] >= 0 && p[1] >= 0.9 * peak)?.[0];
      lede.textContent = `${ev.length} times you pressed the pedal firmly (at least 15 points, from a steady pedal). Revs rise by a median ${Math.round(peak).toLocaleString()} rpm${t90 != null ? `, most of it within ${t90} s` : ""}, while speed keeps building after. Blue: rpm change; orange: speed gained (× 100 to share the axis).`;
      Plot.lines(host.querySelector("#cvt-press"), [
        { label: "RPM change", cls: "s1", pts: rpm.map((p) => [p[0], p[1]]), width: 2.5 },
        { label: "Speed gained × 100 (mph)", cls: "s2", pts: mph.map((p) => [p[0], p[1] * 100]) },
      ], { xFmt: (v) => `${v > 0 ? "+" : ""}${v}`, xUnit: " s", yUnit: "", yFmt: (v) => Math.round(v).toLocaleString(), aria: "RPM and speed after pressing the pedal", bands: [{ lo: rpm.map((p) => [p[0], p[2]]), hi: rpm.map((p) => [p[0], p[3]]), cls: "s1" }] });
      const big = [...ev].sort((a, b) => b.pedal - b.from - (a.pedal - a.from)).slice(0, 5);
      host.querySelector("#cvt-press-list").innerHTML = big.map((e) => {
        const top = Math.max(...e.trace.map((p) => p.drpm));
        return `<li><a href="#/r/${esc(e.trip)}/${Math.round(e.t)}"><b>${esc(new Date(e.t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }))}</b><span>pedal +${e.from.toFixed(0)} → +${e.pedal.toFixed(0)} at ${e.mph.toFixed(0)} mph: ${Math.round(e.rpm0).toLocaleString()} rpm, up ${Math.round(top).toLocaleString()}</span></a></li>`;
      }).join("");
    }

    // Cold vs warm at light pedal.
    const cold = ratio((s) => band(s) === "light" && s.coolant != null && s.coolant < 71);
    const warm = ratio((s) => band(s) === "light" && s.coolant != null && s.coolant >= 80);
    if (cold.length >= 2) {
      Plot.lines(host.querySelector("#cvt-cold"), [
        { label: "Warm", cls: "s1", pts: warm.map((b) => [b[0], b[1]]), width: 2.5 },
        { label: "Cold", cls: "s2", pts: cold.map((b) => [b[0], b[1]]) },
      ], { xUnit: " mph", yUnit: " rpm/mph", yFmt: (v) => v.toFixed(0), aria: "Revs per mph, cold and warm" });
    } else host.querySelector("#cvt-cold").innerHTML = `<p class="hint">Not enough cold-engine driving yet.</p>`;

    // Coasting: rpm while coasting vs cruising, and how often fuel is cut.
    const coast = moving.filter((s) => band(s) === "coast" && s.mph >= 10);
    const coastRpm = binned(coast, { x: (s) => s.mph, val: (s) => s.rpm, lo: 10, hi: maxMph, minN: 10 });
    const cutShare = binned(coast, { x: (s) => s.mph, val: (s) => (s.cut ? 1 : 0), lo: 10, hi: maxMph, minN: 10, step: 5 });
    const cruiseRpm = binned(moving, { x: (s) => s.mph, val: (s) => s.rpm, keep: (s) => band(s) === "light" && steady(s), lo: 10, hi: maxMph, minN: 15 });
    const cl = host.querySelector("#cvt-coast-lede");
    if (coastRpm.length >= 2) {
      const cutAll = coast.filter((s) => s.cut).length / coast.length;
      const firstCut = cutShare.find((b) => b[1] >= 0.5);
      // Compare coasting and cruising revs only at speeds both have, and only say what the data shows.
      const pairs = coastRpm.map((c) => [c, cruiseRpm.find((r) => r[0] === c[0])]).filter(([, r]) => r);
      const diff = pairs.length >= 3 ? Plot.quantile(pairs.map(([c, r]) => c[1] - r[1]).sort((a, b) => a - b), 0.5) : null;
      const compare = diff == null ? ""
        : diff > 150 ? ` Coasting, the transmission holds revs about ${Math.round(diff).toLocaleString()} rpm higher than when cruising at the same speed: engine braking, which keeps the engine turning without fuel.`
        : diff < -150 ? ` Coasting, revs drop about ${Math.round(-diff).toLocaleString()} rpm below cruising at the same speed, so there's little engine braking.`
        : " Coasting and cruising revs are about the same at each speed.";
      cl.textContent = `Foot off the pedal above 10 mph, the engine cut fuel entirely ${Math.round(cutAll * 100)}% of the time${firstCut ? `, most of the time from about ${Math.round(firstCut[0] - 2.5)} mph up` : ""}.${compare}`;
      Plot.lines(host.querySelector("#cvt-coast"), [
        { label: "Coasting", cls: "s2", pts: coastRpm.map((b) => [b[0], b[1]]), width: 2.5 },
        { label: "Cruising, light pedal", cls: "s1", pts: cruiseRpm.map((b) => [b[0], b[1]]) },
      ], { xUnit: " mph", yUnit: " rpm", yFmt: (v) => Math.round(v).toLocaleString(), aria: "RPM while coasting and cruising", yMin: 0 });
    } else {
      cl.textContent = "Not enough coasting yet.";
    }
  }

  return { render, seconds, presses, band };
})();
