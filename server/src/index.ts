// Fuelish API: receives recording metadata and gzip chunks from the phone,
// stores chunks in R2 and metadata in D1, and serves them back to the web app.

import { VIN_RE, decodeVin } from "./vehicles";
import { fuelProfile, sumProfiles } from "./fuelprofile";
import {
  AuthError, INVITE_TTL_MS, SESSION_TTL_MS, identify, randomToken, safeEqual, sessionCookie, signIn, signOut, verifyGoogleIdToken,
  type Principal, type Scope,
} from "./auth";

export interface Env {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ASSETS: Fetcher;
  DEVICE_TOKEN: string; // original shared upload token (counts as the owner's phone)
  WEB_TOKEN: string; // original shared read token (counts as the owner); also signs download links
  GOOGLE_CLIENT_ID: string; // the web OAuth client: Google ID tokens must be issued for it
  TEST_GOOGLE_JWKS?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_META_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 90 * 1024 * 1024; // Workers request bodies are capped at 100 MB
const LINK_TTL_S = 15 * 60;
const SHARE_RE = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
const PREF_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_PREF_BYTES = 64 * 1024;
const PAGE_SIZE = 500;
const STATUSES = new Set(["recording", "stopped", "interrupted"]);
const MAX_CHUNKS = 999_999; // chunk seqs are at most 6 digits
const MAX_TRACK_POINTS = 100_000;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await route(req, url, env, ctx);
    } catch (e) {
      // A dead session cookie is cleared, so the page can sign in again without it.
      if (e instanceof AuthError && e.staleSession) return json({ error: e.message }, e.status, { "Set-Cookie": sessionCookie("", 0) });
      if (e instanceof HttpError || e instanceof AuthError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function route(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, "").split("/").slice(3); // after /api/v1
  if (!url.pathname.startsWith("/api/v1/")) throw new HttpError(404, "not found");
  const m = req.method;

  // Signed download links work without a bearer token so the browser can stream them.
  if (m === "GET" && p[0] === "recordings" && p.length >= 3 && url.searchParams.has("sig")) {
    await verifySignedUrl(url, env);
    return download(p, env, ctx);
  }

  // Public data, no token: weekly average gas prices (for trip cost).
  if (m === "GET" && p[0] === "gas-prices" && p.length === 1) return gasPrices(ctx);

  // Share links work without a token: one recording, trimmed, read-only.
  if (m === "GET" && p[0] === "shared" && p.length === 2) return getShared(p[1], env);

  // Signing in needs no credentials (but takes the original web token into account, for the owner).
  // An ended session's cookie doesn't stop anyone signing in again or out: it's simply replaced.
  const who = await identify(req, env).catch((e) => {
    if (p[0] === "auth" && e instanceof AuthError && e.staleSession) return null;
    throw e;
  });

  if (p[0] === "auth") {
    if (m === "POST" && p[1] === "google" && p.length === 2) return googleSignIn(req, who, env);
    if (m === "POST" && p[1] === "logout" && p.length === 2) {
      await signOut(req, env);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
    }
    throw new HttpError(404, "not found");
  }
  // An invite's status, so its page can say who it's from before anyone signs in.
  if (m === "GET" && p[0] === "invites" && p.length === 2) return inviteInfo(p[1], env);
  // The invite page's download button: someone with a usable invite gets the app before signing in,
  // and signs in once, in the app.
  if (m === "GET" && p[0] === "app" && p[1] === "apk" && p[2] === "latest" && p.length === 3 && url.searchParams.has("invite")) {
    if (!(await usableInvite(url.searchParams.get("invite") ?? "", env))) throw new HttpError(403, "that invite has been used or has expired");
    return downloadApp("latest", env);
  }

  if (!who) throw new HttpError(401, "missing bearer token");
  const scopes = who.scopes;
  const need = (s: Scope) => {
    if (!scopes.includes(s)) throw new HttpError(403, `requires ${s} scope`);
  };
  const needAdmin = () => {
    if (!who.admin) throw new HttpError(403, "only the owner can do that");
  };

  if (m === "GET" && p[0] === "me" && p.length === 1) return me(who, env);

  if (p[0] === "users" && p.length === 1 && m === "GET") {
    need("read");
    return listUsers(env);
  }
  if (p[0] === "invites") {
    needAdmin();
    if (p.length === 1 && m === "GET") return listInvites(env);
    if (p.length === 1 && m === "POST") return createInvite(req, who, env);
    if (p.length === 2 && m === "DELETE") return revokeInvite(p[1], env);
    throw new HttpError(404, "not found");
  }
  if (p[0] === "devices") {
    need("read");
    if (p.length === 1 && m === "GET") return listDevices(who, env);
    if (p.length === 2 && m === "DELETE") return revokeDevice(who, p[1], env);
    throw new HttpError(404, "not found");
  }
  if (p[0] === "app") {
    // Any phone or person may check for and fetch the app; only the owner publishes it.
    if (p[1] === "latest" && p.length === 2 && m === "GET") return latestApp(env);
    if (p[1] === "apk" && p.length === 3 && m === "GET") return downloadApp(p[2], env);
    if (p[1] === "apk" && p.length === 2 && m === "PUT") {
      needAdmin();
      return publishApp(req, url, env);
    }
    throw new HttpError(404, "not found");
  }
  // A car's name from its VIN (the app asks after reading it over OBD).
  if (m === "GET" && p[0] === "vehicles" && p[1] === "vin" && p.length === 3) {
    if (!scopes.includes("upload") && !scopes.includes("read")) throw new HttpError(403, "requires upload or read scope");
    if (!VIN_RE.test(p[2])) throw new HttpError(400, "not a VIN");
    const v = await decodeVin(p[2]).catch((e) => {
      throw new HttpError(502, `couldn't look up the VIN: ${e.message}`);
    });
    if (!v) throw new HttpError(404, "that VIN didn't decode to a vehicle");
    return json(v);
  }
  if (p[0] === "admin") {
    needAdmin();
    if (p[1] === "phones" && p.length === 2 && m === "GET") return listPhones(env);
    if (p[1] === "phones" && p.length === 3 && m === "PUT") return setPhoneOwner(req, p[2], env);
    if (p[1] === "users" && p.length === 3 && m === "PUT") return setUserDisabled(req, who, p[2], env);
    throw new HttpError(404, "not found");
  }

  if (p[0] === "prefs") {
    need("read");
    if (p.length === 1 && m === "GET") return getPrefs(env);
    if (p.length === 2 && m === "PUT") return putPref(req, p[1], who, env);
    throw new HttpError(404, "not found");
  }

  if (p[0] !== "recordings") throw new HttpError(404, "not found");
  if (p.length === 1 && m === "GET") {
    need("read");
    return listRecordings(url, who, env);
  }
  const id = p[1];
  if (!id || !ID_RE.test(id)) throw new HttpError(400, "bad recording id");

  if (p.length === 2 && m === "PUT") {
    need("upload");
    return putRecording(req, id, who, env);
  }
  if (p.length === 2 && m === "GET") {
    need("read");
    return getRecording(id, env);
  }
  if (p.length === 3 && p[2] === "verify" && m === "POST") {
    need("upload");
    return verifyRecording(id, who, env);
  }
  if (p.length === 4 && p[2] === "chunks" && m === "PUT") {
    need("upload");
    return putChunk(req, id, parseSeq(p[3]), who, env);
  }
  if (p[2] === "shares") {
    need("read");
    await needTripOwner(id, who, env);
    if (p.length === 3 && m === "GET") return listShares(id, env);
    if (p.length === 3 && m === "POST") return createShare(id, env);
    if (p.length === 4 && m === "DELETE") return revokeShare(id, p[3], env);
  }
  if (p.length === 3 && p[2] === "links" && m === "POST") {
    need("read");
    return createLinks(url, id, env);
  }
  if (m === "GET" && (p[2] === "download" || p[2] === "chunks")) {
    need("read");
    return download(p, env, ctx);
  }
  throw new HttpError(404, "not found");
}

// ---------- auth ----------

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

async function signPath(path: string, env: Env): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S;
  const sig = await hmacHex(env.WEB_TOKEN, `GET\n${path}\n${exp}`);
  return `${path}?exp=${exp}&sig=${sig}`;
}

async function verifySignedUrl(url: URL, env: Env): Promise<void> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!env.WEB_TOKEN || !Number.isFinite(exp) || exp < Date.now() / 1000) throw new HttpError(403, "link expired");
  const want = await hmacHex(env.WEB_TOKEN, `GET\n${url.pathname}\n${exp}`);
  if (!(await safeEqual(sig, want))) throw new HttpError(403, "bad signature");
}

// ---------- upload ----------

// Refuses a body that says (or turns out) to be larger than `max`, before buffering much of it.
async function readBounded(req: Request, max: number, what: string): Promise<ArrayBuffer> {
  // No header means "unknown length" (a streamed body), not zero.
  const header = req.headers.get("Content-Length");
  const declared = header == null || header.trim() === "" ? NaN : Number(header);
  if (header != null && header.trim() !== "" && !(Number.isInteger(declared) && declared >= 0)) throw new HttpError(400, "bad Content-Length");
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, `${what} too large`);
  if (!req.body) return new ArrayBuffer(0);
  // With a declared length (the phone always sends one) the body goes straight into one buffer of
  // that size, so a large chunk is never held twice. Without one, the pieces are joined at the end.
  const known = Number.isFinite(declared) && declared >= 0 ? declared : null;
  const out = known != null ? new Uint8Array(known) : null;
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (n + value.byteLength > (known ?? max)) {
      await reader.cancel();
      throw new HttpError(known != null && known <= max ? 400 : 413, known != null && known <= max ? `${what} longer than its Content-Length` : `${what} too large`);
    }
    if (out) out.set(value, n); else parts.push(value);
    n += value.byteLength;
  }
  if (out) {
    if (n !== known) throw new HttpError(400, `${what} shorter than its Content-Length`);
    return out.buffer;
  }
  const joined = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { joined.set(p, o); o += p.byteLength; }
  return joined.buffer;
}

// Metadata arrives in the order requests finish, not the order the phone wrote it, so each copy
// carries `rev` (raised on every write). An older revision never replaces a newer one, and a
// finished recording is never reopened by a late "recording" snapshot.
async function putRecording(req: Request, id: string, who: Principal, env: Env): Promise<Response> {
  const text = new TextDecoder().decode(await readBounded(req, MAX_META_BYTES, "metadata"));
  let meta: any;
  try {
    meta = JSON.parse(text);
  } catch {
    throw new HttpError(400, "metadata is not JSON");
  }
  if (meta?.id !== id) throw new HttpError(400, "metadata id does not match URL");
  const deviceId = String(meta.deviceId ?? "");
  const status = String(meta.status ?? "");
  const startedAt = Number(meta.startedWallMs);
  if (!deviceId || !status || !Number.isFinite(startedAt)) {
    throw new HttpError(400, "metadata requires deviceId, status, startedWallMs");
  }
  if (!STATUSES.has(status)) throw new HttpError(400, "unknown status");
  if (meta.chunkCount != null && !(Number.isInteger(meta.chunkCount) && meta.chunkCount >= 0 && meta.chunkCount <= MAX_CHUNKS)) {
    throw new HttpError(400, "bad chunkCount");
  }
  if (meta.rev != null && !(Number.isInteger(meta.rev) && meta.rev >= 0)) throw new HttpError(400, "bad rev");
  const endedAt = Number.isFinite(Number(meta.endedWallMs)) && meta.endedWallMs != null ? Number(meta.endedWallMs) : null;
  const chunkCount = Number.isInteger(meta.chunkCount) && status !== "recording" ? meta.chunkCount : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO recordings (id, device_id, status, started_at_ms, ended_at_ms, chunk_count, meta_json, created_at_ms, updated_at_ms, user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, ended_at_ms = excluded.ended_at_ms, chunk_count = excluded.chunk_count,
       meta_json = excluded.meta_json, updated_at_ms = excluded.updated_at_ms
     WHERE recordings.device_id = excluded.device_id
       AND (recordings.user_id IS NULL OR excluded.user_id IS NULL OR recordings.user_id = excluded.user_id)
       AND COALESCE(json_extract(excluded.meta_json, '$.rev'), 0) >= COALESCE(json_extract(recordings.meta_json, '$.rev'), 0)
       AND NOT (recordings.status != 'recording' AND excluded.status = 'recording')`,
  )
    .bind(id, deviceId, status, startedAt, endedAt, chunkCount, text, now, who.userId)
    .run();
  const row = await env.DB.prepare("SELECT device_id, meta_json, user_id FROM recordings WHERE id = ?").bind(id).first<{ device_id: string; meta_json: string; user_id: string | null }>();
  if (row?.device_id !== deviceId) throw new HttpError(409, "recording id belongs to another device");
  if (!canWrite(who, row.user_id)) throw new HttpError(403, "recording belongs to someone else");
  // A stale copy is acknowledged (the phone has a newer one queued anyway) but not stored.
  return json({ ok: true, stale: row.meta_json !== text });
}

// The phone asks this before deleting its copy: does the server hold every chunk 0..chunkCount-1?
async function verifyRecording(id: string, who: Principal, env: Env): Promise<Response> {
  const d = await recordingDetail(id, env);
  if (!canWrite(who, d.recording.userId)) throw new HttpError(403, "recording belongs to someone else");
  return json({ complete: d.recording.complete, chunkCount: d.recording.chunkCount, missing: d.missing });
}

function parseSeq(s: string | undefined): number {
  if (!s || !/^\d{1,6}$/.test(s)) throw new HttpError(400, "bad chunk seq");
  return Number(s);
}

// Objects are named by their content, so two different uploads for one seq never overwrite each
// other's bytes; D1 decides which one is the chunk. (Chunks stored before this have the old name,
// kept in their r2_key.)
// The trip list reads every chunk's track (or, when the phone left the track out, its thinned
// routeOutline), so a malformed one is refused here rather than stored.
// Points are [wallMs, lat, lon, ...numbers or null]; see docs/data-format.md.
export function checkChunkMeta(meta: any): void {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new HttpError(400, "chunk metadata must be an object");
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  for (const key of ["track", "routeOutline"]) {
    const track = meta[key];
    if (track === undefined) continue;
    if (!Array.isArray(track) || track.length > MAX_TRACK_POINTS) throw new HttpError(400, `chunk ${key} must be an array of points`);
    for (const pt of track) {
      const ok =
        Array.isArray(pt) && pt.length >= 3 && pt.length <= 16 && num(pt[0]) &&
        pt.every((x) => x === null || num(x)) &&
        (pt[1] === null || (pt[1] >= -90 && pt[1] <= 90)) &&
        (pt[2] === null || (pt[2] >= -180 && pt[2] <= 180));
      if (!ok) throw new HttpError(400, `chunk ${key} has a bad point`);
    }
  }
}

function chunkKey(id: string, seq: number, sha: string): string {
  return `recordings/${id}/chunk-${String(seq).padStart(6, "0")}-${sha}.ndjson.gz`;
}

// A phone key may only add to its own person's trips; the original shared token predates people.
function canWrite(who: Principal, owner: string | null): boolean {
  return who.via === "legacy" || owner == null || owner === who.userId;
}

async function putChunk(req: Request, id: string, seq: number, who: Principal, env: Env): Promise<Response> {
  const sha = (req.headers.get("X-Fuelish-Sha256") ?? "").toLowerCase();
  if (!SHA_RE.test(sha)) throw new HttpError(400, "missing X-Fuelish-Sha256");
  const metaHeader = req.headers.get("X-Fuelish-Meta");
  let chunkMeta: string;
  try {
    chunkMeta = metaHeader ? JSON.stringify(JSON.parse(b64urlDecode(metaHeader))) : "{}";
  } catch {
    throw new HttpError(400, "X-Fuelish-Meta must be base64url JSON");
  }
  const parsedMeta = JSON.parse(chunkMeta);
  checkChunkMeta(parsedMeta);
  // The server's own summary of the engine data, for telling towing apart (see fuelprofile.ts).
  const profile = fuelProfile(parsedMeta);
  if (profile) chunkMeta = JSON.stringify({ ...parsedMeta, fuelProfile: profile });
  else if ("fuelProfile" in parsedMeta) {
    delete parsedMeta.fuelProfile;
    chunkMeta = JSON.stringify(parsedMeta);
  }

  const rec = await env.DB.prepare("SELECT id, chunk_count, user_id FROM recordings WHERE id = ?").bind(id).first<{ chunk_count: number | null; user_id: string | null }>();
  if (!rec) throw new HttpError(404, "upload recording metadata first");
  if (!canWrite(who, rec.user_id)) throw new HttpError(403, "recording belongs to someone else");
  if (rec.chunk_count != null && seq >= rec.chunk_count) throw new HttpError(400, `recording has only ${rec.chunk_count} chunks`);

  const existing = await env.DB.prepare("SELECT sha256 FROM chunks WHERE recording_id = ? AND seq = ?")
    .bind(id, seq)
    .first<{ sha256: string }>();
  if (existing) {
    // Retries of an already-stored chunk are acknowledged without rewriting anything.
    if (existing.sha256 === sha) return json({ ok: true, duplicate: true });
    throw new HttpError(409, "chunk already stored with different content");
  }

  const body = await readBounded(req, MAX_CHUNK_BYTES, "chunk");
  if (body.byteLength === 0) throw new HttpError(400, "empty chunk");
  const actual = hex(await crypto.subtle.digest("SHA-256", body));
  if (actual !== sha) throw new HttpError(422, "sha256 mismatch");

  const key = chunkKey(id, seq, sha);
  await env.RECORDINGS.put(key, body, {
    sha256: sha,
    httpMetadata: { contentType: "application/gzip" },
  });
  const ins = await env.DB.prepare(
    `INSERT INTO chunks (recording_id, seq, r2_key, bytes, sha256, meta_json, uploaded_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(id, seq, key, body.byteLength, sha, chunkMeta, Date.now())
    .run();
  if (!ins.meta.changes) {
    // Another upload of this seq got there first. Same bytes: a duplicate. Different bytes: ours
    // lost, so remove its object (the winner's has a different name and is untouched).
    const won = await env.DB.prepare("SELECT sha256 FROM chunks WHERE recording_id = ? AND seq = ?").bind(id, seq).first<{ sha256: string }>();
    if (won?.sha256 === sha) return json({ ok: true, duplicate: true });
    await env.RECORDINGS.delete(key);
    throw new HttpError(409, "chunk already stored with different content");
  }
  return json({ ok: true, duplicate: false }, 201);
}

// ---------- read ----------

// Newest first, a page at a time, ordered by (start time, id) so recordings sharing a start time are
// neither skipped nor repeated. `before` continues from the previous page's `next`: "<startMs>:<id>"
// (a bare start time, from older clients, is read as "everything that started earlier").
export function parseCursor(before: string | null): { ms: number; id: string } {
  if (!before) return { ms: Number.MAX_SAFE_INTEGER, id: "" };
  const m = /^(\d{1,16})(?::([A-Za-z0-9_-]{1,64}))?$/.exec(before);
  if (!m) throw new HttpError(400, "bad cursor");
  return { ms: Number(m[1]), id: m[2] ?? "" };
}

// `user`: one person's trips ("me" for the caller's own); without it, everyone's.
async function listRecordings(url: URL, who: Principal, env: Env): Promise<Response> {
  const { ms, id } = parseCursor(url.searchParams.get("before"));
  let user = url.searchParams.get("user");
  if (user === "me") user = who.userId ?? "";
  if (user != null && !/^[A-Za-z0-9_-]{0,64}$/.test(user)) throw new HttpError(400, "bad user");
  // Counting a recording's chunks uses the (recording_id, seq) key, so this stays small however long
  // the drives are. Each trip's route summary comes from list_json (see listParts).
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.device_id, r.user_id, r.status, r.started_at_ms, r.ended_at_ms, r.chunk_count, r.meta_json, r.updated_at_ms,
            r.list_json, r.list_key,
            (SELECT COUNT(*) FROM chunks c WHERE c.recording_id = r.id) AS chunks_received,
            (SELECT COUNT(*) FROM chunks c WHERE c.recording_id = r.id AND c.seq < r.chunk_count) AS chunks_in_range,
            (SELECT COALESCE(SUM(c.bytes), 0) FROM chunks c WHERE c.recording_id = r.id) AS bytes
     FROM recordings r WHERE (r.started_at_ms < ?1 OR (r.started_at_ms = ?1 AND r.id < ?2))
       AND (?4 IS NULL OR COALESCE(r.user_id, '') = ?4)
     ORDER BY r.started_at_ms DESC, r.id DESC LIMIT ?3`,
  )
    .bind(ms, id, PAGE_SIZE, user)
    .all<any>();
  const rows = results.map((r) => ({ r, row: recordingRow(r) }));
  const parts = await listParts(rows.map(({ r, row }) => ({ id: r.id, chunks: r.chunks_received, endMs: row.driveEndWallMs, key: r.list_key, json: r.list_json })), env);
  const last = results.at(-1);
  return json({
    recordings: rows.map(({ r, row }) => ({ ...row, ...parts.get(r.id) })),
    next: results.length === PAGE_SIZE ? `${last.started_at_ms}:${last.id}` : null,
  });
}

// Raise when tripSummary, stopsOf or sumProfiles change what they return, so stored ones are redone.
const LIST_VERSION = 1;
const listKey = (chunks: number, endMs: number | null) => `v${LIST_VERSION}:${chunks}:${endMs ?? ""}`;
// How many recordings' tracks are read in one go when their summaries need working out.
const LIST_BATCH = 20;

type ListParts = { trip: ReturnType<typeof tripSummary>; routeGaps: number; fuelProfile: ReturnType<typeof sumProfiles> | null };

// What the list shows for each recording beyond its row: the route summary, chunks whose route it
// couldn't see (routeGaps), and the fuel profile. Kept in list_json and worked out again only when
// list_key no longer matches: chunks are never changed once stored, so their count says whether
// anything new arrived. A chunk landing mid-way leaves a key that won't match next time.
async function listParts(
  recs: { id: string; chunks: number; endMs: number | null; key: string | null; json: string | null }[],
  env: Env,
): Promise<Map<string, ListParts>> {
  const out = new Map<string, ListParts>();
  const stale: typeof recs = [];
  for (const rec of recs) {
    if (rec.key === listKey(rec.chunks, rec.endMs) && rec.json) {
      try {
        out.set(rec.id, JSON.parse(rec.json));
        continue;
      } catch {
        // fall through: work it out again
      }
    }
    stale.push(rec);
  }
  for (let i = 0; i < stale.length; i += LIST_BATCH) {
    const group = stale.slice(i, i + LIST_BATCH);
    const read = await env.DB.batch(
      group.map((rec) =>
        env.DB.prepare(
          `SELECT json_group_array(COALESCE(json_extract(meta_json, '$.track'), json_extract(meta_json, '$.routeOutline'))) AS tracks,
                  json_group_array(json_extract(meta_json, '$.fuelProfile')) AS profiles,
                  COUNT(CASE WHEN json_extract(meta_json, '$.track') IS NULL AND json_extract(meta_json, '$.routeOutline') IS NULL
                               AND json_extract(meta_json, '$.streams."loc:gps"') IS NOT NULL THEN 1 END) AS untracked
           FROM (SELECT meta_json FROM chunks WHERE recording_id = ? ORDER BY seq)`,
        ).bind(rec.id),
      ),
    );
    const writes: D1PreparedStatement[] = [];
    group.forEach((rec, k) => {
      const c: any = read[k].results[0] ?? {};
      // One damaged summary (stored before tracks were checked) costs that trip its outline, not the list.
      let trip = null;
      try {
        trip = tripSummary(c.tracks, rec.endMs);
      } catch (e) {
        console.error(`trip summary for ${rec.id}:`, e);
      }
      // routeGaps: chunks with GPS whose route the list couldn't see (summary left out before
      // phones sent an outline). Their trip may say less than was driven; the trip page has it all.
      let fuelProfile = null;
      try {
        fuelProfile = sumProfiles(JSON.parse(c.profiles ?? "[]"));
      } catch (e) {
        console.error(`fuel profile for ${rec.id}:`, e);
      }
      const parts: ListParts = { trip, routeGaps: c.untracked ?? 0, fuelProfile };
      out.set(rec.id, parts);
      writes.push(env.DB.prepare("UPDATE recordings SET list_json = ?, list_key = ? WHERE id = ?").bind(JSON.stringify(parts), listKey(rec.chunks, rec.endMs), rec.id));
    });
    // Saving is only a shortcut for next time: a failure here mustn't fail the list.
    if (writes.length) await env.DB.batch(writes).catch((e) => console.error("saving list summaries:", e));
  }
  return out;
}

// When the drive itself ended. An automatic stop waits a while after the car goes away
// (Bluetooth disconnect, or the engine stops answering), and that wait isn't driving: it's
// usually the walk away from the car. The phone stamps the stop when the wait runs out, so
// the drive ended one wait earlier. Manual stops and recordings still going end when they end.
// Phones since late 2026 record the moment itself (driveEndWallMs); older recordings get the estimate.
export function driveEndMs(meta: any, endedAtMs: number | null): number | null {
  if (endedAtMs == null) return null;
  const stamped = Number(meta?.driveEndWallMs);
  if (meta?.driveEndWallMs != null && Number.isFinite(stamped)) return Math.max(meta?.startedWallMs ?? 0, Math.min(endedAtMs, stamped));
  const auto = meta?.config?.auto ?? {};
  const waitS =
    meta?.stopReason === "car_disconnected" ? auto.stopAfterCarDisconnectS
    : meta?.stopReason === "engine_off" ? auto.stopAfterEngineOffS
    : 0;
  const wait = Number.isFinite(waitS) && waitS > 0 ? waitS * 1000 : 0;
  return Math.max(meta?.startedWallMs ?? 0, endedAtMs - wait);
}

// Distance, speeds and a small route outline for the list, from the GPS track every chunk's
// stats carry ([wallMs, lat, lon, speedMps, hAccM, ...]; older chunks have a fix every 5 s).
// Fixes after endMs (the drive's end; see driveEndMs) are left out.
export function tripSummary(tracksJson: string, endMs: number | null = null) {
  const fixes: number[][] = [];
  for (const t of JSON.parse(tracksJson || "[]")) {
    let arr = t;
    if (typeof t === "string") {
      try {
        arr = JSON.parse(t);
      } catch {
        continue; // one bad chunk's track: skip it, keep the rest
      }
    }
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]) && (endMs == null || p[0] <= endMs)) fixes.push(p);
      }
    }
  }
  if (fixes.length < 2) return null;
  fixes.sort((a, b) => a[0] - b[0]);
  let meters = 0, maxMps = 0, movingMs = 0;
  for (let i = 1; i < fixes.length; i++) {
    const [t0, la0, lo0, v0, a0] = fixes[i - 1], [t1, la1, lo1, v1, a1] = fixes[i];
    meters += segmentMeters(t1 - t0, haversine(la0, lo0, la1, lo1), v0, v1, a0, a1);
    if (t1 - t0 <= MAX_GAP_MS && ((v0 ?? 0) > 0.5 || (v1 ?? 0) > 0.5)) movingMs += t1 - t0;
  }
  for (const p of fixes) if (p[3] != null) maxMps = Math.max(maxMps, p[3]);
  const step = Math.max(1, Math.ceil(fixes.length / 80));
  const path = fixes.filter((_, i) => i % step === 0 || i === fixes.length - 1).map((p) => [round5(p[1]), round5(p[2])]);
  return { meters: Math.round(meters), maxMps, movingMs, path, stops: stopsOf(fixes) };
}

// Where a drive stood still along the way (not at its start or end) for at least STOP_MS: [lat, lon,
// ms], at the stop's average position, so the list can name places visited in the middle of a trip
// (dropping someone off). Only fixes with a speed count; a gap in the track ends a stop.
const STOP_MS = 30_000;
function stopsOf(fixes: number[][]): number[][] {
  const out: number[][] = [];
  let run: number[][] = [];
  const close = (last: boolean) => {
    if (run.length && !last && run[0] !== fixes[0] && run.at(-1)![0] - run[0][0] >= STOP_MS) {
      const n = run.length;
      out.push([round5(run.reduce((a, p) => a + p[1], 0) / n), round5(run.reduce((a, p) => a + p[2], 0) / n), run.at(-1)![0] - run[0][0]]);
    }
    run = [];
  };
  for (const p of fixes) {
    const still = p[3] != null && p[3] < 0.5;
    if (still && run.length && p[0] - run.at(-1)![0] > MAX_GAP_MS) close(false);
    if (still) run.push(p);
    else close(false);
  }
  close(true); // still standing at the end: that's where it ended, not a stop
  return out;
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

// Distance policy, the same here and in the web page (route.js): a step between two fixes counts
// unless it bridges a gap in the track, the car was standing still (GPS speed under 0.5 m/s at both
// ends: position wander while parked), or it's an impossible jump. Without speeds, a step counts
// only when it's longer than the fixes' own uncertainty.
const MAX_GAP_MS = 30_000;
export function segmentMeters(dtMs: number, d: number, v0?: number | null, v1?: number | null, acc0?: number | null, acc1?: number | null): number {
  if (dtMs <= 0 || dtMs > MAX_GAP_MS) return 0;
  if (d / (dtMs / 1000) > 90) return 0; // over 200 mph: a bad fix, not a drive
  if (v0 != null && v1 != null) return v0 > 0.5 || v1 > 0.5 ? d : 0;
  return d > Math.max(acc0 ?? 0, acc1 ?? 0, 10) ? d : 0;
}

function haversine(la1: number, lo1: number, la2: number, lo2: number): number {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

function recordingRow(r: any) {
  const meta = JSON.parse(r.meta_json);
  return {
    id: r.id,
    deviceId: r.device_id,
    userId: r.user_id ?? null,
    status: r.status,
    startedWallMs: r.started_at_ms,
    endedWallMs: r.ended_at_ms,
    driveEndWallMs: driveEndMs(meta, r.ended_at_ms),
    chunkCount: r.chunk_count,
    chunksReceived: r.chunks_received,
    bytes: r.bytes,
    // Every seq 0..chunkCount-1 is here (seqs are unique per recording), not just as many chunks.
    complete: r.chunk_count != null && r.chunks_in_range === r.chunk_count,
    updatedAtMs: r.updated_at_ms,
    meta,
  };
}

async function getRecording(id: string, env: Env): Promise<Response> {
  return json(await recordingDetail(id, env));
}

async function recordingDetail(id: string, env: Env) {
  const r = await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM chunks WHERE recording_id = r.id) AS chunks_received,
            (SELECT COUNT(*) FROM chunks WHERE recording_id = r.id AND seq < r.chunk_count) AS chunks_in_range,
            (SELECT COALESCE(SUM(bytes), 0) FROM chunks WHERE recording_id = r.id) AS bytes
     FROM recordings r WHERE r.id = ?`,
  )
    .bind(id)
    .first<any>();
  if (!r) throw new HttpError(404, "recording not found");
  const { results } = await env.DB.prepare(
    "SELECT seq, bytes, sha256, meta_json, uploaded_at_ms FROM chunks WHERE recording_id = ? ORDER BY seq",
  )
    .bind(id)
    .all<any>();
  const chunks = results.map((c) => ({
    seq: c.seq,
    bytes: c.bytes,
    sha256: c.sha256,
    uploadedAtMs: c.uploaded_at_ms,
    meta: JSON.parse(c.meta_json),
  }));
  const have = new Set(chunks.map((c) => c.seq));
  const expected = r.chunk_count ?? (chunks.length ? chunks[chunks.length - 1].seq + 1 : 0);
  const missing: number[] = [];
  for (let s = 0; s < expected; s++) if (!have.has(s)) missing.push(s);
  return { recording: recordingRow(r), chunks, missing };
}

// ---------- prefs ----------

// `versions`: each setting's version (its last change, ms). A save sends back the version it started
// from (X-Fuelish-Base), so one made from an out-of-date copy is refused instead of undoing someone
// else's change.
async function getPrefs(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT key, value_json, updated_at_ms FROM prefs").all<{ key: string; value_json: string; updated_at_ms: number }>();
  return json({
    prefs: Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value_json)])),
    versions: Object.fromEntries(results.map((r) => [r.key, r.updated_at_ms])),
  });
}

// Entries of two objects that differ (added, changed or removed).
function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * What someone other than the owner may change. Place names are shared by everyone. The cost
 * settings everyone starts from are the owner's. Vehicle costs: only vehicles on your own trips.
 * Towing corrections: only your own trips. (Your own time is handled in putPref.)
 */
async function checkPrefChange(key: string, stored: any, value: any, who: Principal, env: Env): Promise<void> {
  if (who.admin || key === "places" || key === "people") return;
  if (key === "costs") throw new HttpError(403, "only the owner can change the shared cost settings");
  if (!who.userId) throw new HttpError(403, "sign in to change this");
  const changed = changedKeys(stored ?? {}, value ?? {});
  if (!changed.length) return;
  if (key === "towing") {
    const own = await env.DB.batch(changed.map((id) => env.DB.prepare("SELECT 1 FROM recordings WHERE id = ? AND user_id = ?").bind(id, who.userId)));
    if (own.some((r) => !r.results.length)) throw new HttpError(403, "you can only correct towing on your own trips");
    return;
  }
  if (key === "vehicles") {
    const own = await env.DB.batch(
      changed.map((name) => env.DB.prepare("SELECT 1 FROM recordings WHERE user_id = ? AND json_extract(meta_json, '$.vehicle') = ? LIMIT 1").bind(who.userId, name)),
    );
    const bad = changed.filter((_, i) => !own[i].results.length);
    if (bad.length) throw new HttpError(403, `only the people who drive it can change the costs for ${bad.join(", ")}`);
  }
}

// What each setting may hold, so a malformed value can't break the pages that read it.
export function validPref(key: string, v: any): string | null {
  const num = (x: any, max: number) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max;
  if (key === "places") {
    if (!Array.isArray(v) || v.length > 500) return "places must be a list of at most 500";
    for (const p of v) {
      if (!p || typeof p !== "object" || !num(Math.abs(p.lat), 90) || !num(Math.abs(p.lon), 180) || typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) {
        return "each place needs lat, lon and a name of 1-80 characters";
      }
    }
    return null;
  }
  if (key === "costs") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return "costs must be an object";
    const limits: Record<string, number> = { timePerHour: 10000, wearPerMile: 100, valuePerMile: 100, co2KgPerGal: 100, carbonPerTonne: 100000, otherPerMile: 100 };
    for (const [k, x] of Object.entries(v)) {
      if (!(k in limits)) return `unknown cost setting ${k}`;
      if (!num(x, limits[k])) return `${k} must be a number from 0 to ${limits[k]}`;
    }
    return null;
  }
  // Per vehicle (by the name trips carry): what a mile costs in wear, lost value and anything else.
  if (key === "vehicles") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return "vehicles must be an object";
    if (Object.keys(v).length > 50) return "at most 50 vehicles";
    for (const [name, c] of Object.entries<any>(v)) {
      if (!name.trim() || name.length > 120) return "vehicle names are 1-120 characters";
      if (!c || typeof c !== "object" || Array.isArray(c)) return `costs for ${name} must be an object`;
      for (const [k, x] of Object.entries(c)) {
        if (!["wearPerMile", "valuePerMile", "otherPerMile"].includes(k)) return `unknown vehicle cost ${k}`;
        if (!num(x, 100)) return `${k} must be a number from 0 to 100`;
      }
    }
    return null;
  }
  // Per person (by user id): what an hour of their time is worth to them.
  if (key === "people") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return "people must be an object";
    if (Object.keys(v).length > 100) return "at most 100 people";
    for (const [id, c] of Object.entries<any>(v)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return "bad person id";
      if (!c || typeof c !== "object" || Array.isArray(c)) return "each person's settings must be an object";
      for (const [k, x] of Object.entries(c)) {
        if (k !== "timePerHour") return `unknown personal setting ${k}`;
        if (!num(x, 10000)) return "timePerHour must be a number from 0 to 10000";
      }
    }
    return null;
  }
  // Corrections to towing detection: recording id -> towing or not.
  if (key === "towing") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return "towing must be an object";
    if (Object.keys(v).length > 2000) return "at most 2000 corrections";
    for (const [id, x] of Object.entries(v)) {
      if (!ID_RE.test(id) || typeof x !== "boolean") return "towing maps recording ids to true or false";
    }
    return null;
  }
  return `unknown setting ${key}`;
}

async function putPref(req: Request, key: string, who: Principal, env: Env): Promise<Response> {
  if (!PREF_RE.test(key)) throw new HttpError(400, "bad pref key");
  let text = new TextDecoder().decode(await readBounded(req, MAX_PREF_BYTES, "pref"));
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "pref value is not JSON");
  }
  const bad = validPref(key, value);
  if (bad) throw new HttpError(400, bad);
  const baseHeader = req.headers.get("X-Fuelish-Base");
  const base = baseHeader == null || baseHeader === "" ? null : Number(baseHeader);
  if (base != null && !(Number.isInteger(base) && base >= 0)) throw new HttpError(400, "bad X-Fuelish-Base");
  const row = await env.DB.prepare("SELECT value_json, updated_at_ms FROM prefs WHERE key = ?").bind(key).first<{ value_json: string; updated_at_ms: number }>();
  const stored = row ? JSON.parse(row.value_json) : null;
  const conflict = () => json({ error: "changed since you loaded it", value: stored, version: row?.updated_at_ms ?? 0 }, 409);
  // Saved from an out-of-date copy: the page applies its edit to the newer value and tries again.
  if (base != null && base !== (row?.updated_at_ms ?? 0)) return conflict();
  await checkPrefChange(key, stored, value, who, env);
  // Everyone sets their own time's worth; only the owner can change someone else's.
  if (key === "people" && !who.admin) {
    if (!who.userId) throw new HttpError(403, "sign in to set your own time");
    const next = { ...(stored ?? {}) };
    const mine = (value as any)[who.userId];
    if (mine) next[who.userId] = mine;
    else delete next[who.userId];
    text = JSON.stringify(next);
  }
  // Only over the version just read, so a save landing in between isn't lost. Versions always rise.
  const now = Math.max(Date.now(), (row?.updated_at_ms ?? 0) + 1);
  const res = row
    ? await env.DB.prepare("UPDATE prefs SET value_json = ?, updated_at_ms = ? WHERE key = ? AND updated_at_ms = ?").bind(text, now, key, row.updated_at_ms).run()
    : await env.DB.prepare("INSERT INTO prefs (key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING").bind(key, text, now).run();
  if (!res.meta.changes) {
    if (base == null) throw new HttpError(409, "changed while saving; try again");
    const fresh = await env.DB.prepare("SELECT value_json, updated_at_ms FROM prefs WHERE key = ?").bind(key).first<{ value_json: string; updated_at_ms: number }>();
    return json({ error: "changed since you loaded it", value: fresh ? JSON.parse(fresh.value_json) : null, version: fresh?.updated_at_ms ?? 0 }, 409);
  }
  return json({ ok: true, version: now, value: JSON.parse(text) });
}

// ---------- share links ----------

function shareToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Sharing a trip, and seeing or stopping its links, is up to the person whose trip it is (or the owner).
async function needTripOwner(id: string, who: Principal, env: Env): Promise<void> {
  const r = await env.DB.prepare("SELECT user_id FROM recordings WHERE id = ?").bind(id).first<{ user_id: string | null }>();
  if (!r) throw new HttpError(404, "recording not found");
  if (!who.admin && (r.user_id == null || r.user_id !== who.userId)) throw new HttpError(403, "only the person whose trip it is can share it");
}

async function listShares(id: string, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT token, created_at_ms FROM shares WHERE recording_id = ? AND revoked_at_ms IS NULL ORDER BY created_at_ms",
  )
    .bind(id)
    .all<any>();
  return json({ shares: results.map((s) => ({ token: s.token, createdAtMs: s.created_at_ms })) });
}

async function createShare(id: string, env: Env): Promise<Response> {
  const exists = await env.DB.prepare("SELECT 1 FROM recordings WHERE id = ?").bind(id).first();
  if (!exists) throw new HttpError(404, "recording not found");
  const token = shareToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO shares (token, recording_id, created_at_ms) VALUES (?, ?, ?)").bind(token, id, now).run();
  return json({ token, createdAtMs: now }, 201);
}

async function revokeShare(id: string, token: string, env: Env): Promise<Response> {
  await env.DB.prepare("UPDATE shares SET revoked_at_ms = ? WHERE token = ? AND recording_id = ? AND revoked_at_ms IS NULL")
    .bind(Date.now(), token, id)
    .run();
  return json({ ok: true });
}

// What a share link shows: the trip and its chunk summaries (route, engine data), but none of the
// phone's settings, Bluetooth addresses or device details, and no raw chunks.
export function sharedView(detail: { recording: any; chunks: any[]; missing: number[] }) {
  const r = detail.recording, m = r.meta ?? {};
  const meta: Record<string, unknown> = {};
  for (const k of ["vehicle", "trigger", "stopReason", "timezone", "startedWallMs"]) if (m[k] != null) meta[k] = m[k];
  return {
    recording: {
      id: r.id, status: r.status, startedWallMs: r.startedWallMs, endedWallMs: r.endedWallMs, driveEndWallMs: r.driveEndWallMs,
      chunkCount: r.chunkCount, chunksReceived: r.chunksReceived, complete: r.complete, updatedAtMs: r.updatedAtMs, meta,
    },
    chunks: detail.chunks.map((c) => ({ seq: c.seq, meta: c.meta })),
    missing: detail.missing,
  };
}

async function getShared(token: string, env: Env): Promise<Response> {
  if (!SHARE_RE.test(token)) throw new HttpError(404, "This link isn't shared.");
  const s = await env.DB.prepare("SELECT recording_id, revoked_at_ms FROM shares WHERE token = ?").bind(token).first<any>();
  if (!s) throw new HttpError(404, "This link isn't shared.");
  if (s.revoked_at_ms != null) throw new HttpError(404, "This trip is no longer shared.");
  return json(sharedView(await recordingDetail(s.recording_id, env)));
}

async function createLinks(url: URL, id: string, env: Env): Promise<Response> {
  const base = `/api/v1/recordings/${id}`;
  const { results } = await env.DB.prepare("SELECT seq FROM chunks WHERE recording_id = ? ORDER BY seq")
    .bind(id)
    .all<{ seq: number }>();
  const all = url.origin + (await signPath(`${base}/download`, env));
  const chunks: Record<number, string> = {};
  for (const { seq } of results) chunks[seq] = url.origin + (await signPath(`${base}/chunks/${seq}`, env));
  return json({ all, chunks, expiresInSeconds: LINK_TTL_S });
}

async function download(p: string[], env: Env, ctx: ExecutionContext): Promise<Response> {
  const id = p[1];
  if (!ID_RE.test(id)) throw new HttpError(400, "bad recording id");
  if (p[2] === "chunks" && p.length === 4) {
    const seq = parseSeq(p[3]);
    const row = await env.DB.prepare("SELECT r2_key FROM chunks WHERE recording_id = ? AND seq = ?").bind(id, seq).first<{ r2_key: string }>();
    const obj = row && (await env.RECORDINGS.get(row.r2_key));
    if (!obj) throw new HttpError(404, "chunk not found");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(obj.size),
        "Content-Disposition": `attachment; filename="${id}-chunk-${String(seq).padStart(6, "0")}.ndjson.gz"`,
      },
    });
  }
  if (p[2] !== "download" || p.length !== 3) throw new HttpError(404, "not found");

  // Concatenated gzip members are themselves a valid gzip stream, so the whole
  // recording downloads as one .ndjson.gz without decompressing anything here.
  const { results } = await env.DB.prepare(
    "SELECT seq, r2_key, bytes FROM chunks WHERE recording_id = ? ORDER BY seq",
  )
    .bind(id)
    .all<{ seq: number; r2_key: string; bytes: number }>();
  if (!results.length) throw new HttpError(404, "no chunks uploaded");
  const total = results.reduce((n, c) => n + c.bytes, 0);
  const { readable, writable } = new FixedLengthStream(total);
  ctx.waitUntil(
    (async () => {
      try {
        for (const c of results) {
          const obj = await env.RECORDINGS.get(c.r2_key);
          if (!obj) throw new Error(`missing R2 object ${c.r2_key}`);
          await obj.body.pipeTo(writable, { preventClose: true });
        }
        await writable.close();
      } catch (e) {
        console.error(e);
        await writable.abort(e);
      }
    })(),
  );
  return new Response(readable, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${id}.ndjson.gz"`,
    },
  });
}

// ---------- accounts ----------

async function googleSignIn(req: Request, who: Principal | null, env: Env): Promise<Response> {
  // Same rule as other changes made with a cookie: a page on another site can't sign someone in.
  if (req.headers.get("X-Fuelish") !== "1") throw new HttpError(403, "missing X-Fuelish header");
  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBounded(req, 16 * 1024, "sign-in")));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "sign-in body is not JSON");
  }
  if (typeof body?.credential !== "string") throw new HttpError(400, "missing credential");
  const google = await verifyGoogleIdToken(body.credential, env);
  const device = body.device && typeof body.device.name === "string" ? { name: body.device.name } : null;
  const r = await signIn(env, google, {
    invite: typeof body.invite === "string" ? body.invite : null,
    caller: who,
    device,
    userAgent: req.headers.get("User-Agent"),
  });
  return json(
    { user: r.user, claimed: r.claimed, ...(r.deviceToken ? { deviceToken: r.deviceToken } : {}) },
    200,
    { "Set-Cookie": sessionCookie(r.sessionToken, SESSION_TTL_MS / 1000) },
  );
}

async function me(who: Principal, env: Env): Promise<Response> {
  const u = who.userId ? await env.DB.prepare("SELECT id, name, email, picture, is_admin FROM users WHERE id = ?").bind(who.userId).first<any>() : null;
  const owned = await env.DB.prepare("SELECT 1 FROM users WHERE is_admin = 1 LIMIT 1").first();
  return json({
    scopes: who.scopes,
    via: who.via,
    admin: who.admin,
    // Only someone signed in with Google (or the owner's original token) gets their details back.
    user: u && who.via !== "device" ? { id: u.id, name: u.name, email: u.email, picture: u.picture, admin: !!u.is_admin } : null,
    // Whose trips this credential uploads as: a phone checks this so trips recorded under one account
    // never quietly upload as another after someone else signs in on it.
    account: u ? { id: u.id, name: u.name } : null,
    claimed: !!owned,
  });
}

async function listUsers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.picture, u.is_admin, u.disabled_at_ms, (SELECT COUNT(*) FROM recordings r WHERE r.user_id = u.id) AS trips
     FROM users u ORDER BY u.created_at_ms`,
  ).all<any>();
  return json({
    users: results.map((u) => ({ id: u.id, name: u.name, picture: u.picture, admin: !!u.is_admin, disabled: u.disabled_at_ms != null, trips: u.trips })),
  });
}

// The body is optional: {"email": "..."} makes the invite work for that Google account without the link.
async function createInvite(req: Request, who: Principal, env: Env): Promise<Response> {
  if (!who.userId) throw new HttpError(409, "sign in with Google first, then invite people");
  const text = new TextDecoder().decode(await readBounded(req, 4096, "invite")).trim();
  let email: string | null = null;
  if (text) {
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invite body is not JSON");
    }
    if (body?.email != null && body.email !== "") {
      if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) || body.email.length > 254) {
        throw new HttpError(400, "that doesn't look like an email address");
      }
      email = body.email.trim().toLowerCase();
      const taken = await env.DB.prepare("SELECT 1 FROM users WHERE lower(email) = ?").bind(email).first();
      if (taken) throw new HttpError(409, `${email} has already joined`);
    }
  }
  const code = randomToken(16);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO invites (code, created_by, created_at_ms, expires_at_ms, email) VALUES (?, ?, ?, ?, ?)")
    .bind(code, who.userId, now, now + INVITE_TTL_MS, email)
    .run();
  return json({ code, email, createdAtMs: now, expiresAtMs: now + INVITE_TTL_MS }, 201);
}

async function listInvites(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT i.code, i.email, i.created_at_ms, i.expires_at_ms, i.used_at_ms, u.name AS used_by_name
     FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.revoked_at_ms IS NULL ORDER BY i.created_at_ms DESC LIMIT 50`,
  ).all<any>();
  return json({
    invites: results.map((i) => ({ code: i.code, email: i.email ?? null, createdAtMs: i.created_at_ms, expiresAtMs: i.expires_at_ms, usedAtMs: i.used_at_ms, usedBy: i.used_by_name })),
  });
}

async function revokeInvite(code: string, env: Env): Promise<Response> {
  await env.DB.prepare("UPDATE invites SET revoked_at_ms = ? WHERE code = ? AND used_by IS NULL").bind(Date.now(), code).run();
  return json({ ok: true });
}

async function usableInvite(code: string, env: Env): Promise<any | null> {
  if (!code) return null;
  const i = await env.DB.prepare(
    "SELECT i.*, u.name AS from_name FROM invites i JOIN users u ON u.id = i.created_by WHERE i.code = ?",
  ).bind(code).first<any>();
  return i && !i.used_by && i.revoked_at_ms == null && i.expires_at_ms > Date.now() ? i : null;
}

// `email` is only there for an invite made for one address: the page tells them which account to use.
async function inviteInfo(code: string, env: Env): Promise<Response> {
  const i = await usableInvite(code, env);
  return json({ usable: !!i, from: i ? i.from_name : null, ...(i?.email ? { email: i.email } : {}) });
}

async function listDevices(who: Principal, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT k.id, k.name, k.created_at_ms, k.last_used_ms, k.user_id, u.name AS user_name
     FROM device_keys k JOIN users u ON u.id = k.user_id
     WHERE k.revoked_at_ms IS NULL AND (?1 = 1 OR k.user_id = ?2) ORDER BY k.created_at_ms`,
  )
    .bind(who.admin ? 1 : 0, who.userId)
    .all<any>();
  return json({
    devices: results.map((d) => ({ id: d.id, name: d.name, createdAtMs: d.created_at_ms, lastUsedMs: d.last_used_ms, userId: d.user_id, userName: d.user_name })),
  });
}

async function revokeDevice(who: Principal, id: string, env: Env): Promise<Response> {
  const r = await env.DB.prepare("UPDATE device_keys SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL AND (?3 = 1 OR user_id = ?4)")
    .bind(Date.now(), id, who.admin ? 1 : 0, who.userId)
    .run();
  if (!r.meta.changes) throw new HttpError(404, "no such phone");
  return json({ ok: true });
}

// Every phone that has uploaded, whose trips they count as, and its latest vehicle label. The owner
// uses this to give trips from a phone that used the original shared token to the right person.
async function listPhones(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT device_id, COUNT(*) AS trips, MAX(started_at_ms) AS last_ms,
            (SELECT json_extract(meta_json, '$.vehicle') FROM recordings r2 WHERE r2.device_id = r.device_id ORDER BY started_at_ms DESC LIMIT 1) AS vehicle,
            (SELECT json_extract(meta_json, '$.device.model') FROM recordings r2 WHERE r2.device_id = r.device_id ORDER BY started_at_ms DESC LIMIT 1) AS model,
            json_group_array(DISTINCT COALESCE(user_id, '')) AS owners
     FROM recordings r GROUP BY device_id ORDER BY last_ms DESC`,
  ).all<any>();
  return json({
    phones: results.map((p) => ({
      deviceId: p.device_id, trips: p.trips, lastMs: p.last_ms, vehicle: p.vehicle ?? null, model: p.model ?? null,
      owners: (JSON.parse(p.owners) as string[]).map((o) => o || null),
    })),
  });
}

async function setPhoneOwner(req: Request, deviceId: string, env: Env): Promise<Response> {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(deviceId)) throw new HttpError(400, "bad device id");
  const body: any = await req.json().catch(() => null);
  const userId = body?.userId;
  if (typeof userId !== "string" || !(await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first())) {
    throw new HttpError(400, "unknown person");
  }
  const r = await env.DB.prepare("UPDATE recordings SET user_id = ? WHERE device_id = ?").bind(userId, deviceId).run();
  return json({ ok: true, trips: r.meta.changes });
}

async function setUserDisabled(req: Request, who: Principal, id: string, env: Env): Promise<Response> {
  const body: any = await req.json().catch(() => null);
  if (typeof body?.disabled !== "boolean") throw new HttpError(400, "send {disabled: true|false}");
  if (id === who.userId) throw new HttpError(400, "you can't turn yourself off");
  const r = await env.DB.prepare("UPDATE users SET disabled_at_ms = ? WHERE id = ? AND is_admin = 0").bind(body.disabled ? Date.now() : null, id).run();
  if (!r.meta.changes) throw new HttpError(404, "no such person");
  if (body.disabled) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- app updates ----------

// The Android app checks /app/latest when it opens and offers to install a newer build. The APK and a
// small JSON describing it live in R2 next to the recordings. Old builds stay, under their version.
const APP_LATEST = "app/latest.json";
const MAX_APK_BYTES = 80 * 1024 * 1024;

async function latestApp(env: Env): Promise<Response> {
  const o = await env.RECORDINGS.get(APP_LATEST);
  return json(o ? await o.json() : { versionCode: 0 });
}

async function publishApp(req: Request, url: URL, env: Env): Promise<Response> {
  const versionCode = Number(url.searchParams.get("versionCode"));
  const versionName = url.searchParams.get("versionName") ?? "";
  if (!Number.isInteger(versionCode) || versionCode < 1) throw new HttpError(400, "versionCode must be a positive integer");
  if (!/^[0-9A-Za-z._-]{1,40}$/.test(versionName)) throw new HttpError(400, "bad versionName");
  const sha = (req.headers.get("X-Fuelish-Sha256") ?? "").toLowerCase();
  if (!SHA_RE.test(sha)) throw new HttpError(400, "missing X-Fuelish-Sha256");
  const current: any = await (await env.RECORDINGS.get(APP_LATEST))?.json();
  if (current && versionCode <= current.versionCode) {
    throw new HttpError(409, `version ${versionCode} isn't newer than the published ${current.versionCode}`);
  }
  const body = await readBounded(req, MAX_APK_BYTES, "apk");
  if (hex(await crypto.subtle.digest("SHA-256", body)) !== sha) throw new HttpError(422, "sha256 mismatch");
  // An APK is a zip: refuse anything else before phones are told to install it.
  if (new Uint8Array(body, 0, 2).join() !== "80,75") throw new HttpError(400, "not an APK");
  await env.RECORDINGS.put(`app/fuelish-${versionCode}.apk`, body, { sha256: sha, httpMetadata: { contentType: "application/vnd.android.package-archive" } });
  const latest = { versionCode, versionName, sha256: sha, bytes: body.byteLength, publishedAtMs: Date.now() };
  await env.RECORDINGS.put(APP_LATEST, JSON.stringify(latest), { httpMetadata: { contentType: "application/json" } });
  return json(latest, 201);
}

// `version` is a number, or "latest" (the website's download button).
async function downloadApp(version: string, env: Env): Promise<Response> {
  if (version === "latest") {
    const latest: any = await (await env.RECORDINGS.get(APP_LATEST))?.json();
    if (!latest) throw new HttpError(404, "no app published yet");
    version = String(latest.versionCode);
  }
  if (!/^\d{1,9}$/.test(version)) throw new HttpError(400, "bad version");
  const o = await env.RECORDINGS.get(`app/fuelish-${version}.apk`);
  if (!o) throw new HttpError(404, "no such version");
  return new Response(o.body, {
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(o.size),
      "Content-Disposition": `attachment; filename="fuelish-${version}.apk"`,
      "Cache-Control": "private, max-age=86400",
    },
  });
}

// ---------- helpers ----------

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ---------- gas prices ----------

// EIA weekly retail prices, regular gasoline (all formulations), dollars per gallon: the U.S. and its
// five PADD regions. EIA's API needs a key; its public history pages don't, so those are parsed.
export const GAS_REGIONS: Record<string, { name: string; series: string }> = {
  us: { name: "U.S.", series: "EMM_EPMR_PTE_NUS_DPG" },
  east: { name: "East Coast", series: "EMM_EPMR_PTE_R10_DPG" },
  midwest: { name: "Midwest", series: "EMM_EPMR_PTE_R20_DPG" },
  gulf: { name: "Gulf Coast", series: "EMM_EPMR_PTE_R30_DPG" },
  rockies: { name: "Rocky Mountain", series: "EMM_EPMR_PTE_R40_DPG" },
  west: { name: "West Coast", series: "EMM_EPMR_PTE_R50_DPG" },
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const GAS_CACHE_S = 12 * 3600;

/** [week start (UTC ms), $/gal] from an EIA weekly history page, oldest first, from sinceMs on. */
export function parseEiaWeekly(html: string, sinceMs = 0): [number, number][] {
  const out: [number, number][] = [];
  const row = /(\d{4})-([A-Z][a-z]{2})<\/td>([\s\S]*?)<\/tr>/g;
  const cell = /class='B5'>(\d{2})\/(\d{2})&nbsp;<\/td>\s*<td class='B3'>\s*([\d.]+)/g;
  for (const r of html.matchAll(row)) {
    const year = +r[1], month = MONTHS.indexOf(r[2]);
    if (month < 0) continue;
    for (const c of r[3].matchAll(cell)) {
      const mm = +c[1] - 1, dd = +c[2];
      const y = month === 0 && mm === 11 ? year - 1 : year; // a late-December week listed under January
      const t = Date.UTC(y, mm, dd);
      if (t >= sinceMs) out.push([t, +c[3]]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

async function gasPrices(ctx: ExecutionContext): Promise<Response> {
  const key = new Request("https://fuelish.internal/gas-prices/v1");
  const cache = (caches as unknown as { default: Cache }).default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const since = Date.now() - 3 * 365 * 86400_000;
  const regions: Record<string, { name: string; weeks: [number, number][] }> = {};
  const failures: string[] = [];
  await Promise.all(
    Object.entries(GAS_REGIONS).map(async ([k, { name, series }]) => {
      try {
        const res = await fetch(`https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=${series}&f=W`, {
          headers: { "User-Agent": "fuelish (personal driving log)" },
        });
        if (!res.ok) return void failures.push(`${k}: HTTP ${res.status}`);
        const weeks = parseEiaWeekly(await res.text(), since);
        if (weeks.length) regions[k] = { name, weeks };
        else failures.push(`${k}: no prices on the page`);
      } catch (e) {
        failures.push(`${k}: ${e}`);
      }
    }),
  );
  if (failures.length) console.error("gas prices:", failures.join("; "));
  if (!Object.keys(regions).length) throw new HttpError(502, `couldn't fetch gas prices (${failures[0]})`);
  const res = new Response(
    JSON.stringify({ source: "U.S. EIA weekly retail price, regular gasoline", regions }),
    // A partial result (some regions failed) is kept only an hour, so they're retried soon.
    { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${failures.length ? 3600 : GAS_CACHE_S}` } },
  );
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
