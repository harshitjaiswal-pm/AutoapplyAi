# Run this from the autoapply-ai directory in PowerShell
# Usage: .\PUSH_NOW.ps1

Write-Host "Repairing git config..." -ForegroundColor Cyan

$gitConfig = @"
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
"@

Set-Content -Path ".git\config" -Value $gitConfig -Encoding UTF8
Write-Host "Git config restored" -ForegroundColor Green

git status

Write-Host "`nStaging all changes..." -ForegroundColor Cyan
git add -A

Write-Host "`nCommitting..." -ForegroundColor Cyan
git commit -m "feat: complete self-serve onboarding flow + extension bug fixes

Onboarding flow (web app):
- Landing page with clear CTA and feature overview
- 4-step wizard: Welcome / Extension / Resume upload / Profile form
- Resume upload with parse preview (name, jobs, skills count)
- Profile form pre-filled from Google auth + parsed resume
- Success screen with next steps to start applying
- Dashboard enhanced with profile/resume/history sections
- Extension profile-sync script (web app to chrome.storage)
- Middleware routes new users to onboarding

Extension fixes:
- Lever: navigate to /apply from detail page
- Lever/Generic: isSameJob requires title+company match
- Lever/Generic: clear stale PDF when different job detected
- Lever: fill Current location + Current company fields

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

Write-Host "`nPushing to GitHub..." -ForegroundColor Cyan
git push origin main

Write-Host "`nDone! Vercel will auto-deploy in ~2 minutes." -ForegroundColor Green
