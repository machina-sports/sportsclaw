import json, os, sys
a = sys.argv
mode = json.load(open(a[a.index("--input") + 1]))["input"]["mode"]
out = a[a.index("--out") + 1]
open(os.path.join(out, "good.json"), "w").write("{}")
outside = os.path.join(out, "..", "outside.txt")
open(outside, "w").write("secret")
bad = {"dotdot": "../outside.txt", "abs": os.path.abspath(outside)}.get(mode, "link.txt")
if mode == "symlink":
    os.symlink(os.path.abspath(outside), os.path.join(out, "link.txt"))
json.dump({"artifacts": [{"kind": "facts", "file": "good.json"}, {"kind": "facts", "file": bad}], "facts": {}},
          open(os.path.join(out, "manifest.json"), "w"))
