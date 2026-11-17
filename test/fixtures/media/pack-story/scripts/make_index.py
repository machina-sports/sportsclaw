# Writes the events it is given as a shared event-index for the source.
# mode "bad-sha" names another source; mode "extra-field" adds a key the index shape does not have.
import json, os, sys
a = sys.argv
doc = json.load(open(a[a.index("--input") + 1]))
out = a[a.index("--out") + 1]
inp = doc["input"]
mode = inp.get("mode", "")
events = inp["events"]
sha = doc["source"]["sha256"]
if mode == "bad-sha":
    sha = "0" * 64
if mode == "extra-field":
    events = [dict(e, extra=1) for e in events]
json.dump({"version": 1, "sourceSha256": sha, "events": events, "skipped": []}, open(os.path.join(out, "index.json"), "w"))
json.dump({"artifacts": [{"kind": "event-index", "file": "index.json", "shared": True}], "facts": {"events": len(events)}},
          open(os.path.join(out, "manifest.json"), "w"))
