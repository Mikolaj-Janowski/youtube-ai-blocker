// metrics.js — Dashboard logic for YouTube AI Blocker
// Reads performance data from chrome.storage.local and renders the analytics dashboard.

const METRICS_KEY = "ytd_ai_metrics_v2";
const THRESHOLD_KEY = "ytd_ai_threshold_v2";

/* ──────────────── Calculations ──────────────── */

function calculateMetrics(data) {
  const auto = data.totalAutoBlocked || 0;
  const fp   = data.falsePositives   || 0;
  const fn   = data.falseNegatives   || 0;
  const tp   = Math.max(0, auto - fp);

  const precision = auto > 0
    ? tp / auto
    : null;

  const recall = (tp + fn) > 0
    ? tp / (tp + fn)
    : null;

  const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall)
    : null;

  return { tp, fp, fn, auto, precision, recall, f1 };
}

/* ──────────────── Formatting helpers ──────────────── */

function fmtPct(val) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  return (val * 100).toFixed(1) + '%';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString();
}

function fmtDateShort(ts) {
  return new Date(ts).toLocaleDateString();
}

function scoreBadge(val) {
  if (val === null || val === undefined || isNaN(val)) {
    return '<span class="badge badge-na">N/A</span>';
  }
  if (val >= 0.85) return `<span class="badge badge-excellent">${fmtPct(val)}</span>`;
  if (val >= 0.70) return `<span class="badge badge-good">${fmtPct(val)}</span>`;
  if (val >= 0.55) return `<span class="badge badge-ok">${fmtPct(val)}</span>`;
  return `<span class="badge badge-poor">${fmtPct(val)}</span>`;
}

/* ──────────────── Render: Overview Cards ──────────────── */

function renderOverview(data) {
  const { tp, fp, fn, auto } = calculateMetrics(data);
  document.getElementById('statAutoBlocked').textContent   = auto;
  document.getElementById('statTruePositives').textContent = tp;
  document.getElementById('statFalsePositives').textContent = fp;
  document.getElementById('statFalseNegatives').textContent = fn;
}

/* ──────────────── Render: Metric Bars ──────────────── */

function renderMetrics(data) {
  const container = document.getElementById('metricsContent');
  const { precision, recall, f1, auto } = calculateMetrics(data);

  if (auto === 0) {
    container.innerHTML = `
      <div class="no-data">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        No blocking data yet. Start blocking videos on YouTube to see performance metrics.
      </div>`;
    return;
  }

  function barRow(label, val, barClass, valClass) {
    const pct = val !== null ? Math.max(2, Math.round(val * 100)) : 2;
    return `
      <div class="metric-row">
        <div class="metric-label">${label}</div>
        <div class="metric-bar-wrap">
          <div class="metric-bar ${barClass}" style="width:${pct}%"></div>
        </div>
        <div class="metric-value ${valClass}">${fmtPct(val)}</div>
      </div>`;
  }

  container.innerHTML =
    barRow('Precision', precision, 'bar-precision', 'val-precision') +
    barRow('Recall',    recall,    'bar-recall',    'val-recall')    +
    barRow('F1 Score',  f1,        'bar-f1',        'val-f1');
}

/* ──────────────── Render: SVG Chart ──────────────── */

function renderChart(history) {
  const container = document.getElementById('chartContainer');

  if (!history || history.length < 2) {
    container.innerHTML = `
      <div class="no-data">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg>
        Not enough snapshots yet. A snapshot is taken every 10 auto-block events.
      </div>`;
    return;
  }

  const W = 760, H = 220;
  const MT = 20, MR = 20, MB = 42, ML = 50;
  const PW = W - ML - MR;
  const PH = H - MT - MB;
  const n  = history.length;

  const getX = (i) => ML + (i / (n - 1)) * PW;
  const getY = (v) => (v !== null && v !== undefined) ? MT + (1 - v) * PH : null;

  function makeLine(series, color) {
    const pts = series
      .map((v, i) => { const y = getY(v); return y !== null ? `${getX(i).toFixed(1)},${y.toFixed(1)}` : null; })
      .filter(Boolean);
    if (pts.length < 2) return '';
    return `<path d="${pts.map((p, i) => (i === 0 ? 'M' : 'L') + p).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;
  }

  function makeDots(series, color) {
    return series.map((v, i) => {
      const y = getY(v);
      return y !== null
        ? `<circle cx="${getX(i).toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="${color}" stroke="white" stroke-width="2"/>`
        : '';
    }).join('');
  }

  // Y-axis grid
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
  const yGrid = yTicks.map(v => {
    const y = getY(v).toFixed(1);
    return `
      <line x1="${ML}" y1="${y}" x2="${ML + PW}" y2="${y}" stroke="#f0f1f5" stroke-width="1"/>
      <text x="${ML - 8}" y="${parseFloat(y) + 4}" text-anchor="end" font-size="11" fill="#9ca3af">${(v * 100).toFixed(0)}%</text>`;
  }).join('');

  // X-axis labels (every auto-blocked count milestone)
  const step = n <= 8 ? 1 : Math.ceil(n / 7);
  const xLabels = history.map((s, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    return `<text x="${getX(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#9ca3af">${s.totalAutoBlocked}</text>`;
  }).join('');

  const precisions = history.map(s => s.precision);
  const recalls    = history.map(s => s.recall);
  const f1s        = history.map(s => s.f1);

  const svg = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg">
      ${yGrid}
      <line x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + PH}" stroke="#e2e8f0" stroke-width="1.5"/>
      <line x1="${ML}" y1="${MT + PH}" x2="${ML + PW}" y2="${MT + PH}" stroke="#e2e8f0" stroke-width="1.5"/>
      <text x="${W / 2}" y="${H - 1}" text-anchor="middle" font-size="11" fill="#9ca3af">Cumulative Auto-Blocked Videos</text>
      ${makeLine(precisions, '#667eea')}
      ${makeLine(recalls,    '#10b981')}
      ${makeLine(f1s,        '#f59e0b')}
      ${makeDots(precisions, '#667eea')}
      ${makeDots(recalls,    '#10b981')}
      ${makeDots(f1s,        '#f59e0b')}
      ${xLabels}
    </svg>
    <div class="chart-legend">
      <div class="legend-item"><div class="legend-dot" style="background:#667eea"></div> Precision</div>
      <div class="legend-item"><div class="legend-dot" style="background:#10b981"></div> Recall</div>
      <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div> F1 Score</div>
    </div>`;

  container.innerHTML = `<div class="chart-container">${svg}</div>`;
}

/* ──────────────── Render: Early vs Recent Comparison ──────────────── */

function renderComparison(history) {
  const container = document.getElementById('comparisonContainer');
  container.innerHTML = '';

  if (!history || history.length < 4) return;

  const mid    = Math.floor(history.length / 2);
  const early  = history.slice(0, mid);
  const recent = history.slice(mid);

  const avgOf = (arr, key) => {
    const valid = arr.filter(s => s[key] !== null && s[key] !== undefined);
    return valid.length > 0 ? valid.reduce((s, x) => s + x[key], 0) / valid.length : null;
  };

  const eP = avgOf(early,  'precision'), rP = avgOf(recent, 'precision');
  const eR = avgOf(early,  'recall'),    rR = avgOf(recent, 'recall');
  const eF = avgOf(early,  'f1'),        rF = avgOf(recent, 'f1');

  if (eF === null || rF === null) return;

  const delta    = rF - eF;
  const sign     = delta >= 0 ? '+' : '';
  const isImprove = delta >= 0;

  container.innerHTML = `
    <div style="margin-top:24px;">
      <div style="font-size:12px;font-weight:700;color:#667eea;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;">
        Longitudinal Comparison — Early vs Recent
      </div>
      <div class="comparison-grid">
        <div class="comparison-card" style="background:#f8f9ff;border:2px solid #e0e4ff;">
          <div class="period-label">Early (first ${early.length} snapshots)</div>
          <div class="period-value" style="color:#667eea;">${fmtPct(eF)}</div>
          <div class="period-sub">Avg F1 &nbsp;|&nbsp; P: ${fmtPct(eP)} &nbsp; R: ${fmtPct(eR)}</div>
        </div>
        <div class="comparison-card" style="background:#f8f9ff;border:2px solid #e0e4ff;">
          <div class="period-label">Recent (last ${recent.length} snapshots)</div>
          <div class="period-value" style="color:#667eea;">${fmtPct(rF)}</div>
          <div class="period-sub">Avg F1 &nbsp;|&nbsp; P: ${fmtPct(rP)} &nbsp; R: ${fmtPct(rR)}</div>
        </div>
        <div class="comparison-card" style="background:${isImprove ? '#f0fdf4' : '#fef2f2'};border:2px solid ${isImprove ? '#bbf7d0' : '#fecaca'};">
          <div class="period-label">Change</div>
          <div class="period-value" style="color:${isImprove ? '#16a34a' : '#dc2626'};">${sign}${fmtPct(delta)}</div>
          <div class="period-sub">${isImprove ? '📈 Improving over time' : '📉 Declining — review settings'}</div>
        </div>
      </div>
    </div>`;
}

/* ──────────────── Render: History Table ──────────────── */

function renderHistoryTable(history) {
  const section   = document.getElementById('historySection');
  const container = document.getElementById('historyTable');
  const countEl   = document.getElementById('historyCount');

  if (!history || history.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  countEl.textContent = `${history.length} snapshot${history.length !== 1 ? 's' : ''}`;

  const rows = [...history].reverse().map((s, idx) => {
    const isLatest = idx === 0;
    const isFirst  = idx === history.length - 1;
    return `
      <tr>
        <td>${fmtDate(s.timestamp)}</td>
        <td><strong>${s.totalAutoBlocked}</strong></td>
        <td>${s.falsePositives || 0}</td>
        <td>${s.falseNegatives || 0}</td>
        <td>${scoreBadge(s.precision)}</td>
        <td>${scoreBadge(s.recall)}</td>
        <td>${scoreBadge(s.f1)}</td>
        <td>${s.threshold !== undefined ? (s.threshold * 100).toFixed(0) + '%' : '—'}</td>
        <td>${isLatest ? '<span class="badge badge-good">Latest</span>' : isFirst ? '<span class="badge badge-na">Initial</span>' : '—'}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="history-table">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Auto-Blocked</th>
          <th>FP</th>
          <th>FN</th>
          <th>Precision</th>
          <th>Recall</th>
          <th>F1</th>
          <th>Threshold</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ──────────────── Export CSV ──────────────── */

function exportCSV(metricsObj) {
  const history = metricsObj.history || [];

  if (history.length === 0) {
    alert('No snapshot history to export yet. Wait until 10 videos have been auto-blocked.');
    return;
  }

  const headers = [
    'Timestamp', 'Date', 'AutoBlocked', 'FalsePositives', 'FalseNegatives',
    'Precision_%', 'Recall_%', 'F1_%', 'Threshold_%'
  ];

  const rows = history.map(s => [
    s.timestamp,
    fmtDate(s.timestamp).replace(/,/g, ''),
    s.totalAutoBlocked,
    s.falsePositives  || 0,
    s.falseNegatives  || 0,
    s.precision  !== null && s.precision  !== undefined ? (s.precision  * 100).toFixed(2) : '',
    s.recall     !== null && s.recall     !== undefined ? (s.recall     * 100).toFixed(2) : '',
    s.f1         !== null && s.f1         !== undefined ? (s.f1         * 100).toFixed(2) : '',
    s.threshold  !== undefined                         ? (s.threshold  * 100).toFixed(0) : ''
  ]);

  const csv  = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `ytd-ai-metrics-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ──────────────── Main load & render ──────────────── */

async function loadAndRender() {
  const data = await new Promise(resolve =>
    chrome.storage.local.get([METRICS_KEY, THRESHOLD_KEY], resolve)
  );

  const metrics = data[METRICS_KEY] || {
    totalAutoBlocked: 0, falsePositives: 0, falseNegatives: 0,
    totalManualBlocked: 0, sessionStart: Date.now(), history: []
  };

  const threshold = data[THRESHOLD_KEY] || 0.7;

  // Update header info
  const lastEl = document.getElementById('lastUpdated');
  const since  = metrics.sessionStart ? `Tracking since: ${fmtDate(metrics.sessionStart)}` : 'Tracking started';
  lastEl.textContent = `${since}  |  Current threshold: ${(threshold * 100).toFixed(0)}%  |  Manual blocks: ${metrics.totalManualBlocked || 0}`;

  renderOverview(metrics);
  renderMetrics(metrics);
  renderChart(metrics.history || []);
  renderComparison(metrics.history || []);
  renderHistoryTable(metrics.history || []);
}

/* ──────────────── Event listeners ──────────────── */

document.getElementById('refreshBtn').addEventListener('click', loadAndRender);

document.getElementById('exportBtn').addEventListener('click', () => {
  chrome.storage.local.get([METRICS_KEY], (data) => {
    exportCSV(data[METRICS_KEY] || {});
  });
});

document.getElementById('resetBtn').addEventListener('click', () => {
  if (!confirm('Reset all metrics data? This will erase all snapshots and counters. This cannot be undone.')) return;
  const fresh = {
    totalAutoBlocked: 0, falsePositives: 0, falseNegatives: 0,
    totalManualBlocked: 0, sessionStart: Date.now(), history: []
  };
  chrome.storage.local.set({ [METRICS_KEY]: fresh }, loadAndRender);
});

// Auto-refresh whenever the content script writes new metrics
chrome.storage.onChanged.addListener((changes) => {
  if (changes[METRICS_KEY] || changes[THRESHOLD_KEY]) {
    loadAndRender();
  }
});

// Initial load
loadAndRender();

