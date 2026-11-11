/**
 * The reader for the released Machina Sports Schema envelope (src/schema/machina-sports.ts),
 * against envelopes the schema's own code produced. See test/fixtures/machina-sports-schema/README.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const { readMachinaSportsEvent } = await import("../dist/schema/machina-sports.js");

const fixture = (name) => readFileSync(new URL(`./fixtures/machina-sports-schema/${name}`, import.meta.url));
const SOCCER = fixture("sports-skills-espn-soccer-envelope.json");
const soccer = () => JSON.parse(SOCCER.toString("utf8"));
const nba = () => JSON.parse(fixture("nba-synthetic-envelope.json").toString("utf8"));
/** A copy of the soccer envelope with one change applied to its schema block. */
const changed = (change) => {
  const document = soccer();
  change(document.machina_sports_schema);
  return document;
};

describe("reading a Machina Sports Schema envelope", () => {
  it("the reference envelope is the one sports-skills ships", () => {
    // sha256 from sports-skills tests/fixtures/canonical/REFERENCE-CONTRACT.json
    assert.equal(createHash("sha256").update(SOCCER).digest("hex"), "cdcbc745a24eea0e3771cfd93c5603702c9700a4070fd222d53ae75856e493cd");
  });

  it("reads the event, its teams and where it came from, as the envelope states them", () => {
    const event = readMachinaSportsEvent(soccer());
    assert.equal(event.schemaVersion, "machina-sports-schema/1");
    assert.equal(event.profile, "machina-iptc-profile/1.2");
    assert.equal(event.eventId, "urn:machina:sports:event:x8d703481b8b2545eede3d19ac879fc6d");
    assert.equal(event.label, "Synthetic Home United vs Synthetic Away Town");
    assert.equal(event.sport, "soccer");
    assert.equal(event.status, "closed");
    assert.equal(event.startTime, "2026-03-01T20:00:00+00:00");
    assert.deepEqual(event.competition, { id: "urn:machina:sports:competition:xc983a33029ed9a55a34b922a7f8ddc7d", name: "Synthetic Premier Division" });
    assert.deepEqual(event.participants, [
      { id: "urn:machina:sports:team:xc5e6eb33acaef3504ff5fd9c9fdf07c5", role: "home", name: "Synthetic Home United", score: "2" },
      { id: "urn:machina:sports:team:x6db1801abba4c6eac80b3296bd73dc74", role: "away", name: "Synthetic Away Town", score: "1" },
    ]);
    assert.deepEqual(event.actions, []);
    assert.deepEqual(event.provider, { namespace: "sports-skills/espn", family: "open-data" });
    assert.equal(event.observedAt, "2026-03-01T22:05:00+00:00");
    assert.deepEqual(event.rights, { dataClass: "open-public", prototypeOnly: true, commercialUse: false });
  });

  it("reads play-by-play actions with the id the schema gave each one", () => {
    const event = readMachinaSportsEvent(nba());
    assert.equal(event.sport, "basketball");
    assert.deepEqual(event.participants.map((p) => [p.role, p.name, p.score, p.outcome]), [
      ["home", "Synthetic Home Hoopers", "101", "win"],
      ["away", "Synthetic Away Ballers", "99", "loss"],
    ]);
    assert.equal(event.actions.length, 4);
    assert.deepEqual(event.actions[0], {
      id: "urn:machina:sports:action:x36bfe29de77206f951a9d5d2a958caf1", ordinal: "90011", class: "play",
      label: "Synthetic Guard makes 26-foot three point jumper", minute: "11:35", period: "1",
    });
    assert.deepEqual(event.actions.map((a) => [a.ordinal, a.minute, a.period]), [["90011", "11:35", "1"], ["90012", "11:10", "1"], ["90013", "7.1", "4"], ["90014", "1.1", "4"]]);
    assert.ok(event.actions.every((a) => /^urn:machina:sports:action:x[0-9a-f]{32}$/.test(a.id)));
  });

  it("keeps an action the graph does not carry, without an id", () => {
    const document = nba();
    const graph = document.machina_sports_schema.sport_schema_graph;
    graph["@graph"] = graph["@graph"].filter((node) => node["sport:sequenceNumber"] !== "90012");
    const event = readMachinaSportsEvent(document);
    assert.deepEqual(event.actions[1], { ordinal: "90012", class: "play", label: "Synthetic Center misses 4-foot layup", minute: "11:10", period: "1" });
    assert.ok(event.actions[0].id);
  });

  it("is undefined for anything that is not a valid envelope", () => {
    assert.equal(readMachinaSportsEvent(undefined), undefined);
    assert.equal(readMachinaSportsEvent({}), undefined);
    assert.equal(readMachinaSportsEvent({ status: true, data: { events: [] } }), undefined, "a provider-native payload");
    assert.equal(readMachinaSportsEvent(changed((m) => { m.schema_version = "machina-sports-schema/1.1"; })), undefined, "a schema version it was not checked against");
    assert.equal(readMachinaSportsEvent(changed((m) => { delete m.rights; })), undefined, "no rights block");
    assert.equal(readMachinaSportsEvent(changed((m) => { m.rights.commercial_use = "no"; })), undefined, "a rights value that is not true or false");
    assert.equal(readMachinaSportsEvent(changed((m) => { m.event_view.event_id = "9001"; })), undefined, "an event id that is not a schema id");
    assert.equal(readMachinaSportsEvent(changed((m) => { m.event_view.event_id = "urn:machina:sports:team:xc5e6eb33acaef3504ff5fd9c9fdf07c5"; })), undefined, "an id of another kind");
    assert.equal(readMachinaSportsEvent(changed((m) => { m.event_view.participants[0].id = "home"; })), undefined, "a team id that is not a schema id");
    assert.equal(readMachinaSportsEvent(changed((m) => { delete m.event_view.provider.namespace; })), undefined, "no provider");
    assert.equal(readMachinaSportsEvent(changed((m) => { m.event_view.participants[0].score = 2; })), undefined, "a value the schema writes as text, given as a number");
  });
});
