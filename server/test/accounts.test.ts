import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://fuelish.test/api/v1";
const DEVICE = { Authorization: "Bearer test-device-token" };
const WEB = { Authorization: "Bearer test-web-token" };
const POST = { "Content-Type": "application/json", "X-Fuelish": "1" };

function call(path: string, init: RequestInit = {}) {
  return exports.default.fetch(new Request(BASE + path, init));
}

function b64url(bytes: Uint8Array | string) {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A Google ID token signed with the test key the Worker trusts. */
async function idToken(claims: Record<string, unknown>, over: { aud?: string; exp?: number } = {}) {
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.TEST_GOOGLE_PRIVATE_JWK), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: "https://accounts.google.com", aud: over.aud ?? env.GOOGLE_CLIENT_ID, iat: now, exp: over.exp ?? now + 3600,
    email_verified: true, ...claims,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const ANDREW = { sub: "g-andrew", email: "andrew@example.com", name: "Andrew" };
const DAD = { sub: "g-dad", email: "dad@example.com", name: "Dad" };

async function signIn(who: Record<string, unknown>, extra: object = {}, headers: Record<string, string> = {}) {
  return call("/auth/google", { method: "POST", headers: { ...POST, ...headers }, body: JSON.stringify({ credential: await idToken(who), ...extra }) });
}

function sessionOf(res: Response): Record<string, string> {
  const c = res.headers.get("Set-Cookie") ?? "";
  return { Cookie: c.split(";")[0] };
}

const meta = (id: string, deviceId: string) => JSON.stringify({ id, deviceId, status: "stopped", startedWallMs: 5000, chunkCount: 0 });

describe("accounts", () => {
  let andrew: Record<string, string>;
  let dadPhone: Record<string, string>;
  let dadId: string;

  it("refuses sign-in until the owner claims the server with the original token", async () => {
    // A trip uploaded with the original shared device token, before anyone signed in.
    expect((await call("/recordings/old1", { method: "PUT", headers: DEVICE, body: meta("old1", "andrew-phone") })).status).toBe(200);
    expect((await signIn(ANDREW)).status).toBe(403);
  });

  it("rejects tokens that aren't for this app, are expired, or are forged", async () => {
    const wrongAud = await idToken(ANDREW, { aud: "someone-else" });
    const expired = await idToken(ANDREW, { exp: Math.floor(Date.now() / 1000) - 3600 });
    const forged = (await idToken(ANDREW)).slice(0, -4) + "AAAA";
    for (const credential of [wrongAud, expired, forged, "not.a.token"]) {
      const r = await call("/auth/google", { method: "POST", headers: { ...POST, ...WEB }, body: JSON.stringify({ credential }) });
      expect(r.status).toBe(401);
    }
  });

  it("needs the X-Fuelish header, so another site can't sign someone in", async () => {
    const r = await call("/auth/google", { method: "POST", headers: { "Content-Type": "application/json", ...WEB }, body: JSON.stringify({ credential: await idToken(ANDREW) }) });
    expect(r.status).toBe(403);
  });

  it("makes the owner on a sign-in that carries the original web token, and gives them the old trips", async () => {
    const r = await signIn(ANDREW, {}, WEB);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ claimed: true, user: { name: "Andrew", admin: true } });
    expect(r.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    andrew = sessionOf(r);
    const list: any = await (await call("/recordings?user=me", { headers: andrew })).json();
    expect(list.recordings.map((x: any) => x.id)).toEqual(["old1"]);
    expect((await (await call("/me", { headers: andrew })).json() as any).user.admin).toBe(true);
  });

  it("lets a known account sign in again without anything else", async () => {
    expect((await signIn(ANDREW)).status).toBe(200);
  });

  it("lets a new person in only with an unused invite", async () => {
    expect((await signIn(DAD)).status).toBe(403);
    const inv: any = await (await call("/invites", { method: "POST", headers: { ...andrew, "X-Fuelish": "1" } })).json();
    expect((await call(`/invites/${inv.code}`)).status).toBe(200);
    expect(await (await call(`/invites/${inv.code}`)).json()).toEqual({ usable: true, from: "Andrew" });

    const r = await signIn(DAD, { invite: inv.code, device: { name: "Pixel 6" } });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.user.admin).toBe(false);
    expect(typeof body.deviceToken).toBe("string");
    dadId = body.user.id;
    dadPhone = { Authorization: `Bearer ${body.deviceToken}` };

    // Used up.
    expect((await signIn({ sub: "g-other", email: "o@example.com", name: "Other" }, { invite: inv.code })).status).toBe(403);
  });

  it("lets someone in with no link when the invite names their Google address", async () => {
    const make = (body: object) =>
      call("/invites", { method: "POST", headers: { ...andrew, ...POST }, body: JSON.stringify(body) });
    expect((await make({ email: "not an email" })).status).toBe(400);
    expect((await make({ email: "andrew@example.com" })).status).toBe(409); // already joined
    const inv: any = await (await make({ email: " Bro@Example.com " })).json();
    expect(inv.email).toBe("bro@example.com");
    expect(await (await call(`/invites/${inv.code}`)).json()).toEqual({ usable: true, from: "Andrew", email: "bro@example.com" });
    const listed: any = await (await call("/invites", { headers: andrew })).json();
    expect(listed.invites.find((i: any) => i.code === inv.code).email).toBe("bro@example.com");

    // Someone else without a link still can't get in; the named address can, with no code.
    expect((await signIn({ sub: "g-stranger", email: "stranger@example.com", name: "Stranger" })).status).toBe(403);
    const r = await signIn({ sub: "g-bro", email: "bro@example.com", name: "Bro" }, { device: { name: "Pixel 9" } });
    expect(r.status).toBe(200);
    expect(await (await call(`/invites/${inv.code}`)).json()).toEqual({ usable: false, from: null });
  });

  it("files a phone's uploads under its person, and keeps people out of each other's trips", async () => {
    expect((await call("/recordings/dad1", { method: "PUT", headers: dadPhone, body: meta("dad1", "dad-phone") })).status).toBe(200);
    const mine: any = await (await call("/recordings?user=me", { headers: andrew })).json();
    expect(mine.recordings.map((x: any) => x.id)).toEqual(["old1"]);
    const dads: any = await (await call(`/recordings?user=${dadId}`, { headers: andrew })).json();
    expect(dads.recordings.map((x: any) => x.id)).toEqual(["dad1"]);
    // A phone key can't add to someone else's trip.
    expect((await call("/recordings/old1", { method: "PUT", headers: dadPhone, body: meta("old1", "andrew-phone") })).status).toBe(403);
    // Phone keys upload; they can't read.
    expect((await call("/recordings", { headers: dadPhone })).status).toBe(403);
  });

  it("tells a phone whose account its key uploads as", async () => {
    const me: any = await (await call("/me", { headers: dadPhone })).json();
    expect(me.account).toEqual({ id: dadId, name: "Dad" });
    expect(me.user).toBeNull();
  });

  it("only lets the owner invite or manage people", async () => {
    const dad = sessionOf(await signIn(DAD));
    expect((await call("/invites", { method: "POST", headers: { ...dad, "X-Fuelish": "1" } })).status).toBe(403);
    expect((await call("/admin/phones", { headers: dad })).status).toBe(403);
  });

  it("moves a phone's trips to another person", async () => {
    const phones: any = await (await call("/admin/phones", { headers: andrew })).json();
    expect(phones.phones.map((p: any) => p.deviceId).sort()).toEqual(["andrew-phone", "dad-phone"]);
    const r = await call("/admin/phones/andrew-phone", { method: "PUT", headers: { ...andrew, ...POST }, body: JSON.stringify({ userId: dadId }) });
    expect(await r.json()).toEqual({ ok: true, trips: 1 });
    const dads: any = await (await call(`/recordings?user=${dadId}`, { headers: andrew })).json();
    expect(dads.recordings.map((x: any) => x.id).sort()).toEqual(["dad1", "old1"]);
  });

  it("refuses cookie changes without the X-Fuelish header", async () => {
    expect((await call("/invites", { method: "POST", headers: andrew })).status).toBe(403);
  });

  it("turns off a person's sessions and phone keys", async () => {
    const r = await call(`/admin/users/${dadId}`, { method: "PUT", headers: { ...andrew, ...POST }, body: JSON.stringify({ disabled: true }) });
    expect(r.status).toBe(200);
    expect((await call("/recordings/dad2", { method: "PUT", headers: dadPhone, body: meta("dad2", "dad-phone") })).status).toBe(401);
    expect((await signIn(DAD)).status).toBe(403);
  });

  it("signs out", async () => {
    const r = await call("/auth/logout", { method: "POST", headers: { ...andrew, "X-Fuelish": "1" } });
    expect(r.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    expect((await call("/me", { headers: andrew })).status).toBe(401);
  });

  it("lets a browser with an ended session sign in again or out, and clears the dead cookie", async () => {
    // `andrew`'s session was ended by the sign-out above.
    const me = await call("/me", { headers: andrew });
    expect(me.status).toBe(401);
    expect(me.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    const out = await call("/auth/logout", { method: "POST", headers: { ...andrew, "X-Fuelish": "1" } });
    expect(out.status).toBe(200);
    const again = await signIn(ANDREW, {}, andrew);
    expect(again.status).toBe(200);
    expect((await call("/me", { headers: sessionOf(again) })).status).toBe(200);
  });

  it("lists each trip with its person", async () => {
    const r: any = await (await call(`/recordings?user=${dadId}`, { headers: WEB })).json();
    expect(r.recordings.length).toBeGreaterThan(0);
    for (const x of r.recordings) expect(x.userId).toBe(dadId);
  });

  it("keeps the original tokens working", async () => {
    expect((await call("/recordings", { headers: WEB })).status).toBe(200);
    expect((await call("/recordings/old2", { method: "PUT", headers: DEVICE, body: meta("old2", "andrew-phone") })).status).toBe(200);
  });
});

describe("app updates", () => {
  const apk = (n: number) => new Uint8Array([0x50, 0x4b, 3, 4, n, n, n]); // "PK…": looks like a zip
  async function sha(b: Uint8Array) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  async function publish(code: number, body = apk(code), headers: Record<string, string> = WEB) {
    return call(`/app/apk?versionCode=${code}&versionName=0.1.${code}`, { method: "PUT", headers: { ...headers, "X-Fuelish-Sha256": await sha(body) }, body });
  }

  it("says there's nothing until the owner publishes a build", async () => {
    expect(await (await call("/app/latest", { headers: DEVICE })).json()).toEqual({ versionCode: 0 });
  });

  it("only lets the owner publish, and only newer, intact APKs", async () => {
    expect((await publish(5, apk(5), DEVICE)).status).toBe(403);
    expect((await publish(5, new Uint8Array([1, 2, 3]))).status).toBe(400);
    const bad = await call("/app/apk?versionCode=5&versionName=x", { method: "PUT", headers: { ...WEB, "X-Fuelish-Sha256": "0".repeat(64) }, body: apk(5) });
    expect(bad.status).toBe(422);
    expect((await publish(5)).status).toBe(201);
    expect((await publish(5)).status).toBe(409);
    expect((await publish(4)).status).toBe(409);
  });

  it("serves the latest to a phone", async () => {
    const latest: any = await (await call("/app/latest", { headers: DEVICE })).json();
    expect(latest).toMatchObject({ versionCode: 5, versionName: "0.1.5", sha256: await sha(apk(5)), bytes: 7 });
    const r = await call("/app/apk/5", { headers: DEVICE });
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(apk(5));
    expect((await call("/app/apk/5")).status).toBe(401);
    expect(new Uint8Array(await (await call("/app/apk/latest", { headers: WEB })).arrayBuffer())).toEqual(apk(5));
  });

  it("lets someone with a usable invite download the app before signing in", async () => {
    const owner = sessionOf(await signIn(ANDREW));
    const inv: any = await (await call("/invites", { method: "POST", headers: { ...owner, "X-Fuelish": "1" } })).json();
    const r = await call(`/app/apk/latest?invite=${inv.code}`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(apk(5));
    expect((await call("/app/apk/latest?invite=nope")).status).toBe(403);
    expect((await call("/app/apk/5?invite=" + inv.code)).status).toBe(401); // only the latest, from the invite page
    await call(`/invites/${inv.code}`, { method: "DELETE", headers: { ...owner, "X-Fuelish": "1" } });
    expect((await call(`/app/apk/latest?invite=${inv.code}`)).status).toBe(403);
  });
});
