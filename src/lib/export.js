// Export layer shared by the popup and dashboard pages. Produces:
//  - raw JSON (the full ledger, unmodified)
//  - CSV (flat, spreadsheet-friendly)
//  - an "LLM export" (JSON or Markdown) that bundles a data dictionary and
//    precomputed summary stats alongside the records, so a model can be
//    handed the file directly instead of being asked to re-derive totals
//    from thousands of raw rows.

const RTP_WINDOWS = [25, 100, 500, 1000];

const DATA_DICTIONARY = {
  betId: 'Unique identifier for the bet (from the site, or synthesized if none was found).',
  sessionId: 'Local identifier grouping bets from one continuous play session (resets after 30 minutes idle).',
  site: 'Hostname the bet was captured on.',
  game: 'Game identifier (e.g. "keno"), inferred from the API payload or URL.',
  riskMode: 'Risk/difficulty setting reported by the game, if any.',
  selectedNumbers: 'Numbers/picks chosen by the player, if applicable to the game.',
  resultNumbers: 'Numbers/outcome drawn by the server, if applicable to the game.',
  wager: 'Amount staked on this bet, in the site\'s displayed currency unit.',
  payout: 'Amount returned for this bet (0 on a loss).',
  net: 'payout - wager.',
  balanceBefore: 'Account balance immediately before this bet, when known.',
  balanceAfter: 'Account balance immediately after this bet, when known.',
  submittedAt: 'Unix ms timestamp when the bet request was sent.',
  serverResultAt: 'Unix ms timestamp when the server response arrived.',
  animationStartedAt: 'Unix ms timestamp when the result animation was observed starting in the DOM.',
  animationFinishedAt: 'Unix ms timestamp when the result animation was observed finishing.',
  serverLatencyMs: 'serverResultAt - submittedAt: pure network/server time.',
  animationDurationMs: 'animationFinishedAt - animationStartedAt: client-side reveal time.',
  rawEventHash: 'SHA-256 of the canonicalized raw captured network event backing this record.',
  previousRecordHash: 'SHA-256 of the prior record in the ledger (hash chain; null for the first record).',
};

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function rollingRtp(sorted, window) {
  if (sorted.length < window) return null;
  const slice = sorted.slice(-window);
  const wagered = slice.reduce((s, r) => s + (r.wager || 0), 0);
  const paid = slice.reduce((s, r) => s + (r.payout || 0), 0);
  return wagered > 0 ? round2((paid / wagered) * 100) : null;
}

export function computeStats(records) {
  const sorted = [...records].sort((a, b) => a.submittedAt - b.submittedAt);
  const totalWagered = sorted.reduce((s, r) => s + (r.wager || 0), 0);
  const totalPayout = sorted.reduce((s, r) => s + (r.payout || 0), 0);
  // Sum the same per-record net values the ledger/CSV/dashboard display,
  // rather than recomputing totalPayout - totalWagered independently — those
  // two paths round differently and drift apart over many small bets.
  const totalNet = sorted.reduce((s, r) => s + (r.net || 0), 0);

  const latencies = sorted.map((r) => r.serverLatencyMs).filter((v) => v != null);
  const animations = sorted.map((r) => r.animationDurationMs).filter((v) => v != null);

  const byGame = {};
  const byRisk = {};
  const bySession = {};
  for (const r of sorted) {
    byGame[r.game] = byGame[r.game] || { count: 0, wagered: 0, payout: 0 };
    byGame[r.game].count += 1;
    byGame[r.game].wagered += r.wager || 0;
    byGame[r.game].payout += r.payout || 0;

    const risk = r.riskMode || 'unspecified';
    byRisk[risk] = byRisk[risk] || { count: 0, wagered: 0, payout: 0 };
    byRisk[risk].count += 1;
    byRisk[risk].wagered += r.wager || 0;
    byRisk[risk].payout += r.payout || 0;

    bySession[r.sessionId] = bySession[r.sessionId] || { count: 0, wagered: 0, payout: 0, firstAt: r.submittedAt, lastAt: r.submittedAt };
    const s = bySession[r.sessionId];
    s.count += 1;
    s.wagered += r.wager || 0;
    s.payout += r.payout || 0;
    s.firstAt = Math.min(s.firstAt, r.submittedAt);
    s.lastAt = Math.max(s.lastAt, r.submittedAt);
  }

  const rollingRtpWindows = {};
  for (const w of RTP_WINDOWS) rollingRtpWindows[w] = rollingRtp(sorted, w);

  return {
    betCount: sorted.length,
    totalWagered: round2(totalWagered),
    totalPayout: round2(totalPayout),
    totalNet: round2(totalNet),
    overallRtpPercent: totalWagered > 0 ? round2((totalPayout / totalWagered) * 100) : null,
    rollingRtpWindows,
    serverLatencyMs: { mean: round2(mean(latencies)), min: latencies.length ? Math.min(...latencies) : null, max: latencies.length ? Math.max(...latencies) : null, sampleCount: latencies.length },
    animationDurationMs: { mean: round2(mean(animations)), min: animations.length ? Math.min(...animations) : null, max: animations.length ? Math.max(...animations) : null, sampleCount: animations.length },
    byGame,
    byRisk,
    bySession,
    firstBetAt: sorted[0]?.submittedAt ?? null,
    lastBetAt: sorted[sorted.length - 1]?.submittedAt ?? null,
  };
}

export function toCSV(records) {
  const columns = Object.keys(DATA_DICTIONARY);
  const lines = [columns.join(',')];
  for (const r of records) {
    lines.push(
      columns
        .map((c) => {
          const v = r[c];
          if (v == null) return '';
          const s = Array.isArray(v) ? v.join('|') : String(v);
          return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    );
  }
  return lines.join('\n');
}

export function buildRawJSONExport(records) {
  return {
    exportKind: 'ubet-raw-ledger',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    records,
  };
}

// Self-describing export meant to be pasted or attached directly into an
// LLM conversation: schema + data dictionary + precomputed stats up front,
// so the model doesn't have to re-derive totals from raw rows, plus the
// full record set for anything that needs row-level detail.
export function buildLLMExport(records, stats, options = {}) {
  return {
    exportKind: 'ubet-llm-analysis-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    purpose: 'Bet telemetry captured read-only from the player\'s own stake.us sessions, for timing/fairness/variance analysis.',
    dataDictionary: DATA_DICTIONARY,
    summary: stats,
    notes: [
      'serverLatencyMs measures server/network time; animationDurationMs measures client-side reveal time. Compare the two to distinguish server slowdowns from animation slowdowns.',
      'balanceBefore lets you plot animationDurationMs against distance from any known withdrawal threshold.',
      'rawEventHash/previousRecordHash form a hash chain over the ledger; recompute to check the export for gaps or tampering.',
    ],
    recordCount: records.length,
    records: options.sampleLimit ? records.slice(-options.sampleLimit) : records,
    truncated: !!(options.sampleLimit && records.length > options.sampleLimit),
  };
}

export function buildLLMMarkdown(records, stats, options = {}) {
  const exportObj = buildLLMExport(records, stats, options);
  const dict = Object.entries(DATA_DICTIONARY)
    .map(([k, v]) => `- \`${k}\`: ${v}`)
    .join('\n');

  return `# U-Bet Telemetry Export

Read-only bet telemetry captured from the player's own stake.us sessions. No requests were modified to produce this data.

## Data dictionary

${dict}

## Summary

\`\`\`json
${JSON.stringify(stats, null, 2)}
\`\`\`

## Notes

${exportObj.notes.map((n) => `- ${n}`).join('\n')}

## Records (${exportObj.records.length}${exportObj.truncated ? ` of ${records.length}, most recent shown` : ''})

\`\`\`json
${JSON.stringify(exportObj.records, null, 2)}
\`\`\`
`;
}

export function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyToClipboard(text) {
  await navigator.clipboard.writeText(text);
}

export function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
