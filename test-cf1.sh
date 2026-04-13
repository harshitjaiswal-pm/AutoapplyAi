#!/bin/bash
# AutoApply AI — CF1 API Test Suite (Cycle 1)
# Run: bash ~/Documents/AutoapplyAi/test-cf1.sh
# Requires: localhost:3000 running (npm run dev)

BASE="http://localhost:3000"
PASS=0
FAIL=0
LOG=~/Documents/AutoapplyAi/TEST_LOG.md

echo ""
echo "═══════════════════════════════════════════════"
echo " AutoApply AI — CF1 API Test Suite"
echo " $(date)"
echo "═══════════════════════════════════════════════"
echo ""

# ── Helper ──────────────────────────────────────────
pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL+1)); }
section() { echo ""; echo "── $1 ──────────────────────────────────────"; }

# ── Check server ────────────────────────────────────
section "PRE-FLIGHT: localhost:3000"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE" 2>/dev/null)
if [ "$STATUS" = "200" ]; then
  pass "localhost:3000 is up (HTTP $STATUS)"
else
  fail "localhost:3000 not responding (HTTP $STATUS) — run: npm run dev"
  echo ""
  echo "Cannot run tests without the dev server. Exiting."
  exit 1
fi

# ── Test 1A: parse-resume ────────────────────────────
section "CF1-1A: parse-resume"

RESUME_TEXT='Kiran Shahi
kiran.shahi@email.com | 604-555-1234 | linkedin.com/in/kiranshahi | Vancouver, BC
PROFESSIONAL EXPERIENCE
Business Analyst — NTT DATA North America | Jan 2023 – Present
- Led requirements gathering for 3 enterprise digital transformation projects
- Created BRDs, FRDs, and user stories in Jira for agile delivery teams
Junior Business Analyst — TELUS Digital | May 2021 – Dec 2022
- Supported UAT for a customer portal migration affecting 2M+ users
- Built Power BI dashboards tracking KPIs for 3 business units
EDUCATION
Bachelor of Commerce, Management Information Systems — Simon Fraser University, 2021
SKILLS
Requirements Elicitation, Agile/Scrum, Jira, Confluence, SQL, Power BI, Visio, Stakeholder Management'

PARSE_RESP=$(curl -s -X POST "$BASE/api/parse-resume" \
  -H "Content-Type: application/json" \
  -d "{\"resumeText\": $(echo "$RESUME_TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")

echo "  Response preview: ${PARSE_RESP:0:200}..."

# Check name
echo "$PARSE_RESP" | python3 -c "
import json, sys
try:
    r = json.loads(sys.stdin.read())
    pr = r.get('parsedResume', {})
    name = pr.get('contactInfo', {}).get('name', '')
    email = pr.get('contactInfo', {}).get('email', '')
    exp = pr.get('experience', [])
    edu = pr.get('education', [])
    skills = pr.get('skills', {})
    skill_count = sum(len(v) for v in skills.values()) if isinstance(skills, dict) else len(skills) if isinstance(skills, list) else 0

    checks = [
        ('name contains Kiran', 'Kiran' in name),
        ('email is kiran.shahi@email.com', 'kiran.shahi@email.com' in email),
        ('2 experience entries', len(exp) == 2),
        ('1 education entry', len(edu) == 1),
        ('8+ skills', skill_count >= 8),
        ('no hallucinated NTT DATA', any('NTT' in (e.get('company','') + e.get('role','')) for e in exp)),
        ('no hallucinated employer', not any(c in str(pr) for c in ['Google','Amazon','Microsoft','Apple','Meta'])),
    ]
    for label, result in checks:
        print(f'  {\"PASS\" if result else \"FAIL\"}: {label}')
except Exception as e:
    print(f'  ERROR: {e}')
" | while read line; do
  if echo "$line" | grep -q "^  PASS"; then
    echo "  ✅${line:6}"
    PASS=$((PASS+1))
  elif echo "$line" | grep -q "^  FAIL"; then
    echo "  ❌${line:6}"
    FAIL=$((FAIL+1))
  else
    echo "$line"
  fi
done

# Store parsedResume for next test
echo "$PARSE_RESP" | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print(json.dumps(r.get('parsedResume', {})))" > /tmp/aa_parsed_resume.json 2>/dev/null

# ── Test 1B: analyze-job ─────────────────────────────
section "CF1-1B: analyze-job"

JD_TEXT='Business Analyst — TELUS Health | Vancouver, BC
TELUS Health is looking for a Business Analyst to join our Digital Health team.
Responsibilities:
- Gather and document business and functional requirements
- Create user stories and acceptance criteria in Jira
- Perform data analysis using SQL to support product decisions
- Build dashboards in Tableau or Power BI for stakeholder reporting
Requirements:
- 2+ years experience as a Business Analyst
- Experience with Agile/Scrum methodology
- Strong SQL skills
- Excellent communication and stakeholder management
Nice to have: Confluence, Figma, virtual care, digital health'

JOB_RESP=$(curl -s -X POST "$BASE/api/analyze-job" \
  -H "Content-Type: application/json" \
  -d "{\"jobDescription\": $(echo "$JD_TEXT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")

echo "  Response preview: ${JOB_RESP:0:200}..."

echo "$JOB_RESP" | python3 -c "
import json, sys
try:
    r = json.loads(sys.stdin.read())
    pj = r.get('parsedJob', {})
    title = str(pj.get('title', pj.get('jobTitle', ''))).lower()
    company = str(pj.get('company', '')).lower()
    all_text = json.dumps(pj).lower()
    required_kw = ['sql','agile','jira','stakeholder','power bi','tableau','virtual care','digital health','acceptance criteria']
    found_kw = [kw for kw in required_kw if kw in all_text]

    checks = [
        ('title contains business analyst', 'business analyst' in title),
        ('company contains telus', 'telus' in company),
        ('keyword overlap >=7/9', len(found_kw) >= 7),
        ('no hallucinated requirements', 'kubernetes' not in all_text and 'machine learning' not in all_text),
    ]
    print(f'  Keywords found: {found_kw}')
    for label, result in checks:
        print(f'  {\"PASS\" if result else \"FAIL\"}: {label}')
except Exception as e:
    print(f'  ERROR: {e}')
" | while read line; do
  if echo "$line" | grep -q "^  PASS"; then
    echo "  ✅${line:6}"
    PASS=$((PASS+1))
  elif echo "$line" | grep -q "^  FAIL"; then
    echo "  ❌${line:6}"
    FAIL=$((FAIL+1))
  else
    echo "$line"
  fi
done

echo "$JOB_RESP" | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); print(json.dumps(r.get('parsedJob', {})))" > /tmp/aa_parsed_job.json 2>/dev/null

# ── Test 1C: tailor-resume ───────────────────────────
section "CF1-1C: tailor-resume (this takes ~15-30s)"

PARSED_RESUME=$(cat /tmp/aa_parsed_resume.json 2>/dev/null || echo '{}')
PARSED_JOB=$(cat /tmp/aa_parsed_job.json 2>/dev/null || echo '{}')

TAILOR_RESP=$(curl -s -m 120 -X POST "$BASE/api/tailor-resume" \
  -H "Content-Type: application/json" \
  -d "{\"parsedResume\": $PARSED_RESUME, \"parsedJob\": $PARSED_JOB, \"mode\": \"fast\"}")

echo "  Response preview: ${TAILOR_RESP:0:300}..."

echo "$TAILOR_RESP" | python3 -c "
import json, sys
try:
    r = json.loads(sys.stdin.read())
    tr = r.get('tailoredResult', {})
    all_text = json.dumps(tr).lower()

    name = str(tr.get('contactInfo', {}).get('name', '')).lower()
    email = str(tr.get('contactInfo', {}).get('email', ''))
    exp = tr.get('experience', [])
    edu = tr.get('education', [])

    jd_kws = ['sql','agile','jira','stakeholder','power bi','tableau','virtual care','digital health','acceptance criteria','scrum','confluence']
    found = [kw for kw in jd_kws if kw in all_text]
    overlap_pct = len(found) / len(jd_kws)

    # hallucination checks
    invented_employers = ['google','amazon','microsoft','apple','meta','shopify']
    hallucinated = [c for c in invented_employers if c in all_text and c not in 'ntt data telus digital simon fraser']

    checks = [
        ('contact name preserved (kiran)', 'kiran' in name),
        ('email preserved', 'kiran.shahi@email.com' in email),
        ('2 experience entries preserved', len(exp) == 2),
        ('education preserved', len(edu) >= 1),
        ('keyword overlap >=7/11', len(found) >= 7),
        ('no hallucinated employers', len(hallucinated) == 0),
        ('NTT DATA preserved', any('ntt' in (e.get('company','')+'').lower() for e in exp)),
        ('TELUS Digital preserved', any('telus' in (e.get('company','')+'').lower() for e in exp)),
    ]
    print(f'  Keywords found ({len(found)}/{len(jd_kws)}): {found}')
    if hallucinated:
        print(f'  ⚠️  Hallucinated employers: {hallucinated}')
    for label, result in checks:
        print(f'  {\"PASS\" if result else \"FAIL\"}: {label}')
except Exception as e:
    print(f'  ERROR: {e}')
    print(f'  Raw response: {sys.stdin.read()[:300] if hasattr(sys.stdin, \"read\") else \"\"}')
" | while read line; do
  if echo "$line" | grep -q "^  PASS"; then
    echo "  ✅${line:6}"
    PASS=$((PASS+1))
  elif echo "$line" | grep -q "^  FAIL"; then
    echo "  ❌${line:6}"
    FAIL=$((FAIL+1))
  else
    echo "$line"
  fi
done

# ── Summary ──────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo " RESULTS: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════"
echo ""

# Append to TEST_LOG.md
cat >> "$LOG" << LOGEOF

## Cycle 1 — CF1 API Tests — $(date)
CF1-1A parse-resume: See terminal output above
CF1-1B analyze-job: See terminal output above
CF1-1C tailor-resume: See terminal output above
Results: $PASS passed / $FAIL failed
LOGEOF
