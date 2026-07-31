import { computeStats, toCSV, buildRawJSONExport, buildLLMExport, buildLLMMarkdown, downloadText, timestampForFilename } from '../lib/export.js';
import { renderLine, renderScatter, renderBar } from './mini-charts.js';

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

async function getThreshold() {
  const stored = await chrome.storage.local.get('withdrawalThreshold');
  return typeof stored.withdrawalThreshold === 'number' ? stored.withdrawalThreshold : null;
}

function renderSummary(stats, chain) {
  const items = [
    ['Bets logged', stats.betCount],
    ['Total wagered', stats.totalWagered ?? '–'],
    ['Total net', stats.totalNet ?? '–'],
    ['Overall RTP', stats.overallRtpPercent != null ? `${stats.overallRtpPercent}%` : '–'],
    ['Avg server latency', stats.serverLatencyMs.mean != null ? `${stats.serverLatencyMs.mean} ms` : '–'],
    ['Avg animation duration', stats.animationDurationMs.mean != null ? `${stats.animationDurationMs.mean} ms` : '–'],
    ['Ledger chain', chain.valid ? 'intact' : `broken @${chain.brokenAtIndex}`],
  ];
  const el = document.getElementById('summary');
  el.innerHTML = items
    .map(([label, value]) => `<div class="stat"><span class="value">${value}</span><span class="label">${label}</span></div>`)
    .join('');
}

function renderCharts(records, stats, threshold) {
  const sorted = [...records].sort((a, b) => a.submittedAt - b.submittedAt);

  let cumulative = 0;
  const cumulativePoints = sorted.map((r, i) => {
    cumulative += r.net || 0;
    return { x: i, y: round2(cumulative) };
  });
  renderLine(document.getElementById('chartCumulativeNet'), cumulativePoints, { zeroLine: true, yLabel: 'net' });

  const rtpBars = Object.entries(stats.rollingRtpWindows)
    .filter(([, v]) => v != null)
    .map(([w, v]) => ({ label: `${w}`, value: v - 100 }));
  renderBar(document.getElementById('chartRollingRtp'), rtpBars, {});

  const wagerNetPoints = sorted.filter((r) => r.wager != null && r.net != null).map((r) => ({ x: r.wager, y: r.net }));
  renderScatter(document.getElementById('chartWagerNet'), wagerNetPoints, { xLabel: 'wager', yLabel: 'net' });

  const balanceAnimPoints = sorted
    .filter((r) => r.balanceBefore != null && r.animationDurationMs != null)
    .map((r) => ({ x: r.balanceBefore, y: r.animationDurationMs }));
  renderScatter(document.getElementById('chartBalanceAnimation'), balanceAnimPoints, {
    xLabel: 'balance before',
    yLabel: 'animation ms',
    referenceX: threshold,
    referenceLabel: threshold != null ? 'withdrawal min' : undefined,
  });

  const latencyAnimPoints = sorted
    .filter((r) => r.serverLatencyMs != null && r.animationDurationMs != null)
    .map((r) => ({ x: r.serverLatencyMs, y: r.animationDurationMs }));
  renderScatter(document.getElementById('chartLatencyAnimation'), latencyAnimPoints, { xLabel: 'server latency ms', yLabel: 'animation ms' });

  const byGameBars = Object.entries(stats.byGame).map(([game, v]) => ({ label: game, value: round2(v.payout - v.wagered) }));
  renderBar(document.getElementById('chartByGame'), byGameBars, {});

  const byRiskBars = Object.entries(stats.byRisk).map(([risk, v]) => ({ label: risk, value: round2(v.payout - v.wagered) }));
  renderBar(document.getElementById('chartByRisk'), byRiskBars, {});
}

function renderRawTable(rawEvents) {
  const tbody = document.querySelector('#rawTable tbody');
  tbody.innerHTML = rawEvents
    .slice()
    .reverse()
    .slice(0, 100)
    .map((e) => {
      const preview = (e.rawEvent?.responseBody || e.rawEvent?.requestBody || '').slice(0, 160);
      return `<tr><td>${new Date(e.capturedAt).toLocaleTimeString()}</td><td>${e.channel}</td><td title="${escapeHtml(e.url)}">${escapeHtml(shorten(e.url))}</td><td>${escapeHtml(preview)}</td></tr>`;
    })
    .join('');
}

function shorten(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() {
  const [records, rawEvents, chain] = await Promise.all([
    sendMessage({ type: 'UBET_GET_BETS' }).then((r) => r || []),
    sendMessage({ type: 'UBET_GET_RAW', limit: 200 }).then((r) => r || []),
    sendMessage({ type: 'UBET_VERIFY_CHAIN' }),
  ]);
  const stats = computeStats(records);
  const threshold = await getThreshold();

  renderSummary(stats, chain);
  renderCharts(records, stats, threshold);
  renderRawTable(rawEvents);

  return { records, stats };
}

document.getElementById('refresh').addEventListener('click', refresh);

document.getElementById('exportJson').addEventListener('click', async () => {
  const { records } = await refresh();
  downloadText(`ubet-ledger-${timestampForFilename()}.json`, JSON.stringify(buildRawJSONExport(records), null, 2), 'application/json');
});

document.getElementById('exportCsv').addEventListener('click', async () => {
  const { records } = await refresh();
  downloadText(`ubet-ledger-${timestampForFilename()}.csv`, toCSV(records), 'text/csv');
});

document.getElementById('exportLlmMd').addEventListener('click', async () => {
  const { records, stats } = await refresh();
  downloadText(`ubet-llm-export-${timestampForFilename()}.md`, buildLLMMarkdown(records, stats), 'text/markdown');
});

document.getElementById('exportLlmJson').addEventListener('click', async () => {
  const { records, stats } = await refresh();
  downloadText(`ubet-llm-export-${timestampForFilename()}.json`, JSON.stringify(buildLLMExport(records, stats), null, 2), 'application/json');
});

document.getElementById('clearAll').addEventListener('click', async () => {
  const confirmed = confirm('This permanently deletes all locally stored bet telemetry. Export first if you want to keep it. Continue?');
  if (!confirmed) return;
  await sendMessage({ type: 'UBET_CLEAR_ALL', confirm: 'WIPE_LOCAL_DATA' });
  refresh();
});

const thresholdInput = document.getElementById('withdrawalThreshold');
getThreshold().then((v) => {
  if (v != null) thresholdInput.value = v;
});
thresholdInput.addEventListener('change', async () => {
  const v = thresholdInput.value === '' ? null : Number(thresholdInput.value);
  await chrome.storage.local.set({ withdrawalThreshold: v });
  refresh();
});

refresh();
