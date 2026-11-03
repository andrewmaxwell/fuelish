#!/usr/bin/env python3
"""Inspect and export Fuelish recordings (stdlib only).

  python3 tools/fuelish.py summary RECORDING.ndjson.gz
  python3 tools/fuelish.py export  RECORDING.ndjson.gz OUT_DIR

Input is the whole-recording download from the web app (concatenated gzip members),
a single chunk, or an uncompressed .ndjson file. Export writes one CSV per stream;
original records are never modified, so re-exporting with new logic is always possible.
"""
import csv
import gzip
import json
import os
import sys
from collections import defaultdict


def records(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                print(f"line {n}: unparseable (truncated by a crash?)", file=sys.stderr)


def stream_of(r):
    k = r["k"]
    if k == "s":
        return "s:" + r["s"], r["ts"]
    if k == "loc":
        return "loc:" + r["p"], r["et"]
    if k == "obd":
        return "obd:" + r.get("f", "pid" + r["pid"]), r["rx"]
    return k, r.get("rx", 0)


def summary(path):
    st = defaultdict(lambda: {"n": 0, "first": None, "last": None, "maxdt": 0})
    chunks = set()
    meta = None
    for r in records(path):
        if r["k"] == "chunk":
            chunks.add(r["seq"])
        if r["k"] == "session" and meta is None:
            meta = r["meta"]
        key, t = stream_of(r)
        s = st[key]
        if s["last"] is not None:
            s["maxdt"] = max(s["maxdt"], t - s["last"])
        s["first"] = t if s["first"] is None else s["first"]
        s["last"] = t
        s["n"] += 1
    if meta:
        print(f"recording {meta['id']}  vehicle={meta.get('vehicle')}  note={meta.get('note')!r}")
    missing = sorted(set(range(max(chunks) + 1)) - chunks) if chunks else []
    print(f"chunks present: {len(chunks)}  missing: {missing or 'none'}")
    print(f"{'stream':32} {'n':>9} {'rate Hz':>9} {'max gap ms':>11}")
    for k in sorted(st):
        s = st[k]
        span = (s["last"] - s["first"]) / 1e9 if s["n"] > 1 else 0
        rate = (s["n"] - 1) / span if span > 0 else 0
        print(f"{k:32} {s['n']:9d} {rate:9.2f} {s['maxdt'] / 1e6:11.1f}")


def export(path, out):
    os.makedirs(out, exist_ok=True)
    writers, files = {}, {}

    def row(name, header, values):
        if name not in writers:
            f = open(os.path.join(out, name.replace(":", "_") + ".csv"), "w", newline="")
            files[name] = f
            writers[name] = csv.writer(f)
            writers[name].writerow(header)
        writers[name].writerow(values)

    other = open(os.path.join(out, "other.ndjson"), "w")
    for r in records(path):
        k = r["k"]
        if k == "s":
            v = r["v"]
            row("s:" + r["s"], ["ts_ns", "rx_ns", "accuracy"] + [f"v{i}" for i in range(len(v))], [r["ts"], r["rx"], r.get("a")] + v)
        elif k == "loc":
            cols = ["p", "et", "rx", "time", "lat", "lon", "alt", "msl", "hAcc", "vAcc", "speed", "speedAcc", "bearing", "bearingAcc", "sats", "mock"]
            row("loc", cols, [r.get(c) for c in cols])
        elif k == "obd":
            cols = ["tx", "rx", "ecu", "pid", "data", "f", "val", "u"]
            row("obd", cols, [r.get(c) for c in cols])
        elif k == "obd_raw":
            cols = ["tx", "rx", "cmd", "st", "resp"]
            row("obd_raw", cols, [r.get(c) for c in cols])
        elif k == "batt":
            cols = ["rx", "pct", "chargeUah", "currentUa", "currentAvgUa", "mv", "tempC", "status", "plugged", "thermal", "powerSave", "cpuMs"]
            row("batt", cols, [r.get(c) for c in cols])
        else:
            other.write(json.dumps(r) + "\n")
    other.close()
    for f in files.values():
        f.close()
    print(f"wrote {len(files)} CSV files + other.ndjson to {out}")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "summary":
        summary(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "export":
        export(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
        sys.exit(2)
