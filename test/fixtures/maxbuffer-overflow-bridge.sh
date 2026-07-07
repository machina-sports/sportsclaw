#!/bin/sh
# Stand-in for `python3 -m sports_skills ...` that reproduces a real
# divergence between exec's error.message and the raw stderr stream:
# it writes a classifiable signal to stderr, then floods stdout past
# execFile's maxBuffer so Node kills the process and replaces
# error.message with the generic "stdout maxBuffer length exceeded" —
# losing the classifying text that only exists in stderr.
echo "${FLAKY_ERROR:-429 too many requests}" >&2
yes A | head -c 40000000
exit 1
