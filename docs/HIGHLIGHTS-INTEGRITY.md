# Highlights media integrity

Successful extraction manifests now include `source.sha256` / `source.sizeBytes` and
`clips[].sha256` / `clips[].sizeBytes`. SHA-256 is computed from the actual media, in bounded
memory. These are additive V1 fields; consumers must explicitly require them before claiming
that a CV ranking, editorial review or reel is bound to the extraction's bytes.

The relay retains its existing private admission snapshot. CLI extraction pins the resolved
source path and checks file identity and bytes before and after extraction. If they change,
the run fails and removes only its generated clips. It never issues a success manifest for
that run. Source media is not deleted or overwritten.

This does not upload footage, grant rights, call CV, render a reel, or approve delivery.
Old manifests without hashes remain historical records, not verified media receipts. Run
extraction again from an approved source to obtain integrity evidence; do not fill in hashes
by hand to upgrade old records.

Verification: `npm run build` then
`node --test test/highlights-core.test.mjs test/highlights-cli.test.mjs test/highlights-providers.test.mjs test/relay-highlights-api.test.mjs`.
The extraction tests generate synthetic local media and independently hash each output.
