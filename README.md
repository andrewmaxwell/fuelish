# Fuelish

Records driving telemetry (phone sensors, GNSS, and OBD-II through a Bluetooth adapter such as an OBDLink MX+
or LX) and shows each trip on a web page: maps, fuel use and cost, repeated-trip comparisons, insights.
Several people can use one server, each signed in with Google and seeing whose trips are whose.

```
android/   Android recorder (Kotlin, Compose). Foreground service, chunked local storage, WorkManager uploads
server/    Cloudflare Worker: API (/api/v1/*) + serves web/ as static assets; D1 metadata, R2 chunks
web/       Static web page: trips, maps, insights, repeated trips, costs, transmission (tests: web/test/).
           app.js is what the pages share and the router; list.js, trip.js, many.js, pages.js and map.js are the pages
shared/    cases.json: inputs and answers for rules that exist in more than one of web/, server/ and android/ (gas
           region, distance, fuel from airflow). Each suite checks its copy against it; make-cases.mjs rewrites it
tools/     dev.sh (local server), pull-prod.sh (copy production data down), publish-apk.sh (ship the app),
           fuelish.py (summarise / export a downloaded recording to CSV, stdlib only)
docs/      data-format.md: every record type, clock and file
brand/     generate.py draws the logo, favicon and Android icons; preview.html shows them
.github/   deploy.yml (Worker) and android.yml (APK), both run on pushes to main
```

## How it works

1. **Start recording** in the app (or let the car's Bluetooth start it) → foreground service + partial wake lock,
   so it keeps going with the screen locked.
2. Every source writes timestamped NDJSON records to one writer thread. Every 60 s (configurable) the chunk is
   gzipped, hashed, and written next to a stats sidecar. A crash loses at most about 1 s. Leftover chunks are
   finished on the next launch and the recording is marked `interrupted`.
3. WorkManager uploads each finished chunk over any network as you drive (about 13 MB per hour of driving),
   retrying with backoff. Settings → **Upload over mobile data** off makes uploads wait for Wi-Fi (any unmetered
   network); **Upload now over mobile data** on the recorder screen then sends them anyway.
   Uploads are idempotent: the server keys chunks by `(recording, seq)`, checks the sha256, and treats re-sends as
   duplicates. A chunk is marked uploaded only after the server acknowledges it (sha256 verified, stored in R2); its
   data is then deleted from the phone, and a finished recording's folder is removed once the server has all of it
   (`upload.deleteAfterUpload`, default on).
4. The web page shows the trips. See below.

**Fuel data.** With an OBD adapter, fuel use comes from the engine. Cars that don't report fuel rate (PID 5E;
the Civic doesn't) get it estimated from airflow and the commanded air-fuel ratio. Miles come from the car's speed,
scaled to GPS when the two consistently disagree (the Civic reads about 2% low). Engine readings are moved onto GPS
time per drive (the GPS track runs about 2 s ahead of the phone's clock), so map colors and readouts land where they
happened. Each trip's cost uses the average regular gas price for its week and region (U.S. EIA weekly survey,
fetched and cached by the Worker: no key or input needed).

## What the web page shows

**Trip list.** Trips by day (route outline, distance, moving time, top speed), the last five weeks first. Trips that
start within 30 min of the last one ending, near where it ended (errands, a fuel stop), are linked into one
**outing**, and so are trips out and back to the same place on the same day however long you stayed (Home → X → Home;
the card shows the time parked). A day, a week or an outing can be opened as one map of all its trips. An automatic stop waits a couple of
minutes after the car goes away; that wait (usually you walking off) isn't counted or drawn.

**A trip.** A full-size map with five views over it:
- **Spend** (the default with an adapter): a band beside the route as wide as the gas spent per mile there, split
  into lanes by what it went to: the engine just running, tires, air, climbing, speeding up and everything else,
  from physics fitted to the drive's own fuel readings. Gas burned standing still is a circle at the stop, at the
  same scale; what downhills saved is counted too (`web/ribbon.js`). Grades come from USGS ground heights, the AWS
  Terrain Tiles passed through the Worker at `/api/v1/terrain` (`web/terrain.js`).
- **Vs usual** (with an adapter): fuel per mile over ~20 s against the drive's own average at that speed, so ramps
  and stop-and-go show red and coasting blue.
- **Speed**, **Smooth** (braking red, speeding up blue) and **Pedal**.

Small ticks cross the route every minute or, with engine data, every 5–100¢ of gas; every fifth is labeled. Notable
moments are labeled too (hardest brake and acceleration, sharpest turn, top speed, longest stop, thirstiest minute).
Below the map is a speed timeline; beside it the headline numbers (miles, moving time, mpg, cost), highway vs. town
economy, wasted fuel, a one-line car health summary and a friction circle. Hovering the map or the timeline shows that
moment's readout. The **driving score** (also on each trip in the list) is the gas the cheapest way to drive the
trip would take ÷ the gas it took (`web/ideal.js`). The cheapest way keeps the same roads and stops and is never faster
than you were anywhere, so traffic and lights hold it back too. It changes only what the driver controls: no running
rich, the engine off in long standstills, cruising no faster than the cheapest steady speed counting your time (kept to
55–70 mph), and slowing early and gently. Its fuel comes from the drive's own fit, scaled to the measured fuel. Lines
under the score say what each difference cost and add up to the gap.

**Share this trip** makes a link anyone can open without signing in: just that trip (route, charts, engine data), with
no phone settings, Bluetooth addresses or raw data. **Stop sharing** turns the link off.

**Other pages:**
- **Insights** (`#/insights`): every drive with engine data. Totals; the last 12 weeks side by side (mpg, gas spent and
  the week's driving score: its trips' scores weighted by their gas), a month-by-month table, and the best and
  thirstiest trips; fuel economy by speed and by engine temperature,
  and a grid of how the engine signals correlate, with a scatter for any pair and links to where they disagree most.
- **Stops** (`#/stops`): every stop along every drive with engine data (lights, stop signs, traffic; not a trip's
  start or end or a pause within 100 m of either, nor anything over 5 minutes): the gas burned waiting plus the gas to get back up to speed, and the
  time lost. Stops within ~35 m are one place; the map sizes each place by what it cost and colors it by the usual wait.
- **Repeated trips** (`#/routes`): drives between the same two places (named once, for everyone) as leaderboards:
  least gas, quickest, cheapest all in, best mpg, with cold starts and thin fuel data marked. A journey driven more
  than one way has the ways compared by median time, gas and cost.
- **Costs** (`#/costs`): what driving really costs (gas, your time, wear and repairs, lost resale value, carbon), each
  assumption editable. Finds your cheapest steady speed from your own fuel use, what idling costs a minute, and what
  each cold start costs. Every trip page shows its own breakdown.
- **Transmission** (`#/cvt`): how a CVT picks engine speed, from engine rpm and road speed alone (the Civic reports no
  CVT data), so it shows behavior, not wear.

## The Android app

The app opens on the web page (trips, maps, insights) shown inside it, loaded from the server URL in Settings.
A strip along the bottom shows what the recorder is doing (recording time, uploads, or what starts the next
recording); tap it for the recorder screen. When the server confirms it has all of a trip, a "Trip ready"
notification opens straight to it. If the page can't load (no signal), the app says so instead of showing a browser error.

**OBD is read-only by construction:** `ElmAllowlist` lets through only AT/ST adapter setup, mode 01 (live data),
03/07/0A (read stored, pending and permanent codes) and 09 (VIN/calibration). Anything else, including 04 (clear
codes), throws before reaching the adapter. On connect the recorder discovers which PIDs the car says it supports
(nothing is assumed about the car), reads VIN and DTCs, then **benchmarks** single-PID latency and the largest
multi-PID request the ECU answers fully. After that it polls with an earliest-deadline-first scheduler: "fast" PIDs
(RPM, speed, MAF/MAP, throttle, load, pedal) use all spare bus time, while medium (500 ms) and slow (5 s) PIDs get
their turn. When multi-PID requests work, the slow PIDs ride along in otherwise-empty slots. The benchmark also tries
addressing the engine ECU alone (some cars, like the Civic, have a transmission ECU that answers half the requests
with copies of the engine's values) and keeps that if it's faster and nothing is lost. Every exchange is logged raw
(`obd_raw`) beside the decoded values (`obd`, with unit and source bytes). Supported PIDs the decoder doesn't know are
still polled and stored as raw bytes.

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

Create two long random tokens: `DEVICE_TOKEN` (uploads only) and `WEB_TOKEN` (the owner's key: it claims the server
once and publishes app updates).

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

The app is served at `https://fuelish.andrewmaxwell.dev` (the `routes` entry in `wrangler.jsonc`; the
`andrewmaxwell.dev` zone is on the same Cloudflare account). The old `https://fuelish.emailandrewmaxwell.workers.dev`
still works. Open it and sign in with `WEB_TOKEN`.
The token is kept in that browser's localStorage. Downloads use signed links that expire after 15 minutes.

### Accounts (Sign in with Google)

People sign in with Google; there are no passwords. The Google Cloud project **Fuelish** has one web OAuth client
(its ID is `GOOGLE_CLIENT_ID` in `wrangler.jsonc`, `web/account.js` and the Android `GoogleSignIn.kt`; it isn't
secret) and two Android clients for package `app.fuelish`, one per signing key (release and debug SHA-1). Its
authorized JavaScript origins are `https://fuelish.andrewmaxwell.dev`, the workers.dev URL and `http://localhost:8787`.

- **The owner** claims the server once: sign in with `WEB_TOKEN` as before, then **Continue with Google** in the
  banner. That account becomes the owner and gets every trip uploaded so far.
- **Everyone else** joins with an invite link (Account → Make an invite link; one person, two weeks).
- **Phones**: signing in inside the Android app also gives that phone its own upload key, so its recordings count
  as that person's. Keys are listed (and removable) on the Account page. A phone that uploaded with the shared
  `DEVICE_TOKEN` counts as the owner's; Account → Phones that have uploaded moves its trips to someone else.
- **Seeing trips**: everyone signed in can see everyone's trips; the header's "whose trips" picker starts on your own.
- **Changing things**: only you (or the owner) can share your trips or correct their towing, and only the people who
  drive a vehicle can change its costs. Place names are everyone's; the shared starting cost settings are the owner's.
- **Deleting**: a trip's page has Delete (its person or the owner); Account has "Delete all my trips" and, for
  everyone but the owner, "Delete my account". Deleted trips leave only their id, so a phone still holding one
  is told 410 and drops its copy.
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

First run on the phone: the recorder's **Set up Fuelish** card walks through one step at a time, each with a
sentence on why it's needed:
1. **Sign in with Google** (the server URL is built in). Someone new needs an invite made for their Google
   address (Account → Invite someone); signing in uses it, so they never sign up on the web.
2. **Permissions**: location, nearby devices (Bluetooth), notifications.
3. **OBD adapter**: plug it in, press its button, tap **Find adapter**. Android's companion-device sheet lists
   nearby adapters and pairs the one tapped, with no trip to Bluetooth settings. Or **I don't have one**.
4. **Battery**: unrestricted, so recording and uploads keep going with the screen off. (Being the adapter's
   companion app may already allow this, in which case the step is checked off.)
5. **Vehicle**, only without an adapter. With one, the first drive reads the VIN and the server names the car
   with NHTSA's decoder (`GET /api/v1/vehicles/vin/:vin`). A name typed in Settings is never replaced.

Then **How recording starts**: automatically or by hand. With an adapter, automatic needs no car to pick (see
below); it asks for "Allow all the time" location and physical activity. Without one, it asks which Bluetooth
entry is the car.

After a drive with the car's Bluetooth connected, the recorder offers to use that car (a car stereo or hands-free
kit; never headphones or the adapter): **Record every drive automatically?**, or with auto-record already on,
**Start recording sooner?** No never asks about that device again.

Settings has the vehicle, adapter, auto-record, what's said during a drive, and mobile-data uploads. The server, device token and raw JSON are under Advanced.

### Auto-record

Settings → **Auto-record**: turn it on and tap **Allow** for location all the time (and physical activity, with an
adapter). After that:

- **Start, with an adapter:** Android's activity recognition says when the phone starts riding in a vehicle,
  usually a minute or two into the drive, and recording starts in the background and tries the adapter. Its
  uploads wait until the engine answers through the adapter. If it doesn't within 2 minutes
  (`auto.adapterWaitS`), it wasn't a car with the adapter in it (someone else's car, a bus): the recording is
  deleted, never uploaded, and a quiet notification says so if the phone drove anywhere. So moving the adapter
  to another car just works. Two things keep the drive anyway, recorded from the phone alone, with a spoken
  "can't reach the adapter": the adapter's Bluetooth link came up (it's in this car; the car just isn't
  answering it), or the phone is connected to a car stereo it's paired with (so it's your car, and the adapter is
  the problem). Android allows a background start on
  an activity-transition event; the registration is renewed at app start, after a reboot and after an update.
- **Start, with the car's Bluetooth** (optional with an adapter, required without one): pick the car's entry
  (not the OBD adapter) and recording starts as soon as the phone connects, so the start of the drive isn't
  missed. A Bluetooth connection broadcast lets an app start a foreground service from the background. If
  Android refuses anyway, you get a "Car connected: tap to record" notification.
- **Stop:** 10 s after the car's Bluetooth disconnects or Android says you left the vehicle (walking), once the
  engine has stopped answering OBD (if it still answers, the car is running and it was a glitch, so the drive goes
  on); or after the adapter reports the car not answering for 60 s. An adapter link failure alone never stops a
  recording. Trips split by a stop are joined into one outing on the web. The delays are
  `auto.stopAfterCarDisconnectS` / `auto.stopAfterEngineOffS` in the JSON (0 disables).
- Recordings you start by hand are never stopped automatically. Every recording stores `trigger`
  (`manual`, `car_bluetooth`, `car_bluetooth_notification`, `driving_detected`) and `stopReason` (`manual`,
  `car_disconnected`, `left_vehicle`, `engine_off`, `service_destroyed`). The connect/disconnect and
  `left_vehicle` events are in the data too.

### During a drive

Spoken like navigation prompts (through the car's speakers when the phone plays there, lowering music instead of
pausing it), so nothing needs a glance. Settings → **During a drive** has a switch for each:

- **Recording sounds:** a chime when recording starts (for a detected drive, once the adapter confirms the car),
  and a spoken alert if the adapter never connects 90 s into a moving drive, or drops for 20 s while moving
  (and again when it's back). A drop after the car stopped answering is the car switching off, not a problem.
- **Summary when a drive ends:** miles, time, gallons, mpg and the gas cost at the latest regional average price.
  Said when the car is switched off (the engine stops answering the adapter and the phone is standing still, or
  the car's Bluetooth goes), not when the recording stops a while later, so you're still in the seat. A recording
  you stop yourself, or one without an adapter, says it when it stops.
- **Car warnings:** the check-engine light coming on (not every drive while it stays on), coolant at 113 °C
  (235 °F) or more for 30 s, under 12.0 V for a minute with the engine running.
- **Idling tip:** at most once a drive, after three minutes idling at a standstill in one go: how long, and
  what the wait has cost so far. Nothing is said about how you drive while the car is moving.

What was said is in the data as `feedback` events.

Debug builds can simulate the car's Bluetooth, or Android detecting a drive, from adb (the real broadcasts can't
be sent from adb):

```bash
adb shell am broadcast -n app.fuelish/.auto.DebugCarReceiver --es address AA:BB:CC:DD:EE:FF --ez connected true
```

```bash
adb shell am broadcast -n app.fuelish/.auto.DebugCarReceiver --ez driving true
```

Everything else (sensor rates in Hz, GNSS raw measurements, chunk length, PID tiers and intervals, forced
multi-PID batch size) is in the JSON box in Settings. Each recording embeds the
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

- **Worker** (59 tests in the Workers runtime, `cd server && npm test`): token scopes, metadata-before-chunks,
  idempotent re-upload, sha mismatch and conflicting content rejected, missing-chunk detection, completeness,
  signed-link download = exact concatenation, device-id ownership; Google sign-in, invites, people and phones,
  signing in again after a session ends; share links, prefs, app updates, deleting; input checks on metadata and
  chunk tracks, trip summaries and route outlines; VIN lookups.
- **Web** (56 tests, `node --test web/test/*.test.mjs`): the analysis math (route distance, fuel, costs, repeated trips).
- **Android JVM tests** (102, `./gradlew testDebugUnitTest`): JSON escaping; chunk rotation with every record
  accounted for; crash recovery; ELM/CAN parsing (single + ISO-TP multi-frame); multi-PID splitting and SAE decoding;
  the read-only allowlist; scheduler fairness; auto-stop rules (disconnect grace period, brief drops, engine-off,
  adapter trouble never stops, a detected drive without the adapter or with a slow one, leaving the vehicle); what's said during a
  drive, the end-of-drive summary and when it's said; naming trips by VIN; uploader resume after errors, lost-ack duplicates, bad token, live recordings. The OBD
  recorder also runs end to end against a fake ELM327/STN adapter: discovery, VIN, benchmark finding the multi-PID
  limit, ignition-off wait then recovery, reconnect after a dropped link.
- **Emulator (Pixel 9 Pro profile, Android 16)** against local `wrangler dev`: recording with the screen locked,
  simulated GPS movement, uploads with retry, force-killing the app mid-recording (recovered as `interrupted` and
  uploaded complete), and auto-record through the debug receiver (background start, a 4 s Bluetooth drop that didn't
  split the recording, auto-stop with `stopReason`, and the tap-to-record fallback). A detected drive with no
  adapter was held from upload and deleted after the wait; text-to-speech spoke the adapter warning 90 s into a
  simulated drive and the summary after parking.
- **Real drives** in the Civic with an OBDLink MX+ and a Pixel 9 Pro on a windshield mount.

## Still worth checking on a real drive

- [ ] **Battery drain per hour** while unplugged (the web page shows %/hour and the fraction of time plugged in).
- [ ] **Offline drive**: airplane mode for a whole trip, then confirm everything uploads later and the recording shows complete.
- [ ] **Ignition off/on mid-recording** (should show `waiting_vehicle` then resume), and walking away until the adapter's
  Bluetooth drops (should reconnect with backoff).
- [ ] **Drive detection**: how far into a drive recording starts, that riding in another car without the adapter
  leaves nothing behind, and that walking away ends a drive whose adapter dropped.
- [ ] **Spoken prompts** over the car's speakers with Maps and music playing: loud enough, ducking not pausing.
- [ ] **Other cars**: the first drive in a new car (a truck towing a camper, a turbo engine) — check its
  `obd_discovery` and `obd_bench` and whether fuel and Spend look sensible.

## Deliberately deferred

Judging route choice in the driving score, and coaching while driving (hard stops, highway speed).
