# Machina Sports Schema envelopes

Real output of the released schema, for `test/machina-sports-schema.test.mjs`. Nothing here is
written by hand, and nothing in this repository computes a schema id.

- `sports-skills-espn-soccer-envelope.json`: the cross-repository reference envelope, copied
  byte for byte from `sports-skills` (`tests/fixtures/canonical/`). Its sha256 is recorded in
  that repository's `REFERENCE-CONTRACT.json`, and the test checks it.
- `nba-synthetic-envelope.json`: what `sports_skills.canonical.canonicalize_nba_event`
  (sports-skills 0.40.4) returns for the stand-in game in `nba-synthetic-native.json`. It is the
  fixture with play-by-play actions.

Names, ids and scores in both are stand-ins.
