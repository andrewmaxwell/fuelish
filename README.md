# Fuelish

Records driving telemetry (phone sensors, GNSS, OBD-II through an OBDLink MX+) so trips
can be analysed, mapped and compared later. Milestone 1 is about **collecting real
data reliably**. Reporting and scoring come later.

```
android/   Android recorder (Kotlin, Compose). Foreground service, chunked local storage, WorkManager uploads
server/    Cloudflare Worker: API (/api/v1/*) + serves web/ as static assets; D1 metadata, R2 chunks
web/       Static web page: list recordings, inspect collection quality, download raw data
tools/     fuelish.py: summarise / export a downloaded recording to CSV (stdlib only)
docs/      data-format.md: every record type, clock and file
```

## How it works

1. **Start recording** in the app → foreground service + partial wake lock (keeps going with the screen locked).
2. Every source writes timestamped NDJSON records to one writer thread. Every 60 s (configurable) the chunk is
   gzipped, hashed, and written next to a stats sidecar. A crash loses at most about 1 s. Leftover chunks are finished on the next launch
   and the recording is marked `interrupted`.
3. WorkManager uploads finished chunks once the phone is on Wi-Fi (any unmetered network), retrying with backoff.
   **Upload now** on the main screen sends them over mobile data too; `upload.allowCellular` makes that automatic.
   Uploads are idempotent: the server keys chunks by `(recording, seq)`, checks the sha256, and treats re-sends as duplicates.
   A chunk is marked uploaded only after the server acknowledges it (sha256 verified, stored in R2); its data is then
   deleted from the phone, and a finished recording's folder is removed once the server has all of it
   (`upload.deleteAfterUpload`, default on).
4. The web page lists trips by day (route outline, distance, moving time, top speed). Each trip opens on a full-size
   map colored by speed, acceleration, bumpiness, GPS accuracy or time, with a speed timeline and a friction circle
   (forward vs. sideways g from GPS speed and heading). Hovering any of the three highlights the same moment in the others.

**OBD is read-only by construction:** `ElmAllowlist` lets through only AT/ST adapter setup, mode 01 (live data),
03/07/0A (read stored, pending and permanent codes) and 09 (VIN/calibration). Anything else, including 04 (clear codes), throws
before reaching the adapter. On connect the recorder discovers which PIDs the car says it supports
(nothing is assumed about the Civic), reads VIN and DTCs, then **benchmarks** single-PID latency and the largest
multi-PID request the ECU answers fully. After that it polls with an earliest-deadline-first scheduler: "fast" PIDs (RPM,
speed, MAF/MAP, throttle, load, pedal) use all spare bus time, while medium (500 ms) and slow (5 s) PIDs get their turn.
When multi-PID requests work, the slow PIDs ride along in otherwise-empty slots. Every exchange is logged raw (`obd_raw`)
beside the decoded values (`obd`, with unit and source bytes). Supported PIDs the decoder doesn't know are still
polled and stored as raw bytes. Fuel rate (PID 5E) is recorded only if the car reports it. Nothing is estimated.

## Deploy the backend (one time)

```bash
cd server && npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler d1 create fuelish
```

Paste the printed `database_id` into `server/wrangler.jsonc`, then:

```bash
npx wrangler r2 bucket create fuelish-recordings
```

```bash
npx wrangler d1 migrations apply fuelish --remote
```

Create two long random tokens: one for the phone (upload only), one for the web page (read only).

```bash
openssl rand -hex 32
```

```bash
npx wrangler secret put DEVICE_TOKEN
```

```bash
npx wrangler secret put WEB_TOKEN
```

```bash
npx wrangler deploy
```

The deploy prints the URL (e.g. `https://fuelish.<account>.workers.dev`). Open it and sign in with `WEB_TOKEN`.
The token is kept in that browser's localStorage. Downloads use signed links that expire after 15 minutes.

After that, deploys are automatic: every push to `main` that touches `server/` or `web/` runs the typecheck and
tests, applies D1 migrations, then deploys (`.github/workflows/deploy.yml`). It needs a Cloudflare API token with
**Workers Scripts: Edit** and **D1: Edit** on the account, stored as the `CLOUDFLARE_API_TOKEN` repo secret:

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

## Install the Android app

Requirements: Android Studio, or its bundled JDK, plus Android SDK platform 37.2. The SDK path goes in `android/local.properties`.

```bash
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew assembleRelease
```

Enable USB debugging on the Pixel (Settings → About phone → tap Build number 7×, then Developer options → USB debugging), connect it, then:

```bash
~/Library/Android/sdk/platform-tools/adb install -r android/app/build/outputs/apk/release/app-release.apk
```

The release APK is signed with the local debug key (fine for sideloading to your own phone). The `debug` build also
allows plain-HTTP uploads to `10.0.2.2`/`localhost`, for testing against `wrangler dev`.

First run on the phone:
1. **Grant permissions** (location "while using the app", nearby devices/Bluetooth, notifications).
2. **Allow unrestricted battery** (button on the main screen). This keeps recording and uploads alive with the screen off.
3. **Settings** → server URL + `DEVICE_TOKEN` → Save.
4. Pair the MX+ in Android Bluetooth settings (press the button on the adapter), then pick it under Settings → OBD adapter.

### Auto-record with the car's Bluetooth

Settings → **Auto-record**: turn it on, pick the Civic's Bluetooth entry (not the MX+), and tap
**Allow all the time** for location. After that:

- **Start:** when the phone connects to the car's Bluetooth, recording starts in the background (no tap needed)
  and connects to the MX+ as usual. Android permits this because a Bluetooth connection broadcast lets an app start
  a foreground service from the background. The battery-optimisation exemption is a second, independent allowance.
  Location in a service started that way needs "Allow all the time".
- **If Android refuses anyway** (e.g. the permission was revoked), you get a "Car connected: tap to record"
  notification; one tap opens Fuelish and starts recording.
- **Stop:** 120 s after the car's Bluetooth disconnects (a reconnect within that window cancels it, so
  brief drops don't split a drive), or after the MX+ reports the car not answering for 300 s. An MX+ link failure alone
  never stops a recording. Both delays are `auto.stopAfterCarDisconnectS` / `auto.stopAfterEngineOffS` in the JSON (0 disables).
- Recordings you start by hand are never stopped automatically. Every recording stores `trigger`
  (`manual`, `car_bluetooth`, `car_bluetooth_notification`) and `stopReason` (`manual`, `car_disconnected`, `engine_off`,
  `service_destroyed`). The car connect/disconnect events are in the data too.

Debug builds can simulate the car's Bluetooth from adb (the real broadcast can't be sent from adb):

```bash
adb shell am broadcast -n app.fuelish/.auto.DebugCarReceiver --es address AA:BB:CC:DD:EE:FF --ez connected true
```

Everything else (sensor rates in Hz, GNSS raw measurements, chunk length, PID tiers and intervals, forced
multi-PID batch size, uploading over mobile data) is in the JSON box in Settings. Each recording embeds the
exact config it ran with (token redacted).

## Run locally

```bash
cd server && npm test
```

```bash
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew testDebugUnitTest
```

Local server with local D1/R2 (`server/.dev.vars` sets `dev-device-token` / `dev-web-token`):

```bash
cd server && cp .dev.vars.example .dev.vars && npx wrangler d1 migrations apply fuelish --local && npx wrangler dev --ip 0.0.0.0
```

The emulator reaches it at `http://10.0.2.2:8787`. To try a real phone on the same Wi-Fi, use the Mac's LAN IP.
That only works with a debug build after adding the IP to `android/app/src/debug/res/xml/network_security_config.xml`.

Inspect a downloaded recording:

```bash
python3 tools/fuelish.py summary recording.ndjson.gz
```

```bash
python3 tools/fuelish.py export recording.ndjson.gz out/
```

## What has been tested

- **Worker** (5 tests in the Workers runtime): token scopes, metadata-before-chunks, idempotent re-upload, sha mismatch rejection,
  conflicting content rejected, missing-chunk detection, completeness, signed-link download = exact concatenation, device-id ownership.
- **Android JVM tests** (24, including auto-stop rules: disconnect grace period, brief drops, engine-off, adapter trouble never stops): JSON escaping; chunk rotation with every record accounted for; crash recovery; ELM/CAN parsing
  (single + ISO-TP multi-frame); multi-PID splitting and SAE decoding; the read-only allowlist; scheduler fairness; uploader
  resume after errors, lost-ack duplicates, bad token, live recordings. The OBD recorder also runs end to end against a fake
  ELM327/STN adapter: discovery, VIN, benchmark finding the multi-PID limit, ignition-off wait then recovery, reconnect after
  a dropped link.
- **Emulator (Pixel 9 Pro profile, Android 16)** against local `wrangler dev`: recording with the screen locked
  (≈1 k records/s, 0 dropped), simulated GPS movement, uploads with retry, force-killing the app mid-recording →
  recovered as `interrupted` and uploaded complete, web page list/detail/map/downloads, CSV export.
  Auto-record (simulated car Bluetooth via the debug receiver): background start with no tap and screen-off
  location, a 4 s Bluetooth drop that didn't split the recording, auto-stop after disconnect with `stopReason` recorded,
  and a refused background start falling back to the tap-to-record notification.
  Measured on the emulator at default settings: **≈65 MB/hour compressed** (≈6:1 vs raw). The emulator caps its virtual sensors at 100 Hz, so expect more on the Pixel.

## Still needs testing on the real phone and car

- [ ] **Sensor rates on the Pixel 9 Pro**: does `acc`/`gyro` actually deliver 200 Hz (see the web page's stream table), and how many MB/hour does that cost?
- [ ] **Screen-off reliability for a full drive** (30–60 min), with and without the battery-optimisation exemption. Look for gaps >1 s on fast streams and `drop` records.
- [ ] **Battery drain per hour** while unplugged (the web page shows %/hour and the fraction of time plugged in). Try `gnssMeasurements: false` and lower sensor rates to see what they cost.
- [ ] **MX+ pairing and SPP connect** (`BluetoothSppTransport`). Not testable without hardware. If the secure socket fails, it falls back to insecure RFCOMM.
- [ ] **What the Civic actually supports**: check the first recording's `obd_discovery` (OBD panel on the web page). Confirm the protocol is ISO 15765-4 CAN 11/500 and look at which PIDs answer, especially MAF (10), MAP (0B), fuel rate (5E, probably absent), commanded λ (44) and wideband O2 (34).
- [ ] **Benchmark results**: single-PID latency and whether the ECU answers multi-PID requests completely (`obd_bench`), plus sustained requests/s (`obd_stats`). If a second ECU (e.g. the CVT at 7E9) answers, its values are tagged by `ecu`.
- [ ] **Ignition off/on in the middle of a recording** (should show `waiting_vehicle` then resume), and walking away from the car until Bluetooth drops (should reconnect with backoff).
- [ ] **Offline drive**: airplane mode for a whole trip, then confirm everything uploads later and the recording shows complete.
- [ ] **Auto-record with the real car**: does the Civic's Bluetooth connection start recording with the phone locked in your pocket?
  The emulator test couldn't send the real Bluetooth broadcast, so the Bluetooth exemption itself is unverified. With the battery
  exemption on as well, start should work either way. Check the recording's `trigger` and how many seconds after starting the car it began.
  Also check that switching the car off ends the recording with `stopReason: car_disconnected` about 2 minutes later, and that a gas stop
  behaves the way you'd like.
- [ ] **Phone mount**: record how the phone is mounted in the note field. Bump/road-surface analysis needs the phone rigidly mounted, and the orientation (gravity/rotation vector) is recorded so it can be rotated into the car frame later.

## Deliberately deferred

Activity-recognition trip detection (for cars without Bluetooth), dashboards, scoring, route matching, fuel-economy estimation (needs MAF/AFR assumptions,
to be added explicitly later), deleting recordings from the server, multi-user auth (Cloudflare Access can sit in front later).
