use axum::response::Html;

/// Serve the embedded node dashboard at /
pub async fn node_dashboard() -> Html<&'static str> {
    Html(DASHBOARD_HTML)
}

const DASHBOARD_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>RougeChain Node</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;
    min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px;
  }
  .container{max-width:720px;width:100%}
  .header{display:flex;align-items:center;gap:12px;margin-bottom:32px}
  .logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#ff1744,#d500f9);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:#fff}
  .header h1{font-size:20px;font-weight:700;letter-spacing:1px}
  .header .sub{font-size:11px;color:#666;letter-spacing:2px;text-transform:uppercase}
  .live-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-left:auto}
  .live-badge.online{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3)}
  .live-badge.offline{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
  .dot{width:6px;height:6px;border-radius:50%;animation:pulse 2s infinite}
  .online .dot{background:#22c55e}
  .offline .dot{background:#ef4444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
  .stat-card{
    background:#111;border:1px solid #222;border-radius:12px;padding:16px;
    transition:border-color .2s
  }
  .stat-card:hover{border-color:#ff174440}
  .stat-label{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px}
  .stat-value{font-size:28px;font-weight:800;line-height:1}
  .stat-value.red{color:#ff1744}
  .stat-value.purple{color:#d500f9}
  .stat-value.green{color:#22c55e}
  .stat-value.orange{color:#f97316}
  .stat-value.cyan{color:#06b6d4}
  .stat-value.white{color:#e5e5e5}

  .section{background:#111;border:1px solid #222;border-radius:12px;padding:20px;margin-bottom:16px}
  .section-title{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:12px;font-weight:700}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1a1a1a;font-size:13px}
  .info-row:last-child{border-bottom:none}
  .info-label{color:#666}
  .info-value{color:#e5e5e5;font-family:monospace;font-size:12px;word-break:break-all;text-align:right;max-width:60%}

  .peer-list{list-style:none}
  .peer-item{
    display:flex;align-items:center;gap:10px;padding:8px 12px;
    border-radius:8px;margin-bottom:4px;font-size:12px;font-family:monospace;
    background:#0d0d0d;border:1px solid #1a1a1a;transition:border-color .2s
  }
  .peer-item:hover{border-color:#ff174440}
  .peer-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0}
  .peer-name{color:#d500f9;font-weight:600;margin-left:auto;font-size:11px}

  .footer{text-align:center;margin-top:24px;font-size:10px;color:#333;letter-spacing:1px}
  .footer a{color:#ff1744;text-decoration:none}
  .footer a:hover{text-decoration:underline}

  #error-banner{display:none;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;padding:12px;border-radius:10px;margin-bottom:16px;font-size:12px;text-align:center}
  .node-name-display{font-size:14px;color:#ff1744;font-weight:700}
  .uptime{font-size:10px;color:#444;margin-top:2px}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">R</div>
    <div>
      <h1>RougeChain Node</h1>
      <div class="sub" id="node-name-sub">Loading...</div>
    </div>
    <div class="live-badge offline" id="status-badge">
      <span class="dot"></span>
      <span id="status-text">CONNECTING</span>
    </div>
  </div>

  <div id="error-banner"></div>

  <div class="stats-grid" id="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Block Height</div>
      <div class="stat-value red" id="height">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Finalized</div>
      <div class="stat-value cyan" id="finalized">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Peers</div>
      <div class="stat-value purple" id="peers">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Mining</div>
      <div class="stat-value orange" id="mining">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Fees</div>
      <div class="stat-value green" id="fees">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">WebSocket</div>
      <div class="stat-value white" id="ws-clients">—</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Node Info</div>
    <div class="info-row">
      <span class="info-label">Node ID</span>
      <span class="info-value" id="node-id">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Chain ID</span>
      <span class="info-value" id="chain-id">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Node Name</span>
      <span class="info-value" id="node-name">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">Last Block Fee</span>
      <span class="info-value" id="last-fee">—</span>
    </div>
    <div class="info-row">
      <span class="info-label">API</span>
      <span class="info-value" id="api-url">—</span>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Connected Peers</div>
    <ul class="peer-list" id="peer-list">
      <li class="peer-item" style="color:#444;justify-content:center">Loading...</li>
    </ul>
  </div>

  <div class="footer">
    <p>RougeChain Testnet • Post-Quantum L1 • <a href="https://rougechain.io" target="_blank">rougechain.io</a></p>
    <p style="margin-top:4px">Auto-refreshes every 5 seconds</p>
  </div>
</div>

<script>
const BASE = window.location.origin;
let lastHeight = 0;
let startTime = Date.now();

async function fetchStats() {
  try {
    const res = await fetch(BASE + '/api/stats');
    if (!res.ok) throw new Error('Stats API returned ' + res.status);
    const d = await res.json();

    document.getElementById('height').textContent = (d.network_height ?? d.networkHeight ?? 0).toLocaleString();
    document.getElementById('finalized').textContent = (d.finalized_height ?? d.finalizedHeight ?? 0).toLocaleString();
    document.getElementById('peers').textContent = d.connected_peers ?? d.connectedPeers ?? 0;
    document.getElementById('mining').textContent = (d.is_mining ?? d.isMining) ? 'YES' : 'NO';
    document.getElementById('fees').textContent = (d.total_fees_collected ?? d.totalFeesCollected ?? 0).toFixed(2) + ' XRGE';
    document.getElementById('ws-clients').textContent = (d.ws_clients ?? d.wsClients ?? 0) + ' clients';
    document.getElementById('node-id').textContent = d.node_id ?? d.nodeId ?? '—';
    document.getElementById('chain-id').textContent = d.chain_id ?? d.chainId ?? '—';
    const name = d.node_name ?? d.nodeName ?? null;
    document.getElementById('node-name').textContent = name || '(not set)';
    document.getElementById('node-name-sub').textContent = name || d.chain_id || 'Local Node';
    document.getElementById('last-fee').textContent = (d.fees_in_last_block ?? d.feesInLastBlock ?? 0).toFixed(4) + ' XRGE';
    document.getElementById('api-url').textContent = BASE;

    const badge = document.getElementById('status-badge');
    badge.className = 'live-badge online';
    document.getElementById('status-text').textContent = 'ONLINE';
    document.getElementById('error-banner').style.display = 'none';

    const h = d.network_height ?? d.networkHeight ?? 0;
    if (h !== lastHeight && lastHeight > 0) {
      document.getElementById('height').style.color = '#22c55e';
      setTimeout(() => { document.getElementById('height').style.color = ''; }, 800);
    }
    lastHeight = h;
  } catch (e) {
    const badge = document.getElementById('status-badge');
    badge.className = 'live-badge offline';
    document.getElementById('status-text').textContent = 'OFFLINE';
    const eb = document.getElementById('error-banner');
    eb.textContent = 'Cannot reach node API: ' + e.message;
    eb.style.display = 'block';
  }
}

async function fetchPeers() {
  try {
    const res = await fetch(BASE + '/api/peers');
    if (!res.ok) return;
    const d = await res.json();
    const list = document.getElementById('peer-list');
    const details = d.peer_details ?? d.peerDetails ?? [];
    const urls = d.peers ?? [];

    if (urls.length === 0) {
      list.innerHTML = '<li class="peer-item" style="color:#444;justify-content:center">No peers connected</li>';
      return;
    }

    const nameMap = {};
    for (const pd of details) {
      if (pd.url && pd.node_name) nameMap[pd.url] = pd.node_name;
    }

    list.innerHTML = urls.map(url => {
      const name = nameMap[url] || '';
      return '<li class="peer-item"><span class="peer-dot"></span><span>' + url + '</span>' +
        (name ? '<span class="peer-name">' + name + '</span>' : '') + '</li>';
    }).join('');
  } catch {}
}

async function refresh() {
  await Promise.all([fetchStats(), fetchPeers()]);
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>"##;
