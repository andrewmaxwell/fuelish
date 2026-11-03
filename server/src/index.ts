// Fuelish API: receives recording metadata and gzip chunks from the phone,
// stores chunks in R2 and metadata in D1, and serves them back to the web app.

export interface Env {
  DB: D1Database;
  RECORDINGS: R2Bucket;
  ASSETS: Fetcher;
  DEVICE_TOKEN: string; // scope: upload
  WEB_TOKEN: string; // scope: read
}

type Scope = "upload" | "read";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_META_BYTES = 512 * 1024;
const MAX_CHUNK_BYTES = 90 * 1024 * 1024; // Workers request bodies are capped at 100 MB
const LINK_TTL_S = 15 * 60;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await route(req, url, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
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

  const scopes = await authenticate(req, env);
  const need = (s: Scope) => {
    if (!scopes.includes(s)) throw new HttpError(403, `requires ${s} scope`);
  };

  if (m === "GET" && p[0] === "me" && p.length === 1) return json({ scopes });

  if (p[0] !== "recordings") throw new HttpError(404, "not found");
  if (p.length === 1 && m === "GET") {
    need("read");
    return listRecordings(env);
  }
  const id = p[1];
  if (!id || !ID_RE.test(id)) throw new HttpError(400, "bad recording id");

  if (p.length === 2 && m === "PUT") {
    need("upload");
    return putRecording(req, id, env);
  }
  if (p.length === 2 && m === "GET") {
    need("read");
    return getRecording(id, env);
  }
  if (p.length === 4 && p[2] === "chunks" && m === "PUT") {
    need("upload");
    return putChunk(req, id, parseSeq(p[3]), env);
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

async function authenticate(req: Request, env: Env): Promise<Scope[]> {
  const h = req.headers.get("Authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "missing bearer token");
  const scopes: Scope[] = [];
  if (env.DEVICE_TOKEN && (await safeEqual(token, env.DEVICE_TOKEN))) scopes.push("upload");
  if (env.WEB_TOKEN && (await safeEqual(token, env.WEB_TOKEN))) scopes.push("read");
  if (!scopes.length) throw new HttpError(401, "invalid token");
  return scopes;
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

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

async function putRecording(req: Request, id: string, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_META_BYTES) throw new HttpError(413, "metadata too large");
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
  const endedAt = Number.isFinite(Number(meta.endedWallMs)) && meta.endedWallMs != null ? Number(meta.endedWallMs) : null;
  const chunkCount = Number.isInteger(meta.chunkCount) && status !== "recording" ? meta.chunkCount : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO recordings (id, device_id, status, started_at_ms, ended_at_ms, chunk_count, meta_json, created_at_ms, updated_at_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, ended_at_ms = excluded.ended_at_ms, chunk_count = excluded.chunk_count,
       meta_json = excluded.meta_json, updated_at_ms = excluded.updated_at_ms
     WHERE recordings.device_id = excluded.device_id`,
  )
    .bind(id, deviceId, status, startedAt, endedAt, chunkCount, text, now)
    .run();
  const row = await env.DB.prepare("SELECT device_id FROM recordings WHERE id = ?").bind(id).first<{ device_id: string }>();
  if (row?.device_id !== deviceId) throw new HttpError(409, "recording id belongs to another device");
  return json({ ok: true });
}

function parseSeq(s: string | undefined): number {
  if (!s || !/^\d{1,6}$/.test(s)) throw new HttpError(400, "bad chunk seq");
  return Number(s);
}

function chunkKey(id: string, seq: number): string {
  return `recordings/${id}/chunk-${String(seq).padStart(6, "0")}.ndjson.gz`;
}

async function putChunk(req: Request, id: string, seq: number, env: Env): Promise<Response> {
  const sha = (req.headers.get("X-Fuelish-Sha256") ?? "").toLowerCase();
  if (!SHA_RE.test(sha)) throw new HttpError(400, "missing X-Fuelish-Sha256");
  const metaHeader = req.headers.get("X-Fuelish-Meta") ?? "{}";
  let chunkMeta: string;
  try {
    chunkMeta = JSON.stringify(JSON.parse(b64urlDecode(metaHeader)));
  } catch {
    throw new HttpError(400, "X-Fuelish-Meta must be base64url JSON");
  }

  const rec = await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(id).first();
  if (!rec) throw new HttpError(404, "upload recording metadata first");

  const existing = await env.DB.prepare("SELECT sha256 FROM chunks WHERE recording_id = ? AND seq = ?")
    .bind(id, seq)
    .first<{ sha256: string }>();
  if (existing) {
    // Retries of an already-stored chunk are acknowledged without rewriting anything.
    if (existing.sha256 === sha) return json({ ok: true, duplicate: true });
    throw new HttpError(409, "chunk already stored with different content");
  }

  const body = await req.arrayBuffer();
  if (body.byteLength === 0) throw new HttpError(400, "empty chunk");
  if (body.byteLength > MAX_CHUNK_BYTES) throw new HttpError(413, "chunk too large");
  const actual = hex(await crypto.subtle.digest("SHA-256", body));
  if (actual !== sha) throw new HttpError(422, "sha256 mismatch");

  const key = chunkKey(id, seq);
  await env.RECORDINGS.put(key, body, {
    sha256: sha,
    httpMetadata: { contentType: "application/gzip" },
  });
  await env.DB.prepare(
    `INSERT INTO chunks (recording_id, seq, r2_key, bytes, sha256, meta_json, uploaded_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(id, seq, key, body.byteLength, sha, chunkMeta, Date.now())
    .run();
  return json({ ok: true, duplicate: false }, 201);
}

// ---------- read ----------

async function listRecordings(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.device_id, r.status, r.started_at_ms, r.ended_at_ms, r.chunk_count, r.meta_json, r.updated_at_ms,
            COUNT(c.seq) AS chunks_received, COALESCE(SUM(c.bytes), 0) AS bytes,
            json_group_array(json_extract(c.meta_json, '$.track')) AS tracks
     FROM recordings r LEFT JOIN (SELECT * FROM chunks ORDER BY seq) c ON c.recording_id = r.id
     GROUP BY r.id ORDER BY r.started_at_ms DESC LIMIT 500`,
  ).all<any>();
  return json({ recordings: results.map((r) => ({ ...recordingRow(r), trip: tripSummary(r.tracks) })) });
}

// Distance, speeds and a small route outline for the list, from the GPS track every chunk's
// stats carry ([wallMs, lat, lon, speedMps, hAccM, ...]; older chunks have a fix every 5 s).
export function tripSummary(tracksJson: string) {
  const fixes: number[][] = [];
  for (const t of JSON.parse(tracksJson || "[]")) {
    const arr = typeof t === "string" ? JSON.parse(t) : t;
    if (Array.isArray(arr)) for (const p of arr) if (p?.[1] != null && p?.[2] != null) fixes.push(p);
  }
  if (fixes.length < 2) return null;
  fixes.sort((a, b) => a[0] - b[0]);
  let meters = 0, maxMps = 0, movingMs = 0;
  for (let i = 1; i < fixes.length; i++) {
    const [t0, la0, lo0, v0] = fixes[i - 1], [t1, la1, lo1, v1] = fixes[i];
    if (t1 - t0 > 30_000) continue; // a gap in the track (tunnel, lost fix): don't bridge it
    meters += haversine(la0, lo0, la1, lo1);
    if ((v0 ?? 0) > 1 || (v1 ?? 0) > 1) movingMs += t1 - t0;
  }
  for (const p of fixes) if (p[3] != null) maxMps = Math.max(maxMps, p[3]);
  const step = Math.max(1, Math.ceil(fixes.length / 80));
  const path = fixes.filter((_, i) => i % step === 0 || i === fixes.length - 1).map((p) => [round5(p[1]), round5(p[2])]);
  return { meters: Math.round(meters), maxMps, movingMs, path };
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

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
    status: r.status,
    startedWallMs: r.started_at_ms,
    endedWallMs: r.ended_at_ms,
    chunkCount: r.chunk_count,
    chunksReceived: r.chunks_received,
    bytes: r.bytes,
    complete: r.chunk_count != null && r.chunks_received === r.chunk_count,
    updatedAtMs: r.updated_at_ms,
    meta,
  };
}

async function getRecording(id: string, env: Env): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM chunks WHERE recording_id = r.id) AS chunks_received,
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
  return json({ recording: recordingRow(r), chunks, missing });
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
    const obj = await env.RECORDINGS.get(chunkKey(id, seq));
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

// ---------- helpers ----------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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
