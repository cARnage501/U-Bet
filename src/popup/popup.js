import { computeStats, toCSV, buildRawJSONExport, buildLLMExport, buildLLMMarkdown, downloadText, copyToClipboard, timestampForFilename } from '../lib/export.js';

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function loadStats() {
  const records = (await sendMessage({ type: 'UBET_GET_BETS' })) || [];
  const stats = computeStats(records);

  document.getElementById('statBets').textContent = stats.betCount;
  document.getElementById('statNet').textContent = stats.totalNet != null ? formatMoney(stats.totalNet) : '–';
  document.getElementById('statRtp').textContent = stats.overallRtpPercent != null ? `${stats.overallRtpPercent}%` : '–';

  const chain = await sendMessage({ type: 'UBET_VERIFY_CHAIN' });
  document.getElementById('chainStatus').textContent = chain.valid
    ? 'ledger chain intact'
    : `chain break at record ${chain.brokenAtIndex}`;

  return { records, stats };
}

function formatMoney(n) {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}`;
}

// Surfaced so the build actually running in the browser can be compared at a
// glance against what's checked out — a stale loaded extension otherwise looks
// identical to a fresh one.
function initVersionLabel() {
  document.getElementById('versionLabel').textContent = `v${chrome.runtime.getManifest().version}`;
}

async function initCaptureToggle() {
  const toggle = document.getElementById('captureToggle');
  toggle.checked = await sendMessage({ type: 'UBET_GET_CAPTURE_ENABLED' });
  toggle.addEventListener('change', () => {
    sendMessage({ type: 'UBET_SET_CAPTURE_ENABLED', enabled: toggle.checked });
  });
}

document.getElementById('openDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
});

document.getElementById('exportJson').addEventListener('click', async () => {
  const { records } = await loadStats();
  downloadText(`ubet-ledger-${timestampForFilename()}.json`, JSON.stringify(buildRawJSONExport(records), null, 2), 'application/json');
});

document.getElementById('exportCsv').addEventListener('click', async () => {
  const { records } = await loadStats();
  downloadText(`ubet-ledger-${timestampForFilename()}.csv`, toCSV(records), 'text/csv');
});

document.getElementById('exportLlm').addEventListener('click', async () => {
  const { records, stats } = await loadStats();
  downloadText(`ubet-llm-export-${timestampForFilename()}.md`, buildLLMMarkdown(records, stats), 'text/markdown');
});

document.getElementById('copyLlm').addEventListener('click', async () => {
  const { records, stats } = await loadStats();
  await copyToClipboard(JSON.stringify(buildLLMExport(records, stats), null, 2));
  const btn = document.getElementById('copyLlm');
  const original = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = original), 1200);
});

initVersionLabel();
initCaptureToggle();
loadStats();
