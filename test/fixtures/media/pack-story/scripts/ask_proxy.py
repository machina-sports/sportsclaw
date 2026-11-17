# One call to the role proxy's eyes role, when the runner gave this job a proxy. Errors are ignored.
import json, os, urllib.request

def ask_eyes(text):
    url = os.environ.get("SPORTSCLAW_ROLE_PROXY_URL")
    if not url:
        return None
    req = urllib.request.Request(url + "/role/eyes", data=json.dumps({"input": text}).encode(), method="POST",
                                 headers={"content-type": "application/json",
                                          "authorization": "Bearer " + os.environ["SPORTSCLAW_ROLE_PROXY_TOKEN"]})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status
    except Exception as err:
        return getattr(err, "code", "error")
