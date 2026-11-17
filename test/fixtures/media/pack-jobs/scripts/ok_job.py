import json, os, sys
a = sys.argv
inp = json.load(open(a[a.index("--input") + 1]))
out = a[a.index("--out") + 1]
open(os.path.join(out, "result.json"), "w").write(json.dumps({"text": inp["input"].get("text")}))
kind = inp["input"].get("kind", "subject-identity")
json.dump({"artifacts": [{"kind": kind, "file": "result.json", "facts": {"n": 1}}],
           "facts": {"argv0": a[0], "source": inp.get("source")}}, open(os.path.join(out, "manifest.json"), "w"))
