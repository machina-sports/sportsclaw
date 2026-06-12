#!/bin/sh
# Stand-in for `python3 -m sports_skills ...` used by bridge resilience tests.
# Counts invocations in $FLAKY_STATE. Fails with $FLAKY_ERROR on stderr until
# $FLAKY_FAILURES invocations have happened, then prints JSON on stdout.
COUNT=0
[ -f "$FLAKY_STATE" ] && COUNT=$(cat "$FLAKY_STATE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$FLAKY_STATE"
if [ "$COUNT" -le "$FLAKY_FAILURES" ]; then
  echo "${FLAKY_ERROR:-getaddrinfo ENOTFOUND fake.example}" >&2
  exit 1
fi
echo "{\"ok\": true, \"attempt\": $COUNT}"
