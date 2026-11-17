import json, os, sys
out = sys.argv[sys.argv.index("--out") + 1]
json.dump({"artifacts": [], "facts": {"env": sorted(os.environ)}}, open(os.path.join(out, "manifest.json"), "w"))
