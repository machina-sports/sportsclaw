# Writes the events it is given as a shared event-index for the source.
# mode "bad-sha" names another source; mode "extra-field" adds a key the index shape does not have;
# mode "unshared" does not mark it shared. "sleep" waits that many seconds first.
import json, os, sys, time
from ask_proxy import ask_eyes
a = sys.argv
doc = json.load(open(a[a.index("--input") + 1]))
out = a[a.index("--out") + 1]
inp = doc["input"]
mode = inp.get("mode", "")
events = inp["events"]
sha = doc["source"]["sha256"]
time.sleep(inp.get("sleep", 0))
ask_eyes("read the scoreboard")
if mode == "bad-sha":
    sha = "0" * 64
if mode == "extra-field":
    events = [dict(e, extra=1) for e in events]
json.dump({"version": 1, "sourceSha256": sha, "events": events, "skipped": []}, open(os.path.join(out, "index.json"), "w"))
json.dump({"artifacts": [{"kind": "event-index", "file": "index.json", "shared": mode != "unshared"}], "facts": {"events": len(events)}},
          open(os.path.join(out, "manifest.json"), "w"))
