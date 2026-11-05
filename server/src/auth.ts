// Who is asking: a signed-in person (cookie session), a phone (its upload key), or one of the two
// original shared tokens. People sign in with Google; the server checks Google's ID token itself.

export type Scope = "upload" | "read";

export interface AuthEnv {
  DB: D1Database;
  DEVICE_TOKEN: string;
  WEB_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  /** Tests only: a JWKS used instead of Google's published keys. */
  TEST_GOOGLE_JWKS?: string;
}

export interface Principal {
  scopes: Scope[];
  /** The person this counts as. Null only before the owner has claimed the server. */
  userId: string | null;
  admin: boolean;
  /** How the request proved itself: a browser session, a phone key, or an original shared token. */
  via: "session" | "device" | "legacy";
  /** The original WEB_TOKEN was presented (it proves ownership of the server). */
  legacyWeb: boolean;
}

export class AuthError extends Error {
  // staleSession: the browser's session cookie names a session that has ended (expired, signed out
  // elsewhere, or the person was turned off). Sign-in may replace it and any reply should clear it.
  constructor(public status: number, message: string, public staleSession = false) {
    super(message);
  }
}

export const SESSION_COOKIE = "fuelish_session";
export const SESSION_TTL_MS = 365 * 24 * 3600 * 1000;
export const INVITE_TTL_MS = 14 * 24 * 3600 * 1000;

// ---------- small helpers ----------

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(value: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`;
}

async function ownerId(env: AuthEnv): Promise<string | null> {
  const r = await env.DB.prepare("SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at_ms LIMIT 1").first<{ id: string }>();
  return r?.id ?? null;
}

// ---------- who is asking ----------

/**
 * Works out who sent the request, or null when it carries no credentials at all.
 * A bad or expired credential is an error (401), not "nobody".
 */
export async function identify(req: Request, env: AuthEnv): Promise<Principal | null> {
  const h = req.headers.get("Authorization") ?? "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (bearer) return fromBearer(bearer, env);

  const sid = cookie(req, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.user_id, s.expires_at_ms, s.last_seen_ms, u.is_admin, u.disabled_at_ms
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
  )
    .bind(await sha256Hex(sid))
    .first<any>();
  const now = Date.now();
  if (!row || row.expires_at_ms < now || row.disabled_at_ms != null) throw new AuthError(401, "signed out", true);
  // A cookie can be sent by any site that links here; a custom header can't be added cross-site
  // without the browser asking us first (and we never say yes). So changes need the header.
  if (!["GET", "HEAD"].includes(req.method) && req.headers.get("X-Fuelish") !== "1") throw new AuthError(403, "missing X-Fuelish header");
  if (now - row.last_seen_ms > 3600_000) {
    await env.DB.prepare("UPDATE sessions SET last_seen_ms = ? WHERE id_hash = ?").bind(now, row.id_hash).run();
  }
  return { scopes: ["read"], userId: row.user_id, admin: !!row.is_admin, via: "session", legacyWeb: false };
}

async function fromBearer(token: string, env: AuthEnv): Promise<Principal> {
  const scopes: Scope[] = [];
  let legacyWeb = false;
  if (env.DEVICE_TOKEN && (await safeEqual(token, env.DEVICE_TOKEN))) scopes.push("upload");
  if (env.WEB_TOKEN && (await safeEqual(token, env.WEB_TOKEN))) {
    scopes.push("read");
    legacyWeb = true;
  }
  if (scopes.length) {
    // The original tokens belong to the owner. Before anyone has signed in, trips have no owner yet.
    return { scopes, userId: await ownerId(env), admin: legacyWeb, via: "legacy", legacyWeb };
  }
  const key = await env.DB.prepare(
    `SELECT k.id, k.user_id, k.revoked_at_ms, k.last_used_ms, u.disabled_at_ms
     FROM device_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?`,
  )
    .bind(await sha256Hex(token))
    .first<any>();
  if (!key || key.revoked_at_ms != null || key.disabled_at_ms != null) throw new AuthError(401, "invalid token");
  const now = Date.now();
  if (!key.last_used_ms || now - key.last_used_ms > 3600_000) {
    await env.DB.prepare("UPDATE device_keys SET last_used_ms = ? WHERE id = ?").bind(now, key.id).run();
  }
  return { scopes: ["upload"], userId: key.user_id, admin: false, via: "device", legacyWeb: false };
}

// ---------- Google ID tokens ----------

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

let jwksCache: { keys: any[]; until: number } | null = null;

async function googleKeys(env: AuthEnv): Promise<any[]> {
  if (env.TEST_GOOGLE_JWKS) return JSON.parse(env.TEST_GOOGLE_JWKS).keys;
  if (jwksCache && jwksCache.until > Date.now()) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new AuthError(502, "couldn't reach Google to check the sign-in");
  const keys = ((await res.json()) as any).keys ?? [];
  // Google rotates keys every few days and says how long to keep them.
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1] ?? 3600);
  jwksCache = { keys, until: Date.now() + Math.min(maxAge, 86400) * 1000 };
  return keys;
}

/** Checks a Google ID token's signature, issuer, audience and expiry; returns who it's for. */
export async function verifyGoogleIdToken(token: string, env: AuthEnv): Promise<GoogleIdentity> {
  const bad = () => new AuthError(401, "Google sign-in didn't check out. Try again.");
  const parts = token.split(".");
  if (parts.length !== 3) throw bad();
  let header: any, claims: any;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch {
    throw bad();
  }
  if (header.alg !== "RS256") throw bad();
  const jwk = (await googleKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) throw bad();
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw bad();
  const now = Date.now() / 1000;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw bad();
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw bad();
  if (!(claims.exp > now - 60) || (claims.iat && claims.iat > now + 300)) throw bad();
  if (!claims.sub || !claims.email || claims.email_verified === false) throw bad();
  return { sub: String(claims.sub), email: String(claims.email), name: String(claims.name || claims.email), picture: claims.picture ? String(claims.picture) : null };
}

// ---------- signing in ----------

export interface SignInResult {
  user: { id: string; name: string; email: string; picture: string | null; admin: boolean };
  sessionToken: string;
  deviceToken?: string;
  /** This sign-in made them the owner (and gave them every trip that had no owner). */
  claimed: boolean;
}

/**
 * Signs a Google account in. A known account just signs in. A new one needs either a valid invite
 * or, while nobody owns the server yet, the original web token (which only the owner has).
 */
export async function signIn(
  env: AuthEnv,
  google: GoogleIdentity,
  opts: { invite?: string | null; caller: Principal | null; device?: { name: string } | null; userAgent?: string | null },
): Promise<SignInResult> {
  const now = Date.now();
  let user = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(google.sub).first<any>();
  let claimed = false;
  if (user && user.disabled_at_ms != null) throw new AuthError(403, "This account has been turned off. Ask the owner to turn it back on.");

  if (!user) {
    const owner = await ownerId(env);
    const id = randomToken(9);
    if (!owner) {
      if (!opts.caller?.legacyWeb) {
        throw new AuthError(403, "Nobody has set up this Fuelish yet. The owner signs in first, with the original web token.");
      }
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, is_admin, created_at_ms) VALUES (?, ?, ?, ?, ?, 1, ?)")
          .bind(id, google.sub, google.email, google.name, google.picture, now),
        env.DB.prepare("UPDATE recordings SET user_id = ? WHERE user_id IS NULL").bind(id),
      ]);
      claimed = true;
    } else {
      const code = opts.invite ?? "";
      const inv = code ? await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<any>() : null;
      if (!inv) throw new AuthError(403, "This Fuelish is invite-only. Ask the owner for an invite link.");
      if (inv.used_by || inv.revoked_at_ms != null || inv.expires_at_ms < now) {
        throw new AuthError(403, "That invite link has been used or has expired. Ask for a new one.");
      }
      await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, is_admin, created_at_ms) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .bind(id, google.sub, google.email, google.name, google.picture, now)
        .run();
      // Only one person gets each invite: if someone else took it meanwhile, undo this account.
      const take = await env.DB.prepare("UPDATE invites SET used_by = ?, used_at_ms = ? WHERE code = ? AND used_by IS NULL").bind(id, now, code).run();
      if (!take.meta.changes) {
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
        throw new AuthError(403, "That invite link has just been used. Ask for a new one.");
      }
    }
    user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<any>();
  } else {
    // Keep name, email and picture as Google has them now.
    await env.DB.prepare("UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?").bind(google.email, google.name, google.picture, user.id).run();
  }

  const sessionToken = randomToken();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at_ms, expires_at_ms, last_seen_ms, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(sessionToken), user.id, now, now + SESSION_TTL_MS, now, (opts.userAgent ?? "").slice(0, 200))
    .run();

  let deviceToken: string | undefined;
  if (opts.device) {
    deviceToken = randomToken();
    await env.DB.prepare("INSERT INTO device_keys (id, token_hash, user_id, name, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .bind(randomToken(9), await sha256Hex(deviceToken), user.id, opts.device.name.slice(0, 80) || "Phone", now)
      .run();
  }
  return {
    user: { id: user.id, name: google.name, email: google.email, picture: google.picture, admin: !!user.is_admin },
    sessionToken,
    deviceToken,
    claimed,
  };
}

export async function signOut(req: Request, env: AuthEnv): Promise<void> {
  const sid = cookie(req, SESSION_COOKIE);
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(sid)).run();
}
