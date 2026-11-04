# Fuelish recording format (v1)

A recording is a sequence of **chunks**. Each chunk is gzip-compressed NDJSON:
one JSON object per line, with every object carrying `"k"` (its kind). Chunks are
numbered from 0 with no gaps. The web app's "Download whole recording" gives you
all chunks concatenated, which is still a valid gzip file (`zcat`, `gunzip` and
Python's `gzip` read multi-member files; browser `DecompressionStream` and workerd
stop after the first member).

Nothing is resampled, filtered or merged on the phone. Values are written as the
platform delivered them, with their own timestamps, so the data can be reinterpreted
later.

## Clocks

| Field  | Clock | Meaning |
|--------|-------|---------|
| `rx`   | `SystemClock.elapsedRealtimeNanos()` | when the app received / logged the record |
| `ts`   | same clock | `SensorEvent.timestamp`: when the sensor sampled (use this for intervals) |
| `et`   | same clock | `Location.getElapsedRealtimeNanos()`: when the fix was computed |
| `tx`   | same clock | when an OBD request was written to the adapter |
| `wall` | Unix ms | phone wall clock |
| `time` | Unix ms | GNSS-derived UTC time of a location fix |

All nanosecond fields share one monotonic clock, so streams align directly. Map to
wall time using `clock` records (every 10 s) or GPS `time`. `rx - ts` shows sensor
batching latency.

## Record kinds

| `k` | When | Key fields |
|-----|------|------------|
| `chunk` | first line of every chunk | `v` (format version), `rec`, `seq`, `rx`, `wall` |
| `session` | start of chunk 0 | `meta`: the full recording metadata (device, app, config, note) |
| `clock` | every 10 s | `rx`, `wall`, `uptimeMs`, `utcOffsetMin` |
| `sensor_list` | start | every sensor on the phone with vendor, resolution, range, power, delays, FIFO sizes |
| `sensor_info` | start, per enabled sensor | requested Hz, period, max report latency, registration result, sensor metadata |
| `s` | each sensor sample | `s` (key, e.g. `acc`), `ts`, `rx`, `v` (values array as delivered by Android, SI units), `a` (accuracy) |
| `accuracy` | sensor accuracy change | `s`, `rx`, `a` |
| `loc` | each location fix | `p` (provider: `gps` / `fused`), `et`, `rx`, `time`, `lat`, `lon`, `alt`, `msl`, `hAcc`, `vAcc`, `speed` (m/s), `speedAcc`, `bearing`, `bearingAcc`, `sats`, `mock`. Missing fields were not provided. |
| `gnss_info` | start | GNSS chipset model/year and capabilities |
| `gnss_status` | ~1 Hz | per-satellite constellation, svid, C/N0, elevation, azimuth, used-in-fix |
| `gnss_meas` | ~1 Hz | raw GNSS clock + measurements (pseudorange rate, ADR, received SV time, ...) for post-processing |
| `gnss_nav`, `nmea` | if enabled | navigation messages / NMEA sentences |
| `batt` | every `batteryIntervalS` | percent, charge counter (µAh), current (µA), voltage, temperature, plugged, thermal status, process CPU ms |
| `stats` | every 10 s | writer totals: records written, dropped, queue depth |
| `drop` | when the write queue overflowed | `total` drops so far (should never appear) |
| `event` | app events | `ev`: `start` (detail = trigger), `stop` (detail = stop reason), `car_bt_connected`/`car_bt_disconnected`, `provider_enabled`/`disabled`, `obd_not_started` |
| `obd_event` | adapter link changes | `ev`: `connected`, `adapter_ready`, `disconnected`, `vehicle_lost` (the car stopped answering: 5 errors, or 5 requests in a row with nothing answered, which is how ignition off shows up on the Civic), `pid_demoted`, `pid_restored` (a demoted PID answered again and is back on its tier's interval) |
| `obd_raw` | every adapter exchange | `tx`, `rx`, `cmd`, `st` (OK/NO_DATA/ERROR/TIMEOUT), `resp` (exact text before the `>` prompt) |
| `obd_discovery` | after the car answers | protocol, `mainEcu` (the engine ECU: 7E8/18DAF110, else the one supporting the most PIDs), supported PIDs per ECU, PIDs the decoder doesn't know, decoder formulas for every supported PID, VIN/calibration info, raw DTC responses |
| `obd_bench` | after discovery | single-PID latency, multi-PID completeness and throughput per batch size, chosen batch size; the same measured with requests addressed to the engine ECU alone (`engineOnly`), and `addressing`: `engine_only` when that answered completely and was at least 5% faster (config `obd.engineOnly`: auto / on / off), else `all_ecus` |
| `obd` | each decoded value | `tx`, `rx`, `ecu` (CAN header), `pid`, `data` (hex data bytes), `f` (field), `val`, `u` (unit). PIDs without a decoder have only `data`. |
| `obd_adapter` | every 5 s | adapter-measured battery voltage (`ATRV`) |
| `obd_stats` | every 10 s | requests/s, mean latency, per-PID polls/answers/tier/interval |

Sensor keys: `acc`, `acc_unc`, `gyro`, `gyro_unc`, `mag`, `mag_unc`, `gravity`,
`linacc`, `rotvec`, `gamerot`, `georot`, `pressure`, `light`, `prox`, `temp`,
`humidity`, `heading`. `v` follows Android's `SensorEvent.values` layout for that type
(e.g. `rotvec` is x, y, z, w, heading accuracy).

## Files on the phone

```
Android/data/app.fuelish/files/recordings/<id>/
  recording.json             metadata (rewritten atomically)
  chunk-000000.ndjson        chunk in progress (or left by a crash; recovered on next launch)
  chunk-000000.ndjson.gz     finished chunk (immutable; uploaded as-is, then deleted from the phone)
  chunk-000000.meta.json     per-chunk stats: records, per-stream counts and min/max intervals, sha256, and
                             `track` (trackFormat 2): every GPS fix as [wallMs, lat, lon, speedMps, hAccM,
                             bearingDeg, joltMps2], where jolt = max |‖accel‖ − g| since the previous fix.
                             Older chunks (no trackFormat) only have a point every 5 s; the web app rebuilds
                             their route from the raw chunks instead.
                             `engine` (engineFormat 1, only when OBD values arrived): rows of [wallMs at the
                             middle of a second, mean of each `engineCols` field from the main ECU over that
                             second, or null], for about 20 engine fields (rpm, speed, pedal, load, maf,
                             commanded_lambda, coolant_temp, ...). ~8 KB a minute. Older chunks don't have it;
                             the web app reads their engine data from the raw chunks.
  chunk-000000.uploaded      server acknowledged this chunk
  meta.uploaded              sha256 of the last recording.json the server accepted
```

With `upload.deleteAfterUpload` on (the default), a recording's whole folder is deleted once it
is stopped and every chunk plus the final metadata has been acknowledged by the server.

`recording.json` also has `trigger` (`manual`, `car_bluetooth`, `car_bluetooth_notification`) and, once
stopped, `stopReason` (`manual`, `car_disconnected`, `engine_off`, `service_destroyed`).

`recording.json` `status`: `recording`, `stopped` (normal stop), or `interrupted`
(the app was killed; recovered at next launch with whatever reached disk, at most
~1 s lost).

## Server

- D1 `recordings` and `chunks` tables hold the phone's metadata JSON verbatim plus a
  few columns for listing.
- R2 key: `recordings/<id>/chunk-<seq:06>.ndjson.gz`, byte-identical to the phone's file.
- Upload is idempotent on `(recording id, seq)` with sha256 verification.
