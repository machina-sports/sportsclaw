# Fails a line that mentions the crowd: the official record has nothing on it.
# A first line "short" makes it drop the last verdict; "crash" makes it exit 1.
import json, os, sys
a = sys.argv
inp = json.load(open(a[a.index("--input") + 1]))["input"]
out = a[a.index("--out") + 1]
lines = inp["lines"]
if lines and lines[0]["text"] == "crash":
    sys.exit(1)
verdicts = []
for line in lines:
    bad = "crowd" in line["text"].lower()
    verdicts.append({"text": line["text"], "ok": not bad, "reasons": ["crowd_not_in_record"] if bad else []})
if lines and lines[0]["text"] == "short":
    verdicts = verdicts[:-1]
json.dump({"artifacts": [], "facts": {"verdicts": verdicts}}, open(os.path.join(out, "manifest.json"), "w"))
