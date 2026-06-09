<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Limited Sniper</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;600&display=swap');

  :root {
    --bg: #0a0a0f;
    --panel: #111118;
    --border: #1e1e2e;
    --accent: #00ff88;
    --accent2: #ff4466;
    --orange: #ff8800;
    --text: #e0e0e0;
    --muted: #555570;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Space Grotesk', sans-serif;
    min-height: 100vh;
    padding: 24px;
  }

  header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 28px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 16px;
  }

  header h1 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.3rem;
    color: var(--accent);
  }

  .status-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--accent2);
    box-shadow: 0 0 8px var(--accent2);
    flex-shrink: 0;
    transition: all 0.3s;
  }
  .status-dot.running {
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
    animation: pulse 1.4s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.45} }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    max-width: 1080px;
  }
  @media(max-width:720px){ .grid{ grid-template-columns:1fr; } }

  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
  }

  .panel h2 {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 2.5px;
    color: var(--muted);
    margin-bottom: 14px;
  }

  label {
    display: block;
    font-size: 0.76rem;
    color: var(--muted);
    margin: 10px 0 3px;
  }
  label:first-of-type { margin-top: 0; }

  input[type=text], input[type=number] {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    padding: 7px 10px;
    outline: none;
    transition: border-color .2s;
  }
  input:focus { border-color: var(--accent); }

  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    font-size: 0.82rem;
    color: var(--muted);
  }
  input[type=checkbox] { accent-color: var(--accent); }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 12px;
    padding: 8px 16px;
    border-radius: 6px;
    border: none;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity .15s, transform .1s;
    letter-spacing: .4px;
  }
  .btn:active { transform: scale(.97); }
  .btn-green  { background: var(--accent);  color: #000; }
  .btn-red    { background: var(--accent2); color: #fff; }
  .btn-ghost  { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Deal tier badges */
  .tier-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    margin-bottom: 4px;
  }
  .tier-card {
    border-radius: 8px;
    padding: 10px 12px;
    border: 1px solid;
  }
  .tier-card.small  { border-color: #00ff8840; background: #00ff8808; }
  .tier-card.medium { border-color: #ff880040; background: #ff880008; }
  .tier-card.big    { border-color: #ff446640; background: #ff446608; }
  .tier-card .tier-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin-bottom: 6px;
  }
  .tier-card.small  .tier-label { color: var(--accent); }
  .tier-card.medium .tier-label { color: var(--orange); }
  .tier-card.big    .tier-label { color: var(--accent2); }
  .tier-card .tier-range {
    font-size: 0.75rem;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .tier-card input { font-size: 0.72rem; }

  /* Items table */
  .items-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  .items-table th {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--muted);
    padding: 5px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .items-table td {
    padding: 8px;
    border-bottom: 1px solid #14141e;
    font-family: 'JetBrains Mono', monospace;
  }
  .items-table tr:last-child td { border-bottom: none; }
  .remove-btn {
    background: none; border: none;
    color: var(--accent2); cursor: pointer;
    font-size: 0.9rem; padding: 0 4px;
  }

  .tag { display:inline-block; padding:1px 7px; border-radius:4px; font-size:0.68rem; font-family:'JetBrains Mono',monospace; }
  .tag-yes { background:#00ff8820; color:var(--accent); }
  .tag-no  { background:#ff446620; color:var(--accent2); }

  /* Log */
  #log-box {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    height: 200px;
    overflow-y: auto;
    padding: 10px 12px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    line-height: 1.75;
    color: #7070a0;
    grid-column: 1 / -1;
  }
  #log-box .buy  { color: var(--accent); font-weight: 600; }
  #log-box .deal { color: var(--orange); }
  #log-box .err  { color: var(--accent2); }
  #log-box .warn { color: #ffaa44; }

  #toast {
    position: fixed; bottom: 18px; right: 18px;
    background: #1a1a28; border: 1px solid var(--border);
    border-radius: 8px; padding: 9px 14px;
    font-size: 0.78rem; color: var(--text);
    display: none; z-index: 999;
    font-family: 'JetBrains Mono', monospace;
  }
</style>
</head>
<body>

<header>
  <div class="status-dot" id="status-dot"></div>
  <h1>// limited sniper</h1>
  <span id="status-label" style="font-size:0.78rem;color:var(--muted);font-family:'JetBrains Mono',monospace">stopped</span>
</header>

<div class="grid">

  <!-- Settings -->
  <div class="panel">
    <h2>Settings</h2>
    <label>.ROBLOSECURITY cookie</label>
    <input type="text" id="cookie" placeholder="_|WARNING:-DO-NOT-SHARE..." value="{{ config.cookie }}">
    <div class="toggle-row">
      <input type="checkbox" id="debug" {% if config.DEBUG_MESSAGES %}checked{% endif %}>
      <span>Log all price checks</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-ghost" onclick="saveSettings()">Save settings</button>
    </div>
  </div>

  <!-- Add item -->
  <div class="panel">
    <h2>Add Item</h2>
    <label>Asset ID</label>
    <input type="text" id="new-asset" placeholder="e.g. 1365767">
    <label>Max buy price (R$) — 0 to disable auto-buy</label>
    <input type="number" id="new-price" placeholder="0" min="0" value="0">
    <div class="toggle-row">
      <input type="checkbox" id="buyagain">
      <span>Buy multiple times</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-green" onclick="addItem()">+ Add item</button>
    </div>
  </div>

  <!-- Deal channels -->
  <div class="panel" style="grid-column: 1 / -1;">
    <h2>Discord Deal Channels &nbsp;<span style="color:var(--muted);font-size:0.65rem;font-family:'JetBrains Mono',monospace">Set SMALL/MEDIUM/BIG_DEALS_CHANNEL env vars on Railway</span></h2>
    <div class="tier-grid" style="grid-template-columns:1fr 1fr 1fr 1fr">
      <div class="tier-card small">
        <div class="tier-label">📉 small-deals</div>
        <div class="tier-range">20 – 39% off</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted)">
          Channel ID: <span style="color:var(--text)">{{ channel_ids.small or '(not set)' }}</span>
        </div>
      </div>
      <div class="tier-card medium">
        <div class="tier-label">💰 medium-deals</div>
        <div class="tier-range">40 – 59% off</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted)">
          Channel ID: <span style="color:var(--text)">{{ channel_ids.medium or '(not set)' }}</span>
        </div>
      </div>
      <div class="tier-card big">
        <div class="tier-label">🔥 big-deals</div>
        <div class="tier-range">60%+ off</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted)">
          Channel ID: <span style="color:var(--text)">{{ channel_ids.big or '(not set)' }}</span>
        </div>
      </div>
      <div class="tier-card" style="border-color:#5865f240;background:#5865f208">
        <div class="tier-label" style="color:#5865f2">📊 price-tracker</div>
        <div class="tier-range">price changes + latency</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted)">
          Channel ID: <span style="color:var(--text)">{{ channel_ids.tracker or '(not set)' }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Items list -->
  <div class="panel" style="grid-column: 1 / -1;">
    <h2>Targets &nbsp;<span id="item-count" style="color:var(--accent)">{{ config.limiteds|length }}</span></h2>
    <table class="items-table">
      <thead>
        <tr>
          <th>Asset ID</th>
          <th>Max R$</th>
          <th>Multi-buy</th>
          <th>Product ID</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="items-tbody">
        {% for item in config.limiteds %}
        <tr id="row-{{ item.asset }}">
          <td><a href="https://www.roblox.com/catalog/{{ item.asset }}" target="_blank" style="color:var(--accent);text-decoration:none">{{ item.asset }}</a></td>
          <td>{{ item.price }}</td>
          <td><span class="tag {% if item.buyagain %}tag-yes{% else %}tag-no{% endif %}">{% if item.buyagain %}yes{% else %}no{% endif %}</span></td>
          <td>{{ item.productid }}</td>
          <td><button class="remove-btn" onclick="removeItem('{{ item.asset }}')">✕</button></td>
        </tr>
        {% else %}
        <tr id="empty-row"><td colspan="5" style="color:var(--muted);text-align:center;padding:18px">No items added yet</td></tr>
        {% endfor %}
      </tbody>
    </table>
  </div>

  <!-- Controls -->
  <div class="panel" style="grid-column:1/-1;display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
    <button class="btn btn-green" onclick="startSniper()">&#9654; Start sniper</button>
    <button class="btn btn-red"   onclick="stopSniper()">&#9209; Stop sniper</button>
    <div style="margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:var(--muted)">
      auto-buy: <span id="threshold-display" style="color:var(--accent)">{{ "%.0f"|format(config.buy_discount_threshold) }}% off</span>
      &nbsp;&mdash;&nbsp; change with <code style="color:var(--text)">/setbuy</code> in Discord
    </div>
  </div>

  <!-- Log -->
  <div id="log-box">
    {% for line in log %}
    <div class="{{ 'buy' if 'BUY ✓' in line else ('deal' if 'DEAL' in line else ('err' if 'ERROR' in line or 'BUY ✗' in line else ('warn' if 'RATELIMIT' in line else ''))) }}">{{ line }}</div>
    {% endfor %}
  </div>

</div>

<div id="toast"></div>

<script>
let running = {{ 'true' if running else 'false' }};

function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.style.borderColor = err ? 'var(--accent2)' : 'var(--accent)';
  clearTimeout(t._t);
  t._t = setTimeout(() => t.style.display = 'none', 2500);
}

function updateStatusUI(r) {
  running = r;
  document.getElementById('status-dot').classList.toggle('running', r);
  document.getElementById('status-label').textContent = r ? 'running' : 'stopped';
}

async function saveSettings() {
  const res = await fetch('/api/config/settings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      cookie: document.getElementById('cookie').value,
      debug:  document.getElementById('debug').checked
    })
  });
  const d = await res.json();
  toast(d.ok ? 'Settings saved' : d.error, !d.ok);
}

async function addItem() {
  const asset    = document.getElementById('new-asset').value.trim();
  const price    = document.getElementById('new-price').value.trim() || '0';
  const buyagain = document.getElementById('buyagain').checked;
  if (!asset) { toast('Enter an asset ID', true); return; }

  toast('Fetching product ID + Rolimons value...');
  const res = await fetch('/api/config/add_item', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ asset_id: asset, max_price: price, buyagain })
  });
  const d = await res.json();
  if (!d.ok) { toast(d.error, true); return; }

  const empty = document.getElementById('empty-row');
  if (empty) empty.remove();
  const existing = document.getElementById('row-' + asset);
  if (existing) existing.remove();

  const tbody = document.getElementById('items-tbody');
  const tr = document.createElement('tr');
  tr.id = 'row-' + asset;
  tr.innerHTML = `
    <td><a href="https://www.roblox.com/catalog/${asset}" target="_blank" style="color:var(--accent);text-decoration:none">${asset}</a></td>
    <td>${price}</td>
    <td><span class="tag ${buyagain ? 'tag-yes' : 'tag-no'}">${buyagain ? 'yes' : 'no'}</span></td>
    <td>${d.product_id}</td>
    <td><button class="remove-btn" onclick="removeItem('${asset}')">✕</button></td>
  `;
  tbody.appendChild(tr);
  updateCount();
  document.getElementById('new-asset').value = '';
  document.getElementById('new-price').value = '0';

  const rv = d.rolimons_value;
  toast(rv ? `Added — Rolimons value: ${rv.toLocaleString()} R$` : 'Added (no Rolimons value found)');
}

async function removeItem(asset) {
  await fetch('/api/config/remove_item', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ asset_id: asset })
  });
  const row = document.getElementById('row-' + asset);
  if (row) row.remove();
  updateCount();
  toast('Item removed');
}

function updateCount() {
  document.getElementById('item-count').textContent =
    document.getElementById('items-tbody').querySelectorAll('tr:not(#empty-row)').length;
}

async function startSniper() {
  const res = await fetch('/api/sniper/start', { method: 'POST' });
  const d = await res.json();
  if (d.ok) { updateStatusUI(true); toast('Sniper started'); }
  else toast(d.error, true);
}

async function stopSniper() {
  await fetch('/api/sniper/stop', { method: 'POST' });
  updateStatusUI(false);
  toast('Sniper stopped');
}

function colorLine(l) {
  if (l.includes('BUY ✓'))  return 'buy';
  if (l.includes('DEAL'))   return 'deal';
  if (l.includes('ERROR') || l.includes('BUY ✗')) return 'err';
  if (l.includes('RATELIMIT')) return 'warn';
  return '';
}

setInterval(async () => {
  const d = await (await fetch('/api/status')).json();
  updateStatusUI(d.running);
  const box = document.getElementById('log-box');
  const atBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 40;
  box.innerHTML = d.log.map(l => `<div class="${colorLine(l)}">${l}</div>`).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}, 2000);

updateStatusUI(running);
</script>
</body>
</html>
