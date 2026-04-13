#!/bin/bash
# One-shot commit + push for ALL pending fixes — self-destructs after running
cd ~/Documents/AutoapplyAi
[ -f .git/index.lock ] && rm .git/index.lock
[ -f .git/HEAD.lock  ] && rm .git/HEAD.lock

git add chrome-extension/background.js \
  chrome-extension/content.js \
  src/app/api/analyze-job/route.ts \
  src/app/api/parse-resume/route.ts \
  src/app/api/tailor-resume/route.ts \
  src/lib/prompts.ts

git commit -m "Fix 6 bugs: wrong-resume guard, SACRED rule, schema validation, user-facing banner

- background.js: resumeKey in entryPayload; pass callerTabId to handleDownloadResume;
  send SHOW_BANNER to panel when download blocked (no more silent failure)
- content.js: Add chrome.runtime.onMessage listener; render SHOW_BANNER from background
  as a dismissible amber/red/green banner at top of panel (auto-dismisses in 8s)
- prompts.ts: Add name/email/phone to SACRED rule and MUST NEVER DO list
- parse-resume: 20-word minimum check, schema guard, 30s timeout
- analyze-job: Schema guard (requires title/skills/requirements), 30s timeout
- tailor-resume: Pre-parse JSON check, schema guard, 90s timeout"

git push https://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@github.com/harshitjaiswal-pm/AutoapplyAi.git main

echo ""
echo "✅ Pushed. Reload extension at chrome://extensions, then run:"
echo "   bash ~/Documents/AutoapplyAi/test-cf1.sh"
rm -- "$0"
