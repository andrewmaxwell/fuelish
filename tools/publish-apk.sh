#!/usr/bin/env bash
# Builds a release APK and publishes it, so phones offer it as an update the next time Fuelish opens.
#   tools/publish-apk.sh
# Needs a clean checkout (the version number is the commit count, so it must name one build), the release
# key in ~/.android/fuelish-release.*, and WEB_TOKEN (the owner's) in server/.secrets.env or the environment.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER="${FUELISH_SERVER:-https://fuelish.emailandrewmaxwell.workers.dev}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first: the version number is the commit count." >&2
  exit 1
fi
if [ ! -f ~/.android/fuelish-release.properties ]; then
  echo "No release key (~/.android/fuelish-release.*). Phones can't install a build signed with another key." >&2
  exit 1
fi
TOKEN="${WEB_TOKEN:-$(grep '^WEB_TOKEN=' server/.secrets.env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' \r')}"
[ -n "$TOKEN" ] || { echo "Set WEB_TOKEN (or put it in server/.secrets.env)." >&2; exit 1; }

(cd android && ./gradlew -q assembleRelease)
OUT=android/app/build/outputs/apk/release
APK="$OUT/app-release.apk"
CODE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["elements"][0]["versionCode"])' "$OUT/output-metadata.json")
NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["elements"][0]["versionName"])' "$OUT/output-metadata.json")
SHA=$(shasum -a 256 "$APK" | cut -d' ' -f1)

echo "Publishing Fuelish $NAME (version $CODE, $(du -h "$APK" | cut -f1))…"
# The token goes in on stdin, so it never shows in the process list.
printf 'Authorization: Bearer %s\n' "$TOKEN" | curl -sS --fail-with-body -X PUT \
  -H @- -H "X-Fuelish-Sha256: $SHA" -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary @"$APK" "$SERVER/api/v1/app/apk?versionCode=$CODE&versionName=$NAME"
echo
