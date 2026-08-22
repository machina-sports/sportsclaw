import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterToolNamesForAgent,
  selectExplicitAgents,
} from "../dist/agents.js";
import { conversationNamespace, scopeSessionId } from "../dist/engine.js";

const agents = [
  {
    id: "nba-reader",
    name: "NBA Reader",
    skills: ["nba"],
    tags: [],
    body: "NBA only",
    active: true,
    builtin: false,
  },
  {
    id: "retired",
    name: "Retired",
    skills: ["nfl"],
    tags: [],
    body: "Inactive",
    active: false,
    builtin: false,
  },
];

describe("explicit native agent selection", () => {
  it("selects exactly the requested active agent", () => {
    assert.deepEqual(selectExplicitAgents(agents, ["nba-reader"]), [agents[0]]);
    assert.throws(() => selectExplicitAgents(agents, []), /exactly one/i);
    assert.throws(() => selectExplicitAgents(agents, ["nba-reader", "retired"]), /exactly one/i);
    assert.throws(() => selectExplicitAgents(agents, ["missing"]), /not found/i);
  });

  it("denies inactive agents", () => {
    assert.throws(() => selectExplicitAgents(agents, ["retired"]), /inactive/i);
  });

  it("constrains tools to the selected agent skills", () => {
    const owners = new Map([
      ["nba_scores", "nba"],
      ["nfl_scores", "nfl"],
    ]);
    assert.deepEqual(
      filterToolNamesForAgent(
        agents[0],
        ["nba_scores", "nfl_scores", "run_selftest", "mcp__demo__health"],
        (name) => owners.get(name),
      ),
      ["nba_scores", "run_selftest", "mcp__demo__health"],
    );
  });

  it("isolates persisted sessions by native agent", () => {
    assert.equal(scopeSessionId("discord-42", "nba-reader"), "discord-42::agent::nba-reader");
    assert.notEqual(
      scopeSessionId("discord-42", "nba-reader"),
      scopeSessionId("discord-42", "retired"),
    );
    assert.notEqual(
      conversationNamespace("user-1", "nba-reader", "session-a"),
      conversationNamespace("user-1", "nba-reader", "session-b"),
    );
  });
});
