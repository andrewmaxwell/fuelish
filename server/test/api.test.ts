import { exports } from "cloudflare:workers";
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
    expect(await (await call("/me", { headers: WEB })).json()).toEqual({ scopes: ["read"] });
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

    const tampered = links.all.replace(/sig=./, "sig=0");
    expect((await exports.default.fetch(new Request(tampered))).status).toBe(403);
  });

  it("refuses to let another device overwrite a recording", async () => {
    await call("/recordings/rec1", { method: "PUT", headers: DEVICE, body: meta() });
    const res = await call("/recordings/rec1", { method: "PUT", headers: DEVICE, body: meta({ deviceId: "other" }) });
    expect(res.status).toBe(409);
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
  });
});
