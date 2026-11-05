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
| `gnss_status` | ~1 Hz, if `location.gnssStatus` (off by default) | per-satellite constellation, svid, C/N0, elevation, azimuth, used-in-fix |
| `gnss_meas` | ~1 Hz, if `location.gnssMeasurements` (off by default) | raw GNSS clock + measurements (pseudorange rate, ADR, received SV time, ...) for post-processing |
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

### What a default recording holds (since Nov 2026)

Only streams the app uses or is likely to: GPS and fused location, OBD (decoded and raw), battery,
the accelerometer and the barometer. The accelerometer runs at 200 Hz so `jolt` still sees short
bumps, but only ~50 Hz is written (`sensorStoreHz.acc`; whole samples kept as delivered, never
averaged; `sensor_info` carries `storeHz`). The barometer runs at 5 Hz (road grade). Gyroscope,
magnetometer, the fused orientation sensors and raw GNSS (`gnss_status`, `gnss_meas`) are off; each
can be turned back on in the settings JSON. The satellite count on the status screen still works
without `gnss_status` records. That's ~0.17 MB per driving minute instead of ~1.8 MB. A phone whose
saved settings still hold the old default blocks exactly takes the new ones.

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
                             Status fields (mil_on, dtc_count, fuel_sys1) hold the second's last reading,
                             not a mean. Since late 2026 two derived columns ride along (`fuelEstVersion` 1):
                             `fuel_est_gs`, fuel g/s computed per airflow sample from the air-fuel target
                             read within the last second (0 in fuel cut), and `fuel_cut`, the share of
                             those samples in fuel cut.
                             If a sidecar is too big for the upload header, the phone drops a whole
                             summary (rows and format keys together) and lists it in `summaryOmitted`;
                             the web app rebuilds that chunk's summary from its raw data. A dropped track
                             leaves `routeOutline` behind: the same points cut to [wallMs, lat, lon,
                             speedMps, hAccM], at most one every 1–20 s, so the trip list still has the route.
                             A chunk recovered after a crash has `recovered: true`, no summaries (but a
                             `routeOutline` from its GPS lines), and its
                             clock (`firstNs`, `wallStartMs`, `lastNs`, `wallEndMs`) and per-stream counts
                             read back from the raw file.
  chunk-000000.uploaded      server acknowledged this chunk
  meta.uploaded              sha256 of the last recording.json the server accepted
  server.complete            the server confirmed it holds every chunk 0..chunkCount-1
  upload.target              where it uploads, fixed when recording starts: server, a fingerprint of the
                             upload key (never the key), and the account. A recording whose account or
                             server differs from the phone's current one waits until the person chooses
                             to send it as the current account (that resets the acknowledgements above
                             when the server changes).
  upload.refused             the key that tried, and why the server refused it (someone else's trip)
```

With `upload.deleteAfterUpload` on (the default), a recording's whole folder is deleted only once it
is stopped, its chunk count is known, every chunk 0..chunkCount-1 is finished and acknowledged,
nothing is left half-written, the final metadata is acknowledged, and the server answered
`POST /recordings/<id>/verify` with `complete: true`. One uploader runs at a time.

`recording.json` carries `rev`, raised on every write. The server never lets a lower `rev` replace a
higher one, and never lets a `recording` snapshot reopen a stopped or interrupted recording.

`recording.json` also has `trigger` (`manual`, `car_bluetooth`, `car_bluetooth_notification`) and, once
stopped, `stopReason` (`manual`, `car_disconnected`, `engine_off`, `service_destroyed`). An automatic
stop also records when the drive itself ended, before the stop wait: `driveEndWallMs` and
`driveEndElapsedNs` (the Bluetooth disconnect, or when the engine stopped answering).

`recording.json` `status`: `recording`, `stopped` (normal stop), or `interrupted`
(the app was killed; recovered at next launch with whatever reached disk, at most
~1 s lost).

`resumes` (optional): the id of the recording an app update cut short, which this one carries on.
The phone starts it by itself after the update (a manual recording always, an automatic one while the
car's Bluetooth is still connected), and the web map draws the two as one drive.

## Server

- D1 `recordings` and `chunks` tables hold the phone's metadata JSON verbatim plus a
  few columns for listing.
- R2 key: `recordings/<id>/chunk-<seq:06>-<sha256>.ndjson.gz` (older chunks: without the sha), byte-identical
  to the phone's file; D1's `r2_key` names the accepted object. Naming objects by content means two
  conflicting uploads of one seq can't overwrite each other's bytes; the loser's object is removed.
- `complete` means every seq 0..chunkCount-1 is present, not just that many chunks. Chunks past a
  final chunkCount are refused.
- `GET /recordings` is paged, newest first by (start time, id): pass the previous page's `next`
  (`"<startMs>:<id>"`) as `?before=`.
- `prefs` (D1): small JSON settings the web page edits, `GET /prefs`, `PUT /prefs/<key>` with the
  web token. Only known keys with the right shape are accepted: `places` (a list of
  `{ lat, lon, name }`, names 1–80 characters) and `costs` (`timePerHour`, `wearPerMile`,
  `valuePerMile`, `co2KgPerGal`, `carbonPerTonne`, `otherPerMile`, each a number ≥ 0).
- `POST /recordings/<id>/verify` answers `{ complete, missing }`. The phone re-sends any missing
  chunk it still has; one it no longer has is kept in `server.missing` and shown on the main screen.
- Upload is idempotent on `(recording id, seq)` with sha256 verification.
