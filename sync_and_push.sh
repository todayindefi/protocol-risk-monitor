#!/bin/bash
cd /home/danger/protocol-risk-monitor

# Sync protocol-topology snapshots from LendingMarketTracker
# fluid — analyzer fires hourly at :42; run this on :44 or on-demand
cp /home/danger/LendingMarketTracker/data/fluid_snapshot.json data/ 2>/dev/null

# Commit and push if changed
git add data/
if ! git diff --cached --quiet; then
    git commit -m "Update snapshots $(date +'%Y-%m-%d %H:%M')"
    git push
    echo "$(date): Pushed updated snapshots"
else
    echo "$(date): No changes to push"
fi
