import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "docker", "relay");
const python = process.env.PYTHON_PATH || "python3";

const driver = String.raw`
import json, os, sys, tempfile, types

root = tempfile.mkdtemp(prefix="sc-relay-agents-")
os.environ["HIGHLIGHTS_JOBS_ROOT"] = os.path.join(root, "jobs")
os.environ["HIGHLIGHTS_MEDIA_ROOT"] = os.path.join(root, "media")
os.environ["AGENTS_API_TOKEN"] = "agent-secret"

class Response:
    def __init__(self, data, status=200):
        self.data = data
        self.status = status

class Router:
    def __init__(self): self.routes = []
    def add_get(self, path, handler): self.routes.append(("GET", path))
    def add_post(self, path, handler): self.routes.append(("POST", path))
    def add_patch(self, path, handler): self.routes.append(("PATCH", path))

class Application(dict):
    def __init__(self):
        super().__init__()
        self.router = Router()

web = types.SimpleNamespace(
    Request=object, Response=Response, StreamResponse=object,
    Application=Application,
    json_response=lambda data, status=200: Response(data, status),
    run_app=None,
)
aiohttp = types.ModuleType("aiohttp")
aiohttp.web = web
sys.modules["aiohttp"] = aiohttp
sys.path.insert(0, sys.argv[1])
import relay_server

scenario = sys.argv[2]
if scenario == "routes":
    print(json.dumps(relay_server.create_app().router.routes))
elif scenario == "command":
    print(json.dumps(relay_server._build_cmd({"prompt": "hello", "user_id": "u1", "agent_id": "analyst"})))
elif scenario == "delegated_command":
    print(json.dumps(relay_server._build_cmd({"prompt": "hello", "agent_id": "analyst", "_delegated": True})))
elif scenario == "invalid":
    try:
        relay_server._build_cmd({"prompt": "hello", "agent_id": "../escape"})
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
    else:
        print(json.dumps({"error": None}))
elif scenario == "delegate":
    print(json.dumps(relay_server._build_delegated_body({
        "prompt": "research this", "user_id": "u1",
        "source_agent_id": "analyst", "agent_id": "newsdesk"
    })))
elif scenario == "self":
    try:
        relay_server._build_delegated_body({
            "prompt": "research this", "user_id": "u1",
            "source_agent_id": "analyst", "agent_id": "analyst"
        })
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
    else:
        print(json.dumps({"error": None}))
elif scenario == "recursive":
    try:
        relay_server._build_delegated_body({
            "prompt": "research this", "user_id": "u1",
            "source_agent_id": "analyst", "agent_id": "newsdesk",
            "delegation_depth": 1
        })
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
    else:
        print(json.dumps({"error": None}))
elif scenario == "inactive":
    class Request:
        headers = {"X-Auth-Token": "agent-secret"}
        async def json(self):
            return {
                "prompt": "research", "user_id": "u1",
                "source_agent_id": "analyst", "agent_id": "retired"
            }
    async def fake_cli(args, payload=None):
        agent_id = args[1]
        return {"id": agent_id, "active": agent_id != "retired"}
    relay_server._run_agent_cli = fake_cli
    result = __import__("asyncio").run(relay_server.agents_delegate(Request()))
    print(json.dumps({"status": result.status, "data": result.data}))
elif scenario == "auth":
    class Request:
        headers = {}
    result = __import__("asyncio").run(relay_server.agents_list(Request()))
    print(json.dumps({"status": result.status, "data": result.data}))
elif scenario == "query_auth":
    class Request:
        headers = {}
    result = relay_server._query_agent_auth_error(Request(), {"agent_id": "analyst"})
    print(json.dumps({"status": result.status, "data": result.data}))
elif scenario == "query_compat":
    del os.environ["AGENTS_API_TOKEN"]
    class Request:
        headers = {}
    result = relay_server._query_agent_auth_error(Request(), {"prompt": "hello"})
    print(json.dumps({"allowed": result is None}))
elif scenario == "active_type":
    try:
        relay_server._validate_agent_payload({"active": 0}, create=False)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
    else:
        print(json.dumps({"error": None}))
elif scenario == "title_validation":
    errors = []
    for title in ("x" * 121, " padded ", "bad\x7ftitle", "bad\ntitle"):
        try:
            relay_server._validate_agent_payload({"title": title}, create=False)
        except Exception as exc:
            errors.append(str(exc))
    empty = relay_server._validate_agent_payload({"title": ""}, create=False)
    print(json.dumps({"errors": errors, "empty": empty}))
elif scenario == "mutation_responses":
    calls = []
    async def fake_cli(args, payload=None):
        calls.append({"args": args, "payload": payload})
        return {
            "id": payload.get("id", "match-reader"),
            "name": payload.get("name", "Match Reader"),
            "title": payload.get("title", ""),
            "body": payload.get("body", "Directives"),
            "skills": payload.get("skills", []),
            "tags": payload.get("tags", []),
            "active": True,
            "builtin": False,
        }
    relay_server._run_agent_cli = fake_cli
    class Request:
        headers = {"X-Auth-Token": "agent-secret"}
        match_info = {"agent_id": "match-reader"}
        def __init__(self, payload): self.payload = payload
        async def json(self): return self.payload
    async def mutate():
        created = await relay_server.agents_create(Request({
            "id": "match-reader", "name": "Match Reader",
            "title": "Football Briefing Specialist", "body": "Directives"
        }))
        updated = await relay_server.agents_patch(Request({"title": "Senior Match Analyst"}))
        return {
            "created_status": created.status,
            "created": created.data,
            "updated_status": updated.status,
            "updated": updated.data,
            "calls": calls,
        }
    print(json.dumps(__import__("asyncio").run(mutate())))
`;

function run(scenario) {
  const result = spawnSync(python, ["-c", driver, relayDir, scenario], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

describe("relay native agents API", () => {
  it("registers CRUD and one-hop delegation routes", () => {
    const routes = run("routes").map(([method, path]) => `${method} ${path}`);
    assert.ok(routes.includes("GET /api/agents"));
    assert.ok(routes.includes("POST /api/agents"));
    assert.ok(routes.includes("GET /api/agents/{agent_id}"));
    assert.ok(routes.includes("PATCH /api/agents/{agent_id}"));
    assert.ok(routes.includes("POST /api/agents/delegate"));
  });

  it("validates and forwards query agent_id as --agent", () => {
    const command = run("command");
    assert.deepEqual(command.slice(-4), ["--user", "u1", "--agent", "analyst"]);
    assert.match(run("invalid").error, /agent_id/i);
  });

  it("builds a one-hop target query without arbitrary system prompts", () => {
    const delegated = run("delegate");
    assert.equal(delegated.agent_id, "newsdesk");
    assert.equal(delegated.user_id, "u1");
    assert.equal(delegated.prompt, "research this");
    assert.equal("system_prompt" in delegated, false);
    assert.match(run("self").error, /self/i);
    assert.match(run("recursive").error, /recursive|one-hop/i);
    assert.ok(run("delegated_command").includes("--delegated"));
  });

  it("denies delegation to an inactive target", () => {
    const response = run("inactive");
    assert.equal(response.status, 403);
    assert.match(response.data.error, /inactive/i);
  });

  it("fails closed without agent API auth and rejects non-boolean inactivation", () => {
    assert.equal(run("auth").status, 401);
    assert.equal(run("query_auth").status, 401);
    assert.equal(run("query_compat").allowed, true);
    assert.match(run("active_type").error, /active/i);
  });

  it("validates optional titles and returns them from create and update", () => {
    const validation = run("title_validation");
    assert.equal(validation.errors.length, 4);
    assert.ok(validation.errors.every((error) => /title/i.test(error)));
    assert.equal(validation.empty.title, "");

    const mutations = run("mutation_responses");
    assert.equal(mutations.created_status, 201);
    assert.equal(mutations.created.agent.title, "Football Briefing Specialist");
    assert.equal(mutations.updated_status, 200);
    assert.equal(mutations.updated.agent.title, "Senior Match Analyst");
    assert.equal(mutations.calls[0].payload.title, "Football Briefing Specialist");
    assert.equal(mutations.calls[1].payload.title, "Senior Match Analyst");
  });
});
