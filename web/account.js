// Accounts: signing in with Google, invite links, the account page (your phones, and for the owner:
// invites, people, and which person each phone's trips belong to), and "whose trips" in the header.
//
// In a browser, Google's own button signs in. Inside the Android app Google doesn't allow its sign-in
// page, so the app does it natively: the page calls FuelishApp.signIn(), the app signs in, stores the
// session cookie for this page and an upload key for itself, then calls Account.nativeDone().

const GOOGLE_CLIENT_ID = "1033825280710-td79ais1l0e1bq8m1sq9a5uf6ccvfmfo.apps.googleusercontent.com";
const WHO_KEY = "fuelish.who";

const Account = (() => {
  let me = null, users = null, pending = null;

  const inApp = () => typeof window.FuelishApp?.signIn === "function";
  const onAndroid = () => /Android/i.test(navigator.userAgent);
  const APP_KEY = "fuelish.appBanner";

  // The Android app, for a phone that should record. Downloads from the server (signed-in only), so
  // the first install needs no computer; after that the app updates itself.
  const appDownload = (cls = "primary") =>
    `<a class="button ${cls}" href="/api/v1/app/apk/latest" download="fuelish.apk">Download the Fuelish app</a>`;
  const appSteps = `<p class="muted">Chrome downloads it; open the download and allow installing. The first time, Android asks to allow installs from Chrome. Then open Fuelish and sign in with the same Google account.</p>`;
  const legacy = () => me?.via === "legacy";

  // Who's signed in, or null. Doesn't go through api(): a 401 here just means "not signed in".
  async function load() {
    if (me) return me;
    pending ||= (async () => {
      const t = token();
      if (t && tokenProblem(t)) return null;
      const res = await fetch("/api/v1/me", { headers: t ? { Authorization: "Bearer " + t } : {} });
      if (!res.ok) return null;
      me = await res.json();
      if (!me.scopes.includes("read")) me = null; // a phone's upload key can't see trips
      if (me) users = (await api("/users").catch(() => ({ users: [] }))).users;
      return me;
    })().finally(() => { pending = null; });
    return pending;
  }

  function forget() { me = null; users = null; }

  // ---------- whose trips ----------

  function who() {
    let v = "me";
    try { v = localStorage.getItem(WHO_KEY) || "me"; } catch {}
    if (v !== "me" && v !== "all" && !users?.some((u) => u.id === v)) v = "me";
    return v;
  }
  /** The picker choice that shows `userId`'s trips ("all" when they aren't one of the people listed). */
  function whoFor(userId) {
    if (!userId) return "all";
    if (userId === me?.user?.id) return "me";
    return users?.some((u) => u.id === userId) ? userId : "all";
  }
  /** Switches the picker (it takes effect on the next page shown). */
  function setWho(v) {
    try { localStorage.setItem(WHO_KEY, v); } catch {}
  }
  /** The `user` filter for /recordings, or "" for everyone. */
  function whoParam() {
    const v = who();
    if (v === "all" || (v === "me" && !me?.user)) return ""; // before the owner signs in, trips have no owner
    return v;
  }

  function renderHeader() {
    const sel = document.getElementById("who"), link = document.getElementById("account-link");
    const others = (users || []).filter((u) => u.id !== me?.user?.id && !u.disabled);
    sel.hidden = !me || !me.user || !others.length;
    if (!sel.hidden) {
      const v = who();
      sel.innerHTML = [`<option value="me">My trips</option>`, ...others.map((u) => `<option value="${esc(u.id)}">${esc(firstName(u.name))}'s trips</option>`), `<option value="all">Everyone's</option>`]
        .join("");
      sel.value = v;
    }
    link.hidden = !me;
    if (me) {
      const pic = me.user?.picture;
      link.innerHTML = pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<span>${esc(initials(me.user?.name || "Account"))}</span>`;
      link.title = me.user ? `${me.user.name}: account` : "Account";
    }
    const banner = document.getElementById("banner");
    // On an Android phone's browser (not the app), offer the app once until it's dismissed.
    let dismissed = false;
    try { dismissed = !!localStorage.getItem(APP_KEY); } catch {}
    const offerApp = !!me?.user && onAndroid() && !inApp() && !dismissed;
    banner.hidden = !legacy() && !offerApp;
    if (offerApp && !legacy() && banner.dataset.ready !== "app") {
      banner.dataset.ready = "app";
      banner.innerHTML = `<p><b>Record your drives on this phone?</b> Get the Fuelish app.</p>${appDownload()}<button class="ghost" id="app-later">Not now</button>`;
      document.getElementById("app-later").onclick = () => {
        try { localStorage.setItem(APP_KEY, "1"); } catch {}
        banner.hidden = true;
      };
    }
    if (legacy() && !banner.dataset.ready) {
      banner.dataset.ready = "1";
      banner.innerHTML = `<p><b>${me.claimed ? "Sign in with Google" : "Set up sign-in"}:</b> ${me.claimed ? "you're using the original web token." : "you're the owner. Sign in with Google once to switch from the token and invite your family."}</p><div class="g-slot"></div><p class="bad" hidden></p>`;
      googleButton(banner.querySelector(".g-slot"), { text: "continue_with", error: banner.querySelector(".bad") });
    }
  }
  document.getElementById("who").onchange = (e) => {
    try { localStorage.setItem(WHO_KEY, e.target.value); } catch {}
    route();
  };

  const firstName = (n) => String(n || "").split(/\s+/)[0] || n;
  const initials = (n) => String(n).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  // ---------- Google sign-in ----------

  let gisLoading = null;
  function gis() {
    gisLoading ||= new Promise((resolve, reject) => {
      if (window.google?.accounts?.id) return resolve(google.accounts.id);
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve(google.accounts.id);
      s.onerror = () => { gisLoading = null; reject(new Error("Couldn't load Google sign-in. Check the connection and reload.")); };
      document.head.append(s);
    });
    return gisLoading;
  }

  let afterSignIn = null; // what the current button does once signed in

  /** Puts a "Sign in with Google" button in `el`. */
  async function googleButton(el, { invite = null, text = "signin_with", error = null } = {}) {
    const fail = (msg) => { if (error) { error.textContent = msg; error.hidden = false; } };
    afterSignIn = { invite, fail };
    if (inApp()) {
      el.innerHTML = `<button class="g-native" type="button"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>${text === "signup_with" ? "Sign up with Google" : text === "continue_with" ? "Continue with Google" : "Sign in with Google"}</button>`;
      el.querySelector("button").onclick = (e) => {
        e.currentTarget.disabled = true;
        if (error) error.hidden = true;
        window.FuelishApp.signIn(invite || "", token() || "");
      };
      return;
    }
    try {
      const id = await gis();
      id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: (r) => finish(r.credential, invite, fail), ux_mode: "popup", auto_select: false });
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      el.innerHTML = "";
      id.renderButton(el, { theme: dark ? "filled_black" : "outline", size: "large", text, shape: "pill", logo_alignment: "left" });
    } catch (e) {
      fail(e.message);
    }
  }

  async function finish(credential, invite, fail) {
    const t = token();
    try {
      const res = await fetch("/api/v1/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fuelish": "1", ...(t && !tokenProblem(t) ? { Authorization: "Bearer " + t } : {}) },
        body: JSON.stringify({ credential, invite }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return fail(body.error || "Sign-in didn't work. Try again.");
      done(invite);
    } catch {
      fail("Couldn't reach the server. Try again.");
    }
  }

  // Signed in: the session cookie is set, so this browser no longer needs the original token.
  function done(invite) {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    forget();
    const banner = document.getElementById("banner");
    banner.hidden = true;
    delete banner.dataset.ready;
    if (invite || location.hash.startsWith("#/invite")) location.hash = "#/";
    else route();
  }

  /** Called by the Android app when its native sign-in finishes. */
  function nativeDone(ok, message) {
    document.querySelectorAll(".g-native").forEach((b) => (b.disabled = false));
    if (ok) return done(afterSignIn?.invite);
    if (message) afterSignIn?.fail(message);
  }

  async function signOut() {
    await fetch("/api/v1/auth/logout", { method: "POST", headers: { "X-Fuelish": "1" } }).catch(() => {});
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    forget();
    window.FuelishApp?.signedOut?.();
    location.hash = "#/";
    route();
  }

  // ---------- pages ----------

  function showLogin(msg = "") {
    app.innerHTML = `
      <div class="card login">
        <h1>Sign in</h1>
        <p class="muted">Sign in with the Google account you joined with. New here? Open the invite link you were sent.</p>
        <div class="g-slot"></div>
        <p class="bad" ${msg ? "" : "hidden"}>${esc(msg)}</p>
        <details class="token-login">
          <summary>Use the original web token</summary>
          <form id="login">
            <p class="muted">The <code>WEB_TOKEN</code> set on the Worker. It stays in this browser.</p>
            <input type="password" id="tok" autocomplete="current-password" placeholder="Token" required>
            <button class="primary">Sign in with token</button>
          </form>
        </details>
      </div>`;
    googleButton(app.querySelector(".g-slot"), { error: app.querySelector(".login .bad") });
    document.getElementById("login").onsubmit = (e) => {
      e.preventDefault();
      const t = cleanToken(document.getElementById("tok").value);
      const problem = tokenProblem(t);
      if (problem) return showLogin(problem);
      try { localStorage.setItem(TOKEN_KEY, t); } catch {}
      forget();
      route();
    };
  }

  async function showInvite(code) {
    app.innerHTML = `<p class="muted loading">Loading…</p>`;
    const info = await fetch(`/api/v1/invites/${encodeURIComponent(code)}`).then((r) => r.json()).catch(() => ({ usable: false }));
    const signedIn = await load();
    if (signedIn?.user) {
      app.innerHTML = `<div class="card login"><h1>You're already in</h1><p class="muted">You're signed in as ${esc(signedIn.user.name)}. This invite is for someone new.</p><p><a href="#/">Go to your trips →</a></p></div>`;
      return;
    }
    if (!info.usable) {
      app.innerHTML = `<div class="card login"><h1>This invite has expired</h1><p class="muted">Invite links work once, for two weeks. Ask for a new one.</p><p><a href="#/">Already joined? Sign in →</a></p></div>`;
      return;
    }
    app.innerHTML = `
      <div class="card login">
        <h1>Join Fuelish</h1>
        <p>${esc(info.from)} invited you to record your drives and see what they cost.</p>
        <div class="g-slot"></div>
        <p class="bad" hidden></p>
        ${inApp() ? "" : onAndroid()
          ? `<p class="muted">After you sign up, you can download the Fuelish app here to record your drives.</p>`
          : `<p class="muted">Recording on an Android phone? After you sign up, open Fuelish on the phone, sign in, and download the app from your Account page.</p>`}
      </div>`;
    googleButton(app.querySelector(".g-slot"), { invite: code, text: "signup_with", error: app.querySelector(".login .bad") });
  }

  const ago = (ms) => (ms ? new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "never");

  async function showAccount() {
    const live = current();
    const m = await load();
    if (!live()) return;
    const [devices, admin] = await Promise.all([
      m.user ? api("/devices").then((b) => b.devices) : [],
      m.admin && m.user ? Promise.all([api("/invites"), api("/admin/phones"), api("/users")]) : null,
    ]);
    if (!live()) return;
    const mine = devices.filter((d) => d.userId === m.user?.id);
    const people = admin ? admin[2].users : [];
    const nameOf = (id) => people.find((u) => u.id === id)?.name ?? "nobody yet";
    app.innerHTML = `
      <div class="account-page">
        <h1>Account</h1>
        <section class="card">
          ${m.user
            ? `<div class="me">${m.user.picture ? `<img src="${esc(m.user.picture)}" alt="" referrerpolicy="no-referrer">` : ""}<div><b>${esc(m.user.name)}</b><span class="muted">${esc(m.user.email)}${m.user.admin ? " · owner" : ""}</span></div></div>`
            : `<p>Signed in with the original web token.</p>`}
          <button class="ghost" id="signout">Sign out</button>
        </section>
        ${m.user && !inApp() ? `
        <section class="card">
          <h2>Android app</h2>
          ${onAndroid() ? `<p>Records your drives in the background and uploads them as yours.</p>${appDownload()}${appSteps}`
            : `<p class="muted">To record drives, open this page on an Android phone (sign in with the same Google account) and download the app from here.</p>`}
        </section>` : ""}
        ${m.user ? `
        <section class="card">
          <h2>Your phones</h2>
          <p class="muted">Phones that upload your trips. A phone gets added when you sign in on it in the Fuelish app.</p>
          ${mine.length ? `<ul class="rows">${mine.map((d) => `<li><span><b>${esc(d.name)}</b><small class="muted">added ${ago(d.createdAtMs)} · last upload ${ago(d.lastUsedMs)}</small></span><button class="ghost" data-revoke="${esc(d.id)}">Remove</button></li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
        </section>` : ""}
        ${admin ? `
        <section class="card">
          <h2>Invite someone</h2>
          <p class="muted">Each link lets one person join with their Google account, within two weeks.</p>
          <button class="primary" id="invite">Make an invite link</button>
          <div id="invite-out"></div>
          ${admin[0].invites.filter((i) => !i.usedAtMs && i.expiresAtMs > Date.now()).length ? `<h3>Waiting to be used</h3><ul class="rows">${admin[0].invites.filter((i) => !i.usedAtMs && i.expiresAtMs > Date.now()).map((i) => `<li><span>Made ${ago(i.createdAtMs)}<small class="muted">expires ${ago(i.expiresAtMs)}</small></span><span><button class="ghost" data-copy="${esc(i.code)}">Copy link</button><button class="ghost" data-uninvite="${esc(i.code)}">Cancel</button></span></li>`).join("")}</ul>` : ""}
        </section>
        <section class="card">
          <h2>People</h2>
          <ul class="rows">${people.map((u) => `<li><span><b>${esc(u.name)}</b><small class="muted">${plural(u.trips, "trip")}${u.admin ? " · owner" : ""}${u.disabled ? " · turned off" : ""}</small></span>${u.admin ? "" : `<button class="ghost" data-disable="${esc(u.id)}" data-off="${u.disabled ? "" : "1"}">${u.disabled ? "Turn back on" : "Turn off"}</button>`}</li>`).join("")}</ul>
        </section>
        <section class="card">
          <h2>Phones that have uploaded</h2>
          <p class="muted">Whose trips each phone's recordings count as. Use this for a phone that recorded before its person joined.</p>
          <ul class="rows">${admin[1].phones.map((p) => `<li><span><b>${esc(p.model || "Phone")}</b><small class="muted">${esc(p.vehicle || "")}${p.vehicle ? " · " : ""}${plural(p.trips, "trip")} · last ${ago(p.lastMs)}</small></span>
            <select data-phone="${esc(p.deviceId)}" aria-label="Whose trips">${p.owners.length === 1 ? "" : `<option value="">${esc(p.owners.map(nameOf).join(" + "))}</option>`}${people.map((u) => `<option value="${esc(u.id)}" ${p.owners.length === 1 && p.owners[0] === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("")}</select></li>`).join("")}</ul>
        </section>` : ""}
      </div>`;

    document.getElementById("signout").onclick = signOut;
    const link = (code) => `${location.origin}/#/invite/${code}`;
    const copy = async (btn, text) => {
      try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { prompt("Copy this link:", text); }
    };
    // Runs a change from a button or picker: disabled while it runs; a failure is said next to it
    // and the control is left ready to try again (a picker goes back to what it showed).
    const act = async (el, fn) => {
      const was = el.tagName === "SELECT" ? el.dataset.was : null;
      el.disabled = true;
      el.parentElement.querySelector(".act-error")?.remove();
      try {
        await fn();
      } catch (e) {
        if (e.message === "unauthorized") throw e;
        if (was != null) el.value = was;
        el.insertAdjacentHTML("afterend", `<small class="bad act-error" role="alert">Didn't work: ${esc(e.message)}. Try again.</small>`);
      } finally {
        el.disabled = false;
      }
    };
    app.querySelectorAll("[data-revoke]").forEach((b) => (b.onclick = () => {
      if (!confirm("Remove this phone? It stops uploading until you sign in on it again.")) return;
      return act(b, async () => {
        await api(`/devices/${b.dataset.revoke}`, { method: "DELETE" });
        showAccount();
      });
    }));
    const inviteBtn = document.getElementById("invite");
    if (inviteBtn) inviteBtn.onclick = () => act(inviteBtn, async () => {
      {
        const inv = await api("/invites", { method: "POST" });
        const url = link(inv.code);
        const out = document.getElementById("invite-out");
        out.innerHTML = `<div class="invite-link"><input readonly value="${esc(url)}"><button class="ghost" id="copy-inv">Copy</button>${navigator.share ? `<button class="ghost" id="share-inv">Send…</button>` : ""}</div>`;
        out.querySelector("input").select();
        document.getElementById("copy-inv").onclick = (e) => copy(e.target, url);
        const share = document.getElementById("share-inv");
        if (share) share.onclick = () => navigator.share({ title: "Join Fuelish", text: "Join me on Fuelish to track your drives:", url }).catch(() => {});
      }
    });
    app.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => copy(b, link(b.dataset.copy))));
    app.querySelectorAll("[data-uninvite]").forEach((b) => (b.onclick = () => act(b, async () => {
      await api(`/invites/${b.dataset.uninvite}`, { method: "DELETE" });
      showAccount();
    })));
    app.querySelectorAll("[data-disable]").forEach((b) => (b.onclick = () => {
      const off = !!b.dataset.off;
      if (off && !confirm("Turn this person off? They're signed out everywhere and their phones stop uploading. Their trips stay.")) return;
      return act(b, async () => {
        await api(`/admin/users/${b.dataset.disable}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled: off }) });
        forget();
        await load();
        renderHeader();
        showAccount();
      });
    }));
    app.querySelectorAll("[data-phone]").forEach((s) => {
      s.dataset.was = s.value;
      s.onchange = () => {
        if (!s.value) return;
        return act(s, async () => {
          await api(`/admin/phones/${encodeURIComponent(s.dataset.phone)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: s.value }) });
          forget();
          await load();
          renderHeader();
          showAccount();
        });
      };
    });
  }

  return { load, forget, whoParam, whoFor, setWho, renderHeader, showLogin, showInvite, showAccount, nativeDone, signOut, inApp };
})();
window.Account = Account;
