import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const BASE = "https://fuelish.test/api/v1";
const DEVICE = { Authorization: "Bearer test-device-token" };
const WEB = { Authorization: "Bearer test-web-token" };

function call(path: string, init: RequestInit = {}) {
  return exports.default.fetch(new Request(BASE + path, init));
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(s: string) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const meta = (over: object = {}) =>
  JSON.stringify({ id: "rec1", deviceId: "dev1", status: "recording", startedWallMs: 1000, ...over });

const sent = new Map<number, Uint8Array>();

async function putChunk(seq: number, text: string, shaOverride?: string) {
  const body = await gzip(text);
  const res = await call(`/recordings/rec1/chunks/${seq}`, {
    method: "PUT",
    headers: {
      ...DEVICE,
      "X-Fuelish-Sha256": shaOverride ?? (await sha(body)),
      "X-Fuelish-Meta": b64url(JSON.stringify({ records: 1 })),
    },
    body,
  });
  if (res.status === 201) sent.set(seq, body);
  return res;
}

describe("auth", () => {
  it("rejects missing and wrong tokens", async () => {
    expect((await call("/recordings")).status).toBe(401);
    expect((await call("/recordings", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("separates upload and read scopes", async () => {
    expect((await call("/recordings", { headers: DEVICE })).status).toBe(403);
    expect((await call("/recordings/rec1", { method: "PUT", headers: WEB, body: meta() })).status).toBe(403);
    expect(await (await call("/me", { headers: WEB })).json()).toMatchObject({ scopes: ["read"], via: "legacy" });
  });
});

describe("upload pipeline", () => {
  it("requires metadata before chunks", async () => {
    expect((await putChunk(0, "x\n")).status).toBe(404);
  });

  it("stores chunks idempotently and downloads them concatenated", async () => {
    expect((await call("/recordings/rec1", { method: "PUT", headers: DEVICE, body: meta() })).status).toBe(200);
    expect((await putChunk(0, '{"k":"a"}\n')).status).toBe(201);
    // Retry of the same chunk: acknowledged, not duplicated.
    const dup = await putChunk(0, '{"k":"a"}\n');
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ duplicate: true });
    // Same seq, different content: conflict.
    expect((await putChunk(0, '{"k":"different"}\n')).status).toBe(409);
    // Corrupted body: rejected.
    expect((await putChunk(1, '{"k":"b"}\n', "0".repeat(64))).status).toBe(422);
    expect((await putChunk(2, '{"k":"c"}\n')).status).toBe(201);

    let detail: any = await (await call("/recordings/rec1", { headers: WEB })).json();
    expect(detail.chunks.map((c: any) => c.seq)).toEqual([0, 2]);
    expect(detail.missing).toEqual([1]);
    expect(detail.recording.complete).toBe(false);

    expect((await putChunk(1, '{"k":"b"}\n')).status).toBe(201);
    await call("/recordings/rec1", {
      method: "PUT",
      headers: DEVICE,
      body: meta({ status: "stopped", endedWallMs: 2000, chunkCount: 3 }),
    });
    detail = await (await call("/recordings/rec1", { headers: WEB })).json();
    expect(detail.missing).toEqual([]);
    expect(detail.recording.complete).toBe(true);

    const list: any = await (await call("/recordings", { headers: WEB })).json();
    expect(list.recordings[0]).toMatchObject({ id: "rec1", chunksReceived: 3, chunkCount: 3, complete: true });

    // Signed link download, no bearer header.
    const links: any = await (await call("/recordings/rec1/links", { method: "POST", headers: WEB })).json();
    const res = await exports.default.fetch(new Request(links.all));
    expect(res.status).toBe(200);
    // workerd's DecompressionStream stops after one gzip member, so compare bytes:
    // the download must be exactly the stored members in seq order.
    const got = new Uint8Array(await res.arrayBuffer());
    const want = new Uint8Array(await new Blob([sent.get(0)!, sent.get(1)!, sent.get(2)!]).arrayBuffer());
    expect(got).toEqual(want);

    // Flip the signature's first hex digit to a value guaranteed to differ.
    const tampered = links.all.replace(/sig=(.)/, (_: string, c: string) => `sig=${c === "0" ? "1" : "0"}`);
    expect((await exports.default.fetch(new Request(tampered))).status).toBe(403);
  });

  it("refuses to let another device overwrite a recording", async () => {
    await call("/recordings/rec1", { method: "PUT", headers: DEVICE, body: meta() });
    const res = await call("/recordings/rec1", { method: "PUT", headers: DEVICE, body: meta({ deviceId: "other" }) });
    expect(res.status).toBe(409);
  });
});

describe("integrity", () => {
  const put = (id: string, over: object) =>
    call(`/recordings/${id}`, { method: "PUT", headers: DEVICE, body: JSON.stringify({ id, deviceId: "dev1", status: "recording", startedWallMs: 1000, ...over }) });

  it("ignores stale metadata that arrives after newer metadata", async () => {
    await put("r2", { rev: 5, status: "stopped", endedWallMs: 2000, chunkCount: 2 });
    const late = await put("r2", { rev: 3 }); // an older 'recording' snapshot finishing last
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ stale: true });
    // Even with a higher revision, a finished recording isn't reopened.
    await put("r2", { rev: 9 });
    const d: any = await (await call("/recordings/r2", { headers: WEB })).json();
    expect(d.recording).toMatchObject({ status: "stopped", chunkCount: 2 });
  });

  it("calls a recording complete only with every expected seq, and refuses seqs past the end", async () => {
    await put("r3", {});
    for (const seq of [0, 2]) {
      const body = await gzip(`{"k":"${seq}"}\n`);
      await call(`/recordings/r3/chunks/${seq}`, { method: "PUT", headers: { ...DEVICE, "X-Fuelish-Sha256": await sha(body) }, body });
    }
    await put("r3", { rev: 2, status: "stopped", endedWallMs: 2000, chunkCount: 2 });
    const d: any = await (await call("/recordings/r3", { headers: WEB })).json();
    expect(d.missing).toEqual([1]);
    expect(d.recording.complete).toBe(false);
    const v: any = await (await call("/recordings/r3/verify", { method: "POST", headers: DEVICE })).json();
    expect(v).toMatchObject({ complete: false, missing: [1] });
    const body = await gzip("late\n");
    const past = await call("/recordings/r3/chunks/5", { method: "PUT", headers: { ...DEVICE, "X-Fuelish-Sha256": await sha(body) }, body });
    expect(past.status).toBe(400);
  });

  it("keeps the stored bytes matching the database when a conflicting chunk loses", async () => {
    await put("r4", {});
    const a = await gzip("first\n"), b = await gzip("second\n");
    const up = async (body: Uint8Array) =>
      call("/recordings/r4/chunks/0", { method: "PUT", headers: { ...DEVICE, "X-Fuelish-Sha256": await sha(body) }, body });
    expect((await up(a)).status).toBe(201);
    expect((await up(b)).status).toBe(409);
    const res = await call("/recordings/r4/chunks/0", { headers: WEB });
    expect(await sha(new Uint8Array(await res.arrayBuffer()))).toBe(await sha(a));
  });

  it("rejects oversized bodies from their declared length", async () => {
    const res = await call("/recordings/r5", { method: "PUT", headers: { ...DEVICE, "Content-Length": String(10 * 1024 * 1024) }, body: "{}" });
    expect(res.status).toBe(413);
  });
});

describe("input checks", () => {
  it("reads a streamed body that has no Content-Length", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ id: "r6", deviceId: "dev6", status: "recording", startedWallMs: 1 }));
    const stream = new ReadableStream({ start(c) { c.enqueue(body); c.close(); } });
    const req = new Request(BASE + "/recordings/r6", { method: "PUT", headers: DEVICE, body: stream, duplex: "half" } as RequestInit);
    expect(req.headers.get("Content-Length")).toBeNull();
    expect((await exports.default.fetch(req)).status).toBe(200);
  });

  it("refuses unknown statuses and impossible chunk counts", async () => {
    const put = (o: object) => call("/recordings/r7", { method: "PUT", headers: DEVICE, body: JSON.stringify({ id: "r7", deviceId: "dev7", startedWallMs: 1, ...o }) });
    expect((await put({ status: "done" })).status).toBe(400);
    expect((await put({ status: "stopped", chunkCount: -1 })).status).toBe(400);
    expect((await put({ status: "stopped", chunkCount: 5_000_000 })).status).toBe(400);
    expect((await put({ status: "stopped", chunkCount: 1 })).status).toBe(200);
  });

  it("refuses a chunk whose track isn't a list of GPS points", async () => {
    await call("/recordings/r8", { method: "PUT", headers: DEVICE, body: JSON.stringify({ id: "r8", deviceId: "dev8", status: "recording", startedWallMs: 1 }) });
    const send = async (m: object) => {
      const body = await gzip("{}\n");
      return call("/recordings/r8/chunks/0", { method: "PUT", headers: { ...DEVICE, "X-Fuelish-Sha256": await sha(body), "X-Fuelish-Meta": b64url(JSON.stringify(m)) }, body });
    };
    expect((await send({ track: "not JSON" })).status).toBe(400);
    expect((await send({ track: [[0, 91, 0]] })).status).toBe(400);
    expect((await send({ track: [[0, 38, "x"]] })).status).toBe(400);
    expect((await send([1])).status).toBe(400);
    expect((await send({ track: [[0, 38, -90, null, 3]] })).status).toBe(201);
  });

  it("lists a trip's route from the outline the phone sends when the full track was left out", async () => {
    await call("/recordings/r10", { method: "PUT", headers: DEVICE, body: JSON.stringify({ id: "r10", deviceId: "dev10", status: "recording", startedWallMs: 3 }) });
    const send = async (seq: number, m: object) => {
      const body = await gzip(`{"seq":${seq}}\n`);
      return call(`/recordings/r10/chunks/${seq}`, { method: "PUT", headers: { ...DEVICE, "X-Fuelish-Sha256": await sha(body), "X-Fuelish-Meta": b64url(JSON.stringify(m)) }, body });
    };
    const outline = [[0, 38.0, -90.0, 20, 3], [5000, 38.001, -90.0, 20, 3]];
    expect((await send(0, { summaryOmitted: ["track"], routeOutline: outline, streams: { "loc:gps": { n: 50 } } })).status).toBe(201);
    expect((await send(1, { routeOutline: [[0, 100, 0]] })).status).toBe(400);
    // An older upload: GPS in the raw chunk, no route the list can see.
    expect((await send(1, { summaryOmitted: ["track"], streams: { "loc:gps": { n: 50 } } })).status).toBe(201);
    const r: any = await (await call("/recordings", { headers: WEB })).json();
    const t = r.recordings.find((x: any) => x.id === "r10");
    expect(t.trip.meters).toBeGreaterThan(100);
    expect(t.routeGaps).toBe(1);
  });

  it("keeps listing trips when one stored track is damaged", async () => {
    await call("/recordings/r9", { method: "PUT", headers: DEVICE, body: JSON.stringify({ id: "r9", deviceId: "dev9", status: "recording", startedWallMs: 2 }) });
    // As if stored before tracks were checked.
    await env.DB.prepare("INSERT INTO chunks (recording_id, seq, sha256, bytes, r2_key, meta_json, uploaded_at_ms) VALUES ('r9', 0, ?, 1, 'x', ?, 0)")
      .bind("0".repeat(64), JSON.stringify({ track: "not JSON" })).run();
    const res = await call("/recordings", { headers: WEB });
    expect(res.status).toBe(200);
    const r: any = await res.json();
    expect(r.recordings.find((x: any) => x.id === "r9").trip).toBeNull();
  });
});

describe("paging", () => {
  it("doesn't skip recordings that share a start time at a page boundary", async () => {
    // 501 recordings started at the same moment: the second page must hold the last one.
    const stmts = Array.from({ length: 501 }, (_, i) =>
      env.DB.prepare("INSERT INTO recordings (id, device_id, status, started_at_ms, meta_json, created_at_ms, updated_at_ms) VALUES (?, 'd', 'stopped', 5, '{}', 0, 0)").bind(`same-${String(i).padStart(3, "0")}`));
    await env.DB.batch(stmts);
    const seen = new Set<string>();
    let before: string | null = null;
    for (let k = 0; k < 5; k++) {
      const page: any = await (await call(`/recordings${before ? `?before=${before}` : ""}`, { headers: WEB })).json();
      for (const r of page.recordings) if (r.id.startsWith("same-")) seen.add(r.id);
      if (!page.next) break;
      before = page.next;
    }
    expect(seen.size).toBe(501);
  });
});

describe("prefs", () => {
  it("stores small JSON settings for the web page", async () => {
    expect((await call("/prefs/places", { method: "PUT", headers: DEVICE, body: "{}" })).status).toBe(403);
    const places = [{ lat: 38.6, lon: -90.3, name: "Home" }];
    expect((await call("/prefs/places", { method: "PUT", headers: WEB, body: JSON.stringify(places) })).status).toBe(200);
    expect((await call("/prefs/places", { method: "PUT", headers: WEB, body: "not json" })).status).toBe(400);
    // Shapes are checked: the pages rely on them.
    expect((await call("/prefs/places", { method: "PUT", headers: WEB, body: JSON.stringify({ a: "Home" }) })).status).toBe(400);
    expect((await call("/prefs/costs", { method: "PUT", headers: WEB, body: JSON.stringify({ timePerHour: -1 }) })).status).toBe(400);
    expect((await call("/prefs/costs", { method: "PUT", headers: WEB, body: JSON.stringify({ timePerHour: 25 }) })).status).toBe(200);
    expect((await call("/prefs/whatever", { method: "PUT", headers: WEB, body: "{}" })).status).toBe(400);
    const got: any = await (await call("/prefs", { headers: WEB })).json();
    expect(got.prefs.places).toEqual(places);
    expect(got.prefs.costs).toEqual({ timePerHour: 25 });
  });
});

describe("share links", () => {
  it("shows one trip without a token, trimmed, until revoked", async () => {
    await call("/recordings/rec1", { method: "PUT", headers: DEVICE, body: meta({ rev: 10, status: "stopped", endedWallMs: 2000, chunkCount: 3, vehicle: "Civic", note: "private", config: { obd: { deviceAddress: "00:04" } } }) });
    expect((await call("/recordings/rec1/shares", { method: "POST", headers: DEVICE })).status).toBe(403);
    const created = await call("/recordings/rec1/shares", { method: "POST", headers: WEB });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as any;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const shared = await call(`/shared/${token}`);
    expect(shared.status).toBe(200);
    const body = (await shared.json()) as any;
    expect(body.recording.id).toBe("rec1");
    expect(body.recording.meta).toEqual({ vehicle: "Civic", startedWallMs: 1000 });
    expect(JSON.stringify(body)).not.toContain("00:04");
    expect(body.recording.deviceId).toBeUndefined();

    const list = (await (await call("/recordings/rec1/shares", { headers: WEB })).json()) as any;
    expect(list.shares.map((s: any) => s.token)).toEqual([token]);
    await call(`/recordings/rec1/shares/${token}`, { method: "DELETE", headers: WEB });
    expect((await call(`/shared/${token}`)).status).toBe(404);
    expect((await call("/shared/not-a-real-token-at-all")).status).toBe(404);
  });
});

describe("trip summary", () => {
  it("measures distance, top speed and moving time from chunk tracks, skipping gaps", async () => {
    const { tripSummary } = await import("../src/index");
    // ~111 m per 0.001° of latitude; the 60 s gap before the last fix isn't bridged.
    const tracks = JSON.stringify([
      [[0, 38.0, -90.0, 0, 3], [5000, 38.001, -90.0, 20, 3]],
      [[10000, 38.002, -90.0, 25, 3], [70000, 38.5, -90.0, 10, 3]],
      null,
    ]);
    const t = tripSummary(tracks)!;
    expect(t.meters).toBeGreaterThan(215);
    expect(t.meters).toBeLessThan(230);
    expect(t.maxMps).toBe(25);
    expect(t.movingMs).toBe(10000);
    expect(t.path.length).toBe(4);
    expect(tripSummary("[null]")).toBeNull();
  });

  it("doesn't count parked GPS wander as distance", async () => {
    const { tripSummary } = await import("../src/index");
    // 61 fixes alternating ~11 m apart, speed 0, 100 m accuracy: the review's reproduction.
    const fixes = Array.from({ length: 61 }, (_, i) => [i * 1000, 38 + (i % 2) * 0.0001, -90, 0, 100]);
    expect(tripSummary(JSON.stringify([fixes]))!.meters).toBe(0);
  });

  it("leaves out fixes after the drive ended", async () => {
    const { tripSummary } = await import("../src/index");
    const tracks = JSON.stringify([[[0, 38.0, -90.0, 5, 3], [5000, 38.001, -90.0, 5, 3], [9000, 38.002, -90.0, 1, 3]]]);
    expect(tripSummary(tracks, 5000)!.path.length).toBe(2);
  });
});

describe("drive end", () => {
  it("takes the stop wait off automatic stops only", async () => {
    const { driveEndMs } = await import("../src/index");
    const config = { auto: { stopAfterCarDisconnectS: 120, stopAfterEngineOffS: 300 } };
    expect(driveEndMs({ stopReason: "car_disconnected", config }, 1_000_000)).toBe(880_000);
    expect(driveEndMs({ stopReason: "engine_off", config }, 1_000_000)).toBe(700_000);
    expect(driveEndMs({ stopReason: "manual", config }, 1_000_000)).toBe(1_000_000);
    expect(driveEndMs({ stopReason: "car_disconnected" }, 1_000_000)).toBe(1_000_000);
    expect(driveEndMs({ stopReason: "car_disconnected", config, startedWallMs: 950_000 }, 1_000_000)).toBe(950_000);
    expect(driveEndMs({ stopReason: "car_disconnected", config }, null)).toBeNull();
    // A phone that stamped the disconnect itself is believed over the estimate.
    expect(driveEndMs({ stopReason: "car_disconnected", config, driveEndWallMs: 810_000 }, 1_000_000)).toBe(810_000);
  });
});

describe("gas prices", () => {
  it("parses EIA weekly history rows, including a December week listed under January", async () => {
    const { parseEiaWeekly } = await import("../src/index");
    const html = `<tr> <td class='B6'>&nbsp;&nbsp;2026-Oct</td>
      <td class='B5'>10/26&nbsp;</td> <td class='B3'>4.269&nbsp;&nbsp;&nbsp;</td>
      <td class='B5'>&nbsp;</td> <td class='B3'>&nbsp;&nbsp;&nbsp;</td> </tr>
      <tr> <td class='B6'>&nbsp;&nbsp;2026-Jan</td>
      <td class='B5'>12/29&nbsp;</td> <td class='B3'>3.901&nbsp;</td>
      <td class='B5'>01/05&nbsp;</td> <td class='B3'>3.950&nbsp;</td> </tr>`;
    expect(parseEiaWeekly(html)).toEqual([
      [Date.UTC(2025, 11, 29), 3.901],
      [Date.UTC(2026, 0, 5), 3.95],
      [Date.UTC(2026, 9, 26), 4.269],
    ]);
    expect(parseEiaWeekly(html, Date.UTC(2026, 0, 1)).length).toBe(2);
  });
});
