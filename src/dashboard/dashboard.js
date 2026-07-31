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
    // Sample count is shown alongside the mean because measured coverage is
    // partial by nature — a mean over a handful of bets reads very
    // differently from one over hundreds, and that context is easy to lose.
    ['Avg animation duration', stats.animationDurationMs.mean != null
      ? `${stats.animationDurationMs.mean} ms <span class="qualifier">(${stats.animationDurationMs.sampleCount} measured)</span>`
      : '–'],
    ['Ledger chain', chain.valid ? 'intact' : `broken @${chain.brokenAtIndex}`],
  ];
  const el = document.getElementById('summary');
  el.innerHTML = items
    .map(([label, value]) => `<div class="stat"><span class="value">${value}</span><span class="label">${label}</span></div>`)
    .join('');
}

// Only measured durations belong on the timing scatters — plotting bounded
// 'superseded' estimates there would put artefacts of fast play into charts
// meant to show real animation behaviour.
const MEASURED = new Set(['tile-cascade']);

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
    .filter((r) => r.balanceBefore != null && r.animationDurationMs != null && MEASURED.has(r.animationTimingQuality))
    .map((r) => ({ x: r.balanceBefore, y: r.animationDurationMs }));
  renderScatter(document.getElementById('chartBalanceAnimation'), balanceAnimPoints, {
    xLabel: 'balance before',
    yLabel: 'animation ms',
    referenceX: threshold,
    referenceLabel: threshold != null ? 'withdrawal min' : undefined,
  });

  const latencyAnimPoints = sorted
    .filter((r) => r.serverLatencyMs != null && r.animationDurationMs != null && MEASURED.has(r.animationTimingQuality))
    .map((r) => ({ x: r.serverLatencyMs, y: r.animationDurationMs }));
  renderScatter(document.getElementById('chartLatencyAnimation'), latencyAnimPoints, { xLabel: 'server latency ms', yLabel: 'animation ms' });

  const byGameBars = Object.entries(stats.byGame).map(([game, v]) => ({ label: game, value: round2(v.payout - v.wagered) }));
  renderBar(document.getElementById('chartByGame'), byGameBars, {});

  const byRiskBars = Object.entries(stats.byRisk).map(([risk, v]) => ({ label: risk, value: round2(v.payout - v.wagered) }));
  renderBar(document.getElementById('chartByRisk'), byRiskBars, {});
}

function renderRawTable(rawEvents) {
  const tbody = document.querySelector('#rawTable tbody');
  // Rebuilding the rows resets scroll position, which on a 1s auto-refresh
  // would yank the view out from under anyone reading the log.
  const wrap = document.querySelector('.table-wrap');
  const scrollTop = wrap ? wrap.scrollTop : 0;
  tbody.innerHTML = rawEvents
    .slice()
    .reverse()
    .slice(0, 100)
    .map((e) => {
      const preview = (e.rawEvent?.responseBody || e.rawEvent?.requestBody || '').slice(0, 160);
      return `<tr><td>${new Date(e.capturedAt).toLocaleTimeString()}</td><td>${e.channel}</td><td title="${escapeHtml(e.url)}">${escapeHtml(shorten(e.url))}</td><td>${escapeHtml(preview)}</td></tr>`;
    })
    .join('');
  if (wrap) wrap.scrollTop = scrollTop;
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

const AUTO_REFRESH_MS = 1000;

let refreshInFlight = null;
let lastRenderSignature = null;
let lastChainResult = { valid: true };
let lastChainBetCount = -1;
let latest = { records: [], stats: null };

// Cheap stand-in for "did anything actually change". Both stores are
// append-only, so a count plus the newest key is enough to tell.
function dataSignature(records, rawEvents) {
  const lastBet = records.length ? records[records.length - 1] : null;
  const lastRaw = rawEvents.length ? rawEvents[rawEvents.length - 1] : null;
  return [records.length, lastBet ? lastBet.seq ?? lastBet.betId : '', rawEvents.length, lastRaw ? lastRaw.seq ?? '' : ''].join('|');
}

function refresh({ force = false } = {}) {
  // A tick that lands while the previous one is still awaiting the service
  // worker would queue up behind it and, on a slow read, snowball. Callers
  // get the in-flight promise rather than a stale snapshot, so an export
  // clicked mid-tick still resolves against real data instead of whatever
  // was last rendered (or, on first load, an empty set).
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh({ force }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefresh({ force }) {
  const [records, rawEvents] = await Promise.all([
    sendMessage({ type: 'UBET_GET_BETS' }).then((r) => r || []),
    sendMessage({ type: 'UBET_GET_RAW', limit: 200 }).then((r) => r || []),
  ]);

  // Chain verification re-hashes every record, so it runs only when the bet
  // count actually moved rather than on every tick — at a few thousand
  // records, hashing the whole ledger once a second would dominate the CPU.
  if (force || records.length !== lastChainBetCount) {
    lastChainResult = await sendMessage({ type: 'UBET_VERIFY_CHAIN' });
    lastChainBetCount = records.length;
  }

  const stats = computeStats(records);
  latest = { records, stats };

  const signature = dataSignature(records, rawEvents);
  if (force || signature !== lastRenderSignature) {
    lastRenderSignature = signature;
    const threshold = await getThreshold();
    renderSummary(stats, lastChainResult);
    renderCharts(records, stats, threshold);
    renderRawTable(rawEvents);
  }

  return latest;
}

// Polling a hidden tab burns CPU for nothing; catch up on the way back.
function startAutoRefresh() {
  const indicator = document.getElementById('liveIndicator');
  const syncIndicator = () => {
    if (!indicator) return;
    indicator.classList.toggle('paused', document.hidden);
    indicator.textContent = document.hidden ? 'paused' : 'live';
  };

  setInterval(() => {
    if (!document.hidden) refresh();
  }, AUTO_REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    syncIndicator();
    if (!document.hidden) refresh();
  });

  syncIndicator();
}

// Surfaced so the build actually running in the browser can be compared at a
// glance against what's checked out — a stale loaded extension otherwise looks
// identical to a fresh one.
document.getElementById('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;

// Manual actions force a render: the signature check can't see a changed
// threshold, and an explicit click should always visibly do something.
document.getElementById('refresh').addEventListener('click', () => refresh({ force: true }));

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
  refresh({ force: true });
});

const thresholdInput = document.getElementById('withdrawalThreshold');
getThreshold().then((v) => {
  if (v != null) thresholdInput.value = v;
});
thresholdInput.addEventListener('change', async () => {
  const v = thresholdInput.value === '' ? null : Number(thresholdInput.value);
  await chrome.storage.local.set({ withdrawalThreshold: v });
  refresh({ force: true });
});

refresh({ force: true });
startAutoRefresh();
