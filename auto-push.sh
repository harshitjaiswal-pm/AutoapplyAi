#!/bin/bash
# =============================================================
# AutoApply AI — Auto Push Script
# Watches for changes and pushes to GitHub automatically
#
# Usage:   ./auto-push.sh          (checks every 5 minutes)
#          ./auto-push.sh 10       (checks every 10 minutes)
#
# To stop:  Press Ctrl+C in the terminal, or close the terminal
# =============================================================

INTERVAL=${1:-5}  # Default: check every 5 minutes
REPO_DIR="$HOME/Documents/AutoapplyAi"
BRANCH="main"

# Colors for terminal output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  AutoApply AI — Auto Push Running${NC}"
echo -e "${BLUE}  Checking every ${INTERVAL} minutes${NC}"
echo -e "${BLUE}  Press Ctrl+C to stop${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd "$REPO_DIR" || { echo -e "${RED}Error: Could not find $REPO_DIR${NC}"; exit 1; }

while true; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

    # Pull latest changes first (avoid conflicts)
    echo -e "${BLUE}[$TIMESTAMP]${NC} Pulling latest changes..."
    git pull origin "$BRANCH" --quiet 2>/dev/null

    # Check if there are any changes
    CHANGES=$(git status --porcelain 2>/dev/null)

    if [ -n "$CHANGES" ]; then
        # Count what changed
        ADDED=$(echo "$CHANGES" | grep "^??" | wc -l | tr -d ' ')
        MODIFIED=$(echo "$CHANGES" | grep "^ M\|^M" | wc -l | tr -d ' ')
        DELETED=$(echo "$CHANGES" | grep "^ D\|^D" | wc -l | tr -d ' ')

        # Build a smart commit message
        CHANGED_FILES=$(git status --porcelain | head -5 | awk '{print $2}' | xargs basename -a 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

        if [ "$ADDED" -gt 0 ] && [ "$MODIFIED" -eq 0 ]; then
            MSG="Add $CHANGED_FILES"
        elif [ "$MODIFIED" -gt 0 ] && [ "$ADDED" -eq 0 ]; then
            MSG="Update $CHANGED_FILES"
        else
            TOTAL=$((ADDED + MODIFIED + DELETED))
            MSG="Update ${TOTAL} files: $CHANGED_FILES"
        fi

        # Stage, commit, push
        git add -A
        git commit -m "$MSG" --quiet

        if git push origin "$BRANCH" --quiet 2>/dev/null; then
            echo -e "${GREEN}[$TIMESTAMP] ✓ Pushed: ${MSG}${NC}"
        else
            echo -e "${RED}[$TIMESTAMP] ✗ Push failed — will retry next cycle${NC}"
        fi
    else
        echo -e "${YELLOW}[$TIMESTAMP]${NC} No changes detected"
    fi

    # Wait for next check
    sleep $((INTERVAL * 60))
done
