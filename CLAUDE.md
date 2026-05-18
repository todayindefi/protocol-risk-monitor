# protocol-risk-monitor

Static HTML dashboards for protocol-topology risk monitoring. Sibling to
backing-monitor (asset-backing dashboards) — separate repos by domain per
the analyzer-side split (PegTracker = asset / LMT = protocol).

## Architecture
- `index.html` — page shell, route resolution via `?protocol=<name>`
- `js/app.js` — common scaffolding (theme, refresh, JSON fetch, routing)
- `js/renderers/<protocol>.js` — per-protocol renderer module
- `css/styles.css` — shared styles
- `data/` — synced JSON snapshots from analyzers in sibling repos
- `sync_and_push.sh` — pulls data from analyzer repos, commits, pushes to deploy

## Current protocols
- fluid — analyzer at `~/LendingMarketTracker/src/risk/fluid_risk_analyzer.py`
  (commits 7817bc8 / 980f93d / 0a03545; hourly cron at :42). Renderer
  implementation pending (Chunks A + B of the handoff at
  `~/riskAnalyst/specs/handoffs/fluid-layer2-renderer-protocol-risk-monitor.md`).

## Future protocols
Each new protocol gets a renderer file under `js/renderers/` + a data-sync
entry in `sync_and_push.sh` + a route in `js/app.js`. Don't fork or
restructure; extend in place.

## Hosting
GitHub Pages, mirroring backing-monitor. `.github/workflows/deploy.yml`
deploys the repo root on every push to `main`. Live URL:
`https://todayindefi.github.io/protocol-risk-monitor/`.

## Data sync
`sync_and_push.sh` does a local `cp` from `~/LendingMarketTracker/data/` into
`./data/`, commits the result, pushes to origin. Triggered on a cron offset
from the analyzer's hourly run (analyzer fires at `:42`; sync at `:44` or
on-demand). NOT a symlink — the JSON must ship with the repo to be served
statically by Pages.

## Companion analyzer / handoff sources
- Analyzer: `~/LendingMarketTracker/src/risk/`
- Handoff source / design plans: `~/riskAnalyst/specs/`
  - Layout + thresholds: `~/riskAnalyst/specs/fluid-risk-dashboard-plan.md`
  - Renderer scope: `~/riskAnalyst/specs/handoffs/fluid-layer2-renderer-protocol-risk-monitor.md`
- Tech-stack analog: `~/backing-monitor/` (static HTML + Tailwind CDN +
  Chart.js CDN, no build step, 5-min auto-refresh via `setInterval`)
