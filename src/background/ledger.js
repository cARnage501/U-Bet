export const SCHEMA_VERSION = 1;

// Stable stringify: sorts object keys recursively so the same logical
// content always hashes to the same string, regardless of key insertion order.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Builds an immutable, chained BetRecordV1 from a normalized capture plus
// the previous record's hash. The chain lets an export be checked for
// tampering or gaps after the fact: recompute each hash and compare.
export async function buildRecord(normalized, previousRecordHash, seq) {
  const rawEventHash = await sha256Hex(canonicalize(normalized.rawEvent ?? null));

  const record = {
    schemaVersion: SCHEMA_VERSION,
    // Monotonic insertion order — the true chain order. Deliberately
    // separate from submittedAt, which is bet-placement time and can arrive
    // out of order relative to when a bet actually finishes being appended.
    seq,
    betId: normalized.betId,
    sessionId: normalized.sessionId,
    site: normalized.site,
    game: normalized.game,
    riskMode: normalized.riskMode ?? null,
    selectedNumbers: normalized.selectedNumbers ?? [],
    resultNumbers: normalized.resultNumbers ?? [],
    wager: normalized.wager ?? null,
    payout: normalized.payout ?? null,
    // Full precision, not rounded to cents: stake.us pays out in sub-cent
    // amounts, and rounding here would make per-record net stop summing to
    // the same total as recomputing it fresh. Round only at display time.
    net: normalized.wager != null && normalized.payout != null
      ? cleanFloat(normalized.payout - normalized.wager)
      : null,
    balanceBefore: normalized.balanceBefore ?? null,
    balanceAfter: normalized.balanceAfter ?? null,
    submittedAt: normalized.submittedAt,
    serverResultAt: normalized.serverResultAt ?? null,
    animationStartedAt: normalized.animationStartedAt ?? null,
    animationFinishedAt: normalized.animationFinishedAt ?? null,
    serverLatencyMs: normalized.serverResultAt != null && normalized.submittedAt != null
      ? normalized.serverResultAt - normalized.submittedAt
      : null,
    animationDurationMs: normalized.animationFinishedAt != null && normalized.animationStartedAt != null
      ? normalized.animationFinishedAt - normalized.animationStartedAt
      : null,
    // How animationFinishedAt was determined. Kept alongside the duration so
    // clean measurements and bounded estimates never get pooled by accident.
    animationTimingQuality: normalized.animationTimingQuality ?? null,
    rawEventHash,
    previousRecordHash: previousRecordHash ?? null,
  };

  return record;
}

// Rounds away binary floating-point noise (e.g. 0.013999999999999999) without
// destroying real sub-cent precision the way rounding to 2 decimals would.
function cleanFloat(n) {
  return Math.round(n * 1e8) / 1e8;
}

// Recomputes the chain over an exported record array and reports the first
// break, if any. A break means a record's stored hash no longer matches its
// own content, or its previousRecordHash no longer matches the prior record.
export async function verifyChain(records) {
  let expectedPrev = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.previousRecordHash !== expectedPrev) {
      return { valid: false, brokenAtIndex: i, reason: 'previousRecordHash mismatch' };
    }
    expectedPrev = await sha256Hex(canonicalize(r));
  }
  return { valid: true };
}
