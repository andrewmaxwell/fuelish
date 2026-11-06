# Fuelish

Records driving telemetry (phone sensors, GNSS, OBD-II through an OBDLink MX+) and shows
each trip on a web page: maps, fuel use and cost, repeated-trip comparisons, insights.
Several people can use one server, each signed in with Google and seeing whose trips are whose.

```
android/   Android recorder (Kotlin, Compose). Foreground service, chunked local storage, WorkManager uploads
server/    Cloudflare Worker: API (/api/v1/*) + serves web/ as static assets; D1 metadata, R2 chunks
web/       Static web page: trips, maps, insights, repeated-trip leaderboards, costs, transmission (node --test web/test/*.test.mjs)
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
   map with four views over it: **Cost** (with the OBD adapter, the default: fuel per mile over ~20 s against the
   drive's own average at that speed, so climbs, ramps and stop-and-go show red and coasting blue), **Speed**,
   **Smooth** (braking red, speeding up blue) and **Pedal**. Small ticks cross the route every minute (wide apart
   on the highway, bunched in town, stacked at stops) or, with engine data, every 5–100¢ of gas (wide where the car
   sips, bunched on climbs and hard starts); every fifth is labeled. Notable moments are labeled on the map (hardest brake and
   acceleration, sharpest turn, top speed, longest stop, thirstiest minute). Below the map is a short speed
   timeline; beside it the headline numbers (miles, moving time, mpg, cost), highway vs. town economy, wasted fuel,
   a one-line car health summary and a friction circle (forward vs. sideways g from GPS speed and heading).
   Hovering the map or the timeline shows that moment's readout.
   Trips that start within 30 min of the last one ending, near where it ended (errands, a fuel stop), are linked into
   one **outing**. A day, a week or an outing can be opened as one map of all its trips. An automatic stop waits a
   couple of minutes after the car goes away; that wait (usually you walking off) isn't counted or drawn.
   With the OBD adapter, fuel use comes from the engine. The Civic doesn't report
   fuel use, so it's estimated from airflow and the commanded air-fuel ratio. Miles come from the car's speed,
   scaled to GPS when the two consistently disagree (the Civic reads about 2% low).
   Each trip shows its cost at the average regular gas price for its week and region (U.S. EIA weekly survey,
   fetched and cached by the Worker: no key or input needed). **Where you could save** ranks what the driver
   controls by what it cost: braking (the energy braked off, with the biggest stops linked to the map), cruising
   above 60/65/70 mph (gas saved against minutes lost, from the drive's own fuel use at steady speeds), idling and
   running rich at full throttle. Engine readings are moved onto GPS time per drive (the GPS track runs about 2 s
   ahead of the phone's clock), so map colors and readouts land where they happened.
   **Insights** (`#/insights`) covers every drive with engine data: totals, fuel economy by speed and by engine
   temperature, and a grid of how the engine signals correlate, with a scatter for any pair and links to the
   moments they disagree most.
   **Repeated trips** (`#/routes`) groups drives between the same two places (named once, for every browser)
   into leaderboards: least gas, quickest, cheapest all in, best mpg, with cold starts and thin fuel data marked.
   When you've driven a journey more than one way, the ways are compared side by side by median time, gas and cost.
   **Costs** (`#/costs`) counts what driving really costs: gas, your time, wear and repairs, lost resale value and
   carbon, each assumption editable. It finds your cheapest steady speed from your own fuel use (with and without
   your time), what idling costs a minute, and what each cold start costs. Every trip page shows its own breakdown.
   **Transmission** (`#/cvt`) shows how the CVT picks engine speed: rpm against road speed colored by pedal, revs
   per mph at light and heavy pedal, how revs answer a press of the pedal, cold vs warm, and engine braking while
   coasting. It's built from engine rpm and road speed (the Civic reports no CVT data), so it shows behavior, not wear.
   **Share this trip** on a trip page makes a link anyone can open without the web token: just that trip
   (route, charts, engine data), with no phone settings, Bluetooth addresses or raw data. **Stop sharing**
   turns the link off.

**One app on the phone.** The Android app opens on the web page (trips, maps, insights) shown inside it, loaded from
the server URL in Settings. A strip along the bottom shows what the recorder is doing (recording time, uploads, or
what starts the next recording); tap it for the recorder screen. Sign in to the web page once in the app with the
web token: it stays signed in. When the server confirms it has all of a trip, a "Trip ready" notification opens
straight to it. If the page can't load (no signal), the app says so instead of showing a browser error. A browser
"Add to Home screen" shortcut to the web page is no longer needed on the phone.

**OBD is read-only by construction:** `ElmAllowlist` lets through only AT/ST adapter setup, mode 01 (live data),
03/07/0A (read stored, pending and permanent codes) and 09 (VIN/calibration). Anything else, including 04 (clear codes), throws
before reaching the adapter. On connect the recorder discovers which PIDs the car says it supports
(nothing is assumed about the Civic), reads VIN and DTCs, then **benchmarks** single-PID latency and the largest
multi-PID request the ECU answers fully. After that it polls with an earliest-deadline-first scheduler: "fast" PIDs (RPM,
speed, MAF/MAP, throttle, load, pedal) use all spare bus time, while medium (500 ms) and slow (5 s) PIDs get their turn.
When multi-PID requests work, the slow PIDs ride along in otherwise-empty slots. The benchmark also tries addressing the engine ECU alone (the Civic's transmission ECU otherwise answers
half the requests with copies of the engine's values) and keeps that if it's faster and nothing is lost. Every exchange is logged raw (`obd_raw`)
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

### Accounts (Sign in with Google)

People sign in with Google; there are no passwords. The Google Cloud project **Fuelish** has one web OAuth client
(its ID is `GOOGLE_CLIENT_ID` in `wrangler.jsonc`, `web/account.js` and the Android `GoogleSignIn.kt`; it isn't
secret) and two Android clients for package `app.fuelish`, one per signing key (release and debug SHA-1). Its
authorized JavaScript origins are the workers.dev URL and `http://localhost:8787`.

- **The owner** claims the server once: sign in with `WEB_TOKEN` as before, then **Continue with Google** in the
  banner. That account becomes the owner and gets every trip uploaded so far.
- **Everyone else** joins with an invite link (Account → Make an invite link; one person, two weeks).
- **Phones**: signing in inside the Android app also gives that phone its own upload key, so its recordings count
  as that person's. Keys are listed (and removable) on the Account page. A phone that uploaded with the shared
  `DEVICE_TOKEN` counts as the owner's; Account → Phones that have uploaded moves its trips to someone else.
- **Seeing trips**: everyone signed in can see everyone's trips; the header's "whose trips" picker starts on your own.
- `WEB_TOKEN` and `DEVICE_TOKEN` keep working (as the owner). Sessions are an HttpOnly cookie for a year; requests
  that change something must carry `X-Fuelish: 1`, which another site can't add.

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

Release APKs are signed with the key in `~/.android/fuelish-release.jks` (its passwords are in
`~/.android/fuelish-release.properties`). Google sign-in is registered against that key, and an installed app only
updates from an APK with the same key, so **back both files up** (a password manager is fine). Without them, release
builds fall back to the debug key. The `debug` build also allows plain-HTTP uploads to `10.0.2.2`/`localhost`, for
testing against `wrangler dev`.

### Updating the app on everyone's phones

```bash
tools/publish-apk.sh
```

builds a release APK from a clean checkout and uploads it to the server (owner only: it uses `WEB_TOKEN`).
Each phone checks when Fuelish opens (at most every 30 minutes) and shows **A new version of Fuelish is ready**
above the recorder strip; a tap downloads it, checks its SHA-256 and opens Android's installer. The first time,
Android asks to allow "Install unknown apps" for Fuelish. It never installs mid-recording. The version number is
the git commit count, so every published build is newer than the last. Debug builds don't offer updates.

**Automatically:** `.github/workflows/android.yml` runs the unit tests and then `tools/publish-apk.sh` on every
push to main that touches `android/`. It needs the release key and owner token as repo secrets, set once from
this Mac (nothing is printed):

```bash
base64 -i ~/.android/fuelish-release.jks | gh secret set FUELISH_RELEASE_JKS_B64
gh secret set FUELISH_RELEASE_PROPERTIES < ~/.android/fuelish-release.properties
grep '^WEB_TOKEN=' server/.secrets.env | cut -d= -f2- | tr -d '"'"'"' \r' | gh secret set FUELISH_WEB_TOKEN
```

Until they're set, the workflow only runs the tests and warns that it skipped publishing.

First run on the phone:
1. **Grant permissions** (location "while using the app", nearby devices/Bluetooth, notifications).
2. **Allow unrestricted battery** (button on the main screen). This keeps recording and uploads alive with the screen off.
3. **Sign in with Google** on the Trips page (the server URL is filled in). That also sets up uploads from this phone.
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
- **Stop:** 10 s after the car's Bluetooth disconnects, once the engine has stopped answering OBD (if it still
  answers, the car is running and it was a Bluetooth glitch, so the drive goes on), or after the MX+ reports the car
  not answering for 60 s with Bluetooth still on. An MX+ link failure alone never stops a recording. Trips split by a
  stop are joined into one outing on the web. Both delays are `auto.stopAfterCarDisconnectS` /
  `auto.stopAfterEngineOffS` in the JSON (0 disables).
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

Local server with local D1/R2 on `http://localhost:8787`. It installs dependencies, creates `server/.dev.vars`
(`dev-device-token` / `dev-web-token`) if missing and applies migrations. Sign in with Google or the web token.

```bash
tools/dev.sh
```

To try changes on your real trips, copy production's database and recordings down first (read-only against
production; replaces the local database; recordings are mirrored, so re-runs only fetch what's new; needs
`npx wrangler login`). Stop the local server before pulling.

```bash
tools/dev.sh --pull
```

`tools/pull-prod.sh` does just the copy (`--db-only` skips recordings, `--apks` adds the published APKs).

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

- **Worker** (41 tests in the Workers runtime, `cd server && npm test`): token scopes, metadata-before-chunks, idempotent re-upload,
  sha mismatch rejection, conflicting content rejected, missing-chunk detection, completeness, signed-link download = exact
  concatenation, device-id ownership; Google sign-in, invites, people and phones, signing in again after a session ends;
  share links, prefs, app updates; input checks on metadata and chunk tracks, trip summaries and route outlines.
- **Web** (26 tests, `node --test web/test/*.test.mjs`): the analysis math (route distance, fuel, costs, repeated trips).
- **Android JVM tests** (56, including auto-stop rules: disconnect grace period, brief drops, engine-off, adapter trouble never stops): JSON escaping; chunk rotation with every record accounted for; crash recovery; ELM/CAN parsing
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
  Also check that switching the car off ends the recording with `stopReason: car_disconnected` about 10 seconds later, and that a gas stop
  behaves the way you'd like.
- [ ] **Phone mount**: record how the phone is mounted in the note field. Bump/road-surface analysis needs the phone rigidly mounted, and the accelerometer's average (gravity) plus GPS heading is enough to rotate it into the car frame later.

## Deliberately deferred

Activity-recognition trip detection (for cars without Bluetooth), driving scores, and deleting recordings from the server.
