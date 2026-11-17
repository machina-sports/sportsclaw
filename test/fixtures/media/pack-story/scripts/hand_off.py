# Reports what the runner handed it: the artifacts map and whether a role proxy was given.
import json, os, sys, time
a = sys.argv
doc = json.load(open(a[a.index("--input") + 1]))
out = a[a.index("--out") + 1]
time.sleep(doc["input"].get("sleep", 0))
facts = {"artifacts": doc.get("artifacts"), "proxyUrl": os.environ.get("SPORTSCLAW_ROLE_PROXY_URL")}
json.dump({"artifacts": [], "facts": facts}, open(os.path.join(out, "manifest.json"), "w"))
