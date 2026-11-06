#!/usr/bin/env bash
# Checks that CHANGELOG.md and RELEASE_NOTES.md lead with the same version and
# that the CHANGELOG heading carries a date.
#
#   scripts/release-docs.sh                     check the two files agree
#   scripts/release-docs.sh 0.1.3               also require that version
#   scripts/release-docs.sh 0.1.3 notes.md      also write its release notes
#
# The release and publish workflows call it with a version, so a tag can never
# ship with the previous release's notes or with no CHANGELOG entry.
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

chg=$(grep -m1 -oE '^## \[[^]]+\]' CHANGELOG.md | sed -E 's/^## \[(.*)\]$/\1/' || true)
rel=$(grep -m1 -oE '^## v[^[:space:]]+' RELEASE_NOTES.md | sed 's/^## v//' || true)

[ -n "$chg" ] || fail "CHANGELOG.md has no \"## [x.y.z] — YYYY-MM-DD\" heading."
[ -n "$rel" ] || fail "RELEASE_NOTES.md has no \"## vx.y.z\" heading."
[ "$chg" = "$rel" ] || fail "CHANGELOG.md leads with [$chg] but RELEASE_NOTES.md leads with v$rel. Both are newest-first and name the same version."

heading=$(grep -m1 -F "## [$chg]" CHANGELOG.md)
printf '%s\n' "$heading" | grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2}' ||
  fail "CHANGELOG.md heading \"$heading\" carries no date. Use \"## [$chg] — YYYY-MM-DD\"."

if [ $# -ge 1 ]; then
  [ "$chg" = "$1" ] || fail "Both files lead with $chg, but the release is $1. Add a section for $1 at the top of each."
fi

if [ $# -ge 2 ]; then
  awk '/^## v/{n++} n==1' RELEASE_NOTES.md > "$2"
fi

echo "CHANGELOG.md and RELEASE_NOTES.md both lead with $chg."
