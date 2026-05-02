"""Seed Redis with 3 mock AuditRecord blobs so the dashboard renders with
realistic data even before the worker has produced real audits.

Three records:
  app-mock-001  status=completed       — Workday UBC, full successful pipeline
  app-mock-002  status=in_progress     — Canadian Tire, partial steps
  app-mock-003  status=failed          — Langara, errored at start_application

Also pushes the three IDs onto user:kiranshahi.can@gmail.com:applications.
"""
import json, urllib.request, urllib.parse, re
from pathlib import Path
from datetime import datetime, timedelta

ENV = Path(r"C:\dev\autoapply-ai\.env.local").read_text()
URL = re.search(r'UPSTASH_REDIS_REST_URL\s*=\s*([^\s"\']+)', ENV).group(1).strip()
TOKEN = re.search(r'UPSTASH_REDIS_REST_TOKEN\s*=\s*([^\s"\']+)', ENV).group(1).strip()

USER = "kiranshahi.can@gmail.com"

def upstash_cmd(cmd_array):
    """Send a Redis command as JSON array body to Upstash REST root.

    Format: POST {URL}/ with body [\"SET\", \"key\", \"value\", \"EX\", \"3600\"]
    """
    body = json.dumps(cmd_array)
    req = urllib.request.Request(
        URL + "/",
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
        data=body.encode("utf-8"),
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def set_json(key, value):
    return upstash_cmd(["SET", key, json.dumps(value), "EX", str(60 * 60 * 24 * 30)])

def del_key(key):
    return upstash_cmd(["DEL", key])

def lpush(key, values):
    return upstash_cmd(["LPUSH", key, *values])

now = datetime.utcnow()
def iso(offset_minutes=0):
    return (now - timedelta(minutes=-offset_minutes)).isoformat() + "Z"

mocks = [
    {
        "applicationId": "app-mock-001",
        "queueJobId": "queue-001",
        "userId": USER,
        "jobMeta": {
            "jobUrl": "https://ubc.wd10.myworkdayjobs.com/en-US/ubcstaffjobs/job/UBC-Vancouver-Campus---Vancouver-BC-Canada/Senior-Business-Analyst_JR24300",
            "jobTitle": "Senior Business Analyst",
            "company": "University of British Columbia",
        },
        "status": "completed",
        "steps": [
            {
                "stepName": "tailor_resume",
                "status": "completed",
                "startedAt": iso(-15),
                "completedAt": iso(-13),
                "durationMs": 8421,
                "costCents": 1.2,
                "artifactUrl": "r2://autoapply/tailored/app-mock-001/resume.json",
                "output": {"llmInputTokens": 6321, "llmOutputTokens": 1842, "tailoredSummary": "Senior BA with 8+ years across BI..."},
            },
            {
                "stepName": "open_ats",
                "status": "completed",
                "startedAt": iso(-13),
                "completedAt": iso(-12),
                "durationMs": 4210,
                "artifactUrl": "https://placehold.co/1280x800/e2e8f0/475569.png?text=UBC+JD+page",
                "output": {"pageTitle": "Senior Business Analyst", "finalUrl": "https://ubc.wd10.myworkdayjobs.com/...", "contentBytes": 124382},
            },
            {
                "stepName": "start_application",
                "status": "completed",
                "startedAt": iso(-12),
                "completedAt": iso(-11),
                "durationMs": 3120,
                "artifactUrl": "https://placehold.co/1280x800/dbeafe/1e40af.png?text=Apply+clicked+%E2%86%92+Choice+picker",
                "output": {"applySelector": "[data-automation-id='adventureButton']", "postApplyUrl": "...choice picker..."},
            },
            {
                "stepName": "detect_form_fields",
                "status": "completed",
                "startedAt": iso(-11),
                "completedAt": iso(-11),
                "durationMs": 1840,
                "output": {"fieldsDetected": 22, "wizardPagesEstimated": 7},
            },
            {
                "stepName": "fill_form",
                "status": "completed",
                "startedAt": iso(-11),
                "completedAt": iso(-10),
                "durationMs": 12300,
                "artifactUrl": "https://placehold.co/1280x800/d1fae5/065f46.png?text=Form+filled+%E2%80%94+page+1+of+7",
                "output": {"fieldsFilled": 18, "fieldsSkipped": 4, "wizardPage": "1 of 7"},
            },
            {
                "stepName": "pre_submit_screenshot",
                "status": "completed",
                "startedAt": iso(-10),
                "completedAt": iso(-10),
                "durationMs": 920,
                "artifactUrl": "https://placehold.co/1280x800/fef3c7/92400e.png?text=Pre-submit+%E2%80%94+ready+for+review",
            },
        ],
        "totalCostCents": 1.2,
        "totalDurationMs": 30811,
        "createdAt": iso(-15),
        "updatedAt": iso(-10),
        "qa": [
            {"label": "Years of SQL", "value": "8", "source": "profile"},
            {"label": "Years of Power BI", "value": "5", "source": "profile"},
            {"label": "Why are you interested in this role?", "value": "(see cover letter)", "source": "tailored"},
            {"label": "Salary expectations (CAD)", "value": "120000", "source": "profile"},
            {"label": "How did you hear about us?", "value": "?", "source": "human", "flagged": True},
        ],
    },
    {
        "applicationId": "app-mock-002",
        "queueJobId": "queue-002",
        "userId": USER,
        "jobMeta": {
            "jobUrl": "https://canadiantirecorporation.wd3.myworkdayjobs.com/en-US/Enterprise_External_Careers_Site/job/Senior-Business-Analyst_JR159715",
            "jobTitle": "Senior Business Analyst",
            "company": "Canadian Tire",
        },
        "status": "in_progress",
        "steps": [
            {
                "stepName": "tailor_resume",
                "status": "completed",
                "startedAt": iso(-3),
                "completedAt": iso(-2),
                "durationMs": 9120,
                "costCents": 1.4,
                "artifactUrl": "r2://autoapply/tailored/app-mock-002/resume.json",
                "output": {"llmInputTokens": 6210, "llmOutputTokens": 1990},
            },
            {
                "stepName": "open_ats",
                "status": "completed",
                "startedAt": iso(-2),
                "completedAt": iso(-2),
                "durationMs": 5210,
                "artifactUrl": "https://placehold.co/1280x800/e2e8f0/475569.png?text=Canadian+Tire+JD+page",
            },
            {
                "stepName": "start_application",
                "status": "running",
                "startedAt": iso(-1),
            },
        ],
        "totalCostCents": 1.4,
        "totalDurationMs": 14330,
        "createdAt": iso(-3),
        "updatedAt": iso(-1),
    },
    {
        "applicationId": "app-mock-003",
        "queueJobId": "queue-003",
        "userId": USER,
        "jobMeta": {
            "jobUrl": "https://langara.wd10.myworkdayjobs.com/en-US/External_Employment_Opportunities/job/Intermediate-Business-Analyst_JR-4189",
            "jobTitle": "Intermediate Business Analyst",
            "company": "Langara College",
        },
        "status": "failed",
        "steps": [
            {
                "stepName": "tailor_resume",
                "status": "completed",
                "startedAt": iso(-30),
                "completedAt": iso(-29),
                "durationMs": 7800,
                "costCents": 1.1,
                "output": {"llmInputTokens": 5800, "llmOutputTokens": 1620},
            },
            {
                "stepName": "open_ats",
                "status": "completed",
                "startedAt": iso(-29),
                "completedAt": iso(-29),
                "durationMs": 4900,
                "artifactUrl": "https://placehold.co/1280x800/e2e8f0/475569.png?text=Langara+JD+loaded",
            },
            {
                "stepName": "start_application",
                "status": "failed",
                "startedAt": iso(-28),
                "completedAt": iso(-28),
                "durationMs": 6420,
                "error": "After clicking Apply Manually, landed on Create Account form. Account creation flow not implemented in v1 (anon-apply tenant required). See WORKDAY_FEASIBILITY.md.",
                "artifactUrl": "https://placehold.co/1280x800/fee2e2/991b1b.png?text=Stopped+at+Create+Account+wall",
            },
        ],
        "totalCostCents": 1.1,
        "totalDurationMs": 19120,
        "createdAt": iso(-30),
        "updatedAt": iso(-28),
    },
]

# Wipe and rewrite
for m in mocks:
    set_json(f"audit:{m['applicationId']}", m)
    print(f"  [ok]wrote audit:{m['applicationId']} ({m['status']})")

# Replace user's applications list (delete then rebuild — newest first)
del_key(f"user:{USER}:applications")
ids = [m["applicationId"] for m in mocks]
# lpush takes args one at a time; final order is reverse of insertion. We want newest first → push oldest first.
for app_id in reversed(ids):
    lpush(f"user:{USER}:applications", [app_id])
print(f"  [ok]user:{USER}:applications = {ids[::-1]}")

print("\nSeeded 3 mock audit records. Visit /dashboard/applications when deployed.")
