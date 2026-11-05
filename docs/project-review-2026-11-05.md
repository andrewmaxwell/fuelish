# Fuelish project review — November 5, 2026

Reviewed commit `0ec52f2`. Reviewed the Android recorder, Worker API/authentication, database migrations, web application and analysis modules, upload/update flows, command-line tools, deployment workflow, and documentation. Application source was not changed. Findings distinguish runtime reproductions, browser observations with synthetic data, and source-level conclusions.

**Most useful first fixes:** escape account names in the owner page; protect the Android recording action from external intents; let expired sessions recover; validate uploaded summaries; and keep one account's pending recording from blocking another account's uploads.

**Validation**

| Check | Result |
| --- | --- |
| Server TypeScript check | Passed |
| Existing Worker/API tests | 33 passed |
| Existing web analysis tests | 26 passed |
| Existing Android JVM tests, forced fresh run | 48 passed |
| npm dependency advisory audit | No known vulnerabilities reported for the installed dependency tree |
| Android lint | Failed: 1 error, 10 warnings; see finding 15 |
| Additional isolated backend probes | Confirmed expired-cookie login/logout failure, cross-member public sharing, missing owner IDs, missing-Content-Length rejection, and list failure from malformed track metadata |
| Additional isolated Android probes | Confirmed invalid required config sections are accepted, an old account's rejected recording blocks later uploads, and acknowledgement markers are independent of server URL |
| Browser review | Actual web code with synthetic trips/accounts, including 320px phone and 1280px desktop layouts; trips, costs, insights, and account screens inspected |

Temporary reproduction tests were removed from the project after running. Reference copies remain at `/tmp/fuelish-review-server-probes.test.ts` and `/tmp/fuelish-review-android-probes.kt`; their relative imports/package placement require copying them back to their original test directories to rerun. No production data, accounts, sharing settings, or deployments were changed.

## Actionable findings

### 1. [P1] Account names can become HTML in the owner's account page

**Location:** [web/account.js:293](/Users/andrew/fuelish/web/account.js:293), [server/src/auth.ts:184](/Users/andrew/fuelish/server/src/auth.ts:184).

The mixed-owner phone option inserts `p.owners.map(nameOf).join(" + ")` directly into `innerHTML`. Other names on the same page are escaped. A name containing closing `option`/`select` tags can escape the selector and create arbitrary page elements. Because this is the owner's page, script execution through this sink would run with owner privileges.

**Evidence:** With synthetic API data, a name containing `</option></select><img ...>` produced an actual image element outside the selector. The browser accessibility tree displayed the injected image. This confirms HTML injection. Acceptance of such a name through Google's current profile-name rules was not tested, so an end-to-end Google-to-stored-XSS exploit is not claimed.

**Fix:** Escape the combined display string, or construct options with DOM APIs and `textContent`. Do not rely on identity-provider name validation as an HTML-safety boundary.

### 2. [P1] Other installed apps can request recording through the exported activity

**Location:** [MainActivity.kt:163](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/MainActivity.kt:163), [AndroidManifest.xml:37](/Users/andrew/fuelish/android/app/src/main/AndroidManifest.xml:37).

The launcher activity is exported, and `handleIntent()` treats any `startTrigger` extra as authority to start recording using Fuelish's existing location permission. Another foreground app can explicitly launch this activity with `startTrigger="manual"`; there is no check that the intent came from Fuelish's notification. A manual trigger also avoids automatic stopping. Fuelish's recorder UI and foreground notification remain visible, so this is not a claim of invisible recording or data exfiltration.

**Evidence:** Source-level finding; not exercised on the user's phone. Android documents that an exported activity can be launched by another app using its exact class name. [Android exported-component guidance](https://developer.android.com/privacy-and-security/risks/android-exported).

**Fix:** Send notification recording actions to a private component, and keep the exported launcher limited to opening the UI. Require an explicit user action before an externally supplied intent starts recording.

### 3. [P2] An expired or revoked browser session prevents signing in again

**Location:** [server/src/index.ts:66](/Users/andrew/fuelish/server/src/index.ts:66), [server/src/auth.ts:102](/Users/andrew/fuelish/server/src/auth.ts:102).

`identify()` runs before `/auth/google` and `/auth/logout`. It throws for an expired cookie or a cookie whose session row was deleted. Consequently, the login form cannot replace that cookie, and logout cannot clear it. This also affects a user whose sessions were removed when disabled and who is later re-enabled. The Android native sign-in uses a separate HTTP request without the WebView cookie, so this specific failure concerns the browser/web login path.

**Evidence:** The same valid Google test credential returned 200 with no cookie, 401 with an expired cookie, and logout with that cookie also returned 401. The error was `signed out`.

**Fix:** Allow authentication endpoints to replace/clear invalid sessions while preserving the owner-token check and CSRF protection. Clear unusable cookies when protected endpoints reject them.

### 4. [P2] One bad uploaded track can break the entire trip list

**Location:** [server/src/index.ts:299](/Users/andrew/fuelish/server/src/index.ts:299), [server/src/index.ts:413](/Users/andrew/fuelish/server/src/index.ts:413).

Chunk metadata is checked for JSON syntax, but its structure and track values are not validated. `tripSummary()` then parses string-valued tracks without isolating errors. A malformed chunk in one trip causes `/recordings` to return 500, also preventing the list-dependent analysis pages from loading for affected filters. An upload credential is required; this is an authenticated denial-of-service path, not an anonymous one.

**Evidence:** A chunk with valid content hash and metadata `{ "track": "not JSON" }` was accepted with 201. The subsequent recordings list returned 500 with a `JSON.parse` failure in `tripSummary()`.

**Fix:** Validate summary objects, track arrays, point lengths, finite values, and coordinate ranges before storage. Isolate corrupt legacy summaries so one trip cannot break an entire page. Also bound `chunkCount` and validate status/revision fields rather than accepting arbitrary integers and status strings.

### 5. [P2] Switching accounts can permanently block the upload queue

**Location:** [GoogleSignIn.kt:87](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/GoogleSignIn.kt:87), [Uploader.kt:57](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/upload/Uploader.kt:57).

Native sign-in replaces the phone's single upload token. Recordings do not retain their upload account. If an older pending recording already belongs to the previous account, the server correctly returns 403 when the new key attempts to continue it. The uploader treats this as a fatal token problem and returns immediately, so every later recording is blocked too. Previously unuploaded recordings instead become attributed to whichever account happens to upload them.

**Evidence:** An isolated Android test with an older recording returning 403 and a newer permitted recording returned `Fatal` after requesting only the older recording. The newer recording was never attempted.

**Fix:** Bind recordings to an account when recording starts, define how pending trips behave on account changes, and report a per-recording ownership problem while allowing other recordings to upload. Prevent an account change from silently reassigning offline trips.

**Related migration risk:** Upload acknowledgement files and `server.complete` are not bound to a server URL. A separate probe showed that a recording acknowledged by server A could be deleted by an uploader configured for unreachable server B without making a request. Its copy still exists on A; this does not prove total data loss. Preserve the destination identity with acknowledgement state, and make server-switch behavior explicit.

### 6. [P2] Valid JSON can save an unusable recorder configuration

**Location:** [Config.kt:106](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/Config.kt:106), [RecorderState.kt:59](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/RecorderState.kt:59), [SettingsScreen.kt:238](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/SettingsScreen.kt:238).

The advanced editor calls parsing “validation,” but the merge permits required objects to become null, strings, or arrays. For example, `{ "obd": null }` is accepted, then `config.obd` throws. Settings and recorder code assume these objects exist. Other unchecked fields can fail later during service startup, after recording resources have been acquired.

**Evidence:** An Android probe confirmed `Config.parse("{\"obd\":null}")` succeeds and reading `obd` throws `JSONException`.

**Fix:** Validate the merged configuration before saving: required object types, sensor rates, intervals, chunk limits, PID lists, Bluetooth addresses, and server URL. Retain a last-known-good configuration and an accessible reset path.

### 7. [P2] Streamed requests without Content-Length are rejected

**Location:** [server/src/index.ts:204](/Users/andrew/fuelish/server/src/index.ts:204).

`Number(req.headers.get("Content-Length"))` converts a missing header to zero. The intended unknown-length streaming branch is therefore never selected when the header is absent. Any nonempty streamed metadata, preference, sign-in, or APK body without a declared length is rejected as exceeding a zero-byte length. The normal Android chunk uploader explicitly sends a fixed length, so it is not affected by this case.

**Evidence:** A valid metadata request backed by a `ReadableStream`, with no Content-Length, returned 400: `metadata longer than its Content-Length`.

**Fix:** Check header presence before conversion, validate a supplied length, and apply the bounded unknown-length path when absent.

### 8. [P2] Omitted track summaries make recorded trips disappear from aggregate maps

**Location:** [Uploader.kt:131](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/upload/Uploader.kt:131), [server/src/index.ts:370](/Users/andrew/fuelish/server/src/index.ts:370), [web/app.js:1040](/Users/andrew/fuelish/web/app.js:1040).

Oversized summaries intentionally lose their track before upload; recovered chunks can also lack a summary. The individual trip page reconstructs these from raw data. The list API only counts retained summaries, and day/week/outing views exclude recordings with `trip === null`. Thus a recording with real GPS can say “No GPS yet,” disappear from aggregate maps, or contribute only part of its distance to totals. Increased GPS rates or chunk durations make summary omission more likely.

**Evidence:** Source-level flow; the existing tests verify raw fallback on individual trips but do not cover list and aggregate-map consistency.

**Fix:** Always retain a compact list summary, even when detailed samples are omitted. Mark summary completeness and rebuild summaries for recovered recordings; distinguish “summary unavailable” from “no GPS recorded.”

### 9. [P2] Trip detail uses different history and person filters from comparison pages

**Location:** [web/app.js:655](/Users/andrew/fuelish/web/app.js:655), [web/app.js:865](/Users/andrew/fuelish/web/app.js:865).

Trip detail fetches one unfiltered `/recordings` page to find its outing and repeated journey. Other pages use paginated `allRecordings()` with the selected person. Older trips beyond the first 500 lose their outing/comparison context. A trip in another person's history can show a comparison link that the currently filtered Compare page cannot resolve.

**Fix:** Use consistent person/history context throughout navigation, or return the trip's outing/journey context from the server. Carry the relevant person in cross-page links when needed.

### 10. [P2] Returning from a trip can hide the active navigation tab on phones

**Location:** [web/app.js:236](/Users/andrew/fuelish/web/app.js:236), [web/style.css:224](/Users/andrew/fuelish/web/style.css:224).

The router scrolls the active tab into view while the previous `page-trip` class still hides the header. Those layout measurements are zero. The header only becomes visible afterward. With the person picker and account icon also present, a narrow screen can display Trips and part of Compare while the active Costs tab is outside the visible area. The scrollbar is hidden, which further conceals the navigation.

**Evidence:** At 320px, opening Costs from a trip left navigation scroll at 0. The navigation viewport was x=54–146, while the active Costs link was x=184–239.

**Fix:** Update the page class before measuring or scroll after layout. Give overflow navigation a visible affordance, or use a compact menu on narrow screens.

### 11. [P2] Quickly naming two places can discard the first name

**Location:** [web/app.js:871](/Users/andrew/fuelish/web/app.js:871), [web/app.js:85](/Users/andrew/fuelish/web/app.js:85).

Each rename snapshots the whole places array before entering the serialized save queue. If rename B starts while rename A is saving, B's snapshot still contains A's old name. B's later save overwrites A despite both requests succeeding. Preserving typed text during redraw does not fix the stored lost update.

**Evidence:** Source-level race: `Prefs` updates its cached value only after the request succeeds, but callers compute replacement arrays before that update.

**Fix:** Queue mutations that merge against the latest value at execution time, or use a per-place update endpoint with revision/conflict handling.

### 12. [P2] Recorder setup can remain incomplete even when the user has done everything required

**Location:** [MainScreen.kt:60](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/MainScreen.kt:60), [MainScreen.kt:113](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/MainScreen.kt:113).

`POST_NOTIFICATIONS` is included in required permissions on all supported Android versions, although it exists only from API 33. On API 31/32 the app's own `checkSelfPermission`-based checklist can continue treating it as missing. Separately, `setupDone` requires an OBD adapter even though the UI explicitly offers “No adapter (phone sensors only)” and labels the adapter optional. A valid phone-only setup therefore never finishes. Recording itself is still available through the separate idle card.

**Evidence:** Source-level finding; lint independently flags the notification constant's API mismatch. No API 31/32 device UI was exercised.

**Fix:** Build required permissions by OS version and chosen features. Separate essential setup from optional enhancements, and allow a phone-only setup to complete.

### 13. [P2] Live and uploading trip pages do not update as promised

**Location:** [web/app.js:690](/Users/andrew/fuelish/web/app.js:690), [MainActivity.kt:111](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/MainActivity.kt:111).

Trip detail says the route fills in as parts upload, but it fetches the recording once and has no poll, subscription, or refresh control. Returning to the Android app refreshes only the list, not a currently open trip. A live or partially uploaded detail can remain incomplete indefinitely until manually reloaded. Raw route/engine caches also use only the recording ID, so future refresh support must account for newly uploaded chunks.

**Fix:** Refresh while recording/uploading, pause refresh when hidden, version caches by content revision, and offer a visible retry/refresh action with a last-updated time.

### 14. [P3] List responses report every recording's userId as null

**Location:** [server/src/index.ts:370](/Users/andrew/fuelish/server/src/index.ts:370), [server/src/index.ts:458](/Users/andrew/fuelish/server/src/index.ts:458).

The list query does not select `r.user_id`, while `recordingRow()` returns that field with a null fallback. Ownership filtering works in SQL, but the returned list records contradict detail responses. This is currently mostly an API correctness issue; the existing UI does not use the list's `userId` for access control.

**Evidence:** For the same owned recording, the local probe returned `userId: null` in the list and the correct owner ID in detail.

**Fix:** Select `r.user_id` and verify list/detail consistency.

### 15. [P2] Android's standard static check currently fails

**Location:** [PhoneSensors.kt:160](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/sensors/PhoneSensors.kt:160).

`lintDebug` fails with `WrongConstant` because `hasAccumulatedDeltaRange()` is compared with literal `1` instead of the named `GnssCapabilities` capability constant. This is a failed quality gate, not evidence that the current numeric comparison produces an incorrect runtime value. The command also reports 10 warnings, including the API-version issue in finding 12; several remaining warnings are style suggestions or concern debug-only code.

**Fix:** Use the named constant and add Android tests/lint to CI. The existing deployment workflow runs server and web checks but provides no Android gate.

## Security policies and hardening

- **Public sharing is available to every member for every trip.** `/recordings/:id/shares` requires only read scope. A non-owner member created a link for the owner's recording with 201, and an unauthenticated request read it with 200. Members can also list and revoke another person's links. This is the current implemented policy, not a bypass of an existing owner check. Consider restricting share management to the trip owner/server owner, and make the policy clear when joining. Members already have read/download access, so this restriction cannot prevent them from redistributing data outside Fuelish. [server/src/index.ts:157](/Users/andrew/fuelish/server/src/index.ts:157).
- **Large uploads leave little memory headroom.** The API accepts 90 MiB chunks and 80 MiB APKs and buffers each complete body before hashing/storing. Workers allow 128 MB per isolate, shared by concurrent requests. Normal chunks are smaller; failure at these upper limits was not load-tested. Stream hashing/storage or reduce limits and account for concurrent uploads. [server/src/index.ts:204](/Users/andrew/fuelish/server/src/index.ts:204), [Cloudflare memory limits](https://developers.cloudflare.com/workers/platform/limits/).
- **Third-party script integrity is an available improvement.** Leaflet is loaded from a CDN without Subresource Integrity, and no application CSP is configured in the repository. A compromised script would execute in a page that can make authenticated requests and may hold the legacy token. Vendor or integrity-pin static dependencies and introduce a CSP compatible with Google sign-in. [web/index.html:27](/Users/andrew/fuelish/web/index.html:27).
- **Release signing should fail closed.** Release builds fall back to a debug key when the release properties are absent. The publish script checks for the properties file, which mitigates the normal publishing path, but a release build on another machine can still produce an APK that existing users cannot install. Require release credentials for release artifacts and verify the APK's signing identity before publication. [android/app/build.gradle.kts:52](/Users/andrew/fuelish/android/app/build.gradle.kts:48).

## UI/UX improvement and simplification opportunities

1. **Make first-run setup a short sequence:** permissions → sign in → optional adapter/auto-record → ready. Offer “Use phone sensors only” as a completed path. Put the JSON editor behind advanced settings and expose ordinary Wi-Fi/mobile-data and keep-local-copy controls directly.
2. **Simplify navigation:** keep Trips, Compare, and Costs prominent; group Insights and Transmission under an analysis menu. A visible overflow affordance or menu works better than a tiny sideways strip beside the person picker.
3. **Make the trip's first screen answer three questions:** how far, how long, and how much gas/cost. Fold the detailed fuel allocation, car-health readings, and friction circle into expandable sections. On mobile, the map currently consumes 62% of viewport height before most results appear.
4. **Label relative fuel use more clearly:** the map's “Cost” view shows fuel per mile relative to this drive's average at the same speed, not dollars. The explanation is hidden on narrow layouts. “Fuel use” plus a concise “Compared with your usual at this speed” explanation would reduce confusion.
5. **Provide keyboard and accessible alternatives to chart inspection.** Map moments, friction points, scatterplots, and heatmap cells depend on pointer events. Image labels identify the chart but do not expose individual values or equivalent controls. Add a keyboard-operable trip timeline and compact data tables for the analysis views. [web/route.js:366](/Users/andrew/fuelish/web/route.js:366), [web/charts.js:43](/Users/andrew/fuelish/web/charts.js:43), [web/plot.js:115](/Users/andrew/fuelish/web/plot.js:115).
6. **Keep failures local and actionable.** Account mutations such as phone removal, invitation creation, and person disabling lack visible error handling in several callbacks. Show an inline error, restore control state, and allow retry. Preserve the current page when a background request fails. [web/account.js:302](/Users/andrew/fuelish/web/account.js:302).
7. **State who the recorder uploads as.** Signing out of the web page intentionally leaves the native upload key active. The recorder strip should identify the upload account and explain that signing out does not stop recording/uploads; provide a separate disconnect-phone action. [TripsWeb.kt:70](/Users/andrew/fuelish/android/app/src/main/java/app/fuelish/ui/TripsWeb.kt:70).
8. **Distinguish measured, estimated, partial, and unavailable data consistently.** Keep these badges near headline values and in aggregate pages, including missing route summaries, guessed fuel, mixed vehicles, and trips with engine outages. Shared cost assumptions should clearly say that editing them affects everyone, even when viewing “My trips.”
9. **Make long-history browsing progressive.** The trip list currently fetches all pages before showing results, and analysis pages request detail for every trip. Show recent trips immediately, load older pages on demand, and offer a date range for analysis. Map rendering creates casing and colored Leaflet segments for every adjacent GPS fix and scans all points during hover; use zoom-aware simplification/batched drawing and a spatial index before histories get large. [web/app.js:47](/Users/andrew/fuelish/web/app.js:47), [web/route.js:451](/Users/andrew/fuelish/web/route.js:451).
10. **Give charts a clear lifecycle.** Insights creates resize observers without a disposal path; the shared plot module exposes `release()` but route cleanup never invokes it. Connect chart cleanup to `onLeave` and profile repeated analysis-page navigation. This is a source-level resource-lifecycle concern; heap growth was not measured. [web/insights.js:151](/Users/andrew/fuelish/web/insights.js:151), [web/plot.js:20](/Users/andrew/fuelish/web/plot.js:20).

## Verification gaps and maintenance

- The signed-in live Fuelish origin was not inspected. Automatic approval review denied that action because access could expose private trip data outside the authorized code-review scope. A separate local preview used only synthetic trips/accounts.
- Real car/adapter behavior, Bluetooth reconnection under hardware faults, GPS quality, screen-off reliability, battery drain, device permission dialogs, and APK installation were not exercised. JVM success does not establish those behaviors.
- No production load or penetration test was run. A suspected long-trip D1 aggregation limit was specifically tested with approximately 2.8 MB of local track metadata and **did not reproduce locally**; it is not listed as a confirmed defect. Production D1 limits still warrant keeping list summaries compact. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Repository scanning found the secret-variable files excluded from version control, scoped upload/read credentials, parameterized SQL, hashed session/device tokens, CSRF protection for cookie mutations, signed expiring download URLs, and an OBD command allowlist. These are useful protections to preserve.
- Add browser-flow checks for login recovery, public sharing policy, mixed-owner account rendering, person-filter navigation, and live refresh. The current web tests exercise analysis math rather than these UI flows.
- Enable Worker traces explicitly if request tracing is wanted: `observability.enabled` enables logs, while `observability.traces.enabled` is absent. Consider generated binding types to keep the hand-written environment interface aligned with configuration. [server/wrangler.jsonc:8](/Users/andrew/fuelish/server/wrangler.jsonc:8), [Cloudflare tracing configuration](https://developers.cloudflare.com/workers/observability/traces/).
- Update README test counts and the deferred-feature list: they still describe 5 Worker tests, 24 Android tests, and features such as multi-user authentication and reporting as deferred even though the code implements them.

Suggested order: security rendering/intent boundaries → login recovery and upload isolation → input/summary validation → navigation/setup/live-state correctness → accessibility, progressive history loading, and analysis-page simplification.
