#!/bin/bash
# Run this from the autoapply-ai directory to push all onboarding changes to GitHub
# Usage: bash PUSH_NOW.sh

set -e

echo "🔧 Repairing git config..."
cat > .git/config << 'GITCONFIG'
[core]
	repositoryformatversion = 0
	filemode = false
	bare = false
	logallrefupdates = true
[remote "origin"]
	url = https://github.com/harshitschulich-boop/AutoapplyAi.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
	merge = refs/heads/main
GITCONFIG

echo "✅ Git config restored"

git status

echo ""
echo "📦 Staging all changes..."
git add -A

echo ""
echo "💬 Committing..."
git commit -m "feat: complete self-serve onboarding flow + extension bug fixes

Onboarding flow (web app):
- Landing page with clear CTA and feature overview
- 4-step wizard: Welcome / Extension / Resume upload / Profile form
- Resume upload with parse preview (name, jobs, skills count)
- Profile form pre-filled from Google auth + parsed resume
- Success screen with next steps to start applying
- Dashboard enhanced with profile/resume/history sections
- Extension profile-sync script (web app → chrome.storage)
- Middleware routes new users to onboarding

Extension fixes:
- Lever: navigate to /apply from detail page (not init() in place)
- Lever/Generic: isSameJob requires title+company match (not title alone)
- Lever/Generic: clear stale PDF when different job detected
- Lever: fill Current location + Current company in fillBasicFieldsOnly

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

echo ""
echo "🚀 Pushing to GitHub..."
git push origin main

echo ""
echo "✅ Done! Vercel will auto-deploy in ~2 minutes."
echo "🌐 Check deployment at: https://vercel.com/dashboard"
