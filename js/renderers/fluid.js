/**
 * Fluid renderer — consumes data/fluid_snapshot.json written by
 * ~/LendingMarketTracker/src/risk/fluid_risk_analyzer.py.
 *
 * Implements Chunks A + B of the layer-2 handoff:
 *   ~/riskAnalyst/specs/handoffs/fluid-layer2-renderer-protocol-risk-monitor.md
 */

var FluidRenderer = (function () {

    var TICK_BASE = 1.0015;            // Fluid tick base (debt/coll ratio compounding)
    var DANGER_PP_FROM_LIQ = 5.0;      // a tick is "danger zone" if ratio is within 5pp of liq threshold
    var WARN_PP_FROM_LIQ = 10.0;       // amber band 5–10pp from liq
    var DANGER_HEADLINE_USD = 5_000_000;
    var TOP_N_TICK_VAULTS = 8;
    var TOP_N_STACKED_COLS = 6;
    var STACK_PALETTE = [
        '#2563eb', '#06b6d4', '#10b981', '#f59e0b', '#ef4444',
        '#a855f7', '#ec4899', '#84cc16', '#6366f1', '#14b8a6'
    ];
    var OTHER_COLOR = '#94a3b8';

    // ---------- formatting helpers ----------

    function fmtUSD(n) {
        if (n == null || isNaN(n)) return '—';
        var abs = Math.abs(n);
        if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
        if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
        return '$' + n.toFixed(0);
    }

    function fmtPct(n, digits) {
        if (n == null || isNaN(n)) return '—';
        return n.toFixed(digits != null ? digits : 1) + '%';
    }

    function fmtShare(share, digits) {
        if (share == null || isNaN(share)) return '—';
        return (share * 100).toFixed(digits != null ? digits : 1) + '%';
    }

    function fmtTimestamp(iso) {
        if (!iso) return '';
        try {
            var d = new Date(iso);
            return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace('Z', ' UTC');
        } catch (e) {
            return iso;
        }
    }

    function shortAddr(addr) {
        if (!addr || addr.length < 12) return addr || '';
        return addr.slice(0, 6) + '…' + addr.slice(-4);
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ---------- buffer math ----------

    // Buffer to liquidation (in %) given current top_tick and estimated liq_tick.
    // Each tick = TICK_BASE; buffer = (TICK_BASE^(liq-top) - 1) * 100.
    // Returns null if either tick is missing.
    function bufferPctFromTicks(topTick, liqTick) {
        if (topTick == null || liqTick == null) return null;
        var raw = Math.pow(TICK_BASE, liqTick - topTick) - 1;
        return raw * 100;
    }

    function tickBarSeverity(ratioPct, liqThresholdPct) {
        if (ratioPct == null || liqThresholdPct == null) return 'ok';
        var distance = liqThresholdPct - ratioPct;  // pp below liq threshold
        if (distance <= DANGER_PP_FROM_LIQ) return 'danger';
        if (distance <= WARN_PP_FROM_LIQ) return 'warn';
        return 'ok';
    }

    // ---------- main entry ----------

    function render(snapshot) {
        renderTopline(snapshot);
        renderHeadlineAlerts(snapshot);
        renderSystemicVaults(snapshot);
        renderLenderPoolExposure(snapshot);
        renderUtilizationTable(snapshot);
        renderTickDensity(snapshot);
        renderSmartPools(snapshot);
        renderGovernance(snapshot);
        renderContext(snapshot);

        // Header timestamp
        document.getElementById('header-subtitle').textContent = 'Fluid';
        document.getElementById('header-timestamp').textContent =
            'Updated: ' + fmtTimestamp(snapshot.generated_at);
    }

    // ---------- Topline ----------

    function renderTopline(snapshot) {
        var t = snapshot.tier_c.totals;
        document.getElementById('topline-title').textContent = 'Fluid Risk Monitor';

        var dedup = snapshot.dedup_check && snapshot.dedup_check.ok
            ? '<span class="text-ok">dedup ok</span>'
            : '<span class="text-danger">dedup FAILED</span>';

        document.getElementById('topline-subtitle').innerHTML =
            'Layers 1 + 1.5 LIVE · ' +
            fmtUSD(t.collateral_usd) + ' coll · ' +
            fmtUSD(t.debt_usd) + ' debt · ' +
            fmtPct(t.utilization_pct) + ' util · ' +
            dedup;
    }

    // ---------- Headline alerts ----------

    function renderHeadlineAlerts(snapshot) {
        var alerts = [];

        // Rule 1: vaults with danger_zone_debt_usd > $5M
        Object.entries(snapshot.tier_c.tick_density).forEach(function (entry) {
            var td = entry[1];
            var dz = td.danger_zone_debt_usd;
            if (dz != null && dz > DANGER_HEADLINE_USD) {
                var buffer = bufferPctFromTicks(td.top_tick, td.liquidation_tick_estimated);
                var bufStr = buffer != null ? ' · buffer ' + buffer.toFixed(1) + '%' : '';
                alerts.push({
                    sev: 'red',
                    title: 'Vault ' + td.vault_id + ' danger zone',
                    detail: fmtUSD(dz) + ' within ' + DANGER_PP_FROM_LIQ +
                        '% of liquidation' + bufStr +
                        ' · ' + fmtShare(td.danger_zone_share_of_vault_debt) +
                        ' of vault debt'
                });
            }
        });

        // Rule 2: utilization >= warn / page
        snapshot.tier_c.liquidity_layer_utilization.forEach(function (u) {
            if (u.status === 'page') {
                alerts.push({
                    sev: 'red',
                    title: u.asset_symbol + ' util ' + fmtPct(u.utilization_pct, 2),
                    detail: 'Near max — withdrawal headroom thin'
                });
            } else if (u.status === 'warn') {
                alerts.push({
                    sev: 'yellow',
                    title: u.asset_symbol + ' util ' + fmtPct(u.utilization_pct, 2),
                    detail: 'Above warn threshold'
                });
            }
        });

        // Rule 3: lender_pool_concentrations entries (analyzer already filters)
        snapshot.tier_c.lender_pool_concentrations.forEach(function (c) {
            alerts.push({
                sev: 'yellow',
                title: c.collateral_asset + ' = ' + fmtShare(c.share, 0) +
                    ' of ' + c.debt_asset + ' pool',
                detail: fmtUSD(c.usd) + ' concentration'
            });
        });

        // Rule 4: dedup check
        if (!(snapshot.dedup_check && snapshot.dedup_check.ok)) {
            alerts.unshift({
                sev: 'red',
                title: 'Dedup sanity check failed',
                detail: (snapshot.dedup_check && snapshot.dedup_check.warnings || []).join('; ')
                    || 'No warnings emitted'
            });
        }

        // Sort red first
        alerts.sort(function (a, b) {
            if (a.sev === b.sev) return 0;
            return a.sev === 'red' ? -1 : 1;
        });

        var container = document.getElementById('headline-alerts');
        if (alerts.length === 0) {
            container.innerHTML = '<div class="alert-card alert-muted col-span-full">No active headline alerts.</div>';
            return;
        }
        container.innerHTML = alerts.map(function (a) {
            return '<div class="alert-card alert-' + a.sev + '">' +
                '<div class="alert-title">' + escapeHtml(a.title) + '</div>' +
                '<div class="alert-detail">' + escapeHtml(a.detail) + '</div>' +
                '</div>';
        }).join('');
    }

    // ---------- Systemic Vaults ----------

    function tickEntryForVaultId(snapshot, vaultId) {
        var found = null;
        Object.values(snapshot.tier_c.tick_density).some(function (td) {
            if (td.vault_id === vaultId) { found = td; return true; }
            return false;
        });
        return found;
    }

    function renderSystemicVaults(snapshot) {
        var vaults = snapshot.tier_c.systemic_vaults;
        var container = document.getElementById('systemic-vaults');
        if (!vaults || vaults.length === 0) {
            container.innerHTML = '<div class="text-muted text-sm">No systemic vaults (no single vault ≥10% of system debt).</div>';
            return;
        }

        container.innerHTML = vaults.map(function (v) {
            var td = tickEntryForVaultId(snapshot, v.id);
            var buffer = td ? bufferPctFromTicks(td.top_tick, td.liquidation_tick_estimated) : null;
            var bufferLine = buffer != null
                ? '<div class="kv-row"><span class="kv-key">Buffer to liq</span><span class="kv-val">' + buffer.toFixed(2) + '%</span></div>'
                : '';
            var dzLine = td && td.danger_zone_debt_usd != null && td.danger_zone_debt_usd > 0
                ? '<div class="kv-row"><span class="kv-key">Danger-zone debt</span><span class="kv-val text-danger">' + fmtUSD(td.danger_zone_debt_usd) + '</span></div>'
                : '';

            var smartFlags = [];
            if (v.is_smart_supply) smartFlags.push('smart-supply');
            if (v.is_smart_borrow) smartFlags.push('smart-borrow');
            var smart = smartFlags.length ? ' <span class="pill pill-blue">' + smartFlags.join(' · ') + '</span>' : '';

            return '<div class="card">' +
                '<div class="card-title">Vault ' + v.id + ': ' + escapeHtml(v.coll_label) + ' → ' + escapeHtml(v.debt_label) + smart + '</div>' +
                '<div class="card-subtitle">' + fmtShare(v.share_of_system_debt, 1) + ' of system debt · ' + (v.positions || '0') + ' positions</div>' +
                '<div class="kv-row"><span class="kv-key">Borrow</span><span class="kv-val">' + fmtUSD(v.borrow_usd) + '</span></div>' +
                '<div class="kv-row"><span class="kv-key">Supply</span><span class="kv-val">' + fmtUSD(v.supply_usd) + '</span></div>' +
                '<div class="kv-row"><span class="kv-key">LTV / liq thr</span><span class="kv-val">' + fmtPct(v.ltv) + ' / ' + fmtPct(v.liq_threshold) + '</span></div>' +
                bufferLine +
                dzLine +
                '<div class="kv-row"><span class="kv-key">Address</span><span class="kv-val mono">' + shortAddr(v.address) + '</span></div>' +
                '</div>';
        }).join('');
    }

    // ---------- Lender Pool Exposure ----------

    function renderLenderPoolExposure(snapshot) {
        var pools = snapshot.tier_c.debt_pool_sizes;
        var attr = snapshot.tier_c.lender_pool_attribution;
        var container = document.getElementById('lender-pool-exposure');

        container.innerHTML = pools.map(function (p) {
            var mix = attr[p.asset] || {};
            // Convert into [{coll, usd}] sorted desc
            var entries = Object.entries(mix).map(function (kv) {
                return { coll: kv[0], usd: kv[1] };
            }).filter(function (e) {
                return e.usd > 0;
            }).sort(function (a, b) { return b.usd - a.usd; });

            // Top N + other
            var top = entries.slice(0, TOP_N_STACKED_COLS);
            var rest = entries.slice(TOP_N_STACKED_COLS);
            var restUsd = rest.reduce(function (s, e) { return s + e.usd; }, 0);
            var total = top.reduce(function (s, e) { return s + e.usd; }, 0) + restUsd;
            if (total <= 0) total = 1;

            var segs = '';
            var legend = '';
            top.forEach(function (e, i) {
                var pct = (e.usd / total) * 100;
                var color = STACK_PALETTE[i % STACK_PALETTE.length];
                var label = pct >= 6 ? (e.coll + ' ' + pct.toFixed(0) + '%') : '';
                segs += '<div class="stacked-bar-seg" style="width:' + pct.toFixed(2) +
                    '%; background:' + color + ';" title="' + escapeHtml(e.coll) + ' ' + fmtUSD(e.usd) + ' (' + pct.toFixed(1) + '%)">' +
                    escapeHtml(label) + '</div>';
                legend += '<span><span class="legend-dot" style="background:' + color + '"></span>' +
                    escapeHtml(e.coll) + ' ' + fmtUSD(e.usd) + ' (' + pct.toFixed(1) + '%)</span>';
            });
            if (restUsd > 0) {
                var pctOther = (restUsd / total) * 100;
                segs += '<div class="stacked-bar-seg" style="width:' + pctOther.toFixed(2) +
                    '%; background:' + OTHER_COLOR + ';" title="Other ' + fmtUSD(restUsd) + ' (' + pctOther.toFixed(1) + '%)">' +
                    (pctOther >= 6 ? 'Other ' + pctOther.toFixed(0) + '%' : '') + '</div>';
                legend += '<span><span class="legend-dot" style="background:' + OTHER_COLOR + '"></span>Other ' +
                    fmtUSD(restUsd) + ' (' + pctOther.toFixed(1) + '%)</span>';
            }

            return '<div class="panel">' +
                '<div class="flex justify-between items-baseline mb-2">' +
                    '<div><span class="font-semibold">' + escapeHtml(p.asset) + '</span> ' +
                        '<span class="text-muted text-sm">debt pool · ' + fmtUSD(p.usd) + ' (' + fmtShare(p.share) + ' of system)</span></div>' +
                '</div>' +
                '<div class="stacked-bar">' + segs + '</div>' +
                '<div class="stacked-bar-legend">' + legend + '</div>' +
                '</div>';
        }).join('');
    }

    // ---------- Liquidity Layer Utilization ----------

    function statusPill(status) {
        if (status === 'page') return '<span class="pill pill-red">page</span>';
        if (status === 'warn') return '<span class="pill pill-yellow">warn</span>';
        return '<span class="pill pill-green">ok</span>';
    }

    function renderUtilizationTable(snapshot) {
        var rows = snapshot.tier_c.liquidity_layer_utilization
            .slice()
            .sort(function (a, b) { return (b.utilization_pct || 0) - (a.utilization_pct || 0); });

        var tbody = document.querySelector('#util-table tbody');
        tbody.innerHTML = rows.map(function (u) {
            return '<tr>' +
                '<td>' + escapeHtml(u.asset_symbol) + '</td>' +
                '<td class="text-right num">' + fmtPct(u.utilization_pct, 2) + '</td>' +
                '<td class="text-right num">' + fmtPct(u.max_utilization_pct, 0) + '</td>' +
                '<td class="text-right num">' + fmtUSD(u.total_supply_usd) + '</td>' +
                '<td class="text-right num">' + fmtUSD(u.total_borrow_usd) + '</td>' +
                '<td class="text-right num">' + fmtPct(u.borrow_apr_pct, 2) + '</td>' +
                '<td class="text-right num">' + fmtPct(u.supply_apr_pct, 2) + '</td>' +
                '<td>' + statusPill(u.status) + '</td>' +
                '</tr>';
        }).join('');
    }

    // ---------- Tick Density ----------

    function renderTickDensity(snapshot) {
        // Rank by danger_zone_debt_usd desc, then by vault_debt_usd_in_window desc.
        var entries = Object.entries(snapshot.tier_c.tick_density)
            .map(function (kv) {
                var td = kv[1];
                return {
                    addr: kv[0],
                    td: td,
                    score: (td.danger_zone_debt_usd || 0) * 1000 + (td.vault_debt_usd_in_window || 0)
                };
            })
            .filter(function (e) {
                // Require some debt to render
                return (e.td.vault_debt_usd_in_window || 0) > 0;
            })
            .sort(function (a, b) { return b.score - a.score; })
            .slice(0, TOP_N_TICK_VAULTS);

        var container = document.getElementById('tick-density');
        if (!entries.length) {
            container.innerHTML = '<div class="text-muted text-sm">No tick-density data.</div>';
            return;
        }

        container.innerHTML = entries.map(function (e) {
            var td = e.td;
            var ticks = td.ticks || [];
            // sort by tick ascending (so leftmost = lowest tick = furthest from top)
            ticks = ticks.slice().sort(function (a, b) { return a.tick - b.tick; });

            var maxDebt = ticks.reduce(function (m, t) { return Math.max(m, t.debt_normal_usd || 0); }, 0) || 1;

            var bars = ticks.map(function (t) {
                var sev = tickBarSeverity(t.ratio_pct, td.liquidation_threshold_pct);
                var h = ((t.debt_normal_usd || 0) / maxDebt) * 100;
                var minH = (t.debt_normal_usd || 0) > 0 ? 4 : 0;
                var styleH = Math.max(h, minH);
                var title = 'tick ' + t.tick +
                    ' · ratio ' + fmtPct(t.ratio_pct, 2) +
                    ' · debt ' + fmtUSD(t.debt_normal_usd) +
                    ' · ' + fmtPct(t.distance_pct_from_top, 2) + ' from top';
                return '<div class="tick-bar ' + sev + '" style="height:' + styleH.toFixed(1) + '%" title="' + escapeHtml(title) + '"></div>';
            }).join('');

            var buffer = bufferPctFromTicks(td.top_tick, td.liquidation_tick_estimated);
            var bufStr = buffer != null ? buffer.toFixed(2) + '%' : '—';
            var dz = td.danger_zone_debt_usd || 0;
            var dzShare = td.danger_zone_share_of_vault_debt;

            return '<div class="panel">' +
                '<div class="flex justify-between items-baseline mb-1">' +
                    '<div class="font-semibold">Vault ' + td.vault_id + '</div>' +
                    '<div class="text-xs text-muted">buffer ' + bufStr +
                        ' · top tick ' + (td.top_tick != null ? td.top_tick : '—') +
                        ' · liq ' + (td.liquidation_tick_estimated != null ? td.liquidation_tick_estimated : '—') +
                    '</div>' +
                '</div>' +
                '<div class="tick-chart">' + bars + '</div>' +
                '<div class="flex justify-between text-xs text-muted mt-2">' +
                    '<div>Debt in window: ' + fmtUSD(td.vault_debt_usd_in_window) + '</div>' +
                    '<div>' + (dz > 0
                        ? '<span class="text-danger">Danger zone: ' + fmtUSD(dz) + (dzShare != null ? ' (' + fmtShare(dzShare) + ')' : '') + '</span>'
                        : '<span class="text-ok">No debt in danger zone</span>') + '</div>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    // ---------- Smart Pools ----------

    function renderSmartPool(pool, kind) {
        var usd = kind === 'borrow' ? pool.borrow_usd : pool.supply_usd;
        var legs = kind === 'borrow' ? (pool.borrow_legs || []) : (pool.supply_legs || []);
        var vaultIds = (pool.contributing_vault_ids || []).join(', ');

        var legsLine = legs.map(function (l) {
            return escapeHtml(l.sym) + ' ' + fmtUSD(l.usd);
        }).join(' · ');

        return '<div class="panel">' +
            '<div class="flex justify-between items-baseline">' +
                '<div class="font-semibold">' + escapeHtml(pool.label) + '</div>' +
                '<div class="text-sm text-muted num">' + fmtUSD(usd) + '</div>' +
            '</div>' +
            '<div class="text-xs text-muted mt-1">' +
                (pool.contributing_vault_ids || []).length + ' vault' +
                ((pool.contributing_vault_ids || []).length === 1 ? '' : 's') +
                (vaultIds ? ' (' + vaultIds + ')' : '') +
            '</div>' +
            (legsLine ? '<div class="text-xs mt-1">' + legsLine + '</div>' : '') +
            '<div class="text-xs mono text-dim mt-1">' + shortAddr(pool.dex_addr) + '</div>' +
            '</div>';
    }

    function renderSmartPools(snapshot) {
        var borrow = (snapshot.tier_c.smart_borrow_pools || []).slice()
            .sort(function (a, b) { return (b.borrow_usd || 0) - (a.borrow_usd || 0); });
        var supply = (snapshot.tier_c.smart_supply_pools || []).slice()
            .sort(function (a, b) { return (b.supply_usd || 0) - (a.supply_usd || 0); });

        document.getElementById('smart-borrow-pools').innerHTML = borrow.length
            ? borrow.map(function (p) { return renderSmartPool(p, 'borrow'); }).join('')
            : '<div class="text-muted text-sm">No smart-borrow pools.</div>';

        document.getElementById('smart-supply-pools').innerHTML = supply.length
            ? supply.map(function (p) { return renderSmartPool(p, 'supply'); }).join('')
            : '<div class="text-muted text-sm">No smart-collateral pools.</div>';
    }

    // ---------- Governance (Tier B stub) ----------

    function renderGovernance(snapshot) {
        var tb = snapshot.tier_b || {};
        var addrs = tb.addresses_to_watch || {};
        var labels = {
            governor_bravo: 'GovernorBravo',
            compound_timelock: 'Compound Timelock',
            vault_factory_owner: 'VaultFactoryOwner',
            team_multisig_avocado: 'Team Multisig (Avocado)'
        };

        var addrList = Object.keys(addrs).map(function (k) {
            return '<div class="kv-row"><span class="kv-key">' + escapeHtml(labels[k] || k) + '</span>' +
                '<span class="kv-val mono">' + escapeHtml(addrs[k]) + '</span></div>';
        }).join('');

        var notesBlock = '';
        if (tb.notes && tb.notes.length) {
            notesBlock = '<div class="mt-3 text-xs text-muted">' +
                tb.notes.map(function (n) { return '• ' + escapeHtml(n); }).join('<br>') +
                '</div>';
        }

        document.getElementById('governance').innerHTML =
            '<div class="text-sm text-muted mb-2">' +
                'Status: ' + escapeHtml(tb.status || 'unknown') + ' · ' +
                'event filters pending — see ' +
                '<span class="mono">~/riskAnalyst/specs/fluid-risk-dashboard-plan.md</span> §9' +
            '</div>' +
            addrList +
            notesBlock;
    }

    // ---------- Context (Tier D) ----------

    function renderContext(snapshot) {
        var td = snapshot.tier_d || {};
        var tvl = td.tvl_by_chain || {};

        var chainRows = Object.keys(tvl).map(function (chain) {
            var c = tvl[chain];
            return '<tr>' +
                '<td>' + escapeHtml(chain) + '</td>' +
                '<td class="text-right num">' + fmtUSD(c.collateral_usd) + '</td>' +
                '<td class="text-right num">' + fmtUSD(c.debt_usd) + '</td>' +
                '<td class="text-right num">' + (c.n_vaults != null ? c.n_vaults : '—') + '</td>' +
                '</tr>';
        }).join('');

        var dedupBlurb = snapshot.dedup_check && snapshot.dedup_check.ok
            ? '<span class="text-ok">ok</span>'
            : '<span class="text-danger">FAILED: ' +
                escapeHtml(((snapshot.dedup_check || {}).warnings || []).join('; ')) + '</span>';

        document.getElementById('context').innerHTML =
            '<table class="data-table mb-3"><thead><tr><th>Chain</th><th class="text-right">Collateral</th>' +
                '<th class="text-right">Debt</th><th class="text-right">Vaults</th></tr></thead>' +
                '<tbody>' + chainRows + '</tbody></table>' +
            '<div class="text-xs text-muted">' +
                'Layer status: 1 + 1.5 LIVE · analyzer commits 7817bc8 / 980f93d / 0a03545 · cron hourly :42<br>' +
                'Snapshot generated: ' + escapeHtml(fmtTimestamp(snapshot.generated_at)) + ' · ' +
                'dedup check: ' + dedupBlurb + ' · schema v' + (snapshot.schema_version || '?') +
            '</div>';
    }

    // ---------- public ----------

    return { render: render };

})();
