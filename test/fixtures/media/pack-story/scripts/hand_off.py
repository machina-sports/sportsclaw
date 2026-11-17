# Reports what the runner handed it: the artifacts map and whether a role proxy was given.
import json, os, sys, time
from ask_proxy import ask_eyes
a = sys.argv
doc = json.load(open(a[a.index("--input") + 1]))
out = a[a.index("--out") + 1]
time.sleep(doc["input"].get("sleep", 0))
if doc["input"].get("fail"):
    sys.stderr.write("e" * int(doc["input"]["fail"]) + " reading /Users/someone/secret.txt failed")
    sys.exit(1)
facts = {"proxyStatus": ask_eyes("hello") if doc["input"].get("callProxy") else None, "artifacts": doc.get("artifacts"), "proxyUrl": os.environ.get("SPORTSCLAW_ROLE_PROXY_URL"),
         "pad": "x" * int(doc["input"].get("pad", 0))}
json.dump({"artifacts": [], "facts": facts}, open(os.path.join(out, "manifest.json"), "w"))
