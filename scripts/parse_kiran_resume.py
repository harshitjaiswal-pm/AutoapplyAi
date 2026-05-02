"""Step 5 of the autonomous loop: parse Kiran's stored resumeText into
structured form and write the full StoredResume blob back to Redis.

The /onboarding flow today saves only the raw text and an empty summary.
This script:
  1. Reads the current `user:{email}:resume` blob from Upstash.
  2. POSTs the resumeText to https://autoapply-ai-delta.vercel.app/api/parse-resume
     (which calls Claude Haiku and returns structured JSON).
  3. Computes parsedResumeSummary (name + jobCount + skillCount) per the
     StoredResume schema in src/app/api/user/resume/route.ts.
  4. Writes the new blob back to Redis under the same key with savedAt updated.

Idempotent — re-running just refreshes the parse.
"""
import json, urllib.request, urllib.parse, re
from pathlib import Path
from datetime import datetime

ENV = Path(r"C:\dev\autoapply-ai\.env.local").read_text()
URL = re.search(r'UPSTASH_REDIS_REST_URL\s*=\s*([^\s"\']+)', ENV).group(1).strip()
TOKEN = re.search(r'UPSTASH_REDIS_REST_TOKEN\s*=\s*([^\s"\']+)', ENV).group(1).strip()

API_BASE = "https://autoapply-ai-delta.vercel.app"
USER = "kiranshahi.can@gmail.com"
KEY = f"user:{USER}:resume"

def upstash_cmd(arr):
    body = json.dumps(arr).encode("utf-8")
    req = urllib.request.Request(
        URL + "/", method="POST",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        data=body,
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def main():
    print(f"[1/4] Reading {KEY} from Upstash...")
    got = upstash_cmd(["GET", KEY])
    raw = got.get("result")
    if not raw:
        print(f"  ERROR: no value at {KEY}"); return 1
    stored = json.loads(raw) if isinstance(raw, str) else raw
    resume_text = stored.get("resumeText", "")
    if not resume_text:
        print("  ERROR: resumeText is empty"); return 1
    print(f"  [ok] resumeText length: {len(resume_text)} chars")
    print(f"  [ok] current parsedResumeSummary: {stored.get('parsedResumeSummary')}")

    print(f"\n[2/4] Calling {API_BASE}/api/parse-resume...")
    body = json.dumps({"resumeText": resume_text}).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/api/parse-resume", method="POST",
        headers={"Content-Type": "application/json"}, data=body,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")[:500]
        print(f"  ERROR: HTTP {e.code} — {err_body}")
        return 1
    parsed = data.get("parsedResume") or data.get("parsed") or data
    if not isinstance(parsed, dict):
        print(f"  ERROR: unexpected response shape: {list(data.keys())}")
        print(f"  body preview: {str(data)[:300]}")
        return 1
    print(f"  [ok] parsedResume keys: {list(parsed.keys())[:8]}")

    # Compute summary
    name = (parsed.get("contactInfo", {}).get("name")
            or parsed.get("name")
            or parsed.get("personalInfo", {}).get("name")
            or "")
    jobs = parsed.get("experience") or parsed.get("workExperience") or parsed.get("jobs") or []
    job_count = len(jobs) if isinstance(jobs, list) else 0

    skills = parsed.get("skills")
    skill_count = 0
    if isinstance(skills, dict):
        for v in skills.values():
            if isinstance(v, list): skill_count += len(v)
            elif isinstance(v, str): skill_count += len([s for s in v.split(",") if s.strip()])
    elif isinstance(skills, list):
        skill_count = len(skills)
    elif isinstance(skills, str):
        skill_count = len([s for s in skills.split(",") if s.strip()])

    print(f"  [ok] computed summary: name={name!r}, jobs={job_count}, skills={skill_count}")

    print("\n[3/4] Writing updated blob back to Redis...")
    new_blob = {
        "resumeText": resume_text,
        "parsedResume": parsed,
        "parsedResumeSummary": {
            "name": name,
            "jobCount": job_count,
            "skillCount": skill_count,
        },
        "savedAt": datetime.now().isoformat() + "Z",
    }
    res = upstash_cmd(["SET", KEY, json.dumps(new_blob)])
    if res.get("result") != "OK":
        print(f"  ERROR: SET returned {res}"); return 1
    print(f"  [ok] {KEY} written ({len(json.dumps(new_blob))} bytes)")

    print("\n[4/4] Verify round-trip...")
    got = upstash_cmd(["GET", KEY])
    verify = json.loads(got["result"]) if isinstance(got["result"], str) else got["result"]
    print(f"  [ok] read back: name={verify['parsedResumeSummary']['name']!r}, "
          f"jobs={verify['parsedResumeSummary']['jobCount']}, "
          f"skills={verify['parsedResumeSummary']['skillCount']}, "
          f"savedAt={verify['savedAt']}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
