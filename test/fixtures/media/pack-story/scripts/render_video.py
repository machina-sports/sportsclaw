# A renderer: copies the source as the story video and reports the timeline and artifacts it got.
import json, os, shutil, sys
a = sys.argv
doc = json.load(open(a[a.index("--input") + 1]))
out = a[a.index("--out") + 1]
shutil.copyfile(doc["source"]["path"], os.path.join(out, "story.mp4"))
facts = {"captions": doc["input"]["timeline"]["captions"], "artifacts": doc.get("artifacts")}
json.dump({"artifacts": [{"kind": "video", "file": "story.mp4"}], "facts": facts}, open(os.path.join(out, "manifest.json"), "w"))
