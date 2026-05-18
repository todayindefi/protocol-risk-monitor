/**
 * Protocol Risk Monitor — main application.
 * Routes ?protocol=<name> to a per-protocol renderer.
 */

var REFRESH_INTERVAL = 5 * 60 * 1000;

var PROTOCOL_RENDERERS = {
    fluid: typeof FluidRenderer !== 'undefined' ? FluidRenderer : null
};

var DEFAULT_PROTOCOL = 'fluid';

function getProtocolSlug() {
    var params = new URLSearchParams(window.location.search);
    return params.get('protocol') || DEFAULT_PROTOCOL;
}

function showOnly(id) {
    ['index-view', 'protocol-view', 'error-view'].forEach(function (k) {
        var el = document.getElementById(k);
        if (el) el.classList.toggle('hidden', k !== id);
    });
}

function showError(msg) {
    showOnly('error-view');
    document.getElementById('error-message').textContent = msg;
}

async function renderProtocol(slug) {
    var renderer = PROTOCOL_RENDERERS[slug];
    if (!renderer) {
        showError('Unknown protocol: ' + slug);
        return;
    }
    showOnly('protocol-view');

    try {
        var resp = await fetch('data/' + slug + '_snapshot.json', { cache: 'no-store' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var snapshot = await resp.json();
        renderer.render(snapshot);
    } catch (e) {
        showError('Could not load ' + slug + ' snapshot: ' + e.message);
    }
}

function route() {
    var slug = getProtocolSlug();
    renderProtocol(slug);
}

document.addEventListener('DOMContentLoaded', function () {
    route();
    setInterval(route, REFRESH_INTERVAL);
});
